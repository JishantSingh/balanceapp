/**
 * Bahi — Google Sheets backend API (Khatabook-style udhaar ledger) · v3
 *
 * Sheets (columns are created/added automatically):
 *   "user":        user_id | name | created_at | phone | cohort | last_reminded | token
 *   "transaction": id | user_name | date | type | amount | comment | photo
 *     - "user_name" holds the customer's user_id (kept for AppSheet back-compat)
 *     - "type" is "given" (udhaar) or "received" (payment)
 *     - "cohort" is a reminder frequency: off | weekly | 15days | monthly
 *     - "token" is a per-customer secret for the read-only passbook link
 *     - "photo" is a Drive file id of an attached bill photo
 *
 * Photos are stored in a "Bahi Photos" folder in YOUR Drive and served only
 * through this API (key required) — they are never made public.
 *
 * Setup:
 *  1. Spreadsheet → Extensions → Apps Script; paste this file into Code.gs.
 *  2. Project Settings (gear) → show appsscript.json → paste the manifest from
 *     this repo (scopes: this spreadsheet + files created by this app).
 *  3. Set API_KEY below to a long random string.
 *  4. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).
 *     Updating later: Deploy → Manage deployments → Edit → New version.
 */

const API_KEY = 'change-me-to-a-long-random-string';

const USER_SHEET = 'user';
const USER_HEADERS = ['user_id', 'name', 'created_at', 'phone', 'cohort', 'last_reminded', 'token'];
const TXN_SHEET = 'transaction';
const TXN_HEADERS = ['id', 'user_name', 'date', 'type', 'amount', 'comment', 'photo'];
const PHOTO_FOLDER = 'Bahi Photos';
const MAX_PHOTO_B64 = 2 * 1024 * 1024; // ~1.5MB image

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

  if (req.key !== API_KEY) {
    return respond({ ok: false, error: 'Unauthorized: bad or missing key' });
  }
  try {
    switch (req.action) {
      case 'list':
        return respond({ ok: true, data: withLock(listAll) });
      case 'addUser':
        return respond({ ok: true, data: withLock(addUser, req.data) });
      case 'updateUser':
        return respond({ ok: true, data: withLock(updateUser, req.id, req.data) });
      case 'deleteUser':
        return respond({ ok: true, data: withLock(deleteUser, req.id) });
      case 'addTxn':
        return respond({ ok: true, data: withLock(addTxn, req.data) });
      case 'updateTxn':
        return respond({ ok: true, data: withLock(updateTxn, req.id, req.data) });
      case 'deleteTxn':
        return respond({ ok: true, data: withLock(deleteTxn, req.id) });
      case 'photo':
        return respond({ ok: true, data: getPhoto(req.id) });
      case 'remindLog':
        return respond({ ok: true, data: withLock(remindLog, req.id) });
      default:
        return respond({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return respond({ ok: false, error: String(err) });
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
    lock.releaseLock();
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
  const users = listRows(userSheet(), USER_HEADERS);
  const txns = listRows(txnSheet(), TXN_HEADERS);
  users.forEach(function (u) { delete u._row; });
  txns.forEach(function (t) { delete t._row; });
  return { users: users, transactions: txns };
}

// Every customer gets a token so passbook links can be built.
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

// ---------- users ----------

const COHORTS = ['off', 'weekly', '15days', 'monthly'];

function cleanCohort(v) {
  return COHORTS.indexOf(String(v)) !== -1 ? String(v) : 'monthly';
}

function addUser(data) {
  const sheet = userSheet();
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
function deleteUser(id) {
  const uSheet = userSheet();
  const row = findRow(uSheet, 'user_id', id);
  if (row === -1) throw new Error('Customer not found: ' + id);

  const tSheet = txnSheet();
  const map = headerMap(tSheet);
  const lastRow = tSheet.getLastRow();
  let removed = 0;
  if (lastRow >= 2) {
    const values = tSheet.getRange(2, 1, lastRow - 1, tSheet.getLastColumn()).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      if (String(values[i][map.user_name]) === String(id)) {
        if (map.photo !== undefined && values[i][map.photo]) trashPhoto(String(values[i][map.photo]));
        tSheet.deleteRow(i + 2);
        removed++;
      }
    }
  }
  uSheet.deleteRow(row);
  return { deleted: id, transactionsRemoved: removed };
}

// ---------- passbook (read-only, token-gated) ----------

function passbook(token) {
  if (!token || token.length < 12) throw new Error('Invalid passbook link');
  const users = listRows(userSheet(), USER_HEADERS);
  const match = users.filter(function (u) { return String(u.token) === token; })[0];
  if (!match) throw new Error('This passbook link is no longer valid');
  const txns = listRows(txnSheet(), TXN_HEADERS)
    .filter(function (t) { return String(t.user_name) === String(match.user_id); })
    .map(function (t) {
      return { date: t.date, type: t.type, amount: t.amount, comment: t.comment };
    });
  return { name: match.name, transactions: txns };
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
    photo: resolvePhoto(data.photo, existingPhoto),
  };
}

// data.photo: undefined → keep existing · '' → remove · base64 → replace
function resolvePhoto(incoming, existing) {
  if (incoming === undefined) return existing || '';
  if (incoming === '') {
    if (existing) trashPhoto(existing);
    return '';
  }
  if (existing) trashPhoto(existing);
  return savePhoto(String(incoming));
}

function addTxn(data) {
  const sheet = txnSheet();
  const txn = buildTxn(shortId(), data, '');
  if (!txn.user_name) throw new Error('user_id is required');
  writeRow(sheet, TXN_HEADERS, sheet.getLastRow() + 1, txn);
  txn.date = serialize(txn.date);
  return txn;
}

function updateTxn(id, data) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) throw new Error('Transaction not found: ' + id);
  const existingPhoto = String(readCell(sheet, row, 'photo') || '');
  const txn = buildTxn(id, data, existingPhoto);
  writeRow(sheet, TXN_HEADERS, row, txn);
  txn.date = serialize(txn.date);
  return txn;
}

function deleteTxn(id) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) throw new Error('Transaction not found: ' + id);
  const photo = String(readCell(sheet, row, 'photo') || '');
  if (photo) trashPhoto(photo);
  sheet.deleteRow(row);
  return { deleted: id };
}

// ---------- photos (merchant's own Drive, private) ----------

function photoFolder() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('photoFolderId');
  if (saved) {
    try {
      return DriveApp.getFolderById(saved);
    } catch (e) { /* folder was deleted — recreate */ }
  }
  const folder = DriveApp.createFolder(PHOTO_FOLDER);
  props.setProperty('photoFolderId', folder.getId());
  return folder;
}

function savePhoto(b64) {
  if (b64.length > MAX_PHOTO_B64) throw new Error('Photo too large — try again, it will be compressed more');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'bahi-' + shortId() + '.jpg');
  const file = photoFolder().createFile(blob);
  return file.getId();
}

function getPhoto(fileId) {
  if (!fileId) throw new Error('Missing photo id');
  const blob = DriveApp.getFileById(String(fileId)).getBlob();
  return { b64: Utilities.base64Encode(blob.getBytes()), mime: blob.getContentType() };
}

function trashPhoto(fileId) {
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (e) { /* already gone — ignore */ }
}
