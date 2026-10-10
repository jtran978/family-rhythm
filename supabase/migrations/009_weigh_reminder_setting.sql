-- Casa Yuffie update: turn weigh-in reminders off for a person (chore and bill reminders still come).
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.

alter table public.profiles add column if not exists weigh_reminders boolean not null default true;
