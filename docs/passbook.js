/* Shared passbook URL codec and read-only renderer. No owner credentials,
   localStorage, write queue or owner screens are accessed here. */
'use strict';
(() => {
  const INVALID_LINK = 'Invalid passbook link. Please ask the shopkeeper to share it again.';
  const API_PREFIX = 'https://script.google.com/macros/s/';
  const CANONICAL_API = /^https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const numbers = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  const $ = id => document.getElementById(id);
  let request = null;

  function createLink(pageUrl, backendUrl, token) {
    const match = CANONICAL_API.exec(backendUrl);
    if (!match || typeof token !== 'string' || !token || token === 'off') return null;
    // A new path, not a new hash on the owner page: old cached owner JS must
    // never mistake this format for a request to boot its saved ledger.
    const page = new URL('p/', pageUrl);
    page.hash = match[1] + '.' + encodeURIComponent(token);
    return page.href;
  }

  function validatePayload(payload, allowDemo) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(INVALID_LINK);
    if (allowDemo && typeof payload.d === 'string' && payload.d) return { d: payload.d };
    if (typeof payload.u !== 'string' || typeof payload.t !== 'string' || !payload.t || payload.t === 'off') {
      throw new Error(INVALID_LINK);
    }
    const endpoint = new URL(payload.u);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
        !['script.google.com', 'script.googleusercontent.com'].includes(endpoint.hostname)) {
      throw new Error(INVALID_LINK);
    }
    return { u: payload.u, t: payload.t };
  }

  function parseHash(hash, { allowDemo = false } = {}) {
    try {
      if (hash.startsWith('#p=')) {
        if (!/^#p=[A-Za-z0-9_-]+$/.test(hash)) throw new Error(INVALID_LINK);
        return validatePayload(JSON.parse(atob(hash.slice(3).replace(/-/g, '+').replace(/_/g, '/'))), allowDemo);
      }
      const match = /^#([A-Za-z0-9_-]+)\.(.+)$/.exec(hash);
      if (!match) throw new Error(INVALID_LINK);
      return validatePayload({ u: API_PREFIX + match[1] + '/exec', t: decodeURIComponent(match[2]) }, false);
    } catch (_) { throw new Error(INVALID_LINK); }
  }

  function parseDate(value) {
    if (!value) return new Date(0);
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    const date = new Date(value);
    return isNaN(date) ? new Date(0) : date;
  }

  function fmtDate(value) {
    const date = parseDate(value);
    return date.getTime() === 0 ? '—' :
      `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }

  function clear() {
    $('pb-name').textContent = '…';
    $('pb-amt').textContent = '…';
    $('pb-amt').className = 'balance-amt';
    $('pb-word').textContent = '';
    $('pb-list').replaceChildren();
    $('pb-status').hidden = false;
    $('pb-status').textContent = 'Loading your passbook…';
  }

  function cancel() {
    if (request) { clearTimeout(request.timer); request.controller.abort(); }
    request = null;
  }

  function showError(message) {
    cancel();
    clear();
    $('pb-status').textContent = message || INVALID_LINK;
  }

  function element(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }

  function paint(data, currency) {
    if (!data || typeof data.name !== 'string' || !Array.isArray(data.transactions)) {
      throw new Error('The ledger returned an invalid response. Please reopen the link.');
    }
    const txns = data.transactions.slice().sort((a, b) => parseDate(b.date) - parseDate(a.date));
    const money = value => currency + numbers.format(Math.abs(Number(value) || 0));
    const balance = txns.reduce((sum, txn) => sum + (txn.type === 'received' ? -1 : 1) * (Number(txn.amount) || 0), 0);
    const fragment = document.createDocumentFragment();
    let lastMonth = '';
    txns.forEach(txn => {
      const date = parseDate(txn.date);
      const month = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
      if (month !== lastMonth) fragment.append(element('li', 'date-divider', `— ${month} —`));
      lastMonth = month;
      const row = element('li', 'txn-row txn-ro');
      const gave = element('div', 'txn-cell' + (txn.type === 'received' ? '' : ' gave'));
      const got = element('div', 'txn-cell' + (txn.type === 'received' ? ' got' : ''));
      const cell = txn.type === 'received' ? got : gave;
      cell.append(element('div', 'txn-amt', money(txn.amount)));
      if (txn.comment) cell.append(element('div', 'txn-note', txn.comment));
      cell.append(element('div', 'txn-date', fmtDate(txn.date)));
      row.append(gave, got);
      fragment.append(row);
    });
    $('pb-name').textContent = data.name;
    $('pb-amt').textContent = money(balance);
    $('pb-amt').className = 'balance-amt ' + (balance > 0 ? 'due' : balance < 0 ? 'adv' : '');
    $('pb-word').textContent = balance > 0 ? 'to pay' : balance < 0 ? 'advance with shopkeeper' : 'settled up';
    $('pb-list').replaceChildren(fragment);
    $('pb-status').hidden = true;
  }

  async function open(payload, { data, currency = '₹', isActive = () => true } = {}) {
    cancel();
    clear();
    const current = { controller: new AbortController(), timer: null, timedOut: false };
    request = current;
    current.timer = setTimeout(() => { current.timedOut = true; current.controller.abort(); }, 30000);
    try {
      if (data === undefined) {
        const checked = validatePayload(payload, false);
        const response = await fetch(checked.u, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'passbook', token: checked.t }),
          credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          signal: current.controller.signal,
        });
        if (!response.ok) throw new Error('Could not load the ledger. Please reopen the link.');
        let json;
        try { json = await response.json(); }
        catch (_) { throw new Error('The ledger returned an invalid response. Please reopen the link.'); }
        if (!json.ok) throw new Error(json.error || 'Could not load your passbook.');
        data = json.data;
      }
      if (request !== current || !isActive()) return;
      paint(data, currency);
    } catch (err) {
      if (request !== current || !isActive()) return;
      const message = current.timedOut ? 'The ledger took too long to respond. Please reopen the link.' :
        err instanceof TypeError ? 'Could not reach the ledger — check your internet and reopen the link.' : err.message;
      showError(message);
    } finally {
      clearTimeout(current.timer);
      if (request === current) request = null;
    }
  }

  window.BahiPassbook = Object.freeze({ createLink, parseHash, clear, cancel, showError, open });
})();
