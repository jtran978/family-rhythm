// Runs hourly from GitHub Actions.
// 1. Touches the database every run, which keeps the free Supabase project from pausing.
// 2. Sends gentle reminders at the right local times.

import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const TZ = 'America/New_York';
const WEIGH_DAYS = ['Mon', 'Fri'];
const WEIGH_IN_HOUR = 8;         // morning reminder on weigh-in days
const WEIGH_IN_NUDGE_HOUR = 19;  // evening nudge if still not logged
const CHORE_HOUR = 18;           // daily nudge if any chores are open

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:family-rhythm@example.com',
  REMINDER_FORCE = ''           // 'weigh' or 'chores' to send a test right now
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY })) {
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(p => [p.type, p.value])
);
const today = `${parts.year}-${parts.month}-${parts.day}`;
const hour = Number(parts.hour);
const weighDay = WEIGH_DAYS.includes(parts.weekday);
console.log(`Local time: ${parts.weekday} ${today} ${hour}:00 (${TZ})`);

// Every run reads the database. This is the keep-awake ping.
const { data: subs, error } = await db.from('push_subscriptions').select('*');
if (error) { console.error(error); process.exit(1); }
console.log(`${subs.length} reminder subscription(s)`);

async function send(sub, payload) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload));
    console.log(`Sent "${payload.tag}" to profile ${sub.profile_id}`);
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await db.from('push_subscriptions').delete().eq('id', sub.id);
      console.log('Removed an expired subscription');
    } else {
      console.error('Push failed', err.statusCode, err.body);
    }
  }
}

const doWeigh = REMINDER_FORCE === 'weigh' || (weighDay && (hour === WEIGH_IN_HOUR || hour === WEIGH_IN_NUDGE_HOUR));
const doChores = REMINDER_FORCE === 'chores' || hour === CHORE_HOUR;

if (doWeigh && subs.length) {
  const { data: logged } = await db.from('weigh_ins').select('profile_id').eq('date', today);
  const done = new Set((logged || []).map(r => r.profile_id));
  const evening = hour === WEIGH_IN_NUDGE_HOUR;
  for (const sub of subs) {
    if (!sub.profile_id || done.has(sub.profile_id)) continue;
    await send(sub, evening
      ? { title: 'Still time to check in ♡', body: 'A family photo is saved for you whenever you’re ready.', tag: 'weigh-in' }
      : { title: 'It’s weigh-in day ♡', body: 'A quick check-in, then a family photo.', tag: 'weigh-in' });
  }
}

if (doChores && subs.length) {
  const { data: open } = await db.from('chores').select('owner').eq('done', false);
  const counts = {};
  for (const c of open || []) counts[c.owner] = (counts[c.owner] || 0) + 1;
  for (const sub of subs) {
    const n = counts[sub.owner];
    if (!n) continue;
    await send(sub, { title: 'A little household love', body: `${n} chore${n === 1 ? ' is' : 's are'} ready when you are.`, tag: 'chores' });
  }
}

console.log('Done');
