# Photo controls: preview and acceptance

This records the original single-photo camera release. For v9 multiple photos,
the current acceptance matrix and rollout requirements are in
[MULTIPLE-PHOTOS.md](MULTIPLE-PHOTOS.md).

Add photo / Change opens Take photo, Choose from gallery, and Cancel. Take
photo opens an in-app camera via `getUserMedia` with Capture, Retake and Use
photo. It prefers the rear lens, requests no microphone and never opens a
file picker. Gallery selection and accepted captures use the existing
compression, preview and upload flow. Camera errors offer gallery selection.

## Automated checks

```sh
npm test -- tests/e2e/camera.spec.mjs tests/e2e/photos.spec.mjs
npm test
```

The camera tests use Chromium's synthetic camera to exercise real
getUserMedia, video playback and frame capture without activating physical
hardware. Tests verify Capture/Retake/Use photo, no file chooser on the camera
path, permission and hardware failures, gallery fallback, late permission
results, and releasing tracks on capture, cancel, Escape, background and
navigation. The photo tests also cover preview/upload/reopening, unreadable
files, repeated gallery selection, PIN-protected replacement, Save during
processing, late results after closing a form, and offline queue/retry.
They use a mock backend, not real Sheets or Drive. Physical camera selection,
focus, image quality and browser-specific permission UX still need phone checks.

Verified locally on 12 September 2026: in-app camera/photo suite **24 passed**;
complete ledger suite **101 passed**. The HTTPS preview assets match the
tested local build, and its existing PWA updated successfully through the
new-version button.
Camera live/review layouts inspected at 360px with synthetic camera frames;
the source chooser was also inspected at 320px and 360px. Camera controls
have 48px touch targets. Phone-camera and real Google ledger checks below
remain pending.

## Temporary phone preview (no GitHub release)

Install `cloudflared` once (`brew install cloudflared`, or use Cloudflare's
official standalone macOS client). In separate terminals in this repository:

```sh
PORT=4174 node tests/serve.mjs
cloudflared tunnel --url http://127.0.0.1:4174
```

Only the static `docs/` app is served. Keep the laptop awake and both processes
running while testing. Share the generated HTTPS address with the tester.
Keep one tunnel running throughout a test session: restarting it changes the
origin and the phone's saved connection will not follow to the new address.
Stop both processes with Ctrl-C when the session is complete.

Start with **Try demo**. The preview has separate browser storage from the
published app. Use a dedicated test Google ledger for the real upload/PIN/
offline-sync checks; demo mode cannot prove those backend operations.
Do not add ledger keys, invite links or merchant photos to this repository.

## Physical checks (pending tester confirmation)

- [ ] Phone browser: Given/Received → enter amount and note → Add photo →
      Take photo. Allow camera permission if prompted. Confirm a live in-app
      preview appears, with no Camera/Files picker; Capture → Use photo.
- [ ] Preview is correctly oriented and bill details remain readable. Save,
      open the thumbnail, and check the full photo.
- [ ] Retake, cancel the camera, and cancel the source chooser. Amount, note,
      date and any previous photo survive. Repeat gallery selection.
- [ ] Repeat in the preview installed through Add to Home screen. Returning
      from capture must return to the same transaction draft. The camera-use
      indicator must stop on capture, cancel and when backgrounding the app.
- [ ] Deny camera permission and verify a helpful message plus gallery
      fallback. Re-enable permission in the browser and use Try again.
- [ ] Test Google ledger: set an App PIN, unlock an existing entry, replace
      its photo, and verify the new photo on reopening and in the test Drive.
- [ ] Test Google ledger: while offline, capture and save a photo entry,
      reload the installed app, reconnect, and sync. Confirm one transaction
      and one uploaded photo, with the pending count back at zero.

Record the phone model, OS/browser versions and outcomes in the PR. Use the
same checks in Chrome, Samsung Internet and Safari as available. Untested
phone/browser combinations remain unverified. Release follows approval; this
frontend change requires no Apps Script redeployment.
