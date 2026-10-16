(function () {
'use strict';

const STORE_KEY = 'flashcards.v1';
const DEFAULTS = { newPerDay: 20, reviewsPerDay: 200 };
const DIRS = { f: 'Front → Back', r: 'Back → Front', b: 'Both directions' };
const fsrs = FSRS.fsrs(FSRS.generatorParameters());
const { Rating, State } = FSRS;

// ---------- storage ----------
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.decks) return s;
  } catch (e) { /* ignore corrupt data */ }
  return { decks: {}, theme: null };
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
    cards.push({ id, front, back });
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
function schedKey(cid, dir) { return cid + '|' + dir; }
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
function allItems(deck, dir) {
  const dirs = dir === 'b' ? ['f', 'r'] : [dir];
  const out = [];
  for (const card of deck.cards) for (const d of dirs) out.push({ card, dir: d, key: schedKey(card.id, d) });
  return out;
}
function counts(deck, dir, now) {
  const daily = dailyCounts(deck, now);
  const end = nextMidnight(now);
  let nw = 0, learn = 0, rev = 0;
  for (const it of allItems(deck, dir)) {
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
function pickNext(deck, dir, now) {
  const daily = dailyCounts(deck, now);
  const end = nextMidnight(now);
  const learn = [], rev = [], nw = [];
  let nextLearn = null;
  for (const it of allItems(deck, dir)) {
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

// ---------- export ----------
function exportDeck(deck) {
  const data = {
    format: 'flash-cards-deck', version: 1, exportedAt: new Date().toISOString(),
    deck: { id: deck.id, name: deck.name, settings: deck.settings, cards: deck.cards },
    schedule: deck.sched, daily: deck.daily || null
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: (deck.name.replace(/[^\w\-]+/g, '_') || 'deck') + '.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- views ----------
const app = document.getElementById('app');
let pending = null;
let session = null;

function show(...nodes) { app.replaceChildren(...nodes.flat().filter(n => n)); }
function go(hash) { location.hash = hash; }

function viewLibrary() {
  const decks = Object.values(state.decks);
  show(
    h('h2', {}, 'Your decks'),
    decks.length ? decks.map(d => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('strong', {}, d.name), h('div', { class: 'muted' }, d.cards.length + ' cards')),
      h('button', { class: 'primary', onclick: () => go('#/deck/' + d.id) }, 'Open')
    )) : h('p', { class: 'muted' }, 'No decks yet.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => go('#/new') }, '+ New deck'))
  );
}

async function viewNew(deckId) {
  const existing = deckId ? state.decks[deckId] : null;
  const msg = h('p', { class: 'err' });
  const name = h('input', { type: 'text', placeholder: 'Deck name', value: existing ? existing.name : '' });
  const finish = (cards, suggested) => {
    pending = { cards, deckId: existing ? existing.id : null, name: (name.value.trim() || suggested || 'New deck') };
    go('#/select');
  };
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xls,.apkg' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    msg.textContent = 'Reading…';
    try { finish(await parseFile(file.files[0]), file.files[0].name.replace(/\.[^.]+$/, '')); }
    catch (e) { msg.textContent = e.message; }
  });
  const provided = h('select', {}, h('option', { value: '' }, 'Loading…'));
  let list = [];
  fetch('decks/index.json').then(r => r.json()).then(l => {
    list = l;
    provided.replaceChildren(...l.map((d, i) => h('option', { value: i }, d.name + (d.description ? ' — ' + d.description : ''))));
    if (!l.length) provided.replaceChildren(h('option', { value: '' }, 'No provided decks'));
  }).catch(() => provided.replaceChildren(h('option', { value: '' }, 'Provided decks unavailable')));
  const loadProvided = h('button', { onclick: async () => {
    const d = list[provided.value];
    if (!d) return;
    msg.textContent = 'Loading…';
    try {
      const r = await fetch('decks/' + encodeURIComponent(d.file));
      if (!r.ok) throw new Error('Could not load ' + d.file);
      finish(rowsToCards(parseCSV(await r.text())), d.name);
    } catch (e) { msg.textContent = e.message; }
  } }, 'Load provided deck');
  show(
    h('h2', {}, existing ? 'Add cards to ' + existing.name : 'New deck'),
    h('label', {}, 'Deck name'), name,
    h('hr'),
    h('h3', {}, 'Import a file'),
    h('p', { class: 'muted' }, 'CSV, Excel (.xlsx/.xls) with a header row (columns "front" and "back", or the first two columns), or an Anki .apkg (text of the first two fields only).'),
    file,
    h('hr'),
    h('h3', {}, 'Provided decks'), provided, h('div', { class: 'row' }, loadProvided),
    msg,
    h('div', { class: 'row' }, h('button', { onclick: () => go(existing ? '#/deck/' + existing.id : '#/') }, 'Cancel'))
  );
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
  show(
    h('h2', {}, 'Choose cards'),
    p.deckId ? h('p', {}, 'Adding to: ', h('strong', {}, state.decks[p.deckId].name)) : [h('label', {}, 'Deck name'), nameInput],
    h('div', { class: 'row' },
      h('button', { onclick: () => setAll(true) }, 'Select all'),
      h('button', { onclick: () => setAll(false) }, 'Select none'), countEl),
    search, listEl,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        const chosen = p.cards.filter(c => checked.has(c.id)).map(c => ({ id: c.id, front: c.front, back: c.back }));
        if (!chosen.length) return alert('Select at least one card.');
        let deck = p.deckId && state.decks[p.deckId];
        if (!deck) {
          deck = { id: uid(), name: nameInput.value.trim() || 'New deck', cards: [], sched: {}, settings: Object.assign({}, DEFAULTS), daily: null };
          state.decks[deck.id] = deck;
        }
        deck.cards.push(...chosen);
        save(); pending = null; go('#/deck/' + deck.id);
      } }, 'Add to deck'),
      h('button', { onclick: () => { pending = null; go(p.deckId ? '#/deck/' + p.deckId : '#/'); } }, 'Cancel'))
  );
}

function viewDeck(deck) {
  const now = new Date();
  let dir = deck.lastDir || 'f';
  const stats = h('p', { class: 'muted' });
  const refresh = () => {
    const c = counts(deck, dir, now);
    stats.textContent = 'New: ' + c.newLeft + ' · Learning: ' + c.learn + ' · Review: ' + c.reviewLeft;
  };
  const radios = Object.entries(DIRS).map(([k, label]) => {
    const r = h('input', { type: 'radio', name: 'dir', value: k });
    r.checked = k === dir;
    r.addEventListener('change', () => { dir = k; refresh(); });
    return h('label', {}, r, ' ', label);
  });
  refresh();
  show(
    h('h2', {}, deck.name),
    h('p', { class: 'muted' }, deck.cards.length + ' cards'),
    h('h3', {}, 'Study direction'), radios, stats,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        deck.lastDir = dir; save();
        session = { deckId: deck.id, dir, revealed: false, current: null };
        go('#/deck/' + deck.id + '/study');
      } }, 'Study'),
      h('button', { onclick: () => go('#/deck/' + deck.id + '/settings') }, 'Settings'),
      h('button', { onclick: () => go('#/') }, 'Back'))
  );
}

function viewStudy(deck) {
  if (!session || session.deckId !== deck.id) return go('#/deck/' + deck.id);
  const now = new Date();
  const { item, nextLearn } = pickNext(deck, session.dir, now);
  const done = (text) => show(
    h('h2', {}, deck.name),
    h('p', {}, text),
    h('div', { class: 'row' },
      nextLearn && h('button', { onclick: () => viewStudy(deck) }, 'Check again'),
      h('button', { class: 'primary', onclick: () => go('#/deck/' + deck.id) }, 'Done'))
  );
  if (!item) {
    return done(nextLearn
      ? 'Nothing due right now. Next card in ' + fmtInterval(nextLearn, now) + '.'
      : 'All done for today! 🎉');
  }
  session.current = item; session.revealed = false;
  const fsrsCard = getFsrsCard(deck, item.key);
  const q = item.dir === 'f' ? item.card.front : item.card.back;
  const a = item.dir === 'f' ? item.card.back : item.card.front;
  const draw = () => {
    const rec = session.revealed ? fsrs.repeat(fsrsCard, now) : null;
    const grade = (label, g) => h('button', { class: g === Rating.Good ? 'primary' : '', onclick: () => rate(g) },
      label, h('div', { class: 'muted' }, fmtInterval(rec[g].card.due, now)));
    show(
      h('div', { class: 'muted' }, DIRS[item.dir]),
      h('div', { class: 'cardface' }, session.revealed ? [h('div', {}, q), h('hr'), h('div', {}, a)] : q),
      session.revealed
        ? h('div', { class: 'grades' }, grade('Again', Rating.Again), grade('Hard', Rating.Hard), grade('Good', Rating.Good), grade('Easy', Rating.Easy))
        : h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { session.revealed = true; draw(); } }, 'Show answer')),
      h('div', { class: 'row' }, h('button', { onclick: () => go('#/deck/' + deck.id) }, 'Stop'))
    );
  };
  const rate = (g) => {
    const t = new Date();
    const daily = dailyCounts(deck, t);
    if (!deck.sched[item.key]) daily.newDone++;
    else if (deck.sched[item.key].state === State.Review) daily.reviewsDone++;
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
  show(
    h('h2', {}, 'Deck settings'),
    h('label', {}, 'Name'), name,
    h('label', {}, 'New cards per day'), np,
    h('label', {}, 'Maximum reviews per day'), rp,
    h('p', { class: 'muted' }, 'The day rolls over at midnight in your device\'s local time.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        deck.name = name.value.trim() || deck.name;
        deck.settings.newPerDay = num(np, DEFAULTS.newPerDay);
        deck.settings.reviewsPerDay = num(rp, DEFAULTS.reviewsPerDay);
        save(); go('#/deck/' + deck.id);
      } }, 'Save'),
      h('button', { onclick: () => exportDeck(deck) }, 'Export'),
      h('button', { onclick: () => go('#/new/' + deck.id) }, 'Add cards'),
      h('button', { onclick: () => go('#/deck/' + deck.id) }, 'Back')),
    h('hr'),
    h('button', { class: 'danger', onclick: () => {
      if (confirm('Delete "' + deck.name + '" and all its progress?')) { delete state.decks[deck.id]; save(); go('#/'); }
    } }, 'Delete deck')
  );
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const deck = parts[0] === 'deck' && state.decks[parts[1]];
  if (parts[0] === 'new') viewNew(parts[1] && state.decks[parts[1]] ? parts[1] : null);
  else if (parts[0] === 'select') viewSelect();
  else if (deck && parts[2] === 'study') viewStudy(deck);
  else if (deck && parts[2] === 'settings') viewSettings(deck);
  else if (deck) viewDeck(deck);
  else viewLibrary();
}

document.addEventListener('keydown', e => {
  if (!session || !session.current || !/\/study$/.test(location.hash) || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const btns = app.querySelectorAll('.grades button, .row .primary');
  if (e.key === ' ' && !session.revealed) { e.preventDefault(); btns[0] && btns[0].click(); }
  else if (session.revealed && '1234'.includes(e.key) && e.key) { const b = app.querySelectorAll('.grades button')[+e.key - 1]; b && b.click(); }
});

window.addEventListener('hashchange', route);
route();
})();
