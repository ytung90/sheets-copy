'use strict';
/*
 * Sheets Copy Helper – phone app (PWA).
 * Shows one Google Sheets row at a time. Tap a value to copy it, paste it in the other app,
 * then press Done: the script writes the timestamp (and your name, and e.g. NEW → Done)
 * and the next matching row appears.
 *
 * The app talks only to YOUR Google Apps Script (apps-script/Code.gs). Settings are kept on this phone.
 */

const APP_VERSION = '1.0.0';
const STORAGE_KEY = 'sheetsCopy.settings.v1';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_UNDO = 50;

/* ===================== small helpers ===================== */

const $ = (sel) => document.querySelector(sel);

class UserError extends Error {}

// Material Icons paths (Apache License 2.0)
const ICONS = {
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.488.488 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  next: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  install: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
};
const svg = (name, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${ICONS[name]}"/></svg>`;

/* ===================== columns ===================== */

const MAX_COL_INDEX = 18277; // ZZZ

function letterToIndex(letters) {
  const s = String(letters || '').trim().toUpperCase();
  if (!s) throw new UserError('Column is empty.');
  if (s.length > 3 || !/^[A-Z]+$/.test(s)) throw new UserError(`"${String(letters).trim()}" is not a column letter.`);
  let r = 0;
  for (const ch of s) r = r * 26 + (ch.charCodeAt(0) - 64);
  return r - 1;
}

function indexToLetter(index) {
  let n = index + 1, s = '';
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** "J" → 9, "" → null; throws on bad input. */
function parseOptionalColumn(text) {
  return String(text || '').trim() ? letterToIndex(text) : null;
}

/** "C, D, F-H" → [2,3,5,6,7]. Keeps the typed order, drops duplicates. */
function parseColumnList(text) {
  const out = [];
  const add = (i) => { if (!out.includes(i)) out.push(i); };
  const normalized = String(text || '').trim().replace(/\s*[-:]\s*/g, '-');
  if (!normalized) return out;
  for (const token of normalized.split(/[,;\s]+/).filter(Boolean)) {
    const parts = token.split('-');
    if (parts.length === 1) add(letterToIndex(parts[0]));
    else if (parts.length === 2) {
      let a = letterToIndex(parts[0]), b = letterToIndex(parts[1]);
      if (b < a) [a, b] = [b, a];
      if (b - a > 200) throw new UserError(`The range "${token}" is too wide.`);
      for (let i = a; i <= b; i++) add(i);
    } else throw new UserError(`"${token}" is not a column or range.`);
  }
  return out;
}

/* ===================== sheet link ===================== */

function parseSheetLink(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, error: 'Paste the Google Sheets link.' };
  if (/\/d\/e\//i.test(s)) return { ok: false, error: 'That is a "Publish to web" link. Use the normal link of the sheet instead.' };
  if (/rtpof=true/i.test(s)) return { ok: false, error: 'This link is an Excel (.xlsx) file in Google Drive. Open it, choose File → Save as Google Sheets, and use the new link.' };
  let id = null;
  const m = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/);
  if (m) id = m[1];
  else if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) id = s;
  if (!id) return { ok: false, error: "That doesn't look like a Google Sheets link. It should start with https://docs.google.com/spreadsheets/d/…" };
  const g = s.match(/[#?&]gid=(\d+)/);
  return { ok: true, id, gid: g ? Number(g[1]) : null };
}

/* ===================== settings & profiles ===================== */

const newId = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');

function newProfile(name = 'My sheet') {
  return { id: newId(), name, sheetLink: '', tabName: '', headerRow: 1, copyColumns: '',
           filterColumn: '', filterValue: '', doneValue: 'Done', timestampColumn: '', nameColumn: '' };
}

function normalizeSettings(raw) {
  const s = Object.assign({ scriptUrl: '', passcode: '', userName: '', activeProfileId: '', profiles: [] }, raw || {});
  s.profiles = Array.isArray(s.profiles) ? s.profiles.map((p) => Object.assign(newProfile(), p)) : [];
  if (s.profiles.length === 0) s.profiles.push(newProfile());
  if (!s.profiles.some((p) => p.id === s.activeProfileId)) s.activeProfileId = s.profiles[0].id;
  return s;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch { /* storage blocked or damaged: start fresh */ }
  return normalizeSettings(null);
}

function storeSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); // may throw; caller shows the error
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const activeProfile = (s) => s.profiles.find((p) => p.id === s.activeProfileId) || s.profiles[0];

function validateConnection(s) {
  const errors = [];
  const url = String(s.scriptUrl || '').trim();
  if (!url) errors.push('Enter the Script URL (from your Apps Script deployment).');
  else if (/\/dev\/?(\?.*)?$/.test(url)) errors.push('That is the test (/dev) URL. Use the Web app URL that ends in /exec.');
  else if (!/^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec\/?(\?.*)?$/.test(url))
    errors.push('The Script URL should look like https://script.google.com/macros/s/…/exec');
  if (!String(s.passcode || '').trim()) errors.push('Enter the passcode you set in the script.');
  return errors;
}

function validateProfile(p) {
  const errors = [];
  const link = parseSheetLink(p.sheetLink);
  if (!link.ok) errors.push(link.error);
  if (!(Number.isInteger(p.headerRow) && p.headerRow >= 1)) errors.push('Header row must be 1 or more.');

  let copy = [];
  try {
    copy = parseColumnList(p.copyColumns);
    if (copy.length === 0) errors.push('Enter at least one column to copy (for example: C, D, F).');
  } catch (e) { errors.push('Columns to copy: ' + e.message); }

  const col = (text, label) => { try { return parseOptionalColumn(text); } catch (e) { errors.push(`${label}: ${e.message}`); return null; } };
  const ts = col(p.timestampColumn, 'Timestamp column');
  if (!String(p.timestampColumn || '').trim()) errors.push('Enter the timestamp column (for example: J).');
  const filter = col(p.filterColumn, 'Filter column');
  const name = col(p.nameColumn, 'Name column');

  if (ts !== null && filter !== null && ts === filter) errors.push('The timestamp column and the filter column must be different.');
  if (name !== null && ts !== null && name === ts) errors.push('The name column and the timestamp column must be different.');
  if (name !== null && filter !== null && name === filter) errors.push('The name column and the filter column must be different.');
  if (ts !== null && copy.includes(ts)) errors.push("The timestamp column can't also be a column to copy.");
  if (filter !== null && String(p.doneValue || '').trim() &&
      String(p.filterValue || '').trim().toLowerCase() === String(p.doneValue || '').trim().toLowerCase())
    errors.push('"When done, set to" must be different from "Show rows with", otherwise finished rows never leave the list.');
  return errors;
}

/** The profile turned into what the script needs (0-based column numbers). Call only after validateProfile passes. */
function toLayout(p) {
  const link = parseSheetLink(p.sheetLink);
  return {
    spreadsheetId: link.id,
    gid: link.gid,
    tab: String(p.tabName || '').trim(),
    headerRow: p.headerRow,
    copy: parseColumnList(p.copyColumns),
    filterCol: parseOptionalColumn(p.filterColumn),
    filterValue: String(p.filterValue || '').trim(),
    doneValue: String(p.doneValue || '').trim(),
    tsCol: letterToIndex(p.timestampColumn),
    nameCol: parseOptionalColumn(p.nameColumn),
  };
}

function describeFilter(L) {
  const parts = [];
  if (L.filterCol !== null) parts.push(L.filterValue ? `${indexToLetter(L.filterCol)} = ${L.filterValue}` : `${indexToLetter(L.filterCol)} is blank`);
  if (L.filterCol === null || !L.doneValue) parts.push(`${indexToLetter(L.tsCol)} is blank`);
  return parts.length ? parts.join(', ') : 'all rows';
}

/* ===================== talking to the script ===================== */

async function callScript(action, payload, conn) {
  const url = String(conn.scriptUrl || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    // A plain string body is sent as text/plain, which Apps Script accepts without a CORS preflight.
    response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(Object.assign({}, payload, { action, passcode: String(conn.passcode || '') })),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new UserError('Google took too long to answer. Check the internet connection and try again.');
    throw new UserError(navigator.onLine === false
      ? 'No internet connection.'
      : "Can't reach the script. Check the Script URL, and that the script is deployed with Who has access: Anyone.");
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new UserError("The Script URL didn't answer like the Sheets Copy script. Use the Web app URL ending in /exec, " +
                        'and deploy with Execute as: Me and Who has access: Anyone.');
  }
  if (!data || data.ok !== true) throw new UserError((data && data.error) || 'The script returned an error.');
  return data;
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ===================== app state ===================== */

const app = {
  settings: loadSettings(),
  session: null,        // see startSession()
  busy: false,
  banner: null,         // { kind: 'info' | 'warn' | 'error', text }
  state: null,          // { title, detail, setup } when there is no row to show
  copied: new Set(),    // indexes of copied fields in the current row
  copiedRow: -1,
  shownKey: '',         // which row the cards currently show
  needsSetup: false,
  installPrompt: null,
};

/* ===================== main screen ===================== */

async function startSession() {
  app.session = null;
  app.copied.clear();
  app.copiedRow = -1;
  app.shownKey = '';
  app.banner = null;

  const s = app.settings;
  const p = activeProfile(s);
  const problems = validateConnection(s).concat(validateProfile(p));
  if (s.userName.trim() === '' && String(p.nameColumn || '').trim()) problems.push('Enter your name, or clear the name column.');

  if (problems.length) {
    app.needsSetup = true;
    app.state = { title: 'Finish setting up', detail: problems.join('\n'), setup: true };
    render();
    return;
  }

  app.needsSetup = false;
  app.state = null;
  app.session = {
    profile: p, layout: toLayout(p),
    loaded: false, tab: '', headers: [], queue: [], done: 0, undo: [], dataRows: 0,
  };
  await runBusy(() => loadRows(app.session));
}

async function loadRows(session) {
  const r = await callScript('load', { layout: session.layout }, app.settings);
  session.tab = r.tab;
  session.headers = r.headers;
  session.queue = r.rows;
  session.dataRows = r.dataRows;
  session.loaded = true;
}

async function runBusy(fn) {
  if (app.busy) return;
  app.busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    showBanner('error', e instanceof UserError ? e.message : 'Something went wrong: ' + (e && e.message));
  } finally {
    app.busy = false;
    render();
  }
}

function currentRow() {
  const s = app.session;
  return s && s.loaded && s.queue.length ? s.queue[0] : null;
}

async function copyField(index) {
  const row = currentRow();
  if (!row || app.busy) return;
  const value = String(row.cells[index] ?? '');
  if (!value.trim()) return;

  const ok = await writeClipboard(value);
  if (!ok) { showBanner('warn', "Couldn't copy. Tap the value again."); render(); return; }

  if (app.copiedRow !== row.row) { app.copied.clear(); app.copiedRow = row.row; }
  app.copied.add(index);
  if (navigator.vibrate) navigator.vibrate(12); // Android shows its own "copied" popup, so no toast here
  render();
  scrollToNextCard();
}

function nextUncopiedIndex() {
  const row = currentRow();
  if (!row) return -1;
  const copied = app.copiedRow === row.row ? app.copied : new Set();
  return row.cells.findIndex((v, i) => String(v ?? '').trim() !== '' && !copied.has(i));
}

async function copyNext() {
  const i = nextUncopiedIndex();
  if (i >= 0) await copyField(i);
}

async function doneAndNext() {
  const session = app.session;
  const row = currentRow();
  if (!row) return;
  await runBusy(async () => {
    const r = await callScript('complete',
      { layout: session.layout, row: row.row, expect: row.cells, userName: app.settings.userName.trim() }, app.settings);
    if (r.outcome === 'saved') {
      session.undo.push({ row: row.row, cells: row.cells, restore: r.restore });
      if (session.undo.length > MAX_UNDO) session.undo.shift();
      session.queue = session.queue.filter((x) => x.row !== row.row);
      session.done++;
      app.banner = null;
      toast(`✓ Row ${r.row} saved · ${String(r.timestamp).slice(11)}`);
    } else {
      showBanner('warn', `Row ${row.row} changed in the sheet since it was loaded, so nothing was saved. ` +
                         'The list has been refreshed. Check the row shown now.');
      await loadRows(session);
    }
    app.copied.clear();
  });
}

async function undoLast() {
  const session = app.session;
  if (!session || session.undo.length === 0) return;
  const entry = session.undo[session.undo.length - 1];
  await runBusy(async () => {
    await callScript('restore', { layout: session.layout, row: entry.row, cells: entry.restore }, app.settings);
    session.undo.pop();
    session.queue = [{ row: entry.row, cells: entry.cells }].concat(session.queue.filter((x) => x.row !== entry.row));
    session.done = Math.max(0, session.done - 1);
    app.banner = null;
    app.copied.clear();
    app.shownKey = '';
    toast(`↶ Row ${entry.row} restored`);
  });
}

async function refresh() {
  if (!app.session) { await startSession(); return; }
  app.banner = null;
  await runBusy(() => loadRows(app.session));
}

function showBanner(kind, text) { app.banner = { kind, text }; }

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

function scrollToNextCard() {
  const next = document.querySelector('.card.next');
  if (next) next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function render() {
  const s = app.session;
  const p = activeProfile(app.settings);
  $('#profileName').textContent = (p && p.name) || 'Sheets Copy';
  $('#busy').hidden = !app.busy;

  const banner = $('#banner');
  banner.hidden = !app.banner;
  if (app.banner) { banner.className = 'banner ' + app.banner.kind; banner.textContent = app.banner.text; }

  $('#btnRefresh').disabled = app.busy || app.needsSetup;
  $('#btnUndo').disabled = app.busy || !s || s.undo.length === 0;

  let state = app.state;
  if (s && !s.loaded) {
    state = app.busy
      ? { title: 'Loading…', detail: 'Reading the sheet from Google.' }
      : { title: "Couldn't load the sheet", detail: 'Fix the problem shown above, then press Refresh.' };
  }

  const loaded = s && s.loaded;
  $('#subTitle').textContent = loaded ? `${s.tab} · ${describeFilter(s.layout)}` : '';

  const total = loaded ? s.done + s.queue.length : 0;
  $('#counter').hidden = !loaded || total === 0;
  if (loaded && total > 0) {
    const row = s.queue[0];
    $('#position').textContent = `${row ? s.done + 1 : total} / ${total}`;
    $('#rowInfo').textContent = row ? `Row ${row.row} · ${s.queue.length} left` : `${s.done} done`;
    $('#progressFill').style.width = `${(100 * s.done) / total}%`;
  }

  const row = currentRow();
  if (loaded && !row) {
    state = {
      title: total === 0 ? 'No rows to do' : 'All done',
      detail: `No rows left where ${describeFilter(s.layout)}. Press Refresh to check for new ones.`,
    };
  }

  // state panel vs cards
  const stateEl = $('#state');
  stateEl.hidden = !state || !!row;
  if (state && !row) {
    $('#stateTitle').textContent = state.title;
    $('#stateDetail').textContent = state.detail || '';
    $('#stateSettings').hidden = !state.setup;
  }
  $('#fields').hidden = !row;

  if (row) renderCards(row);
  else { $('#fields').replaceChildren(); app.shownKey = ''; }

  // footer
  const nextIdx = nextUncopiedIndex();
  $('#btnDone').disabled = app.busy || !row;
  $('#btnCopyNext').disabled = app.busy || !row || nextIdx < 0;
  $('#copyNextLabel').textContent = !row ? '–'
    : nextIdx < 0 ? 'All copied ✓'
    : (s.headers[nextIdx] || indexToLetter(s.layout.copy[nextIdx]));
}

function renderCards(row) {
  const s = app.session;
  if (app.copiedRow !== row.row) { app.copied.clear(); app.copiedRow = row.row; }

  const key = row.row + '|' + JSON.stringify(row.cells) + '|' + s.headers.join('|');
  const container = $('#fields');
  if (key !== app.shownKey) {
    container.replaceChildren(...row.cells.map((value, i) => {
      const text = String(value ?? '');
      const empty = text.trim() === '';
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card' + (empty ? ' empty' : '');
      card.dataset.index = String(i);

      const body = document.createElement('div');
      body.className = 'text';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = `${s.headers[i] || 'Column'} · ${indexToLetter(s.layout.copy[i])}`;
      const val = document.createElement('div');
      val.className = 'value';
      val.textContent = empty ? '(empty)' : text;
      body.append(label, val);

      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.innerHTML = svg('copy', 16) + '<span class="pill-text">Copy</span>';

      card.append(body, pill);
      card.addEventListener('click', () => copyField(i));
      return card;
    }));
    container.scrollTop = 0;
    app.shownKey = key;
  }

  const nextIdx = nextUncopiedIndex();
  container.querySelectorAll('.card').forEach((card) => {
    const i = Number(card.dataset.index);
    const copied = app.copied.has(i);
    card.classList.toggle('copied', copied);
    card.classList.toggle('next', i === nextIdx);
    card.disabled = card.classList.contains('empty');
    const pill = card.querySelector('.pill');
    pill.innerHTML = copied ? svg('check', 16) + '<span class="pill-text">Copied</span>'
                            : svg('copy', 16) + '<span class="pill-text">Copy</span>';
  });
}

/* ===================== settings screen ===================== */

const form = {
  draft: null,
  current: null,
};

const F = {
  scriptUrl: () => $('#fScriptUrl'), passcode: () => $('#fPasscode'), userName: () => $('#fUserName'),
  profile: () => $('#fProfile'), profileName: () => $('#fProfileName'), sheetLink: () => $('#fSheetLink'),
  tab: () => $('#fTab'), headerRow: () => $('#fHeaderRow'), copyColumns: () => $('#fCopyColumns'),
  timestampColumn: () => $('#fTimestampColumn'), nameColumn: () => $('#fNameColumn'),
  filterColumn: () => $('#fFilterColumn'), filterValue: () => $('#fFilterValue'), doneValue: () => $('#fDoneValue'),
};

function openSettings() {
  form.draft = clone(app.settings);
  F.scriptUrl().value = form.draft.scriptUrl;
  F.passcode().value = form.draft.passcode;
  F.passcode().type = 'password';
  $('#btnShowPass').textContent = 'Show';
  F.userName().value = form.draft.userName;
  showSettingsError('');
  showTestResult(null, '');
  fillProfileList(activeProfile(form.draft).id);
  $('#installBox').hidden = !app.installPrompt;
  $('#versionText').textContent = `Sheets Copy Helper ${APP_VERSION}`;
  hideToast();
  $('#main').hidden = true;
  $('#settings').hidden = false;
  $('#settingsForm').scrollTop = 0;
}

function closeSettings() {
  $('#settings').hidden = true;
  $('#main').hidden = false;
}

function fillProfileList(selectId) {
  const sel = F.profile();
  sel.replaceChildren(...form.draft.profiles.map((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name || '(no name)';
    return o;
  }));
  sel.value = selectId;
  loadProfileIntoForm(form.draft.profiles.find((p) => p.id === selectId) || form.draft.profiles[0]);
}

function loadProfileIntoForm(p) {
  form.current = p;
  F.profileName().value = p.name;
  $('#profileIdText').textContent = `Profile ID: ${p.id}`;
  F.sheetLink().value = p.sheetLink;
  F.tab().value = p.tabName;
  $('#tabList').replaceChildren();
  F.headerRow().value = String(p.headerRow);
  F.copyColumns().value = p.copyColumns;
  F.timestampColumn().value = p.timestampColumn;
  F.nameColumn().value = p.nameColumn;
  F.filterColumn().value = p.filterColumn;
  F.filterValue().value = p.filterValue;
  F.doneValue().value = p.doneValue;
  showTestResult(null, '');
}

function commitForm() {
  const d = form.draft;
  d.scriptUrl = F.scriptUrl().value.trim();
  d.passcode = F.passcode().value.trim();
  d.userName = F.userName().value.trim();
  const p = form.current;
  if (!p) return;
  p.name = F.profileName().value.trim() || 'My sheet';
  p.sheetLink = F.sheetLink().value.trim();
  p.tabName = F.tab().value.trim();
  const hr = Number(F.headerRow().value.trim());
  p.headerRow = Number.isInteger(hr) ? hr : 0;
  p.copyColumns = F.copyColumns().value.trim().toUpperCase();
  p.timestampColumn = F.timestampColumn().value.trim().toUpperCase();
  p.nameColumn = F.nameColumn().value.trim().toUpperCase();
  p.filterColumn = F.filterColumn().value.trim().toUpperCase();
  p.filterValue = F.filterValue().value.trim();
  p.doneValue = F.doneValue().value.trim();
  const opt = F.profile().selectedOptions[0];
  if (opt) opt.textContent = p.name;
}

function settingsProblems() {
  const d = form.draft;
  const p = form.current;
  const problems = validateConnection(d).concat(validateProfile(p));
  if (String(p.nameColumn || '').trim() && !d.userName) problems.push('Enter your name, or clear the name column.');
  return problems;
}

async function testConnection() {
  commitForm();
  const problems = settingsProblems();
  if (problems.length) { showTestResult(false, problems.join('\n')); return; }

  const btn = $('#btnTest');
  btn.disabled = true;
  showTestResult(null, 'Connecting to your script…');
  try {
    const L = toLayout(form.current);
    const r = await callScript('load', { layout: L }, form.draft);
    $('#tabList').replaceChildren(...r.tabs.map((t) => { const o = document.createElement('option'); o.value = t; return o; }));
    const lines = [`✓ Connected to tab "${r.tab}".`, ''];
    L.copy.forEach((c, i) => lines.push(`  ${indexToLetter(c).padEnd(3)} →  ${r.headers[i]}`));
    lines.push(`  Timestamp → ${indexToLetter(L.tsCol)} (${r.tsHeader})`);
    if (L.nameCol !== null) lines.push(`  Name → ${indexToLetter(L.nameCol)} (${r.nameHeader})`);
    lines.push('', `${r.rows.length} of ${r.dataRows} rows match (${describeFilter(L)}).`);
    showTestResult(true, lines.join('\n'));
  } catch (e) {
    showTestResult(false, e instanceof UserError ? e.message : String(e && e.message));
  } finally {
    btn.disabled = false;
  }
}

function saveSettings() {
  commitForm();
  const problems = settingsProblems();
  if (problems.length) { showSettingsError('• ' + problems.join('\n• ')); return; }
  form.draft.activeProfileId = form.current.id;
  try {
    storeSettings(form.draft);
  } catch (e) {
    showSettingsError("Couldn't save settings on this phone: " + (e && e.message));
    return;
  }
  app.settings = normalizeSettings(clone(form.draft));
  closeSettings();
  startSession();
}

function showSettingsError(text) {
  const el = $('#settingsError');
  el.textContent = text;
  el.hidden = !text;
}

function showTestResult(ok, text) {
  const el = $('#testResult');
  el.hidden = !text;
  el.textContent = text;
  el.className = 'test-result' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}

/* ===================== wiring ===================== */

function wire() {
  document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon)));

  $('#btnCopyNext').addEventListener('click', copyNext);
  $('#btnDone').addEventListener('click', doneAndNext);
  $('#btnUndo').addEventListener('click', undoLast);
  $('#btnRefresh').addEventListener('click', refresh);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#stateSettings').addEventListener('click', openSettings);
  $('#banner').addEventListener('click', () => { app.banner = null; render(); });

  $('#btnSettingsClose').addEventListener('click', closeSettings);
  $('#btnCancel').addEventListener('click', closeSettings);
  $('#btnSave').addEventListener('click', saveSettings);
  $('#btnTest').addEventListener('click', testConnection);
  $('#settingsForm').addEventListener('submit', (e) => e.preventDefault());

  $('#btnShowPass').addEventListener('click', () => {
    const input = F.passcode();
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#btnShowPass').textContent = show ? 'Hide' : 'Show';
  });

  F.profile().addEventListener('change', () => {
    commitForm();
    const p = form.draft.profiles.find((x) => x.id === F.profile().value);
    if (p) loadProfileIntoForm(p);
  });
  F.profileName().addEventListener('change', commitForm);

  $('#btnNewProfile').addEventListener('click', () => {
    commitForm();
    const p = newProfile(`Sheet ${form.draft.profiles.length + 1}`);
    form.draft.profiles.push(p);
    fillProfileList(p.id);
    F.sheetLink().focus();
  });
  $('#btnDupProfile').addEventListener('click', () => {
    commitForm();
    const copy = Object.assign(clone(form.current), { id: newId(), name: form.current.name + ' (copy)' });
    form.draft.profiles.push(copy);
    fillProfileList(copy.id);
  });
  $('#btnDelProfile').addEventListener('click', () => {
    if (form.draft.profiles.length === 1) { showSettingsError('You need at least one profile. Change this one instead of deleting it.'); return; }
    if (!confirm(`Delete the profile "${form.current.name}"?\n\nOnly this setup is removed. The Google Sheet is not touched.`)) return;
    form.draft.profiles = form.draft.profiles.filter((p) => p.id !== form.current.id);
    fillProfileList(form.draft.profiles[0].id);
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    app.installPrompt = e;
    $('#installBox').hidden = false;
  });
  window.addEventListener('appinstalled', () => { app.installPrompt = null; $('#installBox').hidden = true; });
  $('#btnInstall').addEventListener('click', async () => {
    const prompt = app.installPrompt;
    if (!prompt) return;
    prompt.prompt();
    try { await prompt.userChoice; } catch { /* ignore */ }
    app.installPrompt = null;
    $('#installBox').hidden = true;
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }
}

wire();
render();
startSession().then(() => { if (app.needsSetup) openSettings(); });
