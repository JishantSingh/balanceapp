/* Bahi — udhaar khata · app logic
   Data lives in the merchant's own Google Sheet, reached through their own
   Apps Script deployment. This file talks to that API and renders the UI.

   Write path: every write is applied to the local cache immediately, then
   queued. The queue replays in order; network failures keep items queued
   (visible as the "pending" chip) — entries never silently fail. A write the
   server *refuses* is rolled back locally and parked in the failed list
   (the red chip) so the ledger never shows an entry the sheet doesn't have. */

'use strict';

// ---------------------------------------------------------------- state

const LS_CONFIG = 'bahi.config';
const LS_CACHE = 'bahi.cache';
const LS_DEMO = 'bahi.demo';
const LS_QUEUE = 'bahi.queue';
const LS_FAILED = 'bahi.failed';

const DEFAULT_TEMPLATE =
  'Namaste {name} ji 🙏\n' +
  'Aapka {merchant} par {amount} ka hisaab baaki hai. ' +
  'Kripya jald bhugtan karein.\n' +
  'Apna pura hisaab yahan dekhein: {passbook}\n' +
  'Dhanyavaad!';

let config = loadJSON(LS_CONFIG) || null;
let db = loadJSON(LS_CACHE) || { users: [], transactions: [] };
let queue = loadJSON(LS_QUEUE) || [];
let failed = loadJSON(LS_FAILED) || [];   // writes the server refused (rolled back locally)
let authBad = false;                      // last list call failed on the key
let currentCustomerId = null;
let editingTxnId = null;
let editingCustomerId = null;
let txnFormType = 'given';
let confirmArmed = null;
let updateWaiting = false;                // a new app version is installed and waiting

// photo form state: mode 'none' | 'existing' | 'new' | 'removed'
let photoState = { mode: 'none', b64: null, id: null };
const photoCache = {};   // fileId -> dataURI (in-memory)
const demoPhotos = {};   // demo fileId -> b64 (in-memory, demo mode only)

// tiny ledger thumbnails, persisted so the list stays instant + offline
const LS_THUMBS = 'bahi.thumbs';
let thumbs = loadJSON(LS_THUMBS) || {};   // fileId -> {d: dataURI, t: ts}
const thumbLoading = new Set();

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ---------------------------------------------------------------- dom

const $ = (id) => document.getElementById(id);
const screens = {
  connect: $('screen-connect'),
  home: $('screen-home'),
  customer: $('screen-customer'),
  passbook: $('screen-passbook'),
};

function show(name) {
  Object.values(screens).forEach((s) => (s.hidden = true));
  screens[name].hidden = false;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- top layer

/* showModal() promotes a dialog to the *top layer*: it paints above every
   z-indexed element in the page, and everything outside it goes inert, so it
   swallows taps too. Toasts and the busy bar were therefore invisible exactly
   where feedback matters most — photo loading, photo failures (audit 0.4).
   A popover shares the top layer but is still inert under an open modal, so
   the reliable fix is to keep the overlays *inside* whatever dialog is on top.
   They are position:fixed, so the geometry never changes; they simply belong
   to the dialog's subtree and ride above it. */

const openSheets = [];   // modal dialogs we opened, in top-layer order

// Self-healing: a dialog reports open === false the instant close() runs,
// while its `close` event only arrives on a later task.
function overlayHost() {
  for (let i = openSheets.length - 1; i >= 0; i--) {
    if (openSheets[i].open) return openSheets[i];
    openSheets.splice(i, 1);
  }
  return document.body;
}

function moveOverlays() {
  const host = overlayHost();
  ['toast', 'busy', 'update-bar'].forEach((id) => {
    const el = $(id);
    if (el && el.parentNode !== host) host.appendChild(el);
  });
}

function showSheet(dlg) {
  dlg.showModal();
  if (!openSheets.includes(dlg)) openSheets.push(dlg);
  moveOverlays();
}

function topShow(el) { moveOverlays(); el.hidden = false; }
function topHide(el) { el.hidden = true; }

// ---------------------------------------------------------------- toast

/* One toast slot. opts: {err} red · {tone:'gave'|'got'} money colours (audit
   1.3) · {action,onAction} one tappable action, e.g. undo (audit 1.2) · {ms}.
   The update notice deliberately does NOT live here — it has its own element
   so a passing toast can never destroy it (audit 0.7). */
function showToast(msg, opts) {
  const o = opts || {};
  const el = $('toast');
  el.className = 'toast' + (o.err ? ' err' : '') + (o.tone ? ' ' + o.tone : '') +
    (o.action ? ' act' : '');
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (o.action) {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'toast-act';
    act.textContent = o.action;
    act.addEventListener('click', () => { hideToast(); o.onAction(); });
    el.appendChild(act);
  }
  topShow(el);
  clearTimeout(toast._t);
  toast._t = setTimeout(hideToast, o.ms || 3200);
}

function toast(msg, isError) { showToast(msg, { err: !!isError }); }

function hideToast() {
  clearTimeout(toast._t);
  topHide($('toast'));
}

// ---------------------------------------------------------------- update notice

// A finished background download of a new app version. It gets its own
// persistent surface (never the shared toast slot) and comes back on every
// foreground until the merchant actually reloads (audit 0.7).
function showUpdateBar() {
  updateWaiting = true;
  topShow($('update-bar'));
}

function busy(on) {
  const el = $('busy');
  if (on) topShow(el); else topHide(el);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- dates & money

function parseDate(str) {
  if (str instanceof Date) return str;
  if (!str) return new Date(0);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(str);
  return isNaN(d) ? new Date(0) : d;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(str) {
  const d = parseDate(str);
  if (d.getTime() === 0) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// "aaj" · "kal" · "N din pehle" · "DD MMM" once it is older than 30 days
function relDate(str) {
  const d = parseDate(str);
  if (d.getTime() === 0) return '';
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
  if (days <= 0) return 'aaj';
  if (days === 1) return 'kal';
  if (days <= 30) return days + ' din pehle';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoOf(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
function money(n) {
  const cur = (config && config.currency) || '₹';
  return cur + inr.format(Math.abs(Number(n) || 0));
}

// ---------------------------------------------------------------- api

// A mistyped/blank backend URL is a settings problem, not a dead network —
// it must never look like OFFLINE. Marked so callers can keep writes queued.
function configError(msg) {
  const err = new Error(msg);
  err.configError = true;
  return err;
}

function isAuthError(err) {
  return /unauthor|bad or missing key|invalid key/i.test(String((err && err.message) || ''));
}

async function api(action, payload) {
  if (config && config.demo) return demoApi(action, payload);

  // Parsed before any fetch so a bad URL is distinguishable from a network
  // failure — one is fixed in Settings, the other by waiting (audit 0.6)
  let endpoint;
  try {
    endpoint = new URL(config.url);
  } catch (e) {
    const bad = configError('Backend URL galat hai — Settings me check karein');
    toast(bad.message, true);
    throw bad;
  }

  busy(true);
  try {
    let res;
    if (action === 'list') {
      endpoint.searchParams.set('action', 'list');
      endpoint.searchParams.set('key', config.key);
      res = await fetch(endpoint.toString());
    } else {
      // text/plain keeps the request "simple" so Apps Script needs no CORS preflight
      res = await fetch(endpoint.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, key: config.key }, payload)),
      });
    }
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Request failed');
    setOffline(false);
    if (action === 'list') setAuthBad(false);
    return json.data;
  } catch (err) {
    if (err instanceof TypeError) setOffline(true);            // network failure
    else if (action === 'list' && isAuthError(err)) setAuthBad(true);
    throw err;
  } finally {
    busy(false);
  }
}

function setOffline(off) { $('chip-offline').hidden = !off; }

// A wrong/rotated key used to show nothing at all — now it stays on screen
// until a list call succeeds. Tapping the chip opens Settings.
function setAuthBad(bad) {
  authBad = !!bad;
  updateChips();
}

// The sheet has no column for _created (the audit-0.8 tiebreak), so a sync
// would otherwise drop today's new customer straight back to the bottom of
// today's rows. Carry the local stamp across.
function keepLocalMeta(users) {
  const was = new Map(db.users.map((u) => [String(u.user_id), u]));
  users.forEach((u) => {
    const old = was.get(String(u.user_id));
    if (old && old._created && !u._created) u._created = old._created;
  });
  return users;
}

async function refresh(silent) {
  if (queue.length) { render(); processQueue(); return; } // local truth wins until synced
  try {
    const data = await api('list');
    db = { users: keepLocalMeta(data.users || []), transactions: data.transactions || [] };
    saveCache();
    render();
  } catch (err) {
    if (!silent) toast('Could not sync: ' + err.message, true);
    render(); // fall back to cached copy
  }
}

// ---------------------------------------------------------------- offline write queue

function saveQueue() {
  try {
    saveJSON(LS_QUEUE, queue);
  } catch (e) {
    // Storage full — drop queued photo payloads (entries themselves survive)
    if (dropQueuedPhotos()) {
      toast('Storage full — a queued photo was dropped; the entry is safe', true);
      try { saveJSON(LS_QUEUE, queue); } catch (e2) { /* give up quietly */ }
      try { saveJSON(LS_FAILED, failed); } catch (e2) { /* give up quietly */ }
    }
  }
  updateChips();
}

// Photo bytes (~1.4MB b64 each) are the only thing in local storage big
// enough to blow the quota — dropping them keeps the entries themselves.
function dropQueuedPhotos() {
  let dropped = false;
  queue.concat(failed).forEach((item) => {
    if (item.payload && item.payload.data && item.payload.data.photo) {
      delete item.payload.data.photo;
      dropped = true;
    }
  });
  return dropped;
}

// The cached ledger must never take an entry down with it: on a full phone we
// free what we can, tell the merchant what was lost, and carry on (audit 0.5).
function saveCache() {
  try {
    saveJSON(LS_CACHE, db);
  } catch (e) {
    const dropped = dropQueuedPhotos();
    if (dropped) {
      try { saveJSON(LS_QUEUE, queue); } catch (e2) { /* keep going */ }
      try { saveJSON(LS_FAILED, failed); } catch (e2) { /* keep going */ }
    }
    try { saveJSON(LS_CACHE, db); } catch (e3) { /* stale cache — the queue still holds the truth */ }
    toast(dropped
      ? 'Phone ki memory bhar gayi — entry save hui, par photo nahi'
      : 'Phone ki memory bhar gayi — entry save hui, par phone par nahi rakhi ja saki', true);
  }
}

function saveFailed() {
  try {
    saveJSON(LS_FAILED, failed);
  } catch (e) {
    if (dropQueuedPhotos()) { try { saveJSON(LS_FAILED, failed); } catch (e2) { /* memory only */ } }
  }
  updateChips();
}

function updateChips() {
  const pending = $('chip-pending');
  pending.hidden = queue.length === 0;
  pending.textContent = queue.length + ' pending';

  const bad = $('chip-failed');
  bad.hidden = failed.length === 0;
  bad.textContent = failed.length + ' nahi bache';

  $('chip-auth').hidden = !authBad;
}

function enqueue(action, payload, tmpId, undo) {
  // Demo writes go straight to the local demo store — no queue, no chip
  if (config && config.demo) {
    api(action, payload).then(() => refresh(true));
    return;
  }
  // Everything needed to undo the optimistic local change if the server
  // refuses this write: an add needs only its temporary id, an edit or delete
  // needs a pre-image of what it overwrote.
  const rollback = undo || (tmpId ? { type: action, tmpId } : null);
  queue.push({
    action,
    payload,
    tmpId: tmpId || null,
    undo: rollback,
    label: describeWrite(action, payload, rollback),   // named while the entity still exists
  });
  saveQueue();
  processQueue();
}

function userName(id) {
  const u = db.users.find((x) => String(x.user_id) === String(id));
  return u ? u.name : '';
}

// Short human label for the failed list — "₹888 · Ramu Halwai"
function describeWrite(action, payload, undo) {
  const d = (payload && payload.data) || {};
  const txn = (undo && undo.txn) || null;
  const user = (undo && undo.user) || null;
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  switch (action) {
    case 'addTxn': return join(money(d.amount), userName(d.user_id));
    case 'updateTxn': return join(money(d.amount), userName(d.user_id) || (txn && userName(txn.user_name)), 'badla');
    case 'deleteTxn': return join(txn ? money(txn.amount) : 'Entry', txn && userName(txn.user_name), 'hataya');
    case 'addUser': return join(d.name, 'naya customer');
    case 'updateUser': return join(d.name || (user && user.name), 'customer badla');
    case 'deleteUser': return join(user ? user.name : 'Customer', 'hataya');
    default: return action;
  }
}

let processing = false;
async function processQueue() {
  if (processing || !queue.length || (config && config.demo)) return;
  processing = true;
  try {
    while (queue.length) {
      const item = queue[0];
      let result;
      try {
        result = await api(item.action, item.payload);
      } catch (err) {
        // Offline, or a backend URL that needs fixing — keep queued, retry later
        if (err instanceof TypeError || (err && err.configError)) return;
        // The server refused it (bad key, already deleted, bad data). Drop it
        // so the queue can't jam, undo the optimistic local change, and park
        // it where the merchant can see it — a rejected write must never just
        // disappear while the ledger keeps showing it (audit 0.1).
        queue.shift();
        rollbackWrite(item);
        failed.push({
          action: item.action,
          payload: item.payload,
          tmpId: item.tmpId || null,
          undo: item.undo || null,
          label: item.label || describeWrite(item.action, item.payload, item.undo),
          error: err.message,
          at: Date.now(),
        });
        saveCache();
        saveQueue();
        saveFailed();
        render();
        toast('Save nahi hua: ' + failed[failed.length - 1].label, true);
        continue;
      }
      // success — resolve temporary ids to server ids
      if (item.tmpId && result) {
        if (item.action === 'addUser') remapUserId(item.tmpId, result.user_id, result);
        if (item.action === 'addTxn') remapTxnId(item.tmpId, result.id);
      }
      queue.shift();
      saveQueue();
    }
    refresh(true); // fully drained — reconcile with the sheet
  } finally {
    processing = false;
  }
}

function remapUserId(tmpId, realId, serverUser) {
  const u = db.users.find((x) => x.user_id === tmpId);
  if (u) Object.assign(u, serverUser || {}, { user_id: realId });
  db.transactions.forEach((t) => { if (t.user_name === tmpId) t.user_name = realId; });
  // failed items too: retrying a parked entry after its customer finally
  // landed must point at the real customer, not the dead temporary id
  queue.concat(failed).forEach((item) => {
    if (item.payload && item.payload.data && item.payload.data.user_id === tmpId) {
      item.payload.data.user_id = realId;
    }
    if (item.payload && item.payload.id === tmpId) item.payload.id = realId;
  });
  if (currentCustomerId === tmpId) currentCustomerId = realId;
  saveCache();
  saveQueue();
  saveFailed();
  render();
}

function remapTxnId(tmpId, realId) {
  const t = db.transactions.find((x) => x.id === tmpId);
  if (t) t.id = realId;
  queue.concat(failed).forEach((item) => {
    if (item.payload && item.payload.id === tmpId) item.payload.id = realId;
  });
  saveCache();
  saveQueue();
  saveFailed();
}

// ---------------------------------------------------------------- failed writes

// Undo the optimistic local change behind a write the server refused.
// Pre-images are captured in enqueue(); adds carry only their temporary id.
function rollbackWrite(item) {
  const u = item && item.undo;
  if (!u) return;   // pre-0.1 queue item — nothing captured, leave the cache alone
  if (u.type === 'addTxn') {
    db.transactions = db.transactions.filter((t) => String(t.id) !== String(u.tmpId));
  } else if (u.type === 'addUser') {
    db.users = db.users.filter((x) => String(x.user_id) !== String(u.tmpId));
    db.transactions = db.transactions.filter((t) => String(t.user_name) !== String(u.tmpId));
    if (String(currentCustomerId) === String(u.tmpId)) goHome();
  } else if (u.type === 'txn' && u.txn) {
    const i = db.transactions.findIndex((t) => String(t.id) === String(u.txn.id));
    if (i >= 0) db.transactions[i] = clone(u.txn);
    else db.transactions.push(clone(u.txn));
  } else if (u.type === 'user' && u.user) {
    const i = db.users.findIndex((x) => String(x.user_id) === String(u.user.user_id));
    if (i >= 0) db.users[i] = clone(u.user);
    else db.users.push(clone(u.user));
    (u.txns || []).forEach((t) => {
      if (!db.transactions.some((x) => String(x.id) === String(t.id))) db.transactions.push(clone(t));
    });
  }
}

// Retry = put the optimistic local copy back exactly as the original save did,
// then queue the write again.
function reapplyWrite(f) {
  const d = (f.payload && f.payload.data) || {};
  const id = f.payload && f.payload.id;
  if (f.action === 'addTxn') {
    db.transactions.push({
      id: f.tmpId, user_name: d.user_id, date: d.date, type: d.type,
      amount: d.amount, comment: d.comment || '', photo: d.photo ? 'pending' : '',
    });
  } else if (f.action === 'addUser') {
    db.users.push({
      user_id: f.tmpId, name: d.name, phone: d.phone || '',
      created_at: todayISO(), token: '', _created: Date.now(),
    });
  } else if (f.action === 'updateTxn') {
    const t = db.transactions.find((x) => String(x.id) === String(id));
    if (t) Object.assign(t, d, {
      user_name: d.user_id,
      photo: d.photo ? 'pending' : (d.photo === '' ? '' : (t.photo || '')),
    });
  } else if (f.action === 'updateUser') {
    const u = db.users.find((x) => String(x.user_id) === String(id));
    if (u) Object.assign(u, { name: d.name, phone: d.phone });
  } else if (f.action === 'deleteTxn') {
    db.transactions = db.transactions.filter((x) => String(x.id) !== String(id));
  } else if (f.action === 'deleteUser') {
    db.users = db.users.filter((x) => String(x.user_id) !== String(id));
    db.transactions = db.transactions.filter((x) => String(x.user_name) !== String(id));
  }
}

function retryFailed(i) {
  const f = failed[i];
  if (!f) return;
  // An entry can only go back if its customer is still here — when the
  // customer's own write also failed, that one has to be retried first.
  const uid = f.payload && f.payload.data && f.payload.data.user_id;
  if (uid && !db.users.some((x) => String(x.user_id) === String(uid))) {
    toast('Pehle customer ko dobara bhejein', true);
    return;
  }
  failed.splice(i, 1);
  reapplyWrite(f);
  saveCache();
  queue.push({
    action: f.action, payload: f.payload, tmpId: f.tmpId || null,
    undo: f.undo || null, label: f.label,
  });
  saveQueue();
  saveFailed();
  render();
  renderFailed();
  if (!failed.length) $('dlg-failed').close();
  processQueue();
}

function discardFailed(i) {
  const f = failed[i];
  if (!f) return;
  failed.splice(i, 1);
  saveFailed();
  render();
  renderFailed();
  if (!failed.length) $('dlg-failed').close();
  toast('Hata diya — ' + f.label);
}

function renderFailed() {
  $('failed-list').innerHTML = failed.map((f, i) => `<li class="failed-row">
      <div class="failed-main">
        <div class="failed-label">${escapeHtml(f.label || f.action)}</div>
        <div class="failed-why">${escapeHtml(f.error || 'Server ne mana kar diya')}${f.at ? ' · ' + escapeHtml(relDate(new Date(f.at))) : ''}</div>
      </div>
      <button type="button" class="btn btn-ghost failed-act" data-retry="${i}">Retry</button>
      <button type="button" class="btn btn-danger-ghost failed-act" data-drop="${i}">Hatayein</button>
    </li>`).join('');
}

function isTmp(id) { return /^tmp/.test(String(id)); }

// Find a queued "add" item that created this temporary id
function queuedAddFor(tmpId) {
  return queue.find((item) => item.tmpId === tmpId);
}

// ---------------------------------------------------------------- demo backend

function demoSeed() {
  const t = new Date();
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const thisMonth = iso(t.getFullYear(), t.getMonth() + 1, Math.max(1, t.getDate() - 3));
  return {
    users: [
      { user_id: 'demo0001', name: 'Chetan Kirana Store', created_at: '2025-11-02', phone: '9876500001', token: '' },
      { user_id: 'demo0002', name: 'Sunita Tailor', created_at: '2025-12-14', phone: '9876500002', token: '' },
      { user_id: 'demo0003', name: 'Arihant Auto Works', created_at: '2026-01-05', phone: '', token: '' },
      { user_id: 'demo0004', name: 'Hina Madam', created_at: '2026-02-20', phone: '9876500004', token: '' },
    ],
    transactions: [
      { id: 'demot001', user_name: 'demo0001', date: '2026-05-11', type: 'given', amount: 11500, comment: 'Net parchi', photo: '' },
      { id: 'demot002', user_name: 'demo0001', date: '2026-06-01', type: 'given', amount: 1262, comment: 'Slip', photo: '' },
      { id: 'demot003', user_name: 'demo0001', date: '2026-07-03', type: 'received', amount: 6400, comment: 'Cash', photo: '' },
      { id: 'demot004', user_name: 'demo0002', date: '2026-06-18', type: 'given', amount: 1800, comment: 'School dress stitching', photo: '' },
      { id: 'demot005', user_name: 'demo0002', date: '2026-07-21', type: 'received', amount: 1800, comment: 'GPay', photo: '' },
      { id: 'demot006', user_name: 'demo0003', date: '2026-07-28', type: 'given', amount: 8624, comment: 'Copy + register', photo: '' },
      { id: 'demot007', user_name: 'demo0004', date: thisMonth, type: 'given', amount: 5500, comment: '50 kg kirana saman', photo: '' },
      { id: 'demot008', user_name: 'demo0004', date: thisMonth, type: 'given', amount: 200, comment: '100 ring golden', photo: '' },
    ],
  };
}

function demoApi(action, payload) {
  let demo = loadJSON(LS_DEMO) || demoSeed();
  const id = () => Math.random().toString(16).slice(2, 10);

  function storePhoto(data, existing) {
    if (data.photo === undefined) return existing || '';
    if (data.photo === '') return '';
    const pid = 'dph' + id();
    demoPhotos[pid] = data.photo;
    return pid;
  }

  switch (action) {
    case 'list':
      break;
    case 'photo':
      return Promise.resolve({ b64: demoPhotos[payload.id] || '', mime: 'image/jpeg' });
    case 'addUser':
      demo.users.push({
        user_id: id(), name: payload.data.name, created_at: todayISO(),
        phone: payload.data.phone || '', token: '', _created: Date.now(),
      });
      break;
    case 'updateUser': {
      const u = demo.users.find((x) => x.user_id === payload.id);
      if (u) Object.assign(u, payload.data);
      break;
    }
    case 'deleteUser':
      demo.users = demo.users.filter((x) => x.user_id !== payload.id);
      demo.transactions = demo.transactions.filter((x) => x.user_name !== payload.id);
      break;
    case 'addTxn':
      demo.transactions.push({
        id: id(), user_name: payload.data.user_id, date: payload.data.date,
        type: payload.data.type, amount: Number(payload.data.amount), comment: payload.data.comment || '',
        photo: storePhoto(payload.data, ''),
      });
      break;
    case 'updateTxn': {
      const t = demo.transactions.find((x) => x.id === payload.id);
      if (t) Object.assign(t, {
        date: payload.data.date, type: payload.data.type,
        amount: Number(payload.data.amount), comment: payload.data.comment || '',
        photo: storePhoto(payload.data, t.photo),
      });
      break;
    }
    case 'deleteTxn':
      demo.transactions = demo.transactions.filter((x) => x.id !== payload.id);
      break;
  }
  saveJSON(LS_DEMO, demo);
  return Promise.resolve({ users: demo.users, transactions: demo.transactions });
}

// ---------------------------------------------------------------- derived data

function txnsOf(userId) {
  return db.transactions
    .filter((t) => String(t.user_name) === String(userId))
    .sort((a, b) => parseDate(b.date) - parseDate(a.date));
}

// positive = customer owes you (due) · negative = you owe customer (advance)
function balanceOf(userId) {
  return txnsOf(userId).reduce(
    (sum, t) => sum + (t.type === 'received' ? -1 : 1) * (Number(t.amount) || 0), 0);
}

/* What a phone number may look like before it is allowed into the ledger
   (audit 1.5). Empty is fine — plenty of customers have no number. Otherwise
   it is the 10-digit local number, tolerating a leading 0 or the country code
   already typed in. Everything else (7 digits, junk text) is blocked with a
   readable reason instead of failing later inside WhatsApp. */
function checkPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const cc = (config && config.cc) || '91';
  if (!digits) return { ok: true, value: '' };
  if (digits.length === 10) return { ok: true, value: digits };
  if (digits.length === 11 && digits.startsWith('0')) return { ok: true, value: digits.slice(1) };
  if (digits.length === cc.length + 10 && digits.startsWith(cc)) {
    return { ok: true, value: digits.slice(cc.length) };
  }
  return { ok: false, value: digits };
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  const cc = (config && config.cc) || '91';
  if (digits.length === 10) return cc + digits;
  if (digits.length === 11 && digits.startsWith('0')) return cc + digits.slice(1);
  return digits;
}

// ---------------------------------------------------------------- render: home

function render() {
  renderHome();
  if (currentCustomerId) renderCustomer();
  updateChips();
}

function renderHome() {
  let totalDue = 0, totalAdv = 0;
  const items = db.users.map((u) => {
    const bal = balanceOf(u.user_id);
    if (bal > 0) totalDue += bal; else totalAdv += -bal;
    const txns = txnsOf(u.user_id);
    return { u, bal, txns, last: txns.length ? parseDate(txns[0].date) : parseDate(u.created_at) };
  });

  $('sum-get').textContent = money(totalDue);
  $('sum-give').textContent = money(totalAdv);
  $('sum-count').textContent = db.users.length;

  const typed = $('search').value.trim();
  const q = typed.toLowerCase();
  const filtered = items
    .filter((it) => !q || it.u.name.toLowerCase().includes(q))
    // created_at has no time of day, so a customer made two seconds ago ties
    // with everyone who transacted today and falls to the bottom. The local
    // _created stamp breaks that tie in favour of the newest (audit 0.8).
    .sort((a, b) => (b.last - a.last) || ((b.u._created || 0) - (a.u._created || 0)));

  $('customer-list').innerHTML = filtered.map((it, i) => {
    const tag = it.bal > 0 ? 'due' : it.bal < 0 ? 'adv' : '';
    // red = they owe you (milenge) · green = you owe them (denge)
    const caption = it.bal > 0 ? 'milenge' : it.bal < 0 ? 'denge' : '';
    const when = it.txns.length ? relDate(it.txns[0].date) : '';
    return `<li class="customer-row" data-id="${escapeHtml(it.u.user_id)}" style="animation-delay:${Math.min(i * 40, 400)}ms">
      <span class="avatar t${avatarTone(it.u.name)}">${escapeHtml(initialOf(it.u.name))}</span>
      <span class="customer-main">
        <span class="customer-name">${escapeHtml(it.u.name)}</span>
        ${when ? `<div class="customer-sub">${escapeHtml(when)}</div>` : ''}
      </span>
      <span class="customer-amt ${tag}"><b>${money(it.bal)}</b>${caption ? `<small>${caption}</small>` : ''}</span>
    </li>`;
  }).join('');

  // A search that matches nothing used to leave a blank screen — the empty
  // state was gated on total customers, not on the filtered count. The typed
  // name is almost always someone who still has to be created (audit 3.2).
  const noMatch = !!q && filtered.length === 0;
  $('home-empty').hidden = db.users.length > 0 || !!q;
  $('search-empty').hidden = !noMatch;
  if (noMatch) {
    $('search-empty-title').textContent = `'${typed}' nahi mila`;
    $('search-empty-add').textContent = `＋ '${typed}' ko naya customer banayein`;
  }
  $('chip-demo').hidden = !(config && config.demo);
}

function initialOf(name) {
  return (String(name).trim()[0] || '?').toUpperCase();
}
// deterministic avatar colour: name -> one of 8 muted palette slots (.avatar.t0…t7)
function avatarTone(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}

// ---------------------------------------------------------------- render: customer

function currentCustomer() {
  return db.users.find((u) => String(u.user_id) === String(currentCustomerId));
}

function renderCustomer() {
  const u = currentCustomer();
  if (!u) { goHome(); return; }

  $('cust-avatar').textContent = initialOf(u.name);
  $('cust-avatar').className = 'avatar t' + avatarTone(u.name);
  $('cust-name').textContent = u.name;
  $('cust-meta').textContent = u.phone ? '☎ ' + u.phone : 'no phone · tap to add';

  const call = $('btn-call');
  if (u.phone) { call.hidden = false; call.href = 'tel:+' + normalizePhone(u.phone); }
  else call.hidden = true;

  const bal = balanceOf(u.user_id);
  const amtEl = $('bal-amt');
  amtEl.textContent = money(bal);
  amtEl.className = 'balance-amt ' + (bal > 0 ? 'due' : bal < 0 ? 'adv' : '');
  $('bal-word').textContent =
    bal > 0 ? `${u.name.split(' ')[0]} owes you` :
    bal < 0 ? `you owe ${u.name.split(' ')[0]}` : 'settled up';

  const remind = $('btn-remind');
  const hint = $('remind-hint');
  if (bal > 0 && u.phone) { remind.hidden = false; hint.hidden = true; }
  else if (bal > 0 && !u.phone) { remind.hidden = true; hint.hidden = false; }
  else { remind.hidden = true; hint.hidden = true; }

  const txns = txnsOf(u.user_id);
  let lastMonth = '';
  $('txn-list').innerHTML = txns.map((t, i) => {
    const d = parseDate(t.date);
    const monthKey = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const divider = monthKey !== lastMonth
      ? `<li class="date-divider">— ${monthKey} —</li>` : '';
    lastMonth = monthKey;
    const side = t.type === 'received' ? 'got' : 'gave';
    return `${divider}<li class="txn-row" data-id="${escapeHtml(t.id)}" style="animation-delay:${Math.min(i * 30, 300)}ms">
      <div class="txn-cell ${side === 'gave' ? 'gave' : ''}">${side === 'gave' ? txnCell(t) : ''}</div>
      <div class="txn-cell ${side === 'got' ? 'got' : ''}">${side === 'got' ? txnCell(t) : ''}</div>
    </li>`;
  }).join('');

  $('cust-empty').hidden = txns.length > 0;
  loadLedgerThumbs();
}

function txnCell(t) {
  const hasPhoto = t.photo && t.photo !== 'pending';
  const thumb = hasPhoto
    ? (thumbs[t.photo]
        ? `<img class="txn-thumb" data-pid="${escapeHtml(t.photo)}" src="${thumbs[t.photo].d}" alt="photo">`
        : `<span class="txn-thumb txn-thumb-ph" data-pid="${escapeHtml(t.photo)}">📎</span>`)
    : '';
  return `<div class="txn-body"><div class="txn-text">` +
    `<div class="txn-amt">${money(t.amount)}</div>` +
    (t.comment ? `<div class="txn-note">${escapeHtml(t.comment)}</div>` : '') +
    `<div class="txn-date">${fmtDate(t.date)}${t.photo === 'pending' ? ' 📎' : ''}</div>` +
    `</div>${thumb}</div>`;
}

// fetch full photos one at a time, shrink to 96px squares, cache locally
async function loadLedgerThumbs() {
  const ids = [...new Set(
    [...document.querySelectorAll('#txn-list .txn-thumb-ph')].map((el) => el.dataset.pid)
  )].filter((id) => id && !thumbs[id] && !thumbLoading.has(id));
  for (const id of ids) {
    thumbLoading.add(id);
    try {
      if (!photoCache[id]) {
        const data = await api('photo', { id });
        if (!data.b64) throw new Error('not found');
        photoCache[id] = `data:${data.mime || 'image/jpeg'};base64,` + data.b64;
      }
      thumbs[id] = { d: await makeThumb(photoCache[id]), t: Date.now() };
      saveThumbs();
      document.querySelectorAll(`#txn-list .txn-thumb-ph[data-pid="${CSS.escape(id)}"]`).forEach((el) => {
        const img = document.createElement('img');
        img.className = 'txn-thumb';
        img.dataset.pid = id;
        img.src = thumbs[id].d;
        img.alt = 'photo';
        el.replaceWith(img);
      });
    } catch (e) { /* keep the 📎 placeholder */ }
    finally { thumbLoading.delete(id); }
  }
}

function makeThumb(dataURI) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = 96;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(
        img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => reject(new Error('thumb failed'));
    img.src = dataURI;
  });
}

function saveThumbs() {
  const keys = Object.keys(thumbs);
  if (keys.length > 120) {
    keys.sort((a, b) => thumbs[a].t - thumbs[b].t)
      .slice(0, keys.length - 120)
      .forEach((k) => delete thumbs[k]);
  }
  try { saveJSON(LS_THUMBS, thumbs); }
  catch (e) { thumbs = {}; try { saveJSON(LS_THUMBS, thumbs); } catch (e2) { /* skip caching */ } }
}

function goHome() {
  currentCustomerId = null;
  show('home');
  renderHome();
}

function openCustomer(id, push) {
  currentCustomerId = id;
  show('customer');
  renderCustomer();
  if (push !== false) history.pushState({ customer: id }, '');
}

// ---------------------------------------------------------------- invite & passbook links

// #s=… carries a merchant connection (URL + key). Fragment never reaches servers.
// Parsing is *all* this does: nothing in the link is believed until the backend
// has answered a real list call with it (audit 0.3).
function parseInviteLink() {
  const m = /#s=([A-Za-z0-9\-_]+)/.exec(location.hash);
  if (!m) return null;
  let payload;
  try {
    payload = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return null; }
  if (!payload.u || !/^https:\/\/script\.google(?:usercontent)?\.com\//.test(payload.u)) return null;
  // the key is a credential — get it out of the address bar immediately
  history.replaceState(null, '', location.pathname + location.search);
  return { u: payload.u, k: payload.k || '' };
}

/* ---------- connecting to a ledger -------------------------------------

   Two rules, both learned the hard way (audit 0.3):
   1. A connection is never committed before a real `list` call succeeds with
      it. "Connected ✓" over an empty ledger invites entries that die later.
   2. Nothing from the old connection may ride into the new one — not the
      cache, not the queue (ledger A's unsynced writes replaying into ledger
      B's sheet), not the demo's shop name signing real reminders. */

let connecting = false;      // a validation is in flight — leave config alone
let pendingInvite = null;    // an invite waiting on the switch dialog

function wipeLedgerData() {
  [LS_CACHE, LS_QUEUE, LS_FAILED, LS_DEMO, LS_THUMBS].forEach((k) => localStorage.removeItem(k));
  db = { users: [], transactions: [] };
  queue = [];
  failed = [];
  thumbs = {};
  Object.keys(photoCache).forEach((k) => delete photoCache[k]);
  Object.keys(demoPhotos).forEach((k) => delete demoPhotos[k]);
  currentCustomerId = null;
  setAuthBad(false);
}

// Device preferences (currency, country code, a template the merchant typed)
// are theirs and carry over. Shop identity belongs to the *ledger*: a demo's
// "Demo General Store" — or the previous ledger's name — must never end up
// signing real WhatsApp reminders. The demo ships the stock template, so
// "reset it if it equals the demo's" is exactly the default fallback below.
function freshConfig(url, key, prev) {
  const sameLedger = !!(prev && !prev.demo && prev.url === url);
  return {
    url,
    key: key || '',
    demo: false,
    currency: (prev && prev.currency) || '₹',
    cc: (prev && prev.cc) || '91',
    merchant: sameLedger ? (prev.merchant || '') : '',
    template: (prev && prev.template) || DEFAULT_TEMPLATE,
  };
}

// Ask the backend, with the candidate credentials, before anything is saved.
// On failure the old config is put back exactly as it was.
async function validateConfig(candidate) {
  const prev = config;
  config = candidate;
  try {
    return await api('list');
  } catch (err) {
    config = prev;
    setAuthBad(false);   // the bad key was the candidate's, not this ledger's
    throw err;
  }
}

// Validate → wipe (only when the ledger actually changes) → commit → render.
// Throws if the credentials do not work; the device is untouched in that case.
async function connectTo(invite) {
  const prev = config;
  const candidate = freshConfig(invite.u, invite.k, prev);
  const sameLedger = !!(prev && !prev.demo && prev.url === candidate.url);
  const data = await validateConfig(candidate);
  if (!sameLedger) wipeLedgerData();     // another khata (or the demo's) — nothing survives
  config = candidate;
  saveJSON(LS_CONFIG, config);
  db = { users: data.users || [], transactions: data.transactions || [] };
  saveCache();
  show('home');
  render();
  return sameLedger;
}

function connectNote(msg, isErr) {
  const el = $('connect-note');
  el.textContent = msg || '';
  el.className = 'connect-alert reveal d2' + (isErr ? ' err' : '');
  el.hidden = !msg;
}

// Normal start-up: cached copy first, then a background sync.
function bootLedger(opts) {
  if (!config) { show('connect'); return; }
  show('home');
  render();
  if (!opts || opts.sync !== false) refresh(true);
}

// The invite path. Every branch ends with the merchant on a screen that tells
// the truth about which khata this phone is holding.
async function openInvite(invite) {
  const prev = config;
  const prevReal = !!(prev && !prev.demo);
  const sameLedger = prevReal && prev.url === invite.u;
  if (sameLedger && (prev.key || '') === invite.k) { bootLedger(); return; }

  // Unsynced writes belong to the ledger they were made in. Until they are
  // synced or explicitly thrown away, no other connection may touch this phone.
  const unsynced = queue.length + failed.length;
  if (prev && unsynced) { bootLedger(); askSwitch(invite, unsynced); return; }
  if (prevReal && !sameLedger) { bootLedger(); askSwitch(invite, 0); return; }

  await runConnect(invite, prev);
}

async function runConnect(invite, prev) {
  connecting = true;
  if (!prev) { show('connect'); connectNote('Ledger khul raha hai — thoda intezaar karein…'); }
  else bootLedger({ sync: false });   // keep the old ledger on screen, don't sync it mid-swap
  try {
    const sameLedger = await connectTo(invite);
    connectNote('');
    toast(sameLedger ? 'Nayi key lag gayi ✓' : 'Khata jud gaya ✓');
  } catch (err) {
    if (!prev) {
      show('connect');
      connectNote('Yeh link kaam nahi kar raha — bhejne wale se naya link mangwayein', true);
    } else {
      bootLedger();   // old khata, untouched
      toast('Yeh link kaam nahi kar raha — purana khata waisa hi hai', true);
    }
  } finally {
    connecting = false;
  }
}

function askSwitch(invite, unsynced) {
  pendingInvite = invite;
  const go = $('switch-go');
  $('switch-msg').textContent = unsynced
    ? unsynced + ' entry abhi tak sheet me nahi gayi. Pehle unko sync karein — ' +
      'warna woh galat khaate me chali jayengi.'
    : 'Is phone par doosra khata khulega. Purana khata hat jayega.';
  $('switch-sync').hidden = !unsynced;
  go.textContent = unsynced ? 'Hata kar jodein' : 'Jodein';
  go.className = 'btn ' + (unsynced ? 'btn-danger-ghost' : 'btn-ink');
  $('dlg-switch').dataset.drop = unsynced ? '1' : '';
  showSheet($('dlg-switch'));
}

function inviteLink() {
  return location.origin + location.pathname + '#s=' + b64url({ u: config.url, k: config.key });
}

// #p=… opens the read-only customer passbook. {u,t} = api url + customer token;
// {d} = demo customer id.
function applyPassbookLink() {
  const m = /#p=([A-Za-z0-9\-_]+)/.exec(location.hash);
  if (!m) return false;
  let payload;
  try {
    payload = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return false; }
  if (!payload.d && !(payload.u && payload.t)) return false;
  show('passbook');
  renderPassbook(payload);
  return true;
}

async function renderPassbook(payload) {
  const status = $('pb-status');
  try {
    let data;
    if (payload.d) {
      const demo = loadJSON(LS_DEMO) || demoSeed();
      const u = demo.users.find((x) => x.user_id === payload.d);
      if (!u) throw new Error('This passbook link is no longer valid.');
      data = { name: u.name, transactions: demo.transactions.filter((t) => t.user_name === payload.d) };
    } else {
      const res = await fetch(payload.u, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'passbook', token: payload.t }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Could not load your passbook.');
      data = json.data;
    }

    $('pb-name').textContent = data.name;
    const txns = data.transactions.slice()
      .sort((a, b) => parseDate(b.date) - parseDate(a.date));
    const bal = txns.reduce((s, t) => s + (t.type === 'received' ? -1 : 1) * (Number(t.amount) || 0), 0);
    const amtEl = $('pb-amt');
    amtEl.textContent = money(bal);
    amtEl.className = 'balance-amt ' + (bal > 0 ? 'due' : bal < 0 ? 'adv' : '');
    $('pb-word').textContent = bal > 0 ? 'to pay' : bal < 0 ? 'advance with shopkeeper' : 'settled up';

    let lastMonth = '';
    $('pb-list').innerHTML = txns.map((t) => {
      const d = parseDate(t.date);
      const monthKey = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      const divider = monthKey !== lastMonth ? `<li class="date-divider">— ${monthKey} —</li>` : '';
      lastMonth = monthKey;
      const side = t.type === 'received' ? 'got' : 'gave';
      const cell = `<div class="txn-amt">${money(t.amount)}</div>` +
        (t.comment ? `<div class="txn-note">${escapeHtml(t.comment)}</div>` : '') +
        `<div class="txn-date">${fmtDate(t.date)}</div>`;
      return `${divider}<li class="txn-row txn-ro">
        <div class="txn-cell ${side === 'gave' ? 'gave' : ''}">${side === 'gave' ? cell : ''}</div>
        <div class="txn-cell ${side === 'got' ? 'got' : ''}">${side === 'got' ? cell : ''}</div>
      </li>`;
    }).join('');
    status.hidden = true;
  } catch (err) {
    status.textContent = (err instanceof TypeError)
      ? 'Could not reach the ledger — check your internet and reopen the link.'
      : err.message;
  }
}

function passbookLink(u) {
  if (config && config.demo) {
    return location.origin + location.pathname + '#p=' + b64url({ d: u.user_id });
  }
  if (!u.token) return '';
  return location.origin + location.pathname + '#p=' + b64url({ u: config.url, t: u.token });
}

// ---------------------------------------------------------------- reminders

function reminderLink(u, bal) {
  const template = (config && config.template) || DEFAULT_TEMPLATE;
  const merchant = (config && config.merchant) || 'hamari dukaan';
  const pb = passbookLink(u);
  let msg = template
    .replaceAll('{name}', u.name)
    .replaceAll('{amount}', money(bal))
    .replaceAll('{merchant}', merchant);
  if (msg.includes('{passbook}')) {
    // strip the whole line cleanly when no link is available yet
    msg = pb ? msg.replaceAll('{passbook}', pb)
             : msg.split('\n').filter((line) => !line.includes('{passbook}')).join('\n');
  } else if (pb) {
    msg += '\nApna pura hisaab: ' + pb;
  }
  return 'https://wa.me/' + normalizePhone(u.phone) + '?text=' + encodeURIComponent(msg);
}

// ---------------------------------------------------------------- photos

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const shrink = (maxSide, quality) => {
        const s = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * s));
        c.height = Math.max(1, Math.round(img.height * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', quality);
      };
      let dataUri = shrink(1280, 0.72);
      if (dataUri.length > 1400000) dataUri = shrink(1024, 0.55);
      if (dataUri.length > 1400000) dataUri = shrink(800, 0.5);
      resolve(dataUri.split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

function setPhotoUI() {
  const label = $('txn-photo-label');
  const view = $('txn-photo-view');
  if (photoState.mode === 'new') {
    label.textContent = 'Photo added ✓';
    view.hidden = false;
  } else if (photoState.mode === 'existing') {
    label.textContent = 'Change';
    view.hidden = false;
  } else {
    label.textContent = 'Add photo';
    view.hidden = true;
  }
}

// Removing a bill photo now lives in the viewer, behind a confirm — you have to
// be looking at the photo to throw it away (audit 1.2). Only the form flow may
// remove; a tap from the read-only ledger just looks.
async function viewCurrentPhoto() {
  if (photoState.mode === 'new') {
    const img = $('photo-img');
    img.src = 'data:image/jpeg;base64,' + photoState.b64;
    openPhotoViewer(true);
  } else if (photoState.mode === 'existing') {
    viewPhotoById(photoState.id, true);
  }
}

function openPhotoViewer(fromForm) {
  $('photo-remove').hidden = !fromForm;
  showSheet($('dlg-photo'));
}

async function viewPhotoById(id, fromForm) {
  const img = $('photo-img');
  img.src = '';
  try {
    if (!photoCache[id]) {
      toast('Photo aa rahi hai…');
      const data = await api('photo', { id });
      if (!data.b64) throw new Error('Photo not found');
      photoCache[id] = `data:${data.mime || 'image/jpeg'};base64,` + data.b64;
    }
    img.src = photoCache[id];
    openPhotoViewer(fromForm);
  } catch (err) {
    toast('Photo nahi khul payi: ' + err.message, true);
  }
}

// ---------------------------------------------------------------- entry save & undo

/* Colored readback after every save — the only way a red/green mis-tap gets
   noticed at all (audit 1.3). Red for given, green for received, the
   customer's first name, and the balance the entry actually produced. */
function saveReadback(payload) {
  const u = currentCustomer();
  const first = u ? String(u.name).trim().split(/\s+/)[0] : '';
  const bal = balanceOf(currentCustomerId);
  const tail = bal > 0 ? money(bal) + ' baaki'
    : bal < 0 ? money(bal) + ' advance'
    : 'hisaab clear';
  const got = payload.type === 'received';
  showToast(
    `${money(payload.amount)} ${got ? 'mila' : 'diya'} · ${first} — ${tail}` +
    (navigator.onLine ? '' : ' · sync baaki'),
    { tone: got ? 'got' : 'gave' }
  );
}

/* Undo after deleting an entry (audit 1.2). Two shapes, both cheap:
   - the delete is still sitting in the queue (or was only ever a queued add):
     drop that queue item and put the row back — no server call at all;
   - the queue already drained, or we are in demo mode where writes go through
     immediately: the sheet row is gone, so re-create it as a fresh addTxn.
   A re-created entry cannot carry its photo back (the bytes only ever lived in
   the queued payload), so it returns without one. */
function restoreTxn(pre) {
  if (!pre) return;
  if (!db.transactions.some((t) => String(t.id) === String(pre.id))) db.transactions.push(clone(pre));
  saveCache();
  render();
  toast('Entry wapas aa gayi');
}

function readdTxn(pre) {
  if (!pre) return;
  const tmpId = 'tmp' + Date.now();
  const data = {
    user_id: pre.user_name, date: isoOf(pre.date), type: pre.type,
    amount: pre.amount, comment: pre.comment || '',
  };
  db.transactions.push(Object.assign(clone(pre), { id: tmpId, photo: '' }));
  saveCache();
  enqueue('addTxn', { data }, tmpId);
  render();
  toast(pre.photo ? 'Entry wapas aa gayi — photo nahi aa payi' : 'Entry wapas aa gayi');
}

// ---------------------------------------------------------------- double-tap confirm

/* Two taps to destroy something. The token must name the *entity*, never just
   the kind of thing ('del-txn:t9', not 'del-txn'), and the armed state is
   cleared whenever a dialog opens or closes — otherwise arming on entry A and
   cancelling leaves entry B one tap from the grave (audit 0.2). */

// Put every armed button back the way it was and forget the arming.
function disarmConfirm() {
  confirmArmed = null;
  clearTimeout(armConfirm._t);
  document.querySelectorAll('.btn.armed').forEach((b) => {
    if (b.dataset.armedLabel != null) {
      b.textContent = b.dataset.armedLabel;
      delete b.dataset.armedLabel;
    }
    b.classList.remove('armed');
    b.style.width = '';
  });
}

function armConfirm(btn, token, warn) {
  if (confirmArmed === token) { disarmConfirm(); return true; }
  disarmConfirm();
  confirmArmed = token;
  // Pin the box before swapping the label: an armed button that resizes shoves
  // the whole action row sideways, and the next tap lands somewhere else.
  const w = btn.getBoundingClientRect().width;   // border-box, so it round-trips exactly
  if (w) btn.style.width = w.toFixed(2) + 'px';
  btn.dataset.armedLabel = btn.textContent;
  btn.textContent = 'Pakka?';
  btn.classList.add('armed');   // ghost-red outline fills in solid red
  if (warn) toast(warn);        // room for the real warning, no reflow
  armConfirm._t = setTimeout(() => {
    if (confirmArmed === token) disarmConfirm();
  }, 2600);
  return false;
}

// ---------------------------------------------------------------- wiring

function init() {
  // connect screen
  $('btn-connect').addEventListener('click', async () => {
    if (connecting) return;
    const url = $('cfg-url').value.trim();
    const key = $('cfg-key').value.trim();
    const errEl = $('connect-error');
    errEl.hidden = true;
    if (!/^https:\/\/script\.google(?:usercontent)?\.com\//.test(url)) {
      errEl.textContent = 'That does not look like an Apps Script /exec URL.';
      errEl.hidden = false;
      return;
    }
    connecting = true;
    try {
      // same path as an invite: validated first, demo residue never inherited
      await connectTo({ u: url, k: key });
      connectNote('');
      toast('Aapka khata khul gaya ✓');
    } catch (err) {
      errEl.textContent = 'Could not connect: ' + err.message;
      errEl.hidden = false;
    } finally {
      connecting = false;
    }
  });

  $('btn-demo').addEventListener('click', () => {
    if (connecting) return;
    config = { demo: true, currency: '₹', cc: '91', merchant: 'Demo General Store', template: DEFAULT_TEMPLATE };
    saveJSON(LS_CONFIG, config);
    refresh(true);
    show('home');
    toast('Demo ledger — sample data, edits stay on this device');
  });

  // home
  $('search').addEventListener('input', renderHome);
  $('btn-refresh').addEventListener('click', () => refresh());
  $('chip-pending').addEventListener('click', () => { toast('Retrying sync…'); processQueue(); });
  $('chip-failed').addEventListener('click', () => {
    renderFailed();
    showSheet($('dlg-failed'));
  });
  $('chip-auth').addEventListener('click', () => $('btn-settings').click());
  $('failed-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.failed-act');
    if (!btn) return;
    if (btn.dataset.retry !== undefined) retryFailed(Number(btn.dataset.retry));
    else if (btn.dataset.drop !== undefined) discardFailed(Number(btn.dataset.drop));
  });
  $('customer-list').addEventListener('click', (e) => {
    const row = e.target.closest('.customer-row');
    if (row) openCustomer(row.dataset.id);
  });
  $('fab').addEventListener('click', () => openCustomerForm(null));
  // a no-match search offers the one thing it can: create that person
  $('search-empty-add').addEventListener('click', () => openCustomerForm(null, $('search').value.trim()));

  // ledger switch (invite link for a different khata / a refreshed key)
  $('switch-go').addEventListener('click', async () => {
    const invite = pendingInvite;
    const drop = $('dlg-switch').dataset.drop === '1';
    $('dlg-switch').close();
    if (!invite || connecting) return;
    if (drop) {
      // explicit discard — the only way past unsynced writes
      queue = [];
      failed = [];
      saveQueue();
      saveFailed();
      render();
    }
    await runConnect(invite, config);
  });
  $('switch-sync').addEventListener('click', () => {
    $('dlg-switch').close();
    toast('Pehle purani entry sync karein, phir link dobara kholein');
    processQueue();
  });
  $('dlg-switch').addEventListener('close', () => { pendingInvite = null; });

  // settings
  $('btn-settings').addEventListener('click', () => {
    $('set-merchant').value = config.merchant || '';
    $('set-currency').value = config.currency || '₹';
    $('set-cc').value = config.cc || '91';
    $('set-template').value = config.template || DEFAULT_TEMPLATE;
    $('set-url').value = config.url || '';
    $('set-key').value = config.key || '';
    document.querySelector('.settings-conn').open = false;
    $('invite-wrap').hidden = !!config.demo || !config.url;
    showSheet($('dlg-settings'));
  });
  // The dangerous link. The warning lands on the *first* tap — before the copy
  // exists — not as a 3.2s toast after it is already in the clipboard (1.1).
  $('btn-invite').addEventListener('click', (e) => {
    if (!armConfirm(e.currentTarget, 'invite-copy',
      'Is link se poora khata khul jayega — sirf apne bharose walon ko bhejein')) return;
    copyText(inviteLink())
      .then(() => toast('Link copy ho gaya — sirf bharose wale ko bhejein'))
      .catch(() => toast('Copy nahi ho paya', true));
  });
  $('form-settings').addEventListener('submit', () => {
    config.merchant = $('set-merchant').value.trim();
    config.currency = $('set-currency').value.trim() || '₹';
    config.cc = $('set-cc').value.replace(/\D/g, '') || '91';
    config.template = $('set-template').value || DEFAULT_TEMPLATE;
    if (!config.demo) {
      config.url = $('set-url').value.trim();
      config.key = $('set-key').value.trim();
    }
    saveJSON(LS_CONFIG, config);
    render();
    toast('Settings saved');
  });
  $('btn-disconnect').addEventListener('click', (e) => {
    if (!armConfirm(e.currentTarget, 'disconnect')) return;
    const unsynced = queue.length + failed.length;
    if (unsynced && !window.confirm(unsynced + ' unsynced change(s) will be lost. Disconnect anyway?')) return;
    // thumbs are bill photos — a "cleared" device must not keep them (audit 0.9)
    [LS_CONFIG, LS_CACHE, LS_DEMO, LS_QUEUE, LS_FAILED, LS_THUMBS]
      .forEach((k) => localStorage.removeItem(k));
    location.reload();
  });

  // customer screen
  $('btn-back').addEventListener('click', () => history.back());
  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.customer) openCustomer(e.state.customer, false);
    else goHome();
  });
  $('cust-head-main').addEventListener('click', () => openCustomerForm(currentCustomerId));
  $('btn-remind').addEventListener('click', () => {
    const u = currentCustomer();
    window.open(reminderLink(u, balanceOf(u.user_id)), '_blank');
  });
  $('btn-gave').addEventListener('click', () => openTxnForm('given', null));
  $('btn-got').addEventListener('click', () => openTxnForm('received', null));
  $('txn-list').addEventListener('click', (e) => {
    const th = e.target.closest('.txn-thumb');
    if (th && th.dataset.pid) { viewPhotoById(th.dataset.pid, false); return; }
    const row = e.target.closest('.txn-row');
    if (!row) return;
    const t = db.transactions.find((x) => x.id === row.dataset.id);
    if (t) openTxnForm(t.type, t);
  });

  // txn photo controls
  $('txn-photo').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const b64 = await compressImage(file);
      photoState = { mode: 'new', b64, id: photoState.id };
      setPhotoUI();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('txn-photo-view').addEventListener('click', viewCurrentPhoto);
  $('photo-remove').addEventListener('click', (e) => {
    if (!armConfirm(e.currentTarget, 'del-photo')) return;
    photoState = { mode: 'removed', b64: null, id: null };
    setPhotoUI();
    $('dlg-photo').close();
    toast('Photo hata di — entry save karein');
  });

  // direction toggle (edit only)
  $('txn-dir').addEventListener('click', (e) => {
    const b = e.target.closest('.dir-btn');
    if (b) setTxnFormType(b.dataset.dir);
  });

  // txn dialog
  $('form-txn').addEventListener('submit', (e) => {
    const amount = parseFloat($('txn-amount').value.replace(/[,\s]/g, ''));
    const errEl = $('txn-error');
    errEl.hidden = true;
    if (!(amount > 0)) {
      e.preventDefault();
      errEl.textContent = 'Enter an amount greater than zero.';
      errEl.hidden = false;
      return;
    }
    const payload = {
      user_id: currentCustomerId,
      date: $('txn-date').value || todayISO(),
      type: txnFormType,
      amount,
      comment: $('txn-comment').value.trim(),
    };
    if (photoState.mode === 'new') payload.photo = photoState.b64;
    if (photoState.mode === 'removed') payload.photo = '';

    if (editingTxnId) {
      const t = db.transactions.find((x) => x.id === editingTxnId);
      const pre = clone(t);   // rollback pre-image, taken before we overwrite it
      const localPhoto = photoState.mode === 'new' ? 'pending'
        : photoState.mode === 'removed' ? '' : (t.photo || '');
      Object.assign(t, payload, { user_name: payload.user_id, photo: localPhoto });
      const queuedAdd = isTmp(editingTxnId) && queuedAddFor(editingTxnId);
      if (queuedAdd) {
        Object.assign(queuedAdd.payload.data, payload);
        queuedAdd.label = describeWrite(queuedAdd.action, queuedAdd.payload, queuedAdd.undo);
        saveQueue(); processQueue();
      } else {
        enqueue('updateTxn', { id: editingTxnId, data: payload }, null, { type: 'txn', txn: pre });
      }
    } else {
      const tmpId = 'tmp' + Date.now();
      // local copy carries a marker, never the photo bytes (those live in the queue payload)
      const localTxn = Object.assign({ id: tmpId, user_name: payload.user_id }, payload);
      localTxn.photo = photoState.mode === 'new' ? 'pending' : '';
      db.transactions.push(localTxn);
      enqueue('addTxn', { data: payload }, tmpId);
    }
    saveCache();
    render();
    saveReadback(payload);
  });
  $('txn-delete').addEventListener('click', (e) => {
    if (!armConfirm(e.currentTarget, 'del-txn:' + editingTxnId)) return;
    $('dlg-txn').close();
    const id = editingTxnId;
    const pre = clone(db.transactions.find((x) => x.id === id));
    db.transactions = db.transactions.filter((x) => x.id !== id);
    const queuedAdd = isTmp(id) && queuedAddFor(id);
    let undoDelete;
    if (queuedAdd) {
      // Never reached the sheet — dropping its queued add *is* the delete, so
      // undo is simply putting that item (and the row) back.
      const at = queue.indexOf(queuedAdd);
      queue = queue.filter((item) => item !== queuedAdd);
      saveQueue();
      undoDelete = () => {
        queue.splice(Math.min(at, queue.length), 0, queuedAdd);
        saveQueue();
        restoreTxn(pre);
        processQueue();
      };
    } else {
      enqueue('deleteTxn', { id }, null, pre ? { type: 'txn', txn: pre } : null);
      const queued = queue[queue.length - 1];
      const del = queued && queued.action === 'deleteTxn' && queued.payload.id === id ? queued : null;
      undoDelete = () => {
        const i = del ? queue.indexOf(del) : -1;
        if (i >= 0) { queue.splice(i, 1); saveQueue(); restoreTxn(pre); }   // still queued: purely local
        else readdTxn(pre);                                                 // already gone upstream: re-create
      };
    }
    saveCache();
    render();
    if (pre) {
      showToast('Entry hata di ·', {
        action: 'WAPAS LAYEIN', onAction: undoDelete, ms: 7000,
      });
    }
  });

  // customer dialog
  // normalized readback as soon as the field is left, so the merchant sees the
  // number the reminder will actually use (audit 1.5)
  $('cust-input-phone').addEventListener('change', (e) => {
    const ok = checkPhone(e.target.value);
    if (ok.ok && ok.value) e.target.value = ok.value;
  });
  $('cust-passbook').addEventListener('click', () => {
    const u = db.users.find((x) => String(x.user_id) === String(editingCustomerId));
    const link = u ? passbookLink(u) : '';
    if (!link) { toast('Is customer ka passbook link abhi nahi bana', true); return; }
    copyText(link)
      .then(() => toast('Passbook link copy ho gaya — sirf dekhne ke liye'))
      .catch(() => toast('Copy nahi ho paya', true));
  });
  $('form-customer').addEventListener('submit', (e) => {
    const name = $('cust-input-name').value.trim();
    const errEl = $('cust-error');
    errEl.hidden = true;
    if (!name) {
      e.preventDefault();
      errEl.textContent = 'Name is required.';
      errEl.hidden = false;
      return;
    }
    // A 7-digit number is a wa.me link that fails inside WhatsApp days later,
    // and junk text opens the contact picker — the balance goes to a stranger.
    const checked = checkPhone($('cust-input-phone').value);
    if (!checked.ok) {
      e.preventDefault();
      errEl.textContent = 'Phone number 10 digit ka hona chahiye';
      errEl.hidden = false;
      $('cust-input-phone').focus();
      return;
    }
    const phone = checked.value;
    $('cust-input-phone').value = phone;
    if (editingCustomerId) {
      const u = db.users.find((x) => x.user_id === editingCustomerId);
      const pre = clone(u);   // rollback pre-image, taken before we overwrite it
      Object.assign(u, { name, phone });
      const queuedAdd = isTmp(editingCustomerId) && queuedAddFor(editingCustomerId);
      if (queuedAdd) {
        Object.assign(queuedAdd.payload.data, { name, phone });
        queuedAdd.label = describeWrite(queuedAdd.action, queuedAdd.payload, queuedAdd.undo);
        saveQueue(); processQueue();
      } else {
        enqueue('updateUser', { id: editingCustomerId, data: { name, phone } }, null,
          { type: 'user', user: pre });
      }
    } else {
      const tmpId = 'tmpu' + Date.now();
      // _created: the sheet's created_at has no time, so today's new customer
      // ties with today's transactors and loses. Local ms breaks the tie (0.8).
      db.users.push({ user_id: tmpId, name, phone, created_at: todayISO(), token: '', _created: Date.now() });
      enqueue('addUser', { data: { name, phone } }, tmpId);
      toast(`${name} added`);
    }
    saveCache();
    render();
  });
  $('cust-delete').addEventListener('click', (e) => {
    if (!armConfirm(e.currentTarget, 'del-cust:' + editingCustomerId,
      'Dobara tap — is customer ki saari entry mit jayengi')) return;
    $('dlg-customer').close();
    const id = editingCustomerId;
    // pre-image for rollback: the customer AND every entry that goes with them
    const preUser = clone(db.users.find((x) => x.user_id === id));
    const preTxns = clone(db.transactions.filter((x) => String(x.user_name) === String(id)));
    db.users = db.users.filter((x) => x.user_id !== id);
    db.transactions = db.transactions.filter((x) => x.user_name !== id);
    const queuedAdd = isTmp(id) && queuedAddFor(id);
    if (queuedAdd) {
      // never reached the server — drop its add and any queued entries for it
      queue = queue.filter((item) => item !== queuedAdd &&
        !(item.payload && item.payload.data && item.payload.data.user_id === id));
      saveQueue();
    } else {
      enqueue('deleteUser', { id }, null,
        preUser ? { type: 'user', user: preUser, txns: preTxns } : null);
    }
    saveCache();
    goHome();
    toast('Customer deleted');
  });

  // generic dialog close buttons
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  // A cancelled (or submitted, or Esc'd) dialog must never leave an arming
  // behind for whatever opens next — audit 0.2's other half. It also hands the
  // overlays back down to whatever is underneath it.
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
    disarmConfirm();
    moveOverlays();
  }));

  // update notice — its own element, so an ordinary toast can't wipe it
  $('update-go').addEventListener('click', () => location.reload());
  $('update-dismiss').addEventListener('click', () => topHide($('update-bar')));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && updateWaiting) showUpdateBar();
  });

  // resync when network returns
  window.addEventListener('online', () => { setOffline(false); processQueue(); });
  window.addEventListener('offline', () => setOffline(true));

  // boot — a passbook link is a customer view; an invite link is a merchant connection
  if (applyPassbookLink()) {
    // read-only mode: nothing else to wire
  } else {
    const invite = parseInviteLink();
    if (invite) openInvite(invite);   // async: validates before it believes the link
    else bootLedger();
  }

  // Ask the browser to never evict our storage (config, cache, queue, thumbs).
  // Chrome auto-grants this for installed PWAs — no prompt.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          // "installed" with an existing controller = an update, not a first install
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar();
          }
        });
      });
      // installed PWAs can stay alive for days — re-check on every foreground
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

// Direction is the one thing a merchant most often taps wrong, and the two
// entry buttons on the customer screen are frozen — so the fix is a toggle
// inside the *edit* dialog only (audit 1.3). It repaints the title, the Save
// button and the toggle itself, so the colour never lies about what will save.
function setTxnFormType(type) {
  txnFormType = type === 'received' ? 'received' : 'given';
  const got = txnFormType === 'received';
  const title = $('txn-title');
  title.textContent = got ? 'Received' : 'Given';
  title.className = 'sheet-title ' + (got ? 'got' : 'gave');
  $('txn-save').className = 'btn btn-ink ' + (got ? 'got' : 'gave');
  $('txn-dir').querySelectorAll('.dir-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.dir === txnFormType));
  });
}

function openTxnForm(type, txn) {
  disarmConfirm();   // an arming can never survive into another entry
  editingTxnId = txn ? txn.id : null;
  setTxnFormType(type);
  $('txn-dir').hidden = !txn;   // only when editing; new entries keep the frozen flow
  $('txn-cur').textContent = (config && config.currency) || '₹';
  $('txn-amount').value = txn ? String(txn.amount) : '';
  $('txn-date').value = txn ? isoOf(txn.date) : todayISO();
  $('txn-comment').value = txn ? (txn.comment || '') : '';
  photoState = (txn && txn.photo && txn.photo !== 'pending')
    ? { mode: 'existing', b64: null, id: txn.photo }
    : { mode: 'none', b64: null, id: null };
  setPhotoUI();
  $('txn-delete').hidden = !txn;
  $('txn-delete').textContent = 'Delete';
  $('txn-error').hidden = true;
  showSheet($('dlg-txn'));
  if (!txn) $('txn-amount').focus();
}

function openCustomerForm(id, prefillName) {
  disarmConfirm();   // …nor into another customer
  editingCustomerId = id;
  const u = id ? db.users.find((x) => String(x.user_id) === String(id)) : null;
  $('cust-dlg-title').textContent = u ? 'Edit customer' : 'New customer';
  $('cust-input-name').value = u ? u.name : (prefillName || '');
  $('cust-input-phone').value = u ? (u.phone || '') : '';
  // no token yet (a queued tmp id, or a pre-v3 backend) = no passbook link
  $('cust-passbook-wrap').hidden = !(u && passbookLink(u));
  $('cust-delete').hidden = !u;
  $('cust-delete').textContent = 'Delete';
  $('cust-error').hidden = true;
  showSheet($('dlg-customer'));
  if (!u) $('cust-input-name').focus();
}

init();
