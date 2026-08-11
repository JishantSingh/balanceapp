# Bahi — Merchant Setup Guide

*How to give a shop its own Bahi backend. Written for the person doing the setup — usually a tech-comfortable helper (relative, friend) working on a **computer**. Budget ~20 minutes for Part 1. The shopkeeper themselves only ever needs Part 0.*

Everything here is free and stays free. When you're done, the shop's ledger lives in **their** Google Sheet, runs under **their** Google account, and nobody else — including the people who wrote this app — can see or touch it.

---

## Part 0 — The shopkeeper's path (no setup at all)

If someone has already done Part 1 for this shop, the shopkeeper just:

1. Taps the **invite link** received on WhatsApp → the app opens, already connected.
2. In Chrome: **⋮ menu → Add to Home screen** → Bahi becomes an app icon.

That's it. Everything below is for the helper.

---

## Part 1 — Standard setup (every shop, one time)

### 1. The Google Sheet

Sign in to the **shop's** Google account (not yours — ownership is the whole point). Create a blank Google Sheet at [sheets.new](https://sheets.new) and name it something like `Dukaan Ledger`. The app creates its own tabs and columns on first contact — an existing sheet with old data in `user`/`transaction` tabs works too.

### 2. The backend code

1. In the Sheet: **Extensions → Apps Script**. An editor opens with an empty `Code.gs`.
2. Open [`apps-script/Code.gs`](apps-script/Code.gs) from this repo → **Raw** → select all → copy.
3. Paste over everything in the editor's `Code.gs`. Save (⌘/Ctrl-S).
   *(You do NOT need to edit the API key line — a key is generated for you in step 4.)*
4. **Project Settings (gear icon) → check "Show `appsscript.json` manifest file in editor"** → back in the editor, open `appsscript.json`, and paste over it with [`apps-script/appsscript.json`](apps-script/appsscript.json) from this repo. Save.

**What those manifest permissions mean** (this is the trust contract — read it once so you can explain it):

| Permission | Plain meaning |
|---|---|
| `spreadsheets.currentonly` | This one spreadsheet only — no other files |
| `drive.file` | Only files this app itself creates (the bill-photos folder) |
| `script.external_request` | May fetch from the internet (used to read photos back, and to check for updates) |

No contacts, no email, no location, no "all your Drive". If a setup guide ever asks you for broader permissions than these, stop and ask why. (The optional auto-update mode in Part 2 does ask for more — that's exactly why it's optional.)

### 3. Authorize — and the scary screen

1. In the editor toolbar, select the function **`setup`** → **Run**.
2. Google shows **"Google hasn't verified this app."** This is expected and correct: you just created this app, in this account, thirty seconds ago — there is no company behind it for Google to verify. That's the feature.
3. Click **Advanced → Go to … (unsafe) → Allow**.
4. When it finishes, open the execution log (View → Logs / Executions). You'll see:
   `Bahi v6 ready — auto-update OFF (standard mode; see SETUP.md to enable). API key: a1b2c3…`
5. **Copy that API key somewhere safe** (the shop's notebook is fine). It is the password to this ledger. It's also stored in the script's properties, so it survives everything — but written down beats "I forget".

### 4. Deploy the web app

1. **Deploy → New deployment → gear icon → Web app.**
2. **Execute as: Me.**
3. **Who has access: Anyone.** ← This sounds wrong; it isn't. "Anyone" means anyone can *knock on the door* — but every request without the API key is rejected with `Unauthorized`. The sheet itself stays fully private in the shop's account. (The one keyless action, the customer passbook, only ever returns a single customer's rows, gated by that customer's own secret token.)
4. **Deploy** → copy the **Web app URL** (ends in `/exec`).

> ⚠️ **The #1 mistake for later:** deployments serve a frozen *snapshot*. Whenever you update the code in the future, the change is **not live** until you do **Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy**. Same URL, new code. (The app will remind you when an update is available.)

### ✅ Checkpoint 1

Open this in a browser tab (paste your values):

```
<your /exec URL>?action=list&key=<your API key>
```

You should see `{"ok":true,...}` with empty (or your existing) users/transactions. If you see an HTML sign-in page instead of JSON → "Who has access" isn't set to Anyone (step 4.3). If you see `Unauthorized` → key mismatch.

### 5. Connect the shop's phone

On your computer, open **https://jishantsingh.github.io/balanceapp/** → paste the `/exec` URL and API key → **Open my ledger**. Then **Settings (gear) → 🔗 Copy invite link** and send it to the shopkeeper on WhatsApp.

> The invite link carries the key — treat it like the key. Send it only to the shop's own number, and delete the message after they've opened it if you want to be tidy.

The shopkeeper does Part 0. Done: their sheet, their backend, their phone.

---

## Part 2 — Auto-update mode (optional, technical)

**Standard mode is the default and is fine.** When a backend update ships (rare — a few times a year at most), the app shows a notice and the update is a guided two-minute repeat of steps 2–4 above. Old backends keep working regardless — updates are never urgent.

Auto-update mode makes the backend update **itself** (a daily check against this repo, files verified by SHA-256 before applying, deployment repointed automatically — the `/exec` URL never changes). The cost is real, which is why it's opt-in:

- **Broader permission:** it needs "see, edit, create and delete all your Google Apps Script projects" — the script must be able to rewrite itself. This is the one place Bahi asks for more than the minimum.
- **~10 minutes of Google Cloud console**, the least friendly UI in this guide.

Worth it for: the person maintaining several shops' backends, or anyone technical who never wants to paste code again. Skip freely otherwise.

### 2.1 Create a standard Google Cloud project

The hidden project Google normally runs scripts on is sealed — you need a real one.

1. [console.cloud.google.com](https://console.cloud.google.com) (same Google account) → project picker (top-left) → **New project** → name: `bahi-backend` → Create → **select it** in the picker.
2. **APIs & Services → Library** → enable **both**: **Apps Script API** and **Google Drive API**. (Miss one and you'll get a 403 later that names the missing API and links you back here.)
3. **APIs & Services → OAuth consent screen** → External → app name `Bahi backend`, your email in both email fields → Save through the remaining screens (skip scopes and test users).
4. ⚠️ **Click "Publish app" so the status reads "In production."** In "Testing" status, Google silently expires the authorization **every 7 days** — your backend would break weekly with no error you'd ever see. This step is not optional.
5. **IAM & Admin → Settings** → copy the **Project number**.

### 2.2 Bind the script to it

1. Apps Script editor → **Project Settings (gear) → Google Cloud Platform (GCP) Project → Change project** → paste the number → Set project.
2. Also on your account (one-time, per account): [script.google.com/home/usersettings](https://script.google.com/home/usersettings) → **Google Apps Script API → On**. (Without it, the API accepts reads but rejects the writes the updater needs.)

### 2.3 Swap to the six-scope manifest and re-authorize

1. In the editor, replace `appsscript.json` with [`apps-script/appsscript-autoupdate.json`](apps-script/appsscript-autoupdate.json) from this repo. Save.
2. Run **`setup`** → consent screen (via your new project) → Advanced → Allow all six permissions.
3. **If the run then fails with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`:** Google reused your old, narrower consent — a known quirk. Fix: [myaccount.google.com/permissions](https://myaccount.google.com/permissions) → find this script → **Remove access** → run `setup` again → grant the fresh, full consent.
4. **Deploy → Manage deployments → ✏️ → New version → Deploy** (the deployment must re-snapshot the new manifest — see the ⚠️ in Part 1).

### ✅ Checkpoint 2

The log from `setup` should now say **"auto-update is ON"**. To prove the whole chain, run **`checkForUpdate`** from the editor: `up-to-date` means everything works (or `updated` if a release was actually waiting — even better). From now on the daily trigger handles it; releases needing *new* permissions are the one thing that still waits for a human, by design.

---

## Troubleshooting (every one of these is a real error we've hit)

| Symptom | Cause | Fix |
|---|---|---|
| Changes made in the editor don't show up at the `/exec` URL | Deployments serve pinned snapshots | Manage deployments → ✏️ → **New version** → Deploy |
| `ACCESS_TOKEN_SCOPE_INSUFFICIENT` despite correct manifest | Google reused a partial old consent | Revoke at myaccount.google.com/permissions → re-run `setup` |
| `…API has not been used in project <number>…` (403) | That Google API isn't enabled on your `bahi-backend` project | The error includes an enable link — click it, wait 2 min |
| `User has not enabled the Apps Script API` | Per-user toggle off | script.google.com/home/usersettings → On |
| Web app returns an HTML sign-in page instead of JSON | Deployment access isn't "Anyone" | Redeploy with **Who has access: Anyone** |
| Backend works, then dies ~a week after Part 2 | Consent screen left in "Testing" status | OAuth consent screen → **Publish app** (In production), re-authorize |
| `Unauthorized: bad or missing key` | Key mismatch | The key is in Script Properties (`apiKey`) — Project Settings → Script Properties |
