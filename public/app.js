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
let pendingImage = null;      // 待发送图片 dataURL
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
    const delBtn = myRole === 'admin' ? `<button class="room-del" title="删除此任务（含其下所有内容）" onclick="delRoom('${r.id}')">✕</button>` : '';
    div.innerHTML = `<span class="room-idx">任务${i + 1}</span><span class="room-name">${escapeHtml(r.name)}</span>${delBtn}`;
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
$('#taskCreate').onclick = async () => {
  const name = $('#taskName').value.trim();
  if (!name) return;
  try { const { room } = await api('POST', '/api/rooms', { name }); show($('#taskModal'), false); await loadRooms(); selectRoom(room.id); }
  catch (e) { alert(e.message); }
};

async function selectRoom(id) {
  currentRoomId = id;
  const idx = rooms.findIndex((r) => r.id === id);
  const label = idx > -1 ? `任务${idx + 1}：${rooms[idx].name}` : '';
  $('#roomTitle').textContent = label;
  $('#todoScope').textContent = label;
  $('#notesTip').textContent = label ? '自动保存' : '';
  renderRooms();
  if (!currentRoomId) { renderTodos([]); $('#notesArea').value = ''; return; }
  await loadMessages();
  await loadTodos();
  await loadNotes();
  startRoomLive();
}

// ---------- 消息 ----------
async function loadMessages() {
  if (!currentRoomId) return;
  const { messages } = await api('GET', `/api/rooms/${currentRoomId}/messages`);
  renderMessages(messages);
}
function renderMessages(list) {
  const box = $('#messages');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">还没有消息，发一条吧</div>'; return; }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  list.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (m.user === me ? 'me' : 'other');
    let inner = '';
    if (m.image) inner += `<img class="msg-img" src="${BASE + m.image}" alt="图片" onclick="window.open('${BASE + m.image}')" />`;
    if (m.text) inner += `<div class="text">${escapeHtml(m.text)}</div>`;
    const delBtn = myRole === 'admin' ? `<button class="msg-del" title="删除此消息" onclick="delMessage('${m.id}')">✕</button>` : '';
    row.innerHTML = `<div class="bubble"><div class="meta"><span class="who">${escapeHtml(m.nickname)}</span><span class="time">${fmtTime(m.time)}</span>${delBtn}</div>${inner}</div>`;
    box.appendChild(row);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
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
  chip.innerHTML = `<img src="${pendingImage}" class="chip-img"/><button class="chip-x" onclick="clearPendingImage()">✕</button><span class="chip-tip">随发送一起发出</span>`;
  show(chip, true);
}
function clearPendingImage() { pendingImage = null; renderImgChip(); }
window.clearPendingImage = clearPendingImage;

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

// ---------- 在线状态（按房间）----------
function startRoomLive() {
  stopRoomTimers();
  // 每 5 秒上报自己在该房间在线，并拉取在线名单 + 成员列表（人员面板实时刷新）
  presenceTimer = setInterval(() => {
    if (currentRoomId) {
      api('POST', '/api/presence', { roomId: currentRoomId }).then((d) => renderDots(d.online)).catch(() => {});
      loadRank().catch(() => {});
    }
  }, 5000);
  // 立即上报一次
  api('POST', '/api/presence', { roomId: currentRoomId }).then((d) => renderDots(d.online)).catch(() => {});
  window.addEventListener('beforeunload', leavePresence);
}
function stopRoomTimers() {
  if (presenceTimer) clearInterval(presenceTimer);
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

// 全局轮询消息（半实时）
function startTimers() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (currentRoomId) loadMessages().catch(() => {}); }, 8000);
}
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
    const mins = Math.floor(m.onlineSec / 60);
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
  if (name === 'main') startRoomLive();
  else stopRoomTimers();
  if (name === 'daily') loadDaily();
  if (name === 'vote') loadVotes();
  if (name === 'moan') loadMoans();
}
window.goView = goView;

// ---------- 工作日报生成器 ----------
let dailyRooms = [];
async function loadDaily() {
  try {
    const d = await api('GET', '/api/daily');
    dailyRooms = d.rooms;
    renderDailyRooms();
  } catch (e) { $('#dailyRooms').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
function renderDailyRooms() {
  const box = $('#dailyRooms');
  box.innerHTML = '';
  if (!dailyRooms.length) { box.innerHTML = '<div class="empty">今天还没有任务消息，先去 AI 任务区聊几句吧</div>'; return; }
  dailyRooms.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'daily-room';
    div.innerHTML =
      `<label class="daily-pick"><input type="checkbox" data-id="${r.id}" checked /><b>${escapeHtml(r.name)}</b></label>` +
      `<span class="daily-meta">${r.count} 条 · 参与：${r.people.map(escapeHtml).join('、')}</span>` +
      (r.snippets.length ? `<div class="daily-snips">${r.snippets.map((s) => `<i>${escapeHtml(s)}</i>`).join('')}</div>` : '');
    box.appendChild(div);
  });
}
function selectedDailyRooms() {
  const ids = new Set([...document.querySelectorAll('#dailyRooms input[type=checkbox]:checked')].map((c) => c.dataset.id));
  return dailyRooms.filter((r) => ids.has(r.id));
}
$('#dailyGen').onclick = () => {
  const sel = selectedDailyRooms();
  if (!sel.length) { flash('请先勾选至少一个任务'); return; }
  const lines = sel.map((r, i) =>
    `■ ${i + 1}. ${r.name}：今日推进 ${r.count} 条沟通` +
    (r.people.length ? `（参与：${r.people.join('、')}）` : '') +
    (r.snippets.length ? `\n   · ${r.snippets.join('\n   · ')}` : '')
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
};
$('#dailyCopy').onclick = async () => {
  const ta = $('#dailyOut');
  try { await navigator.clipboard.writeText(ta.value); flash('日报已复制，去群里粘贴吧'); }
  catch {
    ta.focus(); ta.select();
    try { document.execCommand('copy'); flash('已复制（兼容模式）'); } catch { alert('复制失败，请手动 Ctrl+C'); }
  }
};
$('#dailySelAll').onclick = () => document.querySelectorAll('#dailyRooms input[type=checkbox]').forEach((c) => { c.checked = true; });
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
      return `<div class="vote-opt${v.mine ? ' locked' : ''}" data-vid="${v.id}" data-idx="${i}">` +
        `<div class="vote-opt-bar" style="width:${pct}%"></div>` +
        `<span class="vote-opt-txt">${escapeHtml(o.text)}${mine ? ' <em>✓ 我投的</em>' : ''}</span>` +
        `<span class="vote-opt-n">${o.count} 票 · ${pct}%</span></div>`;
    }).join('');
    const delBtn = myRole === 'admin' ? `<button class="vote-del" onclick="delVote('${v.id}')">✕</button>` : '';
    card.innerHTML =
      `<div class="vote-head"><b>${escapeHtml(v.title)}</b><span class="vote-total">共 ${sum} 票</span>${delBtn}</div>` +
      `<div class="vote-opts">${optsHtml}</div>` +
      (v.mine ? '<div class="vote-tip">已参与 · 结果实时更新</div>' : '<div class="vote-tip">点击选项参与投票（每人一票）</div>');
    box.appendChild(card);
  });
  document.querySelectorAll('.vote-opt:not(.locked)').forEach((el) => {
    el.onclick = () => vote(el.dataset.vid, Number(el.dataset.idx));
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

// ---------- 匿名树洞 ----------
async function loadMoans() {
  try {
    const { moans } = await api('GET', '/api/moans');
    renderMoans(moans);
  } catch (e) { $('#moanList').innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}
function renderMoans(list) {
  const box = $('#moanList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">树洞还空着，来说点什么吧（完全匿名）</div>'; return; }
  list.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'moan-card';
    const delBtn = myRole === 'admin' ? `<button class="moan-del" onclick="delMoan('${m.id}')">✕</button>` : '';
    div.innerHTML = `<div class="moan-body">${escapeHtml(m.text)}</div>` +
      `<div class="moan-foot"><span class="moan-time">匿名 · ${fmtTime(m.time)}</span>${delBtn}</div>`;
    box.appendChild(div);
  });
}
async function delMoan(id) {
  if (!confirm('确定删除这条树洞？')) return;
  try { await api('DELETE', `/api/moans/${id}`); await loadMoans(); } catch (e) { alert(e.message); }
}
window.delMoan = delMoan;
$('#moanSend').onclick = async () => {
  const text = $('#moanText').value.trim();
  if (!text) { flash('先写点什么再发'); return; }
  try { await api('POST', '/api/moans', { text }); $('#moanText').value = ''; await loadMoans(); }
  catch (e) { alert(e.message); }
};

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
