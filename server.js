const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'rooms.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 存储层 ----------
// 有 DATABASE_URL 就持久化到 Postgres（部署到 Render 时自动挂免费 PG，数据永久不丢）；
// 没有则退回本地文件（本地开发用）。两种模式逻辑一致，只是落盘位置不同。
const USE_DB = !!process.env.DATABASE_URL;
let pool = null;
if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}
let rooms = {};
let saveTimer = null;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function initDB() {
  if (!pool) return;
  // 启动时重试连接：Render 免费 PG 在 Oregon，web 在 Singapore，跨区域 DNS 可能慢。
  // 这里给到 5 分钟覆盖最坏情况（5s × 60 次）
  const maxAttempts = 60;
  const intervalMs = 5000;
  let lastErr = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const c = await pool.connect();
      await c.query(`CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      c.release();
      console.log(`✅ Postgres 已连接（第 ${i}/${maxAttempts} 次尝试）`);
      return;
    } catch (e) {
      lastErr = e;
      if (i === 1 || i % 6 === 0) {
        console.warn(`⏳ 数据库尚未就绪（${i}/${maxAttempts}）：${e.code || e.message}`);
      }
      await sleep(intervalMs);
    }
  }
  throw lastErr || new Error('数据库连接失败');
}

async function loadRooms() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT id, data FROM rooms');
      rooms = {};
      for (const r of rows) rooms[r.id] = r.data;
      return;
    } catch (e) { console.error('从数据库加载失败，回退为空：', e.message); rooms = {}; return; }
  }
  try { rooms = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8') || '{}'); }
  catch (e) { rooms = {}; }
}

// 把整个 rooms 对象写入存储。DB 模式下每个 room upsert 一行（用 jsonb 整个存，结构零改动）。
async function persist() {
  if (pool) {
    for (const id of Object.keys(rooms)) {
      await pool.query(
        'INSERT INTO rooms (id, data, updated_at) VALUES ($1,$2,now()) ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=now()',
        [id, JSON.stringify(rooms[id])]
      );
    }
    return;
  }
  await fsp.writeFile(DATA_FILE, JSON.stringify(rooms, null, 2));
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await persist(); } catch (e) { console.error('保存失败：', e.message); }
  }, 300);
}

// ---------- 工具 ----------
// 每个参与者分配一个基础色相（hue），在自己的色系内用深/中/浅区分类别
const HUES = [210, 265, 330, 25, 150, 195, 285, 350, 130, 45];
const HOURS = []; for (let h = 7; h <= 23; h++) HOURS.push(h); // 7:00 - 23:00
function genId(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s;
}
function genRoomId() { let id; do { id = genId(6); } while (rooms[id]); return id; }
function genPid() { return crypto.randomUUID(); }
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function validTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

// ---------- API ----------
app.post('/api/rooms', async (req, res) => {
  const title = (req.body.title || '我们的日历').toString().slice(0, 60);
  const tz = (req.body.tz || 'Asia/Shanghai').toString().slice(0, 40);
  const dayCount = [7, 14, 30].includes(req.body.dayCount) ? req.body.dayCount : 7;
  const id = genRoomId();
  rooms[id] = { id, title, tz, dayCount, createdAt: Date.now(), participants: {}, events: [] };
  scheduleSave();
  res.json({ id, room: rooms[id] });
});

app.get('/api/rooms/:id', (req, res) => {
  const r = rooms[req.params.id];
  if (!r) return res.status(404).json({ error: '房间不存在' });
  res.json({ room: r });
});

// 房间设置：时区 / 日期范围天数
app.put('/api/rooms/:id', (req, res) => {
  const r = rooms[req.params.id];
  if (!r) return res.status(404).json({ error: '房间不存在' });
  if (req.body.tz) r.tz = req.body.tz.toString().slice(0, 40);
  if ([7, 14, 30].includes(req.body.dayCount)) r.dayCount = req.body.dayCount;
  scheduleSave();
  res.json({ room: r });
});

app.post('/api/rooms/:id/participants', (req, res) => {
  const r = rooms[req.params.id];
  if (!r) return res.status(404).json({ error: '房间不存在' });
  const name = (req.body.name || '匿名').toString().slice(0, 24);
  const pid = genPid();
  const used = Object.values(r.participants).map(p => p.hue);
  let hue = HUES.find(h => !used.includes(h));
  if (hue === undefined) hue = HUES[Object.keys(r.participants).length % HUES.length];
  r.participants[pid] = { pid, name, hue };
  scheduleSave();
  res.json({ pid, hue, room: r });
});

app.put('/api/rooms/:id/participants/:pid', (req, res) => {
  const r = rooms[req.params.id]; if (!r) return res.status(404).json({ error: '房间不存在' });
  const p = r.participants[req.params.pid]; if (!p) return res.status(404).json({ error: '参与者不存在' });
  if (req.body.name) p.name = req.body.name.toString().slice(0, 24);
  scheduleSave(); res.json({ room: r });
});

// 删除参与者（仅本人可删自己；连带删除其名下所有日程）
app.delete('/api/rooms/:id/participants/:pid', (req, res) => {
  const r = rooms[req.params.id]; if (!r) return res.status(404).json({ error: '房间不存在' });
  const pid = req.params.pid;
  if (!r.participants[pid]) return res.status(404).json({ error: '参与者不存在' });
  // 鉴权：URL 里的 pid 必须是本人（用 body 或者 header 都行；这里约定只能用 URL pid 表示"本人删自己"）
  const requester = (req.body && req.body.requester) || req.headers['x-pid'];
  if (requester && requester !== pid) return res.status(403).json({ error: '只能删除自己的身份' });
  // 保留房间至少 1 人（避免空房间）
  if (Object.keys(r.participants).length <= 1) {
    return res.status(400).json({ error: '房间至少保留一位参与者' });
  }
  // 删除该 pid 名下所有事件（作为 owner 的事件以及其作为被邀请者的 status）
  const beforeEvents = r.events.length;
  r.events = r.events.filter(ev => ev.owner !== pid && ev.inviteTo !== pid);
  const removed = beforeEvents - r.events.length;
  delete r.participants[pid];
  scheduleSave();
  res.json({ room: r, removed });
});

// 事件：owner 添加自己的日程；inviteTo 非空则为"邀请事件"
// 字段：shade(0深/1中/2浅) 区分类别，confirm(busy 用：confirmed 实线 / tentative 虚线)，repeat 重复规则
function parseRepeat(rep) {
  if (!rep || typeof rep !== 'object') return null;
  if (rep.type === 'weekly' && Array.isArray(rep.days)) {
    const days = rep.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6).slice(0, 7);
    if (days.length === 0) return null;
    return { type: 'weekly', days };
  }
  if (rep.type === 'monthly' && Number.isInteger(rep.dom) && rep.dom >= 1 && rep.dom <= 31) {
    return { type: 'monthly', dom: rep.dom };
  }
  return null;
}
app.post('/api/rooms/:id/events', (req, res) => {
  const r = rooms[req.params.id]; if (!r) return res.status(404).json({ error: '房间不存在' });
  const { pid, title, date, start, end, inviteTo } = req.body;
  const p = r.participants[pid]; if (!p) return res.status(404).json({ error: '参与者不存在' });
  if (!validTime(start) || !validTime(end) || start >= end) return res.status(400).json({ error: '时间非法' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期非法' });
  if (inviteTo && inviteTo !== 'all' && !r.participants[inviteTo]) return res.status(400).json({ error: '邀请对象不存在' });
  // 连续多天：endDate 合法且 >= 开始日期 才保存，否则视为单日
  let endDate = null;
  if (req.body.endDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.endDate) && req.body.endDate >= date) endDate = req.body.endDate;
  const shade = [0, 1, 2].includes(req.body.shade) ? req.body.shade : 1;
  const confirm = req.body.confirm === 'tentative' ? 'tentative' : 'confirmed';
  const repeat = parseRepeat(req.body.repeat);
  const eid = genId(8);
  const ev = {
    id: eid, owner: pid, ownerName: p.name, hue: p.hue,
    title: (title || '日程').toString().slice(0, 40),
    date, endDate, start, end,
    kind: inviteTo ? 'invite' : 'busy',
    inviteTo: inviteTo || null,
    status: inviteTo ? 'pending' : 'confirmed',
    confirm, shade, repeat,
    note: (req.body.note || '').toString().slice(0, 200),
  };
  r.events.push(ev); scheduleSave(); res.json({ room: r });
});

app.put('/api/rooms/:id/events/:eid', (req, res) => {
  const r = rooms[req.params.id]; if (!r) return res.status(404).json({ error: '房间不存在' });
  const ev = r.events.find(x => x.id === req.params.eid); if (!ev) return res.status(404).json({ error: '事件不存在' });
  const { pid, title, date, start, end } = req.body;
  if (ev.owner !== pid) return res.status(403).json({ error: '只能修改自己的日程' });
  if (title !== undefined) ev.title = title.toString().slice(0, 40);
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) ev.date = date;
  // 连续多天：endDate 变更（为空/非法/早于开始 → 置 null，即回到单日）
  if (req.body.endDate !== undefined) {
    if (req.body.endDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.endDate) && req.body.endDate >= ev.date) ev.endDate = req.body.endDate;
    else ev.endDate = null;
  }
  if (start !== undefined && validTime(start)) ev.start = start;
  if (end !== undefined && validTime(end)) ev.end = end;
  if (ev.start >= ev.end) return res.status(400).json({ error: '结束时间必须晚于开始' });
  if (req.body.shade !== undefined && [0, 1, 2].includes(req.body.shade)) ev.shade = req.body.shade;
  if (req.body.confirm === 'tentative' || req.body.confirm === 'confirmed') ev.confirm = req.body.confirm;
  if (req.body.repeat !== undefined) ev.repeat = parseRepeat(req.body.repeat);
  // 行程类型变更：清空/设置 inviteTo，同步切换 kind/status
  // inviteTo=null/空 → 所有人可见（busy+confirmed）；inviteTo=pid → 邀请（invite+pending）
  if (req.body.inviteTo !== undefined) {
    const it = req.body.inviteTo || null;
    if (it && it !== 'all' && !r.participants[it]) return res.status(400).json({ error: '邀请对象不存在' });
    ev.inviteTo = it;
    ev.kind = it ? 'invite' : 'busy';
    ev.status = it ? 'pending' : 'confirmed';
  }
  scheduleSave(); res.json({ room: r });
});

app.delete('/api/rooms/:id/events/:eid', (req, res) => {
  const r = rooms[req.params.id]; if (!r) return res.status(404).json({ error: '房间不存在' });
  const ev = r.events.find(x => x.id === req.params.eid); if (!ev) return res.status(404).json({ error: '事件不存在' });
  const { pid } = req.body || {};
  const isInvitee = ev.kind === 'invite' && (ev.inviteTo === pid || ev.inviteTo === 'all');
  if (ev.owner !== pid && !isInvitee) return res.status(403).json({ error: '无权删除' });
  r.events = r.events.filter(x => x.id !== ev.id); scheduleSave(); res.json({ room: r });
});

// 邀请回应：被邀请人同意 / 拒绝
app.put('/api/rooms/:id/events/:eid/respond', (req, res) => {
  const r = rooms[req.params.id]; if (!r) return res.status(404).json({ error: '房间不存在' });
  const ev = r.events.find(x => x.id === req.params.eid); if (!ev) return res.status(404).json({ error: '事件不存在' });
  if (ev.kind !== 'invite') return res.status(400).json({ error: '这不是邀请' });
  const { pid, status } = req.body;
  const isInvitee = ev.inviteTo === pid || ev.inviteTo === 'all';
  if (!isInvitee) return res.status(403).json({ error: '你不是被邀请人' });
  if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: '状态非法' });
  if (status === 'declined') { r.events = r.events.filter(x => x.id !== ev.id); }
  else { ev.status = 'accepted'; }
  scheduleSave(); res.json({ room: r });
});

(async () => {
  // 即使数据库暂时连不上，也先把 web 服务起起来（不让 Render 误判 Exited 1）
  // DB 模式下首次启动若失败：本轮 rooms 为空 + 提示；下次请求会触发新的连接尝试。
  try {
    await initDB();
    await loadRooms();
  } catch (e) {
    console.error('❌ 启动时数据库初始化失败，将以「临时内存模式」继续提供服务：', e.message);
    console.error('   一般是 Render 内网 DNS 尚未解析完成后端 PG hostname，过一会儿刷新即可');
    rooms = {};
  }
  app.listen(PORT, () => {
    console.log(`MeetScheduler 运行在 http://localhost:${PORT}（存储：${pool ? (Object.keys(rooms).length ? 'Postgres ✅' : 'Postgres ⚠️ 临时内存') : '本地文件'}）`);
    if (pool) {
      // 后台静默重试，每 15s 探测一次，连上后立即从数据库加载
      const retry = async () => {
        try {
          const c = await pool.connect(); c.release();
          await loadRooms();
          console.log('✅ 数据库已上线，已有数据已加载（共 ' + Object.keys(rooms).length + ' 个房间）');
          return true;
        } catch { return false; }
      };
      (async function loop() {
        while (!(await retry())) await sleep(15000);
      })();
    }
  });
})();
