/* Run with node --test tools/test.cjs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../data.js');

const at = '2026-09-13T10:00:00.000Z';
const entry = (overrides = {}) => D.normalise({
  id: 'pain-1', at, notes: 'After lunch',
  symptoms: [{ name: 'Headache', intensity: 7 }],
  triggers: ['Poor sleep'], ...overrides,
});
const state = (entries = []) => ({ ...D.empty(), entries });

test('normalise keeps valid symptom ratings and removes case-insensitive duplicates', () => {
  const result = D.normalise({ at, symptoms: [
    { name: ' Headache ', intensity: 4 },
    { name: 'headache', intensity: 8 },
    { name: 'Nausea', intensity: 11 },
  ], triggers: [' Stress ', 'stress'] });
  assert.deepEqual(result.symptoms, [{ name: 'headache', intensity: 8 }]);
  assert.deepEqual(result.triggers, ['Stress']);
});

test('validation rejects missing names and intensity outside 1–10', () => {
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: 1 }] }), true);
  assert.equal(D.valid({ at, symptoms: [{ name: '', intensity: 5 }] }), false);
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: 0 }] }), false);
  assert.equal(D.valid({ at, symptoms: [{ name: 'Headache', intensity: 10.5 }] }), false);
});

test('strict reading rejects corrupt records and repeated IDs', () => {
  assert.throws(() => D.parse({ entries: [entry(), { at: 'bad' }] }, true));
  assert.throws(() => D.parse({ entries: [entry(), entry()] }, true));
  assert.throws(() => D.parse({ version: 2, entries: [] }, true));
});

test('backup round trip retains custom items and preferences', () => {
  const original = { ...state([entry()]), customSymptoms: ['Jaw pain'], customTriggers: ['Stress'], preferences: { theme: 'dark' } };
  const restored = D.parse(JSON.parse(JSON.stringify(original)), true);
  assert.deepEqual(restored.entries[0].symptoms, [{ name: 'Headache', intensity: 7 }]);
  assert.deepEqual(restored.customSymptoms, ['Jaw pain']);
  assert.equal(restored.preferences.theme, 'dark');
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
