-- Allow incomplete listings to be saved as drafts. They still require at least
-- one credential before the existing publish functions can activate them.
create or replace function public.replace_listing_configuration(
  p_listing uuid,
  p_credentials jsonb,
  p_transfer_ciphertext text,
  p_transfer_iv text,
  p_rental_options jsonb
)
returns boolean
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists(select 1 from public.listings where id=p_listing) then
    raise exception 'listing not found';
  end if;
  if jsonb_typeof(p_credentials)<>'array'
     or jsonb_array_length(p_credentials)>30 then
    raise exception 'invalid credential fields' using errcode='22023';
  end if;
  if jsonb_array_length(p_credentials)=0
     and not exists(select 1 from public.listings where id=p_listing and status='draft') then
    raise exception 'credentials are required before activation' using errcode='P0001';
  end if;
  if jsonb_typeof(coalesce(p_rental_options,'[]'::jsonb))<>'array' then
    raise exception 'invalid rental options' using errcode='22023';
  end if;

  delete from public.listing_credentials where listing_id=p_listing;
  insert into public.listing_credentials(listing_id,label,ciphertext,iv,sort_order)
  select p_listing,left(x->>'label',80),x->>'ciphertext',x->>'iv',(x->>'sort_order')::integer
  from jsonb_array_elements(p_credentials) x;

  delete from public.listing_transfer_instructions where listing_id=p_listing;
  if coalesce(p_transfer_ciphertext,'')<>'' and coalesce(p_transfer_iv,'')<>'' then
    insert into public.listing_transfer_instructions(listing_id,ciphertext,iv)
    values(p_listing,p_transfer_ciphertext,p_transfer_iv);
  end if;

  delete from public.listing_rental_options where listing_id=p_listing;
  insert into public.listing_rental_options(listing_id,duration_days,price,enabled)
  select p_listing,(x->>'duration_days')::integer,(x->>'price')::bigint,true
  from jsonb_array_elements(coalesce(p_rental_options,'[]'::jsonb)) x;
  return true;
end;
$$;
