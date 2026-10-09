const $ = (s) => document.querySelector(s);
const cid = localStorage.getItem('cid') || (localStorage.setItem('cid', crypto.randomUUID()), localStorage.getItem('cid'));
const hdr = () => ({ 'x-client-id': cid, ...(localStorage.getItem('admin') ? { 'x-admin': localStorage.getItem('admin') } : {}) });

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method, body: body && JSON.stringify(body),
    headers: { ...hdr(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'เกิดข้อผิดพลาด ' + r.status);
  return j;
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}
const app = $('#app');
const toast = (e) => alert(e.message || e);

// ---------- routing ----------
let S = null; // สถานะหน้าอัลบั้ม
async function route() {
  closeLb();
  const m = location.hash.match(/^#\/a\/([\w-]+)/);
  try { m ? await albumView(m[1]) : (S = null, await home()); }
  catch (e) { app.replaceChildren(el('p', { class: 'mut' }, e.message), el('a', { href: '#/', class: 'back' }, '← กลับ')); }
}
addEventListener('hashchange', route);

// ---------- หน้าแรก: รายการอัลบั้ม ----------
async function home() {
  const search = el('input', { type: 'search', class: 'search', placeholder: '🔍 ค้นหาชื่ออัลบั้ม...', autocomplete: 'off', oninput: () => show() });
  const box = el('div', {}, el('p', { class: 'mut' }, 'กำลังโหลด...'));
  app.replaceChildren(
    el('div', { class: 'bar' }, el('h1', {}, '📷 PhotoShare'), el('button', { onclick: newAlbum }, '+ สร้างอัลบั้ม')),
    search, box);
  const albums = await api('/albums');
  const card = (a) => el('a', { class: 'card', href: '#/a/' + a.id },
    a.cover ? el('img', { src: `/api/photos/${a.cover}/thumb`, loading: 'lazy', alt: '' }) : el('div', { class: 'ph' }, '📷'),
    el('div', { class: 'name' }, a.name));
  function show() {
    const q = search.value.trim().toLowerCase();
    const list = albums.filter((a) => a.name.toLowerCase().includes(q));
    box.replaceChildren(list.length
      ? el('div', { class: 'albums' }, list.map(card))
      : el('p', { class: 'mut' }, albums.length ? `ไม่พบอัลบั้มที่ตรงกับ "${search.value.trim()}"` : 'ยังไม่มีอัลบั้ม กด "สร้างอัลบั้ม" เพื่อเริ่มต้น'));
  }
  show();
}
async function newAlbum() {
  const name = prompt('ชื่ออัลบั้ม');
  if (!name?.trim()) return;
  try { location.hash = '#/a/' + (await api('/albums', { method: 'POST', body: { name: name.trim() } })).id; } catch (e) { toast(e); }
}

// ---------- หน้าอัลบั้ม ----------
async function albumView(id) {
  S = { id, photos: [], next: null, sel: null, album: null, lb: null };
  app.replaceChildren(el('p', { class: 'mut' }, 'กำลังโหลด...'));
  await loadMore();
  draw();
}
async function loadMore() {
  const d = await api(`/albums/${S.id}/photos` + (S.next ? `?pageToken=${encodeURIComponent(S.next)}` : ''));
  S.album = d.album; S.photos.push(...d.photos); S.next = d.nextPageToken;
}

let statusText = '';
function draw() {
  const { album, sel } = S;
  const fileIn = el('input', { type: 'file', accept: 'image/*', multiple: '', hidden: '', onchange: (e) => { enqueue([...e.target.files]); e.target.value = ''; } });
  const grid = el('div', { class: 'photos' }, S.photos.map((p, i) =>
    el('div', { class: 'ph' + (sel?.has(p.id) ? ' on' : ''), onclick: (e) => (S.sel ? pick(p, e.currentTarget) : openLb(i)) },
      el('img', { src: `/api/photos/${p.id}/thumb`, loading: 'lazy', alt: p.name }))));
  app.replaceChildren(
    el('div', { class: 'bar' },
      el('a', { href: '#/', class: 'back' }, '← อัลบั้ม'),
      el('h1', {}, album.name),
      el('button', { onclick: () => fileIn.click() }, 'อัปโหลด'), fileIn,
      S.photos.length > 0 && el('button', { class: 'sec', onclick: () => { S.sel = S.sel ? null : new Set(); draw(); } }, sel ? 'ยกเลิก' : 'เลือกรูป'),
      sel && el('button', { class: 'sec', onclick: selectAll }, 'เลือกทั้งหมด'),
      sel && el('button', { onclick: downloadSelected }, 'ดาวน์โหลด (', el('span', { class: 'selcount' }, String(sel.size)), ')'),
      sel && S.photos.some((p) => p.canDelete) && el('button', { class: 'danger', onclick: delSelected }, 'ลบ (', el('span', { class: 'selcount' }, String(sel.size)), ')'),
      album.canDelete && el('button', { class: 'danger', onclick: delAlbum }, 'ลบอัลบั้ม')),
    el('p', { class: 'mut', id: 'status' }, statusText),
    grid,
    S.next && el('button', { class: 'sec more', onclick: async () => { await loadMore(); draw(); } }, 'โหลดเพิ่ม'),
    !S.photos.length && el('p', { class: 'mut' }, 'ยังไม่มีรูป ลากรูปมาวางหรือกด "อัปโหลด"'));
}
const updCount = () => document.querySelectorAll('.selcount').forEach((s) => { s.textContent = S.sel.size; });
function pick(p, node) {
  S.sel.has(p.id) ? S.sel.delete(p.id) : S.sel.add(p.id);
  node.classList.toggle('on', S.sel.has(p.id));
  updCount();
}
function selectAll() {
  S.sel = S.sel.size === S.photos.length ? new Set() : new Set(S.photos.map((p) => p.id));
  document.querySelectorAll('.photos .ph').forEach((n, i) => n.classList.toggle('on', S.sel.has(S.photos[i].id)));
  updCount();
}
// 1 รูป = ดาวน์โหลดไฟล์ตรง ๆ, หลายรูป = ให้ server รวมเป็น zip
function downloadSelected() {
  const ids = [...S.sel];
  if (!ids.length) return toast('ยังไม่ได้เลือกรูป');
  if (ids.length > 200) return toast('ดาวน์โหลดได้ครั้งละไม่เกิน 200 รูป');
  if (ids.length === 1) {
    const a = el('a', { href: `/api/photos/${ids[0]}/file?download=1` });
    document.body.append(a); a.click(); a.remove();
    return;
  }
  const f = el('form', { method: 'POST', action: '/api/photos/zip', style: 'display:none' },
    el('input', { name: 'ids', value: ids.join(',') }), el('input', { name: 'name', value: S.album.name }));
  document.body.append(f); f.submit(); f.remove();
}

// ---------- อัปโหลด (คิว 3 ไฟล์พร้อมกัน) ----------
let queue = [], active = 0, done = 0, total = 0, errs = [];
function enqueue(files) {
  files = files.filter((f) => f.type.startsWith('image/'));
  if (!files.length || !S) return;
  total += files.length;
  queue.push(...files.map((f) => ({ f, id: S.id })));
  pump();
}
function pump() {
  while (active < 3 && queue.length) {
    const { f, id } = queue.shift();
    active++;
    uploadOne(id, f).then(() => done++).catch((e) => errs.push(`${f.name}: ${e.message}`))
      .finally(async () => {
        active--;
        setStatus();
        if (!queue.length && !active) await finishUploads(id); else pump();
      });
  }
  setStatus();
}
function setStatus() {
  statusText = active || queue.length ? `กำลังอัปโหลด ${done + errs.length}/${total}...` : statusText;
  const s = $('#status'); if (s) s.textContent = statusText;
}
async function finishUploads(id) {
  statusText = `อัปโหลดเสร็จ ${done} รูป` + (errs.length ? ` · ผิดพลาด ${errs.length}: ${errs[0]}` : '');
  done = total = 0; errs = [];
  if (S?.id === id) { S.photos = []; S.next = null; await loadMore(); draw(); }
}
function uploadOne(id, file) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/albums/${id}/photos`);
    for (const [k, v] of Object.entries(hdr())) x.setRequestHeader(k, v);
    x.onload = () => {
      const j = (() => { try { return JSON.parse(x.responseText); } catch { return {}; } })();
      x.status < 300 ? res(j) : rej(new Error(j.error || x.status));
    };
    x.onerror = () => rej(new Error('เครือข่ายขัดข้อง'));
    const fd = new FormData(); fd.append('file', file); x.send(fd);
  });
}
// ลากวาง
let dragN = 0;
addEventListener('dragenter', (e) => { if (S && e.dataTransfer?.types.includes('Files')) { dragN++; document.body.classList.add('drag'); } });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drag'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; document.body.classList.remove('drag'); if (S) enqueue([...e.dataTransfer.files]); });

// ---------- ลบ ----------
async function delAlbum() {
  if (!confirm(`ลบอัลบั้ม "${S.album.name}" และรูปทั้งหมดในอัลบั้ม?`)) return;
  try { await api('/albums/' + S.id, { method: 'DELETE' }); location.hash = '#/'; } catch (e) { toast(e); }
}
async function delSelected() {
  const ids = [...S.sel].filter((id) => S.photos.find((p) => p.id === id)?.canDelete);
  const skipped = S.sel.size - ids.length;
  if (!ids.length) return toast('รูปที่เลือกไม่มีสิทธิ์ลบ');
  if (!confirm(`ลบ ${ids.length} รูปที่เลือก?` + (skipped ? `\n(อีก ${skipped} รูปไม่มีสิทธิ์ลบ จะไม่ถูกลบ)` : ''))) return;
  const failed = [];
  for (let i = 0; i < ids.length; i += 4)
    await Promise.all(ids.slice(i, i + 4).map((id) => api('/photos/' + id, { method: 'DELETE' }).catch(() => failed.push(id))));
  S.photos = S.photos.filter((p) => !ids.includes(p.id) || failed.includes(p.id));
  S.sel = null; draw();
  if (failed.length) toast(`ลบไม่สำเร็จ ${failed.length} รูป`);
}

// ---------- ดูรูปเต็ม ----------
let lbEl = null;
const openLb = (i) => { S.lb = i; renderLb(); };
function closeLb() { lbEl?.remove(); lbEl = null; if (S) S.lb = null; }
function renderLb() {
  lbEl?.remove();
  const p = S.photos[S.lb];
  const src = (q) => (q.type === 'image/gif' ? `/api/photos/${q.id}/file` : `/api/photos/${q.id}/preview`);
  lbEl = el('div', { class: 'lb', onclick: (e) => e.target === lbEl && closeLb() },
    el('img', { src: src(p), alt: p.name }),
    el('div', { class: 'lbbar' },
      el('span', {}, `${S.lb + 1}/${S.photos.length} · ${p.name}`),
      el('a', { class: 'btn', href: `/api/photos/${p.id}/file?download=1`, download: p.name }, 'ดาวน์โหลด'),
      p.canDelete && el('button', { class: 'danger', onclick: delOne }, 'ลบ'),
      el('button', { class: 'sec', onclick: closeLb }, 'ปิด')),
    el('button', { class: 'nav l', onclick: () => step(-1) }, '‹'),
    el('button', { class: 'nav r', onclick: () => step(1) }, '›'));
  document.body.append(lbEl);
  for (const n of [S.photos[S.lb - 1], S.photos[S.lb + 1]]) if (n) new Image().src = src(n); // preload รูปข้างเคียง
}
function step(d) { S.lb = (S.lb + d + S.photos.length) % S.photos.length; renderLb(); }
async function delOne() {
  const p = S.photos[S.lb];
  if (!confirm(`ลบรูป "${p.name}"?`)) return;
  try {
    await api('/photos/' + p.id, { method: 'DELETE' });
    S.photos.splice(S.lb, 1);
    draw();
    if (!S.photos.length) return closeLb();
    S.lb = Math.min(S.lb, S.photos.length - 1); renderLb();
  } catch (e) { toast(e); }
}
addEventListener('keydown', (e) => {
  if (!lbEl) return;
  if (e.key === 'Escape') closeLb();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

route();
