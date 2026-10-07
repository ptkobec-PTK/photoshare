import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import rateLimit from 'express-rate-limit';
import { google } from 'googleapis';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const {
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
  ROOT_FOLDER_NAME = 'PhotoShare', ROOT_FOLDER_ID = '', ROOT_ALBUM_NAME = 'รูปที่ยังไม่ได้จัดอัลบั้ม', DELETE_MODE = 'owner', ADMIN_PASSWORD = '',
  PORT = 3000, CACHE_DIR = './cache',
} = process.env;

// ---------- Drive ----------
const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth });
const FOLDER = 'application/vnd.google-apps.folder';
let ROOT, THUMBS;

async function ensureFolder(name, parent) {
  const q = `name='${name}' and mimeType='${FOLDER}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
  const { data } = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  if (data.files[0]) return data.files[0].id;
  const r = await drive.files.create({
    requestBody: { name, mimeType: FOLDER, parents: parent ? [parent] : undefined }, fields: 'id',
  });
  return r.data.id;
}
const trash = (id) => drive.files.update({ fileId: id, requestBody: { trashed: true } });
const download = async (id) =>
  Buffer.from((await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'arraybuffer' })).data);

// ---------- helpers ----------
const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e.message);
  const s = Number.isInteger(e.status) ? e.status : e.code >= 400 && e.code < 600 ? e.code : 500;
  res.status(s).json({ error: s === 404 ? 'ไม่พบข้อมูล' : e.message });
});
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const me = (req) => (req.get('x-client-id') ? hash(req.get('x-client-id')) : null);
const isAdmin = (req) => !!ADMIN_PASSWORD && req.get('x-admin') === ADMIN_PASSWORD;
const canManage = (a, req) =>
  DELETE_MODE === 'public' || isAdmin(req) || (!!me(req) && a.appProperties?.owner === me(req));
const canDelAlbum = (a, req) => !a.isRoot && canManage(a, req);
const canDelPhoto = (p, a, req) =>
  canManage(a, req) || (!!me(req) && p.appProperties?.uploader === me(req));
const safeName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'photo';

// อัลบั้ม = โฟลเดอร์ย่อยโดยตรงของ ROOT เท่านั้น (กันไม่ให้เข้าถึงไฟล์อื่นนอกขอบเขตใน Drive)
async function getAlbum(id) {
  if (id === ROOT) { // รูปที่วางตรง ๆ ในโฟลเดอร์หลัก แสดงเป็นอัลบั้มพิเศษ
    const { data } = await drive.files.get({ fileId: ROOT, fields: 'id,appProperties' });
    return { id: ROOT, name: ROOT_ALBUM_NAME, isRoot: true, appProperties: data.appProperties || {} };
  }
  const { data } = await drive.files.get({ fileId: id, fields: 'id,name,createdTime,mimeType,parents,appProperties,trashed' });
  if (data.mimeType !== FOLDER || data.trashed || !data.parents?.includes(ROOT) || data.name === '_thumbs') fail(404);
  data.appProperties ||= {};
  return data;
}
const albumOk = new Map(); // albumId -> เวลาหมดอายุของการตรวจสอบ
async function getPhoto(id) {
  const { data } = await drive.files.get({ fileId: id, fields: 'id,name,mimeType,parents,appProperties,trashed' });
  if (!data.mimeType?.startsWith('image/') || data.trashed || !data.parents?.[0]) fail(404);
  const pid = data.parents[0];
  if (pid !== ROOT && !(albumOk.get(pid) > Date.now())) { await getAlbum(pid); albumOk.set(pid, Date.now() + 60000); }
  data.appProperties ||= {};
  return data;
}

// แคชบนดิสก์ (thumbnail/preview) + ให้เบราว์เซอร์แคชยาว ๆ ทำให้ไม่ต้องแตะ Drive ซ้ำ
async function cached(key, make) {
  const f = path.join(CACHE_DIR, key);
  try { return await fs.readFile(f); } catch {}
  const buf = await make();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(f, buf).catch(() => {});
  return buf;
}
const IMG = { 'Cache-Control': 'public, max-age=31536000, immutable' };
let albumsCache = { t: 0, v: [] };

// ดึงภาพย่อที่ Drive สร้างให้ (เร็วกว่าโหลดต้นฉบับ และรองรับ HEIC)
async function driveThumbnail(id, size) {
  const { data } = await drive.files.get({ fileId: id, fields: 'thumbnailLink' });
  if (!data.thumbnailLink) fail(404);
  const { token } = await auth.getAccessToken();
  const r = await fetch(data.thumbnailLink.replace(/=s\d+$/, `=s${size}`), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) fail(404);
  return Buffer.from(await r.arrayBuffer());
}
async function makeThumb(p) {
  let src;
  try { src = await driveThumbnail(p.id, 400); } catch { src = await download(p.id); }
  return sharp(src).rotate().resize(400, 400, { fit: 'cover' }).webp({ quality: 75 }).toBuffer();
}
// เก็บ thumbnail ที่สร้างทีหลังไว้ใน Drive เพื่อไม่ต้องสร้างซ้ำเมื่อ server restart
function saveThumb(p, buf) {
  drive.files.create({
    requestBody: { name: 'thumb.webp', parents: [THUMBS], appProperties: { kind: 'thumb' } },
    media: { mimeType: 'image/webp', body: Readable.from(buf) }, fields: 'id',
  }).then((t) => drive.files.update({ fileId: p.id, requestBody: { appProperties: { thumbId: t.data.id } } })).catch(() => {});
}
let genRunning = 0; const genWaiters = [];
async function limited(fn) {
  while (genRunning >= 4) await new Promise((r) => genWaiters.push(r));
  genRunning++;
  try { return await fn(); } finally { genRunning--; genWaiters.shift()?.(); }
}
const noCover = new Map();
async function fillCovers(albums) {
  const need = albums.filter((a) => !a.appProperties.cover && !(noCover.get(a.id) > Date.now()));
  for (let i = 0; i < need.length; i += 5) {
    await Promise.all(need.slice(i, i + 5).map(async (a) => {
      try {
        const { data } = await drive.files.list({
          q: `'${a.id}' in parents and trashed=false and mimeType contains 'image/'`,
          fields: 'files(id)', orderBy: 'createdTime desc', pageSize: 1,
        });
        const id = data.files[0]?.id;
        if (!id) return noCover.set(a.id, Date.now() + 5 * 60000);
        a.appProperties.cover = id;
        drive.files.update({ fileId: a.id, requestBody: { appProperties: { cover: id } } }).catch(() => {});
      } catch {}
    }));
  }
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public', { maxAge: 0 }));
app.param('id', (req, res, next, id) => (/^[\w-]{10,80}$/.test(id) ? next() : res.status(404).json({ error: 'ไม่พบข้อมูล' })));
const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

// อัลบั้ม
app.get('/api/albums', h(async (req, res) => {
  if (Date.now() - albumsCache.t > 10000) {
    const files = [];
    let pageToken;
    do {
      const { data } = await drive.files.list({
        q: `'${ROOT}' in parents and trashed=false and mimeType='${FOLDER}'`,
        fields: 'nextPageToken,files(id,name,createdTime,appProperties)', orderBy: 'createdTime desc',
        pageSize: 200, pageToken,
      });
      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    const albums = files.filter((a) => a.name !== '_thumbs');
    albums.forEach((a) => { a.appProperties ||= {}; });
    await fillCovers(albums);
    const { data: ri } = await drive.files.list({
      q: `'${ROOT}' in parents and trashed=false and mimeType contains 'image/'`,
      fields: 'files(id)', orderBy: 'createdTime desc', pageSize: 1,
    });
    if (ri.files[0]) albums.unshift({ id: ROOT, name: ROOT_ALBUM_NAME, isRoot: true, appProperties: { cover: ri.files[0].id } });
    albumsCache = { t: Date.now(), v: albums };
  }
  res.json(albumsCache.v.map((a) => ({
    id: a.id, name: a.name, createdTime: a.createdTime,
    cover: a.appProperties.cover || null, canDelete: canDelAlbum(a, req),
  })));
}));

app.post('/api/albums', writeLimit, h(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'กรุณาใส่ชื่ออัลบั้ม');
  if (!me(req)) fail(400, 'missing client id');
  const r = await drive.files.create({
    requestBody: { name, mimeType: FOLDER, parents: [ROOT], appProperties: { kind: 'album', owner: me(req) } },
    fields: 'id',
  });
  albumsCache.t = 0;
  res.json({ id: r.data.id });
}));

app.delete('/api/albums/:id', writeLimit, h(async (req, res) => {
  const album = await getAlbum(req.params.id);
  if (album.isRoot) fail(403, 'ลบโฟลเดอร์หลักไม่ได้ (ลบรูปทีละรูปได้)');
  if (!canDelAlbum(album, req)) fail(403, 'ไม่มีสิทธิ์ลบอัลบั้มนี้');
  // thumbnail อยู่คนละโฟลเดอร์ ต้องไล่ลบเอง
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q: `'${album.id}' in parents and trashed=false`, fields: 'nextPageToken,files(id,appProperties)',
      pageSize: 200, pageToken,
    });
    for (let i = 0; i < data.files.length; i += 5) {
      await Promise.all(data.files.slice(i, i + 5).map(async (f) => {
        if (f.appProperties?.thumbId) await trash(f.appProperties.thumbId).catch(() => {});
        fs.rm(path.join(CACHE_DIR, 't_' + f.id), { force: true }); fs.rm(path.join(CACHE_DIR, 'p_' + f.id), { force: true });
      }));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  await trash(album.id); // ย้ายลงถังขยะของ Drive (กู้คืนได้)
  albumsCache.t = 0;
  res.json({ ok: true });
}));

// รูปในอัลบั้ม
app.get('/api/albums/:id/photos', h(async (req, res) => {
  const album = await getAlbum(req.params.id);
  const { data } = await drive.files.list({
    q: `'${album.id}' in parents and trashed=false and mimeType contains 'image/'`,
    fields: 'nextPageToken,files(id,name,mimeType,createdTime,size,appProperties)',
    orderBy: 'createdTime desc', pageSize: 200, pageToken: req.query.pageToken || undefined,
  });
  if (!album.appProperties.cover && data.files[0] && !req.query.pageToken) {
    drive.files.update({ fileId: album.id, requestBody: { appProperties: { cover: data.files[0].id } } })
      .then(() => { albumsCache.t = 0; }).catch(() => {});
  }
  res.json({
    album: { id: album.id, name: album.name, canDelete: canDelAlbum(album, req) },
    photos: data.files.map((p) => ({
      id: p.id, name: p.name, type: p.mimeType, size: Number(p.size || 0),
      createdTime: p.createdTime, canDelete: canDelPhoto(p, album, req),
    })),
    nextPageToken: data.nextPageToken || null,
  });
}));

app.post('/api/albums/:id/photos', writeLimit, upload.single('file'), h(async (req, res) => {
  const album = await getAlbum(req.params.id);
  const f = req.file;
  if (!me(req)) fail(400, 'missing client id');
  if (!f || !OK.has(f.mimetype)) fail(400, 'รองรับเฉพาะไฟล์ JPG, PNG, WebP, GIF, AVIF');
  let thumb;
  try { thumb = await sharp(f.buffer).rotate().resize(400, 400, { fit: 'cover' }).webp({ quality: 75 }).toBuffer(); }
  catch { fail(400, 'ไฟล์รูปเสียหรืออ่านไม่ได้'); }

  const t = await drive.files.create({
    requestBody: { name: 'thumb.webp', parents: [THUMBS], appProperties: { kind: 'thumb' } },
    media: { mimeType: 'image/webp', body: Readable.from(thumb) }, fields: 'id',
  });
  const name = safeName(Buffer.from(f.originalname, 'latin1').toString('utf8'));
  const o = await drive.files.create({
    requestBody: { name, parents: [album.id], appProperties: { kind: 'photo', uploader: me(req), thumbId: t.data.id } },
    media: { mimeType: f.mimetype, body: Readable.from(f.buffer) }, fields: 'id',
  });
  fs.mkdir(CACHE_DIR, { recursive: true }).then(() => fs.writeFile(path.join(CACHE_DIR, 't_' + o.data.id), thumb)).catch(() => {});
  if (!album.appProperties.cover) {
    await drive.files.update({ fileId: album.id, requestBody: { appProperties: { cover: o.data.id } } });
    albumsCache.t = 0;
  }
  res.json({ id: o.data.id });
}));

app.delete('/api/photos/:id', writeLimit, h(async (req, res) => {
  const p = await getPhoto(req.params.id);
  const album = await getAlbum(p.parents[0]);
  if (!canDelPhoto(p, album, req)) fail(403, 'ไม่มีสิทธิ์ลบรูปนี้');
  await trash(p.id);
  if (p.appProperties.thumbId) await trash(p.appProperties.thumbId).catch(() => {});
  if (album.appProperties.cover === p.id) {
    await drive.files.update({ fileId: album.id, requestBody: { appProperties: { cover: null } } }).catch(() => {});
    albumsCache.t = 0;
  }
  fs.rm(path.join(CACHE_DIR, 't_' + p.id), { force: true }); fs.rm(path.join(CACHE_DIR, 'p_' + p.id), { force: true });
  res.json({ ok: true });
}));

// แสดง / ดาวน์โหลดรูป
app.get('/api/photos/:id/thumb', h(async (req, res) => {
  const buf = await cached('t_' + req.params.id, async () => {
    const p = await getPhoto(req.params.id);
    if (p.appProperties.thumbId) return download(p.appProperties.thumbId);
    return limited(async () => { // รูปเดิมที่ยังไม่มี thumbnail: สร้างตอนมีคนเปิดดูครั้งแรก
      const thumb = await makeThumb(p);
      saveThumb(p, thumb);
      return thumb;
    });
  });
  res.set({ ...IMG, 'Content-Type': 'image/webp' }).send(buf);
}));

app.get('/api/photos/:id/preview', h(async (req, res) => {
  const buf = await cached('p_' + req.params.id, async () => {
    const p = await getPhoto(req.params.id);
    try {
      return await sharp(await download(p.id)).rotate().resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer();
    } catch {
      return sharp(await driveThumbnail(p.id, 1800)).webp({ quality: 82 }).toBuffer();
    }
  });
  res.set({ ...IMG, 'Content-Type': 'image/webp' }).send(buf);
}));

app.get('/api/photos/:id/file', h(async (req, res) => {
  const p = await getPhoto(req.params.id);
  const r = await drive.files.get({ fileId: p.id, alt: 'media' }, { responseType: 'stream' });
  res.set({
    'Content-Type': p.mimeType,
    'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(p.name)}`,
    'Cache-Control': 'public, max-age=86400',
  });
  r.data.on('error', () => res.destroy()).pipe(res);
}));

// ---------- start ----------
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'])
  if (!process.env[k]) { console.error(`ยังไม่ได้ตั้งค่า ${k} ในไฟล์ .env`); process.exit(1); }
ROOT = ROOT_FOLDER_ID || await ensureFolder(ROOT_FOLDER_NAME); // ใส่ ROOT_FOLDER_ID เพื่อผูกกับโฟลเดอร์ด้วยรหัส ย้าย/เปลี่ยนชื่อได้อิสระ
try { await drive.files.get({ fileId: ROOT, fields: 'id' }); }
catch { console.error('เข้าถึงโฟลเดอร์หลักไม่ได้ ตรวจ ROOT_FOLDER_ID และสิทธิ์ drive (ต้องรัน npm run auth ใหม่หลังเปลี่ยน scope)'); process.exit(1); }
THUMBS = await ensureFolder('_thumbs', ROOT);
app.listen(PORT, () => console.log(`PhotoShare พร้อมที่ http://localhost:${PORT}  (DELETE_MODE=${DELETE_MODE})`));
