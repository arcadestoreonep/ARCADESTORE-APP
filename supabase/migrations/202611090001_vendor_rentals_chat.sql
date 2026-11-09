-- Add vendor-owned inventory, flexible encrypted credentials, rentals, and
-- order-specific assisted-delivery chat without deleting legacy records.
create table if not exists public.vendor_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  verified_partner boolean not null default false,
  flw_subaccount_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.listings add column if not exists listing_code text;
alter table public.listings add column if not exists owner_vendor_id uuid references public.vendor_profiles(user_id);
alter table public.listings add column if not exists owner_type text not null default 'platform';
alter table public.listings add column if not exists delivery_type text not null default 'instant';
alter table public.listings add column if not exists transfer_instructions_required boolean not null default false;
alter table public.listings add column if not exists updated_by uuid references auth.users(id);
update public.listings set listing_code='AS-'||upper(substr(replace(id::text,'-',''),1,12)) where listing_code is null;
alter table public.listings alter column listing_code set default ('AS-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)));
alter table public.listings alter column listing_code set not null;
create unique index if not exists listings_listing_code_key on public.listings(listing_code);
alter table public.listings drop constraint if exists listings_owner_type_check;
alter table public.listings add constraint listings_owner_type_check check((owner_type='platform' and owner_vendor_id is null) or (owner_type='vendor' and owner_vendor_id is not null));
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check check(status in ('draft','published','active','paused','reserved','held','sold','rented','hidden','deleted'));
alter table public.listings drop constraint if exists listings_delivery_type_check;
alter table public.listings add constraint listings_delivery_type_check check(delivery_type in ('instant','assisted','rental'));

create table if not exists public.listing_credentials (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  label text not null check(length(label) between 1 and 80),
  ciphertext text not null,
  iv text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique(listing_id,sort_order)
);
create index if not exists listing_credentials_order_idx on public.listing_credentials(listing_id,sort_order);

create table if not exists public.listing_transfer_instructions (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.listing_rental_options (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  duration_days integer not null check(duration_days between 1 and 365),
  price bigint not null check(price > 0),
  enabled boolean not null default true,
  unique(listing_id,duration_days)
);
alter table public.reservations add column if not exists rental_duration_days integer;
alter table public.reservations add column if not exists status_before_reservation text;

alter table public.orders add column if not exists order_code text;
alter table public.orders add column if not exists delivery_status text not null default 'awaiting_payment';
alter table public.orders add column if not exists rental_started_at timestamptz;
alter table public.orders add column if not exists rental_expires_at timestamptz;
update public.orders set order_code='ORD-'||upper(substr(replace(id::text,'-',''),1,12)) where order_code is null;
alter table public.orders alter column order_code set default ('ORD-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)));
alter table public.orders alter column order_code set not null;
create unique index if not exists orders_order_code_key on public.orders(order_code);
alter table public.orders drop constraint if exists orders_delivery_status_check;
alter table public.orders add constraint orders_delivery_status_check check(delivery_status in ('awaiting_payment','awaiting_vendor','delivered','rental_active','rental_expired','cancelled'));

alter table public.order_items add column if not exists owner_vendor_id uuid references public.vendor_profiles(user_id);
alter table public.order_items add column if not exists owner_type text not null default 'platform';
alter table public.order_items add column if not exists delivery_type text not null default 'instant';
alter table public.order_items add column if not exists rental_days integer;
alter table public.order_items add column if not exists vendor_subaccount_id text;
alter table public.order_items add column if not exists listing_status_before_hold text;
alter table public.order_items add column if not exists rental_started_at timestamptz;
alter table public.order_items add column if not exists rental_expires_at timestamptz;
alter table public.order_items add column if not exists delivery_status text not null default 'awaiting_payment';

create or replace function public.protect_listing_vendor_owner()
returns trigger language plpgsql set search_path=public as $$
begin
  if (old.owner_vendor_id is distinct from new.owner_vendor_id or old.owner_type is distinct from new.owner_type)
     and coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' then
    raise exception 'listing owner is server managed';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_listing_vendor_owner_trigger on public.listings;
create trigger protect_listing_vendor_owner_trigger before update of owner_vendor_id,owner_type on public.listings
for each row execute function public.protect_listing_vendor_owner();

create or replace function public.can_access_order_chat(p_order uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.orders o
    join public.order_items i on i.order_id=o.id
    where o.id=p_order and o.status='paid'
      and (o.buyer_id=auth.uid() or public.is_owner() or (i.owner_vendor_id=auth.uid() and exists(select 1 from public.vendor_profiles v where v.user_id=auth.uid())))
  )
$$;

create table if not exists public.order_chats (
  order_id uuid primary key references public.orders(id) on delete cascade,
  listing_id uuid not null references public.listings(id),
  buyer_id uuid not null references auth.users(id),
  vendor_id uuid references public.vendor_profiles(user_id),
  created_at timestamptz not null default now()
);
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.order_chats(order_id) on delete cascade,
  sender_id uuid references auth.users(id),
  message_type text not null check(message_type in ('text','image','system')),
  body text,
  attachment_path text,
  created_at timestamptz not null default now(),
  check((message_type='text' and body is not null and length(body) between 1 and 4000 and attachment_path is null)
     or (message_type='image' and body is null and attachment_path is not null)
     or (message_type='system' and sender_id is null and body is not null and attachment_path is null))
);
create index if not exists chat_messages_order_time_idx on public.chat_messages(order_id,created_at,id);
create table if not exists public.chat_read_state (
  order_id uuid not null references public.order_chats(order_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key(order_id,user_id)
);
create table if not exists public.chat_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  message_count integer not null default 0
);

create or replace function public.consume_chat_rate_limit(p_user uuid,p_max integer default 20,p_window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.chat_rate_limits%rowtype;
begin
  insert into public.chat_rate_limits(user_id,window_started_at,message_count) values(p_user,now(),0) on conflict(user_id) do nothing;
  select * into r from public.chat_rate_limits where user_id=p_user for update;
  if r.window_started_at < now()-make_interval(secs=>p_window_seconds) then
    update public.chat_rate_limits set window_started_at=now(),message_count=1 where user_id=p_user;
    return true;
  end if;
  if r.message_count>=p_max then return false; end if;
  update public.chat_rate_limits set message_count=message_count+1 where user_id=p_user;
  return true;
end;
$$;

create or replace function public.replace_listing_configuration(
  p_listing uuid,p_credentials jsonb,p_transfer_ciphertext text,p_transfer_iv text,p_rental_options jsonb
)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.listings where id=p_listing) then raise exception 'listing not found'; end if;
  if jsonb_typeof(p_credentials)<>'array' or jsonb_array_length(p_credentials)<1 or jsonb_array_length(p_credentials)>30 then raise exception 'invalid credential fields'; end if;
  if jsonb_typeof(coalesce(p_rental_options,'[]'::jsonb))<>'array' then raise exception 'invalid rental options'; end if;
  delete from public.listing_credentials where listing_id=p_listing;
  insert into public.listing_credentials(listing_id,label,ciphertext,iv,sort_order)
  select p_listing,left(x->>'label',80),x->>'ciphertext',x->>'iv',(x->>'sort_order')::integer
  from jsonb_array_elements(p_credentials) x;
  delete from public.listing_transfer_instructions where listing_id=p_listing;
  if coalesce(p_transfer_ciphertext,'')<>'' and coalesce(p_transfer_iv,'')<>'' then
    insert into public.listing_transfer_instructions(listing_id,ciphertext,iv) values(p_listing,p_transfer_ciphertext,p_transfer_iv);
  end if;
  delete from public.listing_rental_options where listing_id=p_listing;
  insert into public.listing_rental_options(listing_id,duration_days,price,enabled)
  select p_listing,(x->>'duration_days')::integer,(x->>'price')::bigint,true
  from jsonb_array_elements(coalesce(p_rental_options,'[]'::jsonb)) x;
  return true;
end;
$$;

create or replace function public.expire_rentals()
returns integer language plpgsql security definer set search_path=public as $$
declare n integer; expired_ids uuid[]; expired_orders uuid[];
begin
  with expired as (
    update public.order_items set delivery_status='rental_expired'
    where delivery_type='rental' and delivery_status='rental_active' and rental_expires_at<=now()
    returning order_id,listing_id
  ) select coalesce(array_agg(distinct listing_id),'{}'::uuid[]),coalesce(array_agg(distinct order_id),'{}'::uuid[])
    into expired_ids,expired_orders from expired;
  update public.orders o set delivery_status='rental_expired'
  where o.id=any(expired_orders) and o.delivery_status='rental_active'
    and not exists(select 1 from public.order_items i where i.order_id=o.id and i.delivery_type='rental' and i.delivery_status='rental_active');
  insert into public.chat_messages(order_id,sender_id,message_type,body)
  select c.order_id,null,'system','Rental period expired. The vendor is responsible for revoking access.'
  from public.order_chats c join public.order_items i on i.order_id=c.order_id and i.delivery_type='rental' and i.delivery_status='rental_expired'
  where c.order_id=any(expired_orders)
    and not exists(select 1 from public.chat_messages m where m.order_id=c.order_id and m.message_type='system' and m.body='Rental period expired. The vendor is responsible for revoking access.');
  update public.listings l set status='active',updated_at=now()
  from public.order_items i join public.orders o on o.id=i.order_id
  where i.listing_id=l.id and i.delivery_type='rental' and i.delivery_status='rental_expired'
    and l.status='rented' and not exists (
      select 1 from public.order_items oi
      where oi.listing_id=l.id and oi.delivery_type='rental' and oi.delivery_status='rental_active' and oi.rental_expires_at>now()
    );
  get diagnostics n=row_count;
  return coalesce(array_length(expired_orders,1),0);
end;
$$;

drop function if exists public.reserve_listing(uuid,uuid);
create or replace function public.reserve_listing(p_buyer uuid,p_listing uuid,p_rental_days integer default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare l public.listings%rowtype; rid uuid; option_ok boolean; previous_status text;
begin
  if not coalesce((select enabled from public.feature_flags where key='reservations'),false) then raise exception 'feature disabled'; end if;
  select * into l from public.listings where id=p_listing for update;
  if not found or l.status not in ('published','active') then raise exception 'listing unavailable'; end if;
  if l.delivery_type='rental' then
    if p_rental_days is null then raise exception 'rental duration required'; end if;
    select exists(select 1 from public.listing_rental_options where listing_id=l.id and duration_days=p_rental_days and enabled) into option_ok;
    if not option_ok then raise exception 'rental duration unavailable'; end if;
  elsif p_rental_days is not null then raise exception 'duration is only valid for rentals'; end if;
  previous_status:=l.status;
  insert into public.reservations(listing_id,buyer_id,status,expires_at,rental_duration_days,status_before_reservation)
  values(l.id,p_buyer,'active',now()+interval '24 hours',p_rental_days,previous_status) returning id into rid;
  update public.listings set status='reserved',updated_at=now() where id=l.id;
  return rid;
end;
$$;

drop function if exists public.create_cart_order(uuid,text);
create or replace function public.create_cart_order(p_buyer uuid,p_tx_ref text,p_commission_percent numeric)
returns public.orders language plpgsql security definer set search_path=public,auth as $$
declare total bigint; o public.orders%rowtype; r record; fee bigint;
begin
  if p_commission_percent<0 or p_commission_percent>100 then raise exception 'commission percentage must be from 0 to 100'; end if;
  if not coalesce((select enabled from public.feature_flags where key='checkout'),false) then raise exception 'feature disabled'; end if;
  perform 1 from public.reservations where buyer_id=p_buyer and status='active' and expires_at>now() for update;
  select coalesce(sum(case when l.delivery_type='rental' then ro.price else l.price end),0) into total
  from public.reservations rs join public.listings l on l.id=rs.listing_id
  left join public.listing_rental_options ro on ro.listing_id=l.id and ro.duration_days=rs.rental_duration_days and ro.enabled
  where rs.buyer_id=p_buyer and rs.status='active' and rs.expires_at>now() and l.status='reserved'
    and (l.delivery_type<>'rental' or ro.id is not null);
  if total<=0 then raise exception 'cart empty or rental option unavailable'; end if;
  insert into public.orders(buyer_id,amount,status,flw_tx_ref,hold_until,order_code,delivery_status)
  values(p_buyer,total,'held',p_tx_ref,now()+interval '20 minutes','ORD-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),'awaiting_payment') returning * into o;
  for r in
    select rs.id reservation_id,rs.rental_duration_days,rs.status_before_reservation,l.id listing_id,l.seller_id,
      l.game,l.delivery_type,l.owner_type,l.owner_vendor_id,l.price,(case when l.delivery_type='rental' then ro.price else l.price end) item_price,
      v.flw_subaccount_id
    from public.reservations rs join public.listings l on l.id=rs.listing_id
    left join public.listing_rental_options ro on ro.listing_id=l.id and ro.duration_days=rs.rental_duration_days and ro.enabled
    left join public.vendor_profiles v on v.user_id=l.owner_vendor_id
    where rs.buyer_id=p_buyer and rs.status='active' and rs.expires_at>now() and l.status='reserved'
    for update of l,rs
  loop
    if r.owner_type not in ('platform','vendor') or (r.owner_type='vendor' and r.owner_vendor_id is null) then raise exception 'listing owner cannot be determined'; end if;
    if r.owner_type='vendor' and r.flw_subaccount_id is null then raise exception 'vendor subaccount is missing'; end if;
    fee:=case when r.owner_type='platform' then 0 else round(r.item_price*p_commission_percent/100)::bigint end;
    insert into public.order_items(order_id,listing_id,seller_id,game,gross,commission,net,owner_type,owner_vendor_id,delivery_type,rental_days,vendor_subaccount_id,listing_status_before_hold)
    values(o.id,r.listing_id,r.seller_id,r.game,r.item_price,fee,r.item_price-fee,r.owner_type,r.owner_vendor_id,r.delivery_type,r.rental_duration_days,r.flw_subaccount_id,coalesce(r.status_before_reservation,'published'));
    update public.listings set status='held',updated_at=now() where id=r.listing_id;
    update public.reservations set status='checkout',order_id=o.id,expires_at=o.hold_until where id=r.reservation_id;
  end loop;
  return o;
end;
$$;

create or replace function public.release_reservation(p_buyer uuid,p_reservation uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype;
begin
  select * into r from public.reservations where id=p_reservation for update;
  if not found or r.buyer_id<>p_buyer or r.status<>'active' then return false; end if;
  update public.reservations set status='removed' where id=r.id;
  update public.listings set status=coalesce(r.status_before_reservation,'published'),updated_at=now() where id=r.listing_id and status='reserved';
  return true;
end;
$$;

create or replace function public.owner_release_reservation(p_owner uuid,p_reservation uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype; o public.orders%rowtype;
begin
  if coalesce((select raw_app_meta_data->>'role' from auth.users where id=p_owner),'')<>'owner' then raise exception 'forbidden'; end if;
  select * into r from public.reservations where id=p_reservation for update;
  if not found or r.status not in ('active','checkout') then return false; end if;
  if r.status='checkout' and r.order_id is not null then
    select * into o from public.orders where id=r.order_id for update;
    if o.status<>'held' then return false; end if;
    update public.orders set status='cancelled',delivery_status='cancelled' where id=o.id;
    update public.listings l set status=i.listing_status_before_hold,updated_at=now()
      from public.order_items i where i.order_id=o.id and l.id=i.listing_id and l.status='held';
    update public.reservations set status='removed' where order_id=o.id and status='checkout';
    return true;
  else
    update public.listings set status=coalesce(r.status_before_reservation,'published'),updated_at=now()
      where id=r.listing_id and status='reserved';
  end if;
  update public.reservations set status='removed' where id=r.id;
  return true;
end;
$$;

create or replace function public.expire_reservations()
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  with expired as (update public.reservations set status='expired' where status='active' and expires_at<=now() returning listing_id,status_before_reservation)
  update public.listings l set status=coalesce(e.status_before_reservation,'published'),updated_at=now()
  from expired e where l.id=e.listing_id and l.status='reserved'
    and not exists(select 1 from public.reservations r where r.listing_id=l.id and r.status in ('active','checkout'));
  get diagnostics n=row_count;
  return coalesce(n,0);
end;
$$;

create or replace function public.cancel_checkout(p_buyer uuid,p_order uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order and buyer_id=p_buyer for update;
  if not found or o.status<>'held' then return false; end if;
  update public.orders set status='cancelled',delivery_status='cancelled' where id=o.id;
  update public.listings l set status=i.listing_status_before_hold,updated_at=now()
  from public.order_items i where i.order_id=o.id and l.id=i.listing_id and l.status='held';
  update public.reservations set status='removed' where order_id=o.id and status='checkout';
  return true;
end;
$$;

create or replace function public.expire_orders()
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  with expired as (update public.orders set status='expired',delivery_status='cancelled' where status='held' and hold_until<=now() returning id)
  update public.listings l set status=i.listing_status_before_hold,updated_at=now()
  from public.order_items i,expired e where i.order_id=e.id and l.id=i.listing_id and l.status='held';
  update public.reservations set status='expired' where status='checkout' and expires_at<=now();
  get diagnostics n=row_count;
  return coalesce(n,0);
end;
$$;

create or replace function public.apply_payment_result(p_order uuid,p_tx jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders%rowtype; i public.order_items%rowtype; txid text; has_assisted boolean; has_rental boolean;
begin
  select * into o from public.orders where id=p_order for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if o.status='paid' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if coalesce(p_tx->>'status','')<>'successful' then return jsonb_build_object('ok',false,'reason','not_successful'); end if;
  if coalesce(p_tx->>'tx_ref','')<>o.flw_tx_ref or coalesce(p_tx->>'currency','')<>'NGN' or coalesce((p_tx->>'amount')::numeric,0)<>o.amount then return jsonb_build_object('ok',false,'reason','mismatch'); end if;
  txid:=p_tx->>'id';
  if o.hold_until<=now() then
    update public.orders set status='needs_refund',flw_transaction_id=txid,refund_reason='Payment arrived after the 20-minute hold expired' where id=o.id;
    return jsonb_build_object('ok',false,'reason','needs_refund');
  end if;
  select bool_or(delivery_type='assisted'),bool_or(delivery_type='rental') into has_assisted,has_rental from public.order_items where order_id=o.id;
  update public.orders set status='paid',flw_transaction_id=txid,paid_at=now(),delivery_status=case when has_assisted then 'awaiting_vendor' when has_rental then 'rental_active' else 'delivered' end where id=o.id;
  for i in select * from public.order_items where order_id=o.id loop
    if i.delivery_type='rental' then
      update public.order_items set rental_started_at=now(),rental_expires_at=now()+make_interval(days=>i.rental_days),delivery_status='rental_active' where id=i.id;
      update public.listings set status='rented',updated_at=now() where id=i.listing_id and status='held';
    else
      update public.order_items set delivery_status=case when i.delivery_type='assisted' then 'awaiting_vendor' else 'delivered' end where id=i.id;
      update public.listings set status='sold',updated_at=now() where id=i.listing_id and status='held';
    end if;
    insert into public.ledger(user_id,direction,amount,entry_type,order_id,reference)
    values(i.seller_id,'credit',i.net,'sale',o.id,'sale:'||o.id::text||':'||i.listing_id::text) on conflict(reference) do nothing;
    if i.delivery_type in ('assisted','rental') then
      insert into public.order_chats(order_id,listing_id,buyer_id,vendor_id) values(o.id,i.listing_id,o.buyer_id,i.owner_vendor_id) on conflict(order_id) do nothing;
      insert into public.chat_messages(order_id,sender_id,message_type,body) values(o.id,null,'system','Payment confirmed. This order is paid.');
      if i.delivery_type='assisted' then insert into public.chat_messages(order_id,sender_id,message_type,body) values(o.id,null,'system','Vendor notified. Delivery is awaiting vendor assistance.'); end if;
      if i.delivery_type='rental' then insert into public.chat_messages(order_id,sender_id,message_type,body) values(o.id,null,'system','Vendor notified. Rental started and access is scheduled to expire on '||(now()+make_interval(days=>i.rental_days))::text||'. The vendor manages access revocation.'); end if;
    end if;
  end loop;
  update public.reservations set status='completed' where order_id=o.id and status='checkout';
  update public.orders set rental_started_at=(select min(rental_started_at) from public.order_items where order_id=o.id and delivery_type='rental'),
    rental_expires_at=(select max(rental_expires_at) from public.order_items where order_id=o.id and delivery_type='rental') where id=o.id;
  return jsonb_build_object('ok',true,'duplicate',false);
end;
$$;

alter table public.vendor_profiles enable row level security;
alter table public.listing_credentials enable row level security;
alter table public.listing_transfer_instructions enable row level security;
alter table public.listing_rental_options enable row level security;
alter table public.order_chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_read_state enable row level security;
alter table public.chat_rate_limits enable row level security;

drop policy if exists listings_public_or_seller on public.listings;
create policy listings_public_or_seller on public.listings for select using (
  status in ('published','active','reserved','held')
  or seller_id=auth.uid() and public.is_admin_or_owner()
  or seller_id=auth.uid() and exists(select 1 from public.vendor_profiles v where v.user_id=auth.uid())
  or public.is_owner()
);
create policy vendor_profile_owner_read on public.vendor_profiles for select using(public.is_owner());
create policy vendor_profile_self_read on public.vendor_profiles for select using(user_id=auth.uid());
create policy vendor_profile_public_badge_read on public.vendor_profiles for select using(verified_partner);
create policy rental_options_public_read on public.listing_rental_options for select using(enabled and exists(select 1 from public.listings l where l.id=listing_id and l.status in ('active','published','reserved','held')));
create policy listing_credentials_permitted_read on public.listing_credentials for select using (
  public.is_owner()
  or exists(select 1 from public.vendor_profiles v join public.listings l on l.owner_vendor_id=v.user_id where l.id=listing_id and v.user_id=auth.uid())
  or exists(select 1 from public.orders o join public.order_items i on i.order_id=o.id where o.status='paid' and o.buyer_id=auth.uid() and i.listing_id=listing_id)
);
create policy listing_transfer_permitted_read on public.listing_transfer_instructions for select using (
  public.is_owner()
  or exists(select 1 from public.vendor_profiles v join public.listings l on l.owner_vendor_id=v.user_id where l.id=listing_id and v.user_id=auth.uid())
  or exists(select 1 from public.orders o join public.order_items i on i.order_id=o.id where o.status='paid' and o.buyer_id=auth.uid() and i.listing_id=listing_id)
);
create policy order_chats_participant_read on public.order_chats for select using(public.can_access_order_chat(order_id));
create policy chat_messages_participant_read on public.chat_messages for select using(public.can_access_order_chat(order_id));
create policy chat_read_state_self on public.chat_read_state for select using(user_id=auth.uid() and public.can_access_order_chat(order_id));
create policy chat_read_state_self_insert on public.chat_read_state for insert with check(user_id=auth.uid() and public.can_access_order_chat(order_id));
create policy chat_read_state_self_update on public.chat_read_state for update using(user_id=auth.uid() and public.can_access_order_chat(order_id)) with check(user_id=auth.uid() and public.can_access_order_chat(order_id));

revoke all on public.vendor_profiles,public.listing_credentials,public.listing_transfer_instructions,public.chat_rate_limits from anon,authenticated;
grant select(user_id,verified_partner) on public.vendor_profiles to anon,authenticated;
revoke insert,update,delete on public.listings,public.listing_rental_options,public.order_chats,public.chat_messages from anon,authenticated;
grant select on public.listings,public.listing_credentials,public.listing_transfer_instructions,public.listing_rental_options,public.order_chats,public.chat_messages,public.chat_read_state to authenticated;
grant select on public.listing_rental_options to anon;
grant execute on function public.can_access_order_chat(uuid) to authenticated;
revoke execute on function public.reserve_listing(uuid,uuid,integer),public.create_cart_order(uuid,text,numeric) from public,anon,authenticated;
grant execute on function public.reserve_listing(uuid,uuid,integer),public.create_cart_order(uuid,text,numeric) to service_role;
revoke execute on function public.consume_chat_rate_limit(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_chat_rate_limit(uuid,integer,integer) to service_role;
revoke execute on function public.expire_rentals() from public,anon,authenticated;
grant execute on function public.expire_rentals() to service_role;
revoke execute on function public.owner_release_reservation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.owner_release_reservation(uuid,uuid) to service_role;
revoke execute on function public.replace_listing_configuration(uuid,jsonb,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.replace_listing_configuration(uuid,jsonb,text,text,jsonb) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('order-chat-attachments','order-chat-attachments',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp'];
drop policy if exists order_chat_attachment_read on storage.objects;
create policy order_chat_attachment_read on storage.objects for select to authenticated using(
  bucket_id='order-chat-attachments' and public.can_access_order_chat((storage.foldername(name))[1]::uuid)
);
drop policy if exists order_chat_attachment_insert on storage.objects;
create policy order_chat_attachment_insert on storage.objects for insert to authenticated with check(
  bucket_id='order-chat-attachments' and public.can_access_order_chat((storage.foldername(name))[1]::uuid)
  and lower(coalesce(metadata->>'mimetype','')) in ('image/jpeg','image/png','image/webp')
  and coalesce((metadata->>'size')::bigint,0)<=5242880
);
drop policy if exists listing_photos_owner_insert on storage.objects;
create policy listing_photos_owner_insert on storage.objects for insert to authenticated with check(
  bucket_id='listing-photos' and (public.is_owner() or (storage.foldername(name))[1]=auth.uid()::text
    and (public.is_admin_or_owner() or exists(select 1 from public.vendor_profiles v where v.user_id=auth.uid())))
);
drop policy if exists listing_photos_seller_delete on storage.objects;
create policy listing_photos_seller_delete on storage.objects for delete to authenticated using(
  bucket_id='listing-photos' and (public.is_owner() or (storage.foldername(name))[1]=auth.uid()::text
    and (public.is_admin_or_owner() or exists(select 1 from public.vendor_profiles v where v.user_id=auth.uid())))
);

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;
