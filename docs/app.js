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
const LS_PINLOCK = 'bahi.pinlock';   // PIN attempt limiter — counters only, never digits

/* A passbook link the merchant revoked keeps this sentinel in the token cell:
   a blank cell would simply be re-issued by the backend's backfill. It is a
   dead token, so no link may ever be built from it. Mirrors Code.gs. */
const REVOKED_TOKEN = 'off';

const DEFAULT_TEMPLATE =
  'Namaste {name} ji 🙏\n' +
  'Aapka {merchant} par {amount} ka hisaab baaki hai. ' +
  'Kripya jald bhugtan karein.\n' +
  'Apna pura hisaab yahan dekhein: {passbook}\n' +
  'Dhanyavaad!';
const DEFAULT_CREDIT_TEMPLATE =
  'Namaste {name} ji 🙏\n' +
  '{merchant} ke hisaab mein aapko {amount} milenge.\n' +
  'Apna pura hisaab yahan dekhein: {passbook}\n' +
  'Dhanyavaad!';

const BALANCE_SHARE_TIMEOUT_MS = 30000;
let balanceShareSession = null;
let balanceNativeBusy = false;
let passbookLoadGen = 0;

let config = loadJSON(LS_CONFIG) || null;
// the cached ledger: users + transactions, plus whatever the last `list`
// carried about the ledger itself (pin = salt+hash for offline PIN checks,
// sheetUrl). Both are v7 additions and are simply absent on older backends.
let db = loadJSON(LS_CACHE) || { users: [], transactions: [] };
let queue = loadQueue();
let failed = loadJSON(LS_FAILED) || [];   // writes the server refused (rolled back locally)
let authBad = false;                      // last list call failed on the key
let offline = false;                      // last network attempt failed
let currentCustomerId = null;
let editingTxnId = null;
let editingCustomerId = null;
let customerContactSession = null;
let customerContactRequest = null; // native picker cannot be aborted; prevent overlapping requests
let txnFormType = 'given';
let confirmArmed = null;
// bumped every time the ledger on this phone is replaced: anything in flight
// across that line belongs to the old khata and must not be applied here
let ledgerGen = 0;
let updateWaiting = false;                // a new app version is installed and waiting

// photo form state: mode 'none' | 'existing' | 'new' | 'removed'
let photoState = { mode: 'none', b64: null, id: null };
let photoFormGen = 0;     // a decoded image belongs only to the form that selected it
let photoProcessing = false;
let draftPhotos = [];
let originalDraftPhotos = [];
let replacingPhotoId = null;
let photoViewer = null;
let viewerGen = 0;
const PHOTO_QUEUE_BUDGET = 3 * 1024 * 1024;
const PHOTO_ACTIONS = new Set(['uploadTxnPhoto', 'removeTxnPhoto', 'restoreTxnPhoto']);
const isPhotoJob = (item) => PHOTO_ACTIONS.has(item.action);
const hasFinancialWrites = () => queue.some((item) => !isPhotoJob(item));
const multiPhotoSupported = () => !!(config && config.demo) || !!(db.capabilities && db.capabilities.multiPhoto);
const photoLimit = () => multiPhotoSupported() ? 5 : 1;
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

/* Every local id — a temporary row id or a queue item's identity — comes from
   here. Date.now() alone collides when two writes land in the same
   millisecond (a fast double tap, a retry loop), and two queue items sharing
   an id is exactly how the wrong entry gets removed. */
let idSeq = 0;
function nextId() { return Date.now().toString(36) + '-' + (++idSeq).toString(36); }
function tmpTxnId() { return 'tmp' + nextId(); }
function tmpUserId() { return 'tmpu' + nextId(); }

// A queue saved while an item was on the wire keeps that item's inflight flag;
// after a reload nothing is on the wire, so the flags start clean.
function loadQueue() {
  const items = loadJSON(LS_QUEUE) || [];
  items.forEach((item) => {
    delete item.inflight;
    if (!item.qid) item.qid = nextId();
  });
  return items;
}

// ---------------------------------------------------------------- dom

const $ = (id) => document.getElementById(id);
const screens = {
  connect: $('screen-connect'),
  home: $('screen-home'),
  customer: $('screen-customer'),
  passbook: $('screen-passbook'),
};

function show(name) {
  if (name !== 'passbook') { passbookLoadGen++; window.BahiPassbook?.cancel(); }
  if (name !== 'customer' && balanceShareSession) closeBalanceShare();
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

/* Overlapping calls (a queue drain under a photo fetch) each turn the bar on
   and off. A boolean lets whichever finishes first hide a bar the other one
   still needs, so it is a refcount. */
let busyN = 0;
function busy(on) {
  busyN = Math.max(0, busyN + (on ? 1 : -1));
  const el = $('busy');
  if (busyN > 0) topShow(el); else topHide(el);
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

/* Every call names the connection it is for. The global `config` is only ever
   the *committed* ledger: a candidate being validated is passed in here
   instead of being installed globally, so a write that happens mid-validation
   can never be addressed to a backend this phone has not agreed to yet
   (and the settings dialog can never persist a candidate). */
async function apiWith(cfg, action, payload, opts) {
  const probe = !!(opts && opts.probe);   // a candidate, not this phone's ledger
  if (cfg && cfg.demo) { setOffline(false); return demoApi(action, payload); }

  // Parsed before any fetch so a bad URL is distinguishable from a network
  // failure — one is fixed in Settings, the other by waiting (audit 0.6)
  let endpoint;
  try {
    endpoint = new URL(cfg.url);
  } catch (e) {
    const bad = configError('Backend URL galat hai — Settings me check karein');
    toast(bad.message, true);
    throw bad;
  }

  const controller = PHOTO_ACTIONS.has(action) ? new AbortController() : null;
  const deadline = controller ? setTimeout(() => controller.abort(), 30000) : null;
  busy(true);
  try {
    let res;
    if (action === 'list') {
      endpoint.searchParams.set('action', 'list');
      endpoint.searchParams.set('key', cfg.key);
      res = await fetch(endpoint.toString(), { signal: opts?.signal });
    } else {
      // text/plain keeps the request "simple" so Apps Script needs no CORS preflight
      res = await fetch(endpoint.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, key: cfg.key }, payload)),
        signal: opts?.signal || controller?.signal,
      });
    }
    // A reply that is not JSON is not a refusal: it is Google's sign-in page
    // in front of a wrongly-shared deployment. Rolling writes back on that
    // would empty the queue over something a re-share fixes.
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error('Server ne jawab galat bheja — deployment "Anyone" par set karein');
    }
    if (!json.ok) {
      const refused = new Error(json.error || 'Request failed');
      refused.rejected = true;   // the backend itself said no — the only rollback reason
      refused.code = json.code;
      throw refused;
    }
    setOffline(false);
    if (!probe && action === 'list') setAuthBad(false);
    return json.data;
  } catch (err) {
    if (err instanceof TypeError) setOffline(true);            // network failure
    else if (!probe && action === 'list' && isAuthError(err)) setAuthBad(true);
    throw err;
  } finally {
    if (deadline) clearTimeout(deadline);
    busy(false);
  }
}

function api(action, payload) { return apiWith(config, action, payload); }

function setOffline(off) { offline = !!off; updateChips(); }

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

/* An 8-hex id that happens to be all digits ('12345678') comes back from
   Sheets as a *Number*. Reads compare with String(), but the mutation paths
   (row tap, edit, delete) compare with === — and a number never equals the
   string in a data-attribute, so those rows quietly stop being editable.
   Ids become strings here, once, the moment they enter the app. */
function normalizeData(data) {
  const str = (v) => (v == null ? '' : String(v));
  const users = (data && data.users) || [];
  const transactions = (data && data.transactions) || [];
  users.forEach((u) => { u.user_id = str(u.user_id); });
  transactions.forEach((t) => { t.id = str(t.id); t.user_name = str(t.user_name); });
  const out = { users, transactions };
  /* v7 ledger facts. A pre-Suraksha backend omits both keys entirely, and the
     difference between "absent" and "null" is the whole feature detection:
     absent = this backend cannot do PINs (offer an update, no buttons),
     null = it can and none is set. Copied only when present, so `undefined`
     survives the round trip through the cache (JSON drops the key). */
  if (data && 'pin' in data) out.pin = data.pin;
  if (data && 'sheetUrl' in data) out.sheetUrl = data.sheetUrl;
  if (data && 'capabilities' in data) out.capabilities = data.capabilities;
  return out;
}

// A slow list answer must never overwrite a newer one (or a ledger that has
// been switched underneath it), so every refresh carries a token.
let refreshGen = 0;
async function refresh(silent) {
  if (connecting) return;                                 // a candidate is being validated
  if (hasFinancialWrites()) { render(); processQueue(); return; }
  const gen = ++refreshGen;
  const ledger = ledgerGen;
  try {
    const data = await api('list');
    // stale answer, another ledger, or a write made while we waited: keep local
    if (gen !== refreshGen || ledger !== ledgerGen || hasFinancialWrites()) { render(); return; }
    applyLedgerList(data);
  } catch (err) {
    if (!silent) toast('Could not sync: ' + err.message, true);
    render(); // fall back to cached copy
  }
}

function applyLedgerList(data) {
  const fresh = normalizeData(data);
  db = {
    users: keepLocalMeta(fresh.users), transactions: fresh.transactions,
    pin: fresh.pin, sheetUrl: fresh.sheetUrl, capabilities: fresh.capabilities,
  };
  const orphaned = queue.filter(j => isPhotoJob(j) && !isTmp(j.payload.id) &&
    !db.transactions.some(t => String(t.id) === String(j.payload.id)));
  if (orphaned.length) {
    try {
      commitQueue(queue.filter(j => !orphaned.includes(j)));
      toast('Entry removed on another device; its pending photos were cancelled.');
    } catch (err) { toast(err.message, true); }
  }
  saveCache();
  render();
}

// ---------------------------------------------------------------- offline write queue

function writeDurably(key, value) {
  try { saveJSON(key, value); return true; } catch (e) {
    // Only rebuildable caches may be evicted. Queue/failed/config are never
    // removed to make room, and image bytes are never silently discarded.
    [LS_CACHE, LS_THUMBS].forEach((k) => { try { localStorage.removeItem(k); } catch (ignored) { /* storage unavailable */ } });
    thumbs = {};
    try { saveJSON(key, value); return true; } catch (again) { return false; }
  }
}
function queuedPhotoBytes(items) {
  return items.reduce((sum, item) => sum + 2 * String(
    (item.payload && (item.payload.b64 || (item.payload.data && item.payload.data.photo))) || ''
  ).length, 0);
}
function commitQueue(candidate, checkBudget = false) {
  const before = queuedPhotoBytes(queue.concat(failed));
  const after = queuedPhotoBytes(candidate.concat(failed));
  if (checkBudget && after > PHOTO_QUEUE_BUDGET && after > before) {
    throw new Error('Photos exceed offline storage budget. Sync pending photos or remove some new photos.');
  }
  if (!writeDurably(LS_QUEUE, candidate)) {
    throw new Error('Phone storage is full. Sync pending work or remove new photos, then try again.');
  }
  queue = candidate;
  updateChips();
}
function saveQueue() {
  if (!writeDurably(LS_QUEUE, queue)) {
    toast('Queue could not be saved. Keep this app open and free phone storage.', true);
    return false;
  }
  updateChips();
  return true;
}

// The cached ledger must never take an entry down with it: on a full phone we
// free what we can, tell the merchant what was lost, and carry on (audit 0.5).
function saveCache() {
  try { saveJSON(LS_CACHE, db); } catch (e) { /* queue remains authoritative */ }
}

function saveFailed() {
  const ok = writeDurably(LS_FAILED, failed);
  if (!ok) toast('Failed work could not be saved. Free phone storage before closing the app.', true);
  updateChips();
  return ok;
}

function updateChips() {
  const pending = $('chip-pending');
  pending.hidden = queue.length === 0;
  pending.textContent = queue.length + ' pending';
  const photoCount = queue.filter(isPhotoJob).length;
  if (photoCount) pending.textContent = queue.filter((j) => !isPhotoJob(j)).length + ' entries · ' + photoCount + ' photos pending';

  const bad = $('chip-failed');
  bad.hidden = failed.length === 0;
  bad.textContent = failed.length + ' nahi bache';

  $('chip-auth').hidden = !authBad;
  // every chip is painted here, so nothing can leave one stuck on screen
  $('chip-offline').hidden = !offline;
  observeBalanceShare();
}

function makeWrite(action, payload, tmpId, undo) {
  const qid = nextId();
  if (action === 'addTxn' || action === 'addUser') payload = Object.assign({}, payload, { cid: payload.cid || qid });
  return { qid, action, payload, tmpId: tmpId || null,
    undo: undo || (tmpId ? { type: action, tmpId } : null), label: describeWrite(action, payload, undo) };
}

function enqueue(action, payload, tmpId, undo) {
  // Demo writes go straight to the local demo store — no queue, no chip
  if (config && config.demo) {
    api(action, payload).then(() => refresh(true));
    return true;
  }
  // Everything needed to undo the optimistic local change if the server
  // refuses this write: an add needs only its temporary id, an edit or delete
  // needs a pre-image of what it overwrote.
  const rollback = undo || (tmpId ? { type: action, tmpId } : null);
  const qid = nextId();   // identity: the queue is never touched by position
  /* …and, for the two writes that INSERT, the idempotency key the backend
     needs. A reply lost after the row was written looks exactly like a reply
     that never happened: the item stays queued and is sent again. Carrying
     the same id on every attempt lets a v8 backend answer the retry with the
     row it already made instead of a second one (and a second photo upload).
     Older backends ignore the field. It rides at the top level of the request,
     next to `action` and `key` — apiWith merges the payload in there. */
  if (action === 'addTxn' || action === 'addUser') {
    payload = Object.assign({}, payload, { cid: (payload && payload.cid) || qid });
  }
  const item = {
    qid,
    action,
    payload,
    tmpId: tmpId || null,
    undo: rollback,
    label: describeWrite(action, payload, rollback),   // named while the entity still exists
  };
  try { commitQueue(queue.concat(item), true); }
  catch (err) { toast(err.message, true); return false; }
  if (!connecting) processQueue();   // a candidate is being validated — wait
  return true;
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

// Remove a queue item by identity. Four other call sites rewrite the queue
// while an item is on the wire; shifting position 0 afterwards would throw
// away whatever slid into it — an unrelated, unsent entry.
function dropQueued(item) {
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  return at >= 0;
}

/* Did this refusal mean "that row is already gone"? Only a delete can be
   forgiven this way, and only on the messages Code.gs itself writes — error
   TEXT is not contract (ARCHITECTURE §3.5), so this matches their stable
   opening words and treats everything else as a real refusal. Backends from v8
   on answer such a delete with success and never reach here; this exists for
   the ones still out there. When in doubt we keep the old behavior: a wrongly
   forgiven delete is a lost write, and those are the ones the failed chip is
   for. */
function alreadyGone(action, message) {
  const msg = String(message || '');
  if (action === 'deleteTxn') return msg.startsWith('Error: Transaction not found') ||
    msg.startsWith('Transaction not found');
  if (action === 'deleteUser') return msg.startsWith('Error: Customer not found') ||
    msg.startsWith('Customer not found') || msg.startsWith('User not found') ||
    msg.startsWith('Error: User not found');
  return false;
}

let processing = false;
async function processQueue() {
  if (processing || connecting || !queue.length) return;
  processing = true;
  const attemptedPhotos = new Set();
  try {
    while (queue.length) {
      if (connecting) return;          // a ledger switch is being validated
      const item = queue.find((j) => !isPhotoJob(j)) || queue.find((j) =>
        isPhotoJob(j) && j.status !== 'failed' && !attemptedPhotos.has(j.qid) &&
        !isTmp(j.payload.id) && db.transactions.some((t) => String(t.id) === String(j.payload.id)) &&
        !failed.some((f) => f.qid && f.qid === j.dependsOn));
      if (!item) break;
      if (item.inflight) return;       // belt and braces: never send twice
      item.inflight = true;
      item.attempted = true;
      if (isPhotoJob(item)) attemptedPhotos.add(item.qid);
      const ledger = ledgerGen;        // the ledger this write belongs to
      let result;
      try {
        result = await apiWith(config, item.action, item.payload);
      } catch (err) {
        item.inflight = false;
        if (isPhotoJob(item)) {
          if (ledger !== ledgerGen) return;
          item.status = 'failed';
          item.error = err.message || 'Photo upload failed';
          if (isAuthError(err)) setAuthBad(true);
          if (!saveQueue()) return;
          render();
          continue; // a photo cannot roll back money or block another job
        }
        // Offline, a backend URL that needs fixing, or a reply that was not
        // JSON at all — keep queued, retry later. ONLY a backend that actually
        // said no gets rolled back.
        if (!err || !err.rejected) return;
        /* …except a delete whose row the sheet no longer has. That is not a
           refusal, it is our own delete arriving twice: the first attempt
           committed and only its answer was lost. Rolling it back would put a
           deleted entry back on the screen and park it in the failed list. A
           v8 backend answers such a delete with plain success; this is the
           softening for the older ones, which still throw. */
        if (alreadyGone(item.action, err.message)) {
          dropQueued(item);
          saveQueue();
          if (ledger !== ledgerGen) return;   // ledger swapped underneath: stop here
          continue;
        }
        // The server refused it (bad key, stale row, bad data). Drop it
        // so the queue can't jam, undo the optimistic local change, and park
        // it where the merchant can see it — a rejected write must never just
        // disappear while the ledger keeps showing it (audit 0.1).
        dropQueued(item);
        if (ledger !== ledgerGen) { saveQueue(); return; }   // ledger swapped: result is not ours
        rollbackWrite(item);
        failed.push({
          qid: item.qid,
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
      item.inflight = false;
      dropQueued(item);
      // The ledger was wiped or switched while this was on the wire: it landed
      // in the sheet it was meant for, but nothing here may be remapped to it.
      if (ledger !== ledgerGen) { saveQueue(); return; }
      if (isPhotoJob(item)) {
        const txn = db.transactions.find((t) => String(t.id) === String(item.payload.id));
        if (txn && result && result.photos) {
          txn.photos = result.photos;
          txn.photo = result.photos[0]?.fileId || '';
          draftPhotos.forEach((p) => {
            const ready = result.photos.find(x => x.id === p.id);
            if (ready && !p.isNew) Object.assign(p, ready, { b64: undefined, status: undefined, error: undefined });
          });
        }
        if (item.action === 'uploadTxnPhoto' && result?.attachment?.fileId && !result.cancelled) {
          const uri = 'data:image/jpeg;base64,' + item.payload.b64;
          photoCache[result.attachment.fileId] = uri;
          await idbPhotoPut(result.attachment.fileId, uri);
        }
        if (item.action === 'removeTxnPhoto') {
          queue = queue.filter((j) => !(isPhotoJob(j) && j.payload.id === item.payload.id &&
            j.payload.attachmentId === item.payload.attachmentId));
        }
        saveCache();
        if (!saveQueue()) return;
        render();
        continue;
      }
      /* The photo this write carried is already on this phone — it is the very
         file we just uploaded. Filing it under the id the sheet gave it means
         the ledger's thumbnail is built locally, instantly, with no network at
         all; otherwise the list would download the picture back from Drive
         before it could draw a 96px square of it. */
      await keepUploadedPhoto(item, result);
      // success — resolve temporary ids to server ids
      if (item.tmpId && result) {
        if (item.action === 'addUser') remapUserId(item.tmpId, result.user_id, result);
        if (item.action === 'addTxn') remapTxnId(item.tmpId, result.id);
      }
      if (item.action === 'deleteTxn' || item.action === 'deleteUser') {
        queue = queue.filter((j) => !isPhotoJob(j) ||
          (item.action === 'deleteTxn' ? String(j.payload.id) !== String(item.payload.id) :
            String(j.parentUserId) !== String(item.payload.id)));
      }
      if (!saveQueue()) return;
    }
    refresh(true); // fully drained — reconcile with the sheet
  } finally {
    processing = false;
  }
}

function retryPhotoJobs(attachmentId) {
  const candidate = queue.map((job) => isPhotoJob(job) && !job.inflight &&
    (!attachmentId || job.payload.attachmentId === attachmentId)
    ? { ...job, status: 'pending', error: '' } : job);
  try { commitQueue(candidate); } catch (err) { toast(err.message, true); return; }
  processQueue();
}

function canonicalPhotos(txn) {
  if (Array.isArray(txn?.photos)) return txn.photos.map((p) => ({ id: String(p.id), fileId: String(p.fileId) }));
  return txn?.photo && txn.photo !== 'pending' ? [{ id: String(txn.photo), fileId: String(txn.photo) }] : [];
}

function photosFor(txn) {
  const photos = canonicalPhotos(txn);
  queue.filter((j) => isPhotoJob(j) && String(j.payload.id) === String(txn.id)).forEach((j) => {
    const p = j.payload;
    if (j.action === 'removeTxnPhoto') {
      const at = photos.findIndex((x) => x.id === p.attachmentId);
      if (at >= 0) photos.splice(at, 1);
    } else {
      const photo = { id: p.attachmentId, fileId: '', b64: p.b64, status: j.status || 'pending',
        error: j.error || '', replacesId: p.replacesId || '', source: j.action };
      const at = photos.findIndex((x) => x.id === p.attachmentId || x.id === p.replacesId);
      if (at >= 0) photos.splice(at, 1, photo); else photos.push(photo);
    }
  });
  return photos;
}

function makePhotoJob(action, txnId, data, dependency, userId) {
  return { ...makeWrite(action, { id: txnId, ...data }), status: 'pending',
    dependsOn: dependency, parentUserId: userId };
}

function saveTransaction(payload) {
  const existing = editingTxnId && db.transactions.find((t) => String(t.id) === String(editingTxnId));
  if (editingTxnId && !existing) throw new Error('Yeh entry ab yahan nahi hai — band karke dobara kholein.');
  const txnId = existing ? existing.id : tmpTxnId();
  const candidate = queue.slice();
  const pendingAdd = existing && queuedAddFor(txnId);
  let moneyJob;
  if (pendingAdd) {
    const at = candidate.indexOf(pendingAdd);
    moneyJob = { ...pendingAdd, payload: { ...pendingAdd.payload, data: { ...pendingAdd.payload.data, ...payload } } };
    candidate[at] = moneyJob;
  } else {
    moneyJob = makeWrite(existing ? 'updateTxn' : 'addTxn',
      existing ? { id: txnId, data: payload } : { data: payload },
      existing ? null : txnId, existing ? { type: 'txn', txn: clone(existing) } : null);
    candidate.push(moneyJob);
  }
  if (multiPhotoSupported()) {
    originalDraftPhotos.forEach((old) => {
      const kept = draftPhotos.some((p) => p.id === old.id || p.replacesId === old.id);
      if (kept) return;
      const jobIndex = candidate.findIndex((j) => isPhotoJob(j) && j.payload.id === txnId && j.payload.attachmentId === old.id);
      const job = candidate[jobIndex];
      if (job && !job.attempted && !job.inflight) candidate.splice(jobIndex, 1);
      else candidate.push(makePhotoJob('removeTxnPhoto', txnId, { attachmentId: old.id }, moneyJob.qid, payload.user_id));
      if (old.replacesId) candidate.push(makePhotoJob('removeTxnPhoto', txnId,
        { attachmentId: old.replacesId }, moneyJob.qid, payload.user_id));
    });
    draftPhotos.filter((p) => p.isNew).forEach((p) => candidate.push(makePhotoJob(
      'uploadTxnPhoto', txnId, { attachmentId: p.id, b64: p.b64, replacesId: p.replacesId || '' },
      moneyJob.qid, payload.user_id)));
  }
  commitQueue(candidate, true); // must succeed before the optimistic entry is changed
  const local = { ...(existing || {}), id: txnId, user_name: payload.user_id, ...payload };
  if (!multiPhotoSupported()) local.photo = payload.photo ? 'pending' : payload.photo === '' ? '' : (existing?.photo || '');
  else { local.photos = canonicalPhotos(existing); local.photo = local.photos[0]?.fileId || ''; }
  if (existing) Object.assign(existing, local); else db.transactions.push(local);
  saveCache();
  render();
  saveReadback(payload);
  processQueue();
}

/* Seed both photo caches from a write that just synced: the bytes went up in
   this item's payload, the sheet answered with the file id they were stored
   under, and those two facts together are a fully warm cache. Only the two
   actions that can carry photo bytes qualify. */
async function keepUploadedPhoto(item, result) {
  const b64 = item.payload && item.payload.data && item.payload.data.photo;
  const id = result && result.photo;
  if (!b64 || !id) return;
  if (item.action !== 'addTxn' && item.action !== 'updateTxn') return;
  const uri = 'data:image/jpeg;base64,' + b64;   // compressImage always emits JPEG
  photoCache[id] = uri;
  await idbPhotoPut(id, uri);
}

function remapUserId(tmpId, realId, serverUser) {
  realId = String(realId);
  const u = db.users.find((x) => String(x.user_id) === String(tmpId));
  if (u) Object.assign(u, serverUser || {}, { user_id: realId });
  db.transactions.forEach((t) => { if (String(t.user_name) === String(tmpId)) t.user_name = realId; });
  // an open Edit dialog is still holding the temporary id: leave it there and
  // Save throws (the edit is lost silently) while Delete queues a dead id
  if (editingCustomerId === tmpId) editingCustomerId = realId;
  // failed items too: retrying a parked entry after its customer finally
  // landed must point at the real customer, not the dead temporary id
  queue.concat(failed).forEach((item) => {
    if (item.payload && item.payload.data && item.payload.data.user_id === tmpId) {
      item.payload.data.user_id = realId;
    }
    if (item.payload && item.payload.id === tmpId) item.payload.id = realId;
  });
  if (currentCustomerId === tmpId) currentCustomerId = realId;
  if (balanceShareSession?.customerId === tmpId && balanceShareSession.ledger === ledgerGen) {
    balanceShareSession.customerId = realId;
  }
  saveCache();
  saveQueue();
  saveFailed();
  render();
}

function remapTxnId(tmpId, realId) {
  realId = String(realId);
  const t = db.transactions.find((x) => String(x.id) === String(tmpId));
  if (t) t.id = realId;
  if (editingTxnId === tmpId) editingTxnId = realId;   // …same for an open entry
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
    const pending = {
      id: f.tmpId, user_name: d.user_id, date: d.date, type: d.type,
      amount: d.amount, comment: d.comment || '', photo: d.photo ? 'pending' : '',
    };
    const existing = db.transactions.find(t => String(t.id) === String(f.tmpId));
    if (existing) Object.assign(existing, pending); else db.transactions.push(pending);
  } else if (f.action === 'addUser') {
    if (!db.users.some(u => String(u.user_id) === String(f.tmpId))) db.users.push({
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
  const retryId = nextId();
  queue.forEach(j => { if (j.dependsOn && j.dependsOn === f.qid) j.dependsOn = retryId; });
  queue.push({
    qid: retryId,
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
  queue = queue.filter(j => !(isPhotoJob(j) && ((f.qid && j.dependsOn === f.qid) ||
    (f.tmpId && j.payload.id === f.tmpId))));
  saveQueue();
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

/* Find a queued "add" item that created this temporary id. An item that is
   already on the wire is deliberately NOT offered: the row it creates is
   about to exist in the sheet, so callers must take their "already gone
   upstream" branch and send a real write instead of editing the payload of a
   request that has left the phone. */
function queuedAddFor(tmpId) {
  const item = queue.find((x) => x.tmpId === tmpId);
  return item && !item.inflight && !item.attempted ? item : null;
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
  const demo = loadJSON(LS_DEMO) || demoSeed();
  demo._photoUploads ||= {};
  demo._removedPhotos ||= {};
  const id = () => Math.random().toString(16).slice(2, 10);
  let result;
  const txn = () => demo.transactions.find((t) => String(t.id) === String(payload.id));
  const setPhotos = (t, photos) => { t.photos = photos; t.photo = photos[0]?.fileId || ''; };
  const saveLegacyPhoto = (data, old) => {
    if (data.photo === undefined) return old;
    if (!data.photo) return old.slice(1);
    const fileId = 'dph' + id(); demoPhotos[fileId] = data.photo;
    return [{ id: fileId, fileId }].concat(old.slice(1));
  };
  switch (action) {
    case 'list': break;
    case 'photo': return Promise.resolve({ b64: demoPhotos[payload.id] || '', mime: 'image/jpeg' });
    case 'addUser': {
      result = { user_id: id(), name: payload.data.name, created_at: todayISO(),
        phone: payload.data.phone || '', token: '', _created: Date.now() };
      demo.users.push(result); break;
    }
    case 'updateUser': {
      const u = demo.users.find(x => x.user_id === payload.id);
      if (u) Object.assign(u, payload.data);
      break;
    }
    case 'deleteUser':
      demo.users = demo.users.filter(u => u.user_id !== payload.id);
      demo.transactions = demo.transactions.filter(t => t.user_name !== payload.id);
      break;
    case 'addTxn': {
      result = { id: id(), user_name: payload.data.user_id, ...payload.data };
      setPhotos(result, saveLegacyPhoto(payload.data, []));
      demo.transactions.push(result); break;
    }
    case 'updateTxn': {
      const t = txn();
      if (t) {
        const photos = saveLegacyPhoto(payload.data, canonicalPhotos(t));
        Object.assign(t, payload.data); setPhotos(t, photos); result = t;
      }
      break;
    }
    case 'deleteTxn': {
      const t = txn();
      if (t) demo._removedPhotos[t.id] = canonicalPhotos(t);
      demo.transactions = demo.transactions.filter(t => t.id !== payload.id);
      break;
    }
    case 'uploadTxnPhoto':
    case 'restoreTxnPhoto': {
      const t = txn();
      if (!t) throw new Error('Entry was removed');
      const existing = canonicalPhotos(t);
      let fileId = demo._photoUploads[payload.attachmentId];
      if (!fileId) {
        if (action === 'restoreTxnPhoto') {
          fileId = demo._removedPhotos[payload.sourceTxnId]?.find(p => p.id === payload.sourceAttachmentId)?.fileId;
          if (!fileId) throw new Error('Original photo is missing');
        } else {
          fileId = 'dph' + id(); demoPhotos[fileId] = payload.b64;
        }
        const at = payload.replacesId ? existing.findIndex(p => p.id === payload.replacesId) : -1;
        if (payload.replacesId && at < 0) throw new Error('Photo changed');
        if (at < 0 && existing.length >= 5) throw new Error('An entry can have up to five photos');
        existing.splice(at < 0 ? existing.length : at, at < 0 ? 0 : 1, { id: payload.attachmentId, fileId });
        setPhotos(t, existing); demo._photoUploads[payload.attachmentId] = fileId;
      }
      result = { attachment: { id: payload.attachmentId, fileId }, photos: canonicalPhotos(t) }; break;
    }
    case 'removeTxnPhoto': {
      const t = txn();
      if (t) setPhotos(t, canonicalPhotos(t).filter(p => p.id !== payload.attachmentId));
      result = { photos: t ? canonicalPhotos(t) : [] }; break;
    }
  }
  saveJSON(LS_DEMO, demo);
  return Promise.resolve(result || { users: demo.users, transactions: demo.transactions,
    v: 9, capabilities: { multiPhoto: true, maxPhotos: 5 } });
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
  // a sync can land while Settings is open (or right after it opened on a
  // cache older than this feature) — the PIN block must not go stale
  renderSuraksha();
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
  remind.hidden = !Number.isFinite(bal) || Math.round(Math.abs(bal) * 100) === 0;
  hint.hidden = true; // file sharing selects a recipient in the phone's share menu

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
      <div class="txn-cell ${side === 'gave' ? 'gave' : ''}">${side === 'gave' ? txnCell(t) : txnPhotoCell(t)}</div>
      <div class="txn-cell ${side === 'got' ? 'got' : ''}">${side === 'got' ? txnCell(t) : txnPhotoCell(t)}</div>
    </li>`;
  }).join('');

  $('cust-empty').hidden = txns.length > 0;
  loadLedgerThumbs();
}

function photoTile(photo, index, txnId, fromForm) {
  const uri = photo.b64 ? 'data:image/jpeg;base64,' + photo.b64 :
    (thumbs[photo.fileId]?.d || photoCache[photo.fileId] || '');
  const attrs = ' data-pid="' + escapeHtml(photo.fileId || '') + '"';
  const visual = uri ? '<img class="txn-thumb" src="' + uri + '" alt="Photo ' + (index + 1) + '"' + attrs + '>' :
    '<span class="txn-thumb txn-thumb-ph"' + attrs + '>📎</span>';
  return '<div class="photo-tile"><button type="button" data-photo-index="' + index + '"' +
    (fromForm ? ' data-from-form="1"' : ' data-txn-id="' + escapeHtml(txnId) + '"') +
    ' aria-label="View photo ' + (index + 1) + '">' + visual + '</button>' +
    (photo.status ? '<small class="' + (photo.status === 'failed' ? 'photo-error' : '') + '">' +
      (photo.status === 'failed' ? 'Not uploaded' : 'Pending') + '</small>' : '') +
    (photo.status === 'failed' ? '<button type="button" class="photo-retry" data-retry-photo="' +
      escapeHtml(photo.id) + '">Retry</button>' : '') + '</div>';
}

function txnCell(t) {
  return '<button type="button" class="txn-text"><span class="txn-amt">' + money(t.amount) + '</span>' +
    (t.comment ? '<span class="txn-note">' + escapeHtml(t.comment) + '</span>' : '') +
    '<span class="txn-date">' + fmtDate(t.date) + (t.photo === 'pending' ? ' 📎' : '') + '</span></button>';
}
function txnPhotoCell(t) {
  const photos = photosFor(t);
  return photos.length ? '<div class="photo-strip" aria-label="Entry photos">' +
    photos.map((p, i) => photoTile(p, i, t.id, false)).join('') + '</div>' : '';
}

let photoObserver = null;
const thumbTasks = [];
let thumbWorkers = 0;
function loadLedgerThumbs() {
  if (photoObserver) photoObserver.disconnect();
  if (connecting) return;
  const placeholders = [...document.querySelectorAll('#txn-list .txn-thumb-ph, #txn-photo-list .txn-thumb-ph')];
  const schedule = (el) => {
    const id = el.dataset.pid;
    if (!id || thumbs[id] || thumbLoading.has(id)) return;
    thumbLoading.add(id);
    thumbTasks.push({ id, ledger: ledgerGen });
    drainThumbs();
  };
  if (!window.IntersectionObserver) { placeholders.forEach(schedule); return; }
  photoObserver = new IntersectionObserver((entries) => {
    entries.filter(e => e.isIntersecting).forEach(e => { photoObserver.unobserve(e.target); schedule(e.target); });
  });
  placeholders.forEach(el => photoObserver.observe(el));
}
async function drainThumbs() {
  while (thumbWorkers < 2 && thumbTasks.length) {
    const task = thumbTasks.shift();
    thumbWorkers++;
    (async () => {
      const { id, ledger } = task;
      try {
        if (ledger !== ledgerGen) return;
        await fetchFullPhoto(id);
        if (ledger !== ledgerGen) return;
        thumbs[id] = { d: await makeThumb(photoCache[id]), t: Date.now() };
        saveThumbs();
        document.querySelectorAll('.txn-thumb-ph[data-pid="' + CSS.escape(id) + '"]').forEach((el) => {
          const img = document.createElement('img');
          img.className = 'txn-thumb'; img.dataset.pid = id;
          img.src = thumbs[id].d; img.alt = 'photo';
          el.replaceWith(img);
        });
      } catch (e) { /* keep a retryable placeholder */ }
      finally { thumbLoading.delete(task.id); thumbWorkers--; drainThumbs(); }
    })();
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
  closeBalanceShare();
  closeCustomerForm();
  currentCustomerId = null;
  show('home');
  renderHome();
}

function openCustomer(id, push) {
  if (String(currentCustomerId) !== String(id)) {
    closeBalanceShare();
    closeCustomerForm();
  }
  currentCustomerId = id;
  show('customer');
  renderCustomer();
  if (push !== false) history.pushState({ customer: id }, '');
}

// ---------------------------------------------------------------- invite & passbook links

// #s=… carries a merchant connection (URL + key). Fragment never reaches servers.
// Parsing is *all* this does: nothing in the link is believed until the backend
// has answered a real list call with it (audit 0.3).
// The fragment carries credentials (a full-access key, or a customer's
// passbook token). It leaves the address bar the moment it has been read —
// on every exit, including the ones that reject it, because a link that
// failed to parse still has the key sitting in it.
function stripHash() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function parseInviteLink() {
  const m = /#s=([A-Za-z0-9\-_]+)/.exec(location.hash);
  if (!m) return null;
  stripHash();
  let payload;
  try {
    payload = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return null; }
  if (!payload.u || !/^https:\/\/script\.google(?:usercontent)?\.com\//.test(payload.u)) return null;
  return { u: payload.u, k: payload.k || '' };
}

// One entry point for both link kinds, used at boot and again on every
// hashchange — a link tapped while the app is already open used to do nothing
// at all (the app only ever read the fragment once, at start-up).
function dispatchLink() {
  if (applyPassbookLink()) return true;
  const invite = parseInviteLink();
  if (invite) { openInvite(invite); return true; }
  return false;
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
  closeBalanceShare();
  closeCustomerForm();
  ledgerGen++;   // whatever is on the wire now belongs to the khata we are leaving
  resetPhotoControls();
  [LS_CACHE, LS_QUEUE, LS_FAILED, LS_DEMO, LS_THUMBS].forEach((k) => localStorage.removeItem(k));
  idbPhotosClear();
  db = { users: [], transactions: [] };
  queue = [];
  failed = [];
  thumbs = {};
  Object.keys(photoCache).forEach((k) => delete photoCache[k]);
  Object.keys(demoPhotos).forEach((k) => delete demoPhotos[k]);
  currentCustomerId = null;
  editingTxnId = null;
  editingCustomerId = null;
  // the grace window was bought with the OLD khata's PIN — it may not spend
  // itself on this one's first delete (the limiter is deliberately kept: it
  // counts guesses on this device, and a wipe is no reason to forgive them)
  pinOkUntil = 0;
  setOffline(false);   // the old ledger's last network state says nothing about this one
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
    creditTemplate: (prev && prev.creditTemplate) || DEFAULT_CREDIT_TEMPLATE,
  };
}

/* Ask the backend, with the candidate credentials, before anything is saved.
   The candidate is never installed as the global config to do it: while a
   list call is in flight the phone is still holding the OLD ledger's data,
   and every other write in that window (a queue drain, a refresh, an entry
   the merchant is saving right now) would be addressed to the new backend.
   The candidate travels as an argument, and the auth chip — which belongs to
   the ledger this phone actually has — is left alone either way. */
function validateConfig(candidate) {
  return apiWith(candidate, 'list', null, { probe: true });
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
  // Same rule as refresh(): unsynced writes are the truth until they drain,
  // so a key refresh must not blank the entries that are still waiting.
  if (!hasFinancialWrites()) {
    const fresh = normalizeData(data);
    db = {
      users: keepLocalMeta(fresh.users), transactions: fresh.transactions,
      pin: fresh.pin, sheetUrl: fresh.sheetUrl, capabilities: fresh.capabilities,
    };
    saveCache();
  }
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
  queue.filter(j => !isPhotoJob(j)).forEach(reapplyWrite);
  show('home');
  render();
  if (!opts || opts.sync !== false) refresh(true);
}

// The invite path. Every branch ends with the merchant on a screen that tells
// the truth about which khata this phone is holding.
async function openInvite(invite) {
  if (connecting) return;   // one validation at a time
  const prev = config;
  const prevReal = !!(prev && !prev.demo);
  const sameLedger = prevReal && prev.url === invite.u;
  if (sameLedger && (prev.key || '') === invite.k) { bootLedger(); return; }

  /* Same khata, new key. Nothing is at risk here: the unsynced writes were
     made in THIS ledger and the new key is exactly what will let them
     through. Warning about a "galat khata" would be a lie, and the only way
     past that warning threw the writes away — so this case skips the refusal
     entirely, adopts the key, and lets the queue drain with it. */
  if (sameLedger) { await runConnect(invite, prev); return; }

  // Unsynced writes belong to the ledger they were made in. Until they are
  // synced or explicitly thrown away, no other connection may touch this phone.
  const unsynced = queue.length + failed.length;
  if (prev && unsynced) { bootLedger(); askSwitch(invite, unsynced); return; }
  if (prevReal) { bootLedger(); askSwitch(invite, 0); return; }

  await runConnect(invite, prev);
}

async function runConnect(invite, prev) {
  if (connecting) return false;
  connecting = true;
  let ok = false;
  if (!prev) { show('connect'); connectNote('Ledger khul raha hai — thoda intezaar karein…'); }
  else bootLedger({ sync: false });   // keep the old ledger on screen, don't sync it mid-swap
  try {
    const sameLedger = await connectTo(invite);
    connectNote('');
    toast(sameLedger ? 'Nayi key lag gayi ✓' : 'Khata jud gaya ✓');
    ok = true;
  } catch (err) {
    if (!prev) {
      show('connect');
      connectNote('Yeh link kaam nahi kar raha — bhejne wale se naya link mangwayein', true);
    } else {
      bootLedger({ sync: false });   // old khata, untouched
      toast('Yeh link kaam nahi kar raha — purana khata waisa hi hai', true);
    }
  } finally {
    connecting = false;
  }
  // The window is shut: writes may move again (a key refresh exists precisely
  // so the queue can drain), and the ledger can finish painting its thumbs.
  render();
  if (queue.length) processQueue();
  else if (!ok) refresh(true);   // failed switch — the old khata still deserves a sync
  return ok;
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
  if (!/^#p(?:$|=|\d)/.test(location.hash)) return false;
  // Unlike the invite key, the passbook token stays in the URL: it is the
  // customer's only way back in on reload, and it is scoped + revocable.
  show('passbook');
  renderPassbook(location.hash);
  return true;
}

async function renderPassbook(hash) {
  const gen = ++passbookLoadGen;
  const active = () => gen === passbookLoadGen && !screens.passbook.hidden;
  const status = $('pb-status');
  // Clear before an async script load too: stale rows must never remain under
  // a different customer's link or on an invalid-link error.
  $('pb-name').textContent = $('pb-amt').textContent = '…';
  $('pb-word').textContent = '';
  $('pb-list').replaceChildren();
  status.hidden = false;
  status.textContent = 'Loading your passbook…';
  try {
    // New JS with an older cached HTML shell still supports legacy links.
    if (!window.BahiPassbook) await import(new URL('passbook.js', location.href).href);
    if (!active()) return;
    const payload = BahiPassbook.parseHash(hash, { allowDemo: true });
    let data;
    if (payload.d) {
      // Only ever an EXISTING demo on this device. Seeding one here would
      // fabricate a ledger — invented names and amounts — on the phone of
      // whoever opened the link (audit 0.3's other half).
      const demo = loadJSON(LS_DEMO);
      const u = demo && (demo.users || []).find((x) => String(x.user_id) === String(payload.d));
      if (!u) throw new Error('This passbook link is no longer valid.');
      data = {
        name: u.name,
        transactions: (demo.transactions || []).filter((t) => String(t.user_name) === String(payload.d)),
      };
    }
    await BahiPassbook.open(payload, { data, currency: (config && config.currency) || '₹', isActive: active });
  } catch (err) {
    if (!active()) return;
    if (window.BahiPassbook) BahiPassbook.showError(err.message);
    else status.textContent = 'The passbook could not load. Please refresh this page.';
  }
}

function passbookLink(u) {
  if (config && config.demo) {
    return location.origin + location.pathname + '#p=' + b64url({ d: u.user_id });
  }
  // no token yet (pre-v3 backend, or a queued tmp customer) — and a REVOKED
  // one is not a token at all: the passbook action refuses it, so offering the
  // link would hand out a dead link that reads as a working one.
  if (!u.token || String(u.token) === REVOKED_TOKEN) return '';
  const compact = window.BahiPassbook?.createLink(location.href, config.url, String(u.token));
  if (compact) return compact;
  // Keep the lossless legacy format for nonstandard backend URLs or a mixed
  // cached shell which has not loaded the new codec yet.
  return location.origin + location.pathname + '#p=' + b64url({ u: config.url, t: u.token });
}

// ---------------------------------------------------------------- reminders

function reminderMessage(u, bal) {
  const template = bal < 0 ? (config.creditTemplate || DEFAULT_CREDIT_TEMPLATE)
    : (config.template || DEFAULT_TEMPLATE);
  const merchant = (config && config.merchant) || 'hamari dukaan';
  const pb = config.demo ? '' : passbookLink(u); // demo passbooks only exist on this device
  const hasPassbook = template.includes('{passbook}');
  // Substitute once, literally: names/currency can contain $ or braces.
  // A revoked link removes its whole template line, as in the text-only flow.
  const source = !pb && hasPassbook
    ? template.split('\n').filter(line => !line.includes('{passbook}')).join('\n') : template;
  const values = { name: u.name, amount: money(bal), merchant, passbook: pb };
  let msg = source.replace(/\{(name|amount|merchant|passbook)\}/g, (_, key) => values[key]);
  if (!hasPassbook && pb) {
    msg += '\nApna pura hisaab: ' + pb;
  }
  return msg;
}

function reminderLink(u, bal) {
  return 'https://wa.me/' + normalizePhone(u.phone) + '?text=' + encodeURIComponent(reminderMessage(u, bal));
}

// ---------------------------------------------------------------- balance-card sharing

function balanceShareSignature() {
  const u = currentCustomer();
  return JSON.stringify([ledgerGen, currentCustomerId, config?.url, config?.key,
    config?.merchant, config?.currency, config?.cc, config?.template, config?.creditTemplate,
    u?.user_id, u?.name, u?.phone, u?.token, u ? balanceOf(u.user_id) : null]);
}
function balanceShareIsCurrent(s) {
  return s === balanceShareSession && $('dlg-balance-share').open && !connecting &&
    s.ledger === ledgerGen && String(s.customerId) === String(currentCustomerId) &&
    s.url === config?.url && s.key === config?.key;
}
function releaseBalanceCard(s) {
  if (s?.objectUrl) URL.revokeObjectURL(s.objectUrl);
  if (s) { s.objectUrl = null; s.file = null; }
}
function closeBalanceShare() {
  const s = balanceShareSession;
  balanceShareSession = null;
  if (s) { clearTimeout(s.timer); s.controller.abort(); releaseBalanceCard(s); }
  if (!$('dlg-balance-share')) return; // an installed app may still have the previous HTML shell
  $('balance-share-image').removeAttribute('src');
  $('balance-share-message').textContent = '';
  if ($('dlg-balance-share').open) $('dlg-balance-share').close();
}
function failBalanceShare(s, message) {
  if (s !== balanceShareSession) return;
  clearTimeout(s.timer); s.controller.abort(); releaseBalanceCard(s);
  s.phase = 'error'; s.status = message;
  $('balance-share-image').removeAttribute('src');
  $('balance-share-message').textContent = '';
  paintBalanceShare(s);
}
function observeBalanceShare() {
  const s = balanceShareSession;
  if (!s) return;
  if (!balanceShareIsCurrent(s)) { closeBalanceShare(); return; }
  const stamp = queue.filter(j => !isPhotoJob(j)).map(j => j.qid).join(',');
  if (stamp !== s.queueStamp) { s.queueStamp = stamp; s.financialRevision++; }
  if (s.phase === 'ready' && (hasFinancialWrites() || failed.some(j => !isPhotoJob(j)) ||
      (!config.demo && (offline || authBad || !navigator.onLine)) ||
      s.signature !== balanceShareSignature())) {
    failBalanceShare(s, 'Balance or account details changed. Retry sync and review the new card.');
  }
}
function paintBalanceShare(s) {
  if (s !== balanceShareSession) return;
  const ready = s.phase === 'ready';
  $('balance-share-status').textContent = s.status;
  $('balance-share-status').classList.toggle('error', s.phase === 'error' || !!s.imageError);
  $('balance-share-retry').hidden = s.phase !== 'error';
  $('balance-share-ready').hidden = !ready;
  $('balance-share-image').hidden = !ready || !s.objectUrl;
  if (s.objectUrl) $('balance-share-image').src = s.objectUrl;
  $('balance-share-message').textContent = ready ? s.snapshot.message : '';
  let canShareImage = false;
  try { canShareImage = !!(s.file && navigator.share && navigator.canShare?.({ files: [s.file] })); }
  catch (err) { /* native sharing is optional */ }
  s.canShareImage = canShareImage;
  $('balance-share-native').disabled = !ready || !canShareImage || balanceNativeBusy;
  $('balance-share-download').disabled = !ready || !s.file || balanceNativeBusy;
  $('balance-share-copy').disabled = !ready || balanceNativeBusy;
  $('balance-share-text').disabled = !ready || !s.snapshot?.phone || balanceNativeBusy;
  $('balance-share-help').textContent = (canShareImage
    ? 'Choose WhatsApp and the recipient in the share menu. If the message is omitted, use Copy message.'
    : 'Image sharing is unavailable here. Download the image and copy the message, or use Text only.') +
    (ready && !s.snapshot.phone ? ' Add a phone number to open the customer’s chat directly.' : '');
}
function readyBalanceShare() {
  observeBalanceShare();
  const s = balanceShareSession;
  return s?.phase === 'ready' && !balanceNativeBusy ? s : null;
}
function openBalanceShare() {
  if (!currentCustomer()) return;
  if (!$('dlg-balance-share')) {
    showUpdateBar();
    toast('Reload the new app version to use balance sharing.');
    return;
  }
  closeBalanceShare();
  const s = { ledger: ledgerGen, customerId: currentCustomerId, url: config.url, key: config.key,
    controller: new AbortController(), phase: 'loading', status: 'Syncing the ledger…',
    financialRevision: 0, queueStamp: queue.filter(j => !isPhotoJob(j)).map(j => j.qid).join(',') };
  balanceShareSession = s;
  showSheet($('dlg-balance-share'));
  paintBalanceShare(s);
  s.timer = setTimeout(() => failBalanceShare(s, 'Preparation timed out. Your queued work is kept; retry when connected.'), BALANCE_SHARE_TIMEOUT_MS);
  prepareBalanceShare(s);
}
async function prepareBalanceShare(s) {
  const assertCurrent = () => {
    if (!balanceShareIsCurrent(s) || s.phase !== 'loading') throw new Error('Sharing cancelled.');
  };
  try {
    assertCurrent();
    if (!config.demo && !navigator.onLine) throw new Error('Connect to the internet and retry sync before sharing.');
    if (failed.some(j => !isPhotoJob(j))) throw new Error('Resolve failed financial changes first: retry or discard them from the failed-work list.');
    if (hasFinancialWrites()) {
      processQueue().catch(() => {}); // the queue retains/reports its own failures
      while (hasFinancialWrites()) {
        await new Promise(resolve => setTimeout(resolve, 100));
        assertCurrent();
        if (failed.some(j => !isPhotoJob(j))) throw new Error('Resolve failed financial changes before sharing.');
        if (!processing && hasFinancialWrites()) throw new Error('Pending entries could not sync. Your work is kept; retry when connected.');
      }
    }
    assertCurrent();
    if (failed.some(j => !isPhotoJob(j))) throw new Error('Resolve failed financial changes before sharing.');
    const revision = s.financialRevision, signature = balanceShareSignature();
    ++refreshGen; // an earlier background list must not overwrite this snapshot
    const data = await apiWith(config, 'list', null, { signal: s.controller.signal });
    assertCurrent();
    if (!Array.isArray(data?.users) || !Array.isArray(data?.transactions)) throw new Error('The server returned an invalid ledger. Retry sync.');
    if (revision !== s.financialRevision || hasFinancialWrites() || failed.some(j => !isPhotoJob(j)) ||
        signature !== balanceShareSignature()) throw new Error('The ledger changed during sync. Retry and review the updated balance.');
    ++refreshGen;
    applyLedgerList(data);
    assertCurrent();
    const u = currentCustomer(), bal = balanceOf(u.user_id);
    if (!Number.isFinite(bal)) throw new Error('Balance could not be calculated. Check the ledger first.');
    if (Math.round(Math.abs(bal) * 100) === 0) {
      clearTimeout(s.timer); s.phase = 'settled'; s.status = 'No outstanding balance.';
      paintBalanceShare(s); return;
    }
    const now = new Date();
    const date = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
    s.snapshot = Object.freeze({ merchantName: config.merchant || 'hamari dukaan', customerName: u.name,
      amountText: money(bal), direction: bal > 0 ? 'due' : 'credit', asOfDate: date,
      message: reminderMessage(u, bal), phone: u.phone ? normalizePhone(u.phone) : '',
      filename: 'bahi-balance-' + todayISO() + '.png' });
    const exportedText = [s.snapshot.merchantName, s.snapshot.customerName, s.snapshot.message].join('\n');
    if (/#s=/.test(exportedText) || (config.key && exportedText.includes(config.key))) {
      throw new Error('Remove the owner invite link or API key from the message/account details before sharing.');
    }
    s.signature = balanceShareSignature();
    s.status = 'Preparing the image…'; paintBalanceShare(s);
    let blob;
    try {
      if (!window.BahiBalanceCard?.render) throw new Error('Image component is not loaded. Reload, or use Text only or Copy message.');
      blob = await window.BahiBalanceCard.render(s.snapshot);
    }
    catch (err) { s.imageError = err.message || 'Image creation failed. Use Text only or Copy message.'; }
    assertCurrent();
    if (s.signature !== balanceShareSignature() || revision !== s.financialRevision || hasFinancialWrites() ||
        failed.some(j => !isPhotoJob(j))) throw new Error('Balance or account details changed. Retry sync and review the new card.');
    if (blob) {
      s.file = new File([blob], s.snapshot.filename, { type: 'image/png' });
      s.objectUrl = URL.createObjectURL(s.file);
      $('balance-share-image').alt = `${s.snapshot.customerName}: ${s.snapshot.direction === 'due' ? 'Aapka baki' : 'Aapko milenge'} ${s.snapshot.amountText}. ${date}.`;
    }
    clearTimeout(s.timer);
    s.phase = 'ready';
    s.status = s.imageError || (config.demo ? 'Sample balance — no real account is being shared.' : 'Synced. Review the card and message before sharing.');
    paintBalanceShare(s);
    $('dlg-balance-share').querySelector('form').scrollTop = 0;
  } catch (err) {
    if (balanceShareIsCurrent(s) && s.phase === 'loading') failBalanceShare(s, 'Could not prepare balance: ' + err.message);
  }
}
async function shareBalanceNative() {
  const s = readyBalanceShare();
  if (!s?.file || !s.canShareImage) return;
  balanceNativeBusy = true; paintBalanceShare(s);
  try {
    // File is already prepared: preserve the button tap's user activation.
    await navigator.share({ files: [s.file], text: s.snapshot.message });
    // Completion means handoff, not that WhatsApp sent/delivered a message.
  } catch (err) {
    if (s === balanceShareSession && s.phase === 'ready' && err.name !== 'AbortError') {
      s.status = 'Could not open sharing. Try Download image, Copy message or Text only.';
    }
  } finally {
    balanceNativeBusy = false;
    if (balanceShareSession) { observeBalanceShare(); if (balanceShareSession) paintBalanceShare(balanceShareSession); }
  }
}

// ---------------------------------------------------------------- photos

function resetPhotoControls() {
  photoFormGen++;
  photoProcessing = false;
  replacingPhotoId = null;
  $('txn-photo').value = '';
  closeCamera();
  if ($('dlg-photo-source').open) $('dlg-photo-source').close();
  setPhotoUI();
}

function chooseGalleryPhoto() {
  if (photoProcessing || !$('dlg-txn').open) return;
  closeCamera();
  $('dlg-photo-source').close();
  // Stay in the button's user gesture: awaiting anything here can prevent
  // mobile browsers from opening the file picker.
  $('txn-photo').click();
}

async function handleTxnPhoto(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';     // choosing the same file again must still fire change
  return processTxnPhoto(files);
}

async function processTxnPhoto(file) {
  const files = Array.isArray(file) ? file : file ? [file] : [];
  if (!files.length || photoProcessing || !$('dlg-txn').open) return;
  if ((replacingPhotoId && files.length > 1) ||
      (multiPhotoSupported() && !replacingPhotoId && draftPhotos.length + files.length > photoLimit())) {
    toast('An entry can have up to ' + photoLimit() + ' photos. Choose fewer files.', true);
    return;
  }
  const form = photoFormGen;
  const ledger = ledgerGen;
  const customer = currentCustomerId;
  const stillCurrent = () => form === photoFormGen && ledger === ledgerGen &&
    customer === currentCustomerId && $('dlg-txn').open;
  photoProcessing = true;
  setPhotoUI();
  busy(true);
  try {
    const images = [];
    for (const selected of files) images.push(await compressImage(selected));
    if (stillCurrent()) {
      if (!multiPhotoSupported()) photoState = { mode: 'new', b64: images[0], id: photoState.id };
      else if (replacingPhotoId) {
        const at = draftPhotos.findIndex((p) => p.id === replacingPhotoId);
        if (at < 0) throw new Error('Photo changed; reopen the entry');
        const old = draftPhotos[at];
        draftPhotos[at] = old.isNew ? { ...old, b64: images[0] } :
          { id: crypto.randomUUID(), fileId: '', b64: images[0], isNew: true, replacesId: old.id };
      } else images.forEach((b64) => draftPhotos.push({ id: crypto.randomUUID(), fileId: '', b64, isNew: true }));
    }
  } catch (err) {
    if (stillCurrent()) toast(err.message, true);
  } finally {
    busy(false);
    if (form === photoFormGen) {
      photoProcessing = false;
      replacingPhotoId = null;
      setPhotoUI();
    }
  }
}

// Live capture is local. Only Use photo passes the reviewed frame into the
// same processing path as gallery selection; no file picker opens here.
let cameraSession = null;

function cameraIsCurrent(session) {
  return cameraSession === session && session.form === photoFormGen &&
    session.ledger === ledgerGen && session.customer === currentCustomerId &&
    $('dlg-txn').open && $('dlg-camera').open;
}

function stopCameraStream(session) {
  if (!session || !session.stream) return;
  const stream = session.stream;
  session.stream = null;
  stream.getTracks().forEach((track) => track.stop());
  if ($('camera-video').srcObject === stream) {
    $('camera-video').pause();
    $('camera-video').srcObject = null;
  }
}

function clearCameraSession() {
  const session = cameraSession;
  cameraSession = null; // invalidate permission/capture promises before cleanup
  stopCameraStream(session);
  if (session && session.shotUrl) URL.revokeObjectURL(session.shotUrl);
  $('camera-shot').removeAttribute('src');
}

function closeCamera() {
  clearCameraSession();
  if ($('dlg-camera').open) $('dlg-camera').close();
}

function cameraError(session, message) {
  if (!cameraIsCurrent(session)) return;
  session.phase = 'error';
  stopCameraStream(session);
  $('camera-status').textContent = message;
  $('camera-status').classList.add('err');
  $('camera-video').hidden = true;
  $('camera-capture').hidden = true;
  $('camera-retry').hidden = false;
  $('camera-gallery').hidden = false;
}

function cameraErrorMessage(err) {
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
    return 'Camera access is blocked. Allow it in your browser settings and try again, or choose from gallery.';
  }
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
    return 'No camera is available. Connect a camera and try again, or choose from gallery.';
  }
  return 'Camera could not start. Close any other app using it and try again, or choose from gallery.';
}

async function startCamera() {
  if (photoProcessing || !$('dlg-txn').open) return;
  $('dlg-photo-source').close();
  clearCameraSession();
  const session = {
    form: photoFormGen, ledger: ledgerGen, customer: currentCustomerId,
    stream: null, shot: null, shotUrl: null, phase: 'starting',
  };
  cameraSession = session;
  $('camera-status').textContent = 'Opening camera… Allow camera access if asked.';
  $('camera-status').classList.remove('err');
  $('camera-capture').hidden = false;
  $('camera-capture').disabled = true;
  ['camera-video', 'camera-shot', 'camera-retake', 'camera-use', 'camera-retry', 'camera-gallery']
    .forEach((id) => { $(id).hidden = true; });
  if (!$('dlg-camera').open) showSheet($('dlg-camera'));
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraError(session, 'Camera access is not available here. Open this page in a browser with camera support, or choose from gallery.');
    $('camera-retry').hidden = true;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    // A permission prompt may outlive Cancel, a ledger switch or a newer
    // attempt. Release a late stream without touching the new UI.
    if (!cameraIsCurrent(session)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
      if (session.phase === 'live') cameraError(session, 'Camera stopped. Try again or choose from gallery.');
    }));
    const video = $('camera-video');
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    if (!cameraIsCurrent(session)) return;
    if (!video.videoWidth || !video.videoHeight) throw new Error('Camera has no image');
    session.phase = 'live';
    $('camera-status').textContent = 'Point the camera at your bill, then tap Capture.';
    $('camera-capture').disabled = false;
  } catch (err) {
    cameraError(session, cameraErrorMessage(err));
  }
}

async function captureCameraPhoto() {
  const session = cameraSession;
  if (!session || !cameraIsCurrent(session) || session.phase !== 'live') return;
  const video = $('camera-video');
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  session.phase = 'capturing';
  $('camera-capture').disabled = true;
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const shot = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!cameraIsCurrent(session)) return;
    if (!shot) throw new Error('Empty capture');
    session.shot = shot;
    session.shotUrl = URL.createObjectURL(shot);
    session.phase = 'review';
    stopCameraStream(session); // the camera is off while reviewing the still
    $('camera-shot').src = session.shotUrl;
    $('camera-shot').hidden = false;
    $('camera-video').hidden = true;
    $('camera-status').textContent = 'Check that the bill is clear and readable.';
    $('camera-capture').hidden = true;
    $('camera-retake').hidden = false;
    $('camera-use').hidden = false;
  } catch (err) {
    cameraError(session, 'Could not capture a photo. Try again or choose from gallery.');
  }
}

function useCameraPhoto() {
  const session = cameraSession;
  if (!session || !cameraIsCurrent(session) || session.phase !== 'review') return;
  const shot = session.shot;
  closeCamera();
  processTxnPhoto(shot);
}

async function compressImage(file) {
  // createImageBitmap downsamples DURING decode (hardware path) — on a cheap
  // phone this is the difference between ~0.3s and several frozen seconds of
  // decoding a 12MP JPEG at full size just to throw the pixels away.
  const source = await decodeScaled(file, 1280);
  const shrink = (maxSide, quality) => {
    const s = Math.min(1, maxSide / Math.max(source.width, source.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(source.width * s));
    c.height = Math.max(1, Math.round(source.height * s));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  };
  let dataUri = shrink(1280, 0.72);
  if (dataUri.length > 1400000) dataUri = shrink(1024, 0.55);
  if (dataUri.length > 1400000) dataUri = shrink(800, 0.5);
  if (source.close) source.close();
  return dataUri.split(',')[1];
}

async function decodeScaled(file, maxSide) {
  if (window.createImageBitmap) {
    try {
      const probe = await createImageBitmap(file);
      if (Math.max(probe.width, probe.height) <= maxSide) return probe;
      const s = maxSide / Math.max(probe.width, probe.height);
      const scaled = await createImageBitmap(file, {
        resizeWidth: Math.max(1, Math.round(probe.width * s)),
        resizeHeight: Math.max(1, Math.round(probe.height * s)),
        resizeQuality: 'medium',
      });
      probe.close();
      return scaled;
    } catch (e) { /* fall through to <img> decode */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

function setPhotoUI() {
  const label = $('txn-photo-label');
  const view = $('txn-photo-view');
  const prev = $('txn-photo-prev');
  const emoji = $('txn-photo-emoji');
  // a fresh capture shows itself — the picture is the confirmation
  const showPrev = photoState.mode === 'new' && photoState.b64;
  prev.hidden = !showPrev;
  emoji.hidden = !!showPrev;
  prev.src = showPrev ? 'data:image/jpeg;base64,' + photoState.b64 : '';
  if (photoState.mode === 'new') {
    label.textContent = 'Badlein';
    view.hidden = false;
  } else if (photoState.mode === 'existing') {
    label.textContent = 'Change';
    view.hidden = false;
  } else {
    label.textContent = 'Add photo';
    view.hidden = true;
  }
  if (photoProcessing) label.textContent = 'Photo ban rahi hai…';
  ['txn-photo-add', 'txn-photo-view', 'txn-save', 'txn-delete'].forEach((id) => {
    $(id).disabled = photoProcessing;
  });
  const multi = multiPhotoSupported();
  $('txn-photo').multiple = multi && !replacingPhotoId;
  $('txn-photo-list').hidden = !multi || !draftPhotos.length;
  $('txn-photo-limit').hidden = multi || !!config?.demo;
  $('txn-photo-limit').textContent = 'One photo per entry. Update the backend to add up to five.';
  if (multi) {
    label.textContent = photoProcessing ? 'Photo ban rahi hai…' : 'Add photo';
    prev.hidden = true; emoji.hidden = false; view.hidden = true;
    $('txn-photo-add').disabled = photoProcessing || (draftPhotos.length >= photoLimit() && !replacingPhotoId);
    $('txn-photo-list').innerHTML = draftPhotos.map((p, i) => photoTile(p, i, '', true)).join('');
    loadLedgerThumbs();
  } else $('txn-photo-list').innerHTML = '';
}

// Removing a bill photo now lives in the viewer, behind a confirm — you have to
// be looking at the photo to throw it away (audit 1.2). Only the form flow may
// remove; a tap from the read-only ledger just looks.
async function viewCurrentPhoto() {
  if (multiPhotoSupported()) { if (draftPhotos.length) openPhotoCollection(draftPhotos, 0, true); return; }
  if (photoState.mode === 'new') {
    openPhotoCollection([{ id: 'draft', b64: photoState.b64 }], 0, true);
  } else if (photoState.mode === 'existing') {
    openPhotoCollection([{ id: photoState.id, fileId: photoState.id }], 0, true);
  }
}

function openPhotoCollection(photos, index, fromForm) {
  photoViewer = { photos, index, fromForm };
  openPhotoViewer(fromForm);
  showCollectionPhoto();
}

// Only a deliberate, single-finger horizontal stroke on the photo navigates.
// Native vertical scrolling and pinch zoom retain control (pointercancel),
// and a zoomed page uses normal panning instead of changing attachments.
let photoSwipe = null;
const photoIsZoomed = () => (window.visualViewport?.scale || 1) > 1.01;
function syncPhotoSwipe() {
  photoSwipe = null;
  const enabled = $('dlg-photo').open && photoViewer?.photos.length > 1 && !photoIsZoomed();
  $('photo-swipe-area').classList.toggle('swipe-enabled', !!enabled);
  $('photo-swipe-hint').hidden = !enabled;
}
function navigatePhoto(delta) {
  if (!photoViewer || !$('dlg-photo').open) return;
  const next = photoViewer.index + delta;
  if (next < 0 || next >= photoViewer.photos.length) return;
  photoViewer.index = next;
  showCollectionPhoto();
}
function startPhotoSwipe(e) {
  if (e.pointerType !== 'touch' || !e.isPrimary ||
      !$('photo-swipe-area').classList.contains('swipe-enabled')) return;
  photoSwipe = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp,
    viewer: photoViewer, index: photoViewer.index, ledger: ledgerGen,
    distance: Math.max(32, Math.min(72, $('photo-swipe-area').clientWidth * 0.15)) };
  $('photo-swipe-area').setPointerCapture(e.pointerId);
}
function movePhotoSwipe(e) {
  const g = photoSwipe;
  if (!g || g.id !== e.pointerId) return;
  const x = Math.abs(e.clientX - g.x), y = Math.abs(e.clientY - g.y);
  if (y > 12 && y > x) photoSwipe = null;
}
function endPhotoSwipe(e) {
  const g = photoSwipe;
  if (!g || g.id !== e.pointerId) return;
  photoSwipe = null;
  if (g.viewer !== photoViewer || g.index !== photoViewer.index ||
      g.ledger !== ledgerGen || photoIsZoomed() || e.timeStamp - g.at > 1000) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (Math.abs(dx) >= g.distance && Math.abs(dx) > Math.abs(dy) * 1.5) navigatePhoto(dx < 0 ? 1 : -1);
}
async function showCollectionPhoto() {
  syncPhotoSwipe();
  const viewer = photoViewer;
  if (!viewer) return;
  const p = viewer.photos[viewer.index];
  if (!p) { $('dlg-photo').close(); return; }
  const generation = ++viewerGen;
  $('photo-counter').textContent = (viewer.index + 1) + ' / ' + viewer.photos.length;
  $('photo-prev').hidden = $('photo-next').hidden = viewer.photos.length < 2;
  $('photo-prev').disabled = viewer.index === 0;
  $('photo-next').disabled = viewer.index === viewer.photos.length - 1;
  $('photo-replace').hidden = !viewer.fromForm;
  $('photo-replace').disabled = !!p.status && !p.isNew;
  $('photo-remove').hidden = !viewer.fromForm;
  $('photo-retry').hidden = p.status !== 'failed';
  $('photo-status').hidden = !p.status;
  $('photo-status').textContent = p.status === 'failed' ? (p.error || 'Photo not uploaded. Retry when ready.') : 'Photo upload pending';
  const img = $('photo-img');
  img.src = p.b64 ? 'data:image/jpeg;base64,' + p.b64 : photoCache[p.fileId] || thumbs[p.fileId]?.d || '';
  img.classList.toggle('photo-loading', !!p.fileId && !photoCache[p.fileId]);
  if (!p.fileId) return;
  try {
    await fetchFullPhoto(p.fileId);
    if (generation !== viewerGen || !$('dlg-photo').open) return;
    img.src = photoCache[p.fileId]; img.classList.remove('photo-loading');
  } catch (err) {
    if (generation === viewerGen) { $('photo-status').hidden = false; $('photo-status').textContent = err.message; }
  }
}

function openPhotoViewer(fromForm) {
  $('photo-remove').hidden = !fromForm;
  showSheet($('dlg-photo'));
}

async function viewPhotoById(id, fromForm) {
  const img = $('photo-img');
  // Open instantly: the 96px thumb (blurred up) is on-device; the full photo
  // sharpens in when it arrives. Waiting on a closed dialog reads as broken.
  const thumb = thumbs[id] && thumbs[id].d;
  img.src = photoCache[id] || thumb || '';
  img.classList.toggle('photo-loading', !photoCache[id]);
  openPhotoViewer(fromForm);
  if (photoCache[id]) return;
  try {
    await fetchFullPhoto(id);
    img.src = photoCache[id];
    img.classList.remove('photo-loading');
  } catch (err) {
    toast('Photo nahi khul payi: ' + err.message, true);
  }
}

// One path for full photos: memory → device store → network (persisting on
// the way through, so a photo fetched for ANY reason is durable on-device).
async function fetchFullPhoto(id) {
  const ledger = ledgerGen;
  if (photoCache[id]) return photoCache[id];
  const stored = await idbPhotoGet(id);
  if (ledger !== ledgerGen) throw new Error('Ledger changed');
  if (stored) { photoCache[id] = stored; return stored; }
  busy(true);
  try {
    const data = await api('photo', { id });
    if (ledger !== ledgerGen) throw new Error('Ledger changed');
    if (!data.b64) throw new Error('Photo not found');
    photoCache[id] = `data:${data.mime || 'image/jpeg'};base64,` + data.b64;
    await idbPhotoPut(id, photoCache[id]);
    return photoCache[id];
  } finally { busy(false); }
}

// ---------------------------------------------------------------- photo store (IndexedDB)
// Full-size photos persist on-device so repeat views are instant and work
// offline. LRU-capped; wiped with the rest of the ledger data on disconnect
// or switch (bill photos must not outlive the khata on a device).

const PHOTO_STORE_MAX = 30;

function idbPhotos() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('bahi-photos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbPhotoGet(id) {
  try {
    const db = await idbPhotos();
    return await new Promise((resolve) => {
      const req = db.transaction('photos').objectStore('photos').get(id);
      req.onsuccess = () => resolve(req.result ? req.result.d : null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}

async function idbPhotoPut(id, dataUri) {
  try {
    const db = await idbPhotos();
    const tx = db.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    store.put({ d: dataUri, t: Date.now() }, id);
    const keysReq = store.getAllKeys();
    const allReq = store.getAll();
    keysReq.onsuccess = () => allReq.onsuccess = () => {
      const keys = keysReq.result, rows = allReq.result;
      if (keys.length <= PHOTO_STORE_MAX) return;
      keys.map((k, i) => ({ k, t: rows[i].t }))
        .sort((a, b) => a.t - b.t)
        .slice(0, keys.length - PHOTO_STORE_MAX)
        .forEach(({ k }) => store.delete(k));
    };
    // resolve only once the write is durable — a reload right after viewing
    // must not outrun the commit
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
  } catch (e) { /* cache only — never block the view */ }
}

function idbPhotosClear() {
  try { indexedDB.deleteDatabase('bahi-photos'); } catch (e) { /* best effort */ }
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
  // "sync baaki" is about this write, not about the radio: navigator.onLine is
  // true on a captive wifi and true when the deployment itself is refusing.
  // The queue is the only thing that knows whether the sheet has it yet.
  const waiting = !(config && config.demo) && queue.length > 0;
  showToast(
    `${money(payload.amount)} ${got ? 'mila' : 'diya'} · ${first} — ${tail}` +
    (waiting ? ' · sync baaki' : ''),
    { tone: got ? 'got' : 'gave' }
  );
}

/* Undo after deleting an entry (audit 1.2). Two shapes, both cheap:
   - the delete is still sitting in the queue (or was only ever a queued add):
     drop that queue item and put the row back — no server call at all;
   - the queue already drained, or we are in demo mode where writes go through
     immediately: the sheet row is gone, so re-create it as a fresh addTxn.
   v9 restores attachments through the backend's Drive journal. Older backends
   can only re-upload the single photo when its bytes are still cached. */
function restoreTxn(pre) {
  if (!pre) return;
  if (!db.transactions.some((t) => String(t.id) === String(pre.id))) db.transactions.push(clone(pre));
  saveCache();
  render();
  toast('Entry wapas aa gayi');
}

async function readdTxn(pre, snapshot) {
  if (!pre) return;
  const tmpId = tmpTxnId();
  const data = {
    user_id: pre.user_name, date: isoOf(pre.date), type: pre.type,
    amount: pre.amount, comment: pre.comment || '',
  };
  if (multiPhotoSupported()) {
    const moneyJob = makeWrite('addTxn', { data }, tmpId);
    const jobs = (snapshot || canonicalPhotos(pre)).map((p) => makePhotoJob(
      p.fileId ? 'restoreTxnPhoto' : 'uploadTxnPhoto', tmpId,
      p.fileId ? { attachmentId: crypto.randomUUID(), sourceTxnId: pre.id, sourceAttachmentId: p.id } :
        { attachmentId: crypto.randomUUID(), b64: p.b64 },
      moneyJob.qid, pre.user_name));
    try { commitQueue(queue.concat(moneyJob, ...jobs), true); }
    catch (err) { toast(err.message, true); return; }
    db.transactions.push({ ...clone(pre), id: tmpId, photo: '', photos: [] });
    saveCache(); render(); toast('Entry restored — photos syncing');
    processQueue(); return;
  }
  // The server trashed the Drive file with the delete — but the ledger's
  // thumbnail loader put the full photo in the on-device store, so undo can
  // re-upload it as a fresh file. Only a never-viewed or LRU-evicted photo
  // is genuinely gone.
  let photoB64 = null;
  if (pre.photo && pre.photo !== 'pending') {
    try {
      const uri = photoCache[pre.photo] || await idbPhotoGet(pre.photo);
      if (uri) photoB64 = uri.split(',')[1];
    } catch (e) { /* fall through to the honest toast */ }
  }
  if (photoB64) data.photo = photoB64;
  db.transactions.push(Object.assign(clone(pre), { id: tmpId, photo: photoB64 ? 'pending' : '' }));
  saveCache();
  enqueue('addTxn', { data }, tmpId);
  render();
  toast(pre.photo && !photoB64 ? 'Entry wapas aa gayi — photo nahi aa payi' : 'Entry wapas aa gayi');
}

function deleteMultiEntry() {
  const id = editingTxnId;
  const pre = clone(db.transactions.find(t => String(t.id) === String(id)));
  if (!pre) { toast('Yeh entry ab yahan nahi hai', true); return; }
  const snapshot = photosFor(pre).map(p => ({ ...p }));
  const ledger = ledgerGen;
  const add = queuedAddFor(id);
  const dropped = add ? queue.filter(j => j === add || (isPhotoJob(j) && j.payload.id === id)) : [];
  const del = add ? null : makeWrite('deleteTxn', { id }, null, { type: 'txn', txn: pre });
  try { commitQueue(add ? queue.filter(j => !dropped.includes(j)) : queue.concat(del)); }
  catch (err) { toast(err.message, true); return; }
  db.transactions = db.transactions.filter(t => String(t.id) !== String(id));
  $('dlg-txn').close(); saveCache(); render();
  showToast('Entry hata di ·', { action: 'WAPAS LAYEIN', ms: 7000, onAction: () => {
    if (ledger !== ledgerGen) return;
    if (add || (queue.includes(del) && !del.attempted)) {
      try { commitQueue(add ? queue.concat(dropped) : queue.filter(j => j !== del)); }
      catch (err) { toast(err.message, true); return; }
      restoreTxn(pre); processQueue();
    } else readdTxn(pre, snapshot);
  } });
  processQueue();
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

// ---------------------------------------------------------------- PIN Suraksha

/* Two tiers, both owned by the merchant's own backend (Sprint 3):
   - the Master PIN lives only in their Script Properties. It authorizes
     setting/changing/removing the App PIN, is checked server-side, and is
     never returned by any action.
   - the App PIN is 4 digits, opt-in. The backend ships salt+hash in `list`,
     so every device sharing the ledger verifies it OFFLINE and the digits
     themselves never leave the phone they are typed on — not to the sheet,
     not to storage, not into a toast or a log line.

   Threat model: casual misuse on a shared shop phone (staff, family). Anyone
   who can read `list` can brute-force 10^4 hashes — this is a lock on a
   drawer, not a safe, and no string in this app may claim otherwise. */

const PIN_GRACE_MS = 2 * 60 * 1000;   // one correct PIN covers a short burst of work
const PIN_FAIL_LIMIT = 3;
const PIN_COOLDOWN_MS = 30000;        // doubles every round

// A pre-Suraksha backend omits `pin` from `list` entirely; a v7 one with no
// PIN set sends null. "Cannot" and "not switched on" are different answers.
function pinSupported() { return db.pin !== undefined; }
function pinConfigured() { return !!(db.pin && db.pin.salt && db.pin.hash); }

let pinOkUntil = 0;   // grace window; cleared when the app goes to the background

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Same recipe as Code.gs: sha256(salt + ':' + pin), lowercase hex.
async function pinMatches(pin) {
  if (!pinConfigured()) return false;
  return (await sha256Hex(db.pin.salt + ':' + pin)) === String(db.pin.hash).toLowerCase();
}

/* The limiter lives in localStorage so a reload cannot shake it off, and it
   holds counters only. 3 wrong in a row → a cooldown that doubles each round;
   one correct entry forgives the whole run. */
function pinLock() {
  const l = loadJSON(LS_PINLOCK);
  return (l && typeof l === 'object') ? l : { fails: 0, until: 0, round: 0 };
}
function pinLockLeft() { return Math.max(0, (pinLock().until || 0) - Date.now()); }

function pinPassed() {
  try { localStorage.removeItem(LS_PINLOCK); } catch (e) { /* nothing to forgive then */ }
  pinOkUntil = Date.now() + PIN_GRACE_MS;
}

function pinFailed() {
  const l = pinLock();
  l.fails = (l.fails || 0) + 1;
  if (l.fails >= PIN_FAIL_LIMIT) {
    l.round = (l.round || 0) + 1;
    l.fails = 0;
    l.until = Date.now() + PIN_COOLDOWN_MS * Math.pow(2, l.round - 1);
  }
  // A full phone must not hand out unlimited guesses, but it must not throw
  // into the pad either — the in-memory verdict below is still enforced.
  try { saveJSON(LS_PINLOCK, l); } catch (e) { /* best effort */ }
}

/* ---------- the pad ----------

   One promise per question. `check(value)` decides what a full entry means:
   return true to accept (the sheet closes and the promise resolves true), or
   a string to reject with that message — shake, clear the dots, stay open.
   The typed digits live in `pinEntry` and nowhere else. */

let pinAsk = null;    // the question on screen: {len, check, keep, resolve, busy}
let pinEntry = '';
let pinTimer = null;  // cooldown countdown

function askPin(opts) {
  return new Promise((resolve) => {
    const dlg = $('dlg-pin');
    pinAsk = { len: opts.len || 4, check: opts.check, keep: !!opts.keep, resolve, busy: false };
    pinEntry = '';
    $('pin-title').textContent = opts.title;
    const sub = $('pin-sub');
    sub.textContent = opts.sub || '';
    sub.hidden = !opts.sub;
    $('pin-forgot').hidden = !opts.forgot;
    pinError('');
    buildPinDots(pinAsk.len);
    paintPinDots();
    paintPinLock();
    /* A chained step re-arms the sheet that is already up. Closing and
       reopening it would replay the sheet animation between steps and, worse,
       race the previous close event against the new showModal(). */
    if (!dlg.open) showSheet(dlg);
  });
}

function buildPinDots(len) {
  $('pin-dots').innerHTML = new Array(len).fill('<span class="pin-dot"></span>').join('');
}

function paintPinDots() {
  const dots = $('pin-dots').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < pinEntry.length);
}

function shakePin() {
  const el = $('pin-dots');
  el.classList.remove('shake');
  void el.offsetWidth;   // reflow, so the animation actually starts over
  el.classList.add('shake');
}

function pinError(msg) {
  const el = $('pin-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* Cooldown: the grid goes dead and says when it comes back, ticking live so
   the wait is visibly finite. "PIN bhool gaye?" stays alive throughout — a
   locked-out owner still has to have a way in. */
function paintPinLock() {
  const left = pinLockLeft();
  const el = $('pin-lock');
  el.hidden = left <= 0;
  if (left > 0) el.textContent = 'Phir se koshish karein ' + Math.ceil(left / 1000) + 's mein';
  $('pin-grid').querySelectorAll('button').forEach((b) => { b.disabled = left > 0; });
  if (left > 0 && !pinTimer) pinTimer = setInterval(paintPinLock, 250);
  if (left <= 0 && pinTimer) { clearInterval(pinTimer); pinTimer = null; }
}

function pinKey(k) {
  if (!pinAsk || pinAsk.busy || pinLockLeft() > 0) return;
  if (k === 'back') { pinEntry = pinEntry.slice(0, -1); paintPinDots(); return; }
  if (pinEntry.length >= pinAsk.len) return;
  pinEntry += k;
  pinError('');
  paintPinDots();
  if (pinEntry.length === pinAsk.len) submitPin();   // no OK button: full is done
}

async function submitPin() {
  const ask = pinAsk;
  ask.busy = true;
  let verdict;
  try { verdict = await ask.check(pinEntry); }
  catch (err) { verdict = (err && err.message) || 'Kuch galat ho gaya'; }
  if (pinAsk !== ask) return;   // closed, or re-armed, while we were checking
  ask.busy = false;
  if (verdict === true) {
    pinAsk = null;              // the close event below now has nothing to reject
    pinEntry = '';
    if (!ask.keep) $('dlg-pin').close();
    ask.resolve(true);
    return;
  }
  pinEntry = '';
  paintPinDots();
  shakePin();
  pinError(typeof verdict === 'string' && verdict ? verdict : 'PIN galat hai');
  paintPinLock();
}

function closePinAsk() {
  const ask = pinAsk;
  pinAsk = null;
  pinEntry = '';
  if (pinTimer) { clearInterval(pinTimer); pinTimer = null; }
  if (ask) ask.resolve(false);
}

/* ---------- gates ---------- */

/* The one thing every gated action asks. True = go ahead: no PIN is
   configured, we are still inside the grace window, or the merchant just
   typed the right one. A cancel is false, never a rejection. */
function requirePin(label) {
  if (!pinConfigured()) return Promise.resolve(true);
  if (Date.now() < pinOkUntil) return Promise.resolve(true);
  return askPin({
    title: label,
    len: 4,
    forgot: true,
    check: async (value) => {
      if (!(await pinMatches(value))) { pinFailed(); return 'PIN galat hai'; }
      pinPassed();
      return true;
    },
  });
}

/* Destructive owner-level actions run through here. With an App PIN configured
   the PIN *replaces* the double-tap; with no PIN the call site's own
   armConfirm decides, exactly as it did before Suraksha. Existing-entry edits
   use requirePin() at the earlier boundary where their sheet is opened. */
function gated(label, arm, fn) {
  if (!pinConfigured()) { if (arm()) fn(); return; }
  requirePin(label).then((ok) => { if (ok) fn(); });
}

/* ---------- set / change / remove ---------- */

/* The salt is minted server-side, so the only way to learn the new PIN state
   is to ask. refresh() is the normal path but it deliberately stands down
   while unsynced writes exist — and the PIN state has to land either way. */
async function syncPinState() {
  const ledger = ledgerGen;
  const data = await api('list');
  if (ledger !== ledgerGen) return;   // another khata now — not ours to apply
  db.pin = data.pin;
  db.sheetUrl = data.sheetUrl;
  saveCache();
}

/* Master PIN first, then the new PIN twice — a typo here locks the whole shop
   out of its own delete button. Both values live in this closure and die with
   it. This is the one PIN path that needs the network: the Master PIN is only
   ever checked by the merchant's own backend. */
async function runPinFlow(kind) {   // 'set' | 'change' | 'remove'
  const removing = kind === 'remove';
  let master = '';
  const gotMaster = await askPin({
    title: removing ? 'PIN hatane ke liye Master PIN' : 'Master PIN daalein',
    sub: 'Apps Script → Script Properties me milega',
    len: 6,
    keep: !removing,
    check: (value) => { master = value; return true; },
  });
  if (!gotMaster) return;

  let fresh = '';
  if (!removing) {
    const first = await askPin({
      title: 'Naya App PIN', sub: '4 ank', len: 4, keep: true,
      check: (value) => { fresh = value; return true; },
    });
    if (!first) return;
    const again = await askPin({
      title: 'Naya PIN dobara daalein', len: 4,
      check: (value) => (value === fresh ? true : 'Dono PIN alag hain — dobara koshish karein'),
    });
    if (!again) return;
  }

  try {
    await api('setTxnPin', { admin: master, pin: removing ? '' : fresh });
  } catch (err) {
    /* Branch on WHICH failure, never on its words. A dead network is not a
       wrong Master PIN, and the backend's message is not ours to parse. */
    if (err instanceof TypeError) toast('Internet chahiye — PIN badalne ke liye', true);
    else if (err.rejected) toast('Master PIN galat hai — Apps Script → Script Properties me milega', true);
    else toast('PIN nahi badla: ' + err.message, true);
    return;
  }
  pinOkUntil = 0;   // a changed PIN starts a fresh window, never inherits one
  try { localStorage.removeItem(LS_PINLOCK); } catch (e) { /* best effort */ }
  try { await syncPinState(); } catch (e) { /* the sheet has it; this device catches up on the next sync */ }
  renderSuraksha();
  toast(removing ? 'App PIN hata diya' : 'App PIN lag gaya ✓');
}

/* The Settings block. Three honest states: this backend cannot do PINs yet,
   it can and none is set, or one is set. */
function renderSuraksha() {
  const demo = !!(config && config.demo);
  const supported = pinSupported();
  const on = pinConfigured();

  // the demo has no backend to hold a Master PIN — nothing here can work
  $('suraksha').hidden = demo;
  const note = $('suraksha-note');
  note.className = 'suraksha-note' + (supported ? '' : ' off');
  note.textContent = !supported
    ? 'Backend update chahiye — PIN ke liye'
    : on
      ? 'App PIN laga hai ✓'
      : 'Delete jaise kaam PIN ke bina nahi honge — shared phone ke liye.';
  $('btn-pin-set').hidden = !supported || on;
  $('btn-pin-change').hidden = !supported || !on;
  $('btn-pin-remove').hidden = !supported || !on;

  const sheet = $('btn-sheet');
  const url = (!demo && db.sheetUrl) || '';
  sheet.hidden = !url;
  if (url) sheet.href = url;
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
    config = { demo: true, currency: '₹', cc: '91', merchant: 'Demo General Store',
      template: DEFAULT_TEMPLATE, creditTemplate: DEFAULT_CREDIT_TEMPLATE };
    saveJSON(LS_CONFIG, config);
    refresh(true);
    show('home');
    toast('Demo ledger — sample data, edits stay on this device');
  });

  // home
  $('search').addEventListener('input', renderHome);
  $('btn-refresh').addEventListener('click', () => refresh());
  $('chip-pending').addEventListener('click', () => { toast('Retrying sync…'); retryPhotoJobs(); });
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
    if (!drop) { await runConnect(invite, config); return; }

    /* Explicit discard — the only way past unsynced writes. The writes are
       NOT thrown away first: a link that turns out not to work would have
       destroyed them for nothing. They are held, the connection is proved,
       and only a successful switch drops them (the wipe usually does it; a
       same-ledger switch needs their optimistic rows undone by hand so the
       cache stops showing entries the sheet has never heard of). */
    const dropped = queue.concat(failed);
    const ok = await runConnect(invite, config);
    if (!ok) return;                              // link failed: the stash is untouched
    if (!queue.length && !failed.length) return;  // the wipe already took them
    queue = [];
    failed = [];
    dropped.reverse().forEach(rollbackWrite);
    saveQueue();
    saveFailed();
    saveCache();
    render();
  });
  $('switch-sync').addEventListener('click', () => {
    $('dlg-switch').close();
    toast('Pehle purani entry sync karein, phir link dobara kholein');
    processQueue();
  });
  $('dlg-switch').addEventListener('close', () => { pendingInvite = null; });

  // PIN pad
  $('pin-grid').addEventListener('click', (e) => {
    const key = e.target.closest('.pin-key');
    if (key && key.dataset.k) pinKey(key.dataset.k);
  });
  // typing works too (a phone with a keyboard, and every desktop)
  $('dlg-pin').addEventListener('keydown', (e) => {
    if (!pinAsk) return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinKey(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); pinKey('back'); }
  });
  // Cancel, Esc and the backdrop all land here: the question is answered "no".
  $('dlg-pin').addEventListener('close', () => {
    // a close event left over from a step that has already re-opened the sheet
    if ($('dlg-pin').open) return;
    closePinAsk();
  });
  /* Forgotten PIN: the App PIN cannot be recovered, only replaced — and only
     with the Master PIN. The gated action is abandoned (answered "no"); the
     reset flow opens in its place. */
  $('pin-forgot').addEventListener('click', () => {
    closePinAsk();
    $('dlg-pin').close();
    runPinFlow('change');
  });

  // settings
  $('btn-pin-set').addEventListener('click', () => runPinFlow('set'));
  $('btn-pin-change').addEventListener('click', () => runPinFlow('change'));
  $('btn-pin-remove').addEventListener('click', () => runPinFlow('remove'));
  $('btn-settings').addEventListener('click', () => {
    $('set-merchant').value = config.merchant || '';
    $('set-currency').value = config.currency || '₹';
    $('set-cc').value = config.cc || '91';
    $('set-template').value = config.template || DEFAULT_TEMPLATE;
    if ($('set-credit-template')) $('set-credit-template').value = config.creditTemplate || DEFAULT_CREDIT_TEMPLATE;
    $('set-url').value = config.url || '';
    $('set-key').value = config.key || '';
    const conn = document.querySelector('.settings-conn');
    conn.open = false;
    // Demo has no connection to edit — the fields used to be there and their
    // Save was silently ignored. The one real action is offered instead.
    conn.hidden = !!config.demo;
    $('settings-demo').hidden = !config.demo;
    $('invite-wrap').hidden = !!config.demo || !config.url;
    renderSuraksha();
    showSheet($('dlg-settings'));
  });
  /* Gate 6 — the Connection section holds the URL, the key and Disconnect:
     opening it is itself an owner-level act. The <details> toggle is
     intercepted rather than replaced, so with no PIN it behaves exactly as it
     always did (and closing it never asks). */
  document.querySelector('.settings-conn summary').addEventListener('click', (e) => {
    const conn = document.querySelector('.settings-conn');
    if (conn.open || !pinConfigured()) return;
    e.preventDefault();
    requirePin('Connection kholne ke liye PIN').then((ok) => { if (ok) conn.open = true; });
  });
  // Leave the demo without destroying it: the sample khata stays on the phone
  // so "Try the demo" comes back to the same numbers.
  $('btn-leave-demo').addEventListener('click', () => {
    closeBalanceShare();
    $('dlg-settings').close();
    [LS_CONFIG, LS_CACHE, LS_QUEUE, LS_FAILED, LS_THUMBS].forEach((k) => localStorage.removeItem(k));
    idbPhotosClear();
    config = null;
    db = { users: [], transactions: [] };
    queue = [];
    failed = [];
    currentCustomerId = null;
    render();
    connectNote('');
    $('connect-error').hidden = true;
    $('cfg-url').value = '';
    $('cfg-key').value = '';
    show('connect');
  });
  // The dangerous link. The warning lands on the *first* tap — before the copy
  // exists — not as a 3.2s toast after it is already in the clipboard (1.1).
  $('btn-invite').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    gated('Link copy karne ke liye PIN',
      () => armConfirm(btn, 'invite-copy',
        'Is link se poora khata khul jayega — sirf apne bharose walon ko bhejein'),
      () => {
        copyText(inviteLink())
          .then(() => toast('Link copy ho gaya — sirf bharose wale ko bhejein'))
          .catch(() => toast('Copy nahi ho paya', true));
      });
  });
  $('form-settings').addEventListener('submit', () => {
    config.merchant = $('set-merchant').value.trim();
    config.currency = $('set-currency').value.trim() || '₹';
    config.cc = $('set-cc').value.replace(/\D/g, '') || '91';
    config.template = $('set-template').value || DEFAULT_TEMPLATE;
    if ($('set-credit-template')) config.creditTemplate = $('set-credit-template').value || DEFAULT_CREDIT_TEMPLATE;
    /* Editing the URL or the key here IS switching ledgers — it was the one
       door into a different khata with no validation, no confirm, no wipe,
       and it drained this khata's queue into the other sheet. It goes through
       exactly the same guard as an invite link now. */
    let switchTo = null;
    if (!config.demo) {
      const url = $('set-url').value.trim();
      const key = $('set-key').value.trim();
      if (url !== (config.url || '') || key !== (config.key || '')) switchTo = { u: url, k: key };
    }
    saveJSON(LS_CONFIG, config);   // preferences only — never the new credentials
    render();
    if (!switchTo) { toast('Settings saved'); return; }
    if (connecting) {   // another connection is already being checked
      toast('Ek connection pehle se check ho raha hai — thodi der baad', true);
      return;
    }
    // after this dialog has actually closed (method="dialog" closes it for us)
    setTimeout(() => openInvite(switchTo), 0);
  });
  $('btn-disconnect').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    gated('Device hatane ke liye PIN', () => armConfirm(btn, 'disconnect'), () => {
      const unsynced = queue.length + failed.length;
      if (unsynced && !window.confirm(unsynced + ' unsynced change(s) will be lost. Disconnect anyway?')) return;
      // thumbs are bill photos — a "cleared" device must not keep them (audit 0.9)
      [LS_CONFIG, LS_CACHE, LS_DEMO, LS_QUEUE, LS_FAILED, LS_THUMBS]
        .forEach((k) => localStorage.removeItem(k));
      location.reload();
    });
  });

  // customer screen
  $('btn-back').addEventListener('click', () => history.back());
  window.addEventListener('popstate', (e) => {
    closeCamera();
    if (e.state && e.state.customer) openCustomer(e.state.customer, false);
    else goHome();
  });
  $('cust-head-main').addEventListener('click', () => openCustomerForm(currentCustomerId));
  $('btn-remind').addEventListener('click', openBalanceShare);
  $('balance-share-retry')?.addEventListener('click', openBalanceShare);
  $('balance-share-native')?.addEventListener('click', shareBalanceNative);
  $('balance-share-copy')?.addEventListener('click', () => {
    const s = readyBalanceShare();
    if (!s) return;
    copyText(s.snapshot.message).then(() => {
      if (s === balanceShareSession) toast('Message copied — paste it in your chat.');
    }).catch(() => { if (s === balanceShareSession) toast('Could not copy. Select the message text and copy it manually.', true); });
  });
  $('balance-share-text')?.addEventListener('click', () => {
    const s = readyBalanceShare();
    if (s?.snapshot.phone) window.open('https://wa.me/' + s.snapshot.phone + '?text=' +
      encodeURIComponent(s.snapshot.message), '_blank', 'noopener,noreferrer');
  });
  $('balance-share-download')?.addEventListener('click', () => {
    const s = readyBalanceShare();
    if (!s?.objectUrl) return;
    const a = document.createElement('a');
    a.href = s.objectUrl; a.download = s.snapshot.filename;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $('dlg-balance-share')?.addEventListener('cancel', closeBalanceShare);
  $('dlg-balance-share')?.addEventListener('close', () => {
    if (!$('dlg-balance-share').open) closeBalanceShare();
  });
  $('btn-gave').addEventListener('click', () => openTxnForm('given', null));
  $('btn-got').addEventListener('click', () => openTxnForm('received', null));
  $('txn-list').addEventListener('click', (e) => {
    const retry = e.target.closest('[data-retry-photo]');
    if (retry) { retryPhotoJobs(retry.dataset.retryPhoto); return; }
    const row = e.target.closest('.txn-row');
    if (!row) return;
    const t = db.transactions.find((x) => String(x.id) === String(row.dataset.id));
    const photo = e.target.closest('[data-photo-index]');
    if (t && photo) { openPhotoCollection(photosFor(t), Number(photo.dataset.photoIndex), false); return; }
    if (t && e.target.closest('.txn-text')) openExistingTxn(t);
  });

  // txn photo controls
  $('txn-photo-add').addEventListener('click', () => {
    replacingPhotoId = null;
    $('txn-photo').multiple = multiPhotoSupported();
    $('photo-source-title').textContent = !multiPhotoSupported() && (photoState.mode === 'new' || photoState.mode === 'existing')
      ? 'Change photo' : 'Add photo';
    showSheet($('dlg-photo-source'));
  });
  $('photo-take').addEventListener('click', startCamera);
  $('photo-choose').addEventListener('click', chooseGalleryPhoto);
  $('txn-photo').addEventListener('change', handleTxnPhoto);
  $('camera-capture').addEventListener('click', captureCameraPhoto);
  $('camera-retake').addEventListener('click', startCamera);
  $('camera-use').addEventListener('click', useCameraPhoto);
  $('camera-retry').addEventListener('click', startCamera);
  $('camera-gallery').addEventListener('click', chooseGalleryPhoto);
  $('camera-cancel').addEventListener('click', closeCamera);
  $('dlg-camera').addEventListener('cancel', clearCameraSession);
  $('dlg-camera').addEventListener('close', () => {
    if (!$('dlg-camera').open) clearCameraSession();
  });
  $('txn-photo-view').addEventListener('click', viewCurrentPhoto);
  $('txn-photo-list').addEventListener('click', (e) => {
    const retry = e.target.closest('[data-retry-photo]');
    if (retry) { retryPhotoJobs(retry.dataset.retryPhoto); return; }
    const tile = e.target.closest('[data-photo-index]');
    if (tile) openPhotoCollection(draftPhotos, Number(tile.dataset.photoIndex), true);
  });
  $('photo-prev').addEventListener('click', () => navigatePhoto(-1));
  $('photo-next').addEventListener('click', () => navigatePhoto(1));
  $('photo-swipe-area').addEventListener('pointerdown', startPhotoSwipe, { passive: true });
  $('photo-swipe-area').addEventListener('pointermove', movePhotoSwipe, { passive: true });
  $('photo-swipe-area').addEventListener('pointerup', endPhotoSwipe, { passive: true });
  $('photo-swipe-area').addEventListener('lostpointercapture', () => { photoSwipe = null; });
  // Also cancel when a second finger lands outside the image, e.g. on a control.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !e.isPrimary) photoSwipe = null;
  }, { capture: true, passive: true });
  document.addEventListener('pointercancel', () => { photoSwipe = null; }, { passive: true });
  window.visualViewport?.addEventListener('resize', syncPhotoSwipe);
  window.addEventListener('pagehide', () => { photoSwipe = null; });
  document.addEventListener('visibilitychange', () => { photoSwipe = null; });
  $('dlg-photo').addEventListener('cancel', () => { photoSwipe = null; });
  $('dlg-photo').addEventListener('close', () => {
    if ($('dlg-photo').open) return; // a newer viewer may already be open
    photoViewer = null;
    viewerGen++;
    syncPhotoSwipe();
  });
  $('photo-retry').addEventListener('click', () => {
    const p = photoViewer.photos[photoViewer.index];
    $('dlg-photo').close(); retryPhotoJobs(p.id);
  });
  $('photo-replace').addEventListener('click', () => {
    replacingPhotoId = multiPhotoSupported() ? photoViewer.photos[photoViewer.index].id : null;
    $('txn-photo').multiple = false;
    $('dlg-photo').close();
    $('photo-source-title').textContent = 'Replace photo';
    showSheet($('dlg-photo-source'));
  });
  $('photo-remove').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    gated('Photo hatane ke liye PIN', () => armConfirm(btn, 'del-photo'), () => {
      if (multiPhotoSupported()) draftPhotos.splice(photoViewer.index, 1);
      else photoState = { mode: 'removed', b64: null, id: null };
      setPhotoUI();
      $('dlg-photo').close();
      toast('Photo hata di — entry save karein');
    });
  });

  // direction toggle (edit only)
  $('txn-dir').addEventListener('click', (e) => {
    const b = e.target.closest('.dir-btn');
    if (b) setTxnFormType(b.dataset.dir);
  });

  // txn dialog
  $('form-txn').addEventListener('submit', (e) => {
    if (photoProcessing) { e.preventDefault(); return; }
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
    if (!multiPhotoSupported()) {
      if (photoState.mode === 'new') payload.photo = photoState.b64;
      if (photoState.mode === 'removed') payload.photo = '';
    }
    try { saveTransaction(payload); }
    catch (err) {
      e.preventDefault();
      errEl.textContent = err.message; errEl.hidden = false;
    }
  });
  $('txn-delete').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const gateId = editingTxnId;   // named before any await can move underneath us
    gated('Entry hatane ke liye PIN', () => armConfirm(btn, 'del-txn:' + gateId), () => {
      if (multiPhotoSupported()) { deleteMultiEntry(); return; }
      $('dlg-txn').close();
      const id = editingTxnId;
      const pre = clone(db.transactions.find((x) => String(x.id) === String(id)));
      if (!pre) { toast('Yeh entry ab yahan nahi hai', true); return; }
      db.transactions = db.transactions.filter((x) => String(x.id) !== String(id));
      // an add that is already on the wire is NOT droppable — the row is about
      // to exist in the sheet, so this becomes a real deleteTxn (its payload id
      // is remapped to the server id when the add lands)
      const queuedAdd = isTmp(id) && queuedAddFor(id);
      const ledger = ledgerGen;
      let undoDelete;
      if (queuedAdd) {
        // Never reached the sheet — dropping its queued add *is* the delete, so
        // undo is simply putting that item (and the row) back.
        const at = queue.indexOf(queuedAdd);
        dropQueued(queuedAdd);
        saveQueue();
        undoDelete = () => {
          if (ledger !== ledgerGen) return;   // different khata now — nothing to put back
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
          if (ledger !== ledgerGen) return;
          const i = del && !del.inflight ? queue.indexOf(del) : -1;
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
  });

  // customer dialog
  $('cust-contacts')?.addEventListener('click', pickCustomerContact);
  $('cust-contact-cancel')?.addEventListener('click', () => {
    if (!customerContactActive(customerContactSession)) return;
    customerContactSession.choice = null;
    paintCustomerContacts();
    $('cust-contacts').focus();
  });
  ['cust-input-name', 'cust-input-phone'].forEach(id => {
    $(id).addEventListener('input', () => contactNotice(''));
  });
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
    if (customerContactSession?.picking || customerContactSession?.choice) {
      e.preventDefault(); // also guard implicit/keyboard/programmatic form submission
      return;
    }
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
    const rawPhone = $('cust-input-phone').value;
    const checked = checkPhone(rawPhone);
    // An imported non-number must stay visible for correction, not silently
    // become an empty phone. Leave existing manual-entry validation unchanged.
    const invalidContactPhone = rawPhone && rawPhone === customerContactSession?.importedPhone && !checked.value;
    if (!checked.ok || invalidContactPhone) {
      e.preventDefault();
      errEl.textContent = 'Phone number 10 digit ka hona chahiye';
      errEl.hidden = false;
      $('cust-input-phone').focus();
      return;
    }
    const phone = checked.value;
    $('cust-input-phone').value = phone;
    if (editingCustomerId) {
      const u = db.users.find((x) => String(x.user_id) === String(editingCustomerId));
      if (!u) {   // gone underneath the open dialog — say so, never throw
        e.preventDefault();
        errEl.textContent = 'Yeh customer ab yahan nahi hai — band karke dobara kholein.';
        errEl.hidden = false;
        return;
      }
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
      const tmpId = tmpUserId();
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
    const btn = e.currentTarget;
    const gateId = editingCustomerId;
    gated('Customer hatane ke liye PIN',
      () => armConfirm(btn, 'del-cust:' + gateId,
        'Dobara tap — is customer ki saari entry mit jayengi'),
      () => {
        $('dlg-customer').close();
        const id = editingCustomerId;
        // pre-image for rollback: the customer AND every entry that goes with them
        const preUser = clone(db.users.find((x) => String(x.user_id) === String(id)));
        const preTxns = clone(db.transactions.filter((x) => String(x.user_name) === String(id)));
        db.users = db.users.filter((x) => String(x.user_id) !== String(id));
        db.transactions = db.transactions.filter((x) => String(x.user_name) !== String(id));
        const queuedAdd = isTmp(id) && queuedAddFor(id);
        if (queuedAdd) {
          // Never reached the server — drop its add and any queued entries for it.
          // An item already on the wire is left alone: it is going to land, and
          // the deleteUser/deleteTxn behind it is what undoes it.
          queue = queue.filter((item) => item.inflight || (item !== queuedAdd &&
            !(item.payload && item.payload.data && item.payload.data.user_id === id)));
          saveQueue();
        } else {
          enqueue('deleteUser', { id }, null,
            preUser ? { type: 'user', user: preUser, txns: preTxns } : null);
        }
        saveCache();
        goHome();
        toast('Customer deleted');
      });
  });

  // generic dialog close buttons
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  // A cancelled (or submitted, or Esc'd) dialog must never leave an arming
  // behind for whatever opens next — audit 0.2's other half. It also hands the
  // overlays back down to whatever is underneath it.
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
    if (d.id === 'dlg-txn' && !d.open) resetPhotoControls();
    if (d.id === 'dlg-customer' && !d.open) resetCustomerContacts();
    disarmConfirm();
    moveOverlays();
  }));

  // update notice — its own element, so an ordinary toast can't wipe it
  $('update-go').addEventListener('click', () => location.reload());
  $('update-dismiss').addEventListener('click', () => topHide($('update-bar')));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && updateWaiting) showUpdateBar();
    // The app went to the background — the phone is on the counter again, and
    // the PIN's grace window has no business surviving that.
    if (document.visibilityState === 'hidden') pinOkUntil = 0;
    if (document.visibilityState === 'hidden') closeCamera();
    if (document.visibilityState === 'visible') { retryPhotoJobs(); refresh(true); }
  });
  window.addEventListener('pagehide', () => { closeCamera(); closeBalanceShare(); });

  // resync when network returns
  window.addEventListener('online', () => { setOffline(false); retryPhotoJobs(); refresh(true); });
  window.addEventListener('offline', () => setOffline(true));

  // a link tapped while the app is already open (installed PWAs stay alive for
  // days) is same-document navigation — only hashchange ever hears about it
  window.addEventListener('hashchange', () => { closeCamera(); dispatchLink(); });

  // Remove the retired owner shortcut, including when an older HTML shell
  // is cached. This is UI removal, not an owner-app lock or storage isolation.
  $('pb-mine')?.remove();

  // boot — a passbook link is a customer view; an invite link is a merchant connection
  if (!dispatchLink()) bootLedger();

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

/* Both copy buttons live inside a modal dialog, and everything outside the top
   dialog is inert — a textarea parked on document.body cannot be selected, so
   the fallback silently copied nothing while the caller cheerfully toasted
   "copy ho gaya". It goes inside whatever is on top, and a refusal is
   reported as one. */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  overlayHost().appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy nahi hua'));
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

// An existing entry is already editable the moment its sheet opens, so the
// PIN belongs at that boundary rather than on Save. This covers amount, date,
// direction, note and photo changes together while leaving new-entry capture
// fast. The normal two-minute authenticated grace window still applies.
function openExistingTxn(txn) {
  const ledger = ledgerGen;
  const id = String(txn.id);
  requirePin('Entry badalne ke liye PIN').then((ok) => {
    if (!ok || ledger !== ledgerGen) return;
    const current = db.transactions.find((t) => String(t.id) === id);
    if (!current || String(current.user_name) !== String(currentCustomerId)) {
      toast('Yeh entry ab yahan nahi hai', true);
      return;
    }
    openTxnForm(current.type, current);
  });
}

function openTxnForm(type, txn) {
  resetPhotoControls();
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
  draftPhotos = txn ? photosFor(txn).map((p) => ({ ...p })) : [];
  originalDraftPhotos = draftPhotos.map((p) => ({ ...p }));
  setPhotoUI();
  $('txn-delete').hidden = !txn;
  $('txn-delete').textContent = 'Delete';
  $('txn-error').hidden = true;
  showSheet($('dlg-txn'));
  if (!txn) $('txn-amount').focus();
}

// Contacts are an explicit, single-contact import into this draft only. No
// address-book IDs, raw results, or unused numbers enter storage or the API.
function customerContactActive(session) {
  return !!(session && session === customerContactSession &&
    session.ledger === ledgerGen && $('dlg-customer').open);
}

function paintCustomerContacts() {
  if (!$('cust-contacts')) return; // safe with an older cached HTML shell
  const s = customerContactSession;
  const pending = !!(s?.picking || s?.choice);
  $('cust-contacts').hidden = !s?.supported;
  $('cust-contacts').disabled = pending || !!customerContactRequest;
  $('cust-contacts').setAttribute('aria-expanded', String(!!s?.choice));
  $('cust-contact-numbers').hidden = !s?.choice;
  if (!s?.choice) {
    $('cust-contact-options').replaceChildren();
    $('cust-contact-name').textContent = '';
  }
  ['cust-input-name', 'cust-input-phone', 'cust-save', 'cust-delete'].forEach(id => {
    $(id).disabled = pending;
  });
}

function contactNotice(message, error = false) {
  const el = $('cust-contact-status');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle('contact-error', error);
}

function resetCustomerContacts() {
  customerContactSession = null;
  contactNotice('');
  paintCustomerContacts();
}

function closeCustomerForm() {
  resetCustomerContacts();
  if ($('dlg-customer')?.open) $('dlg-customer').close();
}

async function prepareCustomerContacts() {
  const s = { ledger: ledgerGen, supported: false, picking: false, choice: null, importedPhone: null };
  customerContactSession = s;
  paintCustomerContacts();
  if (!$('cust-contacts') || !window.isSecureContext || window.top !== window ||
      typeof navigator.contacts?.select !== 'function' ||
      typeof navigator.contacts?.getProperties !== 'function') return;
  try {
    // Resolve capabilities before the tap: no await may precede select() in
    // its click handler, or Chrome can lose the required user activation.
    const props = await navigator.contacts.getProperties();
    if (!customerContactActive(s)) return;
    s.supported = Array.isArray(props) && props.includes('name') && props.includes('tel');
    paintCustomerContacts();
  } catch (_) { /* unsupported/broken capability check: manual form stays usable */ }
}

function applyCustomerContact(s, name, rawPhone) {
  if (!customerContactActive(s)) return;
  const checked = checkPhone(rawPhone);
  const invalid = !!rawPhone && (!checked.ok || !checked.value);
  $('cust-input-name').value = name;
  $('cust-input-phone').value = invalid ? rawPhone : checked.value;
  s.importedPhone = $('cust-input-phone').value;
  s.choice = null;
  $('cust-error').hidden = true;
  const notices = [];
  if (!name.trim()) notices.push('No name shared — enter a name.');
  if (!rawPhone) notices.push('No phone number shared — add one if needed.');
  if (invalid) notices.push('Phone number 10 digit ka hona chahiye — please check it.');
  contactNotice(notices.join(' '), invalid);
  paintCustomerContacts();
  // The native call's finally block enables fields before returning focus.
  if (!s.picking) $(name.trim() ? 'cust-input-phone' : 'cust-input-name').focus();
}

async function pickCustomerContact() {
  const s = customerContactSession;
  if (!customerContactActive(s) || !s.supported || s.picking || s.choice || customerContactRequest) return;
  const request = {};
  customerContactRequest = request;
  s.picking = true;
  contactNotice('');
  paintCustomerContacts();
  let filled = false;
  try {
    const result = await navigator.contacts.select(['name', 'tel'], { multiple: false });
    if (!customerContactActive(s)) return;
    if (Array.isArray(result) && result.length === 0) return; // native cancellation
    if (!Array.isArray(result) || result.length !== 1 || !result[0] || typeof result[0] !== 'object') {
      throw new Error('Unexpected contact result');
    }
    const strings = values => Array.isArray(values) ? values.filter(v => typeof v === 'string' && v.trim()) : [];
    const name = strings(result[0].name)[0] || '';
    const numbers = [];
    const seen = new Set();
    for (const raw of strings(result[0].tel)) {
      const checked = checkPhone(raw);
      const key = checked.ok && checked.value ? checked.value : raw.trim();
      if (!seen.has(key)) { seen.add(key); numbers.push(raw); }
    }
    if (numbers.length <= 1) {
      applyCustomerContact(s, name, numbers[0] || '');
      filled = true;
    } else {
      s.choice = { name, numbers };
      $('cust-contact-name').textContent = name || 'Selected contact';
      $('cust-contact-options').replaceChildren(...numbers.map(raw => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'contact-number';
        const label = document.createElement('span');
        label.textContent = raw;
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        arrow.setAttribute('aria-hidden', 'true');
        button.append(label, arrow);
        button.addEventListener('click', () => applyCustomerContact(s, name, raw));
        return button;
      }));
    }
  } catch (err) {
    if (customerContactActive(s) && err?.name !== 'AbortError') {
      contactNotice('Contacts could not be opened. Try again or enter the details manually.', true);
    }
  } finally {
    if (customerContactRequest === request) customerContactRequest = null;
    s.picking = false;
    paintCustomerContacts();
    if (customerContactActive(s)) {
      if (s.choice) $('cust-contact-options').querySelector('button')?.focus();
      else if (filled) $($('cust-input-name').value.trim() ? 'cust-input-phone' : 'cust-input-name').focus();
      else $('cust-contacts').focus();
    }
  }
}

function openCustomerForm(id, prefillName) {
  resetCustomerContacts();
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
  prepareCustomerContacts();
  if (!u) $('cust-input-name').focus();
}

init();
