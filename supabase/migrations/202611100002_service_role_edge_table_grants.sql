-- The Edge Functions use the service-role client for server-side reads and
-- writes. RLS bypass does not grant SQL table privileges, so explicitly grant
-- only the operations those functions use.
grant select on public.listing_credentials,
  public.listing_transfer_instructions,
  public.listing_rental_options
to service_role;

grant select, insert, update on public.vendor_profiles to service_role;

grant select on public.order_chats to service_role;
grant select, insert on public.chat_messages to service_role;
grant select, insert, update on public.chat_read_state to service_role;

grant select, update on public.orders, public.order_items to service_role;

grant select, delete on public.push_subscriptions to service_role;
grant select on public.push_preferences to service_role;
