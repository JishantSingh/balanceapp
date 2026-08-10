# बही Bahi — Feature Plan

*The living product document. Merges shipped work, direct user feedback, and market/UX research (Aug 2026). Full research memo with sources: [research artifact](https://claude.ai/code/artifact/2ee5a4f8-8aee-415c-a6a1-8610dfc6cfbb).*

**Vision:** a Khatabook-class udhaar ledger where each merchant owns everything — data in their own Google Sheet, backend in their own Google account, app as a static PWA. No company in the middle, free forever. Trust expressed as behavior (no OTP, no ads, no calls, no loans), not architecture.

**Status legend:** ✅ shipped · 🔨 drafted (code exists locally, not shipped) · 📋 planned · 🧪 explore · ⛔ never

---

## 1 · Shipped (v1, live at jishantsingh.github.io/balanceapp)

- ✅ Customer list home with search, due/advance/settled balances, totals strip
- ✅ Two-button entry (red/green), amount-first, date defaults today, notes
- ✅ Edit/delete entries and customers (double-tap confirm)
- ✅ WhatsApp reminder per customer — editable template ({name}, {amount}, {merchant}), respectful default wording
- ✅ Tap-to-call; phone numbers with auto country code
- ✅ Works against the existing AppSheet "Ledger" sheet schema; adds missing columns automatically
- ✅ Demo mode (sample data, zero setup)
- ✅ PWA: installable on Android, offline read of last-synced data
- ✅ One-click invite links (#s=…) — connection travels in the URL fragment; short-link friendly
- ✅ Narrow permissions: script sees only its own spreadsheet (`spreadsheets.currentonly`)
- ✅ API-key security, key rotation as the universal kill switch

## 2 · Requested by test users — DECIDED, build next

Decisions recorded 10 Aug 2026 (all four approved):

| # | Feature | Design decision | Status |
|---|---------|----------------|--------|
| 2.1 | **Reminder cohorts + due queue** | Per-customer frequency: Off / Weekly / 15 days / Monthly (**default: Monthly**). "🔔 N due" strip + guided "Send all" run (send-back-next; one WhatsApp tap per contact is the floor — WhatsApp-Web automation rejected: ToS/ban risk + needs a server). | ⏸ **parked → backlog #1** ([SPRINT.md](SPRINT.md)); backend fields ship dormant |
| 2.2 | **Customer passbook link** | Per-customer 16-hex secret token in the sheet; keyless read-only `passbook` API action; link via `{passbook}` placeholder in reminders. Customer sees only their own name, balance, entries. Revocable by clearing the token cell. Doubles as the research's "customer becomes the auditor" dispute-proofing feature. | 🔨 backend drafted |
| 2.3 | **Given (red) / Received (green) buttons** | Straight relabel of entry buttons + dialog titles. (Research note: button wording is measurably conversion-sensitive — OkCredit +1.7% activation from copy alone. Revisit wording when vernacular UI lands.) | 🔨 drafted |
| 2.4 | **Photo on any transaction** | Client-side compression (≤1280px JPEG) → stored in a "Bahi Photos" folder in the **merchant's own Drive** → file id in the sheet → served back only through the key-gated API (never public links). Costs one extra narrow permission: `drive.file` (files created by the app only) — requires one re-authorize + redeploy. | 🔨 backend drafted |

> All of §2 ships with a single backend redeploy (new Code.gs + manifest → new version → re-authorize once).

## 3 · From research — table stakes still missing (build soon)

Ordered by value ÷ effort:

- 📋 **UPI in reminders** — merchant sets UPI ID once; reminders carry a pay link/ID against the stated balance. Collection is the category's killer feature; Bahi never touches the money. *(Small)*
- 📋 **Per-customer statement (PDF/print)** — the dispute-settling artifact; universal in competitors. Print-formatted page + browser share. *(Small)*
- 📋 **Hinglish + Hindi UI** — strings file + first-launch language picker. 30%+ of Khatabook users choose non-English; Hinglish beat proper Hindi in their tests. Money words stay vernacular (udhaar, jama, hisaab). *(Medium)*
- 📋 **Contacts import** — Contact Picker API (Chrome on Android): one tap pulls name + phone. The phonebook is the shopkeeper's CRM. *(Small)*
- 📋 **Entry receipt** — after saving, optional one-tap "Send receipt on WhatsApp" (entry + new balance + passbook link). OkCredit's signature trust feature, manual-tap so it never becomes spam. *(Small)*
- 📋 **PIN lock** — phones are shared within families. *(Small)*
- 📋 **Trust copy at point of request** — connect screen says it in Hinglish: "Aapka data sirf aapki Google Sheet mein rehta hai — kisi company ke paas nahi." *(Tiny)*

## 4 · Next — differentiation

- 📋 **Offline write queue** — entries queue locally when offline, sync when network returns, visible "pending sync" chip. Research: silent offline failure = broken khata.
- 📋 **Supplier framing** — customer/supplier toggle so "you'll give" balances read naturally.
- 📋 **Template-sheet onboarding** — "Make a copy" spreadsheet with script pre-installed + 5-minute Hinglish setup video. Aimed at the *helper persona* (the phone-savvy relative who does setup); the merchant persona only ever sees the two buttons.
- 📋 **Collection promise dates** — optional "will pay by" date per customer feeding the due queue (complements cohorts; Khatabook charges coins for this).

## 5 · Later — only with demonstrated demand

- 🧪 **Voice entry (Hinglish)** — the 2025–26 frontier (VoiceKhata, Dukaan AI). Powerful for low-literacy users but a mis-parse in a money app is a trust incident: always confirm on the keypad before save.
- 🧪 **Cashbook module** — daily in/out on a second sheet tab (adjacent, universal in competitors).
- 🧪 **Staff access with limits** — per-key permissions in the script (entry-only keys that can't see totals). Named as an unmet need even for incumbents.
- 🧪 **Multiple books** — polish the existing workaround (multiple sheets/deployments) into a book switcher.

## 6 · Never — the positioning is the product

- ⛔ Ads, loan cross-sell, credit scoring, or any monetization of merchant data
- ⛔ Payment intermediation (money never flows through Bahi — Khatabook's stuck-settlement complaints are the cautionary tale)
- ⛔ OTP/login walls before first value
- ⛔ Paywalls on entries, reminders, or backup ("free forever" for the core is the differentiator the incumbents abandoned)
- ⛔ Auto-messaging customers without a merchant tap (the researched trust-killer)
- ⛔ Feature sprawl that crowds the two-button loop (GST/inventory stays out unless it becomes an opt-in separate module)

## 7 · UI/UX design principles (research findings)

The rules Bahi's interface follows, with the evidence behind them — and an honest audit of where we stand.

**Patterns with evidence:**

| Principle | Evidence | Bahi today |
|---|---|---|
| Two-verb entry buttons, full-width, pinned bottom, **never relabeled or moved** | Fixed positions build muscle memory for novice users (Google NBU); OkCredit measured **+1.7% activation from button wording alone** — copy on these buttons is load-bearing | ✅ (labels changing once to Given/Received per user request, then frozen) |
| Red = due, green = received/advance, **everywhere** | Color does the reading for low-literacy users; the home list doubles as the collections dashboard | ✅ |
| Customer list **is** the home screen — no dashboard, no charts | Khatabook succeeded by digitizing the paper khata habit, not teaching bookkeeping | ✅ |
| Amount-first entry; date defaults to today; note/photo optional | Universal across the category; matches how entries are narrated aloud | ✅ |
| Icon + text labels together, never icon-only for critical actions | NBU: icons alone fail for low digital literacy | ⚠️ gear/refresh are icon-only; FAB is correct |
| Large tap targets, high contrast, big numerals, lakh/crore digit grouping | Entry-level Androids, older eyes, shop lighting | ✅ (en-IN grouping shipped) |
| **Vibrant over sparse** — pale minimalism reads as "empty/broken" to this audience | Google NBU field research; UC Browser's dense vibrancy beat clean minimalism in India | ✅ warm paper + strong red/green; keep type big, don't let it go pale |
| Language picker at first launch; **Hinglish as its own language**; money words stay vernacular (udhaar, jama, hisaab) | 30%+ of Khatabook users choose non-English; Hinglish tested **better than proper Hindi** | ❌ English-only — biggest UI gap (§3) |
| Trust copy **at the point of request**, not in a policy page | Google Station prints "Your number is safe with us" beside the phone field | ❌ planned (§3) |
| Chat-style / two-column ledger history — borrow the WhatsApp mental model | "If you can use WhatsApp, you can use it" is the minimal apps' entire pitch | ✅ two-column you-gave/you-got |
| Statement/PDF as the dispute-settling artifact | The thing merchants physically show customers during an argument | ❌ planned (§3) |
| Offline entry that never silently fails | Any entry lost to weak network = broken khata = uninstall | ⚠️ reads work offline; writes don't queue yet (§4) |

**Anti-patterns (all currently absent — keep it that way):** OTP/login walls before first value (challengers advertise "no OTP" as a headline feature) · ads/upsell nags inside a money ledger · superapp sprawl crowding the two-button loop · messaging the merchant's customers without a merchant tap · long scrolling forms · accounting jargon (debit/credit) · UI overhauls — when Khatabook shipped redesigns, users left; evolve incrementally.

## 8 · User requirements reference (research, ranked)

1. Entry a 55-year-old can do in two taps — complexity and UI churn are the documented adoption killers
2. Reminders that recover money: free, WhatsApp, balance stated, way to pay
3. Respectful tone — neutral record-keeper, never collection agency; merchant-editable wording
4. Dispute-proofing via a shared record (receipt + passbook)
5. Data permanence: survives phone change and the app's own death — "it's literally your spreadsheet" is the strongest answer in the market
6. No data misuse, provably — no calls, no loan ads, no scoring SDKs
7. Free forever for the core ledger
8. Works on a ₹8,000 phone with flaky network, no OTP
9. Staff/family access with limits
10. Coexists with UPI and paper (parallel-running against the paper bahi is the conversion path)

## 9 · Open questions

- **Naming:** an established Play Store app is already "Bahi Khata" (bahikhataapp.com) with adjacent own-your-data positioning. Rename before wider distribution?
- **Language priority:** Hinglish first, then Hindi script, then which regional language?
- **Monetization (if ever):** never the ledger — candidates are paid setup/support or opt-in billing module (the Vyapar lesson: merchants pay ₹3–4k/yr for billing/GST, ₹0 for khata).
- **Distribution:** template link + invite links exist; is a Play Store TWA wrapper (installable listing) worth it later?
