-- A held listing stays visible as booked, but reserve_listing only accepts
-- published listings, so buyers cannot create a second reservation.
drop policy if exists listings_public_or_seller on public.listings;
create policy listings_public_or_seller on public.listings
for select using (
  status in ('published', 'reserved', 'held')
  or seller_id = auth.uid() and public.is_admin_or_owner()
  or public.is_owner()
);
