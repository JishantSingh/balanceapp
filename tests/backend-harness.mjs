import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Runs the actual deployable Code.gs. Only Google services are substituted.
export function createScriptBackend(seed = {}) {
  const state = {
    sheets: new Map(), files: new Map(), properties: new Map([['apiKey', 'test-key']]),
    cache: new Map(), now: Date.now(), generated: 0, uploads: 0, faults: new Map(),
  };
  const fail = (point) => {
    const fault = state.faults.get(point);
    if (fault) { state.faults.delete(point); throw new Error(fault); }
  };
  function sheet(name) {
    if (!state.sheets.has(name)) state.sheets.set(name, []);
    const rows = state.sheets.get(name);
    return {
      getLastRow: () => rows.length,
      getLastColumn: () => Math.max(0, ...rows.map(r => r.length)),
      setFrozenRows() {},
      deleteRow(row) { rows.splice(row - 1, 1); fail('afterDelete:' + name); },
      getRange(row, col, height = 1, width = 1) {
        const range = {
          getValues: () => Array.from({ length: height }, (_, y) =>
            Array.from({ length: width }, (_, x) => rows[row - 1 + y]?.[col - 1 + x] ?? '')),
          getValue() { return this.getValues()[0][0]; },
          setValues(values) {
            fail('beforeWrite:' + name);
            values.forEach((r, y) => {
              rows[row - 1 + y] ||= [];
              r.forEach((v, x) => { rows[row - 1 + y][col - 1 + x] = v; });
            });
            fail('afterWrite:' + name);
            return range;
          },
          setValue(value) { return this.setValues([[value]]); },
          setFontWeight() { return range; },
        };
        return range;
      },
    };
  }
  for (const [name, rows] of Object.entries(seed.sheets || {})) state.sheets.set(name, structuredClone(rows));
  const blob = (bytes, mime = 'image/jpeg', name = '') => ({
    getBytes: () => bytes, getContentType: () => mime, getName: () => name,
  });
  const context = vm.createContext({
    console, Date,
    SpreadsheetApp: {
      flush: () => fail('flush'),
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => state.sheets.has(name) ? sheet(name) : null,
        insertSheet: sheet,
        getUrl: () => 'https://docs.google.com/spreadsheets/d/TEST/edit',
      }),
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => state.properties.get(k) ?? null,
      setProperty: (k, v) => state.properties.set(k, String(v)),
      deleteProperty: (k) => state.properties.delete(k),
    }) },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    Utilities: {
      getUuid: randomUUID,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algo, text) => [...createHash('sha256').update(text).digest()],
      formatDate: d => d.toISOString().slice(0, 10),
      newBlob: blob,
      base64Decode: b64 => [...Buffer.from(b64, 'base64')],
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const v = state.cache.get(k); return v && v.until > state.now ? v.id : null; },
      put: (k, id, ttl) => state.cache.set(k, { id, until: state.now + ttl * 1000 }),
    }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
    },
    Drive: { Files: {
      generateIds: () => ({ ids: ['reserved-' + (++state.generated)] }),
      create(meta, content) {
        fail('beforeCreate');
        const id = meta.id || 'folder-' + randomUUID();
        if (state.files.has(id)) throw new Error('409: already exists');
        state.files.set(id, { ...meta, id, mimeType: content?.getContentType() || meta.mimeType,
          bytes: content?.getBytes(), trashed: false });
        if (content) state.uploads++;
        fail('afterCreate');
        return { id };
      },
      get(id) {
        fail('getFile');
        const file = state.files.get(id);
        if (!file) throw new Error('404: file missing');
        return { ...file };
      },
      update(patch, id) {
        fail('updateFile');
        const file = state.files.get(id);
        if (!file) throw new Error('404: file missing');
        Object.assign(file, patch);
        return { ...file };
      },
    } },
    ScriptApp: { getOAuthToken: () => 'test-only' },
    UrlFetchApp: { fetch(url) {
      const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
      const file = state.files.get(id);
      return { getResponseCode: () => file && !file.trashed ? 200 : 404,
        getBlob: () => blob(file?.bytes || []), getContentText: () => '' };
    } },
  });
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), context);
  return {
    state,
    failNext: (point, message = 'Injected failure') => state.faults.set(point, message),
    api(req) {
      context.testRequest = { key: 'test-key', ...req };
      return JSON.parse(vm.runInContext('handle(testRequest).text', context));
    },
    run(expression) { return vm.runInContext(expression, context); },
  };
}
