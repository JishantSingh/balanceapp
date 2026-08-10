# बही Bahi — Udhaar Khata

A Khatabook/OkCredit-style ledger app where **each merchant owns everything**:

- **Database** → the merchant's own Google Sheet (in their Google account)
- **Backend API** → a small Apps Script the merchant deploys themselves (runs under *their* account, on Google's free tier)
- **App** → a static web page (PWA). Works in any browser, installs on Android like a native app. The Apps Script URL + key are stored only on the merchant's device.

There is no central server, no company in the middle, and nothing to pay — ever. You (the distributor) never see or touch a merchant's data.

```
┌─────────────┐   fetch JSON    ┌──────────────────┐   reads/writes   ┌──────────────┐
│  Bahi PWA   │ ──────────────► │  Apps Script API │ ───────────────► │ Google Sheet │
│ (any phone) │ ◄────────────── │ (merchant's own) │ ◄─────────────── │ (merchant's) │
└─────────────┘                 └──────────────────┘                  └──────────────┘
```

## Features

- Customer list with **due / advance / settled** balances, search, totals
- Per-customer two-column ledger (**You gave** / **You got**), month-wise
- Add / edit / delete entries and customers (with double-tap confirm) — the buttons say **Given** (red) and **Received** (green)
- **Bill / parchi photo per entry** — stored in a "Bahi Photos" folder in *your* Drive, served only through your own API, never made public
- **WhatsApp payment reminders** — free, via `wa.me` links with an editable message template (`{name}`, `{amount}`, `{merchant}`)
- **Customer passbook links** — each reminder can carry a private read-only link where that customer sees their own ledger and live balance; revoke it anytime by clearing their `token` cell in the sheet
- Tap-to-call customers
- Works offline (shows last-synced data), installs to the Android home screen
- **Offline write queue** — entries made without network are queued on the device and sync automatically when it returns; a "pending" chip shows the count
- **Demo mode** with sample data — try the whole app without any setup
- Compatible with the existing AppSheet "Ledger" sheet schema (`user` + `transaction` sheets) — old data keeps working

## Merchant setup (~10 minutes, once)

### 1. The Google Sheet

Either use an existing Ledger sheet, or create a blank Google Sheet — the script creates the `user` and `transaction` tabs automatically on first use. A `phone` column is added to `user` automatically (needed for WhatsApp reminders).

### 2. The backend

1. In the sheet: **Extensions → Apps Script**
2. Paste all of [`apps-script/Code.gs`](apps-script/Code.gs) into `Code.gs`, replacing what's there
3. **Project Settings (gear) → tick "Show `appsscript.json` manifest file in editor"**, then paste [`apps-script/appsscript.json`](apps-script/appsscript.json) over it — this narrows the permission prompt to **three scopes only**: the spreadsheet the script is bound to, *files created by this app* in Drive (the "Bahi Photos" folder), and *connect to an external service* (the script reading photo bytes back via Google's own Drive API — no non-Google service is ever contacted). The script still cannot see any of your other spreadsheets or any Drive file it didn't create. The manifest also enables the Advanced Drive service, which the photo feature requires (plain `DriveApp` refuses to work under the narrow scope).
4. Change `API_KEY` at the top of `Code.gs` to a long random string (this is the merchant's password)
5. **Deploy → New deployment → Web app**, with:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
6. Authorize when asked, then copy the **`/exec` URL**

> Re-deploying later (after script changes) — use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

### 3. The app

The app lives in [`docs/`](docs/) and is published free with GitHub Pages: repo **Settings → Pages → Deploy from a branch → `main` / `/docs`**, which serves it at

```
https://jishantsingh.github.io/balanceapp/
```

**One hosted copy serves every merchant.** The page is just code; each merchant's phone stores their own Apps Script URL + key locally, so every install is connected to a different sheet. (A merchant who wants zero dependence on your hosting can fork the repo and host their own copy — it's 6 static files.)

### 4. On the merchant's Android phone

1. Open the app URL in Chrome
2. Paste the Apps Script URL + API key → **Open my ledger**
3. Chrome menu → **Add to Home screen** (or the install prompt)

It now opens full-screen from its own icon, like any app. Same URL works on iPhone (Share → Add to Home Screen) and desktop.

### Sharing a connected ledger (invite links)

Once connected, **Settings → Copy invite link** produces a single URL that opens the app *already connected* — perfect for a second phone, a family member, or a shop worker. The connection rides in the URL fragment (`#s=…`), which browsers never send to servers.

> An invite link carries the API key: anyone holding it has **full read/write access** to that ledger. Share it like you'd share a key.

## Updating an existing deployment

If a merchant is already running an older version of the script:

1. **Extensions → Apps Script**, paste the new [`apps-script/Code.gs`](apps-script/Code.gs) over the old one (keep your own `API_KEY` line)
2. Paste the new [`apps-script/appsscript.json`](apps-script/appsscript.json) over the old manifest
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** — the `/exec` URL stays the same, so nobody has to reconnect
4. Re-authorize when prompted — the new Drive "files created by this app" permission needs a fresh consent

Nothing to change in the sheet by hand: the script adds any missing columns (`token`, `photo`, `cohort`, `last_reminded`) itself on first use.

## Distributing to many merchants

The clean "AppSheet-like" flow:

1. Make a **template spreadsheet** with the Apps Script already pasted in (container-bound scripts are copied along with the sheet).
2. Give a merchant the template's **"Make a copy"** link (`.../copy` URL).
3. The merchant: makes their copy → opens Apps Script → sets their own `API_KEY` → deploys → pastes URL+key into the app.

Their copy, their account, their data. You're never in the loop.

## WhatsApp reminders

The **Remind on WhatsApp** button appears on any customer with a due balance and a phone number. It opens WhatsApp with a pre-filled message — no WhatsApp Business API, no cost, and the merchant sees/edits the message before sending. The template lives in **Settings**:

```
Namaste {name} ji 🙏
Aapka {merchant} par {amount} ka hisaab baaki hai. Kripya jald bhugtan karein.
Dhanyavaad!
```

Numbers are normalized with the country code from Settings (default `91`).

## Data format

| sheet | columns |
|---|---|
| `user` | `user_id`, `name`, `created_at`, `phone`, `token` (secret that powers that customer's passbook link — clear the cell to revoke it) |
| `transaction` | `id`, `user_name` (holds the customer's `user_id`), `date`, `type` (`given` \| `received`), `amount`, `comment`, `photo` (Drive file id of the bill/parchi image, blank if none) |

Balance per customer = Σ`given` − Σ`received`. Positive → customer owes the merchant ("due"), negative → advance.

The `user` sheet also carries `cohort` and `last_reminded` (the script creates and fills them), but they are dormant — reserved for the parked automatic-reminders feature. No screen in the app acts on them today.

## Security & limits — honest notes

- The API key lives in the merchant's browser storage and in their Apps Script — anyone who has **both the URL and the key** can read/write that sheet. Fine for a personal shop ledger; rotate the key (script + settings) if a phone is lost.
- "Who has access: Anyone" means anyone can *call* the URL, but without the key every request is rejected; the sheet itself stays private to the merchant's Google account.
- Apps Script free quotas (per merchant, per day) are far beyond one shop's usage: tens of thousands of calls. Every merchant has their **own** quota, since they run their own deployment.
- Writes need internet; offline you still see the last-synced ledger.

## Development

```bash
cd docs && python3 -m http.server 8742   # http://localhost:8742 — use demo mode
```

No build step, no dependencies: `index.html` + `styles.css` + `app.js` + `sw.js`. When you change shell files, bump `CACHE` in `sw.js` so installed apps pick up the update.
