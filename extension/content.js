// PickFocus browser extension content script (GENERATED from webview/inject.cjs by tools/build-extension.py; do not edit).
// The purpose is entered in the PickFocus hub app, not here.
// PickFocus controls the user, not YouTube: on every surface (search, home, subscriptions,
// watch-next, channel pages) only items whose titles fit the declared purpose stay visible,
// and a video that does not fit the purpose does not play.
// Only the search query and visible titles are read. No watch history, descriptions or behavior are collected.

// Top-level item cards on any YouTube surface.
const cards = [
  'ytd-video-renderer', 'ytd-rich-item-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer',
  'ytd-playlist-renderer', 'ytd-compact-playlist-renderer', 'ytd-compact-radio-renderer', 'ytd-radio-renderer',
  'ytd-channel-renderer', 'ytd-grid-channel-renderer', 'yt-lockup-view-model',
  'ytm-shorts-lockup-view-model-v2', 'ytm-shorts-lockup-view-model', 'ytd-reel-item-renderer'
].join(',');
const shelves = 'grid-shelf-view-model,ytd-reel-shelf-renderer,ytd-rich-shelf-renderer';
const css = `
html.pf-active :is(${cards}):not([data-pf-state="allow"]):not(:is(${cards})[data-pf-state="allow"] *){display:none!important}
html.pf-active.pf-reveal :is(${cards})[data-pf-state]:not([data-pf-state="allow"]):not([data-pf-state="pending"]){display:block!important;opacity:.38;outline:1px dashed #8a8a86;outline-offset:4px}
html.pf-gated ytd-search{display:none!important}
html.pf-nopurpose ytd-app{visibility:hidden!important}
html.pf-gray{filter:grayscale(1)}
/* A Shorts shelf stays only if at least one of its items fits the purpose. */
html.pf-active:not(.pf-reveal) :is(${shelves}):not(:has([data-pf-state="allow"])){display:none!important}
html.pf-active [data-pf-hide]{display:none!important}
html.pf-watch-blocked:not(.pf-reveal) ytd-watch-flexy #primary-inner{visibility:hidden!important}
/* Sources of temptation that are not single items: Shorts, navigation drawers, end screens. */
html.pf-active ytd-mini-guide-renderer, html.pf-active tp-yt-app-drawer, html.pf-active ytd-guide-renderer,
html.pf-active #guide-button, html.pf-active ytd-pivot-bar-renderer,
html.pf-active .ytp-endscreen-content, html.pf-active .ytp-ce-element,
html.pf-active .ytp-autonav-endscreen-countdown-overlay, html.pf-active ytd-feed-filter-chip-bar-renderer,
html.pf-active ytd-inline-survey-renderer, html.pf-active ytd-single-option-survey-renderer{display:none!important}
/* Cooldown after repeated off-purpose videos: YouTube is unusable until it ends. */
html.pf-cool ytd-app{visibility:hidden!important}
`;

let config = { enabled: false, purpose: '', engine: 'local', keywords: [] };
let revision = 0, route = '', gate = '', gateRun = 0, queued = 0, navigating = false, notice = '';
let watch = { id: '', state: '', title: '' };
let coolUntil = 0; // set by the hub after repeated off-purpose videos
const cooling = () => coolUntil > Date.now();
const records = new Map(); const cache = new Map();
const root = () => document.documentElement;
const active = () => config.enabled && !!config.purpose;
const page = () => location.pathname;
const inSearch = () => page() === '/results';
const inWatch = () => page() === '/watch';
const currentQuery = () => new URL(location.href).searchParams.get('search_query') || '';
const videoId = () => new URL(location.href).searchParams.get('v') || '';

(function addStyle() {
  const style = document.createElement('style'); style.textContent = css;
  const attach = () => { if (document.documentElement) { document.documentElement.appendChild(style); return true; } return false; };
  if (!attach()) new MutationObserver((_, obs) => { if (attach()) obs.disconnect(); }).observe(document, { childList: true });
})();

const norm = s => s.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
function localDecision(text) {
  // Word match, explicitly not AI. Used only when no API key is configured.
  if (!config.keywords.length || !text.trim()) return { decision: 'uncertain' };
  return { decision: config.keywords.some(k => norm(text).includes(k)) ? 'related' : 'unrelated' };
}
async function decide(items) {
  if (config.engine !== 'gemini') return items.map(localDecision);
  try {
    const data = await chrome.runtime.sendMessage({ type: 'classify', items: items.map(t => t.slice(0, 300)) });
    if (data?.error || data?.results?.length !== items.length) throw new Error();
    return data.results.map(r => ['related', 'unrelated', 'uncertain'].includes(r.decision) ? r : { decision: 'uncertain', error: true });
  } catch { return items.map(() => ({ decision: 'uncertain', error: true })); }
}
async function decideCached(title) {
  if (cache.has(title)) return cache.get(title);
  const [r] = await decide([title]); if (!r.error) remember(title, r); return r;
}
function remember(title, result) { if (cache.size >= 400) cache.delete(cache.keys().next().value); cache.set(title, result); }

function surface() {
  const p = page();
  if (p === '/results') return 'search';
  if (p === '/') return 'home';
  if (p === '/watch') return 'watch';
  if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
  if (p.startsWith('/@') || p.startsWith('/channel') || p.startsWith('/c/')) return 'channel';
  return 'other';
}
function report() {
  const values = [...records.values()];
  if (inSearch() && !watch.state) {
    const shown = values.filter(r => r.state === 'allow').length, waiting = values.filter(r => r.state === 'pending' && r.title).length;
    notice = values.length && !shown && !waiting ? '이 검색 결과에는 지금 목적에 맞는 영상이 없습니다.' : '';
  }
  drawBanner();
  chrome.runtime.sendMessage({ type: 'status',
    surface: surface(), gate, notice, watch: watch.state,
    shown: values.filter(r => r.state === 'allow').length,
    hidden: values.filter(r => r.state === 'unrelated' || r.state === 'uncertain').length + (watch.state === 'block' ? 1 : 0),
    pending: values.filter(r => r.state === 'pending' && r.title).length,
    errors: values.filter(r => r.error).length
  }).catch(() => {});
}
function clearCards() { for (const node of records.keys()) node.removeAttribute('data-pf-state'); records.clear(); }
function titleOf(node) {
  const t = node.querySelector('#video-title, .yt-lockup-metadata-view-model__title, h3 a, #channel-title, #title, [class*="ShortsLockupViewModelHostMetadataTitle"], h3');
  return (t?.getAttribute('title') || t?.getAttribute('aria-label') || t?.textContent || '').trim();
}
function mark(node, record, result) {
  record.error = !!result.error; record.at = Date.now();
  record.state = result.decision === 'related' ? 'allow' : result.decision;
  node.dataset.pfState = record.state;
}

function pauseVideo() { document.querySelectorAll('video').forEach(v => { try { v.pause(); } catch {} }); }
async function checkWatch() {
  const id = videoId();
  if (watch.id !== id) { watch = { id, state: 'pending', title: '' }; root().classList.add('pf-watch-blocked'); pauseVideo(); }
  if (watch.state !== 'pending') { if (watch.state === 'block') pauseVideo(); return; }
  const title = (document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1')?.textContent || '').trim();
  if (!title || watch.title === title) return;
  watch.title = title;
  const rev = revision, result = await decideCached(title);
  if (rev !== revision || videoId() !== id) return;
  watch.state = result.decision === 'related' ? 'allow' : 'block';
  root().classList.toggle('pf-watch-blocked', watch.state === 'block');
  notice = watch.state === 'block' ? (result.error ? '연결 · 판단 모델에 닿지 못해 이 영상을 멈췄습니다. 딴짓 횟수에는 세지 않습니다.' : '이 영상은 지금 목적과 맞지 않습니다.') : '';
  if (watch.state === 'block') pauseVideo();
  // Only a clear "unrelated" judgment counts as a strike; errors and uncertain titles never do.
  if (watch.state === 'block' && !result.error && result.decision === 'unrelated') void strike(id);
  report();
}
async function strike(id) {
  let r; try { r = await chrome.runtime.sendMessage({ type: 'strike', id }); } catch { return; }
  if (!r || videoId() !== id) return;
  if (r.coolUntil) { setCool(r.coolUntil); return; }
  if (r.strikes >= r.warnAt) notice = r.mode === 'lock'
    ? `경고 · 목적과 무관한 영상을 10분 안에 ${r.strikes}번 열었습니다. 한 번 더 열면 유튜브가 15분 동안 잠깁니다.`
    : `경고 · 목적과 무관한 영상을 10분 안에 ${r.strikes}번 열었습니다. 지금 목적: ${config.purpose}`;
  report();
}
function setCool(until) {
  coolUntil = until || 0;
  root()?.classList.toggle('pf-cool', cooling());
  if (cooling()) pauseVideo();
}

async function scan() {
  queued = 0;
  if (!document.body) return;
  const next = location.pathname + location.search;
  if (route !== next) { route = next; gate = ''; notice = ''; gateRun++; clearCards(); navigating = false; if (!inWatch()) { watch = { id: '', state: '', title: '' }; root().classList.remove('pf-watch-blocked'); } }
  root().classList.toggle('pf-active', active());
  // Shorts: no swipe feed. A short opened from results plays in the normal player instead.
  if (active() && page().startsWith('/shorts/')) { location.replace(`/watch?v=${page().split('/')[2]}`); return; }
  if (active()) for (const chip of document.querySelectorAll('yt-chip-cloud-chip-renderer, chip-view-model, yt-chip-view-model')) {
    if (chip.textContent.trim() === 'Shorts') chip.setAttribute('data-pf-hide', '');
  }
  if (!active()) { root().classList.remove('pf-gated', 'pf-watch-blocked'); clearCards(); report(); return; }
  root().classList.remove('pf-gated'); // searching is always allowed; only the results are filtered
  if (inWatch()) void checkWatch();

  for (const node of records.keys()) if (!node.isConnected) records.delete(node);
  const batch = [];
  for (const node of document.querySelectorAll(cards)) {
    if (node.parentElement?.closest(cards)) continue; // the outer card owns its children
    const title = titleOf(node), old = records.get(node);
    if (old && old.title === title && !(old.error && Date.now() - old.at > 8000)) continue; // retry failed judgments later
    const record = { title, state: 'pending', error: false };
    records.set(node, record);
    if (!title) { node.dataset.pfState = 'pending'; record.title = ''; continue; } // not rendered yet; re-read later
    if (cache.has(title)) { mark(node, record, cache.get(title)); continue; }
    node.dataset.pfState = 'pending'; batch.push({ node, record });
  }
  report();
  const rev = revision, at = route;
  for (let i = 0; i < batch.length; i += 40) {
    if (revision !== rev || at !== route || !active()) return;
    const slice = batch.slice(i, i + 40);
    const results = await decide(slice.map(x => x.record.title));
    if (revision !== rev || at !== route || !active()) return;
    slice.forEach(({ node, record }, k) => {
      if (!results[k].error) remember(record.title, results[k]);
      if (node.isConnected && records.get(node) === record) mark(node, record, results[k]);
    });
    report();
  }
}
function schedule() { if (!queued) queued = setTimeout(scan, 80); }

document.addEventListener('play', () => { if (cooling() || (active() && inWatch() && watch.state !== 'allow' && !root().classList.contains('pf-reveal'))) pauseVideo(); }, true);
document.addEventListener('yt-navigate-finish', schedule);
window.addEventListener('popstate', schedule);

// ---- Purpose comes from the PickFocus page (this extension's background holds it). Without a purpose, YouTube is not usable. ----
let hubKey = '';
function applyState(state) {
  const enabled = !!state?.enabled && !!state?.purpose;
  root()?.classList.toggle('pf-nopurpose', !enabled);
  root()?.classList.toggle('pf-gray', enabled && !!state.gray);
  setCool(enabled ? Number(state.coolUntil) || 0 : 0);
  const key = enabled ? state.purpose + '|' + state.since : 'off';
  if (key === hubKey) { drawBanner(); return; }
  hubKey = key;
  config = { enabled, purpose: enabled ? String(state.purpose).slice(0, 500) : '', engine: state?.ai ? 'gemini' : 'local',
    keywords: enabled ? String(state.keywords || state.purpose).split(/[,\s]+/).map(norm).filter(w => w.length >= 2) : [] };
  revision++; gateRun++; gate = ''; notice = ''; cache.clear(); clearCards(); watch = { id: '', state: '', title: '' };
  root()?.classList.toggle('pf-active', active());
  drawBanner(); schedule();
}
async function pollState() {
  try { applyState(await chrome.runtime.sendMessage({ type: 'state' })); } catch { applyState(null); }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pfReveal) root()?.classList.toggle('pf-reveal', !!changes.pfReveal.newValue);
});
chrome.storage.local.get('pfReveal').then(v => root()?.classList.toggle('pf-reveal', !!v.pfReveal)).catch(() => {});

// A thin black banner for messages, and a full cover for no purpose / no hub / cooldown. Shadow DOM keeps YouTube styles out.
// Styles follow 09_브랜딩_디자인문법.md: warn = strong border + "경고 ·" label, error = surface + "연결 ·" label.
let bannerHost, bannerText;
function drawBanner() {
  if (!document.body) return;
  if (!bannerHost) {
    bannerHost = document.createElement('pf-banner');
    // Bottom, small, click-through: never covers YouTube's search box.
    bannerHost.style.cssText = 'position:fixed;left:0;right:0;bottom:24px;z-index:2147483647;visibility:visible;pointer-events:none;display:flex;justify-content:center';
    const shadow = bannerHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial}'
      + 'div{font:13px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Malgun Gothic","Segoe UI",sans-serif;word-break:keep-all;max-width:560px;background:#000;color:#ededeb;border:1px solid #222221;border-radius:8px;padding:8px 16px}'
      + 'div.warn{border-color:#5a5a57}div.error{background:#0e0e0e;color:#a3a3a0}b{font-weight:600;color:#ededeb}'
      + 'div.full{position:fixed;inset:0;max-width:none;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;border:0;border-radius:0;padding:0 24px;text-align:center;pointer-events:auto}'
      + '.t{font-size:18px;font-weight:600}.r{color:#a3a3a0}.p{color:#80807c}'
      // Cooldown lock: the one inverted screen in the product (user decision, 2026-11-25): white page, black words.
      + 'div.full.lock{background:#ffffff;color:#000000;gap:12px}div.lock .t{font-size:30px;letter-spacing:-.02em}div.lock .r{color:#3a3a38;font-size:14px}div.lock .p{color:#5a5a57}';
    bannerText = document.createElement('div');
    shadow.append(style, bannerText); document.documentElement.append(bannerHost);
  }
  const off = root().classList.contains('pf-nopurpose'), cool = !off && cooling();
  const line = (cls, text) => Object.assign(document.createElement('p'), { className: cls, textContent: text, style: 'margin:0' });
  if (cool) {
    const minutes = Math.max(1, Math.ceil((coolUntil - Date.now()) / 60e3));
    bannerText.className = 'full lock';
    bannerText.replaceChildren(line('t', '지금 이게 뭐 하는 거죠?!'),
      line('r', `목적과 무관한 영상을 10분 안에 4번 열어서 유튜브가 ${minutes}분 동안 잠겼습니다.`), line('p', `목적: ${config.purpose}`));
  } else if (off) {
    bannerText.className = 'full';
    bannerText.replaceChildren(line('t', '목적이 없습니다.'),
      line('r', '툴바의 PickFocus 아이콘을 눌러 목적을 쓰면 유튜브가 열립니다.'));
  } else {
    // "경고 · …" and "연결 · …" carry their own style and a bold label.
    const m = /^(경고|연결) · ([\s\S]*)$/.exec(notice || '');
    bannerText.className = m ? (m[1] === '경고' ? 'warn' : 'error') : '';
    if (m) bannerText.replaceChildren(Object.assign(document.createElement('b'), { textContent: m[1] + ' · ' }), document.createTextNode(m[2]));
    else bannerText.textContent = notice || '';
  }
  bannerHost.hidden = !off && !cool && !notice;
}

function boot() {
  new MutationObserver(() => schedule())
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'href', 'aria-label'] });
  schedule();
}
root()?.classList.add('pf-nopurpose'); // closed until the background confirms a purpose
pollState(); setInterval(pollState, 2000);
if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
