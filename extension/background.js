// PickFocus demo: the extension is the whole product. This service worker is the hub:
// it holds the purpose, judges titles with Gemini Decision 1, counts strikes,
// runs the 15-minute lock and keeps the session history. Everything stays in this browser (chrome.storage.local).
import { classify } from './lib/decision.mjs';
import { BUILTIN } from './lib/config.mjs';
const keyOf = settings => settings.apiKey || BUILTIN;

const STRIKE_WINDOW = 10 * 60e3, WARN_AT = 3, COOL_MS = 15 * 60e3;
const DEFAULTS = { session: null, strikes: [], coolUntil: 0, history: [], settings: { apiKey: '', grayDefault: false, lockMode: 'lock', recent: [], keywords: '', seenDemo: false }, stats: { hidden: 0, shown: 0, at: 0, tab: null }, lastSeen: 0 };
const get = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
const set = v => chrome.storage.local.set(v);
const now = () => Date.now();

// ---- judging: at most 2 calls at once, 429/5xx retried with backoff ----
let running = 0; const waiting = [];
async function judge(purpose, items, key) {
  if (running >= 2) await new Promise(r => waiting.push(r));
  running++;
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await classify({ engine: 'gemini', purpose, items }, { env: { GEMINI_API_KEY: key } }); }
      catch (e) { if (attempt >= 3 || !/\(429\)|\(5\d\d\)/.test(String(e?.message))) throw e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
    }
  } finally { running--; waiting.shift()?.(); }
}

// ---- state the YouTube page needs (same shape the desktop hub served) ----
async function pageState() {
  const s = await get(); await set({ lastSeen: now() });
  const on = !!s.session;
  return { enabled: on, purpose: on ? s.session.purpose : '', gray: on && !!s.session.gray, since: on ? s.session.start : 0,
    lock: on ? s.session.lock : s.settings.lockMode, ai: !!keyOf(s.settings), coolUntil: s.coolUntil > now() ? s.coolUntil : 0, keywords: s.settings.keywords };
}
// ---- what the PickFocus page and PiP show ----
async function info() {
  const s = await get(), t = now();
  return { session: s.session, settings: { ...s.settings, apiKey: s.settings.apiKey ? '••••' + s.settings.apiKey.slice(-4) : '' }, builtinKey: !!BUILTIN,
    extension: t - s.lastSeen < 6000, hidden: s.stats.hidden, shown: s.stats.shown,
    strikes: s.strikes.filter(x => t - x.at < STRIKE_WINDOW).length, warnAt: WARN_AT, coolUntil: s.coolUntil > t ? s.coolUntil : 0 };
}

async function startSession({ purpose, gray, lock }) {
  purpose = String(purpose || '').trim().slice(0, 500); if (!purpose) return info();
  const s = await get();
  if (s.session) await closeSession();
  const recent = [purpose, ...s.settings.recent.filter(p => p !== purpose)].slice(0, 8);
  await set({ session: { purpose, start: now(), gray: !!gray, lock: lock === 'warn' ? 'warn' : 'lock', strikes: 0, locks: 0, hidden: 0 },
    settings: { ...s.settings, recent }, stats: DEFAULTS.stats });
  return info();
}
async function closeSession() {
  const s = await get(); if (!s.session) return;
  const history = [...s.history, { ...s.session, end: now() }].slice(-500);
  await set({ session: null, history, stats: DEFAULTS.stats });
}
async function addStrike(id) {
  const s = await get(), t = now();
  if (!s.session) return { error: 'no-purpose' };
  let strikes = s.strikes.filter(x => t - x.at < STRIKE_WINDOW), coolUntil = s.coolUntil, session = { ...s.session };
  const cooling = coolUntil > t;
  if (id && !cooling && !strikes.some(x => x.id === id)) { strikes.push({ id, at: t }); session.strikes++; }
  if (session.lock === 'lock' && strikes.length > WARN_AT && !cooling) {
    coolUntil = t + COOL_MS; strikes = []; session.locks++;
    chrome.notifications.create('pf-lock', { type: 'basic', iconUrl: 'icons/icon128.png', title: '유튜브가 15분 동안 잠겼습니다', message: '목적과 무관한 영상을 10분 안에 4번 열었습니다. 시작할 때 고른 규칙입니다.', silent: true });
  }
  await set({ strikes, coolUntil, session });
  return { strikes: strikes.length, warnAt: WARN_AT, mode: session.lock, coolUntil: coolUntil > t ? coolUntil : 0 };
}

// Open (or focus) the PickFocus page when the toolbar icon is clicked.
async function openHub() {
  const url = chrome.runtime.getURL('hub.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(openHub);
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') openHub(); });
chrome.notifications.onClicked.addListener(() => openHub());

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // sender.url is set for content scripts even without the tabs permission.
  const fromYouTube = (sender.url || sender.tab?.url || '').startsWith('https://www.youtube.com/');
  const fromPage = (sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (!fromYouTube && !fromPage) return;
  (async () => {
    try {
      const type = message?.type;
      if (type === 'state') return respond(await pageState());
      if (type === 'classify' && fromYouTube) {
        const s = await get();
        if (!s.session) return respond({ error: 'no-purpose' });
        if (!keyOf(s.settings)) return respond({ error: 'no-key' });
        const items = Array.isArray(message.items) ? message.items.slice(0, 50).map(t => String(t).slice(0, 300)) : [];
        try { return respond(await judge(s.session.purpose, items, keyOf(s.settings))); } catch { return respond({ error: 'model' }); }
      }
      if (type === 'strike' && fromYouTube) return respond(await addStrike(String(message.id || '').slice(0, 20)));
      if (type === 'status' && fromYouTube) {
        const text = message.hidden > 0 ? String(Math.min(message.hidden, 999)) : '';
        if (sender.tab?.id != null) await chrome.action.setBadgeText({ tabId: sender.tab.id, text });
        await chrome.action.setBadgeBackgroundColor({ color: '#3a3a38' });
        const s = await get(), hidden = Math.max(0, Math.min(9999, message.hidden | 0));
        const patch = { stats: { hidden, shown: Math.max(0, message.shown | 0), at: now(), tab: sender.tab?.id ?? null } };
        if (s.session) patch.session = { ...s.session, hidden: Math.max(s.session.hidden || 0, hidden) };
        await set(patch); return respond({ ok: true });
      }
      if (!fromPage) return respond({ error: 'unknown' });
      if (type === 'info') return respond(await info());
      if (type === 'start') return respond(await startSession(message));
      if (type === 'end') { await closeSession(); return respond(await info()); }
      if (type === 'gray') { const s = await get(); if (s.session) await set({ session: { ...s.session, gray: !!message.on } }); return respond(await info()); }
      if (type === 'history') { const s = await get(); return respond({ items: [...s.history].reverse().slice(0, 300), current: s.session }); }
      if (type === 'clear-history') { await set({ history: [] }); return respond({ ok: true }); }
      if (type === 'settings') {
        const s = await get(), v = message.value || {}, next = { ...s.settings };
        for (const k of ['grayDefault', 'seenDemo']) if (k in v) next[k] = !!v[k];
        if ('lockMode' in v && !s.session) next.lockMode = v.lockMode === 'warn' ? 'warn' : 'lock';
        if ('keywords' in v) next.keywords = String(v.keywords).slice(0, 200);
        if ('apiKey' in v) next.apiKey = String(v.apiKey).trim().slice(0, 200);
        await set({ settings: next }); return respond(await info());
      }
      respond({ error: 'unknown' });
    } catch { respond({ error: 'failed' }); }
  })();
  return true;
});
