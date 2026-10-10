// Runs hourly from GitHub Actions.
// 1. Touches the database every run, which keeps the free Supabase project from pausing.
// 2. Sends gentle reminders at the right local times.

import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const TZ = 'America/New_York';
const WEIGH_DAYS = ['Mon', 'Fri'];
const WEIGH_IN_HOUR = 8;         // morning reminder on weigh-in days
const WEIGH_IN_NUDGE_HOUR = 19;  // evening nudge if still not logged
const CATCH_UP_HOURS = 2;  // GitHub sometimes runs late or skips an hour
// Each chore and bill sets its own reminder hour in the app.

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:family-rhythm@example.com',
  REMINDER_FORCE = ''           // 'weigh', 'chores' or 'bills' to send a test right now
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

if (doWeigh && subs.length) {
  const { data: logged } = await db.from('weigh_ins').select('profile_id').eq('date', today);
  const done = new Set((logged || []).map(r => r.profile_id));
  // People with weigh-in reminders turned off in their profile are skipped.
  const { data: optedOut } = await db.from('profiles').select('id').eq('weigh_reminders', false);
  for (const p of optedOut || []) done.add(p.id);
  const evening = hour === WEIGH_IN_NUDGE_HOUR;
  for (const sub of subs) {
    if (!sub.profile_id || done.has(sub.profile_id)) continue;
    await send(sub, evening
      ? { title: 'Still time to check in ♡', body: 'A family photo is saved for you whenever you’re ready.', tag: 'weigh-in' }
      : { title: 'It’s weigh-in day ♡', body: 'A quick check-in, then a family photo.', tag: 'weigh-in' });
  }
}

// Open chores whose reminder hour has arrived (within the catch-up window) and
// haven't been reminded today. A forced test sends every open chore that has a reminder.
if (subs.length) {
  const force = REMINDER_FORCE === 'chores';
  let q = db.from('chores').select('id, owner, name').eq('done', false).not('remind_hour', 'is', null);
  if (!force) q = q
    .lte('remind_hour', hour).gte('remind_hour', hour - CATCH_UP_HOURS)
    .or(`last_reminded_on.is.null,last_reminded_on.lt.${today}`);
  const { data: due, error: choreError } = await q;
  if (choreError) console.error(choreError);

  const byOwner = {};
  for (const c of due || []) (byOwner[c.owner] ||= []).push(c.name);
  for (const sub of subs) {
    const names = byOwner[sub.owner];
    if (!names) continue;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    await send(sub, { title: 'A little household love', body: `${list} ${names.length === 1 ? 'is' : 'are'} ready when you are.`, tag: `chores-${hour}` });
  }
  if (!force && due?.length) {
    await db.from('chores').update({ last_reminded_on: today }).in('id', due.map(c => c.id));
  }
}

// Bills: one reminder per due date, remind_days before it at remind_hour. A bill added
// after its reminder day (or already overdue) is reminded at the next matching hour.
// A forced test sends every active bill that has a reminder.
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const money = n => n == null ? '' : ` (${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)})`;
function dueText(nextDue) {
  const days = dayDiff(nextDue, today);
  if (days === 0) return 'is due today';
  if (days === 1) return 'is due tomorrow';
  if (days < 0) return `was due ${days === -1 ? 'yesterday' : `${-days} days ago`}`;
  return `is due in ${days} days`;
}

if (subs.length) {
  const force = REMINDER_FORCE === 'bills';
  let q = db.from('bills').select('id, owner, name, amount, next_due, remind_days, last_reminded_for')
    .eq('active', true).not('remind_days', 'is', null);
  if (!force) q = q.lte('remind_hour', hour).gte('remind_hour', hour - CATCH_UP_HOURS);
  const { data: bills, error: billError } = await q;
  if (billError) console.error(billError);

  const due = (bills || []).filter(b => force ||
    (dayDiff(b.next_due, today) <= b.remind_days && b.last_reminded_for !== b.next_due));
  for (const b of due) {
    for (const sub of subs.filter(s => s.owner === b.owner)) {
      await send(sub, { title: 'Bill reminder', body: `${b.name}${money(b.amount)} ${dueText(b.next_due)}.`, tag: `bill-${b.id}` });
    }
    if (!force) await db.from('bills').update({ last_reminded_for: b.next_due }).eq('id', b.id);
  }
}

console.log('Done');
