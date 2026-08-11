# Bahi — Sprint & Backlog

*Working doc for dev runs. Feature rationale and research live in [FEATURES.md](FEATURES.md).*

## Current state — as of 10 Aug 2026 (read this first on resume)

- **Live app:** https://jishantsingh.github.io/balanceapp/ — GitHub Pages from `main:/docs` of the public repo `JishantSingh/balanceapp`. Shell cache `bahi-shell-v5`; bump it in `docs/sw.js` on any shell change (users then get the tap-to-update toast).
- **Live backend:** Apps Script **v3 + Advanced Drive Service photos** deployed on the **"Ledger (Bahi test)"** spreadsheet (a copy — the original "Ledger" sheet is untouched). Same `/exec` deployment since day one; updates go via Manage deployments → ✏️ → New version. Owner has granted all three narrow scopes.
- **Verified working end-to-end on the real deployment:** invite links, offline write queue (chip → sync → sheet), passbook links (all 10 customers have tokens), photo attach/fetch/trash via Drive, update toast, `{passbook}` graceful fallback.
- **Test data:** 10 customers / 22 transactions; every customer's `phone` filled with the owner's two numbers alternating (so reminder/passbook tests loop back to the owner).
- **Engineering gotchas learned:** `DriveApp` refuses the narrow `drive.file` scope (hence Advanced Drive Service + `script.external_request` for reading bytes); trashed photos stay readable to the owner's token for ~30 days (normal Drive trash); Apps Script serves via 302 → always `fetch`/`curl -L`; POST as `text/plain` to avoid CORS preflight.
- **Sprint 2 candidates (not yet committed):** see [UX-AUDIT.md](UX-AUDIT.md) (11 Aug 2026, three-agent workflow audit) — recommended: Sprint 2 "Nothing lies, nothing lost" (correctness bugs + money-safety rails), then collection round, then entry economics, then onboarding. UPI ID in reminders (backlog #2) and per-customer statement (#3) fold into those. Batch all backend-touching items into one Code.gs v4 release.
- **Parked with decisions recorded:** scheduled reminders (#1), config sheet tab (#12).
- Product decisions + research live in [FEATURES.md](FEATURES.md); artifacts: feature plan `claude.ai/code/artifact/7a53ebbc-…`, research memo `…/2ee5a4f8-…`, this doc `…/398d125b-…`.

## Sprint 2 — "Nothing lies, nothing lost" (SHIPPED 11-12 Aug 2026)

**All Tier 0 + Tier 1 audit findings fixed, plus a hardening round.** Commits: Phase 0 harness 1133468 → WP-A f61ba98 → WP-B 6431c07 → WP-C 5a545d1 → coverage 38 specs f447ebb → hardening 0b4df80. Suite: **55 specs, all green**, every fix mutation-verified (specs fail against pre-fix code). The hardening round came from an adversarial review of the combined diff, which found 2 criticals + 6 highs the per-package tests missed — root theme: all three packages assumed no global-state mutation across an `await` (queue shift vs concurrent delete; config swap during invite validation; Settings as an unguarded ledger switch). Full findings preserved in the review round's commit message and UX-AUDIT.md. Design note: invite `#s=` fragments are stripped from the URL (full-access credential); passbook `#p=` fragments are deliberately KEPT (customer's only re-entry path, scoped + revocable).


Fix every Tier 0 + Tier 1 finding from [UX-AUDIT.md](UX-AUDIT.md), with an E2E test harness built FIRST so the fixes land against red tests and the offline queue can't silently regress.

### Phase 0 — E2E test harness (prerequisite)

- **Stack:** Playwright (`@playwright/test`, chromium only) as a devDependency; static server over `docs/`; a ~100-line Node **mock Apps Script backend** (`tests/mock-backend.mjs`) emulating `/exec` — list/addUser/addTxn/updateTxn/deleteTxn/photo/passbook, plus switchable failure modes (`ok:false` bad-key, HTML sign-in page, network drop). Demo mode bypasses the queue, so the mock backend is what makes queue/error paths testable. **The mock doubles as the contract test** (ARCHITECTURE.md §3.5): one frozen mock per released backend version, append-only — the v3 mock is never edited once written; core specs must pass against every mock in the matrix.
- **~15 specs covering the essential workflows.** Several are written to CURRENT-CORRECT behavior (entry loop, offline queue round-trip, passbook fields, photo attach); the rest encode the Tier-0 bugs and **fail red on today's build by design**: bad-key invite must not say "Connected ✓"; ledger switch must wipe cache/queue; rejected write must surface + roll back; armConfirm must not fire cross-entity; no-match search must show a next action; new customer must sort first; toast must be visible over an open dialog.
- **Run:** `npm test` locally. Optional GitHub Actions workflow on push (free on public repos) — included unless vetoed.
- PWA/service-worker and localStorage-quota cases stay manual (noted in the spec file).

### Phase 1 — three work packages (Opus implements, Fable specs+verifies, tests must be green + manual browser pass before each ship)

| WP | Contents (audit refs) | Size |
|----|----------------------|------|
| **A — Queue truth** | Failed-writes surface w/ local rollback + persistent red chip (0.1) · cache-save quota guard (0.5) · split auth/URL errors from "OFFLINE" (0.6) | M |
| **B — Destructive-action safety** | armConfirm entity tokens + clear-on-open + fixed-width color armed state (0.2) · toast/busy top-layer rescue (0.4) · durable update toast (0.7) · undo entry delete (1.2) · photo-remove into viewer w/ confirm (1.2) · direction toggle when editing + colored save readback (1.3) | M |
| **C — Links & hygiene** | Invite validation before "Connected ✓" + switch confirm + cache/queue/demo wipe + no demo-field inheritance (0.3) · created-at tiebreak (0.8) · thumbs in disconnect wipe (0.9) · passbook-link copy button + invite relabel/danger/confirm (1.1) · note-privacy help line (1.4) · phone validation (1.5) | M |

Ship order A → B → C (A unblocks B's undo semantics; C's tests depend on the mock backend from Phase 0). One sw cache bump per WP ship. **No backend changes in this sprint** — everything is frontend; backend-touching audit items wait for the batched Code.gs v4.

### Done criteria

All Phase-0 red tests green · no previously-green test broken · manual pass on the real test deployment (invite link, offline entry round-trip, photo view) · SPRINT.md + memory updated.

## Sprint 3 — "PIN Suraksha" (designed 12 Aug 2026, awaiting go)

Two-tier PIN protecting owner-level operations on shared shop phones. Threat model: casual misuse (staff/family), NOT a technical attacker with the device — never claim more. Decisions locked with owner 12 Aug 2026.

**Master PIN** (ADMIN_PIN): generated at backend setup (printed by `setup` beside the API key; existing deployments get one at the v7 self-update, readable in Apps Script → Script Properties). Never stored on-device, never returned by any API action, not changeable in-app (escape hatch = edit the Script Property). Sole use: authorize App-PIN set/change/remove, verified server-side.

**App PIN** (TXN_PIN): 4 digits, opt-in. Backend stores salted hash; hash rides in `list` → offline verification on every device sharing the ledger. Set/change in Settings → "🔒 Suraksha" (requires Master PIN, online).

**Gated (App PIN replaces the double-tap when configured):** delete entry · delete customer · remove bill photo · copy invite link · disconnect device · open Connection section. **NOT gated:** adding entries, EDITING entries (owner's call — daily corrections stay free; readback toast is the audit trail), everything else.

**UX:** 3×4 numeric pad in a sheet, op named in title ("Entry hatane ke liye PIN"), 4 dots, shake on wrong; 3 wrong → 30s cooldown (doubling). **2-minute grace window** after success, cleared on app background. "PIN bhool gaye?" → reset via Master PIN. Pre-v7 backend → "Backend update chahiye". PIN off → today's armConfirm behavior unchanged.

**Impl:** Backend v7 (the batched release: `setTxnPin` action + `adminPin`/`txnPinSalt`/`txnPinHash` properties + hash in list + parked items #2.7 token revoke, #4.3 sheet URL) shipped via the self-updater. Frontend: `requirePin(op)` composed at the six gate sites, pad component, Suraksha settings, limiter state in localStorage. E2E: gate on/off, lockout, offline verify, change flow, second-device adoption, pre-v7 fallback, grace expiry.

## Sprint 1 — "Passbook & Photos" (shipped)

Goal: ship the test user's approved requests, minus reminders (parked → backlog #1).

| # | Item | Scope | Acceptance criteria |
|---|------|-------|---------------------|
| S1.1 | **Given / Received buttons** | Relabel the two entry buttons + dialog titles; red/green unchanged; positions frozen per design principles | Buttons read "Given ₹" (red) and "Received ₹" (green) everywhere, including the entry dialog titles |
| S1.2 | **Customer passbook link** | Per-customer 16-hex token (auto-backfilled); keyless read-only `passbook` API action; `#p=…` read-only page (name, balance, entry history); `{passbook}` placeholder in the reminder template, auto-appended if the template lacks it | Customer opens the link from WhatsApp with no login and sees only their own live ledger; link revocable by clearing the token cell; passbook page works in demo mode |
| S1.3 | **Photos on transactions** | Camera/file input on the entry form; client-side compression (≤1280px JPEG); stored in "Bahi Photos" folder in the merchant's own Drive; file id in the sheet; photos served only through the key-gated API; entries with photos show a marker; view in-app; photo trashed when its entry is deleted | Attach → save → reopen entry → view photo round-trips on a real deployment; photo is not publicly accessible by URL |
| S1.4 | **Offline write queue** | All writes (entries, customer add/edit/delete) made offline are queued locally in order; visible "N pending sync" chip; auto-replay on reconnect or next app open; failures surface with retry — never silent loss | Airplane mode → add entry → chip shows "1 pending" → network back → entry lands in the sheet and chip clears; killing the app mid-queue loses nothing |
| S1.5 | **Ship it** | Demo-mode support for new fields; local browser test; sw cache bump; README + redeploy instructions (new `drive.file` scope → one re-authorize); commit, push, verify Pages | All acceptance criteria demonstrated; live site serves the new version; merchant redeploy steps documented in README |

Out of scope for Sprint 1: everything below.

## Backlog (ordered)

1. **Scheduled reminders — cohorts + due queue + guided "Send all"** *(parked 10 Aug 2026)*. Per-customer frequency (Off/Weekly/15 days/Monthly, default Monthly), "🔔 N due" strip, guided send-back-next run stamping `last_reminded`. Decisions and WhatsApp constraints already settled (no free auto-send; WhatsApp-Web automation rejected — ToS/ban risk + needs a server; official Business API only ever as merchant-pays opt-in). Backend fields (`cohort`, `last_reminded`, `remindLog`) ship dormant in v3 — building this later is frontend-only.
2. **UPI ID in reminders** — merchant sets UPI ID once; reminders carry a pay link against the balance. Small, collection-critical.
2b. **Backend self-updater** *(decided 11 Aug 2026 — chosen direction, see ARCHITECTURE.md §5 Option B)*: script updates itself via Apps Script API (updateContent → versions.create → deployments.update on the same /exec URL) + daily trigger against a pinned release manifest. Needs scopes `script.projects`/`script.deployments`/`script.scriptapp` + the merchant's one-time Apps Script API toggle. Scope-stable releases apply silently; scope-adding releases require re-consent by design. Spike on our test deployment as part of Code.gs v4. Contract freeze itself is DEFERRED until Jishant declares the release event.
3. **Per-customer statement (PDF/print)** — the dispute-settling artifact.
4. **Hinglish + Hindi UI** — strings file + first-launch language picker; Hinglish first.
5. **Contacts import** — Contact Picker API (Chrome/Android).
6. **Entry receipt** — post-save one-tap "Send receipt on WhatsApp" (entry + new balance + passbook link).
7. **PIN lock** — shared family phones.
8. **Trust copy on connect screen** — "Aapka data sirf aapki Google Sheet mein rehta hai."
9. **Supplier framing** — customer/supplier toggle.
10. **Template-sheet onboarding** — "Make a copy" sheet + Hinglish setup video for the helper persona.
11. **Collection promise dates** — "will pay by" feeding the (future) due queue.
12. **Config sheet tab** *(parked 10 Aug 2026, user idea)* — a `config` tab in the spreadsheet holding merchant name, reminder template, currency, country code; app reads it on sync so settings follow the ledger across devices instead of living in per-device storage.
13. *Later tier (demand-gated):* voice entry with keypad confirm · cashbook module · staff keys with limited scope · multiple-book switcher.

*Moved into Sprint 1: offline write queue (10 Aug 2026).*

## Done

- **Backend self-updater — built & proven 11 Aug 2026.** The script updates itself from the repo's release manifest (SHA-256-verified) via the Apps Script API: daily trigger + key-gated `update` action; same /exec URL across updates; API key moved to Script Properties (survives updates — proven live, v4→v5 applied by the script itself with key and all data intact). Decision: assisted updates (Option A) stay the merchant default; self-update is the power path and runs on our test deployment (GCP project `bahi-backend`). Setup gotchas recorded in ARCHITECTURE.md §5. Backend releases now: bump BAHI_VERSION → `node apps-script/make-release.mjs` → push → fire `update`.
- **Standardized UI reskin — shipped 11 Aug 2026.** Dropped the paper-ink theme for the Khatabook/OkCredit-standard look (owner's call after seeing competitor screenshots): system font stack (Google Fonts removed entirely), white surfaces, solid blue `#1565C0` app bar, red/green strictly reserved for money. Customer rows gained initial avatars (8-color muted palette), relative-time subtext ("N din pehle"), and MILENGE/DENGE balance captions. Layout/behavior untouched — buttons, screens, and flows are frozen per design principles. The red bahi-book app icon stays (it's the real object). Verified in light + dark on demo mode.
- **Update-ready toast — shipped 10 Aug 2026.** New app versions self-announce ("Naya version aa gaya — tap karein ⟳"); tap reloads into the new version; re-checks on every app foreground. Toast centering fixed.
- **Sprint 1 — shipped 10 Aug 2026.** All five items live: Given/Received buttons, passbook links, photos, offline write queue, docs. Verified: real-backend queue round-trip (offline entry → pending chip → synced to sheet → deleted), demo photo round-trip (compress → save → 📎 → view), passbook page render, graceful `{passbook}` fallback on pre-v3 backends. Merchant redeploy of Code.gs v3 + manifest required for tokens/photos to activate (README → "Updating an existing deployment").
- v1 core app (ledger, reminders, invite links, PWA) — shipped 10 Aug 2026
