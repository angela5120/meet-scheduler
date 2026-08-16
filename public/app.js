const $ = (s) => document.querySelector(s);
const api = async (method, url, body) => {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error((await r.json()).error || '请求失败');
  return r.json();
};
const HOUR_START = 7, HOUR_END = 23, ROWH = 46;
const WEEKDAY = ['周日','周一','周二','周三','周四','周五','周六'];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtHM = (h) => `${pad(Math.floor(h))}:${pad(Math.round((h%1)*60))}`;
const toFloat = (hm) => { const [h,m] = hm.split(':').map(Number); return h + m/60; };
const weekdayShort = (d) => WEEKDAY[new Date(d+'T00:00:00').getDay()];
const toast = (m) => { const t=$('#toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add('hidden'),2200); };

let roomId=null, room=null, myPid=null, pollTimer=null;
let rangeStart=new Date();   // 日历起始日期
let rangeDays=7;             // 显示天数(7/14/30)
let visible=new Set();       // 显示的人员 pid
let editingId=null;

// ---------- 首页 ----------
function showHome(){ $('#home').classList.remove('hidden'); $('#room').classList.add('hidden'); }
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  $('#tab-create').classList.toggle('hidden', b.dataset.tab!=='create');
  $('#tab-join').classList.toggle('hidden', b.dataset.tab!=='join');
});
$('#btn-create').onclick=async()=>{ const t=$('#create-title').value.trim()||'我们的日历';
  try{ const {id}=await api('POST','/api/rooms',{title:t}); location.href=location.pathname+'?room='+id; }catch(e){toast(e.message);} };
$('#btn-join').onclick=()=>{ const id=$('#join-id').value.trim().toUpperCase(); if(!id) return toast('请输入房间号'); location.href=location.pathname+'?room='+id; };

// ---------- 进入房间 ----------
async function enterRoom(id){
  roomId=id;
  try{ const {room:r}=await api('GET','/api/rooms/'+id); room=r; }
  catch(e){ toast('房间不存在'); showHome(); return; }
  $('#home').classList.add('hidden'); $('#room').classList.remove('hidden');
  $('#room-title').textContent=room.title;
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
  render();
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(poll,3000);
}
async function poll(){ if(!roomId) return;
  try{ const {room:r}=await api('GET','/api/rooms/'+roomId); room=r;
    if(myPid&&room.participants[myPid]) $('#me-name').textContent=room.participants[myPid].name;
    if(visible.size===0) visible=new Set(Object.keys(room.participants));
    render();
  }catch(e){} }

$('#btn-copy').onclick=()=>{ navigator.clipboard.writeText($('#share-link').value).then(()=>toast('链接已复制，去发给朋友吧')).catch(()=>toast('复制失败，请手动选择')); };
$('#btn-leave').onclick=()=>{ localStorage.removeItem('ms_pid_'+roomId); location.reload(); };
$('#btn-setname').onclick=async()=>{ const n=$('#name-input').value.trim(); if(!n) return toast('请输入名字');
  try{ const {pid}=await api('POST',`/api/rooms/${roomId}/participants`,{name:n}); myPid=pid; localStorage.setItem('ms_pid_'+roomId,pid);
    $('#name-prompt').classList.add('hidden'); $('#me-name').textContent=n; visible=new Set(Object.keys(room.participants)); await poll();
  }catch(e){toast(e.message);} };

// ---------- 日期范围 ----------
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
  sel.onchange=async()=>{ try{ await api('PUT',`/api/rooms/${roomId}`,{tz:sel.value}); room.tz=sel.value; toast('时区已更新'); }catch(e){toast(e.message);} };
}

// ---------- 渲染日历 ----------
function render(){
  renderPeople();
  renderCalendar();
  renderFree();
  renderInvites();
}
function renderPeople(){
  // 快捷：仅我 / 全部
  const box=$('#people-toggles');
  let html=`<button class="ghost small" id="only-me">仅看我</button><button class="ghost small" id="only-all">全部</button>`;
  for(const p of Object.values(room.participants)){
    const off=!visible.has(p.pid)?' off':'';
    html+=`<span class="ptoggle${off}" data-pid="${p.pid}"><i class="sw" style="background:${p.color}"></i>${p.name}</span>`;
  }
  box.innerHTML=html;
  $('#only-me').onclick=()=>{ if(myPid){ visible=new Set([myPid]); render(); } };
  $('#only-all').onclick=()=>{ visible=new Set(Object.keys(room.participants)); render(); };
  box.querySelectorAll('.ptoggle').forEach(el=>el.onclick=()=>{ const pid=el.dataset.pid;
    if(visible.has(pid)) visible.delete(pid); else visible.add(pid); render(); });
}
function renderCalendar(){
  const days=rangeDaysList();
  $('#week-label').textContent=`${days[0].slice(5)} ~ ${days[days.length-1].slice(5)} · 共${days.length}天 · ${room.tz||'时区'}`;
  // 时间轴
  let axis=`<div class="time-axis"><div class="ta-head"></div>`;
  for(let h=HOUR_START;h<HOUR_END;h++) axis+=`<div class="ta-hour">${pad(h)}:00</div>`;
  axis+=`</div>`;
  // 各天列
  let cols='';
  const todayStr=fmtDate(new Date());
  for(const d of days){
    const isToday=d===todayStr?' today':'';
    cols+=`<div class="day-col"><div class="day-head${isToday}"><span class="dh-d">${d.slice(5)}</span><span class="dh-w">${weekdayShort(d)}</span></div><div class="day-body" data-d="${d}">`;
    for(let h=HOUR_START;h<HOUR_END;h++) cols+=`<div class="hour-line${h%1? '':''}"></div>`;
    // 事件
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
  // 点击空白添加
  $('#calendar').querySelectorAll('.day-body').forEach(db=>{
    db.onclick=(ev)=>{ if(ev.target.classList.contains('day-body')||ev.target.classList.contains('hour-line')){
      const rect=db.getBoundingClientRect(); const y=ev.clientY-rect.top;
      const hr=HOUR_START+Math.floor(y/ROWH);
      openModal(db.dataset.d, hr);
    } };
  });
  $('#calendar').querySelectorAll('.event').forEach(el=>{
    el.onclick=(ev)=>{ ev.stopPropagation(); const id=el.dataset.id; const e=room.events.find(x=>x.id===id);
      if(e.owner===myPid && e.kind==='busy') openModal(e.date, null, e);
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
    <div class="ev-t">${ev.title} ${tag}</div>
    <div class="ev-o">${ev.start}-${ev.end} · ${ev.ownerName}</div>
    ${actions}</div>`;
}

// ---------- 空闲时段 ----------
function renderFree(){
  const days=rangeDaysList(); const box=$('#free-list'); box.innerHTML='';
  let any=false;
  for(const d of days){
    // 收集可见人员的"占用"区间
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
    const visibleCount=visible.size;
    if(free.length===0){ box.innerHTML+=`<div class="free-chip">${d.slice(5)} ${weekdayShort(d)}：无共同空闲</div>`; continue; }
    for(const [s,e] of free){ if(e-s<0.5) continue; any=true;
      box.innerHTML+=`<div class="free-chip">${d.slice(5)} ${weekdayShort(d)}：${fmtHM(s)}–${fmtHM(e)} 空闲</div>`; }
  }
  if(!any && box.innerHTML==='') box.innerHTML='<span class="af-empty">还没有日程，添加后这里会显示共同空闲时段。</span>';
}

// ---------- 邀请面板 ----------
function renderInvites(){
  const box=$('#invites'); box.innerHTML='';
  const received=room.events.filter(e=>e.kind==='invite'&&e.status==='pending'&&(e.inviteTo===myPid||e.inviteTo==='all'));
  const sent=room.events.filter(e=>e.kind==='invite'&&e.status==='pending'&&e.owner===myPid);
  if(received.length===0&&sent.length===0){ box.innerHTML='<span class="af-empty">暂无邀请。在日历上点空白处添加日程，选择「作为邀请发给」即可发起。</span>'; return; }
  for(const e of received){
    box.innerHTML+=`<div class="inv"><div class="inv-time">${e.date.slice(5)} ${weekdayShort(e.date)} ${e.start}-${e.end}</div>
      <div class="inv-meta">${e.ownerName} 邀请你：「${e.title}」${e.note?' · '+e.note:''}</div>
      <div class="inv-actions"><button class="primary small" data-act="accepted" data-id="${e.id}">同意</button><button class="ghost small" data-act="declined" data-id="${e.id}">拒绝</button></div></div>`;
  }
  for(const e of sent){
    const who=e.inviteTo==='all'?'所有人':(room.participants[e.inviteTo]?.name||'对方');
    box.innerHTML+=`<div class="inv"><div class="inv-time">${e.date.slice(5)} ${weekdayShort(e.date)} ${e.start}-${e.end}</div>
      <div class="inv-meta">你邀请 ${who}：「${e.title}」 · 等待回应…</div></div>`;
  }
  box.querySelectorAll('button[data-act]').forEach(b=>b.onclick=async()=>{
    try{ await api('PUT',`/api/rooms/${roomId}/events/${b.dataset.id}/respond`,{pid:myPid,status:b.dataset.act}); toast(b.dataset.act==='accepted'?'已同意 ✅':'已拒绝'); await poll(); }
    catch(err){toast(err.message);} });
}

// ---------- 弹窗：添加/编辑 ----------
function openModal(date, startHour, ev){
  editingId=ev?ev.id:null;
  $('#modal-title').textContent=ev?'编辑日程':'添加日程';
  $('#ev-title').value=ev?ev.title:'';
  $('#ev-date').value=ev?ev.date:date;
  $('#ev-start').value=ev?ev.start:(pad(startHour)+':00');
  $('#ev-end').value=ev?ev.end:(pad(Math.min(startHour+1,HOUR_END))+':00');
  // 邀请对象下拉
  const sel=$('#ev-invite'); sel.innerHTML='<option value="">不邀请（仅自己的日程）</option><option value="all">所有人</option>';
  for(const p of Object.values(room.participants)) if(p.pid!==myPid) sel.innerHTML+=`<option value="${p.pid}">${p.name}</option>`;
  sel.value=ev?(ev.inviteTo||''):'';
  $('#ev-invite').disabled=!!ev; // 编辑时不改邀请属性
  let actions=$('#modal-actions');
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
    if(editingId) await api('PUT',`/api/rooms/${roomId}/events/${editingId}`,{pid:myPid,title,date,start,end});
    else await api('POST',`/api/rooms/${roomId}/events`,{pid:myPid,title,date,start,end,inviteTo});
    closeModal(); await poll(); toast('已保存');
  }catch(e){toast(e.message);}
}
async function deleteEvent(){
  try{ await api('DELETE',`/api/rooms/${roomId}/events/${editingId}`,{pid:myPid}); closeModal(); await poll(); toast('已删除'); }
  catch(e){toast(e.message);}
}
$('#range-start').onchange=()=>{ const v=$('#range-start').value; if(v){ rangeStart=new Date(v+'T00:00:00'); renderCalendar(); renderFree(); } };
$('#range-days').onchange=()=>{ rangeDays=Number($('#range-days').value); renderCalendar(); renderFree(); };
$('#wk-prev').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()-rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#wk-next').onclick=()=>{ rangeStart.setDate(rangeStart.getDate()+rangeDays); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
$('#wk-today').onclick=()=>{ rangeStart=new Date(); rangeStart.setHours(0,0,0,0); $('#range-start').value=fmtDate(rangeStart); renderCalendar(); renderFree(); };
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

// ---------- 启动 ----------
(function init(){
  const params=new URLSearchParams(location.search); const id=params.get('room');
  if(id) enterRoom(id.toUpperCase()); else showHome();
})();
