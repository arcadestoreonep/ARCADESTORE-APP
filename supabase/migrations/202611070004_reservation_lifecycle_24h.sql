-- Keep buyer reservations for 24 hours. Checkout links still have a separate
-- 20-minute payment attempt window; a failed/expired attempt returns the item
-- to the same buyer's cart until the reservation itself expires.

update public.reservations
set expires_at = created_at + interval '24 hours'
where status in ('active', 'checkout')
  and expires_at > created_at + interval '24 hours';

create or replace function public.reserve_listing(p_buyer uuid,p_listing uuid)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare l public.listings%rowtype; rid uuid;
begin
  if not coalesce((select enabled from public.feature_flags where key='reservations'),false) then
    raise exception 'feature disabled';
  end if;
  select * into l from public.listings where id=p_listing for update;
  if not found or l.status<>'published' then raise exception 'listing unavailable'; end if;
  insert into public.reservations(listing_id,buyer_id,status,expires_at)
  values(l.id,p_buyer,'active',now()+interval '24 hours') returning id into rid;
  update public.listings set status='reserved',updated_at=now() where id=l.id;
  return rid;
end;
$$;

create or replace function public.release_reservation(p_buyer uuid,p_reservation uuid)
returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare r public.reservations%rowtype;
begin
  select * into r from public.reservations where id=p_reservation for update;
  if not found or r.buyer_id<>p_buyer or r.status not in ('active','checkout') or r.expires_at<=now() then
    return false;
  end if;
  if r.status='checkout' and r.order_id is not null then
    update public.orders set status='cancelled'
    where id=r.order_id and buyer_id=p_buyer and status='held';
  end if;
  update public.reservations set status='removed',order_id=null where id=r.id;
  update public.listings set status='published',updated_at=now()
  where id=r.listing_id and status in ('reserved','held')
    and not exists(select 1 from public.reservations rs where rs.listing_id=r.listing_id and rs.status in ('active','checkout'));
  return true;
end;
$$;

create or replace function public.owner_release_reservation(p_owner uuid,p_reservation uuid)
returns boolean
language plpgsql
security definer
set search_path=public,auth
as $$
declare r public.reservations%rowtype;
begin
  if coalesce((select raw_app_meta_data->>'role' from auth.users where id=p_owner),'')<>'owner' then
    raise exception 'forbidden';
  end if;
  select * into r from public.reservations where id=p_reservation for update;
  if not found or r.status not in ('active','checkout') or r.expires_at<=now() then return false; end if;
  if r.status='checkout' and r.order_id is not null then
    update public.orders set status='cancelled' where id=r.order_id and status='held';
  end if;
  update public.reservations set status='removed',order_id=null where id=r.id;
  update public.listings set status='published',updated_at=now()
  where id=r.listing_id and status in ('reserved','held')
    and not exists(select 1 from public.reservations rs where rs.listing_id=r.listing_id and rs.status in ('active','checkout'));
  return true;
end;
$$;

create or replace function public.create_cart_order(p_buyer uuid,p_tx_ref text)
returns public.orders
language plpgsql
security definer
set search_path=public
as $$
declare total bigint; o public.orders%rowtype; r record; fee bigint;
begin
  if not coalesce((select enabled from public.feature_flags where key='checkout'),false) then raise exception 'feature disabled'; end if;
  perform 1 from public.reservations where buyer_id=p_buyer and status='active' and expires_at>now() for update;
  select coalesce(sum(l.price),0) into total
  from public.reservations rs join public.listings l on l.id=rs.listing_id
  where rs.buyer_id=p_buyer and rs.status='active' and rs.expires_at>now() and l.status='reserved';
  if total<=0 then raise exception 'cart empty'; end if;
  insert into public.orders(buyer_id,amount,status,flw_tx_ref,hold_until)
  values(p_buyer,total,'held',p_tx_ref,now()+interval '20 minutes') returning * into o;
  for r in
    select rs.id reservation_id,l.id listing_id,l.seller_id,l.game,l.price,
      coalesce(u.raw_app_meta_data->>'role','buyer') seller_role
    from public.reservations rs join public.listings l on l.id=rs.listing_id
    join auth.users u on u.id=l.seller_id
    where rs.buyer_id=p_buyer and rs.status='active' and rs.expires_at>now() and l.status='reserved'
    for update of l,rs
  loop
    fee:=case when r.seller_role='owner' then 0 else round(r.price*.20)::bigint end;
    insert into public.order_items(order_id,listing_id,seller_id,game,gross,commission,net)
    values(o.id,r.listing_id,r.seller_id,r.game,r.price,fee,r.price-fee);
    update public.listings set status='held',updated_at=now() where id=r.listing_id;
    -- Do not shorten the buyer's 24-hour reservation to the payment window.
    update public.reservations set status='checkout',order_id=o.id where id=r.reservation_id;
  end loop;
  return o;
end;
$$;

create or replace function public.cancel_checkout(p_buyer uuid,p_order uuid)
returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order and buyer_id=p_buyer for update;
  if not found or o.status<>'held' then return false; end if;
  update public.orders set status='cancelled' where id=o.id;
  update public.reservations set status=case when expires_at>now() then 'active' else 'expired' end,
    order_id=null where order_id=o.id and status='checkout';
  update public.listings l set status=case
    when exists(select 1 from public.reservations rs where rs.listing_id=l.id and rs.status='active' and rs.expires_at>now()) then 'reserved'
    else 'published' end,updated_at=now()
  from public.order_items i where i.order_id=o.id and l.id=i.listing_id and l.status in ('held','reserved');
  return true;
end;
$$;

create or replace function public.expire_orders()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare expired_ids uuid[]; n integer;
begin
  with expired as (
    update public.orders set status='expired'
    where status='held' and hold_until<=now() returning id
  ) select coalesce(array_agg(id),array[]::uuid[]),count(*) into expired_ids,n from expired;
  if cardinality(expired_ids)>0 then
    update public.reservations set status=case when expires_at>now() then 'active' else 'expired' end,
      order_id=null where status='checkout' and order_id=any(expired_ids);
    update public.listings l set status=case
      when exists(select 1 from public.reservations rs where rs.listing_id=l.id and rs.status='active' and rs.expires_at>now()) then 'reserved'
      else 'published' end,updated_at=now()
    from public.order_items i where i.order_id=any(expired_ids) and l.id=i.listing_id and l.status in ('held','reserved');
  end if;
  return coalesce(n,0);
end;
$$;

create or replace function public.expire_reservations()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare expired_listing_ids uuid[]; expired_order_ids uuid[]; n integer;
begin
  with expired as (
    update public.reservations set status='expired'
    where status in ('active','checkout') and expires_at<=now()
    returning listing_id,order_id
  ) select coalesce(array_agg(distinct listing_id),array[]::uuid[]),
      coalesce(array_agg(distinct order_id) filter(where order_id is not null),array[]::uuid[]),count(*)
    into expired_listing_ids,expired_order_ids,n from expired;
  if cardinality(expired_order_ids)>0 then
    update public.orders set status='expired'
    where id=any(expired_order_ids) and status='held';
    update public.reservations set status='active',order_id=null
    where status='checkout' and order_id=any(expired_order_ids) and expires_at>now();
    update public.listings l set status='reserved',updated_at=now()
    where l.id in (select rs.listing_id from public.reservations rs where rs.status='active' and rs.expires_at>now())
      and l.status='held'
      and not exists(select 1 from public.reservations rs where rs.listing_id=l.id and rs.status='checkout');
  end if;
  if cardinality(expired_listing_ids)>0 then
    update public.listings l set status='published',updated_at=now()
    where l.id=any(expired_listing_ids) and l.status in ('reserved','held')
      and not exists(select 1 from public.reservations rs where rs.listing_id=l.id and rs.status in ('active','checkout'));
  end if;
  return coalesce(n,0);
end;
$$;

grant execute on function public.owner_release_reservation(uuid,uuid) to service_role;
grant execute on function public.release_reservation(uuid,uuid),public.expire_reservations(),public.expire_orders(),public.cancel_checkout(uuid,uuid),public.create_cart_order(uuid,text) to service_role;

-- Apply the shortened deadline immediately to reservations already past 24 hours.
select public.expire_reservations();
