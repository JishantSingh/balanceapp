/* Bahi — udhaar khata · app logic
   Data lives in the merchant's own Google Sheet, reached through their own
   Apps Script deployment. This file talks to that API and renders the UI.

   Write path: every write is applied to the local cache immediately, then
   queued. The queue replays in order; network failures keep items queued
   (visible as the "pending" chip) — entries never silently fail. */

'use strict';

// ---------------------------------------------------------------- state

const LS_CONFIG = 'bahi.config';
const LS_CACHE = 'bahi.cache';
const LS_DEMO = 'bahi.demo';
const LS_QUEUE = 'bahi.queue';

const DEFAULT_TEMPLATE =
  'Namaste {name} ji 🙏\n' +
  'Aapka {merchant} par {amount} ka hisaab baaki hai. ' +
  'Kripya jald bhugtan karein.\n' +
  'Apna pura hisaab yahan dekhein: {passbook}\n' +
  'Dhanyavaad!';

let config = loadJSON(LS_CONFIG) || null;
let db = loadJSON(LS_CACHE) || { users: [], transactions: [] };
let queue = loadJSON(LS_QUEUE) || [];
let currentCustomerId = null;
let editingTxnId = null;
let editingCustomerId = null;
let txnFormType = 'given';
let confirmArmed = null;

// photo form state: mode 'none' | 'existing' | 'new' | 'removed'
let photoState = { mode: 'none', b64: null, id: null };
const photoCache = {};   // fileId -> dataURI (in-memory)
const demoPhotos = {};   // demo fileId -> b64 (in-memory, demo mode only)

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

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

function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function busy(on) { $('busy').hidden = !on; }

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

async function api(action, payload) {
  if (config && config.demo) return demoApi(action, payload);

  busy(true);
  try {
    let res;
    if (action === 'list') {
      const u = new URL(config.url);
      u.searchParams.set('action', 'list');
      u.searchParams.set('key', config.key);
      res = await fetch(u.toString());
    } else {
      // text/plain keeps the request "simple" so Apps Script needs no CORS preflight
      res = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, key: config.key }, payload)),
      });
    }
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Request failed');
    setOffline(false);
    return json.data;
  } catch (err) {
    if (err instanceof TypeError) setOffline(true); // network failure
    throw err;
  } finally {
    busy(false);
  }
}

function setOffline(off) { $('chip-offline').hidden = !off; }

async function refresh(silent) {
  if (queue.length) { render(); processQueue(); return; } // local truth wins until synced
  try {
    const data = await api('list');
    db = { users: data.users || [], transactions: data.transactions || [] };
    saveJSON(LS_CACHE, db);
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
    let dropped = false;
    queue.forEach((item) => {
      if (item.payload && item.payload.data && item.payload.data.photo) {
        delete item.payload.data.photo;
        dropped = true;
      }
    });
    if (dropped) {
      toast('Storage full — a queued photo was dropped; the entry is safe', true);
      try { saveJSON(LS_QUEUE, queue); } catch (e2) { /* give up quietly */ }
    }
  }
  updatePendingChip();
}

function updatePendingChip() {
  const chip = $('chip-pending');
  chip.hidden = queue.length === 0;
  chip.textContent = queue.length + ' pending';
}

function enqueue(action, payload, tmpId) {
  // Demo writes go straight to the local demo store — no queue, no chip
  if (config && config.demo) {
    api(action, payload).then(() => refresh(true));
    return;
  }
  queue.push({ action, payload, tmpId: tmpId || null });
  saveQueue();
  processQueue();
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
        if (err instanceof TypeError) return; // offline — keep queued, retry later
        // Server rejected it (bad data, already deleted, …) — drop so the queue can't jam
        queue.shift();
        saveQueue();
        toast('One change was rejected: ' + err.message, true);
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
  queue.forEach((item) => {
    if (item.payload && item.payload.data && item.payload.data.user_id === tmpId) {
      item.payload.data.user_id = realId;
    }
    if (item.payload && item.payload.id === tmpId) item.payload.id = realId;
  });
  if (currentCustomerId === tmpId) currentCustomerId = realId;
  saveJSON(LS_CACHE, db);
  saveQueue();
  render();
}

function remapTxnId(tmpId, realId) {
  const t = db.transactions.find((x) => x.id === tmpId);
  if (t) t.id = realId;
  queue.forEach((item) => {
    if (item.payload && item.payload.id === tmpId) item.payload.id = realId;
  });
  saveJSON(LS_CACHE, db);
  saveQueue();
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
      demo.users.push({ user_id: id(), name: payload.data.name, created_at: todayISO(), phone: payload.data.phone || '', token: '' });
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
  updatePendingChip();
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

  const q = $('search').value.trim().toLowerCase();
  const filtered = items
    .filter((it) => !q || it.u.name.toLowerCase().includes(q))
    .sort((a, b) => b.last - a.last);

  $('customer-list').innerHTML = filtered.map((it, i) => {
    const tag = it.bal > 0 ? 'due' : it.bal < 0 ? 'adv' : '';
    const word = it.bal > 0 ? 'due' : it.bal < 0 ? 'advance' : 'settled';
    const sub = it.txns.length
      ? `${it.txns.length} entr${it.txns.length === 1 ? 'y' : 'ies'} · last ${fmtDate(it.txns[0].date)}`
      : 'no entries yet';
    return `<li class="customer-row" data-id="${escapeHtml(it.u.user_id)}" style="animation-delay:${Math.min(i * 40, 400)}ms">
      <span class="avatar t${avatarTone(it.u.name)}">${escapeHtml(initialOf(it.u.name))}</span>
      <span class="customer-main">
        <span class="customer-name">${escapeHtml(it.u.name)}</span>
        <div class="customer-sub">${escapeHtml(sub)}</div>
      </span>
      <span class="customer-amt ${tag}"><b>${money(it.bal)}</b><small>${word}</small></span>
    </li>`;
  }).join('');

  $('home-empty').hidden = db.users.length > 0;
  $('chip-demo').hidden = !(config && config.demo);
}

function initialOf(name) {
  return (String(name).trim()[0] || '?').toUpperCase();
}
function avatarTone(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 3;
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
}

function txnCell(t) {
  return `<div class="txn-amt">${money(t.amount)}</div>` +
    (t.comment ? `<div class="txn-note">${escapeHtml(t.comment)}</div>` : '') +
    `<div class="txn-date">${fmtDate(t.date)}${t.photo ? ' 📎' : ''}</div>`;
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
function applyInviteLink() {
  const m = /#s=([A-Za-z0-9\-_]+)/.exec(location.hash);
  if (!m) return false;
  let payload;
  try {
    payload = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return false; }
  if (!payload.u || !/^https:\/\/script\.google(?:usercontent)?\.com\//.test(payload.u)) return false;
  config = Object.assign(
    { currency: '₹', cc: '91', merchant: '', template: DEFAULT_TEMPLATE },
    config || {},
    { url: payload.u, key: payload.k || '', demo: false }
  );
  saveJSON(LS_CONFIG, config);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
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
  const remove = $('txn-photo-remove');
  if (photoState.mode === 'new') {
    label.textContent = 'Photo added ✓';
    view.hidden = false; remove.hidden = false;
  } else if (photoState.mode === 'existing') {
    label.textContent = 'Change photo';
    view.hidden = false; remove.hidden = false;
  } else {
    label.textContent = 'Add photo';
    view.hidden = true; remove.hidden = true;
  }
}

async function viewCurrentPhoto() {
  const img = $('photo-img');
  img.src = '';
  try {
    if (photoState.mode === 'new') {
      img.src = 'data:image/jpeg;base64,' + photoState.b64;
    } else if (photoState.mode === 'existing') {
      if (!photoCache[photoState.id]) {
        toast('Loading photo…');
        const data = await api('photo', { id: photoState.id });
        if (!data.b64) throw new Error('Photo not found');
        photoCache[photoState.id] = `data:${data.mime || 'image/jpeg'};base64,` + data.b64;
      }
      img.src = photoCache[photoState.id];
    } else {
      return;
    }
    $('dlg-photo').showModal();
  } catch (err) {
    toast('Could not load photo: ' + err.message, true);
  }
}

// ---------------------------------------------------------------- double-tap confirm

function armConfirm(btn, token, label) {
  if (confirmArmed === token) { confirmArmed = null; return true; }
  confirmArmed = token;
  const original = btn.textContent;
  btn.textContent = label || 'Tap again to confirm';
  setTimeout(() => {
    if (confirmArmed === token) confirmArmed = null;
    btn.textContent = original;
  }, 2600);
  return false;
}

// ---------------------------------------------------------------- wiring

function init() {
  // connect screen
  $('btn-connect').addEventListener('click', async () => {
    const url = $('cfg-url').value.trim();
    const key = $('cfg-key').value.trim();
    const errEl = $('connect-error');
    errEl.hidden = true;
    if (!/^https:\/\/script\.google(?:usercontent)?\.com\//.test(url)) {
      errEl.textContent = 'That does not look like an Apps Script /exec URL.';
      errEl.hidden = false;
      return;
    }
    config = { url, key, currency: '₹', cc: '91', merchant: '', template: DEFAULT_TEMPLATE, demo: false };
    try {
      const data = await api('list');
      db = { users: data.users || [], transactions: data.transactions || [] };
      saveJSON(LS_CACHE, db);
      saveJSON(LS_CONFIG, config);
      show('home');
      render();
      toast('Connected to your ledger ✓');
    } catch (err) {
      config = null;
      errEl.textContent = 'Could not connect: ' + err.message;
      errEl.hidden = false;
    }
  });

  $('btn-demo').addEventListener('click', () => {
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
  $('customer-list').addEventListener('click', (e) => {
    const row = e.target.closest('.customer-row');
    if (row) openCustomer(row.dataset.id);
  });
  $('fab').addEventListener('click', () => openCustomerForm(null));

  // settings
  $('btn-settings').addEventListener('click', () => {
    $('set-merchant').value = config.merchant || '';
    $('set-currency').value = config.currency || '₹';
    $('set-cc').value = config.cc || '91';
    $('set-template').value = config.template || DEFAULT_TEMPLATE;
    $('set-url').value = config.url || '';
    $('set-key').value = config.key || '';
    document.querySelector('.settings-conn').open = false;
    $('btn-invite').hidden = !!config.demo || !config.url;
    $('dlg-settings').showModal();
  });
  $('btn-invite').addEventListener('click', () => {
    copyText(inviteLink())
      .then(() => toast('Invite link copied — anyone with it gets full access'))
      .catch(() => toast('Could not copy link', true));
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
    if (!armConfirm(e.target, 'disconnect')) return;
    if (queue.length && !window.confirm(queue.length + ' unsynced change(s) will be lost. Disconnect anyway?')) return;
    [LS_CONFIG, LS_CACHE, LS_DEMO, LS_QUEUE].forEach((k) => localStorage.removeItem(k));
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
  $('txn-photo-remove').addEventListener('click', () => {
    photoState = { mode: 'removed', b64: null, id: null };
    setPhotoUI();
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
      const localPhoto = photoState.mode === 'new' ? 'pending'
        : photoState.mode === 'removed' ? '' : (t.photo || '');
      Object.assign(t, payload, { user_name: payload.user_id, photo: localPhoto });
      const queuedAdd = isTmp(editingTxnId) && queuedAddFor(editingTxnId);
      if (queuedAdd) {
        Object.assign(queuedAdd.payload.data, payload);
        saveQueue(); processQueue();
      } else {
        enqueue('updateTxn', { id: editingTxnId, data: payload });
      }
    } else {
      const tmpId = 'tmp' + Date.now();
      // local copy carries a marker, never the photo bytes (those live in the queue payload)
      const localTxn = Object.assign({ id: tmpId, user_name: payload.user_id }, payload);
      localTxn.photo = photoState.mode === 'new' ? 'pending' : '';
      db.transactions.push(localTxn);
      enqueue('addTxn', { data: payload }, tmpId);
    }
    saveJSON(LS_CACHE, db);
    render();
    if (!navigator.onLine) toast('Saved — will sync when you are back online');
  });
  $('txn-delete').addEventListener('click', (e) => {
    if (!armConfirm(e.target, 'del-txn')) return;
    $('dlg-txn').close();
    const id = editingTxnId;
    db.transactions = db.transactions.filter((x) => x.id !== id);
    const queuedAdd = isTmp(id) && queuedAddFor(id);
    if (queuedAdd) {
      queue = queue.filter((item) => item !== queuedAdd);
      saveQueue();
    } else {
      enqueue('deleteTxn', { id });
    }
    saveJSON(LS_CACHE, db);
    render();
    toast('Entry deleted');
  });

  // customer dialog
  $('form-customer').addEventListener('submit', (e) => {
    const name = $('cust-input-name').value.trim();
    const phone = $('cust-input-phone').value.trim();
    const errEl = $('cust-error');
    errEl.hidden = true;
    if (!name) {
      e.preventDefault();
      errEl.textContent = 'Name is required.';
      errEl.hidden = false;
      return;
    }
    if (editingCustomerId) {
      const u = db.users.find((x) => x.user_id === editingCustomerId);
      Object.assign(u, { name, phone });
      const queuedAdd = isTmp(editingCustomerId) && queuedAddFor(editingCustomerId);
      if (queuedAdd) {
        Object.assign(queuedAdd.payload.data, { name, phone });
        saveQueue(); processQueue();
      } else {
        enqueue('updateUser', { id: editingCustomerId, data: { name, phone } });
      }
    } else {
      const tmpId = 'tmpu' + Date.now();
      db.users.push({ user_id: tmpId, name, phone, created_at: todayISO(), token: '' });
      enqueue('addUser', { data: { name, phone } }, tmpId);
      toast(`${name} added`);
    }
    saveJSON(LS_CACHE, db);
    render();
  });
  $('cust-delete').addEventListener('click', (e) => {
    if (!armConfirm(e.target, 'del-cust', 'Tap again — deletes all entries')) return;
    $('dlg-customer').close();
    const id = editingCustomerId;
    db.users = db.users.filter((x) => x.user_id !== id);
    db.transactions = db.transactions.filter((x) => x.user_name !== id);
    const queuedAdd = isTmp(id) && queuedAddFor(id);
    if (queuedAdd) {
      // never reached the server — drop its add and any queued entries for it
      queue = queue.filter((item) => item !== queuedAdd &&
        !(item.payload && item.payload.data && item.payload.data.user_id === id));
      saveQueue();
    } else {
      enqueue('deleteUser', { id });
    }
    saveJSON(LS_CACHE, db);
    goHome();
    toast('Customer deleted');
  });

  // generic dialog close buttons
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  // resync when network returns
  window.addEventListener('online', () => { setOffline(false); processQueue(); });
  window.addEventListener('offline', () => setOffline(true));

  // boot — a passbook link is a customer view; an invite link is a merchant connection
  if (applyPassbookLink()) {
    // read-only mode: nothing else to wire
  } else {
    const invited = applyInviteLink();
    if (!config) {
      show('connect');
    } else {
      show('home');
      render();          // cached copy immediately
      refresh(true);     // then sync in background (also drains the queue)
      if (invited) toast('Connected to shared ledger ✓');
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
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

function openTxnForm(type, txn) {
  txnFormType = type;
  editingTxnId = txn ? txn.id : null;
  const title = $('txn-title');
  title.textContent = type === 'received' ? 'Received' : 'Given';
  title.className = 'sheet-title ' + (type === 'received' ? 'got' : 'gave');
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
  $('dlg-txn').showModal();
  if (!txn) $('txn-amount').focus();
}

function openCustomerForm(id) {
  editingCustomerId = id;
  const u = id ? db.users.find((x) => String(x.user_id) === String(id)) : null;
  $('cust-dlg-title').textContent = u ? 'Edit customer' : 'New customer';
  $('cust-input-name').value = u ? u.name : '';
  $('cust-input-phone').value = u ? (u.phone || '') : '';
  $('cust-delete').hidden = !u;
  $('cust-delete').textContent = 'Delete';
  $('cust-error').hidden = true;
  $('dlg-customer').showModal();
  if (!u) $('cust-input-name').focus();
}

init();
