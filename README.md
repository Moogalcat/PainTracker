# Pain Tracker

A small, private, installable pain diary inspired by the companion Migraine Log app. It runs entirely in the browser and has no runtime dependencies or build step.

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

All health data stays in browser `localStorage`. Exported JSON backups are the user's responsibility.
