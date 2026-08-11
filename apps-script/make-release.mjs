#!/usr/bin/env node
/* Regenerates release.json — the manifest the self-updater in every
   merchant's backend checks daily. Run after ANY change to Code.gs or
   appsscript.json, before pushing:

     node apps-script/make-release.mjs

   The version is read from BAHI_VERSION in Code.gs; hashes are SHA-256 of
   the exact file bytes (the updater refuses non-matching files). */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

// Releases are consumed ONLY by self-updating (auto-update mode) backends,
// so the manifest we ship is the six-scope autoupdate variant. Standard
// installs use apps-script/appsscript.json and update manually.
const files = [
  { name: 'Code', type: 'SERVER_JS', path: 'Code.gs' },
  { name: 'appsscript', type: 'JSON', path: 'appsscript-autoupdate.json' },
];

const code = readFileSync(join(dir, 'Code.gs'), 'utf8');
const version = Number(/const BAHI_VERSION = (\d+);/.exec(code)?.[1]);
if (!version) throw new Error('BAHI_VERSION not found in Code.gs');

const manifest = {
  version,
  released: new Date().toISOString().slice(0, 10),
  files: files.map((f) => ({
    ...f,
    sha256: createHash('sha256').update(readFileSync(join(dir, f.path), 'utf8'), 'utf8').digest('hex'),
  })),
};

writeFileSync(join(dir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`release.json → v${version}`);
