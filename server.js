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
const BODY_CAP = 400 * 1024 * 1024;        // 请求体上限（媒体上传含 base64 膨胀，放宽至 400MB）

// 安全响应头：防点击劫持 / MIME 嗅探 / 收窄 XSS 影响面
function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'");
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
let votes = readJson(jf('votes.json'), []);   // 团队投票 { id, title, options:[{text, votes:[email]}], by, createdAt, votedBy:[email] }
let moans = readJson(jf('moans.json'), []);   // 匿名树洞 { id, text, time }（不记录作者，纯匿名）
let kb = readJson(jf('kb.json'), { folders: [], docs: [] }); // 团队知识库 { folders:[{id,name,parent}], docs:[{id,folderId,title,content,createdBy,updatedBy,createdAt,updatedAt}] }
let media = readJson(jf('media.json'), []); // 平台媒体库 { id,name,type,ext,size,path,uploadedBy,createdAt }
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
function saveVotes() { writeJson(jf('votes.json'), votes); }
function saveMoans() { writeJson(jf('moans.json'), moans); }
function saveKb() { writeJson(jf('kb.json'), kb); }
function saveMedia() { writeJson(jf('media.json'), media); }

// 知识库文档权限：可管理(manage) > 可编辑(edit) > 仅查看(view，默认)。
// 作者与管理员始终为「可管理」，不受 perms 影响。
const KB_LEVELS = ['manage', 'edit', 'view'];
function kbPermOf(doc, email) {
  if (isAdmin(email) || doc.createdBy === email) return 'manage';
  const lv = doc.perms && doc.perms[email];
  return KB_LEVELS.includes(lv) ? lv : 'view';
}
function kbCanEdit(doc, email) { const lv = kbPermOf(doc, email); return lv === 'manage' || lv === 'edit'; }
function kbCanManage(doc, email) { return kbPermOf(doc, email) === 'manage'; }


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
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
const unlocked = new Map(); // email -> Set(roomId) 加密任务解锁状态（内存态，重启后需重新解锁）
function canAccessRoom(room, email) {
  if (!room || !room.encrypted) return true;
  if (isAdmin(email) || room.createdBy === email) return true;
  return !!(unlocked.get(email) && unlocked.get(email).has(room.id));
}
// 活跃度称号（由高到低）。积分规则：在线每分钟=1分（在线10分钟=10分），每条消息=1分
const TITLES = [
  { t: '真神', min: 500 }, { t: '悟道', min: 400 }, { t: '化神', min: 300 },
  { t: '元婴', min: 200 }, { t: '结丹', min: 100 }, { t: '筑基', min: 20 },
  { t: '练气', min: 0 },
];
function titleOf(score) { return (TITLES.find((x) => score >= x.min) || TITLES[TITLES.length - 1]).t; }
function nickOf(email) { const u = users.find((x) => x.email === email); return u ? u.nickname : email; }

// ===== 灵石体系：极品(jp) > 上品(sp) > 中品(zp) > 下品(xp)，低→高 1:100 兑换 =====
const SPIRIT_ORDER = ['xp', 'zp', 'sp', 'jp']; // 从低到高
const SPIRIT_NAMES = { jp: '极品灵石', sp: '上品灵石', zp: '中品灵石', xp: '下品灵石' };
const SPIRIT_ICONS = { jp: '💎', sp: '🔮', zp: '🪨', xp: '⚪' };
const SPIRIT_CONVERT_RATIO = 100; // 100 低阶 = 1 高阶
function newSpirit() { return { jp: 0, sp: 0, zp: 0, xp: 0 }; }

// 签到：每月 +5 活跃积分 +10 下品灵石
const SIGNIN_REWARD = { bonus: 5, xp: 10 };
// 每日任务：每项完成 +5 活跃积分 +25 下品灵石
const DAILY_REWARD = { bonus: 5, xp: 25 };
// 专属任务（新用户 30 天内）：填写个人资料 +10 活跃积分 +50 下品灵石
const NEWBIE_REWARD = { bonus: 10, xp: 50 };
const NEWBIE_DAYS = 30;

const DAILY_TASKS = [
  { id: 't1', title: '活跃发言', desc: '在任意任务中发言 3 条' },
  { id: 't2', title: '完成代办', desc: '完成 1 项代办清单' },
  { id: 't3', title: '知识分享', desc: '在知识库中完成一次知识分享（新建文档）' },
  { id: 't4', title: '快乐分享', desc: '去意见反馈分享一件令人开心的事' },
  { id: 't5', title: '协作完成', desc: '完成一次别人布置的任务（需发布者确认）' },
];

// 商城（灵石购买）
const SHOP_ITEMS = [
  { id: 'rename', name: '改名卡', icon: '🪪', desc: '解锁一次自由修改昵称的机会（不再强制「x包」）', price: 50, unit: 'xp' },
  { id: 'title', name: '个性称号', icon: '🏅', desc: '为自己定制专属称号，展示在名字旁', price: 100, unit: 'xp' },
  { id: 'frame', name: '鎏金头像框', icon: '🖼️', desc: '永久解锁鎏金头像框，金光闪闪', price: 200, unit: 'xp' },
];

function ensureUser(u) {
  if (!u.spirit) u.spirit = newSpirit();
  if (typeof u.bonus !== 'number') u.bonus = 0;
  if (!u.profile) u.profile = {};
  if (!u.tasks) u.tasks = {};
  if (!u.tasks.daily) u.tasks.daily = {};
  if (!u.tasks.newbie) u.tasks.newbie = { claimed: false };
  if (!u.createdAt) u.createdAt = Date.now();
  if (typeof u.renameCards !== 'number') u.renameCards = 0;
  if (!u.title2) u.title2 = '';
  if (!u.avatarFrame) u.avatarFrame = '';
  return u;
}
function ymStr(d) { const x = d || new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; }
function signinDates(u) { return (u.signin && u.signin[ymStr()]) || []; }
function todayNum() { return new Date().getDate(); }

// 每日任务完成判定（按当天 0 点起）
function dailyTaskDone(u, taskId, dayStart) {
  const e = u.email;
  switch (taskId) {
    case 't1': return messages.filter((m) => m.user === e && m.time >= dayStart && !m.recalled).length >= 3;
    case 't2': return todos.some((t) => t.done && t.doneBy === e && t.doneAt >= dayStart);
    case 't3': return kb.docs.some((d) => d.createdBy === e && d.createdAt >= dayStart);
    case 't4': return moans.some((x) => x.by === e && x.time >= dayStart);
    case 't5': return todos.some((t) => t.done && t.by !== e && t.confirmed && t.doneAt >= dayStart);
  }
  return false;
}
// 专属任务：填写个人资料（年龄/出生日期/婚配/头像任一填写即视为完成）
function newbieDone(u) { const p = u.profile || {}; return !!(p.age || p.birth || p.married === true || p.married === false || p.avatar); }
function newbieLocked(u) { return Date.now() - (u.createdAt || Date.now()) > NEWBIE_DAYS * 86400000; }
// 活跃总分 = 动态分（在线分钟 + 当日消息）+ 额外奖励分（签到/任务）
function scoreOf(u) {
  ensureStatsDate();
  const dayStart = new Date(todayStr() + 'T00:00:00').getTime();
  const ms = messages.filter((m) => m.user === u.email && m.time >= dayStart && !m.recalled).length;
  return Math.round((stats.onlineSec[u.email] || 0) / 60000) + ms + (u.bonus || 0);
}
// 领取奖励：加活跃积分 + 下品灵石
function grantReward(u, reward) {
  u.bonus = (u.bonus || 0) + reward.bonus;
  u.spirit.xp = (u.spirit.xp || 0) + reward.xp;
}

// 在线状态：email -> {roomId, ts}
const presence = new Map();

// SSE 实时推送：email -> Set<res>（一个用户可多标签页）
const sseClients = new Map();
function pushRoomEvent(roomId, data) {
  const payload = 'data: ' + JSON.stringify(data) + '\n\n';
  const room = rooms.find((r) => r.id === roomId);
  for (const [email, set] of sseClients) {
    if (room && !canAccessRoom(room, email)) continue; // 加密任务只推给有权者
    for (const res of set) { try { res.write(payload); } catch {} }
  }
}
// 广播给所有在线用户（房间新建等全局事件）
function pushAll(data) {
  const payload = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const [, set] of sseClients) for (const res of set) { try { res.write(payload); } catch {} }
}

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
  // 清理未被引用的上传文件（含知识库文档中引用的图片）
  const used = new Set(messages.filter((m) => m.image).map((m) => m.image.replace('/uploads/', '')));
  used.add(theme.bgImage);
  // 媒体库文件（media- 前缀）始终保留，不随消息清理被误删
  media.forEach((mm) => { if (mm.path) used.add(mm.path.replace('/uploads/', '')); });
  // 用户头像（avatar- 前缀）始终保留
  users.forEach((u) => { if (u.profile && u.profile.avatar) used.add(u.profile.avatar.replace('/uploads/', '')); });
  kb.docs.forEach((d) => {
    const re = /!\[[^\]]*\]\((\/uploads\/[^)]+)\)/g;
    let m; while ((m = re.exec(d.content || ''))) used.add(m[1].replace('/uploads/', ''));
  });
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };

function serveStatic(req, res) {
  addSecurityHeaders(res);
  let p = url.parse(req.url).pathname;
  if (p === '/') p = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    // 禁用缓存：前端频繁迭代，避免浏览器/代理缓存旧版本导致功能不一致
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
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
      // ---- SSE 实时推送（EventSource 无法带 Header，token 走 query）----
      if (p === '/api/stream' && method === 'GET') {
        const q = url.parse(req.url, true).query;
        const token = q.token || '';
        const entry = sessions[token];
        if (!entry || (entry.exp && entry.exp < Date.now())) { res.writeHead(401); res.end('unauthorized'); return; }
        const email = entry.email;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': ok\n\n');
        if (!sseClients.has(email)) sseClients.set(email, new Set());
        sseClients.get(email).add(res);
        const close = () => {
          const set = sseClients.get(email);
          if (set) { set.delete(res); if (!set.size) sseClients.delete(email); }
        };
        req.on('close', close);
        res.on('close', close);
        const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 30000); // 30s 心跳保活
        res.on('close', () => clearInterval(hb));
        return;
      }
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
        const nu = { email, salt, hash: hashPassword(password, salt), nickname, role: 'user', invite: code, createdAt: Date.now(), spirit: newSpirit(), bonus: 0, profile: {}, signin: {}, tasks: { daily: {}, newbie: { claimed: false } }, renameCards: 0, title2: '', avatarFrame: '' };
        users.push(nu);
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
        if (m && sessions[m[1]]) {
          const email = sessions[m[1]].email;
          delete sessions[m[1]]; saveSessions();
          unlocked.delete(email); // 登出即清解锁态：下次登录仍需密码
        }
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/me' && method === 'GET') {
        const e = currentUser(req);
        if (!e) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === e));
        const today = todayStr();
        const dayStart = new Date(today + 'T00:00:00').getTime();
        return sendJson(res, 200, {
          email: e, nickname: u.nickname, role: u.role,
          profile: u.profile || {}, spirit: u.spirit || newSpirit(), bonus: u.bonus || 0,
          score: scoreOf(u), title: titleOf(scoreOf(u)),
          renameCards: u.renameCards || 0, title2: u.title2 || '', avatarFrame: u.avatarFrame || '',
          createdAt: u.createdAt, newbieDone: newbieDone(u), newbieLocked: newbieLocked(u),
          signinDates: signinDates(u), signedToday: signinDates(u).includes(todayNum()),
          daily: DAILY_TASKS.map((t) => {
            const key = `${today}:${t.id}`;
            return { id: t.id, title: t.title, desc: t.desc, done: dailyTaskDone(u, t.id, dayStart), claimed: !!(u.tasks.daily && u.tasks.daily[key]) };
          }),
        });
      }

      // ---- 个人中心：保存个人资料（头像/昵称/年龄/出生日期/婚配）----
      if (p === '/api/me/profile' && method === 'PUT') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const b = JSON.parse(await readBody(req) || '{}');
        if (b.avatar && String(b.avatar).startsWith('data:image/')) {
          try { u.profile.avatar = saveDataUrl(b.avatar, 'avatar'); }
          catch (err) { return sendJson(res, 400, { error: err.message }); }
        } else if (b.avatar === null) u.profile.avatar = '';
        if (b.nickname !== undefined) {
          const raw = String(b.nickname).trim().slice(0, 20);
          if (!raw) return sendJson(res, 400, { error: '昵称不能为空' });
          if (u.renameCards > 0) { u.nickname = raw; u.renameCards -= 1; }
          else {
            const bao = toBaoNickname(raw);
            if (!bao) return sendJson(res, 400, { error: '昵称不能为空' });
            u.nickname = bao;
          }
        }
        if (b.age !== undefined && b.age !== null && b.age !== '') {
          const age = Number(b.age);
          if (!Number.isInteger(age) || age < 1 || age > 150) return sendJson(res, 400, { error: '年龄需为 1~150 的整数' });
          u.profile.age = age;
        } else if (b.age === null || b.age === '') u.profile.age = null;
        if (b.birth !== undefined && b.birth !== null && b.birth !== '') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.birth))) return sendJson(res, 400, { error: '出生日期格式应为 YYYY-MM-DD' });
          u.profile.birth = String(b.birth);
        } else if (b.birth === null || b.birth === '') u.profile.birth = null;
        if (b.married !== undefined && b.married !== null && b.married !== '') u.profile.married = String(b.married) === 'true';
        else if (b.married === null || b.married === '') u.profile.married = null;
        if (b.title2 !== undefined) u.title2 = String(b.title2).trim().slice(0, 12);
        saveUsers();
        return sendJson(res, 200, { ok: true, nickname: u.nickname, renameCards: u.renameCards, profile: u.profile, title2: u.title2 });
      }

      // ---- 个人中心：每日签到（每月一次，+5 活跃积分 +10 下品灵石）----
      if (p === '/api/me/signin' && method === 'POST') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const y = ymStr(), d = todayNum();
        if (!u.signin) u.signin = {};
        if ((u.signin[y] || []).includes(d)) return sendJson(res, 400, { error: '今天已经签到过啦' });
        if (!u.signin[y]) u.signin[y] = [];
        u.signin[y].push(d);
        grantReward(u, SIGNIN_REWARD);
        saveUsers();
        return sendJson(res, 200, { ok: true, dates: u.signin[y], spirit: u.spirit, bonus: u.bonus, reward: SIGNIN_REWARD });
      }

      // ---- 个人中心：任务总览（每日任务 + 专属任务）----
      if (p === '/api/me/tasks' && method === 'GET') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const today = todayStr(), dayStart = new Date(today + 'T00:00:00').getTime();
        const daysLeft = Math.max(0, Math.ceil((NEWBIE_DAYS * 86400000 - (Date.now() - (u.createdAt || Date.now()))) / 86400000));
        return sendJson(res, 200, {
          date: today,
          daily: DAILY_TASKS.map((t) => {
            const key = `${today}:${t.id}`;
            return { id: t.id, title: t.title, desc: t.desc, done: dailyTaskDone(u, t.id, dayStart), claimed: !!(u.tasks.daily && u.tasks.daily[key]) };
          }),
          newbie: { done: newbieDone(u), claimed: !!(u.tasks.newbie && u.tasks.newbie.claimed), locked: newbieLocked(u), daysLeft },
          reward: { daily: DAILY_REWARD, newbie: NEWBIE_REWARD, signin: SIGNIN_REWARD },
        });
      }
      // 领取每日任务奖励（每项一次）
      const tclaim = p.match(/^\/api\/me\/tasks\/daily\/([^/]+)\/claim$/);
      if (tclaim && method === 'POST') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const tid = tclaim[1];
        const task = DAILY_TASKS.find((t) => t.id === tid);
        if (!task) return sendJson(res, 404, { error: '任务不存在' });
        const today = todayStr(), dayStart = new Date(today + 'T00:00:00').getTime();
        if (!dailyTaskDone(u, tid, dayStart)) return sendJson(res, 400, { error: '任务还没完成哦' });
        const key = `${today}:${tid}`;
        if (u.tasks.daily && u.tasks.daily[key]) return sendJson(res, 400, { error: '该任务奖励已领取' });
        if (!u.tasks.daily) u.tasks.daily = {};
        u.tasks.daily[key] = Date.now();
        grantReward(u, DAILY_REWARD);
        saveUsers();
        return sendJson(res, 200, { ok: true, spirit: u.spirit, bonus: u.bonus, reward: DAILY_REWARD });
      }
      // 领取专属任务奖励（新用户 30 天内）
      if (p === '/api/me/tasks/newbie/claim' && method === 'POST') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        if (newbieLocked(u)) return sendJson(res, 400, { error: '专属任务已过期锁定（注册 30 天内有效）' });
        if (!newbieDone(u)) return sendJson(res, 400, { error: '请先完成专属任务：填写个人资料' });
        if (u.tasks.newbie && u.tasks.newbie.claimed) return sendJson(res, 400, { error: '专属任务奖励已领取' });
        u.tasks.newbie = { claimed: true, claimedAt: Date.now() };
        grantReward(u, NEWBIE_REWARD);
        saveUsers();
        return sendJson(res, 200, { ok: true, spirit: u.spirit, bonus: u.bonus, reward: NEWBIE_REWARD });
      }

      // ---- 个人中心：灵石兑换（100 低阶 = 1 高阶，仅相邻升阶）----
      if (p === '/api/me/spirit/convert' && method === 'POST') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const b = JSON.parse(await readBody(req) || '{}');
        const from = b.from, to = b.to;
        const fi = SPIRIT_ORDER.indexOf(from), ti = SPIRIT_ORDER.indexOf(to);
        if (fi < 0 || ti < 0) return sendJson(res, 400, { error: '灵石类型无效' });
        if (ti !== fi + 1) return sendJson(res, 400, { error: '只能逐级向上兑换（下品→中品→上品→极品）' });
        const need = SPIRIT_CONVERT_RATIO;
        if ((u.spirit[from] || 0) < need) return sendJson(res, 400, { error: `灵石不足：需要 ${need} 枚${SPIRIT_NAMES[from]}` });
        u.spirit[from] -= need;
        u.spirit[to] = (u.spirit[to] || 0) + 1;
        saveUsers();
        return sendJson(res, 200, { ok: true, spirit: u.spirit });
      }

      // ---- 个人中心：商城（商品列表 + 我的灵石 + 已购状态）----
      if (p === '/api/me/shop' && method === 'GET') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const owned = { rename: (u.renameCards || 0) > 0, title: !!(u.title2 && u.title2 !== ''), frame: !!(u.avatarFrame && u.avatarFrame !== '') };
        return sendJson(res, 200, { spirit: u.spirit, items: SHOP_ITEMS, owned });
      }
      // 购买商品（灵石扣减）
      const buy = p.match(/^\/api\/me\/shop\/([^/]+)\/buy$/);
      if (buy && method === 'POST') {
        const me2 = currentUser(req);
        if (!me2) return sendJson(res, 401, { error: '未登录' });
        const u = ensureUser(users.find((x) => x.email === me2));
        const item = SHOP_ITEMS.find((it) => it.id === buy[1]);
        if (!item) return sendJson(res, 404, { error: '商品不存在' });
        if ((u.spirit[item.unit] || 0) < item.price) return sendJson(res, 400, { error: `灵石不足：需要 ${item.price} 枚${SPIRIT_NAMES[item.unit]}` });
        const b = JSON.parse(await readBody(req) || '{}');
        u.spirit[item.unit] -= item.price;
        if (item.id === 'rename') u.renameCards = (u.renameCards || 0) + 1;
        else if (item.id === 'title') {
          const t2 = (b.title2 || '').trim().slice(0, 12);
          if (!t2) { u.spirit[item.unit] += item.price; return sendJson(res, 400, { error: '请输入称号内容' }); }
          u.title2 = t2;
        } else if (item.id === 'frame') u.avatarFrame = 'gold';
        saveUsers();
        return sendJson(res, 200, { ok: true, spirit: u.spirit, renameCards: u.renameCards, title2: u.title2, avatarFrame: u.avatarFrame });
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
      if (p === '/api/rooms' && method === 'GET') {
        return sendJson(res, 200, { rooms: rooms.map((r) => ({ id: r.id, name: r.name, createdBy: r.createdBy, createdAt: r.createdAt, encrypted: !!r.encrypted })) });
      }
      if (p === '/api/rooms' && method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        const name = (b.name || '').trim();
        if (!name) return sendJson(res, 400, { error: '任务名不能为空' });
        const encrypted = !!b.encrypted;
        let passwordHash = null;
        if (encrypted) {
          const pw = String(b.password || '');
          if (!pw) return sendJson(res, 400, { error: '加密任务需设置访问密码' });
          if (pw.length > 100) return sendJson(res, 400, { error: '密码过长（最多100位）' });
          passwordHash = sha256(pw);
        }
        const room = { id: crypto.randomUUID(), name, createdBy: me, createdAt: Date.now(), encrypted, passwordHash };
        rooms.push(room); saveRooms();
        // 实时：通知所有在线用户刷新任务列表（剥离密码哈希）
        pushAll({ type: 'roomCreated', room: { id: room.id, name: room.name, createdBy: room.createdBy, createdAt: room.createdAt, encrypted: room.encrypted } });
        return sendJson(res, 200, { room: { id: room.id, name: room.name, createdBy: room.createdBy, createdAt: room.createdAt, encrypted: room.encrypted } });
      }
      // ---- 解锁加密任务 ----
      const ul = p.match(/^\/api\/rooms\/([^/]+)\/unlock$/);
      if (ul && method === 'POST') {
        const room = rooms.find((r) => r.id === ul[1]);
        if (!room) return sendJson(res, 404, { error: '任务不存在' });
        if (!room.encrypted) return sendJson(res, 400, { error: '该任务未加密' });
        const b = JSON.parse(await readBody(req) || '{}');
        if (sha256(String(b.password || '')) !== room.passwordHash) return sendJson(res, 403, { error: '密码错误' });
        if (!unlocked.has(me)) unlocked.set(me, new Set());
        unlocked.get(me).add(room.id);
        return sendJson(res, 200, { ok: true });
      }
      // ---- 退出加密任务（清除解锁态 = 之后进入需重新输密码）----
      const ex = p.match(/^\/api\/rooms\/([^/]+)\/exit$/);
      if (ex && method === 'POST') {
        if (!rooms.find((r) => r.id === ex[1])) return sendJson(res, 404, { error: '任务不存在' });
        if (unlocked.has(me)) unlocked.get(me).delete(ex[1]);
        presence.delete(me); // 同时离开在线状态
        return sendJson(res, 200, { ok: true });
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
        pushRoomEvent(rid, { type: 'roomDeleted', roomId: rid });
        return sendJson(res, 200, { ok: true });
      }
      const m = p.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      if (m && method === 'GET') {
        if (!canAccessRoom(rooms.find((r) => r.id === m[1]), me)) return sendJson(res, 403, { error: '该任务已加密，请输入密码' });
        const list = messages.filter((x) => x.roomId === m[1]);
        return sendJson(res, 200, { messages: list });
      }
      if (m && method === 'POST') {
        const roomId = m[1];
        const room = rooms.find((r) => r.id === roomId);
        if (!room) return sendJson(res, 404, { error: '任务不存在' });
        if (!canAccessRoom(room, me)) return sendJson(res, 403, { error: '该任务已加密，请输入密码' });
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
        pushRoomEvent(roomId, { type: 'message', roomId });
        return sendJson(res, 200, { message: msg });
      }
      // ---- 删除 / 编辑单条消息 ----
      const md = p.match(/^\/api\/rooms\/([^/]+)\/messages\/([^/]+)$/);
      if (md && method === 'DELETE') {
        const idx = messages.findIndex((x) => x.id === md[2] && x.roomId === md[1]);
        if (idx < 0) return sendJson(res, 404, { error: '消息不存在' });
        const msg = messages[idx];
        if (!isAdmin(me) && msg.user !== me) return sendJson(res, 403, { error: '只能撤回自己发送的消息' });
        if (msg.recalled) return sendJson(res, 400, { error: '该消息已撤回' });
        const oldImg = msg.image;
        msg.recalled = true; msg.text = ''; msg.image = null; msg.edited = false; msg.recalledBy = me;
        saveMessages();
        removeImageIfUnused(oldImg);
        pushRoomEvent(md[1], { type: 'message', roomId: md[1] });
        return sendJson(res, 200, { ok: true });
      }
      if (md && method === 'PATCH') {
        const msg = messages.find((x) => x.id === md[2] && x.roomId === md[1]);
        if (!msg) return sendJson(res, 404, { error: '消息不存在' });
        if (msg.user !== me) return sendJson(res, 403, { error: '只能编辑自己发送的消息' });
        const b = JSON.parse(await readBody(req) || '{}');
        const text = (b.text || '').trim();
        if (!text) return sendJson(res, 400, { error: '内容不能为空' });
        if (text.length > MAX_TEXT) return sendJson(res, 400, { error: '内容过长' });
        msg.text = text; msg.edited = true; msg.editedAt = Date.now(); saveMessages();
        pushRoomEvent(md[1], { type: 'message', roomId: md[1] });
        return sendJson(res, 200, { ok: true });
      }
      // ---- 在线状态（全局：登录即计在线时长，跨房间/仪表盘都累计）----
      if (p === '/api/presence' && method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        const now = Date.now();
        ensureStatsDate(); // 无条件先校验跨天，保证「今日活跃」只算当天
        const prev = presence.get(me);
        if (prev) {
          let delta = now - prev.ts;
          if (delta > 60000) delta = 60000; // 离开/重连/跨天间隙>1分钟不累计，防虚高
          if (delta > 0) {
            stats.onlineSec[me] = (stats.onlineSec[me] || 0) + delta;
            stats.lastTs[me] = now;
            saveStats();
          }
        }
        presence.set(me, { roomId: b.roomId || null, ts: now });
        const rid = b.roomId;
        const online = [];
        for (const [email, st] of presence) {
          if ((rid ? st.roomId === rid : true) && now - st.ts < 15000) online.push({ email, nickname: nickOf(email) });
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

      // ---- 今日活跃榜（摸鱼指数：在线时长 + 消息 → 称号）----
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
          // onlineSec 单位为毫秒：÷60000 转分钟，在线每分钟=1分（在线10分钟=10分）；每条消息=1分；另加签到/任务奖励分 bonus
          const score = Math.round(onlineSec / 60000) + ms + (u.bonus || 0);
          const title = titleOf(score);
          const st = presence.get(u.email);
          return { nickname: u.nickname, email: u.email, role: u.role, online: !!(st && now - st.ts < 15000), onlineSec, msgs: ms, done: dn, score, title, title2: u.title2 || '', avatarFrame: u.avatarFrame || '', avatar: (u.profile && u.profile.avatar) || '' };
        });
        list.sort((a, b) => b.score - a.score);
        return sendJson(res, 200, { rank: list });
      }

      // ---- 团队投票 ----
      if (p === '/api/votes' && method === 'GET') {
        return sendJson(res, 200, { votes: votes.map((v) => {
          const ci = v.votedBy.indexOf(me);
          return { id: v.id, title: v.title, by: v.by, createdAt: v.createdAt, mine: ci >= 0, myChoice: ci,
                   options: v.options.map((o) => ({ text: o.text, count: o.votes.length })) };
        }).reverse() });
      }
      if (p === '/api/votes' && method === 'POST') {
        if (!rateLimit('vote:' + clientIp(req), 10, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        const title = (b.title || '').trim();
        const opts = Array.isArray(b.options) ? b.options.map((o) => String(o).trim()).filter(Boolean) : [];
        if (!title) return sendJson(res, 400, { error: '投票主题不能为空' });
        if (opts.length < 2) return sendJson(res, 400, { error: '至少需要 2 个选项' });
        if (opts.length > 10) return sendJson(res, 400, { error: '选项最多 10 个' });
        const vote = { id: crypto.randomUUID(), title, options: opts.map((text) => ({ text, votes: [] })), by: me, createdAt: Date.now(), votedBy: [] };
        votes.push(vote); saveVotes();
        return sendJson(res, 200, { vote });
      }
      const vm = p.match(/^\/api\/votes\/([^/]+)\/vote$/);
      if (vm && method === 'POST') {
        const v = votes.find((x) => x.id === vm[1]);
        if (!v) return sendJson(res, 404, { error: '投票不存在' });
        if (v.votedBy.includes(me)) return sendJson(res, 400, { error: '你已经投过票了' });
        const b = JSON.parse(await readBody(req) || '{}');
        const idx = Number(b.optionIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= v.options.length) return sendJson(res, 400, { error: '选项无效' });
        v.options[idx].votes.push(me); v.votedBy.push(me); saveVotes();
        return sendJson(res, 200, { ok: true });
      }
      const vd = p.match(/^\/api\/votes\/([^/]+)$/);
      if (vd && method === 'DELETE') {
        if (!isAdmin(me)) return sendJson(res, 403, { error: '仅管理员可删除' });
        votes = votes.filter((x) => x.id !== vd[1]); saveVotes();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 匿名树洞（不记录作者，纯匿名）----
      if (p === '/api/moans' && method === 'GET') return sendJson(res, 200, { moans: moans.slice().reverse() });
      if (p === '/api/moans' && method === 'POST') {
        if (!rateLimit('moan:' + clientIp(req), 5, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        const text = (b.text || '').trim();
        if (!text) return sendJson(res, 400, { error: '内容不能为空' });
        if (text.length > 2000) return sendJson(res, 400, { error: '内容过长（最多2000字）' });
        moans.push({ id: crypto.randomUUID(), text, time: Date.now(), by: me }); // by 仅用于每日任务统计，前端不下发保持匿名
        saveMoans();
        return sendJson(res, 200, { ok: true });
      }
      const mnd = p.match(/^\/api\/moans\/([^/]+)$/);
      if (mnd && method === 'DELETE') {
        if (!isAdmin(me)) return sendJson(res, 403, { error: '仅管理员可删除' });
        moans = moans.filter((x) => x.id !== mnd[1]); saveMoans();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 平台媒体库（上传 mp4 / 音频，站内播放）----
      if (p === '/api/media' && method === 'GET') {
        const list = media.slice().sort((a, b) => b.createdAt - a.createdAt)
          .map((m) => ({ id: m.id, name: m.name, type: m.type, ext: m.ext, size: m.size, path: m.path, uploadedBy: m.uploadedBy, createdAt: m.createdAt }));
        return sendJson(res, 200, { media: list });
      }
      if (p === '/api/media' && method === 'POST') {
        if (!rateLimit('media:' + clientIp(req), 30, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        let dataUrl = b.dataUrl || '';
        let type = (b.type || '').toLowerCase();
        let name = (b.name || '未命名媒体').slice(0, 200);
        // 兼容 "data:<mime>;base64,<...>" 或纯 base64
        let mm = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        let buf, mime;
        if (mm) { mime = mm[1].toLowerCase(); buf = Buffer.from(mm[2], 'base64'); }
        else { mime = type || 'application/octet-stream'; try { buf = Buffer.from(String(dataUrl), 'base64'); } catch { return sendJson(res, 400, { error: '文件数据无法解析' }); } }
        if (!/^(video|audio)\//.test(mime)) return sendJson(res, 400, { error: '仅支持视频/音频文件（mp4/mp3 等）' });
        if (!buf || buf.length < 8) return sendJson(res, 400, { error: '文件内容为空或已损坏' });
        if (buf.length > 300 * 1024 * 1024) return sendJson(res, 400, { error: '媒体文件过大（上限 300MB）' });
        const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '');
        const fname = `media-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
        const rec = { id: crypto.randomUUID(), name, type: mime, ext, size: buf.length, path: '/uploads/' + fname, uploadedBy: me, createdAt: Date.now() };
        media.push(rec); saveMedia();
        return sendJson(res, 200, { media: rec });
      }
      const mdel = p.match(/^\/api\/media\/([^/]+)$/);
      if (mdel && method === 'DELETE') {
        const idx = media.findIndex((m) => m.id === mdel[1]);
        if (idx < 0) return sendJson(res, 404, { error: '媒体不存在' });
        const m = media[idx];
        if (!isAdmin(me) && m.uploadedBy !== me) return sendJson(res, 403, { error: '仅上传者或管理员可删除' });
        if (m.path) { try { fs.unlinkSync(path.join(UPLOADS_DIR, m.path.replace('/uploads/', ''))); } catch {} }
        media.splice(idx, 1); saveMedia();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 今日工作日报聚合（按任务分组今日消息）----
      if (p === '/api/daily' && method === 'GET') {
        const dayStart = new Date(todayStr() + 'T00:00:00').getTime();
        const byRoom = new Map();
        messages.forEach((m) => {
          if (m.time < dayStart || !m.user) return;
          if (!byRoom.has(m.roomId)) byRoom.set(m.roomId, []);
          byRoom.get(m.roomId).push(m);
        });
        // 返回全部任务（今日 0 条的也列出，便于日报勾选），有消息的带计数与摘要；加密任务仅对有权者可见
        const out = rooms.filter((room) => canAccessRoom(room, me)).map((room) => {
          const ms = byRoom.get(room.id) || [];
          return {
            id: room.id, name: room.name, count: ms.length,
            people: [...new Set(ms.map((m) => m.nickname))],
            snippets: ms.slice(-3).map((m) => (m.text || (m.image ? '[图片]' : ''))).filter(Boolean),
          };
        });
        return sendJson(res, 200, { rooms: out, date: todayStr() });
      }

      // ---- 通用图片上传（知识库等富文本用）----
      if (p === '/api/upload' && method === 'POST') {
        if (!rateLimit('up:' + clientIp(req), 20, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        try { const url = saveDataUrl(b.dataUrl, 'kb'); return sendJson(res, 200, { url }); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }

      // ---- 团队知识库（Wiki：文件夹 + 文档 + 全文搜索）----
      if (p === '/api/kb' && method === 'GET') {
        return sendJson(res, 200, { kb: { folders: kb.folders, docs: kb.docs.map((d) => ({ id: d.id, folderId: d.folderId, title: d.title, createdBy: d.createdBy, updatedBy: d.updatedBy, createdAt: d.createdAt, updatedAt: d.updatedAt, pinned: !!d.pinned })) } });
      }
      if (p === '/api/kb/search' && method === 'GET') {
        const q = (url.parse(req.url, true).query.q || '').trim().toLowerCase();
        if (!q) return sendJson(res, 200, { results: [] });
        const results = kb.docs.filter((d) => (d.title + ' ' + (d.content || '')).toLowerCase().includes(q))
          .slice(0, 30)
          .map((d) => ({ id: d.id, title: d.title, folderId: d.folderId, updatedAt: d.updatedAt }));
        return sendJson(res, 200, { results });
      }
      if (p === '/api/kb/folders' && method === 'POST') {
        if (!rateLimit('kb:' + clientIp(req), 30, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        const name = (b.name || '').trim();
        if (!name) return sendJson(res, 400, { error: '文件夹名不能为空' });
        kb.folders.push({ id: crypto.randomUUID(), name, parent: b.parent || null, createdBy: me });
        saveKb();
        return sendJson(res, 200, { ok: true });
      }
      const kbf = p.match(/^\/api\/kb\/folders\/([^/]+)$/);
      if (kbf && method === 'DELETE') {
        const fid = kbf[1];
        const folder = kb.folders.find((f) => f.id === fid);
        if (!folder) return sendJson(res, 404, { error: '文件夹不存在' });
        const isOwner = folder.createdBy === me;
        if (!isAdmin(me) && !isOwner) return sendJson(res, 403, { error: '只能删除自己创建的文件夹' });
        kb.folders = kb.folders.filter((f) => f.id !== fid);
        if (isAdmin(me)) {
          // 管理员删除：级联清除其下全部文档
          kb.docs = kb.docs.filter((d) => d.folderId !== fid);
        } else {
          // 作者删除：自己创建的文档一并删除，他人文档移回根目录（不误删）
          kb.docs = kb.docs.map((d) => {
            if (d.folderId !== fid) return d;
            if (d.createdBy === me) return null;
            d.folderId = null; return d;
          }).filter(Boolean);
        }
        saveKb();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/kb/docs' && method === 'POST') {
        if (!rateLimit('kb:' + clientIp(req), 30, 60000)) return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
        const b = JSON.parse(await readBody(req) || '{}');
        if (b.folderId && !kb.folders.find((f) => f.id === b.folderId)) return sendJson(res, 400, { error: '文件夹不存在' });
        const title = (b.title || '').trim() || '未命名文档';
        const doc = { id: crypto.randomUUID(), folderId: b.folderId || null, title, content: '', createdBy: me, updatedBy: me, createdAt: Date.now(), updatedAt: Date.now(), perms: {}, pinned: false };
        kb.docs.push(doc); saveKb();
        return sendJson(res, 200, { doc: { id: doc.id, title: doc.title, folderId: doc.folderId } });
      }
      const kbd = p.match(/^\/api\/kb\/docs\/([^/]+)$/);
      // ---- 文档置顶（仅管理员）----
      const kbpin = p.match(/^\/api\/kb\/docs\/([^/]+)\/pin$/);
      if (kbpin && method === 'PUT') {
        const doc = kb.docs.find((d) => d.id === kbpin[1]);
        if (!doc) return sendJson(res, 404, { error: '文档不存在' });
        if (!isAdmin(me)) return sendJson(res, 403, { error: '仅管理员可置顶' });
        const b = JSON.parse(await readBody(req) || '{}');
        doc.pinned = !!b.pinned;
        saveKb();
        return sendJson(res, 200, { ok: true, pinned: doc.pinned });
      }
      // ---- 文档权限设置（可管理/可编辑/仅查看）----
      const kbp = p.match(/^\/api\/kb\/docs\/([^/]+)\/perms$/);
      if (kbp && method === 'PUT') {
        const doc = kb.docs.find((d) => d.id === kbp[1]);
        if (!doc) return sendJson(res, 404, { error: '文档不存在' });
        if (!kbCanManage(doc, me)) return sendJson(res, 403, { error: '仅作者/管理员/可管理成员可设置权限' });
        const b = JSON.parse(await readBody(req) || '{}');
        const perms = {};
        if (b.perms && typeof b.perms === 'object') {
          for (const [email, lv] of Object.entries(b.perms)) {
            if (!KB_LEVELS.includes(lv)) continue;
            if (!users.find((u) => u.email === email)) continue; // 仅限平台成员
            perms[email] = lv;
          }
        }
        doc.perms = perms;
        doc.updatedBy = me; doc.updatedAt = Date.now();
        saveKb();
        return sendJson(res, 200, { ok: true, perms: doc.perms });
      }
      if (kbd && method === 'GET') {
        const doc = kb.docs.find((d) => d.id === kbd[1]);
        if (!doc) return sendJson(res, 404, { error: '文档不存在' });
        return sendJson(res, 200, { doc });
      }
      if (kbd && method === 'PUT') {
        const doc = kb.docs.find((d) => d.id === kbd[1]);
        if (!doc) return sendJson(res, 404, { error: '文档不存在' });
        if (!kbCanEdit(doc, me)) return sendJson(res, 403, { error: '无权编辑该文档（仅可查看）' });
        const b = JSON.parse(await readBody(req) || '{}');
        if (b.title !== undefined) { const t = String(b.title).trim(); if (!t) return sendJson(res, 400, { error: '标题不能为空' }); doc.title = t.slice(0, 200); }
        if (b.content !== undefined) { if (String(b.content).length > 100000) return sendJson(res, 400, { error: '内容过长' }); doc.content = String(b.content); }
        if (b.folderId !== undefined) {
          if (b.folderId && !kb.folders.find((f) => f.id === b.folderId)) return sendJson(res, 400, { error: '文件夹不存在' });
          doc.folderId = b.folderId || null;
        }
        doc.updatedBy = me; doc.updatedAt = Date.now(); saveKb();
        return sendJson(res, 200, { ok: true });
      }
      if (kbd && method === 'DELETE') {
        const doc = kb.docs.find((d) => d.id === kbd[1]);
        if (!doc) return sendJson(res, 404, { error: '文档不存在' });
        if (!isAdmin(me) && doc.createdBy !== me) return sendJson(res, 403, { error: '只能删除自己创建的文档' });
        kb.docs = kb.docs.filter((d) => d.id !== kbd[1]); saveKb();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 代办清单（按任务）----
      const tm = p.match(/^\/api\/rooms\/([^/]+)\/todos$/);
      if (tm && method === 'GET') {
        if (!canAccessRoom(rooms.find((r) => r.id === tm[1]), me)) return sendJson(res, 403, { error: '该任务已加密，请输入密码' });
        return sendJson(res, 200, { todos: todos.filter((x) => x.roomId === tm[1]) });
      }
      if (tm && method === 'POST') {
        const rid = tm[1];
        const room = rooms.find((r) => r.id === rid);
        if (!room) return sendJson(res, 404, { error: '任务不存在' });
        if (!canAccessRoom(room, me)) return sendJson(res, 403, { error: '该任务已加密，请输入密码' });
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
        if (typeof b.done === 'boolean' && b.done !== t.done) {
          t.done = b.done;
          if (b.done) {
            t.doneBy = me; t.doneAt = Date.now();
            if (t.by === me) { t.confirmed = true; t.confirmBy = me; t.confirmAt = Date.now(); }
            else { t.confirmed = false; t.confirmBy = null; }
          } else { t.doneBy = null; t.doneAt = null; t.confirmed = false; }
        }
        // 发布者确认他人完成的代办（每日任务5「协作完成」的前置）
        if (b.confirm === true && t.by === me && t.done && !t.confirmed) {
          t.confirmed = true; t.confirmBy = me; t.confirmAt = Date.now();
        }
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
        if (!canAccessRoom(rooms.find((r) => r.id === nm[1]), me)) return sendJson(res, 403, { error: '该任务已加密，请输入密码' });
        const n = notes.find((x) => x.roomId === nm[1]);
        return sendJson(res, 200, { text: n ? n.text : '' });
      }
      if (nm && method === 'POST') {
        const rid = nm[1];
        const room = rooms.find((r) => r.id === rid);
        if (!room) return sendJson(res, 404, { error: '任务不存在' });
        if (!canAccessRoom(room, me)) return sendJson(res, 403, { error: '该任务已加密，请输入密码' });
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
