-- Copyright (c) 2026 Anish Sandeep Bhargav (Dytalmc). Licensed under the MIT License; see LICENSE.
-- Allow a signed-in player to change their public pilot name without granting
-- unrestricted UPDATE permission on profiles. Run this on an existing database.
begin;
create or replace function public.set_pilot_username(p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_username text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_username, '')));
begin
  if v_user_id is null then
    raise exception 'Sign in is required to change a cloud pilot name.' using errcode = '28000';
  end if;
  if pg_catalog.length(v_username) < 3 or pg_catalog.length(v_username) > 16
     or v_username !~ '^[a-z0-9_]{3,16}$' then
    raise exception 'Pilot names must be 3–16 letters, numbers or underscores.' using errcode = '22023';
  end if;
  update public.profiles
     set username = v_username, updated_at = pg_catalog.now()
   where id = v_user_id;
  if not found then
    insert into public.profiles(id, username) values (v_user_id, v_username);
  end if;
  return v_username;
end;
$function$;
revoke all on function public.set_pilot_username(text) from public, anon;
grant execute on function public.set_pilot_username(text) to authenticated;
commit;
