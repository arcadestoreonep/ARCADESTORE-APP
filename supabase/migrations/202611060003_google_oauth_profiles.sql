-- Google OAuth users do not provide Arcade Store username metadata before the
-- auth.users insert trigger runs. Derive a unique username from their Google
-- profile or email so the profile row can be created without email OTP.
create or replace function public.create_profile_for_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  candidate text;
  base_name text;
  suffix text;
  counter integer := 0;
begin
  base_name := coalesce(
    nullif(regexp_replace(coalesce(new.raw_user_meta_data->>'username', ''), '[^A-Za-z0-9_]', '', 'g'), ''),
    nullif(regexp_replace(coalesce(split_part(new.email, '@', 1), ''), '[^A-Za-z0-9_]', '', 'g'), ''),
    'player'
  );
  if length(base_name) < 3 then base_name := 'player_' || base_name; end if;
  candidate := left(base_name, 24);

  if exists (select 1 from public.profiles p where p.username = candidate) then
    suffix := right(replace(new.id::text, '-', ''), 8);
    candidate := left(base_name, 15) || '_' || suffix;
    while exists (select 1 from public.profiles p where p.username = candidate) loop
      counter := counter + 1;
      candidate := left(base_name, 13) || '_' || suffix || counter::text;
    end loop;
  end if;

  insert into public.profiles(id, username, display_name, email)
  values (
    new.id,
    candidate,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'full_name', ''), nullif(new.raw_user_meta_data->>'name', ''), candidate),
    new.email
  );
  return new;
end;
$$;
