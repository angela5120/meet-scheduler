const $ = (s) => document.querySelector(s);

// ============ 数据层：调用自己的后端 API（数据存在服务器，不依赖任何第三方） ============
const api = {
  getRoom:    (id)    => fetch(`/api/rooms/${id}`).then(r=>r.json()).then(d=>d.room),
  createRoom: (title) => fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})}).then(r=>r.json()),
  join:       (id,name)=> fetch(`/api/rooms/${id}/participants`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}).then(r=>r.json()),
  addEvent:   (id,ev)  => fetch(`/api/rooms/${id}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev)}).then(r=>r.json()).then(d=>d.room),
  updateEvent:(id,eid,ev)=> fetch(`/api/rooms/${id}/events/${eid}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev)}).then(r=>r.json()).then(d=>d.room),
  deleteEvent:(id,eid,pid)=> fetch(`/api/rooms/${id}/events/${eid}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid})}).then(r=>r.json()).then(d=>d.room),
  respond:    (id,eid,pid,status)=> fetch(`/api/rooms/${id}/events/${eid}/respond`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid,status})}).then(r=>r.json()).then(d=>d.room),
  setRoom:    (id,body)=> fetch(`/api/rooms/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).then(d=>d.room),
};
const cacheRoom = () => { try { localStorage.setItem('ms_room_' + roomId, JSON.stringify(room)); } catch (e) {} };
const loadCache = () => { try { return JSON.parse(localStorage.getItem('ms_room_' + roomId)); } catch (e) { return null; } };

// 轮询：拉最新房间，数据有变化才重绘
let lastSig = null;
function sigOf(r){ return JSON.stringify([r.participants, r.events, r.tz, r.dayCount, r.title, view]); }
async function poll() {
  if (!roomId) return;
  try {
    const r = await api.getRoom(roomId);
    const sig = sigOf(r);
    if (sig !== lastSig) {
      lastSig = sig; room = r; cacheRoom();
      if (myPid && room.participants[myPid]) updateMeChip();
      render();
    }
  } catch (e) {}
}

// ============ 工具 ============
const HOUR_START = 7, HOUR_END = 23, ROWH = 46;
const WEEKDAY = ['周日','周一','周二','周三','周四','周五','周六'];
const WEEKDAY_MIN = ['日','一','二','三','四','五','六'];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtHM = (h) => `${pad(Math.floor(h))}:${pad(Math.round((h%1)*60))}`;
const toFloat = (hm) => { const [h,m] = hm.split(':').map(Number); return h + m/60; };
const weekdayShort = (d) => WEEKDAY[new Date(d+'T00:00:00').getDay()];
const toast = (m) => { const t=$('#toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add('hidden'),2200); };
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 色系：每个参与者一个基础色相(hue)，在色系内分 深/中/浅 三档区分类别
// bg=实色（确定事项），bgSoft=半透明（待定/虚线事项，仍保留色相深浅区分）
function shadeSet(hue){
  return [
    { bg:`hsl(${hue} 58% 42%)`, bgSoft:`hsl(${hue} 58% 42% / .30)`, text:'#fff',                     border:`hsl(${hue} 55% 34%)` }, // 0 深
    { bg:`hsl(${hue} 62% 58%)`, bgSoft:`hsl(${hue} 62% 58% / .32)`, text:'#fff',                     border:`hsl(${hue} 55% 48%)` }, // 1 中
    { bg:`hsl(${hue} 70% 84%)`, bgSoft:`hsl(${hue} 70% 84% / .55)`, text:`hsl(${hue} 55% 28%)`,      border:`hsl(${hue} 50% 66%)` }, // 2 浅
  ];
}
function ownerHue(ev){ return (ev.hue!=null) ? ev.hue : (room.participants[ev.owner]?.hue ?? 210); }
function evShade(ev){ const s=[0,1,2].includes(ev.shade)?ev.shade:1; return shadeSet(ownerHue(ev))[s]; }
// 实线 / 虚线 语义：实线=已确定；虚线=待定(可能改) 或 对方尚未同意的邀请
function isSolid(ev){
  if(ev.kind==='invite') return ev.status==='accepted';
  return ev.confirm !== 'tentative';
}

// 重复展开：返回某天应当显示的事件（含 repeat 展开的副本，副本带 eid=主事件id）
function displayEventsOn(ds){
  const out=[];
  const date=new Date(ds+'T00:00:00');
  const dow=date.getDay();        // 0=周日 .. 6=周六
  const dom=date.getDate();
  for(const ev of room.events){
    if(!visible.has(ev.owner)) continue;
    if(ev.repeat){
      let hit=false;
      if(ev.repeat.type==='weekly') hit=ev.repeat.days.includes(dow);
      else if(ev.repeat.type==='monthly') hit=(ev.repeat.dom===dom);
      if(hit) out.push({...ev, date:ds, eid:ev.id});
    } else if(ev.date===ds){
      out.push({...ev, eid:ev.id});
    }
  }
  out.sort((a,b)=>toFloat(a.start)-toFloat(b.start));
  return out;
}

let roomId=null, room=null, myPid=null, pollTimer=null;
let rangeStart=new Date(); rangeStart.setHours(0,0,0,0);
let rangeDays=7;
let visible=new Set();
let editingId=null;
let view='month';            // month / week / agenda
let viewMonth=new Date(); viewMonth.setDate(1); viewMonth.setHours(0,0,0,0);
// 弹窗当前选择（打开时初始化）
let curConfirm='confirmed', curShade=1, curRepeatType='none';

// ---------- 首页 ----------
function showHome(){ $('#home').classList.remove('hidden'); $('#room').classList.add('hidden'); }
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  $('#tab-create').classList.toggle('hidden', b.dataset.tab!=='create');
  $('#tab-join').classList.toggle('hidden', b.dataset.tab!=='join');
});
$('#btn-create').onclick=async()=>{
  const t=$('#create-title').value.trim()||'我们的日历';
  try{
    const d=await api.createRoom(t);
    location.href=location.pathname+'?room='+d.id;
  }catch(e){ toast('创建失败，请检查网络后重试'); }
};
$('#btn-join').onclick=()=>{ const id=$('#join-id').value.trim(); if(!id) return toast('请输入房间号或链接');
  const m=id.match(/room=([^&\s]+)/); location.href=location.pathname+'?room='+(m?m[1]:id); };

// ---------- 进入房间 ----------
async function enterRoom(id){
  roomId=id;
  try{ room=await api.getRoom(id); lastSig=sigOf(room); }
  catch(e){
    const c=loadCache();
    if(c){ room=c; toast('服务器暂不可达，先显示本地缓存'); }
    else { toast('房间不存在或服务器不可用'); showHome(); return; }
  }
  cacheRoom();
  $('#home').classList.add('hidden'); $('#room').classList.remove('hidden');
  $('#room-title').textContent=room.title||'共享日历';
  $('#share-link').value=location.origin+location.pathname+'?room='+id;
  myPid=localStorage.getItem('ms_pid_'+id);
  if(!myPid||!room.participants[myPid]){ $('#name-prompt').classList.remove('hidden'); $('#me-name').textContent='—'; }
  else { $('#name-prompt').classList.add('hidden'); updateMeChip(); }
  visible=new Set(Object.keys(room.participants));
  rangeStart=new Date(); rangeStart.setHours(0,0,0,0);
  rangeDays=[7,14,30].includes(room.dayCount)?room.dayCount:7;
  $('#range-start').value=fmtDate(rangeStart);
  $('#range-days').value=String(rangeDays);
  initTz();
  const t=new Date(); t.setHours(0,0,0,0);
  viewMonth=new Date(t.getFullYear(), t.getMonth(), 1);
  render();
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(poll,3000);
}
// 把"我是：xxx"的色块染成我的专属色系深档
function updateMeChip(){
  const p=room.participants[myPid];
  if(!p) return;
  const sh=shadeSet(p.hue)[0];
  $('#me-name').textContent=p.name;
  $('#me-name').style.background=sh.bg;
  $('#me-name').style.color=sh.text;
  $('#me-name').style.borderColor=sh.border;
}
$('#btn-copy').onclick=()=>{ navigator.clipboard.writeText($('#share-link').value).then(()=>toast('链接已复制，去发给朋友吧')).catch(()=>toast('复制失败，请手动选择')); };
$('#btn-leave').onclick=()=>{ localStorage.removeItem('ms_pid_'+roomId); location.reload(); };
$('#btn-setname').onclick=async()=>{
  const n=$('#name-input').value.trim(); if(!n) return toast('请输入名字');
  try{
    const d=await api.join(roomId,n);
    myPid=d.pid;
    localStorage.setItem('ms_pid_'+roomId,myPid);
    room=d.room;
    $('#name-prompt').classList.add('hidden'); updateMeChip();
    visible=new Set(Object.keys(room.participants)); render();
  }catch(e){ toast('加入失败，请重试'); }
};

// ---------- 日期范围 / 时区 ----------
function rangeDaysList(){
  const base=new Date(rangeStart); base.setHours(0,0,0,0);
  const out=[]; for(let i=0;i<rangeDays;i++){ const d=new Date(base); d.setDate(base.getDate()+i); out.push(fmtDate(d)); }
  return out;
}
const TZ_LIST=['Asia/Shanghai','Asia/Hong_Kong','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Paris','America/New_York','America/Los_Angeles','Australia/Sydney','UTC'];
function initTz(){
  const sel=$('#room-tz'); sel.innerHTML='';
  for(const t of TZ_LIST) sel.innerHTML+=`<option value="${t}">${t}</option>`;
  sel.value=room.tz||'Asia/Shanghai';
  sel.onchange=async()=>{ try{ room=await api.setRoom(roomId,{tz:sel.value}); room.tz=sel.value; toast('时区已更新'); }catch(e){toast('更新失败');} };
}

// ---------- 视图切换 ----------
function switchView(v){
  view=v;
  document.querySelectorAll('.view-tab').forEach(t=>t.classList.toggle('active', t.dataset.view===v));
  $('#view-month').classList.toggle('hidden', v!=='month');
  $('#view-week').classList.toggle('hidden', v!=='week');
  $('#view-agenda').classList.toggle('hidden', v!=='agenda');
  $('#fab-add').style.display = (v==='month') ? 'flex' : 'none';
  render();
}
document.querySelectorAll('.view-tab').forEach(b=>b.onclick=()=>switchView(b.dataset.view));

// ---------- 渲染 ----------
function render(){ renderPeople(); renderCalendar(); renderFree(); renderInvites(); if(view==='agenda') renderAgenda(); }

// ---------- 月历工作台 ----------
function renderCalendar(){
  if(view==='month'){ renderMonth(); return; }
  if(view==='week'){  renderWeek();  return; }
}
function monthGridDays(){
  const y=viewMonth.getFullYear(), m=viewMonth.getMonth();
  const first=new Date(y,m,1);
  const dow=(first.getDay()+6)%7;                       // 周一开头
  const start=new Date(y,m,1-dow);
  return { y, m, days:Array.from({length:42},(_,i)=>{ const d=new Date(start); d.setDate(start.getDate()+i); return d; }) };
}
function renderMonth(){
  const { y, m, days } = monthGridDays();
  $('#cal-month-label').textContent = `${y}年${m+1}月`;
  const todayStr=fmtDate(new Date());
  let html='';
  for(const d of days){
    const inMonth = d.getMonth()===m;
    const ds=fmtDate(d);
    const wd=d.getDay();
    const isToday = ds===todayStr;
    const cls=['mcell'];
    if(!inMonth) cls.push('out');
    if(wd===6) cls.push('sat');
    if(wd===0) cls.push('sun');
    if(isToday) cls.push('today');
    const dayEvents=displayEventsOn(ds);
    let tagsHtml='';
    const MAX=4;
    for(let i=0;i<Math.min(MAX,dayEvents.length);i++) tagsHtml += monthTag(dayEvents[i]);
    if(dayEvents.length>MAX) tagsHtml += `<span class="tag-more" data-more="${ds}">+${dayEvents.length-MAX}</span>`;
    html += `<div class="${cls.join(' ')}" data-d="${ds}">
      <div class="mcell-head"><span class="mcell-day">${d.getDate()}</span><span class="mcell-week">${WEEKDAY_MIN[wd]}</span></div>
      <div class="mcell-tags">${tagsHtml}</div>
    </div>`;
  }
  $('#month-grid').innerHTML=html;
  $('#month-grid').querySelectorAll('.mcell').forEach(c=>{
    c.onclick=(e)=>{ if(e.target.classList.contains('tag')||e.target.classList.contains('tag-more')) return; openModal(c.dataset.d, 9); };
  });
  $('#month-grid').querySelectorAll('.tag').forEach(t=>{
    t.onclick=(e)=>{ e.stopPropagation();
      const ev=room.events.find(x=>x.id===t.dataset.id);
      if(ev) openModal(ev.date, null, ev);
    };
  });
  $('#month-grid').querySelectorAll('.tag-more').forEach(mo=>{
    mo.onclick=(e)=>{ e.stopPropagation();
      rangeStart=new Date(mo.dataset.more+'T00:00:00'); rangeDays=7;
      $('#range-start').value=fmtDate(rangeStart); $('#range-days').value='7';
      switchView('agenda');
    };
  });
}
function monthTag(ev){
  const sh=evShade(ev);
  const isTent = ev.kind==='busy' && ev.confirm==='tentative';
  const bg = isTent ? sh.bgSoft : sh.bg;
  const bd = isSolid(ev) ? `1px solid ${sh.border}` : `1.5px dashed ${sh.border}`;
  let cls='tag';
  if(!isSolid(ev)) cls+=' dash';
  const iAmInvitee = ev.kind==='invite'&&(ev.inviteTo===myPid||ev.inviteTo==='all');
  if(ev.kind==='invite'&&ev.status==='pending'&&iAmInvitee) cls+=' pending-me';
  if(ev.kind==='invite'&&ev.status==='accepted') cls+=' accepted-ring';
  const mark = ev.kind==='invite'?(ev.status==='accepted'?' ✓':'(待回应)'):(isTent?' ·待定':'');
  return `<div class="${cls}" data-id="${ev.eid||ev.id}" style="background:${bg};border:${bd};color:${sh.text}">
    <span class="tag-t">${escapeHtml(ev.title)}${mark}</span><span class="tag-c">${ev.start}</span></div>`;
}

// ---------- 周视图（时间轴）----------
function renderWeek(){
  const days=rangeDaysList();
  $('#week-label').textContent=`${days[0].slice(5)} ~ ${days[days.length-1].slice(5)} · 共${days.length}天 · ${room.tz||'时区'}`;
  let axis=`<div class="time-axis"><div class="ta-head"></div>`;
  for(let h=HOUR_START;h<HOUR_END;h++) axis+=`<div class="ta-hour">${pad(h)}:00</div>`;
  axis+=`</div>`;
  let cols='';
  const todayStr=fmtDate(new Date());
  for(const d of days){
    const isToday=d===todayStr?' today':'';
    cols+=`<div class="day-col"><div class="day-head${isToday}"><span class="dh-d">${d.slice(5)}</span><span class="dh-w">${weekdayShort(d)}</span></div><div class="day-body" data-d="${d}">`;
    for(let h=HOUR_START;h<HOUR_END;h++) cols+=`<div class="hour-line"></div>`;
    for(const ev of displayEventsOn(d)){
      const s=Math.max(toFloat(ev.start),HOUR_START), e=Math.min(toFloat(ev.end),HOUR_END);
      if(e<=s) continue;
      const top=(s-HOUR_START)*ROWH, hgt=(e-s)*ROWH;
      cols+=eventBlock(ev,top,hgt);
    }
    cols+=`</div></div>`;
  }
  $('#calendar').innerHTML=axis+cols;
  $('#calendar').querySelectorAll('.day-body').forEach(db=>{
    db.onclick=(ev)=>{ if(ev.target.classList.contains('day-body')||ev.target.classList.contains('hour-line')){
      const rect=db.getBoundingClientRect(); const y=ev.clientY-rect.top; const hr=HOUR_START+Math.floor(y/ROWH); openModal(db.dataset.d, hr);
    } };
  });
  $('#calendar').querySelectorAll('.event').forEach(el=>{
    el.onclick=(ev)=>{ ev.stopPropagation(); const ev2=room.events.find(x=>x.id===el.dataset.id);
      if(ev2&&ev2.owner===myPid&&ev2.kind==='busy') openModal(ev2.date, null, ev2);
    };
  });
}
function eventBlock(ev,top,hgt){
  const sh=evShade(ev);
  const isTent = ev.kind==='busy' && ev.confirm==='tentative';
  const bg = isTent ? sh.bgSoft : sh.bg;
  const bd = isSolid(ev) ? `1px solid ${sh.border}` : `1.5px dashed ${sh.border}`;
  let cls='event';
  if(!isSolid(ev)) cls+=' dash';
  const iAmInvitee=ev.kind==='invite'&&(ev.inviteTo===myPid||ev.inviteTo==='all');
  if(ev.kind==='invite'&&ev.status==='pending'&&iAmInvitee) cls+=' pending-me';
  if(ev.kind==='invite'&&ev.status==='accepted') cls+=' accepted-ring';
  let actions='';
  if(ev.kind==='invite'&&ev.status==='pending'&&iAmInvitee){
    actions=`<div class="ev-actions"><button class="mini-a" data-act="accepted" data-id="${ev.id}">同意</button><button class="mini-d" data-act="declined" data-id="${ev.id}">拒绝</button></div>`;
  }
  const tag=ev.kind==='invite'?(ev.status==='accepted'?'✓邀请':'⟳邀请'):(isTent?'·待定':'');
  return `<div class="${cls}" data-id="${ev.id}" style="top:${top}px;height:${hgt}px;background:${bg};border:${bd};color:${sh.text}">
    <div class="ev-t">${escapeHtml(ev.title)} ${tag}</div><div class="ev-o">${ev.start}-${ev.end} · ${escapeHtml(ev.ownerName)}</div>${actions}</div>`;
}

// ---------- 日程视图 ----------
function renderAgenda(){
  const days=rangeDaysList();
  $('#ag-label').textContent = `${days[0].slice(5)} ~ ${days[days.length-1].slice(5)} · ${room.tz||'时区'}`;
  const list=$('#agenda-list'); list.innerHTML='';
  let any=false;
  for(const d of days){
    const evs=displayEventsOn(d);
    if(evs.length===0) continue;
    any=true;
    list.innerHTML += `<div class="agenda-day">${d.slice(5)} <span class="sub">${weekdayShort(d)}</span></div>`;
    for(const ev of evs){
      const sh=evShade(ev);
      const mark = ev.kind==='invite'?(ev.status==='accepted'?' ✓邀请':' ⟳邀请(待回应)'):(ev.confirm==='tentative'?' ·待定':'');
      list.innerHTML += `<div class="agenda-item" data-id="${ev.eid||ev.id}">
        <span class="agenda-dot" style="background:${sh.bg}"></span>
        <span class="agenda-time">${ev.start}–${ev.end}</span>
        <span class="agenda-tit" style="color:${sh.text}">${escapeHtml(ev.title)}${mark}</span>
        <span class="agenda-meta">${escapeHtml(ev.ownerName)}</span></div>`;
    }
  }
  if(!any) list.innerHTML = '<div class="agenda-empty">这段时间还没有可见的日程</div>';
  list.querySelectorAll('.agenda-item').forEach(el=>{
    el.onclick=()=>{ const ev=room.events.find(x=>x.id===el.dataset.id); if(ev) openModal(ev.date, null, ev); };
  });
}

// ---------- 人员显隐 ----------
function renderPeople(){
  const src=`<button class="ghost small" id="only-me">仅看我</button><button class="ghost small" id="only-all">全部</button>`;
  let parts='';
  for(const p of Object.values(room.participants)){
    const off=!visible.has(p.pid)?' off':'';
    const sw=shadeSet(p.hue)[0].bg;
    parts += `<span class="ptoggle${off}" data-pid="${p.pid}"><i class="sw" style="background:${sw}"></i>${escapeHtml(p.name)}</span>`;
  }
  const html = src+parts;
  $('#people-toggles').innerHTML = html;
  const mirror=$('#people-toggles-2'); if(mirror) mirror.innerHTML=html;
  [['#people-toggles'],['#people-toggles-2']].forEach(([sel])=>{
    const box=$(sel); if(!box) return;
    box.querySelector('#only-me')?.addEventListener('click',()=>{ if(myPid){ visible=new Set([myPid]); render(); } });
    box.querySelector('#only-all')?.addEventListener('click',()=>{ visible=new Set(Object.keys(room.participants)); render(); });
    box.querySelectorAll('.ptoggle').forEach(el=>el.addEventListener('click',()=>{
      const pid=el.dataset.pid; if(visible.has(pid)) visible.delete(pid); else visible.add(pid); render();
    }));
  });
}

// ---------- 共同空闲 ----------
function isOccupy(ev){ if(ev.kind==='invite') return ev.status==='accepted'; return true; } // busy(含待定) 都算占用；pending 邀请不算
function renderFree(){
  const days=rangeDaysList(); const box=$('#free-list'); box.innerHTML='';
  let any=false;
  for(const d of days){
    const blocks=[];
    for(const ev of displayEventsOn(d)){ if(isOccupy(ev)) blocks.push([toFloat(ev.start),toFloat(ev.end)]); }
    blocks.sort((a,b)=>a[0]-b[0]);
    const free=[]; let cur=HOUR_START;
    for(const [s,e] of blocks){ if(s>cur) free.push([cur,Math.min(s,HOUR_END)]); cur=Math.max(cur,e); }
    if(cur<HOUR_END) free.push([cur,HOUR_END]);
    if(free.length===0){ box.innerHTML+=`<div class="free-chip">${d.slice(5)} ${weekdayShort(d)}：无共同空闲</div>`; continue; }
    for(const [s,e] of free){ if(e-s<0.5) continue; any=true;
      box.innerHTML+=`<div class="free-chip">${d.slice(5)} ${weekdayShort(d)}：${fmtHM(s)}–${fmtHM(e)} 空闲</div>`; }
  }
  if(!any && box.innerHTML==='') box.innerHTML='<span class="af-empty">还没有日程，添加后这里会显示共同空闲时段。</span>';
}

// ---------- 待回应邀请 ----------
function renderInvites(){
  const box=$('#invites'); box.innerHTML='';
  const received=room.events.filter(e=>e.kind==='invite'&&e.status==='pending'&&(e.inviteTo===myPid||e.inviteTo==='all'));
  const sent=room.events.filter(e=>e.kind==='invite'&&e.status==='pending'&&e.owner===myPid);
  if(received.length===0&&sent.length===0){ box.innerHTML='<span class="af-empty">暂无邀请。在日历上点空白处添加日程，选择「作为邀请发给」即可发起。</span>'; return; }
  for(const e of received){
    box.innerHTML+=`<div class="inv"><div class="inv-time">${e.date.slice(5)} ${weekdayShort(e.date)} ${e.start}-${e.end}</div>
      <div class="inv-meta">${escapeHtml(e.ownerName)} 邀请你：「${escapeHtml(e.title)}」</div>
      <div class="inv-actions"><button class="primary small" data-act="accepted" data-id="${e.id}">同意</button><button class="ghost small" data-act="declined" data-id="${e.id}">拒绝</button></div></div>`;
  }
  for(const e of sent){
    const who=e.inviteTo==='all'?'所有人':(room.participants[e.inviteTo]?.name||'对方');
    box.innerHTML+=`<div class="inv"><div class="inv-time">${e.date.slice(5)} ${weekdayShort(e.date)} ${e.start}-${e.end}</div>
      <div class="inv-meta">你邀请 ${who}：「${escapeHtml(e.title)}」 · 等待回应…</div></div>`;
  }
  box.querySelectorAll('button[data-act]').forEach(b=>b.onclick=async()=>{
    try{ room=await api.respond(roomId,b.dataset.id,myPid,b.dataset.act); toast(b.dataset.act==='accepted'?'已同意 ✅':'已拒绝'); render(); }
    catch(err){toast('操作失败，请重试');} });
}

// ---------- 弹窗：添加/编辑事件 ----------
function buildMonthlyOptions(){
  let o=''; for(let i=1;i<=31;i++) o+=`<option value="${i}">每月 ${i} 号</option>`;
  $('#ev-monthly').innerHTML=o;
}
function openModal(date, startHour, ev){
  editingId=ev?ev.id:null;
  const isInvite = ev && ev.kind==='invite';
  $('#modal-title').textContent=ev?'编辑日程':'添加日程';
  $('#ev-title').value=ev?ev.title:'';
  $('#ev-date').value=ev?ev.date:date;
  $('#ev-start').value=ev?ev.start:(pad(startHour||9)+':00');
  $('#ev-end').value=ev?ev.end:(pad(Math.min((startHour||9)+1,HOUR_END))+':00');

  // 行程类型（两种）：所有人可见 / 邀请特定人
  // 编辑旧邀请事件时回填；编辑普通事件/新建 默认"所有人可见"
  let curVis = 'public';
  const radios = $('#ev-vis-opts').querySelectorAll('input[name=ev-vis]');
  if (ev && isInvite) {
    curVis = 'invite';
  } else if (ev && ev.inviteTo === 'all') {
    // 兼容老数据：之前选过"所有人"——现在归并到"所有人可见"
    curVis = 'public';
  }
  radios.forEach(r => r.checked = (r.value === curVis));
  $('#ev-vis-opts').querySelectorAll('.vis-opt').forEach(o => o.classList.toggle('on', o.dataset.vis === curVis));

  // 邀请目标人下拉：仅 curVis === 'invite' 时显示；填入除了自己之外的所有参与者
  const sel = $('#ev-invite');
  sel.innerHTML = '';
  for (const p of Object.values(room.participants)) {
    if (p.pid !== myPid) sel.innerHTML += `<option value="${p.pid}">${escapeHtml(p.name)}</option>`;
  }
  if (isInvite && ev.inviteTo && ev.inviteTo !== 'all') {
    // 若该人还在列表里就选中；不在则自动追加并选中
    if (![...sel.options].some(o => o.value === ev.inviteTo)) {
      const tp = room.participants[ev.inviteTo];
      if (tp) sel.innerHTML += `<option value="${tp.pid}">${escapeHtml(tp.name)}</option>`;
    }
    sel.value = ev.inviteTo;
  } else if (sel.options.length > 0) {
    sel.value = sel.options[0].value;
  }
  const updateInviteRow = () => {
    const v = [...radios].find(r => r.checked)?.value || 'public';
    $('#ev-vis-opts').querySelectorAll('.vis-opt').forEach(o => o.classList.toggle('on', o.dataset.vis === v));
    $('#ev-invite-row').classList.toggle('hidden', v !== 'invite');
  };
  $('#ev-vis-opts').querySelectorAll('input[name=ev-vis]').forEach(r => r.addEventListener('change', updateInviteRow));
  updateInviteRow();

  // 状态（仅普通日程显示；邀请由回应决定）
  const confirmWrap=$('#ev-confirm-wrap');
  if(confirmWrap) confirmWrap.classList.toggle('hidden', isInvite);
  curConfirm = (ev && ev.kind!=='invite') ? (ev.confirm||'confirmed') : 'confirmed';
  $('#ev-confirm-seg').querySelectorAll('.seg-b').forEach(x=>x.classList.toggle('on', x.dataset.v===curConfirm));
  // 类别颜色（用我的色系预览三档）
  const hue = (room.participants[myPid]?.hue ?? 210);
  const ss=shadeSet(hue);
  $('#ev-shades').innerHTML = ss.map((s,i)=>`<button type="button" class="shade-b" data-i="${i}" style="background:${s.bg};border-color:${s.border};color:${s.text}">${['深','中','浅'][i]}</button>`).join('');
  curShade = (ev && [0,1,2].includes(ev.shade)) ? ev.shade : 1;
  $('#ev-shades').querySelectorAll('.shade-b').forEach(x=>x.classList.toggle('on', Number(x.dataset.i)===curShade));
  $('#ev-shades').querySelectorAll('.shade-b').forEach(b=>b.onclick=()=>{ curShade=Number(b.dataset.i);
    $('#ev-shades').querySelectorAll('.shade-b').forEach(x=>x.classList.toggle('on', Number(x.dataset.i)===curShade)); });
  $('#ev-confirm-seg').querySelectorAll('.seg-b').forEach(b=>b.onclick=()=>{ curConfirm=b.dataset.v;
    $('#ev-confirm-seg').querySelectorAll('.seg-b').forEach(x=>x.classList.toggle('on', x.dataset.v===curConfirm)); });
  // 重复
  curRepeatType = ev && ev.repeat ? ev.repeat.type : 'none';
  $('#ev-repeat-type').value=curRepeatType;
  $('#ev-weekly').classList.toggle('hidden', curRepeatType!=='weekly');
  $('#ev-monthly').classList.toggle('hidden', curRepeatType!=='monthly');
  if(curRepeatType==='weekly' && ev.repeat){
    $('#ev-weekly').querySelectorAll('button').forEach(b=>b.classList.toggle('on', ev.repeat.days.includes(Number(b.dataset.d))));
  } else {
    $('#ev-weekly').querySelectorAll('button').forEach(b=>b.classList.remove('on'));
  }
  if(curRepeatType==='monthly' && ev.repeat){ $('#ev-monthly').value=String(ev.repeat.dom); }
  $('#ev-repeat-type').onchange=()=>{ const t=$('#ev-repeat-type').value;
    $('#ev-weekly').classList.toggle('hidden', t!=='weekly');
    $('#ev-monthly').classList.toggle('hidden', t!=='monthly'); };
  $('#ev-weekly').querySelectorAll('button').forEach(b=>b.onclick=()=>b.classList.toggle('on'));
  // 操作按钮
  const actions=$('#modal-actions');
  if(ev){ actions.innerHTML=`<button class="ghost" id="ev-cancel">取消</button><button class="primary" id="ev-save">保存</button><button class="ghost small" id="ev-del" style="color:#ef4444;border-color:#ef4444">删除</button>`; }
  else { actions.innerHTML=`<button class="ghost" id="ev-cancel">取消</button><button class="primary" id="ev-save">保存</button>`; }
  $('#ev-cancel').onclick=closeModal;
  $('#ev-save').onclick=saveEvent;
  if(ev) $('#ev-del').onclick=deleteEvent;
  $('#modal').classList.remove('hidden');
}
function closeModal(){ $('#modal').classList.add('hidden'); editingId=null; }
function readRepeat(){
  const t=$('#ev-repeat-type').value;
  if(t==='weekly'){ const days=[...$('#ev-weekly').querySelectorAll('button.on')].map(b=>Number(b.dataset.d));
    if(days.length) return {type:'weekly',days}; }
  if(t==='monthly'){ return {type:'monthly',dom:Number($('#ev-monthly').value)}; }
  return null;
}
async function saveEvent(){
  if(!myPid){ toast('请先填写名字'); return; }
  const title=$('#ev-title').value.trim()||'日程';
  const date=$('#ev-date').value, start=$('#ev-start').value, end=$('#ev-end').value;
  // 行程类型：所有人可见 → 不邀请（inviteTo=null）；邀请特定人 → 选中的 pid
  const visRadios = $('#ev-vis-opts').querySelectorAll('input[name=ev-vis]');
  const vis = [...visRadios].find(r => r.checked)?.value || 'public';
  let inviteTo = null;
  if (vis === 'invite') {
    inviteTo = $('#ev-invite').value || null;
    if (!inviteTo) return toast('请选择邀请对象');
  }
  if(start>=end) return toast('结束时间必须晚于开始');
  const repeat=readRepeat();
  // 编辑已有事件时也要带 inviteTo（即使是 null，让后端能区分"清空邀请"和"未改"）
  const payload={ pid:myPid, title, date, start, end, inviteTo, shade:curShade, confirm:curConfirm, repeat };
  try{
    if(editingId){ room=await api.updateEvent(roomId,editingId,payload); }
    else { room=await api.addEvent(roomId,payload); }
    closeModal(); render(); toast('已保存');
  }catch(e){ toast('保存失败，请重试'); }
}
async function deleteEvent(){
  try{ room=await api.deleteEvent(roomId,editingId,myPid); closeModal(); render(); toast('已删除'); }
  catch(e){ toast('删除失败'); }
}

// ---------- 月份导航 ----------
$('#mo-prev').onclick=()=>{ viewMonth=new Date(viewMonth.getFullYear(), viewMonth.getMonth()-1, 1); renderCalendar(); };
$('#mo-next').onclick=()=>{ viewMonth=new Date(viewMonth.getFullYear(), viewMonth.getMonth()+1, 1); renderCalendar(); };
$('#cal-pickmonth').onclick=()=>{
  $('#mp-year').innerHTML=''; $('#mp-month').innerHTML='';
  const yr=viewMonth.getFullYear(), mo=viewMonth.getMonth();
  for(let i=yr-5;i<=yr+5;i++) $('#mp-year').innerHTML+=`<option value="${i}" ${i===yr?'selected':''}>${i}年</option>`;
  for(let i=0;i<12;i++) $('#mp-month').innerHTML+=`<option value="${i}" ${i===mo?'selected':''}>${i+1}月</option>`;
  $('#month-picker').classList.remove('hidden');
};
$('#mp-cancel').onclick=()=>$('#month-picker').classList.add('hidden');
$('#mp-ok').onclick=()=>{ const y=Number($('#mp-year').value), m=Number($('#mp-month').value);
  viewMonth=new Date(y,m,1); renderCalendar(); $('#month-picker').classList.add('hidden'); };
$('#month-picker').onclick=(e)=>{ if(e.target.id==='month-picker') $('#month-picker').classList.add('hidden'); };
$('#fab-add').onclick=()=>{ openModal(fmtDate(new Date()), 9); };

// ---------- 周/日程导航 ----------
$('#range-start').onchange=()=>{ const v=$('#range-start').value; if(v){ rangeStart=new Date(v+'T00:00:00'); renderCalendar(); renderFree(); } };
$('#range-days').onchange=()=>{ rangeDays=Number($('#range-days').value); renderCalendar(); renderFree(); };
$('#wk-prev').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()-rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#wk-next').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()+rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#wk-today').onclick=()=>{ rangeStart=new Date(); rangeStart.setHours(0,0,0,0); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#ag-prev').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()-rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderAgenda(); renderFree(); };
$('#ag-next').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()+rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderAgenda(); renderFree(); };
$('#ag-today').onclick=()=>{ rangeStart=new Date(); rangeStart.setHours(0,0,0,0); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderAgenda(); renderFree(); };
$('#modal').onclick=(e)=>{ if(e.target.id==='modal') closeModal(); };

// ---------- .ics 导出 ----------
function genIcs(){
  if(!myPid) return toast('请先设置名字');
  if(!room.participants[myPid]) return toast('请先加入日历');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//MeetScheduler//CN','CALSCALE:GREGORIAN'];
  let n=0;
  for(const ev of room.events){
    const mine=(ev.owner===myPid&&ev.kind==='busy'&&ev.confirm==='confirmed')||
      (ev.kind==='invite'&&ev.status==='accepted'&&(ev.owner===myPid||ev.inviteTo===myPid||ev.inviteTo==='all'));
    if(!mine) continue; n++;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:'+ev.id+'@meetscheduler');
    lines.push('DTSTART:'+ev.date.replace(/-/g,'')+'T'+ev.start.replace(':','')+'00');
    lines.push('DTEND:'+ev.date.replace(/-/g,'')+'T'+ev.end.replace(':','')+'00');
    lines.push('SUMMARY:'+(ev.kind==='invite'?'邀请: ':'')+ev.title);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  if(n===0) return toast('你还没有可导出的已确认日程');
  const blob=new Blob([lines.join('\r\n')],{type:'text/calendar'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`${(room.title||'calendar').replace(/[^\w一-龥-]/g,'')}-${myPid.slice(0,4)}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('已导出 '+n+' 条日程为 .ics');
}
$('#btn-ics').onclick=genIcs;
$('#btn-ics-2').onclick=genIcs;
$('#btn-search').onclick=()=>toast('搜索功能开发中…');
$('#btn-more').onclick=()=>toast('更多人/导出/帮助等功能稍后添加');

// ---------- 折叠「大家都有空的时段」 ----------
const freeToggle=$('#btn-toggle-free');
const freeBox=$('#free-list');
if(freeToggle){
  freeToggle.addEventListener('click',()=>{
    const open=freeBox.hidden;
    freeBox.hidden=!open;
    freeToggle.setAttribute('aria-expanded', String(open));
    freeToggle.classList.toggle('open', open);
  });
}

// ---------- 启动 ----------
buildMonthlyOptions();
(function init(){
  const params=new URLSearchParams(location.search); const id=params.get('room');
  if(id){ enterRoom(id); switchView('month'); } else showHome();
})();
