/* In-process mock of the Bahi Apps Script backend (Code.gs v8 contract).
   Installed per-test via Playwright request routing, so every test gets an
   isolated "deployment" with its own sheet state and failure mode.

   Mirrors the real contract:
   - GET  ?action=list&key=…            → {ok, data:{users, transactions, v,
                                            pin, sheetUrl}}
   - POST text/plain JSON {action,key,…} → per-action data (full user / full txn)
   - errors are HTTP 200 with {ok:false, error} (Apps Script never 4xxs)
   Failure modes: 'ok' | 'badkey' | 'html' (sign-in page) | 'down' (network) |
   'drop-once' (commit, then lose the answer — see below).

   Version skew: `createBackend({ v: 6 })` answers like a pre-Suraksha backend
   — `list` OMITS `pin` and `sheetUrl` entirely (the frontend feature-detects
   on the FIELD's absence, so leaving them null would not exercise the
   fallback) and `setTxnPin` comes back "Unknown action", exactly as a real v6
   deployment's switch default does. `{ v: 7 }` is a pre-idempotency backend:
   it ignores `cid` and still errors on a delete whose row is gone, which is
   what the frontend's own softening has to cope with forever.

   Deliberately NOT emulated: Apps Script's 302 redirect dance. The browser
   follows redirects inside the network stack — below any app code — and
   Playwright cannot intercept the redirect hop, so emulating it tests
   nothing of ours and leaks requests to the real googleusercontent.com. */

import { createHash } from 'node:crypto';

export const MOCK_EXEC = 'https://script.google.com/macros/s/MOCKDEPLOY/exec';
export const MOCK_SHEET_URL = 'https://docs.google.com/spreadsheets/d/MOCKSHEET/edit';

/* Code.gs stores sha256(salt + ':' + pin) as lowercase hex; identical bytes
   here (verified against Utilities.computeDigest's signed-byte hex mapping). */
export const pinHash = (salt, pin) => createHash('sha256').update(salt + ':' + pin).digest('hex');

/* A revoked passbook link keeps this sentinel in the token cell — a blank cell
   would be re-issued by backfillTokens on the next list. See Code.gs. */
export const REVOKED_TOKEN = 'off';

export function seedLedger() {
  return {
    users: [
      { user_id: 'u1', name: 'Ramu Halwai', created_at: '2026-07-01', phone: '9876500001', cohort: '', last_reminded: '', token: 'tok_ramu_1234567890' },
      { user_id: 'u2', name: 'Sunita Tailor', created_at: '2026-07-02', phone: '', cohort: '', last_reminded: '', token: 'tok_sunita_123456789' },
    ],
    transactions: [
      { id: 't1', user_name: 'u1', date: '2026-08-01', type: 'given', amount: 500, comment: 'atta', photo: '' },
      { id: 't2', user_name: 'u1', date: '2026-08-05', type: 'received', amount: 200, comment: '', photo: '' },
    ],
  };
}

/* Everything that changes the sheet — the actions 'drop-once' can commit and
   then lie about. Reads are left alone so a list/photo call cannot burn it. */
const MUTATIONS = new Set([
  'addUser', 'updateUser', 'deleteUser',
  'addTxn', 'updateTxn', 'deleteTxn',
  'remindLog', 'setTxnPin',
]);

export function createBackend(opts = {}) {
  const state = {
    key: opts.key ?? 'testkey',
    url: opts.url ?? MOCK_EXEC,  // which deployment this one answers for
    v: opts.v ?? 8,              // set 6/7 to simulate an older backend
    mode: 'ok',
    users: opts.users ?? [],
    transactions: opts.transactions ?? [],
    photos: opts.photos ?? {},   // photoId -> b64
    cids: {},                    // client id -> the row id its insert created
    adminPin: opts.adminPin ?? '123456',  // Master PIN; never leaves the server
    pin: opts.pin ?? null,       // App PIN: null | {salt, hash}
    sheetUrl: opts.sheetUrl ?? MOCK_SHEET_URL,
    log: [],                     // every {action} handled, for assertions
    requests: [],                // every request URL that arrived, gated or not
  };
  let n = 0;
  let gate = null;
  const newId = (p) => p + String(++n).padStart(4, '0');

  const ok = (data) => ({ ok: true, data });
  const err = (message) => ({ ok: false, error: message });
  // Sheets hands back whatever the cell holds — an all-digit id arrives as a
  // Number. Code.gs matches rows with String(a) === String(b); so do we.
  const same = (a, b) => String(a) === String(b);

  /* Idempotent inserts (Code.gs v8). The first addTxn/addUser carrying a `cid`
     remembers which row it made; a replay of the same `cid` gets that row back
     instead of writing a second one. A row deleted since answers with its id
     alone, exactly as Code.gs does — the client remaps, the next list
     reconciles. A v7 deployment ignores `cid` entirely. */
  const cidHit = (cid, idField, find) => {
    if (state.v < 8 || !cid) return null;
    const id = state.cids[cid];
    if (id === undefined) return null;
    return find(id) || { [idField]: id, replayed: true };
  };
  const cidRemember = (cid, id) => { if (state.v >= 8 && cid) state.cids[cid] = id; };

  function api(req) {
    state.log.push(req.action);
    if (req.action === 'passbook') {
      const t = String(req.token || '');
      if (t.length < 12 || t === REVOKED_TOKEN) return err('Invalid passbook link');
      const u = state.users.find((x) => same(x.token, t));
      if (!u) return err('This passbook link is no longer valid');
      return ok({
        name: u.name,
        transactions: state.transactions
          .filter((x) => same(x.user_name, u.user_id))
          .map(({ date, type, amount, comment }) => ({ date, type, amount, comment })),
      });
    }
    if (state.mode === 'badkey' || !same(req.key, state.key)) {
      return err('Unauthorized: bad or missing key');
    }
    switch (req.action) {
      case 'list': {
        const data = { users: state.users, transactions: state.transactions, v: state.v };
        // v7 additions — omitted, not nulled, on older backends.
        if (state.v >= 7) {
          data.pin = state.pin;
          data.sheetUrl = state.sheetUrl;
        }
        return ok(data);
      }
      case 'addUser': {
        const replay = cidHit(req.cid, 'user_id', (id) => state.users.find((x) => same(x.user_id, id)));
        if (replay) return ok(replay);
        const u = {
          user_id: newId('u'), name: String(req.data.name || '').trim(),
          created_at: new Date().toISOString().slice(0, 10),
          phone: String(req.data.phone || '').trim(), cohort: '', last_reminded: '',
          token: 'tok_' + newId('n') + '_1234567890',
        };
        state.users.push(u);
        cidRemember(req.cid, u.user_id);
        return ok(u);
      }
      case 'updateUser': {
        const u = state.users.find((x) => same(x.user_id, req.id));
        if (!u) return err('User not found');
        Object.assign(u, { name: req.data.name ?? u.name, phone: req.data.phone ?? u.phone });
        // Passbook revoke/re-issue: '' revokes, and is stored as the sentinel
        // (a blank cell would be re-issued by the real backend's backfill).
        if (req.data.token !== undefined) {
          const t = String(req.data.token).trim();
          u.token = t === '' ? REVOKED_TOKEN : t;
        }
        return ok(u);
      }
      /* "Already gone" is success from v8 on: a delete that arrives twice has
         still done what it was asked to do, and failing it makes a retrying
         phone roll the delete back. A v7 deployment still says no. */
      case 'deleteUser': {
        if (!state.users.some((x) => same(x.user_id, req.id))) {
          return state.v >= 8 ? ok({ deleted: req.id, already: true })
                              : err('Error: Customer not found: ' + req.id);
        }
        state.users = state.users.filter((x) => !same(x.user_id, req.id));
        state.transactions = state.transactions.filter((x) => !same(x.user_name, req.id));
        return ok({ deleted: req.id });
      }
      case 'addTxn': {
        const replay = cidHit(req.cid, 'id', (id) => state.transactions.find((x) => same(x.id, id)));
        if (replay) return ok(replay);
        if (!req.data.user_id) return err('user_id is required');
        let photo = '';
        if (req.data.photo) { photo = newId('ph'); state.photos[photo] = req.data.photo; }
        const t = {
          id: newId('t'), user_name: req.data.user_id, date: req.data.date,
          type: req.data.type === 'received' ? 'received' : 'given',
          amount: Number(req.data.amount), comment: String(req.data.comment || ''), photo,
        };
        state.transactions.push(t);
        cidRemember(req.cid, t.id);
        return ok(t);
      }
      case 'updateTxn': {
        const t = state.transactions.find((x) => same(x.id, req.id));
        if (!t) return err('Entry not found');
        let photo = t.photo;
        if (req.data.photo === '') photo = '';
        else if (req.data.photo) { photo = newId('ph'); state.photos[photo] = req.data.photo; }
        Object.assign(t, {
          date: req.data.date, type: req.data.type,
          amount: Number(req.data.amount), comment: String(req.data.comment || ''), photo,
        });
        return ok(t);
      }
      case 'deleteTxn': {
        // Code.gs throws here pre-v8, and handle() reports it as String(err) —
        // hence the "Error: " prefix a real deployment puts on the wire. The
        // frontend's forgiveness matches that exact text, so the mock has to
        // carry it too.
        if (!state.transactions.some((x) => same(x.id, req.id))) {
          return state.v >= 8 ? ok({ deleted: req.id, already: true })
                              : err('Error: Transaction not found: ' + req.id);
        }
        state.transactions = state.transactions.filter((x) => !same(x.id, req.id));
        return ok({ deleted: req.id });
      }
      case 'photo': {
        const b64 = state.photos[req.id];
        if (!b64) return err('Photo not found');
        return ok({ b64, mime: 'image/png' });
      }
      case 'remindLog': {
        const u = state.users.find((x) => same(x.user_id, req.id));
        if (u) u.last_reminded = new Date().toISOString().slice(0, 10);
        return ok({ logged: true });
      }
      case 'setTxnPin': {
        // A pre-Suraksha backend has no such case — it hits its switch default.
        if (state.v < 7) return err('Unknown action: ' + req.action);
        if (String(req.admin ?? '') !== state.adminPin) return err('Master PIN galat hai');
        const p = String(req.pin ?? '');
        if (p === '') { state.pin = null; return ok({ set: false }); }
        if (!/^\d{4}$/.test(p)) return err('PIN 4 ank ka hona chahiye');
        const salt = ('ffee' + String(++n).padStart(12, '0'));  // 16 hex, like longId()
        state.pin = { salt, hash: pinHash(salt, p) };
        return ok({ set: true });
      }
      default:
        return err('Unknown action: ' + req.action);
    }
  }

  function fulfillJSON(route, body) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    });
  }

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push(request.url());   // arrived — recorded before any gating

    if (gate) await gate;                 // held open by hold(), released by the test
    if (state.mode === 'down') return route.abort('connectionfailed');
    if (state.mode === 'html') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Sign in - Google Accounts</body></html>' });
    }

    let req;
    if (request.method() === 'GET') {
      req = { action: url.searchParams.get('action'), key: url.searchParams.get('key'), token: url.searchParams.get('token') };
    } else {
      try { req = JSON.parse(request.postData() || '{}'); }
      catch { return fulfillJSON(route, { ok: false, error: 'Bad request body' }); }
    }

    /* 'drop-once' — the failure that costs real money. The write is APPLIED
       (row written, photo stored), and only then does the answer disappear:
       a dropped connection after the commit, which is indistinguishable on the
       phone from a write that never arrived. The phone must therefore retry,
       and the retry must not write the row again. Fires once, then the
       deployment is healthy — the retry is meant to succeed. */
    if (state.mode === 'drop-once' && MUTATIONS.has(req.action)) {
      state.mode = 'ok';
      api(req);
      return route.abort('connectionfailed');
    }
    return fulfillJSON(route, api(req));
  }

  return {
    state,
    setMode(m) { state.mode = m; },

    /* Freeze every reply until the returned function is called. Requests still
       arrive (state.requests grows), they simply do not finish — which is how
       a test can stand *inside* an in-flight call instead of racing it. */
    hold() {
      let release;
      gate = new Promise((r) => { release = r; });
      return () => { gate = null; release(); };
    },

    /* By default a backend answers for every script.google URL — most tests
       have exactly one deployment and the second one only has to differ as a
       string. `{ only: true }` scopes it to its own state.url instead, so two
       backends can be installed side by side and each one's log tells the
       truth about what was sent to IT. */
    async install(page, opts) {
      const only = !!(opts && opts.only);
      await page.route(
        (u) => (only ? u.href.startsWith(state.url) : u.href.startsWith('https://script.google')),
        handle
      );
    },
  };
}
