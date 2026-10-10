# Family Rhythm

A gentle household app: Monday and Friday weigh-ins with photo rewards, a food journal, and a shared chore list.

- One household login (Supabase Auth), with a "Who's checking in?" profile per person
- Weigh-ins and food are per profile; chores and photos are shared
- Data in Supabase Postgres, photos in a private Supabase Storage bucket
- Hosted on GitHub Pages from `dist/`
- Reminders via Web Push, sent hourly by GitHub Actions (`.github/workflows/reminders.yml`), which also keeps the free Supabase project from pausing

## Layout

| Path | What it is |
| --- | --- |
| `dist/` | The app (static files, deployed to GitHub Pages) |
| `dist/config.js` | Supabase URL, anon key, VAPID public key |
| `supabase/schema.sql` | Tables, Row Level Security, photo bucket |
| `scripts/send-reminders.mjs` | Reminder sender + keep-awake ping |

## GitHub secrets for reminders

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` address).

## Reminder schedule (New York time)

- Mon and Fri, 8am: weigh-in reminder for each profile that hasn't logged yet
- Mon and Fri, 7pm: gentle nudge if still not logged
- Daily, 6pm: nudge if any chores are open

Change the hours at the top of `scripts/send-reminders.mjs`. Run the workflow manually with `force` set to `weigh` or `chores` to send a test.

On iPhone, reminders only work after the app is added to the Home Screen (iOS 16.4+) and turned on from the Today screen.
