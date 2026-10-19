/* Сервер «Контроль» для iPhone (веб-версия):
   1) раздаёт приложение из папки www;
   2) хранит расписание напоминаний каждого телефона и присылает их через Web Push.
   Без сторонних библиотек — только встроенные модули Node.js. */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const WWW = path.join(__dirname, 'www');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'subs.json');
const KEYS_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/nurmuhammetagamuradov-afk/control-app';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- base64url ---------- */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ---------- ключи VAPID ---------- */
function loadVapid() {
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) return { pub: process.env.VAPID_PUBLIC, priv: process.env.VAPID_PRIVATE };
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (e) {}
  const k = generateVapid();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(k));
  console.warn('VAPID_PUBLIC/VAPID_PRIVATE не заданы — созданы временные ключи. Задайте их в переменных окружения, иначе после перезапуска напоминания придётся включить заново.');
  return k;
}
function generateVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { pub: b64u(raw), priv: jwk.d };
}
const VAPID = loadVapid();
const vapidPubRaw = unb64u(VAPID.pub);
const vapidKey = crypto.createPrivateKey({
  key: { kty: 'EC', crv: 'P-256', x: b64u(vapidPubRaw.subarray(1, 33)), y: b64u(vapidPubRaw.subarray(33, 65)), d: VAPID.priv },
  format: 'jwk'
});

function vapidJwt(audience) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKey, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}

/* ---------- шифрование сообщения (RFC 8291, aes128gcm) ---------- */
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function encrypt(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPub = ecdh.generateKeys();
  const secret = ecdh.computeSecret(uaPub);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

function sendPush(sub, data) {
  return new Promise(resolve => {
    let url;
    try { url = new URL(sub.endpoint); } catch (e) { return resolve(400); }
    const body = encrypt(sub, JSON.stringify(data));
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        TTL: '1800',
        Urgency: 'high',
        Authorization: 'vapid t=' + vapidJwt(url.origin) + ', k=' + VAPID.pub
      },
      timeout: 15000
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

/* ---------- хранилище расписаний ---------- */
let DB = {};
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(DB), () => {}), 500); }
const subId = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);

function validSub(s) {
  return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 120).map(i => ({
    at: Number(i.at), title: String(i.title || '').slice(0, 120), body: String(i.body || '').slice(0, 300), screen: i.screen === 'stats' ? 'stats' : 'today'
  })).filter(i => Number.isFinite(i.at)).sort((a, b) => a.at - b.at);
}

/* ---------- отправка по расписанию ---------- */
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const now = Date.now();
    for (const [id, rec] of Object.entries(DB)) {
      const due = rec.items.filter(i => i.at <= now);
      if (!due.length) continue;
      rec.items = rec.items.filter(i => i.at > now);
      persist();
      // если сервер спал — старые напоминания не шлём пачкой, только последнее
      const fresh = due.filter(i => now - i.at < 30 * 60000);
      const toSend = fresh.length ? [fresh[fresh.length - 1]] : [];
      for (const n of toSend) {
        const code = await sendPush(rec.sub, n);
        if (code === 404 || code === 410) { delete DB[id]; persist(); break; }
        if (code >= 400 || code === 0) console.warn('push', id, code);
      }
    }
    // удаляем телефоны, которые не выходили на связь 30 дней
    for (const [id, rec] of Object.entries(DB)) if (now - (rec.seen || 0) > 30 * 86400000) { delete DB[id]; persist(); }
  } finally { ticking = false; }
}
setInterval(tick, 15000);

/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 200000) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/key' && req.method === 'GET') return json(res, 200, { key: VAPID.pub });
    if (p === '/api/health') return json(res, 200, { ok: true, phones: Object.keys(DB).length });
    if (p === '/api/plan' && req.method === 'POST') {
      const b = await readJson(req);
      if (!validSub(b.sub)) return json(res, 400, { error: 'sub' });
      const id = subId(b.sub.endpoint);
      DB[id] = { sub: b.sub, items: cleanItems(b.items).filter(i => i.at > Date.now() - 60000), seen: Date.now() };
      persist();
      return json(res, 200, { ok: true, count: DB[id].items.length });
    }
    if (p === '/api/test' && req.method === 'POST') {
      const b = await readJson(req);
      if (!validSub(b.sub)) return json(res, 400, { error: 'sub' });
      const code = await sendPush(b.sub, { title: 'Проверка связи', body: 'Контроль работает. Отговорок больше нет.', screen: 'today' });
      return json(res, code >= 200 && code < 300 ? 200 : 502, { status: code });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // статические файлы приложения
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let file = path.normalize(path.join(WWW, decodeURIComponent(p)));
    if (!file.startsWith(WWW)) { res.writeHead(403); return res.end(); }
    if (p.endsWith('/')) file = path.join(file, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    json(res, 400, { error: 'bad request' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log('Контроль: сервер на порту ' + PORT));
module.exports = { encrypt, vapidJwt, VAPID, server, generateVapid };
