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
let pollTimer = null, presenceTimer = null;

const fmtTime = (t) => {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const show = (el, v) => el.classList.toggle('hidden', !v);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    const delBtn = myRole === 'admin' ? `<button class="room-del" title="删除此任务（含其下所有内容）" data-act="delroom" data-id="${r.id}">✕</button>` : '';
    div.innerHTML = `<span class="room-idx">任务${i + 1}</span><span class="room-name">${r.encrypted ? '🔒 ' : ''}${escapeHtml(r.name)}</span>${delBtn}`;
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
  renderMessages(messages);
}
function renderMessages(list) {
  curMessages = list || [];
  const box = $('#messages');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">还没有消息，发一条吧</div>'; updateScrollBtn(); return; }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
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
    row.innerHTML = `<div class="bubble"><div class="meta"><span class="who">${escapeHtml(m.nickname)}</span><span class="time">${fmtTime(m.time)}</span>${editedTag}${delBtn}</div>${inner}</div>`;
    box.appendChild(row);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
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
  if (file.size > 100 * 1024 * 1024) { alert('图片不能超过 100MB'); e.target.value = ''; return; }
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
document.addEventListener('click', (e) => { if (!e.target.closest('#msgMenu')) hideMsgMenu(); });
document.addEventListener('scroll', hideMsgMenu, true);

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

// ---------- SSE 实时推送（消息秒达；轮询保留兜底）----------
let sse = null;
function connectSSE() {
  const token = localStorage.getItem('oc_token');
  if (!token || sse) return;
  try {
    sse = new EventSource(BASE + '/api/stream?token=' + encodeURIComponent(token));
    sse.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d || !d.type) return;
        if (d.type === 'message' && d.roomId === currentRoomId) loadMessages().catch(() => {});
        else if (d.type === 'roomCreated') loadRooms().catch(() => {});
        else if (d.type === 'roomDeleted' && d.roomId === currentRoomId) {
          currentRoomId = null;
          $('#roomTitle').textContent = '请选择左侧任务';
          renderTodos([]);
          $('#notesArea').value = '';
          loadRooms().catch(() => {});
        }
      } catch {}
    };
    // EventSource 断线自动重连，无需手动处理 error
  } catch {}
}
function closeSSE() { if (sse) { sse.close(); sse = null; } }

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
    row.innerHTML = `<label class="todo-check"><input type="checkbox" ${t.done ? 'checked' : ''}/><span class="todo-text">${escapeHtml(t.text)}</span></label><button class="todo-x" title="删除">✕</button>`;
    row.querySelector('input').onchange = () => toggleTodo(t.id, row.querySelector('input').checked);
    row.querySelector('.todo-x').onclick = () => deleteTodo(t.id);
    box.appendChild(row);
  });
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
    row.className = 'member-item';
    const mins = Math.floor(m.onlineSec / 60000); // onlineSec 单位是毫秒 → 转分钟
    const role = m.role === 'admin' ? '<span class="member-role">管理员</span>' : '';
    row.innerHTML =
      `<span class="member-dot ${m.online ? 'on' : ''}"></span>` +
      `<span class="rank-no">${i + 1}</span>` +
      `<span class="rank-title t-${m.title}">${m.title}</span>` +
      `<span class="member-name">${escapeHtml(m.nickname)}</span>${role}` +
      `<span class="rank-score">${m.score}分</span>` +
      `<span class="member-email">在线${mins}分 · 消息${m.msgs} · 完成${m.done}</span>`;
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
function goView(name) {
  const isMain = name === 'main';
  show($('#app'), isMain);
  show($('#page-daily'), name === 'daily');
  show($('#page-vote'), name === 'vote');
  show($('#page-moan'), name === 'moan');
  show($('#page-kb'), name === 'kb');
  if (name === 'main') startRoomLive();
  else stopRoomTimers();
  if (name === 'daily') loadDaily();
  if (name === 'vote') loadVotes();
  if (name === 'moan') loadMoans();
  if (name === 'kb') loadKb();
}
window.goView = goView;

// 全局事件委托：统一处理所有 data-act 动作（不用内联 onclick，兼容严格 CSP）
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-fmt]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.dataset.fmt) { applyFmt(el.dataset.fmt); return; }
  if (act === 'view') goView(el.dataset.view);
  else if (act === 'delmsg') delMessage(el.dataset.id);
  else if (act === 'delroom') delRoom(el.dataset.id);
  else if (act === 'delvote') delVote(el.dataset.id);
  else if (act === 'delmoan') delMoan(el.dataset.id);
  else if (act === 'openimg') window.open(el.dataset.src);
  else if (act === 'clearimg') clearPendingImage();
  else if (act === 'vote') vote(el.dataset.vid, Number(el.dataset.idx));
  else if (act === 'delfolder') deleteKbFolder(el.dataset.id);
  else if (act === 'delkbdoc') deleteKbDoc();
  else if (act === 'kbimg') $('#kbImgInput').click();
  else if (act === 'kbemoji') show($('#kbEmojiPanel'), $('#kbEmojiPanel').classList.contains('hidden'));
  else if (act === 'emoji') { insertAtCursor(el.dataset.e); show($('#kbEmojiPanel'), false); }
  else if (act === 'kbnewdoc') newKbDoc(el.dataset.folder);
});

// ---------- 工作日报生成器 ----------
let dailyRooms = [];
async function loadDaily() {
  try { const d = await api('GET', '/api/daily'); dailyRooms = d.rooms; }
  catch (e) { dailyRooms = []; }
}
$('#dailyGen').onclick = () => {
  if (!dailyRooms.length) { flash('还没有任何任务，先去左侧「新建任务」建一个'); return; }
  $('#dailyPickList').innerHTML = dailyRooms.map((r) =>
    `<label class="daily-pick"><input type="checkbox" data-id="${r.id}" checked /><b>${escapeHtml(r.name)}</b>` +
    `<span class="daily-cnt">${r.count > 0 ? r.count + ' 条' : '0 条'}</span></label>`).join('');
  show($('#dailyModal'), true);
};
$('#closeDaily').onclick = () => show($('#dailyModal'), false);
$('#dailyPickAll').onclick = () => document.querySelectorAll('#dailyPickList input[type=checkbox]').forEach((c) => { c.checked = true; });
$('#dailyPickNone').onclick = () => document.querySelectorAll('#dailyPickList input[type=checkbox]').forEach((c) => { c.checked = false; });
$('#dailyPickOk').onclick = () => {
  const ids = new Set([...document.querySelectorAll('#dailyPickList input[type=checkbox]:checked')].map((c) => c.dataset.id));
  const sel = dailyRooms.filter((r) => ids.has(r.id));
  if (!sel.length) { flash('请至少勾选一个任务'); return; }
  const lines = sel.map((r, i) =>
    `■ ${i + 1}. ${r.name}：` + (r.count > 0
      ? `今日推进 ${r.count} 条沟通` + (r.people.length ? `（参与：${r.people.join('、')}）` : '') +
        (r.snippets.length ? `\n   · ${r.snippets.join('\n   · ')}` : '')
      : '今日暂未推进沟通')
  );
  const d = new Date();
  const out =
`【工作日报】${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}
${lines.join('\n')}
---
今日推进 ${sel.length} 项任务，累计沟通 ${sel.reduce((a, r) => a + r.count, 0)} 条。`;
  $('#dailyOut').value = out;
  show($('#dailyOut'), true);
  show($('#dailyCopy'), true);
  show($('#dailyClear'), true);
  show($('#dailyModal'), false);
};
$('#dailyCopy').onclick = async () => {
  const ta = $('#dailyOut');
  try { await navigator.clipboard.writeText(ta.value); flash('日报已复制，去群里粘贴吧'); }
  catch {
    ta.focus(); ta.select();
    try { document.execCommand('copy'); flash('已复制（兼容模式）'); } catch { alert('复制失败，请手动 Ctrl+C'); }
  }
};
$('#dailyClear').onclick = () => { $('#dailyOut').value = ''; show($('#dailyOut'), false); show($('#dailyCopy'), false); show($('#dailyClear'), false); };

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
    kbFolders = kbd.kb.folders; kbDocs = kbd.kb.docs;
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
    div.className = 'kb-doc' + (kbCurrent === d.id ? ' active' : '');
    div.innerHTML = `<span class="kb-doc-t">${escapeHtml(d.title)}</span><span class="kb-doc-time">${fmtTime(d.updatedAt)}</span>`;
    div.onclick = () => selectKbDoc(d.id);
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
    $('#kbPreviewMode').checked = false;
    show($('#kbContent'), true);
    show($('#kbPreview'), false);
    $('#kbPreview').innerHTML = '';
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
  if (file.size > 100 * 1024 * 1024) { alert('图片不能超过 100MB'); return; }
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
$('#kbPreviewMode').onchange = (e2) => {
  const on = e2.target.checked;
  show($('#kbContent'), !on);
  show($('#kbPreview'), on);
  if (on) $('#kbPreview').innerHTML = renderMarkdown($('#kbContent').value);
};
function scheduleKbSave() {
  if (!kbCurrent) return;
  $('#kbSaveState').textContent = '编辑中…';
  clearTimeout(kbSaveTimer);
  kbSaveTimer = setTimeout(async () => {
    try {
      await api('PUT', `/api/kb/docs/${kbCurrent}`, { title: $('#kbTitle').value, content: $('#kbContent').value });
      $('#kbSaveState').textContent = `已保存 ${new Date().toTimeString().slice(0, 5)}`;
      const d = kbDocs.find((x) => x.id === kbCurrent);
      if (d) { d.title = $('#kbTitle').value.trim(); d.updatedAt = Date.now(); renderKbTree(); }
    } catch (e) { $('#kbSaveState').textContent = '保存失败'; }
  }, 800);
}
$('#kbTitle').addEventListener('input', scheduleKbSave);
$('#kbContent').addEventListener('input', scheduleKbSave);
async function newKbDoc(folderId) {
  try { const { doc } = await api('POST', '/api/kb/docs', { folderId: folderId || null }); await loadKb(); await selectKbDoc(doc.id); $('#kbTitle').focus(); }
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

// ---------- 启动 ----------
(async () => {
  try { await loadTheme(); } catch {} // 首页即展示团队定制背景（主题已改为公开可读）
  if (localStorage.getItem('oc_token')) {
    try { await enter(); startTimers(); return; } catch {}
  }
  show($('#home'), true);
})();
