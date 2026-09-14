/* Data rules shared by the app and dependency-free regression tests. */
'use strict';

const PainData = (() => {
  const backupVersion = 2;
  const themes = ['system', 'light', 'dark'];
  const reliefLevels = ['None', 'Some', 'Strong'];
  const reminderMinutes = [0, 30, 60, 120, 240, 480, 960];
  const unknownMedicationName = 'Medication (name not recorded)';
  // Matches the notes cap in firestore.rules and the notes editor's maxlength.
  const notesLimit = 50000;
  const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  // Ratings are optional: a symptom, relief attempt or medication can be saved without one.
  const isIntensity = value => value == null || (Number.isInteger(value) && value >= 0 && value <= 10);
  const isRating = value => value == null || reliefLevels.includes(value);
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
      && (entry.endedAt == null || (isDate(entry.endedAt) && Date.parse(entry.endedAt) >= Date.parse(entry.at)))
      && (entry.ongoing == null || typeof entry.ongoing === 'boolean')
      && (entry.notes == null || typeof entry.notes === 'string')
      && (entry.impact == null || (Number.isInteger(entry.impact) && entry.impact >= 0 && entry.impact <= 3))
      && (entry.characteristics == null || (Array.isArray(entry.characteristics)
        && entry.characteristics.every(value => typeof value === 'string' && value.trim())))
      && (entry.relief == null || (Array.isArray(entry.relief)
        && entry.relief.every(item => item && typeof item.name === 'string' && item.name.trim()
          && isRating(item.effectiveness))))
      && (entry.medications == null || (Array.isArray(entry.medications)
        && entry.medications.every(item => item && typeof item.name === 'string'
          && (item.dose == null || typeof item.dose === 'string') && isRating(item.effectiveness))))
      && (entry.triggers == null || (Array.isArray(entry.triggers)
        && entry.triggers.every(value => typeof value === 'string' && value.trim())))
      && (entry.knownCauses == null || (Array.isArray(entry.knownCauses)
        && entry.knownCauses.every(value => typeof value === 'string' && value.trim())))
      && (entry.symptoms == null || (Array.isArray(entry.symptoms)
        && entry.symptoms.every(item => item && typeof item.name === 'string' && item.name.trim()
          && isIntensity(item.intensity))));
  }

  function normalise(entry) {
    const symptomMap = new Map();
    for (const item of entry.symptoms || []) {
      const name = String(item.name).trim();
      const key = name.toLocaleLowerCase();
      if (name && isIntensity(item.intensity)) symptomMap.set(key, { name, intensity: item.intensity ?? null });
    }
    const reliefMap = new Map();
    let legacyMedication = null;
    for (const item of entry.relief || []) {
      const name = String(item.name).trim();
      const key = name.toLocaleLowerCase();
      if (!name || !isRating(item.effectiveness)) continue;
      if (key === 'medication') legacyMedication = item.effectiveness;
      else reliefMap.set(key, { name, effectiveness: item.effectiveness ?? null });
    }
    const medications = (entry.medications || [])
      .filter(item => item && isRating(item.effectiveness))
      .map(item => ({ name: String(item.name ?? '').trim() || unknownMedicationName,
        dose: String(item.dose ?? '').trim(), effectiveness: item.effectiveness ?? null }));
    // Entries from before medication details keep their overall rating with an explicit fallback label.
    if (!medications.length && legacyMedication) medications.push({ name: unknownMedicationName, dose: '', effectiveness: legacyMedication });
    const knownCauses = uniqueLabels(entry.knownCauses);
    const causeKeys = new Set(knownCauses.map(value => value.toLocaleLowerCase()));
    const ongoing = entry.ongoing === true;
    return {
      id: String(entry.id || uid()),
      at: new Date(entry.at).toISOString(),
      updatedAt: isDate(entry.updatedAt) ? new Date(entry.updatedAt).toISOString() : null,
      endedAt: !ongoing && isDate(entry.endedAt) ? new Date(entry.endedAt).toISOString() : null,
      ongoing,
      notes: entry.notes || '',
      symptoms: [...symptomMap.values()],
      characteristics: uniqueLabels(entry.characteristics),
      relief: [...reliefMap.values()],
      medications,
      impact: Number.isInteger(entry.impact) && entry.impact >= 0 && entry.impact <= 3 ? entry.impact : null,
      triggers: uniqueLabels(entry.triggers).filter(value => !causeKeys.has(value.toLocaleLowerCase())),
      knownCauses,
    };
  }

  function contentKey(entry) {
    const symptoms = entry.symptoms
      .map(item => [item.name.toLocaleLowerCase(), item.intensity])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const relief = entry.relief
      .map(item => [item.name.toLocaleLowerCase(), item.effectiveness])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const medications = entry.medications
      .map(item => JSON.stringify([item.name.toLocaleLowerCase(), item.dose.toLocaleLowerCase(), item.effectiveness]))
      .sort();
    return JSON.stringify([entry.at, entry.endedAt, entry.ongoing, symptoms,
      entry.characteristics.map(value => value.toLocaleLowerCase()).sort(),
      relief, entry.impact, entry.triggers.map(value => value.toLocaleLowerCase()).sort(), entry.notes, medications,
      entry.knownCauses.map(value => value.toLocaleLowerCase()).sort()]);
  }

  function empty() {
    return {
      version: backupVersion,
      entries: [],
      customSymptoms: [],
      customCharacteristics: [],
      customRelief: [],
      customMedications: [],
      customTriggers: [],
      preferences: { theme: 'system', reminderMinutes: 0 },
      deletedIds: [],
    };
  }

  function parse(value, strict = false) {
    const object = Array.isArray(value) ? { entries: value } : value;
    if (!object || !Array.isArray(object.entries)) throw new Error('No entry list found');
    if (object.version != null && ![1, backupVersion].includes(object.version)) throw new Error('Unsupported backup version');
    for (const key of ['customSymptoms', 'customCharacteristics', 'customRelief', 'customMedications', 'customTriggers']) {
      if (object[key] != null && (!Array.isArray(object[key])
        || !object[key].every(item => typeof item === 'string' && item.trim()))) {
        throw new Error(`Invalid ${key}`);
      }
    }
    if (object.preferences != null && (!object.preferences || typeof object.preferences !== 'object'
      || !themes.includes(object.preferences.theme)
      || (object.preferences.reminderMinutes != null && !reminderMinutes.includes(object.preferences.reminderMinutes)))) {
      throw new Error('Invalid preferences');
    }
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
      customCharacteristics: uniqueLabels(object.customCharacteristics),
      customRelief: uniqueLabels(object.customRelief),
      customMedications: uniqueLabels(object.customMedications),
      customTriggers: uniqueLabels(object.customTriggers),
      preferences: {
        theme: object.preferences?.theme || 'system',
        reminderMinutes: object.preferences?.reminderMinutes || 0,
      },
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
        version: backupVersion,
        entries: [...byId.values()],
        customSymptoms: uniqueLabels([...current.customSymptoms, ...incoming.customSymptoms]),
        customCharacteristics: uniqueLabels([...current.customCharacteristics, ...incoming.customCharacteristics]),
        customRelief: uniqueLabels([...current.customRelief, ...incoming.customRelief]),
        customMedications: uniqueLabels([...current.customMedications, ...incoming.customMedications]),
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

  function endState(entry) {
    return entry.ongoing ? 'ongoing' : entry.endedAt ? 'ended' : 'unknown';
  }

  // Spreadsheets run cells starting with these characters as formulas, so such text is marked as plain text.
  function csvCell(value) {
    const text = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  return { backupVersion, themes, reliefLevels, reminderMinutes, unknownMedicationName, notesLimit,
    uid, uniqueLabels, valid, normalise, contentKey, empty, parse, merge, toInput, fromInput, endState, csvCell };
})();

if (typeof module !== 'undefined') module.exports = PainData;
