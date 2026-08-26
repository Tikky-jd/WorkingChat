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
let shopTab = 'prop';          // 商城当前标签：prop=道具 / style=样式

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
  window.__msgRendered = false; // 增量渲染标记重置：切换房间后下次全量渲染
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
// 消息加载防抖合并：SSE 与发送后 loadMessages 可能并发触发 → 合并为一次渲染，避免重绘掐断入场动画
let msgLoadInFlight = false, msgLoadPending = false;
async function loadMessages() {
  if (!currentRoomId) return;
  if (msgLoadInFlight) { msgLoadPending = true; return; }
  msgLoadInFlight = true;
  try {
    const { messages } = await api('GET', `/api/rooms/${currentRoomId}/messages`);
    const prev = curMessages || [];
    renderMessages(messages);
    // 轮询兜底：SSE 断线/服务器未关 Nginx 缓冲时，后台标签页也要响"滴滴"+亮角标
    // （2s 内 SSE 刚推过则跳过，避免与 SSE 路径重复提示）
    if (document.hidden && prev.length && Date.now() - lastSseMsgAt > 2000) {
      const fresh = messages.filter((m) => !m.recalled && !prev.some((p) => p.id === m.id));
      if (fresh.length) { bumpUnread(currentRoomId); notifyNewMsg(currentRoomId); }
    }
  } catch {}
  msgLoadInFlight = false;
  if (msgLoadPending) { msgLoadPending = false; loadMessages(); }
}
// 消息增量渲染：只追加新增 / 移除消失 / 更新变化，绝不整表清空重建。
// 这样新消息的入场动画（msg-new）一旦加上就不会被后续重绘抹掉；历史浏览位置也不受影响。
function buildMsgEl(m, animate) {
  const row = document.createElement('div');
  row.dataset.mid = m.id;
  if (m.recalled) {
    row.className = 'msg-row recalled-row';
    row.innerHTML = `<div class="msg-recalled">${escapeHtml(m.nickname || '成员')} 撤回了一条消息</div>`;
    return row;
  }
  if (m.burned) {
    row.className = 'msg-row burned-row';
    row.innerHTML = `<div class="msg-burned">🔥 该消息已被炎爆符销毁，不可恢复</div>`;
    return row;
  }
  row.className = 'msg-row ' + (m.user === me ? 'me' : 'other') + (m.anonymous ? ' anonymous' : '');
  if (animate) row.classList.add('msg-new');
  let inner = '';
  if (m.image) inner += `<img class="msg-img" src="${BASE + m.image}" alt="图片" data-act="openimg" data-src="${BASE + m.image}" onerror="this.alt='图片加载失败';this.style.opacity=0.4" />`;
  if (m.text) inner += `<div class="text">${escapeHtml(m.text)}</div>`;
  const own = m.user === me;
  const delBtn = (myRole === 'admin' || own) ? `<button class="msg-del" title="删除此消息" data-act="delmsg" data-id="${m.id}">✕</button>` : '';
  const editedTag = m.edited ? '<span class="msg-edited">已编辑</span>' : '';
  const title2Tag = (!m.anonymous && m.title2) ? `<span class="msg-title2">${escapeHtml(m.title2)}</span>` : '';
  const bubbleStyle = m.anonymous ? 'default' : (m.bubbleStyle || 'default');
  const whoHtml = m.anonymous
    ? `<span class="who">🕵️ ${escapeHtml(m.nickname)}</span>`
    : `<span class="who">${escapeHtml(m.nickname)}</span>${title2Tag}`;
  row.innerHTML = `<div class="bubble bubble-style-${escapeHtml(bubbleStyle)}"><div class="meta">${whoHtml}<span class="time">${fmtTime(m.time)}</span>${editedTag}${delBtn}</div>${inner}</div>`;
  return row;
}
function renderMessages(list) {
  const prev = curMessages || [];
  curMessages = list || [];
  const box = $('#messages');
  // 关键：在改动 DOM 之前记录滚动状态
  const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const prevScrollTop = box.scrollTop;
  // 首次渲染：整段历史一次性渲染（无动画，避免全列表闪动）
  if (!window.__msgRendered) {
    window.__msgRendered = true;
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="empty">还没有消息，发一条吧</div>'; box.scrollTop = 0; updateScrollBtn(); return; }
    list.forEach((m) => box.appendChild(buildMsgEl(m, false)));
    if (wasAtBottom) box.scrollTop = box.scrollHeight; else box.scrollTop = prevScrollTop;
    updateScrollBtn();
    return;
  }
  // 增量 diff
  const prevIds = new Set(prev.map((m) => m.id));
  const curIds = new Set(list.map((m) => m.id));
  let appended = false;
  // 1) 追加新增消息（末尾，带动画）
  list.forEach((m) => { if (!prevIds.has(m.id)) { box.appendChild(buildMsgEl(m, true)); appended = true; } });
  // 2) 移除已消失的消息（删除）
  prev.forEach((m) => { if (!curIds.has(m.id)) { const el = box.querySelector(`[data-mid="${m.id}"]`); if (el) el.remove(); } });
  // 3) 更新状态变化（撤回 / 编辑文本）
  list.forEach((m) => {
    const el = box.querySelector(`[data-mid="${m.id}"]`);
    if (!el) return;
    const pm = prev.find((p) => p.id === m.id);
    if (!pm) return;
    if (m.recalled !== pm.recalled) { el.replaceWith(buildMsgEl(m, false)); return; }
    if (m.text !== pm.text) {
      const t = el.querySelector('.text');
      if (t) t.textContent = m.text;
      if (m.edited && !el.querySelector('.msg-edited')) {
        const s = document.createElement('span'); s.className = 'msg-edited'; s.textContent = '已编辑';
        const meta = el.querySelector('.meta'); if (meta) meta.appendChild(s);
      }
    }
  });
  if (!list.length && box.querySelector('.msg-row') === null) box.innerHTML = '<div class="empty">还没有消息，发一条吧</div>';
  // 仅在用户本就贴近底部时才回到底部；否则保留其历史浏览位置
  if (wasAtBottom && appended) box.scrollTop = box.scrollHeight;
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
  try {
    const r = await api('POST', `/api/rooms/${currentRoomId}/messages`, body);
    await loadMessages();
    if (r && r.message && r.message.anonymous) {
      meData.charges = meData.charges || {};
      meData.charges.anon = Math.max(0, (meData.charges.anon || 0) - 1);
      renderAnonIndicator();
    }
  }
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
  if (!m || m.recalled || m.burned) { hideMsgMenu(); return; }
  const own = m.user === me;
  const charges = (meData && meData.charges) || {};
  show($('#ctxRecall'), !!own || myRole === 'admin');
  show($('#ctxReedit'), !!own && !!m.text);
  show($('#ctxQuote'), true);
  show($('#ctxTrace'), !!m.anonymous && (charges.trace || 0) > 0);
  show($('#ctxBurn'), (charges.burn || 0) > 0);
  const menu = $('#msgMenu');
  menu.style.left = Math.min(e.clientX, window.innerWidth - 175) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 210) + 'px';
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
$('#ctxTrace').onclick = async () => {
  hideMsgMenu();
  if (!ctxMid || !currentRoomId) return;
  try {
    const r = await api('POST', `/api/messages/${ctxMid}/trace`);
    if (r.charges) meData.charges = r.charges;
    renderShop();
    showTraceResult(r);
  } catch (e) { alert(e.message); }
};
$('#ctxBurn').onclick = async () => {
  hideMsgMenu();
  if (!ctxMid || !currentRoomId) return;
  if (!confirm('确定用炎爆符销毁这条消息吗？\n对方无法撤回，且不可恢复。')) return;
  try {
    const r = await api('POST', `/api/messages/${ctxMid}/burn`);
    if (r.charges) meData.charges = r.charges;
    renderShop();
    await loadMessages();
    flash('🔥 消息已销毁');
  } catch (e) { alert(e.message); }
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
        else if (d.type === 'heart') {
          const s = d.session;
          if (s) {
            meData.heartSessions = (meData.heartSessions || []).filter((x) => x.id !== s.id).concat(s); capHeartSessions();
            renderShop();
            const hm = $('#heartModal');
            if (hm && !hm.classList.contains('hidden')) renderHeartList(meData.heartSessions);
          }
        }
        else if (d.type === 'task') {
          if (currentView === 'tasks') loadTasks().catch(() => {});
          else if (currentView === 'me') loadMe().catch(() => {});
          const t = d.task || {};
          if (t.title) flash('📋 任务更新：' + escapeHtml(t.title));
        }
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
  // 动效：仅新增代办播放入场动画（首次加载整列表不加，避免全列表闪动）
  const firstTodoRender = window.__todoIds === undefined;
  const prevTodoIds = new Set(window.__todoIds || []);
  window.__todoIds = list.map((t) => t.id);
  box.innerHTML = '';
  list.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'todo-item' + (t.done ? ' done' : '');
    if (!firstTodoRender && t.id && !prevTodoIds.has(t.id)) row.classList.add('todo-new');
    const isMine = t.by === me;
    // 别人完成了我布置的代办 → 我确认后任务5才成立；我完成的别人代办 → 等待对方确认
    const needConfirm = t.done && isMine && t.doneBy && t.doneBy !== me && !t.confirmed;
    const waitConfirm = t.done && !isMine && t.doneBy === me && !t.confirmed;
    let extra = '';
    if (waitConfirm) extra = '<span class="todo-wait">待发布者确认</span>';
    if (needConfirm) extra = `<button class="todo-confirm" data-tid="${t.id}">✓ 确认完成</button>`;
    row.innerHTML = `<label class="todo-check"><input type="checkbox" ${t.done ? 'checked' : ''}/><span class="todo-text">${escapeHtml(t.text)}</span></label>${extra}<button class="todo-x" title="删除">✕</button>`;
    row.querySelector('input').onchange = () => { row.classList.add('todo-just-done'); toggleTodo(t.id, row.querySelector('input').checked); };
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
  // 动效：排名比上次上升（名次数字变小）的成员播金色脉冲提示；首次加载不触发
  const prevRankIdx = window.__rankIdx || {};
  window.__rankIdx = {};
  list.forEach((m, i) => { window.__rankIdx[m.email] = i; });
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  list.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'member-item' + (m.glow ? ' glow-gold' : '');
    if (prevRankIdx[m.email] !== undefined && i < prevRankIdx[m.email]) row.classList.add('rank-up');
    const mins = Math.floor(m.onlineSec / 60000); // onlineSec 单位是毫秒 → 转分钟
    const role = m.role === 'admin' ? '<span class="member-role">管理员</span>' : '';
    const avatarHtml = m.avatar ? `<span class="member-ava ${m.avatarFrame === 'gold' ? 'frame-gold' : ''}"><img src="${BASE + m.avatar}" alt="" onerror="this.closest('.member-ava')&&(this.closest('.member-ava').innerHTML='')" /></span>` : '';
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
  show($('#page-tasks'), name === 'tasks');
  if (name === 'main') startRoomLive();
  else stopRoomTimers();
  if (name === 'me') loadMe();
  if (name === 'media') loadMedia();
  if (name === 'vote') loadVotes();
  if (name === 'moan') loadMoans();
  if (name === 'kb') loadKb();
  if (name === 'tasks') loadTasks();
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
          ${p.avatar ? `<img src="${BASE + p.avatar}" alt="头像" onerror="this.outerHTML='<span class=&quot;me-avatar-letter&quot;>${(escapeHtml((d.nickname||'?').slice(0,1)))}</span>'" />` : `<span class="me-avatar-letter">${escapeHtml((d.nickname || '?').slice(0, 1))}</span>`}
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
          ${p.avatar ? `<img src="${BASE + p.avatar}" alt="头像" onerror="this.outerHTML='<span class=&quot;me-avatar-letter&quot;>${(escapeHtml((d.nickname||'?').slice(0,1)))}</span>'" />` : `<span class="me-avatar-letter">${escapeHtml((d.nickname || '?').slice(0, 1))}</span>`}
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
    // 兼容 type 为空的情况（按扩展名兜底）；HEIC/AVIF 浏览器无法显示 → 明确提示
    if (/^image\/(heic|heif|avif)$/i.test(f.type) || /\.(heic|heif|avif)$/i.test(f.name || '')) { alert('不支持 HEIC/AVIF 格式，请将图片转换为 JPG 或 PNG 后上传'); e.target.value = ''; return; }
    const isImg = /^image\/(jpe?g|png|gif|webp)$/i.test(f.type) || (!f.type && /\.(jpe?g|png|gif|webp)$/i.test(f.name || ''));
    if (!isImg) { alert('仅支持 JPG / PNG / GIF / WebP 图片'); e.target.value = ''; return; }
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
    </div>
    <div class="me-card">
      <h3 class="me-card-t">🙋 限时任务 <span class="me-hint">在皇榜揭榜接取，最多同时 3 个</span></h3>
      <div id="meTimedTasks"><div class="empty">加载中…</div></div>
      <div class="me-card-foot">
        <button class="btn-ghost" data-act="gotasks">📋 更多任务（皇榜）</button>
      </div>
    </div>`;
  const sb = $('#signinBtn');
  if (sb && !d.signedToday) sb.onclick = doSignin;
  if ($('#newbieClaimBtn')) $('#newbieClaimBtn').onclick = claimNewbie;
  if ($('#newbieGoBtn')) $('#newbieGoBtn').onclick = () => { renderProfileEdit(); $('#meProfile').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  loadMeTimedTasks();
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
      <p class="me-hint">稀有度：💎极品 ＞ 🔮上品 ＞ 🪨中品 ＞ ⚪下品 · 逐级兑换：下→中 100 / 中→上 100 / 上→极 10</p>
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
        <button class="btn-ghost convert-btn" data-from="sp" data-to="jp">兑换 10 上品 → 1 极品</button>
      </div>
      <div class="spirit-actions"><button class="btn-ghost" id="spiritLogBtn">📊 灵石明细</button></div>
    </div>
      <div class="me-card">
        <h3 class="me-card-t">🛒 灵石商城</h3>
        <div class="shop-tabs">
          <button class="shop-tab ${shopTab === 'prop' ? 'active' : ''}" data-tab="prop">🧰 道具</button>
          <button class="shop-tab ${shopTab === 'style' ? 'active' : ''}" data-tab="style">🎨 样式</button>
        </div>
        <div class="shop-heart-bar"><button class="btn-ghost" id="heartOpenBtn">💗 真心换真心</button></div>
        <div class="shop-list">
          ${shopItemsHtml()}
        </div>
      </div>`;
  document.querySelectorAll('.convert-btn').forEach((b) => { b.onclick = () => convertSpirit(b.dataset.from, b.dataset.to); });
  document.querySelectorAll('.shop-tab').forEach((b) => { b.onclick = () => { shopTab = b.dataset.tab; renderShop(); }; });
  document.querySelectorAll('.shop-buy').forEach((b) => { b.onclick = () => buyItem(b.dataset.id); });
  document.querySelectorAll('.shop-equip').forEach((b) => { b.onclick = () => equipStyle(b.dataset.type, b.dataset.id); });
  document.querySelectorAll('.shop-heart-open').forEach((b) => { b.onclick = () => openHeartPanel(); });
  const hb = $('#heartOpenBtn'); if (hb) hb.onclick = () => openHeartPanel();
  const slb = $('#spiritLogBtn'); if (slb) slb.onclick = () => openSpiritLog();
  renderAnonIndicator();
}

// ---- 灵石明细 ----
async function openSpiritLog() {
  show($('#spiritLogModal'), true);
  const list = $('#spiritLogList');
  list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await api('GET', '/api/me/spirit/log');
    const log = (r.log || []).slice().sort((a, b) => b.t - a.t);
    const sp = r.spirit || {};
    // 汇总
    let gain = 0, spend = 0;
    for (const e of log) { if (e.delta > 0) gain += e.delta; else spend += -e.delta; }
    $('#spiritSummary').innerHTML = `
      <span class="ss-item ss-gain">获得 ${gain}</span>
      <span class="ss-item ss-spend">支出 ${spend}</span>
      <span class="ss-sep">·</span>
      ${SPIRIT_ORDER.slice().reverse().map((k) => `<span class="ss-item">${SPIRIT_ICONS[k]} ${sp[k] || 0} ${SPIRIT_NAMES[k].replace('灵石', '')}</span>`).join('')}`;
    if (!log.length) {
      list.innerHTML = '<div class="empty">暂无获得 / 支出记录，以下为当前持有：</div>' +
        SPIRIT_ORDER.slice().reverse().map((k) => `<div class="spirit-log-row sl-bal"><span class="sl-ico">${SPIRIT_ICONS[k]}</span><span class="sl-reason">当前持有</span><span class="sl-bal-val">${sp[k] || 0} ${SPIRIT_NAMES[k].replace('灵石', '')}</span></div>`).join('');
      return;
    }
    list.innerHTML = log.map((e) => {
      const sign = e.delta > 0 ? '+' : '';
      const cls = e.delta > 0 ? 'sl-gain' : 'sl-spend';
      const d = new Date(e.t);
      const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const unitName = SPIRIT_NAMES[e.unit] ? SPIRIT_NAMES[e.unit].replace('灵石', '') : e.unit;
      return `<div class="spirit-log-row ${cls}">
        <span class="sl-ico">${SPIRIT_ICONS[e.unit] || '⚪'}</span>
        <span class="sl-reason">${escapeHtml(e.reason || '灵石变动')}</span>
        <span class="sl-amt">${sign}${e.delta} ${unitName}</span>
        <span class="sl-time">${ts}</span>
        <span class="sl-bal">余 ${e.balance}</span>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = '<div class="empty">加载失败：' + (err.message || err) + '</div>';
  }
}
$('#spiritLogClose').onclick = () => show($('#spiritLogModal'), false);
$('#spiritLogModal').addEventListener('click', (e) => { if (e.target === $('#spiritLogModal')) show($('#spiritLogModal'), false); });
function shopItemsHtml() {
  // 与后端 SHOP_ITEMS 保持一致；kind: self=直接购买 / target=需选成员(+输入内容)；repeat=true 表示可重复购买（买过仍显示购买按钮，可叠加）
  const items = [
    { id: 'rename', name: '改名卡', icon: '🪪', desc: '解锁一次自由修改昵称的机会（不再强制「x包」）', price: 50, unit: 'xp', kind: 'self', category: 'prop', repeat: true },
    { id: 'title', name: '个性称号', icon: '🏅', desc: '为自己定制专属称号，展示在名字旁', price: 100, unit: 'xp', kind: 'self', category: 'prop' },
    { id: 'glow', name: '鎏金光效', icon: '✨', desc: '今日活跃榜中自己的条目获得金色流动边框光效，有效期 3 天（可续期叠加）', price: 1, unit: 'zp', kind: 'self', category: 'prop', repeat: true },
    { id: 'baoxue', name: '爆血符', icon: '💥', desc: '活跃积分不变，称号强升下一等级，持续 1 小时（可叠加续期）', price: 20, unit: 'xp', kind: 'self', category: 'prop', repeat: true },
    { id: 'mute', name: '噤声符', icon: '🤐', desc: '禁言任意一位成员 3 分钟（期间无法发送消息）', price: 1, unit: 'zp', kind: 'target', category: 'prop', repeat: true },
    { id: 'voodoo', name: '迷魂符', icon: '🌀', desc: '让指定成员发送的下一条消息内容，变为你输入的消息', price: 80, unit: 'xp', kind: 'target', category: 'prop', repeat: true },
    { id: 'nisheng', name: '拟声符', icon: '📝', desc: '修改任意一位成员的个人签名（对方改自己签名需 50 下品）', price: 100, unit: 'xp', kind: 'target', category: 'prop', repeat: true },
    { id: 'xuehun', name: '血魂符', icon: '🩸', desc: '仅可对同阶或更低阶成员使用，修改其个性称号（显示在消息昵称旁）', price: 1, unit: 'jp', kind: 'target', category: 'prop', repeat: true },
    { id: 'anon', name: '藏踪符', icon: '🕵️', desc: '使用后下一条消息匿名发送（隐藏身份），每人每日限购 5 次', price: 30, unit: 'xp', kind: 'self', category: 'prop', repeat: true, dailyLimit: 5 },
    { id: 'trace', name: '追灵符', icon: '🔍', desc: '选定一条匿名消息，查看其真实发送者，每人每日限购 1 次', price: 50, unit: 'xp', kind: 'self', category: 'prop', repeat: true, dailyLimit: 1 },
    { id: 'burn', name: '炎爆符', icon: '🔥', desc: '销毁任意一条消息（对方无法撤回），每人每日限购 1 次', price: 80, unit: 'xp', kind: 'self', category: 'prop', repeat: true, dailyLimit: 1 },
    { id: 'heart', name: '真心符', icon: '💗', desc: '指定一位成员发起真心换真心，双方确认后互换消息/图片/文件，只有双方都提交才可互收', price: 100, unit: 'xp', kind: 'target', category: 'prop', repeat: true, dailyLimit: 0 },
    { id: 'frame', name: '鎏金头像框', icon: '🖼️', desc: '永久解锁鎏金头像框，金光闪闪', price: 200, unit: 'xp', kind: 'self', category: 'style', styleType: 'avatarFrame', styleId: 'gold' },
    { id: 'bubble_green', name: '清新绿边气泡', icon: '💬', desc: '为消息换上清新绿边气泡，带俏皮小尾巴，永久使用', price: 180, unit: 'xp', kind: 'self', category: 'style', styleType: 'bubble', styleId: 'green' },
    { id: 'bubble_cat', name: '萌猫耳气泡', icon: '🐱', desc: '为消息换上软糯猫耳气泡，萌趣可爱，永久使用', price: 240, unit: 'xp', kind: 'self', category: 'style', styleType: 'bubble', styleId: 'cat' },
    { id: 'bubble_v4', name: '暖金气泡', icon: '🌟', desc: '为消息换上暖金流光气泡，温暖治愈，永久使用', price: 260, unit: 'xp', kind: 'self', category: 'style', styleType: 'bubble', styleId: 'v4' },
  ].filter((it) => it.category === shopTab);

  if (!items.length) return '<div class="empty">该分类暂无商品</div>';

  if (shopTab === 'style') {
    return `<div class="style-list">${items.map((it) => {
      const key = `${it.styleType}_${it.styleId}`;
      const owned = !!(meData && meData.ownedStyles && meData.ownedStyles[key]);
      const equipped = !!(meData && meData.equippedStyles && meData.equippedStyles[it.styleType] === it.styleId);
      let btn;
      if (equipped) btn = '<span class="shop-owned">✅ 使用中</span>';
      else if (owned) btn = `<button class="btn-ghost shop-equip" data-type="${escapeHtml(it.styleType)}" data-id="${escapeHtml(it.styleId)}">装备</button>`;
      else btn = `<button class="btn-primary shop-buy" data-id="${it.id}">购买</button>`;
      return `
      <div class="style-item">
        <div class="style-preview">${stylePreviewHtml(it)}</div>
        <div class="style-info">
          <b class="shop-name">${it.icon} ${escapeHtml(it.name)}</b>
          <span class="shop-desc">${escapeHtml(it.desc)}</span>
        </div>
        <div class="style-side">
          <span class="shop-price">${it.price} ${SPIRIT_NAMES[it.unit]}</span>
          ${btn}
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  // 道具分类（原行为）
  const baoxueActive = !!(meData && meData.baoxueUntil) && meData.baoxueUntil > Date.now();
  const owned = meData ? { rename: (meData.renameCards || 0) > 0, title: !!meData.title2, glow: !!meData.glow, baoxue: baoxueActive } : {};
  return items.map((it) => {
    const btn = it.repeat
      ? `<button class="btn-primary shop-buy" data-id="${it.id}">购买</button>`
      : (owned[it.id]
        ? '<span class="shop-owned">✅ 已拥有</span>'
        : `<button class="btn-primary shop-buy" data-id="${it.id}">购买</button>`);
    let extra = '';
    if (it.id === 'rename' && (meData.renameCards || 0) > 0) extra = `<span class="shop-count">已持 ×${meData.renameCards}</span>`;
    else if (it.id === 'baoxue' && baoxueActive) {
      const mins = Math.max(1, Math.ceil((meData.baoxueUntil - Date.now()) / 60000));
      extra = `<span class="shop-count">生效中 · 剩 ${mins} 分钟</span>`;
    } else if (it.id === 'glow' && meData.glow) extra = '<span class="shop-count">生效中</span>';
    else if ((it.id === 'anon' || it.id === 'trace' || it.id === 'burn') && ((meData.charges || {})[it.id] || 0) > 0) extra = `<span class="shop-count">已持 ×${(meData.charges || {})[it.id]}</span>`;
    else if (it.id === 'heart') {
      const hs = (meData.heartSessions || []).filter((s) => s.status === 'pending' || s.status === 'active' || s.status === 'exchanged');
      if (hs.length) extra = `<button class="btn-ghost shop-heart-open">查看 ${hs.length} 场</button>`;
    }
    return `
    <div class="shop-item">
      <span class="shop-ico">${it.icon}</span>
      <div class="shop-info">
        <b class="shop-name">${escapeHtml(it.name)}</b>
        <span class="shop-desc">${escapeHtml(it.desc)}</span>
      </div>
      <div class="shop-side">
        <span class="shop-price">${it.price} ${SPIRIT_NAMES[it.unit]}</span>
        ${btn}${extra}
      </div>
    </div>`;
  }).join('');
}
function stylePreviewHtml(item) {
  if (item.styleType === 'bubble') {
    return `<img class="style-preview-bubble" src="/images/bubbles/${escapeHtml(item.styleId)}-reply.png" alt="" onerror="this.style.display='none'"/>`;
  }
  if (item.styleType === 'avatarFrame') {
    return `<span class="style-preview-frame frame-${escapeHtml(item.styleId)}"></span>`;
  }
  return `<span class="style-preview-placeholder">${item.icon}</span>`;
}
async function equipStyle(styleType, styleId) {
  try {
    const r = await api('POST', '/api/me/styles/equip', { styleType, styleId });
    if (r.avatarFrame !== undefined) meData.avatarFrame = r.avatarFrame;
    if (r.equippedStyles !== undefined) meData.equippedStyles = r.equippedStyles;
    flash('样式装备成功！');
    loadMe();
  } catch (e) { alert(e.message); }
}
async function convertSpirit(from, to) {
  try {
    const r = await api('POST', '/api/me/spirit/convert', { from, to });
    meData.spirit = r.spirit;
    flash('兑换成功：' + SPIRIT_NAMES[from] + ' → ' + SPIRIT_NAMES[to] + ' +1');
    renderShop();
  } catch (e) { alert(e.message); }
}
// 购买流程：self 直接买（title 需输入称号）；target 弹窗选成员(+输入内容)
let shopBuyCtx = null;
async function buyItem(id) {
  const meta = { rename: {}, title: { input: '称号', max: 12 }, frame: {}, bubble_green: {}, bubble_cat: {}, bubble_v4: {}, glow: {}, baoxue: {},
    mute: { target: true, hint: '选择要禁言 3 分钟的成员' },
    voodoo: { target: true, input: '替换消息内容', max: 200, hint: '选择成员，其下一条消息将被替换为你输入的内容' },
    nisheng: { target: true, input: '新签名', max: 30, hint: '选择要修改签名的成员' },
    xuehun: { target: true, input: '新个性称号', max: 12, hint: '选择同阶或更低阶的成员' },
    anon: {}, trace: {}, burn: {},
    heart: { target: true, hint: '选择要发起真心换真心的成员（对方确认后方可交换）' } }[id];
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
  if (r.baoxueUntil !== undefined) meData.baoxueUntil = r.baoxueUntil;
  if (r.glowUntil !== undefined) meData.glowUntil = r.glowUntil;
  if (r.slogan !== undefined) meData.slogan = r.slogan;
  if (r.ownedStyles !== undefined) meData.ownedStyles = r.ownedStyles;
  if (r.equippedStyles !== undefined) meData.equippedStyles = r.equippedStyles;
  if (r.charges) meData.charges = r.charges;
  if (r.dailyLimits) meData.dailyLimits = r.dailyLimits;
  if (r.heartSession) {
    meData.heartSessions = meData.heartSessions || [];
    meData.heartSessions = meData.heartSessions.filter((s) => s.id !== r.heartSession.id).concat(r.heartSession); capHeartSessions();
  }
  flash('购买成功！');
  loadMe();
  if (r.heartSession) openHeartPanel(r.heartSession.id);
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

// ---------- 真心符 / 追灵符 / 藏踪符 前端逻辑 ----------
let heartSubmitId = null, pendingHeartImage = null, pendingHeartFile = null;
function renderAnonIndicator() {
  const el = $('#anonIndicator');
  if (!el) return;
  const n = (meData && meData.charges && meData.charges.anon) || 0;
  if (n > 0) { el.textContent = `🕵️ 藏踪符生效中：下一条消息将匿名发送（剩 ${n} 次）`; show(el, true); }
  else show(el, false);
}
function showTraceResult(r) {
  const el = $('#traceModal');
  if (!el) { alert(`🔍 追灵符揭示：该匿名消息由「${r.nickname}」(${r.user}) 发送`); return; }
  $('#traceName').textContent = r.nickname || '未知';
  $('#traceTitle2').textContent = r.title2 ? `（${r.title2}）` : '';
  $('#traceEmail').textContent = r.user || '';
  show(el, true);
}
async function openHeartPanel(focusId) {
  show($('#heartModal'), true);
  await loadHeartSessions(focusId);
}
const HEART_KEEP = 5; // 真心换真心记录只保留最新的 5 条
function capHeartSessions() {
  if (!meData.heartSessions || meData.heartSessions.length <= HEART_KEEP) return;
  meData.heartSessions = [...meData.heartSessions].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, HEART_KEEP);
}
async function loadHeartSessions(focusId) {
  const list = $('#heartList');
  if (list) list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const { sessions } = await api('GET', '/api/heart/mine');
    meData.heartSessions = sessions; capHeartSessions();
    renderHeartList(meData.heartSessions, focusId);
    renderShop();
  } catch (e) { if (list) list.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`; }
}
function heartOtherNick(s) { return s.myRole === 'initiator' ? s.targetNick : s.initiatorNick; }
function heartStatusText(s) {
  if (s.status === 'pending') return s.myRole === 'target' ? '对方向你发起，等待你确认' : '已发起，等待对方确认…';
  if (s.status === 'active') return '进行中：双方都提交后互收内容';
  if (s.status === 'exchanged') return '已完成：双方内容已互换';
  if (s.status === 'rejected') return '已被对方拒绝';
  return s.status;
}
function heartContentHtml(c) {
  if (!c) return '<span class="muted">（空）</span>';
  let h = '';
  if (c.text) h += `<div class="text">${escapeHtml(c.text)}</div>`;
  if (c.image) h += `<img class="msg-img" src="${BASE + c.image}" alt="图片"/>`;
  if (c.file) h += `<a class="heart-file" href="${BASE + c.file.url}" target="_blank" rel="noopener">📎 ${escapeHtml(c.file.name || '文件')}</a>`;
  return h || '<span class="muted">（空）</span>';
}
function heartCardHtml(s) {
  const pair = `${escapeHtml(s.initiatorNick)} 💗 ${escapeHtml(s.targetNick)}`;
  let body = '';
  if (s.status === 'pending') {
    if (s.myRole === 'target') body = `<div class="heart-actions"><button class="btn-primary heart-accept" data-id="${s.id}">接受</button><button class="btn-ghost heart-reject" data-id="${s.id}">拒绝</button></div>`;
    else body = `<div class="heart-tip">等待「${escapeHtml(s.targetNick)}」确认…</div>`;
  } else if (s.status === 'active') {
    if (!s.mySubmitted) body = `<div class="heart-actions"><button class="btn-primary heart-submit-open" data-id="${s.id}">提交我的内容</button></div>`;
    else if (!s.otherSubmitted) body = `<div class="heart-tip">你已提交，等待「${escapeHtml(heartOtherNick(s))}」提交…</div>`;
    else body = `<div class="heart-tip">双方均已提交，内容已互换 ↓</div>`;
  } else if (s.status === 'exchanged') {
    if (s.cleared) body = `<div class="heart-tip">内容已清除（阅后即焚，关闭弹窗后不可再查看）。</div>`;
    else body = `<div class="heart-content"><div class="heart-content-other"><b>对方内容</b>${heartContentHtml(s.otherContent)}</div><div class="heart-content-me"><b>我的内容</b>${heartContentHtml(s.myContent)}</div></div>`;
  } else if (s.status === 'rejected') {
    body = `<div class="heart-tip">对方已拒绝本次真心换真心。</div>`;
  }
  return `<div class="heart-card" data-sid="${s.id}"><div class="heart-card-head"><span class="heart-pair">${pair}</span><span class="heart-status heart-status-${s.status}">${heartStatusText(s)}</span></div>${body}</div>`;
}
function renderHeartList(sessions, focusId) {
  const list = $('#heartList');
  if (!list) return;
  if (!sessions || !sessions.length) { list.innerHTML = '<div class="empty">还没有真心换真心会话。购买「真心符」并向一位成员发起吧。</div>'; return; }
  list.innerHTML = sessions.map((s) => heartCardHtml(s)).join('');
  list.querySelectorAll('.heart-accept').forEach((b) => b.onclick = () => heartAct(b.dataset.id, 'accept'));
  list.querySelectorAll('.heart-reject').forEach((b) => b.onclick = () => heartAct(b.dataset.id, 'reject'));
  list.querySelectorAll('.heart-submit-open').forEach((b) => b.onclick = () => openHeartSubmit(b.dataset.id));
  if (focusId) { const f = list.querySelector(`[data-sid="${focusId}"]`); if (f) f.scrollIntoView({ behavior: 'smooth' }); }
}
async function heartAct(id, action) {
  try {
    const r = await api('POST', `/api/heart/${id}/${action}`);
    if (r.session) meData.heartSessions = (meData.heartSessions || []).filter((x) => x.id !== id).concat(r.session); capHeartSessions();
    renderHeartList(meData.heartSessions);
    renderShop();
  } catch (e) { alert(e.message); }
}
function openHeartSubmit(id) {
  heartSubmitId = id; pendingHeartImage = null; pendingHeartFile = null;
  $('#heartSubmitText').value = '';
  $('#heartSubmitImgChip').innerHTML = ''; show($('#heartSubmitImgChip'), false);
  $('#heartSubmitFileChip').innerHTML = ''; show($('#heartSubmitFileChip'), false);
  show($('#heartSubmitModal'), true);
}
function renderHeartImgChip() {
  const chip = $('#heartSubmitImgChip');
  if (!pendingHeartImage) { show(chip, false); chip.innerHTML = ''; return; }
  chip.innerHTML = `<img src="${pendingHeartImage}" class="chip-img"/><button class="chip-x" data-act="clearheartimg">✕</button>`;
  show(chip, true);
}
function renderHeartFileChip() {
  const chip = $('#heartSubmitFileChip');
  if (!pendingHeartFile) { show(chip, false); chip.innerHTML = ''; return; }
  chip.innerHTML = `📎 ${escapeHtml(pendingHeartFile.name)}<button class="chip-x" data-act="clearheartfile">✕</button>`;
  show(chip, true);
}
async function submitHeart() {
  if (!heartSubmitId) return;
  const text = $('#heartSubmitText').value.trim();
  if (!text && !pendingHeartImage && !pendingHeartFile) { alert('请提交内容（消息/图片/文件）'); return; }
  const body = {};
  if (text) body.text = text;
  if (pendingHeartImage) body.image = pendingHeartImage;
  if (pendingHeartFile) { body.fileDataUrl = pendingHeartFile.dataUrl; body.fileName = pendingHeartFile.name; body.fileType = pendingHeartFile.type; }
  show($('#heartSubmitModal'), false);
  try {
    const r = await api('POST', `/api/heart/${heartSubmitId}/submit`, body);
    pendingHeartImage = null; pendingHeartFile = null;
    if (r.session) meData.heartSessions = (meData.heartSessions || []).filter((x) => x.id !== heartSubmitId).concat(r.session); capHeartSessions();
    renderHeartList(meData.heartSessions);
    renderShop();
    flash('已提交，等待对方提交后即可互收');
  } catch (e) { alert(e.message); }
}
// 真心符提交：图片选择
$('#heartSubmitImg').onclick = () => $('#heartSubmitImgInput').click();
$('#heartSubmitImgInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('仅支持图片文件'); e.target.value = ''; return; }
  if (file.size > 10 * 1024 * 1024) { alert('图片不能超过 10MB'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { pendingHeartImage = reader.result; renderHeartImgChip(); };
  reader.readAsDataURL(file); e.target.value = '';
};
// 真心符提交：文件选择
$('#heartSubmitFile').onclick = () => $('#heartSubmitFileInput').click();
$('#heartSubmitFileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pendingHeartFile = { name: file.name, type: file.type, dataUrl: reader.result }; renderHeartFileChip(); };
  reader.readAsDataURL(file); e.target.value = '';
};
$('#heartSubmitOk').onclick = submitHeart;
$('#heartSubmitClose').onclick = () => show($('#heartSubmitModal'), false);
$('#heartModalClose').onclick = closeHeartModal;
// 关闭真心换真心弹窗时，擦除已交换的内容（阅后即焚）
async function closeHeartModal() {
  const ex = (meData.heartSessions || []).filter((s) => s.status === 'exchanged' && !s.cleared);
  for (const s of ex) {
    try {
      const r = await api('POST', `/api/heart/${s.id}/clear`);
      if (r.session) meData.heartSessions = (meData.heartSessions || []).filter((x) => x.id !== s.id).concat(r.session); capHeartSessions();
    } catch (e) { /* 忽略：即便清失败也照常关闭弹窗 */ }
  }
  show($('#heartModal'), false);
}
// 点遮罩 / 按 Esc 关闭真心换真心弹窗，同样触发阅后即焚擦除
$('#heartModal').addEventListener('click', (e) => { if (e.target === $('#heartModal')) closeHeartModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const hm = $('#heartModal'); if (hm && !hm.classList.contains('hidden')) closeHeartModal(); } });
$('#traceClose').onclick = () => show($('#traceModal'), false);
// 全局委托：真心符图片/文件清除
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'clearheartimg') { pendingHeartImage = null; renderHeartImgChip(); }
  else if (act === 'clearheartfile') { pendingHeartFile = null; renderHeartFileChip(); }
});

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
  else if (act === 'taskaccept') acceptTask(el.dataset.id);
  else if (act === 'tasksubmit') openSubmitModal(el.dataset.id);
  else if (act === 'taskconfirm') confirmTask(el.dataset.id);
  else if (act === 'taskquit') quitTask(el.dataset.id);
  else if (act === 'taskcancel') cancelTask(el.dataset.id);
  else if (act === 'gotasks') goView('tasks');
  else if (act === 'mytasks') openMyTasks();
  else if (act === 'taskprev') goCarousel(-1);         // ← 向左按钮 → 选中左侧卡片（上一任务，从服务端拉取上一个）
  else if (act === 'tasknext') goCarousel(1);          // 向右 → 按钮 → 选中右侧卡片（下一任务，从服务端拉取下一个）
  else if (act === 'taskacceptnav') { const ct = taskAtAbs(taskCenterIdx); if (ct) acceptTask(ct.id); }
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
      ? `<video src="${BASE + m.path}" controls preload="metadata" onerror="this.outerHTML='<div class=&quot;media-fail&quot;>视频加载失败</div>'"></video>`
      : `<audio src="${BASE + m.path}" controls preload="metadata" onerror="this.outerHTML='<div class=&quot;media-fail&quot;>音频加载失败</div>'"></audio>`;
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
    kbMobileEditing(false); // 移动端：默认回到文档列表（桌面端无样式影响）
  } catch (e) { $('#kbTree').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
// 知识库移动端两页切换：kb-editing=true 显示编辑器、false 显示文档列表（≤860px 生效，桌面无影响）
function kbMobileEditing(on) {
  const b = document.querySelector('.kb-body');
  if (b) b.classList.toggle('kb-editing', on);
}
$('#kbBack').onclick = () => kbMobileEditing(false);
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
    kbMobileEditing(true); // 移动端：进入编辑/查看页（桌面端无样式影响）
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
// 「＋ 新建」下拉：新建文档 / 新建文件夹
$('#kbNewBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#kbNewMenu');
  if (!menu.classList.contains('hidden')) { show(menu, false); return; }
  const r = $('#kbNewBtn').getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.right - 170, window.innerWidth - 178)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  show(menu, true);
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#kbNewMenu') && !e.target.closest('#kbNewBtn')) show($('#kbNewMenu'), false);
});
$('#kbNewMenu').querySelectorAll('.ctx-item').forEach((b) => {
  b.onclick = () => {
    show($('#kbNewMenu'), false);
    if (b.dataset.kbnew === 'doc') newKbDoc(null);
    else {
      const name = prompt('文件夹名称：');
      if (!name || !name.trim()) return;
      api('POST', '/api/kb/folders', { name: name.trim() }).then(() => loadKb()).catch((e) => alert(e.message));
    }
  };
});
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

// ---------- 任务发布板块（皇榜） ----------
let taskBoardData = { open: [], published: [], accepted: [] };
let pendingTaskFile = null;     // 提交交付时的临时文件
let submitTaskId = null;
const DELIVER_LABEL = { doc: '📄 文档', video: '🎬 视频', image: '🖼 图片', audio: '🎵 音频' };
const TASK_STATUS_LABEL = { open: '待揭榜', accepted: '进行中', submitted: '待确认', done: '已完成', canceled: '已取消/已退单' };
function deliverLabel(t) { return DELIVER_LABEL[t] || t; }
function taskStatusLabel(s) { return TASK_STATUS_LABEL[s] || s; }
// 渲染接单方提交的交付内容（发布者/接单方可见）
function submissionHtml(t) {
  if (!t.submission) return '';
  const s = t.submission;
  let html = '<div class="task-submission"><div class="task-sub-label">📦 接单方交付内容</div>';
  if (s.text) html += `<p class="task-sub-text">${escapeHtml(s.text)}</p>`;
  if (s.url) {
    const name = s.name || '交付文件';
    const isImg = /^image\//.test(s.type || '');
    if (isImg) html += `<a href="${s.url}" target="_blank" class="task-sub-file"><img src="${s.url}" class="task-sub-img" alt="交付图片" /></a>`;
    else html += `<a href="${s.url}" target="_blank" download class="task-sub-file">📎 ${escapeHtml(name)}</a>`;
  }
  if (!s.text && !s.url) html += '<p class="task-sub-text muted">（接单方未填写内容）</p>';
  html += '</div>';
  return html;
}

async function loadTasks() {
  try {
    const mine = await api('GET', '/api/tasks/mine');
    taskBoardData.published = mine.published || [];
    taskBoardData.accepted = mine.accepted || [];
    const tu = $('#timedUsed'); if (tu) tu.textContent = mine.timedUsed || 0;
    const tm = $('#timedMax'); if (tm) tm.textContent = mine.timedMax || 3;
    if (currentView === 'tasks') await refreshCarousel();
  } catch (e) { const b = $('#taskStage'); if (b) b.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
// ===== 皇榜三卡封面流（服务端分页：初始只拉 3 个，左右导航各从 DB 拉取上/下一个）=====
let taskCenterIdx = 0;            // 当前居中卡片在「全量 open 列表」中的绝对下标
let taskTotal = 0;                // 服务端返回的可浏览任务总数
let taskWindow = [];              // 当前已加载的窗口（最多 3 个）
let taskWindowStart = 0;          // 当前窗口首项的绝对下标
let taskAnimating = false;
let taskSwipeBound = false;
let carouselL = null, carouselC = null, carouselR = null;

function renderTasks() { renderTaskBoard(); }

function renderTaskBoard() {
  const stage = $('#taskStage');
  if (!stage) return;
  refreshCarousel().catch(() => {});
}

// 进入皇榜 / 接取·确认等操作后调用；保留当前居中位置，从服务端重新拉取窗口
async function refreshCarousel() {
  const stage = $('#taskStage');
  if (!stage) return;
  const firstLoad = !carouselC;
  if (firstLoad) buildCarouselDom();
  await fetchWindow(taskCenterIdx);
  if (firstLoad) taskCenterIdx = taskTotal >= 3 ? 1 : (taskTotal === 2 ? 1 : 0);
  else taskCenterIdx = Math.min(Math.max(taskCenterIdx, 0), Math.max(0, taskTotal - 1));
  renderSlotsFromWindow();
  updateNavButtons();
}

// 从服务端分页拉取以 centerIdx 为中心、最多 3 个的窗口
async function fetchWindow(centerIdx) {
  const localStart = Math.max(0, centerIdx - 1);
  const d = await api('GET', `/api/tasks?offset=${localStart}&limit=3`);
  taskTotal = d.total || 0;
  taskWindow = d.tasks || [];
  taskWindowStart = localStart;
  return d;
}
function taskAtAbs(absIdx) {
  if (absIdx < taskWindowStart || absIdx >= taskWindowStart + taskWindow.length) return null;
  return taskWindow[absIdx - taskWindowStart];
}

function buildCarouselDom() {
  const stage = $('#taskStage'); if (!stage) return;
  stage.innerHTML = '';
  carouselL = makeSlot(); carouselC = makeSlot(); carouselR = makeSlot();
  stage.appendChild(carouselL); stage.appendChild(carouselC); stage.appendChild(carouselR);
  bindTaskSwipe();
}
function makeSlot() {
  const el = document.createElement('div');
  el.className = 'task-card task-card--carousel pos-center';
  el.addEventListener('click', () => {
    if (taskAnimating) return;
    if (el === carouselL) goCarousel(-1);
    else if (el === carouselR) goCarousel(1);
  });
  return el;
}
function setSlot(slot, task, posClass) {
  if (!slot) return;
  if (!task) { slot.style.visibility = 'hidden'; slot.innerHTML = ''; slot.className = 'task-card task-card--carousel ' + posClass; return; }
  slot.style.visibility = 'visible';
  slot.innerHTML = taskCardHtml(task, 'board');
  slot.className = 'task-card task-card--carousel ' + posClass;
}
function renderSlotsFromWindow() {
  const rel = taskCenterIdx - taskWindowStart;
  const center = taskWindow[rel];
  if (!center) {
    const stage = $('#taskStage');
    if (stage) stage.innerHTML = '<div class="empty">还没有悬赏任务，去发布一个吧～</div>';
    carouselL = carouselC = carouselR = null;
    return;
  }
  setSlot(carouselL, rel > 0 ? taskWindow[rel - 1] : null, 'pos-left');
  setSlot(carouselC, center, 'pos-center');
  setSlot(carouselR, rel < taskWindow.length - 1 ? taskWindow[rel + 1] : null, 'pos-right');
}
function updateNavButtons() {
  const prev = $('#taskPrevBtn'), next = $('#taskNextBtn');
  if (prev) prev.disabled = taskCenterIdx <= 0;
  if (next) next.disabled = taskCenterIdx >= taskTotal - 1;
}

// dir>0：下一张（卡片向左滑）；dir<0：上一张（卡片向右滑）；每次都从服务端拉取新窗口
async function goCarousel(dir) {
  if (taskAnimating) return;
  const newCenter = taskCenterIdx + dir;
  if (newCenter < 0 || newCenter >= taskTotal) return;
  taskAnimating = true;
  const stage = $('#taskStage');
  await fetchWindow(newCenter);
  if (dir > 0) {
    if (carouselL) { carouselL.classList.remove('pos-left'); carouselL.classList.add('pos-left-hidden'); const L = carouselL; setTimeout(() => L.remove(), 440); }
    if (carouselC) { carouselC.classList.remove('pos-center'); carouselC.classList.add('pos-left'); }
    if (carouselR) { carouselR.classList.remove('pos-right'); carouselR.classList.add('pos-center'); }
    const nr = taskAtAbs(taskCenterIdx + 2);
    const newR = makeSlot();
    newR.className = 'task-card task-card--carousel pos-right-hidden';
    if (nr) { newR.innerHTML = taskCardHtml(nr, 'board'); newR.style.visibility = 'visible'; }
    else newR.style.visibility = 'hidden';
    stage.appendChild(newR);
    void newR.offsetWidth;
    newR.classList.remove('pos-right-hidden'); newR.classList.add('pos-right');
    carouselL = carouselC; carouselC = carouselR; carouselR = newR;
  } else {
    if (carouselR) { carouselR.classList.remove('pos-right'); carouselR.classList.add('pos-right-hidden'); const R = carouselR; setTimeout(() => R.remove(), 440); }
    if (carouselC) { carouselC.classList.remove('pos-center'); carouselC.classList.add('pos-right'); }
    if (carouselL) { carouselL.classList.remove('pos-left'); carouselL.classList.add('pos-center'); }
    const nl = taskAtAbs(taskCenterIdx - 2);
    const newL = makeSlot();
    newL.className = 'task-card task-card--carousel pos-left-hidden';
    if (nl) { newL.innerHTML = taskCardHtml(nl, 'board'); newL.style.visibility = 'visible'; }
    else newL.style.visibility = 'hidden';
    stage.appendChild(newL);
    void newL.offsetWidth;
    newL.classList.remove('pos-left-hidden'); newL.classList.add('pos-left');
    carouselR = carouselC; carouselC = carouselL; carouselL = newL;
  }
  taskCenterIdx = newCenter;
  updateNavButtons();
  setTimeout(() => { taskAnimating = false; }, 440);
}

// 滑动手势：左划 → 下一张；右划 → 上一张
function bindTaskSwipe() {
  const stage = $('#taskStage');
  if (!stage || taskSwipeBound) return;
  taskSwipeBound = true;
  let sx = 0, sy = 0;
  stage.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; }, { passive: true });
  stage.addEventListener('pointerup', (e) => {
    if (!sx && !sy) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) goCarousel(1); else goCarousel(-1); }
    sx = 0; sy = 0;
  }, { passive: true });
}
function taskCardHtml(t, where) {
  const uname = SPIRIT_NAMES[t.reward.unit] ? SPIRIT_NAMES[t.reward.unit].replace('灵石', '') : '';
  const reward = `${t.reward.amount} ${SPIRIT_ICONS[t.reward.unit] || ''}${uname}`;
  const timeReq = t.timeReq ? escapeHtml(t.timeReq) : '不限';
  let actions = '';
  if (where === 'board') {
    actions = t.iAccepted
      ? `<span class="task-tag">你已接取</span>`
      : `<button class="btn-primary task-act-btn" data-act="taskaccept" data-id="${t.id}">🙋 揭榜</button>`;
  } else if (where === 'accepted') {
    if (t.status === 'accepted') actions = `<button class="btn-primary task-act-btn" data-act="tasksubmit" data-id="${t.id}">📤 提交交付</button><button class="btn-ghost task-act-btn" data-act="taskquit" data-id="${t.id}">退单</button>`;
    else if (t.status === 'submitted') actions = `<span class="task-tag">已提交 · 待发布者确认</span>`;
    else if (t.status === 'done') actions = `<span class="task-tag task-done">已完成 · 灵石已到账</span>`;
  } else if (where === 'published') {
    if (t.status === 'open') actions = `<button class="btn-ghost task-act-btn" data-act="taskcancel" data-id="${t.id}">取消（退灵石）</button>`;
    else if (t.status === 'submitted') actions = `<button class="btn-primary task-act-btn" data-act="taskconfirm" data-id="${t.id}">✅ 确认完成并发放</button>`;
    else if (t.status === 'accepted') actions = `<span class="task-tag">已接取（${escapeHtml(t.acceptedByNick || '')}）</span>`;
    else if (t.status === 'done') actions = `<span class="task-tag task-done">已完成</span>`;
  }
  // 发布者/接单方在「待确认」「已完成」状态下可见交付内容
  const showSub = t.submission && (where === 'published' || where === 'accepted') && (t.status === 'submitted' || t.status === 'done');
  return `<div class="task-card ${t.status === 'done' || t.status === 'canceled' ? 'task-card--done' : ''}">
    <div class="task-card-top">
      <span class="task-status-badge task-status-${t.status}">${taskStatusLabel(t.status)}</span>
      <span class="task-reward">🏆 ${reward}</span>
    </div>
    <h3 class="task-title">${escapeHtml(t.title)}</h3>
    ${t.desc ? `<p class="task-desc-text">${escapeHtml(t.desc)}</p>` : ''}
    <div class="task-card-info">
      <div class="task-info-row"><span class="ti-label">交付格式</span><span class="ti-val">${deliverLabel(t.deliverType)}</span></div>
      <div class="task-info-row"><span class="ti-label">时间要求</span><span class="ti-val">${timeReq}</span></div>
      <div class="task-info-row"><span class="ti-label">发布者</span><span class="ti-val">${escapeHtml(t.publisherNick || '')}</span></div>
      <div class="task-info-row"><span class="ti-label">发布时间</span><span class="ti-val">${fmtTime(t.createdAt)}</span></div>
    </div>
    ${showSub ? submissionHtml(t) : ''}
    <div class="task-card-foot">${actions}</div>
  </div>`;
}
async function acceptTask(id) {
  try { await api('POST', `/api/tasks/${id}/accept`); flash('揭榜成功！任务已加入你的限时任务'); loadTasks(); }
  catch (e) { alert(e.message); }
}
function openSubmitModal(id) {
  submitTaskId = id;
  const t = taskBoardData.accepted.find((x) => x.id === id);
  $('#taskSubmitReq').textContent = t ? `要求交付类型：${deliverLabel(t.deliverType)}` : '';
  $('#taskSubmitText').value = '';
  pendingTaskFile = null; const chip = $('#taskSubmitChip'); chip.classList.add('hidden'); chip.textContent = '';
  show($('#taskSubmitModal'), true);
}
async function doSubmit() {
  if (!submitTaskId) return;
  const body = { text: $('#taskSubmitText').value };
  if (pendingTaskFile) { body.fileDataUrl = pendingTaskFile.dataUrl; body.fileName = pendingTaskFile.name; }
  try { await api('POST', `/api/tasks/${submitTaskId}/submit`, body); show($('#taskSubmitModal'), false); flash('交付已提交，等待发布者确认'); loadTasks(); }
  catch (e) { alert(e.message); }
}
async function confirmTask(id) {
  if (!confirm('确认该任务已完成，并将悬赏灵石发放给接单方？')) return;
  try { await api('POST', `/api/tasks/${id}/confirm`); flash('已确认，灵石已发放'); loadTasks(); }
  catch (e) { alert(e.message); }
}
async function quitTask(id) {
  if (!confirm('确定退单吗？任务将退回皇榜，悬赏灵石退回发布者。')) return;
  try { await api('POST', `/api/tasks/${id}/quit`); flash('已退单'); loadTasks(); }
  catch (e) { alert(e.message); }
}
async function cancelTask(id) {
  if (!confirm('取消发布？悬赏灵石将退回你的账户。')) return;
  try { await api('POST', `/api/tasks/${id}/cancel`); flash('已取消，灵石已退回'); loadTasks(); }
  catch (e) { alert(e.message); }
}
function openPublishModal() {
  $('#taskTitle').value = ''; $('#taskDesc').value = ''; $('#taskTimeReq').value = '';
  $('#taskRewardAmount').value = ''; $('#taskDeliverType').value = 'doc'; $('#taskRewardUnit').value = 'xp';
  show($('#taskPublishModal'), true);
}
async function doPublish() {
  const title = $('#taskTitle').value.trim();
  const desc = $('#taskDesc').value.trim();
  const rewardUnit = $('#taskRewardUnit').value;
  const rewardAmount = Number($('#taskRewardAmount').value);
  if (!title) { alert('请填写任务标题'); return; }
  if (!rewardAmount || rewardAmount <= 0) { alert('请填写有效的悬赏数量'); return; }
  try {
    const r = await api('POST', '/api/tasks', { title, desc, rewardUnit, rewardAmount, deliverType: $('#taskDeliverType').value, timeReq: $('#taskTimeReq').value.trim() });
    show($('#taskPublishModal'), false);
    flash(`发布成功，已托管 ${r.task.reward.amount} ${SPIRIT_NAMES[r.task.reward.unit].replace('灵石', '')} 灵石`);
    if (meData && meData.spirit) meData.spirit = r.spirit;
    loadTasks();
  } catch (e) { alert(e.message); }
}
// 个人中心「限时任务」区填充
async function loadMeTimedTasks() {
  const box = $('#meTimedTasks'); if (!box) return;
  try {
    const mine = await api('GET', '/api/tasks/mine');
    if (!mine.accepted.length) { box.innerHTML = '<div class="empty">还没有接取限时任务</div>'; return; }
    box.innerHTML = mine.accepted.map((t) => `<div class="me-timed-row"><b>${escapeHtml(t.title)}</b><span class="task-tag">${taskStatusLabel(t.status)}</span>${t.status === 'accepted' ? `<button class="btn-ghost task-act-btn" data-act="tasksubmit" data-id="${t.id}">提交</button>` : ''}</div>`).join('');
  } catch { box.innerHTML = '<div class="empty">加载失败</div>'; }
}
// 我的任务：弹出查看已接取的任务
function openMyTasks() {
  const box = $('#myTasksList'); if (!box) return;
  box.innerHTML = taskBoardData.accepted.length
    ? taskBoardData.accepted.map((t) => taskCardHtml(t, 'accepted')).join('')
    : '<div class="empty">还没有接取任务，去皇榜揭榜吧～</div>';
  const pub = $('#myTasksPublished');
  if (pub) pub.innerHTML = taskBoardData.published.length
    ? taskBoardData.published.map((t) => taskCardHtml(t, 'published')).join('')
    : '<div class="empty">还没有发布任务</div>';
  show($('#myTasksModal'), true);
}
// 视图布局切换（4.1）
function setLayout(n) {
  const grid = document.querySelector('.grid');
  grid.classList.remove('layout-0', 'layout-1', 'layout-2', 'layout-3', 'layout-4');
  grid.classList.add('layout-' + n);
  document.querySelectorAll('#layoutSwitch .layout-sq').forEach((b) => b.classList.toggle('active', Number(b.dataset.layout) === n));
}
// 多功能按钮：显示/隐藏 5 个功能入口（媒体管理 / 投票 / 反馈 / 知识库 / 皇榜）
// 出现动画：从右到左依次弹出（最右的皇榜先出现）；隐藏动画：从左到右依次收回（最左的媒体管理先收）
let featHidden = false, featAnimating = false;
function toggleFeatBar() {
  if (featAnimating) return;
  const bar = document.querySelector('.feature-bar');
  if (!bar) return;
  const cards = Array.from(bar.querySelectorAll('.feat-card'));
  const N = cards.length;
  const STEP = 90; // 各按钮错峰间隔(ms)
  featAnimating = true;
  if (!featHidden) {
    // 隐藏：从左到右（最左 index0 先收）
    cards.forEach((c, i) => {
      c.style.animationDelay = (i * STEP) + 'ms';
      c.classList.remove('feat-anim-show');
      void c.offsetWidth; // 强制重排以重启动画
      c.classList.add('feat-anim-hide');
    });
    setTimeout(() => {
      cards.forEach((c) => { c.style.display = 'none'; c.classList.remove('feat-anim-hide'); c.style.animationDelay = ''; });
      featHidden = true; featAnimating = false;
      const mf = document.getElementById('multiFuncBtn'); if (mf) mf.classList.add('active');
    }, N * STEP + 320);
  } else {
    // 显示：从右到左（最右 indexN-1 先弹）
    cards.forEach((c, i) => {
      c.style.display = '';
      c.classList.remove('feat-anim-hide');
      c.style.animationDelay = ((N - 1 - i) * STEP) + 'ms';
      void c.offsetWidth;
      c.classList.add('feat-anim-show');
    });
    setTimeout(() => {
      cards.forEach((c) => { c.classList.remove('feat-anim-show'); c.style.animationDelay = ''; });
      featHidden = false; featAnimating = false;
      const mf = document.getElementById('multiFuncBtn'); if (mf) mf.classList.remove('active');
    }, N * STEP + 420);
  }
}
function initTasksUI() {
  const $p = (id) => document.getElementById(id);
  if ($p('taskPublishBtn')) $p('taskPublishBtn').onclick = openPublishModal;
  if ($p('taskPublishClose')) $p('taskPublishClose').onclick = () => show($p('taskPublishModal'), false);
  if ($p('taskPublishOk')) $p('taskPublishOk').onclick = doPublish;
  if ($p('taskSubmitClose')) $p('taskSubmitClose').onclick = () => show($p('taskSubmitModal'), false);
  if ($p('taskSubmitOk')) $p('taskSubmitOk').onclick = doSubmit;
  if ($p('taskDetailClose')) $p('taskDetailClose').onclick = () => show($p('taskDetailModal'), false);
  if ($p('myTasksClose')) $p('myTasksClose').onclick = () => show($p('myTasksModal'), false);
  const mt = $p('myTasksModal'); if (mt) mt.addEventListener('click', (e) => { if (e.target === mt) show(mt, false); });
  if ($p('taskSubmitFileBtn')) $p('taskSubmitFileBtn').onclick = () => $p('taskSubmitFile').click();
  if ($p('taskSubmitFile')) $p('taskSubmitFile').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { pendingTaskFile = { dataUrl: reader.result, name: file.name }; const c = $p('taskSubmitChip'); c.textContent = '📎 ' + file.name; c.classList.remove('hidden'); };
    reader.readAsDataURL(file); e.target.value = '';
  };
  document.querySelectorAll('#layoutSwitch .layout-sq').forEach((b) => { b.onclick = () => setLayout(Number(b.dataset.layout)); });
  const mf = $p('multiFuncBtn'); if (mf) mf.onclick = toggleFeatBar;
}

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
  initTasksUI();
  if (localStorage.getItem('oc_token')) {
    try { await enter(); startTimers(); return; } catch {}
  }
  show($('#home'), true);
})();
