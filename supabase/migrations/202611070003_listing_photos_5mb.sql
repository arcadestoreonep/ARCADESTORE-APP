do $$
begin
  if not exists (select 1 from storage.buckets where id = 'listing-photos') then
    raise exception 'Expected storage bucket listing-photos to exist; no changes applied';
  end if;
end;
$$;

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'listing-photos';
