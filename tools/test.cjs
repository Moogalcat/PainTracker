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

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readFile = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('records beyond the caps in the Firestore rules are kept off the upload list', () => {
  const upload = overrides => S.reconcileEntries(state([entry(overrides)]), []).uploads[0];
  const many = count => Array.from({ length: count }, (_, index) => `Item ${index}`);
  assert.equal(D.notesLimit, 50000);
  assert.equal(S.fitsCloud(upload({ notes: 'x'.repeat(D.notesLimit), triggers: many(200) })), true);
  assert.equal(S.fitsCloud(upload({ notes: 'x'.repeat(D.notesLimit + 1) })), false);
  const oversizedLists = {
    symptoms: many(201).map(name => ({ name, intensity: 1 })),
    characteristics: many(201),
    relief: many(201).map(name => ({ name, effectiveness: 'Some' })),
    medications: many(201).map(name => ({ name, dose: '', effectiveness: 'Some' })),
    triggers: many(201),
    knownCauses: many(201),
  };
  for (const [key, items] of Object.entries(oversizedLists)) assert.equal(S.fitsCloud(upload({ [key]: items })), false, key);
  assert.equal(S.fitsCloud(upload({ id: 'x'.repeat(129) })), false);
  assert.equal(S.fitsCloud({ kind: 'entry', id: 'gone', deleted: true, modifiedAt: at }), true);
  assert.equal(S.fitsCloud({ kind: 'entry', id: 'x'.repeat(129), deleted: true, modifiedAt: at }), false);
  const settings = { kind: 'settings', modifiedAt: at, customSymptoms: [], customCharacteristics: [], customRelief: [],
    customMedications: [], customTriggers: [], preferences: { theme: 'system', reminderMinutes: 0 } };
  assert.equal(S.fitsCloud(settings), true);
  for (const key of ['customSymptoms', 'customCharacteristics', 'customRelief', 'customMedications', 'customTriggers']) {
    assert.equal(S.fitsCloud({ ...settings, [key]: many(201) }), false, key);
  }
});

test('the notes editor and the cloud checks stop at the limits the Firestore rules accept', () => {
  assert.match(readFile('index.html'), new RegExp(`<textarea data-field="notes"[^>]*maxlength="${D.notesLimit}"`));
  const rules = readFile('firestore.rules');
  assert.match(rules, new RegExp(`isText\\(entry\\.notes, ${D.notesLimit}\\)`));
  assert.match(rules, /value is list && value\.size\(\) <= 200;/);
  assert.match(rules, /isText\(data\.id, 128\)/);
});

// Runs the real sync.js against a fake Firestore that behaves like the SDK: writes show as pending at once and a
// refused request is rolled back into a new snapshot. Like the deployed rules, it refuses requests of more than
// 20 writes (each write looks up config/access, and a batch may make 20 lookups) and notes over the cap.
function syncHost({ entries = [], cloud = [] } = {}) {
  const copy = value => JSON.parse(JSON.stringify(value));
  let diary = { ...D.empty(), entries };
  const docs = new Map(cloud);
  const pending = new Map();
  const requests = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: true, classList: { toggle() {} }, addEventListener() {} });
    return elements.get(id);
  };
  let listener;
  let nextId = 0;
  let refuseAll = false;
  const snapshot = () => {
    const items = [...[...docs].map(([id, data]) => ({ id, data, waiting: false })),
      ...[...pending].map(([id, data]) => ({ id, data, waiting: true }))];
    return { docs: items.map(item => ({ id: item.id, data: () => copy(item.data), metadata: { hasPendingWrites: item.waiting } })),
      metadata: { fromCache: false, hasPendingWrites: pending.size > 0 } };
  };
  const emit = () => {
    const current = snapshot();
    setImmediate(() => listener?.(current));
  };
  const firestore = {
    collection: () => ({}),
    doc: (_collection, id) => ({ id: id ?? `cloud-${String(++nextId).padStart(4, '0')}` }),
    query: collection => collection, where: () => ({}), limit: () => ({}),
    getDocs: async () => snapshot(), signOut: async () => {}, waitForPendingWrites: async () => {},
    onSnapshot(_query, _options, next) { listener = next; emit(); return () => { listener = undefined; }; },
    writeBatch() {
      const writes = [];
      return {
        set: (ref, data) => writes.push({ id: ref.id, data: copy(data) }),
        delete: ref => writes.push({ id: ref.id }),
        commit() {
          if (requests.length >= 200) return new Promise(() => {}); // stop a retry loop from running forever
          requests.push(writes.length);
          for (const write of writes) if (write.data) pending.set(write.id, write.data);
          emit();
          return new Promise((resolve, reject) => setImmediate(() => {
            for (const write of writes) pending.delete(write.id);
            const refused = refuseAll || writes.length > 20 || writes.some(write => write.data?.entry?.notes.length > 50000);
            if (!refused) for (const write of writes) write.data ? docs.set(write.id, write.data) : docs.delete(write.id);
            emit();
            if (refused) reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
            else resolve();
          }));
        },
      };
    },
  };
  const context = vm.createContext({ console: { error() {}, warn() {} }, setTimeout, clearTimeout,
    navigator: { onLine: true }, document: { getElementById: element },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { confirm: () => true, PainTrackerAppSync: { getState: () => copy(diary), isCurrent: () => true,
      applyState(value) { diary = copy(value); return true; }, clearDiary() { diary = D.empty(); return true; } } },
    firestore });
  for (const file of ['data.js', 'sync-data.js', 'sync.js']) vm.runInContext(readFile(file), context, { filename: file });
  vm.runInContext('firebaseApi = firestore; db = {}; auth = {};', context);
  return {
    requests, docs,
    get diary() { return diary; },
    status: () => element('syncStatus').textContent,
    message: () => element('syncResult').textContent,
    refuseWrites(value) { refuseAll = value; },
    cloudEntries: () => [...docs.values()].filter(record => record.kind === 'entry' && !record.deleted).map(record => record.id).sort(),
    async signIn() {
      vm.runInContext("watchUser({ uid: 'account-a', email: 'a@example.com' })", context);
      await new Promise(resolve => setTimeout(resolve, 100));
    },
  };
}

test('sync sends cloud writes ten at a time, so a large first sync fits the rules limits', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => entry({ id: `pain-${index}`,
    at: new Date(Date.UTC(2026, 8, 1, index)).toISOString() }));
  const host = syncHost({ entries });
  await host.signIn();
  assert.ok(Math.max(...host.requests) <= 10, `largest request had ${Math.max(...host.requests)} writes`);
  assert.equal(host.cloudEntries().length, 25);
  assert.equal(host.status(), ' · Synced');
});

test('sync removes superseded cloud copies ten at a time', async () => {
  const latest = entry({ updatedAt: '2026-09-14T00:00:00.000Z' });
  const record = (modifiedAt, value) => ({ kind: 'entry', id: latest.id, deleted: false, modifiedAt, entry: value,
    generation: 1, deviceId: 'other-device' });
  const cloud = Array.from({ length: 30 }, (_, index) => {
    const modifiedAt = new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString();
    return [`old-${String(index).padStart(2, '0')}`, record(modifiedAt, { ...latest, updatedAt: modifiedAt })];
  });
  cloud.push(['latest', record(latest.updatedAt, latest)]);
  const host = syncHost({ entries: [latest], cloud });
  await host.signIn();
  assert.ok(Math.max(...host.requests) <= 10, `largest request had ${Math.max(...host.requests)} writes`);
  assert.deepEqual([...host.docs].filter(([, value]) => value.kind === 'entry').map(([id]) => id), ['latest']);
});

test('after the rules refuse a write, sync pauses for the session instead of retrying in a loop', async () => {
  const host = syncHost({ entries: [entry()] });
  host.refuseWrites(true);
  await host.signIn();
  assert.equal(host.requests.length, 1);
  assert.equal(host.status(), ' · Paused');
  assert.match(host.message(), /sign in again or reload/);
  // Signing in again tries once more.
  host.refuseWrites(false);
  await host.signIn();
  assert.deepEqual(host.cloudEntries(), ['pain-1']);
});

test('an entry too large for the rules stays on this device while the rest of the diary syncs', async () => {
  const long = entry({ id: 'long-note', at: '2026-09-12T10:00:00.000Z', notes: 'x'.repeat(50001) });
  const host = syncHost({ entries: [entry(), long] });
  await host.signIn();
  assert.deepEqual(host.cloudEntries(), ['pain-1']);
  assert.match(host.message(), /1 entry is too large to sync/);
  assert.deepEqual(host.diary.entries.map(item => item.id).sort(), ['long-note', 'pain-1']);
  assert.ok(host.requests.length < 5, `${host.requests.length} requests`);
});
