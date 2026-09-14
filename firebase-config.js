/*
  Firebase's web configuration is a public project identifier, not a password.
  Access to diary data is enforced by firestore.rules.
*/
window.PAIN_FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyD50RuLbeng5XpUYxauApk-rg2a7AD6xrU',
  authDomain: 'paintracker-e5caf.firebaseapp.com',
  projectId: 'paintracker-e5caf',
  storageBucket: 'paintracker-e5caf.firebasestorage.app',
  messagingSenderId: '844480424049',
  appId: '1:844480424049:web:e2fe64d39c061c9f6ed3d0',
});

/*
  Optional App Check site key (reCAPTCHA v3). Leave empty until the key is registered on the Firebase
  console's App Check page; then enforce App Check for Cloud Firestore there.
*/
window.PAIN_APP_CHECK_SITE_KEY = '';
