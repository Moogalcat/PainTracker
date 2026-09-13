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

The diary remains available in browser `localStorage`, including while offline. When Firebase sync is enabled and the user signs in, saved entries, custom options, theme, and reminder preference are also stored in that user's private Firestore path and changes upload after reconnecting.

## Firebase setup

1. Create a Firebase web app and place its public configuration in `firebase-config.js`.
2. Enable Google as a Firebase Authentication sign-in provider and add the deployed site hostname to Authentication's authorized domains.
3. Create a Firestore database and deploy `firestore.rules` with `firebase deploy --only firestore:rules`.

The rules permit a signed-in user to read and append records only inside their own `users/{uid}/changes` collection. Existing records cannot be changed or deleted by clients.
