-- Family Rhythm update: the photo library is locked behind a PIN.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.
--
-- How it works:
-- - One PIN per household login, stored as a bcrypt hash. The app can only reach it through the functions below.
-- - A correct PIN unlocks the library for 15 minutes. Storage refuses to list or serve photos otherwise.
-- - 5 wrong PINs in a row lock it for 15 minutes.
-- - A weigh-in saved in the last 10 minutes earns one random photo, viewable for 2 minutes, without the PIN.
-- Forgot the PIN? Run:  update public.photo_lock set pin_hash = null;  then set a new one in the app.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.photo_lock (
  owner uuid primary key references auth.users on delete cascade,
  pin_hash text,
  unlocked_until timestamptz,
  failed_attempts int not null default 0,
  locked_out_until timestamptz
);
alter table public.photo_lock enable row level security; -- no policies: functions only

create table if not exists public.reward_grants (
  owner uuid not null references auth.users on delete cascade,
  object_name text not null,
  expires_at timestamptz not null,
  primary key (owner, object_name)
);
alter table public.reward_grants enable row level security; -- no policies: functions only

-- The database stamps when a weigh-in was last saved, so the app can't fake a reward.
alter table public.weigh_ins add column if not exists saved_at timestamptz not null default now();
create or replace function public.touch_saved_at() returns trigger language plpgsql as $$
begin new.saved_at := now(); return new; end $$;
drop trigger if exists weigh_ins_saved_at on public.weigh_ins;
create trigger weigh_ins_saved_at before insert or update on public.weigh_ins
  for each row execute function public.touch_saved_at();

create or replace function public.photos_unlocked() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.photo_lock where owner = auth.uid() and unlocked_until > now());
$$;

create or replace function public.reward_granted(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reward_grants g
                 where g.owner = auth.uid() and g.object_name = reward_granted.object_name and g.expires_at > now());
$$;

-- 'none' (no PIN yet), 'locked' or 'unlocked'
create or replace function public.photo_pin_status() returns text
language plpgsql stable security definer set search_path = '' as $$
declare r public.photo_lock;
begin
  select * into r from public.photo_lock where owner = auth.uid();
  if not found or r.pin_hash is null then return 'none'; end if;
  return case when r.unlocked_until > now() then 'unlocked' else 'locked' end;
end $$;

-- Set the first PIN, or change it while unlocked.
create or replace function public.set_photo_pin(new_pin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if new_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN must be 4 to 8 digits'; end if;
  if public.photo_pin_status() = 'locked' then raise exception 'Unlock photos before changing the PIN'; end if;
  insert into public.photo_lock (owner, pin_hash, unlocked_until)
  values (auth.uid(), extensions.crypt(new_pin, extensions.gen_salt('bf')), now() + interval '15 minutes')
  on conflict (owner) do update
    set pin_hash = excluded.pin_hash, unlocked_until = excluded.unlocked_until, failed_attempts = 0, locked_out_until = null;
end $$;

-- Returns 'ok', 'wrong', 'locked_out' or 'no_pin'. Never raises, so failed attempts are always counted.
create or replace function public.unlock_photos(pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.photo_lock;
begin
  select * into r from public.photo_lock where owner = auth.uid() for update;
  if not found or r.pin_hash is null then return 'no_pin'; end if;
  if r.locked_out_until > now() then return 'locked_out'; end if;
  if extensions.crypt(coalesce(pin, ''), r.pin_hash) = r.pin_hash then
    update public.photo_lock set unlocked_until = now() + interval '15 minutes', failed_attempts = 0, locked_out_until = null
      where owner = auth.uid();
    return 'ok';
  end if;
  update public.photo_lock
    set failed_attempts = case when r.failed_attempts >= 4 then 0 else r.failed_attempts + 1 end,
        locked_out_until = case when r.failed_attempts >= 4 then now() + interval '15 minutes' end
    where owner = auth.uid();
  return case when r.failed_attempts >= 4 then 'locked_out' else 'wrong' end;
end $$;

create or replace function public.lock_photos() returns void
language sql security definer set search_path = '' as $$
  update public.photo_lock set unlocked_until = null where owner = auth.uid();
$$;

-- After a fresh weigh-in, pick one random photo and allow it for 2 minutes. Returns its path, or null.
create or replace function public.grant_reward() returns text
language plpgsql security definer set search_path = '' as $$
declare pick text;
begin
  if not exists (select 1 from public.weigh_ins where owner = auth.uid() and saved_at > now() - interval '10 minutes') then
    return null;
  end if;
  select o.name into pick from storage.objects o
    where o.bucket_id = 'photos' and (storage.foldername(o.name))[1] = auth.uid()::text and o.name not like '%/.%'
    order by random() limit 1;
  if pick is null then return null; end if;
  delete from public.reward_grants where owner = auth.uid() and expires_at < now();
  insert into public.reward_grants (owner, object_name, expires_at) values (auth.uid(), pick, now() + interval '2 minutes')
    on conflict (owner, object_name) do update set expires_at = excluded.expires_at;
  return pick;
end $$;

revoke execute on function public.photos_unlocked(), public.reward_granted(text), public.photo_pin_status(),
  public.set_photo_pin(text), public.unlock_photos(text), public.lock_photos(), public.grant_reward() from public, anon;
grant execute on function public.photos_unlocked(), public.reward_granted(text), public.photo_pin_status(),
  public.set_photo_pin(text), public.unlock_photos(text), public.lock_photos(), public.grant_reward() to authenticated;

-- Storage: the library needs the PIN; a reward photo needs a fresh grant.
drop policy if exists "household photos read" on storage.objects;
drop policy if exists "household photos add" on storage.objects;
drop policy if exists "household photos remove" on storage.objects;

create policy "household photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
         and (public.photos_unlocked() or public.reward_granted(name)));
create policy "household photos add" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.photos_unlocked());
create policy "household photos remove" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.photos_unlocked());
