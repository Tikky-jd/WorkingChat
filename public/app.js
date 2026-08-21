const $ = (s) => document.querySelector(s);
const BASE = window.API_BASE || '';
const api = async (method, path, body) => {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('oc_token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401) localStorage.removeItem('oc_token'); // token 失效/未登录，清掉
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
};

const THEMES = [
  { id: 'blue', name: '商务蓝' }, { id: 'dark', name: '暗夜' },
  { id: 'green', name: '清新绿' }, { id: 'orange', name: '暖橙' }, { id: 'gray', name: '简约灰' },
];

let me = null, myRole = null, myNick = null;
let rooms = [];
let currentRoomId = null;
let pendingRoomId = null;      // 待解锁的加密任务 id
let pendingImage = null;      // 待发送图片 dataURL
let pendingExitId = null;     // 待退出的加密任务 id（切换确认用）
let pendingEnterId = null;     // 确认退出后要进入的任务 id
let curMessages = [];          // 当前房间消息缓存（右键菜单查引用）
let editingMid = null;         // 正在重编辑的消息 id（null=发新消息）
let ctxMid = null;             // 右键选中的消息 id
let ctxRoomId = null;          // 右键选中的任务 id（任务设置菜单）
let pollTimer = null, presenceTimer = null;

const fmtTime = (t) => {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const show = (el, v) => el.classList.toggle('hidden', !v);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 白屏兜底：任何脚本异常都确保首页可见，避免手机端出现纯白屏 ----------
window.addEventListener('error', (e) => {
  try { const home = document.getElementById('home'); if (home) home.classList.remove('hidden'); } catch {}
});
window.addEventListener('unhandledrejection', () => {
  try { const home = document.getElementById('home'); if (home) home.classList.remove('hidden'); } catch {}
});

// 昵称 xx包 预览（取最后一字 + 包）
function baoPreview(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  const chars = Array.from(s);
  return chars[chars.length - 1] + '包';
}
$('#rgNick').addEventListener('input', (e) => {
  const v = baoPreview(e.target.value);
  $('#rgNickHint').textContent = v ? `登录后昵称将显示为「${v}」` : '昵称将自动变为「X包」';
});

// ---------- 登录/注册切换 ----------
let mode = 'login';
$('#tabLogin').onclick = () => { mode = 'login'; $('#tabLogin').classList.add('active'); $('#tabReg').classList.remove('active'); show($('#loginForm'), true); show($('#regForm'), false); $('#liMsg').textContent = ''; };
$('#tabReg').onclick = () => { mode = 'register'; $('#tabReg').classList.add('active'); $('#tabLogin').classList.remove('active'); show($('#loginForm'), false); show($('#regForm'), true); $('#liMsg').textContent = ''; };

$('#liSubmit').onclick = async () => {
  const email = $('#liEmail').value.trim(), password = $('#liPass').value;
  $('#liMsg').textContent = '';
  try { const d = await api('POST', '/api/login', { email, password }); if (d.token) localStorage.setItem('oc_token', d.token); await enter(); }
  catch (e) { $('#liMsg').textContent = e.message; }
};
$('#rgSubmit').onclick = async () => {
  const nickname = $('#rgNick').value, email = $('#rgEmail').value.trim(),
        invite = $('#rgInvite').value.trim(), password = $('#rgPass').value, confirm = $('#rgConfirm').value;
  $('#liMsg').textContent = '';
  try {
    const d = await api('POST', '/api/register', { nickname, email, invite, password, confirm });
    if (d.token) localStorage.setItem('oc_token', d.token);
    await enter();
  } catch (e) { $('#liMsg').textContent = e.message; }
};

$('#logout').onclick = async () => {
  stopTimers();
  closeSSE();
  try { await api('POST', '/api/logout'); } catch {}
  localStorage.removeItem('oc_token');
  location.reload();
};

// ---------- 进入应用 ----------
async function enter() {
  const me_ = await api('GET', '/api/me');
  me = me_.email; myRole = me_.role; myNick = me_.nickname;
  $('#meName').textContent = myNick;
  show($('#home'), false);
  show($('#login'), false);
  show($('#app'), true);
  show($('#adminBtn'), myRole === 'admin');
  await loadTheme();
  await loadRooms();
  await loadRank();
  connectSSE();
  loadNotifMuted();   // 读取各任务浏览器提示开关（权限请求见 oncePerm：仅非交互区域点击触发）
}

// 首页「进入协作台」/ 导航登录 → 显示登录/注册
function revealLogin() {
  mode = 'login'; $('#tabLogin').classList.add('active'); $('#tabReg').classList.remove('active');
  show($('#loginForm'), true); show($('#regForm'), false);
  show($('#home'), false); show($('#login'), true);
  $('#liMsg').textContent = ''; $('#liEmail').focus();
}
['#enterBtn', '#enterBtn2', '#enterBtn3', '#navLogin'].forEach((id) => { const el = $(id); if (el) el.onclick = revealLogin; });

// ---------- 任务室 ----------
async function loadRooms() {
  rooms = (await api('GET', '/api/rooms')).rooms;
  renderRooms();
}
function renderRooms() {
  const box = $('#roomList');
  box.innerHTML = '';
  rooms.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'room-item' + (r.id === currentRoomId ? ' active' : '');
    div.dataset.rid = r.id;
    const delBtn = myRole === 'admin' ? `<button class="room-del" title="删除此任务（含其下所有内容）" data-act="delroom" data-id="${r.id}">✕</button>` : '';
    const un = unread[r.id] || 0;
    div.innerHTML = `<span class="room-idx">任务${i + 1}</span><span class="room-name">${r.encrypted ? '🔒 ' : ''}${escapeHtml(r.name)}</span>${un > 0 ? `<span class="room-unread" title="${un} 条未读"></span>` : ''}${delBtn}`;
    div.onclick = () => selectRoom(r.id);
    box.appendChild(div);
  });
}
// 管理员删除任务（级联清理）
async function delRoom(id) {
  if (!confirm('确定删除该任务？其下所有消息/待办/备注将一并删除，不可恢复！')) return;
  try {
    await api('DELETE', `/api/rooms/${id}`);
    if (currentRoomId === id) { currentRoomId = null; $('#roomTitle').textContent = '请选择左侧任务'; renderTodos([]); $('#notesArea').value = ''; }
    await loadRooms();
  } catch (e) { alert(e.message); }
}
window.delRoom = delRoom;
$('#newTask').onclick = () => { $('#taskName').value = ''; show($('#taskModal'), true); $('#taskName').focus(); };
$('#closeTask').onclick = () => show($('#taskModal'), false);
// 新建任务（公开/加密）
document.querySelectorAll('input[name=taskVis]').forEach((r) => {
  r.onchange = () => show($('#taskPass'), document.querySelector('input[name=taskVis]:checked').value === 'encrypted');
});
$('#taskCreate').onclick = async () => {
  const name = $('#taskName').value.trim();
  if (!name) return;
  const vis = document.querySelector('input[name=taskVis]:checked').value;
  const body = { name };
  if (vis === 'encrypted') {
    const pw = $('#taskPass').value;
    if (!pw) { alert('加密任务需设置访问密码'); return; }
    body.encrypted = true; body.password = pw;
  }
  try {
    const { room } = await api('POST', '/api/rooms', body);
    show($('#taskModal'), false); $('#taskPass').value = ''; document.querySelector('input[name=taskVis][value=public]').checked = true; show($('#taskPass'), false);
    await loadRooms(); selectRoom(room.id);
  } catch (e) { alert(e.message); }
};
// 解锁加密任务
function isAdminOrCreator(r) { return myRole === 'admin' || (r && r.createdBy === me); }
function showUnlock(id) {
  const r = rooms.find((x) => x.id === id);
  pendingRoomId = id;
  $('#unlockTitle').textContent = `「${r ? r.name : '该任务'}」已加密，请输入访问密码`;
  $('#unlockPass').value = '';
  show($('#unlockModal'), true);
  $('#unlockPass').focus();
}
$('#unlockConfirm').onclick = async () => {
  const id = pendingRoomId;
  if (!id) return;
  try {
    await api('POST', `/api/rooms/${id}/unlock`, { password: $('#unlockPass').value });
    show($('#unlockModal'), false);
    await enterRoom(id);
  } catch (e) { alert(e.message); }
};
$('#closeUnlock').onclick = () => show($('#unlockModal'), false);

// 确认退出加密任务（切换其它任务时触发）
$('#exitConfirm').onclick = async () => {
  const oldId = pendingExitId;
  show($('#exitModal'), false);
  if (oldId) { try { await api('POST', `/api/rooms/${oldId}/exit`); } catch {} }
  const newId = pendingEnterId; pendingExitId = null; pendingEnterId = null;
  if (newId) proceedEnter(newId);
};
$('#exitClose').onclick = () => { show($('#exitModal'), false); pendingExitId = null; pendingEnterId = null; };
$('#exitCancel').onclick = () => { show($('#exitModal'), false); pendingExitId = null; pendingEnterId = null; };

async function selectRoom(id) {
  const target = rooms.find((r) => r.id === id);
  const cur = rooms.find((r) => r.id === currentRoomId);
  // 从加密任务切换到其它任务 = 退出当前任务，需确认
  if (cur && cur.encrypted && currentRoomId !== id) {
    pendingExitId = currentRoomId; pendingEnterId = id;
    $('#exitTitle').textContent = isAdminOrCreator(cur)
      ? `将退出加密任务「${cur.name}」（你是管理员/创建者，可随时免密返回）。`
      : `确认退出加密任务「${cur.name}」？退出后需重新输入密码才能再次进入。`;
    show($('#exitModal'), true);
    return;
  }
  proceedEnter(id);
}
async function proceedEnter(id) {
  const target = rooms.find((r) => r.id === id);
  // 加密任务：管理员/创建者免密；其它成员每次进入都需密码
  if (target && target.encrypted && myRole !== 'admin' && target.createdBy !== me) { showUnlock(id); return; }
  await enterRoom(id);
}
async function enterRoom(id) {
  currentRoomId = id;
  unread[id] = 0; updateFavicon(); // 进入任务清零未读（renderRooms 随后刷新列表角标）
  editingMid = null; // 进入新任务清空重编辑态
  const idx = rooms.findIndex((r) => r.id === id);
  const label = idx > -1 ? `任务${idx + 1}：${rooms[idx].name}` : '';
  $('#roomTitle').textContent = label;
  $('#todoScope').textContent = label;
  $('#notesTip').textContent = label ? '自动保存' : '';
  renderRooms();
  if (!currentRoomId) { renderTodos([]); $('#notesArea').value = ''; return; }
  try {
    await loadMessages();
    await loadTodos();
    await loadNotes();
  } catch (e) {
    // 服务端判定未解锁（含重启清态 / 刚切换任务）→ 重新弹密码框
    if (e && e.message && e.message.indexOf('加密') > -1) { showUnlock(id); return; }
    throw e;
  }
  startRoomLive();
}

// ---------- 消息 ----------
async function loadMessages() {
  if (!currentRoomId) return;
  const { messages } = await api('GET', `/api/rooms/${currentRoomId}/messages`);
  const prev = curMessages || [];
  renderMessages(messages);
  // 轮询兜底：SSE 断线/服务器未关 Nginx 缓冲时，后台标签页也要响"滴滴"+亮角标
  // （2s 内 SSE 刚推过则跳过，避免与 SSE 路径重复提示）
  if (document.hidden && prev.length && Date.now() - lastSseMsgAt > 2000) {
    const fresh = messages.filter((m) => !m.recalled && !prev.some((p) => p.id === m.id));
    if (fresh.length) { bumpUnread(currentRoomId); notifyNewMsg(currentRoomId); }
  }
}
function renderMessages(list) {
  curMessages = list || [];
  const box = $('#messages');
  // 关键：在清空 DOM 之前记录滚动状态，否则清空后 scrollHeight/scrollTop 归零，atBottom 永远为 true → 历史被强制回滚底部
  const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const prevScrollTop = box.scrollTop;
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">还没有消息，发一条吧</div>'; box.scrollTop = 0; updateScrollBtn(); return; }
  list.forEach((m) => {
    const row = document.createElement('div');
    row.dataset.mid = m.id;
    if (m.recalled) {
      row.className = 'msg-row recalled-row';
      row.innerHTML = `<div class="msg-recalled">${escapeHtml(m.nickname || '成员')} 撤回了一条消息</div>`;
      box.appendChild(row);
      return;
    }
    row.className = 'msg-row ' + (m.user === me ? 'me' : 'other');
    let inner = '';
    if (m.image) inner += `<img class="msg-img" src="${BASE + m.image}" alt="图片" data-act="openimg" data-src="${BASE + m.image}" />`;
    if (m.text) inner += `<div class="text">${escapeHtml(m.text)}</div>`;
    const own = m.user === me;
    const delBtn = (myRole === 'admin' || own) && !m.recalled ? `<button class="msg-del" title="删除此消息" data-act="delmsg" data-id="${m.id}">✕</button>` : '';
    const editedTag = m.edited ? '<span class="msg-edited">已编辑</span>' : '';
    const title2Tag = m.title2 ? `<span class="msg-title2">${escapeHtml(m.title2)}</span>` : '';
    row.innerHTML = `<div class="bubble"><div class="meta"><span class="who">${escapeHtml(m.nickname)}</span>${title2Tag}<span class="time">${fmtTime(m.time)}</span>${editedTag}${delBtn}</div>${inner}</div>`;
    box.appendChild(row);
  });
  // 仅在用户本就贴近底部时才回到底部；否则保留其历史浏览位置
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevScrollTop;
  updateScrollBtn();
}

// 管理员删除消息
async function delMessage(mid) {
  if (!currentRoomId) return;
  if (!confirm('确定删除这条消息吗？')) return;
  try { await api('DELETE', `/api/rooms/${currentRoomId}/messages/${mid}`); await loadMessages(); }
  catch (e) { alert(e.message); }
}
window.delMessage = delMessage;

$('#send').onclick = sendMsg;
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
async function sendMsg() {
  if (!currentRoomId) return;
  const text = $('#input').value.trim();
  if (!text && !pendingImage) return;
  if (editingMid) {
    // 重编辑：更新原消息（仅文本）
    const id = editingMid; editingMid = null;
    $('#input').value = '';
    try { await api('PATCH', `/api/rooms/${currentRoomId}/messages/${id}`, { text }); await loadMessages(); }
    catch (e) { alert(e.message); }
    return;
  }
  const body = {};
  if (text) body.text = text;
  if (pendingImage) body.image = pendingImage;
  $('#input').value = '';
  clearPendingImage();
  try { await api('POST', `/api/rooms/${currentRoomId}/messages`, body); await loadMessages(); }
  catch (e) { alert(e.message); }
}

// 图片选择
$('#addFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('仅支持图片文件'); e.target.value = ''; return; }
  if (file.size > 10 * 1024 * 1024) { alert('图片不能超过 10MB'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { pendingImage = reader.result; renderImgChip(); };
  reader.readAsDataURL(file);
  e.target.value = '';
};
function renderImgChip() {
  const chip = $('#imgChip');
  if (!pendingImage) { show(chip, false); chip.innerHTML = ''; return; }
  chip.innerHTML = `<img src="${pendingImage}" class="chip-img"/><button class="chip-x" data-act="clearimg">✕</button><span class="chip-tip">随发送一起发出</span>`;
  show(chip, true);
}
function clearPendingImage() { pendingImage = null; renderImgChip(); }
window.clearPendingImage = clearPendingImage;

// ---------- 回到底部悬浮按钮（纯图标，无文字）----------
function isAtBottom() { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 60; }
function updateScrollBtn() { const b = $('#scrollBottom'); if (b) show(b, !isAtBottom() && !!currentRoomId); }
$('#messages').addEventListener('scroll', updateScrollBtn);
$('#scrollBottom').onclick = () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; };

// ---------- 消息右键操作菜单（撤回 / 重编辑 / 引用）----------
function hideMsgMenu() { show($('#msgMenu'), false); }
function startEdit(m) {
  editingMid = m.id;
  $('#input').value = m.text || '';
  $('#input').focus();
  flash('正在重编辑，发送即更新原消息（仅文本）');
}
$('#messages').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.msg-row');
  if (!row || !currentRoomId) return;
  e.preventDefault();
  ctxMid = row.dataset.mid;
  const m = curMessages.find((x) => x.id === ctxMid);
  if (!m || m.recalled) { hideMsgMenu(); return; }
  const own = m.user === me;
  show($('#ctxRecall'), !!own || myRole === 'admin');
  show($('#ctxReedit'), !!own && !!m.text);
  show($('#ctxQuote'), true);
  const menu = $('#msgMenu');
  menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 140) + 'px';
  show(menu, true);
});
$('#ctxRecall').onclick = async () => {
  hideMsgMenu();
  if (!ctxMid || !currentRoomId) return;
  try { await api('DELETE', `/api/rooms/${currentRoomId}/messages/${ctxMid}`); await loadMessages(); }
  catch (e) { alert(e.message); }
};
$('#ctxReedit').onclick = () => {
  hideMsgMenu();
  const m = curMessages.find((x) => x.id === ctxMid);
  if (m) startEdit(m);
};
$('#ctxQuote').onclick = () => {
  hideMsgMenu();
  const m = curMessages.find((x) => x.id === ctxMid);
  if (m) { const q = `> ${m.nickname}：${m.text || '[图片]'}\n`; $('#input').value = q + $('#input').value; $('#input').focus(); }
};
// ---------- 任务设置菜单（右键任务：浏览器提示开/关）----------
function hideRoomMenu() { show($('#roomMenu'), false); }
$('#roomList').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.room-item');
  if (!item) return;
  e.preventDefault();
  hideMsgMenu();
  ctxRoomId = item.dataset.rid;
  $('#roomNotifToggle').textContent = notifMuted[ctxRoomId] ? '开启浏览器提示' : '关闭浏览器提示';
  const menu = $('#roomMenu');
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 60) + 'px';
  show(menu, true);
});
$('#roomNotifToggle').onclick = () => {
  hideRoomMenu();
  if (!ctxRoomId) return;
  if (notifMuted[ctxRoomId]) delete notifMuted[ctxRoomId]; else notifMuted[ctxRoomId] = true;
  saveNotifMuted();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#msgMenu')) hideMsgMenu();
  if (!e.target.closest('#roomMenu')) hideRoomMenu();
});
document.addEventListener('scroll', () => { hideMsgMenu(); hideRoomMenu(); }, true);

// 模型下拉（演示）
$('#modelSel').onchange = (e) => { if (e.target.value) flash(`已选择模型：${e.target.value}（演示，仅展示）`); };

// 语音输入（浏览器 Web Speech API）
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const rec = new SR();
  rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = false;
  let finalTxt = '';
  rec.onresult = (ev) => {
    let t = '';
    for (const r of ev.results) t += r[0].transcript;
    $('#input').value = (finalTxt + t).trimStart();
  };
  rec.onend = () => { finalTxt = $('#input').value; $('#voiceBtn').classList.remove('rec'); };
  $('#voiceBtn').onclick = () => {
    if (recodings_active()) return;
    finalTxt = $('#input').value; $('#voiceBtn').classList.add('rec'); rec.start();
  };
  function recodings_active() { return $('#voiceBtn').classList.contains('rec'); }
} else {
  $('#voiceBtn').disabled = true; $('#voiceBtn').title = '当前浏览器不支持语音输入（建议 Chrome/Edge）';
}

// ---------- 未读消息角标（tab 图标红点+数字；任务列表同步角标）----------
const unread = {}; // roomId -> 未读数
let favIcon = null, favBase = '';
function initFavicon() {
  favIcon = document.querySelector('link[rel="icon"]');
  if (!favIcon) return;
  favBase = favIcon.href || '';
}
function totalUnread() { let n = 0; for (const k in unread) n += unread[k]; return n; }
function drawBaseIcon(ctx) {
  // 蓝色圆角方块 + 三条白杠（与 index.html 的 favicon 一致）
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(4, 4, 56, 56, 14);
  else ctx.rect(4, 4, 56, 56);
  ctx.fillStyle = '#2563eb'; ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fillRect(16, 18, 32, 5);
  ctx.globalAlpha = 0.8; ctx.fillRect(16, 29, 22, 5);
  ctx.globalAlpha = 0.65; ctx.fillRect(16, 40, 28, 5);
  ctx.globalAlpha = 1;
}
function updateFavicon() {
  if (!favIcon) return;
  const n = totalUnread();
  if (n <= 0) { favIcon.href = favBase; return; }
  // 纯 canvas 直接画：基础图标 + 红色数字角标，同步生成，不依赖图片加载
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  drawBaseIcon(ctx);
  const text = n > 99 ? '99+' : String(n);
  ctx.beginPath(); ctx.arc(47, 17, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444'; ctx.fill();
  ctx.lineWidth = 3.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 47, 17.5);
  favIcon.href = c.toDataURL('image/png');
}
function bumpUnread(id) { if (!id) return; unread[id] = (unread[id] || 0) + 1; updateFavicon(); renderRooms(); }
function clearRoomUnread(id) { if (id && unread[id]) { unread[id] = 0; updateFavicon(); renderRooms(); } }
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearRoomUnread(currentRoomId); });

// ---------- 系统通知（任务栏图标闪烁 + 弹窗；手机端震动）+ 自定义"滴滴"音效 ----------
let notifIcon = '';
let notifMuted = {}; // roomId -> true（该任务关闭浏览器提示）
function loadNotifMuted() { try { notifMuted = JSON.parse(localStorage.getItem('oc_notif_muted') || '{}'); } catch { notifMuted = {}; } }
function saveNotifMuted() { try { localStorage.setItem('oc_notif_muted', JSON.stringify(notifMuted)); } catch {} }
function getNotifIcon() {
  if (notifIcon) return notifIcon;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  drawBaseIcon(c.getContext('2d'));
  notifIcon = c.toDataURL('image/png');
  return notifIcon;
}
let beepCtx = null, lastBeepAt = 0;
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!beepCtx) beepCtx = new AC();
    if (beepCtx.state === 'suspended') beepCtx.resume();
  } catch {}
}
function playBeep() {
  const now = Date.now();
  if (now - lastBeepAt < 1500) return; // 防连发轰炸：1.5s 内只响一次"滴滴"
  lastBeepAt = now;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!beepCtx) beepCtx = new AC();
    if (beepCtx.state === 'suspended') beepCtx.resume();
    const ctx = beepCtx, t0 = ctx.currentTime;
    for (let i = 0; i < 2; i++) { // 两声"嘀嘀"：880Hz 短音 × 2，间隔 160ms
      const t = t0 + i * 0.16;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.12);
    }
  } catch {}
}
function ensureNotifyPerm() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try { Notification.requestPermission(); } catch {}
}
function notifyNewMsg(roomId) {
  if (notifMuted[roomId]) return; // 该任务已在设置菜单中关闭浏览器提示
  playBeep(); // "滴滴"音效不依赖通知权限（页面点过一次解锁音频即可响）
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const r = rooms.find((x) => x.id === roomId);
  try {
    const n = new Notification('协作台', {
      body: `「${r ? r.name : '某任务'}」收到新消息（共 ${totalUnread()} 条未读）`,
      tag: 'oc-msg-' + roomId,
      icon: getNotifIcon(),
      silent: true, // 关掉系统默认提示音，改用自定义"滴滴"
    });
    n.onclick = () => { window.focus(); n.close(); };
    if (navigator.vibrate) try { navigator.vibrate(120); } catch {}
  } catch {}
}
// 请求通知权限（浏览器要求用户手势）。只允许在点击【非交互区域】时触发：
// 若在点击任务/输入框/按钮时弹权限，Firefox 的模态权限弹窗会阻塞页面，
// 导致用户点进加密任务后无法输入密码（管理员免密不经过该流程，只有普通用户会撞上）。
document.addEventListener('click', function oncePerm(e) {
  const t = e.target;
  const interactive = t && t.closest ? t.closest('.modal, .room-item, .msg-row, input, textarea, button, select, a, .ctx-menu') : null;
  if (interactive) { unlockAudio(); return; } // 交互元素上只解锁音频，绝不弹权限
  ensureNotifyPerm();
  unlockAudio();
  document.removeEventListener('click', oncePerm);
}, { capture: true });

// ---------- SSE 实时推送（消息秒达；轮询保留兜底）----------
let sse = null;
let lastSseMsgAt = 0; // 最近一次 SSE 消息时间戳（轮询兜底据此避免重复提示）
function connectSSE() {
  initFavicon();
  const token = localStorage.getItem('oc_token');
  if (!token || sse) return;
  try {
    sse = new EventSource(BASE + '/api/stream?token=' + encodeURIComponent(token));
    sse.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d || !d.type) return;
        if (d.type === 'message') {
          lastSseMsgAt = Date.now();
          // 当前任务且标签页在前台 → 立即刷新（已读）；否则计入未读角标 + 提示音/系统通知
          if (d.roomId === currentRoomId && !document.hidden) loadMessages().catch(() => {});
          else { bumpUnread(d.roomId); notifyNewMsg(d.roomId); }
        }
        else if (d.type === 'roomCreated') loadRooms().catch(() => {});
        else if (d.type === 'talisman') showTalismanNotice(d.text || '');
        else if (d.type === 'roomDeleted') {
          unread[d.roomId] = 0;
          if (d.roomId === currentRoomId) {
            currentRoomId = null;
            $('#roomTitle').textContent = '请选择左侧任务';
            renderTodos([]);
            $('#notesArea').value = '';
          }
          updateFavicon();
          loadRooms().catch(() => {});
        }
      } catch {}
    };
    // EventSource 断线自动重连，无需手动处理 error
  } catch {}
}
function closeSSE() { if (sse) { sse.close(); sse = null; } }

// 符类生效通知：显示在 AI任务区 Header 绿色圆左侧，8 秒后淡出，并响"嘟嘟"提示音
let talismanTimer = null;
function showTalismanNotice(text) {
  const el = $('#talismanNotice');
  if (!el) return;
  el.textContent = '⚡ ' + (text || '');
  el.classList.remove('fade-out');
  show(el, true);
  playBeep(); // 与消息提示音一致
  clearTimeout(talismanTimer);
  talismanTimer = setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => show(el, false), 450);
  }, 8000);
}

// 道具使用记录：查询弹窗（未及时看到实时通知时，可随时回看明细）
async function openTalismanLog() {
  show($('#talismanLogModal'), true);
  $('#talismanLogList').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const { log } = await api('GET', '/api/talisman/log');
    const box = $('#talismanLogList');
    if (!log || !log.length) { box.innerHTML = '<div class="empty">暂无道具使用记录</div>'; return; }
    box.innerHTML = log.map((r) => `
      <div class="talisman-log-item">
        <span class="talisman-log-time">${fmtTime(r.time)}</span>
        <span class="talisman-log-text">${escapeHtml(r.text)}</span>
      </div>`).join('');
  } catch (e) { $('#talismanLogList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
$('#talismanLogBtn').onclick = openTalismanLog;
$('#talismanLogClose').onclick = () => show($('#talismanLogModal'), false);

// ---------- 在线状态（按房间）+ 消息轮询 ----------
function startRoomLive() {
  stopRoomTimers();
  // 每 5 秒上报在线 + 拉在线名单；每 3 秒拉消息（半实时）
  presenceTimer = setInterval(() => {
    if (currentRoomId) {
      api('POST', '/api/presence', { roomId: currentRoomId }).then((d) => renderDots(d.online)).catch(() => {});
      loadRank().catch(() => {});
    }
  }, 5000);
  pollTimer = setInterval(() => { if (currentRoomId) loadMessages().catch(() => {}); }, 3000);
  // 立即上报 + 立即拉一次
  if (currentRoomId) {
    api('POST', '/api/presence', { roomId: currentRoomId }).then((d) => renderDots(d.online)).catch(() => {});
    loadMessages().catch(() => {});
  }
  window.addEventListener('beforeunload', leavePresence);
}
function stopRoomTimers() {
  if (presenceTimer) clearInterval(presenceTimer);
  if (pollTimer) clearInterval(pollTimer);
}
function leavePresence() { if (currentRoomId) api('POST', '/api/presence', { roomId: null }).catch(() => {}); }
function renderDots(online) {
  const box = $('#onlineDots');
  const n = online.length;
  box.innerHTML = '';
  if (!n) { box.title = '当前无人'; return; }
  const show = Math.min(n, 3);
  for (let i = 0; i < show; i++) {
    const d = document.createElement('span'); d.className = 'dot-online';
    box.appendChild(d);
  }
  if (n > 3) { const num = document.createElement('span'); num.className = 'dot-num'; num.textContent = n; box.appendChild(num); }
  box.title = '在线：' + online.map((o) => o.nickname).join('、');
}

// 登录后启动房间实时（在线 + 消息轮询）
function startTimers() { startRoomLive(); }
function stopTimers() { stopRoomTimers(); if (pollTimer) clearInterval(pollTimer); window.removeEventListener('beforeunload', leavePresence); }

// ---------- 代办清单 ----------
async function loadTodos() {
  if (!currentRoomId) { renderTodos([]); return; }
  try { const { todos } = await api('GET', `/api/rooms/${currentRoomId}/todos`); renderTodos(todos); }
  catch { renderTodos([]); }
}
function renderTodos(list) {
  const box = $('#todoList');
  if (!currentRoomId) { box.innerHTML = '<div class="empty">请先选择左侧任务</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="empty">暂无代办，添加一项吧</div>'; return; }
  box.innerHTML = '';
  list.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'todo-item' + (t.done ? ' done' : '');
    const isMine = t.by === me;
    // 别人完成了我布置的代办 → 我确认后任务5才成立；我完成的别人代办 → 等待对方确认
    const needConfirm = t.done && isMine && t.doneBy && t.doneBy !== me && !t.confirmed;
    const waitConfirm = t.done && !isMine && t.doneBy === me && !t.confirmed;
    let extra = '';
    if (waitConfirm) extra = '<span class="todo-wait">待发布者确认</span>';
    if (needConfirm) extra = `<button class="todo-confirm" data-tid="${t.id}">✓ 确认完成</button>`;
    row.innerHTML = `<label class="todo-check"><input type="checkbox" ${t.done ? 'checked' : ''}/><span class="todo-text">${escapeHtml(t.text)}</span></label>${extra}<button class="todo-x" title="删除">✕</button>`;
    row.querySelector('input').onchange = () => toggleTodo(t.id, row.querySelector('input').checked);
    row.querySelector('.todo-x').onclick = () => deleteTodo(t.id);
    const cf = row.querySelector('.todo-confirm');
    if (cf) cf.onclick = () => confirmTodo(t.id);
    box.appendChild(row);
  });
}
async function confirmTodo(tid) {
  try {
    await api('PUT', `/api/rooms/${currentRoomId}/todos/${tid}`, { confirm: true });
    await loadTodos();
    flash('已确认完成，协作任务 +1');
  } catch (e) { alert(e.message); }
}
async function addTodo() {
  if (!currentRoomId) { flash('请先选择左侧任务'); return; }
  const inp = $('#todoInput'); const text = inp.value.trim();
  if (!text) return;
  try { const { todo } = await api('POST', `/api/rooms/${currentRoomId}/todos`, { text }); inp.value = ''; await loadTodos(); }
  catch (e) { alert(e.message); }
}
async function toggleTodo(tid, done) {
  try { await api('PUT', `/api/rooms/${currentRoomId}/todos/${tid}`, { done }); }
  catch (e) { alert(e.message); loadTodos(); }
}
async function deleteTodo(tid) {
  try { await api('DELETE', `/api/rooms/${currentRoomId}/todos/${tid}`); await loadTodos(); }
  catch (e) { alert(e.message); }
}
$('#todoAdd').onclick = addTodo;
$('#todoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTodo(); } });

// ---------- 备注 ----------
async function loadNotes() {
  if (!currentRoomId) { $('#notesArea').value = ''; return; }
  try { const { text } = await api('GET', `/api/rooms/${currentRoomId}/notes`); $('#notesArea').value = text || ''; }
  catch { $('#notesArea').value = ''; }
}
let notesTimer = null;
$('#notesArea').addEventListener('input', () => {
  if (!currentRoomId) return;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    api('POST', `/api/rooms/${currentRoomId}/notes`, { text: $('#notesArea').value }).catch(() => {});
  }, 800);
});

// ---------- 今日活跃榜（摸鱼指数，替代原成员展示）----------
async function loadRank() {
  try { const { rank } = await api('GET', '/api/rank'); renderRank(rank); }
  catch {}
}
function renderRank(list) {
  const box = $('#memberList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  list.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'member-item' + (m.glow ? ' glow-gold' : '');
    const mins = Math.floor(m.onlineSec / 60000); // onlineSec 单位是毫秒 → 转分钟
    const role = m.role === 'admin' ? '<span class="member-role">管理员</span>' : '';
    const avatarHtml = m.avatar ? `<span class="member-ava ${m.avatarFrame === 'gold' ? 'frame-gold' : ''}"><img src="${BASE + m.avatar}" alt="" /></span>` : '';
    const title2Html = m.title2 ? `<span class="member-title2">${escapeHtml(m.title2)}</span>` : '';
    const sloganHtml = m.slogan ? `<span class="member-slogan">「${escapeHtml(m.slogan)}」</span>` : '';
    row.innerHTML =
      `<span class="member-dot ${m.online ? 'on' : ''}"></span>` +
      `<span class="rank-no">${i + 1}</span>` +
      `<span class="rank-title t-${m.title}">${m.title}</span>` +
      avatarHtml +
      `<span class="member-name">${escapeHtml(m.nickname)}</span>${role}${title2Html}` +
      `<span class="rank-score">${m.score}分</span>` +
      `<span class="member-email">在线${mins}分 · 消息${m.msgs} · 完成${m.done}</span>` +
      sloganHtml;
    box.appendChild(row);
  });
}

// ---------- 主题 ----------
async function loadTheme() { const { theme } = await api('GET', '/api/theme'); applyTheme(theme); }
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme.colorTheme || 'blue');
  const layer = $('#bgLayer');
  if (theme.bgImage) { layer.style.backgroundImage = `url('${BASE}/uploads/${theme.bgImage}')`; show(layer, true); }
  else { layer.style.backgroundImage = ''; show(layer, false); }
  $('#bgPreview').style.backgroundImage = theme.bgImage ? `url('${BASE}/uploads/${theme.bgImage}')` : '';
  show($('#bgPreview'), !!theme.bgImage);
}
$('#openTheme').onclick = () => { renderSwatches(); show($('#themeModal'), true); };
$('#closeTheme').onclick = () => show($('#themeModal'), false);
function renderSwatches() {
  const box = $('#themeSwatches'); box.innerHTML = '';
  const cur = document.body.getAttribute('data-theme');
  THEMES.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (t.id === cur ? ' active' : '');
    b.innerHTML = `<span class="dot dot-${t.id}"></span>${t.name}`;
    b.onclick = async () => { try { const { theme } = await api('POST', '/api/theme', { colorTheme: t.id }); applyTheme(theme); renderSwatches(); } catch (e) { alert(e.message); } };
    box.appendChild(b);
  });
}
$('#bgFile').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => { try { const { theme } = await api('POST', '/api/theme/background', { dataUrl: reader.result }); applyTheme(theme); } catch (err) { alert(err.message); } };
  reader.readAsDataURL(file); e.target.value = '';
};
$('#bgRemove').onclick = async () => { try { const { theme } = await api('DELETE', '/api/theme/background'); applyTheme(theme); } catch (e) { alert(e.message); } };

// ---------- 管理员邀请码 ----------
$('#adminBtn').onclick = async () => { await loadInvites(); show($('#adminModal'), true); };
$('#closeAdmin').onclick = () => show($('#adminModal'), false);
async function loadInvites() {
  const { invites } = await api('GET', '/api/admin/invites');
  const box = $('#inviteList'); box.innerHTML = '';
  invites.slice().reverse().forEach((iv) => {
    const row = document.createElement('div');
    row.className = 'invite-row';
    const status = iv.used ? `<span class="inv-used">已使用 · ${iv.usedBy || ''}</span>` : `<span class="inv-ok">可用</span>`;
    row.innerHTML = `<code class="inv-code">${iv.code}</code>${status}`;
    box.appendChild(row);
  });
}
$('#genInvite').onclick = async () => {
  try { await api('POST', '/api/admin/invites'); await loadInvites(); }
  catch (e) { alert(e.message); }
};

// ---------- 视图切换（主界面 ↔ 功能页面）----------
let currentView = 'main';
function goView(name) {
  const prev = currentView;
  currentView = name;
  // 离开媒体页时，若页内仍有媒体在播放，转入后台播放器（音乐/视频继续，并浮现控制条）
  if (prev === 'media' && name !== 'media') {
    let playing = null;
    document.querySelectorAll('#page-media .media-card video, #page-media .media-card audio')
      .forEach((el) => { if (!el.paused && !playing) playing = el; });
    if (playing) {
      const card = playing.closest('.media-card');
      const nameEl = card && card.querySelector('.media-name');
      setMedia(playing.currentSrc || playing.src, nameEl ? nameEl.textContent : '媒体', playing.tagName === 'VIDEO', playing.currentTime);
      playing.pause();
    }
  }
  const isMain = name === 'main';
  show($('#app'), isMain);
  show($('#page-me'), name === 'me');
  show($('#page-media'), name === 'media');
  show($('#page-vote'), name === 'vote');
  show($('#page-moan'), name === 'moan');
  show($('#page-kb'), name === 'kb');
  if (name === 'main') startRoomLive();
  else stopRoomTimers();
  if (name === 'me') loadMe();
  if (name === 'media') loadMedia();
  if (name === 'vote') loadVotes();
  if (name === 'moan') loadMoans();
  if (name === 'kb') loadKb();
}
window.goView = goView;

// ---------- 个人中心（资料 / 签到任务 / 商城灵石） ----------
const SIGNIN_REWARD = { bonus: 5, xp: 10 };
const DAILY_REWARD = { bonus: 5, xp: 25 };
const NEWBIE_REWARD = { bonus: 10, xp: 50 };
const NEWBIE_DAYS = 30;
const SPIRIT_ORDER = ['xp', 'zp', 'sp', 'jp'];
const SPIRIT_NAMES = { jp: '极品灵石', sp: '上品灵石', zp: '中品灵石', xp: '下品灵石' };
const SPIRIT_ICONS = { jp: '💎', sp: '🔮', zp: '🪨', xp: '⚪' };

let meData = null;
$('#meBtn').onclick = () => goView('me');

async function loadMe() {
  try { meData = await api('GET', '/api/me'); }
  catch (e) { meData = null; flash(e.message); return; }
  renderProfile();
  renderTasksPane();
  renderShop();
}

// ---- 板块1：个人资料（默认只读，点击「编辑资料」进入编辑态） ----
function renderProfile() {
  const d = meData || {};
  const p = d.profile || {};
  const marriedText = p.married === true ? '已婚' : p.married === false ? '未婚' : '未设置';
  const field = (label, val, extra) => `
    <div class="me-field">
      <span class="me-field-label">${label}</span>
      <span class="me-field-val">${val}</span>${extra || ''}
    </div>`;
  $('#meProfile').innerHTML = `
    <div class="me-card">
      <h3 class="me-card-t">👤 个人资料 <span class="me-hint">（只读，点击「编辑资料」可修改）</span></h3>
      <div class="me-avatar-row">
        <div class="me-avatar ${d.avatarFrame === 'gold' ? 'frame-gold' : ''}">
          ${p.avatar ? `<img src="${BASE + p.avatar}" alt="头像" />` : `<span class="me-avatar-letter">${escapeHtml((d.nickname || '?').slice(0, 1))}</span>`}
        </div>
        <div class="me-avatar-info">
          <div class="me-nick">${escapeHtml(d.nickname)}${d.title2 ? ` <span class="me-title2">${escapeHtml(d.title2)}</span>` : ''}</div>
          <div class="me-sub">邮箱：${escapeHtml(d.email)}（不可修改）</div>
        </div>
      </div>
      <div class="me-fields-grid">
        ${field('头像', p.avatar ? '<span class="me-hint">已设置</span>' : '未设置')}
        ${field('年龄', p.age ? `${p.age} 岁` : '未设置')}
        ${field('出生日期', p.birth || '未设置')}
        ${field('是否婚配', marriedText)}
        ${field('个人签名', d.slogan ? `「${escapeHtml(d.slogan)}」` : '未设置')}
      </div>
      <div class="me-card-foot">
        <button id="meEditProfile" class="btn-primary">✏️ 编辑资料</button>
      </div>
    </div>`;
  $('#meEditProfile').onclick = renderProfileEdit;
}

function renderProfileEdit() {
  const d = meData || {};
  const p = d.profile || {};
  $('#meProfile').innerHTML = `
    <div class="me-card">
      <h3 class="me-card-t">👤 编辑个人资料</h3>
      <div class="me-avatar-row">
        <div class="me-avatar ${d.avatarFrame === 'gold' ? 'frame-gold' : ''}">
          ${p.avatar ? `<img src="${BASE + p.avatar}" alt="头像" />` : `<span class="me-avatar-letter">${escapeHtml((d.nickname || '?').slice(0, 1))}</span>`}
        </div>
        <div class="me-avatar-info">
          <div class="me-nick">${escapeHtml(d.nickname)}${d.title2 ? ` <span class="me-title2">${escapeHtml(d.title2)}</span>` : ''}</div>
          <div class="me-sub">邮箱：${escapeHtml(d.email)}（不可修改）</div>
        </div>
      </div>
      <div class="me-field">头像
        <label class="btn-ghost me-avatar-btn">上传图片<input id="meAvatarFile" type="file" accept="image/*" hidden /></label>
        <span class="me-hint">支持 JPG/PNG，展示在活跃榜与个人中心</span>
      </div>
      <div class="me-field">昵称
        <div class="me-nick-row">
          <input id="meNick" class="input" value="${escapeHtml(d.nickname)}" maxlength="20" ${d.renameCards > 0 ? '' : 'disabled'} />
          ${d.renameCards > 0 ? `<button id="meRenameBtn" class="btn-ghost">✏️ 改名</button>` : ''}
        </div>
        <span class="me-hint">${d.renameCards > 0 ? `拥有改名卡 ×${d.renameCards}，可自由修改` : '未持有改名卡（可在商城购买）'}</span>
      </div>
      <div class="me-field">年龄
        <input id="meAge" class="input" type="number" min="1" max="150" value="${p.age ?? ''}" placeholder="如 28" />
      </div>
      <div class="me-field">出生日期
        <input id="meBirth" class="input" type="date" value="${p.birth || ''}" />
      </div>
      <div class="me-field">是否婚配
        <select id="meMarried" class="input">
          <option value="">未设置</option>
          <option value="false" ${p.married === false ? 'selected' : ''}>未婚</option>
          <option value="true" ${p.married === true ? 'selected' : ''}>已婚</option>
        </select>
      </div>
      <div class="me-field">个人签名<span class="me-hint">（修改需 50 枚下品灵石）</span>
        <input id="meSlogan" class="input" value="${escapeHtml(d.slogan || '')}" maxlength="30" placeholder="写一句个人签名吧" />
      </div>
      <div class="me-card-foot">
        <button id="meSaveProfile" class="btn-primary">💾 保存</button>
        <button id="meCancelProfile" class="btn-ghost">取消</button>
      </div>
    </div>`;
  $('#meSaveProfile').onclick = saveProfile;
  $('#meCancelProfile').onclick = renderProfile;
  if ($('#meRenameBtn')) $('#meRenameBtn').onclick = async () => {
    const nick = $('#meNick').value.trim();
    if (!nick) { alert('请输入新昵称'); return; }
    try {
      const r = await api('PUT', '/api/me/profile', { nickname: nick });
      meData.nickname = r.nickname; meData.renameCards = r.renameCards;
      $('#meName').textContent = r.nickname;
      flash('昵称已更新'); renderProfileEdit();
    } catch (e) { alert(e.message); }
  };
  $('#meAvatarFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!/^image\//.test(f.type)) { alert('仅支持图片文件'); e.target.value = ''; return; }
    if (f.size > 10 * 1024 * 1024) { alert('图片过大（上限 10MB）'); e.target.value = ''; return; }
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        const r = await api('PUT', '/api/me/profile', { avatar: rd.result });
        meData.profile = r.profile;
        flash('头像已更新'); renderProfileEdit();
      } catch (err) { alert(err.message); }
    };
    rd.readAsDataURL(f); e.target.value = '';
  };
}

async function saveProfile() {
  const body = {
    age: $('#meAge').value,
    birth: $('#meBirth').value || null,
    married: $('#meMarried').value === '' ? null : $('#meMarried').value === 'true',
  };
  if ($('#meSlogan')) body.slogan = $('#meSlogan').value;
  try {
    const r = await api('PUT', '/api/me/profile', body);
    meData.profile = r.profile;
    if (r.slogan !== undefined) meData.slogan = r.slogan;
    if (r.spirit) meData.spirit = r.spirit;
    flash('资料已保存'); loadMe();
  } catch (e) { alert(e.message); }
}

// ---- 板块2：签到与任务 ----
function renderTasksPane() {
  const d = meData || {};
  $('#meTasks').innerHTML = `
    <div class="me-card">
      <h3 class="me-card-t">📅 每日签到</h3>
      <p class="me-hint">每月签到一次：+${SIGNIN_REWARD.bonus} 活跃积分 · +${SIGNIN_REWARD.xp} 枚下品灵石</p>
      <div class="signin-grid">${signinGrid(d.signinDates || [])}</div>
      <div class="me-card-foot">
        <button id="signinBtn" class="btn-primary" ${d.signedToday ? 'disabled' : ''}>${d.signedToday ? '✅ 今日已签到' : '🖊 立即签到'}</button>
        <span class="me-hint" id="signinMsg"></span>
      </div>
    </div>
    <div class="me-card">
      <h3 class="me-card-t">🗓 每日任务 <span class="me-hint">每项：+${DAILY_REWARD.bonus} 活跃积分 · +${DAILY_REWARD.xp} 下品灵石</span></h3>
      <div id="dailyTaskList">${dailyTasksHtml((d.daily || []))}</div>
    </div>
    <div class="me-card">
      <h3 class="me-card-t">🌟 专属任务 <span class="me-hint">新用户注册 ${NEWBIE_DAYS} 天内有效，过期锁定</span></h3>
      <div class="newbie-box">
        <div class="newbie-row">
          <b>任务1：填写个人资料</b>
          <span class="me-hint">${d.newbieLocked ? '🔒 已过期锁定' : `剩余 ${d.newbieDaysLeft ?? '—'} 天`}</span>
        </div>
        <p class="me-hint">完善头像 / 昵称 / 年龄 / 出生日期 / 婚配任一即可</p>
        <div class="me-card-foot">
          ${d.newbieDone
            ? (d.newbieClaimed ? '<button class="btn-ghost" disabled>✅ 奖励已领取</button>' : `<button id="newbieClaimBtn" class="btn-primary">🎁 领取奖励（+${NEWBIE_REWARD.bonus}活跃 · +${NEWBIE_REWARD.xp}下品灵石）</button>`)
            : `<button id="newbieGoBtn" class="btn-ghost" data-me="profile">去填写资料 →</button>`}
        </div>
      </div>
    </div>`;
  const sb = $('#signinBtn');
  if (sb && !d.signedToday) sb.onclick = doSignin;
  if ($('#newbieClaimBtn')) $('#newbieClaimBtn').onclick = claimNewbie;
  if ($('#newbieGoBtn')) $('#newbieGoBtn').onclick = () => { renderProfileEdit(); $('#meProfile').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
}
function signinGrid(dates) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = now.getDate();
  let html = '';
  for (let i = 1; i <= daysInMonth; i++) {
    const signed = (dates || []).includes(i);
    html += `<span class="signin-cell ${signed ? 'signed' : ''} ${i === today ? 'today' : ''}" title="${i}日${signed ? ' · 已签到' : ''}">${i}${signed ? ' ✓' : ''}</span>`;
  }
  return html;
}
function dailyTasksHtml(list) {
  if (!list || !list.length) return '<div class="empty">加载中…</div>';
  return list.map((t) => `
    <div class="task-row ${t.done ? 'done' : ''}">
      <div class="task-info">
        <b>${escapeHtml(t.title)}</b>
        <span class="me-hint">${escapeHtml(t.desc)}</span>
      </div>
      <div class="task-act">
        ${t.claimed ? '<span class="task-claimed">✅ 已领取</span>'
          : t.done ? `<button class="btn-primary task-claim" data-tid="${t.id}">🎁 领取</button>`
          : '<span class="task-pending">未完成</span>'}
      </div>
    </div>`).join('');
}
async function doSignin() {
  try {
    const r = await api('POST', '/api/me/signin');
    $('#signinMsg').textContent = `签到成功！+${r.reward.bonus} 活跃积分 · +${r.reward.xp} 下品灵石`;
    meData.signedToday = true; meData.signinDates = r.dates; meData.spirit = r.spirit; meData.bonus = r.bonus;
    renderTasksPane();
  } catch (e) { alert(e.message); }
}
async function claimDaily(tid) {
  try {
    const r = await api('POST', `/api/me/tasks/daily/${tid}/claim`);
    flash(`领取成功！+${r.reward.bonus} 活跃积分 · +${r.reward.xp} 下品灵石`);
    meData.spirit = r.spirit; meData.bonus = r.bonus;
    loadMe();
  } catch (e) { alert(e.message); }
}
async function claimNewbie() {
  try {
    const r = await api('POST', '/api/me/tasks/newbie/claim');
    flash(`专属奖励已领取！+${r.reward.bonus} 活跃积分 · +${r.reward.xp} 下品灵石`);
    meData.spirit = r.spirit; meData.bonus = r.bonus;
    loadMe();
  } catch (e) { alert(e.message); }
}

// ---- 板块3：商城与灵石 ----
function renderShop() {
  const d = meData || {};
  const sp = d.spirit || {};
  $('#meShop').innerHTML = `
    <div class="me-card">
      <h3 class="me-card-t">💠 我的灵石</h3>
      <p class="me-hint">稀有度：💎极品 ＞ 🔮上品 ＞ 🪨中品 ＞ ⚪下品 · 兑换比例 1:100（低→高）</p>
      <div class="spirit-row">
        ${SPIRIT_ORDER.slice().reverse().map((k) => `
          <div class="spirit-item ${k === 'jp' ? 'rare' : ''}">
            <span class="spirit-icon">${SPIRIT_ICONS[k]}</span>
            <b>${sp[k] || 0}</b>
            <em>${SPIRIT_NAMES[k].replace('灵石', '')}</em>
          </div>`).join('')}
      </div>
      <div class="convert-row">
        <button class="btn-ghost convert-btn" data-from="xp" data-to="zp">兑换 100 下品 → 1 中品</button>
        <button class="btn-ghost convert-btn" data-from="zp" data-to="sp">兑换 100 中品 → 1 上品</button>
        <button class="btn-ghost convert-btn" data-from="sp" data-to="jp">兑换 100 上品 → 1 极品</button>
      </div>
    </div>
    <div class="me-card">
      <h3 class="me-card-t">🛒 灵石商城</h3>
      <div class="shop-list">
        ${shopItemsHtml()}
      </div>
    </div>`;
  document.querySelectorAll('.convert-btn').forEach((b) => { b.onclick = () => convertSpirit(b.dataset.from, b.dataset.to); });
  document.querySelectorAll('.shop-buy').forEach((b) => { b.onclick = () => buyItem(b.dataset.id); });
}
function shopItemsHtml() {
  // 与后端 SHOP_ITEMS 保持一致；kind: self=直接购买 / target=需选成员(+输入内容)；repeat=true 表示可重复购买（买过仍显示购买按钮，可叠加）
  const items = [
    { id: 'rename', name: '改名卡', icon: '🪪', desc: '解锁一次自由修改昵称的机会（不再强制「x包」）', price: 50, unit: 'xp', kind: 'self', repeat: true },
    { id: 'title', name: '个性称号', icon: '🏅', desc: '为自己定制专属称号，展示在名字旁', price: 100, unit: 'xp', kind: 'self' },
    { id: 'frame', name: '鎏金头像框', icon: '🖼️', desc: '永久解锁鎏金头像框，金光闪闪', price: 200, unit: 'xp', kind: 'self' },
    { id: 'glow', name: '鎏金光效', icon: '✨', desc: '今日活跃榜中自己的条目获得金色流动边框光效，有效期 3 天（可续期叠加）', price: 1, unit: 'zp', kind: 'self', repeat: true },
    { id: 'mute', name: '噤声符', icon: '🤐', desc: '禁言任意一位成员 3 分钟（期间无法发送消息）', price: 1, unit: 'zp', kind: 'target', repeat: true },
    { id: 'voodoo', name: '迷魂符', icon: '🌀', desc: '让指定成员发送的下一条消息内容，变为你输入的消息', price: 80, unit: 'xp', kind: 'target', repeat: true },
    { id: 'baoxue', name: '爆血符', icon: '💥', desc: '活跃积分不变，称号直接强升下一等级（可叠加）', price: 20, unit: 'xp', kind: 'self', repeat: true },
    { id: 'nisheng', name: '拟声符', icon: '📝', desc: '修改任意一位成员的个人签名（对方改自己签名需 50 下品）', price: 100, unit: 'xp', kind: 'target', repeat: true },
    { id: 'xuehun', name: '血魂符', icon: '🩸', desc: '仅可对同阶或更低阶成员使用，修改其个性称号（显示在消息昵称旁）', price: 1, unit: 'jp', kind: 'target', repeat: true },
  ];
  const owned = meData ? { rename: (meData.renameCards || 0) > 0, title: !!meData.title2, frame: meData.avatarFrame === 'gold', glow: !!meData.glow, baoxue: (meData.titleBoost || 0) > 0 } : {};
  return items.map((it) => {
    // 可重复购买（消耗型/叠加型）：始终显示购买按钮，并附现有数量提示；永久型才显示「已拥有」
    const btn = it.repeat
      ? `<button class="btn-primary shop-buy" data-id="${it.id}">购买</button>`
      : (owned[it.id]
        ? '<span class="shop-owned">✅ 已拥有</span>'
        : `<button class="btn-primary shop-buy" data-id="${it.id}">购买</button>`);
    let extra = '';
    if (it.id === 'rename' && (meData.renameCards || 0) > 0) extra = `<span class="shop-count">已持 ×${meData.renameCards}</span>`;
    else if (it.id === 'baoxue' && (meData.titleBoost || 0) > 0) extra = `<span class="shop-count">已叠加 ×${meData.titleBoost}</span>`;
    else if (it.id === 'glow' && meData.glow) extra = '<span class="shop-count">生效中</span>';
    return `
    <div class="shop-item">
      <span class="shop-ico">${it.icon}</span>
      <div class="shop-info">
        <b class="shop-name">${it.name}</b>
        <span class="shop-desc">${it.desc}</span>
      </div>
      <div class="shop-side">
        <span class="shop-price">${it.price} ${SPIRIT_NAMES[it.unit]}</span>
        ${btn}${extra}
      </div>
    </div>`;
  }).join('');
}
async function convertSpirit(from, to) {
  try {
    const r = await api('POST', '/api/me/spirit/convert', { from, to });
    meData.spirit = r.spirit;
    flash(`兑换成功：${SPIRIT_NAMES[from]} -100 → ${SPIRIT_NAMES[to]} +1`);
    renderShop();
  } catch (e) { alert(e.message); }
}
// 购买流程：self 直接买（title 需输入称号）；target 弹窗选成员(+输入内容)
let shopBuyCtx = null;
async function buyItem(id) {
  const meta = { rename: {}, title: { input: '称号', max: 12 }, frame: {}, glow: {}, baoxue: {},
    mute: { target: true, hint: '选择要禁言 3 分钟的成员' },
    voodoo: { target: true, input: '替换消息内容', max: 200, hint: '选择成员，其下一条消息将被替换为你输入的内容' },
    nisheng: { target: true, input: '新签名', max: 30, hint: '选择要修改签名的成员' },
    xuehun: { target: true, input: '新个性称号', max: 12, hint: '选择同阶或更低阶的成员' } }[id];
  if (!meta) return;
  if (!meta.target) {
    if (id === 'title') {
      const t2 = prompt('请输入你的专属称号（最多 12 字）');
      if (!t2) return;
      try { const r = await api('POST', `/api/me/shop/${id}/buy`, { title2: t2 }); afterBuy(r, id); } catch (e) { alert(e.message); }
    } else {
      try { const r = await api('POST', `/api/me/shop/${id}/buy`, {}); afterBuy(r, id); } catch (e) { alert(e.message); }
    }
    return;
  }
  // target 型：拉成员列表弹选择窗
  try {
    const { members } = await api('GET', '/api/members');
    const box = $('#shopBuyTarget');
    box.innerHTML = members.map((mb) => `<option value="${escapeHtml(mb.email)}">${escapeHtml(mb.nickname)}（${escapeHtml(mb.email)}）</option>`).join('') || '<option value="">暂无成员</option>';
    $('#shopBuyTitle').textContent = meta.hint || '选择成员';
    $('#shopBuyHint').textContent = meta.hint || '';
    $('#shopBuyText').placeholder = meta.input || '';
    show($('#shopBuyText'), !!meta.input);
    $('#shopBuyText').value = '';
    shopBuyCtx = { id, input: meta.input, max: meta.max || 12 };
    show($('#shopBuyModal'), true);
  } catch (e) { alert(e.message); }
}
function afterBuy(r, id) {
  meData.spirit = r.spirit;
  if (r.renameCards !== undefined) meData.renameCards = r.renameCards;
  if (r.title2 !== undefined) meData.title2 = r.title2;
  if (r.avatarFrame !== undefined) meData.avatarFrame = r.avatarFrame;
  if (r.titleBoost !== undefined) meData.titleBoost = r.titleBoost;
  if (r.glowUntil !== undefined) meData.glowUntil = r.glowUntil;
  if (r.slogan !== undefined) meData.slogan = r.slogan;
  flash('购买成功！');
  loadMe();
}
// 商城购买弹窗事件
$('#shopBuyClose').onclick = () => show($('#shopBuyModal'), false);
$('#shopBuyOk').onclick = async () => {
  if (!shopBuyCtx) return;
  const target = $('#shopBuyTarget').value;
  if (!target) { alert('请选择成员'); return; }
  const body = { target };
  if (shopBuyCtx.input) {
    const val = $('#shopBuyText').value.trim();
    if (!val) { alert(`请输入${shopBuyCtx.input}`); return; }
    if (shopBuyCtx.id === 'voodoo') body.text = val;
    else if (shopBuyCtx.id === 'nisheng') body.slogan = val;
    else if (shopBuyCtx.id === 'xuehun') body.title2 = val;
  }
  try {
    const r = await api('POST', `/api/me/shop/${shopBuyCtx.id}/buy`, body);
    show($('#shopBuyModal'), false);
    afterBuy(r, shopBuyCtx.id);
  } catch (e) { alert(e.message); }
};

// 全局委托补充：每日任务领奖
document.addEventListener('click', (e) => {
  const claimBtn = e.target.closest('.task-claim');
  if (claimBtn) { claimDaily(claimBtn.dataset.tid); return; }
});

// 全局事件委托：统一处理所有 data-act 动作（不用内联 onclick，兼容严格 CSP）
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-fmt]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.dataset.fmt) { applyFmt(el.dataset.fmt); return; }
  if (act === 'view') goView(el.dataset.view);
  else   if (act === 'delmsg') delMessage(el.dataset.id);
  else if (act === 'delroom') delRoom(el.dataset.id);
  else if (act === 'delvote') delVote(el.dataset.id);
  else if (act === 'delmoan') delMoan(el.dataset.id);
  else if (act === 'delmedia') delMedia(el.dataset.id);
  else if (act === 'mediabg') {
    pauseInlineMedia();
    setMedia(BASE + el.dataset.src, el.dataset.name, el.dataset.video === '1');
  }
  else if (act === 'openimg') window.open(el.dataset.src);
  else if (act === 'clearimg') clearPendingImage();
  else if (act === 'vote') vote(el.dataset.vid, Number(el.dataset.idx));
  else if (act === 'delfolder') deleteKbFolder(el.dataset.id);
  else if (act === 'delkbdoc') deleteKbDoc();
  else if (act === 'kbpin') toggleKbPin(el.dataset.id, el.dataset.pin === '1');
  else if (act === 'kbimg') $('#kbImgInput').click();
  else if (act === 'kbemoji') show($('#kbEmojiPanel'), $('#kbEmojiPanel').classList.contains('hidden'));
  else if (act === 'emoji') { insertAtCursor(el.dataset.e); show($('#kbEmojiPanel'), false); }
  else if (act === 'kbnewdoc') newKbDoc(el.dataset.folder);
});

// ---------- 媒体管理（原工作日报板块改造；分页，每页 12 条） ----------
let mediaList = [];
let mediaHasMore = false;
async function loadMedia() {
  try {
    const d = await api('GET', '/api/media?limit=12');
    mediaList = d.media || [];
    mediaHasMore = !!d.hasMore;
    renderMedia();
  } catch (e) { $('#mediaGrid').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
async function loadMoreMedia() {
  const btn = $('#mediaMoreBtn');
  if (btn) { btn.textContent = '加载中…'; btn.disabled = true; }
  try {
    const d = await api('GET', `/api/media?limit=12&offset=${mediaList.length}`);
    mediaList = mediaList.concat(d.media || []);
    mediaHasMore = !!d.hasMore;
    renderMedia();
  } catch (e) { alert(e.message); if (btn) { btn.textContent = '加载更多'; btn.disabled = false; } }
}
function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function renderMedia() {
  const box = $('#mediaGrid');
  if (!mediaList.length) { box.innerHTML = '<div class="empty">还没有媒体，点击右上角「上传媒体」添加视频/音频</div>'; return; }
  box.innerHTML = mediaList.map((m) => {
    const isVideo = (m.type || '').startsWith('video/');
    const player = isVideo
      ? `<video src="${BASE + m.path}" controls preload="metadata"></video>`
      : `<audio src="${BASE + m.path}" controls preload="metadata"></audio>`;
    const canDel = myRole === 'admin' || m.uploadedBy === me;
    return `<div class="media-card" data-id="${m.id}">
      <div class="media-container">${player}</div>
      <div class="media-info">
        <div class="media-title-row">
          <span class="media-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
          <span class="media-size">${fmtSize(m.size)}</span>
        </div>
        <div class="media-by">上传者：${escapeHtml(m.uploadedBy || '')}</div>
      </div>
      <button class="media-bg-btn" data-act="mediabg" data-src="${m.path}" data-name="${escapeHtml(m.name)}" data-video="${isVideo ? '1' : '0'}">🎧 后台播放</button>
      ${canDel ? `<button class="media-del" data-act="delmedia" data-id="${m.id}">删除</button>` : ''}
    </div>`;
  }).join('');
  if (mediaHasMore) {
    box.insertAdjacentHTML('beforeend', `<button class="media-more" id="mediaMoreBtn">加载更多（已显示 ${mediaList.length} 条）</button>`);
    $('#mediaMoreBtn').onclick = loadMoreMedia;
  }
}
$('#mediaFile').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!/^(video|audio)\//.test(file.type)) { alert('仅支持视频/音频文件（mp4/mp3 等）'); e.target.value = ''; return; }
  if (file.size > 30 * 1024 * 1024) { alert('媒体文件过大（上限 30MB）'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const card = document.createElement('div');
    card.className = 'media-card media-uploading';
    card.textContent = '上传中…';
    $('#mediaGrid').prepend(card);
    try {
      const r = await api('POST', '/api/media', { name: file.name, type: file.type, dataUrl });
      mediaList.unshift(r.media);
      renderMedia();
    } catch (err) { card.remove(); alert(err.message); }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
};
async function delMedia(id) {
  if (!confirm('确定删除该媒体吗？此操作不可恢复')) return;
  try { await api('DELETE', `/api/media/${id}`); mediaList = mediaList.filter((m) => m.id !== id); renderMedia(); }
  catch (e) { alert(e.message); }
}
window.delMedia = delMedia;

// ---------- 全局后台媒体播放器（离开媒体页后继续播放 + 浮动控制条） ----------
const bgMedia = $('#bgMedia');
function pauseInlineMedia() {
  document.querySelectorAll('#page-media .media-card video, #page-media .media-card audio')
    .forEach((el) => { try { el.pause(); } catch {} });
}
function updateMediaIcon() { $('#mediaPlay').textContent = bgMedia.paused ? '▶' : '⏸'; }
function setMedia(src, name, isVideo, start) {
  bgMedia.src = src;
  if (start) { try { bgMedia.currentTime = start; } catch {} }
  $('#mediaName').textContent = name || '媒体';
  $('#mediaBar').classList.toggle('show-video', !!isVideo);
  show($('#mediaBar'), true);
  bgMedia.play().then(updateMediaIcon).catch(() => {});
}
// 在媒体页直接点开内联播放器时，暂停后台播放器，避免双声
$('#page-media').addEventListener('play', (e) => {
  if (e.target && e.target.matches && e.target.matches('video, audio')) bgMedia.pause();
}, true);
bgMedia.addEventListener('play', updateMediaIcon);
bgMedia.addEventListener('pause', updateMediaIcon);
bgMedia.addEventListener('ended', updateMediaIcon);
bgMedia.addEventListener('timeupdate', () => {
  const dur = bgMedia.duration || 0, cur = bgMedia.currentTime || 0;
  $('#mediaProg').style.width = (dur ? (cur / dur * 100) : 0) + '%';
});
$('#mediaPlay').onclick = () => { if (bgMedia.paused) bgMedia.play().catch(() => {}); else bgMedia.pause(); };
$('#mediaStop').onclick = () => { bgMedia.pause(); try { bgMedia.currentTime = 0; } catch {} show($('#mediaBar'), false); };
$('#mediaToggle').onclick = () => $('#mediaBar').classList.toggle('collapsed');
$('#mediaProgWrap').onclick = (e) => {
  const dur = bgMedia.duration; if (!dur) return;
  const r = e.currentTarget.getBoundingClientRect();
  try { bgMedia.currentTime = ((e.clientX - r.left) / r.width) * dur; } catch {}
};

// ---------- 团队投票 ----------
let voteOptCount = 2;
async function loadVotes() {
  try {
    const { votes } = await api('GET', '/api/votes');
    renderVotes(votes);
  } catch (e) { $('#voteList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
function renderVotes(list) {
  const box = $('#voteList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">还没有投票，点右上角「发起投票」建一个</div>'; return; }
  list.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vote-card';
    const sum = v.options.reduce((a, o) => a + o.count, 0);
    const total = sum || 1;
    const optsHtml = v.options.map((o, i) => {
      const pct = Math.round((o.count / total) * 100);
      const mine = v.mine && v.myChoice === i;
      return `<div class="vote-opt${v.mine ? ' locked' : ''}"${v.mine ? '' : ` data-act="vote" data-vid="${v.id}" data-idx="${i}"`}>` +
        `<div class="vote-opt-bar" style="width:${pct}%"></div>` +
        `<span class="vote-opt-txt">${escapeHtml(o.text)}${mine ? ' <em>✓ 我投的</em>' : ''}</span>` +
        `<span class="vote-opt-n">${o.count} 票 · ${pct}%</span></div>`;
    }).join('');
    const delBtn = myRole === 'admin' ? `<button class="vote-del" data-act="delvote" data-id="${v.id}">✕</button>` : '';
    card.innerHTML =
      `<div class="vote-head"><b>${escapeHtml(v.title)}</b><span class="vote-total">共 ${sum} 票</span>${delBtn}</div>` +
      `<div class="vote-opts">${optsHtml}</div>` +
      (v.mine ? '<div class="vote-tip">已参与 · 结果实时更新</div>' : '<div class="vote-tip">点击选项参与投票（每人一票）</div>');
    box.appendChild(card);
  });
}
async function vote(vid, idx) {
  try { await api('POST', `/api/votes/${vid}/vote`, { optionIndex: idx }); await loadVotes(); }
  catch (e) { alert(e.message); }
}
async function delVote(vid) {
  if (!confirm('确定删除该投票？')) return;
  try { await api('DELETE', `/api/votes/${vid}`); await loadVotes(); } catch (e) { alert(e.message); }
}
window.delVote = delVote;

$('#voteNew').onclick = () => { voteOptCount = 2; renderVoteOpts(); $('#voteTitle').value = ''; show($('#voteModal'), true); };
$('#closeVote').onclick = () => show($('#voteModal'), false);
$('#voteAddOpt').onclick = () => { if (voteOptCount >= 10) { flash('最多 10 个选项'); return; } voteOptCount++; renderVoteOpts(); };
function renderVoteOpts() {
  const box = $('#voteOpts');
  box.innerHTML = '';
  for (let i = 0; i < voteOptCount; i++) {
    const input = document.createElement('input');
    input.className = 'input vote-opt-input';
    input.placeholder = `选项 ${i + 1}`;
    input.maxLength = 200;
    box.appendChild(input);
  }
}
$('#voteCreate').onclick = async () => {
  const title = $('#voteTitle').value.trim();
  const options = [...document.querySelectorAll('#voteOpts .vote-opt-input')].map((i) => i.value.trim()).filter(Boolean);
  if (!title) { alert('请填写投票主题'); return; }
  if (options.length < 2) { alert('至少填写 2 个选项'); return; }
  try { await api('POST', '/api/votes', { title, options }); show($('#voteModal'), false); await loadVotes(); }
  catch (e) { alert(e.message); }
};

// ---------- 意见反馈（匿名）----------
async function loadMoans() {
  try {
    const { moans } = await api('GET', '/api/moans');
    renderMoans(moans);
  } catch (e) { $('#moanList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
function renderMoans(list) {
  const box = $('#moanList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">暂无反馈，欢迎匿名提交你的建议</div>'; return; }
  list.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'moan-card';
    const delBtn = myRole === 'admin' ? `<button class="moan-del" data-act="delmoan" data-id="${m.id}">✕</button>` : '';
    div.innerHTML = `<div class="moan-body">${escapeHtml(m.text)}</div>` +
      `<div class="moan-foot"><span class="moan-time">匿名 · ${fmtTime(m.time)}</span>${delBtn}</div>`;
    box.appendChild(div);
  });
}
async function delMoan(id) {
  if (!confirm('确定删除这条反馈？')) return;
  try { await api('DELETE', `/api/moans/${id}`); await loadMoans(); } catch (e) { alert(e.message); }
}
window.delMoan = delMoan;
$('#moanSend').onclick = async () => {
  const text = $('#moanText').value.trim();
  if (!text) { flash('先写点什么再发'); return; }
  try { await api('POST', '/api/moans', { text }); $('#moanText').value = ''; await loadMoans(); }
  catch (e) { alert(e.message); }
};

// ---------- 团队知识库 ----------
let kbFolders = [], kbDocs = [], kbCurrent = null, kbSaveTimer = null, kbNameMap = {};
const kbNick = (e) => kbNameMap[e] || e;
async function loadKb() {
  try {
    const [kbd, mb] = await Promise.all([
      api('GET', '/api/kb'),
      api('GET', '/api/members').catch(() => ({ members: [] })),
    ]);
    kbFolders = kbd.kb.folders;
    kbDocs = kbd.kb.docs.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); // 置顶文档靠前
    kbNameMap = Object.fromEntries(mb.members.map((m) => [m.email, m.nickname]));
    if (kbCurrent && !kbDocs.find((d) => d.id === kbCurrent)) kbCurrent = null;
    renderKbTree();
    if (!kbCurrent) { show($('#kbEdit'), false); show($('#kbEmpty'), true); }
  } catch (e) { $('#kbTree').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
function renderKbTree() {
  const box = $('#kbTree');
  box.innerHTML = '';
  const byFolder = new Map(kbFolders.map((f) => [f.id, []]));
  kbDocs.forEach((d) => { if (d.folderId && byFolder.has(d.folderId)) byFolder.get(d.folderId).push(d); });
  const docItem = (d) => {
    const div = document.createElement('div');
    div.className = 'kb-doc' + (kbCurrent === d.id ? ' active' : '') + (d.pinned ? ' kb-pinned' : '');
    // 置顶按钮（仅管理员可点；普通成员置顶文档只显示 📌 标记）
    const pin = myRole === 'admin'
      ? `<button class="kb-pin" data-act="kbpin" data-id="${d.id}" data-pin="${d.pinned ? '1' : '0'}" title="${d.pinned ? '取消置顶' : '置顶'}">📌</button>`
      : (d.pinned ? '<span class="kb-pin kb-pin-static" title="已置顶">📌</span>' : '');
    div.innerHTML = `<span class="kb-doc-t">${escapeHtml(d.title)}</span>${pin}<span class="kb-doc-time">${fmtTime(d.updatedAt)}</span>`;
    div.onclick = (e) => { if (e.target.closest('.kb-pin')) return; selectKbDoc(d.id); };
    return div;
  };
  kbFolders.forEach((f) => {
    const fdiv = document.createElement('div');
    fdiv.className = 'kb-folder';
    const del = (myRole === 'admin' || f.createdBy === me) ? `<button class="kb-del" data-act="delfolder" data-id="${f.id}" title="删除文件夹（含其下文档）">✕</button>` : '';
    fdiv.innerHTML = `<div class="kb-folder-head"><span>📁</span><b>${escapeHtml(f.name)}</b>` +
      `<button class="kb-new-in" data-act="kbnewdoc" data-folder="${f.id}" title="在此文件夹新建文档">＋</button>${del}</div>`;
    const list = document.createElement('div');
    list.className = 'kb-folder-docs';
    (byFolder.get(f.id) || []).forEach((d) => list.appendChild(docItem(d)));
    fdiv.appendChild(list);
    box.appendChild(fdiv);
  });
  const rootDocs = kbDocs.filter((d) => !d.folderId);
  if (rootDocs.length) {
    const rd = document.createElement('div');
    rd.className = 'kb-root';
    rootDocs.forEach((d) => rd.appendChild(docItem(d)));
    box.appendChild(rd);
  }
  if (!kbFolders.length && !kbDocs.length) box.innerHTML = '<div class="empty">知识库还是空的，点「新建文档」开始沉淀</div>';
}
async function selectKbDoc(id) {
  kbCurrent = id;
  renderKbTree();
  try {
    const { doc } = await api('GET', `/api/kb/docs/${id}`);
    show($('#kbEdit'), true); show($('#kbEmpty'), false);
    $('#kbTitle').value = doc.title;
    $('#kbContent').value = doc.content;
    $('#kbInfo').textContent = `创建：${kbNick(doc.createdBy)} · 更新：${fmtTime(doc.updatedAt)}`;
    $('#kbSaveState').textContent = '';
    show($('#kbDeleteDoc'), myRole === 'admin' || doc.createdBy === me);
    // 文档权限：作者/管理员/可管理=管理；可编辑=仅编辑；其余默认仅查看（不显示编辑按钮）
    const canManage = myRole === 'admin' || doc.createdBy === me || (doc.perms && doc.perms[me] === 'manage');
    const canEdit = canManage || (doc.perms && doc.perms[me] === 'edit');
    show($('#kbPermBtn'), canManage);
    show($('#kbEditToggle'), canEdit);
    $('#kbMoveFolder').disabled = !canEdit;
    setKbMode('view'); // 默认查看态：渲染预览、隐藏编辑器
    $('#kbPreview').innerHTML = renderMarkdown(doc.content);
    const sel = $('#kbMoveFolder');
    sel.innerHTML = '<option value="">根目录</option>' + kbFolders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    sel.value = doc.folderId || '';
  } catch (e) { alert(e.message); }
}
$('#kbMoveFolder').onchange = async (e2) => {
  if (!kbCurrent) return;
  const folderId = e2.target.value;
  try { await api('PUT', `/api/kb/docs/${kbCurrent}`, { folderId }); await loadKb(); flash('已移动到' + (folderId ? '文件夹' : '根目录')); }
  catch (e) { alert(e.message); }
};

// ---- 知识库富文本：Markdown 渲染（白名单，仅输出安全标签）----
function mdInline(t) {
  let s = escapeHtml(t);
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/uploads\/[^)\s]+)\)/g, '<img src="$2" alt="$1" />');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/uploads\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s;
}
function renderMarkdown(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let inCode = false, codeBuf = [], inUl = false, inOl = false;
  const closeList = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('```')) {
      if (inCode) { out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'); inCode = false; codeBuf = []; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (!t) { closeList(); out.push(''); continue; }
    let m;
    if ((m = t.match(/^(#{1,3})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); out.push('<hr/>'); continue; }
    if (t.startsWith('- ') || t.startsWith('* ')) {
      if (!inUl) { closeList(); out.push('<ul>'); inUl = true; }
      out.push('<li>' + mdInline(t.slice(2)) + '</li>'); continue;
    }
    if ((m = t.match(/^\d+\.\s+(.*)/))) {
      if (!inOl) { closeList(); out.push('<ol>'); inOl = true; }
      out.push('<li>' + mdInline(m[1]) + '</li>'); continue;
    }
    if (t.startsWith('> ')) { closeList(); out.push('<blockquote>' + mdInline(t.slice(2)) + '</blockquote>'); continue; }
    closeList();
    out.push('<p>' + mdInline(t) + '</p>');
  }
  if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  closeList();
  return out.join('\n');
}
function applyFmt(fmt) {
  const ta = $('#kbContent');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const sel = v.slice(s, e);
  const ins = (before, after, ph) => {
    const t = sel || ph;
    ta.value = v.slice(0, s) + before + t + after + v.slice(e);
    ta.focus();
    const p = s + before.length;
    ta.setSelectionRange(p, p + t.length);
    scheduleKbSave();
  };
  if (fmt === 'bold') ins('**', '**', '加粗文字');
  else if (fmt === 'italic') ins('*', '*', '斜体文字');
  else if (fmt === 'h2') ins('\n## ', '', '二级标题');
  else if (fmt === 'h3') ins('\n### ', '', '三级标题');
  else if (fmt === 'ul') ins('\n- ', '', '列表项');
  else if (fmt === 'ol') ins('\n1. ', '', '列表项');
  else if (fmt === 'quote') ins('\n> ', '', '引用内容');
  else if (fmt === 'code') ins('`', '`', '代码');
}
function insertAtCursor(text) {
  const ta = $('#kbContent');
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  ta.value = v.slice(0, s) + text + v.slice(e);
  ta.focus();
  const p = s + text.length;
  ta.setSelectionRange(p, p);
  scheduleKbSave();
}
$('#kbImgInput').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('仅支持图片'); return; }
  if (file.size > 10 * 1024 * 1024) { alert('图片不能超过 10MB'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const { url } = await api('POST', '/api/upload', { dataUrl: reader.result });
      insertAtCursor(`![图片](${url})\n`);
      flash('图片已插入，预览模式可查看');
    } catch (err) { alert(err.message); }
  };
  reader.readAsDataURL(file);
};
const KB_EMOJI = ['😀','😂','🤣','😅','😊','🙃','😉','😍','🤔','😴','🤤','🥱','😭','😡','🤯','🥳','🤫','🙄','😎','😜','👍','👏','🙏','💪','🔥','💯','🍔','🍕','🥤','☕','🍺','🍉','🐟','🦑','🐸','🐷','🦄','💻','📱','🎮','🎧','🎵','📺','🎬','⚽','🏀','🌚','🌝','💤','🙈','🙉','🙊','✨','🎉','❓','❗'];
$('#kbEmojiPanel').innerHTML = KB_EMOJI.map((ch) => `<button class="kb-emoji" data-act="emoji" data-e="${ch}">${ch}</button>`).join('');
// 查看态 / 编辑态切换：查看态=渲染预览（只读），编辑态=文本框+工具栏
let kbEditing = false;
function setKbMode(m) {
  kbEditing = m === 'edit';
  $('#kbEditToggle').textContent = kbEditing ? '✓ 完成' : '✏️ 编辑';
  show($('#kbToolbar'), kbEditing);
  show($('#kbEmojiPanel'), false);
  show($('#kbContent'), kbEditing);
  show($('#kbPreview'), !kbEditing);
  $('#kbTitle').readOnly = !kbEditing;
}
$('#kbEditToggle').onclick = () => {
  if (kbEditing) {
    // 完成：先保存，再渲染回查看态
    saveKbNow();
    $('#kbPreview').innerHTML = renderMarkdown($('#kbContent').value);
    setKbMode('view');
  } else {
    setKbMode('edit');
    $('#kbContent').focus();
  }
};

// ---------- 知识库文档权限管理（两步：选成员 → 选等级）----------
let kbPermSelEmails = new Set();
let kbPermAllEmails = [];
function openKbPerm() {
  if (!kbCurrent) return;
  kbPermAllEmails = Object.keys(kbNameMap).filter((e) => e !== me).sort(); // 自己无需授权
  const doc = kbDocs.find((d) => d.id === kbCurrent);
  const cur = (doc && doc.perms) || {};
  kbPermSelEmails = new Set(Object.keys(cur).filter((e) => cur[e] !== 'view' && e !== me)); // 预勾选已授权成员
  $('#kbPermSearch').value = '';
  renderKbPermList('');
  show($('#kbPermStep2'), false);
  show($('#kbPermStep1'), true);
  show($('#kbPermModal'), true);
}
function renderKbPermList(q) {
  const box = $('#kbPermList');
  const ql = (q || '').trim().toLowerCase();
  const rows = kbPermAllEmails.filter((e) => {
    const nick = (kbNameMap[e] || e).toLowerCase();
    return !ql || nick.includes(ql) || e.toLowerCase().includes(ql);
  });
  box.innerHTML = rows.length ? rows.map((e) =>
    `<label class="kb-perm-row"><input type="checkbox" data-email="${escapeHtml(e)}" ${kbPermSelEmails.has(e) ? 'checked' : ''} /> <span class="kb-perm-nick">${escapeHtml(kbNameMap[e] || e)}</span><span class="kb-perm-mail">${escapeHtml(e)}</span></label>`
  ).join('') : '<div class="empty">未找到匹配成员</div>';
}
$('#kbPermSearch').addEventListener('input', (e) => renderKbPermList(e.target.value));
$('#kbPermList').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  if (cb.checked) kbPermSelEmails.add(cb.dataset.email); else kbPermSelEmails.delete(cb.dataset.email);
});
$('#kbPermNext').onclick = () => {
  if (!kbPermSelEmails.size) { alert('请先勾选至少一位成员'); return; }
  $('#kbPermCount').textContent = kbPermSelEmails.size;
  $('#kbPermSel').innerHTML = [...kbPermSelEmails].map((e) => `<span class="kb-perm-chip">${escapeHtml(kbNameMap[e] || e)}</span>`).join('');
  show($('#kbPermStep1'), false);
  show($('#kbPermStep2'), true);
};
$('#kbPermBack').onclick = () => { renderKbPermList($('#kbPermSearch').value); show($('#kbPermStep2'), false); show($('#kbPermStep1'), true); };
$('#kbPermClose').onclick = () => show($('#kbPermModal'), false);
$('#kbPermDone').onclick = async () => {
  if (!kbCurrent || !kbPermSelEmails.size) return;
  const lv = document.querySelector('input[name=kbPermLevel]:checked').value;
  const perms = {};
  kbPermSelEmails.forEach((e) => { perms[e] = lv; });
  try {
    const r = await api('PUT', `/api/kb/docs/${kbCurrent}/perms`, { perms });
    const doc = kbDocs.find((d) => d.id === kbCurrent);
    if (doc) doc.perms = r.perms || perms;
    const canManage = myRole === 'admin' || (doc && doc.createdBy === me) || (doc && doc.perms && doc.perms[me] === 'manage');
    const canEdit = canManage || (doc && doc.perms && doc.perms[me] === 'edit');
    show($('#kbPermBtn'), canManage);
    show($('#kbEditToggle'), canEdit);
    $('#kbMoveFolder').disabled = !canEdit;
    show($('#kbPermModal'), false);
    flash('权限已保存');
  } catch (e) { alert(e.message); }
};
$('#kbPermBtn').onclick = openKbPerm;
function scheduleKbSave() {
  if (!kbCurrent) return;
  $('#kbSaveState').textContent = '编辑中…';
  clearTimeout(kbSaveTimer);
  kbSaveTimer = setTimeout(saveKbNow, 800);
}
async function saveKbNow() {
  if (!kbCurrent) return;
  clearTimeout(kbSaveTimer);
  try {
    await api('PUT', `/api/kb/docs/${kbCurrent}`, { title: $('#kbTitle').value, content: $('#kbContent').value });
    $('#kbSaveState').textContent = `已保存 ${new Date().toTimeString().slice(0, 5)}`;
    const d = kbDocs.find((x) => x.id === kbCurrent);
    if (d) { d.title = $('#kbTitle').value.trim(); d.updatedAt = Date.now(); renderKbTree(); }
  } catch (e) { $('#kbSaveState').textContent = '保存失败'; }
}
$('#kbTitle').addEventListener('input', scheduleKbSave);
$('#kbContent').addEventListener('input', scheduleKbSave);
async function newKbDoc(folderId) {
  try { const { doc } = await api('POST', '/api/kb/docs', { folderId: folderId || null }); await loadKb(); await selectKbDoc(doc.id); setKbMode('edit'); $('#kbTitle').focus(); }
  catch (e) { alert(e.message); }
}
$('#kbNewDoc').onclick = () => newKbDoc(null);
$('#kbNewFolder').onclick = async () => {
  const name = prompt('文件夹名称：');
  if (!name || !name.trim()) return;
  try { await api('POST', '/api/kb/folders', { name: name.trim() }); await loadKb(); }
  catch (e) { alert(e.message); }
};
async function deleteKbDoc() {
  if (!kbCurrent || !confirm('确定删除这篇文档？')) return;
  try { await api('DELETE', `/api/kb/docs/${kbCurrent}`); kbCurrent = null; await loadKb(); }
  catch (e) { alert(e.message); }
}
async function toggleKbPin(id, isPinned) {
  try {
    await api('PUT', `/api/kb/docs/${id}/pin`, { pinned: !isPinned });
    const d = kbDocs.find((x) => x.id === id);
    if (d) d.pinned = !isPinned;
    kbDocs = kbDocs.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    renderKbTree();
  } catch (e) { alert(e.message); }
}
async function deleteKbFolder(fid) {
  const isMine = kbFolders.find((f) => f.id === fid)?.createdBy === me;
  const tip = isMine ? '（自己创建的文档将一并删除，他人文档会自动移回根目录）' : '（其下全部文档将被删除）';
  if (!confirm(`确定删除该文件夹？${tip}`)) return;
  try {
    await api('DELETE', `/api/kb/folders/${fid}`);
    if (kbCurrent) { kbCurrent = null; show($('#kbEdit'), false); show($('#kbEmpty'), true); }
    await loadKb();
  } catch (e) { alert(e.message); }
}
let kbSearchTimer = null;
$('#kbSearch').addEventListener('input', (e) => {
  clearTimeout(kbSearchTimer);
  const q = e.target.value.trim();
  kbSearchTimer = setTimeout(async () => {
    if (!q) { await loadKb(); return; }
    try {
      const { results } = await api('GET', `/api/kb/search?q=${encodeURIComponent(q)}`);
      const box = $('#kbTree'); box.innerHTML = '';
      if (!results.length) { box.innerHTML = '<div class="empty">无匹配文档</div>'; return; }
      results.forEach((d) => {
        const div = document.createElement('div');
        div.className = 'kb-doc' + (kbCurrent === d.id ? ' active' : '');
        div.innerHTML = `<span class="kb-doc-t">${escapeHtml(d.title)}</span><span class="kb-doc-time">${fmtTime(d.updatedAt)}</span>`;
        div.onclick = () => { $('#kbSearch').value = ''; selectKbDoc(d.id); };
        box.appendChild(div);
      });
    } catch {}
  }, 300);
});

// 轻提示
function flash(msg) {
  const t = document.createElement('div'); t.className = 'flash'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ---------- 移动端：侧栏抽屉开关 + 面板切换 ----------
function setupMobileUI() {
  const appEl = $('#app');
  const tg = $('#sideToggle'); if (tg) tg.onclick = () => appEl.classList.toggle('sidebar-open');
  const bd = $('#sideBackdrop'); if (bd) bd.onclick = () => appEl.classList.remove('sidebar-open');
  // 选中任务后自动收起侧栏（移动端）
  const rl = $('#roomList'); if (rl) rl.addEventListener('click', () => appEl.classList.remove('sidebar-open'));
  // 面板切换 tab：点哪个放大哪个（移动端 CSS 控显隐，桌面端无影响）
  const tabs = document.querySelectorAll('.ptab');
  tabs.forEach((t) => {
    t.onclick = () => {
      const p = t.dataset.panel;
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.panel').forEach((pn) => pn.classList.toggle('p-active', pn.dataset.panel === p));
    };
  });
  // 默认选中「AI任务区」
  const chatTab = document.querySelector('.ptab[data-panel="chat"]');
  if (chatTab) chatTab.click();
}

// ---------- 启动 ----------
(async () => {
  try { await loadTheme(); } catch {} // 首页即展示团队定制背景（主题已改为公开可读）
  setupMobileUI();
  if (localStorage.getItem('oc_token')) {
    try { await enter(); startTimers(); return; } catch {}
  }
  show($('#home'), true);
})();
