(function () {
'use strict';

const STORE_KEY = 'flashcards.v1';
const DEFAULTS = { newPerDay: 20, reviewsPerDay: 200 };
const NO_HTTP_MSG = 'Could not load the provided decks. This app must be served over http(s) (for example run "python -m http.server 8000" in this folder and open http://localhost:8000); opening index.html directly via file:// does not work.';
const fsrs = FSRS.fsrs(FSRS.generatorParameters());
const { Rating, State } = FSRS;

// ---------- storage ----------
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.decks) return migrate(s);
  } catch (e) { /* ignore corrupt data */ }
  return { decks: {}, theme: null, studied: null };
}
// Cards without an `included` flag count as included only if they already have a schedule (so existing progress stays visible).
function migrate(s) {
  for (const d of Object.values(s.decks)) {
    if (!d || !Array.isArray(d.cards)) continue;
    if (!d.sched || typeof d.sched !== 'object') d.sched = {};
    for (const c of d.cards) {
      if (typeof c.included !== 'boolean') c.included = !!d.sched[c.id + '|f'];
    }
  }
  return s;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { alert('Could not save to browser storage: ' + e.message); }
}

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function deckById(id) { return Object.hasOwn(state.decks, id) ? state.decks[id] : null; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function cardId(front, back) {
  let x = 5381;
  const s = front + '\u0001' + back;
  for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}
function localDay(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function nextMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}
function fmtInterval(due, now) {
  const m = Math.max(1, Math.round((due - now) / 60000));
  if (m < 60) return m + 'm';
  const hr = Math.round(m / 60);
  if (hr < 24) return hr + 'h';
  const d = Math.round(hr / 24);
  if (d < 30) return d + 'd';
  if (d < 365) return Math.round(d / 30) + 'mo';
  return (d / 365).toFixed(1) + 'y';
}

// ---------- theme ----------
function applyTheme() {
  const t = state.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
}
document.getElementById('theme').addEventListener('click', () => {
  state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  save(); applyTheme();
});
applyTheme();

// ---------- parsing ----------
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// rows: array of arrays, first row is the header
function rowsToCards(rows) {
  rows = rows.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (rows.length < 2) throw new Error('File needs a header row and at least one data row.');
  const header = rows[0].map(c => String(c ?? '').trim().toLowerCase());
  if (header.length < 2) throw new Error('File needs at least two columns (front, back).');
  let fi = header.indexOf('front'), bi = header.indexOf('back');
  if (fi < 0 || bi < 0 || fi === bi) { fi = 0; bi = 1; }
  const seen = new Set(), cards = [];
  for (const r of rows.slice(1)) {
    const front = String(r[fi] ?? '').trim(), back = String(r[bi] ?? '').trim();
    if (!front || !back) continue;
    const id = cardId(front, back);
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({ id, front, back, included: false });
  }
  if (!cards.length) throw new Error('No cards with both a front and a back were found.');
  return cards;
}

function stripHtml(s) {
  s = s.replace(/\[sound:[^\]]*\]/g, '').replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(s, 'text/html');
  doc.querySelectorAll('style,script').forEach(n => n.remove());
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

async function parseAPKG(buf) {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('collection.anki21') || zip.file('collection.anki2');
  if (!entry) {
    throw new Error('This .apkg uses the newer Anki format that is not supported. In Anki, export again with "Support older Anki versions" ticked.');
  }
  const SQL = await initSqlJs({ locateFile: f => 'libs/' + f });
  const db = new SQL.Database(new Uint8Array(await entry.async('uint8array')));
  const res = db.exec('select flds from notes');
  db.close();
  const rows = [['front', 'back']];
  if (res.length) {
    for (const [flds] of res[0].values) {
      const parts = String(flds).split('\x1f');
      if (parts.length >= 2) rows.push([stripHtml(parts[0]), stripHtml(parts[1])]);
    }
  }
  return rowsToCards(rows);
}

async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'apkg') return parseAPKG(await file.arrayBuffer());
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return rowsToCards(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }));
  }
  if (['csv', 'tsv', 'txt'].includes(ext)) return rowsToCards(parseCSV(await file.text()));
  throw new Error('Unsupported file type: .' + ext);
}

// ---------- scheduling ----------
// Only the front->back schedule (`cardId|f`) is used. Legacy `cardId|r` entries are ignored but never deleted.
function schedKey(cid) { return cid + '|f'; }
function reviveCard(o) {
  return Object.assign({}, o, { due: new Date(o.due), last_review: o.last_review ? new Date(o.last_review) : undefined });
}
function getFsrsCard(deck, key) {
  return deck.sched[key] ? reviveCard(deck.sched[key]) : FSRS.createEmptyCard(new Date());
}
function dailyCounts(deck, now) {
  const day = localDay(now);
  if (!deck.daily || deck.daily.date !== day) deck.daily = { date: day, newDone: 0, reviewsDone: 0 };
  return deck.daily;
}
function allItems(deck) {
  return deck.cards.filter(card => card.included !== false).map(card => ({ card, key: schedKey(card.id) }));
}
function counts(deck, now) {
  const daily = dailyCounts(deck, now);
  const end = nextMidnight(now);
  let nw = 0, learn = 0, rev = 0;
  for (const it of allItems(deck)) {
    const s = deck.sched[it.key];
    if (!s) nw++;
    else if (s.state === State.Review) { if (new Date(s.due) < end) rev++; }
    else if (new Date(s.due) <= now) learn++;
  }
  return {
    newLeft: Math.min(nw, Math.max(0, deck.settings.newPerDay - daily.newDone)),
    reviewLeft: Math.min(rev, Math.max(0, deck.settings.reviewsPerDay - daily.reviewsDone)),
    learn, totalNew: nw
  };
}
function pickNext(deck, now) {
  const daily = dailyCounts(deck, now);
  const end = nextMidnight(now);
  const learn = [], rev = [], nw = [];
  let nextLearn = null;
  for (const it of allItems(deck)) {
    const s = deck.sched[it.key];
    if (!s) { nw.push(it); continue; }
    const due = new Date(s.due);
    if (s.state === State.Review) { if (due < end) rev.push({ it, due }); }
    else if (due <= now) learn.push({ it, due });
    else if (!nextLearn || due < nextLearn) nextLearn = due;
  }
  const byDue = (a, b) => a.due - b.due;
  if (learn.length) return { item: learn.sort(byDue)[0].it };
  if (rev.length && daily.reviewsDone < deck.settings.reviewsPerDay) return { item: rev.sort(byDue)[0].it };
  if (nw.length && daily.newDone < deck.settings.newPerDay) return { item: nw[0] };
  return { item: null, nextLearn };
}
function studiedToday(now) {
  const day = localDay(now);
  if (!state.studied || state.studied.date !== day) state.studied = { date: day, count: 0, ms: 0 };
  return state.studied;
}

// ---------- export / backup ----------
function download(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function safeName(n) { return n.replace(/[^\w\-]+/g, '_') || 'deck'; }
function exportDeck(deck) {
  const schedule = {};
  for (const c of deck.cards) if (deck.sched[schedKey(c.id)]) schedule[schedKey(c.id)] = deck.sched[schedKey(c.id)];
  download({
    format: 'flash-cards-deck', version: 2, exportedAt: new Date().toISOString(),
    deck: { id: deck.id, name: deck.name, settings: deck.settings, cards: deck.cards },
    schedule, daily: deck.daily || null
  }, safeName(deck.name) + '.json');
}

// ---------- provided decks ----------
async function fetchProvided(path, asJson) {
  let r;
  try { r = await fetch(path); }
  catch (e) { throw new Error(NO_HTTP_MSG); }
  if (!r.ok) throw new Error('Could not load ' + path + ' (HTTP ' + r.status + ').');
  try { return asJson ? await r.json() : await r.text(); }
  catch (e) { throw new Error('Could not read ' + path + '.'); }
}
const loadProvidedList = () => fetchProvided('decks/index.json', true);
async function loadProvidedCards(d) {
  return rowsToCards(parseCSV(await fetchProvided('decks/' + encodeURIComponent(d.file), false)));
}
// Renders the provided decks into `box`; onPick(deckEntry) is called when one is chosen.
async function renderProvided(box, msg, onPick) {
  box.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let list;
  try { list = await loadProvidedList(); }
  catch (e) { box.replaceChildren(); msg.textContent = e.message; return; }
  if (!Array.isArray(list) || !list.length) { box.replaceChildren(h('p', { class: 'muted' }, 'No provided decks.')); return; }
  box.replaceChildren(...list.map(d => {
    const info = h('div', { class: 'muted' }, d.description || '');
    loadProvidedCards(d).then(c => { info.textContent = c.length + ' cards' + (d.description ? ' · ' + d.description : ''); }, () => {});
    return h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('strong', {}, d.name), info),
      h('button', { class: 'primary', onclick: () => onPick(d) }, 'Select'));
  }));
}
async function pickProvided(d, msg, name) {
  msg.textContent = 'Loading…';
  try {
    pending = { cards: await loadProvidedCards(d), deckId: null, name: name || d.name };
    go('#/select');
  } catch (e) { msg.textContent = e.message; }
}

// ---------- views ----------
const app = document.getElementById('app');
let pending = null;
let session = null;
let browseFilter = { deck: '', inc: 'all', q: '' };
let closeMenu = null;

function show(...nodes) {
  if (closeMenu) closeMenu();
  app.replaceChildren(...nodes.flat().filter(n => n));
  const active = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'decks';
  const section = { add: 'add', browse: 'browse', stats: 'stats', sync: 'sync' }[active] || (active === 'deck' || active === 'decks' ? 'decks' : '');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === section));
}
function go(hash) { location.hash = hash; }
function newDeck(name) {
  const deck = { id: uid(), name: name || 'New deck', cards: [], sched: {}, settings: Object.assign({}, DEFAULTS), daily: null };
  state.decks[deck.id] = deck;
  return deck;
}

function viewLibrary() {
  const now = new Date();
  const decks = Object.values(state.decks);
  const num = (n, cls) => h('td', { class: 'num ' + (n > 0 ? cls : 'zero') }, n);
  const rows = decks.map(d => {
    const c = counts(d, now);
    const gear = h('button', { class: 'gear', 'aria-label': 'Options for ' + d.name, onclick: e => { e.stopPropagation(); openMenu(gear, d); } }, '⚙');
    return h('tr', { class: 'deckrow', tabindex: 0, onclick: () => go('#/deck/' + d.id + '/study'),
      onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) go('#/deck/' + d.id + '/study'); } },
      h('td', { class: 'name' }, d.name), num(c.newLeft, 'new'), num(c.learn, 'learn'), num(c.reviewLeft, 'due'),
      h('td', { class: 'gearcell' }, gear));
  });
  const st = studiedToday(now);
  const secs = Math.round(st.ms / 1000);
  show(
    h('div', { class: 'panel' },
      h('table', { class: 'decks' },
        h('thead', {}, h('tr', {}, h('th', { class: 'name' }, 'Deck'), h('th', {}, 'New'), h('th', {}, 'Learn'), h('th', {}, 'Due'), h('th', { class: 'gearcell' }))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No decks yet. Use Get Shared to pick a provided deck.'))))),
    h('p', { class: 'center muted' }, 'Studied ' + st.count + ' card' + (st.count === 1 ? '' : 's') + ' in ' + secs + ' second' + (secs === 1 ? '' : 's') +
      ' today (' + (st.count ? (st.ms / 1000 / st.count).toFixed(1) : '0') + 's/card)'),
    h('div', { class: 'pills' },
      h('button', { class: 'pill', onclick: () => go('#/shared') }, 'Get Shared'),
      h('button', { class: 'pill', onclick: () => go('#/new') }, 'Create Deck'),
      h('button', { class: 'pill', onclick: () => go('#/import') }, 'Import File'))
  );
}

function openMenu(anchor, deck) {
  if (closeMenu) closeMenu();
  const item = (label, fn, cls) => h('button', { class: cls || '', onclick: e => { e.stopPropagation(); closeMenu(); fn(); } }, label);
  const menu = h('div', { class: 'menu' },
    item('Rename', () => {
      const n = prompt('Rename deck', deck.name);
      if (n && n.trim()) { deck.name = n.trim(); save(); viewLibrary(); }
    }),
    item('Options', () => go('#/deck/' + deck.id + '/settings')),
    item('Export', () => exportDeck(deck)),
    item('Delete', () => {
      if (confirm('Delete "' + deck.name + '" and all its progress?')) { delete state.decks[deck.id]; save(); viewLibrary(); }
    }, 'danger'));
  const cell = anchor.parentNode;
  cell.append(menu);
  const onDoc = e => { if (!menu.contains(e.target)) closeMenu(); };
  closeMenu = () => { menu.remove(); document.removeEventListener('click', onDoc, true); closeMenu = null; };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
}

function viewShared() {
  const msg = h('p', { class: 'err' });
  const box = h('div');
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Get Shared'),
    h('p', { class: 'muted' }, 'Pick a provided deck, choose which cards to keep, and add it to your decks. No upload needed.'),
    box, msg,
    h('div', { class: 'row' }, h('button', { onclick: () => go('#/') }, 'Back'))));
  renderProvided(box, msg, d => pickProvided(d, msg));
}

function viewCreate() {
  const msg = h('p', { class: 'err' });
  const name = h('input', { type: 'text', placeholder: 'Deck name' });
  const box = h('div');
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Create Deck'),
    h('label', {}, 'Deck name'), name,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => {
      const d = newDeck(name.value.trim()); save(); go('#/deck/' + d.id + '/settings');
    } }, 'Create empty deck')),
    h('hr'),
    h('h3', {}, 'Or start from a provided deck'), box, msg,
    h('div', { class: 'row' }, h('button', { onclick: () => go('#/') }, 'Back'))));
  renderProvided(box, msg, d => pickProvided(d, msg, name.value.trim()));
}

function viewImport(deckId) {
  const existing = deckId ? state.decks[deckId] : null;
  const msg = h('p', { class: 'err' });
  const name = h('input', { type: 'text', placeholder: 'Deck name', value: existing ? existing.name : '' });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xls,.apkg' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    msg.textContent = 'Reading…';
    try {
      const cards = await parseFile(file.files[0]);
      pending = { cards, deckId: existing ? existing.id : null, name: name.value.trim() || file.files[0].name.replace(/\.[^.]+$/, '') || 'New deck' };
      go('#/select');
    } catch (e) { msg.textContent = e.message; }
  });
  show(h('div', { class: 'panel' },
    h('h2', {}, existing ? 'Import cards into ' + existing.name : 'Import File'),
    existing ? null : [h('label', {}, 'Deck name'), name],
    h('p', { class: 'muted' }, 'CSV, Excel (.xlsx/.xls) with a header row (columns "front" and "back", or the first two columns), or an Anki .apkg (text of the first two fields only).'),
    file, msg,
    h('div', { class: 'row' }, h('button', { onclick: () => go(existing ? '#/deck/' + existing.id + '/settings' : '#/') }, 'Cancel'))));
}

function viewSelect() {
  if (!pending) return go('#/');
  const p = pending;
  const existingIds = new Set(p.deckId ? state.decks[p.deckId].cards.map(c => c.id) : []);
  const checked = new Set(p.cards.filter(c => !existingIds.has(c.id)).map(c => c.id));
  const countEl = h('span', { class: 'muted' });
  const listEl = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search…' });
  const boxes = new Map();
  const update = () => { countEl.textContent = checked.size + ' of ' + p.cards.length + ' selected'; };
  for (const c of p.cards) {
    const dup = existingIds.has(c.id);
    const cb = h('input', { type: 'checkbox', disabled: dup });
    cb.checked = checked.has(c.id);
    cb.addEventListener('change', () => { cb.checked ? checked.add(c.id) : checked.delete(c.id); update(); });
    boxes.set(c.id, cb);
    c.el = h('div', { class: 'item' }, h('label', { class: 'pick' }, cb,
      h('span', { class: 'grow' }, h('strong', {}, c.front), h('div', { class: 'muted' }, c.back + (dup ? ' (already in deck)' : '')))));
    listEl.append(c.el);
  }
  const visible = () => p.cards.filter(c => c.el.style.display !== 'none' && !existingIds.has(c.id));
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    for (const c of p.cards) c.el.style.display = (c.front + ' ' + c.back).toLowerCase().includes(q) ? '' : 'none';
  });
  const setAll = on => { for (const c of visible()) { on ? checked.add(c.id) : checked.delete(c.id); boxes.get(c.id).checked = on; } update(); };
  const nameInput = h('input', { type: 'text', value: p.name });
  update();
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Choose cards'),
    p.deckId ? h('p', {}, 'Adding to: ', h('strong', {}, state.decks[p.deckId].name)) : [h('label', {}, 'Deck name'), nameInput],
    h('div', { class: 'row' },
      h('button', { onclick: () => setAll(true) }, 'Select all'),
      h('button', { onclick: () => setAll(false) }, 'Select none'), countEl),
    search, listEl,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        const chosen = p.cards.filter(c => checked.has(c.id)).map(c => ({ id: c.id, front: c.front, back: c.back, included: false }));
        if (!chosen.length) return alert('Select at least one card.');
        const deck = (p.deckId && state.decks[p.deckId]) || newDeck(nameInput.value.trim());
        deck.cards.push(...chosen);
        save(); pending = null; go('#/');
      } }, 'Add to deck'),
      h('button', { onclick: () => { pending = null; go(p.deckId ? '#/deck/' + p.deckId + '/settings' : '#/'); } }, 'Cancel'))));
}

function deckSelect(selected) {
  const sel = h('select', {}, Object.values(state.decks).map(d => h('option', { value: d.id }, d.name)));
  if (selected && state.decks[selected]) sel.value = selected;
  return sel;
}

function viewAdd() {
  const decks = Object.values(state.decks);
  if (!decks.length) {
    return show(h('div', { class: 'panel' }, h('h2', {}, 'Add'), h('p', {}, 'Create a deck first.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => go('#/new') }, 'Create Deck'))));
  }
  const sel = deckSelect(state.lastAddDeck);
  const front = h('textarea', { rows: 3 }), back = h('textarea', { rows: 3 });
  const msg = h('p', { class: 'muted' });
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Add'),
    h('label', {}, 'Deck'), sel,
    h('label', {}, 'Front'), front,
    h('label', {}, 'Back'), back,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => {
      const f = front.value.trim(), b = back.value.trim();
      if (!f || !b) { msg.textContent = 'Enter both a front and a back.'; return; }
      const deck = deckById(sel.value);
      const id = cardId(f, b);
      if (deck.cards.some(c => c.id === id)) { msg.textContent = 'That card is already in the deck.'; return; }
      deck.cards.push({ id, front: f, back: b, included: false });
      state.lastAddDeck = deck.id;
      save();
      front.value = ''; back.value = ''; front.focus();
      msg.textContent = 'Added to ' + deck.name + '.';
    } }, 'Add card')),
    msg));
}

function viewBrowse(deckId) {
  if (deckId !== undefined) browseFilter = { deck: deckId && deckById(deckId) ? deckId : '', inc: 'all', q: '' };
  const f = browseFilter;
  const search = h('input', { type: 'search', placeholder: 'Search all cards…', value: f.q });
  const deckSel = h('select', {}, h('option', { value: '' }, 'All decks'), Object.values(state.decks).map(d => h('option', { value: d.id }, d.name)));
  deckSel.value = f.deck;
  const incSel = h('select', {}, h('option', { value: 'all' }, 'All'), h('option', { value: 'yes' }, 'Included'), h('option', { value: 'no' }, 'Not included'));
  incSel.value = f.inc;
  const countEl = h('p', { class: 'muted' });
  const list = h('div');
  let rows = [];
  const updateCount = () => {
    const n = rows.filter(r => r.c.included).length;
    countEl.textContent = n + ' of ' + rows.length + ' included' + (rows.length > 200 ? ' (showing first 200, refine your search)' : '');
  };
  const draw = () => {
    const q = f.q.toLowerCase();
    rows = [];
    for (const d of Object.values(state.decks)) {
      if (f.deck && d.id !== f.deck) continue;
      for (const c of d.cards) {
        if (f.inc === 'yes' && !c.included) continue;
        if (f.inc === 'no' && c.included) continue;
        if (!(c.front + ' ' + c.back + ' ' + d.name).toLowerCase().includes(q)) continue;
        rows.push({ d, c });
      }
    }
    updateCount();
    list.replaceChildren(...rows.slice(0, 200).map(({ d, c }) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Include' });
      cb.checked = !!c.included;
      cb.addEventListener('change', () => { c.included = cb.checked; save(); updateCount(); });
      return h('div', { class: 'item' },
        h('label', { class: 'incl' }, cb, h('span', { class: 'muted' }, 'Include')),
        h('div', { class: 'grow' }, h('strong', {}, c.front), h('div', {}, c.back), h('div', { class: 'muted' }, d.name)),
        h('button', { onclick: () => edit(d, c) }, 'Edit'),
        h('button', { class: 'danger', onclick: () => {
          if (!confirm('Delete this card?')) return;
          d.cards = d.cards.filter(x => x !== c);
          delete d.sched[schedKey(c.id)]; delete d.sched[c.id + '|r'];
          save(); draw();
        } }, 'Delete'));
    }));
  };
  const setAll = on => { for (const r of rows) r.c.included = on; save(); draw(); };
  const edit = (d, c) => {
    const fr = h('textarea', { rows: 2 }), b = h('textarea', { rows: 2 });
    fr.value = c.front; b.value = c.back;
    show(h('div', { class: 'panel' }, h('h2', {}, 'Edit card'),
      h('label', {}, 'Front'), fr, h('label', {}, 'Back'), b,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => {
          if (!fr.value.trim() || !b.value.trim()) return alert('Front and back are required.');
          c.front = fr.value.trim(); c.back = b.value.trim(); save(); viewBrowse();
        } }, 'Save'),
        h('button', { onclick: () => viewBrowse() }, 'Cancel'))));
  };
  search.addEventListener('input', () => { f.q = search.value; draw(); });
  deckSel.addEventListener('change', () => { f.deck = deckSel.value; draw(); });
  incSel.addEventListener('change', () => { f.inc = incSel.value; draw(); });
  draw();
  show(h('div', { class: 'panel' }, h('h2', {}, 'Browse'), search,
    h('div', { class: 'row' }, deckSel, incSel),
    h('div', { class: 'row' },
      h('button', { onclick: () => setAll(true) }, 'Include all shown'),
      h('button', { onclick: () => setAll(false) }, 'Exclude all shown')),
    countEl, list));
}

function viewStats() {
  const now = new Date();
  const st = studiedToday(now);
  const decks = Object.values(state.decks);
  const rows = decks.map(d => {
    let nw = 0, learn = 0, young = 0, mature = 0;
    for (const it of allItems(d)) {
      const s = d.sched[it.key];
      if (!s) nw++;
      else if (s.state !== State.Review) learn++;
      else if ((s.scheduled_days || 0) >= 21) mature++;
      else young++;
    }
    return h('tr', {}, h('td', { class: 'name' }, d.name), h('td', { class: 'num' }, nw + learn + young + mature), h('td', { class: 'num' }, nw),
      h('td', { class: 'num' }, learn), h('td', { class: 'num' }, young), h('td', { class: 'num' }, mature));
  });
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Stats'),
    h('p', {}, 'Today: ' + st.count + ' card' + (st.count === 1 ? '' : 's') + ' studied in ' + Math.round(st.ms / 1000) + ' seconds.'),
    h('table', { class: 'decks' },
      h('thead', {}, h('tr', {}, h('th', { class: 'name' }, 'Deck'), h('th', {}, 'Included'), h('th', {}, 'New'), h('th', {}, 'Learning'), h('th', {}, 'Young'), h('th', {}, 'Mature'))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No decks yet.')))),
    h('p', { class: 'muted' }, 'Young = review interval under 21 days; Mature = 21 days or more.')));
}

function viewSync() {
  const msg = h('p', { class: 'muted' });
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      const data = JSON.parse(await file.files[0].text());
      if (!data || data.format !== 'flash-cards-backup' || !data.state || typeof data.state.decks !== 'object') throw new Error('Not a Flash Cards backup file.');
      if (!confirm('Replace all data on this device with the backup?')) return;
      state = migrate(Object.assign({ decks: {}, theme: null, studied: null }, data.state));
      save(); applyTheme(); go('#/');
    } catch (e) { msg.textContent = 'Import failed: ' + e.message; msg.className = 'err'; }
  });
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Sync'),
    h('p', { class: 'muted' }, 'There is no online sync. Your decks and progress are stored on this device only (in this browser). Use a backup to move them to another device or to keep a safe copy.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => download({ format: 'flash-cards-backup', version: 2, exportedAt: new Date().toISOString(), state }, 'flash-cards-backup.json') }, 'Export backup')),
    h('label', {}, 'Import backup (replaces current data)'), file, msg));
}

function viewStudy(deck) {
  if (!session || session.deckId !== deck.id) session = { deckId: deck.id, revealed: false, current: null };
  const now = new Date();
  if (!deck.cards.some(c => c.included !== false)) {
    session.current = null;
    return show(h('div', { class: 'panel' },
      h('h2', {}, deck.name),
      h('p', {}, deck.cards.length ? 'No included cards. Use Browse to include cards.' : 'This deck has no cards yet.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => go('#/browse/' + deck.id) }, 'Go to Browse'),
        h('button', { onclick: () => go('#/') }, 'Done'))));
  }
  const { item, nextLearn } = pickNext(deck, now);
  const done = (text) => { session.current = null; show(h('div', { class: 'panel' },
    h('h2', {}, deck.name),
    h('p', {}, text),
    h('div', { class: 'row' },
      nextLearn && h('button', { onclick: () => viewStudy(deck) }, 'Check again'),
      h('button', { class: 'primary', onclick: () => go('#/') }, 'Done')))); };
  if (!item) {
    return done(nextLearn
      ? 'Nothing due right now. Next card in ' + fmtInterval(nextLearn, now) + '.'
      : 'All done for today! 🎉');
  }
  session.current = item; session.revealed = false; session.shownAt = Date.now();
  const fsrsCard = getFsrsCard(deck, item.key);
  const reveal = () => { session.revealed = true; draw(); };
  const draw = () => {
    const rec = session.revealed ? fsrs.repeat(fsrsCard, now) : null;
    const grade = (label, g) => h('button', { class: g === Rating.Good ? 'primary' : '', onclick: () => rate(g) },
      label, h('div', { class: 'muted' }, fmtInterval(rec[g].card.due, now)));
    session.reveal = session.revealed ? null : reveal;
    session.rate = session.revealed ? rate : null;
    show(
      h('div', { class: 'cardface' }, session.revealed ? [h('div', {}, item.card.front), h('hr'), h('div', {}, item.card.back)] : item.card.front),
      session.revealed
        ? h('div', { class: 'grades' }, grade('Again', Rating.Again), grade('Hard', Rating.Hard), grade('Good', Rating.Good), grade('Easy', Rating.Easy))
        : h('div', { class: 'row center' }, h('button', { class: 'primary', onclick: reveal }, 'Show Answer')),
      h('div', { class: 'row center' }, h('button', { onclick: () => go('#/') }, 'Stop'))
    );
  };
  const rate = (g) => {
    const t = new Date();
    const daily = dailyCounts(deck, t);
    if (!deck.sched[item.key]) daily.newDone++;
    else if (deck.sched[item.key].state === State.Review) daily.reviewsDone++;
    const st = studiedToday(t);
    st.count++; st.ms += Math.min(60000, t - session.shownAt);
    deck.sched[item.key] = fsrs.next(fsrsCard, t, g).card;
    save();
    viewStudy(deck);
  };
  draw();
}

function viewSettings(deck) {
  const name = h('input', { type: 'text', value: deck.name });
  const np = h('input', { type: 'number', min: 0, value: deck.settings.newPerDay });
  const rp = h('input', { type: 'number', min: 0, value: deck.settings.reviewsPerDay });
  const num = (el, def) => { const n = parseInt(el.value, 10); return Number.isFinite(n) && n >= 0 ? n : def; };
  show(h('div', { class: 'panel' },
    h('h2', {}, 'Deck options'),
    h('label', {}, 'Name'), name,
    h('label', {}, 'New cards per day'), np,
    h('label', {}, 'Maximum reviews per day'), rp,
    h('p', { class: 'muted' }, 'The day rolls over at midnight in your device\'s local time.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        deck.name = name.value.trim() || deck.name;
        deck.settings.newPerDay = num(np, DEFAULTS.newPerDay);
        deck.settings.reviewsPerDay = num(rp, DEFAULTS.reviewsPerDay);
        save(); go('#/');
      } }, 'Save'),
      h('button', { onclick: () => exportDeck(deck) }, 'Export'),
      h('button', { onclick: () => go('#/import/' + deck.id) }, 'Import cards'),
      h('button', { onclick: () => go('#/') }, 'Back')),
    h('hr'),
    h('button', { class: 'danger', onclick: () => {
      if (confirm('Delete "' + deck.name + '" and all its progress?')) { delete state.decks[deck.id]; save(); go('#/'); }
    } }, 'Delete deck')));
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const deck = parts[0] === 'deck' && deckById(parts[1]);
  if (parts[0] === 'shared') viewShared();
  else if (parts[0] === 'new') viewCreate();
  else if (parts[0] === 'import') viewImport(parts[1] && deckById(parts[1]) ? parts[1] : null);
  else if (parts[0] === 'select') viewSelect();
  else if (parts[0] === 'add') viewAdd();
  else if (parts[0] === 'browse') viewBrowse(parts[1] || '');
  else if (parts[0] === 'stats') viewStats();
  else if (parts[0] === 'sync') viewSync();
  else if (deck && parts[2] === 'settings') viewSettings(deck);
  else if (deck) viewStudy(deck);
  else viewLibrary();
}

document.addEventListener('keydown', e => {
  if (!session || !session.current || !/\/study$|^#\/deck\/[^/]+$/.test(location.hash) || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === ' ' && session.reveal) { e.preventDefault(); session.reveal(); }
  else if (session.rate && '1234'.includes(e.key) && e.key.length === 1) {
    session.rate([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy][+e.key - 1]);
  }
});

window.addEventListener('hashchange', route);
route();
})();
