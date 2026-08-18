const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MONTH_MS = 30 * 24 * 3600 * 1000;
const TOKEN_TTL = 7 * 24 * 3600 * 1000;   // token 有效期 7 天
const MAX_TEXT = 50000;                    // 单条消息文字上限
const BODY_CAP = 140 * 1024 * 1024;        // 请求体上限（略大于 100MB 图片）

// 安全响应头：防点击劫持 / MIME 嗅探 / 收窄 XSS 影响面
function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'");
}

// 轻量内存限速（滑动窗口）：防爆破 / 资源滥用
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let arr = rateBuckets.get(key) || [];
  arr = arr.filter((t) => now - t < windowMs);
  if (arr.length >= max) { rateBuckets.set(key, arr); return false; }
  arr.push(now); rateBuckets.set(key, arr); return true;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function ensureDirs() {
  for (const d of [DATA_DIR, UPLOADS_DIR, PUBLIC_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function jf(name) { return path.join(DATA_DIR, name); }

let users = readJson(jf('users.json'), []);
let rooms = readJson(jf('rooms.json'), []);
let messages = readJson(jf('messages.json'), []);
let invites = readJson(jf('invites.json'), []);
let theme = readJson(jf('theme.json'), { bgImage: null, colorTheme: 'blue' });
let sessions = readJson(jf('sessions.json'), {}); // token -> { email, exp }
let todos = readJson(jf('todos.json'), []);        // { id, roomId, text, done, by, time }
let notes = readJson(jf('notes.json'), []);        // { roomId, text, updatedAt }
let stats = readJson(jf('stats.json'), { date: '', onlineSec: {}, lastTs: {} }); // 摸鱼指数：{ date, onlineSec:{email:秒}, lastTs:{email:ts} }
// 启动时清理过期 token
for (const k in sessions) if (sessions[k] && sessions[k].exp && sessions[k].exp < Date.now()) delete sessions[k];

function saveUsers() { writeJson(jf('users.json'), users); }
function saveRooms() { writeJson(jf('rooms.json'), rooms); }
function saveMessages() { writeJson(jf('messages.json'), messages); }
function saveInvites() { writeJson(jf('invites.json'), invites); }
function saveTheme() { writeJson(jf('theme.json'), theme); }
function saveSessions() { writeJson(jf('sessions.json'), sessions); }
function saveTodos() { writeJson(jf('todos.json'), todos); }
function saveNotes() { writeJson(jf('notes.json'), notes); }
function saveStats() { writeJson(jf('stats.json'), stats); }

// 今日日期（本地时区，YYYY-MM-DD）
function todayStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 跨天则重置在线时长累计
function ensureStatsDate() {
  const t = todayStr();
  if (stats.date !== t) { stats.date = t; stats.onlineSec = {}; stats.lastTs = {}; }
}

// 种子管理员（邮箱登录）。生产请用 ADMIN_PASS 环境变量覆盖默认弱口令。
if (users.length === 0) {
  const adminPass = process.env.ADMIN_PASS || 'admin123';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(adminPass, salt, 64).toString('hex');
  users.push({ email: 'admin@office.chat', salt, hash, nickname: '管理员', role: 'admin', invite: null });
  saveUsers();
}
if ((process.env.ADMIN_PASS || 'admin123') === 'admin123') {
  console.warn('[安全警告] 正在使用默认管理员密码 admin123，上线前请通过 ADMIN_PASS 环境变量修改！');
}

// 昵称强制 xx包：取输入最后一个字 + 包
function toBaoNickname(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  const chars = Array.from(s);
  return chars[chars.length - 1] + '包';
}

function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function isAdmin(email) { const u = users.find((x) => x.email === email); return !!(u && u.role === 'admin'); }
function nickOf(email) { const u = users.find((x) => x.email === email); return u ? u.nickname : email; }

// 在线状态：email -> {roomId, ts}
const presence = new Map();

function currentUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const entry = sessions[m[1]];
  if (!entry) return null;
  if (entry.exp && entry.exp < Date.now()) { delete sessions[m[1]]; saveSessions(); return null; }
  return entry.email;
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// CORS：支持前端挂 GitHub Pages 等跨域源。FRONTEND_ORIGIN 逗号分隔白名单；留空则放行任意源（开发用）。
function setCors(res, req) {
  addSecurityHeaders(res);
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) console.warn('[安全警告] 未设置 FRONTEND_ORIGIN，CORS 将放行任意源。生产环境请设置为前端域名。');
  if (allowed.length === 0 || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > BODY_CAP) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 保存 dataURL 图片，返回访问路径 /uploads/xxx
function saveDataUrl(dataUrl, prefix) {
  const mm = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/);
  if (!mm) throw new Error('仅支持图片');
  const ext = mm[2] === 'jpeg' ? 'jpg' : mm[2];
  const buf = Buffer.from(mm[3], 'base64');
  if (buf.length > 100 * 1024 * 1024) throw new Error('图片超过 100MB 限制');
  const fname = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
  return '/uploads/' + fname;
}

// 每月清理：删除 30 天前的消息，并清理无用上传文件
function cleanOldMessages() {
  const cutoff = Date.now() - MONTH_MS;
  const before = messages.length;
  messages = messages.filter((m) => m.time >= cutoff);
  saveMessages();
  // 清理未被引用的上传文件
  const used = new Set(messages.filter((m) => m.image).map((m) => m.image.replace('/uploads/', '')));
  used.add(theme.bgImage);
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      if (!used.has(f)) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} }
    }
  } catch {}
  if (before !== messages.length) console.log(`[clean] 已清理 ${before - messages.length} 条过期消息`);
}

// 删除不再被任何消息引用的上传文件（管理员删消息/删任务时调用）
function removeImageIfUnused(image) {
  if (!image) return;
  const fname = image.replace('/uploads/', '');
  if (!fname || fname === image) return;
  const stillUsed = messages.some((m) => m.image && m.image.replace('/uploads/', '') === fname);
  if (stillUsed) return;
  try { fs.unlinkSync(path.join(UPLOADS_DIR, fname)); } catch {}
}
cleanOldMessages();
setInterval(cleanOldMessages, 24 * 3600 * 1000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  addSecurityHeaders(res);
  let p = url.parse(req.url).pathname;
  if (p === '/') p = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res); return;
  }
  if (p.startsWith('/uploads/')) {
    const up = path.normalize(path.join(UPLOADS_DIR, p.replace('/uploads/', '')));
    if (up.startsWith(UPLOADS_DIR) && fs.existsSync(up) && fs.statSync(up).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(up).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(up).pipe(res); return;
    }
  }
  res.writeHead(404); res.end('not found');
}

async function requestHandler(req, res) {
  const p = url.parse(req.url).pathname;
  const method = req.method;
  setCors(res, req);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try {
    if (p.startsWith('/api/')) {
      // ---- 注册 ----
      if (p === '/api/register' && method === 'POST') {
        if (process.env.DISABLE_REGISTER === '1') return sendJson(res, 403, { error: '注册已关闭' });
        if (!rateLimit('reg:' + clientIp(req), 10, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        const email = (b.email || '').trim().toLowerCase();
        const code = (b.invite || '').trim();
        const password = b.password || '';
        const confirm = b.confirm || '';
        const rawNick = (b.nickname || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: '邮箱格式不正确' });
        if (users.find((u) => u.email === email)) return sendJson(res, 400, { error: '该邮箱已注册' });
        const inv = invites.find((x) => x.code === code);
        if (!inv) return sendJson(res, 400, { error: '邀请码无效' });
        if (inv.used) return sendJson(res, 400, { error: '邀请码已被使用' });
        if (password.length < 6) return sendJson(res, 400, { error: '密码至少6位' });
        if (password !== confirm) return sendJson(res, 400, { error: '两次密码不一致' });
        const nickname = toBaoNickname(rawNick);
        if (!nickname) return sendJson(res, 400, { error: '昵称不能为空' });
        const salt = crypto.randomBytes(16).toString('hex');
        users.push({ email, salt, hash: hashPassword(password, salt), nickname, role: 'user', invite: code });
        saveUsers();
        inv.used = true; inv.usedBy = email; inv.usedAt = Date.now(); saveInvites();
        const token = crypto.randomBytes(32).toString('hex');
        sessions[token] = { email, exp: Date.now() + TOKEN_TTL }; saveSessions();
        return sendJson(res, 200, { token, email, nickname });
      }
      // ---- 登录（邮箱）----
      if (p === '/api/login' && method === 'POST') {
        if (!rateLimit('login:' + clientIp(req), 30, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        const email = (b.email || '').trim().toLowerCase();
        const password = b.password || '';
        const u = users.find((x) => x.email === email);
        if (!u || hashPassword(password, u.salt) !== u.hash) return sendJson(res, 401, { error: '邮箱或密码错误' });
        const token = crypto.randomBytes(32).toString('hex');
        sessions[token] = { email: u.email, exp: Date.now() + TOKEN_TTL }; saveSessions();
        return sendJson(res, 200, { token, email: u.email, nickname: u.nickname });
      }
      if (p === '/api/logout' && method === 'POST') {
        const h = req.headers['authorization'] || '';
        const m = h.match(/^Bearer\s+(.+)$/i);
        if (m && sessions[m[1]]) { delete sessions[m[1]]; saveSessions(); }
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/me' && method === 'GET') {
        const e = currentUser(req);
        if (!e) return sendJson(res, 401, { error: '未登录' });
        const u = users.find((x) => x.email === e);
        return sendJson(res, 200, { email: e, nickname: u.nickname, role: u.role });
      }

      // 外观配置为公开（无登录也可读，供首页展示团队定制背景）
      if (p === '/api/theme' && method === 'GET') return sendJson(res, 200, { theme });

      const me = currentUser(req);
      if (!me) return sendJson(res, 401, { error: '未登录' });

      // ---- 管理员：邀请码 ----
      if (p === '/api/admin/invites' && method === 'GET') {
        if (!isAdmin(me)) return sendJson(res, 403, { error: '无权限' });
        return sendJson(res, 200, { invites });
      }
      if (p === '/api/admin/invites' && method === 'POST') {
        if (!isAdmin(me)) return sendJson(res, 403, { error: '无权限' });
        let code;
        do { code = crypto.randomBytes(6).toString('hex').toUpperCase(); } while (invites.find((x) => x.code === code));
        invites.push({ code, by: me, used: false, usedBy: null, createdAt: Date.now() });
        saveInvites();
        return sendJson(res, 200, { invite: invites[invites.length - 1] });
      }

      // ---- 任务室 ----
      if (p === '/api/rooms' && method === 'GET') return sendJson(res, 200, { rooms });
      if (p === '/api/rooms' && method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        const name = (b.name || '').trim();
        if (!name) return sendJson(res, 400, { error: '任务名不能为空' });
        const room = { id: crypto.randomUUID(), name, createdBy: me, createdAt: Date.now() };
        rooms.push(room); saveRooms();
        return sendJson(res, 200, { room });
      }
      // ---- 管理员删除任务（级联清理消息/待办/备注/图片）----
      const rd = p.match(/^\/api\/rooms\/([^/]+)$/);
      if (rd && method === 'DELETE') {
        if (!isAdmin(me)) return sendJson(res, 403, { error: '仅管理员可删除' });
        const rid = rd[1];
        if (!rooms.find((r) => r.id === rid)) return sendJson(res, 404, { error: '任务不存在' });
        const roomMsgs = messages.filter((x) => x.roomId === rid);
        rooms = rooms.filter((r) => r.id !== rid); saveRooms();
        messages = messages.filter((x) => x.roomId !== rid); saveMessages();
        todos = todos.filter((x) => x.roomId !== rid); saveTodos();
        notes = notes.filter((x) => x.roomId !== rid); saveNotes();
        roomMsgs.forEach((msg) => removeImageIfUnused(msg.image));
        for (const [email, st] of presence) if (st.roomId === rid) presence.delete(email);
        return sendJson(res, 200, { ok: true });
      }
      const m = p.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      if (m && method === 'GET') {
        const list = messages.filter((x) => x.roomId === m[1]);
        return sendJson(res, 200, { messages: list });
      }
      if (m && method === 'POST') {
        const roomId = m[1];
        if (!rooms.find((r) => r.id === roomId)) return sendJson(res, 404, { error: '任务不存在' });
        const b = JSON.parse(await readBody(req) || '{}');
        const text = (b.text || '').trim();
        if (text.length > MAX_TEXT) return sendJson(res, 400, { error: '消息文字过长' });
        let image = null;
        if (b.image) { try { image = saveDataUrl(b.image, 'msg'); } catch (e) { return sendJson(res, 400, { error: e.message }); } }
        if (!text && !image) return sendJson(res, 400, { error: '消息不能为空' });
        const msg = {
          id: crypto.randomUUID(), roomId, user: me, nickname: nickOf(me),
          type: image ? (text ? 'mixed' : 'image') : 'text',
          text: text || null, image, time: Date.now(),
        };
        messages.push(msg); saveMessages();
        return sendJson(res, 200, { message: msg });
      }
      // ---- 管理员删除单条消息 ----
      const md = p.match(/^\/api\/rooms\/([^/]+)\/messages\/([^/]+)$/);
      if (md && method === 'DELETE') {
        if (!isAdmin(me)) return sendJson(res, 403, { error: '仅管理员可删除' });
        const idx = messages.findIndex((x) => x.id === md[2] && x.roomId === md[1]);
        if (idx < 0) return sendJson(res, 404, { error: '消息不存在' });
        const [removed] = messages.splice(idx, 1);
        saveMessages();
        removeImageIfUnused(removed.image);
        return sendJson(res, 200, { ok: true });
      }
      // ---- 在线状态（按房间）----
      if (p === '/api/presence' && method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        const now = Date.now();
        const prev = presence.get(me);
        if (b.roomId) {
          // 连续在线（上次心跳仍在同一房间且间隔 < 20s）→ 累计在线时长（摸鱼指数）
          if (prev && prev.roomId === b.roomId && now - prev.ts < 20000) {
            ensureStatsDate();
            stats.onlineSec[me] = (stats.onlineSec[me] || 0) + (now - prev.ts);
            stats.lastTs[me] = now;
            saveStats();
          }
          presence.set(me, { roomId: b.roomId, ts: now });
        } else {
          presence.delete(me);
        }
        const online = [];
        for (const [email, st] of presence) {
          if (st.roomId === b.roomId && now - st.ts < 15000) online.push({ email, nickname: nickOf(email) });
        }
        return sendJson(res, 200, { online });
      }
      // ---- 主题 ----
      if (p === '/api/theme' && method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        if (b.colorTheme) theme.colorTheme = b.colorTheme;
        saveTheme(); return sendJson(res, 200, { theme });
      }
      if (p === '/api/theme/background' && method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        try {
          if (theme.bgImage) { try { fs.unlinkSync(path.join(UPLOADS_DIR, theme.bgImage)); } catch {} }
          theme.bgImage = saveDataUrl(b.dataUrl, 'bg'); saveTheme();
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
        return sendJson(res, 200, { theme });
      }
      if (p === '/api/theme/background' && method === 'DELETE') {
        if (theme.bgImage) { try { fs.unlinkSync(path.join(UPLOADS_DIR, theme.bgImage)); } catch {} theme.bgImage = null; saveTheme(); }
        return sendJson(res, 200, { theme });
      }

      // ---- 成员（仅展示）----
      if (p === '/api/members' && method === 'GET') {
        const now = Date.now();
        const list = users.map((u) => {
          const st = presence.get(u.email);
          return { nickname: u.nickname, email: u.email, role: u.role, online: !!(st && now - st.ts < 15000) };
        });
        return sendJson(res, 200, { members: list });
      }

      // ---- 今日活跃榜（摸鱼指数：在线时长 + 消息 + 完成待办 → 称号）----
      if (p === '/api/rank' && method === 'GET') {
        ensureStatsDate();
        const now = Date.now();
        const dayStart = new Date(todayStr() + 'T00:00:00').getTime();
        const msgs = {}, dones = {};
        messages.forEach((m) => { if (m.time >= dayStart && m.user) msgs[m.user] = (msgs[m.user] || 0) + 1; });
        todos.forEach((t) => { if (t.done && t.by) dones[t.by] = (dones[t.by] || 0) + 1; });
        const list = users.map((u) => {
          const onlineSec = stats.onlineSec[u.email] || 0;
          const ms = msgs[u.email] || 0, dn = dones[u.email] || 0;
          const score = Math.round(onlineSec / 60) + ms * 30 + dn * 50;
          const title = score >= 600 ? '总监' : score >= 300 ? '达人' : score >= 100 ? '干事' : '副总监';
          const st = presence.get(u.email);
          return { nickname: u.nickname, email: u.email, role: u.role, online: !!(st && now - st.ts < 15000), onlineSec, msgs: ms, done: dn, score, title };
        });
        list.sort((a, b) => b.score - a.score);
        return sendJson(res, 200, { rank: list });
      }

      // ---- 代办清单（按任务）----
      const tm = p.match(/^\/api\/rooms\/([^/]+)\/todos$/);
      if (tm && method === 'GET') {
        return sendJson(res, 200, { todos: todos.filter((x) => x.roomId === tm[1]) });
      }
      if (tm && method === 'POST') {
        const rid = tm[1];
        if (!rooms.find((r) => r.id === rid)) return sendJson(res, 404, { error: '任务不存在' });
        const b = JSON.parse(await readBody(req) || '{}');
        const text = (b.text || '').trim();
        if (!text) return sendJson(res, 400, { error: '内容不能为空' });
        if (text.length > 500) return sendJson(res, 400, { error: '内容过长' });
        const t = { id: crypto.randomUUID(), roomId: rid, text, done: false, by: me, time: Date.now() };
        todos.push(t); saveTodos();
        return sendJson(res, 200, { todo: t });
      }
      const tmd = p.match(/^\/api\/rooms\/([^/]+)\/todos\/([^/]+)$/);
      if (tmd && method === 'PUT') {
        const t = todos.find((x) => x.id === tmd[2] && x.roomId === tmd[1]);
        if (!t) return sendJson(res, 404, { error: '代办不存在' });
        const b = JSON.parse(await readBody(req) || '{}');
        if (typeof b.done === 'boolean') t.done = b.done;
        if (b.text !== undefined) { const tx = (b.text || '').trim(); if (tx) t.text = tx.slice(0, 500); }
        saveTodos();
        return sendJson(res, 200, { todo: t });
      }
      if (tmd && method === 'DELETE') {
        todos = todos.filter((x) => !(x.id === tmd[2] && x.roomId === tmd[1]));
        saveTodos();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 备注（按任务，单条）----
      const nm = p.match(/^\/api\/rooms\/([^/]+)\/notes$/);
      if (nm && method === 'GET') {
        const n = notes.find((x) => x.roomId === nm[1]);
        return sendJson(res, 200, { text: n ? n.text : '' });
      }
      if (nm && method === 'POST') {
        const rid = nm[1];
        if (!rooms.find((r) => r.id === rid)) return sendJson(res, 404, { error: '任务不存在' });
        const b = JSON.parse(await readBody(req) || '{}');
        const text = b.text || '';
        let n = notes.find((x) => x.roomId === rid);
        if (n) { n.text = text; n.updatedAt = Date.now(); }
        else notes.push({ roomId: rid, text, updatedAt: Date.now() });
        saveNotes();
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'not found' });
    }
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
  }
}
// 优先 HTTPS（生产，适配 GitHub Pages 等 HTTPS 前端）。
// 证书检测顺序：
//   1) SSL_KEY + SSL_CERT 环境变量（PEM）
//   2) 项目 deploy/certs/key.pem + cert.pem（PEM，gen-cert.ps1 的 openssl 路径产出）
//   3) 项目 deploy/certs/cert.pfx + SSL_PFX_PASS（PFX，gen-cert.ps1 的 PowerShell 路径产出）
const SSL_KEY = process.env.SSL_KEY || path.join(ROOT, 'deploy', 'certs', 'key.pem');
const SSL_CERT = process.env.SSL_CERT || path.join(ROOT, 'deploy', 'certs', 'cert.pem');
const SSL_PFX = process.env.SSL_PFX || path.join(ROOT, 'deploy', 'certs', 'cert.pfx');
const SSL_PFX_PASS = process.env.SSL_PFX_PASS || 'officechat';

let server;
if (fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
  const key = fs.readFileSync(SSL_KEY);
  const cert = fs.readFileSync(SSL_CERT);
  server = https.createServer({ key, cert }, requestHandler);
  console.log(`Office chat running at https://0.0.0.0:${PORT}  (PEM 证书)`);
} else if (fs.existsSync(SSL_PFX)) {
  const pfx = fs.readFileSync(SSL_PFX);
  server = https.createServer({ pfx, passphrase: SSL_PFX_PASS }, requestHandler);
  console.log(`Office chat running at https://0.0.0.0:${PORT}  (PFX 证书)`);
} else {
  server = http.createServer(requestHandler);
  server.listen(PORT, () => console.log(`Office chat running at http://localhost:${PORT}`));
  return;
}
server.listen(PORT, () => console.log(`Office chat started.`));
