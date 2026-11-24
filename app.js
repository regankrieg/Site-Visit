// ---------- State ----------
// Reports (text only) live in memory in `data.reports` and are saved to IndexedDB.
// Photos are stored separately in IndexedDB (they're large) and referenced from each note by id.
let data = { reports: [] };
let db = null;
let dirty = false;
const dirtyReports = new Set();
const photoCache = {};          // photo id -> data URL (undefined = not loaded yet, '' = missing)
let reportSearch = '';
let pendingPhotoTarget = null;  // { rid, nid, sid } for the photo picker that is currently open
let lastRouteKey = '';

// ---------- Responsive layout ----------
// Measures the window and tags <html> so style.css can switch between phone / tablet / laptop / desktop
// layouts. Runs on load, on resize, and when the device is rotated.
const LAYOUT_BREAKPOINTS = { phone: 600, tablet: 900, laptop: 1200 }; // px: below 600 = phone, 600-899 = tablet, 900-1199 = laptop, 1200+ = desktop
function applyLayout() {
  const vv = window.visualViewport;
  const w = Math.round(vv ? vv.width : window.innerWidth);
  const h = Math.round(vv ? vv.height : window.innerHeight);
  // A phone held sideways is wide but very short; treat it as a phone rather than a tablet.
  const shortSide = Math.min(w, h);
  let layout = w < LAYOUT_BREAKPOINTS.phone ? 'phone'
    : w < LAYOUT_BREAKPOINTS.tablet ? 'tablet'
    : w < LAYOUT_BREAKPOINTS.laptop ? 'laptop' : 'desktop';
  if (shortSide < 500 && (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) layout = 'phone';
  const orientation = w >= h ? 'landscape' : 'portrait';
  const root = document.documentElement;
  if (root.dataset.layout !== layout) root.dataset.layout = layout;
  if (root.dataset.orientation !== orientation) root.dataset.orientation = orientation;
}
let layoutTimer = null;
function onViewportChange() { clearTimeout(layoutTimer); layoutTimer = setTimeout(applyLayout, 80); }
applyLayout();
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => { init(); });

async function init() {
  try {
    db = await openDB();
    data.reports = await dbAll('reports');
  } catch (e) {
    console.error('Could not open local storage', e);
    document.getElementById('content').innerHTML = `
      <div class="panel" style="border-color:#E85D5D; max-width:640px;">
        <h1 style="color:#E85D5D;">Storage isn't available</h1>
        <p style="line-height:1.6; color:var(--text);">
          This browser couldn't open its local database, so nothing typed here could be saved.
          This usually means Private Browsing is on, or the page was opened from a location Safari blocks.
          Open the app in a normal Safari tab (or from the Home Screen icon) and try again.
        </p>
      </div>`;
    return;
  }
  data.reports.forEach((r) => {
    r.attendees = r.attendees || [];
    r.notes = r.notes || [];
    r.notes.forEach((n) => { n.photos = n.photos || []; n.subs = n.subs || []; n.subs.forEach((s) => { s.photos = s.photos || []; }); });
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  window.addEventListener('hashchange', route);
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = '#/' + btn.dataset.route; });
  });

  document.getElementById('fileCam').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); });
  document.getElementById('fileLib').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); });
  document.getElementById('fileImport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });

  setInterval(() => { if (dirty) saveNow(); }, 3000);
  window.addEventListener('beforeunload', () => { if (dirty) saveNow(); });
  window.addEventListener('pagehide', () => { if (dirty) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) saveNow(); });

  updateClock();
  setInterval(updateClock, 30000);

  if (!location.hash) location.hash = '#/reports';
  route();
}

function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- IndexedDB ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sitenotes', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('reports', { keyPath: 'id' });
      req.result.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbReq(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function idbStore(name, mode) { return db.transaction(name, mode || 'readonly').objectStore(name); }
function dbAll(name) { return idbReq(idbStore(name).getAll()); }
function dbGet(name, key) { return idbReq(idbStore(name).get(key)); }
function dbPut(name, value) { return idbReq(idbStore(name, 'readwrite').put(value)); }
function dbDel(name, key) { return idbReq(idbStore(name, 'readwrite').delete(key)); }

// ---------- Saving ----------
function markDirty(reportId) {
  if (reportId) dirtyReports.add(reportId);
  dirty = true;
  const ind = document.getElementById('saveIndicator');
  const txt = document.getElementById('saveText');
  ind.classList.add('dirty');
  txt.textContent = 'Unsaved changes…';
}

async function saveNow() {
  const ind = document.getElementById('saveIndicator');
  const txt = document.getElementById('saveText');
  try {
    for (const id of [...dirtyReports]) {
      const r = data.reports.find((x) => x.id === id);
      dirtyReports.delete(id);
      if (!r) continue;
      r.updated = Date.now();
      await dbPut('reports', r);
    }
    dirty = dirtyReports.size > 0;
    if (!dirty) {
      ind.classList.remove('dirty');
      txt.textContent = 'Saved';
      txt.title = '';
    }
  } catch (e) {
    ind.classList.add('dirty');
    txt.textContent = 'Save failed — storage error';
    txt.title = String(e);
  }
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid(prefix) { return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function localTodayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function slug(s) { return String(s || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
function growTextarea(el) { el.style.height = 'auto'; el.style.height = Math.max(44, el.scrollHeight + 2) + 'px'; }
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function getReport(id) { return data.reports.find((r) => r.id === id); }
function findNote(rid, nid, sid) {
  const r = getReport(rid);
  if (!r) return null;
  const n = r.notes.find((x) => x.id === nid);
  if (!n) return null;
  return sid ? n.subs.find((s) => s.id === sid) : n;
}
function allNoteItems(r) {
  // Flat, in display order: each note followed by its sub-notes, with their numbering labels
  const out = [];
  r.notes.forEach((n, i) => {
    out.push({ note: n, label: String(i + 1), sub: false });
    n.subs.forEach((s, j) => out.push({ note: s, label: `${i + 1}.${j + 1}`, sub: true }));
  });
  return out;
}
function photoIdsOf(r) {
  const ids = [];
  allNoteItems(r).forEach((it) => it.note.photos.forEach((p) => ids.push(p.id)));
  return ids;
}
function countPhotos(r) { return photoIdsOf(r).length; }
async function loadPhotos(ids) {
  await Promise.all(ids.map(async (id) => {
    const rec = await dbGet('photos', id);
    photoCache[id] = rec ? rec.data : '';
  }));
}

// ---------- Routing ----------
function route() {
  const hash = location.hash.replace('#/', '') || 'reports';
  const parts = hash.split('/');
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === parts[0] || (b.dataset.route === 'reports' && parts[0] === 'report'));
  });
  updateCounts();

  const key = location.hash;
  const keepY = key === lastRouteKey ? window.scrollY : 0;
  lastRouteKey = key;

  const content = document.getElementById('content');
  if (parts[0] === 'report' && parts[1]) {
    const r = getReport(parts[1]);
    if (r) {
      const missing = photoIdsOf(r).filter((id) => photoCache[id] === undefined);
      if (missing.length) {
        content.innerHTML = '<div class="empty-state">Loading photos…</div>';
        loadPhotos(missing).then(route);
        return;
      }
    }
    content.innerHTML = renderReportDetail(parts[1]);
  } else if (parts[0] === 'backup') content.innerHTML = renderBackup();
  else content.innerHTML = renderReports();

  content.querySelectorAll('textarea.autogrow').forEach(growTextarea);
  window.scrollTo(0, keepY);
}

function updateCounts() {
  document.getElementById('countReports').textContent = data.reports.length || '';
}

// ---------- Reports list ----------
function reportRows() {
  const q = reportSearch.trim().toLowerCase();
  const list = data.reports
    .filter((r) => !q || [r.title, r.project, r.location, r.summary].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.updated || 0) - (a.updated || 0));
  if (!list.length) return `<div class="empty-state">${data.reports.length ? 'No reports match that search.' : 'No reports yet. Click “+ New Report” to start your first site visit.'}</div>`;
  return list.map((r) => `
    <div class="rail-row status-open" onclick="location.hash='#/report/${r.id}'">
      <div class="rail-main">
        <div class="rail-title">${r.title ? escapeHtml(r.title) : '<span style="color:var(--text-faint);font-style:italic;">Untitled report</span>'}</div>
        <div class="rail-sub">${r.project ? '<span class="mono">' + escapeHtml(r.project) + '</span> · ' : ''}${fmtDate(r.date)}${r.location ? ' · ' + escapeHtml(r.location) : ''}</div>
      </div>
      <span class="badge">${r.notes.length} note${r.notes.length === 1 ? '' : 's'}</span>
      <span class="badge">${countPhotos(r)} photo${countPhotos(r) === 1 ? '' : 's'}</span>
    </div>`).join('');
}

function renderReports() {
  return `
    <div class="page-header">
      <div><h1>Site Visit Reports</h1><p class="subtitle">Field and site visit notes with photos. Everything saves automatically on this device.</p></div>
      <button class="btn btn-primary" onclick="createReport()">+ New Report</button>
    </div>
    <div class="filter-row">
      <input class="search-input" type="search" placeholder="Search title, project #, location…" value="${escapeHtml(reportSearch)}" oninput="onReportSearch(this.value)">
    </div>
    <div class="rail-list" id="reportList">${reportRows()}</div>`;
}

function onReportSearch(value) {
  reportSearch = value;
  document.getElementById('reportList').innerHTML = reportRows();
}

function createReport() {
  const r = { id: uid('r'), title: '', project: '', date: localTodayISO(), location: '', summary: '', attendees: [], notes: [], created: Date.now(), updated: Date.now() };
  data.reports.push(r);
  markDirty(r.id);
  saveNow();
  location.hash = '#/report/' + r.id;
}

async function deleteReport(id) {
  const r = getReport(id);
  if (!r) return;
  if (!confirm(`Delete "${r.title || 'Untitled report'}" and all of its photos?\n\nThis cannot be undone.`)) return;
  for (const pid of photoIdsOf(r)) { await dbDel('photos', pid); delete photoCache[pid]; }
  await dbDel('reports', id);
  data.reports = data.reports.filter((x) => x.id !== id);
  dirtyReports.delete(id);
  location.hash = '#/reports';
  route();
}

// ---------- Report detail ----------
function photoThumbHtml(rid, nid, sid, p) {
  const ids = `'${rid}','${nid}','${sid}','${p.id}'`;
  return `
    <div class="photo-thumb">
      <img src="${photoCache[p.id] || ''}" alt="" onclick="viewPhoto('${p.id}')">
      <button class="photo-remove" title="Remove photo" onclick="removePhoto(${ids})">&times;</button>
      <input type="text" placeholder="Caption (optional)" value="${escapeHtml(p.caption || '')}" oninput="updatePhotoCaption(${ids},this.value)">
    </div>`;
}

function noteHtml(r, n, label, nid, sid, idx, len, isSub) {
  const ids = `'${r.id}','${nid}','${sid}'`;
  return `
    <div class="${isSub ? 'sub-note' : 'meeting-point'}">
      <div class="note-row">
        <span class="mono note-num">${label}${isSub ? '' : '.'}</span>
        <textarea id="note-text-${n.id}" class="autogrow" style="flex:1; min-height:44px;" oninput="updateNoteText(${ids},this.value); growTextarea(this)" placeholder="${isSub ? 'Additional note…' : 'Observation / field note…'}">${escapeHtml(n.text)}</textarea>
        <div class="note-ctrls">
          <button class="btn btn-small" title="Move up" onclick="moveNote(${ids},-1)" ${idx === 0 ? 'disabled' : ''}>&uarr;</button>
          <button class="btn btn-small" title="Move down" onclick="moveNote(${ids},1)" ${idx === len - 1 ? 'disabled' : ''}>&darr;</button>
          <button class="btn btn-small btn-danger" onclick="removeNote(${ids})">Remove</button>
        </div>
      </div>
      <div class="note-body">
        ${n.photos.length ? `<div class="photo-grid">${n.photos.map((p) => photoThumbHtml(r.id, nid, sid, p)).join('')}</div>` : ''}
        <div class="note-actions">
          <button class="btn btn-small btn-primary" onclick="startPhoto('cam',${ids})">Take Photo</button>
          <button class="btn btn-small" onclick="startPhoto('lib',${ids})">From Library</button>
          ${isSub ? '' : `<button class="btn btn-small" onclick="addSubNote('${r.id}','${nid}')">+ Add Sub-note (${label}.${n.subs.length + 1})</button>`}
        </div>
      </div>
      ${isSub ? '' : n.subs.map((s, j) => noteHtml(r, s, `${label}.${j + 1}`, nid, s.id, j, n.subs.length, true)).join('')}
    </div>`;
}

function renderReportDetail(id) {
  const r = getReport(id);
  if (!r) return `<div class="empty-state">Report not found.</div><button class="btn" onclick="location.hash='#/reports'">Back to Reports</button>`;

  const attendeeRows = r.attendees.map((a) => `
    <div class="field-row" style="margin-bottom:8px; align-items:center;">
      <div class="field" style="margin-bottom:0;"><input placeholder="Name" value="${escapeHtml(a.name)}" oninput="updateAttendee('${r.id}','${a.id}','name',this.value)"></div>
      <div class="field" style="margin-bottom:0;"><input placeholder="Company / Role" value="${escapeHtml(a.company)}" oninput="updateAttendee('${r.id}','${a.id}','company',this.value)"></div>
      <button class="btn btn-small btn-danger" onclick="removeAttendee('${r.id}','${a.id}')">Remove</button>
    </div>`).join('');

  const noteRows = r.notes.map((n, i) => noteHtml(r, n, String(i + 1), n.id, '', i, r.notes.length, false)).join('');

  return `
    <button class="back-link" onclick="location.hash='#/reports'">&larr; All Reports</button>
    <div class="page-header">
      <div><h1>Site Visit Report</h1><p class="subtitle">Changes here save automatically like everywhere else.</p></div>
      <div class="header-actions">
        <button class="btn" onclick="printReport('${r.id}')">Print / PDF</button>
        <button class="btn btn-primary" onclick="openExportModal('${r.id}')">Export Report</button>
      </div>
    </div>

    <div class="panel">
      <div class="field"><label>Report Title</label><input type="text" value="${escapeHtml(r.title)}" oninput="updateReportField('${r.id}','title',this.value)" placeholder="e.g. Level 2 Mechanical Rough-in Walk"></div>
      <div class="field-row">
        <div class="field"><label>Project #</label><input type="text" value="${escapeHtml(r.project)}" oninput="updateReportField('${r.id}','project',this.value)" placeholder="25-050"></div>
        <div class="field"><label>Visit Date</label><input type="date" value="${r.date || ''}" onchange="updateReportField('${r.id}','date',this.value)"></div>
      </div>
      <div class="field"><label>Location</label><input type="text" value="${escapeHtml(r.location)}" oninput="updateReportField('${r.id}','location',this.value)" placeholder="Site / address"></div>
      <div class="field" style="margin-bottom:0;"><label>Summary of Observations</label><textarea class="autogrow" style="min-height:90px;" oninput="updateReportField('${r.id}','summary',this.value); growTextarea(this)" placeholder="Overall summary of what was observed…">${escapeHtml(r.summary)}</textarea></div>
    </div>

    <div class="panel">
      <div class="section-title-row"><h2>Attendees</h2><button class="btn btn-small" onclick="addAttendee('${r.id}')">+ Add Attendee</button></div>
      ${attendeeRows || '<div class="empty-state">No attendees added yet.</div>'}
    </div>

    <div class="panel">
      <div class="section-title-row"><h2>Field Notes</h2><button class="btn btn-small" onclick="addNote('${r.id}')">+ Add Note</button></div>
      ${noteRows || '<div class="empty-state">No notes yet. Click “+ Add Note” to start.</div>'}
    </div>

    <div class="panel">
      <button class="btn btn-danger" onclick="deleteReport('${r.id}')">Delete this report</button>
    </div>
    <button class="fab" onclick="addNote('${r.id}')">+ Note ${r.notes.length + 1}</button>`;
}

// ---------- Report editing ----------
function updateReportField(id, field, value) {
  const r = getReport(id);
  if (!r) return;
  r[field] = value;
  markDirty(id);
}

function addAttendee(id) {
  const r = getReport(id);
  r.attendees.push({ id: uid('a'), name: '', company: '' });
  markDirty(id); route();
}
function removeAttendee(id, aid) {
  const r = getReport(id);
  r.attendees = r.attendees.filter((a) => a.id !== aid);
  markDirty(id); route();
}
function updateAttendee(id, aid, field, value) {
  const a = getReport(id).attendees.find((x) => x.id === aid);
  if (a) a[field] = value;
  markDirty(id);
}

function addNote(id) {
  const r = getReport(id);
  const n = { id: uid('n'), text: '', photos: [], subs: [] };
  r.notes.push(n);
  markDirty(id); route();
  setTimeout(() => { const el = document.getElementById('note-text-' + n.id); if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); } }, 0);
}
function addSubNote(id, nid) {
  const n = findNote(id, nid, '');
  const s = { id: uid('s'), text: '', photos: [] };
  n.subs.push(s);
  markDirty(id); route();
  setTimeout(() => { const el = document.getElementById('note-text-' + s.id); if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); } }, 0);
}
function updateNoteText(id, nid, sid, value) {
  const n = findNote(id, nid, sid);
  if (n) n.text = value;
  markDirty(id);
}
async function removeNote(id, nid, sid) {
  const n = findNote(id, nid, sid);
  if (!n) return;
  const subCount = sid ? 0 : n.subs.length;
  if (!confirm(`Delete this note${subCount ? ` and its ${subCount} sub-note${subCount === 1 ? '' : 's'}` : ''}, including any photos attached to it?`)) return;
  const doomed = [n, ...(sid ? [] : n.subs)];
  for (const x of doomed) for (const p of x.photos) { await dbDel('photos', p.id); delete photoCache[p.id]; }
  const r = getReport(id);
  if (sid) { const parent = r.notes.find((x) => x.id === nid); parent.subs = parent.subs.filter((s) => s.id !== sid); }
  else r.notes = r.notes.filter((x) => x.id !== nid);
  markDirty(id); route();
}
function moveNote(id, nid, sid, dir) {
  const r = getReport(id);
  const arr = sid ? r.notes.find((x) => x.id === nid).subs : r.notes;
  const key = sid || nid;
  const i = arr.findIndex((x) => x.id === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  markDirty(id); route();
}

// ---------- Photos ----------
function startPhoto(kind, rid, nid, sid) {
  pendingPhotoTarget = { rid, nid, sid };
  document.getElementById(kind === 'cam' ? 'fileCam' : 'fileLib').click();
}

// Photos are shrunk to max 1600px JPEG before saving so a day of site photos doesn't fill device storage.
function resizeImage(file, maxSide, quality) {
  maxSide = maxSide || 1600;
  quality = quality || 0.8;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

async function addPhotos(files) {
  const t = pendingPhotoTarget;
  if (!t || !files.length) return;
  const note = findNote(t.rid, t.nid, t.sid);
  if (!note) return;
  let added = 0;
  for (const f of files) {
    try {
      const dataUrl = await resizeImage(f);
      const id = uid('p');
      await dbPut('photos', { id, data: dataUrl });
      photoCache[id] = dataUrl;
      note.photos.push({ id, caption: '' });
      added++;
    } catch (e) {
      console.error(e);
      toast('Could not read one of the photos');
    }
  }
  if (added) {
    markDirty(t.rid);
    await saveNow();
    route();
    toast(added + ' photo' + (added === 1 ? '' : 's') + ' added');
  }
}

async function removePhoto(rid, nid, sid, pid) {
  if (!confirm('Remove this photo?')) return;
  const n = findNote(rid, nid, sid);
  n.photos = n.photos.filter((p) => p.id !== pid);
  await dbDel('photos', pid);
  delete photoCache[pid];
  markDirty(rid); route();
}
function updatePhotoCaption(rid, nid, sid, pid, value) {
  const p = findNote(rid, nid, sid).photos.find((x) => x.id === pid);
  if (p) p.caption = value;
  markDirty(rid);
}
function viewPhoto(pid) {
  openModal(`<div class="photo-viewer"><img src="${photoCache[pid] || ''}" alt=""></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
}

// ---------- Modals ----------
function openModal(html, wide) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal ${wide ? 'modal-wide' : ''}">${html}</div></div>`;
  document.getElementById('modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

// ---------- Export: a folder with the photos + a text outline ----------
function indentText(text, pad) {
  return String(text || '').split(/\r?\n/).map((l, i) => (i === 0 ? l : pad + l)).join('\n');
}

// Builds the text outline and decides the file name of every photo (Photo_01_Note_2-1.jpg etc.)
// so the text file can point at the photos sitting next to it in the folder.
function buildReportExport(r) {
  const names = {};
  const photoOrder = [];
  let seq = 0;
  allNoteItems(r).forEach((it) => {
    it.note.photos.forEach((p) => {
      seq++;
      names[p.id] = `Photo_${String(seq).padStart(2, '0')}_Note_${it.label.replace('.', '-')}.jpg`;
      photoOrder.push(p.id);
    });
  });

  const lines = [];
  lines.push('SITE VISIT REPORT');
  lines.push(`Title: ${r.title || '(untitled)'}`);
  lines.push(`Project #: ${r.project || '(none)'}`);
  lines.push(`Date: ${fmtDate(r.date)}`);
  if (r.location) lines.push(`Location: ${r.location}`);
  lines.push('');
  lines.push('Summary of Observations:');
  lines.push((r.summary || '').trim() ? '  ' + indentText(r.summary.trim(), '  ') : '  (none entered)');
  lines.push('');
  lines.push('Attendees:');
  if (r.attendees.length) {
    r.attendees.forEach((a) => lines.push(`  - ${a.name || '(unnamed)'}${a.company ? ' (' + a.company + ')' : ''}`));
  } else {
    lines.push('  (none listed)');
  }
  lines.push('');
  lines.push('Field Notes:');
  r.notes.forEach((n, i) => {
    const writeNote = (note, label, sub) => {
      const lead = sub ? `  ${label}  ` : `${label}. `;
      lines.push(lead + indentText(note.text || '(no text)', ' '.repeat(lead.length)));
      note.photos.forEach((p) => lines.push(`${sub ? '      ' : '    '}[Photo] ${names[p.id]}${p.caption ? ' — ' + p.caption : ''}`));
    };
    writeNote(n, String(i + 1), false);
    n.subs.forEach((s, j) => writeNote(s, `${i + 1}.${j + 1}`, true));
  });
  if (!r.notes.length) lines.push('  (no notes)');
  lines.push('');
  lines.push(`Photos in this folder: ${photoOrder.length}`);

  const folder = [slug(r.project) || 'NoProject', slug(r.title) || 'Site_Visit', r.date || localTodayISO()].join('_');
  return { text: lines.join('\n'), names, photoOrder, folder };
}

function dataUrlToBytes(url) {
  const bin = atob(url.split(',')[1] || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Files for the export folder: the text outline + every photo (loaded from storage if needed)
async function prepareExportFiles(r) {
  const ex = buildReportExport(r);
  const missing = ex.photoOrder.filter((id) => photoCache[id] === undefined);
  if (missing.length) await loadPhotos(missing);
  const enc = new TextEncoder();
  const files = [{ name: ex.folder + '.txt', bytes: enc.encode(ex.text) }];
  ex.photoOrder.forEach((id) => { if (photoCache[id]) files.push({ name: ex.names[id], bytes: dataUrlToBytes(photoCache[id]) }); });
  return { folder: ex.folder, files };
}

// Minimal ZIP writer (no compression: JPEGs don't shrink anyway). Opening the .zip in Files on the
// iPad unfolds it into the named folder.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  entries.forEach((e) => {
    const nameBytes = enc.encode(e.name);
    const bytes = e.bytes || new Uint8Array(0);
    const crc = crc32(bytes);
    const size = bytes.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);           // UTF-8 file names
    lh.setUint16(8, 0, true);                // stored (no compression)
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, bytes);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(38, e.isDir ? 0x10 : 0, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
  });
  const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

async function buildReportZip(r) {
  const { folder, files } = await prepareExportFiles(r);
  const entries = [{ name: folder + '/', isDir: true }, ...files.map((f) => ({ name: folder + '/' + f.name, bytes: f.bytes }))];
  return { blob: makeZip(entries), folder, count: files.length - 1 };
}

// Saves a Blob: uses a save dialog where the browser has one (desktop Chrome/Edge), otherwise a normal download.
async function saveBlobFile(blob, suggestedName, description, mime, ext) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [ext] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error('Save picker failed, falling back to direct download:', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function openExportModal(id) {
  const r = getReport(id);
  if (!r) return;
  const ex = buildReportExport(r);
  const canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File([''], 'x.zip', { type: 'application/zip' })] }));
  const canFolder = !!window.showDirectoryPicker;
  openModal(`
    <h2>Export Report</h2>
    <p class="export-note">Creates a folder named <b class="mono">${escapeHtml(ex.folder)}</b> containing <b>${ex.photoOrder.length}</b> photo${ex.photoOrder.length === 1 ? '' : 's'} and one text file with the report info and notes, packaged as a .zip. On the iPad, tap the .zip in Files to open it as a folder.</p>
    <div class="field"><label>Text file preview</label><textarea class="export-preview" readonly rows="14">${escapeHtml(ex.text)}</textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn" id="exportCopyBtn" onclick="copyReportText('${id}', this)">Copy Text</button>
      ${canFolder ? `<button class="btn" onclick="exportReportToFolder('${id}')">Save to Folder…</button>` : ''}
      ${canShare ? `<button class="btn" onclick="shareReportZip('${id}')">Share…</button>` : ''}
      <button class="btn btn-primary" onclick="downloadReportZip('${id}', this)">Download .zip</button>
    </div>`, true);
}

async function copyReportText(id, btn) {
  const r = getReport(id);
  if (!r) return;
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(buildReportExport(r).text);
    btn.textContent = 'Copied!';
  } catch (e) {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
}

async function downloadReportZip(id, btn) {
  const r = getReport(id);
  if (!r) return;
  const original = btn.textContent;
  btn.textContent = 'Building…'; btn.disabled = true;
  try {
    const { blob, folder } = await buildReportZip(r);
    await saveBlobFile(blob, folder + '.zip', 'ZIP archive', 'application/zip', '.zip');
  } catch (e) {
    console.error(e);
    alert('Export failed: ' + e.message);
  }
  btn.textContent = original; btn.disabled = false;
}

async function shareReportZip(id) {
  const r = getReport(id);
  if (!r) return;
  try {
    const { blob, folder } = await buildReportZip(r);
    const file = new File([blob], folder + '.zip', { type: 'application/zip' });
    await navigator.share({ files: [file], title: r.title || 'Site Visit Report' });
  } catch (e) {
    if (!e || e.name !== 'AbortError') { console.error(e); alert('Sharing failed: ' + (e && e.message)); }
  }
}

// Desktop Chrome/Edge only: writes a real folder straight to disk.
async function exportReportToFolder(id) {
  const r = getReport(id);
  if (!r) return;
  try {
    const parent = await window.showDirectoryPicker({ mode: 'readwrite' });
    const { folder, files } = await prepareExportFiles(r);
    const sub = await parent.getDirectoryHandle(folder, { create: true });
    for (const f of files) {
      const fh = await sub.getFileHandle(f.name, { create: true });
      const w = await fh.createWritable();
      await w.write(f.bytes);
      await w.close();
    }
    closeModal();
    toast('Saved folder “' + folder + '”');
  } catch (e) {
    if (!e || e.name !== 'AbortError') { console.error(e); alert('Could not save the folder: ' + (e && e.message)); }
  }
}

// ---------- Print / Save as PDF ----------
async function printReport(id) {
  const r = getReport(id);
  if (!r) return;
  const missing = photoIdsOf(r).filter((pid) => photoCache[pid] === undefined);
  if (missing.length) await loadPhotos(missing);
  const photos = (n) => n.photos.length
    ? `<div class="pp">${n.photos.map((p) => `<figure><img src="${photoCache[p.id] || ''}"><figcaption>${escapeHtml(p.caption || '')}</figcaption></figure>`).join('')}</div>`
    : '';
  document.getElementById('printArea').innerHTML = `
    <div class="meta"><h1>${escapeHtml(r.title || 'Site Visit Report')}</h1>
      <div>${r.project ? '<b>Project #:</b> ' + escapeHtml(r.project) + ' &nbsp; ' : ''}<b>Date:</b> ${fmtDate(r.date)}${r.location ? ' &nbsp; <b>Location:</b> ' + escapeHtml(r.location) : ''}</div></div>
    ${r.summary ? `<h3>Summary of Observations</h3><div style="white-space:pre-wrap">${escapeHtml(r.summary)}</div>` : ''}
    ${r.attendees.length ? `<h3>Attendees</h3><table><tr><th>Name</th><th>Company / Role</th></tr>${r.attendees.map((a) => `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.company)}</td></tr>`).join('')}</table>` : ''}
    <h3>Field Notes</h3>
    ${allNoteItems(r).map((it) => `<div class="pn ${it.sub ? 's' : ''}"><b>${it.label}${it.sub ? '' : '.'}</b><span style="white-space:pre-wrap">${escapeHtml(it.note.text)}</span>${photos(it.note)}</div>`).join('')}`;
  setTimeout(() => window.print(), 150);
}

// ---------- Backup & Restore (all reports + photos in one .json file) ----------
function renderBackup() {
  const photoCount = data.reports.reduce((s, r) => s + countPhotos(r), 0);
  return `
    <div class="page-header">
      <div><h1>Backup &amp; Restore</h1><p class="subtitle">Reports live in this browser's storage on this device. Keep a backup file in Files / iCloud Drive in case Safari ever clears site data.</p></div>
    </div>
    <div class="panel">
      <h2>Backup</h2>
      <p class="subtitle" style="margin-bottom:14px;">${data.reports.length} report${data.reports.length === 1 ? '' : 's'} · ${photoCount} photo${photoCount === 1 ? '' : 's'} on this device. The backup file includes the photos.</p>
      <button class="btn btn-primary" onclick="exportBackup(this)">Download Backup (.json)</button>
    </div>
    <div class="panel">
      <h2>Restore</h2>
      <p class="subtitle" style="margin-bottom:14px;">Pick a backup file to load. Reports with the same ID are replaced; everything else on this device is kept.</p>
      <button class="btn" onclick="document.getElementById('fileImport').click()">Choose Backup File…</button>
    </div>`;
}

async function exportBackup(btn) {
  const original = btn.textContent;
  btn.textContent = 'Building…'; btn.disabled = true;
  try {
    await saveNow();
    const photos = await dbAll('photos');
    const blob = new Blob([JSON.stringify({ app: 'sitenotes', version: 1, exported: Date.now(), reports: data.reports, photos })], { type: 'application/json' });
    await saveBlobFile(blob, 'site-notes-backup-' + localTodayISO() + '.json', 'JSON backup', 'application/json', '.json');
  } catch (e) {
    console.error(e);
    alert('Backup failed: ' + e.message);
  }
  btn.textContent = original; btn.disabled = false;
}

async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'sitenotes' || !Array.isArray(d.reports)) throw new Error('not a Site Notes backup');
    for (const p of d.photos || []) { await dbPut('photos', p); delete photoCache[p.id]; }
    for (const r of d.reports) await dbPut('reports', r);
    data.reports = await dbAll('reports');
    toast('Restored ' + d.reports.length + ' report' + (d.reports.length === 1 ? '' : 's'));
    route();
  } catch (e) {
    alert('That file is not a valid Site Notes backup.');
  }
}
