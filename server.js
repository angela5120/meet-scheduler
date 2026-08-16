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
let rooms = {};
let saveTimer = null;
async function loadRooms() {
  try { rooms = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8') || '{}'); }
  catch (e) { rooms = {}; }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await fsp.writeFile(DATA_FILE, JSON.stringify(rooms, null, 2)); } catch (e) {}
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
  const shade = [0, 1, 2].includes(req.body.shade) ? req.body.shade : 1;
  const confirm = req.body.confirm === 'tentative' ? 'tentative' : 'confirmed';
  const repeat = parseRepeat(req.body.repeat);
  const eid = genId(8);
  const ev = {
    id: eid, owner: pid, ownerName: p.name, hue: p.hue,
    title: (title || '日程').toString().slice(0, 40),
    date, start, end,
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
  if (start !== undefined && validTime(start)) ev.start = start;
  if (end !== undefined && validTime(end)) ev.end = end;
  if (ev.start >= ev.end) return res.status(400).json({ error: '结束时间必须晚于开始' });
  if (req.body.shade !== undefined && [0, 1, 2].includes(req.body.shade)) ev.shade = req.body.shade;
  if (req.body.confirm === 'tentative' || req.body.confirm === 'confirmed') ev.confirm = req.body.confirm;
  if (req.body.repeat !== undefined) ev.repeat = parseRepeat(req.body.repeat);
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

(async () => { await loadRooms(); app.listen(PORT, () => console.log(`MeetScheduler 运行在 http://localhost:${PORT}`)); })();
