# Pain Tracker

A small, private, installable pain diary inspired by the companion Migraine Log app. It is local-first, has no build step, and can optionally sync through Firebase.

## Features

- Date and time for every entry
- Built-in symptom chips for headache, stomachache, nausea, and dizziness
- Custom symptom chips
- A tappable 0–10 intensity scale for every selected symptom
- Common and custom pain-characteristic chips
- Mark an entry as still ongoing, ended at a set time (with a "Now" shortcut), or ended at an unknown time
- Activity-impact levels and relief attempts with effectiveness ratings
- Medication names and doses, with a help rating for each medication
- User-defined triggers, each marked as a possible trigger or a known cause
- Quick repeat for recurring symptom patterns
- Notes, history, six-month activity charts, statistics, printable doctor summaries, and CSV reports
- Optional in-app and system reminders for ongoing entries
- Light/dark themes and JSON backup and restore
- Offline support through a service worker
- Optional cross-device sync with Google sign-in

## Live site and deployment

The app is live at <https://pain-tracker.github-2ca.workers.dev/>. Cloudflare Workers Builds deploys the repository root on every push to `main`; the new version is normally live about a minute later. The `CACHE` name in the live `sw.js` shows which version is being served.

Browser storage belongs to one site address. If the app is ever served from a second address, that copy keeps its own local diary, service worker, backup reminder and sync-device state. Only synced entries reach both; move local-only data with an exported backup.

Cloudflare sends the headers in `_headers`:

- `Content-Security-Policy`: scripts, connections and frames only from this site and the Firebase, Google sign-in and reCAPTCHA hosts, plus `frame-ancestors 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

A host that ignores `_headers` sends none of these, so `index.html` repeats the policy in a meta tag, and `app.js` refuses to run inside a frame because a meta tag cannot forbid framing. If a Firebase or reCAPTCHA host changes, update both copies; a test checks that they match. Cloudflare Web Analytics is not enabled. If it is turned on, the policy blocks its beacon and the browser logs a warning; turn analytics off again rather than loosening the policy.

The `noindex` meta tag and `robots.txt` keep the site out of search results. Neither is access control: anyone with the address can open the app, but without signing in they only see the diary stored in their own browser.

## Run locally

Serve the folder over HTTP so offline support works:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`. This server sends none of the `_headers` headers, so only the meta policy applies locally.

## Tests

```powershell
node --test tools/test.cjs
```

The Firestore rules have their own tests, which run in the local emulator. It needs Java 21 or newer (if an older Java comes first on `PATH`, point `JAVA_HOME` and `PATH` at Java 21 for that shell), and it uses port 8080, so stop the local web server first:

```powershell
npx firebase-tools emulators:exec --only firestore --project demo-pain-tracker "node tools/rules-test.cjs"
```

The emulator does not enforce Firestore's per-request limits, so batch sizes cannot be tested there.

When changing HTML, CSS or JavaScript, bump every `?v=` in `index.html` and `sw.js`, and `CACHE` in `sw.js`. Only the app's own page, not a file such as `robots.txt` opened directly, refreshes the copy used offline.

## Sync between devices

The diary remains available in browser `localStorage`, including while offline. When Firebase sync is enabled and the user signs in with an allowed account, saved entries, custom options, theme, and reminder preference are also stored in that user's private Firestore path, and changes upload after reconnecting. A device's diary stays linked to the Google account it first synced with: signing in with a different account asks before replacing it and never merges it into that account, and signing out offers to remove the diary from the device once every change has synced.

- Notes can be up to 50,000 characters, and the notes box stops there. Each list in an entry, and each custom-option list, syncs up to 200 items. An entry beyond these limits, such as a longer note from an imported backup, stays on the device with a message until it is shortened; the rest of the diary still syncs.
- Uploads and cloud cleanup are sent 10 writes per request.
- If Firebase refuses a write, sync shows Paused with a message and sends nothing more, so it never retries in a loop. Changes stay on the device and upload after signing in again or reloading.
- Once a newer record reaches the cloud, the app removes older copies of that entry and older settings records. A deleted entry keeps a small deletion record (its ID and time) that is never removed, so a device that was offline cannot bring the entry back.
- Anyone who signs in with an account that is not on the allowlist is signed straight back out, and the diary on that device is left as it was.

## Firebase setup

1. Create a Firebase web app and place its public configuration in `firebase-config.js`.
2. Enable Google as a Firebase Authentication sign-in provider. Under **Authentication → Settings → Authorized domains**, add every hostname people sign in from; for the live site that is `pain-tracker.github-2ca.workers.dev`.
3. Create a Firestore database. Before deploying the rules, create the allowlist: at the top level of the **Data** tab, start a collection with the ID `config`, add a document with the ID `access` (not an automatic ID), and give it a field `emails` of type array, holding each allowed Google address as a lowercase string. Nobody can sync until this document exists. The rules read it on every request, so edits take effect without redeploying. A field on a document under `users` has no effect.
4. Deploy `firestore.rules`: paste it into **Firestore → Rules** and publish, or run `firebase deploy --only firestore:rules --project paintracker-e5caf`.
5. Recommended: set a budget alert for the Google Cloud project and turn on App Check. Register a reCAPTCHA v3 key for the site's domain (add `localhost` to test locally), register the web app on the Firebase console's App Check page with that key's secret, put the site key in `PAIN_APP_CHECK_SITE_KEY` in `firebase-config.js`, deploy, and enforce App Check for Cloud Firestore once its metrics show verified requests.

The rules permit an allowed, verified Google account to read and append records only inside its own `users/{uid}/changes` collection, only in the shapes the app writes, with notes capped at 50,000 characters, lists at 200 items and entry IDs at 128 characters. Existing records cannot be changed. Clients may delete entry contents and settings records, but never deletion records.

## Production checks

Checked in September 2026: the live site served the current version with the headers above and a meta policy identical to the header apart from `frame-ancestors`; Google sign-in and sync worked there with an allowlisted account; and the rules tests passed in the emulator before those rules were published.
