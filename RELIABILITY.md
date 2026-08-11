# Bahi — Reliability Audit

*12 Aug 2026 · Six parallel code-trace analyses (atomicity · concurrency · failure/retry · durability/reconciliation · scale/quotas · backup/recovery) against Code.gs v8 + app.js (cache v19), synthesized and de-duplicated; the four most load-bearing new claims re-verified by hand against the code. Payload/render numbers in the scale section are measured, not estimated; Apps Script timings are modelled with the model's falsification test named. Findings ranked exploitability × blast radius.*

**Executive summary.** At the single-request level the system is sound: LockService genuinely serializes all API writes, the queue's error classifier is total with safe defaults and cannot loop, v8's idempotency removed 95–99% of the duplicate-write exposure, and the self-updater fails safe. The real risks live in **composition** — five structural themes below account for most of the ~60 findings. Nothing in Google's quota tables threatens the app; **every scale cliff we will ever hit is our own O(n) code**, and the first one arrives around month 4 of a busy shop.

---

## The five structural themes

**T1 · Reconciliation freezes silently, and staying frozen is invisible.** One un-drainable queue item stops `refresh()` from ever reading the sheet again (app.js:384) — no timer retries it, foregrounding doesn't resync, and no signal distinguishes "3 pending, syncing soon" from "3 pending, stuck for a week." Three dimensions independently converged here. A stuck phone shows a perfect-looking ledger the sheet has never seen; a second device shows week-old truth and re-enters entries (manufacturing duplicates cid can't catch).

**T2 · "Attempted" and "never sent" are indistinguishable after a failure.** `inflight` is cleared on error (verified, app.js:571), so a write that committed but lost its answer looks unsent. Editing/deleting/undoing such an entry silently diverges from the sheet in four distinct ways (F1). The same ambiguity, server-side: the cid marker can commit to CacheService *before* the buffered row write flushes (no `SpreadsheetApp.flush()` anywhere), so a retry can be told "already done" about a row that never landed — a silent loss with a success signal.

**T3 · One error channel.** `{ok:false}` means refusal to the client — but the backend also returns it for lock timeouts (zero work done), partial failures (half a `deleteUser` done), and auth problems (fixable in Settings). All get rolled back and parked as if the data were bad: a rotated key mass-parks the whole queue with 20 rollback toasts; "Hatayein" on a partial delete freezes the half-done state. The planned machine-readable `code` field is the single change that lets every other failure be classified honestly.

**T4 · Our own O(n) is the only scale limit that matters.** Measured: `renderHome` re-scans and re-sorts the whole transaction array twice per customer (the planned Map fix **never shipped** — verified); `serialize()` makes two host-bridge calls per row inside the list loop; `backfillTokens` runs on every read, holding the write lock; `list` ships the entire table every sync (~65×/day for an active merchant). Cliff calendar: taps feel slow month 4, iOS localStorage cliff month ~13, effectively unusable ~month 30 — all fixable, none platform-imposed.

**T5 · The sheet is user-editable production storage, and we invited the edits.** "📄 Meri Google Sheet kholein" shipped with no warning. A renamed tab creates a fresh empty one; an empty `list` result then **overwrites every phone's cache without question** — the most likely merchant mistake becomes a fleet-wide wipe of the last good local copies. Version-restore re-arms revoked passbook links; README's documented revoke procedure actually *re-mints* a live token.

---

## Top 12 actions (the cut line)

| # | Action | Theme | Refs | Effort |
|---|--------|-------|------|--------|
| 1 | **Cache-clobber guard**: if the cached ledger had data and `list` returns none (or drops >50%), keep the cache + red banner, don't save | T5 | R1 | S |
| 2 | **`SpreadsheetApp.flush()` before `cidRemember`** (and before lock release) — a cid must imply a durable row | T2 | A2 | S |
| 3 | **Sticky `attempted` flag** on queue items; the four local-surgery sites (`queuedAddFor`, undo, cust-delete) fall through to real writes when set | T2 | F1 | S |
| 4 | **Auth errors keep-queued + auth chip**, never mass-park; extend to `code:'BUSY'` lock timeouts | T3 | F2, C4 | S |
| 5 | **`renderHome` Map index** (measured 22–29× at the sizes that matter) + hoist `serialize()`'s timezone out of the loop | T4 | S1, S2 | S |
| 6 | **Backfill out of the read path** (one batched `setValues`, gated on a property), then drop the lock from `list` | T4 | S6, S4 | S |
| 7 | **Foreground resync** (throttled `refresh` on visibilitychange) + stale-queue escalation (>24h → red chip with the real error) + fetch timeouts (`AbortSignal.timeout`) | T1 | D1, D7, D9, C2 | S–M |
| 8 | **Photo ordering**: upload still precedes the row, but a `savePhoto` failure degrades to a photo-less entry (`photoFailed` in response) instead of a refused entry; `updateTxn` trashes the old photo **last** | — | F6, S8, A5 | S |
| 9 | **Device-prefixed ids** (`bahi.did` + prefix in `nextId()`) — kills cid collision across devices | — | C7 | S |
| 10 | **Referential check in `addTxn`** (customer must exist) — kills invisible orphan money | — | C1 | S |
| 11 | **Disconnect/switch actually clears IDB photos** (cached connection + awaited, `blocked`-tolerant delete) | — | D2, A6 | S |
| 12 | **PIN lockout clock clamp** + limiter hoisted to memory (currently: skewed clock = multi-day lockout with the escape hatch behind the same disabled pad) | — | D5, D8 | XS |

Everything above is frontend-or-backend-v9, no contract breaks, no scope changes. Items 2, 4(code), 6, 8, 10 batch into **backend v9**; the rest are evergreen frontend.

## Next tier (real, scheduled, not urgent)

- **`writeRow` → single `setValues`** (7 RPCs → 1; shrinks the partial-row window ~10–30×) — F4, S. **setTxnPin atomic property write** — A8, S. **`setTxnPin` honest ambiguous-outcome message** — F7, S. **Stale-update park** (`queuedAt` >12h → park, don't silently revert another device's newer edit) — F5, S. **Update-on-deleted → one-shot notice** (today: unclearable red chip whose Retry resurrects the row) — C6, S–M. **Reverse-order mass rollback** — F8, XS. **Failed list addressed by id, not index** — F9, S. **Duplicate-name guard at customer create** — C3, S. **quota eviction order** (queue is the only unreplayable data; evict thumbs/cache first, drop photos oldest-first one at a time; never claim "entry save hui" unverified) — A3, D4, S. **SW shell consistency** (stop runtime-mutating shell entries; drop `skipWaiting`; try/catch around `init()` → cache-purge reload) — D3, S. **Thumb cache by bytes with half-eviction** — S5, S. **`deleteUser` batching** — A4/S9, M. **Config/demo saves guarded** — D11, XS. **Date input clamp (`max=today`)** + drift warning — D10, XS–S. **`updateUser` actually sending token revokes from the UI** + Script-Properties revocation denylist (restore-proof) — R4, S. **README revoke instructions corrected (`off`, not blank)** — R15, XS. **Frozen header row + warning-protection on legacy tabs** — R11, XS. **Schema sanity in `list`** (`schema:{ok:false,…}` instead of silently empty) — R2, M. **Warning line under the sheet-open button** — R3, XS. **Persist() result read + self-WhatsApp credential backup** — D6, S. **Passbook: lock + per-user server-side filter** — C8/S7, S then M (with L2).

## The scale plan (from the measured cliff calendar)

At 40 entries/day: `list` crosses 3s around **month 4** (~5k txns); iOS 5MB localStorage cliff ≈ **month 13** (the quota guard then fails in a thumb-wipe thrash loop that re-downloads ~32MB of photos every ~20 days); Chrome cliff ≈ month 30. Mitigation ladder:

- **L0 (now, in the top-12/next-tier above):** render index, serialize hoist, backfill batching, lock off reads — pushes "annoying" from month 4 to ~month 10–14. Buys zero bytes.
- **L1 — incremental `since=` sync: REJECTED.** No per-row mtime, no tombstones → a `since` filter silently misses edits/deletes of old rows; making it correct welds a sync protocol into the frozen contract. Wrong trade.
- **L2 — date-windowed `list` (default 6 months + per-user opening balance), trigger at ~5k txns:** bounds payload, cache, and render *by construction*, forever. Reuses for passbook's per-user filter. ~1.5 days.
- **L3 — yearly archive sheet, trigger ~25k txns or month 24:** bounds the server read too. The scariest change in the codebase (bulk row move, no transactions) — must be archive-first→verify→delete, resumable, trigger-only, and must not ship before the atomicity fixes above.

Never binding: Sheets cell cap (98 yr), UrlFetch (≤1% of quota), Drive space from our photos (12–40 yr; Google Photos will fill the account first — hence action 8's comprehensible failure), the 6-minute wall on `list`.

## Recovery (from the disaster matrix — 22 scenarios, 20 currently documented nowhere)

Follow-up deliverable: **RECOVERY.md**, helper-facing, Hinglish-ready — symptom router, surgical-restore-by-copy as the default playbook, photo un-trash within the 30-day fuse, deployment-archive warning ("never Archive — the URL dies and every passbook link with it"), Script Properties inventory (note: deleting `adminPin` silently mints a *different* Master PIN), the monthly 2-minute ritual (named version + .xlsx self-WhatsApp + pending-chips-at-zero), and the plain list of what never comes back. **Its first task is the live restore test** on "Ledger (Bahi test)" — the retention claims carry medium confidence until someone runs one. Also correct ARCHITECTURE.md's unimplemented auto-revert claim (R10).

## Accepted risks (stated for repetition to any asking merchant)

1. **We never hold a copy of merchant data** — every recovery ends with the merchant/helper doing it themselves in their own Google account. That is the product, not a gap.
2. **Duplicates are ~99% prevented, not 100%**: an ambiguous write retried >6h later (CacheService's ceiling, best-effort at that) can still duplicate until the durable-dedup column ships. Residual ≈ 0.01–0.25% of writes on bad networks.
3. **Concurrent edits are last-write-wins with no version check**, and "last" means last-to-drain, not last-typed. We owe the loser a notification (scheduled), not a merge.
4. **A partially-executed request leaves the sheet partially written** — Apps Script has no transactions. We make every multi-step operation resumable and idempotent instead.
5. **A phone lost with pending writes loses those writes.** Mitigation is social ("sync before leaving the shop") + the pending chip explaining itself.
6. **Photos have a 30-day fuse** once trashed; Script Properties have no backup; Google-account loss is total loss. Account hygiene is the merchant's; saying so plainly is ours.
7. **Apps Script's ~1–3s warm floor is unremovable** — the cache-first UI is the answer, not server-side cleverness.
8. **Fleet scale costs nothing** (quotas are per-merchant) and gives nothing (no fleet visibility, no central kill switch beyond key rotation). Both sides accepted.
9. **iOS is second-class**: no persist() guarantee, 5MB storage, 7-idle-day eviction for non-installed use. Android + installed PWA is the recommended configuration.
10. **The sheet is open production storage.** We guard against the likely mistakes (headers, tabs, empty answers) and accept the rest: the merchant can always break their own ledger with enough determination — and version history is the undo.

## Proposed sequencing

**Sprint 4 — "Bharosa" (reliability):** top-12 list + the XS items from the next tier, backend v9 batch (flush, code field, referential check, backfill move, photo ordering, lock-off-list), RECOVERY.md with the live restore test, spec coverage for each fix (mutation-verified where feasible, incl. a mock that can expire cids). **Then** L2 windowing rides behind its 5k-txn trigger, and the UX Tier-2 collection round resumes per UX-AUDIT.md.
