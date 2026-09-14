# Compact customer passbook links

New customer links use the existing site's `/p/` entry point:

```text
https://jishantsingh.github.io/balanceapp/p/#<deployment-id>.<customer-token>
```

The complete Google deployment ID is retained. The complete customer token is
URI-encoded without truncation, then decoded once by the reader. For a 74-character
deployment ID and a 16-character token, this is **136 characters**, compared with
239 for the old encoded-JSON link. Length varies with host, deployment and token.

No shortener, merchant registry, new account/domain or hosting service is involved.
Apps Script code, permissions, APIs and customer tokens are unchanged.

## Generation and compatibility

- Copy passbook link and both WhatsApp message directions use the same generator.
- Canonical `https://script.google.com/macros/s/<id>/exec` URLs use the compact form.
  Other supported Google backend URLs retain the lossless legacy form; query
  parameters and alternate deployment paths are not silently dropped.
- Existing `#p=<base64url JSON>` links continue to work. The new reader also
  accepts real legacy links. Existing local-only demo links remain on the owner
  entry point and never seed demo records on another device.
- A mixed cached owner HTML/JS shell without the new codec continues generating
  old links. It dynamically loads the shared reader when opening an old link.
- Both entry points share one passbook renderer. Invalid/revoked links clear
  stale rows and show an error; late responses cannot restore a previous customer.

## Why `/p/`, not a new hash on the owner page?

Older installed owner apps do not recognize a new hash format and could open
their saved dashboard instead. A new HTML path makes the intended destination
unambiguous even under the old service worker: either the read-only page loads,
or navigation fails. It never falls back to the cached owner page.

The `/p/` page has no owner bundle, controls, configuration, cache/queue access,
or PWA installation. It only sends `passbook` requests with the customer token,
without credentials or referrers. Its policy permits backend connections only
to Google's Script hosts. Customer responses are not persisted by the reader.

**This is still the same origin, not separate-origin storage isolation or an
owner-app lock.** A browser with an existing owner connection can still access
the normal owner URL; this change does not erase or revoke that connection.

## Cache and offline behavior

Frontend shell v29 pre-caches the reader assets. Shell cache keys omit fragments,
so customer tokens do not become distinct HTML cache entries and offline reload
can find the reader shell. Google API responses are never cached by the worker.

The passbook still needs a live backend response. With a cached v29 shell and no
network, it shows a connection error, not cached owner/customer records. An older
v28 worker may show the browser's network-error page offline; opening the link
online works without running its cached owner bundle. No owner data is a fallback.

## Verification

```sh
npx playwright test tests/e2e/compact-passbook.spec.mjs tests/e2e/compact-passbook-cache.spec.mjs tests/e2e/passbook.spec.mjs tests/e2e/customer-form.spec.mjs tests/e2e/balance-share.spec.mjs
npm test
```

Automated coverage includes exact length and token round-trips, copy/open/reload,
both sharing templates, real legacy links, nonstandard backend URLs, malformed
and revoked links, denied destinations, missing assets, response races, timeouts,
storage/credential non-access, and 320/390px light/dark rendering. Cache tests
install real v28/v29 service workers with poisoned owner-only cache markers and
exercise online and offline navigation; the API is mocked with synthetic data.

Verified on 14 September 2026: **212 browser tests and 13 backend tests passed**.
The new reader's light/dark screenshots were inspected at phone widths. Preview
HTML, scripts and service worker matched the local files. A separate read-only
HTTPS preview smoke check against the supplied Google ledger confirmed the same
backend and full token, rendered name/balance/history, and no owner API key or
owner script. No private URL, customer name or amount is recorded here.

Phone verification remains separate: use the temporary HTTPS preview with a
dedicated test ledger, copy its newly generated customer link, send it to yourself
on WhatsApp, and check opening/reload in Chrome and an installed app. Record results
without private tokens or screenshots of real ledger data in the PR.

No production deployment without approval. No Apps Script update is required.
