# Pain Tracker

A small, private, installable pain diary inspired by the companion Migraine Log app. It is local-first, has no build step, and can optionally sync through Firebase.

## Features

- Date and time for every entry
- Built-in symptom chips for stomach-ache, headache, nausea, and dizziness
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

## Run locally

Serve the folder over HTTP so offline support works:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Tests

```powershell
node --test tools/test.cjs
```

The Firestore rules have their own tests, which run against the local emulator (it needs Java 21 or newer):

```powershell
npx firebase-tools emulators:exec --only firestore --project demo-pain-tracker "node tools/rules-test.cjs"
```

The diary remains available in browser `localStorage`, including while offline. When Firebase sync is enabled and the user signs in, saved entries, custom options, theme, and reminder preference are also stored in that user's private Firestore path and changes upload after reconnecting. A device's diary stays linked to the Google account it first synced with: signing in with a different account asks before replacing it and never merges it into that account, and signing out offers to remove the diary from the device once every change has synced.

## Firebase setup

1. Create a Firebase web app and place its public configuration in `firebase-config.js`.
2. Enable Google as a Firebase Authentication sign-in provider and add the deployed site hostname to Authentication's authorized domains.
3. Create a Firestore database. Before deploying the rules, add a document at `config/access` with a field `emails`: an array of the lowercase Google addresses allowed to sync. Nobody can sync until it exists, and you can edit it in the console later without redeploying.
4. Deploy `firestore.rules` with `firebase deploy --only firestore:rules`.
5. Recommended: set a budget alert for the Google Cloud project and turn on App Check. Register a reCAPTCHA v3 key for the site's domain (add `localhost` to test locally), register the web app on the Firebase console's App Check page with that key's secret, put the site key in `PAIN_APP_CHECK_SITE_KEY` in `firebase-config.js`, deploy, and enforce App Check for Cloud Firestore once its metrics show verified requests.

The rules permit an allowed, signed-in Google account to read and append records only inside its own `users/{uid}/changes` collection, only in the shapes the app writes, with capped note lengths and list sizes. Existing records cannot be changed. Once a newer record is saved, the app removes the older ones, so the cloud keeps only the latest version of each entry and of the settings. A deleted entry leaves only a small deletion record (the entry ID and time) so other devices remove it too.
