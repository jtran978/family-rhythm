-- Casa Yuffie update: a photo on each chore (take one or pick from the library).
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.
-- Chore photos live in their own private bucket, visible to the household login without the photo PIN.

alter table public.chores add column if not exists photo_path text check (char_length(photo_path) <= 300);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chore-photos', 'chore-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "household chore photos read" on storage.objects;
drop policy if exists "household chore photos add" on storage.objects;
drop policy if exists "household chore photos remove" on storage.objects;

create policy "household chore photos read" on storage.objects for select to authenticated
  using (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "household chore photos add" on storage.objects for insert to authenticated
  with check (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "household chore photos remove" on storage.objects for delete to authenticated
  using (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);
