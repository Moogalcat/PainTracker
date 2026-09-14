/* Optional Firebase sync. The diary remains fully local when it is not configured. */
'use strict';

const syncBridge = window.PainTrackerAppSync;
const syncConfig = window.PAIN_FIREBASE_CONFIG;
const syncStatus = document.getElementById('syncStatus');
const syncDescription = document.getElementById('syncDescription');
const syncAccount = document.getElementById('syncAccount');
const syncSignIn = document.getElementById('syncSignIn');
const syncSignOut = document.getElementById('syncSignOut');
const syncResult = document.getElementById('syncResult');
const SYNC_META_KEY = 'pain-tracker-sync-v1';
const FIREBASE_VERSION = '12.18.0';
const CHANGE_GENERATION = 1;

let firebaseApi;
let auth;
let db;
let activeUser;
let stopChanges;
let baseline = syncBridge?.getState();
let snapshotQueue = Promise.resolve();

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
  if (error?.code === 'permission-denied') return 'Firebase denied access. Check that the supplied Firestore rules have been deployed.';
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
      settingsModifiedAt: Number.isFinite(value.settingsModifiedAt) ? value.settingsModifiedAt : 0,
      tombstones: Object.fromEntries(Object.entries(tombstones).filter(([, time]) => Number.isFinite(time))),
    };
  } catch {
    return { deviceId: PainData.uid(), settingsModifiedAt: 0, tombstones: {} };
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

function normaliseCloudSettings(record) {
  try {
    const parsed = PainData.parse({
      version: PainData.backupVersion,
      entries: [],
      customSymptoms: record.customSymptoms,
      customCharacteristics: record.customCharacteristics,
      customRelief: record.customRelief,
      customMedications: record.customMedications,
      customTriggers: record.customTriggers,
      preferences: record.preferences,
    }, true);
    return parsed;
  } catch {
    return null;
  }
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
  const records = snapshot.docs.map(item => ({ ...item.data(), cloudId: item.id }));
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
  const cloudSettings = remoteSettings && normaliseCloudSettings(remoteSettings);

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

  if (!snapshot.metadata.fromCache) appendChanges(uploads);
  if (reconciled.invalid) showSyncResult(`${reconciled.invalid} unreadable cloud record${reconciled.invalid === 1 ? '' : 's'} were ignored.`, true);
  else if (remoteSettings && !cloudSettings) showSyncResult('Unreadable cloud settings were ignored.', true);
  else if (!snapshot.metadata.hasPendingWrites) showSyncResult('');
  setSyncStatus(snapshot.metadata.hasPendingWrites ? (navigator.onLine ? 'Syncing' : 'Offline')
    : snapshot.metadata.fromCache && !navigator.onLine ? 'Offline' : 'Synced');
}

function watchUser(user) {
  if (stopChanges) { stopChanges(); stopChanges = undefined; }
  activeUser = user;
  baseline = syncBridge.getState();
  syncSignIn.hidden = !!user;
  syncSignOut.hidden = !user;
  syncAccount.hidden = !user;
  syncAccount.textContent = user ? `Signed in as ${user.email || 'Google user'}` : '';
  if (!user) {
    setSyncStatus('Off');
    showSyncResult('');
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

async function startSync() {
  if (!syncBridge || !syncConfig || !['apiKey', 'authDomain', 'projectId', 'appId'].every(key => syncConfig[key])) return;
  setSyncStatus('Loading');
  showSyncResult('');
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appApi, authApi, firestoreApi] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`),
  ]);
  const firebaseApp = appApi.initializeApp(syncConfig);
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
  syncSignOut.addEventListener('click', async () => {
    syncSignOut.disabled = true;
    try { await authApi.signOut(auth); }
    catch (error) { showSyncResult(friendlyError(error), true); }
    finally { syncSignOut.disabled = false; }
  });
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
