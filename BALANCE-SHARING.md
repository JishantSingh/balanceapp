# Balance-card sharing

## User flow and data

Share balance is available for non-zero customer balances, regardless of whether
a phone number is saved. Viewing/sharing is PIN-free. The app waits for its
existing pending financial queue, requires the user to resolve failed financial
changes, then reads a fresh `list`. It does not wait for the photo queue to empty.
Offline/authentication/invalid-response errors prevent export of cached data.
Preparation has a 30-second timeout and Retry; cancelling or timing out never
drops pending work. Sync may finish previously queued entries; sharing itself
does not create entries or mark reminders as sent.

The preview captures one immutable snapshot: merchant/customer, absolute amount
using the configured currency, balance direction, message, phone and local date
at successful sync. A ledger/customer/credential switch cancels the operation.
Changes to relevant data, financial queue state or connectivity invalidate a
ready image and require a new sync/review. Already exported images are snapshots,
not live balances; the app cannot recall a file handed to another app.

`docs/balance-card.js` renders a 1080 × 710 PNG using Canvas and local font
fallbacks. It draws a white image, blue shop header, customer name and date:

- Positive: red `Aapka baki`, red amount.
- Negative: green `Aapko milenge`, green absolute amount.
- Zero (including values that display as zero to two decimals): no card.

Names wrap over up to two lines. Amounts shrink to fit; if a name or amount still
cannot fit legibly, image creation fails visibly and synced text remains usable.
No payment request, thanks, URL, QR or payment button is drawn into the image.
The card uses no image service, server upload, Drive file, localStorage payload
or transaction-photo queue. Its temporary object URL is revoked on close,
invalidation or replacement.

## Templates and platform behavior

`config.template` retains the existing red message. The additive local setting
`config.creditTemplate` supplies the green message, falling back to the default
greeting, "{merchant} ke hisaab mein aapko {amount} milenge.", passbook and thanks.
Settings/save/reconnect flows preserve both. Placeholder substitution is literal
and single-pass, including names containing dollar signs or braces. Missing or
revoked passbook links omit their template line; a valid customer passbook link
is appended when no placeholder is supplied. Device-only demo passbook links
are not shared. Owner invite links and known API-key text in exported details
are refused rather than accidentally shared.

A File is prepared before the user taps Share. File support is checked with
`navigator.canShare({files})`; the tap calls `navigator.share({files, text})`
without first awaiting image generation. Native sharing is optional and does
not let the app pick the WhatsApp recipient. The operating system/receiving app
may omit accompanying text. Copy message is always available after successful
sync, alongside Download image and Text only (the latter needs a saved phone).
Cancellation leaves the preview; errors leave retry/fallback choices. No success
toast claims that a message was sent or delivered. Repeated native-share taps
are disabled until the current handoff settles.

## Automated verification

Run `npm test` for actual-source backend tests and the complete browser suite.
The focused suite is `npm test -- tests/e2e/balance-share.spec.mjs`.
Tests use mock Google services and a mocked native share handler; they never
send WhatsApp messages or operate a merchant ledger.

Verified locally on 14 September 2026: **157 browser tests and 13 backend tests
passed**. After the final scoped preview-layout adjustment, the **31 balance-share
tests** passed again. PNG and 320px/390px preview screenshots were visually checked.

Coverage includes:

- Real PNG signature/dimensions, Canvas label/color/amount/date output, red and
  green snapshots, zero, decimal currency, long names and oversized amounts.
- Correct File/text handed to native sharing in a user gesture, no PIN/no new
  financial writes, missing phone, download/clipboard fallback, cancellation,
  failed native share and repeated taps.
- Both templates surviving reload and key refresh, literal text (not HTML),
  revoked passbooks and refusal to export owner credentials.
- Pending financial sync and temporary-ID remapping, failed financial jobs,
  photo-only queue, offline/auth/HTML errors, queue/list timeouts, cancelled
  rendering, stale balance/currency/ledger/customer state and URL cleanup.
- 320px preview layout and safe reload prompting with an older cached HTML shell.

Browser screenshots demonstrate app/PNG rendering, not real WhatsApp caption
handling. That requires the separate physical checks below.

## Physical verification — pending

Use the temporary HTTPS preview from this task (keep the laptop/tunnel running).
Try demo and send sample data to your own WhatsApp chat first. For real sync,
use a dedicated test ledger. No Apps Script change is needed.

| Check | Phone / OS / browser / keyboard | Result |
| --- | --- | --- |
| Red and green card readability and direction | Not recorded | Pending |
| Image and accompanying text both reach WhatsApp | Not recorded | Pending |
| Passbook remains clickable; Copy message works if caption is omitted | Not recorded | Pending |
| Recipient selection, cancellation and repeat sharing | Not recorded | Pending |
| Download/text-only fallback and installed-PWA update | Not recorded | Pending |

Test Chrome, Samsung Internet and Safari as available. Do not generalize a pass
on one browser to the others. Record native results separately in the PR.

## Release

Frontend shell is v26 and includes the new renderer script. Apps Script code,
release hashes, scopes and data schemas are unchanged. No backend redeployment
is required. A draft PR and test preview are the delivery boundary; production
publication/merge requires explicit approval.
