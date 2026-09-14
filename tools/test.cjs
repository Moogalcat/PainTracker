/* Run with node --test tools/test.cjs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../data.js');
global.PainData = D;
const S = require('../sync-data.js');

const at = '2026-09-13T10:00:00.000Z';
const entry = (overrides = {}) => D.normalise({
  id: 'pain-1', at, notes: 'After lunch',
  symptoms: [{ name: 'Headache', intensity: 7 }],
  triggers: ['Poor sleep'], ...overrides,
});
const state = (entries = []) => ({ ...D.empty(), entries });

test('normalise keeps valid 0–10 symptom ratings and removes case-insensitive duplicates', () => {
  const result = D.normalise({ at, symptoms: [
    { name: 'Nausea', intensity: 0 },
    { name: ' Headache ', intensity: 4 },
    { name: 'headache', intensity: 8 },
    { name: 'Dizziness', intensity: 11 },
  ], characteristics: [' Sharp ', 'sharp'], triggers: [' Stress ', 'stress'] });
  assert.deepEqual(result.symptoms, [{ name: 'Nausea', intensity: 0 }, { name: 'headache', intensity: 8 }]);
  assert.deepEqual(result.characteristics, ['Sharp']);
  assert.deepEqual(result.triggers, ['Stress']);
});

test('validation accepts 0 and rejects intensity outside 0–10', () => {
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: 1 }] }), true);
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: 0 }] }), true);
  assert.equal(D.valid({ at, symptoms: [{ name: '', intensity: 5 }] }), false);
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: -1 }] }), false);
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: 10.5 }] }), false);
});

test('strict reading rejects corrupt records and repeated IDs', () => {
  assert.throws(() => D.parse({ entries: [entry(), { at: 'bad' }] }, true));
  assert.throws(() => D.parse({ entries: [entry(), entry()] }, true));
  assert.throws(() => D.parse({ version: 3, entries: [] }, true));
});

test('backup version 2 protects new fields while version 1 remains readable', () => {
  assert.equal(D.empty().version, 2);
  const migrated = D.parse({ version: 1, entries: [entry({
    medications: [{ name: 'Ibuprofen', dose: '400 mg', effectiveness: 'Strong' }],
    knownCauses: ['Dental work'],
  })] }, true);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.entries[0].medications[0].name, 'Ibuprofen');
  assert.deepEqual(migrated.entries[0].knownCauses, ['Dental work']);
  assert.equal(D.parse({ version: 2, entries: [] }, true).version, 2);
});

test('backup round trip retains custom items and preferences', () => {
  const original = { ...state([entry({ characteristics: ['Throbbing'], relief: [{ name: 'Heat', effectiveness: 'Strong' }], impact: 2 })]), customSymptoms: ['Jaw pain'],
    customCharacteristics: ['Heavy'], customRelief: ['Tea'], customMedications: ['Naproxen'], customTriggers: ['Stress'], preferences: { theme: 'dark', reminderMinutes: 960 } };
  const restored = D.parse(JSON.parse(JSON.stringify(original)), true);
  assert.deepEqual(restored.entries[0].symptoms, [{ name: 'Headache', intensity: 7 }]);
  assert.deepEqual(restored.entries[0].characteristics, ['Throbbing']);
  assert.deepEqual(restored.entries[0].relief, [{ name: 'Heat', effectiveness: 'Strong' }]);
  assert.equal(restored.entries[0].impact, 2);
  assert.deepEqual(restored.customSymptoms, ['Jaw pain']);
  assert.deepEqual(restored.customCharacteristics, ['Heavy']);
  assert.deepEqual(restored.customRelief, ['Tea']);
  assert.deepEqual(restored.customMedications, ['Naproxen']);
  assert.equal(restored.preferences.theme, 'dark');
  assert.equal(restored.preferences.reminderMinutes, 960);
});

test('older entries migrate with safe defaults for new tracking fields', () => {
  const restored = D.parse([{ id: 'old', at, symptoms: [], triggers: [], notes: '' }], true);
  assert.deepEqual(restored.entries[0].characteristics, []);
  assert.deepEqual(restored.entries[0].relief, []);
  assert.deepEqual(restored.entries[0].medications, []);
  assert.deepEqual(restored.entries[0].knownCauses, []);
  assert.equal(restored.entries[0].impact, null);
  assert.equal(restored.entries[0].endedAt, null);
  assert.equal(restored.entries[0].ongoing, false);
});

test('duration, activity impact, and relief effectiveness are validated', () => {
  const complete = { at, endedAt: '2026-09-13T12:00:00.000Z', ongoing: false, impact: 3,
    relief: [{ name: 'Rest', effectiveness: 'Some' }], symptoms: [] };
  assert.equal(D.valid(complete), true);
  assert.equal(D.valid({ ...complete, endedAt: '2026-09-13T09:00:00.000Z' }), false);
  assert.equal(D.valid({ ...complete, impact: 4 }), false);
  assert.equal(D.valid({ ...complete, relief: [{ name: 'Rest', effectiveness: 'A lot' }] }), false);
  const ongoing = D.normalise({ ...complete, ongoing: true });
  assert.equal(ongoing.endedAt, null);
  assert.equal(D.endState(ongoing), 'ongoing');
  assert.equal(D.endState(D.normalise(complete)), 'ended');
  assert.equal(D.endState(D.normalise({ at })), 'unknown');
});

test('invalid reminder preferences are rejected and old preferences default to off', () => {
  assert.throws(() => D.parse({ entries: [], preferences: { theme: 'dark', reminderMinutes: 15 } }, true));
  assert.equal(D.parse({ entries: [], preferences: { theme: 'light' } }, true).preferences.reminderMinutes, 0);
});

test('a newer copy of an entry updates once and repeated import is idempotent', () => {
  const current = state([entry({ updatedAt: '2026-09-13T11:00:00Z' })]);
  const incoming = D.parse([entry({ notes: 'Changed', updatedAt: '2026-09-13T12:00:00Z' })]);
  const merged = D.merge(current, incoming);
  assert.equal(merged.result.updated, 1);
  assert.equal(merged.state.entries[0].notes, 'Changed');
  assert.equal(D.merge(merged.state, incoming).result.duplicates, 1);
});

test('older conflicts keep local data and deleted IDs prevent resurrection', () => {
  const current = { ...state([entry({ notes: 'Local', updatedAt: '2026-09-13T12:00:00Z' })]), deletedIds: ['gone'] };
  const incoming = D.parse([entry({ notes: 'Old', updatedAt: '2026-09-13T11:00:00Z' }), entry({ id: 'gone' })]);
  const merged = D.merge(current, incoming);
  assert.equal(merged.result.conflicts, 1);
  assert.equal(merged.result.deleted, 1);
  assert.equal(merged.state.entries.length, 1);
});

test('local date conversion rejects impossible and future-shaped junk dates', () => {
  assert.equal(D.fromInput('2026-02-30T10:00'), null);
  assert.equal(D.fromInput('2026-09-13T10:00junk'), null);
  assert.equal(D.toInput(D.fromInput('2026-09-13T10:00')), '2026-09-13T10:00');
});

test('medications keep name, dose, and rating, and older Medication ratings migrate', () => {
  const medications = [
    { name: ' Ibuprofen ', dose: ' 400 mg ', effectiveness: 'Strong' },
    { name: 'Paracetamol', dose: '1 g', effectiveness: 'Some' },
  ];
  const restored = D.parse(JSON.parse(JSON.stringify(state([entry({ medications })]))), true);
  assert.deepEqual(restored.entries[0].medications, [
    { name: 'Ibuprofen', dose: '400 mg', effectiveness: 'Strong' },
    { name: 'Paracetamol', dose: '1 g', effectiveness: 'Some' },
  ]);
  assert.equal(D.valid({ at, medications: [{ name: 'Ibuprofen', dose: '400 mg', effectiveness: 'A lot' }] }), false);

  const legacy = D.normalise({ at, relief: [{ name: 'Medication', effectiveness: 'Some' }, { name: 'Rest', effectiveness: 'None' }] });
  assert.deepEqual(legacy.relief, [{ name: 'Rest', effectiveness: 'None' }]);
  assert.deepEqual(legacy.medications, [{ name: D.unknownMedicationName, dose: '', effectiveness: 'Some' }]);
  assert.deepEqual(D.normalise({ at, medications: [{ name: '', dose: '', effectiveness: 'None' }] }).medications,
    [{ name: D.unknownMedicationName, dose: '', effectiveness: 'None' }]);
  assert.equal(D.contentKey(legacy), D.contentKey(D.normalise(legacy)));
  assert.notEqual(D.contentKey(entry({ medications })),
    D.contentKey(entry({ medications: [{ ...medications[0], dose: '200 mg' }, medications[1]] })));
});

test('known causes stay separate from possible triggers', () => {
  const result = entry({ triggers: ['Stress', 'Dental work'], knownCauses: [' Dental work ', 'dental work'] });
  assert.deepEqual(result.knownCauses, ['Dental work']);
  assert.deepEqual(result.triggers, ['Stress']);
  const restored = D.parse(JSON.parse(JSON.stringify(state([result]))), true);
  assert.deepEqual(restored.entries[0].knownCauses, ['Dental work']);
  assert.equal(D.valid({ at, knownCauses: [''] }), false);
  assert.notEqual(D.contentKey(result), D.contentKey(entry({ triggers: ['Stress', 'Dental work'] })));
});

test('sync reads legacy entry records and uploads new records with an explicit kind', () => {
  assert.equal(S.isEntryChange({ id: 'legacy', deleted: true }), true);
  assert.equal(S.isEntryChange({ kind: 'settings', id: 'settings' }), false);
  const result = S.reconcileEntries(state([entry()]), []);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].kind, 'entry');
});

test('sync combines independent entries from two devices', () => {
  const local = entry({ id: 'local', at: '2026-09-13T10:00:00Z' });
  const remote = entry({ id: 'remote', at: '2026-09-14T10:00:00Z' });
  const result = S.reconcileEntries(state([local]), [{ kind: 'entry', id: remote.id,
    modifiedAt: remote.at, deleted: false, entry: remote }]);
  assert.deepEqual(result.state.entries.map(item => item.id), ['remote', 'local']);
  assert.equal(result.uploads[0].id, 'local');
});

test('sync keeps the newest edit and sends a newer local edit back to the cloud', () => {
  const local = entry({ updatedAt: '2026-09-13T11:00:00Z', notes: 'Local' });
  const remote = entry({ updatedAt: '2026-09-13T12:00:00Z', notes: 'Remote' });
  const newer = S.reconcileEntries(state([local]), [{ kind: 'entry', id: remote.id,
    modifiedAt: remote.updatedAt, deleted: false, entry: remote }]);
  assert.equal(newer.state.entries[0].notes, 'Remote');

  const latestLocal = entry({ updatedAt: '2026-09-13T13:00:00Z', notes: 'Latest local' });
  const olderRemote = S.reconcileEntries(state([latestLocal]), [{ kind: 'entry', id: remote.id,
    modifiedAt: remote.updatedAt, deleted: false, entry: remote }]);
  assert.equal(olderRemote.state.entries[0].notes, 'Latest local');
  assert.equal(olderRemote.uploads[0].entry.notes, 'Latest local');
});

test('sync applies deletions unless an entry has a newer edit', () => {
  const local = entry({ updatedAt: '2026-09-13T11:00:00Z' });
  const deleted = S.reconcileEntries(state([local]), [{ kind: 'entry', id: local.id,
    modifiedAt: '2026-09-13T12:00:00Z', deleted: true }]);
  assert.equal(deleted.state.entries.length, 0);
  assert.deepEqual(deleted.state.deletedIds, [local.id]);

  const newerLocal = entry({ updatedAt: '2026-09-13T13:00:00Z' });
  const retained = S.reconcileEntries(state([newerLocal]), [{ kind: 'entry', id: newerLocal.id,
    modifiedAt: '2026-09-13T12:00:00Z', deleted: true }]);
  assert.equal(retained.state.entries.length, 1);
  assert.equal(retained.uploads[0].deleted, false);
});

test('sync keeps separate entries that were saved for the same minute', () => {
  const savedAt = D.fromInput('2026-09-15T10:00').toISOString();
  const headache = entry({ id: 'headache', at: savedAt, updatedAt: '2026-09-15T10:01:10Z' });
  const nausea = entry({ id: 'nausea', at: savedAt, updatedAt: '2026-09-15T10:01:40Z',
    symptoms: [{ name: 'Nausea', intensity: 4 }] });

  const firstSignIn = S.reconcileEntries(state([headache, nausea]), []);
  assert.deepEqual(firstSignIn.state.entries.map(item => item.id).sort(), ['headache', 'nausea']);
  assert.deepEqual(firstSignIn.uploads.map(item => item.id).sort(), ['headache', 'nausea']);
  assert.deepEqual(firstSignIn.state.deletedIds, []);

  const hiddenButInCloud = S.reconcileEntries(state([nausea]), [headache, nausea].map(item => ({
    kind: 'entry', id: item.id, modifiedAt: item.updatedAt, deleted: false, entry: item })));
  assert.deepEqual(hiddenButInCloud.state.entries.map(item => item.id).sort(), ['headache', 'nausea']);
});

test('sync collapses identical copies and tombstones the dropped copy everywhere', () => {
  const copyA = entry({ id: 'copy-a', updatedAt: '2026-09-13T11:00:00Z' });
  const copyB = entry({ id: 'copy-b', updatedAt: '2026-09-13T11:00:00Z' });
  assert.deepEqual(S.dedupeEntries([copyB, copyA]).map(item => item.id), ['copy-a']);

  const olderB = entry({ id: 'copy-b', notes: 'Draft', updatedAt: '2026-09-13T10:30:00Z' });
  const now = Date.parse('2026-09-14T00:00:00Z');
  const result = S.reconcileEntries(state([copyA, copyB]), [{ kind: 'entry', id: olderB.id,
    modifiedAt: olderB.updatedAt, deleted: false, entry: olderB }], {}, now);
  assert.deepEqual(result.state.entries.map(item => item.id), ['copy-a']);
  assert.deepEqual(result.state.deletedIds, ['copy-b']);
  assert.equal(result.tombstones['copy-b'], now);
  assert.deepEqual(result.uploads.map(item => [item.id, item.deleted]), [['copy-a', false], ['copy-b', true]]);
});

test('sync keeps only the newest confirmed readable record for each entry and for settings', () => {
  const change = (cloudId, id, modifiedAt, deleted = false, overrides = {}) => ({ kind: 'entry', id, cloudId,
    modifiedAt, deleted, confirmed: true, ...(deleted ? {} : { entry: entry({ id }) }), ...overrides });
  const settings = (cloudId, modifiedAt) => ({ kind: 'settings', cloudId, modifiedAt, confirmed: true,
    customSymptoms: [], preferences: { theme: 'system', reminderMinutes: 0 } });
  const records = [
    change('edit-old', 'edited', '2026-09-13T10:00:00Z'),
    change('edit-new', 'edited', '2026-09-13T11:00:00Z'),
    change('deleted-content', 'deleted', '2026-09-13T11:00:00Z'),
    change('deleted-marker', 'deleted', '2026-09-13T11:00:00Z', true),
    change('restored-marker', 'restored', '2026-09-13T10:00:00Z', true),
    change('restored-edit', 'restored', '2026-09-13T12:00:00Z'),
    change('pending-newer', 'pending', '2026-09-13T12:00:00Z', false, { confirmed: false }),
    change('pending-older', 'pending', '2026-09-13T11:00:00Z'),
    change('readable-older', 'unreadable', '2026-09-13T10:00:00Z'),
    change('unreadable-newer', 'unreadable', '2026-09-13T11:00:00Z', false, { entry: { at: 'bad' } }),
    change('legacy-only', 'legacy', '2026-09-13T09:00:00Z', false, { kind: undefined }),
    settings('settings-old', '2026-09-13T08:00:00Z'),
    settings('settings-new', '2026-09-13T09:00:00Z'),
  ];
  assert.deepEqual(S.supersededRecords(records), ['edit-old', 'deleted-content', 'restored-marker', 'settings-old']);
});

test('signing in never merges a diary linked to another account without asking', () => {
  const withEntry = state([entry()]);
  assert.equal(S.signInAction('account-a', 'account-a', withEntry), 'sync');
  assert.equal(S.signInAction(null, 'account-a', withEntry), 'link');
  assert.equal(S.signInAction('account-a', 'account-b', withEntry), 'ask');
  assert.equal(S.signInAction('account-a', 'account-b', { ...state(), customMedications: ['Naproxen'] }), 'ask');
  assert.equal(S.signInAction('account-a', 'account-b', { ...state(), deletedIds: ['gone'] }), 'switch');
  assert.equal(S.hasDiary(state()), false);
});

test('first sync with an account combines custom lists; afterwards the newest settings win', () => {
  const local = { ...state(), customSymptoms: ['Jaw pain'], customMedications: ['Naproxen'],
    preferences: { theme: 'dark', reminderMinutes: 60 } };
  const cloud = { ...state(), customSymptoms: ['jaw pain', 'Back pain'], customTriggers: ['Stress'],
    preferences: { theme: 'light', reminderMinutes: 0 } };
  const first = S.chooseSettings(local, 0, cloud, 1000, true);
  assert.deepEqual([first.customSymptoms, first.customMedications, first.customTriggers],
    [['jaw pain', 'Back pain'], ['Naproxen'], ['Stress']]);
  assert.deepEqual(first.preferences, { theme: 'light', reminderMinutes: 0 });
  assert.deepEqual(S.chooseSettings(local, 2000, cloud, 1000, true).preferences, { theme: 'dark', reminderMinutes: 60 });
  assert.deepEqual(S.chooseSettings(local, 0, cloud, 1000, false).customMedications, []);
  assert.deepEqual(S.chooseSettings(local, 2000, cloud, 1000, false).customSymptoms, ['Jaw pain']);
});

test('CSV cells are quoted and cannot run as spreadsheet formulas', () => {
  assert.equal(D.csvCell('Headache 7/10'), '"Headache 7/10"');
  assert.equal(D.csvCell('said "ouch"'), '"said ""ouch"""');
  assert.equal(D.csvCell(null), '""');
  assert.equal(D.csvCell('=HYPERLINK("http://example.com")'), '"\'=HYPERLINK(""http://example.com"")"');
  for (const risky of ['+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    assert.ok(D.csvCell(risky).startsWith('"\''), risky);
  }
});
