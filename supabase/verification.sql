-- Run these read-only checks in Supabase SQL Editor after applying migrations.

-- 1. Every application table exists.
with expected(table_name) as (
  values ('profiles'), ('feature_flags'), ('feature_flag_logs'), ('listings'),
         ('game_art'), ('listing_secrets'), ('reservations'), ('orders'),
         ('order_items'), ('ledger'), ('seller_bank_details'), ('payouts'),
         ('auth_attempts')
)
select e.table_name, (t.table_name is not null) as exists
from expected e
left join information_schema.tables t
  on t.table_schema = 'public' and t.table_name = e.table_name
order by e.table_name;

-- 2. RLS is enabled on every public table. Investigate any false row.
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- 3. The six feature flags have the intended values.
select key, enabled,
       (key, enabled) in (
         ('buyer_selling', false), ('admin_publishing', true),
         ('reservations', true), ('checkout', true),
         ('payouts', false), ('live_payments', false)
       ) as intended
from public.feature_flags
order by key;

-- 4. Listing photos are limited to 5 MiB and the three supported image types.
select id, file_size_limit, allowed_mime_types,
       file_size_limit = 5242880
       and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']
       and cardinality(allowed_mime_types) = 3 as configured
from storage.buckets
where id = 'listing-photos';

-- 5. At least one auth user has the owner role. This does not reveal user IDs.
select exists (
  select 1 from auth.users where raw_app_meta_data->>'role' = 'owner'
) as owner_role_present;

-- 6. The buyer-profile signup trigger exists on auth.users.
select tgname, pg_get_triggerdef(oid) as trigger_definition
from pg_trigger
where tgrelid = 'auth.users'::regclass
  and tgname = 'on_auth_user_created_arcadestore'
  and not tgisinternal;
