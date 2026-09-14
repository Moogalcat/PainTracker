/* Optional Firebase sync. The diary remains fully local when it is not configured. */
'use strict';

const syncBridge = window.PainTrackerAppSync;
const syncConfig = window.PAIN_FIREBASE_CONFIG;
const appCheckSiteKey = typeof window.PAIN_APP_CHECK_SITE_KEY === 'string' ? window.PAIN_APP_CHECK_SITE_KEY.trim() : '';
const syncStatus = document.getElementById('syncStatus');
const syncDescription = document.getElementById('syncDescription');
const syncAccount = document.getElementById('syncAccount');
const syncSignIn = document.getElementById('syncSignIn');
const syncSignOut = document.getElementById('syncSignOut');
const syncResult = document.getElementById('syncResult');
const SYNC_META_KEY = 'pain-tracker-sync-v1';
const FIREBASE_VERSION = '12.18.0';
const CHANGE_GENERATION = 1;
const DELETE_BATCH_SIZE = 400;

let firebaseApi;
let auth;
let db;
let activeUser;
let stopChanges;
let baseline = syncBridge?.getState();
let snapshotQueue = Promise.resolve();
let serverSynced = false;
let signOutMessage = '';
let watchAttempt = 0;
const removalRequested = new Set();

function setSyncStatus(value) {
  syncStatus.textContent = ` · ${value}`;
}

function showSyncResult(message, isError = false) {
  syncResult.textContent = message;
  syncResult.classList.toggle('error', isError);
  syncResult.hidden = !message;
}

function friendlyError(error) {
  if (error?.code === 'auth/unauthorized-domain') return 'This site address must be added to Firebase Authentication’s authorized domains.';
  if (error?.code === 'auth/popup-closed-by-user') return 'Sign-in was cancelled.';
  if (error?.code === 'auth/popup-blocked') return 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  if (error?.code === 'permission-denied') return 'Firebase denied access. This Google account may not be allowed to sync, or the Firestore rules have not been deployed.';
  return navigator.onLine ? 'Sync could not connect. Try again in a moment.' : 'You are offline. Changes will sync after reconnecting.';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadSyncMeta() {
  try {
    const value = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
    const tombstones = value && typeof value.tombstones === 'object' ? value.tombstones : {};
    return {
      deviceId: typeof value.deviceId === 'string' && value.deviceId ? value.deviceId : PainData.uid(),
      accountUid: typeof value.accountUid === 'string' && value.accountUid ? value.accountUid : null,
      settingsModifiedAt: Number.isFinite(value.settingsModifiedAt) ? value.settingsModifiedAt : 0,
      tombstones: Object.fromEntries(Object.entries(tombstones).filter(([, time]) => Number.isFinite(time))),
    };
  } catch {
    return { deviceId: PainData.uid(), accountUid: null, settingsModifiedAt: 0, tombstones: {} };
  }
}

let syncMeta = loadSyncMeta();
function saveSyncMeta() {
  try { localStorage.setItem(SYNC_META_KEY, JSON.stringify(syncMeta)); }
  catch (error) { console.warn('Could not save sync metadata', error); }
}
saveSyncMeta();

function entryRecord(entry) {
  return { kind: 'entry', id: entry.id, deleted: false,
    modifiedAt: entry.updatedAt || entry.at, entry: clone(entry) };
}

function deletionRecord(id, time) {
  return { kind: 'entry', id, deleted: true, modifiedAt: new Date(time).toISOString() };
}

function settingsRecord(current, time) {
  return { kind: 'settings', modifiedAt: new Date(time).toISOString(),
    customSymptoms: [...current.customSymptoms],
    customCharacteristics: [...current.customCharacteristics],
    customRelief: [...current.customRelief],
    customMedications: [...current.customMedications],
    customTriggers: [...current.customTriggers],
    preferences: { ...current.preferences } };
}

function settingsValue(value) {
  return [value.customSymptoms, value.customCharacteristics, value.customRelief, value.customMedications,
    value.customTriggers, value.preferences];
}

function sameSettings(a, b) {
  return JSON.stringify(settingsValue(a)) === JSON.stringify(settingsValue(b));
}

function newest(records, key) {
  const latest = new Map();
  for (const record of records) {
    const id = key(record);
    const current = latest.get(id);
    const time = Date.parse(record.modifiedAt);
    if (!Number.isFinite(time) || id == null) continue;
    if (!current || time > Date.parse(current.modifiedAt)
      || (time === Date.parse(current.modifiedAt) && record.cloudId > current.cloudId)) latest.set(id, record);
  }
  return [...latest.values()];
}

function appendChanges(records) {
  if (!activeUser || !records.length) return;
  const changes = firebaseApi.collection(db, 'users', activeUser.uid, 'changes');
  setSyncStatus(navigator.onLine ? 'Syncing' : 'Offline');
  const batch = firebaseApi.writeBatch(db);
  for (const record of records) {
    batch.set(firebaseApi.doc(changes), { ...record, generation: CHANGE_GENERATION,
      deviceId: syncMeta.deviceId });
  }
  batch.commit().catch(error => {
    console.error('Cloud write failed', error);
    setSyncStatus(navigator.onLine ? 'Error' : 'Offline');
    showSyncResult(friendlyError(error), true);
  });
}

// The cloud keeps only the newest record for each entry and for settings.
function removeSupersededRecords(records) {
  const cloudIds = PainSyncData.supersededRecords(records).filter(id => !removalRequested.has(id));
  const changes = firebaseApi.collection(db, 'users', activeUser.uid, 'changes');
  for (let start = 0; start < cloudIds.length; start += DELETE_BATCH_SIZE) {
    const batch = firebaseApi.writeBatch(db);
    for (const cloudId of cloudIds.slice(start, start + DELETE_BATCH_SIZE)) {
      removalRequested.add(cloudId);
      batch.delete(firebaseApi.doc(changes, cloudId));
    }
    batch.commit().catch(error => console.warn('Superseded cloud records could not be removed', error));
  }
}

function localChanges(previous, current) {
  baseline = clone(current);
  if (!activeUser || !previous) return;
  const before = new Map(previous.entries.map(entry => [entry.id, entry]));
  const after = new Map(current.entries.map(entry => [entry.id, entry]));
  const records = [];
  const now = Date.now();

  for (const entry of after.values()) {
    if (!before.has(entry.id) || JSON.stringify(before.get(entry.id)) !== JSON.stringify(entry)) records.push(entryRecord(entry));
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      syncMeta.tombstones[id] = now;
      records.push(deletionRecord(id, now));
    }
  }
  const oldDeleted = new Set(previous.deletedIds);
  for (const id of current.deletedIds) {
    if (!oldDeleted.has(id) && !syncMeta.tombstones[id]) {
      syncMeta.tombstones[id] = now;
      records.push(deletionRecord(id, now));
    }
  }
  if (!sameSettings(previous, current)) {
    syncMeta.settingsModifiedAt = now;
    records.push(settingsRecord(current, now));
  }
  saveSyncMeta();
  appendChanges(records);
}

window.PainTrackerSyncStateChanged = () => {
  const current = syncBridge?.getState();
  if (current) localChanges(baseline, current);
};

async function applySnapshot(snapshot) {
  if (!activeUser) return;
  const records = snapshot.docs.map(item => ({ ...item.data(), cloudId: item.id,
    confirmed: !item.metadata.hasPendingWrites }));
  const remoteEntries = newest(records.filter(PainSyncData.isEntryChange), record => record.id);
  const remoteSettings = newest(records.filter(record => record.kind === 'settings'), () => 'settings')[0];
  const current = syncBridge.getState();
  for (const id of current.deletedIds) {
    if (!Number.isFinite(syncMeta.tombstones[id])) syncMeta.tombstones[id] = Date.now();
  }
  const reconciled = PainSyncData.reconcileEntries(current, remoteEntries, syncMeta.tombstones);
  syncMeta.tombstones = reconciled.tombstones;
  let next = reconciled.state;
  const uploads = [...reconciled.uploads];
  const cloudSettings = remoteSettings && PainSyncData.readSettings(remoteSettings);

  if (cloudSettings) {
    const remoteTime = Date.parse(remoteSettings.modifiedAt);
    if (remoteTime >= syncMeta.settingsModifiedAt) {
      if (!sameSettings(next, cloudSettings)) {
        next = { ...next,
          customSymptoms: cloudSettings.customSymptoms,
          customCharacteristics: cloudSettings.customCharacteristics,
          customRelief: cloudSettings.customRelief,
          customMedications: cloudSettings.customMedications,
          customTriggers: cloudSettings.customTriggers,
          preferences: cloudSettings.preferences };
        reconciled.changed = true;
      }
      syncMeta.settingsModifiedAt = remoteTime;
    } else if (!snapshot.metadata.fromCache) uploads.push(settingsRecord(next, syncMeta.settingsModifiedAt));
  } else if (!remoteSettings && !snapshot.metadata.fromCache) {
    syncMeta.settingsModifiedAt = Date.now();
    uploads.push(settingsRecord(next, syncMeta.settingsModifiedAt));
  }

  if (reconciled.changed && !syncBridge.applyState(next)) {
    setSyncStatus('Paused');
    showSyncResult('Cloud changes are waiting because local storage is unavailable or changed in another tab.', true);
    return;
  }
  baseline = clone(next);
  saveSyncMeta();

  if (!snapshot.metadata.fromCache) {
    serverSynced = true;
    appendChanges(uploads);
    removeSupersededRecords(records);
  }
  if (reconciled.invalid) showSyncResult(`${reconciled.invalid} unreadable cloud record${reconciled.invalid === 1 ? '' : 's'} were ignored.`, true);
  else if (remoteSettings && !cloudSettings) showSyncResult('Unreadable cloud settings were ignored.', true);
  else if (!snapshot.metadata.hasPendingWrites) showSyncResult('');
  setSyncStatus(snapshot.metadata.hasPendingWrites ? (navigator.onLine ? 'Syncing' : 'Offline')
    : snapshot.metadata.fromCache && !navigator.onLine ? 'Offline' : 'Synced');
}

function stopWatching() {
  if (stopChanges) { stopChanges(); stopChanges = undefined; }
  activeUser = undefined;
  serverSynced = false;
}

function resetSyncMeta(accountUid) {
  syncMeta = { deviceId: syncMeta.deviceId, accountUid, settingsModifiedAt: 0, tombstones: {} };
  saveSyncMeta();
}

// Returns whether this account may sync with the diary on this device.
function claimDiary(user) {
  const current = syncBridge.getState();
  const action = PainSyncData.signInAction(syncMeta.accountUid, user.uid, current);
  if (action === 'sync') return true;
  if (action === 'link') {
    syncMeta.accountUid = user.uid;
    saveSyncMeta();
    return true;
  }
  if (action === 'ask' && !window.confirm('This device has a diary from a different Google account.\n\n'
    + `Remove it from this device and load the diary for ${user.email || 'this account'} instead? `
    + 'Changes made while signed out exist only on this device, so export a backup first if you need them.\n\n'
    + 'Choose Cancel to sign out and keep it.')) {
    signOutMessage = 'Signed out. This device’s diary was not added to that account. To move it, export a backup and import it after signing in.';
    return false;
  }
  const cleared = action === 'ask' ? syncBridge.clearDiary()
    : !current.deletedIds.length || syncBridge.applyState({ ...current, deletedIds: [] });
  if (!cleared) {
    signOutMessage = 'Signed out. The diary on this device could not be replaced, so nothing was changed.';
    return false;
  }
  resetSyncMeta(user.uid);
  return true;
}

// Signing in does not grant sync: the rules only admit allowed accounts. Checked before the diary is touched.
async function mayAccess(user) {
  if (!navigator.onLine) return true;
  try {
    await firebaseApi.getDocs(firebaseApi.query(firebaseApi.collection(db, 'users', user.uid, 'changes'), firebaseApi.limit(1)));
    return true;
  } catch (error) {
    return error?.code !== 'permission-denied';
  }
}

async function watchUser(user) {
  const attempt = ++watchAttempt;
  stopWatching();
  if (user) setSyncStatus(navigator.onLine ? 'Connecting' : 'Offline');
  const allowed = !user || await mayAccess(user);
  if (attempt !== watchAttempt) return;
  if (!allowed) {
    signOutMessage = 'Signed out. This Google account is not allowed to sync.';
    setSyncStatus('Signing out');
    firebaseApi.signOut(auth).catch(error => showSyncResult(friendlyError(error), true));
    return;
  }
  if (user && !syncBridge.isCurrent()) {
    setSyncStatus('Paused');
    showSyncResult('The diary changed in another tab. Reload this tab to sync.', true);
    return;
  }
  if (user && !claimDiary(user)) {
    setSyncStatus('Signing out');
    firebaseApi.signOut(auth).catch(error => showSyncResult(friendlyError(error), true));
    return;
  }
  activeUser = user;
  baseline = syncBridge.getState();
  syncSignIn.hidden = !!user;
  syncSignOut.hidden = !user;
  syncAccount.hidden = !user;
  syncAccount.textContent = user ? `Signed in as ${user.email || 'Google user'}` : '';
  if (!user) {
    setSyncStatus('Off');
    showSyncResult(signOutMessage);
    signOutMessage = '';
    return;
  }
  setSyncStatus(navigator.onLine ? 'Connecting' : 'Offline');
  const changes = firebaseApi.query(
    firebaseApi.collection(db, 'users', user.uid, 'changes'),
    firebaseApi.where('generation', '==', CHANGE_GENERATION)
  );
  stopChanges = firebaseApi.onSnapshot(changes, { includeMetadataChanges: true }, snapshot => {
    snapshotQueue = snapshotQueue.then(() => applySnapshot(snapshot)).catch(error => {
      console.error('Cloud merge failed', error);
      setSyncStatus('Error');
      showSyncResult(friendlyError(error), true);
    });
  }, error => {
    console.error('Cloud listener failed', error);
    setSyncStatus(navigator.onLine ? 'Error' : 'Offline');
    showSyncResult(friendlyError(error), true);
  });
}

async function cloudHasEverything() {
  if (!serverSynced || !navigator.onLine) return false;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, 10000, false); });
  try { return await Promise.race([firebaseApi.waitForPendingWrites(db).then(() => true), timeout]); }
  catch { return false; }
  finally { clearTimeout(timer); }
}

async function signOutClicked() {
  const user = activeUser;
  const removeDiary = !!user && PainSyncData.hasDiary(syncBridge.getState())
    && window.confirm('Also remove the diary from this device? It stays saved in your Google account.');
  syncSignOut.disabled = true;
  try {
    if (removeDiary) {
      if (!await cloudHasEverything()) {
        showSyncResult('You are still signed in because some changes have not reached your account yet. Try again when sync shows Synced, or export a backup first.', true);
        return;
      }
      stopWatching();
      if (!syncBridge.clearDiary()) { watchUser(user); return; }
      resetSyncMeta(null);
      signOutMessage = 'Signed out and removed the diary from this device.';
    }
    await firebaseApi.signOut(auth);
  } catch (error) {
    signOutMessage = '';
    showSyncResult(friendlyError(error), true);
    if (auth.currentUser && !activeUser) watchUser(auth.currentUser);
  } finally { syncSignOut.disabled = false; }
}

async function startSync() {
  if (!syncBridge || !syncConfig || !['apiKey', 'authDomain', 'projectId', 'appId'].every(key => syncConfig[key])) return;
  setSyncStatus('Loading');
  showSyncResult('');
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appApi, authApi, firestoreApi, appCheckApi] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`),
    appCheckSiteKey ? import(`${base}/firebase-app-check.js`) : null,
  ]);
  const firebaseApp = appApi.initializeApp(syncConfig);
  if (appCheckApi) {
    appCheckApi.initializeAppCheck(firebaseApp, {
      provider: new appCheckApi.ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }
  auth = authApi.getAuth(firebaseApp);
  await authApi.setPersistence(auth, authApi.browserLocalPersistence);
  db = firestoreApi.getFirestore(firebaseApp);
  firebaseApi = { ...authApi, ...firestoreApi };
  syncSignIn.disabled = false;
  syncSignIn.addEventListener('click', async () => {
    syncSignIn.disabled = true;
    setSyncStatus('Signing in');
    showSyncResult('');
    try { await authApi.signInWithPopup(auth, new authApi.GoogleAuthProvider()); }
    catch (error) {
      console.error('Google sign-in failed', error);
      setSyncStatus('Off');
      showSyncResult(friendlyError(error), true);
    }
    finally { syncSignIn.disabled = false; }
  });
  syncSignOut.addEventListener('click', signOutClicked);
  authApi.onAuthStateChanged(auth, watchUser, error => {
    setSyncStatus('Error');
    showSyncResult(friendlyError(error), true);
  });
  syncDescription.textContent = 'Sign in with the same Google account on each device to keep saved entries in sync. Logging continues to work offline.';
}

startSync().catch(error => {
  console.error('Firebase could not start', error);
  setSyncStatus(navigator.onLine ? 'Unavailable' : 'Offline');
  showSyncResult(friendlyError(error), true);
});
