-- An unpaid payment attempt holds a listing for 20 minutes. When the buyer
-- cancels, Flutterwave reports failure, or the attempt expires, release it to
-- the marketplace. Reservations with no payment attempt still last 24 hours.

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
  update public.reservations set status='removed',order_id=null
  where order_id=o.id and status='checkout';
  update public.listings l set status='published',updated_at=now()
  from public.order_items i
  where i.order_id=o.id and l.id=i.listing_id and l.status in ('held','reserved')
    and not exists(select 1 from public.reservations rs where rs.listing_id=l.id and rs.status in ('active','checkout'));
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
    where status='held' and hold_until<=now()
    returning id
  ) select coalesce(array_agg(id),array[]::uuid[]),count(*)
    into expired_ids,n from expired;

  if cardinality(expired_ids)>0 then
    update public.reservations set status='expired',order_id=null
    where status='checkout' and order_id=any(expired_ids);
    update public.listings l set status='published',updated_at=now()
    from public.order_items i
    where i.order_id=any(expired_ids) and l.id=i.listing_id and l.status in ('held','reserved')
      and not exists(select 1 from public.reservations rs where rs.listing_id=l.id and rs.status in ('active','checkout'));
  end if;
  return coalesce(n,0);
end;
$$;

grant execute on function public.cancel_checkout(uuid,uuid),public.expire_orders() to service_role;

-- Normalize attempts that had already passed their deadline before this change.
select public.expire_orders();
