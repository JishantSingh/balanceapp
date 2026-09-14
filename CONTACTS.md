# Customer contact picker

Choose from contacts appears above Name in both New customer and Edit customer.
It requests one contact's name and phone numbers. It replaces both draft fields;
the merchant reviews/edits and taps Save. An existing ledger name is not preserved
automatically when importing a different name. Cancel leaves stored data unchanged.

Multiple distinct numbers require an explicit inline choice. Cancel selection
leaves the previous draft untouched. Missing fields become empty with a notice;
Name is required and Phone is optional. Existing phone normalization is reused
(ten-digit local number, optional leading zero or configured country code).
Invalid imported values stay visible for correction or removal before Save.
Duplicate-customer behavior is unchanged; there is no automatic matching/merging.

## Privacy and browser support

- No bulk import, background address-book access, Google Contacts integration,
  contact identifiers, emails, or contact-result logging/caching.
- Raw picker results and unselected numbers remain in memory only. Only the
  selected name and number use the ordinary customer cache/write queue after Save.
- The browser API is called directly from the tap, after a capability check.
  It requests `['name', 'tel']` with `{ multiple: false }`. No other fields.
- Requires a secure top-level context and support for both properties. Unsupported
  browsers retain the normal manual form; picker failures offer manual entry/retry.
- Android Chrome is the primary supported target. This is not universal browser
  support and is not persistent permission to read contacts.

References: [Chrome Contact Picker API](https://developer.chrome.com/docs/capabilities/web-apis/contact-picker),
[MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/ContactsManager.json).

Native selection is not abortable by the app. A form/ledger session guard discards
late results after cancellation/navigation; a global in-flight marker prevents
overlapping native pickers. Returning from a native picker through background/
foreground changes does not invalidate the active draft. Save and field edits
are disabled during native/number selection; the form can still be cancelled.

## Automated verification

```sh
npx playwright test tests/e2e/contacts.spec.mjs tests/e2e/customer-form.spec.mjs
npm test
```

The contact tests mock only the platform picker and use synthetic names/numbers;
the actual app DOM, event handlers, validation, cache, queue and mocked backend
are exercised. Tests verify request fields/user activation, add/edit review,
manual overrides and casing, multiple-number choice/cancellation, missing/invalid
data, unsupported contexts/properties, permission failure, repeated taps, late
results and capability checks, ledger switches, foreground return, and offline
reload/reconnect. They also check that raw/unselected contact data is never saved,
markup is treated as text, and 320/390px light/dark layouts remain usable.

Verified locally on 14 September 2026: **182 browser + 13 backend tests passed**.
The final focused contact/customer-form rerun passed **33 tests**, including the
unselected-number privacy assertion. New/filled/multiple-number screenshots were
inspected, including 320px dark mode. The temporary HTTPS preview's HTML, app JS,
CSS and service worker were hash-checked against the tested local files.

Automated API mocks do not prove native-picker behavior on a physical phone.

## Physical preview checklist

Use the existing [temporary HTTPS preview workflow](PHOTO-CONTROLS-TESTING.md#temporary-phone-preview-no-github-release).
Start in Try demo with a designated test contact; use a dedicated test ledger
only for real Sheets persistence. Never attach personal address-book screenshots.

| Environment | Status |
| --- | --- |
| Android Chrome, native contact selection | Pending physical verification |
| Chrome-installed PWA | Pending physical verification |
| Samsung Internet / Firefox manual fallback | Pending physical verification |
| iPhone Safari manual fallback | Pending; if available |

- Add: select a test contact, check name/number, manually edit, then Save.
- Edit: import both fields, cancel the sheet and confirm original details remain;
  repeat and Save to confirm the existing customer changes, not its entries.
- Select a contact with multiple numbers; verify number order, no default choice,
  Cancel selection, and use of the number actually tapped.
- Cancel/deny the native picker; confirm the draft remains and manual entry works.
- Check missing phone/name, configured-country-code formatting, and invalid numbers.
- Return from the picker to the same draft, including the installed PWA.
- Offline: import/save in the opened app, reload, reconnect and confirm one customer.
- On an unsupported browser, confirm there is no nonworking contacts button and
  manual add/edit still works.

Record device, OS/browser versions and outcomes separately from automated results.

## Delivery

Frontend shell v27. No Apps Script code, scopes, API or schema changes. No
merchant backend redeployment is needed. Merge/publish only after approval.
