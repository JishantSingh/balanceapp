---
name: onboard-merchant
description: Interactively onboard a new Bahi merchant (a shop) — walks the human through SETUP.md while the agent handles clipboard, live verification, and invite-link generation. Use when the user says "onboard a customer/merchant/shop".
---

You are running a guided Bahi merchant onboarding. **SETUP.md in this repo is the source of truth** — read it first, follow its order, and if it disagrees with anything here, SETUP.md wins. Your job is to be the competent half of a pair: the human does the browser/consent steps (only they can), you do everything scriptable, and you *verify every checkpoint live* instead of trusting "done" (experience shows "I think I did it" is the #1 failure mode — deployments pin snapshots, pastes get missed, consent gets partially granted).

## Ground rules

- **Secrets:** the merchant's API key and /exec URL grant full ledger access. Keep them in the conversation only — never write them to any file in the repo, never put them in commits, never send them to third-party services. Personalized clipboard copies via `pbcopy` are fine (local).
- **One step at a time.** Give the human exactly one action, wait for their confirmation or paste, verify, then move on. Number the steps as SETUP.md does so they can cross-reference.
- **Verify, don't ask.** Whenever a checkpoint is remotely testable, test it yourself with `curl -sL` (GET for list, `-d` without `-X POST` for POST actions — forcing POST breaks on Apps Script's 302). Never advance past a failed checkpoint.
- **On any error, check SETUP.md's troubleshooting table first** — every row in it is a real error with its known fix. Quote the fix, don't re-derive it.

## Flow

1. **Intake.** Ask which mode: **standard** (default — recommend it unless they say otherwise) or **auto-update** (SETUP.md Part 2; confirm they understand the broader scopes + GCP console cost before proceeding). Ask if the shop has an existing sheet with data or starts fresh.
2. **Part 1, steps 1–2 (sheet + code).** Copy `apps-script/Code.gs` to their clipboard with `pbcopy` for the paste step; then `apps-script/appsscript.json` (narrow manifest) when they reach the manifest step. Do NOT pre-fill any API key — v4+ backends mint their own key during `setup` and print it in the log.
3. **Part 1, step 3 (authorize).** Warn them about the unverified-app screen *before* they hit it, using SETUP.md's framing. Have them paste the `setup` log line back to you; extract and echo the API key, and tell them to save it. If the log says "auto-update is ON" for a standard install (or OFF for an intended auto-update install), the wrong manifest is pasted — fix before continuing.
4. **Part 1, step 4 (deploy).** Remind: Execute as **Me**, access **Anyone**, and that future updates need Manage deployments → **"New version"** — the pinned-snapshot trap.
5. **✅ Checkpoint 1 — you run it.** With the /exec URL and key they provide:
   `curl -sL "<exec>?action=list&key=<key>"` → must return `{"ok":true,...}` with a `v` field matching the current `BAHI_VERSION` in `apps-script/Code.gs`. HTML instead of JSON → access isn't "Anyone". Missing `v` → old code or stale deployment version.
6. **Invite link — you generate it.** Build `https://jishantsingh.github.io/balanceapp/#s=` + base64url of `{"u":"<exec>","k":"<key>"}` (node one-liner; base64url = base64 with `+→-`, `/→_`, strip `=`). Verify your encoding round-trips by decoding it back. Hand it over with the standard warning: *the link is the key — send it only to the shop's own WhatsApp.*
7. **Phone.** Point them at Part 0 for the shopkeeper (tap link → Add to Home screen). Suggest a first test entry, then confirm it landed: re-run the list probe and check the transaction count went up (delete the test entry after, via the app).
8. **Auto-update mode, if chosen:** walk SETUP.md Part 2 exactly, one step per message. After the manifest swap to `appsscript-autoupdate.json` and re-consent, verify by having them run `checkForUpdate` in the editor (or fire the key-gated `update` action yourself) — expect `up-to-date` or `updated`. If `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: the partial-grant quirk — revoke at myaccount.google.com/permissions, re-run `setup`, fresh consent.
9. **Wrap up.** Summarize for their records (they save it, not the repo): shop name, sheet name, /exec URL, key, mode, backend version, invite link sent where. Remind them the key is also recoverable from Script Properties (`apiKey`) if lost.
