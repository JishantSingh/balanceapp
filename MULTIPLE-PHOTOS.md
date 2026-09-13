# Multiple photos per entry — v9

## Product contract

- At most five photos, in selection order. Camera captures append; the gallery
  can select multiple files. Individual replacement/removal edits the draft
  until Save; cancelling keeps the existing attachments.
- Given: red entry text left, photos right. Received: photos left, green text
  right. No centre divider. Photo strips scroll horizontally inside the
  vertically scrolling ledger; every attachment has a thumbnail.
- Entry text opens the existing App-PIN-protected editor. A ledger thumbnail
  opens a read-only viewer with previous/next and a counter, without a PIN.
  The editor keeps Add photo beside Date and places its thumbnail strip below.
- Pending/failed photo badges and Retry belong to the photo, not the amount.
  The financial write is committed before its independent photo jobs.

## Storage and synchronization

The existing localStorage queue is retained. A photo payload lives in exactly
one queue job, including when it fails. The application budget is **3 MiB** for
pending/failed image payloads, counting two bytes per encoded character;
existing compression is unchanged. Pre-v9 queued images are retained even
above the new budget, but new images cannot increase an over-budget queue.

Save persists the complete proposed queue before applying the optimistic entry,
closing the sheet, or showing the financial readback. A failed storage write
evicts only recoverable ledger/thumbnail caches and retries once. If that still
fails, the prior queue and open draft remain. The user can sync earlier work or
remove new photos. Browser quota is separate from the 3 MiB application budget,
so actual quota failure is tested too. No pending-image IndexedDB migration is
included; the existing full-image cache remains a recoverable cache.

Financial jobs have queue priority. Failed photo jobs remain persisted and do
not stop other photos or later financial writes. Each photo is attempted once
per processing pass, then retries on reconnect, foreground, or explicit Retry.
Photo requests have a 30-second client deadline. Fresh server ledger data is
merged with local photo status even while photos are failed. If an authoritative
refresh finds that another device deleted the parent entry, its local photo
jobs are cancelled. Unsynced temporary parent IDs are not mistaken for deletion.

## Backend protocol

`list` adds `capabilities: {multiPhoto: true, maxPhotos: 5}`. Transactions return
ordered `photos: [{id, fileId}]`; the Sheet stores it as JSON in an additive
`photos` column. Legacy rows with only `photo` normalize to a one-item list
without moving/re-uploading any Drive files. `photo` always represents the first
completed attachment. Customer `passbook` responses remain unchanged.

Authenticated, lock-serialized photo actions:

| Action | Request fields (in addition to key/action) |
| --- | --- |
| `uploadTxnPhoto` | `id` (transaction), stable `attachmentId`, `b64`, optional `replacesId` |
| `removeTxnPhoto` | `id`, `attachmentId`; also cancels a not-yet-uploaded attachment |
| `restoreTxnPhoto` | new transaction `id`, new `attachmentId`, `sourceTxnId`, `sourceAttachmentId` |

The `photo_uploads` Sheet tab journals upload ID, parent, Drive ID, replacement
target, state, position, image digest and restoration source. Do not clear this
tab: it is the durable retry/cancellation history, not an expendable cache.
IDs and image digests reject accidental reuse of one attachment ID for another
operation. A reservation is flushed before uploading to a pre-generated Drive
ID; retries reuse the same ID, including after the legacy six-hour insert cache
expires. Google documents support for this through the existing `drive.file`
scope in [files.generateIds](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds).

Replacement keeps the original file until the new reference commits. Stale
replacement requests fail rather than recreating a removed photo. Removal
writes a tombstone, including when cancellation arrives before upload. Entry
and customer deletion cancel upload records and trash unreferenced attachments.
Entry Undo creates a new financial row, then restores its original files via
the backend journal; no phone cache is required. Interrupted deletion/replacement
cleanup is safe to replay. Drive trash remains best-effort, as in earlier
versions: a failed cleanup can leave an unreferenced private file until replay.

## Compatibility and rollout

| Combination | Behaviour |
| --- | --- |
| Old rows + v9 | Single attachment normalized lazily; Drive file unchanged |
| Old frontend + v9 | Omitted `photo` preserves all; explicit replacement/removal affects the primary only |
| New frontend + v8 | One-photo controls and legacy write path |
| Pre-upgrade offline queue | Existing single-photo payloads retained and replayed through the legacy path |

Deploy **only to a dedicated test ledger first**. Standard-mode customers later
need one manual **Manage deployments → Edit → New version → Deploy**, preserving
their URL, key, PIN and three existing scopes. No production rollout is implied
by this PR. Auto-update customers consume `release.json` from `main`, so merging
the backend release is itself a rollout gate: do not merge until approved.
Once multiple-photo data exists, keep a compatible **v9 backend during any
frontend rollback**. Do not roll the backend back to v8.

This change bumps the PWA shell to `bahi-shell-v23`; regenerate backend release
hashes with `node apps-script/make-release.mjs` after any backend source changes.

## Verification and acceptance

Automated commands:

```sh
npm ci
npx playwright install chromium
npm run test:backend
npm test
```

`tests/backend-harness.mjs` runs the actual deployable `Code.gs` in a VM with
mocked Sheets, Drive, locks, properties, fetch and cache services. It does not
substitute a reimplementation of the API. Browser tests cover both that source
and the existing v8 mock. These are local checks, **not real Google evidence**.

Verified locally on 13 September 2026: **13 backend tests passed; 112 browser
regression/feature tests passed**, plus the responsive screenshot check added
after that full run. Coverage includes zero/one/five photos, mixed camera/gallery,
sixth-photo rejection, individual edit/cancel, PIN boundaries, offline reload,
legacy over-budget payloads, storage quota failures, independent upload retries,
lost replies, cancellation, deletion/Undo and old/new compatibility. Synthetic
Chromium camera frames exercise capture without using physical hardware.

Temporary HTTPS preview uses the process documented in
[PHOTO-CONTROLS-TESTING.md](PHOTO-CONTROLS-TESTING.md). It serves only `docs/` and
needs the laptop and tunnel to remain running. Preview connection/storage is
separate from the published app. Do not put keys or invite links in this repo.

**Real Google status:** a separate private test Sheet and bound project were
created, and the saved source/standard manifest were copied back from the editor
and verified against local bytes. Google authorization returned `Access is
denied`; setup/deployment and real Drive integration remain **unverified**.
Complete authorization before deploying the test project; never use the merchant
ledger for these tests.

Physical acceptance — record independently from automated results:

| Check | Phone/browser | Result |
| --- | --- | --- |
| Camera/gallery, readable rotated bill images, five-photo horizontal scroll | Not yet supplied | Pending |
| Vertical ledger scroll, correct thumbnail/viewer, PIN-free viewing and protected editing | Not yet supplied | Pending |
| Offline save/reload/reconnect; amount saved even when photo fails | Not yet supplied | Pending |
| Dedicated v9 ledger: files visible in private Drive, replace/remove/delete/Undo | Not yet supplied | Pending |
| Installed PWA update to v23 and repeat camera/offline flows | Not yet supplied | Pending |

For Google integration, also repeat a completed upload request with the same
attachment ID and confirm the same Drive file; remove it then repeat the stale
request and confirm no resurrection. Inspect the Sheet photo order and the
`photo_uploads` records. Try Chrome, Samsung Internet and Safari as available;
record exact phone, OS/browser versions and any untested combinations.

Deferred: pending-photo IndexedDB migration, photo reordering, and unrelated
queue/reliability redesign.
