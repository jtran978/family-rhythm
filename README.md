# Family Rhythm

A gentle household app: Monday and Friday weigh-ins with photo rewards and a shared chore list with reminders.

- One household login (Supabase Auth), with a "Who's checking in?" profile per person
- Weigh-ins are per profile; chores and photos are shared
- Data in Supabase Postgres, photos in a private Supabase Storage bucket
- Hosted on GitHub Pages from `dist/`
- Reminders via Web Push, sent hourly by GitHub Actions (`.github/workflows/reminders.yml`), which also keeps the free Supabase project from pausing

## Layout

| Path | What it is |
| --- | --- |
| `dist/` | The app (static files, deployed to GitHub Pages) |
| `dist/config.js` | Supabase URL, anon key, VAPID public key |
| `supabase/schema.sql` | Tables, Row Level Security, photo bucket (fresh setup) |
| `supabase/migrations/` | Updates to run after `schema.sql`, in order (each is safe to re-run) |
| `scripts/send-reminders.mjs` | Reminder sender + keep-awake ping |

## Photo PIN

The photo library is locked behind a PIN that's checked in the database: storage won't list or serve photos until the PIN is entered, and it locks again after 15 minutes, when you leave the Photos tab, or when the app goes to the background. Five wrong tries locks it for 15 minutes. A fresh weigh-in still reveals one random photo without the PIN.

Forgot the PIN? In Supabase SQL Editor run `update public.photo_lock set pin_hash = null;`, then set a new one in the app.

## GitHub secrets for reminders

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` address).

## Reminder schedule (New York time)

- Mon and Fri, 8am: weigh-in reminder for each profile that hasn't logged yet
- Mon and Fri, 7pm: gentle nudge if still not logged
- Each chore: daily at the time picked for it in the app, until it's marked done (or set to "No reminder")

Change the weigh-in hours at the top of `scripts/send-reminders.mjs`. GitHub runs the sender once an hour, a few minutes past, and sometimes late, so reminders land within the hour, not to the minute. Run the workflow manually with `force` set to `weigh` or `chores` to send a test.

On iPhone, reminders only work after the app is added to the Home Screen (iOS 16.4+) and turned on from the Today screen.
