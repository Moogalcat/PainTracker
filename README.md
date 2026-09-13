# Pain Tracker

A small, private, installable pain diary inspired by the companion Migraine Log app. It runs entirely in the browser and has no runtime dependencies or build step.

## Features

- Date and time for every entry
- Built-in symptom chips for stomach-ache, headache, nausea, and dizziness
- Custom symptom chips
- A tappable 0–10 intensity scale for every selected symptom
- Common and custom pain-characteristic chips
- Optional end time and duration, or mark an entry as ongoing
- Activity-impact levels and relief attempts with effectiveness ratings
- User-defined possible triggers
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
