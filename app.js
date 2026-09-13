/* Pain Tracker — local-first data storage with optional cloud sync. */
'use strict';

if (window.navigator && window.navigator.standalone === true && document.documentElement) {
  document.documentElement.classList.add('standalone');
}

const KEY = 'pain-tracker-v1';
const META_KEY = 'pain-tracker-meta-v1';
const BUILT_IN_SYMPTOMS = ['Stomach-ache', 'Headache', 'Nausea', 'Dizziness'];
const BUILT_IN_CHARACTERISTICS = [
  'Sharp', 'Dull', 'Aching', 'Burning', 'Throbbing',
  'Cramping', 'Pressure', 'Tingling', 'Radiating',
];
const BUILT_IN_RELIEF = ['Medication', 'Rest', 'Heat', 'Cold', 'Stretching', 'Hydration', 'Food', 'Movement'];
const MEDICATION = 'Medication';
const IMPACT_LABELS = ['No limitation', 'Slowed down', 'Stopped activities', 'Needed bed rest'];
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
let highlightOnRender = null;
let toastTimer;
let reminderTimer;
const freshEntryIds = new Set();
const remindedThisSession = new Set();

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
      version: PainData.backupVersion,
      entries: loaded.entries,
      customSymptoms: loaded.customSymptoms,
      customCharacteristics: loaded.customCharacteristics,
      customRelief: loaded.customRelief,
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

function persistState(next, recovering = false, fromSync = false) {
  if (storageBlocked && !recovering) return false;
  try {
    if (!recovering && localStorage.getItem(KEY) !== lastRaw) {
      showError('Your log changed in another tab. Reload before saving.');
      return false;
    }
    const saved = {
      version: PainData.backupVersion,
      entries: [...next.entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      customSymptoms: next.customSymptoms,
      customCharacteristics: next.customCharacteristics,
      customRelief: next.customRelief,
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
    if (!fromSync) window.PainTrackerSyncStateChanged?.();
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
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });

function describe(date) {
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${sameYear ? dateFmt.format(date) : dateFmtYear.format(date)}, ${timeFmt.format(date)}`;
}

function durationText(start, end) {
  const minutes = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
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
  const highlightedId = highlightOnRender;
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
    card.classList.toggle('just-repeated', entry.id === highlightedId);
    card.querySelector('.entry-when').textContent = describe(new Date(entry.at));
    renderEntrySummary(card, entry);
    fillEditor(card, entry);
    setOpen(card, entry.id === openOnRender || entry.id === wasOpen);
    list.append(card);
  }

  openOnRender = null;
  highlightOnRender = null;
  if (highlightedId) {
    setTimeout(() => list.querySelector(`[data-id="${CSS.escape(highlightedId)}"]`)?.classList.remove('just-repeated'), 2100);
  }
  $('empty').hidden = entries.length !== 0;
  $('showOlder').hidden = visibleCount >= entries.length;
  $('showOlder').textContent = `Show older entries (${Math.max(0, entries.length - visibleCount)})`;
  $('recovery').hidden = !storageBlocked;
  $('logNow').disabled = storageBlocked;
  renderTally();
  renderStats();
  renderMedicationNames();
  renderBackupStatus();
  renderReminderStatus();
  scheduleReminder();
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
  const characteristics = card.querySelector('.entry-characteristics');
  characteristics.textContent = entry.characteristics.join(' · ');
  characteristics.hidden = !entry.characteristics.length;
  const duration = card.querySelector('.entry-duration');
  duration.textContent = entry.ongoing ? 'Ongoing'
    : entry.endedAt ? `Ended · Duration ${durationText(entry.at, entry.endedAt)}` : 'Ended · time unknown';
  duration.hidden = !duration.textContent;
  const impact = card.querySelector('.entry-impact');
  impact.textContent = entry.impact == null ? '' : `Impact: ${IMPACT_LABELS[entry.impact]}`;
  impact.hidden = !impact.textContent;
  const medication = card.querySelector('.entry-medication');
  medication.textContent = entry.medications.length
    ? `Medication: ${entry.medications.map(item => `${medicationLabel(item)} — ${item.effectiveness.toLowerCase()}`).join(' · ')}` : '';
  medication.hidden = !medication.textContent;
  const relief = card.querySelector('.entry-relief');
  relief.textContent = entry.relief.length
    ? `Relief: ${entry.relief.map(item => `${item.name} — ${item.effectiveness.toLowerCase()}`).join(' · ')}` : '';
  relief.hidden = !relief.textContent;
  const triggers = card.querySelector('.entry-triggers');
  triggers.textContent = [
    entry.knownCauses.length ? `Known causes: ${entry.knownCauses.join(', ')}` : '',
    entry.triggers.length ? `Possible triggers: ${entry.triggers.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  triggers.hidden = !triggers.textContent;
  const notes = card.querySelector('.entry-notes');
  notes.textContent = entry.notes;
  notes.hidden = !entry.notes;
}

function fillEditor(card, entry) {
  card.querySelector('[data-field="at"]').value = PainData.toInput(new Date(entry.at));
  const endState = PainData.endState(entry);
  for (const radio of card.querySelectorAll('[data-field="endState"]')) {
    radio.name = `end-${entry.id}`;
    radio.checked = radio.value === endState;
  }
  card.querySelector('[data-field="endedAt"]').value = entry.endedAt ? PainData.toInput(new Date(entry.endedAt)) : '';
  updateEndRow(card);
  card.querySelector('[data-field="notes"]').value = entry.notes;
  renderSymptomChips(card.querySelector('[data-chips="symptoms"]'), entry.symptoms);
  renderRatings(card.querySelector('[data-ratings]'), entry.symptoms);
  renderCharacteristicChips(card.querySelector('[data-chips="characteristics"]'), entry.characteristics);
  renderImpactChips(card.querySelector('[data-chips="impact"]'), entry.impact);
  renderReliefChips(card.querySelector('[data-chips="relief"]'), entry.relief, entry.medications.length > 0);
  renderReliefRatings(card.querySelector('[data-relief-ratings]'), entry.relief, entry.medications);
  renderTriggerChips(card.querySelector('[data-chips="triggers"]'), [...entry.knownCauses, ...entry.triggers]);
  renderTriggerChoices(card.querySelector('[data-trigger-choices]'), entry.triggers, entry.knownCauses);
}

function selectedEndState(card) {
  return card.querySelector('[data-field="endState"]:checked')?.value || 'ongoing';
}

function updateEndRow(card) {
  card.querySelector('[data-end-row]').hidden = selectedEndState(card) !== 'ended';
}

function endNow(card) {
  card.querySelector('[data-field="endedAt"]').value = PainData.toInput(new Date());
  showCardError(card, '');
}

function allSymptoms() {
  return [...BUILT_IN_SYMPTOMS, ...state.customSymptoms];
}

function allCharacteristics() {
  return [...BUILT_IN_CHARACTERISTICS, ...state.customCharacteristics];
}

function allRelief() {
  return [...BUILT_IN_RELIEF, ...state.customRelief];
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

function renderCharacteristicChips(container, characteristics) {
  const selected = new Set(characteristics.map(item => item.toLocaleLowerCase()));
  const options = PainData.uniqueLabels([...allCharacteristics(), ...characteristics]);
  container.replaceChildren();
  for (const label of options) {
    container.append(makeChip(label, selected.has(label.toLocaleLowerCase()), state.customCharacteristics.includes(label)));
  }
  container.append(addChip('characteristic'));
}

function renderImpactChips(container, impact) {
  container.replaceChildren();
  IMPACT_LABELS.forEach((label, index) => container.append(makeChip(label, impact === index, false)));
}

function renderReliefChips(container, relief, medicationOn) {
  const selected = new Set(relief.map(item => item.name.toLocaleLowerCase()));
  if (medicationOn) selected.add(MEDICATION.toLocaleLowerCase());
  const options = PainData.uniqueLabels([...allRelief(), ...relief.map(item => item.name)]);
  container.replaceChildren();
  for (const label of options) {
    container.append(makeChip(label, selected.has(label.toLocaleLowerCase()), state.customRelief.includes(label)));
  }
  container.append(addChip('relief'));
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

function renderTriggerChoices(container, triggers, knownCauses) {
  container.replaceChildren();
  for (const name of knownCauses) container.append(makeTriggerChoice(name, true));
  for (const name of triggers) container.append(makeTriggerChoice(name, false));
}

function makeTriggerChoice(name, known = false) {
  const row = document.createElement('div');
  row.className = 'trigger-choice';
  row.dataset.trigger = name;
  row.dataset.known = String(known);
  const label = document.createElement('span');
  label.textContent = name;
  const options = document.createElement('div');
  options.className = 'relief-scale trigger-scale';
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', `Is ${name} a possible trigger or a known cause?`);
  for (const [value, text] of [['false', 'Possible'], ['true', 'Known cause']]) {
    const selected = value === String(known);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.certainty = value;
    button.className = selected ? 'on' : '';
    button.setAttribute('aria-pressed', String(selected));
    button.textContent = text;
    options.append(button);
  }
  row.append(label, options);
  return row;
}

function renderRatings(container, symptoms) {
  container.replaceChildren();
  for (const symptom of symptoms) container.append(makeRatingRow(symptom.name, symptom.intensity));
}

function makeRatingRow(name, intensity = null) {
  const row = document.createElement('div');
  row.className = 'rating-row';
  row.dataset.symptom = name;
  if (Number.isInteger(intensity)) row.dataset.intensity = String(intensity);

  const head = document.createElement('div');
  head.className = 'rating-head';
  const label = document.createElement('span');
  label.textContent = name;
  const value = document.createElement('span');
  value.textContent = Number.isInteger(intensity) ? `${intensity} / 10` : 'Choose 0–10';
  head.append(label, value);

  const scale = document.createElement('div');
  scale.className = 'scale';
  scale.setAttribute('role', 'group');
  scale.setAttribute('aria-label', `${name} intensity`);
  for (let number = 0; number <= 10; number++) {
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
  ends.innerHTML = '<span>None</span><span>Severe</span>';
  row.append(head, scale, ends);
  return row;
}

function renderReliefRatings(container, relief, medications) {
  container.replaceChildren();
  if (medications.length) container.append(makeMedicationPanel(medications));
  for (const item of relief) container.append(makeReliefRow(item.name, item.effectiveness));
}

function makeReliefRow(name, effectiveness = null) {
  const row = document.createElement('div');
  row.className = 'relief-row';
  row.dataset.relief = name;
  if (PainData.reliefLevels.includes(effectiveness)) row.dataset.effectiveness = effectiveness;
  row.append(...makeHelpRating(name, name, effectiveness));
  return row;
}

function makeMedicationPanel(medications) {
  const panel = document.createElement('div');
  panel.className = 'medication-panel';
  panel.dataset.medicationPanel = '';
  const head = document.createElement('div');
  head.className = 'rating-head';
  head.textContent = MEDICATION;
  const rows = document.createElement('div');
  rows.className = 'medication-list';
  for (const item of medications.length ? medications : [{}]) rows.append(makeMedicationRow(item));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip chip-add';
  add.dataset.medAction = 'add';
  add.textContent = '+ Add medication';
  panel.append(head, rows, add);
  return panel;
}

function makeMedicationRow({ name = '', dose = '', effectiveness = null } = {}) {
  const row = document.createElement('div');
  row.className = 'medication-row';
  row.dataset.medication = '';
  if (PainData.reliefLevels.includes(effectiveness)) row.dataset.effectiveness = effectiveness;

  const fields = document.createElement('div');
  fields.className = 'medication-fields';
  for (const [field, value, placeholder, label, maxLength] of [
    ['name', name, 'Name, e.g. Ibuprofen', 'Medication name', 60],
    ['dose', dose, 'Dose, e.g. 400 mg', 'Dose', 30],
  ]) {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.medField = field;
    input.value = value;
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    if (field === 'name') input.setAttribute('list', 'medicationNames');
    fields.append(input);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'medication-remove';
  remove.dataset.medAction = 'remove';
  remove.setAttribute('aria-label', 'Remove medication');
  remove.textContent = '×';
  fields.append(remove);

  row.append(fields, ...makeHelpRating('How much did it help?', MEDICATION, effectiveness, ''));
  return row;
}

function removeMedication(card, row) {
  const panel = row.closest('[data-medication-panel]');
  row.remove();
  if (!panel.querySelector('[data-medication]')) {
    panel.remove();
    const chip = card.querySelector(`[data-chips="relief"] .chip[data-value="${MEDICATION}"]`);
    chip.classList.remove('on');
    chip.setAttribute('aria-pressed', 'false');
  }
  showCardError(card, '');
}

function medicationLabel(item) {
  return `${item.name || PainData.unknownMedicationName}${item.dose ? ` ${item.dose}` : ''}`;
}

function renderMedicationNames() {
  const names = PainData.uniqueLabels(entries.flatMap(entry => entry.medications.map(item => item.name)))
    .filter(name => name !== PainData.unknownMedicationName);
  $('medicationNames').replaceChildren(...names.map(name => new Option('', name)));
}

function makeHelpRating(label, name, effectiveness, prompt = 'How much did it help?') {
  const head = document.createElement('div');
  head.className = 'rating-head';
  const title = document.createElement('span');
  title.textContent = label;
  const value = document.createElement('span');
  value.textContent = effectiveness || prompt;
  head.append(title, value);

  const scale = document.createElement('div');
  scale.className = 'relief-scale';
  scale.setAttribute('role', 'group');
  scale.setAttribute('aria-label', `${name} effectiveness`);
  for (const level of PainData.reliefLevels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.effectiveness = level;
    button.className = level === effectiveness ? 'on' : '';
    button.setAttribute('aria-pressed', String(level === effectiveness));
    button.textContent = level;
    scale.append(button);
  }
  return [head, scale];
}

function readSymptoms(card) {
  return [...card.querySelectorAll('.rating-row[data-symptom]')]
    .filter(row => row.dataset.intensity !== undefined)
    .map(row => ({ name: row.dataset.symptom, intensity: Number(row.dataset.intensity) }));
}

function readImpact(card) {
  const selected = card.querySelector('[data-chips="impact"] .chip.on');
  return selected ? IMPACT_LABELS.indexOf(selected.dataset.value) : null;
}

function readRelief(card) {
  return [...card.querySelectorAll('[data-relief-ratings] [data-relief]')]
    .filter(row => PainData.reliefLevels.includes(row.dataset.effectiveness))
    .map(row => ({ name: row.dataset.relief, effectiveness: row.dataset.effectiveness }));
}

function readMedications(card) {
  return [...card.querySelectorAll('[data-medication]')].map(row => ({
    name: row.querySelector('[data-med-field="name"]').value.trim(),
    dose: row.querySelector('[data-med-field="dose"]').value.trim(),
    effectiveness: row.dataset.effectiveness || null,
  }));
}

function readTriggerChoices(card) {
  const rows = [...card.querySelectorAll('[data-trigger-choices] [data-trigger]')];
  return {
    triggers: rows.filter(row => row.dataset.known !== 'true').map(row => row.dataset.trigger),
    knownCauses: rows.filter(row => row.dataset.known === 'true').map(row => row.dataset.trigger),
  };
}

function readCharacteristics(card) {
  return [...card.querySelectorAll('[data-chips="characteristics"] .chip.on')].map(button => button.dataset.value);
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
    const type = { symptoms: 'symptom', characteristics: 'characteristic', relief: 'relief', triggers: 'trigger' }
      [remove.closest('[data-chips]').dataset.chips];
    removeCustom(type, remove.dataset.remove);
    return;
  }

  const chip = event.target.closest('.chip[data-value]');
  if (!chip) return;
  const container = chip.closest('[data-chips]');
  const turnOn = !chip.classList.contains('on');
  if (container.dataset.chips === 'impact') {
    for (const option of container.querySelectorAll('.chip.on')) {
      option.classList.remove('on');
      option.setAttribute('aria-pressed', 'false');
    }
  }
  chip.classList.toggle('on', turnOn);
  chip.setAttribute('aria-pressed', String(turnOn));

  if (container.dataset.chips === 'symptoms') {
    const ratings = card.querySelector('[data-ratings]');
    const existing = [...ratings.children].find(row => row.dataset.symptom === chip.dataset.value);
    if (turnOn && !existing) ratings.append(makeRatingRow(chip.dataset.value));
    if (!turnOn && existing) existing.remove();
  }
  if (container.dataset.chips === 'relief' && chip.dataset.value === MEDICATION) {
    const ratings = card.querySelector('[data-relief-ratings]');
    const panel = ratings.querySelector('[data-medication-panel]');
    if (turnOn && !panel) {
      const added = makeMedicationPanel([]);
      ratings.prepend(added);
      added.querySelector('input').focus();
    }
    if (!turnOn && panel) panel.remove();
  } else if (container.dataset.chips === 'relief') {
    const ratings = card.querySelector('[data-relief-ratings]');
    const existing = [...ratings.children].find(row => row.dataset.relief === chip.dataset.value);
    if (turnOn && !existing) ratings.append(makeReliefRow(chip.dataset.value));
    if (!turnOn && existing) existing.remove();
  }
  if (container.dataset.chips === 'triggers') {
    const choices = card.querySelector('[data-trigger-choices]');
    const existing = [...choices.children].find(row => row.dataset.trigger === chip.dataset.value);
    if (turnOn && !existing) choices.append(makeTriggerChoice(chip.dataset.value));
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
  input.placeholder = type === 'symptom' ? 'Symptom name'
    : type === 'characteristic' ? 'Pain characteristic'
      : type === 'relief' ? 'Relief attempt' : 'Trigger or cause';
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

  const field = { symptom: 'customSymptoms', characteristic: 'customCharacteristics', relief: 'customRelief', trigger: 'customTriggers' }[type];
  const existing = type === 'symptom' ? allSymptoms()
    : type === 'characteristic' ? allCharacteristics()
      : type === 'relief' ? allRelief() : state.customTriggers;
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
  const chipGroup = { symptom: 'symptoms', characteristic: 'characteristics', relief: 'relief', trigger: 'triggers' }[type];
  const currentChip = [...current.querySelectorAll(`[data-chips="${chipGroup}"] .chip[data-value]`)]
    .find(button => button.dataset.value === label);
  if (currentChip && !currentChip.classList.contains('on')) currentChip.click();
  showCardError(current, '');
}

function removeCustom(type, label) {
  if (!window.confirm(`Remove “${label}” from your ${type} list? Existing saved entries will keep it.`)) return;
  const field = { symptom: 'customSymptoms', characteristic: 'customCharacteristics', relief: 'customRelief', trigger: 'customTriggers' }[type];
  if (!persistState({ ...state, [field]: state[field].filter(item => item !== label) })) return;
  refreshAllChipLists();
  markChanged();
  toast(`${label} removed from your list`);
}

function refreshAllChipLists() {
  for (const card of list.querySelectorAll('.entry')) {
    const selectedSymptoms = [...card.querySelectorAll('.rating-row[data-symptom]')].map(row => ({
      name: row.dataset.symptom,
      intensity: row.dataset.intensity === undefined ? null : Number(row.dataset.intensity),
    }));
    const selectedCharacteristics = readCharacteristics(card);
    const selectedRelief = [...card.querySelectorAll('[data-relief-ratings] [data-relief]')].map(row => ({
      name: row.dataset.relief,
      effectiveness: row.dataset.effectiveness || null,
    }));
    const selectedTriggers = [...card.querySelectorAll('[data-trigger-choices] [data-trigger]')].map(row => row.dataset.trigger);
    renderSymptomChips(card.querySelector('[data-chips="symptoms"]'), selectedSymptoms);
    renderCharacteristicChips(card.querySelector('[data-chips="characteristics"]'), selectedCharacteristics);
    renderReliefChips(card.querySelector('[data-chips="relief"]'), selectedRelief, !!card.querySelector('[data-medication-panel]'));
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

function handleEffectivenessClick(event, card) {
  const button = event.target.closest('button[data-effectiveness]');
  if (!button) return;
  const row = button.closest('[data-medication], [data-relief]');
  row.dataset.effectiveness = button.dataset.effectiveness;
  for (const option of row.querySelectorAll('[data-effectiveness]')) {
    const selected = option === button;
    option.classList.toggle('on', selected);
    option.setAttribute('aria-pressed', String(selected));
  }
  row.querySelector('.rating-head span:last-child').textContent = button.dataset.effectiveness;
  showCardError(card, '');
}

function handleCertaintyClick(event, card) {
  const button = event.target.closest('button[data-certainty]');
  const row = button.closest('[data-trigger]');
  row.dataset.known = button.dataset.certainty;
  for (const option of row.querySelectorAll('button[data-certainty]')) {
    const selected = option === button;
    option.classList.toggle('on', selected);
    option.setAttribute('aria-pressed', String(selected));
  }
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
    showCardError(card, 'Choose an intensity from 0–10 for every selected symptom.');
    return;
  }

  const endState = selectedEndState(card);
  let endedAt = null;
  if (endState === 'ended') {
    const end = PainData.fromInput(card.querySelector('[data-field="endedAt"]').value);
    if (!end) { showCardError(card, 'Choose when it ended, or pick “Ended, time unknown”.'); return; }
    if (end < date) { showCardError(card, 'The end time cannot be before the start time.'); return; }
    if (end.getTime() > Date.now()) { showCardError(card, 'The end time cannot be in the future.'); return; }
    endedAt = end.toISOString();
  }

  const chosenRelief = card.querySelectorAll(`[data-chips="relief"] .chip.on:not([data-value="${MEDICATION}"])`).length;
  const relief = readRelief(card);
  if (relief.length !== chosenRelief) {
    showCardError(card, 'Choose how much every selected relief attempt helped.');
    return;
  }
  const medications = readMedications(card);
  if (medications.some(item => !item.name)) {
    showCardError(card, 'Enter a name for every medication.');
    return;
  }
  if (medications.some(item => !item.effectiveness)) {
    showCardError(card, 'Choose how much every medication helped.');
    return;
  }

  const updated = PainData.normalise({
    ...entry,
    at: date.toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt,
    ongoing: endState === 'ongoing',
    symptoms,
    characteristics: readCharacteristics(card),
    relief,
    medications,
    impact: readImpact(card),
    ...readTriggerChoices(card),
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
  const entry = PainData.normalise({
    id: PainData.uid(), at: now.toISOString(), updatedAt: now.toISOString(), endedAt: null, ongoing: true,
    symptoms: [], characteristics: [], relief: [], impact: null, triggers: [], notes: '',
  });
  if (!persistEntries([entry, ...entries])) return;
  freshEntryIds.add(entry.id);
  openOnRender = entry.id;
  visibleCount = Math.max(visibleCount, 1);
  render();
  requestAnimationFrame(() => list.querySelector(`[data-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function repeatEntry(card) {
  const source = entries.find(item => item.id === card.dataset.id);
  if (!source) return;
  const now = new Date();
  const repeated = PainData.normalise({
    id: PainData.uid(),
    at: now.toISOString(),
    updatedAt: now.toISOString(),
    endedAt: null,
    ongoing: true,
    symptoms: source.symptoms.map(item => ({ ...item })),
    characteristics: [...source.characteristics],
    relief: [],
    impact: null,
    triggers: [...source.triggers],
    knownCauses: [...source.knownCauses],
    notes: '',
  });
  if (!persistEntries([repeated, ...entries])) return;
  freshEntryIds.add(repeated.id);
  highlightOnRender = repeated.id;
  visibleCount = Math.max(visibleCount, 1);
  markChanged();
  render();
  requestAnimationFrame(() => list.querySelector(`[data-id="${CSS.escape(repeated.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  toast('Copied to a new entry at the current time');
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

function monthlyCounts(rows, months = 6) {
  const now = new Date();
  const first = rows.length ? new Date(Math.min(...rows.map(entry => Date.parse(entry.at)))) : now;
  const firstMonth = new Date(first.getFullYear(), first.getMonth(), 1);
  const result = [];
  for (let offset = months - 1; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const count = rows.filter(entry => {
      const entryDate = new Date(entry.at);
      return entryDate.getFullYear() === date.getFullYear() && entryDate.getMonth() === date.getMonth();
    }).length;
    result.push({
      label: `${monthFmt.format(date)}${offset === 0 ? ' (so far)' : ''}`,
      count,
      before: date < firstMonth,
    });
  }
  return result;
}

function appendCountBlock(stats, title, names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  if (!counts.size) return;
  const block = statBlock(title);
  const peak = Math.max(...counts.values());
  [...counts].sort((a, b) => b[1] - a[1]).forEach(([name, count]) => block.append(statRow(name, count, count / peak)));
  stats.append(block);
}

function appendHelpBlock(stats, title, ratings) {
  const counts = new Map();
  for (const [name, effectiveness] of ratings) {
    const key = name.toLocaleLowerCase();
    const current = counts.get(key) || { name, count: 0, score: 0 };
    current.count++;
    current.score += PainData.reliefLevels.indexOf(effectiveness);
    counts.set(key, current);
  }
  if (!counts.size) return;
  const block = statBlock(title);
  [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .forEach(({ name, count, score }) => {
      const average = score / count;
      const description = average >= 1.5 ? 'Strong' : average >= 0.5 ? 'Some' : 'None';
      block.append(statRow(name, `${description} · ${count}×`, average / 2));
    });
  stats.append(block);
}

function renderStats() {
  const stats = $('stats');
  const rows = entries.filter(entry => Date.parse(entry.at) <= Date.now());
  stats.replaceChildren();
  $('statsStatus').textContent = rows.length ? ` · ${rows.length} total` : '';
  if (!rows.length) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = entries.length ? 'Nothing to summarise yet because every entry is in the future.' : 'Statistics will appear after you save an entry.';
    stats.append(note);
    return;
  }

  const facts = statBlock('Overview');
  const values = rows.flatMap(entry => entry.symptoms.map(symptom => symptom.intensity));
  const completedMinutes = rows.filter(entry => entry.endedAt).map(entry => Math.max(0, (Date.parse(entry.endedAt) - Date.parse(entry.at)) / 60000));
  const dl = document.createElement('dl');
  dl.className = 'stat-facts';
  const pairs = [
    ['Entries', rows.length],
    ['Ongoing', rows.filter(entry => entry.ongoing).length],
    ['Symptoms rated', values.length],
    ['Average intensity', values.length ? `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)} / 10` : '—'],
    ['Average duration', completedMinutes.length
      ? durationText('1970-01-01T00:00:00.000Z', new Date(completedMinutes.reduce((sum, value) => sum + value, 0) / completedMinutes.length * 60000).toISOString()) : '—'],
  ];
  for (const [term, detail] of pairs) {
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = detail;
    dl.append(dt, dd);
  }
  facts.append(dl);
  stats.append(facts);

  const months = monthlyCounts(rows);
  const monthPeak = Math.max(...months.map(month => month.count), 1);
  const monthBlock = statBlock('Last six months');
  for (const month of months) {
    const row = statRow(month.label, month.before ? '—' : String(month.count), month.before ? 0 : month.count / monthPeak);
    if (month.before) {
      row.classList.add('before-records');
      row.setAttribute('aria-label', `${month.label}: before first record`);
    }
    monthBlock.append(row);
  }
  const monthNote = document.createElement('p');
  monthNote.className = 'note';
  monthNote.textContent = '— means before your first record. Counts describe logged entries; an empty month does not establish that no pain occurred.';
  monthBlock.append(monthNote);
  stats.append(monthBlock);

  const symptoms = new Map();
  for (const entry of rows) for (const symptom of entry.symptoms) {
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

  const characteristicCounts = new Map();
  for (const entry of rows) for (const characteristic of entry.characteristics) {
    characteristicCounts.set(characteristic, (characteristicCounts.get(characteristic) || 0) + 1);
  }
  if (characteristicCounts.size) {
    const characteristicBlock = statBlock('Pain characteristics');
    const peak = Math.max(...characteristicCounts.values());
    [...characteristicCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([name, count]) => characteristicBlock.append(statRow(name, count, count / peak)));
    stats.append(characteristicBlock);
  }

  const impactCounts = new Map();
  for (const entry of rows) if (entry.impact != null) {
    const label = IMPACT_LABELS[entry.impact];
    impactCounts.set(label, (impactCounts.get(label) || 0) + 1);
  }
  if (impactCounts.size) {
    const impactBlock = statBlock('Activity impact');
    const peak = Math.max(...impactCounts.values());
    for (const label of IMPACT_LABELS) {
      const count = impactCounts.get(label) || 0;
      if (count) impactBlock.append(statRow(label, count, count / peak));
    }
    stats.append(impactBlock);
  }

  appendHelpBlock(stats, 'Medication · average help',
    rows.flatMap(entry => entry.medications.map(item => [item.name || PainData.unknownMedicationName, item.effectiveness])));
  appendHelpBlock(stats, 'Relief attempts · average help',
    rows.flatMap(entry => entry.relief.map(item => [item.name, item.effectiveness])));

  appendCountBlock(stats, 'Known causes', rows.flatMap(entry => entry.knownCauses));
  appendCountBlock(stats, 'Possible triggers', rows.flatMap(entry => entry.triggers));
}

function selectedReportEntries() {
  const period = $('reportPeriod').value;
  const now = Date.now();
  return entries.filter(entry => {
    const time = Date.parse(entry.at);
    if (time > now) return false;
    if (period === 'all') return true;
    if (period === '90') return time >= now - 90 * 24 * 60 * 60 * 1000;
    const month = $('reportMonth').value;
    return /^\d{4}-\d{2}$/.test(month) && PainData.toInput(new Date(entry.at)).slice(0, 7) === month;
  });
}

function reportPeriodLabel() {
  if ($('reportPeriod').value === 'all') return 'All entries';
  if ($('reportPeriod').value === '90') return 'Last 90 days';
  const value = $('reportMonth').value;
  if (!/^\d{4}-\d{2}$/.test(value)) return 'Selected month';
  const [year, month] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function entryDetailLines(entry) {
  return [
    entry.ongoing ? 'Status: ongoing'
      : entry.endedAt ? `Status: ended · Duration: ${durationText(entry.at, entry.endedAt)} · ended ${describe(new Date(entry.endedAt))}`
        : 'Status: ended, time unknown',
    entry.symptoms.length ? `Symptoms: ${entry.symptoms.map(item => `${item.name} ${item.intensity}/10`).join(', ')}` : 'Symptoms: none recorded',
    entry.characteristics.length ? `Characteristics: ${entry.characteristics.join(', ')}` : '',
    entry.impact == null ? '' : `Activity impact: ${IMPACT_LABELS[entry.impact]}`,
    entry.medications.length ? `Medication: ${entry.medications.map(item => `${medicationLabel(item)} (${item.effectiveness.toLowerCase()})`).join(', ')}` : '',
    entry.relief.length ? `Relief: ${entry.relief.map(item => `${item.name} (${item.effectiveness.toLowerCase()})`).join(', ')}` : '',
    entry.knownCauses.length ? `Known causes: ${entry.knownCauses.join(', ')}` : '',
    entry.triggers.length ? `Possible triggers: ${entry.triggers.join(', ')}` : '',
    entry.notes ? `Notes: ${entry.notes}` : '',
  ].filter(Boolean);
}

function preparePrintReport() {
  const rows = selectedReportEntries();
  const error = $('reportError');
  if ($('reportPeriod').value === 'month' && !$('reportMonth').value) {
    error.textContent = 'Choose a month first.';
    error.hidden = false;
    return;
  }
  if (!rows.length) {
    error.textContent = 'There are no entries in that period.';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  const summary = $('printSummary');
  summary.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = 'Pain Tracker summary';
  const period = document.createElement('p');
  period.textContent = `${reportPeriodLabel()} · ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;
  const created = document.createElement('p');
  created.textContent = `Prepared ${dateFmtYear.format(new Date())}`;
  summary.append(heading, period, created);
  for (const entry of rows) {
    const section = document.createElement('section');
    section.className = 'print-entry';
    const title = document.createElement('h2');
    title.textContent = describe(new Date(entry.at));
    section.append(title);
    for (const line of entryDetailLines(entry)) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      section.append(paragraph);
    }
    summary.append(section);
  }
  window.print();
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function exportCsvReport() {
  const rows = selectedReportEntries();
  const error = $('reportError');
  if ($('reportPeriod').value === 'month' && !$('reportMonth').value) {
    error.textContent = 'Choose a month first.';
    error.hidden = false;
    return;
  }
  if (!rows.length) {
    error.textContent = 'There are no entries in that period.';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  const header = ['Start', 'End', 'Duration', 'Status', 'Symptoms', 'Pain characteristics', 'Activity impact', 'Medication', 'Relief attempts', 'Known causes', 'Possible triggers', 'Notes'];
  const records = rows.map(entry => [
    entry.at,
    entry.endedAt || '',
    entry.endedAt ? durationText(entry.at, entry.endedAt) : '',
    entry.ongoing ? 'Ongoing' : entry.endedAt ? 'Ended' : 'Ended, time unknown',
    entry.symptoms.map(item => `${item.name} ${item.intensity}/10`).join('; '),
    entry.characteristics.join('; '),
    entry.impact == null ? '' : IMPACT_LABELS[entry.impact],
    entry.medications.map(item => `${medicationLabel(item)} (${item.effectiveness})`).join('; '),
    entry.relief.map(item => `${item.name} (${item.effectiveness})`).join('; '),
    entry.knownCauses.join('; '),
    entry.triggers.join('; '),
    entry.notes,
  ]);
  const csv = '\uFEFF' + [header, ...records].map(record => record.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pain-tracker-report-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('CSV download started');
}

function activeReminderEntry() {
  return entries.find(entry => entry.ongoing && Date.parse(entry.at) <= Date.now()) || null;
}

function renderReminderStatus() {
  const minutes = state.preferences.reminderMinutes;
  const entry = activeReminderEntry();
  $('reminderMinutes').value = String(minutes);
  $('reminderStatus').textContent = minutes
    ? ` · ${minutes < 60 ? `${minutes} min` : `${minutes / 60} hr`}${entry ? ' · ongoing entry' : ''}` : ' · off';
}

function notifyReminder(entry) {
  if (remindedThisSession.has(entry.id)) return;
  remindedThisSession.add(entry.id);
  toast('Remember to update your ongoing entry');
  if ('Notification' in window && Notification.permission === 'granted') {
    const options = { body: 'Remember to update your ongoing entry.', tag: `pain-entry-${entry.id}`, renotify: false };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(registration => registration.showNotification('Pain Tracker', options))
        .catch(error => console.warn('Notification unavailable', error));
    } else new Notification('Pain Tracker', options);
  }
}

function scheduleReminder() {
  clearTimeout(reminderTimer);
  const minutes = state.preferences.reminderMinutes;
  const entry = activeReminderEntry();
  if (!minutes || !entry || remindedThisSession.has(entry.id)) return;
  const delay = Date.parse(entry.at) + minutes * 60000 - Date.now();
  reminderTimer = setTimeout(() => notifyReminder(entry), Math.max(0, Math.min(delay, 2147483647)));
}

function renderBackupStatus() {
  const meta = readJSON(META_KEY, { pending: 0, lastExportAt: null });
  const count = Math.max(0, Number(meta.pending) || 0);
  const status = $('backupStatus');
  const hasAnythingToBackUp = count > 0 || entries.length > 0
    || state.customSymptoms.length > 0 || state.customCharacteristics.length > 0
    || state.customRelief.length > 0 || state.customTriggers.length > 0;
  if (!meta.lastExportAt) {
    status.textContent = hasAnythingToBackUp ? ' · Not backed up yet' : '';
    status.classList.toggle('stale', hasAnythingToBackUp);
    return;
  }
  status.textContent = count ? ` · ${count} ${count === 1 ? 'change' : 'changes'} since backup` : '';
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
  const medAction = event.target.closest('[data-med-action]')?.dataset.medAction;
  if (medAction === 'add') {
    const row = makeMedicationRow();
    event.target.closest('[data-medication-panel]').querySelector('.medication-list').append(row);
    row.querySelector('input').focus();
    return;
  }
  if (medAction === 'remove') { removeMedication(card, event.target.closest('[data-medication]')); return; }
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'toggle') { setOpen(card, card.querySelector('.entry-body').hidden); return; }
  if (action === 'repeat') { repeatEntry(card); return; }
  if (action === 'end-now') { endNow(card); return; }
  if (action === 'save') { saveEntry(card); return; }
  if (action === 'cancel') { cancelEntry(card); return; }
  if (action === 'delete') { deleteEntry(card); return; }
  if (event.target.closest('[data-chips]')) handleChipClick(event, card);
  else if (event.target.closest('[data-rating]')) handleRatingClick(event, card);
  else if (event.target.closest('button[data-effectiveness]')) handleEffectivenessClick(event, card);
  else if (event.target.closest('button[data-certainty]')) handleCertaintyClick(event, card);
});

list.addEventListener('change', event => {
  if (!event.target.matches('[data-field="endState"]')) return;
  const card = event.target.closest('.entry');
  updateEndRow(card);
  showCardError(card, '');
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
  if (!PainData.themes.includes(theme) || !persistState({ ...state, preferences: { ...state.preferences, theme } })) return;
  applyTheme();
  markChanged();
  renderBackupStatus();
});
$('reportPeriod').addEventListener('change', () => {
  $('reportMonthRow').hidden = $('reportPeriod').value !== 'month';
  $('reportError').hidden = true;
});
$('printReport').addEventListener('click', preparePrintReport);
$('csvReport').addEventListener('click', exportCsvReport);
$('reminderMinutes').addEventListener('change', async () => {
  const minutes = Number($('reminderMinutes').value);
  if (!PainData.reminderMinutes.includes(minutes)) return;
  if (minutes && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); }
    catch (error) { console.warn('Notification permission unavailable', error); }
  }
  if (!persistState({ ...state, preferences: { ...state.preferences, reminderMinutes: minutes } })) return;
  remindedThisSession.clear();
  markChanged();
  renderReminderStatus();
  renderBackupStatus();
  scheduleReminder();
  toast(minutes ? 'Reminder preference saved' : 'Reminders turned off');
});

window.addEventListener('storage', event => {
  if (event.key === KEY) showError('Your log changed in another tab. Reload before making more changes.');
});

applyTheme();
$('reportMonth').value = PainData.toInput(new Date()).slice(0, 7);
render();

window.PainTrackerAppSync = {
  getState: () => JSON.parse(JSON.stringify(state)),
  applyState(value) {
    try {
      const parsed = PainData.parse(value, true);
      if (!persistState(parsed, false, true)) return false;
      applyTheme();
      render();
      return true;
    } catch (error) {
      console.error('Cloud state could not be applied', error);
      return false;
    }
  },
};

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(error => console.warn('Offline mode unavailable', error)));
}
