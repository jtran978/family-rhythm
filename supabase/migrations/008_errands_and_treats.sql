-- Casa Yuffie update: Annoying Errands, with a sweet treat for every 5 errands someone finishes.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.

create table if not exists public.errands (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  done boolean not null default false,
  done_by uuid references public.profiles on delete set null,
  done_at timestamptz,
  archived boolean not null default false,   -- cleared from the list, but still counts toward treats
  created_at timestamptz not null default now()
);

-- The household's treat menu. A random one is suggested when a treat unlocks.
create table if not exists public.treat_menu (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null default '🍰' check (char_length(emoji) <= 16),
  created_at timestamptz not null default now()
);

-- Each claimed treat. Treats waiting = floor(errands done by a person / 5) - their claimed treats.
create table if not exists public.treat_redemptions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  profile_id uuid not null references public.profiles on delete cascade,
  treat text not null check (char_length(treat) between 1 and 60),
  redeemed_at timestamptz not null default now()
);

create index if not exists errands_owner_created on public.errands (owner, created_at);
create index if not exists treat_redemptions_profile on public.treat_redemptions (profile_id);

-- The database stamps when an errand was finished (same trigger as chores).
drop trigger if exists errands_stamp_done on public.errands;
create trigger errands_stamp_done before insert or update on public.errands
  for each row execute function public.stamp_chore_done();

do $$
declare t text;
begin
  foreach t in array array['errands', 'treat_menu', 'treat_redemptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "household only" on public.%I', t);
    execute format(
      'create policy "household only" on public.%I for all to authenticated
         using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;

grant select, insert, update, delete on public.errands, public.treat_menu, public.treat_redemptions to authenticated;
