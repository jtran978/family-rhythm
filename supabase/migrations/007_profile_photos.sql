-- Family Rhythm update: profile photos.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.
-- Profile photos live in their own private bucket, visible to the household login without the photo PIN.

alter table public.profiles add column if not exists avatar_path text check (char_length(avatar_path) <= 300);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "household avatars read" on storage.objects;
drop policy if exists "household avatars add" on storage.objects;
drop policy if exists "household avatars remove" on storage.objects;

create policy "household avatars read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "household avatars add" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "household avatars remove" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
