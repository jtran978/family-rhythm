# Casa Yuffie

A gentle household app: Monday and Friday weigh-ins with photo rewards, a shared chore list, Annoying Errands that earn a sweet treat every 5, household bills with reminders and payment history, and a recipe box that imports recipes from a link.

- One household login (Supabase Auth), with a "Who's checking in?" profile per person (each with an emoji or their own photo)
- Weigh-ins and sweet treats are per profile; chores, errands, bills, recipes and photos are shared
- Data in Supabase Postgres, photos in a private Supabase Storage bucket
- Hosted on GitHub Pages from `dist/`
- Reminders via Web Push, sent hourly by GitHub Actions (`.github/workflows/reminders.yml`), started on time each hour by Supabase's scheduler, which also keeps the free Supabase project from pausing

## Layout

| Path | What it is |
| --- | --- |
| `dist/` | The app (static files, deployed to GitHub Pages) |
| `dist/config.js` | Supabase URL, anon key, VAPID public key |
| `supabase/schema.sql` | Tables, Row Level Security, photo bucket (fresh setup) |
| `supabase/migrations/` | Updates to run after `schema.sql`, in order (each is safe to re-run) |
| `scripts/send-reminders.mjs` | Reminder sender + keep-awake ping |
| `supabase/functions/import-recipe/` | Edge Function that reads a recipe page for the Recipes tab |

## Recipes

Paste a recipe link and the `import-recipe` Edge Function fetches the page and reads the structured recipe data most sites embed for search engines (title, photo, time, servings, ingredients, steps). Some sites, such as Allrecipes and Serious Eats, block apps from reading them; the link is still saved and the recipe can be filled in with Edit.

Deploy the function once: Supabase dashboard > Edge Functions > Deploy a new function > Via Editor, name it `import-recipe`, paste `supabase/functions/import-recipe/index.ts`, Deploy. It only answers signed-in household logins.

## Photo PIN

The photo library is locked behind a PIN that's checked in the database: storage won't list or serve photos until the PIN is entered, and it locks again after 15 minutes, when you leave the Photos tab, or when the app goes to the background. Five wrong tries locks it for 15 minutes. Changing the PIN needs the current PIN. A weigh-in, a finished chore or a paid bill each reveal one random photo without the PIN (one per event).

Forgot the PIN? In Supabase SQL Editor run `update public.photo_lock set pin_hash = null;`, then set a new one in the app.

## GitHub secrets for reminders

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` address).

## Reminder schedule (New York time)

- Mon and Fri, 8am: weigh-in reminder for each profile that hasn't logged yet
- Mon and Fri, 7pm: gentle nudge if still not logged
- Each bill: once per due date, the number of days before and at the time picked for it in the app
- Each chore: daily at the time picked for it in the app, until it's marked done (or set to "No reminder")

Change the weigh-in hours at the top of `scripts/send-reminders.mjs`. GitHub runs the sender once an hour, a few minutes past, and sometimes late, so reminders land within the hour, not to the minute. Run the workflow manually with `force` set to `weigh`, `chores` or `bills` to send a test.

On iPhone, reminders only work after the app is added to the Home Screen (iOS 16.4+) and turned on from the Today screen.

## Reminder schedule setup

Supabase's scheduler (pg_cron) starts the Reminders workflow at 2 minutes past every hour, using a fine-grained GitHub token (Actions: read and write on this repo only) stored in Supabase Vault. See `supabase/migrations/011_reliable_reminder_schedule.sql`. When the token expires, make a new one and run that file again with it.
