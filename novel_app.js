// novel_app.js - Maoe 小说模式主逻辑（多源适配）
// 独立于动漫模式的轻小说界面：加载 / 排行 / 分类 / 搜索 / 详情 / 阅读器 / 书架 / 设置。
// 数据源通过 window.mengmoe.novel（preload 桥）与主进程通信，渲染层与具体源解耦。
'use strict';

/* ================= 本地工具（避免依赖 app.js 加载时序） ================= */
const $N = (s) => document.querySelector(s);
const $$N = (s) => Array.from(document.querySelectorAll(s));

function escN(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const IMG_FALLBACK_N = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="100%" height="100%" fill="#141414"/><text x="50%" y="50%" fill="#5f5f5f" font-size="14" text-anchor="middle" font-family="sans-serif">暂无图片</text></svg>'
);

function toastN(msg) {
  if (typeof window.toast === 'function') { window.toast(msg); return; }
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// 主进程 IPC 可能未就绪时的兜底提示
function nIpc() {
  const api = window.mengmoe && window.mengmoe.novel;
  if (!api) throw new Error('小说模块未就绪，请重启应用');
  return api;
}

/* ================= 存储 ================= */
const N_SOURCE_KEY = 'maoe.novel.source.v1';
const N_SETTINGS_KEY = 'maoe.novel.settings.v1';
const N_SHELF_KEY = 'maoe.novel.shelf.v1';
const N_HISTORY_KEY = 'maoe.novel.history.v1';
const N_READING_KEY = 'maoe.novel.reading.v1';
const N_SEARCH_HISTORY_KEY = 'maoe.novel.searchHistory.v1';   // 搜索关键词历史
const N_SEARCH_HISTORY_MAX = 10;                               // 最多保留条数

const DEFAULT_N_SET = {
  fontSize: 18,
  lineHeight: 1.95,
  fontFamily: 'default',
  theme: 'dark',
  indent: true,
  remember: true,
  readWidth: 'normal',        // reader 区宽：narrow / normal / wide
  paraSpace: 'normal',        // 段落间距：compact / normal / relaxed
  fontWeight: 'normal',       // 正文字重：normal / medium / bold
  brightness: 100,            // 阅读区亮度：60~115
  gridDensity: 'normal',      // 书本网格密度：compact / normal / relaxed
  coverRadius: 10             // 封面圆角：0~20 px
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ } }

/* 阅读历史内存缓存：避免频繁 JSON.parse localStorage（性能优化） */
let nHistCache = null;
function getNHistory() {
  if (nHistCache === null) nHistCache = loadJSON(N_HISTORY_KEY, {});
  return nHistCache;
}
function saveNHistory(hist) { nHistCache = hist; saveJSON(N_HISTORY_KEY, hist); }
function resetNHistoryCache() { nHistCache = null; }

/* ---------- 搜索关键词历史 ---------- */
function getNSearchHistory() {
  const arr = loadJSON(N_SEARCH_HISTORY_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
// 记录一条搜索词：去重（旧条目提前）、置顶、最多保留 N_SEARCH_HISTORY_MAX 条
function pushNSearchHistory(kw) {
  const key = String(kw == null ? '' : kw).trim();
  if (!key) return;
  let arr = getNSearchHistory().filter((k) => k !== key);
  arr.unshift(key);
  if (arr.length > N_SEARCH_HISTORY_MAX) arr = arr.slice(0, N_SEARCH_HISTORY_MAX);
  saveJSON(N_SEARCH_HISTORY_KEY, arr);
}
function clearNSearchHistory() {
  saveJSON(N_SEARCH_HISTORY_KEY, []);
}
// 渲染搜索历史词条；没有历史时返回 false（供空闲态决定是否展示空提示）
function renderNSearchHistory() {
  const wrap = document.getElementById('novelSearchHistory');
  const tags = document.getElementById('novelSearchHistoryTags');
  if (!wrap || !tags) return false;
  const arr = getNSearchHistory();
  if (!arr.length) { wrap.classList.add('hidden'); return false; }
  tags.innerHTML = arr.map((k) =>
    `<span class="sg-tag" data-kw="${escN(k)}">${escN(k)}</span>`
  ).join('') + `<span class="sg-tag sg-clear" id="novelSearchHistoryClear">清空</span>`;
  wrap.classList.remove('hidden');
  return true;
}

/* ================= 全局小说状态 ================= */
const novelState = {
  mode: 'anime',               // 'anime' | 'novel'
  source: 'wenku8',            // 当前数据源 id
  sources: [],                 // 数据源列表
  meta: null,                  // 当前源元数据
  page: 'home',                // 当前小说页面
  prevPage: 'home',            // 详情返回页
  rankIdx: 0,                  // 首页排行 tab 索引
  rankPage: 1,
  rankEnded: false,
  homeLoading: false,
  homeLoaded: false,           // 首页是否已加载（切页不重复刷新）
  catLoaded: false,            // 分类页是否已加载（切页不重复刷新）
  catTabs: [],                 // 分类列表
  catCur: '',                  // 当前分类 id
  catPage: 1,
  catEnded: false,
  catLoading: false,
  catFull: false,
  homeRes: [],                 // 首页缓存（避免反复请求）
  searchKw: '',                // 搜索关键词（返回搜索页时保留）
  searchResult: null,          // 搜索结果缓存（返回搜索页时恢复，避免重新搜索）
  currentDetail: null,         // 当前详情
  catalog: null,               // 当前目录
  chapters: [],                // 展平章节
  reading: null,               // 阅读状态
  shelf: [],                   // 书架
  shelfTab: 'all',             // 书架 tab：'all' 全部 / 'fav' 阅读中
  settings: Object.assign({}, DEFAULT_N_SET, loadJSON(N_SETTINGS_KEY, {}))
};
novelState.shelf = loadJSON(N_SHELF_KEY, []);

let novelLoaded = false;       // 源/元数据是否已初始化
let novelBound = false;        // 事件是否已绑定

/* ============================================================
   模式切换
   ============================================================ */
function isNovelMode() {
  const app = document.getElementById('novelApp');
  return !!app && !app.classList.contains('hidden');
}

function enterNovel() {
  const app = document.getElementById('app');
  const novel = document.getElementById('novelApp');
  if (app) app.classList.add('hidden');
  if (novel) novel.classList.remove('hidden');
  novelState.mode = 'novel';
  try { localStorage.setItem('maoe.mode', 'novel'); } catch (e) { /* ignore */ }
  const mask = document.getElementById('loadingMask');
  if (mask) mask.classList.remove('show');
  applyNUISettings();
  applyNReaderSettings();
  refreshNSettingsControls();
  ensureNovelLoaded();
}

function exitNovel() {
  const app = document.getElementById('app');
  const novel = document.getElementById('novelApp');
  if (novel) novel.classList.add('hidden');
  if (app) app.classList.remove('hidden');
  novelState.mode = 'anime';
  novelState.page = 'home';
  try { localStorage.setItem('maoe.mode', 'anime'); } catch (e) { /* ignore */ }
  // 返回动漫模式时回到首页，防止停留在上一次的页面（修复）
  if (typeof showPage === 'function') showPage('home');
}

/* ============================================================
   初始化
   ============================================================ */
async function ensureNovelLoaded() {
  if (novelLoaded) { renderNSetSource(); switchNPage(novelState.page); syncNPageLoad(); return; }
  try {
    const srcs = await nIpc().sources();
    novelState.sources = srcs;
    const saved = loadJSON(N_SOURCE_KEY, '');
    if (saved && srcs.some((s) => s.id === saved)) novelState.source = saved;
    novelLoaded = true;
    renderNSetSource();
    await loadNMeta();
    bindNovelEvents();
    // homeIsSearch 源（如阅读书源/轻之国度）：默认进入搜索页
    const m = novelState.meta;
    const initPage = (m && m.homeIsSearch) ? 'search' : 'home';
    switchNPage(initPage);
    syncNPageLoad();
  } catch (e) {
    console.error('[novel] 初始化失败', e);
    toastN('小说初始化失败：' + e.message);
  }
}

async function loadNMeta() {
  const meta = await nIpc().meta(novelState.source);
  novelState.meta = meta;
  // 若当前源不支持某能力，自动跳转可用页面
  if (!meta.supportsSearch && novelState.page === 'search') novelState.page = 'home';
  if (!meta.supportsCategory && novelState.page === 'cat') novelState.page = 'home';
}

function updateNSourcePills() {
  $$N('#novelSetSource .src-opt').forEach((p) => p.classList.toggle('active', p.dataset.src === novelState.source));
}

// 小说源切换（设置页，风格与动漫源一致）
function renderNSetSource() {
  const box = document.getElementById('novelSetSource');
  if (!box) return;
  box.innerHTML = novelState.sources.map((s) =>
    `<span class="src-opt ${s.id === novelState.source ? 'active' : ''}" data-src="${escN(s.id)}" title="${escN(s.name)}">
      <span class="dot"></span>${escN(s.name)}
    </span>`).join('');
}

async function setNSource(src) {
  if (novelState.source === src) return;
  novelState.source = src;
  saveJSON(N_SOURCE_KEY, src);
  // 源切换：全局刷新——重置所有页面状态与缓存，清空正文缓存
  novelState.rankIdx = 0;
  novelState.rankPage = 1;
  novelState.rankEnded = false;
  novelState.homeLoaded = false;
  novelState.homeRes = [];
  novelState.catTabs = [];
  novelState.catLoaded = false;
  novelState.catCur = '';
  novelState.catPage = 1;
  novelState.catEnded = false;
  novelState.catLoading = false;
  novelState.catFull = false;
  novelState.searchKw = '';
  novelState.searchResult = null;
  novelState.currentDetail = null;
  novelState.catalog = null;
  novelState.chapters = [];
  novelState.reading = null;
  nChapterCache.clear();
  // 源切换全局刷新：清空所有页面动态内容，杜绝上一个源的数据/文字残留
  // 格式：[元素id, 处理方式]，''=清空innerHTML，'hidden'=隐藏
  const srcClear = [
    ['novelRankBar', ''], ['novelGrid', ''], ['novelMore', 'hidden'], ['novelHomeEmpty', 'hidden'],
    ['novelCatTabs', ''], ['novelCatCount', ''], ['novelCatGrid', ''], ['novelCatMore', 'hidden'], ['novelCatEmpty', 'hidden'],
    ['novelSearchResultHead', 'hidden'], ['novelSearchGrid', ''], ['novelSearchEmpty', 'hidden'],
    ['novelDetailContent', ''], ['readerTitle', ''], ['readerChapterTitle', ''], ['readerParas', '']
  ];
  srcClear.forEach(([id, mode]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (mode === 'hidden') el.classList.add('hidden');
    else el.innerHTML = '';
  });
  const sInp = document.getElementById('novelSearchInput');
  if (sInp) sInp.value = '';
  updateNSourcePills();
  await loadNMeta();
  // 源切换后适配导航可见性（隐藏/显示首页、搜索、分类导航项）
  applyNCapability();
  // homeIsSearch 源：无首页，默认落到搜索页；其它源回到首页
  const m = novelState.meta;
  novelState.page = (m && m.homeIsSearch) ? 'search'
    : (m && !m.supportsRank && !m.rankTabs.length && m.supportsSearch ? 'search' : 'home');
  switchNPage(novelState.page);
  syncNPageLoad();
}

// 根据源能力隐藏/显示导航项
function applyNCapability() {
  const meta = novelState.meta;
  if (!meta) return;
  const catNav = document.querySelector('[data-npage="cat"]');
  const searchNav = document.querySelector('[data-npage="search"]');
  const homeNav = document.querySelector('[data-npage="home"]');
  if (catNav) catNav.style.display = meta.supportsCategory ? '' : 'none';
  if (searchNav) searchNav.style.display = meta.supportsSearch ? '' : 'none';
  // homeIsSearch 源：首页本身就是搜索框，隐藏"首页"导航项，保留搜索导航
  if (homeNav) homeNav.style.display = meta.homeIsSearch ? 'none' : '';
}

/* ============================================================
   小说页面切换
   ============================================================ */
function switchNPage(name) {
  novelState.page = name;
  $$N('.npage').forEach((p) => p.classList.toggle('nactive', p.id === 'npage-' + name));
  $$N('.novel-sidebar .nav-item').forEach((n) => n.classList.toggle('nactive', n.dataset.npage === name));
  applyNCapability();
  const main = document.getElementById('novelMain');
  const scroller = main || document.documentElement;
  scroller.scrollTop = 0;
}

// 依据当前页加载对应内容
function syncNPageLoad() {
  // homeIsSearch 源无首页：任何路径落到 home 时强制转到搜索页
  if (novelState.page === 'home' && novelState.meta && novelState.meta.homeIsSearch) {
    switchNPage('search');
  }
  switch (novelState.page) {
    case 'home': loadNHome(false); break;
    case 'cat': loadNCat(false); break;
    case 'search': showNSearchIdle(); break;
    case 'shelf': renderNShelf(); break;
    case 'settings': renderNSettings(); break;
    // detail / reader 由打开入口负责
  }
}

/* ============================================================
   卡片渲染
   ============================================================ */
// 解析卡片来源的可读名称：优先用子源名（如阅读书源的"得奇小说网"），否则回退到来源元数据名称
function nSourceLabel(b) {
  const src = b.source || novelState.source;
  if (b.srcName) return { id: src, label: String(b.srcName) };
  const map = (novelState.sources || []).reduce((m, s) => { m[s.id] = s.name; return m; }, {});
  return { id: src, label: map[src] || src };
}

function ncardHtml(b) {
  const state = b.banned ? '<span class="ncard-state st-ban">下架</span>'
    : b.status === '已完结' ? '<span class="ncard-state st-done">完结</span>'
    : b.animated ? '<span class="ncard-state st-anime">已动画化</span>' : '';
  const sub = [b.author, b.category].filter(Boolean).join(' · ');
  const tags = (b.tags || []).slice(0, 4).map((t) => `<span class="ncard-tag">${escN(t)}</span>`).join('');
  const cover = b.cover || IMG_FALLBACK_N;
  // 书架为多源共享，需在卡片上标注来源；聚合源（如阅读书源）还带子源名
  const showSrc = Boolean(b.srcName) || b.source !== novelState.source || novelState.page === 'shelf';
  const srcBadge = showSrc && (nSourceLabel(b).label)
    ? `<span class="ncard-src" data-src-id="${escN(nSourceLabel(b).id)}">${escN(nSourceLabel(b).label)}</span>` : '';
  return `
  <div class="ncard" data-src="${escN(b.source || novelState.source)}" data-id="${escN(b.id)}" data-entry="${escN(b.entry || 'detail')}">
    <div class="ncard-cover">
      <img src="${escN(cover)}" alt="${escN(b.title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${IMG_FALLBACK_N}'">
      <div class="ncard-shade"></div>
      ${state}
    </div>
    <div class="ncard-meta">
      <div class="ncard-title">${escN(b.title)}</div>
      ${srcBadge}
      ${sub ? `<div class="ncard-sub">${escN(sub)}</div>` : ''}
      ${tags ? `<div class="ncard-tags">${tags}</div>` : ''}
    </div>
  </div>`;
}

function renderNBooks(grid, books) {
  if (!books || !books.length) return;
  grid.innerHTML += books.map(ncardHtml).join('');
}

/* ============================================================
   加载骨架屏（占位卡片/行，替代“加载中…”文字，避免布局跳动）
   ============================================================ */
function nskelGrid(n) {
  let s = '';
  for (let i = 0; i < (n || 10); i++) {
    s += '<div class="nskel"><div class="nskel-cover"></div><div class="nskel-line w80"></div><div class="nskel-line w60"></div></div>';
  }
  return s;
}
function nskelList(n) {
  let s = '';
  for (let i = 0; i < (n || 10); i++) s += '<div class="nskel-line"></div>';
  return '<div class="nskel-list">' + s + '</div>';
}
function nskelText() {
  const widths = [100, 92, 100, 96, 100, 88, 100, 94, 100, 90, 100, 97, 100, 85, 100, 92, 100, 60];
  return '<div class="nskel-text">' + widths.map((w) => '<div class="nskel-line" style="width:' + w + '%"></div>').join('') + '</div>';
}
function nskelDetail() {
  return '<div class="ndetail-skel">' +
    '<div class="nskel nd-skel-cover"><div class="nskel-cover"></div></div>' +
    '<div class="nd-skel-info">' +
      '<div class="nskel-line w80"></div>' +
      '<div class="nskel-line w60"></div>' +
      '<div class="nskel-line"></div>' +
      '<div class="nskel-line w80"></div>' +
      '<div class="nskel-line w60"></div>' +
    '</div></div>';
}

/* ============================================================
   首页 / 排行
   ============================================================ */
async function loadNHome(reset, force) {
  const grid = document.getElementById('novelGrid');
  const more = document.getElementById('novelMore');
  const empty = document.getElementById('novelHomeEmpty');
  const loginBanner = document.getElementById('novelLoginBanner');
  if (!grid) return;
  renderLoginBanner();
  renderNRankBar();
  if (novelState.homeLoading) return;
  // 已加载且非强制刷新时直接复用缓存，避免切页来回刷新
  if (!reset && !force && novelState.homeLoaded) return;
  novelState.homeLoading = true;
  if (reset) { novelState.rankPage = 1; novelState.rankEnded = false; novelState.homeLoaded = false; grid.innerHTML = nskelGrid(10); }
  else if (!novelState.homeLoaded) { grid.innerHTML = nskelGrid(10); }
  more.classList.add('hidden');
  const tab = (novelState.meta && novelState.meta.rankTabs && novelState.meta.rankTabs[novelState.rankIdx]) || { key: '' };
  try {
    let res;
    try { res = await nIpc().rank(novelState.source, tab.key, novelState.rankPage); }
    catch (e) { res = await nIpc().home(novelState.source); }
    if (reset || !novelState.homeLoaded) grid.innerHTML = '';
    renderNBooks(grid, res.books || []);
    const total = res.totalPage || 1;
    novelState.rankEnded = novelState.rankPage >= total || !(res.books || []).length;
    novelState.rankPage++;
    novelState.homeLoaded = true;
    empty.classList.toggle('hidden', (res.books || []).length > 0);
    more.classList.toggle('hidden', novelState.rankEnded);
  } catch (e) {
    if (reset || !novelState.homeLoaded) {
      const msg = String((e && e.message) || '');
      // 数据源不支持首页/排行时，自动跳转到其可用页面
      if (/不支持首页|不支持排行|暂不支持/.test(msg)) {
        const m = novelState.meta;
        const target = m && m.supportsSearch ? 'search' : (m && m.supportsCategory ? 'cat' : '');
        if (target) { switchNPage(target); syncNPageLoad(); return; }
      }
      grid.innerHTML = `<div class="empty-hint">${reqLoginHint(e)}</div>`;
    }
    empty.classList.add('hidden');
  } finally {
    novelState.homeLoading = false;
  }
}

function reqLoginHint(e) {
  const msg = String((e && e.message) || '');
  if (/NEED_LOGIN|需要登录/.test(msg)) return '该数据源需登录后才能浏览，请前往「设置」登录';
  return '加载失败：' + escN(msg);
}

function renderNRankBar() {
  const bar = document.getElementById('novelRankBar');
  if (!bar) return;
  const tabs = (novelState.meta && novelState.meta.rankTabs) || [];
  bar.innerHTML = tabs.map((t, i) =>
    `<button class="nrank-tab ${i === novelState.rankIdx ? 'active' : ''}" data-rank="${escN(t.key)}" data-ridx="${i}">${escN(t.label)}</button>`).join('')
    + (novelState.meta && novelState.meta.supportsLogin
      ? '<div class="novel-cat-note" data-ranknote="1">浏览排行需要登录（若未登录请到设置或上方登录）</div>'
      : '');
}

async function onNRankTab(idx) {
  if (novelState.rankIdx === idx) return;
  novelState.rankIdx = idx;
  renderNRankBar();
  loadNHome(true);
}

/* ============================================================
   wenku8 登录横幅
   ============================================================ */
async function renderLoginBanner() {
  const el = document.getElementById('novelLoginBanner');
  if (!el) return;
  const meta = novelState.meta;
  if (!meta || !meta.supportsLogin) { el.className = 'nlogin hidden'; el.innerHTML = ''; return; }
  const bar = document.getElementById('novelRankBar');
  const noteEl = bar && bar.querySelector('[data-ranknote]');
  try {
    const st = await nIpc().status(novelState.source);
    if (st.loggedIn) {
      el.className = 'nlogin-banner nl-ok';
      el.innerHTML = `
        <div class="nlogin-msg">已登录 <b>${escN(st.username)}</b><div class="nl-sub">UID ${escN(st.uid || '-')} · 可浏览排行/搜索/分类</div></div>
        <div class="nlogin-actions"><span class="nlogin-user">${escN(st.username)}</span><button class="btn-ghost" id="nlLogout">退出登录</button></div>`;
      if (noteEl) noteEl.style.display = 'none';
    } else {
      el.className = 'nlogin-banner nl-warn';
      el.innerHTML = `
        <div class="nlogin-msg">需登录 <b>${escN(meta.name)}</b> 才能浏览排行<div class="nl-sub">账号仅在本地保存，不会上传</div></div>
        <div class="nlogin-actions"><button class="btn-primary" id="nlLogin">去登录</button></div>`;
      if (noteEl) noteEl.style.display = '';
    }
  } catch (e) {
    el.className = 'nlogin-banner nl-warn';
    if (noteEl) noteEl.style.display = '';
  }
}

/* ============================================================
   分类页
   ============================================================ */
async function loadNCat(reset, force) {
  const tabsEl = document.getElementById('novelCatTabs');
  const grid = document.getElementById('novelCatGrid');
  const meta = novelState.meta;
  if (!meta || !meta.supportsCategory) {
    if (grid) grid.innerHTML = '<div class="empty-hint">该数据源暂不支持分类浏览</div>';
    return;
  }
  if (!novelState.catTabs.length) {
    if (tabsEl) tabsEl.innerHTML = '<div class="novel-cat-note">加载分类中…</div>';
    try {
      const res = await nIpc().categories(novelState.source);
      novelState.catTabs = res.list || [];
      novelState.catLoaded = false;
    } catch (e) {
      if (grid) grid.innerHTML = `<div class="empty-hint">${reqLoginHint(e)}</div>`;
      if (tabsEl) tabsEl.innerHTML = '';
      return;
    }
  }
  // 已加载且非强制刷新时直接复用缓存，避免切页来回刷新
  if (!reset && !force && novelState.catLoaded) return;
  renderNCatTabs();
  if (reset) { novelState.catPage = 1; novelState.catEnded = false; }
  loadNCatGrid();
}

function renderNCatTabs() {
  const tabsEl = document.getElementById('novelCatTabs');
  if (!tabsEl) return;
  const tabs = novelState.catTabs;
  tabsEl.innerHTML = tabs.map((t) =>
    `<button class="novel-cat-tab ${String(t.id) === String(novelState.catCur) ? 'active' : ''}" data-cat="${escN(t.id)}">${escN(t.name)}</button>`).join('')
    + '<div class="novel-cat-note" style="width:100%">点击分类浏览对应作品</div>';
}

async function onNCatTab(id) {
  if (String(novelState.catCur) === String(id)) return;
  novelState.catCur = id;
  novelState.catPage = 1;
  novelState.catEnded = false;
  renderNCatTabs();
  loadNCatGrid();
}

async function loadNCatGrid() {
  const grid = document.getElementById('novelCatGrid');
  const more = document.getElementById('novelCatMore');
  const empty = document.getElementById('novelCatEmpty');
  const count = document.getElementById('novelCatCount');
  if (!grid || novelState.catLoading) return;
  novelState.catLoading = true;
  more.classList.add('hidden');
  const isFirst = novelState.catPage === 1;
  if (isFirst) { grid.innerHTML = nskelGrid(10); }
  try {
    const res = await nIpc().cat(novelState.source, novelState.catCur, novelState.catPage, novelState.catFull);
    if (isFirst) grid.innerHTML = '';
    renderNBooks(grid, res.books || []);
    const total = res.totalPage || 1;
    const len = (res.books || []).length;
    novelState.catEnded = novelState.catPage >= total || !len;
    novelState.catPage++;
    novelState.catLoaded = true;
    if (count) count.textContent = len ? `共 ${total} 页` : '暂无内容';
    empty.classList.toggle('hidden', len > 0);
    more.classList.toggle('hidden', novelState.catEnded);
  } catch (e) {
    if (isFirst) grid.innerHTML = `<div class="empty-hint">${reqLoginHint(e)}</div>`;
    if (count) count.textContent = '';
  } finally {
    novelState.catLoading = false;
  }
}

/* ============================================================
   搜索页
   ============================================================ */
function showNSearchIdle() {
  const head = document.getElementById('novelSearchResultHead');
  const grid = document.getElementById('novelSearchGrid');
  const empty = document.getElementById('novelSearchEmpty');
  if (!head) return;
  // 已有搜索结果缓存（如从详情页返回）时直接恢复，避免重新搜索
  if (novelState.searchResult) {
    grid.innerHTML = '';
    renderNBooks(grid, novelState.searchResult);
    const totalEl = document.getElementById('novelSearchTotal');
    if (totalEl) totalEl.textContent = novelState.searchResult.length;
    head.classList.remove('hidden');
    empty.classList.toggle('hidden', novelState.searchResult.length > 0);
    return;
  }
  head.classList.add('hidden');
  empty.classList.add('hidden');
  if (grid) grid.innerHTML = '';
  // 空闲态展示搜索历史（有历史则显示，无历史保持隐藏）
  renderNSearchHistory();
}

async function doNSearch() {
  const input = document.getElementById('novelSearchInput');
  const kw = (input && input.value || '').trim();
  if (!kw) { toastN('请输入搜索关键词'); return; }
  if (!novelState.meta || !novelState.meta.supportsSearch) { toastN('该数据源不支持搜索'); return; }
  const head = document.getElementById('novelSearchResultHead');
  const grid = document.getElementById('novelSearchGrid');
  const empty = document.getElementById('novelSearchEmpty');
  head.classList.add('hidden');
  empty.classList.add('hidden');
  grid.innerHTML = '<div class="empty-hint">搜索中…</div>';
  try {
    const res = await nIpc().search(novelState.source, kw);
    const books = res.books || [];
    novelState.searchKw = kw;
    novelState.searchResult = books;
    pushNSearchHistory(kw);   // 搜索成功后写入历史
    grid.innerHTML = '';
    renderNBooks(grid, books);
    const totalEl = document.getElementById('novelSearchTotal');
    if (totalEl) totalEl.textContent = books.length;
    head.classList.remove('hidden');
    empty.classList.toggle('hidden', books.length > 0);
  } catch (e) {
    novelState.searchResult = null;
    grid.innerHTML = `<div class="empty-hint">搜索失败：${escN(e.message)}</div>`;
    head.classList.add('hidden');
  }
}

/* ============================================================
   详情页
   ============================================================ */
async function openNDetail(src, id) {
  novelState.prevPage = novelState.page;
  switchNPage('detail');
  const el = document.getElementById('novelDetailContent');
  el.innerHTML = nskelDetail();
  try {
    const d = await nIpc().detail(src, String(id));
    d.source = src;
    d.id = String(id);
    novelState.currentDetail = d;
    renderNDetail(d);
    loadNDetailCatalog(d);           // 简介下方展示卷数目录
  } catch (e) {
    el.innerHTML = `<div class="empty-hint">详情加载失败：${escN(e.message)}</div>`;
  }
}

// 详情页：加载并渲染卷数目录（可折叠，默认首卷展开）
async function loadNDetailCatalog(d) {
  const box = document.getElementById('ndetailCatalog');
  if (!box) return;
  box.innerHTML = nskelList(8);
  try {
    const cat = await nIpc().catalog(d.source, d.read || { id: String(d.id) });
    novelState.catalog = cat;
    novelState.chapters = flattenCatalog(cat);
    renderNDetailCatalog(cat);
  } catch (e) {
    box.innerHTML = `<div class="empty-hint">目录加载失败：${escN(e.message)}</div>`;
  }
}

function renderNDetailCatalog(cat) {
  const box = document.getElementById('ndetailCatalog');
  if (!box) return;
  const volumes = (cat && cat.volumes) || [];
  const total = volumes.reduce((s, v) => s + ((v.chapters || []).length), 0);
  if (!total) { box.innerHTML = '<div class="empty-hint">暂无目录</div>'; return; }
  let flat = 0;
  const volHtml = volumes.map((v, vi) => {
    const chs = (v.chapters || []).map((c) => {
      const idx = flat++;
      return `<div class="ndcat-ch" data-ci="${idx}" title="${escN(c.name)}">${escN(c.name)}</div>`;
    }).join('');
    const collapsed = vi > 0 ? ' collapsed' : '';
    return `
      <div class="ndcat-vol" data-vol="${vi}">
        <div class="ndcat-vol-head" data-vol="${vi}">
          <span class="ndcat-vol-name">${escN(v.name || '正文')}</span>
          <span class="ndcat-vol-count">${(v.chapters || []).length} 章</span>
          <span class="ndcat-vol-toggle">${vi > 0 ? '展开' : '收起'}</span>
        </div>
        <div class="ndcat-vol-body${collapsed}">${chs}</div>
      </div>`;
  }).join('');
  box.innerHTML = `<div class="ndcat-title">目录 · 共 ${total} 章</div>${volHtml}`;
}

function renderNDetail(d) {
  const el = document.getElementById('novelDetailContent');
  if (!el) return;
  const metaChips = [];
  if (d.author) metaChips.push('作者：' + escN(d.author));
  if (d.category) metaChips.push('分类：' + escN(d.category));
  if (d.status) metaChips.push('状态：' + escN(d.status));
  if (d.update) metaChips.push('更新：' + escN(d.update));
  if (d.wordcount) metaChips.push('字数：' + escN(d.wordcount));
  if (d.nums) metaChips.push('数据：' + escN(String(d.nums).replace(/\s+/g, ' ')));
  const tags = (d.tags || []).map((t) => `<span class="ncard-tag">${escN(t)}</span>`).join('');
  const cover = d.cover || IMG_FALLBACK_N;
  const inShelf = novelState.shelf.some((b) => b.source === d.source && String(b.id) === String(d.id));
  el.innerHTML = `
    <div class="ndetail" style="background:linear-gradient(180deg, rgba(0,0,0,0.55), rgba(10,10,12,0.9)), url('${escN(cover)}') center/cover no-repeat">
      <div class="ndetail-hero">
        <img class="ndetail-cover" src="${escN(cover)}" alt="${escN(d.title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${IMG_FALLBACK_N}'">
        <div class="ndetail-info">
          <div class="ndetail-name">${escN(d.title)}</div>
          <div class="ndetail-meta">${metaChips.map((c) => `<span class="meta-chip">${c}</span>`).join('')}</div>
          ${tags ? `<div class="ndetail-tags">${tags}</div>` : ''}
          <div class="ndetail-desc">${escN(d.intro || '暂无简介')}</div>
          <div class="ndetail-actions">
            <button class="btn-read" id="nStartRead">开始阅读</button>
            <button class="btn-ghost" id="nToggleShelf">${inShelf ? '移出书架' : '加入书架'}</button>
          </div>
          <div class="ndetail-src">数据源：${escN(nSourceLabel(d).label)}</div>
        </div>
      </div>
    </div>
    <div class="ndetail-catalog" id="ndetailCatalog"></div>`;
}

/* ============================================================
   阅读器
   ============================================================ */
function flattenCatalog(cat) {
  const list = [];
  (cat.volumes || []).forEach((v) => (v.chapters || []).forEach((c) => list.push({
    cid: (c.cid == null || c.cid === '') ? 'i' + list.length : c.cid,
    name: c.name,
    vol: v.name
  })));
  return list;
}

async function openNReader(source, book, chapterIdx) {
  switchNPage('reader');
  // 兜底：从历史/书架进入时 book 可能缺少书名/封面/作者，用历史记录补齐
  const rec = getNHistory()[source + ':' + String(book.id)] || {};
  // read 对象必须是该书所属源的站点特定结构（如 wenku8 需 {x, bookid}，幻梦/轻之国度只需 {id}）。
  // 跨源场景下 book 可能只带通用 {id}，此时若当前详情与该书匹配，用详情的 read 补齐，避免请求错结构。
  const cur = novelState.currentDetail;
  const readObj = book.read
    || (cur && cur.source === source && String(cur.id) === String(book.id) ? cur.read : null)
    || rec.read
    || { id: String(book.id) };
  novelState.reading = {
    source,
    id: String(book.id),
    read: readObj,
    bookTitle: book.title || rec.bookTitle || '',
    cover: book.cover || rec.cover || '',
    author: book.author || rec.author || '',
    idx: chapterIdx == null ? 0 : chapterIdx
  };
  document.getElementById('readerParas').innerHTML = nskelList(10);
  try {
    const cat = await nIpc().catalog(source, novelState.reading.read);
    novelState.catalog = cat;
    novelState.chapters = flattenCatalog(cat);
    if (!novelState.chapters.length) { toastN('该书暂无章节'); switchNPage('detail'); return; }
    // 仅当未明确指定章节（默认进入阅读器）时才从历史恢复进度；
    // 用户主动点击目录/章节跳转时应尊重其选择，不能被子源/历史进度覆盖
    if (chapterIdx == null && novelState.settings.remember) {
      const rk = source + ':' + novelState.reading.id;
      const rec = getNHistory()[rk];
      if (rec && rec.cid) {
        const i = novelState.chapters.findIndex((c) => String(c.cid) === String(rec.cid));
        if (i >= 0) novelState.reading.idx = i;
      }
    }
    renderNReaderSettings();
    toggleNReaderSettings(false); // 进入阅读器默认关闭设置面板
    loadNChapter();
  } catch (e) {
    document.getElementById('readerParas').innerHTML = `<div class="empty-hint">目录加载失败：${escN(e.message)}</div>`;
  }
}

// 章节正文内存缓存：会话内重复翻章直接复用，减少 IPC 往返
const nChapterCache = new Map();
const N_CHAPTER_CACHE_MAX = 40;
async function loadNChapter() {
  const r = novelState.reading;
  const c = novelState.chapters[r.idx];
  if (!r || !c) return;
  document.getElementById('readerTitle').textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + c.name;
  document.getElementById('readerChapterTitle').textContent = c.name;
  document.getElementById('readerParas').innerHTML = nskelText();
  const ckey = r.source + ':' + ((r.read && r.read.id != null) ? r.read.id : r.id) + ':' + ((c.cid == null || c.cid === '') ? r.idx : c.cid);
  try {
    let content = nChapterCache.get(ckey);
    if (!content) {
      const res = await nIpc().chapter(r.source, r.read, c.cid);
      content = (res.content || []).filter((s) => s && String(s).trim());
      if (content.length) {
        if (nChapterCache.size >= N_CHAPTER_CACHE_MAX) nChapterCache.delete(nChapterCache.keys().next().value);
        nChapterCache.set(ckey, content);
      }
    }
    const paras = document.getElementById('readerParas');
    paras.innerHTML = '';
    if (!content.length) paras.innerHTML = '<div class="empty-hint">本章暂无内容</div>';
    content.forEach((p) => {
      const el = document.createElement('p');
      el.textContent = p;
      paras.appendChild(el);
    });
    applyNReaderSettings();
    updateNReaderNav();
    // 翻章后回到阅读区顶部（修复停留在上一章滚动位置的问题）
    const nMain = document.getElementById('novelMain');
    if (nMain) nMain.scrollTop = 0;
    // 记忆阅读进度
    if (novelState.settings.remember && c.cid != null) {
      const rk = r.source + ':' + r.id;
      const hist = getNHistory();
      hist[rk] = {
        cid: String(c.cid), title: c.name, bookTitle: r.bookTitle, source: r.source,
        id: r.id, cover: r.cover || '', author: r.author || '', read: r.read, idx: r.idx, ts: Date.now()
      };
      saveNHistory(hist);
    }
  } catch (e) {
    document.getElementById('readerParas').innerHTML = `<div class="empty-hint">正文加载失败：${escN(e.message)}</div>`;
  }
}

function updateNReaderNav() {
  const r = novelState.reading;
  if (!r || !novelState.chapters.length) return;
  const prev = document.getElementById('readerPrev');
  const next = document.getElementById('readerNext');
  const prog = document.getElementById('readerProgressBtn');
  if (prev) prev.disabled = r.idx <= 0;
  if (next) next.disabled = r.idx >= novelState.chapters.length - 1;
  if (prog) {
    prog.textContent = (r.idx + 1) + ' / ' + novelState.chapters.length;
    prog.title = '第 ' + (r.idx + 1) + ' / ' + novelState.chapters.length + ' 章 · 点击跳转';
  }
}

// 应用阅读器外观设置到当前阅读区
function applyNReaderSettings() {
  const reader = document.getElementById('npage-reader');
  const body = document.getElementById('readerBody');
  const paras = document.getElementById('readerParas');
  const s = novelState.settings;
  if (reader) {
    reader.setAttribute('data-theme', s.theme);
    reader.setAttribute('data-width', s.readWidth);
    reader.setAttribute('data-pspace', s.paraSpace);
    reader.setAttribute('data-weight', s.fontWeight);
  }
  if (body) {
    // 亮度滤镜只作用于正文区域：若作用在 #npage-reader 上会使其成为
    // position:fixed 侧边栏的 containing block，导致侧边栏不固定、随滚动消失
    body.style.filter = 'brightness(' + s.brightness + '%)';
  }
  if (paras) {
    // 字号/行高直接设置到段落容器（.reader-paras p 为 inherit，从此处继承）：
    // 若只设在 #readerBody 上，p 元素仍可能被显式字号规则覆盖
    paras.style.fontSize = s.fontSize + 'px';
    paras.style.lineHeight = String(s.lineHeight);
    paras.classList.toggle('indent-on', !!s.indent);
    paras.classList.remove('font-serif', 'font-kai', 'font-hei', 'font-default');
    paras.classList.add('font-' + s.fontFamily);
  }
}

// 应用界面类设置（书架网格密度、封面圆角）到小说容器
function applyNUISettings() {
  const app = document.getElementById('novelApp');
  if (!app) return;
  const s = novelState.settings;
  app.setAttribute('data-grid', s.gridDensity);
  app.setAttribute('data-radius', '1');
  app.style.setProperty('--n-radius', (s.coverRadius || 0) + 'px');
}

function refreshNSettingsControls() {
  const s = novelState.settings;
  const val = document.getElementById('nFontSizeVal');
  const fs = document.getElementById('nFontSize');
  if (fs) fs.value = s.fontSize;
  if (val) val.textContent = s.fontSize + 'px';
  $$N('#nLineHeight .seg-opt').forEach((o) => o.classList.toggle('active', String(o.dataset.v) === String(s.lineHeight)));
  $$N('#nFontFamily .seg-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === s.fontFamily));
  $$N('#nReadWidth .seg-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === s.readWidth));
  $$N('#nParaSpace .seg-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === s.paraSpace));
  $$N('#nFontWeight .seg-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === s.fontWeight));
  $$N('#nGridDensity .seg-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === s.gridDensity));
  const bv = document.getElementById('nBrightnessVal');
  const br = document.getElementById('nBrightness');
  if (br) br.value = s.brightness;
  if (bv) bv.textContent = s.brightness + '%';
  const crv = document.getElementById('nCoverRadiusVal');
  const cr = document.getElementById('nCoverRadius');
  if (cr) cr.value = s.coverRadius;
  if (crv) crv.textContent = s.coverRadius + 'px';
  const ind = document.getElementById('nIndent');
  const rem = document.getElementById('nRemember');
  if (ind) ind.checked = !!s.indent;
  if (rem) rem.checked = !!s.remember;
  renderNThemes();
}

function applyNSettingsChange() {
  saveJSON(N_SETTINGS_KEY, novelState.settings);
  applyNReaderSettings();
  applyNUISettings();
  refreshNSettingsControls();
}

/* ============================================================
   阅读器设置面板（浮层）
   ============================================================ */
function renderNReaderSettings() {
  const panel = document.getElementById('readerSettings');
  if (!panel) return;
  const s = novelState.settings;
  const themes = [['dark', '夜间'], ['sepia', '羊皮纸'], ['light', '日间']];
  panel.innerHTML = `
    <div class="reader-set-panel">
      <div class="reader-set-head">
        <span>阅读设置</span>
        <button class="reader-set-close" id="readerSetClose">×</button>
      </div>
      <div class="reader-set-row">
        <label>字号</label>
        <div class="rst-val" id="rstFontSize">${escN(String(s.fontSize))}px</div>
        <div class="rst-range">
          <input type="range" id="rstFontSlider" min="12" max="34" step="1" value="${escN(String(s.fontSize))}">
        </div>
      </div>
      <div class="reader-set-row">
        <label>行距</label>
        <div class="rst-segs">
          ${[1.6, 1.8, 1.95, 2.2].map((v) => `<button class="rst-seg ${String(s.lineHeight) === String(v) ? 'active' : ''}" data-lh="${v}">${v}</button>`).join('')}
        </div>
      </div>
      <div class="reader-set-row">
        <label>字体</label>
        <div class="rst-segs">
          ${[['default', '默认'], ['serif', '宋体'], ['kai', '楷体'], ['hei', '黑体']].map(([v, n]) => `<button class="rst-seg ${s.fontFamily === v ? 'active' : ''}" data-ff="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="reader-set-row">
        <label>主题</label>
        <div class="rst-segs">
          ${themes.map(([v, n]) => `<button class="rst-seg ${s.theme === v ? 'active' : ''}" data-theme="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="reader-set-row">
        <label>亮度</label>
        <div class="rst-val" id="rstBrightVal">${escN(String(s.brightness))}%</div>
        <div class="rst-range">
          <input type="range" id="rstBrightSlider" min="60" max="115" step="1" value="${escN(String(s.brightness))}">
        </div>
      </div>
      <div class="reader-set-row">
        <label>区宽</label>
        <div class="rst-segs">
          ${[['narrow', '窄'], ['normal', '标准'], ['wide', '宽']].map(([v, n]) => `<button class="rst-seg ${s.readWidth === v ? 'active' : ''}" data-w="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="reader-set-row">
        <label>段距</label>
        <div class="rst-segs">
          ${[['compact', '紧凑'], ['normal', '标准'], ['relaxed', '宽松']].map(([v, n]) => `<button class="rst-seg ${s.paraSpace === v ? 'active' : ''}" data-ps="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="reader-set-row">
        <label>字重</label>
        <div class="rst-segs">
          ${[['normal', '常规'], ['medium', '中等'], ['bold', '加粗']].map(([v, n]) => `<button class="rst-seg ${s.fontWeight === v ? 'active' : ''}" data-fw="${v}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="reader-set-row">
        <label>首行缩进</label>
        <button class="rst-toggle ${s.indent ? 'on' : ''}" id="rstIndent">${s.indent ? '已开启' : '已关闭'}</button>
      </div>
      <div class="reader-set-row">
        <label>记忆进度</label>
        <button class="rst-toggle ${s.remember ? 'on' : ''}" id="rstRemember">${s.remember ? '已开启' : '已关闭'}</button>
      </div>
    </div>`;
}

function toggleNReaderSettings(show) {
  const panel = document.getElementById('readerSettings');
  if (!panel) return;
  if (show === undefined) show = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  // 联动：设置打开时加宽右侧边栏容纳面板（面板在固定侧边栏内，无需滚动定位）
  const sec = document.getElementById('npage-reader');
  if (sec) sec.classList.toggle('settings-open', !!show);
}

function gotoNChapter(idx) {
  const r = novelState.reading;
  if (!r) return;
  const max = novelState.chapters.length - 1;
  if (idx < 0 || idx > max) { toastN('已到末尾或开头'); return; }
  r.idx = idx;
  loadNChapter();
}
function onNPrev() { if (novelState.reading) gotoNChapter(novelState.reading.idx - 1); }
function onNNext() { if (novelState.reading) gotoNChapter(novelState.reading.idx + 1); }

function onNProgress() {
  const r = novelState.reading;
  if (!r || !novelState.chapters.length) return;
  const max = novelState.chapters.length;
  const overlay = document.createElement('div');
  overlay.className = 'reader-jump';
  overlay.innerHTML = `
    <div class="reader-jump-box">
      <div class="reader-jump-head">跳转到章节（1 - ${max}）</div>
      <div class="reader-jump-input"><input type="number" id="rjInput" min="1" max="${max}" value="${r.idx + 1}"></div>
      <div class="reader-jump-foot">
        <button class="btn-ghost" id="rjCancel">取消</button>
        <button class="btn-primary" id="rjGo">跳转</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#rjCancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#rjGo').addEventListener('click', () => {
    const n = parseInt(overlay.querySelector('#rjInput').value, 10);
    if (!n || n < 1 || n > max) { toastN('章节号无效'); return; }
    overlay.remove();
    gotoNChapter(n - 1);
  });
  const inp = overlay.querySelector('#rjInput');
  inp.focus(); inp.select();
}

function onNCatalog() {
  const r = novelState.reading;
  if (!r || !novelState.chapters.length) return;
  const overlay = document.createElement('div');
  overlay.className = 'reader-catalog';
  const list = novelState.chapters.map((c, i) =>
    `<div class="rc-item ${i === r.idx ? 'active' : ''}" data-ci="${i}"><span class="rc-idx">${i + 1}</span>${escN(c.name)}</div>`).join('');
  overlay.innerHTML = `
    <div class="reader-catalog-panel">
      <div class="reader-catalog-head"><span>目录（${novelState.chapters.length} 章）</span><button class="reader-set-close" id="rcClose">×</button></div>
      <div class="reader-catalog-list">${list}</div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#rcClose').addEventListener('click', () => overlay.remove());
  overlay.querySelectorAll('.rc-item').forEach((it) => it.addEventListener('click', () => {
    const i = parseInt(it.dataset.ci, 10);
    overlay.remove();
    if (i !== r.idx) gotoNChapter(i);
  }));
  const cur = overlay.querySelector('.rc-item.active');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

/* ============================================================
   书架
   ============================================================ */
function renderNShelf() {
  const grid = document.getElementById('shelfGrid');
  const empty = document.getElementById('shelfEmpty');
  const tabs = document.getElementById('shelfTabs');
  const hist = getNHistory();
  const fav = novelState.shelf.filter((b) => hist[b.source + ':' + b.id]);
  if (tabs) {
    tabs.innerHTML = `
      <button class="shelf-tab ${novelState.shelfTab !== 'fav' ? 'active' : ''}" data-stab="all">全部（${novelState.shelf.length}）</button>
      <button class="shelf-tab ${novelState.shelfTab === 'fav' ? 'active' : ''}" data-stab="fav">阅读中（${fav.length}）</button>`;
  }
  const list = novelState.shelfTab === 'fav' ? fav : novelState.shelf;
  if (grid) grid.innerHTML = '';
  renderNBooks(grid, list);
  if (empty) empty.classList.toggle('hidden', list.length > 0);
  renderNReading();
}

function toggleNShelf() {
  const d = novelState.currentDetail;
  if (!d) return;
  const i = novelState.shelf.findIndex((b) => b.source === d.source && String(b.id) === String(d.id));
  if (i >= 0) { novelState.shelf.splice(i, 1); toastN('已移出书架'); }
  else {
    novelState.shelf.unshift({
      source: d.source, id: String(d.id), title: d.title, author: d.author,
      cover: d.cover, category: d.category, status: d.status,
      srcName: d.srcName || '', read: d.read || { id: String(d.id) }, entry: 'detail', ts: Date.now()
    });
    toastN('已加入书架');
  }
  saveJSON(N_SHELF_KEY, novelState.shelf);
  // 只更新书架按钮文字，不再重建详情页 DOM：
  // 重建会清空 #ndetailCatalog 目录容器且不会自动重新加载，导致目录消失
  const btn = document.getElementById('nToggleShelf');
  if (btn) {
    const nowIn = novelState.shelf.some((b) => b.source === d.source && String(b.id) === String(d.id));
    btn.textContent = nowIn ? '移出书架' : '加入书架';
  }
  if (novelState.page === 'shelf') renderNShelf();
}

function renderNReading() {
  const grid = document.getElementById('readingGrid');
  const section = document.getElementById('readingSection');
  if (!grid) return;
  const hist = getNHistory();
  const items = Object.keys(hist).map((k) => hist[k]).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!items.length) { if (section) section.style.display = 'none'; grid.innerHTML = ''; return; }
  if (section) section.style.display = '';
  grid.innerHTML = items.slice(0, 12).map((r) => {
    const title = r.bookTitle || '未知';   // 历史记录中 title 为章节名，不可作书名
    const sub = r.cid != null ? `读到：${r.title || '第' + (r.idx + 1) + '章'}` : '';
    const cover = r.cover || IMG_FALLBACK_N;
    return `<div class="ncard nreading" data-src="${escN(r.source)}" data-id="${escN(r.id)}" data-idx="${escN(Number.isInteger(r.idx) ? r.idx : 0)}" data-cover="${escN(r.cover || '')}" data-author="${escN(r.author || '')}">
      <div class="ncard-cover">
        <img src="${escN(cover)}" alt="${escN(title)}" loading="lazy" onerror="this.onerror=null;this.src='${IMG_FALLBACK_N}'">
        <div class="ncard-shade"></div>
        <span class="ncard-state st-anime">继续阅读</span>
      </div>
      <div class="ncard-meta">
        <div class="ncard-title">${escN(title)}</div>
        ${sub ? `<div class="ncard-sub">${escN(sub)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ============================================================
   设置页
   ============================================================ */
function renderNThemes() {
  const box = document.getElementById('nTheme');
  if (!box) return;
  const themes = [['dark', '夜间', '#0d0d0f'], ['sepia', '羊皮纸', '#f3e9d2'], ['light', '日间', '#f6f6f6']];
  box.innerHTML = themes.map(([v, n, c]) => `
    <button class="theme-swatch ${novelState.settings.theme === v ? 'active' : ''}" data-theme="${v}" style="--sw:${c}">
      <span class="sw-dot"></span><span>${n}</span>
    </button>`).join('');
}

async function renderNAccount() {
  const box = document.getElementById('novelAccount');
  if (!box) return;
  // 对支持登录的源展示账号面板
  const metas = novelState.sources.filter((s) => s.supportsLogin);
  if (!metas.length) {
    box.innerHTML = '<div class="novel-account-empty">当前没有需要登录的数据源，所有源均可直接浏览。</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    let st = null;
    try { st = await nIpc().status(m.id); } catch (e) { /* ignore */ }
    html += `<div class="novel-account-item" data-src="${escN(m.id)}">
      <div class="novel-account-name">${escN(m.name)}</div>`;
    if (st && st.loggedIn) {
      html += `<div class="novel-account-state ok">已登录 <b>${escN(st.username)}</b><div class="nl-sub">UID ${escN(st.uid || '-')}</div></div>
        <div class="novel-account-actions"><button class="btn-ghost" data-logout="${escN(m.id)}">退出登录</button></div>`;
    } else {
      let regLink = '';
      if (m.registerUrl) {
        regLink = `<span class="nl-sub nl-reg-link" data-reg="${escN(m.id)}" style="cursor:pointer;text-decoration:underline;margin-left:6px;">没有账号？去注册</span>`;
      }
      html += `<div class="novel-account-state">未登录<div class="nl-sub">账号仅在本地保存，不会上传</div></div>
        <form class="novel-account-form" data-login="${escN(m.id)}">
          <input type="text" name="u" placeholder="用户名 / 邮箱" autocomplete="username" required>
          <input type="password" name="p" placeholder="密码" autocomplete="current-password" required>
          <button class="btn-primary" type="submit">登录</button>${regLink}
        </form>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

async function renderNSettings() {
  refreshNSettingsControls();
  renderNSetSource();
  await renderNAccount();
}

/* ============================================================
   事件绑定
   ============================================================ */
function cardNearest(el) {
  return el.closest ? el.closest('.ncard') : null;
}

/* ============================================================
   下拉刷新（支持触屏 + 鼠标拖拽）
   ============================================================ */
function initNPtrRefresh() {
  const main = document.getElementById('novelMain');
  const ptr = document.getElementById('novelPtr');
  if (!main || !ptr) return;
  const THRESHOLD = 64;
  const text = document.getElementById('nptrText');
  let state = 0;            // 0 空闲 / 1 拉动中 / 2 刷新中
  let startY = 0;
  let dist = 0;
  let dragging = false;

  function setPull(d) {
    dist = Math.max(0, Math.min(d, 110));
    ptr.style.transform = 'translateY(' + dist + 'px)';
    ptr.classList.toggle('ready', dist >= THRESHOLD);
    if (text) text.textContent = dist >= THRESHOLD ? '松开刷新' : '下拉刷新';
  }
  function endPull() {
    if (state !== 1) return;
    dragging = false;
    if (dist >= THRESHOLD) {
      state = 2;
      ptr.style.transition = 'transform .22s ease';
      ptr.style.transform = 'translateY(64px)';
      ptr.classList.add('loading');
      if (text) text.textContent = '刷新中…';
      doNPtrRefresh().finally(() => {
        state = 0;
        ptr.classList.remove('loading', 'ready');
        ptr.style.transition = 'transform .22s ease';
        ptr.style.transform = '';
        if (text) text.textContent = '下拉刷新';
      });
    } else {
      state = 0;
      ptr.style.transition = 'transform .22s ease';
      ptr.style.transform = '';
    }
  }
  function canPull() { return state !== 2 && main.scrollTop <= 0; }

  // 触屏
  main.addEventListener('touchstart', (e) => {
    if (!canPull()) return;
    const t = e.touches[0]; if (!t) return;
    state = 1; startY = t.clientY; dist = 0;
    ptr.style.transition = 'none';
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (state !== 1) return;
    const t = e.touches[0]; if (!t) return;
    const dy = t.clientY - startY;
    if (dy <= 0) { setPull(0); return; }
    setPull(dy * 0.5);
  }, { passive: true });
  main.addEventListener('touchend', endPull);
  main.addEventListener('touchcancel', endPull);

  // 鼠标拖拽（桌面端）
  main.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !canPull()) return;
    if (e.target.closest('button, a, input, select, textarea, .nptr')) return;
    state = 1; startY = e.clientY; dist = 0;
    ptr.style.transition = 'none';
    dragging = true;
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging || state !== 1) return;
    const dy = e.clientY - startY;
    if (dy <= 0) { setPull(0); return; }
    setPull(dy * 0.5);
  });
  document.addEventListener('mouseup', () => {
    if (dragging) endPull();
  });
}

// 按当前页面分发下拉刷新动作
async function doNPtrRefresh() {
  const page = novelState.page;
  try {
    switch (page) {
      case 'home':
        return await loadNHome(true);
      case 'cat':
        novelState.catTabs = [];   // 同时强制重拉分类列表
        return await loadNCat(true, true);
      case 'search': {
        const inp = document.getElementById('novelSearchInput');
        const kw = (inp && inp.value.trim()) || novelState.searchKw || '';
        if (kw) {
          if (inp) inp.value = kw;
          return await doNSearch();
        }
        showNSearchIdle();
        return;
      }
      case 'shelf':
        renderNShelf();
        return;
      case 'detail': {
        const d = novelState.currentDetail;
        if (d) {
          novelState.catalog = null;
          return await loadNDetailCatalog(d);
        }
        return;
      }
      case 'reader': {
        const r = novelState.reading;
        const c = novelState.chapters && novelState.chapters[r.idx];
        if (!r || !c) return;
        const ckey = r.source + ':' + (r.read ? r.read.id : r.id) + ':' + c.cid;
        nChapterCache.delete(ckey);   // 清除当前章缓存，强制重新抓取
        return await loadNChapter();
      }
    }
  } catch (e) { /* 各加载函数内部已处理错误展示 */ }
}

function bindNovelEvents() {
  if (novelBound) return;
  novelBound = true;
  const app = document.getElementById('novelApp');
  if (!app) return;

  // 返回动漫
  const back = document.getElementById('backToAnime');
  if (back) back.addEventListener('click', exitNovel);

  // 下拉刷新
  initNPtrRefresh();

  // 侧边栏导航（小说页）：每次点击都强制刷新目标页（清缓存重载）
  $$N('.novel-sidebar .nav-item').forEach((n) => {
    n.addEventListener('click', () => {
      const target = n.dataset.npage;
      // 切到首页/分类时清空已加载标记，保证每次进入都拉最新数据
      if (target === 'home') novelState.homeLoaded = false;
      if (target === 'cat') novelState.catLoaded = false;
      novelState.prevPage = novelState.page;
      switchNPage(target);
      syncNPageLoad();
    });
  });

  // 小说源切换（设置页 src-opt）
  app.addEventListener('click', (e) => {
    const pill = e.target.closest('#novelSetSource .src-opt');
    if (pill) { setNSource(pill.dataset.src); return; }
    const rankTab = e.target.closest('.nrank-tab');
    if (rankTab) { onNRankTab(parseInt(rankTab.dataset.ridx, 10)); return; }
    const catTab = e.target.closest('.novel-cat-tab');
    if (catTab) { onNCatTab(catTab.dataset.cat); return; }
    const themeSw = e.target.closest('.theme-swatch');
    if (themeSw) { novelState.settings.theme = themeSw.dataset.theme; applyNSettingsChange(); return; }
    const shelfTab = e.target.closest('.shelf-tab');
    if (shelfTab) { novelState.shelfTab = shelfTab.dataset.stab || 'all'; renderNShelf(); return; }

    // 详情页目录：卷头折叠/展开
    const volHead = e.target.closest('.ndcat-vol-head');
    if (volHead) {
      const volEl = volHead.closest('.ndcat-vol');
      const body = volEl ? volEl.querySelector('.ndcat-vol-body') : null;
      const tgl = volHead.querySelector('.ndcat-vol-toggle');
      if (body) {
        const collapsed = body.classList.toggle('collapsed');
        if (tgl) tgl.textContent = collapsed ? '展开' : '收起';
      }
      return;
    }
    // 详情页目录：点击章节跳转阅读
    const chEl = e.target.closest('.ndcat-ch');
    if (chEl) {
      const d = novelState.currentDetail;
      const idx = parseInt(chEl.dataset.ci, 10);
      if (d && !Number.isNaN(idx) && novelState.chapters && idx >= 0 && idx < novelState.chapters.length) {
        openNReader(d.source, d, idx);
      }
      return;
    }

    // 详情按钮：开始阅读 / 加入书架
    if (e.target.id === 'nStartRead') {
      const d = novelState.currentDetail;
      if (d) openNReader(d.source, d, null);
      return;
    }
    if (e.target.id === 'nToggleShelf') { toggleNShelf(); return; }

    // 登录横幅按钮
    if (e.target.id === 'nlLogin') { switchNPage('settings'); syncNPageLoad(); return; }
    if (e.target.id === 'nlLogout') {
      nIpc().logout(novelState.source).then(() => { toastN('已退出登录'); renderLoginBanner(); renderNAccount(); }).catch((er) => toastN(er.message));
      return;
    }

    // 阅读器面板按钮
    if (e.target.id === 'readerSetClose') { toggleNReaderSettings(false); return; }
    const rstSeg = e.target.closest('.rst-seg');
    if (rstSeg) {
      if (rstSeg.dataset.lh) novelState.settings.lineHeight = parseFloat(rstSeg.dataset.lh);
      if (rstSeg.dataset.ff) novelState.settings.fontFamily = rstSeg.dataset.ff;
      if (rstSeg.dataset.theme) novelState.settings.theme = rstSeg.dataset.theme;
      if (rstSeg.dataset.w) novelState.settings.readWidth = rstSeg.dataset.w;
      if (rstSeg.dataset.ps) novelState.settings.paraSpace = rstSeg.dataset.ps;
      if (rstSeg.dataset.fw) novelState.settings.fontWeight = rstSeg.dataset.fw;
      applyNSettingsChange(); renderNReaderSettings();
      return;
    }
    if (e.target.id === 'rstIndent') { novelState.settings.indent = !novelState.settings.indent; applyNSettingsChange(); renderNReaderSettings(); return; }
    if (e.target.id === 'rstRemember') { novelState.settings.remember = !novelState.settings.remember; applyNSettingsChange(); renderNReaderSettings(); return; }
    const rstToggle = e.target.closest('.rst-toggle');
    if (rstToggle) { /* 已由上方具体 id 处理 */ }

    // 设置页：退出登录
    const logoutBtn = e.target.closest('[data-logout]');
    if (logoutBtn) { nIpc().logout(logoutBtn.dataset.logout).then(() => { toastN('已退出登录'); renderNAccount(); }).catch((er) => toastN(er.message)); return; }

    // 设置页：去注册（打开数据源注册页）
    const regLink = e.target.closest('[data-reg]');
    if (regLink) {
      const meta = novelState.sources.find((s) => s.id === regLink.dataset.reg);
      const url = meta && meta.registerUrl ? meta.registerUrl : '';
      if (!url) { toastN('该数据源未提供注册链接'); return; }
      nIpc().openExternal(url).then(() => { toastN('已在浏览器打开注册页'); }).catch((er) => toastN(er.message));
      return;
    }

    // 卡片点击（详情/继续阅读）
    const card = cardNearest(e.target);
    if (card && card.dataset.entry !== 'detail') {
      // 仅 detail 卡片应进入详情；继续阅读卡片单独处理
    }
  });

  // 登录提交（设置页表单）—— 委托到 novelAccount
  const account = document.getElementById('novelAccount');
  if (account) {
    account.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target.closest('[data-login]');
      if (!form) return;
      const src = form.dataset.login;
      const u = form.elements.u.value.trim();
      const p = form.elements.p.value;
      if (!u || !p) { toastN('请输入账号密码'); return; }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = '登录中…';
      try {
        const res = await nIpc().login(src, u, p);
        if (res && res.ok) {
          toastN('登录成功');
          novelState.source = src; saveJSON(N_SOURCE_KEY, src);
          renderNAccount(); renderLoginBanner();
          loadNHome(true);
        } else {
          toastN((res && res.msg) || '登录失败');
        }
      } catch (er) {
        toastN(er.message || '登录失败');
      }
      btn.disabled = false; btn.textContent = '登录';
    });
  }

  // 卡片点击（进入详情 / 继续阅读）
  app.addEventListener('click', (e) => {
    const card = cardNearest(e.target);
    if (!card) return;
    const src = card.dataset.src;
    const id = card.dataset.id;
    if (card.dataset.entry !== 'detail' && card.hasAttribute('data-idx') && !card.dataset.cid) {
      // 继续阅读卡片
      const idx = parseInt(card.dataset.idx, 10);
      const cover = card.dataset.cover || '';
      const author = card.dataset.author || '';
      const hist = getNHistory();
      const rec = hist[src + ':' + id] || {};
      openNReader(src, { id, title: rec.bookTitle || '', cover: cover || rec.cover || '', read: rec.read || { id } }, Number.isInteger(idx) ? idx : null);
      return;
    }
    if (card.dataset.entry === 'detail' || card.dataset.cid === undefined) {
      openNDetail(src, id);
    }
  });

  // 详情返回
  const dBack = document.getElementById('novelDetailBack');
  if (dBack) dBack.addEventListener('click', () => { switchNPage(novelState.prevPage || 'home'); syncNPageLoad(); });

  // 阅读器返回 / 设置 / 目录 / 翻章 / 进度
  const rBack = document.getElementById('readerBack');
  if (rBack) rBack.addEventListener('click', () => {
    toggleNReaderSettings(false); // 离开阅读器时收起设置面板
    const cur = novelState.currentDetail;
    const rd = novelState.reading;
    if (rd && cur && cur.source === rd.source && String(cur.id) === String(rd.id)) {
      switchNPage('detail');
    } else if (rd) {
      openNDetail(rd.source, rd.id);   // 从继续阅读卡片进入时无详情缓存，先补加载
    } else {
      switchNPage(novelState.prevPage || 'home');
      syncNPageLoad();
    }
  });
  const rSet = document.getElementById('readerSettingBtn');
  if (rSet) rSet.addEventListener('click', () => { renderNReaderSettings(); toggleNReaderSettings(); });
  const rCat = document.getElementById('readerCatalogBtn');
  if (rCat) rCat.addEventListener('click', onNCatalog);
  const rPrev = document.getElementById('readerPrev');
  if (rPrev) rPrev.addEventListener('click', onNPrev);
  const rNext = document.getElementById('readerNext');
  if (rNext) rNext.addEventListener('click', onNNext);
  const rProg = document.getElementById('readerProgressBtn');
  if (rProg) rProg.addEventListener('click', onNProgress);

  // 阅读器设置面板：字号滑条
  const slider = document.getElementById('rstFontSlider');
  const setPanel = document.getElementById('readerSettings');
  if (setPanel) {
    setPanel.addEventListener('input', (e) => {
      if (e.target.id === 'rstFontSlider') {
        novelState.settings.fontSize = parseInt(e.target.value, 10);
        const v = document.getElementById('rstFontSize');
        if (v) v.textContent = novelState.settings.fontSize + 'px';
        applyNSettingsChange();
      } else if (e.target.id === 'rstBrightSlider') {
        novelState.settings.brightness = parseInt(e.target.value, 10);
        const v = document.getElementById('rstBrightVal');
        if (v) v.textContent = novelState.settings.brightness + '%';
        applyNSettingsChange();
      }
    });
  }

  // 设置页控件
  const nFS = document.getElementById('nFontSize');
  if (nFS) nFS.addEventListener('input', () => {
    novelState.settings.fontSize = parseInt(nFS.value, 10);
    applyNSettingsChange();
  });
  $$N('#nLineHeight .seg-opt').forEach((o) => o.addEventListener('click', () => {
    novelState.settings.lineHeight = parseFloat(o.dataset.v);
    applyNSettingsChange();
  }));
  $$N('#nFontFamily .seg-opt').forEach((o) => o.addEventListener('click', () => {
    novelState.settings.fontFamily = o.dataset.v;
    applyNSettingsChange();
  }));
  $$N('#nReadWidth .seg-opt').forEach((o) => o.addEventListener('click', () => {
    novelState.settings.readWidth = o.dataset.v;
    applyNSettingsChange();
  }));
  $$N('#nParaSpace .seg-opt').forEach((o) => o.addEventListener('click', () => {
    novelState.settings.paraSpace = o.dataset.v;
    applyNSettingsChange();
  }));
  $$N('#nFontWeight .seg-opt').forEach((o) => o.addEventListener('click', () => {
    novelState.settings.fontWeight = o.dataset.v;
    applyNSettingsChange();
  }));
  $$N('#nGridDensity .seg-opt').forEach((o) => o.addEventListener('click', () => {
    novelState.settings.gridDensity = o.dataset.v;
    applyNSettingsChange();
  }));
  const nBr = document.getElementById('nBrightness');
  if (nBr) nBr.addEventListener('input', () => {
    novelState.settings.brightness = parseInt(nBr.value, 10);
    applyNSettingsChange();
  });
  const nCr = document.getElementById('nCoverRadius');
  if (nCr) nCr.addEventListener('input', () => {
    novelState.settings.coverRadius = parseInt(nCr.value, 10);
    applyNSettingsChange();
  });
  const nInd = document.getElementById('nIndent');
  if (nInd) nInd.addEventListener('change', () => { novelState.settings.indent = nInd.checked; applyNSettingsChange(); });
  const nRem = document.getElementById('nRemember');
  if (nRem) nRem.addEventListener('change', () => { novelState.settings.remember = nRem.checked; applyNSettingsChange(); });

  // 数据管理按钮
  const clrShelf = document.getElementById('nClearShelf');
  if (clrShelf) clrShelf.addEventListener('click', () => {
    novelState.shelf = [];
    saveJSON(N_SHELF_KEY, []);
    renderNShelf();
    toastN('书架已清空');
  });
  const clrHist = document.getElementById('nClearHistory');
  if (clrHist) clrHist.addEventListener('click', () => {
    saveNHistory({});
    novelState.reading = null;
    saveJSON(N_READING_KEY, null);
    renderNShelf();
    toastN('阅读记录已清空');
  });
  const rstSet = document.getElementById('nResetSettings');
  if (rstSet) rstSet.addEventListener('click', () => {
    novelState.settings = Object.assign({}, DEFAULT_N_SET);
    saveJSON(N_SETTINGS_KEY, novelState.settings);
    applyNSettingsChange();
    toastN('已恢复默认设置');
  });
  const clrCache = document.getElementById('nClearCache');
  if (clrCache) clrCache.addEventListener('click', () => {
    saveJSON(N_SHELF_KEY, []);
    saveNHistory({});
    saveJSON(N_READING_KEY, null);
    resetNHistoryCache();
    novelState.shelf = [];
    novelState.reading = null;
    novelState.settings = Object.assign({}, DEFAULT_N_SET);
    saveJSON(N_SETTINGS_KEY, novelState.settings);
    novelState.homeLoaded = false;
    novelState.catLoaded = false;
    applyNSettingsChange();
    renderNShelf();
    toastN('本地缓存已清除');
  });

  // 搜索
  const sBtn = document.getElementById('novelSearchBtn');
  const sInp = document.getElementById('novelSearchInput');
  if (sBtn) sBtn.addEventListener('click', doNSearch);
  if (sInp) sInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doNSearch(); });
  // 搜索历史：点击标签填充关键词并搜索，点击"清空"清除全部历史
  const sHistWrap = document.getElementById('novelSearchHistory');
  if (sHistWrap) {
    sHistWrap.addEventListener('click', (e) => {
      const tag = e.target.closest('.sg-tag');
      if (!tag) return;
      if (tag.id === 'novelSearchHistoryClear') {
        clearNSearchHistory();
        renderNSearchHistory();
        return;
      }
      const kw = tag.dataset.kw;
      if (!kw) return;
      const inp = document.getElementById('novelSearchInput');
      if (inp) { inp.value = kw; doNSearch(); }
    });
  }

  // 加载更多
  const more = document.getElementById('novelMore');
  if (more) more.addEventListener('click', () => loadNHome(false, true));
  const catMore = document.getElementById('novelCatMore');
  if (catMore) catMore.addEventListener('click', () => loadNCatGrid());

  // 滚动到底自动加载（首页 / 分类）——rAF 节流，避免高频滚动重复触发
  const main = document.getElementById('novelMain');
  if (main) {
    let scrollTick = false;
    const onNScroll = () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        scrollTick = false;
        if (novelState.page === 'home' && !novelState.rankEnded && !novelState.homeLoading) {
          if (main.scrollTop + main.clientHeight >= main.scrollHeight - 400) loadNHome(false, true);
        } else if (novelState.page === 'cat' && !novelState.catEnded && !novelState.catLoading) {
          if (main.scrollTop + main.clientHeight >= main.scrollHeight - 400) loadNCatGrid();
        }
      });
    };
    main.addEventListener('scroll', onNScroll, { passive: true });
  }

  // 阅读器键盘快捷键：← 上一章 / → 下一章（输入框内不拦截）
  document.addEventListener('keydown', (e) => {
    if (novelState.mode !== 'novel' || novelState.page !== 'reader' || !novelState.reading) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onNPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onNNext(); }
  });
}

/* ============================================================
   启动：恢复模式
   ============================================================ */
function initNovelMode() {
  const mode = 'novel';
  let saved = 'anime';
  try { saved = localStorage.getItem('maoe.mode') || 'anime'; } catch (e) { /* ignore */ }
  if (saved === mode) {
    // 每次进入小说模式：若当前源是 homeIsSearch，默认进入搜索页（首载由 ensureNovelLoaded 兜底）
    if (novelState.meta && novelState.meta.homeIsSearch) novelState.page = 'search';
    else novelState.page = 'home';
    enterNovel();
  }
  // 若主进程 IPC 未就绪，等待重试
  setTimeout(() => {
    if (!novelLoaded) { try { ensureNovelLoaded(); } catch (e) { /* ignore */ } }
  }, 600);
}

// 在 DOM 就绪后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNovelMode);
} else {
  initNovelMode();
}