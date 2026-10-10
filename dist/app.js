// Family Rhythm: one household login, a profile per person.
// Weigh-ins are per profile. Chores and photos are shared.

const cfg = window.FAMILY_RHYTHM_CONFIG || {};
const configured = /^https:\/\//.test(cfg.supabaseUrl || '') && !/PASTE_/.test(cfg.supabaseAnonKey || 'PASTE_');
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } }
};

const FACES = ['😊', '🌷', '🌿', '☀️', '🐻', '🦊', '🐢', '⭐'];
const WEIGH_DAYS = [1, 5]; // Monday, Friday
const DEFAULT_CHORE_HOUR = 18;

let session = null;
let profiles = [];
let me = null;
const data = { weights: [], chores: [], photos: [] };

// ---------- helpers ----------
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const prettyDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2000); }
function oops(error, fallback = 'Something went sideways. Try again?') { if (error) { console.error(error); toast(fallback); return true; } return false; }
const profileName = id => profiles.find(p => p.id === id)?.name;
// Reminder hours are New York time, matching scripts/send-reminders.mjs.
const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const hourOptions = selected => ['<option value="">No reminder</option>']
  .concat(Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === selected ? ' selected' : ''}>${hourLabel(h)}</option>`))
  .join('');

// ---------- screens ----------
function showGate(name) {
  document.body.classList.toggle('locked', !!name);
  $$('.gate').forEach(g => g.classList.toggle('active', g.id === `${name}Gate`));
}

async function boot() {
  $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (!configured) return showGate('setup');

  const { data: { session: s } } = await sb.auth.getSession();
  session = s;
  sb.auth.onAuthStateChange((_event, s2) => {
    const wasSignedIn = !!session;
    session = s2;
    if (!s2 && wasSignedIn) { me = null; showGate('auth'); }
  });
  if (!session) return showGate('auth');
  await loadProfiles(true);
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const err = $('#loginError');
  err.hidden = true;
  const { data: res, error } = await sb.auth.signInWithPassword({
    email: $('#loginEmail').value.trim(),
    password: $('#loginPassword').value
  });
  if (error) { err.textContent = 'That email and password didn’t match. Give it another try.'; err.hidden = false; return; }
  session = res.session;
  $('#loginPassword').value = '';
  await loadProfiles(false);
};

$('#signOut').onclick = async () => {
  store.del('fr-profile');
  await sb.auth.signOut();
  showGate('auth');
};

// ---------- profiles ----------
async function loadProfiles(autoEnter) {
  const { data: rows, error } = await sb.from('profiles').select('*').order('created_at');
  if (oops(error, 'Couldn’t load profiles')) return showGate('picker');
  profiles = rows;
  renderPicker();
  const remembered = profiles.find(p => p.id === store.get('fr-profile'));
  if (autoEnter && remembered) return enterApp(remembered);
  showGate('picker');
  if (!profiles.length) openProfileForm();
}

function renderPicker() {
  $('#profileList').innerHTML = profiles.map(p =>
    `<button class="profile-btn" data-profile="${p.id}"><span class="face">${esc(p.emoji)}</span>${esc(p.name)}</button>`
  ).join('') + `<button class="profile-btn add" id="addProfile"><span class="face">＋</span>Add person</button>`;
  $$('[data-profile]').forEach(b => b.onclick = () => enterApp(profiles.find(p => p.id === b.dataset.profile)));
  $('#addProfile').onclick = openProfileForm;
}

let chosenFace = FACES[0];
function openProfileForm() {
  chosenFace = FACES[profiles.length % FACES.length];
  $('#emojiRow').innerHTML = FACES.map(f => `<button type="button" data-face="${f}" class="${f === chosenFace ? 'selected' : ''}">${f}</button>`).join('');
  $$('[data-face]').forEach(b => b.onclick = () => {
    chosenFace = b.dataset.face;
    $$('[data-face]').forEach(x => x.classList.toggle('selected', x === b));
  });
  $('#profileForm').hidden = false;
  $('#cancelProfile').hidden = !profiles.length;
  $('#profileName').focus();
}
$('#cancelProfile').onclick = () => { $('#profileForm').hidden = true; };
$('#profileForm').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.from('profiles').insert({ name: $('#profileName').value.trim(), emoji: chosenFace });
  if (oops(error, 'Couldn’t add that person')) return;
  e.target.reset();
  $('#profileForm').hidden = true;
  await loadProfiles(false);
};

$('#switchProfile').onclick = () => { renderPicker(); $('#profileForm').hidden = true; showGate('picker'); };

async function enterApp(profile) {
  me = profile;
  data.weights = [];
  render();
  store.set('fr-profile', me.id);
  $('#avatarFace').textContent = me.emoji;
  $('#helloName').textContent = me.name;
  $('#weightUnit').value = store.get(`fr-unit-${me.id}`) || 'lb';
  showGate(null);
  go('home');
  await refresh();
  syncReminderProfile();
}

// ---------- data ----------
async function refresh() {
  if (!me) return;
  const [w, c] = await Promise.all([
    sb.from('weigh_ins').select('*').eq('profile_id', me.id).order('date', { ascending: false }).limit(400),
    sb.from('chores').select('*').order('created_at')
  ]);
  if (oops(w.error || c.error, 'Couldn’t reach the cloud. Check your connection.')) return;
  data.weights = w.data; data.chores = c.data;
  render();
}

// ---------- navigation ----------
function go(id) {
  const leaving = $('.view.active')?.id;
  if (leaving === 'photos' && id !== 'photos') lockPhotos();
  if (id === 'photos' && leaving !== 'photos') openPhotos();
  $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  $$('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.bottom-nav button').forEach(b => b.onclick = () => go(b.dataset.view));
$$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

// ---------- rendering ----------
function render() {
  const today = dateKey();
  const done = data.chores.filter(x => x.done).length;
  const logged = data.weights.some(x => x.date === today);
  $('#choreSummary').textContent = `${done} of ${data.chores.length}`;
  $('#weighSummary').textContent = logged ? 'Done today ✓' : scheduledToday() ? 'Due today' : `Next: ${nextWeighIn().split(',')[0]}`;
  const wins = done + (logged ? 1 : 0);
  $('#todayProgress').textContent = `${wins} small win${wins === 1 ? '' : 's'}`;

  let status = 'Next weigh-in is ' + nextWeighIn();
  if (scheduledToday() && !logged) status = 'Today is a weigh-in day. A family photo is waiting.';
  if (logged) status = 'Today’s check-in is complete. Nicely done.';
  $('#weighStatus').textContent = status;

  renderWeights(); renderChores();
}
const scheduledToday = () => WEIGH_DAYS.includes(new Date().getDay());
function nextWeighIn() {
  const d = new Date();
  for (let i = scheduledToday() ? 1 : 0; i < 8; i++) {
    const x = new Date(d); x.setDate(d.getDate() + i);
    if (WEIGH_DAYS.includes(x.getDay())) return x.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
}

function weightCard(w) {
  return `<div class="list-card"><div class="grow"><strong>${Number(w.value)} ${esc(w.unit)}</strong><small>${prettyDate(w.date)}</small></div><button class="delete" data-delete-weight="${w.id}" aria-label="Delete weigh-in">×</button></div>`;
}
function renderWeights() {
  $('#recentWeights').innerHTML = data.weights.slice(0, 3).map(weightCard).join('') || '<div class="empty">Your first gentle check-in will appear here.</div>';
  $('#weightHistory').innerHTML = data.weights.map(weightCard).join('') || '<div class="empty">No weigh-ins yet. Monday and Friday are your check-in days.</div>';
  $$('[data-delete-weight]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('weigh_ins').delete().eq('id', b.dataset.deleteWeight);
    if (!oops(error)) refresh();
  });
}

function renderChores() {
  $('#choreList').innerHTML = data.chores.map(x => {
    const who = x.done && profileName(x.done_by);
    return `<div class="list-card"><button class="check ${x.done ? 'done' : ''}" data-toggle-chore="${x.id}" aria-label="Mark complete">${x.done ? '✓' : ''}</button><div class="grow ${x.done ? 'completed' : ''}"><strong>${esc(x.name)}</strong><small>${x.done ? (who ? `Done by ${esc(who)}` : 'Complete') : 'Ready when you are'}</small></div><select class="time-select compact" data-chore-time="${x.id}" aria-label="Reminder time for ${esc(x.name)}">${hourOptions(x.remind_hour)}</select><button class="delete" data-delete-chore="${x.id}" aria-label="Delete chore">×</button></div>`;
  }).join('') || '<div class="empty">Your chore list is clear.</div>';
  $$('[data-chore-time]').forEach(s => s.onchange = async () => {
    const remind_hour = s.value === '' ? null : Number(s.value);
    // Clearing last_reminded_on lets a new time still remind later today.
    const { error } = await sb.from('chores').update({ remind_hour, last_reminded_on: null }).eq('id', s.dataset.choreTime);
    if (oops(error, 'Couldn’t change that reminder')) return refresh();
    toast(remind_hour === null ? 'Reminder off' : `Reminder set for ${hourLabel(remind_hour)}`);
    refresh();
  });
  $$('[data-toggle-chore]').forEach(b => b.onclick = async () => {
    const chore = data.chores.find(x => x.id === b.dataset.toggleChore);
    const done = !chore.done;
    const { error } = await sb.from('chores').update({ done, done_by: done ? me.id : null, done_at: done ? new Date().toISOString() : null }).eq('id', chore.id);
    if (!oops(error)) { if (done) toast('Nice. One less thing.'); refresh(); }
  });
  $$('[data-delete-chore]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('chores').delete().eq('id', b.dataset.deleteChore);
    if (!oops(error)) refresh();
  });
}

// ---------- forms ----------
$('#choreRemind').innerHTML = hourOptions(DEFAULT_CHORE_HOUR);
$('#choreForm').onsubmit = async e => {
  e.preventDefault();
  const r = $('#choreRemind').value;
  const { error } = await sb.from('chores').insert({ name: $('#choreName').value.trim(), remind_hour: r === '' ? null : Number(r) });
  if (oops(error, 'Couldn’t add that chore')) return;
  $('#choreName').value = ''; toast('Chore added'); refresh();
};

const openWeigh = () => { $('#weightValue').value = ''; $('#weighDialog').showModal(); setTimeout(() => $('#weightValue').focus(), 100); };
$('#openWeighIn').onclick = openWeigh;
$('#openWeighInLarge').onclick = openWeigh;
$('#weighForm').onsubmit = async e => {
  e.preventDefault();
  const unit = $('#weightUnit').value;
  store.set(`fr-unit-${me.id}`, unit);
  const { error } = await sb.from('weigh_ins').upsert(
    { profile_id: me.id, date: dateKey(), value: Number($('#weightValue').value), unit },
    { onConflict: 'profile_id,date' }
  );
  if (oops(error, 'Couldn’t save your weigh-in')) return;
  $('#weighDialog').close();
  showReward();
  refresh();
};

// A fresh weigh-in earns one random photo for a couple of minutes, no PIN needed.
async function showReward() {
  const img = $('#rewardImage'), empty = $('#rewardEmpty');
  img.hidden = true; empty.hidden = true;
  $('#reward').hidden = false;
  const { data: path } = await sb.rpc('grant_reward');
  const signed = path ? (await sb.storage.from('photos').createSignedUrl(path, 120)).data : null;
  if (signed?.signedUrl) { img.src = signed.signedUrl; img.hidden = false; } else empty.hidden = false;
}
$('#closeReward').onclick = () => { $('#reward').hidden = true; };

// ---------- photo PIN ----------
// The PIN is checked in the database, and storage only serves the library while it's
// unlocked (see supabase/migrations/003_photo_pin.sql), so this isn't just a screen cover.
let pinMode = 'unlock'; // 'unlock' | 'create' | 'change'
let photosOpen = false;
let pickingPhotos = false; // the iOS photo picker can briefly hide the app; don't lock mid-upload

function clearLibrary() {
  photosOpen = false;
  data.photos = [];
  $('#photoGrid').innerHTML = '';
  $('#photoLibrary').hidden = true;
}

function showPinForm(mode) {
  pinMode = mode;
  clearLibrary();
  $('#pinForm').reset();
  $('#pinForm').hidden = false;
  $('#pinTitle').textContent = { unlock: 'Enter the photo PIN', create: 'Create a photo PIN', change: 'Choose a new photo PIN' }[mode];
  $('#pinHint').textContent = mode === 'unlock'
    ? 'Photos lock again when you leave this tab.'
    : '4 to 8 digits. Anyone who wants to browse the photos will need it.';
  $('#pinConfirm').hidden = mode === 'unlock';
  $('#pinConfirm').required = mode !== 'unlock';
  $('#pinSubmit').textContent = mode === 'unlock' ? 'Unlock' : 'Save PIN';
  $('#pinCancel').hidden = mode !== 'change';
  $('#pinError').hidden = true;
}

async function openPhotos() {
  $('#pinForm').hidden = true; clearLibrary();
  const { data: status, error } = await sb.rpc('photo_pin_status');
  if (oops(error, 'Couldn’t check the photo lock')) return;
  if (status === 'unlocked') return openLibrary();
  showPinForm(status === 'none' ? 'create' : 'unlock');
}

function openLibrary() {
  photosOpen = true;
  $('#pinForm').hidden = true;
  $('#photoLibrary').hidden = false;
  loadPhotos();
}

async function lockPhotos() {
  if (!photosOpen) return;
  clearLibrary();
  await sb.rpc('lock_photos');
}

const pinError = t => { $('#pinError').textContent = t; $('#pinError').hidden = false; };
$('#pinForm').onsubmit = async e => {
  e.preventDefault();
  const pin = $('#pinInput').value;
  if (pinMode === 'unlock') {
    const { data: result, error } = await sb.rpc('unlock_photos', { pin });
    if (oops(error, 'Couldn’t check the PIN')) return;
    if (result === 'ok') return openLibrary();
    if (result === 'no_pin') return showPinForm('create');
    $('#pinInput').value = '';
    return pinError(result === 'locked_out' ? 'Too many tries. Photos are locked for 15 minutes.' : 'That PIN didn’t match.');
  }
  if (pin !== $('#pinConfirm').value) return pinError('Those two PINs don’t match.');
  const { error } = await sb.rpc('set_photo_pin', { new_pin: pin });
  if (oops(error, 'Couldn’t save the PIN')) return;
  toast('Photo PIN saved');
  openLibrary();
};
$('#pinCancel').onclick = openLibrary;
$('#changePin').onclick = () => showPinForm('change');
$('#lockPhotos').onclick = async () => { await lockPhotos(); showPinForm('unlock'); };

// ---------- photos (private bucket, shared by the household) ----------
const photoFolder = () => session.user.id;

async function loadPhotos() {
  const { data: files, error } = await sb.storage.from('photos').list(photoFolder(), { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
  if (oops(error, 'Couldn’t load photos')) return;
  if (!photosOpen) return;
  const paths = files.filter(f => f.id && !f.name.startsWith('.')).map(f => `${photoFolder()}/${f.name}`);
  if (!paths.length) { data.photos = []; return renderPhotos(); }
  const { data: signed, error: e2 } = await sb.storage.from('photos').createSignedUrls(paths, 60 * 15);
  if (oops(e2, 'Couldn’t load photos') || !photosOpen) return;
  data.photos = signed.filter(s => s.signedUrl).map(s => ({ path: s.path, url: s.signedUrl }));
  renderPhotos();
}

function renderPhotos() {
  $('#photoGrid').innerHTML = data.photos.map(p =>
    `<div class="photo-cell"><img src="${esc(p.url)}" alt="Family photo" loading="lazy" /><button data-delete-photo="${esc(p.path)}" aria-label="Remove photo">×</button></div>`
  ).join('');
  $$('[data-delete-photo]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this photo?')) return;
    const { error } = await sb.storage.from('photos').remove([b.dataset.deletePhoto]);
    if (!oops(error)) loadPhotos();
  });
}

// Shrink photos before upload so the free storage tier holds thousands of them.
async function shrink(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob || file;
  } catch { return file; }
}

$('#photoInput').onclick = () => { pickingPhotos = true; };
$('#photoInput').onchange = async e => {
  pickingPhotos = false;
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  let added = 0;
  for (const [i, file] of files.entries()) {
    $('#uploadLabel').textContent = `Adding ${i + 1} of ${files.length}…`;
    const blob = await shrink(file);
    const { error } = await sb.storage.from('photos').upload(`${photoFolder()}/${crypto.randomUUID()}.jpg`, blob, { contentType: 'image/jpeg' });
    if (error) console.error(error); else added++;
  }
  $('#uploadLabel').textContent = 'Add family photos';
  toast(added === files.length ? 'Family photos added' : `${added} of ${files.length} photos added`);
  loadPhotos();
};

// ---------- reminders (Web Push) ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  return sb.from('push_subscriptions').upsert(
    { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, profile_id: me.id },
    { onConflict: 'endpoint' }
  );
}

// When someone switches profile on a phone that already has reminders on,
// point that phone's reminders at the new profile.
async function syncReminderProfile() {
  await renderReminderCard();
  try { const sub = await currentSubscription(); if (sub) await saveSubscription(sub); } catch (e) { console.error(e); }
}

async function renderReminderCard() {
  const btn = $('#enableReminders'), status = $('#reminderStatus');
  btn.hidden = false;
  if (!pushSupported()) {
    btn.hidden = true;
    status.textContent = isIOS && !isStandalone()
      ? 'To get reminders, add this app to your Home Screen first, then open it from there.'
      : 'This browser can’t show reminders.';
    return;
  }
  if (Notification.permission === 'denied') {
    btn.hidden = true;
    status.textContent = 'Notifications are blocked for this app. You can allow them in Settings.';
    return;
  }
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    btn.textContent = 'Test';
    status.textContent = `On for ${me.name} on this phone. Mondays and Fridays at 8am, plus each open chore at its reminder time.`;
  } else {
    btn.textContent = 'Turn on';
    status.textContent = 'Weigh-in mornings, plus each chore at the time you choose.';
  }
}

$('#enableReminders').onclick = async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      reg.showNotification('Family Rhythm', { body: `Reminders are working for ${me.name} ♡`, icon: './icon-512.png' });
      return;
    }
    if (!cfg.vapidPublicKey || /PASTE_/.test(cfg.vapidPublicKey)) { toast('Reminders aren’t set up yet'); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { renderReminderCard(); return; }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(cfg.vapidPublicKey) });
    const { error } = await saveSubscription(sub);
    if (oops(error, 'Couldn’t save reminder settings')) return;
    toast('Reminders are on');
    renderReminderCard();
  } catch (e) {
    console.error(e);
    toast('Couldn’t turn on reminders');
  }
};

// Refresh when the app comes back to the foreground (another phone may have changed things).
// Lock the photo library when the app goes to the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && photosOpen && !pickingPhotos) {
    lockPhotos();
    showPinForm('unlock');
  }
  if (document.visibilityState === 'visible') pickingPhotos = false;
  if (document.visibilityState === 'visible' && me) {
    $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    refresh();
  }
});

boot();
