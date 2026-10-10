-- Family Rhythm database setup
-- Paste this whole file into Supabase: SQL Editor > New query > Run.
-- Safe to run once on a fresh project.

-- Everything is owned by the household login (auth.uid()).
-- Row Level Security means a login can only ever see its own rows.

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null default '🙂',
  created_at timestamptz not null default now()
);

create table public.weigh_ins (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  profile_id uuid not null references public.profiles on delete cascade,
  date date not null,
  value numeric(6,1) not null check (value > 0 and value < 1000),
  unit text not null check (unit in ('lb', 'kg')),
  created_at timestamptz not null default now(),
  unique (profile_id, date)
);

create table public.foods (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  profile_id uuid not null references public.profiles on delete cascade,
  date date not null,
  name text not null check (char_length(name) between 1 and 80),
  note text check (char_length(note) <= 180),
  created_at timestamptz not null default now()
);

create table public.chores (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  done boolean not null default false,
  done_by uuid references public.profiles on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  profile_id uuid references public.profiles on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index on public.weigh_ins (profile_id, date desc);
create index on public.foods (profile_id, created_at desc);
create index on public.chores (owner, created_at);

-- Row Level Security: each login sees only its own household's rows.
do $$
declare t text;
begin
  foreach t in array array['profiles','weigh_ins','foods','chores','push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "household only" on public.%I for all to authenticated
         using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;

-- Private photo bucket. Files live under a folder named after the login's id.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

create policy "household photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "household photos add" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "household photos remove" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
