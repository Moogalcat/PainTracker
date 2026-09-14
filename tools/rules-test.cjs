/* Firestore rules tests. Run inside the local emulator (needs Java 21 or newer):
   npx firebase-tools emulators:exec --only firestore --project demo-pain-tracker "node tools/rules-test.cjs" */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../data.js');
global.PainData = D;
const S = require('../sync-data.js');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error('Run through firebase emulators:exec so FIRESTORE_EMULATOR_HOST is set.');
const project = 'demo-pain-tracker';
const documents = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const ADMIN = 'owner';

const encode = value => (value === null ? { nullValue: null }
  : typeof value === 'boolean' ? { booleanValue: value }
    : typeof value === 'number' ? (Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value })
      : typeof value === 'string' ? { stringValue: value }
        : Array.isArray(value) ? { arrayValue: { values: value.map(encode) } }
          : { mapValue: { fields: fieldsOf(value) } });
const fieldsOf = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, encode(value)]));

function idToken({ uid, email, verified = true }) {
  const part = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ iss: `https://securetoken.google.com/${project}`, aud: project,
    iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid, email, email_verified: verified,
    firebase: { sign_in_provider: 'google.com', identities: {} } })}.`;
}

async function call(method, path, auth, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${auth === ADMIN ? ADMIN : idToken(auth)}`;
  const response = await fetch(`${documents}/${path}`, { method, headers, body: body && JSON.stringify(body) });
  await response.text();
  return response.status;
}
const create = (auth, uid, id, data) => call('POST', `users/${uid}/changes?documentId=${id}`, auth, { fields: fieldsOf(data) });
const remove = (auth, uid, id) => call('DELETE', `users/${uid}/changes/${id}`, auth);
// One request holding several writes, the way a Firestore batch is sent.
async function commit(auth, writes) {
  const response = await fetch(`${documents}:commit`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken(auth)}` },
    body: JSON.stringify({ writes }) });
  await response.text();
  return response.status;
}
const documentName = (uid, id) => `projects/${project}/databases/(default)/documents/users/${uid}/changes/${id}`;
const query = (auth, uid) => call('POST', `users/${uid}:runQuery`, auth, { structuredQuery: {
  from: [{ collectionId: 'changes' }],
  where: { fieldFilter: { field: { fieldPath: 'generation' }, op: 'EQUAL', value: { integerValue: '1' } } } } });

const friend = { uid: 'friend-uid', email: 'friend@example.com' };
const stranger = { uid: 'stranger-uid', email: 'stranger@example.com' };

// Records built by the app's sync code, plus the fields appendChanges adds in sync.js.
const withMeta = record => ({ ...record, generation: 1, deviceId: '3f2b6c1e-8d4a-4f7b-9c2e-1a5d7e9b0c3f' });
const rich = D.normalise({ id: 'entry-1', at: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T11:00:00.000Z',
  endedAt: '2026-09-13T12:00:00.000Z', notes: 'After lunch', impact: 2,
  symptoms: [{ name: 'Headache', intensity: 7 }], characteristics: ['Throbbing'],
  relief: [{ name: 'Rest', effectiveness: 'Some' }],
  medications: [{ name: 'Ibuprofen', dose: '400 mg', effectiveness: 'Strong' }],
  triggers: ['Poor sleep'], knownCauses: ['Dental work'] });
const minimal = D.normalise({ id: 'entry-2', at: '2026-09-13T09:00:00.000Z' });
const { uploads } = S.reconcileEntries({ ...D.empty(), entries: [rich, minimal], deletedIds: ['entry-3'] }, [], {},
  Date.parse('2026-09-13T13:00:00Z'));
const entryChange = withMeta(uploads.find(item => item.id === 'entry-1'));
const minimalChange = withMeta(uploads.find(item => item.id === 'entry-2'));
const deletion = withMeta(uploads.find(item => item.id === 'entry-3'));
// Mirrors settingsRecord in sync.js.
const settings = withMeta({ kind: 'settings', modifiedAt: '2026-09-13T13:00:00.000Z', customSymptoms: ['Jaw pain'],
  customCharacteristics: [], customRelief: ['Tea'], customMedications: ['Naproxen'], customTriggers: [],
  preferences: { theme: 'dark', reminderMinutes: 60 } });

beforeEach(async () => {
  await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(await call('PATCH', 'config/access', ADMIN, { fields: fieldsOf({ emails: [friend.email] }) }), 200);
});

test('an allowed account can write every record shape the app sends', async () => {
  assert.equal(await create(friend, friend.uid, 'rich', entryChange), 200);
  assert.equal(await create(friend, friend.uid, 'minimal', minimalChange), 200);
  assert.equal(await create(friend, friend.uid, 'deletion', deletion), 200);
  assert.equal(await create(friend, friend.uid, 'settings', settings), 200);
});

test('an allowed account can query and delete its own records but never change them', async () => {
  assert.equal(await create(friend, friend.uid, 'rich', entryChange), 200);
  assert.equal(await query(friend, friend.uid), 200);
  assert.equal(await call('PATCH', `users/${friend.uid}/changes/rich`, friend, { fields: fieldsOf(entryChange) }), 403);
  assert.equal(await call('DELETE', `users/${friend.uid}/changes/rich`, friend), 200);
});

test('the longest note the app allows is accepted', async () => {
  const longest = { ...entryChange, entry: { ...entryChange.entry, notes: 'x'.repeat(D.notesLimit) } };
  assert.equal(await create(friend, friend.uid, 'longest', longest), 200);
});

test('an allowed account can remove entry contents and settings, but never the deletion records other devices rely on', async () => {
  for (const [id, record] of Object.entries({ rich: entryChange, deletion, settings })) {
    assert.equal(await create(friend, friend.uid, id, record), 200, id);
  }
  assert.equal(await remove(friend, friend.uid, 'rich'), 200);
  assert.equal(await remove(friend, friend.uid, 'settings'), 200);
  assert.equal(await remove(friend, friend.uid, 'already-removed'), 200);
  assert.equal(await remove(friend, friend.uid, 'deletion'), 403);
  assert.equal(await remove(stranger, friend.uid, 'deletion'), 403);
});

test('a batch of ten writes, as the app sends them, is accepted in one request', async () => {
  const writes = Array.from({ length: 10 }, (_, index) => ({ update: { name: documentName(friend.uid, `batch-${index}`),
    fields: fieldsOf(entryChange) }, currentDocument: { exists: false } }));
  assert.equal(await commit(friend, writes), 200);
  const deletes = writes.map(write => ({ delete: write.update.name }));
  assert.equal(await commit(friend, deletes), 200);
});

test('the allowlist ignores letter case but requires a verified address', async () => {
  assert.equal(await create({ ...friend, email: 'Friend@Example.com' }, friend.uid, 'rich', entryChange), 200);
  assert.equal(await create({ ...friend, verified: false }, friend.uid, 'unverified', entryChange), 403);
});

test('other accounts, signed-out requests and paths of other users are denied', async () => {
  assert.equal(await create(stranger, stranger.uid, 'rich', entryChange), 403);
  assert.equal(await query(stranger, stranger.uid), 403);
  assert.equal(await create(null, friend.uid, 'rich', entryChange), 403);
  assert.equal(await query(null, friend.uid), 403);
  assert.equal(await create(friend, 'someone-else', 'rich', entryChange), 403);
  assert.equal(await query(friend, 'someone-else'), 403);
});

test('without the access document nobody can sync', async () => {
  assert.equal(await call('DELETE', 'config/access', ADMIN), 200);
  assert.equal(await create(friend, friend.uid, 'rich', entryChange), 403);
  assert.equal(await query(friend, friend.uid), 403);
});

test('records not shaped the way the app writes them are rejected', async () => {
  const { entry, ...withoutEntry } = entryChange;
  const invalid = {
    unknownKind: { ...entryChange, kind: 'note' },
    extraField: { ...entryChange, extra: 'x' },
    deletionWithContent: { ...deletion, entry },
    contentWithoutEntry: withoutEntry,
    mismatchedEntryId: { ...entryChange, entry: { ...entry, id: 'other' } },
    extraEntryField: { ...entryChange, entry: { ...entry, mood: 'x' } },
    notesTooLong: { ...entryChange, entry: { ...entry, notes: 'x'.repeat(50001) } },
    tooManySymptoms: { ...entryChange, entry: { ...entry,
      symptoms: Array.from({ length: 201 }, (_, index) => ({ name: `S${index}`, intensity: 1 })) } },
    impactOutOfRange: { ...entryChange, entry: { ...entry, impact: 4 } },
    otherGeneration: { ...entryChange, generation: 2 },
    unknownTheme: { ...settings, preferences: { theme: 'neon', reminderMinutes: 0 } },
  };
  for (const [name, record] of Object.entries(invalid)) {
    assert.equal(await create(friend, friend.uid, name, record), 403, name);
  }
});
