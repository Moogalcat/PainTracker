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
  assert.throws(() => D.parse({ version: 2, entries: [] }, true));
});

test('backup round trip retains custom items and preferences', () => {
  const original = { ...state([entry({ characteristics: ['Throbbing'], relief: [{ name: 'Heat', effectiveness: 'Strong' }], impact: 2 })]), customSymptoms: ['Jaw pain'],
    customCharacteristics: ['Heavy'], customRelief: ['Tea'], customTriggers: ['Stress'], preferences: { theme: 'dark', reminderMinutes: 960 } };
  const restored = D.parse(JSON.parse(JSON.stringify(original)), true);
  assert.deepEqual(restored.entries[0].symptoms, [{ name: 'Headache', intensity: 7 }]);
  assert.deepEqual(restored.entries[0].characteristics, ['Throbbing']);
  assert.deepEqual(restored.entries[0].relief, [{ name: 'Heat', effectiveness: 'Strong' }]);
  assert.equal(restored.entries[0].impact, 2);
  assert.deepEqual(restored.customSymptoms, ['Jaw pain']);
  assert.deepEqual(restored.customCharacteristics, ['Heavy']);
  assert.deepEqual(restored.customRelief, ['Tea']);
  assert.equal(restored.preferences.theme, 'dark');
  assert.equal(restored.preferences.reminderMinutes, 960);
});

test('older entries migrate with safe defaults for new tracking fields', () => {
  const restored = D.parse([{ id: 'old', at, symptoms: [], triggers: [], notes: '' }], true);
  assert.deepEqual(restored.entries[0].characteristics, []);
  assert.deepEqual(restored.entries[0].relief, []);
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
