// Family Rhythm: one household login, a profile per person.
// Weigh-ins and food are per profile. Chores and photos are shared.

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

let session = null;
let profiles = [];
let me = null;
const data = { weights: [], foods: [], chores: [], photos: [] };

// ---------- helpers ----------
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const prettyDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2000); }
function oops(error, fallback = 'Something went sideways. Try again?') { if (error) { console.error(error); toast(fallback); return true; } return false; }
const profileName = id => profiles.find(p => p.id === id)?.name;

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
  data.weights = []; data.foods = [];
  render();
  store.set('fr-profile', me.id);
  $('#avatarFace').textContent = me.emoji;
  $('#helloName').textContent = me.name;
  $('#weightUnit').value = store.get(`fr-unit-${me.id}`) || 'lb';
  showGate(null);
  go('home');
  await refresh();
  loadPhotos();
  syncReminderProfile();
}

// ---------- data ----------
async function refresh() {
  if (!me) return;
  const [w, f, c] = await Promise.all([
    sb.from('weigh_ins').select('*').eq('profile_id', me.id).order('date', { ascending: false }).limit(400),
    sb.from('foods').select('*').eq('profile_id', me.id).order('created_at', { ascending: false }).limit(300),
    sb.from('chores').select('*').order('created_at')
  ]);
  if (oops(w.error || f.error || c.error, 'Couldn’t reach the cloud. Check your connection.')) return;
  data.weights = w.data; data.foods = f.data; data.chores = c.data;
  render();
}

// ---------- navigation ----------
function go(id) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  $$('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.bottom-nav button').forEach(b => b.onclick = () => go(b.dataset.view));
$$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

// ---------- rendering ----------
function render() {
  const today = dateKey();
  const foodsToday = data.foods.filter(x => x.date === today);
  const done = data.chores.filter(x => x.done).length;
  $('#mealCount').textContent = `${foodsToday.length} ${foodsToday.length === 1 ? 'entry' : 'entries'}`;
  $('#choreSummary').textContent = `${done} of ${data.chores.length}`;
  $('#todayProgress').textContent = `${foodsToday.length + done} small wins`;

  const logged = data.weights.some(x => x.date === today);
  let status = 'Next weigh-in is ' + nextWeighIn();
  if (scheduledToday() && !logged) status = 'Today is a weigh-in day. A family photo is waiting.';
  if (logged) status = 'Today’s check-in is complete. Nicely done.';
  $('#weighStatus').textContent = status;

  renderWeights(); renderFoods(); renderChores();
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

function renderFoods() {
  $('#foodList').innerHTML = data.foods.map(x =>
    `<div class="list-card"><div class="grow"><strong>${esc(x.name)}</strong><small>${x.note ? esc(x.note) + ' · ' : ''}${prettyDate(x.date)}</small></div><button class="delete" data-delete-food="${x.id}" aria-label="Delete entry">×</button></div>`
  ).join('') || '<div class="empty">Nothing logged yet. Keep it simple and just add what you ate.</div>';
  $$('[data-delete-food]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('foods').delete().eq('id', b.dataset.deleteFood);
    if (!oops(error)) refresh();
  });
}

function renderChores() {
  $('#choreList').innerHTML = data.chores.map(x => {
    const who = x.done && profileName(x.done_by);
    return `<div class="list-card"><button class="check ${x.done ? 'done' : ''}" data-toggle-chore="${x.id}" aria-label="Mark complete">${x.done ? '✓' : ''}</button><div class="grow ${x.done ? 'completed' : ''}"><strong>${esc(x.name)}</strong><small>${x.done ? (who ? `Done by ${esc(who)}` : 'Complete') : 'Ready when you are'}</small></div><button class="delete" data-delete-chore="${x.id}" aria-label="Delete chore">×</button></div>`;
  }).join('') || '<div class="empty">Your chore list is clear.</div>';
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
$('#foodForm').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.from('foods').insert({ profile_id: me.id, date: dateKey(), name: $('#foodName').value.trim(), note: $('#foodNote').value.trim() || null });
  if (oops(error, 'Couldn’t save that entry')) return;
  e.target.reset(); toast('Food entry added'); refresh();
};

$('#choreForm').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.from('chores').insert({ name: $('#choreName').value.trim() });
  if (oops(error, 'Couldn’t add that chore')) return;
  e.target.reset(); toast('Chore added'); refresh();
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

function showReward() {
  const img = $('#rewardImage'), empty = $('#rewardEmpty');
  if (data.photos.length) {
    img.src = data.photos[Math.floor(Math.random() * data.photos.length)].url;
    img.hidden = false; empty.hidden = true;
  } else { img.hidden = true; empty.hidden = false; }
  $('#reward').hidden = false;
}
$('#closeReward').onclick = () => { $('#reward').hidden = true; };

// ---------- photos (private bucket, shared by the household) ----------
const photoFolder = () => session.user.id;

async function loadPhotos() {
  const { data: files, error } = await sb.storage.from('photos').list(photoFolder(), { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
  if (oops(error, 'Couldn’t load photos')) return;
  const paths = files.filter(f => f.id && !f.name.startsWith('.')).map(f => `${photoFolder()}/${f.name}`);
  if (!paths.length) { data.photos = []; return renderPhotos(); }
  const { data: signed, error: e2 } = await sb.storage.from('photos').createSignedUrls(paths, 60 * 60 * 6);
  if (oops(e2, 'Couldn’t load photos')) return;
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

$('#photoInput').onchange = async e => {
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
    status.textContent = `On for ${me.name} on this phone. Mondays and Fridays at 8am, plus 6pm if chores are open.`;
  } else {
    btn.textContent = 'Turn on';
    status.textContent = 'Weigh-in mornings and an evening nudge for open chores.';
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && me) {
    $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    refresh();
  }
});

boot();
