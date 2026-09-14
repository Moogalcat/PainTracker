# Run your own copy with sync

The public Pain Tracker site syncs only for Google accounts its owner has added. To sync your own devices without sharing your address or your diary with anyone, run your own copy of the app with your own Firebase project. Your diary is then stored only in your browsers and in a Firebase project that you alone control.

You need a GitHub account and a Google account. Everything used here is free, and setting it up takes about 30–45 minutes. Firebase menus are sometimes renamed, so a label may differ slightly from the wording below.

Throughout this guide, replace `USERNAME` with your GitHub username and `REPOSITORY` with the name of your copy (normally `PainTracker`).

## 1. Copy the app on GitHub

1. Sign in to GitHub and open <https://github.com/Moogalcat/PainTracker>.
2. Click **Fork**, keep the suggested name, and click **Create fork**.

Your copy is public, like the original. That is fine: the repository contains only the app's code. Diary entries are never stored in it.

Don't turn on GitHub Pages yet. Opening the site before step 4 is finished would save the unconfigured version on that device.

## 2. Create your Firebase project

1. Open <https://console.firebase.google.com> and sign in with your Google account.
2. Click **Create a project**, give it a name, and turn off Google Analytics.
3. On the project's start page, click the **Web** icon (`</>`), enter a nickname such as "Pain Tracker", leave Firebase Hosting unticked, and click **Register app**.
4. Firebase shows a `firebaseConfig` block. Keep this page open, or copy the six values (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`) somewhere; you need them in step 4. These values identify your project but are not passwords.

### Turn on Google sign-in

1. Go to **Build → Authentication** and click **Get started**.
2. Under **Sign-in method**, choose **Google**, switch it on, pick your support email, and click **Save**.
3. Under **Settings → Authorized domains**, click **Add domain** and enter `USERNAME.github.io`.

### Create the database and the allowlist

1. Go to **Build → Firestore Database** and click **Create database**. Choose a location near you and **production mode**.
2. On the **Data** tab, at the top level, click **Start collection**.
3. Enter `config` as the collection ID, then `access` as the document ID. Type it; don't use an automatic ID.
4. Add a field named `emails`, set its type to **array**, and add one **string** item: the address of the Google account you will sign in with, in lowercase. Add another item for each other person who should sync with this copy.
5. Click **Save**.

The app only syncs for addresses in this list, and nobody can sync until it exists. You can edit the list later; changes apply the next time someone signs in.

### Publish the security rules

1. Open `firestore.rules` in your copy on GitHub and copy its entire contents.
2. In Firestore, open the **Rules** tab, replace everything there with what you copied, and click **Publish**.

These rules let each allowed account read and write only its own diary records.

## 3. Optional: set a budget alert

Your project starts on the free Spark plan, which is more than enough for a personal diary and cannot charge you. If you ever upgrade to a paid plan, set a budget alert in Google Cloud first.

## 4. Point your copy at your Firebase project

Edit these files in your copy on GitHub: open each file, click the pencil icon, make the change, then click **Commit changes** (committing directly to `main`).

1. **`firebase-config.js`**: replace the six values inside `PAIN_FIREBASE_CONFIG` with your project's values from step 2. Keep the quotes and commas, and leave `PAIN_APP_CHECK_SITE_KEY` as `''`.
2. **`index.html`**: near the top, in the `Content-Security-Policy` line, replace `paintracker-e5caf.firebaseapp.com` with your own `authDomain` value (it looks like `your-project.firebaseapp.com`). Optionally, in the `og:url` and `og:image` lines, replace `https://pain-tracker.github-2ca.workers.dev/` with `https://USERNAME.github.io/REPOSITORY/`.
3. **`_headers`**: make the same `authDomain` replacement. GitHub Pages ignores this file, but keeping it matching lets the app's tests pass and keeps the protection if you ever move to another host.

If you skip the `index.html` change, the browser blocks sign-in (the console shows a Content Security Policy error). If you can run Node.js, `node --test tools/test.cjs` also catches a missed `index.html` or `_headers` change.

## 5. Publish your copy with GitHub Pages

1. In your copy on GitHub, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose the `main` branch and the `/ (root)` folder, and click **Save**.
3. After a minute or two the page shows your site address, `https://USERNAME.github.io/REPOSITORY/`. The **Actions** tab shows the deployment's progress.

Each later commit to `main` publishes again automatically.

GitHub Pages cannot send security headers. The app still protects itself with the policy in `index.html` and refuses to run inside another site's frame.

## 6. Sign in on each device

1. Open your site address and install the app if you like (see **Install this app** in the app).
2. Open **Sync between devices**, click **Sign in with Google**, and use an address from your allowlist.
3. Wait until the panel shows **Synced**, then do the same on your other devices.

Your copy is a different site address from the public site, so it starts with an empty diary. To bring entries across, open the public site, use **Backup & data → Export backup**, then open your copy and use **Import backup**.

## Keeping your copy up to date

Your copy doesn't receive improvements automatically. When you want them, open your copy on GitHub and click **Sync fork → Update branch**, then check that the app still signs in.

If GitHub says the update conflicts with your commits, the original project changed the same lines you edited. Copy your Firebase values first, let GitHub discard your commits, then repeat step 4.

## Troubleshooting

- **"This site address must be added to Firebase Authentication’s authorized domains."** Add `USERNAME.github.io` under Authentication → Settings → Authorized domains (step 2).
- **"Signed out. This Google account is not allowed to sync."** Check that the allowlist is a document named `access` in a top-level collection named `config`, with an array field named `emails` containing your address in lowercase (step 2).
- **"Firebase denied access. This Google account may not be allowed to sync, or the Firestore rules have not been deployed."** Publish the rules (step 2), then check the allowlist.
- **Sign-in does nothing or closes straight away.** Check the `index.html` change in step 4; the browser console shows a Content Security Policy error when it is missing.
- **The site still shows old settings.** Reload the page twice; the app keeps an offline copy that updates in the background.
