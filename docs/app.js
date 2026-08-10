/* Bahi — udhaar khata · app logic
   Data lives in the merchant's own Google Sheet, reached through their own
   Apps Script deployment. This file talks to that API and renders the UI. */

'use strict';

// ---------------------------------------------------------------- state

const LS_CONFIG = 'bahi.config';
const LS_CACHE = 'bahi.cache';
const LS_DEMO = 'bahi.demo';

const DEFAULT_TEMPLATE =
  'Namaste {name} ji 🙏\n' +
  'Aapka {merchant} par {amount} ka hisaab baaki hai. ' +
  'Kripya jald bhugtan karein.\n' +
  'Dhanyavaad!';

let config = loadJSON(LS_CONFIG) || null;
let db = loadJSON(LS_CACHE) || { users: [], transactions: [] };
let currentCustomerId = null;
let editingTxnId = null;
let editingCustomerId = null;
let txnFormType = 'given';
let confirmArmed = null; // double-tap-to-confirm token

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

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
function money(n) {
  const cur = (config && config.currency) || '₹';
  return cur + inr.format(Math.abs(Number(n) || 0));
}

// ---------------------------------------------------------------- api

async function api(action, payload) {
  if (config && config.demo) return demoApi(action, payload);

  const isRead = action === 'list';
  busy(true);
  try {
    let res;
    if (isRead) {
      const u = new URL(config.url);
      u.searchParams.set('action', action);
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

// ---------------------------------------------------------------- demo backend

function demoSeed() {
  const t = new Date();
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const thisMonth = iso(t.getFullYear(), t.getMonth() + 1, Math.max(1, t.getDate() - 3));
  return {
    users: [
      { user_id: 'demo0001', name: 'Chetan Kirana Store', created_at: '2025-11-02', phone: '9876500001' },
      { user_id: 'demo0002', name: 'Sunita Tailor', created_at: '2025-12-14', phone: '9876500002' },
      { user_id: 'demo0003', name: 'Arihant Auto Works', created_at: '2026-01-05', phone: '' },
      { user_id: 'demo0004', name: 'Hina Madam', created_at: '2026-02-20', phone: '9876500004' },
    ],
    transactions: [
      { id: 'demot001', user_name: 'demo0001', date: '2026-05-11', type: 'given', amount: 11500, comment: 'Net parchi' },
      { id: 'demot002', user_name: 'demo0001', date: '2026-06-01', type: 'given', amount: 1262, comment: 'Slip' },
      { id: 'demot003', user_name: 'demo0001', date: '2026-07-03', type: 'received', amount: 6400, comment: 'Cash' },
      { id: 'demot004', user_name: 'demo0002', date: '2026-06-18', type: 'given', amount: 1800, comment: 'School dress stitching' },
      { id: 'demot005', user_name: 'demo0002', date: '2026-07-21', type: 'received', amount: 1800, comment: 'GPay' },
      { id: 'demot006', user_name: 'demo0003', date: '2026-07-28', type: 'given', amount: 8624, comment: 'Copy + register' },
      { id: 'demot007', user_name: 'demo0004', date: thisMonth, type: 'given', amount: 5500, comment: '50 kg kirana saman' },
      { id: 'demot008', user_name: 'demo0004', date: thisMonth, type: 'given', amount: 200, comment: '100 ring golden' },
    ],
  };
}

function demoApi(action, payload) {
  let demo = loadJSON(LS_DEMO) || demoSeed();
  const id = () => Math.random().toString(16).slice(2, 10);
  switch (action) {
    case 'list':
      break;
    case 'addUser':
      demo.users.push({ user_id: id(), name: payload.data.name, created_at: todayISO(), phone: payload.data.phone || '' });
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
      });
      break;
    case 'updateTxn': {
      const t = demo.transactions.find((x) => x.id === payload.id);
      if (t) Object.assign(t, {
        date: payload.data.date, type: payload.data.type,
        amount: Number(payload.data.amount), comment: payload.data.comment || '',
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

  const list = $('customer-list');
  list.innerHTML = filtered.map((it, i) => {
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
    `<div class="txn-date">${fmtDate(t.date)}</div>`;
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

// ---------------------------------------------------------------- invite links

// The connection travels in the URL fragment, which browsers never send to
// servers. Anyone holding the link has full access to that ledger.
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
  const payload = btoa(JSON.stringify({ u: config.url, k: config.key }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return location.origin + location.pathname + '#s=' + payload;
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

// ---------------------------------------------------------------- reminders

function reminderLink(u, bal) {
  const template = (config && config.template) || DEFAULT_TEMPLATE;
  const merchant = (config && config.merchant) || 'hamari dukaan';
  const msg = template
    .replaceAll('{name}', u.name)
    .replaceAll('{amount}', money(bal))
    .replaceAll('{merchant}', merchant);
  return 'https://wa.me/' + normalizePhone(u.phone) + '?text=' + encodeURIComponent(msg);
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
      await refreshOrThrow();
      saveJSON(LS_CONFIG, config);
      show('home');
      toast('Connected to your ledger ✓');
    } catch (err) {
      config = null;
      errEl.textContent = 'Could not connect: ' + err.message;
      errEl.hidden = false;
    }
  });

  async function refreshOrThrow() {
    const data = await api('list');
    db = { users: data.users || [], transactions: data.transactions || [] };
    saveJSON(LS_CACHE, db);
    render();
  }

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
    localStorage.removeItem(LS_CONFIG);
    localStorage.removeItem(LS_CACHE);
    localStorage.removeItem(LS_DEMO);
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
    const bal = balanceOf(u.user_id);
    window.open(reminderLink(u, bal), '_blank');
  });
  $('btn-gave').addEventListener('click', () => openTxnForm('given', null));
  $('btn-got').addEventListener('click', () => openTxnForm('received', null));
  $('txn-list').addEventListener('click', (e) => {
    const row = e.target.closest('.txn-row');
    if (!row) return;
    const t = db.transactions.find((x) => x.id === row.dataset.id);
    if (t) openTxnForm(t.type, t);
  });

  // txn dialog
  $('form-txn').addEventListener('submit', async (e) => {
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
    try {
      if (editingTxnId) {
        const t = db.transactions.find((x) => x.id === editingTxnId);
        Object.assign(t, payload, { user_name: payload.user_id });
        render();
        await api('updateTxn', { id: editingTxnId, data: payload });
      } else {
        db.transactions.push(Object.assign({ id: 'tmp' + Date.now(), user_name: payload.user_id }, payload));
        render();
        await api('addTxn', { data: payload });
      }
      saveJSON(LS_CACHE, db);
      refresh(true);
    } catch (err) {
      toast('Save failed: ' + err.message, true);
      refresh(true);
    }
  });
  $('txn-delete').addEventListener('click', async (e) => {
    if (!armConfirm(e.target, 'del-txn')) return;
    $('dlg-txn').close();
    try {
      db.transactions = db.transactions.filter((x) => x.id !== editingTxnId);
      render();
      await api('deleteTxn', { id: editingTxnId });
      refresh(true);
      toast('Entry deleted');
    } catch (err) {
      toast('Delete failed: ' + err.message, true);
      refresh(true);
    }
  });

  // customer dialog
  $('form-customer').addEventListener('submit', async (e) => {
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
    try {
      if (editingCustomerId) {
        const u = db.users.find((x) => x.user_id === editingCustomerId);
        Object.assign(u, { name, phone });
        render();
        await api('updateUser', { id: editingCustomerId, data: { name, phone } });
      } else {
        await api('addUser', { data: { name, phone } });
        toast(`${name} added`);
      }
      refresh(true);
    } catch (err) {
      toast('Save failed: ' + err.message, true);
      refresh(true);
    }
  });
  $('cust-delete').addEventListener('click', async (e) => {
    if (!armConfirm(e.target, 'del-cust', 'Tap again — deletes all entries')) return;
    $('dlg-customer').close();
    const id = editingCustomerId;
    try {
      db.users = db.users.filter((x) => x.user_id !== id);
      db.transactions = db.transactions.filter((x) => x.user_name !== id);
      goHome();
      await api('deleteUser', { id });
      refresh(true);
      toast('Customer deleted');
    } catch (err) {
      toast('Delete failed: ' + err.message, true);
      refresh(true);
    }
  });

  // generic dialog close buttons
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  // boot — an invite link (#s=…) carries a ready-made connection
  const invited = applyInviteLink();
  if (!config) {
    show('connect');
  } else {
    show('home');
    render();          // cached copy immediately
    refresh(true);     // then sync in background
    if (invited) toast('Connected to shared ledger ✓');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function openTxnForm(type, txn) {
  txnFormType = type;
  editingTxnId = txn ? txn.id : null;
  const title = $('txn-title');
  title.textContent = type === 'received' ? 'You got' : 'You gave';
  title.className = 'sheet-title ' + (type === 'received' ? 'got' : 'gave');
  $('txn-cur').textContent = (config && config.currency) || '₹';
  $('txn-amount').value = txn ? String(txn.amount) : '';
  $('txn-date').value = txn ? isoOf(txn.date) : todayISO();
  $('txn-comment').value = txn ? (txn.comment || '') : '';
  $('txn-delete').hidden = !txn;
  $('txn-delete').textContent = 'Delete';
  $('txn-error').hidden = true;
  $('dlg-txn').showModal();
  if (!txn) $('txn-amount').focus();
}

function isoOf(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
