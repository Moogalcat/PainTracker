/* Pain Tracker — all data stays in this browser's localStorage. */
'use strict';

if (window.navigator && window.navigator.standalone === true && document.documentElement) {
  document.documentElement.classList.add('standalone');
}

const KEY = 'pain-tracker-v1';
const META_KEY = 'pain-tracker-meta-v1';
const BUILT_IN_SYMPTOMS = ['Stomach-ache', 'Headache', 'Nausea', 'Dizziness'];
const MAX_CUSTOM_ITEMS = 12;
const INITIAL_VISIBLE = 6;
const HISTORY_BATCH = 12;

const $ = id => document.getElementById(id);
const list = $('list');
const tpl = $('entryTpl');
let storageBlocked = false;
let lastRaw = null;
let state = loadState();
let entries = state.entries;
let visibleCount = INITIAL_VISIBLE;
let openOnRender = null;
let toastTimer;
const freshEntryIds = new Set();

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { console.error(error); return false; }
}

function loadState() {
  try {
    lastRaw = localStorage.getItem(KEY);
    const loaded = lastRaw === null ? PainData.empty() : PainData.parse(JSON.parse(lastRaw), true);
    loaded.entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    storageBlocked = false;
    return {
      version: 1,
      entries: loaded.entries,
      customSymptoms: loaded.customSymptoms,
      customTriggers: loaded.customTriggers,
      preferences: loaded.preferences,
      deletedIds: loaded.deletedIds,
    };
  } catch (error) {
    console.error('Saved data left untouched', error);
    storageBlocked = true;
    return PainData.empty();
  }
}

function persistState(next, recovering = false) {
  if (storageBlocked && !recovering) return false;
  try {
    if (!recovering && localStorage.getItem(KEY) !== lastRaw) {
      showError('Your log changed in another tab. Reload before saving.');
      return false;
    }
    const saved = {
      version: 1,
      entries: [...next.entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      customSymptoms: next.customSymptoms,
      customTriggers: next.customTriggers,
      preferences: next.preferences,
      deletedIds: next.deletedIds,
    };
    const raw = JSON.stringify(saved);
    localStorage.setItem(KEY, raw);
    lastRaw = raw;
    state = saved;
    entries = saved.entries;
    storageBlocked = false;
    $('appError').hidden = true;
    return true;
  } catch (error) {
    console.error(error);
    showError('This change could not be saved. Your existing log has not been replaced.');
    return false;
  }
}

function persistEntries(nextEntries, deletedId) {
  return persistState({
    ...state,
    entries: nextEntries,
    deletedIds: deletedId ? [...new Set([...state.deletedIds, deletedId])] : state.deletedIds,
  });
}

function markChanged() {
  const meta = readJSON(META_KEY, { pending: 0, lastExportAt: null });
  writeJSON(META_KEY, { ...meta, pending: Math.max(0, Number(meta.pending) || 0) + 1 });
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dateFmtYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function describe(date) {
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${sameYear ? dateFmt.format(date) : dateFmtYear.format(date)}, ${timeFmt.format(date)}`;
}

function setOpen(card, open) {
  card.classList.toggle('open', open);
  card.querySelector('.entry-body').hidden = !open;
  card.querySelector('[data-act="toggle"]').setAttribute('aria-expanded', String(open));
  if (open) {
    const input = card.querySelector('[data-field="at"]');
    input.max = PainData.toInput(new Date());
  }
}

function render() {
  const wasOpen = list.querySelector('.entry.open')?.dataset.id;
  list.replaceChildren();
  const shown = entries.slice(0, visibleCount);
  let lastYear = null;

  for (const entry of shown) {
    const year = new Date(entry.at).getFullYear();
    if (year !== lastYear && entries.some(item => new Date(item.at).getFullYear() !== year)) {
      const heading = document.createElement('li');
      heading.className = 'year-heading';
      heading.innerHTML = `<h2>${year}</h2>`;
      list.append(heading);
      lastYear = year;
    }

    const card = tpl.content.firstElementChild.cloneNode(true);
    card.dataset.id = entry.id;
    card.querySelector('.entry-when').textContent = describe(new Date(entry.at));
    renderEntrySummary(card, entry);
    fillEditor(card, entry);
    setOpen(card, entry.id === openOnRender || entry.id === wasOpen);
    list.append(card);
  }

  openOnRender = null;
  $('empty').hidden = entries.length !== 0;
  $('showOlder').hidden = visibleCount >= entries.length;
  $('showOlder').textContent = `Show older entries (${Math.max(0, entries.length - visibleCount)})`;
  $('recovery').hidden = !storageBlocked;
  $('logNow').disabled = storageBlocked;
  renderTally();
  renderStats();
  renderBackupStatus();
}

function renderEntrySummary(card, entry) {
  const meta = card.querySelector('.entry-meta');
  if (entry.symptoms.length) {
    meta.replaceChildren();
    entry.symptoms.forEach((symptom, index) => {
      if (index) meta.append(' · ');
      const label = document.createElement('span');
      label.textContent = `${symptom.name} `;
      const intensity = document.createElement('strong');
      intensity.textContent = symptom.intensity;
      label.append(intensity);
      meta.append(label);
    });
  } else meta.textContent = 'No symptoms rated';
  const notes = card.querySelector('.entry-notes');
  notes.textContent = entry.notes;
  notes.hidden = !entry.notes;
}

function fillEditor(card, entry) {
  card.querySelector('[data-field="at"]').value = PainData.toInput(new Date(entry.at));
  card.querySelector('[data-field="notes"]').value = entry.notes;
  renderSymptomChips(card.querySelector('[data-chips="symptoms"]'), entry.symptoms);
  renderRatings(card.querySelector('[data-ratings]'), entry.symptoms);
  renderTriggerChips(card.querySelector('[data-chips="triggers"]'), entry.triggers);
}

function allSymptoms() {
  return [...BUILT_IN_SYMPTOMS, ...state.customSymptoms];
}

function selectedNames(card) {
  return [...card.querySelectorAll('[data-chips="symptoms"] .chip.on')].map(button => button.dataset.value);
}

function makeChip(label, selected, custom) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `chip${selected ? ' on' : ''}`;
  chip.dataset.value = label;
  chip.setAttribute('aria-pressed', String(selected));
  chip.textContent = label;
  if (!custom) return chip;

  const wrap = document.createElement('span');
  wrap.className = 'chip-wrap';
  wrap.append(chip);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'chip-x';
  remove.dataset.remove = label;
  remove.setAttribute('aria-label', `Remove ${label}`);
  remove.textContent = '×';
  wrap.append(remove);
  return wrap;
}

function addChip(label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip chip-add';
  button.dataset.add = label;
  button.textContent = '+ Add your own';
  return button;
}

function renderSymptomChips(container, symptoms) {
  const selected = new Set(symptoms.map(item => item.name.toLocaleLowerCase()));
  const options = PainData.uniqueLabels([...allSymptoms(), ...symptoms.map(item => item.name)]);
  container.replaceChildren();
  for (const label of options) {
    container.append(makeChip(label, selected.has(label.toLocaleLowerCase()), state.customSymptoms.includes(label)));
  }
  container.append(addChip('symptom'));
}

function renderTriggerChips(container, triggers) {
  const selected = new Set(triggers.map(item => item.toLocaleLowerCase()));
  const options = PainData.uniqueLabels([...state.customTriggers, ...triggers]);
  container.replaceChildren();
  for (const label of options) {
    container.append(makeChip(label, selected.has(label.toLocaleLowerCase()), state.customTriggers.includes(label)));
  }
  container.append(addChip('trigger'));
}

function renderRatings(container, symptoms) {
  container.replaceChildren();
  for (const symptom of symptoms) container.append(makeRatingRow(symptom.name, symptom.intensity));
}

function makeRatingRow(name, intensity = null) {
  const row = document.createElement('div');
  row.className = 'rating-row';
  row.dataset.symptom = name;
  if (intensity) row.dataset.intensity = String(intensity);

  const head = document.createElement('div');
  head.className = 'rating-head';
  const label = document.createElement('span');
  label.textContent = name;
  const value = document.createElement('span');
  value.textContent = intensity ? `${intensity} / 10` : 'Choose 1–10';
  head.append(label, value);

  const scale = document.createElement('div');
  scale.className = 'scale';
  scale.setAttribute('role', 'group');
  scale.setAttribute('aria-label', `${name} intensity`);
  for (let number = 1; number <= 10; number++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.rating = String(number);
    button.className = number === intensity ? 'on' : '';
    button.setAttribute('aria-pressed', String(number === intensity));
    button.setAttribute('aria-label', `${number} out of 10`);
    button.textContent = number;
    scale.append(button);
  }
  const ends = document.createElement('div');
  ends.className = 'scale-ends';
  ends.innerHTML = '<span>Mild</span><span>Severe</span>';
  row.append(head, scale, ends);
  return row;
}

function readSymptoms(card) {
  return [...card.querySelectorAll('.rating-row')]
    .filter(row => row.dataset.intensity)
    .map(row => ({ name: row.dataset.symptom, intensity: Number(row.dataset.intensity) }));
}

function readTriggers(card) {
  return [...card.querySelectorAll('[data-chips="triggers"] .chip.on')].map(button => button.dataset.value);
}

function showCardError(card, message) {
  const error = card.querySelector('.entry-error');
  error.textContent = message;
  error.hidden = !message;
}

function handleChipClick(event, card) {
  const add = event.target.closest('[data-add]');
  if (add) { showCustomForm(add.dataset.add, card, add.closest('[data-chips]')); return; }

  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const type = remove.closest('[data-chips]').dataset.chips === 'symptoms' ? 'symptom' : 'trigger';
    removeCustom(type, remove.dataset.remove);
    return;
  }

  const chip = event.target.closest('.chip[data-value]');
  if (!chip) return;
  const container = chip.closest('[data-chips]');
  const turnOn = !chip.classList.contains('on');
  chip.classList.toggle('on', turnOn);
  chip.setAttribute('aria-pressed', String(turnOn));

  if (container.dataset.chips === 'symptoms') {
    const ratings = card.querySelector('[data-ratings]');
    const existing = [...ratings.children].find(row => row.dataset.symptom === chip.dataset.value);
    if (turnOn && !existing) ratings.append(makeRatingRow(chip.dataset.value));
    if (!turnOn && existing) existing.remove();
  }
  showCardError(card, '');
}

function showCustomForm(type, card, container) {
  card.querySelector('.custom-add')?.remove();
  const form = document.createElement('div');
  form.className = 'custom-add';
  form.dataset.customType = type;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = type === 'symptom' ? 'Symptom name' : 'Possible trigger';
  input.setAttribute('aria-label', input.placeholder);
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.dataset.customAction = 'add'; save.textContent = 'Add';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn btn-ghost btn-sm'; cancel.dataset.customAction = 'cancel'; cancel.textContent = 'Cancel';
  form.append(input, save, cancel);
  container.after(form);
  input.focus();
}

function addCustom(type, card, rawValue) {
  const value = rawValue.trim();
  if (!value) { showCardError(card, `Enter a ${type} name first.`); return; }
  if (value.length > 40) { showCardError(card, 'Please use a name of 40 characters or fewer.'); return; }

  const field = type === 'symptom' ? 'customSymptoms' : 'customTriggers';
  const existing = type === 'symptom' ? allSymptoms() : state.customTriggers;
  const match = existing.find(item => item.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (!match && state[field].length >= MAX_CUSTOM_ITEMS) {
    showCardError(card, `You can keep up to ${MAX_CUSTOM_ITEMS} custom ${type}s.`);
    return;
  }

  const label = match || value;
  if (!match) {
    if (!persistState({ ...state, [field]: [...state[field], value] })) return;
    markChanged();
  }
  refreshAllChipLists();

  const current = list.querySelector(`[data-id="${CSS.escape(card.dataset.id)}"]`);
  const currentChip = [...current.querySelectorAll(`[data-chips="${type === 'symptom' ? 'symptoms' : 'triggers'}"] .chip[data-value]`)]
    .find(button => button.dataset.value === label);
  if (currentChip && !currentChip.classList.contains('on')) currentChip.click();
  showCardError(current, '');
}

function removeCustom(type, label) {
  if (!window.confirm(`Remove “${label}” from your ${type} list? Existing saved entries will keep it.`)) return;
  const field = type === 'symptom' ? 'customSymptoms' : 'customTriggers';
  if (!persistState({ ...state, [field]: state[field].filter(item => item !== label) })) return;
  if (type === 'symptom') {
    for (const row of list.querySelectorAll('.rating-row')) {
      if (row.dataset.symptom === label) row.remove();
    }
  }
  refreshAllChipLists();
  markChanged();
  toast(`${label} removed from your list`);
}

function refreshAllChipLists() {
  for (const card of list.querySelectorAll('.entry')) {
    const selectedSymptoms = [...card.querySelectorAll('.rating-row')].map(row => ({
      name: row.dataset.symptom,
      intensity: Number(row.dataset.intensity) || null,
    }));
    const selectedTriggers = readTriggers(card);
    renderSymptomChips(card.querySelector('[data-chips="symptoms"]'), selectedSymptoms);
    renderTriggerChips(card.querySelector('[data-chips="triggers"]'), selectedTriggers);
  }
}

function handleRatingClick(event, card) {
  const button = event.target.closest('[data-rating]');
  if (!button) return;
  const row = button.closest('.rating-row');
  row.dataset.intensity = button.dataset.rating;
  for (const option of row.querySelectorAll('[data-rating]')) {
    const selected = option === button;
    option.classList.toggle('on', selected);
    option.setAttribute('aria-pressed', String(selected));
  }
  row.querySelector('.rating-head span:last-child').textContent = `${button.dataset.rating} / 10`;
  showCardError(card, '');
}

function saveEntry(card) {
  const entry = entries.find(item => item.id === card.dataset.id);
  if (!entry) return;
  const date = PainData.fromInput(card.querySelector('[data-field="at"]').value);
  if (!date) { showCardError(card, 'Choose a valid date and time.'); return; }
  if (date.getTime() > Date.now()) { showCardError(card, 'The date and time cannot be in the future.'); return; }

  const chosen = selectedNames(card);
  const symptoms = readSymptoms(card);
  if (symptoms.length !== chosen.length) {
    showCardError(card, 'Choose an intensity from 1–10 for every selected symptom.');
    return;
  }

  const updated = PainData.normalise({
    ...entry,
    at: date.toISOString(),
    updatedAt: new Date().toISOString(),
    symptoms,
    triggers: readTriggers(card),
    notes: card.querySelector('[data-field="notes"]').value.trim(),
  });
  const next = entries.map(item => item.id === entry.id ? updated : item);
  if (!persistEntries(next)) return;
  freshEntryIds.delete(entry.id);
  markChanged();
  card.classList.remove('open');
  render();
  toast('Entry saved');
}

function cancelEntry(card) {
  if (freshEntryIds.has(card.dataset.id)) {
    const next = entries.filter(item => item.id !== card.dataset.id);
    if (!persistEntries(next, card.dataset.id)) return;
    freshEntryIds.delete(card.dataset.id);
    render();
    toast('New entry cancelled');
  } else {
    card.classList.remove('open');
    render();
  }
}

function deleteEntry(card) {
  if (!window.confirm('Delete this entry? This cannot be undone.')) return;
  const id = card.dataset.id;
  if (!persistEntries(entries.filter(item => item.id !== id), id)) return;
  freshEntryIds.delete(id);
  markChanged();
  render();
  toast('Entry deleted');
}

function addEntry() {
  const now = new Date();
  const entry = PainData.normalise({ id: PainData.uid(), at: now.toISOString(), updatedAt: now.toISOString(), symptoms: [], triggers: [], notes: '' });
  if (!persistEntries([entry, ...entries])) return;
  freshEntryIds.add(entry.id);
  openOnRender = entry.id;
  visibleCount = Math.max(visibleCount, 1);
  render();
  requestAnimationFrame(() => list.querySelector(`[data-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function renderTally() {
  if (!entries.length) { $('tally').textContent = 'Ready when you are'; return; }
  const days = new Set(entries.map(entry => entry.at.slice(0, 10))).size;
  $('tally').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} across ${days} ${days === 1 ? 'day' : 'days'}`;
}

function statBlock(title) {
  const block = document.createElement('section');
  block.className = 'stat-block';
  const heading = document.createElement('h3');
  heading.textContent = title;
  block.append(heading);
  return block;
}

function statRow(label, value, fraction, suffix = '') {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const name = document.createElement('span');
  name.className = 'stat-label';
  name.textContent = label;
  const track = document.createElement('span');
  track.className = 'stat-track';
  const bar = document.createElement('span');
  bar.className = 'stat-bar';
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  track.append(bar);
  const count = document.createElement('span');
  count.className = 'stat-count';
  count.textContent = `${value}${suffix}`;
  row.append(name, track, count);
  return row;
}

function renderStats() {
  const stats = $('stats');
  stats.replaceChildren();
  $('statsStatus').textContent = entries.length ? ` · ${entries.length} total` : '';
  if (!entries.length) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'Statistics will appear after you save an entry.';
    stats.append(note);
    return;
  }

  const facts = statBlock('Overview');
  const values = entries.flatMap(entry => entry.symptoms.map(symptom => symptom.intensity));
  const dl = document.createElement('dl');
  dl.className = 'stat-facts';
  const pairs = [
    ['Entries', entries.length],
    ['Symptoms rated', values.length],
    ['Average intensity', values.length ? `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)} / 10` : '—'],
  ];
  for (const [term, detail] of pairs) {
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = detail;
    dl.append(dt, dd);
  }
  facts.append(dl);
  stats.append(facts);

  const symptoms = new Map();
  for (const entry of entries) for (const symptom of entry.symptoms) {
    const key = symptom.name;
    const current = symptoms.get(key) || { count: 0, total: 0 };
    current.count++; current.total += symptom.intensity; symptoms.set(key, current);
  }
  const symptomBlock = statBlock('Symptoms · average intensity');
  if (!symptoms.size) {
    const note = document.createElement('p'); note.className = 'note'; note.textContent = 'No symptoms rated yet.'; symptomBlock.append(note);
  } else {
    [...symptoms].sort((a, b) => b[1].count - a[1].count).forEach(([name, value]) => {
      const average = value.total / value.count;
      symptomBlock.append(statRow(name, average.toFixed(1), average / 10, '/10'));
    });
  }
  stats.append(symptomBlock);

  const triggerCounts = new Map();
  for (const entry of entries) for (const trigger of entry.triggers) triggerCounts.set(trigger, (triggerCounts.get(trigger) || 0) + 1);
  if (triggerCounts.size) {
    const triggerBlock = statBlock('Possible triggers');
    const peak = Math.max(...triggerCounts.values());
    [...triggerCounts].sort((a, b) => b[1] - a[1]).forEach(([name, count]) => triggerBlock.append(statRow(name, count, count / peak)));
    stats.append(triggerBlock);
  }
}

function renderBackupStatus() {
  const meta = readJSON(META_KEY, { pending: 0 });
  const count = Math.max(0, Number(meta.pending) || 0);
  const status = $('backupStatus');
  status.textContent = count ? ` · ${count} ${count === 1 ? 'change' : 'changes'} since export` : '';
  status.classList.toggle('stale', count > 0);
}

function exportBackup() {
  try {
    const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `pain-tracker-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    writeJSON(META_KEY, { pending: 0, lastExportAt: new Date().toISOString() });
    renderBackupStatus();
    toast('Backup download started');
  } catch (error) { console.error(error); showError('The backup could not be created.'); }
}

async function importBackup(file) {
  try {
    const incoming = PainData.parse(JSON.parse(await file.text()));
    const merged = PainData.merge(state, incoming);
    if (!persistState(merged.state)) return;
    markChanged();
    render();
    const result = merged.result;
    const message = `Imported: ${result.added} added, ${result.updated} updated, ${result.duplicates} already present${result.conflicts ? `, ${result.conflicts} kept local` : ''}${result.invalid ? `, ${result.invalid} invalid skipped` : ''}.`;
    $('importResult').textContent = message;
    $('importResult').hidden = false;
  } catch (error) {
    console.error(error);
    $('importResult').textContent = 'That file is not a valid Pain Tracker backup.';
    $('importResult').classList.add('error');
    $('importResult').hidden = false;
  } finally { $('importFile').value = ''; }
}

function recoveryCopy() {
  const raw = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith('pain-tracker')) raw[key] = localStorage.getItem(key);
  }
  return raw;
}

function downloadRecovery() {
  const blob = new Blob([JSON.stringify(recoveryCopy(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pain-tracker-recovery-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function applyTheme() {
  const theme = state.preferences.theme;
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
  $('theme').value = theme;
}

function showError(message) {
  $('appError').textContent = message;
  $('appError').hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

list.addEventListener('click', event => {
  const card = event.target.closest('.entry');
  if (!card) return;
  const customAction = event.target.closest('[data-custom-action]')?.dataset.customAction;
  if (customAction === 'cancel') { event.target.closest('.custom-add').remove(); return; }
  if (customAction === 'add') {
    const form = event.target.closest('.custom-add');
    addCustom(form.dataset.customType, card, form.querySelector('input').value);
    return;
  }
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'toggle') { setOpen(card, card.querySelector('.entry-body').hidden); return; }
  if (action === 'save') { saveEntry(card); return; }
  if (action === 'cancel') { cancelEntry(card); return; }
  if (action === 'delete') { deleteEntry(card); return; }
  if (event.target.closest('[data-chips]')) handleChipClick(event, card);
  else if (event.target.closest('[data-rating]')) handleRatingClick(event, card);
});

list.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.target.closest('.custom-add input')) return;
  event.preventDefault();
  const form = event.target.closest('.custom-add');
  addCustom(form.dataset.customType, event.target.closest('.entry'), form.querySelector('input').value);
});

$('logNow').addEventListener('click', addEntry);
$('showOlder').addEventListener('click', () => { visibleCount += HISTORY_BATCH; render(); });
$('exportBtn').addEventListener('click', exportBackup);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', () => { const [file] = $('importFile').files; if (file) importBackup(file); });
$('recoveryExport').addEventListener('click', downloadRecovery);
$('recoveryRetry').addEventListener('click', () => { state = loadState(); entries = state.entries; applyTheme(); render(); });
$('theme').addEventListener('change', () => {
  const theme = $('theme').value;
  if (!PainData.themes.includes(theme) || !persistState({ ...state, preferences: { theme } })) return;
  applyTheme();
  markChanged();
  renderBackupStatus();
});

window.addEventListener('storage', event => {
  if (event.key === KEY) showError('Your log changed in another tab. Reload before making more changes.');
});

applyTheme();
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(error => console.warn('Offline mode unavailable', error)));
}
