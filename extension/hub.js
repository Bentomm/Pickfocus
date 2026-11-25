// PickFocus page (demo build). Sidebar (지금 / 기록 / 설정) · toolbar (PiP, 세션 끝내기) · one role per screen.
// All state lives in the background service worker; this page only asks and draws.
const $ = s => document.querySelector(s);
const ask = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const TITLES = { now: '지금', history: '기록', settings: '설정' };
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mins = ms => Math.max(0, Math.round(ms / 60e3));
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
let state = null, lockMode = 'lock', clearArmed = 0, pipWin = null;

// ---- navigation ----
function nav(v) {
  if (!TITLES[v]) return;
  for (const k of Object.keys(TITLES)) $(`#v-${k}`).hidden = k !== v;
  for (const b of document.querySelectorAll('.nav button')) { if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  $('#title').textContent = TITLES[v];
  if (v === 'history') drawHistory();
  if (v === 'now' && !state?.session) $('#purpose').focus();
}

// ---- draw everything from one info snapshot ----
function draw(s) {
  if (!s || s.error) return;
  state = s;
  const st = s.settings, on = !!s.session, t = Date.now(), cooling = s.coolUntil > t;
  const ai = !!st.apiKey || s.builtinKey;
  const engine = ai ? 'Gemini Decision 1' : '단어 일치 (AI 아님)';
  $('#side-engine').textContent = engine; $('#set-engine').textContent = engine;
  $('#side-ext').textContent = s.extension ? '유튜브 탭 연결됨' : '유튜브 탭 없음';
  $('#side-status').classList.toggle('off', !s.extension);
  $('#set-ext').textContent = s.extension ? '연결됨' : '유튜브를 열면 연결됩니다';
  $('#api-key').placeholder = st.apiKey ? `저장됨 (${st.apiKey})` : 'AI Studio에서 받은 키';
  for (const id of ['#key-set', '#key-help', '#keyword-area']) $(id).hidden = s.builtinKey;
  $('#key-note').hidden = ai || on;
  if (document.activeElement !== $('#keywords')) $('#keywords').value = st.keywords || '';
  $('#gray-default').checked = !!st.grayDefault;
  lockMode = on ? s.session.lock : st.lockMode;
  for (const b of document.querySelectorAll('.seg [role="radio"]')) { b.setAttribute('aria-checked', String(b.dataset.v === lockMode)); b.disabled = on; }
  $('#rule-locked').hidden = !on;
  drawRecent(st.recent || []);
  // session
  $('#app').classList.toggle('active', on); $('#app').classList.toggle('locked', on && cooling);
  $('#now-idle').hidden = on; $('#now-session').hidden = !on; $('#end-btn').hidden = !on;
  if (on) {
    $('#s-purpose').textContent = s.session.purpose;
    $('#s-since').textContent = `${hm(s.session.start)} 시작 · ${fmtMin(mins(t - s.session.start))}째`;
    $('#s-strikes').textContent = cooling ? '잠금 중' : `${s.strikes} / ${s.warnAt}`;
    $('#s-hidden').textContent = `${s.hidden}개`;
    $('#s-rule').textContent = s.session.lock === 'lock' ? '4번째에 15분 잠금' : '경고만';
    $('#gray-live').checked = !!s.session.gray;
    $('#lock-band').hidden = !cooling;
    $('#lock-band').textContent = cooling ? `유튜브 잠금 중 · ${Math.ceil((s.coolUntil - t) / 60e3)}분 남음` : '';
  }
  drawPip(s);
}
function drawRecent(list) {
  const ul = $('#recent'); ul.replaceChildren();
  for (const p of list.slice(0, 4)) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.textContent = p; b.onclick = () => start(p);
    li.append(b); ul.append(li);
  }
}
async function refresh() { draw(await ask('info').catch(() => null)); }

// ---- 지금 ----
async function start(purpose) {
  purpose = purpose.trim(); if (!purpose) return;
  $('#ended').hidden = true;
  draw(await ask('start', { purpose, gray: state?.settings.grayDefault, lock: lockMode }));
  nav('now');
}
async function end() {
  if (!state?.session) return;
  draw(await ask('end'));
  $('#purpose').value = ''; $('#start-btn').disabled = true; $('#ended').hidden = false;
  drawToday(); nav('now');
}
async function drawToday() {
  const h = await ask('history').catch(() => ({ items: [] }));
  const day = new Date().toDateString(), today = (h.items || []).filter(s => new Date(s.start).toDateString() === day);
  const m = today.reduce((a, s) => a + mins((s.end || Date.now()) - s.start), 0);
  $('#today-line').textContent = today.length ? `오늘 ${fmtMin(m)} 집중 · 세션 ${today.length}개` : '';
}

// ---- 기록 ----
async function drawHistory() {
  const h = await ask('history').catch(() => ({ items: [], current: null }));
  const items = (h.current ? [h.current] : []).concat(h.items || []);
  const now = Date.now(), dayMs = 864e5, len = s => mins((s.end || now) - s.start);
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const today0 = d0.getTime(), week0 = today0 - 6 * dayMs;
  const week = items.filter(s => s.start >= week0), today = items.filter(s => s.start >= today0);
  $('#h-today').textContent = fmtMin(today.reduce((a, s) => a + len(s), 0));
  $('#h-week').textContent = fmtMin(week.reduce((a, s) => a + len(s), 0));
  $('#h-strikes').textContent = `${week.reduce((a, s) => a + (s.strikes || 0), 0)}번`;
  $('#h-locks').textContent = `${week.reduce((a, s) => a + (s.locks || 0), 0)}번`;
  const days = [...Array(7)].map((_, i) => { const start = week0 + i * dayMs; return { start, m: items.filter(s => s.start >= start && s.start < start + dayMs).reduce((a, s) => a + len(s), 0) }; });
  const max = Math.max(30, ...days.map(d => d.m)), W = ['일', '월', '화', '수', '목', '금', '토'];
  $('#h-chart').replaceChildren(...days.map(d => {
    const col = document.createElement('div'); col.className = 'col' + (d.start === today0 ? ' today' : '');
    const val = document.createElement('span'); val.className = 'v'; val.textContent = d.m ? fmtMin(d.m) : '';
    const bar = document.createElement('i'); bar.style.height = `${Math.round(d.m / max * 100)}%`;
    const lab = document.createElement('span'); lab.className = 'd'; lab.textContent = W[new Date(d.start).getDay()];
    col.append(val, bar, lab); return col;
  }));
  const rows = items.slice(0, 50).map(s => {
    const tr = document.createElement('tr'), d = new Date(s.start);
    for (const c of [`${d.getMonth() + 1}/${d.getDate()} ${hm(s.start)}${s.end ? '' : ' · 진행 중'}`, s.purpose, fmtMin(len(s)), `${s.strikes || 0}`, `${s.locks || 0}`, `${s.hidden || 0}`]) {
      const td = document.createElement('td'); td.textContent = c; tr.append(td);
    }
    return tr;
  });
  $('#h-rows').replaceChildren(...rows);
  $('#h-empty').hidden = rows.length > 0; $('.sessions').hidden = !rows.length;
}

// ---- PiP: Chrome's Document Picture-in-Picture window with the flower. Each strike drops a petal. ----
const L = window.PIP_LAYERS;
const ORDER = [2, 3, 1, 4, 0]; // lower petals fall first, the top one last
let pipPetals = [], pipLeft = 5;
async function openPip() {
  if (pipWin && !pipWin.closed) { pipWin.close(); return; }
  if (!('documentPictureInPicture' in window)) { alert?.('이 Chrome 버전은 PiP 창을 지원하지 않습니다.'); return; }
  pipWin = await documentPictureInPicture.requestWindow({ width: 168, height: 232 });
  const doc = pipWin.document;
  doc.title = 'PickFocus';
  const css = doc.createElement('link'); css.rel = 'stylesheet'; css.href = chrome.runtime.getURL('pip.css'); doc.head.append(css);
  doc.body.className = 'docpip';
  const stage = doc.createElement('div'); stage.className = 'stage'; stage.id = 'stage';
  pipPetals = []; pipLeft = 5;
  if (L) {
    const layers = doc.createElement('div'); layers.className = 'layers'; const [w, h] = L.size || [512, 578];
    const add = (file, anchor) => { const img = doc.createElement('img'); img.src = chrome.runtime.getURL('assets/pip/' + file); img.alt = ''; if (anchor) img.style.transformOrigin = `${anchor[0] / w * 100}% ${anchor[1] / h * 100}%`; layers.append(img); return img; };
    pipPetals = L.petals.map((p, i) => { const img = add(p.file, p.anchor), side = i % 2 ? -1 : 1; img.style.setProperty('--dx', `${side * (4 + i * 2)}px`); img.style.setProperty('--rot', `${side * (30 + i * 6)}deg`); return img; });
    add(L.center); stage.append(layers);
  } else {
    stage.innerHTML = `<svg class="flower-svg" viewBox="-36 -36 504 569"><path class="fill" d="${window.FLOWER.outer}"/><path class="outline" fill-rule="evenodd" d="${window.FLOWER.outline}"/></svg>`;
  }
  const count = doc.createElement('p'); count.className = 'count'; count.id = 'count'; stage.append(count);
  doc.body.append(stage);
  stage.addEventListener('click', () => window.focus());
  pipWin.addEventListener('pagehide', () => { pipWin = null; $('#pip-btn').setAttribute('aria-pressed', 'false'); });
  $('#pip-btn').setAttribute('aria-pressed', 'true');
  if (state) drawPip(state);
}
function drawPip(s) {
  if (!pipWin || pipWin.closed) return;
  const doc = pipWin.document, t = Date.now(), cooling = s.coolUntil > t;
  doc.documentElement.classList.toggle('lock', cooling);
  const n = cooling ? 0 : Math.max(0, 5 - (s.session ? s.strikes : 0));
  if (pipPetals.length) {
    ORDER.forEach((idx, k) => {
      const img = pipPetals[idx];
      if (k >= 5 - n) { img.classList.remove('gone', 'fall'); return; }
      if (k < 5 - pipLeft) { img.classList.add('gone'); return; }
      img.classList.add('fall'); img.addEventListener('animationend', () => img.classList.add('gone'), { once: true });
    });
    pipLeft = n;
  }
  doc.getElementById('count').textContent = cooling ? `잠금 ${Math.ceil((s.coolUntil - t) / 60e3)}분` : (!L && s.session && s.strikes) ? `${s.strikes}/${s.warnAt}` : '';
  doc.getElementById('stage').title = s.session ? `목적: ${s.session.purpose}` : '목적이 없습니다';
}

// ---- events ----
for (const b of document.querySelectorAll('.nav button')) b.addEventListener('click', () => nav(b.dataset.view));
$('#side-status').addEventListener('click', () => { nav('settings'); $('#g-connect').scrollIntoView({ block: 'start' }); });
$('#purpose').addEventListener('input', () => { $('#start-btn').disabled = !$('#purpose').value.trim(); });
$('#purpose-form').addEventListener('submit', e => { e.preventDefault(); start($('#purpose').value); });
$('#pip-btn').addEventListener('click', openPip);
$('#end-btn').addEventListener('click', end);
$('#gray-live').addEventListener('change', async () => draw(await ask('gray', { on: $('#gray-live').checked })));
$('#gray-default').addEventListener('change', async () => draw(await ask('settings', { value: { grayDefault: $('#gray-default').checked } })));
$('#keywords').addEventListener('change', async () => draw(await ask('settings', { value: { keywords: $('#keywords').value } })));
for (const b of document.querySelectorAll('.seg [role="radio"]')) b.addEventListener('click', async () => { if (!state?.session) draw(await ask('settings', { value: { lockMode: b.dataset.v } })); });
$('#key-save').addEventListener('click', async () => { const v = $('#api-key').value.trim(); draw(await ask('settings', { value: { apiKey: v } })); $('#api-key').value = ''; $('#key-save').textContent = v ? '저장됨' : '지움'; });
$('#key-go').addEventListener('click', () => { nav('settings'); $('#g-judge').scrollIntoView({ block: 'start' }); $('#api-key').focus(); });
$('#clear-btn').addEventListener('click', async () => {
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); $('#clear-btn').textContent = '한 번 더 누르면 지웁니다'; return; }
  await ask('clear-history'); clearArmed = 0; $('#clear-btn').textContent = '지웠습니다'; drawToday();
});
const showDemo = on => { $('#demo').hidden = !on; if (on) $('#demo-ok').focus(); };
$('#demo-open').addEventListener('click', () => showDemo(true));
$('#demo-ok').addEventListener('click', async () => { showDemo(false); await ask('settings', { value: { seenDemo: true } }); });
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape' && !$('#demo').hidden) $('#demo-ok').click();
  if (!mod) return;
  if (e.key === '1') { e.preventDefault(); nav('now'); }
  if (e.key === '2') { e.preventDefault(); nav('history'); }
  if (e.key === ',') { e.preventDefault(); nav('settings'); }
  if (e.key === '.') { e.preventDefault(); end(); }
});
chrome.storage.onChanged.addListener(() => refresh());
setInterval(refresh, 15000); // minutes left and elapsed time only change per minute

(async () => {
  $('#set-version').textContent = chrome.runtime.getManifest().version + ' (데모)';
  await refresh(); drawToday();
  if (!state?.settings.seenDemo) showDemo(true); else if (!state?.session) $('#purpose').focus();
})();
