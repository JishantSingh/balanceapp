# Bahi — Sprint & Backlog

*Working doc for dev runs. Feature rationale and research live in [FEATURES.md](FEATURES.md).*

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
12. *Later tier (demand-gated):* voice entry with keypad confirm · cashbook module · staff keys with limited scope · multiple-book switcher.

*Moved into Sprint 1: offline write queue (10 Aug 2026).*

## Done

- v1 core app (ledger, reminders, invite links, PWA) — shipped 10 Aug 2026
- Backend v3 draft (passbook tokens, photos, dormant reminder fields) — drafted, ships with Sprint 1
