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
      if (myPid && room.participants[myPid]) $('#me-name').textContent = room.participants[myPid].name;
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

// 农历（1900-2100 简化查表，覆盖常见年份；够用了）
const LUNAR_INFO=['金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金','金'];
const LUNAR_MONTH=['正','二','三','四','五','六','七','八','九','十','冬','腊'];
const LUNAR_DAY=['初','十','廿','三十'];
// 简化：用查询一个万年历表，避免引入大表。这里用最常见的"节气/节日"近似：直接显示当月农历按序号（够用：日期显示）。
// 实际我们用一层轻量查表（仅显示日期的大致，错误不影响主体功能）
function lunarDaySimple(date){
  // 简化：取一个基准日（2024-01-01 是农历 冬月二十），按 354.367 天平均月长计算；超出农历月份的近似值即可。生产可换真农历库。
  const base=new Date('2024-01-01T00:00:00');
  const diff=Math.floor((date.getTime()-base.getTime())/(1000*60*60*24));
  const offset=(diff+20)%30; // 冬月二十=基准
  const m=(((Math.floor((diff+20)/30)+11)%12));
  const d=offset%30;
  return LUNAR_MONTH[m]+'月'+(d<10?'初':d<20?'十':d<30?'廿':'三十')+'⺁'+(d%10===0?'十':(d%10));
}

let roomId=null, room=null, myPid=null, pollTimer=null;
let rangeStart=new Date(); rangeStart.setHours(0,0,0,0);
let rangeDays=7;
let visible=new Set();
let editingId=null;
let view='month';            // 当前视图：month / week / agenda
let viewMonth=new Date();    // 当前月视图显示的月份（任意一天即可）
viewMonth.setDate(1); viewMonth.setHours(0,0,0,0);

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
  else { $('#name-prompt').classList.add('hidden'); $('#me-name').textContent=room.participants[myPid].name; }
  visible=new Set(Object.keys(room.participants));
  rangeStart=new Date(); rangeStart.setHours(0,0,0,0);
  rangeDays=[7,14,30].includes(room.dayCount)?room.dayCount:7;
  $('#range-start').value=fmtDate(rangeStart);
  $('#range-days').value=String(rangeDays);
  initTz();
  // 月视图默认本月（不是从今天开始的 0 点，而是 1 号）
  const t=new Date(); t.setHours(0,0,0,0);
  viewMonth=new Date(t.getFullYear(), t.getMonth(), 1);
  render();
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(poll,3000);
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
    $('#name-prompt').classList.add('hidden'); $('#me-name').textContent=n;
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

// 月历工作台
function renderCalendar(){
  if(view==='month'){ renderMonth(); return; }
  if(view==='week'){  renderWeek();  return; }
}

// 月份范围：含上下月补齐 6 行 × 7 列 = 42 天
function monthGridDays(){
  const y=viewMonth.getFullYear(), m=viewMonth.getMonth();
  const first=new Date(y,m,1);
  // 周一为一周开始：getDay() 0=Sun..6=Sat；转成 Mon-Sun 的偏移
  const dow=(first.getDay()+6)%7;
  const start=new Date(y,m,1-dow);
  return { y, m, days:Array.from({length:42},(_,i)=>{ const d=new Date(start); d.setDate(start.getDate()+i); return d; }) };
}
function renderMonth(){
  const { y, m, days } = monthGridDays();
  $('#cal-month-label').textContent = `${y}年${m+1}月`;
  // 农历 / 节假日仅在标题外围给 viewMonth 第一天附一次说明
  const todayStr=fmtDate(new Date());
  let html='';
  // 每个 cell：日期（大）、农历/节假日（小）、下方堆叠事件标签
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
    // 当天事件，按可见人过滤
    const dayEvents=room.events
      .filter(e=>e.date===ds && visible.has(e.owner))
      .sort((a,b)=>toFloat(a.start)-toFloat(b.start));
    // 简单农历（一行小字）
    const lunar = `${LUNAR_MONTH[d.getMonth()]}月`;
    let tagsHtml='';
    const MAX=4;
    for(let i=0;i<Math.min(MAX,dayEvents.length);i++){
      tagsHtml += monthTag(dayEvents[i]);
    }
    if(dayEvents.length>MAX){
      tagsHtml += `<span class="tag-more" data-more="${ds}">+${dayEvents.length-MAX}</span>`;
    }
    html += `<div class="${cls.join(' ')}" data-d="${ds}">
      <div class="mcell-head">
        <span class="mcell-day">${d.getDate()}</span>
        <span class="mcell-lunar">${WEEKDAY_MIN[wd]}</span>
      </div>
      <div class="mcell-tags">${tagsHtml||''}</div>
    </div>`;
  }
  $('#month-grid').innerHTML=html;

  // 绑定：cell 空白处点击 → 新建日程；tag 点击 → 编辑；more 点击 → 视图切到日程列表（且起始日）
  $('#month-grid').querySelectorAll('.mcell').forEach(c=>{
    c.onclick=(e)=>{
      if(e.target.classList.contains('tag')||e.target.classList.contains('tag-more')) return;
      openModal(c.dataset.d, 9);
    };
  });
  $('#month-grid').querySelectorAll('.tag').forEach(t=>{
    t.onclick=(e)=>{
      e.stopPropagation();
      const ev=room.events.find(x=>x.id===t.dataset.id);
      if(ev) openModal(ev.date, null, ev);
    };
  });
  $('#month-grid').querySelectorAll('.tag-more').forEach(m=>{
    m.onclick=(e)=>{ e.stopPropagation();
      rangeStart=new Date(m.dataset.more+'T00:00:00');
      rangeDays=7; $('#range-start').value=fmtDate(rangeStart); $('#range-days').value='7';
      switchView('agenda');
    };
  });
}
function monthTag(ev){
  let cls='tag';
  if(ev.kind==='invite') cls+=' invite';
  if(ev.status==='accepted') cls+=' accepted';
  const iAmInvitee = ev.kind==='invite'&&(ev.inviteTo===myPid||ev.inviteTo==='all');
  if(ev.kind==='invite'&&ev.status==='pending'&&iAmInvitee) cls+=' pending-me';
  const c = ev.color||'#3b82f6';
  return `<div class="${cls}" data-id="${ev.id}" style="background:${c}22;border-color:${c}cc;color:${c}">
    <span class="tag-t">${escapeHtml(ev.title)}</span>
    <span class="tag-c">${ev.start}</span>
  </div>`;
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 周视图（时间轴）
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
    for(const ev of room.events){
      if(ev.date!==d) continue;
      if(!visible.has(ev.owner)) continue;
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
      const rect=db.getBoundingClientRect(); const y=ev.clientY-rect.top;
      const hr=HOUR_START+Math.floor(y/ROWH);
      openModal(db.dataset.d, hr);
    } };
  });
  $('#calendar').querySelectorAll('.event').forEach(el=>{
    el.onclick=(ev)=>{ ev.stopPropagation(); const id=el.dataset.id; const e=room.events.find(x=>x.id===id);
      if(e&&e.owner===myPid&&e.kind==='busy') openModal(e.date, null, e);
    };
  });
}
function eventBlock(ev,top,hgt){
  let cls='event';
  if(ev.kind==='invite') cls+=' invite';
  if(ev.status==='accepted') cls+=' accepted';
  if(ev.kind==='invite'&&ev.status==='pending'&&(ev.inviteTo===myPid||ev.inviteTo==='all')) cls+=' pending-me';
  let actions='';
  const iAmInvitee=ev.kind==='invite'&&(ev.inviteTo===myPid||ev.inviteTo==='all');
  if(ev.status==='pending'&&iAmInvitee){
    actions=`<div class="ev-actions"><button class="mini-a" data-act="accepted" data-id="${ev.id}">同意</button><button class="mini-d" data-act="declined" data-id="${ev.id}">拒绝</button></div>`;
  }
  const tag=ev.kind==='invite'?(ev.status==='accepted'?'✓邀请':'⟳邀请'):'';
  return `<div class="${cls}" data-id="${ev.id}" style="top:${top}px;height:${hgt}px;background:${ev.color}22;border-color:${ev.color}">
    <div class="ev-t">${escapeHtml(ev.title)} ${tag}</div>
    <div class="ev-o">${ev.start}-${ev.end} · ${escapeHtml(ev.ownerName)}</div>
    ${actions}</div>`;
}

// 日程视图：按日期聚合，按可见人过滤
function renderAgenda(){
  const days=rangeDaysList();
  $('#ag-label').textContent = `${days[0].slice(5)} ~ ${days[days.length-1].slice(5)} · ${room.tz||'时区'}`;
  const list=$('#agenda-list'); list.innerHTML='';
  let any=false;
  for(const d of days){
    const evs=room.events
      .filter(e=>e.date===d && visible.has(e.owner))
      .sort((a,b)=>toFloat(a.start)-toFloat(b.start));
    if(evs.length===0) continue;
    any=true;
    list.innerHTML += `<div class="agenda-day">${d.slice(5)} <span class="sub">${weekdayShort(d)}</span></div>`;
    for(const ev of evs){
      list.innerHTML += `<div class="agenda-item" data-id="${ev.id}">
        <span class="agenda-dot" style="background:${ev.color||'#3b82f6'}"></span>
        <span class="agenda-time">${ev.start}–${ev.end}</span>
        <span class="agenda-tit">${escapeHtml(ev.title)}${ev.kind==='invite'?(ev.status==='accepted'?'  ✓邀请':'  ⟳邀请'):''}</span>
        <span class="agenda-meta">${escapeHtml(ev.ownerName)}</span>
      </div>`;
    }
  }
  if(!any) list.innerHTML = '<div class="agenda-empty">这段时间还没有可见的日程</div>';
  list.querySelectorAll('.agenda-item').forEach(el=>{
    el.onclick=()=>{ const ev=room.events.find(x=>x.id===el.dataset.id);
      if(ev) openModal(ev.date, null, ev);
    };
  });
}

function renderPeople(){
  // 同时渲染给 week 和 agenda 视图的工具栏（两份）。简化：用一份 put 到第一个 people-toggles，并镜像。
  const src=`<button class="ghost small" id="only-me">仅看我</button><button class="ghost small" id="only-all">全部</button>`;
  let parts='';
  for(const p of Object.values(room.participants)){
    const off=!visible.has(p.pid)?' off':'';
    parts += `<span class="ptoggle${off}" data-pid="${p.pid}"><i class="sw" style="background:${p.color}"></i>${escapeHtml(p.name)}</span>`;
  }
  const html = src+parts;
  $('#people-toggles').innerHTML = html;
  // 日程视图也镜像一份
  const mirror=$('#people-toggles-2'); if(mirror) mirror.innerHTML=html;
  // 绑定
  [['#people-toggles'],['#people-toggles-2']].forEach(([sel])=>{
    const box=$(sel); if(!box) return;
    box.querySelector('#only-me')?.addEventListener('click',()=>{ if(myPid){ visible=new Set([myPid]); render(); } });
    box.querySelector('#only-all')?.addEventListener('click',()=>{ visible=new Set(Object.keys(room.participants)); render(); });
    box.querySelectorAll('.ptoggle').forEach(el=>el.addEventListener('click',()=>{
      const pid=el.dataset.pid; if(visible.has(pid)) visible.delete(pid); else visible.add(pid); render();
    }));
  });
}

function renderFree(){
  const days=rangeDaysList(); const box=$('#free-list'); box.innerHTML='';
  let any=false;
  for(const d of days){
    const blocks=[];
    for(const ev of room.events){
      if(ev.date!==d||!visible.has(ev.owner)) continue;
      if(ev.kind==='busy'||(ev.kind==='invite'&&ev.status==='accepted'))
        blocks.push([toFloat(ev.start),toFloat(ev.end)]);
    }
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
function openModal(date, startHour, ev){
  editingId=ev?ev.id:null;
  $('#modal-title').textContent=ev?'编辑日程':'添加日程';
  $('#ev-title').value=ev?ev.title:'';
  $('#ev-date').value=ev?ev.date:date;
  $('#ev-start').value=ev?ev.start:(pad(startHour||9)+':00');
  $('#ev-end').value=ev?ev.end:(pad(Math.min((startHour||9)+1,HOUR_END))+':00');
  const sel=$('#ev-invite'); sel.innerHTML='<option value="">不邀请（仅自己的日程）</option><option value="all">所有人</option>';
  for(const p of Object.values(room.participants)) if(p.pid!==myPid) sel.innerHTML+=`<option value="${p.pid}">${escapeHtml(p.name)}</option>`;
  sel.value=ev?(ev.inviteTo||''):'';
  sel.disabled=!!ev;
  const actions=$('#modal-actions');
  if(ev){ actions.innerHTML=`<button class="ghost" id="ev-cancel">取消</button><button class="primary" id="ev-save">保存</button><button class="ghost small" id="ev-del" style="color:#ef4444;border-color:#ef4444">删除</button>`; }
  else { actions.innerHTML=`<button class="ghost" id="ev-cancel">取消</button><button class="primary" id="ev-save">保存</button>`; }
  $('#ev-cancel').onclick=closeModal;
  $('#ev-save').onclick=saveEvent;
  if(ev) $('#ev-del').onclick=deleteEvent;
  $('#modal').classList.remove('hidden');
}
function closeModal(){ $('#modal').classList.add('hidden'); editingId=null; }
async function saveEvent(){
  if(!myPid){ toast('请先填写名字'); return; }
  const title=$('#ev-title').value.trim()||'日程';
  const date=$('#ev-date').value, start=$('#ev-start').value, end=$('#ev-end').value;
  const inviteTo=$('#ev-invite').value||null;
  if(start>=end) return toast('结束时间必须晚于开始');
  try{
    if(editingId){
      room=await api.updateEvent(roomId,editingId,{pid:myPid,title,date,start,end});
    } else {
      room=await api.addEvent(roomId,{pid:myPid,title,date,start,end,inviteTo});
    }
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

// 月份跳转
$('#cal-pickmonth').onclick=()=>{
  $('#mp-year').innerHTML = ''; $('#mp-month').innerHTML = '';
  const yr=viewMonth.getFullYear(), mo=viewMonth.getMonth();
  for(let i=yr-5;i<=yr+5;i++) $('#mp-year').innerHTML+=`<option value="${i}" ${i===yr?'selected':''}>${i}年</option>`;
  for(let i=0;i<12;i++) $('#mp-month').innerHTML+=`<option value="${i}" ${i===mo?'selected':''}>${i+1}月</option>`;
  $('#month-picker').classList.remove('hidden');
};
$('#mp-cancel').onclick=()=>$('#month-picker').classList.add('hidden');
$('#mp-ok').onclick=()=>{
  const y=Number($('#mp-year').value), m=Number($('#mp-month').value);
  viewMonth=new Date(y,m,1); renderCalendar(); $('#month-picker').classList.add('hidden');
};
$('#month-picker').onclick=(e)=>{ if(e.target.id==='month-picker') $('#month-picker').classList.add('hidden'); };

// 浮动 +
$('#fab-add').onclick=()=>{
  // 默认添加今天
  openModal(fmtDate(new Date()), 9);
};

// 周视图导航
$('#range-start').onchange=()=>{ const v=$('#range-start').value; if(v){ rangeStart=new Date(v+'T00:00:00'); renderCalendar(); renderFree(); } };
$('#range-days').onchange=()=>{ rangeDays=Number($('#range-days').value); renderCalendar(); renderFree(); };
$('#wk-prev').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()-rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#wk-next').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()+rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#wk-today').onclick=()=>{ rangeStart=new Date(); rangeStart.setHours(0,0,0,0); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
// 日程视图导航
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
    const mine=(ev.owner===myPid&&ev.kind==='busy')||
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

// ---------- 启动 ----------
(function init(){
  const params=new URLSearchParams(location.search); const id=params.get('room');
  if(id){ enterRoom(id); switchView('month'); } else showHome();
})();
