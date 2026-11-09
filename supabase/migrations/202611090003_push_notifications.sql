-- Browser push subscriptions and per-account notification preferences.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_self_manage on public.push_subscriptions;
create policy push_subscriptions_self_manage on public.push_subscriptions for all to authenticated
  using (user_id=auth.uid()) with check (user_id=auth.uid());
revoke all on public.push_subscriptions from anon;
grant select,insert,update,delete on public.push_subscriptions to authenticated;

create table if not exists public.push_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  instant_sale boolean not null default true,
  assisted_delivery boolean not null default true,
  chat_message boolean not null default true,
  rental_started boolean not null default true,
  rental_expiring boolean not null default true,
  rental_expired boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.push_preferences enable row level security;
drop policy if exists push_preferences_self_manage on public.push_preferences;
create policy push_preferences_self_manage on public.push_preferences for all to authenticated
  using (user_id=auth.uid()) with check (user_id=auth.uid());
revoke all on public.push_preferences from anon;
grant select,insert,update on public.push_preferences to authenticated;

-- Server-only idempotency ledger; contains no push credentials or payload text.
create table if not exists public.push_deliveries (
  event_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key(event_key,user_id)
);
alter table public.push_deliveries enable row level security;
revoke all on public.push_deliveries from anon,authenticated;
grant all on public.push_deliveries to service_role;

-- Supabase Vault holds the same random internal cron token as the Edge secret.
-- The migration intentionally does not contain the token value.
create extension if not exists pg_net with schema extensions;
select cron.schedule(
  'arcadestore-push-rental-sweep',
  '0 * * * *',
  $job$
    select net.http_post(
      url := 'https://yuejcomfxczdbjlgxcsw.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-arcade-push-token',(select decrypted_secret from vault.decrypted_secrets where name='arcadestore-push-cron-token' order by created_at desc limit 1)
      ),
      body := '{"action":"rental_sweep"}'::jsonb
    );
  $job$
);
