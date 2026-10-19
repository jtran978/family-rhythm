-- Casa Yuffie update: weekly family reminders, and a Sunday dinner plan with a grocery list.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.

-- 1. Weekly family reminders (trash night, practice, library day...).
--    days: 0 = Sunday ... 6 = Saturday. remind_hour is New York time.
--    profile_id null means everyone in the household; otherwise only that person's phones.
create table if not exists public.family_reminders (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  note text check (char_length(note) <= 200),
  days smallint[] not null
    check (cardinality(days) between 1 and 7 and days <@ array[0,1,2,3,4,5,6]::smallint[]),
  remind_hour smallint not null default 18 check (remind_hour between 0 and 23),
  profile_id uuid references public.profiles on delete set null,
  last_sent_on date,                       -- stops the same reminder going out twice in a day
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. Household settings for the dinner plan: which nights get a dinner, and what hour
--    on Sunday the week is picked (New York time).
create table if not exists public.household_settings (
  owner uuid primary key default auth.uid() references auth.users on delete cascade,
  dinner_days smallint[] not null default '{0,1,2,3,4}'
    check (dinner_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  plan_hour smallint not null default 9 check (plan_hour between 0 and 23),
  last_dinner_notice date                  -- the Sunday we last sent "dinners are picked"
);

-- 3. The dinner plan: one recipe per night. Deleting a recipe frees up its night.
create table if not exists public.meal_plan (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  recipe_id uuid not null references public.recipes on delete cascade,
  created_at timestamptz not null default now(),
  unique (owner, day)
);

-- 4. Grocery list state for a week (Sunday date). The list itself is built from the week's
--    recipes; rows here remember what's been checked off, plus items added by hand.
create table if not exists public.grocery_items (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  week_start date not null,
  item_key text not null check (char_length(item_key) between 1 and 200),
  name text check (char_length(name) between 1 and 80),   -- only for items added by hand
  custom boolean not null default false,
  checked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner, week_start, item_key)
);

-- 5. Recipes can be left out of the dinner shuffle (desserts, sides, sauces).
alter table public.recipes add column if not exists in_rotation boolean not null default true;

do $$
declare t text;
begin
  foreach t in array array['family_reminders', 'household_settings', 'meal_plan', 'grocery_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "household only" on public.%I', t);
    execute format(
      'create policy "household only" on public.%I for all to authenticated
         using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;

grant select, insert, update, delete
  on public.family_reminders, public.household_settings, public.meal_plan, public.grocery_items
  to authenticated, service_role;
-- The reminder sender reads recipes to pick Sunday's dinners.
grant select on public.recipes to service_role;
