-- Casa Yuffie update: start the reminder job on time, every hour, from Supabase.
-- GitHub's own scheduler skips or delays hourly runs, so Supabase's scheduler (pg_cron)
-- asks GitHub to run the "Reminders" workflow at 2 minutes past every hour instead.
--
-- 1. Paste your GitHub token between the quotes on the next line (it starts with github_pat_).
-- 2. Run the whole file in Supabase: SQL Editor > New query > Run. Safe to run again (e.g. with a new token).

do $$
declare token text := 'PASTE_YOUR_TOKEN_HERE';
begin
  token := regexp_replace(token, '\s', '', 'g');  -- ignore stray spaces or line breaks from pasting
  if token = 'PASTE_YOUR_TOKEN_HERE' then
    raise exception 'The token is still the placeholder. Replace PASTE_YOUR_TOKEN_HERE on line 9 with your token.';
  end if;
  if token !~ '^(github_pat_|ghp_)' then
    raise exception 'That doesn''t look like a GitHub token. It should start with github_pat_ (it starts with "%").', left(token, 4);
  end if;
  if exists (select 1 from vault.secrets where name = 'github_reminders_token') then
    perform vault.update_secret((select id from vault.secrets where name = 'github_reminders_token'), token);
  else
    perform vault.create_secret(token, 'github_reminders_token', 'Casa Yuffie: runs the Reminders workflow');
  end if;
end $$;

create extension if not exists pg_net;
create extension if not exists pg_cron;
create schema if not exists private;

-- Asks GitHub to run the Reminders workflow now. Not reachable from the app.
create or replace function private.trigger_reminders() returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://api.github.com/repos/jtran978/family-rhythm/actions/workflows/reminders.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_reminders_token'),
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'casa-yuffie-reminders',
      'Content-Type', 'application/json'),
    body := '{"ref":"main"}'::jsonb
  );
$$;
revoke all on function private.trigger_reminders() from public;

select cron.unschedule(jobid) from cron.job where jobname = 'casa-yuffie-reminders';
select cron.schedule('casa-yuffie-reminders', '2 * * * *', 'select private.trigger_reminders()');

-- Run it once now so we can check it works.
select private.trigger_reminders();
