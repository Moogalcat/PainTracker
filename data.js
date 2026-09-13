/* Data rules shared by the app and dependency-free regression tests. */
'use strict';

const PainData = (() => {
  const themes = ['system', 'light', 'dark'];
  const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const uid = () => globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  function uniqueLabels(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const label = String(value).trim();
      const key = label.toLocaleLowerCase();
      if (label && !seen.has(key)) { seen.add(key); result.push(label); }
    }
    return result;
  }

  function valid(entry) {
    return !!entry && typeof entry === 'object' && isDate(entry.at)
      && (entry.updatedAt == null || isDate(entry.updatedAt))
      && (entry.notes == null || typeof entry.notes === 'string')
      && (entry.triggers == null || (Array.isArray(entry.triggers)
        && entry.triggers.every(value => typeof value === 'string' && value.trim())))
      && (entry.symptoms == null || (Array.isArray(entry.symptoms)
        && entry.symptoms.every(item => item && typeof item.name === 'string' && item.name.trim()
          && Number.isInteger(item.intensity) && item.intensity >= 1 && item.intensity <= 10)));
  }

  function normalise(entry) {
    const symptomMap = new Map();
    for (const item of entry.symptoms || []) {
      const name = String(item.name).trim();
      const key = name.toLocaleLowerCase();
      if (name && Number.isInteger(item.intensity) && item.intensity >= 1 && item.intensity <= 10) {
        symptomMap.set(key, { name, intensity: item.intensity });
      }
    }
    return {
      id: String(entry.id || uid()),
      at: new Date(entry.at).toISOString(),
      updatedAt: isDate(entry.updatedAt) ? new Date(entry.updatedAt).toISOString() : null,
      notes: entry.notes || '',
      symptoms: [...symptomMap.values()],
      triggers: uniqueLabels(entry.triggers),
    };
  }

  function contentKey(entry) {
    const symptoms = entry.symptoms
      .map(item => [item.name.toLocaleLowerCase(), item.intensity])
      .sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify([entry.at, symptoms,
      entry.triggers.map(value => value.toLocaleLowerCase()).sort(), entry.notes]);
  }

  function empty() {
    return {
      version: 1,
      entries: [],
      customSymptoms: [],
      customTriggers: [],
      preferences: { theme: 'system' },
      deletedIds: [],
    };
  }

  function parse(value, strict = false) {
    const object = Array.isArray(value) ? { entries: value } : value;
    if (!object || !Array.isArray(object.entries)) throw new Error('No entry list found');
    if (object.version != null && object.version !== 1) throw new Error('Unsupported backup version');
    for (const key of ['customSymptoms', 'customTriggers']) {
      if (object[key] != null && (!Array.isArray(object[key])
        || !object[key].every(item => typeof item === 'string' && item.trim()))) {
        throw new Error(`Invalid ${key}`);
      }
    }
    if (object.preferences != null && (!object.preferences || typeof object.preferences !== 'object'
      || !themes.includes(object.preferences.theme))) throw new Error('Invalid preferences');
    if (object.deletedIds != null && (!Array.isArray(object.deletedIds)
      || !object.deletedIds.every(id => typeof id === 'string'))) throw new Error('Invalid deleted entry list');

    const validEntries = object.entries.filter(valid);
    const invalid = object.entries.length - validEntries.length;
    if (strict && invalid) throw new Error('Some saved entries cannot be read');
    const entries = validEntries.map(normalise);
    if (strict && new Set(entries.map(entry => entry.id)).size !== entries.length) {
      throw new Error('Repeated saved entry IDs');
    }

    return {
      ...empty(),
      entries,
      invalid,
      customSymptoms: uniqueLabels(object.customSymptoms),
      customTriggers: uniqueLabels(object.customTriggers),
      preferences: object.preferences || { theme: 'system' },
      deletedIds: [...new Set(object.deletedIds || [])],
      hasPreferences: object.preferences != null,
    };
  }

  function merge(current, incoming) {
    const result = { added: 0, updated: 0, duplicates: 0, conflicts: 0, deleted: 0, invalid: incoming.invalid || 0 };
    const byId = new Map(current.entries.map(entry => [entry.id, entry]));
    const seen = new Set(current.entries.map(contentKey));
    const deleted = new Set(current.deletedIds);

    for (const entry of incoming.entries) {
      if (deleted.has(entry.id)) { result.deleted++; continue; }
      const existing = byId.get(entry.id);
      if (existing) {
        if (contentKey(existing) === contentKey(entry)) { result.duplicates++; continue; }
        if (entry.updatedAt && existing.updatedAt
          && Date.parse(entry.updatedAt) > Date.parse(existing.updatedAt)) {
          seen.delete(contentKey(existing));
          byId.set(entry.id, entry);
          seen.add(contentKey(entry));
          result.updated++;
        } else result.conflicts++;
      } else if (seen.has(contentKey(entry))) result.duplicates++;
      else { byId.set(entry.id, entry); seen.add(contentKey(entry)); result.added++; }
    }

    for (const id of incoming.deletedIds) if (!byId.has(id)) deleted.add(id);
    return {
      state: {
        version: 1,
        entries: [...byId.values()],
        customSymptoms: uniqueLabels([...current.customSymptoms, ...incoming.customSymptoms]),
        customTriggers: uniqueLabels([...current.customTriggers, ...incoming.customTriggers]),
        preferences: incoming.hasPreferences ? incoming.preferences : current.preferences,
        deletedIds: [...deleted],
      },
      result,
    };
  }

  function toInput(date) {
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fromInput(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || toInput(date) !== value) return null;
    return date;
  }

  return { themes, uid, uniqueLabels, valid, normalise, contentKey, empty, parse, merge, toInput, fromInput };
})();

if (typeof module !== 'undefined') module.exports = PainData;
