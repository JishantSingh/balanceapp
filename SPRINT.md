# Bahi — Sprint & Backlog

*Working doc for dev runs. Feature rationale and research live in [FEATURES.md](FEATURES.md).*

## Current state — as of 10 Aug 2026 (read this first on resume)

- **Live app:** https://jishantsingh.github.io/balanceapp/ — GitHub Pages from `main:/docs` of the public repo `JishantSingh/balanceapp`. Shell cache `bahi-shell-v5`; bump it in `docs/sw.js` on any shell change (users then get the tap-to-update toast).
- **Live backend:** Apps Script **v3 + Advanced Drive Service photos** deployed on the **"Ledger (Bahi test)"** spreadsheet (a copy — the original "Ledger" sheet is untouched). Same `/exec` deployment since day one; updates go via Manage deployments → ✏️ → New version. Owner has granted all three narrow scopes.
- **Verified working end-to-end on the real deployment:** invite links, offline write queue (chip → sync → sheet), passbook links (all 10 customers have tokens), photo attach/fetch/trash via Drive, update toast, `{passbook}` graceful fallback.
- **Test data:** 10 customers / 22 transactions; every customer's `phone` filled with the owner's two numbers alternating (so reminder/passbook tests loop back to the owner).
- **Engineering gotchas learned:** `DriveApp` refuses the narrow `drive.file` scope (hence Advanced Drive Service + `script.external_request` for reading bytes); trashed photos stay readable to the owner's token for ~30 days (normal Drive trash); Apps Script serves via 302 → always `fetch`/`curl -L`; POST as `text/plain` to avoid CORS preflight.
- **Sprint 2 candidates (not yet committed):** UPI ID in reminders (backlog #2) and per-customer statement (#3) — both small, collection-critical.
- **Parked with decisions recorded:** scheduled reminders (#1), config sheet tab (#12).
- Product decisions + research live in [FEATURES.md](FEATURES.md); artifacts: feature plan `claude.ai/code/artifact/7a53ebbc-…`, research memo `…/2ee5a4f8-…`, this doc `…/398d125b-…`.

## Sprint 1 — "Passbook & Photos" (current)

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

- **Standardized UI reskin — shipped 11 Aug 2026.** Dropped the paper-ink theme for the Khatabook/OkCredit-standard look (owner's call after seeing competitor screenshots): system font stack (Google Fonts removed entirely), white surfaces, solid blue `#1565C0` app bar, red/green strictly reserved for money. Customer rows gained initial avatars (8-color muted palette), relative-time subtext ("N din pehle"), and MILENGE/DENGE balance captions. Layout/behavior untouched — buttons, screens, and flows are frozen per design principles. The red bahi-book app icon stays (it's the real object). Verified in light + dark on demo mode.
- **Update-ready toast — shipped 10 Aug 2026.** New app versions self-announce ("Naya version aa gaya — tap karein ⟳"); tap reloads into the new version; re-checks on every app foreground. Toast centering fixed.
- **Sprint 1 — shipped 10 Aug 2026.** All five items live: Given/Received buttons, passbook links, photos, offline write queue, docs. Verified: real-backend queue round-trip (offline entry → pending chip → synced to sheet → deleted), demo photo round-trip (compress → save → 📎 → view), passbook page render, graceful `{passbook}` fallback on pre-v3 backends. Merchant redeploy of Code.gs v3 + manifest required for tokens/photos to activate (README → "Updating an existing deployment").
- v1 core app (ledger, reminders, invite links, PWA) — shipped 10 Aug 2026
