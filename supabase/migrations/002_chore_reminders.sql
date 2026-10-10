-- Family Rhythm update: remove the food journal, add per-chore reminder times.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.

-- 1. The food journal is gone. This deletes any food entries.
drop table if exists public.foods;

-- 2. Each chore has its own reminder hour (New York time, 0-23). Null means no reminder.
--    last_reminded_on stops the same chore being sent twice in one day.
alter table public.chores
  add column if not exists remind_hour smallint default 18 check (remind_hour between 0 and 23),
  add column if not exists last_reminded_on date;

-- 3. Let the signed-in app and the reminder sender use the tables.
--    Row Level Security still limits the app to its own household's rows.
grant select, insert, update, delete
  on public.profiles, public.weigh_ins, public.chores, public.push_subscriptions
  to authenticated, service_role;
