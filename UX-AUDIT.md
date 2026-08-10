# Bahi — UX & Workflow Audit

*11 Aug 2026 · Method: three parallel code-trace audits (daily merchant flows · setup/trust/lifecycle · reminder/passbook loop), synthesized and de-duplicated; the highest-stakes claims re-verified against the code by hand. Persona: small Indian shopkeeper — low tech comfort, Hinglish, one-handed use, trust-sensitive. Benchmarks: Khatabook, OkCredit.*

*Frozen decisions were respected throughout: the two entry buttons (wording/position/color), no scheduled reminders (parked), no server, free forever.*

**Headline:** the core entry loop is genuinely good — recording a sale is 6 touches, at Khatabook parity, and the red/green + fixed-position language works without literacy. The problems cluster *around* that loop: several correctness bugs that can silently lose or destroy data, a collection workflow that ignores the data it already syncs, and a system voice (errors, sync state, confirmations) that speaks tiny English while the money speaks color.

Severity: 🔴 correctness/data-loss · 🟠 money-safety / trust incident · 🟡 friction. Effort: S (hours) / M (a session+).

---

## Tier 0 — Correctness bugs (fix regardless of UX) — all hand-verified

| # | Bug | What happens | Fix | Effort |
|---|-----|--------------|-----|--------|
| 0.1 | 🔴 **Server-rejected writes vanish silently.** `processQueue` drops a rejected item (`queue.shift()`) with only a 3.2s toast; the optimistic local copy is never rolled back. The ledger keeps showing an entry that isn't in the sheet — until a later sync silently erases it. Contradicts our own "entries never silently fail" contract. Trigger: rotated/wrong key, deleted customer, any `{ok:false}`. | Merchant loses money records without knowing | Failed-writes list (`bahi.failed`) + persistent red chip "N nahi bache ↻" with retry/edit/discard; revert the local mutation on reject | M |
| 0.2 | 🔴 **Single-tap delete of the wrong thing.** `armConfirm` tokens are constants (`'del-txn'`, `'del-cust'`) not entity ids, and opening another dialog doesn't clear the armed state. Arm delete on entry A, cancel, open entry B within 2.6s → one tap deletes B. Same for customers (deletes all their transactions). | Wrong entry or whole customer history destroyed | Token = `'del-txn:'+id`; clear `confirmArmed` on every dialog open/close | S |
| 0.3 | 🔴 **Invite link lies about success.** `applyInviteLink` never validates the key — "Connected ✓" fires unconditionally. A rotated/wrong key yields a congratulatory toast + empty ledger inviting entries that then hit 0.1. Also: switching ledgers doesn't clear `bahi.cache`/`bahi.queue` (ledger A's unsynced writes replay **into ledger B's sheet**) and config *merges*, so a prior demo's `merchant: 'Demo General Store'` leaks into real WhatsApp reminders. | False success; cross-ledger data pollution; demo residue sent to real customers | Validate with `api('list')` before declaring success; confirm + wipe cache/queue/demo/thumbs on connection change; never inherit demo-only fields | S–M |
| 0.4 | 🔴 **Toasts and the busy bar are invisible while any dialog is open.** `showModal()` promotes the dialog to the top layer, which paints above every z-indexed div. Every toast fired from inside a dialog — photo loading, photo failure, image errors — never appears. "View photo" on a slow/failed call is a permanent black hole. | Dead ends exactly where feedback matters most | Reparent toast/busy into the open dialog, or rebuild toast as a `popover` (shares the top layer) | S |
| 0.5 | 🔴 **Entry can vanish on full storage.** `saveJSON(LS_CACHE, db)` on the save path is unguarded (unlike `saveQueue`). On quota exceeded it throws mid-handler: dialog closes, entry queued, but never rendered. Queued photos (~1.4MB b64) make this reachable. | "I entered it and it's gone" | Same try/catch degradation as `saveQueue`; always `render()` in `finally` | S |
| 0.6 | 🟠 **False "OFFLINE" forever.** The offline chip is set by any `TypeError` — including `new URL(bad config.url)`. A blank/mistyped URL in Settings shows a permanent OFFLINE on a working network; meanwhile a bad key shows *nothing*. | Misdiagnosis in both directions | Distinguish URL-parse and auth errors from network errors; give auth failure its own visible state | S |
| 0.7 | 🟠 **Update toast is destroyed by any later toast** and never returns (SW already installed → no second `updatefound`). Users stay on old versions indefinitely. | Update mechanism self-defeats | Separate persistent element with ✕; re-show on each foreground while an update waits | S |
| 0.8 | 🟡 **New customer sorts last among today's rows** — `created_at` has no time, ties resolve by array order, new user is pushed last. Breaks the manual "find who I just created" recovery too. | "Where did Ramu go?" | Local ms-timestamp tiebreaker | S |
| 0.9 | 🟡 **Disconnect leaves bill-photo thumbnails on the device** (`bahi.thumbs` missing from the wipe list). | Customer bill images survive a "cleared" device | Add to wipe list (one token) | S |

## Tier 1 — Money-safety rails

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 1.1 | 🟠 **The only copyable link in the app is the dangerous one.** Settings' "Copy invite link for this ledger" reads exactly like the answer to "mujhe mera khata ka link bhejo" — but grants full read/write + the API key. The safe per-customer passbook link has **no copy affordance anywhere** (it only exists inside a WhatsApp draft). | Add "Passbook link copy karein — sirf yeh customer, sirf dekhne ke liye" to the customer dialog; relabel invite to "Doosre phone par ye khata kholein", danger-style it, route through armConfirm; warning *before* copy, not a 3.2s toast after | S |
| 1.2 | 🟠 **No undo after deleting an entry**, and the ✕ remove-photo button (35px, beside View) destroys a bill photo with no confirm — while the *less* destructive entry-delete has one. | Undo toast (6–8s; pre-drain it's just dropping a queue item — no server call); move photo-remove into the viewer with armConfirm | S |
| 1.3 | 🟠 **A red/green mis-tap can't be fixed.** Entry direction isn't editable — the most likely entry error requires delete + re-enter (which walks into 0.2). And saves have no readback at all, so mis-taps aren't even noticed. | Direction toggle in the *edit* dialog only (entry buttons stay frozen); colored save readback toast: "₹250 diya · Ramu ₹1,250 baaki" (red) / "₹250 mila" (green) | S |
| 1.4 | 🟠 **Merchant notes are visible to customers** in the passbook — nothing warns the merchant. First discovery ("paisa nahi deta") is a trust incident. | One help line under the Note field: "Yeh note customer ko passbook mein dikhega" | S |
| 1.5 | 🟡 **No phone validation.** 7-digit numbers accepted silently → broken wa.me links that fail later inside WhatsApp; junk text → WhatsApp's contact picker (balance sent to the wrong person). | Inline 10-digit validation with normalized readback | S |

## Tier 2 — The collection loop (the killer feature, currently blind)

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 2.1 | 🟠 **`last_reminded` is synced on every list and never used; `remindLog` backend action has zero frontend callers** (verified). A 15-customer collection round is ~75 taps with no record of who was reminded. | On remind: `enqueue('remindLog')` + local stamp; show "reminded N din pehle" on the customer card and as a home-row badge | S |
| 2.2 | 🟠 **Home ordering is anti-collection.** Recency sort buries the ₹11,500 three-month debtor below today's ₹20 buyer; there's no filter/sort control; positions reshuffle daily so no muscle memory forms; the summary strip ("you'll get ₹X") looks like a dashboard and does nothing. | Filter chips **All · Baaki · Purana** (default All — nothing moves for existing users); make "you'll get" tap into Baaki | S–M |
| 2.3 | 🟡 Reminding costs a full round-trip into each customer screen (5 taps each). | WhatsApp icon-button on home rows where `bal>0 && phone` → ~2 taps each (~45 taps saved per round). Safe: wa.me only composes | S |
| 2.4 | 🟠 **Reminders don't say who's asking for money.** Merchant name defaults empty → "hamari dukaan"; the customer's passbook page **never shows the shop name** (github.io URL + base64 fragment = phishing shape). | Require shop name before first remind; carry `{m: merchant}` in the passbook fragment → shop-name headline on the passbook. Zero backend change | S |
| 2.5 | 🟠 **The passbook — the only screen the least-technical person ever sees — is all English**, downloads the full 112KB PWA shell + icons onto metered data, registers a service worker it will never need, shows raw "Error:" strings, caches nothing (offline = blank), and offers zero actions. | Hinglish its ~10 strings; map errors to actionable Hinglish; skip SW registration under `#p=`; cache last payload ("aakhri baar dekha: …"); refresh tap + timestamp. Later: UPI/call buttons via fragment (backlog #2, frontend-only) | S each |
| 2.6 | 🟡 Template placeholders are unvalidated free text — `{amont}` ships literally; empty template silently reverts. The template textarea is the most intimidating element in Settings. | Live preview against a sample customer + insert-chips (+naam, +rakam, +dukaan, +link) + "Wapas default karein" + unknown-token warning | S–M |
| 2.7 | 🟡 Token revocation (passbook kill switch) is documented only in the README; `updateUser` doesn't whitelist `token`, so in-app revoke needs one backend line. | Near-term: help text; real revoke on next backend redeploy | S / S+backend |

## Tier 3 — Daily-entry economics

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 3.1 | 🟠 **Creating a customer abandons the merchant** — back to home, forced to search for the person they created 2 seconds ago (~17 touches for "new customer + first entry" vs Khatabook's ~11). No duplicate detection either — a second "Ramu" silently splits one person's balance. | On create: straight into the customer + open the Given dialog; matching-name suggestions while typing ("Ramu Yadav · ₹1,250 — open instead?") | S |
| 3.2 | 🟠 **Search dead-ends and jank.** No-match = completely blank screen (empty-state is gated on total, not filtered count); every keystroke does two full transaction scans per user + full innerHTML rebuild + replays all row animations (~600k comparisons/char at 100×3,000); search bar scrolls away; name-only matching. | No-results state → "＋ '<query>' ko customer banayein" (prefilled); one Map per render + ~120ms debounce; sticky search bar; phone-number matching; animate first paint only | S |
| 3.3 | 🟡 **"Received full amount" — the most consequential entry — requires reading & retyping the balance** (typo = phantom balance = future dispute). | "Pura ₹1,250" prefill chip in the Received dialog only | S |
| 3.4 | 🟡 Entry loop polish: `enterkeyhint="done"` (core loop → 5 touches, below Khatabook); edit doesn't focus/select amount; edit dialog never names the customer; settling to zero has no moment ("Hisaab clear ✓"). | As listed | S each |
| 3.5 | 🟡 **Photos:** no `capture` attribute (forces the OS chooser); "Photo added ✓" is English text where a thumbnail should be (bytes already local); compress runs with no indicator (multi-second freeze on cheap phones); thumbnails auto-download **full-size** photos serially (5 photos ≈ up to 9MB, silent, on prepaid data). | "📷 Camera" with `capture=environment` + gallery icon; inline thumb in the form; busy state on compress; thumbs on-tap or capped at 3/viewport (or persist 96px thumb to a sheet column — needs backend) | S / M |
| 3.6 | 🟡 **Legibility of the words that matter:** `--text-3` (#80868b) on white = 3.7:1 (below AA); MILENGE/DENGE caption is 9.6px; txn dates (the dispute field) 11.2px. And the same screen says "you'll get" / "MILENGE" / "owes you" / "you gave" — four phrasings, three registers. | Darken `--text-3` → #5f6368; caption 0.72rem, date 0.78rem; one-pass sweep of the ~12 money words to the Hinglish already shipped (milenge/denge/diya/mila/baaki/hisaab clear) | S |
| 3.7 | 🟡 Sync state invisible from the customer screen (chips live only on home); foregrounding never re-syncs data (only the SW); manual refresh has two silent no-op paths. | Mirror chips on customer masthead; throttled refresh-on-foreground (≥60s); spin the refresh glyph + result toast | S |

## Tier 4 — Onboarding, trust & lifecycle

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 4.1 | 🟠 **No install path.** Zero `beforeinstallprompt` handling while our distribution is WhatsApp links that open in WhatsApp's WebView — where installing is impossible and localStorage is sandboxed. The "Open in Chrome" escape is broken because we strip the fragment on arrival. iOS: no persist() → 7-day eviction risk. | Capture `beforeinstallprompt` → "Bahi ko phone par lagayein" bar after first sync; detect in-app browsers → sticky "Chrome mein kholein" bar with a **Copy link** that regenerates the invite from saved config; iOS static hint | S |
| 4.2 | 🟠 **The connect screen is jargon at the moment of maximum distrust.** "Apps Script web app URL" / "API key" / "the secret you set in Code.gs" / a dead-end pointer to "the README" (not a link, not a word this audience knows). Demo — the natural try-before-trust path — is the weakest element on the screen, and demo mode is a trap (real URL/key typed into Settings while in demo is silently ignored). | Demo primary; connect card behind "Mere paas apna ledger hai"; Hinglish trust line; real guide link + "helper se link mangwayein" path; map the three real connect errors to plain Hinglish; submit lock; in demo, Settings shows "Ab apna asli khata jodein" | S–M |
| 4.3 | 🟠 **Trust copy exists on exactly one screen that invite-link users never see.** After connect, the app never again says "your data is yours" — and it can't even show the merchant their own sheet (only the /exec URL is stored). | Hinglish trust line in three places (connect, under the key field, top of Settings); later: return the sheet URL in `list` → "📄 Meri Google Sheet kholein" (needs backend) | S / M |
| 4.4 | 🟠 **Lifecycle cliffs:** disconnect is a one-way lockout labeled like a toggle (shows no recovery info); key edits in Settings are unvalidated (typo = silently broken app); losing the phone loses merchant name/currency/template silently (localStorage-only) and any queued entries with no record. | Disconnect shows URL+key with copy buttons first; "Connection check karein" button; extend invite payload to `{u,k,m,c,cc,t}` so the link users already pass around migrates settings | S each |
| 4.5 | 🟡 **The chips are the least legible element carrying the most consequential state.** ~10px uppercase English; pending's tap-to-retry lives in a `title` tooltip (never renders on touch); "Saved — will sync" only fires on `navigator.onLine === false`, missing India's attached-but-dead-network mode. | One full-width Hinglish status strip when state ≠ normal: "⏳ 3 entry save honi baaki — internet aate hi apne aap · [Abhi koshish karein]" | M |
| 4.6 | 🟡 README: written for two audiences interleaved; never says a computer is required; never mentions Google's scary "unverified app" consent screen (the #1 abandonment cliff); "Anyone" access instruction sits 79 lines from its reassurance. Settings: no app-version string (cheapest support tool); key visible in plain text on shared phones. | Split SETUP-merchant.md (helper-facing, screenshots, consent-screen walkthrough) from README; inline the "Anyone" reassurance; add `v10` to Settings; mask key behind Show/Copy | S–M |

---

## Recommended sequencing

**Sprint 2 — "Nothing lies, nothing lost" (Tier 0 + Tier 1, all S except 0.1):**
0.2 armConfirm tokens · 0.4 toast top-layer rescue · 0.5 cache-save guard · 0.3 invite validation + connection-switch wipe · 0.6 offline/auth state split · 0.7 durable update toast · 0.8 sort tiebreak · 0.9 thumbs wipe · 1.1 passbook-link button + invite relabel · 1.2 undo + photo-remove confirm · 1.3 direction toggle + save readback · 1.4 note-privacy line · 1.5 phone validation · then 0.1 failed-writes surface (M) as the sprint's one big rock.

**Sprint 3 — "Collection round" (Tier 2):** last_reminded + filter chips + home-row remind + merchant-name gate + passbook survival kit (Hinglish/errors/cache/no-SW/shop-name) + template preview.

**Sprint 4 — "Fast fingers" (Tier 3):** create-flow continuation + search bundle + full-amount chip + photo polish + contrast/Hinglish sweep.

**Sprint 5 — "First five minutes" (Tier 4):** install prompt + in-app-browser escape + connect-screen rewrite + status strip + README split.

*Backend redeploys are expensive (each merchant must repaste) — batch every backend-touching item (2.7 token revoke, 3.5 sheet-thumbs, 4.3 sheet URL) into ONE Code.gs v4 release, shipped when Sprint 3 lands.*
