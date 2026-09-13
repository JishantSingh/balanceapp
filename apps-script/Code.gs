/**
 * Bahi — Google Sheets backend API (Khatabook-style udhaar ledger) · v9
 *
 * Sheets (columns are created/added automatically):
 *   "user":        user_id | name | created_at | phone | cohort | last_reminded | token
 *   "transaction": id | user_name | date | type | amount | comment | photo | photos
 *   "photo_uploads": persistent attachment reservations and cancellation history
 *     - "user_name" holds the customer's user_id (kept for AppSheet back-compat)
 *     - "type" is "given" (udhaar) or "received" (payment)
 *     - "cohort" is a reminder frequency: off | weekly | 15days | monthly
 *     - "token" is a per-customer secret for the read-only passbook link
 *       ("off" = link deliberately revoked; see REVOKED_TOKEN below)
 *     - "photos" is an ordered JSON array of {id, fileId}, up to five photos
 *     - "photo" is the first completed Drive file id for legacy clients
 *
 * Photos are stored in a "Bahi Photos" folder in YOUR Drive and served only
 * through this API (key required) — they are never made public.
 *
 * Retries are safe (v8). The phone queues every write and replays it until an
 * answer arrives, so an answer LOST after the row was already written used to
 * mean a second identical row (and a second uploaded photo). Two rules fix it:
 *   · addTxn/addUser accept an optional top-level `cid` — an opaque client id.
 *     The first insert remembers it; a replay with the same `cid` returns the
 *     row that insert made instead of writing another one.
 *   · deleteTxn/deleteUser treat "already gone" as success — a delete that
 *     arrives twice has still done exactly what it was asked to do.
 * (updateTxn/updateUser still fail on a missing row: a lost update is a real
 * conflict, not a duplicate.) Requests without `cid` behave exactly as v7 did.
 *
 * Script Properties this file owns (all survive self-updates):
 *   apiKey       — the API key (never in the code)
 *   adminPin     — 6-digit Master PIN ("Suraksha"); authorizes App-PIN changes.
 *                  NEVER returned by any API action — read it here in the
 *                  editor (Project Settings → Script Properties) if lost.
 *   txnPinSalt   — 16-hex salt for the 4-digit App PIN
 *   txnPinHash   — sha256(salt + ':' + pin), lowercase hex. Ships in `list`
 *                  so every device sharing the ledger can verify offline.
 *
 * Setup:
 *  1. Spreadsheet → Extensions → Apps Script; paste this file into Code.gs.
 *  2. Project Settings (gear) → show appsscript.json → paste the standard
 *     manifest from this repo (this spreadsheet, app-created Drive files,
 *     external requests). No new scopes are needed for v9.
 *  3. In the editor, run the function `setup` once and grant access — the
 *     log prints your API key and Master PIN. (Upgrading from v3? Your API_KEY
 *     constant is adopted automatically; you can leave it in place.)
 *  4. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).
 *     Updates in standard mode require Manage deployments → New version.
 *     Optional self-updating mode and its extra permissions are in SETUP.md.
 */

// Legacy shim (pre-v4 installs set the key here). The real key lives in
// Script Properties so that auto-updates — which overwrite this file —
// can never clobber it. Rotation: edit the `apiKey` Script Property.
const API_KEY = 'change-me-to-a-long-random-string';

function apiKey_() {
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty('apiKey');
  if (!k) {
    k = (API_KEY && API_KEY !== 'change-me-to-a-long-random-string')
      ? API_KEY
      : Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('apiKey', k);
  }
  return k;
}

/** The Master PIN (Suraksha): 6 digits, minted once, kept only in Script
 *  Properties. It authorizes setting/changing/removing the 4-digit App PIN and
 *  is never returned by any action — losing it means reading the property in
 *  the editor, which is exactly the escape hatch we want (only the sheet's
 *  owner can do that). */
function adminPin_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('adminPin');
  if (!p) {
    // Utilities.getUuid() is a type-4 UUID off Java's SecureRandom — a CSPRNG,
    // unlike Math.random(). The last 12 hex chars carry no version/variant
    // bits, so they're 48 fully random bits (still an exact double); folding
    // them to six digits biases the low values by ~1 part in 2.8e8.
    const hex = Utilities.getUuid().replace(/-/g, '').slice(-12);
    p = ('00000' + (parseInt(hex, 16) % 1000000)).slice(-6);
    props.setProperty('adminPin', p);
  }
  return p;
}

// Backend version + where released code is published. The self-updater
// refuses anything whose hashes don't match the release manifest.
const BAHI_VERSION = 9;
const RELEASE_BASE = 'https://raw.githubusercontent.com/JishantSingh/balanceapp/main/apps-script/';
const RELEASE_MANIFEST = RELEASE_BASE + 'release.json';

const USER_SHEET = 'user';
const USER_HEADERS = ['user_id', 'name', 'created_at', 'phone', 'cohort', 'last_reminded', 'token'];
const TXN_SHEET = 'transaction';
const TXN_HEADERS = ['id', 'user_name', 'date', 'type', 'amount', 'comment', 'photo', 'photos'];
const MAX_PHOTOS = 5;
const UPLOAD_HEADERS = ['upload_id', 'txn_id', 'file_id', 'replaces_id', 'replaces_file_id', 'state', 'position', 'digest', 'source_txn'];
const PHOTO_FOLDER = 'Bahi Photos';
const MAX_PHOTO_B64 = 2 * 1024 * 1024; // ~1.5MB image

/** Sentinel written into a customer's `token` cell when their passbook link is
 *  revoked. It cannot be blank: backfillTokens() mints a token for every row
 *  whose cell is empty, so an emptied cell would be silently re-issued on the
 *  very next `list` — revocation has to look "already set" to the backfill and
 *  invalid to `passbook`. "off" is both (and matches the cohort vocabulary).
 *  Real tokens are 16 hex chars, so no token can ever collide with it. */
const REVOKED_TOKEN = 'off';

function doGet(e) {
  return handle(e.parameter || {});
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ ok: false, error: 'Invalid JSON body' });
  }
  return handle(body);
}

function handle(req) {
  // The passbook is the one keyless action: read-only, single customer,
  // gated by that customer's own unguessable token.
  if (req.action === 'passbook') {
    try {
      return respond({ ok: true, data: passbook(String(req.token || '')) });
    } catch (err) {
      return respond({ ok: false, error: String(err) });
    }
  }

  if (req.key !== apiKey_()) {
    return respond({ ok: false, error: 'Unauthorized: bad or missing key' });
  }
  try {
    switch (req.action) {
      case 'list':
        return respond({ ok: true, data: withLock(listAll) });
      case 'addUser':
        return respond({ ok: true, data: withLock(addUser, req.data, req.cid) });
      case 'updateUser':
        return respond({ ok: true, data: withLock(updateUser, req.id, req.data) });
      case 'deleteUser':
        return respond({ ok: true, data: withLock(deleteUser, req.id) });
      case 'addTxn':
        return respond({ ok: true, data: withLock(addTxn, req.data, req.cid) });
      case 'updateTxn':
        return respond({ ok: true, data: withLock(updateTxn, req.id, req.data) });
      case 'deleteTxn':
        return respond({ ok: true, data: withLock(deleteTxn, req.id) });
      case 'photo':
        return respond({ ok: true, data: getPhoto(req.id) });
      case 'uploadTxnPhoto':
        return respond({ ok: true, data: withLock(uploadTxnPhoto, req.id, req.attachmentId, req.b64, req.replacesId) });
      case 'removeTxnPhoto':
        return respond({ ok: true, data: withLock(removeTxnPhoto, req.id, req.attachmentId) });
      case 'restoreTxnPhoto':
        return respond({ ok: true, data: withLock(restoreTxnPhoto, req.id, req.attachmentId, req.sourceTxnId, req.sourceAttachmentId) });
      case 'remindLog':
        return respond({ ok: true, data: withLock(remindLog, req.id) });
      case 'setTxnPin':
        return respond({ ok: true, data: withLock(setTxnPin, req.admin, req.pin) });
      case 'update':
        return respond({ ok: true, data: checkForUpdate() });
      default:
        return respond({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return respond({ ok: false, error: String(err), code: err.code || 'SERVER_ERROR' });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const args = Array.prototype.slice.call(arguments, 1);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn.apply(null, args);
  } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

// ---------- sheets ----------

function ensureSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  const width = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  headers.forEach(function (h) {
    if (existing.indexOf(h) === -1) {
      sheet.getRange(1, existing.length + 1).setValue(h).setFontWeight('bold');
      existing.push(h);
    }
  });
  return sheet;
}

function userSheet() { return ensureSheet(USER_SHEET, USER_HEADERS); }
function txnSheet() { return ensureSheet(TXN_SHEET, TXN_HEADERS); }

function headerMap(sheet) {
  const width = sheet.getLastColumn();
  const row = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  const map = {};
  row.forEach(function (h, i) { if (h) map[h] = i; });
  return map;
}

// Skips blank spacer rows (AppSheet leftovers) by requiring the id column.
function listRows(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const map = headerMap(sheet);
  const width = sheet.getLastColumn();
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const idCol = map[headers[0]];
  const out = [];
  values.forEach(function (row, i) {
    if (row[idCol] === '') return;
    const obj = { _row: i + 2 };
    headers.forEach(function (h) {
      obj[h] = map[h] === undefined ? '' : serialize(row[map[h]]);
    });
    out.push(obj);
  });
  return out;
}

function listAll() {
  backfillTokens();
  adminPin_(); // mint on first sync: deployments upgraded by the self-updater
               // never re-run setup(), and the owner must be able to find the
               // Master PIN in Script Properties. Never sent to the client.
  const users = listRows(userSheet(), USER_HEADERS);
  const txns = listRows(txnSheet(), TXN_HEADERS);
  users.forEach(function (u) { delete u._row; });
  txns.forEach(function (t) { delete t._row; shapePhotos(t); });
  return {
    users: users,
    transactions: txns,
    v: BAHI_VERSION,
    capabilities: { multiPhoto: true, maxPhotos: MAX_PHOTOS },
    // App-PIN material for offline verification on every device sharing this
    // ledger — salt+hash only, never the PIN. null = no PIN configured.
    pin: txnPin_(),
    // "Open my sheet" / trust affordance. getUrl() reads the spreadsheet the
    // script is bound to, so the existing spreadsheets.currentonly scope
    // covers it — no manifest change in this release.
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  };
}

// Every customer gets a token so passbook links can be built. A revoked link
// keeps the REVOKED_TOKEN sentinel here, so this never re-issues one.
function backfillTokens() {
  const sheet = userSheet();
  const map = headerMap(sheet);
  const rows = listRows(sheet, USER_HEADERS);
  rows.forEach(function (u) {
    if (!u.token) {
      sheet.getRange(u._row, map.token + 1).setValue(longId());
    }
    if (!u.cohort) {
      sheet.getRange(u._row, map.cohort + 1).setValue('monthly');
    }
  });
}

function serialize(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return value;
}

// Accepts "yyyy-MM-dd" (from the app) or "dd/MM/yyyy" (legacy rows)
function parseDate(str) {
  if (!str) return new Date();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return new Date();
}

function shortId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function longId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function findRow(sheet, idHeader, id) {
  const map = headerMap(sheet);
  const col = map[idHeader] + 1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function readCell(sheet, rowNum, header) {
  const map = headerMap(sheet);
  if (map[header] === undefined) return '';
  return sheet.getRange(rowNum, map[header] + 1).getValue();
}

function writeRow(sheet, headers, rowNum, obj) {
  const map = headerMap(sheet);
  headers.forEach(function (h) {
    if (map[h] !== undefined && obj[h] !== undefined) {
      sheet.getRange(rowNum, map[h] + 1).setValue(obj[h]);
    }
  });
}

// One row, shaped exactly like `list` shapes it (dates serialized, missing
// columns blank) — so a replayed insert answers with the same row the original
// insert answered with.
function readRow(sheet, headers, rowNum) {
  const map = headerMap(sheet);
  const values = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  const obj = {};
  headers.forEach(function (h) {
    obj[h] = map[h] === undefined ? '' : serialize(values[map[h]]);
  });
  return obj;
}

// ---------- idempotent inserts (client id) ----------
// The phone keeps every write queued until an answer arrives, so an answer lost
// AFTER the row was written comes back as a retry. `cid` — an opaque id the
// client mints once per queued write — turns that retry into a replay: the id
// of the row the first attempt created is remembered here, and the retry gets
// that row back instead of writing a second one (and, for a photo, uploading a
// second file). CacheService is per-script, ephemeral and needs NO OAuth
// scope; 6 hours is its ceiling and far outlives any retry loop. A request
// without `cid` (an older frontend) takes exactly the v7 path.

const CID_TTL = 21600;   // 6 hours — CacheService's maximum

function cidKey(cid) {
  // Cache keys are capped at 250 chars; ours are ~20, but a client is not
  // trusted to keep them short.
  const s = String(cid === undefined || cid === null ? '' : cid).slice(0, 200);
  return s ? 'cid:' + s : '';
}

function cidLookup(key) {
  return key ? CacheService.getScriptCache().get(key) : null;
}

function cidRemember(key, id) {
  if (key) CacheService.getScriptCache().put(key, String(id), CID_TTL);
}

// ---------- users ----------

const COHORTS = ['off', 'weekly', '15days', 'monthly'];

function cleanCohort(v) {
  return COHORTS.indexOf(String(v)) !== -1 ? String(v) : 'monthly';
}

function addUser(data, cid) {
  const sheet = userSheet();
  const key = cidKey(cid);
  const hit = cidLookup(key);
  if (hit) {
    // This request already ran; its answer just never got home. Replay the row
    // it made. If that row has since been deleted, the id is the only honest
    // thing left to say — the client remaps to it and the next `list`
    // reconciles the row away.
    const was = findRow(sheet, 'user_id', hit);
    return was === -1 ? { user_id: hit, replayed: true } : readRow(sheet, USER_HEADERS, was);
  }
  const user = {
    user_id: shortId(),
    name: String(data.name || '').trim(),
    created_at: new Date(),
    phone: String(data.phone || '').trim(),
    cohort: cleanCohort(data.cohort),
    last_reminded: '',
    token: longId(),
  };
  if (!user.name) throw new Error('Name is required');
  writeRow(sheet, USER_HEADERS, sheet.getLastRow() + 1, user);
  user.created_at = serialize(user.created_at);
  cidRemember(key, user.user_id);
  return user;
}

function updateUser(id, data) {
  const sheet = userSheet();
  const row = findRow(sheet, 'user_id', id);
  if (row === -1) throw new Error('Customer not found: ' + id);
  const patch = { user_id: id };
  if (data.name !== undefined) patch.name = String(data.name).trim();
  if (data.phone !== undefined) patch.phone = String(data.phone).trim();
  if (data.cohort !== undefined) patch.cohort = cleanCohort(data.cohort);
  // Passbook revoke/re-issue. '' means "revoke", which we store as the
  // REVOKED_TOKEN sentinel rather than a blank cell — see REVOKED_TOKEN.
  if (data.token !== undefined) {
    const t = String(data.token).trim();
    patch.token = t === '' ? REVOKED_TOKEN : t;
  }
  writeRow(sheet, Object.keys(patch), row, patch);
  return patch;
}

function remindLog(id) {
  const sheet = userSheet();
  const row = findRow(sheet, 'user_id', id);
  if (row === -1) throw new Error('Customer not found: ' + id);
  writeRow(sheet, ['last_reminded'], row, { last_reminded: new Date() });
  return { id: id, last_reminded: serialize(new Date()) };
}

// Deletes the customer AND all their transactions (photos are trashed too).
// "Already gone" is success, exactly as in deleteTxn above.
function deleteUser(id) {
  const uSheet = userSheet();
  const row = findRow(uSheet, 'user_id', id);
  if (row === -1) { cleanupRetiredPhotos(); return { deleted: id, already: true }; }

  const tSheet = txnSheet();
  const map = headerMap(tSheet);
  const lastRow = tSheet.getLastRow();
  let removed = 0;
  let photoFiles = [];
  if (lastRow >= 2) {
    const values = tSheet.getRange(2, 1, lastRow - 1, tSheet.getLastColumn()).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      if (String(values[i][map.user_name]) === String(id)) {
        photoFiles = photoFiles.concat(preparePhotoDeletion(String(values[i][map.id]),
          shapePhotos(readRow(tSheet, TXN_HEADERS, i + 2)).photos));
        tSheet.deleteRow(i + 2);
        removed++;
      }
    }
  }
  uSheet.deleteRow(row);
  SpreadsheetApp.flush();
  photoFiles.forEach(trashUnreferenced);
  cleanupRetiredPhotos(); // includes earlier rows from an interrupted customer delete
  return { deleted: id, transactionsRemoved: removed };
}

// ---------- passbook (read-only, token-gated) ----------

function passbook(token) {
  // The length floor already excludes the revoke sentinel; it is named here so
  // the rule survives any future change to either value.
  if (!token || token.length < 12 || token === REVOKED_TOKEN) {
    throw new Error('Invalid passbook link');
  }
  const users = listRows(userSheet(), USER_HEADERS);
  const match = users.filter(function (u) {
    return String(u.token) === token && String(u.token) !== REVOKED_TOKEN;
  })[0];
  if (!match) throw new Error('This passbook link is no longer valid');
  const txns = listRows(txnSheet(), TXN_HEADERS)
    .filter(function (t) { return String(t.user_name) === String(match.user_id); })
    .map(function (t) {
      return { date: t.date, type: t.type, amount: t.amount, comment: t.comment };
    });
  return { name: match.name, transactions: txns };
}

// ---------- PIN Suraksha (two-tier PIN) ----------
// Master PIN (adminPin_) authorizes changes to the App PIN, server-side only.
// The App PIN is 4 digits; we keep a salted SHA-256 of it and ship salt+hash
// in `list` so every device sharing the ledger verifies OFFLINE — the PIN
// itself never leaves the device that types it, and never reaches the sheet.
// Threat model: casual misuse on a shared shop phone (staff/family). Anyone
// who can read `list` can brute-force 10^4 hashes; this is a lock on a drawer,
// not a safe, and no UI may claim otherwise.

function txnPin_() {
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('txnPinSalt');
  const hash = props.getProperty('txnPinHash');
  return (salt && hash) ? { salt: salt, hash: hash } : null;
}

/** setTxnPin: admin = Master PIN, pin = 4 digits (or '' to remove). */
function setTxnPin(admin, pin) {
  if (String(admin === undefined || admin === null ? '' : admin) !== adminPin_()) {
    throw new Error('Master PIN galat hai');
  }
  const props = PropertiesService.getScriptProperties();
  const p = String(pin === undefined || pin === null ? '' : pin);
  if (p === '') {
    props.deleteProperty('txnPinSalt');
    props.deleteProperty('txnPinHash');
    return { set: false };
  }
  if (!/^\d{4}$/.test(p)) throw new Error('PIN 4 ank ka hona chahiye');
  const salt = longId(); // fresh every set — changing the PIN re-salts
  props.setProperty('txnPinSalt', salt);
  props.setProperty('txnPinHash', sha256Hex_(salt + ':' + p));
  return { set: true };
}

// ---------- transactions ----------

function buildTxn(id, data, existingPhoto) {
  const type = data.type === 'received' ? 'received' : 'given';
  const amount = Number(data.amount);
  if (!(amount > 0)) throw new Error('Amount must be a positive number');
  return {
    id: id,
    user_name: String(data.user_id || data.user_name || ''),
    date: parseDate(data.date),
    type: type,
    amount: amount,
    comment: String(data.comment || ''),
    photo: existingPhoto || '',
  };
}

// data.photo: undefined → keep existing · '' → remove · base64 → replace
function resolveLegacyPhotos(incoming, photos) {
  if (incoming === undefined) return photos;
  if (incoming === '') return photos.slice(1);
  const fileId = savePhoto(String(incoming));
  return [{ id: fileId, fileId: fileId }].concat(photos.slice(1));
}

function addTxn(data, cid) {
  const sheet = txnSheet();
  const key = cidKey(cid);
  const hit = cidLookup(key);
  if (hit) {
    // A replay — see addUser. Answering before buildTxn also means the photo
    // bytes riding along on this retry are never uploaded a second time.
    const was = findRow(sheet, 'id', hit);
    return was === -1 ? { id: hit, replayed: true } : shapePhotos(readRow(sheet, TXN_HEADERS, was));
  }
  const txn = buildTxn(shortId(), data, '');
  if (!txn.user_name) throw new Error('user_id is required');
  txn.photos = resolveLegacyPhotos(data.photo, []);
  txn.photo = txn.photos.length ? txn.photos[0].fileId : '';
  const stored = Object.assign({}, txn, { photos: JSON.stringify(txn.photos) });
  writeRow(sheet, TXN_HEADERS, sheet.getLastRow() + 1, stored);
  SpreadsheetApp.flush();
  txn.date = serialize(txn.date);
  cidRemember(key, txn.id);
  return txn;
}

function updateTxn(id, data) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) throw new Error('Transaction not found: ' + id);
  const before = shapePhotos(readRow(sheet, TXN_HEADERS, row));
  const txn = buildTxn(id, data, before.photo);
  txn.photos = resolveLegacyPhotos(data.photo, before.photos);
  txn.photo = txn.photos.length ? txn.photos[0].fileId : '';
  // Record originals before replacement/removal so Undo can restore from Drive.
  before.photos.forEach(function (p, i) { rememberPhoto(id, p, i); });
  writeTxnValues(sheet, row, Object.assign({}, txn, { photos: JSON.stringify(txn.photos) }));
  if (data.photo !== undefined && before.photos.length) {
    cancelRelatedUploads(id, before.photos[0].id);
    trashUnreferenced(before.photos[0].fileId);
  }
  txn.date = serialize(txn.date);
  return txn;
}

/* Deleting a row that is not here is not an error: either this delete already
   landed and only its answer was lost, or somebody else removed the row. Both
   end in the state the caller asked for. Failing instead would make a retrying
   phone roll the delete back and resurrect the entry. */
function deleteTxn(id) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) {
    uploadsFor(id).forEach(function (u) { trashUnreferenced(u.file_id); });
    return { deleted: id, already: true };
  }
  const files = preparePhotoDeletion(id, shapePhotos(readRow(sheet, TXN_HEADERS, row)).photos);
  sheet.deleteRow(row);
  SpreadsheetApp.flush();
  files.forEach(trashUnreferenced);
  return { deleted: id };
}

// ---------- v9 attachment metadata and persistent upload journal ----------

function photoError(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function shapePhotos(txn) {
  let photos = txn.photos;
  if (typeof photos === 'string' && photos) {
    try { photos = JSON.parse(photos); }
    catch (e) { photoError('PHOTO_METADATA', 'Photo metadata is invalid; restore the photos cell'); }
    if (!Array.isArray(photos)) photoError('PHOTO_METADATA', 'Photo metadata must be a list');
  }
  if (!Array.isArray(photos)) {
    photos = txn.photo ? [{ id: String(txn.photo), fileId: String(txn.photo) }] : [];
  }
  txn.photos = photos.map(function (p) {
    if (!p || !p.id || !p.fileId) photoError('PHOTO_METADATA', 'Photo metadata is incomplete');
    return { id: String(p.id), fileId: String(p.fileId) };
  });
  txn.photo = txn.photos.length ? txn.photos[0].fileId : '';
  return txn;
}

function writeTxnValues(sheet, row, patch) {
  const map = headerMap(sheet);
  const range = sheet.getRange(row, 1, 1, sheet.getLastColumn());
  const values = range.getValues()[0];
  Object.keys(patch).forEach(function (k) { if (map[k] !== undefined) values[map[k]] = patch[k]; });
  range.setValues([values]);
  SpreadsheetApp.flush();
}

function setTxnPhotos(id, photos) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) photoError('ENTRY_MISSING', 'Entry was removed; photo cannot be attached');
  writeTxnValues(sheet, row, { photos: JSON.stringify(photos), photo: photos.length ? photos[0].fileId : '' });
}

function getTxnPhotos(id) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) photoError('ENTRY_MISSING', 'Entry was removed; photo cannot be attached');
  return shapePhotos(readRow(sheet, TXN_HEADERS, row)).photos;
}

function uploadSheet() { return ensureSheet('photo_uploads', UPLOAD_HEADERS); }
function uploadsFor(id) {
  return listRows(uploadSheet(), UPLOAD_HEADERS).filter(function (u) { return String(u.txn_id) === String(id); });
}
function findUpload(id) {
  const sheet = uploadSheet();
  const row = findRow(sheet, 'upload_id', id);
  return row === -1 ? null : Object.assign(readRow(sheet, UPLOAD_HEADERS, row), { _row: row });
}
function writeUpload(record) {
  const sheet = uploadSheet();
  const row = record._row || sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, UPLOAD_HEADERS.length).setValues([
    UPLOAD_HEADERS.map(function (h) { return record[h] === undefined ? '' : record[h]; }),
  ]);
  SpreadsheetApp.flush(); // file creation must never precede this reservation
  record._row = row;
  return record;
}
function rememberPhoto(txnId, photo, position) {
  const found = findUpload(photo.id);
  if (found) return found;
  return writeUpload({
    upload_id: photo.id, txn_id: String(txnId), file_id: photo.fileId,
    replaces_id: '', replaces_file_id: '', state: 'done', position: position, digest: '', source_txn: '',
  });
}
function validAttachmentId(id) {
  id = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) photoError('PHOTO_ID', 'Invalid attachment id');
  return id;
}

function reserveUpload(txnId, attachmentId, replacesId, digest, source) {
  const photos = getTxnPhotos(txnId);
  const existing = findUpload(attachmentId);
  if (existing) {
    if (String(existing.txn_id) === String(txnId) &&
        (existing.state === 'cancelled' || existing.state === 'removed')) return existing;
    if (String(existing.txn_id) !== String(txnId) || String(existing.digest) !== digest ||
        String(existing.replaces_id) !== replacesId || String(existing.source_txn) !== source) {
      photoError('PHOTO_CONFLICT', 'This photo id was already used for another operation');
    }
    return existing;
  }
  photos.forEach(function (p, i) { rememberPhoto(txnId, p, i); });
  const history = uploadsFor(txnId);
  const target = photos.find(function (p) { return p.id === replacesId; });
  if (replacesId && !target) photoError('PHOTO_CONFLICT', 'Photo changed on another device; reopen the entry');
  const pendingAdds = history.filter(function (u) {
    return u.state === 'reserved' && !u.replaces_id && !photos.some(function (p) { return p.id === u.upload_id; });
  }).length;
  if (!replacesId && photos.length + pendingAdds >= MAX_PHOTOS) photoError('PHOTO_LIMIT', 'An entry can have up to five photos');
  const targetRecord = target && findUpload(target.id);
  const position = targetRecord ? Number(targetRecord.position) :
    Math.max(-1, ...history.map(function (u) { return Number(u.position) || 0; })) + 1;
  // Reserve the ID before creating a Drive file. Retrying after a lost create
  // response uses this same ID, including after the CacheService TTL expires.
  const fileId = source ? '' : Drive.Files.generateIds({ count: 1, space: 'drive', type: 'files' }).ids[0];
  return writeUpload({
    upload_id: attachmentId, txn_id: String(txnId), file_id: fileId,
    replaces_id: replacesId, replaces_file_id: target ? target.fileId : '',
    state: 'reserved', position: position, digest: digest, source_txn: source,
  });
}

function photoResult(record) {
  return { attachment: { id: String(record.upload_id), fileId: String(record.file_id) },
    photos: getTxnPhotos(record.txn_id), cancelled: record.state === 'cancelled' || record.state === 'removed' };
}

function completeUpload(record) {
  let photos = getTxnPhotos(record.txn_id);
  if (photos.some(function (p) { return p.id === record.upload_id; })) {
    record.state = 'done'; writeUpload(record);
    if (record.replaces_file_id) trashUnreferenced(record.replaces_file_id);
    return photoResult(record);
  }
  if (record.replaces_id) {
    const at = photos.findIndex(function (p) { return p.id === record.replaces_id; });
    if (at === -1) photoError('PHOTO_CONFLICT', 'Photo changed on another device; reopen the entry');
    photos.splice(at, 1, { id: record.upload_id, fileId: record.file_id });
  } else {
    if (photos.length >= MAX_PHOTOS) photoError('PHOTO_LIMIT', 'An entry can have up to five photos');
    const at = photos.findIndex(function (p) {
      const u = findUpload(p.id);
      return u && Number(u.position) > Number(record.position);
    });
    photos.splice(at === -1 ? photos.length : at, 0, { id: record.upload_id, fileId: record.file_id });
  }
  setTxnPhotos(record.txn_id, photos);
  record.state = 'done'; writeUpload(record);
  if (record.replaces_file_id) trashUnreferenced(record.replaces_file_id);
  return photoResult(record);
}

function uploadTxnPhoto(txnId, attachmentId, b64, replacesId) {
  attachmentId = validAttachmentId(attachmentId);
  replacesId = String(replacesId || '');
  b64 = String(b64 || '');
  if (!b64 || b64.length > MAX_PHOTO_B64) photoError('PHOTO_SIZE', 'Photo is missing or too large');
  const record = reserveUpload(txnId, attachmentId, replacesId, sha256Hex_(b64), '');
  if (record.state !== 'reserved') {
    // A previous run may have stopped after committing the journal, before
    // trashing the replaced/cancelled file. Retrying must finish that cleanup.
    if (record.state === 'done' && record.replaces_file_id) trashUnreferenced(record.replaces_file_id);
    if (record.state === 'cancelled' || record.state === 'removed') trashUnreferenced(record.file_id);
    return photoResult(record);
  }
  // A retry after the row write succeeded only needs to finish the journal.
  if (getTxnPhotos(txnId).some(function (p) { return p.id === attachmentId; })) return completeUpload(record);
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'bahi-' + attachmentId + '.jpg');
  try {
    Drive.Files.create({ id: record.file_id, name: blob.getName(), parents: [photoFolder()] }, blob);
  } catch (err) {
    // Drive returns a conflict for a previously created, pre-generated ID.
    // Confirm that file exists before considering the upload successful.
    let file;
    try { file = Drive.Files.get(record.file_id, { fields: 'id,trashed,parents,mimeType' }); }
    catch (lookupError) { throw err; }
    if (file.trashed || !file.parents || file.parents.indexOf(photoFolder()) === -1 ||
        file.mimeType !== 'image/jpeg') throw err;
  }
  return completeUpload(record);
}

function cancelRelatedUploads(txnId, attachmentId) {
  const records = uploadsFor(txnId).filter(function (u) {
    return String(u.upload_id) === String(attachmentId) ||
      (u.state === 'reserved' && String(u.replaces_id) === String(attachmentId));
  });
  records.forEach(function (u) { u.state = 'cancelled'; writeUpload(u); });
  return records.map(function (u) { return u.file_id; }).filter(Boolean);
}

function removeTxnPhoto(txnId, attachmentId) {
  attachmentId = validAttachmentId(attachmentId);
  const sheet = txnSheet(), row = findRow(sheet, 'id', txnId);
  const photos = row === -1 ? [] : shapePhotos(readRow(sheet, TXN_HEADERS, row)).photos;
  photos.forEach(function (p, i) { rememberPhoto(txnId, p, i); });
  const files = cancelRelatedUploads(txnId, attachmentId);
  if (!findUpload(attachmentId)) {
    // Removal may beat the first upload request; the tombstone prevents it
    // from attaching later when that old queued request finally arrives.
    writeUpload({ upload_id: attachmentId, txn_id: String(txnId), file_id: '', replaces_id: '',
      replaces_file_id: '', state: 'cancelled', position: 0, digest: '', source_txn: '' });
  }
  if (row !== -1) setTxnPhotos(txnId, photos.filter(function (p) { return p.id !== attachmentId; }));
  files.forEach(trashUnreferenced);
  return { removed: attachmentId, photos: row === -1 ? [] : getTxnPhotos(txnId) };
}

function preparePhotoDeletion(txnId, photos) {
  photos.forEach(function (p, i) { rememberPhoto(txnId, p, i); });
  const records = uploadsFor(txnId);
  records.forEach(function (u) { u.state = u.state === 'done' ? 'removed' : 'cancelled'; writeUpload(u); });
  return records.map(function (u) { return u.file_id; }).filter(Boolean);
}

function fileReferenced(fileId, exceptTxn) {
  return listRows(txnSheet(), TXN_HEADERS).some(function (t) {
    return String(t.id) !== String(exceptTxn || '') &&
      shapePhotos(t).photos.some(function (p) { return p.fileId === String(fileId); });
  });
}
function trashUnreferenced(fileId) {
  if (fileId && !fileReferenced(fileId)) trashPhoto(fileId);
}
function cleanupRetiredPhotos() {
  listRows(uploadSheet(), UPLOAD_HEADERS).filter(function (u) {
    return u.state === 'removed' || u.state === 'cancelled';
  }).forEach(function (u) { trashUnreferenced(u.file_id); });
}

function restoreTxnPhoto(txnId, attachmentId, sourceTxnId, sourceAttachmentId) {
  attachmentId = validAttachmentId(attachmentId);
  const source = findUpload(String(sourceAttachmentId));
  if (!source || String(source.txn_id) !== String(sourceTxnId) || !source.file_id) {
    photoError('PHOTO_MISSING', 'Original photo cannot be restored');
  }
  const record = reserveUpload(txnId, attachmentId, '', '', String(sourceTxnId) + ':' + String(sourceAttachmentId));
  if (record.state !== 'reserved') return photoResult(record);
  if (fileReferenced(source.file_id, txnId)) photoError('PHOTO_CONFLICT', 'Photo is attached to another entry');
  record.file_id = source.file_id; writeUpload(record);
  Drive.Files.update({ trashed: false }, source.file_id);
  return completeUpload(record);
}

// ---------- photos (merchant's own Drive, private) ----------
// Uses the Advanced Drive Service (v3) rather than DriveApp: DriveApp demands
// the full-Drive scope, while the advanced service honors the narrow
// drive.file scope ("files created by this app" only).

function photoFolder() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('photoFolderId');
  if (saved) {
    try {
      const f = Drive.Files.get(saved, { fields: 'id,trashed' });
      if (!f.trashed) return saved;
    } catch (e) { /* folder was deleted — recreate */ }
  }
  const folder = Drive.Files.create({
    name: PHOTO_FOLDER,
    mimeType: 'application/vnd.google-apps.folder',
  });
  props.setProperty('photoFolderId', folder.id);
  return folder.id;
}

function savePhoto(b64) {
  if (b64.length > MAX_PHOTO_B64) throw new Error('Photo too large — try again, it will be compressed more');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'bahi-' + shortId() + '.jpg');
  const file = Drive.Files.create({ name: blob.getName(), parents: [photoFolder()] }, blob);
  return file.id;
}

function getPhoto(fileId) {
  if (!fileId) throw new Error('Missing photo id');
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(String(fileId)) + '?alt=media',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error('Photo not found');
  const blob = res.getBlob();
  return { b64: Utilities.base64Encode(blob.getBytes()), mime: blob.getContentType() || 'image/jpeg' };
}

function trashPhoto(fileId) {
  try {
    Drive.Files.update({ trashed: true }, String(fileId));
  } catch (e) { /* already gone — ignore */ }
}

// ---------- self-updater ----------
// The script updates ITSELF: a daily trigger fetches the release manifest
// from the public repo, verifies every file's SHA-256 against it, rewrites
// this project via the Apps Script API, and repoints the existing web-app
// deployment at the new version — the /exec URL (and every link built on
// it) never changes. Two safety rules:
//   · files that don't hash-match the manifest are never applied;
//   · a release whose manifest asks for NEW OAuth scopes is never applied
//     silently — it waits for the owner (updates can't grow their own
//     permissions).

/** Run me once from the editor after pasting: authorizes everything,
 *  adopts/mints the API key, and (in auto-update mode) installs the daily
 *  update check. Standard installs use the narrow manifest, which lacks
 *  the trigger scope — that's fine, updates are just manual for them. */
function setup() {
  userSheet();
  txnSheet();
  photoFolder();
  let auto = true;
  try {
    ensureUpdateTrigger();
  } catch (e) {
    auto = false; // narrow manifest (standard mode) — no trigger scope
  }
  const msg = 'Bahi v' + BAHI_VERSION + ' ready — auto-update ' +
    (auto ? 'is ON' : 'OFF (standard mode; see SETUP.md to enable)') +
    '. API key: ' + apiKey_() +
    ' · Master PIN (Suraksha): ' + adminPin_() +
    ' — likh kar rakhein; app me kabhi store nahi hota';
  console.log(msg);
  return msg;
}

function ensureUpdateTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'checkForUpdate';
  });
  if (!exists) {
    ScriptApp.newTrigger('checkForUpdate').timeBased().everyDays(1).create();
  }
}

function checkForUpdate() {
  const props = PropertiesService.getScriptProperties();
  try {
    const result = applyUpdate_();
    props.setProperty('lastUpdateCheck', new Date().toISOString() + ' · ' + result.status);
    return result;
  } catch (err) {
    // Never let the daily trigger die loudly; record and report instead.
    props.setProperty('lastUpdateError', new Date().toISOString() + ' · ' + String(err));
    return { status: 'error', error: String(err), current: BAHI_VERSION };
  }
}

function applyUpdate_() {
  const bust = '?t=' + Date.now(); // raw.githubusercontent CDN cache-buster
  const manifest = JSON.parse(UrlFetchApp.fetch(RELEASE_MANIFEST + bust).getContentText());
  if (!(Number(manifest.version) > BAHI_VERSION)) {
    return { status: 'up-to-date', current: BAHI_VERSION };
  }

  // Fetch + hash-verify every released file.
  const incoming = manifest.files.map(function (f) {
    const source = UrlFetchApp.fetch(RELEASE_BASE + f.path + bust).getContentText();
    if (sha256Hex_(source) !== f.sha256) {
      throw new Error('Hash mismatch for ' + f.name + ' — refusing to update');
    }
    return { name: f.name, type: f.type, source: source };
  });

  // Scope guard: silently applying a permission change is forbidden.
  const current = scriptApi_('get', '/content');
  const curManifest = current.files.filter(function (f) { return f.name === 'appsscript'; })[0];
  const newManifest = incoming.filter(function (f) { return f.name === 'appsscript'; })[0];
  if (curManifest && newManifest) {
    const curScopes = (JSON.parse(curManifest.source).oauthScopes || []);
    const newScopes = (JSON.parse(newManifest.source).oauthScopes || []);
    const added = newScopes.filter(function (s) { return curScopes.indexOf(s) === -1; });
    if (added.length) {
      return {
        status: 'needs-manual-update', current: BAHI_VERSION,
        available: manifest.version, reason: 'new permissions required: ' + added.join(', '),
      };
    }
  }

  // Upsert released files into the project, preserving any extra files.
  const files = current.files.map(function (f) {
    const repl = incoming.filter(function (n) { return n.name === f.name; })[0];
    return repl || { name: f.name, type: f.type, source: f.source };
  });
  incoming.forEach(function (n) {
    if (!files.some(function (f) { return f.name === n.name; })) files.push(n);
  });
  scriptApi_('put', '/content', { files: files });

  // New immutable version, then repoint every versioned web-app deployment
  // at it — same deploymentId, same /exec URL.
  const version = scriptApi_('post', '/versions', { description: 'Bahi v' + manifest.version + ' (auto-update)' });
  const deployments = scriptApi_('get', '/deployments').deployments || [];
  let updated = 0;
  deployments.forEach(function (d) {
    const isWebApp = (d.entryPoints || []).some(function (e) { return e.entryPointType === 'WEB_APP'; });
    const isVersioned = d.deploymentConfig && d.deploymentConfig.versionNumber;
    if (isWebApp && isVersioned) {
      scriptApi_('put', '/deployments/' + d.deploymentId, {
        deploymentConfig: {
          scriptId: ScriptApp.getScriptId(),
          versionNumber: version.versionNumber,
          manifestFileName: 'appsscript',
          description: 'Bahi v' + manifest.version,
        },
      });
      updated++;
    }
  });

  return { status: 'updated', from: BAHI_VERSION, to: manifest.version, deploymentsUpdated: updated };
}

function scriptApi_(method, path, payload) {
  const res = UrlFetchApp.fetch('https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + path, {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: 'application/json',
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Apps Script API ' + method.toUpperCase() + ' ' + path + ' failed (' + code + '): ' +
      res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText() || '{}');
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b & 0xFF) + 0x100).toString(16).slice(1); })
    .join('');
}
