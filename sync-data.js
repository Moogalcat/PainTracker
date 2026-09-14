/* Pure conflict-resolution rules shared by cloud sync and its tests. */
'use strict';

const PainSyncData = (() => {
  const entryTime = entry => Date.parse(entry.updatedAt || entry.at) || 0;
  const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isEntryChange = record => record?.kind === 'entry'
    || (record?.kind == null && typeof record?.id === 'string'
      && (record.deleted === true || record.entry != null));

  // Only identical copies under different IDs are collapsed. Sharing a start time is not enough:
  // the editor stores whole minutes, so separate entries logged for the same minute are common.
  function dedupeEntries(entries) {
    const unique = new Map();
    for (const entry of entries) {
      const key = PainData.contentKey(entry);
      const existing = unique.get(key);
      if (!existing || entryTime(entry) > entryTime(existing)
        || (entryTime(entry) === entryTime(existing) && entry.id < existing.id)) unique.set(key, entry);
    }
    return [...unique.values()];
  }

  function reconcileEntries(current, remoteRecords, tombstones = {}, now = Date.now()) {
    const byId = new Map(current.entries.map(entry => [entry.id, entry]));
    const deleted = new Set(current.deletedIds);
    const deletedAt = { ...tombstones };
    const seenRemote = new Set();
    let uploads = [];
    let changed = false;
    let invalid = 0;

    for (const id of deleted) {
      if (!Number.isFinite(deletedAt[id])) deletedAt[id] = now;
    }

    for (const record of remoteRecords) {
      if (!record || typeof record.id !== 'string' || !record.id
        || !Number.isFinite(Date.parse(record.modifiedAt))) {
        invalid++;
        continue;
      }
      const id = record.id;
      const remoteTime = Date.parse(record.modifiedAt);
      const local = byId.get(id);
      seenRemote.add(id);

      if (record.deleted === true) {
        if (local && entryTime(local) > remoteTime) {
          uploads.push({ kind: 'entry', id, deleted: false,
            modifiedAt: local.updatedAt || local.at, entry: local });
          continue;
        }
        if (local) { byId.delete(id); changed = true; }
        if (!deleted.has(id)) { deleted.add(id); changed = true; }
        deletedAt[id] = Math.max(deletedAt[id] || 0, remoteTime);
        continue;
      }

      if (!PainData.valid(record.entry) || String(record.entry.id || '') !== id) {
        invalid++;
        continue;
      }
      const remote = PainData.normalise(record.entry);
      if (deleted.has(id)) {
        if ((deletedAt[id] || 0) >= remoteTime) {
          uploads.push({ kind: 'entry', id, deleted: true,
            modifiedAt: new Date(deletedAt[id]).toISOString() });
        } else {
          deleted.delete(id);
          delete deletedAt[id];
          byId.set(id, remote);
          changed = true;
        }
      } else if (!local) {
        byId.set(id, remote);
        changed = true;
      } else if (remoteTime > entryTime(local)
        || (remoteTime === entryTime(local) && !sameEntry(remote, local))) {
        byId.set(id, remote);
        changed = true;
      } else if (entryTime(local) > remoteTime) {
        uploads.push({ kind: 'entry', id, deleted: false,
          modifiedAt: local.updatedAt || local.at, entry: local });
      }
    }

    const uniqueEntries = dedupeEntries([...byId.values()]);
    const uniqueById = new Map(uniqueEntries.map(entry => [entry.id, entry]));
    // Tombstone dropped copies so every device and the cloud keep the same survivor.
    const duplicates = new Set([...byId.keys()].filter(id => !uniqueById.has(id)));
    for (const id of duplicates) {
      deleted.add(id);
      deletedAt[id] = now;
      changed = true;
    }
    uploads = uploads.filter(record => !duplicates.has(record.id));

    for (const entry of uniqueById.values()) {
      if (!seenRemote.has(entry.id)) uploads.push({ kind: 'entry', id: entry.id, deleted: false,
        modifiedAt: entry.updatedAt || entry.at, entry });
    }
    for (const id of deleted) {
      if (!seenRemote.has(id) || duplicates.has(id)) uploads.push({ kind: 'entry', id, deleted: true,
        modifiedAt: new Date(deletedAt[id]).toISOString() });
    }

    return {
      state: { ...current,
        entries: [...uniqueById.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
        deletedIds: [...deleted] },
      tombstones: deletedAt,
      uploads,
      changed,
      invalid,
    };
  }

  function readSettings(record) {
    try {
      return PainData.parse({
        version: PainData.backupVersion,
        entries: [],
        customSymptoms: record.customSymptoms,
        customCharacteristics: record.customCharacteristics,
        customRelief: record.customRelief,
        customMedications: record.customMedications,
        customTriggers: record.customTriggers,
        preferences: record.preferences,
      }, true);
    } catch {
      return null;
    }
  }

  // Cloud records that a newer confirmed, readable record replaces. The newest record for each entry
  // (its deletion record once deleted) and the newest settings stay, so offline devices still catch up.
  // A deletion outranks an edit saved at the same moment, matching reconcileEntries. Deletion records are never
  // listed: the rules keep them, so a device that was offline cannot bring back an entry deleted elsewhere.
  function supersededRecords(records) {
    const groupOf = record => (isEntryChange(record) && typeof record.id === 'string' && record.id ? `entry:${record.id}`
      : record?.kind === 'settings' ? 'settings' : null);
    const readable = record => (record.kind === 'settings' ? readSettings(record) !== null
      : record.deleted === true || (PainData.valid(record.entry) && String(record.entry.id || '') === record.id));
    const outranks = (a, b) => {
      const timeA = Date.parse(a.modifiedAt);
      const timeB = Date.parse(b.modifiedAt);
      if (timeA !== timeB) return timeA > timeB;
      if ((a.deleted === true) !== (b.deleted === true)) return a.deleted === true;
      return String(a.cloudId) > String(b.cloudId);
    };
    const candidates = records.filter(record => record?.confirmed && groupOf(record)
      && Number.isFinite(Date.parse(record.modifiedAt)));
    const newest = new Map();
    for (const record of candidates) {
      const group = groupOf(record);
      if (readable(record) && (!newest.has(group) || outranks(record, newest.get(group)))) newest.set(group, record);
    }
    return candidates
      .filter(record => record.deleted !== true && newest.has(groupOf(record))
        && outranks(newest.get(groupOf(record)), record))
      .map(record => record.cloudId);
  }

  // Mirrors the caps in firestore.rules, so the app never sends a record the rules would refuse.
  const entryLists = ['symptoms', 'characteristics', 'relief', 'medications', 'triggers', 'knownCauses'];
  const settingsLists = ['customSymptoms', 'customCharacteristics', 'customRelief', 'customMedications', 'customTriggers'];
  function fitsCloud(record) {
    if (record.kind === 'settings') return settingsLists.every(key => record[key].length <= 200);
    if (typeof record.id !== 'string' || record.id.length > 128) return false;
    return record.deleted === true || (record.entry.notes.length <= PainData.notesLimit
      && entryLists.every(key => record.entry[key].length <= 200));
  }

  function hasDiary(state) {
    return state.entries.length > 0 || [state.customSymptoms, state.customCharacteristics, state.customRelief,
      state.customMedications, state.customTriggers].some(list => list.length > 0);
  }

  // How signing in treats this device's diary. The device may be shared, so a diary already linked to
  // another account is never merged into this one without asking.
  function signInAction(linkedUid, uid, state) {
    if (linkedUid === uid) return 'sync';
    if (!linkedUid) return 'link';
    return hasDiary(state) ? 'ask' : 'switch';
  }

  // Settings to keep when the cloud copy arrives: the newer side wins. The first time a device syncs with an
  // account its custom lists are combined instead, so options added on either side survive.
  function chooseSettings(local, localTime, cloud, cloudTime, firstSync) {
    const newer = cloudTime >= localTime ? cloud : local;
    const lists = ['customSymptoms', 'customCharacteristics', 'customRelief', 'customMedications', 'customTriggers'];
    return {
      ...Object.fromEntries(lists.map(key => [key,
        firstSync ? PainData.uniqueLabels([...cloud[key], ...local[key]]) : [...newer[key]]])),
      preferences: { ...newer.preferences },
    };
  }

  return { entryTime, isEntryChange, dedupeEntries, reconcileEntries, readSettings, supersededRecords, fitsCloud,
    hasDiary, signInAction, chooseSettings };
})();

if (typeof module !== 'undefined') module.exports = PainSyncData;
