-- Admin Edge Functions need to display active reservation state for listings.
-- The owner check still happens in the function and release RPC.
grant select on public.reservations to service_role;
