/**
 * Bahi — Google Sheets backend API (Khatabook-style udhaar ledger)
 *
 * Works with the existing "Ledger" spreadsheet schema:
 *   sheet "user":        user_id | name | created_at | phone   (phone added automatically)
 *   sheet "transaction": id | user_name | date | type | amount | comment
 *     - "user_name" holds the customer's user_id (kept for AppSheet back-compat)
 *     - "type" is "given" (you gave / udhaar) or "received" (you got / payment)
 *
 * Setup:
 *  1. Open your Ledger spreadsheet → Extensions → Apps Script.
 *  2. Paste this whole file into Code.gs and save.
 *  3. Change API_KEY below to your own long random string.
 *  4. Deploy → New deployment → type "Web app":
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  5. Copy the /exec URL — paste it in the app's connect screen along with the key.
 */

const API_KEY = 'change-me-to-a-long-random-string';

const USER_SHEET = 'user';
const USER_HEADERS = ['user_id', 'name', 'created_at', 'phone'];
const TXN_SHEET = 'transaction';
const TXN_HEADERS = ['id', 'user_name', 'date', 'type', 'amount', 'comment'];

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
  if (req.key !== API_KEY) {
    return respond({ ok: false, error: 'Unauthorized: bad or missing key' });
  }
  try {
    switch (req.action) {
      case 'list':
        return respond({ ok: true, data: { users: listRows(userSheet(), USER_HEADERS), transactions: listRows(txnSheet(), TXN_HEADERS) } });
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
  lock.waitLock(10000);
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
  // Add any missing header columns (e.g. "phone" on an older sheet)
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

// The sheets contain blank spacer rows (AppSheet leftovers); skip any row
// whose id cell is empty, but keep real sheet row numbers for writes.
function listRows(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const map = headerMap(sheet);
  const width = sheet.getLastColumn();
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const idCol = map[headers[0]];
  const out = [];
  values.forEach(function (row) {
    if (row[idCol] === '') return;
    const obj = {};
    headers.forEach(function (h) {
      obj[h] = map[h] === undefined ? '' : serialize(row[map[h]]);
    });
    out.push(obj);
  });
  return out;
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

function writeRow(sheet, headers, rowNum, obj) {
  const map = headerMap(sheet);
  headers.forEach(function (h) {
    if (map[h] !== undefined) sheet.getRange(rowNum, map[h] + 1).setValue(obj[h]);
  });
}

// ---------- users ----------

function addUser(data) {
  const sheet = userSheet();
  const user = {
    user_id: shortId(),
    name: String(data.name || '').trim(),
    created_at: new Date(),
    phone: String(data.phone || '').trim(),
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
  writeRow(sheet, Object.keys(patch), row, patch);
  return patch;
}

// Deletes the customer AND all their transactions.
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
        tSheet.deleteRow(i + 2);
        removed++;
      }
    }
  }
  uSheet.deleteRow(row);
  return { deleted: id, transactionsRemoved: removed };
}

// ---------- transactions ----------

function buildTxn(id, data) {
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
  };
}

function addTxn(data) {
  const sheet = txnSheet();
  const txn = buildTxn(shortId(), data);
  if (!txn.user_name) throw new Error('user_id is required');
  writeRow(sheet, TXN_HEADERS, sheet.getLastRow() + 1, txn);
  txn.date = serialize(txn.date);
  return txn;
}

function updateTxn(id, data) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) throw new Error('Transaction not found: ' + id);
  const txn = buildTxn(id, data);
  writeRow(sheet, TXN_HEADERS, row, txn);
  txn.date = serialize(txn.date);
  return txn;
}

function deleteTxn(id) {
  const sheet = txnSheet();
  const row = findRow(sheet, 'id', id);
  if (row === -1) throw new Error('Transaction not found: ' + id);
  sheet.deleteRow(row);
  return { deleted: id };
}
