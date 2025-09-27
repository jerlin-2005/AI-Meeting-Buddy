/* ====== Helper utilities ====== */

// Parse "HH:MM" to minutes
function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
function minToHm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
// Convert a local slot "HH:MM-HH:MM" at timezone offset to UTC minutes interval [start,end)
function slotToUTCInterval(slot, tzOffset) {
  const [a,b] = slot.split('-');
  const startLocal = hmToMin(a);
  const endLocal = hmToMin(b);
  // timezone_offset in hours (can be decimal)
  const utcStart = startLocal - tzOffset * 60;
  const utcEnd   = endLocal - tzOffset * 60;
  return [utcStart, utcEnd];
}
// find overlapping intervals (in minutes) across arrays of intervals
function findOverlaps(intervalsList, durationMin) {
  // Convert to minute-precision timeline
  // We'll check candidate start times at 15-min steps between minStart and maxEnd
  let minStart = Infinity, maxEnd = -Infinity;
  intervalsList.forEach(list => {
    list.forEach(i => { minStart = Math.min(minStart, i[0]); maxEnd = Math.max(maxEnd, i[1]); });
  });
  const results = [];
  for (let t = Math.floor(minStart/15)*15; t + durationMin <= Math.ceil(maxEnd/15)*15; t += 15) {
    const end = t + durationMin;
    const ok = intervalsList.every(list => list.some(([s,e]) => s <= t && end <= e));
    if (ok) results.push([t,end]);
    if (results.length >= 6) break; // limit results for demo
  }
  return results;
}
// Load CSV into array of objects (simple)
function csvToArray(text) {
  const lines = text.trim().split('\n').map(l=>l.trim()).filter(l=>l);
  if (lines.length===0) return [];
  const header = lines[0].split(',').map(h=>h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c=>c.trim());
    const obj = {};
    header.forEach((h,i)=> obj[h]=cols[i]||'');
    return obj;
  });
}
// Simple tokenizer and bag-of-words
function tokenize(s) {
  return s.toLowerCase().replace(/[^\w\s]/g,'').split(/\s+/).filter(Boolean);
}
function bagOfWords(tokens) {
  const b = {};
  tokens.forEach(t=>b[t]=(b[t]||0)+1);
  return b;
}
function cosineSimBag(a,b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let num = 0, na=0, nb=0;
  keys.forEach(k=>{
    const va = a[k]||0, vb=b[k]||0;
    num += va*vb;
    na += va*va; nb += vb*vb;
  });
  if (na===0 || nb===0) return 0;
  return num / (Math.sqrt(na)*Math.sqrt(nb));
}
/* ====== App state & initialization ====== */
const state = {
  participants: [],
  agendaItems: [],
  reminders: [],
  faq: [],
  sales: []
};
// load mock data
async function loadMockData() {
  const cal = await fetch('mock-data/calendar.json').then(r=>r.json());
  state.participants = cal.participants || [];
  const past = await fetch('mock-data/past_meetings.json').then(r=>r.json());
  state.agendaItems = past || [];
  const salesText = await fetch('mock-data/sales.csv').then(r=>r.text());
  state.sales = csvToArray(salesText);
  const remText = await fetch('mock-data/reminders.csv').then(r=>r.text());
  state.reminders = csvToArray(remText);
  // small FAQ
  state.faq = [
    {q:"what is today's agenda", a:"Agenda includes sales updates, product improvements and distributor feedback."},
    {q:"what are my reminders", a:"Your reminders include marketing materials and license follow-ups."},
    {q:"who attended the last meeting", a:"Zoho Chennai team and the Germany distributor attended last meeting."},
    {q:"how to schedule", a:"Use the Compute Best Slots button to suggest overlapping times across time zones."},
  ];
  renderReminders();
  renderProgress();
}
loadMockData();
/* ====== Scheduling logic ====== */
document.getElementById('compute-slot').addEventListener('click', async ()=>{
  const duration = Number(document.getElementById('duration').value);
  // convert each participant's free slots to UTC intervals
  const intervalsList = state.participants.map(p => {
    const tz = p.timezone_offset;
    return p.free_slots.map(slot => slotToUTCInterval(slot, tz));
  });
  const overlapsUtc = findOverlaps(intervalsList, duration);
  const resultsDiv = document.getElementById('slot-results');
  resultsDiv.innerHTML = '';
  if (overlapsUtc.length===0) {
    resultsDiv.innerHTML = `<div class="notice">No common slot found for ${duration} minutes. Try different duration or ask participants to share more availability.</div>`;
    return;
  }
  overlapsUtc.forEach(([s,e], idx)=> {
    // for display, show each participant local times for that UTC slot
    const slotElem = document.createElement('div');
    slotElem.className = 'slot';
    const utcStartMin = s, utcEndMin = e;
    let html = `<strong>Option ${idx+1} — UTC ${minToHm((utcStartMin%1440+1440)%1440)} - ${minToHm((utcEndMin%1440+1440)%1440)}</strong><br/>`;
    state.participants.forEach(p=>{
      const tz = p.timezone_offset;
      const localStart = utcStartMin + tz*60;
      const localEnd = utcEndMin + tz*60;
      html += `${p.name} (UTC${tz>=0?'+':''}${tz}): ${minToHm(((localStart%1440)+1440)%1440)} - ${minToHm(((localEnd%1440)+1440)%1440)}<br/>`;
    });
    slotElem.innerHTML = html;
    const pickBtn = document.createElement('button');
    pickBtn.textContent = 'Pick this slot';
    pickBtn.style.marginTop = '8px';
    pickBtn.addEventListener('click', ()=>confirmSlot(utcStartMin, utcEndMin));
    slotElem.appendChild(pickBtn);
    resultsDiv.appendChild(slotElem);
  });
});
// Confirm selected slot -> schedule and create a reminder
function confirmSlot(utcStart, utcEnd) {
  const duration = Math.round((utcEnd-utcStart)/60);
  const chosenUTC = {utcStart, utcEnd, duration};
  // store chosen slot in localStorage
  localStorage.setItem('chosenSlot', JSON.stringify(chosenUTC));
  // add a reminder automatically for "Pre-meeting prep" one day before
  const now = new Date();
  const slotDate = new Date(); // Create a date for display by using UTC minutes relative to today for demo
  slotDate.setUTCMinutes(utcStart);
  const reminderDateObj = new Date(slotDate.getTime() - 24*60*60*1000);
  const iso = reminderDateObj.toISOString().slice(0,10);
  state.reminders.push({Date: iso, Reminder:'Pre-meeting prep', FollowUp:'Prepare agenda & slides'});
  renderReminders();
  renderProgress();
  // display agenda automatically
  generateAgenda(true);
  alert('Slot confirmed and pre-meeting reminder added (demo). You can view reminders below.');
}
/* ====== Agenda generation (basic "AI") ====== */
function generateAgenda(fromSchedule=false) {
  // Build agenda by summarizing past meetings and sales highlights
  const agendaPanel = document.getElementById('agenda-panel');
  const items = [];
  // take last two past meetings
  state.agendaItems.slice(-2).forEach(m=>{
    items.push({title: m.topic, detail: m.outcome + (m.notes? ' — ' + m.notes : '')});
  });
  // sales top customers: simple aggregation
  const salesByProduct = {};
  state.sales.forEach(s=> {
    const prod = s.Product;
    if (!salesByProduct[prod]) salesByProduct[prod]=0;
    salesByProduct[prod]+= Number(s.Licenses) || 0;
  });
  const top = Object.entries(salesByProduct).sort((a,b)=>b[1]-a[1]).slice(0,2);
  if (top.length) {
    items.push({title:'Sales snapshot', detail: top.map(t=>`${t[0]}: ${t[1]} licenses`).join('; ')});
  }
  // If scheduled just now, add a "Goals" entry
  if (fromSchedule) items.unshift({title:'Meeting Goal', detail:'Align on promotions, shipping issues, and action items with distributor.'});
  // render
  agendaPanel.innerHTML = '<ul>' + items.map(it=>`<li><strong>${it.title}:</strong> ${it.detail}</li>`).join('') + '</ul>';
  // store for chatbot knowledge
  localStorage.setItem('generatedAgenda', JSON.stringify(items));
}
/* ====== Reminders UI & storage ====== */
function renderReminders() {
  const panel = document.getElementById('reminders-panel');
  if (!state.reminders || state.reminders.length===0) {
    panel.innerHTML = '<em>No reminders.</em>';
    return;
  }
  const ul = document.createElement('ul');
  state.reminders.forEach((r, idx)=>{
    const li = document.createElement('li');
    li.innerHTML = `<strong>${r.Date}</strong> — ${r.Reminder} <em>(${r.FollowUp||''})</em>`;
    const doneBtn = document.createElement('button');
    doneBtn.textContent = 'Mark done';
    doneBtn.style.marginLeft='10px';
    doneBtn.addEventListener('click', ()=>{
      state.reminders.splice(idx,1);
      renderReminders();
      renderProgress();
    });
    li.appendChild(doneBtn);
    ul.appendChild(li);
  });
  panel.innerHTML = '';
  panel.appendChild(ul);
}
document.getElementById('add-reminder').addEventListener('click', ()=>{
  const text = document.getElementById('new-reminder-text').value.trim();
  const date = document.getElementById('new-reminder-date').value;
  if (!text || !date) { alert('Enter text and date'); return; }
  state.reminders.push({Date:date, Reminder:text, FollowUp:''});
  document.getElementById('new-reminder-text').value='';
  document.getElementById('new-reminder-date').value='';
  renderReminders();
  renderProgress();
  scheduleNotifFor(date, text);
});
/* ====== Simple notification scheduling (demo) ====== */
function scheduleNotifFor(dateStr, text) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") {
    Notification.requestPermission();
  }
  // For demo, if the date is today or within next 2 days, set a timeout to fire a notification in a few seconds
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = (d - now) / (24*3600*1000);
  if (diffDays <= 2) {
    setTimeout(()=> {
      if (Notification.permission === "granted") {
        new Notification("AI Meeting Buddy: Reminder", {body: text});
      } else {
        alert('Reminder: ' + text);
      }
    }, 3000); // 3 seconds for demo
  }
}
/* ====== Progress / Trust score ====== */
function renderProgress() {
  const panel = document.getElementById('progress-panel');
  const totalReminders = state.reminders.length;
  const completed = (localStorage.getItem('completedCount')|0);
  // trust score: simple metric: more completed follow-ups increases trust
  const trust = Math.min(100, completed * 10 + 40); // baseline 40
  panel.innerHTML = `<p>Open follow-ups: <strong>${totalReminders}</strong></p>
    <p>Completed actions: <strong>${completed}</strong></p>
    <p>Trust score: <span class="badge">${trust}%</span></p>`;
}
/* ====== Chatbot (semantic-like search) ====== */
function botReplyForText(query) {
  // Build knowledge base: FAQ + generated agenda + reminders
  const kb = [];
  // load faq
  const faq = state.faq || [];
  faq.forEach(f=> kb.push({q:f.q, a:f.a}));
  // generated agenda
  const agenda = JSON.parse(localStorage.getItem('generatedAgenda')||'[]');
  agenda.forEach(a => kb.push({q:a.title + ' ' + a.detail, a: `${a.title}: ${a.detail}`}));
  // reminders -> include as KB
  state.reminders.forEach(r => kb.push({q: `${r.Date} ${r.Reminder}`, a:`Reminder on ${r.Date}: ${r.Reminder}. Follow-up: ${r.FollowUp||'None'}`}));
  // now do similarity
  const qBag = bagOfWords(tokenize(query));
  let best = {score:0, answer:"Sorry, I don't have an exact answer. You can ask about agenda, reminders, or scheduling."};
  kb.forEach(item => {
    const itemBag = bagOfWords(tokenize(item.q));
    const score = cosineSimBag(qBag, itemBag);
    if (score > best.score) { best = {score, answer: item.a}; }
  });
  // if best score very low, fallback to canned response
  if (best.score < 0.08) {
    // try short rules
    const q = query.toLowerCase();
    if (q.includes('schedule') || q.includes('slot')) {
      return "Use 'Compute Best Slots' to find overlapping times. If you need a custom time, pick a date and add availability.";
    }
    if (q.includes('agenda') || q.includes('topic')) return "Agenda is shown in Step 2 — it includes recent product updates, sales snapshot, and goals for the meeting.";
    return best.answer;
  }
  return best.answer;
}
document.getElementById('chat-send').addEventListener('click', ()=>{
  const inputEl = document.getElementById('chat-input');
  const chatBox = document.getElementById('chat-box');
  const text = inputEl.value.trim();
  if (!text) return;
  const userMsg = document.createElement('div'); userMsg.className='msg user'; userMsg.textContent = text;
  chatBox.appendChild(userMsg);
  chatBox.scrollTop = chatBox.scrollHeight;
  inputEl.value='';
  // bot reply (simulate thinking)
  setTimeout(()=>{
    const reply = botReplyForText(text);
    const botMsg = document.createElement('div'); botMsg.className='msg bot'; botMsg.textContent = reply;
    chatBox.appendChild(botMsg);
    chatBox.scrollTop = chatBox.scrollHeight;
  }, 400);
});
/* ====== On load: prepare simple UI hints ====== */
window.addEventListener('load', ()=>{
  // Pre-generate agenda from existing data
  generateAgenda(false);
  renderReminders();
  renderProgress();
});