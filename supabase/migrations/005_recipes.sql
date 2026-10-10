-- Family Rhythm update: shared recipe box.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.
-- Recipes are imported by the import-recipe Edge Function (supabase/functions/import-recipe).

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  url text check (url ~* '^https?://' and char_length(url) <= 2000),
  title text not null check (char_length(title) between 1 and 200),
  image_url text check (image_url ~* '^https://' and char_length(image_url) <= 2000),
  site text check (char_length(site) <= 200),
  yields text check (char_length(yields) <= 80),
  total_minutes int check (total_minutes between 1 and 10000),
  ingredients text[] not null default '{}',
  instructions jsonb not null default '[]',   -- [{ "name": "Sauce" or null, "steps": ["..."] }]
  notes text check (char_length(notes) <= 4000),
  added_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists recipes_owner_created on public.recipes (owner, created_at desc);

alter table public.recipes enable row level security;
drop policy if exists "household only" on public.recipes;
create policy "household only" on public.recipes for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

grant select, insert, update, delete on public.recipes to authenticated;
