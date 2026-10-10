// Casa Yuffie: one household login, a profile per person.
// Weigh-ins are per profile. Chores, bills, recipes and photos are shared.

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
const data = { weights: [], chores: [], bills: [], payments: [], recipes: [], photos: [] };

// ---------- helpers ----------
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const prettyDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
const escAttr = s => esc(s).replace(/"/g, '&quot;');
// The × button in each dialog submits with value "cancel": close without saving.
function cancelled(e) {
  if (e.submitter?.value !== 'cancel') return false;
  e.target.closest('dialog').close();
  return true;
}
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
// A profile shows its own photo if it has one (private "avatars" bucket, no PIN needed), else its emoji.
let avatarUrls = {};
let editingPeople = false;

async function loadProfiles(autoEnter) {
  const { data: rows, error } = await sb.from('profiles').select('*').order('created_at');
  if (oops(error, 'Couldn’t load profiles')) return showGate('picker');
  profiles = rows;
  await loadAvatars();
  if (me) { me = profiles.find(p => p.id === me.id) || me; $('#avatarFace').innerHTML = faceHTML(me); }
  renderPicker();
  const remembered = profiles.find(p => p.id === store.get('fr-profile'));
  if (autoEnter && remembered) return enterApp(remembered);
  showGate('picker');
  if (!profiles.length) openProfileForm();
}

async function loadAvatars() {
  const withPhoto = profiles.filter(p => p.avatar_path);
  avatarUrls = {};
  if (!withPhoto.length) return;
  const { data: signed, error } = await sb.storage.from('avatars').createSignedUrls(withPhoto.map(p => p.avatar_path), 60 * 60 * 24 * 7);
  if (error) return console.error(error);
  for (const sgn of signed || []) {
    const p = withPhoto.find(x => x.avatar_path === sgn.path);
    if (p && sgn.signedUrl) avatarUrls[p.id] = sgn.signedUrl;
  }
}

const faceHTML = p => avatarUrls[p.id] ? `<img class="face-img" src="${escAttr(avatarUrls[p.id])}" alt="" />` : esc(p.emoji);

function renderPicker() {
  $('#profileList').classList.toggle('editing', editingPeople);
  $('#pickerTitle').textContent = editingPeople ? 'Tap someone to edit' : 'Who’s checking in?';
  $('#editPeople').textContent = editingPeople ? 'Done editing' : 'Edit people';
  $('#editPeople').hidden = !profiles.length;
  $('#profileList').innerHTML = profiles.map(p =>
    `<button class="profile-btn" data-profile="${p.id}"><span class="face">${faceHTML(p)}</span>${esc(p.name)}</button>`
  ).join('') + `<button class="profile-btn add" id="addProfile"><span class="face">＋</span>Add person</button>`;
  $$('[data-profile]').forEach(b => b.onclick = () => {
    const p = profiles.find(x => x.id === b.dataset.profile);
    editingPeople ? openProfileForm(p) : enterApp(p);
  });
  $('#addProfile').onclick = () => openProfileForm();
}
$('#editPeople').onclick = () => { editingPeople = !editingPeople; $('#profileForm').hidden = true; renderPicker(); };

// Center-crop to a square and shrink, so profile photos are small and load fast.
async function squarePhoto(file, size = 320) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
}

let chosenFace = FACES[0];
let editingProfile = null;   // null when adding someone new
let pendingPhoto = null;     // { blob, url } chosen but not saved yet
let removePhoto = false;

function renderFacePreview() {
  const url = pendingPhoto?.url || (!removePhoto && editingProfile && avatarUrls[editingProfile.id]);
  $('#profilePhotoPreview').innerHTML = url ? `<img class="face-img" src="${escAttr(url)}" alt="" />` : esc(chosenFace);
  $('#removeProfilePhoto').hidden = !url;
  $('#profilePhotoLabel').textContent = url ? 'Change photo' : 'Choose a photo';
  $('#faceLabel').textContent = url ? 'Face (used if the photo is removed)' : 'Or pick a face';
}

function openProfileForm(profile = null) {
  editingProfile = profile;
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
  pendingPhoto = null; removePhoto = false;
  chosenFace = profile?.emoji || FACES[profiles.length % FACES.length];
  $('#profileFormTitle').textContent = profile ? `Edit ${profile.name}` : 'Add a person';
  $('#saveProfile').textContent = profile ? 'Save' : 'Add';
  $('#profileName').value = profile?.name || '';
  const faces = FACES.includes(chosenFace) ? FACES : [chosenFace, ...FACES];
  $('#emojiRow').innerHTML = faces.map(f => `<button type="button" data-face="${f}" class="${f === chosenFace ? 'selected' : ''}">${f}</button>`).join('');
  $$('[data-face]').forEach(b => b.onclick = () => {
    chosenFace = b.dataset.face;
    $$('[data-face]').forEach(x => x.classList.toggle('selected', x === b));
    renderFacePreview();
  });
  renderFacePreview();
  $('#profileForm').hidden = false;
  $('#cancelProfile').hidden = !profiles.length;
  $('#profileName').focus();
}
$('#cancelProfile').onclick = () => { $('#profileForm').hidden = true; };

$('#profilePhotoInput').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await squarePhoto(file);
    if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
    pendingPhoto = { blob, url: URL.createObjectURL(blob) };
    removePhoto = false;
    renderFacePreview();
  } catch (err) { console.error(err); toast('Couldn’t read that photo'); }
};
$('#removeProfilePhoto').onclick = () => {
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; }
  removePhoto = true;
  renderFacePreview();
};

$('#profileForm').onsubmit = async e => {
  e.preventDefault();
  const fields = { name: $('#profileName').value.trim(), emoji: chosenFace };
  const { data: saved, error } = editingProfile
    ? await sb.from('profiles').update(fields).eq('id', editingProfile.id).select().single()
    : await sb.from('profiles').insert(fields).select().single();
  if (oops(error, editingProfile ? 'Couldn’t save that person' : 'Couldn’t add that person')) return;

  const oldPath = saved.avatar_path;
  let avatar_path = oldPath;
  if (pendingPhoto) {
    const path = `${session.user.id}/${saved.id}-${crypto.randomUUID().slice(0, 8)}.jpg`;
    const { error: upErr } = await sb.storage.from('avatars').upload(path, pendingPhoto.blob, { contentType: 'image/jpeg' });
    if (oops(upErr, 'Saved, but the photo didn’t upload. Try again?')) return loadProfiles(false);
    avatar_path = path;
  } else if (removePhoto) avatar_path = null;

  if (avatar_path !== oldPath) {
    const { error: e2 } = await sb.from('profiles').update({ avatar_path }).eq('id', saved.id);
    if (!oops(e2, 'Couldn’t save the photo') && oldPath) await sb.storage.from('avatars').remove([oldPath]);
  }
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; }
  $('#profileForm').hidden = true;
  toast(editingProfile ? 'Saved' : `${fields.name} added`);
  await loadProfiles(false);
};

$('#switchProfile').onclick = () => { editingPeople = false; renderPicker(); $('#profileForm').hidden = true; showGate('picker'); };

async function enterApp(profile) {
  me = profile;
  data.weights = [];
  render();
  store.set('fr-profile', me.id);
  $('#avatarFace').innerHTML = faceHTML(me);
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
  const [w, c, b, p, r] = await Promise.all([
    sb.from('weigh_ins').select('*').eq('profile_id', me.id).order('date', { ascending: false }).limit(400),
    sb.from('chores').select('*').order('created_at'),
    sb.from('bills').select('*').eq('active', true).order('next_due'),
    sb.from('bill_payments').select('*, bills(name)').order('paid_on', { ascending: false }).order('created_at', { ascending: false }).limit(300),
    sb.from('recipes').select('*').order('created_at', { ascending: false }).limit(500)
  ]);
  if (oops(w.error || c.error || b.error || p.error || r.error, 'Couldn’t reach the cloud. Check your connection.')) return;
  data.weights = w.data; data.chores = c.data; data.bills = b.data; data.payments = p.data; data.recipes = r.data;
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

  renderWeights(); renderChores(); renderBills(); renderRecipes();
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
    return `<div class="list-card"><button class="check ${x.done ? 'done' : ''}" data-toggle-chore="${x.id}" aria-label="Mark complete">${x.done ? '✓' : ''}</button><div class="grow ${x.done ? 'completed' : ''}"><strong>${esc(x.name)}</strong><small>${x.done ? (who ? `Done by ${esc(who)}` : 'Complete') : 'Ready when you are'}</small></div><select class="time-select compact" data-chore-time="${x.id}" aria-label="Reminder time for ${escAttr(x.name)}">${hourOptions(x.remind_hour)}</select><button class="delete" data-delete-chore="${x.id}" aria-label="Delete chore">×</button></div>`;
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
    if (!oops(error)) { if (done) { toast('Nice. One less thing.'); showReward('chore', chore.id); } refresh(); }
  });
  $$('[data-delete-chore]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('chores').delete().eq('id', b.dataset.deleteChore);
    if (!oops(error)) refresh();
  });
}

// ---------- bills (shared by the household) ----------
const money = n => n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const daysUntil = iso => Math.round((new Date(`${iso}T12:00:00`) - new Date(`${dateKey()}T12:00:00`)) / 86400000);
const FREQ = { once: 'One time', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', yearly: 'Yearly' };
function safeUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
function dueStatus(iso) {
  const d = daysUntil(iso);
  if (d < 0) return { cls: 'late', text: d === -1 ? 'Due yesterday' : `${-d} days late` };
  if (d === 0) return { cls: 'late', text: 'Due today' };
  if (d === 1) return { cls: 'soon', text: 'Due tomorrow' };
  if (d <= 7) return { cls: 'soon', text: `Due in ${d} days` };
  return { cls: '', text: `Due ${prettyDate(iso)}` };
}

function renderBills() {
  const bills = data.bills;
  const month = dateKey().slice(0, 7);
  const dueSoon = bills.filter(b => daysUntil(b.next_due) <= 30);
  const paidThisMonth = data.payments.filter(p => p.paid_on.startsWith(month));
  $('#billsDueTotal').textContent = money(dueSoon.reduce((t, b) => t + Number(b.amount || 0), 0));
  $('#billsPaidTotal').textContent = money(paidThisMonth.reduce((t, p) => t + Number(p.amount || 0), 0));

  // Home card
  const late = bills.filter(b => daysUntil(b.next_due) < 0).length;
  const week = bills.filter(b => daysUntil(b.next_due) <= 7).length;
  $('#billSummary').textContent = !bills.length ? 'No bills yet' : late ? `${late} overdue` : week ? `${week} due this week` : 'All caught up';
  $('#billSummaryNext').textContent = bills.length
    ? `Next: ${bills[0].name}, ${dueStatus(bills[0].next_due).text.replace(/^D/, 'd')}`
    : 'Add your household bills';

  $('#billList').innerHTML = bills.map(b => {
    const st = dueStatus(b.next_due);
    const url = b.pay_url && safeUrl(b.pay_url);
    const remind = b.remind_days == null ? 'No reminder'
      : `Reminds ${b.remind_days === 0 ? 'on the day' : `${b.remind_days} day${b.remind_days === 1 ? '' : 's'} before`} at ${hourLabel(b.remind_hour)}`;
    return `<div class="list-card bill-card">
      <div class="bill-top">
        <div class="grow"><button class="bill-name" data-edit-bill="${b.id}">${esc(b.name)}</button>
          <small>${FREQ[b.frequency]} · ${remind}</small>
          <span class="bill-status ${st.cls}">${st.text}</span></div>
        <span class="bill-amount">${money(b.amount)}</span>
      </div>
      <div class="bill-actions">
        ${url ? `<a class="ghost" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">Pay ↗</a>` : ''}
        <button class="primary" data-pay-bill="${b.id}">Mark paid</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">No bills yet. Add one to get reminders before it’s due.</div>';
  $$('[data-edit-bill]').forEach(x => x.onclick = () => openBillForm(data.bills.find(b => b.id === x.dataset.editBill)));
  $$('[data-pay-bill]').forEach(x => x.onclick = () => openPayForm(data.bills.find(b => b.id === x.dataset.payBill)));

  // History, grouped by month. Only each bill's most recent payment can be undone.
  const latest = new Set();
  const seen = new Set();
  for (const p of [...data.payments].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!seen.has(p.bill_id)) { seen.add(p.bill_id); latest.add(p.id); }
  }
  const groups = {};
  for (const p of data.payments) (groups[p.paid_on.slice(0, 7)] ||= []).push(p);
  $('#billHistory').innerHTML = Object.entries(groups).sort(([a], [b]) => b.localeCompare(a)).map(([m, list]) => {
    const label = new Date(`${m}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const total = list.reduce((t, p) => t + Number(p.amount || 0), 0);
    return `<div class="history-month"><span>${label}</span><span>${money(total)}</span></div>` + list.map(p => {
      const who = profileName(p.paid_by);
      return `<div class="list-card"><div class="grow"><strong>${esc(p.bills?.name || 'Deleted bill')}</strong><small>Paid ${prettyDate(p.paid_on)}${who ? ` by ${esc(who)}` : ''} · for ${prettyDate(p.due_date)}</small></div><span class="bill-amount">${money(p.amount)}</span>${latest.has(p.id) ? `<button class="delete" data-undo-payment="${p.id}" aria-label="Undo this payment">↺</button>` : ''}</div>`;
    }).join('');
  }).join('') || '<div class="empty">Payments you mark will show up here.</div>';
  $$('[data-undo-payment]').forEach(x => x.onclick = async () => {
    if (!confirm('Undo this payment? The bill goes back to that due date.')) return;
    const { error } = await sb.rpc('undo_bill_payment', { payment: x.dataset.undoPayment });
    if (!oops(error, 'Couldn’t undo that payment')) { toast('Payment undone'); refresh(); }
  });
}

let editingBill = null;
$('#billRemindHour').innerHTML = hourOptions(9).replace('<option value="">No reminder</option>', '');
function openBillForm(bill = null) {
  editingBill = bill;
  $('#billForm').reset();
  $('#billError').hidden = true;
  $('#billDialogEyebrow').textContent = bill ? 'Edit bill' : 'New bill';
  $('#billDialogTitle').textContent = bill ? bill.name : 'Add a bill';
  $('#billName').value = bill?.name || '';
  $('#billAmount').value = bill?.amount ?? '';
  $('#billDue').value = bill?.next_due || dateKey();
  $('#billFrequency').value = bill?.frequency || 'monthly';
  $('#billRemindDays').value = bill ? (bill.remind_days ?? '') : '3';
  $('#billRemindHour').value = String(bill?.remind_hour ?? 9);
  $('#billUrl').value = bill?.pay_url || '';
  $('#deleteBill').hidden = !bill;
  $('#billDialog').showModal();
}
$('#addBill').onclick = () => openBillForm();

$('#billForm').onsubmit = async e => {
  e.preventDefault();
  if (cancelled(e)) return;
  const url = $('#billUrl').value.trim();
  if (url && !safeUrl(url)) { $('#billError').textContent = 'The payment link needs to start with https://'; $('#billError').hidden = false; return; }
  const due = $('#billDue').value;
  const days = $('#billRemindDays').value;
  const row = {
    name: $('#billName').value.trim(),
    amount: $('#billAmount').value === '' ? null : Number($('#billAmount').value),
    next_due: due,
    due_day: Number(due.slice(8, 10)),
    frequency: $('#billFrequency').value,
    remind_days: days === '' ? null : Number(days),
    remind_hour: Number($('#billRemindHour').value),
    pay_url: url || null,
    last_reminded_for: null
  };
  const { error } = editingBill
    ? await sb.from('bills').update(row).eq('id', editingBill.id)
    : await sb.from('bills').insert(row);
  if (oops(error, 'Couldn’t save that bill')) return;
  $('#billDialog').close();
  toast(editingBill ? 'Bill updated' : 'Bill added');
  refresh();
};

$('#deleteBill').onclick = async () => {
  if (!editingBill || !confirm(`Delete ${editingBill.name}? Its payment history will be deleted too.`)) return;
  const { error } = await sb.from('bills').delete().eq('id', editingBill.id);
  if (oops(error, 'Couldn’t delete that bill')) return;
  $('#billDialog').close();
  toast('Bill deleted');
  refresh();
};

let payingBill = null;
function openPayForm(bill) {
  payingBill = bill;
  $('#payTitle').textContent = `${bill.name} paid`;
  $('#payDueNote').textContent = `For the bill due ${prettyDate(bill.next_due)}.${bill.frequency === 'once' ? '' : ' It will move to the next due date.'}`;
  $('#payAmount').value = bill.amount ?? '';
  $('#payDate').value = dateKey();
  $('#payDialog').showModal();
}
$('#payForm').onsubmit = async e => {
  e.preventDefault();
  if (cancelled(e)) return;
  const { data: paymentId, error } = await sb.rpc('pay_bill', {
    bill: payingBill.id,
    amount: $('#payAmount').value === '' ? null : Number($('#payAmount').value),
    paid_on: $('#payDate').value,
    paid_by: me.id
  });
  if (oops(error, 'Couldn’t save that payment')) return;
  $('#payDialog').close();
  toast(`${payingBill.name} marked paid`);
  showReward('bill', paymentId);
  refresh();
};

// ---------- recipes (shared by the household) ----------
// The import-recipe Edge Function reads the recipe data most sites embed for search engines.
// If a site blocks it, the link is saved anyway and the recipe can be filled in by hand.
const minutesLabel = m => !m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
const siteOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
let openRecipeId = null;

function recipeMsg(text, isError = false) {
  const el = $('#recipeMsg');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

function renderRecipes() {
  const q = $('#recipeSearch').value.trim().toLowerCase();
  $('#recipeSearch').hidden = data.recipes.length < 4 && !q;
  const shown = data.recipes.filter(r => !q || r.title.toLowerCase().includes(q) || r.ingredients.some(i => i.toLowerCase().includes(q)));
  $('#recipeList').innerHTML = shown.map(r => {
    const img = r.image_url && safeUrl(r.image_url);
    const meta = [r.site, minutesLabel(r.total_minutes), r.ingredients.length ? `${r.ingredients.length} ingredients` : 'Needs details'].filter(Boolean).join(' · ');
    return `<button class="list-card recipe-card" data-recipe="${r.id}">${img
      ? `<img class="recipe-thumb" src="${escAttr(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : '<span class="recipe-thumb">❦</span>'}<div class="grow"><strong>${esc(r.title)}</strong><small>${esc(meta)}</small></div></button>`;
  }).join('') || `<div class="empty">${q ? 'No recipes match that.' : 'No recipes yet. Paste a link above to save your first one.'}</div>`;
  $$('[data-recipe]').forEach(b => b.onclick = () => openRecipe(data.recipes.find(r => r.id === b.dataset.recipe)));
}
$('#recipeSearch').oninput = renderRecipes;

$('#recipeForm').onsubmit = async e => {
  e.preventDefault();
  const url = safeUrl($('#recipeUrl').value.trim());
  if (!url) return recipeMsg('That doesn’t look like a web link.', true);
  const existing = data.recipes.find(r => r.url === url);
  if (existing) { $('#recipeUrl').value = ''; recipeMsg(''); return openRecipe(existing); }

  $('#recipeSave').disabled = true;
  recipeMsg('Reading the recipe…');
  const { data: got, error } = await sb.functions.invoke('import-recipe', { body: { url } });
  let row, note = '';
  if (error || !got || got.error) {
    let reason = got?.error;
    try { reason ||= (await error?.context?.json())?.error; } catch { /* no details */ }
    row = { title: siteOf(url) || 'Saved recipe', site: siteOf(url) };
    note = `${reason || 'Couldn’t read that page.'} The link is saved. Tap Edit to add the ingredients and steps.`;
  } else {
    row = { title: got.title, image_url: got.image_url, site: got.site, yields: got.yields, total_minutes: got.total_minutes,
            ingredients: got.ingredients, instructions: got.instructions };
    if (!got.found) note = 'That page didn’t include recipe details, so only the link was saved. Tap Edit to fill it in.';
  }
  const { data: saved, error: saveError } = await sb.from('recipes').insert({ ...row, url, added_by: me.id }).select().single();
  $('#recipeSave').disabled = false;
  if (oops(saveError, 'Couldn’t save that recipe')) return recipeMsg('');
  $('#recipeUrl').value = '';
  recipeMsg(note, !!note);
  data.recipes = [saved, ...data.recipes.filter(r => r.id !== saved.id)];
  renderRecipes();
  openRecipe(saved);
};

function openRecipe(r) {
  openRecipeId = r.id;
  const img = r.image_url && safeUrl(r.image_url);
  $('#recipeImage').hidden = !img;
  if (img) $('#recipeImage').src = img; else $('#recipeImage').removeAttribute('src');
  $('#recipeSite').textContent = r.site || '';
  $('#recipeTitle').textContent = r.title;
  const added = profileName(r.added_by);
  $('#recipeMeta').textContent = [minutesLabel(r.total_minutes), r.yields && `Serves ${r.yields.replace(/^(serves|makes)\s+/i, '')}`, added && `Saved by ${added}`].filter(Boolean).join(' · ');
  const link = r.url && safeUrl(r.url);
  $('#recipeLink').hidden = !link;
  if (link) $('#recipeLink').href = link;
  $('#recipeIngredients').innerHTML = r.ingredients.map(i => `<li>${esc(i)}</li>`).join('') || '<li class="muted">None yet. Tap Edit to add them.</li>';
  $('#recipeSteps').innerHTML = (r.instructions || []).map(sec =>
    `${sec.name ? `<p class="step-section">${esc(sec.name)}</p>` : ''}<ol class="steps">${sec.steps.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`
  ).join('') || '<p class="muted">None yet. Tap Edit to add them.</p>';
  $$('#recipeIngredients li, #recipeSteps li').forEach(li => li.onclick = () => li.classList.toggle('got'));
  $('#recipeNotes').value = r.notes || '';
  $('#recipeView').hidden = false;
  $('#recipeEditForm').hidden = true;
  if (!$('#recipeDialog').open) $('#recipeDialog').showModal();
  $('#recipeDialog').scrollTop = 0;
}
const currentRecipe = () => data.recipes.find(r => r.id === openRecipeId);
$('#closeRecipe').onclick = () => $('#recipeDialog').close();

async function saveRecipe(changes) {
  const { data: saved, error } = await sb.from('recipes').update(changes).eq('id', openRecipeId).select().single();
  if (oops(error, 'Couldn’t save that recipe')) return null;
  data.recipes = data.recipes.map(r => r.id === saved.id ? saved : r);
  renderRecipes();
  return saved;
}

$('#recipeNotes').onchange = async () => {
  if (await saveRecipe({ notes: $('#recipeNotes').value.trim() || null })) toast('Notes saved');
};

$('#editRecipe').onclick = () => {
  const r = currentRecipe();
  $('#editTitle').value = r.title;
  $('#editMinutes').value = r.total_minutes ?? '';
  $('#editYields').value = r.yields || '';
  $('#editIngredients').value = r.ingredients.join('\n');
  $('#editSteps').value = (r.instructions || []).map(sec => (sec.name ? `# ${sec.name}\n` : '') + sec.steps.join('\n')).join('\n');
  $('#recipeView').hidden = true;
  $('#recipeEditForm').hidden = false;
  $('#recipeDialog').scrollTop = 0;
};
$('#cancelEditRecipe').onclick = () => openRecipe(currentRecipe());

$('#recipeEditForm').onsubmit = async e => {
  e.preventDefault();
  const lines = t => t.split('\n').map(x => x.trim()).filter(Boolean);
  const instructions = [];
  for (const line of lines($('#editSteps').value)) {
    if (line.startsWith('#')) instructions.push({ name: line.replace(/^#+\s*/, '') || null, steps: [] });
    else {
      if (!instructions.length) instructions.push({ name: null, steps: [] });
      instructions.at(-1).steps.push(line);
    }
  }
  const saved = await saveRecipe({
    title: $('#editTitle').value.trim(),
    total_minutes: $('#editMinutes').value ? Number($('#editMinutes').value) : null,
    yields: $('#editYields').value.trim() || null,
    ingredients: lines($('#editIngredients').value),
    instructions: instructions.filter(s => s.steps.length)
  });
  if (saved) { toast('Recipe saved'); openRecipe(saved); }
};

$('#deleteRecipe').onclick = async () => {
  const r = currentRecipe();
  if (!r || !confirm(`Delete ${r.title}?`)) return;
  const { error } = await sb.from('recipes').delete().eq('id', r.id);
  if (oops(error, 'Couldn’t delete that recipe')) return;
  $('#recipeDialog').close();
  data.recipes = data.recipes.filter(x => x.id !== r.id);
  renderRecipes();
  toast('Recipe deleted');
};

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
  if (cancelled(e)) return;
  const unit = $('#weightUnit').value;
  store.set(`fr-unit-${me.id}`, unit);
  const cheer = weighCheer(Number($('#weightValue').value), unit);
  const { data: saved, error } = await sb.from('weigh_ins').upsert(
    { profile_id: me.id, date: dateKey(), value: Number($('#weightValue').value), unit },
    { onConflict: 'profile_id,date' }
  ).select('id').single();
  if (oops(error, 'Couldn’t save your weigh-in')) return;
  $('#weighDialog').close();
  showReward('weigh_in', saved?.id, cheer);
  refresh();
};

// ---------- weigh-in encouragement ----------
// Compares with the last weigh-in before today. {d} is the change, {when} is when that was.
// Ups get no number on purpose: the point is to keep showing up.
const CHEERS = {
  first: [
    'Your first check-in! Every journey starts with one step.',
    'Day one is done. So glad you’re here.',
    'First weigh-in logged. This is your starting line, and you showed up for it.',
    'You started. That’s honestly the hardest part.'
  ],
  down: [
    'Down {d} since {when}. Your consistency is paying off.',
    '{d} lighter than last time. Small steps really do add up.',
    'Look at that: down {d}. Be proud of the work behind it.',
    'Down {d}. The habits you’re building are working.',
    'Progress! {d} down since {when}. Keep being kind to yourself.',
    'Down {d}. That’s what showing up looks like.',
    '{d} down. Take a second to celebrate. You earned it.',
    'Moving in the right direction: down {d} since {when}.',
    'Down {d}. Steady and patient wins this one.',
    'Nice work, {d} down. Your future self says thank you.',
    'Down {d}! All those little choices are adding up.',
    '{d} down since {when}. You should feel really good about that.'
  ],
  up: [
    'Bodies go up and down: water, salt, sleep, stress. You still showed up, and that counts most.',
    'One number doesn’t define a week. The trend matters more than any single day.',
    'A little up today, and that’s okay. Checking in on a harder day takes real strength.',
    'Up a bit, which is completely normal. Be gentle with yourself and keep going.',
    'Ups and downs are part of every journey. You’re still on your path.',
    'Today’s number is information, not a grade. Proud of you for stepping on.',
    'Up slightly. Drink some water, get some rest, and keep doing what feels good.',
    'Every road has a few bumps. You’re here, and that’s the win.',
    'Don’t let one weigh-in steal your momentum. You’ve got this.',
    'Scales wobble. Your effort doesn’t. Keep going.',
    'Not every check-in goes down, and that’s fine. Showing up anyway is how it works.',
    'A small bump, not a step back. Tomorrow is a fresh start.'
  ],
  same: [
    'Holding steady. Consistency is a superpower.',
    'Right where you were, and steady is progress too.',
    'Steady as you go. Keeping it level takes real effort.',
    'No big change, and that’s just fine. Keep showing up.',
    'A steady week. Your routine is holding strong.',
    'Holding the line. Small habits make big results over time.',
    'Same as last time. Consistent is exactly what you want to be.'
  ]
};

// Works through each list in a shuffled order, so no message repeats until all have been seen.
function pickCheer(kind) {
  const key = `fr-cheer-${me.id}-${kind}`;
  const pool = CHEERS[kind];
  let deck;
  try { deck = JSON.parse(store.get(key)); } catch { deck = null; }
  if (!Array.isArray(deck) || !deck.length || deck.some(i => !(i in pool))) {
    deck = pool.map((_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    // Don't start the new round with the message that ended the last one.
    if (deck.length > 1 && deck[0] === Number(store.get(`${key}-last`))) deck.push(deck.shift());
  }
  const i = deck.shift();
  store.set(key, JSON.stringify(deck));
  store.set(`${key}-last`, String(i));
  return pool[i];
}

function weighCheer(value, unit) {
  const prev = data.weights.find(w => w.date < dateKey());
  if (!prev) return pickCheer('first');
  const prevValue = Number(prev.value) * (prev.unit === unit ? 1 : unit === 'kg' ? 1 / 2.20462 : 2.20462);
  const delta = value - prevValue;
  const kind = Math.abs(delta) < (unit === 'kg' ? 0.2 : 0.4) ? 'same' : delta < 0 ? 'down' : 'up';
  const days = daysUntil(prev.date) * -1;
  const when = days <= 6 ? new Date(`${prev.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }) : 'last time';
  return pickCheer(kind).replace('{d}', `${Math.abs(delta).toFixed(1)} ${unit}`).replace('{when}', when);
}

// A weigh-in, finished chore or paid bill earns one random photo for a couple of minutes,
// no PIN needed. The database allows one per event. Chores and bills only pop up when there's a photo.
const REWARD_TITLES = { weigh_in: 'You showed up ♡', chore: 'Chore done ♡', bill: 'Bill paid ♡' };
async function showReward(kind, eventId, message = '') {
  const img = $('#rewardImage'), empty = $('#rewardEmpty');
  $('#rewardMessage').textContent = message;
  $('#rewardMessage').hidden = !message;
  const { data: path } = eventId ? await sb.rpc('grant_reward', { kind, event: eventId }) : { data: null };
  const signed = path ? (await sb.storage.from('photos').createSignedUrl(path, 120)).data : null;
  if (!signed?.signedUrl && kind !== 'weigh_in') return;
  $('#rewardEyebrow').textContent = REWARD_TITLES[kind];
  img.hidden = !signed?.signedUrl; empty.hidden = !!signed?.signedUrl;
  if (signed?.signedUrl) img.src = signed.signedUrl;
  $('#reward').hidden = false;
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
    : mode === 'create'
      ? '4 to 8 digits. Only someone with this PIN can browse the photos or change the PIN.'
      : 'Enter the current PIN, then the new one twice.';
  $('#pinConfirm').hidden = mode === 'unlock';
  $('#pinConfirm').required = mode !== 'unlock';
  $('#pinCurrent').hidden = mode !== 'change';
  $('#pinCurrent').required = mode === 'change';
  $('#pinInput').placeholder = mode === 'unlock' ? 'PIN' : 'New PIN';
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
  const { data: result, error } = await sb.rpc('set_photo_pin', { new_pin: pin, current_pin: pinMode === 'change' ? $('#pinCurrent').value : null });
  if (oops(error, 'Couldn’t save the PIN')) return;
  if (result !== 'ok') {
    $('#pinCurrent').value = '';
    return pinError({ wrong: 'The current PIN didn’t match.', locked_out: 'Too many tries. The PIN is locked for 15 minutes.' }[result] || 'The PIN needs to be 4 to 8 digits.');
  }
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
      reg.showNotification('Casa Yuffie', { body: `Reminders are working for ${me.name} ♡`, icon: './icon-512.png' });
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
