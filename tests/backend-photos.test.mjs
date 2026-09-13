import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScriptBackend } from './backend-harness.mjs';

const bytes = (label = 'image') => Buffer.from(label).toString('base64');
function setup() {
  const b = createScriptBackend();
  b.run('photoFolder()');
  const user = b.api({ action: 'addUser', data: { name: 'Test shop customer' } }).data;
  const data = { user_id: user.user_id, amount: 20, type: 'given', comment: 'bill' };
  const txn = b.api({ action: 'addTxn', data, cid: 'money-1' }).data;
  return { b, txn, data, user };
}
const upload = (b, txn, id, extra = {}) => b.api({
  action: 'uploadTxnPhoto', id: txn.id, attachmentId: id, b64: bytes(id), ...extra,
});
const photos = (b, txn) => b.api({ action: 'list' }).data.transactions.find(t => t.id === txn.id)?.photos;

test('v9 advertises capability; five independent photos retain order and legacy primary', () => {
  const { b, txn } = setup();
  for (let i = 0; i < 5; i++) assert.equal(upload(b, txn, 'photo-' + i).ok, true);
  assert.equal(upload(b, txn, 'photo-6').code, 'PHOTO_LIMIT');
  const list = b.api({ action: 'list' }).data;
  assert.deepEqual(list.capabilities, { multiPhoto: true, maxPhotos: 5 });
  assert.equal(list.transactions[0].photo, list.transactions[0].photos[0].fileId);
  assert.deepEqual(photos(b, txn).map(p => p.id), ['photo-0', 'photo-1', 'photo-2', 'photo-3', 'photo-4']);
});

test('lost Drive create answer and expired cache do not duplicate a photo', () => {
  const { b, txn } = setup();
  b.failNext('afterCreate');
  const result = upload(b, txn, 'photo-1');
  assert.equal(result.ok, true);
  b.state.cache.clear();
  assert.equal(upload(b, txn, 'photo-1').ok, true);
  assert.equal(b.state.uploads, 1);
  assert.equal(b.state.generated, 1);
});

test('reserved upload failure preserves the money and later photos can complete first', () => {
  const { b, txn } = setup();
  b.run('photoFolder()');
  b.failNext('beforeCreate');
  assert.equal(upload(b, txn, 'photo-1').ok, false);
  assert.equal(upload(b, txn, 'photo-2').ok, true);
  assert.equal(upload(b, txn, 'photo-1').ok, true);
  assert.deepEqual(photos(b, txn).map(p => p.id), ['photo-1', 'photo-2']);
  assert.equal(b.state.uploads, 2);
});

test('lost attachment-row commit answer reuses the file and completes the journal', () => {
  const { b, txn } = setup();
  b.failNext('afterWrite:transaction');
  assert.equal(upload(b, txn, 'photo-1').ok, false);
  assert.equal(upload(b, txn, 'photo-1').ok, true);
  assert.equal(b.state.uploads, 1);
  assert.equal(photos(b, txn).length, 1);
});

test('replacement leaves original intact until the new attachment is committed', () => {
  const { b, txn } = setup();
  const original = upload(b, txn, 'photo-1').data.attachment;
  b.failNext('beforeCreate');
  assert.equal(upload(b, txn, 'photo-2', { replacesId: 'photo-1' }).ok, false);
  assert.deepEqual(photos(b, txn), [original]);
  assert.equal(b.state.files.get(original.fileId).trashed, false);
  assert.equal(upload(b, txn, 'photo-2', { replacesId: 'photo-1' }).ok, true);
  assert.equal(b.state.files.get(original.fileId).trashed, true);
  assert.deepEqual(photos(b, txn).map(p => p.id), ['photo-2']);
});

test('remove cancels pending replacements and retries cannot resurrect removed photos', () => {
  const { b, txn } = setup();
  upload(b, txn, 'photo-1');
  b.failNext('beforeCreate');
  upload(b, txn, 'photo-2', { replacesId: 'photo-1' });
  assert.equal(b.api({ action: 'removeTxnPhoto', id: txn.id, attachmentId: 'photo-1' }).ok, true);
  assert.equal(upload(b, txn, 'photo-2', { replacesId: 'photo-1' }).data.cancelled, true);
  assert.deepEqual(photos(b, txn), []);
  b.api({ action: 'removeTxnPhoto', id: txn.id, attachmentId: 'not-yet-uploaded' });
  assert.equal(upload(b, txn, 'not-yet-uploaded').data.cancelled, true);
});

test('old frontend photo changes preserve secondary photos, and passbook fields stay private', () => {
  const { b, txn, data, user } = setup();
  upload(b, txn, 'photo-1'); const second = upload(b, txn, 'photo-2').data.attachment;
  assert.equal(b.api({ action: 'updateTxn', id: txn.id, data: { ...data, amount: 25 } }).ok, true);
  assert.equal(photos(b, txn).length, 2);
  b.api({ action: 'updateTxn', id: txn.id, data: { ...data, photo: bytes('legacy') } });
  assert.deepEqual(photos(b, txn)[1], second);
  b.api({ action: 'updateTxn', id: txn.id, data: { ...data, photo: '' } });
  assert.deepEqual(photos(b, txn), [second]);
  const passbook = b.api({ action: 'passbook', token: user.token }).data;
  assert.deepEqual(Object.keys(passbook.transactions[0]).sort(), ['amount', 'comment', 'date', 'type']);
});

test('delete and Undo restore every Drive file without cached image bytes', () => {
  const { b, txn, data } = setup();
  upload(b, txn, 'photo-1'); upload(b, txn, 'photo-2');
  const originals = photos(b, txn);
  b.api({ action: 'deleteTxn', id: txn.id });
  assert.equal(upload(b, txn, 'photo-3').code, 'ENTRY_MISSING');
  const restored = b.api({ action: 'addTxn', data, cid: 'restore-money' }).data;
  for (const [i, p] of originals.entries()) {
    const result = b.api({ action: 'restoreTxnPhoto', id: restored.id, attachmentId: 'restored-' + i,
      sourceTxnId: txn.id, sourceAttachmentId: p.id });
    assert.equal(result.ok, true, result.error);
    assert.equal(b.state.files.get(p.fileId).trashed, false);
  }
  assert.equal(photos(b, restored).length, 2);
  assert.equal(b.state.uploads, 2);
});

test('all new actions require the ledger key, and customer deletion trashes all attachments', () => {
  const { b, txn, user } = setup();
  for (const action of ['uploadTxnPhoto', 'removeTxnPhoto', 'restoreTxnPhoto']) {
    assert.equal(b.api({ action, key: 'wrong' }).ok, false);
  }
  const file = upload(b, txn, 'photo-1').data.attachment.fileId;
  b.api({ action: 'deleteUser', id: user.user_id });
  assert.equal(b.state.files.get(file).trashed, true);
  assert.deepEqual(b.api({ action: 'list' }).data.transactions, []);
});

test('a failed reservation never creates a Drive file; a committed reservation is retryable', () => {
  for (const point of ['beforeWrite:photo_uploads', 'afterWrite:photo_uploads', 'flush']) {
    const { b, txn } = setup();
    b.run('uploadSheet()');
    b.failNext(point);
    assert.equal(upload(b, txn, 'photo-1').ok, false);
    assert.equal(b.state.uploads, 0);
    assert.equal(upload(b, txn, 'photo-1').ok, true);
    assert.equal(b.state.uploads, 1);
  }
});

test('legacy sheet headers upgrade lazily and malformed JSON never erases an attachment', () => {
  const b = createScriptBackend({ sheets: {
    user: [['user_id', 'name'], ['u1', 'Legacy customer']],
    transaction: [['id', 'user_name', 'date', 'type', 'amount', 'comment', 'photo'],
      ['t1', 'u1', '2026-01-01', 'given', 100, 'old bill', 'legacy-file']],
  } });
  const list = b.api({ action: 'list' });
  assert.deepEqual(list.data.transactions[0].photos, [{ id: 'legacy-file', fileId: 'legacy-file' }]);
  const rows = b.state.sheets.get('transaction');
  rows[1][rows[0].indexOf('photos')] = '{}';
  assert.equal(b.api({ action: 'list' }).code, 'PHOTO_METADATA');
  assert.equal(rows[1][rows[0].indexOf('photo')], 'legacy-file');
});

test('delete retries finish Drive cleanup after losing the row-deletion acknowledgement', () => {
  for (const action of ['deleteTxn', 'deleteUser']) {
    const { b, txn, user } = setup();
    const file = upload(b, txn, 'photo-1').data.attachment.fileId;
    b.failNext('afterDelete:transaction');
    const request = { action, id: action === 'deleteTxn' ? txn.id : user.user_id };
    assert.equal(b.api(request).ok, false);
    assert.equal(b.state.files.get(file).trashed, false);
    assert.equal(b.api(request).ok, true);
    assert.equal(b.state.files.get(file).trashed, true);
  }
});

test('replaying a committed replacement retries interrupted old-file cleanup', () => {
  const { b, txn } = setup();
  const file = upload(b, txn, 'photo-1').data.attachment.fileId;
  b.failNext('updateFile');
  assert.equal(upload(b, txn, 'photo-2', { replacesId: 'photo-1' }).ok, true);
  assert.equal(b.state.files.get(file).trashed, false);
  assert.equal(upload(b, txn, 'photo-2', { replacesId: 'photo-1' }).ok, true);
  assert.equal(b.state.files.get(file).trashed, true);
  assert.equal(b.state.uploads, 2);
});
