-- Edge Functions use the service role server-side after validating the caller.
-- Grant only the table operations those functions need.
grant select on public.feature_flags, public.listings, public.orders,
  public.order_items, public.profiles, public.payouts,
  public.seller_bank_details, public.game_art, public.listing_secrets
to service_role;

grant insert, update, delete on public.listings, public.listing_secrets,
  public.game_art, public.seller_bank_details, public.profiles
to service_role;
