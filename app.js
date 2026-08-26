// app.js - Maoe PC 客户端主逻辑 v2
'use strict';

const APP_VERSION = '1.4.3';

// 更新检查：GitHub 仓库与版本工具
const GITHUB_REPO = 'Care0721/Maoe';
// 固定读取 tag 为 Maoe 的 release（用户约定每次更新都在该 tag 下上传新安装包）
const GITHUB_TAG = 'Maoe';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${GITHUB_TAG}`;

function semverCompare(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// 从安装包文件名提取版本号。
// 约定：Maoe_setup_1.2.3.exe / Maoe_setup_1.2.3_x64.exe；
// 同时兼容历史命名 Maoe-Setup-1.2.3.exe。仅匹配以 Maoe 打头的文件，避免误判。
function versionFromFileName(name) {
  const m = String(name || '').match(
    /Maoe[\s_-]*setup[\s_-]*(\d+(?:\.\d+){1,3})(?:[\s_-]\w+)*\.(?:exe|msi|zip|7z|rar)$/i
  );
  return m ? m[1] : null;
}

/* ================= 工具函数 ================= */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const mainEl = $('#main'); // 唯一滚动容器

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 图片占位（加载失败时）
const IMG_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="100%" height="100%" fill="#141414"/><text x="50%" y="50%" fill="#5f5f5f" font-size="14" text-anchor="middle" font-family="sans-serif">暂无图片</text></svg>'
);

function fullImg(src) {
  if (!src) return IMG_FALLBACK;
  if (src.startsWith('http') || src.startsWith('data:')) return src;
  return 'https://img-app.bubuman.com' + src;
}

/* ================= 设置系统 ================= */
const SETTINGS_KEY = 'mengmoe.settings.v1';
const DEFAULT_SETTINGS = {
  defaultSource: 'yh',       // 默认数据源 id（樱花源）
  autoNext: true,            // 自动连播下一集
  bannerAuto: true,          // 轮播自动播放
  muted: false,              // 播放器默认静音
  glass: 'high',             // 玻璃光效 high / low / off
  minimal: false,            // 简洁模式（隐藏副标题/装饰）
  descDefaultExpand: true,   // 简介默认展开
  descExpandButton: true,    // 显示简介展开按钮
  rate: 1,                   // 默认播放倍速
  rememberProgress: true,    // 记忆播放进度（续播）
  autoHideControls: false,   // 播放器控件自动隐藏
  preloadImages: true,       // 列表图片懒加载
  volume: 1,                 // 默认音量 0-1
  accent: '#ffffff',         // 强调色
  scale: 1,                  // 界面缩放 0.85-1.2
};
// 全局可变的运行时设置（含 localStorage 持久化）
const SETTINGS = Object.assign({}, DEFAULT_SETTINGS, (() => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch (e) { return {}; }
})());

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); }
  catch (e) { /* ignore */ }
}

// 应用外观类设置到 DOM
function applyAppearance() {
  const root = document.documentElement;
  root.classList.remove('glass-low', 'glass-off', 'minimal');
  if (SETTINGS.glass === 'low') root.classList.add('glass-low');
  else if (SETTINGS.glass === 'off') root.classList.add('glass-off');
  if (SETTINGS.minimal) root.classList.add('minimal');
  // 强调色：驱动按钮/选中态/进度条的着色
  root.style.setProperty('--accent', SETTINGS.accent || '#ffffff');
  root.style.setProperty('--accent-soft', hexToRgba(SETTINGS.accent || '#ffffff', 0.18));
  // 界面缩放
  root.style.setProperty('--ui-scale', String(SETTINGS.scale || 1));
}

// hex 颜色转 rgba（用于强调色柔和光晕）
function hexToRgba(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  if (isNaN(n)) return 'rgba(255,255,255,' + a + ')';
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ================= 全局状态 ================= */
const state = {
  page: 'home',            // 当前页面
  catType: 'lm1',          // 当前分类类型
  catPage: 1,              // 当前分类页码
  catLoading: false,       // 分类加载锁
  catEnded: false,         // 分类是否到底
  catFilters: { year: '', area: '', sort: '' }, // 分类筛选：年份/地区/排序
  detailData: null,        // 当前详情数据 {meta, vod1, vod2}
  curSource: 0,            // 当前播放源 0=vod1 1=vod2
  curEp: 0,                // 当前集数下标
  bannerIdx: 0,
  bannerCount: 0,
  bannerTimer: null,
  hls: null,               // hls.js 实例
  fallbackUsed: false,     // 是否已自动回退过备源（防止循环回退）
};

/* ================= 加载遮罩 ================= */
let loadingCount = 0;
function showLoading(text) {
  loadingCount++;
  $('#loadingText').textContent = text || '加载中…';
  $('#loadingMask').classList.add('show');
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) $('#loadingMask').classList.remove('show');
}

function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ================= 更新检查 ================= */
// 检查 GitHub 上 tag 为 Maoe 的 release，遍历其安装包文件名提取版本号，
// 取最高者与本地版本对比（tag 名本身是 "Maoe"，不含版本号，版本号在文件名里）。
// opts.onResult({ state, latest, url }) 用于设置页「关于 Maoe」更新状态展示；
// state: 'loading' | 'latest' | 'new' | 'error'
async function checkForUpdates(opts = {}) {
  const { silent = false, onResult } = opts;
  onResult && onResult({ state: 'loading' });
  try {
    const data = await getJson(GITHUB_API, 2, 10000);
    if (!data || !Array.isArray(data.assets)) throw new Error('bad response');
    // 遍历资产文件名，找出版本号最大的安装包
    let latest = null;
    let downloadUrl = data.html_url;
    for (const asset of data.assets) {
      const v = versionFromFileName(asset.name);
      if (!v) continue;
      if (!latest || semverCompare(v, latest) > 0) {
        latest = v;
        downloadUrl = asset.browser_download_url || asset.url || data.html_url;
      }
    }
    if (!latest) throw new Error('no versioned asset');
    const cmp = semverCompare(latest, APP_VERSION);
    if (cmp > 0) {
      showUpdateModal({
        currentVer: APP_VERSION,
        latestVer: latest,
        downloadUrl,
        releaseUrl: data.html_url,
        notes: (data.body || '').slice(0, 300)
      });
      onResult && onResult({ state: 'new', latest, url: downloadUrl });
    } else {
      onResult && onResult({ state: 'latest', latest });
      if (!silent) toast('已是最新版本 v' + APP_VERSION);
    }
  } catch (e) {
    onResult && onResult({ state: 'error' });
    if (!silent) toast('检查更新失败，请稍后再试');
  }
}

// 新版本弹窗（玻璃风格）
function showUpdateModal(info) {
  let overlay = $('#updateModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'updateModal';
  overlay.className = 'update-overlay';
  overlay.innerHTML = `
    <div class="update-card">
      <div class="update-badge">NEW</div>
      <h3 class="update-title">发现新版本</h3>
      <p class="update-sub">当前 v${info.currentVer}，可升级到 v${info.latestVer}</p>
      ${info.notes ? `<div class="update-notes">${escNotes(info.notes)}</div>` : ''}
      <div class="update-actions">
        <button class="btn-ghost" id="updateLater">以后再说</button>
        <a class="btn-primary update-dl" id="updateDownload" href="${info.downloadUrl}" target="_blank" rel="noopener">下载更新</a>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismissUpdate();
  });
  $('#updateLater').addEventListener('click', dismissUpdate);
  const dl = $('#updateDownload');
  if (dl) {
    dl.addEventListener('click', () => {
      dismissUpdate();
      toast('已打开下载页面');
    });
  }
  overlay.classList.add('show');
}
function dismissUpdate() {
  const overlay = $('#updateModal');
  if (!overlay) return;
  overlay.classList.remove('show');
  setTimeout(() => overlay.remove(), 250);
}
// 更新说明：HTML 转义并把换行渲染为 <br>
function escNotes(str) {
  return escapeHtml(String(str == null ? '' : str)).replace(/\n/g, '<br>');
}

// 设置页「关于 Maoe」的更新状态展示
function renderAboutUpdate(res) {
  const box = $('#aboutUpdate');
  const btn = $('#aboutCheck');
  if (!box) return;
  if (btn) {
    btn.disabled = res.state === 'loading';
    btn.textContent = res.state === 'loading' ? '检查中…' : '检查更新';
  }
  if (res.state === 'loading') {
    box.hidden = false;
    box.className = 'about-update';
    box.textContent = '正在检查更新…';
    return;
  }
  if (res.state === 'latest') {
    box.hidden = false;
    box.className = 'about-update is-latest';
    box.textContent = `已是最新版本 v${APP_VERSION}`;
    return;
  }
  if (res.state === 'new') {
    box.hidden = false;
    box.className = 'about-update is-new';
    box.innerHTML =
      `<span>发现新版本 v${escapeHtml(res.latest)}（当前 v${APP_VERSION}）</span>` +
      `<a class="btn-primary au-btn" href="${escapeHtml(res.url)}" target="_blank" rel="noopener">去下载</a>`;
    return;
  }
  // error
  box.hidden = false;
  box.className = 'about-update is-error';
  box.textContent = '检查更新失败，请稍后再试';
}
// 更新说明结束标记：避免与上方 escNotes 混淆

/* ================= 页面导航 ================= */
function showPage(name) {
  // 离开播放页时销毁播放器，避免后台继续缓冲
  if (state.page === 'player' && name !== 'player') {
    if (state.hls) { state.hls.destroy(); state.hls = null; }
    const v = $('#video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  }
  state.page = name;
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $$('#app .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  mainEl.scrollTop = 0; // 修复：滚动容器是 .main 而非 window
  if (name === 'category') ensureCategoryLoaded();
  if (name === 'settings') {
    if (typeof renderSetSource === 'function') renderSetSource();
    const av = $('#aboutVer');
    if (av) av.textContent = `v${APP_VERSION}`;
  }
  if (name === 'search') showSearchIdle();
}

/* ================= 卡片渲染（Animeko 风格：封面撑满 + 标题叠加） ================= */
function cardHtml(item) {
  const img = fullImg(item.src || item.pic);
  return `
  <div class="card" data-uid="${escapeHtml(item.uid)}">
    <div class="card-cover">
      <img src="${img}" alt="${escapeHtml(item.title)}" loading="lazy"
           onerror="this.onerror=null;this.src='${IMG_FALLBACK}'">
      ${item.inlz ? `<span class="card-status">${escapeHtml(item.inlz)}</span>` : ''}
      <div class="card-overlay">
        <div class="card-title">${escapeHtml(item.title)}</div>
        ${item.injq ? `<div class="card-tags">${escapeHtml(item.injq)}</div>` : ''}
      </div>
    </div>
  </div>`;
}

/* ================= 首页 ================= */
// 首页加载令牌：切换源/重新加载时自增，使在途的「全部动漫」翻页循环自动停止
let homeToken = 0;
async function loadHome() {
  const token = ++homeToken;
  showLoading('正在加载首页…');
  try {
    const { index: idx, hot } = await SRC.home();
    const res = idx.result || idx;

    // Banner 轮播（data0；项带 uid 时补源前缀，点击可进详情）
    renderBanner((res.data0 || []).map((b) => (b.uid ? { ...b, uid: SRC.pre(b.uid) } : b)));

    // 精选推荐（data2 + data3，先转统一卡片再加前缀去重，兼容不同源字段）
    const recList = [...(res.data2 || []), ...(res.data3 || [])];
    const seen = new Set();
    const uniq = [];
    for (const it of recList) {
      const card = SRC.prefixCard(it);
      if (!card.uid || seen.has(card.uid)) continue;
      seen.add(card.uid);
      uniq.push(card);
    }
    $('#recGrid').innerHTML = uniq.map(cardHtml).join('');

    // 全部动漫：对默认分类连续翻页抓取全部条目，去重后分批追加渲染
    loadAllAnime(seen, token);

    // 热门周榜
    const hotList = (hot && (hot.result || hot).list_data) || [];
    if (hotList.length) {
      $('#hotSection').style.display = 'block';
      $('#hotGrid').innerHTML = hotList.slice(0, 35).map((it) => cardHtml(SRC.prefixCard(it))).join('');
    } else {
      $('#hotSection').style.display = 'none';
    }

    // 公告
    const gg = res.gonggao;
    if (gg) toast(typeof gg === 'string' ? gg : (gg[0] || ''));
  } catch (e) {
    console.error('首页加载失败', e);
    $('#recGrid').innerHTML = `<div class="empty-hint">首页加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    hideLoading();
  }
}

// 首页「全部动漫」：对默认分类（日本动漫）翻页抓取，去重后分批追加到 #recGrid
async function loadAllAnime(seenSet, token) {
  const grid = $('#recGrid');
  const type = defaultCatType();
  const filters = { year: '', area: '', sort: '' };
  const loading = document.createElement('div');
  loading.className = 'grid-loading';
  loading.textContent = '正在加载全部动漫…';
  grid.appendChild(loading);
  const MAX_PAGES = 60; // 安全上限（每页约 20-30 部）
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (token !== homeToken) break; // 已重新加载首页，终止旧翻页
    try {
      const { list } = await SRC.category(type, page, filters);
      if (!list.length) break;
      const fresh = list.filter((c) => c.uid && !seenSet.has(c.uid));
      if (fresh.length) {
        grid.insertAdjacentHTML('beforeend', fresh.map(cardHtml).join(''));
        fresh.forEach((c) => seenSet.add(c.uid));
      }
      total += fresh.length;
      if (list.length < 20) break; // 不足一页 → 已到底
    } catch (e) {
      console.error('全部动漫翻页失败', e);
      break;
    }
  }
  loading.remove();
  if (!total) grid.insertAdjacentHTML('beforeend', '<div class="empty-hint">暂无更多作品</div>');
}

/* ---- Banner 轮播（优化：进度条 + 暂停/播放 + 悬停暂停） ---- */
let bannerPaused = false;
function goBanner(i) {
  const track = $('#bannerTrack');
  if (!track || !state.bannerCount) return;
  state.bannerIdx = (i + state.bannerCount) % state.bannerCount;
  track.style.transform = `translateX(-${state.bannerIdx * 100}%)`; // 修复：真正滑动切换
  $$('#bannerTrack .banner-slide').forEach((s, si) => s.classList.toggle('active', si === state.bannerIdx));
  $$('#bannerDots .banner-dot').forEach((d, di) => d.classList.toggle('active', di === state.bannerIdx));
  updateBannerProgress();
}

function updateBannerProgress() {
  const bar = $('#bannerProgress');
  if (!bar) return;
  const total = Math.max(1, state.bannerCount);
  const percent = ((state.bannerIdx + 1) / total) * 100;
  bar.style.width = percent + '%';
}

function renderBanner(banners) {
  const track = $('#bannerTrack');
  const dots = $('#bannerDots');
  if (!banners.length) {
    $('#bannerWrap').style.display = 'none';
    return;
  }
  state.bannerCount = banners.length;
  state.bannerIdx = 0;
  bannerPaused = false;
  track.innerHTML = banners.map((b, i) => `
    <div class="banner-slide ${i === 0 ? 'active' : ''}" data-uid="${escapeHtml(b.uid || '')}">
      <img src="${fullImg(b.url || b.src)}" alt="${escapeHtml(b.title)}"
           onerror="this.onerror=null;this.src='${IMG_FALLBACK}'">
      <div class="banner-info">
        <div class="banner-title">${escapeHtml(b.title)}</div>
        <div class="banner-tags"><span class="banner-tag">${escapeHtml(b.type === 'image' ? '推荐' : (b.type || '专题'))}</span></div>
      </div>
    </div>`).join('');
  dots.innerHTML = banners.map((_, i) => `<span class="banner-dot ${i === 0 ? 'active' : ''}" data-i="${i}"></span>`).join('');

  // 箭头用 onclick 赋值（覆盖，不累积）
  const startAuto = () => {
    clearInterval(state.bannerTimer);
    renderBannerPlay(true);
    if (!SETTINGS.bannerAuto) return; // 设置：关闭自动轮播
    state.bannerTimer = setInterval(() => goBanner(state.bannerIdx + 1), 5000);
  };
  $('#bannerPrev').onclick = () => { goBanner(state.bannerIdx - 1); startAuto(); };
  $('#bannerNext').onclick = () => { goBanner(state.bannerIdx + 1); startAuto(); };
  // 暂停/播放按钮（onclick 覆盖，不累积）
  $('#bannerPlay').onclick = (e) => {
    e.stopPropagation();
    bannerPaused = !bannerPaused;
    if (bannerPaused) {
      clearInterval(state.bannerTimer);
      renderBannerPlay(false);
    } else {
      startAuto();
    }
  };
  // 悬停暂停：鼠标进入暂停，离开恢复
  const wrap = $('#bannerWrap');
  wrap.onmouseenter = () => { if (!bannerPaused) { clearInterval(state.bannerTimer); renderBannerPlay(false); } };
  wrap.onmouseleave = () => { if (!bannerPaused) startAuto(); updateBannerProgress(); };

  goBanner(0);
  updateBannerProgress();
  startAuto();
}

// 切换 暂停/播放 图标状态
function renderBannerPlay(running) {
  const btn = $('#bannerPlay');
  if (!btn) return;
  btn.classList.toggle('paused', !running);
  btn.setAttribute('aria-label', running ? '暂停轮播' : '播放轮播');
}

/* ================= 分类页 ================= */
let catInited = false;
// 分类页默认选中「日本动漫」：各源分类名不同，按名称匹配；找不到则回退源首分类
function defaultCatType() {
  const cats = SRC.categories();
  const jp = cats.find((c) => /日本/.test(c.name));
  return (jp || cats[0] || { type: '' }).type;
}

function ensureCategoryLoaded() {
  if (catInited) return;
  catInited = true;
  // 首次进入或切换源后：重置为默认「日本动漫」，保证不残留上一源的选择
  state.catType = defaultCatType();
  state.catFilters = { year: '', area: '', sort: '' };
  state.catPage = 1;
  state.catEnded = false;
  renderCatTabs();
  renderCatFilters();
  loadCategory(true);
}

function renderCatTabs() {
  $('#catTabs').innerHTML = SRC.categories().map((c) => `
    <span class="cat-tab ${c.type === state.catType ? 'active' : ''}" data-type="${c.type}">${c.name}</span>`).join('');
}

// 筛选选项定义（真实对应 macCMS 参数，点击即生效）
const FILTER_OPTIONS = {
  year: [
    { v: '', label: '全部' },
    { v: '2026', label: '2026' },
    { v: '2025', label: '2025' },
    { v: '2024', label: '2024' },
    { v: '2023', label: '2023' },
    { v: '2022', label: '2022' },
    { v: '2021', label: '2021' },
    { v: '2020', label: '2020' },
    { v: '2019', label: '2019' },
    { v: '2018', label: '2018' },
    { v: '2017', label: '2017' },
    { v: '2016', label: '2016' },
    { v: '2015', label: '2015' },
  ],
  area: [
    { v: '', label: '全部' },
    { v: '日本', label: '日本' },
    { v: '中国', label: '中国' },
    { v: '欧美', label: '欧美' },
    { v: '韩国', label: '韩国' },
  ],
  sort: [
    { v: '', label: '最新' },
    { v: 'hits', label: '最热' },
  ],
};

function renderCatFilters() {
  Object.keys(FILTER_OPTIONS).forEach((key) => {
    const box = $('#filter' + key.charAt(0).toUpperCase() + key.slice(1));
    if (!box) return;
    const cur = state.catFilters[key] || '';
    box.innerHTML = FILTER_OPTIONS[key].map((o) => `
      <span class="filter-opt ${o.v === cur ? 'active' : ''}" data-k="${key}" data-v="${o.v}">${o.label}</span>`).join('');
  });
}

// 本地地区过滤：多数 macCMS 源不解析服务端 area 参数，需在客户端按地区字段兜底。
// 不同源字段值混乱（大陆/中国大陆/日本/美国/韩国/香港/台湾/欧美等），
// 这里按关键词归类；地区字段为空时不匹配（避免混入未知地区）。
function areaMatch(area, key) {
  if (!key) return true;
  const a = String(area || '').trim();
  if (!a) return false;
  switch (key) {
    case '日本': return /日本|日韩|日漫/.test(a);
    case '中国': return /大陆|中国|香港|台湾|澳门|内地|国漫/.test(a);
    case '欧美': return /美国|英国|法国|德国|欧洲|欧美|俄罗斯|加拿大|意大利|西班牙|澳洲|苏联/.test(a);
    case '韩国': return /韩国|韩漫/.test(a);
    default: return true;
  }
}

async function loadCategory(reset) {
  if (state.catLoading) return;
  state.catLoading = true;
  const grid = $('#catGrid');
  const more = $('#catLoadMore');
  const empty = $('#catEmpty');
  const countEl = $('#catResultCount');
  const lmText = more.querySelector('.lm-text');
  if (reset) {
    grid.innerHTML = '';
    state.catPage = 1;
    state.catEnded = false;
    empty.classList.add('hidden');
    more.classList.remove('hidden');
    countEl.textContent = '加载中…';
  }
  more.classList.remove('hidden');
  more.classList.add('loading');
  lmText.textContent = '加载中…';
  try {
    const areaFilter = state.catFilters.area;
    const SRC_PAGE = 20;  // macCMS 每页条数
    const MAX_LOOPS = 10; // 地区筛选时最多连续拉取页数，防止死循环
    let matched = [];
    let lastRaw = 0;
    let sawEnd = false;
    let loops = 0;
    while (!sawEnd && loops < MAX_LOOPS) {
      loops++;
      const { list } = await SRC.category(state.catType, state.catPage, state.catFilters);
      lastRaw = list.length;
      state.catPage++;
      // 本地地区过滤（无筛选时直接取全量）
      if (areaFilter) matched = matched.concat(list.filter((c) => areaMatch(c.area, areaFilter)));
      else matched = matched.concat(list);
      // 服务端到底：返回条数小于整页
      if (list.length < SRC_PAGE) { sawEnd = true; break; }
      // 无地区筛选时，一页即为一次加载；地区筛选时凑够一页数量再渲染
      if (!areaFilter) break;
      if (matched.length >= SRC_PAGE) break;
    }
    state.catEnded = sawEnd && matched.length >= SRC_PAGE;
    if (!matched.length) {
      empty.classList.remove('hidden');
      more.classList.add('hidden');
      countEl.textContent = `共 ${grid.children.length} 部作品`;
      lmText.textContent = '没有更多了';
      return;
    }
    grid.insertAdjacentHTML('beforeend', matched.map(cardHtml).join(''));
    more.classList.remove('loading');
    countEl.textContent = `已显示 ${grid.children.length} 部作品`;
    // 到底判断：最后一次拉取返回不足整页，说明没有更多了
    if (sawEnd || lastRaw < SRC_PAGE) {
      state.catEnded = true;
      lmText.textContent = '没有更多了';
    } else {
      lmText.textContent = '加载更多';
    }
  } catch (e) {
    console.error('分类加载失败', e);
    more.classList.remove('loading');
    lmText.textContent = '加载失败，点击重试';
    countEl.textContent = '加载失败';
  } finally {
    state.catLoading = false;
  }
}

/* ================= 搜索页 ================= */
async function doSearch() {
  const kw = $('#searchInput').value.trim().toLowerCase();
  const grid = $('#searchGrid');
  if (!kw) {
    showSearchIdle();
    return;
  }
  showLoading('正在搜索…');
  if (window.innerWidth > 0) {} // 占位，保持结构
  try {
    const res = await SRC.search(kw);
    // 进入结果态
    $('#searchSuggest').classList.add('hidden');
    $('#searchResultHead').classList.remove('hidden');
    $('#searchKwLabel').textContent = `“${escapeHtml(kw)}”`;
    // 跨源兜底提示：当前源搜索失败时已自动切换到其他源
    const fallback = res.sourceName && res.sourceName !== SRC.sourceName();
    $('#searchTotal').innerHTML = fallback
      ? `为你找到 <b>${res.total}</b> 部相关作品（来自「${escapeHtml(res.sourceName)}」）`
      : `为你找到 <b>${res.total}</b> 部相关作品`;
    $('#searchEmpty').classList.add('hidden');
    if (!res.list.length) {
      grid.innerHTML = '';
      $('#searchEmpty').classList.remove('hidden');
      return;
    }
    grid.innerHTML = res.list.slice(0, 200).map(cardHtml).join('');
    addSearchHistory(kw);
  } catch (e) {
    console.error('搜索失败', e);
    $('#searchSuggest').classList.add('hidden');
    $('#searchResultHead').classList.remove('hidden');
    $('#searchKwLabel').textContent = `“${escapeHtml(kw)}”`;
    $('#searchTotal').innerHTML = '搜索失败';
    grid.innerHTML = `<div class="empty-hint">搜索失败：${escapeHtml(e.message)}</div>`;
    $('#searchEmpty').classList.add('hidden');
  } finally {
    hideLoading();
  }
}

// 空搜索/清空 → 显示搜索首页（历史 + 热门）
function showSearchIdle() {
  $('#searchSuggest').classList.remove('hidden');
  $('#searchResultHead').classList.add('hidden');
  $('#searchEmpty').classList.add('hidden');
  $('#searchGrid').innerHTML = '';
  renderSearchSuggest();
}

/* ---- 搜索历史（localStorage） ---- */
const SEARCH_HIST_KEY = 'mengmoe.search.history.v1';
function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HIST_KEY)) || []; }
  catch (e) { return []; }
}
function addSearchHistory(kw) {
  try {
    let arr = getSearchHistory().filter((x) => x.toLowerCase() !== kw);
    arr.unshift(kw);
    arr = arr.slice(0, 8);
    localStorage.setItem(SEARCH_HIST_KEY, JSON.stringify(arr));
    renderSearchSuggest();
  } catch (e) { /* ignore */ }
}
function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HIST_KEY);
  renderSearchSuggest();
}

/* ---- 渲染搜索历史（仅历史，无热门） ---- */
function renderSearchSuggest() {
  const tags = $('#sgHistoryTags');
  const histBlock = $('#sgHistory');
  const emptyBlock = $('#sgNoHistory');
  if (!tags || !histBlock || !emptyBlock) return;
  const hist = getSearchHistory();
  if (hist.length) {
    histBlock.classList.remove('hidden');
    emptyBlock.classList.add('hidden');
    tags.innerHTML = hist.map((k) => `<span class="sg-tag" data-kw="${escapeHtml(k)}">${escapeHtml(k)}</span>`).join('') +
      `<span class="sg-tag sg-clear" title="清空记录">清空</span>`;
  } else {
    histBlock.classList.add('hidden');
    emptyBlock.classList.remove('hidden');
    tags.innerHTML = '';
  }
}

/* ================= 详情页 ================= */
async function openDetail(uid) {
  showPage('detail');
  showLoading('正在加载详情…');
  $('#detailContent').innerHTML = '';
  try {
    const data = await SRC.detail(uid);
    state.detailData = data; // {meta, vod1, vod2}
    state.curSource = data.vod1.length ? 0 : 1;
    state.curEp = 0;
    state.fallbackUsed = false;
    renderDetail();
  } catch (e) {
    console.error('详情加载失败', e);
    $('#detailContent').innerHTML = `<div class="empty-hint">详情加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    hideLoading();
  }
}

function currentList() {
  const { vod1, vod2 } = state.detailData;
  return state.curSource === 0 ? vod1 : (vod2.length ? vod2 : vod1);
}
function hasSource(i) {
  const { vod1, vod2 } = state.detailData;
  return i === 0 ? vod1.length > 0 : vod2.length > 0;
}

// 简介展开指示器初始化：仅在内容超过折叠高度时显示按钮；
// 支持设置里的「默认展开简介」
function initDescToggle() {
  const wrap = document.querySelector('.detail-desc-wrap');
  if (!wrap) return;
  const text = wrap.querySelector('.detail-desc');
  const button = wrap.querySelector('.desc-toggle');
  if (!text) return;
  // 检测是否超长（临时去掉 max-height 测量）
  const wasClamped = text.classList.contains('expanded');
  text.classList.remove('expanded');
  const overflow = text.scrollHeight > 106;
  text.classList.toggle('expanded', wasClamped);

  if (button) {
    const showBtn = overflow && SETTINGS.descExpandButton;
    button.classList.toggle('hidden', !showBtn);
    // 默认展开
    if (SETTINGS.descDefaultExpand && overflow && !text.classList.contains('expanded')) {
      text.classList.add('expanded');
      const bt = button.querySelector('.desc-toggle-text');
      if (bt) bt.textContent = '收起';
      button.classList.add('open');
    }
  }
}

function renderDetail() {
  const { meta, vod1, vod2 } = state.detailData;
  const cover = fullImg(meta.src || meta.pic);
  const chips = [
    meta.inlz && `状态：${meta.inlz}`,
    meta.injq && `题材：${meta.injq}`,
    meta.inlx && `地区：${meta.inlx}`,
    meta.innd && `年份：${meta.innd}`,
    meta.infy && `语言：${meta.infy}`,
    meta.updatetim && `更新：${meta.updatetim}`,
  ].filter(Boolean);

  $('#detailContent').innerHTML = `
    <div class="detail-hero" id="detailHero">
      <div class="hero-bg" style="background-image:url('${cover}')"></div>
      <div class="hero-shade"></div>
      <img class="detail-cover" src="${cover}" alt="${escapeHtml(meta.title)}"
           onerror="this.onerror=null;this.src='${IMG_FALLBACK}'">
      <div class="detail-info">
        <h2 class="detail-name">${escapeHtml(meta.title)}</h2>
        ${meta.title_bm ? `<div class="detail-alias">别名：${escapeHtml(meta.title_bm)}</div>` : ''}
        <div class="detail-meta">${chips.map((c) => `<span class="meta-chip">${escapeHtml(c)}</span>`).join('')}</div>
        <div class="detail-desc-wrap">
          <p class="detail-desc ${meta.injj ? '' : 'empty-desc'}" data-toggle>${escapeHtml(meta.injj || '暂无简介')}</p>
          <button class="desc-toggle" data-toggle aria-label="展开/收起简介" type="button">
            <span class="desc-toggle-text">展开</span>
            <svg class="desc-toggle-arrow" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M7.4 9.4 12 14l4.6-4.6 1.4 1.4L12 16.8 6 10.8z"/>
            </svg>
          </button>
        </div>
        <div class="detail-actions">
          <button class="btn-play" id="btnPlay">▶ 立即播放</button>
          ${vod2.length ? `<button class="btn-switch" id="btnSwitch">切换线路（线路${state.curSource + 1}/2）</button>` : ''}
        </div>
      </div>
    </div>
    <div class="ep-section">
      <div class="ep-title">选集 <span class="src-badge">线路${state.curSource + 1}</span></div>
      <div class="ep-list" id="epListDetail">${renderEpButtons()}</div>
    </div>`;
  initDescToggle();
}

function renderEpButtons() {
  const list = currentList();
  if (!list.length) return '<div class="empty-hint">暂无播放源</div>';
  return list.map((ep, i) => `
    <button class="ep-item ${i === state.curEp ? 'active' : ''}" data-i="${i}"
            title="${escapeHtml(ep.purl || '')}">${escapeHtml(ep.pid || '第' + (i + 1) + '集')}</button>`).join('');
}

/* ================= 播放页 ================= */
function renderPlayerLineSwitch() {
  const html = [];
  if (hasSource(0)) html.push(`<button class="line-btn ${state.curSource === 0 ? 'active' : ''}" data-line="0">线路 1</button>`);
  if (hasSource(1)) html.push(`<button class="line-btn ${state.curSource === 1 ? 'active' : ''}" data-line="1">线路 2</button>`);
  $('#playerLineSwitch').innerHTML = html.join('');
}

function renderEpList() {
  const list = currentList();
  $('#epList').innerHTML = list.map((e, i) => `
    <button class="ep-item ${i === state.curEp ? 'active' : ''}" data-i="${i}">${escapeHtml(e.pid || '第' + (i + 1) + '集')}</button>`).join('');
}

function updatePlayerInfo() {
  const { meta } = state.detailData;
  const list = currentList();
  const ep = list[state.curEp];
  if (!ep) return;
  // 标题与线路/集数分开展示（信息条在视频外，不遮挡画面）
  const t = $('#playerTitle');
  if (t) t.textContent = meta.title || '';
  const s = $('#playerSourceInfo');
  if (s) s.textContent = `线路${state.curSource + 1} · ${ep.pid || '第' + (state.curEp + 1) + '集'}`;
}

function isPlayableUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function openPlayer() {
  const list = currentList();
  const ep = list[state.curEp];
  if (!ep) { toast('暂无可用播放源'); return; }
  state.fallbackUsed = false;
  showPage('player');
  renderPlayerLineSwitch();
  renderEpList();
  playEp();
}

function playEp() {
  let list = currentList();
  let ep = list[state.curEp];
  const video = $('#video');

  // 修复：主源为 auto 格式（非 http 地址）不可直播 → 自动回退到备源 m3u8
  if (ep && !isPlayableUrl(ep.purl) && hasSource(1) && state.curSource === 0 && !state.fallbackUsed) {
    toast('主源格式暂不支持，已自动切换备源');
    state.fallbackUsed = true;
    state.curSource = 1;
    list = currentList();
    ep = list[state.curEp] || list[0];
    state.curEp = list.indexOf(ep);
    renderPlayerLineSwitch();
  }
  if (!ep || !isPlayableUrl(ep.purl)) {
    toast('该集暂无可用播放源');
    return;
  }

  // 销毁旧的 hls 实例
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  video.removeAttribute('src');
  video.load();

  updatePlayerInfo();
  renderEpList();

  const url = ep.purl;
  // 修复：播放失败自动回退备源（仅回退一次）
  const tryFallback = (detail) => {
    if (hasSource(1) && state.curSource === 0 && !state.fallbackUsed) {
      state.fallbackUsed = true;
      toast('播放失败，正在切换备源…');
      state.curSource = 1;
      renderPlayerLineSwitch();
      playEp();
    } else {
      toast('播放失败：' + (detail || '未知错误'));
    }
  };

  // 设置：默认倍速 + 默认音量
  video.playbackRate = SETTINGS.rate || 1;
  if (typeof SETTINGS.volume === 'number' && SETTINGS.volume >= 0 && SETTINGS.volume <= 1) {
    video.volume = SETTINGS.volume;
  }

  if (window.Hls && Hls.isSupported()) {
    state.hls = new Hls({ enableWorker: true });
    state.hls.loadSource(url);
    state.hls.attachMedia(video);
    state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.muted = SETTINGS.muted;
      video.playbackRate = SETTINGS.rate || 1;
      // 设置：记忆播放进度（续播）
      restoreProgress(video);
      video.play().catch(() => {});
    });
    state.hls.on(Hls.Events.ERROR, (evt, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (data.details === 'manifestLoadError' || data.details === 'manifestParsingError') {
          tryFallback(data.details);
        } else {
          toast('网络错误，重试中…');
          state.hls.startLoad();
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        toast('媒体错误，恢复中…');
        state.hls.recoverMediaError();
      } else {
        tryFallback(data.details);
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.muted = SETTINGS.muted;
    video.playbackRate = SETTINGS.rate || 1;
    video.play().catch(() => {});
  } else {
    toast('当前环境不支持 m3u8 播放');
  }

  // 设置：自动连播下一集
  video.onended = () => { autoNext(); };
  // 设置：默认静音
  video.muted = SETTINGS.muted;
  // 设置：进度记忆（每秒保存 + 播放中监听）
  video.ontimeupdate = () => { saveProgress(video); };
  // 设置：控件自动隐藏
  setupAutoHideControls(video);
}

/* ================= 播放器控件自动隐藏 ================= */
// 开启时：鼠标离开视频 2 秒后隐藏原生 controls，移入即显示
function setupAutoHideControls(video) {
  if (!video) return;
  clearTimeout(video._hideTimer);
  video._hideTimer = null;
  const apply = () => {
    video.controls = !SETTINGS.autoHideControls;
    // 若开启，播放后自动进入隐藏倒计时
    if (SETTINGS.autoHideControls && !video.paused) scheduleHide(video);
  };
  const scheduleHide = (el) => {
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { if (!el.paused) el.controls = false; }, 2000);
  };
  video._applyControls = apply;
  video._scheduleHide = scheduleHide;
  if (video._hideBound) return;
  video._hideBound = true;
  video.addEventListener('mousemove', () => {
    if (video.controls === false) video.controls = true;
    if (SETTINGS.autoHideControls) scheduleHide(video);
  });
  video.addEventListener('play', () => { if (SETTINGS.autoHideControls) scheduleHide(video); });
  video.addEventListener('pause', () => { if (SETTINGS.autoHideControls) video.controls = true; clearTimeout(video._hideTimer); });
  apply();
}

// 自动连播下一集（受设置控制）
function autoNext() {
  if (!SETTINGS.autoNext) return;
  const list = currentList();
  if (state.curEp + 1 < list.length) {
    state.curEp += 1;
    renderEpList();
    playEp();
    toast('自动播放下一集');
  } else {
    toast('已是最后一集');
  }
}

/* ================= 播放进度记忆（续播） ================= */
const PROGRESS_KEY = 'mengmoe.progress.v1';
function progressStore() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveProgress(video) {
  if (!SETTINGS.rememberProgress || !video || !video.duration || !state.detailData) return;
  if (video.currentTime < 5 || video.currentTime > video.duration - 5) return; // 首尾各留 5 秒，避免误存
  try {
    const store = progressStore();
    const key = state.detailData.uid + ':' + state.curEp + ':' + state.curSource;
    store[key] = { t: +video.currentTime.toFixed(1), d: +video.duration.toFixed(1), ts: Date.now() };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(store));
  } catch (e) { /* ignore */ }
}
function restoreProgress(video) {
  if (!SETTINGS.rememberProgress || !video || !state.detailData) return;
  if (state.curEp !== 0) return; // 仅对「当前打开的这集」恢复：切集时依赖 act 传参
  try {
    const store = progressStore();
    const key = state.detailData.uid + ':' + state.curEp + ':' + state.curSource;
    const p = store[key];
    if (p && typeof p.t === 'number' && p.t > 5 && p.t < (p.d || 0) - 3) {
      video.currentTime = p.t;
    }
  } catch (e) { /* ignore */ }
}

/* ================= 列表图片懒加载 ================= */
function applyLazyLoad() {
  const imgs = document.querySelectorAll('#homeContent img, #categoryContent img, #searchContent img, #detailContent img');
  imgs.forEach((img) => {
    if (SETTINGS.preloadImages) {
      img.setAttribute('loading', 'lazy'); // 开启懒加载
    } else {
      img.removeAttribute('loading');       // 立即加载
    }
  });
}

/* （侧边栏数据源切换已移除，切换统一在设置页） */

/* ================= 设置页 ================= */
function renderSetSource() {
  const box = $('#setSource');
  if (!box) return;
  box.innerHTML = SRC.sources.map((s) => `
    <span class="src-opt ${SRC.current.id === s.id ? 'active' : ''}" data-src="${s.id}">
      <span class="dot"></span>${escapeHtml(s.name)}
    </span>`).join('');
}

function renderCustomList() {
  const box = $('#csList');
  if (!box) return;
  const list = SRC.customList();
  if (!list.length) {
    box.innerHTML = '<div class="cs-empty">暂无自定义数据源，添加后即可显示在数据源列表中</div>';
    return;
  }
  box.innerHTML = list.map((s) => `
    <div class="cs-item" data-src="${s.id}">
      <div class="cs-item-info">
        <div class="cs-item-name">${escapeHtml(s.name)}</div>
        <div class="cs-item-base">${escapeHtml(s.base)}</div>
      </div>
      <button class="cs-del" data-del="${s.id}" title="删除该数据源">删除</button>
    </div>`).join('');
}

// 将当前设置值同步到设置页 UI 控件（含分段控件/滑杆/色板）
function syncSettingsUI() {
  $('#setAutoNext').checked = SETTINGS.autoNext;
  $('#setBannerAuto').checked = SETTINGS.bannerAuto;
  $('#setMuted').checked = SETTINGS.muted;
  $('#setRememberProgress').checked = SETTINGS.rememberProgress;
  $('#setAutoHideControls').checked = SETTINGS.autoHideControls;
  $('#setPreloadImages').checked = SETTINGS.preloadImages;
  $('#setMinimal').checked = SETTINGS.minimal;
  // 分段控件：倍速 / 玻璃光效
  $$('#setRate .seg-opt').forEach((o) => o.classList.toggle('active', parseFloat(o.dataset.v) === Number(SETTINGS.rate)));
  $$('#setGlass .seg-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === SETTINGS.glass));
  // 滑杆：音量 / 缩放
  const vol = $('#setVolume');
  if (vol) {
    vol.value = String(SETTINGS.volume || 1);
    vol.style.setProperty('--fill', Math.round(vol.value * 100) + '%');
    $('#setVolumeVal').textContent = Math.round(vol.value * 100) + '%';
  }
  const sc = $('#setScale');
  if (sc) {
    sc.value = String(SETTINGS.scale || 1);
    sc.style.setProperty('--fill', Math.round((sc.value - 0.85) / (1.2 - 0.85) * 100) + '%');
    $('#setScaleVal').textContent = Math.round(sc.value * 100) + '%';
  }
  // 色板：强调色
  $$('#setAccent .sw').forEach((s) => s.classList.toggle('active', s.dataset.c.toLowerCase() === String(SETTINGS.accent).toLowerCase()));
}

function initSettings() {
  // 分段控件 / 色板支持键盘（Enter / Space 等价点击）
  ['#setRate .seg-opt', '#setGlass .seg-opt', '#setAccent .sw'].forEach((sel) => {
    $$(sel).forEach((opt) => {
      opt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opt.click(); }
      });
    });
  });

  // 关于 Maoe：版本显示 + 检查更新
  const aboutVer = $('#aboutVer');
  if (aboutVer) aboutVer.textContent = `v${APP_VERSION}`;
  const aboutCheck = $('#aboutCheck');
  if (aboutCheck) {
    aboutCheck.addEventListener('click', () => checkForUpdates({ silent: false, onResult: renderAboutUpdate }));
  }

  // 数据源选择
  renderSetSource();
  $('#setSource').addEventListener('click', (e) => {
    const opt = e.target.closest('.src-opt');
    if (!opt) return;
    SETTINGS.defaultSource = opt.dataset.src;
    saveSettings();
    // 立即切换当前源
    SRC.set(SETTINGS.defaultSource);
    renderSetSource();
    toast(`默认数据源：${SRC.sourceName()}`);
    // 全局刷新：重置所有页面缓存，保证首页/分类/搜索/详情全部用新源
    state.catFilters = { year: '', area: '', sort: '' };
    state.catType = defaultCatType();
    state.catPage = 1;
    state.catEnded = false;
    state.catLoading = false;
    catInited = false;
    const sg = $('#searchContent'); if (sg) sg.innerHTML = '';
    showPage('home');
    loadHome();
  });

  // 播放体验开关
  $('#setAutoNext').addEventListener('change', (e) => { SETTINGS.autoNext = e.target.checked; saveSettings(); });
  $('#setBannerAuto').addEventListener('change', (e) => { SETTINGS.bannerAuto = e.target.checked; saveSettings(); if (state.page === 'home') loadHome(); });
  $('#setMuted').addEventListener('change', (e) => { SETTINGS.muted = e.target.checked; saveSettings(); const v = $('#video'); if (v && SETTINGS.muted) v.muted = true; });
  $('#setRememberProgress').addEventListener('change', (e) => { SETTINGS.rememberProgress = e.target.checked; saveSettings(); });
  $('#setAutoHideControls').addEventListener('change', (e) => { SETTINGS.autoHideControls = e.target.checked; saveSettings(); });
  $('#setPreloadImages').addEventListener('change', (e) => { SETTINGS.preloadImages = e.target.checked; saveSettings(); applyLazyLoad(); });

  // 分段控件：播放倍速（setRate）
  $('#setRate').addEventListener('click', (e) => {
    const opt = e.target.closest('.seg-opt');
    if (!opt || opt.classList.contains('active')) return;
    SETTINGS.rate = parseFloat(opt.dataset.v) || 1;
    saveSettings();
    $$('#setRate .seg-opt').forEach((o) => o.classList.toggle('active', o === opt));
    const v = $('#video'); if (v) v.playbackRate = SETTINGS.rate;
  });

  // 滑杆：默认音量
  const volInput = $('#setVolume');
  const volVal = $('#setVolumeVal');
  const syncVol = () => {
    const pct = Math.round(volInput.value * 100);
    volVal.textContent = pct + '%';
    volInput.style.setProperty('--fill', pct + '%');
  };
  volInput.addEventListener('input', () => { syncVol(); });
  volInput.addEventListener('change', () => {
    SETTINGS.volume = parseFloat(volInput.value) || 1;
    saveSettings();
    const v = $('#video'); if (v) v.volume = SETTINGS.volume;
  });

  // 外观：玻璃光效分段控件（setGlass）
  $('#setGlass').addEventListener('click', (e) => {
    const opt = e.target.closest('.seg-opt');
    if (!opt || opt.classList.contains('active')) return;
    SETTINGS.glass = opt.dataset.v;
    saveSettings();
    $$('#setGlass .seg-opt').forEach((o) => o.classList.toggle('active', o === opt));
    applyAppearance();
  });

  // 外观：强调色色板（setAccent）
  $('#setAccent').addEventListener('click', (e) => {
    const sw = e.target.closest('.sw');
    if (!sw || sw.classList.contains('active')) return;
    SETTINGS.accent = sw.dataset.c;
    saveSettings();
    $$('#setAccent .sw').forEach((s) => s.classList.toggle('active', s === sw));
    applyAppearance();
  });

  // 外观：界面缩放滑杆
  const scaleInput = $('#setScale');
  const scaleVal = $('#setScaleVal');
  const syncScale = () => {
    scaleVal.textContent = Math.round(scaleInput.value * 100) + '%';
    scaleInput.style.setProperty('--fill', Math.round((scaleInput.value - 0.85) / (1.2 - 0.85) * 100) + '%');
  };
  scaleInput.addEventListener('input', () => { syncScale(); });
  scaleInput.addEventListener('change', () => {
    SETTINGS.scale = parseFloat(scaleInput.value) || 1;
    saveSettings();
    applyAppearance();
  });

  // 通用：恢复默认设置
  $('#setReset').addEventListener('click', () => {
    if (!window.confirm('确定将所有设置恢复为默认值？')) return;
    Object.keys(DEFAULT_SETTINGS).forEach((k) => { SETTINGS[k] = DEFAULT_SETTINGS[k]; });
    saveSettings();
    syncSettingsUI();
    applyAppearance();
    // 若默认源变化则刷新
    if (SRC.current.id !== SETTINGS.defaultSource) {
      SRC.set(SETTINGS.defaultSource);
      state.catFilters = { year: '', area: '', sort: '' };
      state.catType = defaultCatType();
      state.catPage = 1; state.catEnded = false; state.catLoading = false;
      catInited = false;
      showPage('home'); loadHome();
    }
    toast('已恢复默认设置');
  });

  // 通用：清空搜索历史
  $('#setClearHist').addEventListener('click', () => {
    if (!window.confirm('确定清空全部搜索历史？')) return;
    clearSearchHistory();
    toast('已清空搜索历史');
  });

  // 简洁模式
  $('#setMinimal').addEventListener('change', (e) => { SETTINGS.minimal = e.target.checked; saveSettings(); applyAppearance(); });

  // 同步 UI 到当前设置值
  syncSettingsUI();

  // 自定义数据源：添加
  const csName = $('#csName');
  const csBase = $('#csBase');
  const addCs = async () => {
    const n = csName.value.trim() || '我的源';
    const b = csBase.value.trim();
    if (!b) { toast('请填写数据源 API 地址'); csBase.focus(); return; }
    try {
      const s = await SRC.addCustom(n, b);
      renderSetSource();
      renderCustomList();
      toast(`已添加数据源：${s.name}`);
      csBase.value = '';
    } catch (err) {
      toast(err && err.message ? err.message : '添加失败，请检查地址');
    }
  };
  $('#csAdd').addEventListener('click', addCs);
  csBase.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCs(); });

  // 自定义数据源：删除（容器委托）
  $('#csList').addEventListener('click', (e) => {
    const del = e.target.closest('.cs-del');
    if (!del) return;
    const id = del.dataset.del;
    if (!window.confirm('确定删除该数据源？')) return;
    const wasCurrent = SRC.current.id === id;
    SRC.removeCustom(id);
    renderSetSource();
    renderCustomList();
    if (wasCurrent) {
      // 当前源被删除：重置所有缓存并全局刷新到首页
      state.catFilters = { year: '', area: '', sort: '' };
      state.catType = defaultCatType();
      state.catPage = 1;
      state.catEnded = false;
      catInited = false;
      showPage('home');
      loadHome();
    }
    toast('已删除数据源');
  });

  renderCustomList();
}

/* ================= 事件绑定（一次性，全部走委托，杜绝累积） ================= */
function bindStaticEvents() {
  // 侧边导航（仅动漫模式，限定 #app 内避免误绑小说侧栏 nav-item）
  $$('#app .nav-item').forEach((n) => n.addEventListener('click', () => {
    // 小说模式入口：切换到独立轻小说界面
    if (n.dataset.nswitch === 'novel') { if (typeof window.enterNovel === 'function') window.enterNovel(); return; }
    showPage(n.dataset.page);
  }));

  // 全局委托：卡片点击 / 返回按钮
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card && card.dataset.uid) {
      openDetail(card.dataset.uid);
      return;
    }
    const back = e.target.closest('.back-btn');
    if (back) {
      if (state.page === 'player') showPage('detail');
      else showPage('home');
    }
  });

  // Banner：圆点 + 轮播点击（持久容器，只绑一次）
  $('#bannerDots').addEventListener('click', (e) => {
    const d = e.target.closest('.banner-dot');
    if (d) {
      goBanner(+d.dataset.i);
      clearInterval(state.bannerTimer);
      state.bannerTimer = setInterval(() => goBanner(state.bannerIdx + 1), 5000);
    }
  });
  $('#bannerTrack').addEventListener('click', (e) => {
    const slide = e.target.closest('.banner-slide');
    if (slide && slide.dataset.uid) openDetail(slide.dataset.uid);
  });

  // 分类 Tab（持久容器，只绑一次）
  $('#catTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.cat-tab');
    if (!tab || tab.dataset.type === state.catType) return;
    state.catType = tab.dataset.type;
    state.catPage = 1;
    state.catEnded = false;
    state.catLoading = false;
    $$('#catTabs .cat-tab').forEach((t) => t.classList.toggle('active', t === tab));
    loadCategory(true);
  });

  // 筛选按钮点击（持久容器，只绑一次）
  $('#filterBar').addEventListener('click', (e) => {
    const opt = e.target.closest('.filter-opt');
    if (!opt) return;
    const k = opt.dataset.k;
    const v = opt.dataset.v;
    if (state.catFilters[k] === v) return;
    state.catFilters[k] = v;
    state.catPage = 1;
    state.catEnded = false;
    state.catLoading = false;
    renderCatFilters();
    loadCategory(true);
  });

  // 分类加载更多
  $('#catLoadMore').addEventListener('click', () => {
    if (state.catEnded || state.catLoading) return;
    loadCategory(false);
  });

  // 修复：滚动触底自动加载绑定到 .main（真正的滚动容器）
  mainEl.addEventListener('scroll', () => {
    if (state.page !== 'category' || state.catEnded || state.catLoading) return;
    if (mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 500) {
      loadCategory(false);
    }
  });

  // 搜索
  $('#searchBtn').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  // 聚焦拉长搜索框（居中 → 向两侧展开）
  const searchBox = $('#searchBox');
  const searchInput = $('#searchInput');
  searchInput.addEventListener('focus', () => { searchBox.classList.add('search-expand'); });
  searchInput.addEventListener('blur', () => { searchBox.classList.remove('search-expand'); });
  $('#searchClear').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#searchInput').focus();
    showSearchIdle();
  });
  $('#searchInput').addEventListener('input', () => {
    $('#searchClear').classList.toggle('hidden', !$('#searchInput').value);
  });
  // 历史标签点击（容器委托）：点词条直接搜索；点「清空」清除历史
  $('#searchSuggest').addEventListener('click', (e) => {
    const tag = e.target.closest('.sg-tag');
    if (!tag) return;
    if (tag.classList.contains('sg-clear')) { clearSearchHistory(); return; }
    $('#searchInput').value = tag.dataset.kw;
    doSearch();
  });

  // 热门"查看全部" → 分类页（当前源第一个分类）
  $('#hotMore').addEventListener('click', () => {
    state.catType = defaultCatType();
    state.catPage = 1;
    state.catEnded = false;
    state.catLoading = false;
    state.catFilters = { year: '', area: '', sort: '' };
    catInited = false;
    showPage('category');
  });

  // 详情页内容委托（按钮、选集、简介展开；detailContent 是持久容器）
  $('#detailContent').addEventListener('click', (e) => {
    if (e.target.closest('#btnPlay')) { openPlayer(); return; }
    if (e.target.closest('#btnSwitch')) {
      // 修复：切换线路后自动播放
      state.curSource = state.curSource === 0 ? 1 : 0;
      state.curEp = 0;
      state.fallbackUsed = false;
      renderDetail();
      toast(`已切换至线路${state.curSource + 1}，正在播放…`);
      openPlayer();
      return;
    }
    const ep = e.target.closest('.ep-item');
    if (ep) {
      state.curEp = +ep.dataset.i;
      openPlayer();
      return;
    }
    const desc = e.target.closest('[data-toggle]');
    if (desc) {
      const wrap = desc.closest('.detail-desc-wrap') || desc;
      const text = wrap.querySelector('.detail-desc') || desc;
      const button = wrap.querySelector('.desc-toggle');
      const expanded = text.classList.toggle('expanded');
      if (button) {
        const bt = button.querySelector('.desc-toggle-text');
        if (bt) bt.textContent = expanded ? '收起' : '展开';
        button.classList.toggle('open', expanded);
      }
      return;
    }
  });

  // 播放页选集（持久容器，只绑一次）
  $('#epList').addEventListener('click', (ev) => {
    const b = ev.target.closest('.ep-item');
    if (!b) return;
    state.curEp = +b.dataset.i;
    renderEpList();
    playEp();
  });

  // 播放页线路切换（持久容器，只绑一次）
  $('#playerLineSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.line-btn');
    if (!btn || btn.disabled) return;
    const line = +btn.dataset.line;
    if (line === state.curSource) return;
    state.curSource = line;
    state.curEp = 0;
    state.fallbackUsed = false;
    renderPlayerLineSwitch();
    renderEpList();
    playEp(); // 修复：切换线路后自动播放
  });
}

/* ================= 初始化 ================= */
// 老版本默认源为落攻源（lg），其接口近期超时，自动迁移为樱花源（yh）
if (SETTINGS.defaultSource === 'lg') {
  SETTINGS.defaultSource = 'yh';
  saveSettings();
}
// 应用设置：默认数据源 + 外观（简洁模式/玻璃档位）
if (SETTINGS.defaultSource && SRC.sources.some((s) => s.id === SETTINGS.defaultSource)) {
  SRC.set(SETTINGS.defaultSource);
}
applyAppearance();
bindStaticEvents();
initSettings();
loadHome();

// 自动检查更新（启动后延迟执行，避免阻塞首屏；结果同步到设置页「关于 Maoe」）
setTimeout(() => checkForUpdates({ silent: true, onResult: renderAboutUpdate }), 3500);

// 版本信息显示（检查更新入口已移至设置页「关于 Maoe」）
(function renderVersion() {
  const el = $('#verInfo');
  if (el) el.textContent = `v${APP_VERSION}`;
  const hv = $('#helpVer');
  if (hv) hv.textContent = `v${APP_VERSION}`;
})();
