-- Stop computing platform fees in SQL. Flutterwave's subaccount configuration
-- controls the split; checkout sends only the configured subaccount ID.
drop function if exists public.create_cart_order(uuid,text,numeric);
drop function if exists public.create_cart_order(uuid,text);

create function public.create_cart_order(p_buyer uuid,p_tx_ref text)
returns public.orders
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  total bigint;
  o public.orders%rowtype;
  r record;
begin
  if not coalesce((select enabled from public.feature_flags where key='checkout'),false) then
    raise exception 'feature disabled';
  end if;

  perform 1 from public.reservations
  where buyer_id=p_buyer and status='active' and expires_at>now()
  for update;

  select coalesce(sum(case when l.delivery_type='rental' then ro.price else l.price end),0)
  into total
  from public.reservations rs
  join public.listings l on l.id=rs.listing_id
  left join public.listing_rental_options ro
    on ro.listing_id=l.id and ro.duration_days=rs.rental_duration_days and ro.enabled
  where rs.buyer_id=p_buyer and rs.status='active' and rs.expires_at>now()
    and l.status='reserved'
    and (l.delivery_type<>'rental' or ro.id is not null);

  if total<=0 then raise exception 'cart empty or rental option unavailable'; end if;

  insert into public.orders(buyer_id,amount,status,flw_tx_ref,hold_until,order_code,delivery_status)
  values(p_buyer,total,'held',p_tx_ref,now()+interval '20 minutes',
    'ORD-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),'awaiting_payment')
  returning * into o;

  for r in
    select rs.id reservation_id,rs.rental_duration_days,rs.status_before_reservation,
      l.id listing_id,l.seller_id,l.game,l.delivery_type,l.owner_type,l.owner_vendor_id,
      (case when l.delivery_type='rental' then ro.price else l.price end) item_price,
      v.flw_subaccount_id
    from public.reservations rs
    join public.listings l on l.id=rs.listing_id
    left join public.listing_rental_options ro
      on ro.listing_id=l.id and ro.duration_days=rs.rental_duration_days and ro.enabled
    left join public.vendor_profiles v on v.user_id=l.owner_vendor_id
    where rs.buyer_id=p_buyer and rs.status='active' and rs.expires_at>now()
      and l.status='reserved'
    for update of l,rs
  loop
    if r.owner_type not in ('platform','vendor')
      or (r.owner_type='vendor' and r.owner_vendor_id is null) then
      raise exception 'listing owner cannot be determined';
    end if;
    if r.owner_type='vendor' and r.flw_subaccount_id is null then
      raise exception 'Vendor payment setup is incomplete. Ask the Arcade Store owner to add the vendor Flutterwave subaccount ID before checkout.';
    end if;

    insert into public.order_items(
      order_id,listing_id,seller_id,game,gross,commission,net,owner_type,
      owner_vendor_id,delivery_type,rental_days,vendor_subaccount_id,
      listing_status_before_hold
    ) values(
      o.id,r.listing_id,r.seller_id,r.game,r.item_price,0,r.item_price,
      r.owner_type,r.owner_vendor_id,r.delivery_type,r.rental_duration_days,
      r.flw_subaccount_id,coalesce(r.status_before_reservation,'published')
    );

    update public.listings set status='held',updated_at=now() where id=r.listing_id;
    update public.reservations set status='checkout',order_id=o.id,expires_at=o.hold_until
    where id=r.reservation_id;
  end loop;
  return o;
end;
$$;

revoke execute on function public.create_cart_order(uuid,text) from public,anon,authenticated;
grant execute on function public.create_cart_order(uuid,text) to service_role;
