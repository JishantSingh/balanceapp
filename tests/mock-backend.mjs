/* In-process mock of the Bahi Apps Script backend (Code.gs v6 contract).
   Installed per-test via Playwright request routing, so every test gets an
   isolated "deployment" with its own sheet state and failure mode.

   Mirrors the real contract:
   - GET  ?action=list&key=…            → {ok, data:{users, transactions, v}}
   - POST text/plain JSON {action,key,…} → per-action data (full user / full txn)
   - errors are HTTP 200 with {ok:false, error} (Apps Script never 4xxs)
   Failure modes: 'ok' | 'badkey' | 'html' (sign-in page) | 'down' (network).

   Deliberately NOT emulated: Apps Script's 302 redirect dance. The browser
   follows redirects inside the network stack — below any app code — and
   Playwright cannot intercept the redirect hop, so emulating it tests
   nothing of ours and leaks requests to the real googleusercontent.com. */

export const MOCK_EXEC = 'https://script.google.com/macros/s/MOCKDEPLOY/exec';

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

export function createBackend(opts = {}) {
  const state = {
    key: opts.key ?? 'testkey',
    url: opts.url ?? MOCK_EXEC,  // which deployment this one answers for
    v: 6,
    mode: 'ok',
    users: opts.users ?? [],
    transactions: opts.transactions ?? [],
    photos: opts.photos ?? {},   // photoId -> b64
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

  function api(req) {
    state.log.push(req.action);
    if (req.action === 'passbook') {
      const t = String(req.token || '');
      if (t.length < 12) return err('Invalid passbook link');
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
      case 'list':
        return ok({ users: state.users, transactions: state.transactions, v: state.v });
      case 'addUser': {
        const u = {
          user_id: newId('u'), name: String(req.data.name || '').trim(),
          created_at: new Date().toISOString().slice(0, 10),
          phone: String(req.data.phone || '').trim(), cohort: '', last_reminded: '',
          token: 'tok_' + newId('n') + '_1234567890',
        };
        state.users.push(u);
        return ok(u);
      }
      case 'updateUser': {
        const u = state.users.find((x) => same(x.user_id, req.id));
        if (!u) return err('User not found');
        Object.assign(u, { name: req.data.name ?? u.name, phone: req.data.phone ?? u.phone });
        return ok(u);
      }
      case 'deleteUser':
        state.users = state.users.filter((x) => !same(x.user_id, req.id));
        state.transactions = state.transactions.filter((x) => !same(x.user_name, req.id));
        return ok({ deleted: true });
      case 'addTxn': {
        if (!req.data.user_id) return err('user_id is required');
        let photo = '';
        if (req.data.photo) { photo = newId('ph'); state.photos[photo] = req.data.photo; }
        const t = {
          id: newId('t'), user_name: req.data.user_id, date: req.data.date,
          type: req.data.type === 'received' ? 'received' : 'given',
          amount: Number(req.data.amount), comment: String(req.data.comment || ''), photo,
        };
        state.transactions.push(t);
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
      case 'deleteTxn':
        state.transactions = state.transactions.filter((x) => !same(x.id, req.id));
        return ok({ deleted: true });
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
