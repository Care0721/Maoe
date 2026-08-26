// legado_engine.js - Legado(阅读) 规则解析引擎（独立可测）
// 支持：CSS选择器链(class./id./tag././#/[attr]/>/空格) + @提取符 + 索引/区间(.N / .N:M / .N:M:K / .-N) + !排除
//      + ##regex##replacement### + && || + {{key}}模板
// 不支持 @js: / JSONPath($.) / XPath(//) / init 模板 — 加载时需过滤
'use strict';
const cheerio = require('cheerio');

// ---- 正则替换处理：`sel##regex##replacement###`；无 ### 时视为空替换（移除匹配） ----
function splitReplace(rule) {
  const idx = rule.lastIndexOf('###');
  if (idx >= 0) {
    const prefix = rule.slice(0, idx);
    const parts = prefix.split('##');
    if (parts.length >= 3) {
      return { selector: parts[0], regex: parts[1], replacement: parts.slice(2).join('##') };
    }
    if (parts.length === 2) {
      return { selector: parts[0], regex: parts[1], replacement: '' };
    }
    return { selector: prefix, regex: null, replacement: null };
  }
  // 无 ### 但有 ##：空替换（删除匹配）；支持 `##RE` / `##RE##` / `X##RE` / `X##RE##`
  const di = rule.indexOf('##');
  if (di >= 0) {
    const selector = rule.slice(0, di).trim();
    let re = rule.slice(di + 2);
    if (re.endsWith('###')) re = re.slice(0, -3);
    else if (re.endsWith('##')) re = re.slice(0, -2);
    re = re.trim();
    if (re !== '') return { selector, regex: re, replacement: '' };
  }
  return { selector: rule, regex: null, replacement: null };
}

// ---- 主入口：规则 + cheerio上下文（元素数组或$）→ 返回提取后的字符串值 ----
function extractValue(rule, $, context) {
  if (!rule) return '';
  if (typeof rule !== 'string') return '';
  const r = rule.trim();
  if (r === '') return '';

  // || 备选：返回第一个非空（须在 ## 处理之前拆分，避免替换串里的 | 干扰）
  if (r.includes('||')) {
    const parts = r.split('||').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const v = extractValue(p, $, context);
      if (v !== '') return v;
    }
    return '';
  }
  // && 拼接
  if (r.includes('&&')) {
    const parts = r.split('&&').map(s => s.trim()).filter(Boolean);
    const vals = parts.map(p => extractValue(p, $, context)).filter(v => v !== '');
    return vals.join(' ');
  }

  let { selector, regex, replacement } = splitReplace(r);
  if (selector === '') selector = 'text'; // 纯替换：作用于当前节点文本
  let result = extractSingle(selector, $, context);

  // 应用正则替换
  if (regex != null && replacement != null && result !== '') {
    try {
      const rep = replacement.replace(/\r?\n/g, '');
      let re;
      try { re = new RegExp(regex, 'g'); } catch (e) {
        re = new RegExp(regex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      }
      result = String(result).replace(re, rep);
    } catch (e) { /* ignore */ }
  }
  return result == null ? '' : stripText(String(result));
}

// ---- 单段（不含&&/||）解析 ----
function extractSingle(selector, $, context) {
  const els = queryElements(selector, $, context);
  if (!els.length) return '';
  // 末段是提取符→字符串数组；是选择器→元素数组，取其文本
  return els.map(e => (typeof e === 'string' ? e : textOf(e, $))).join('').trim();
}

// ---- 元素查询：支持各种选择器链与 @ 提取；返回元素数组或(若末端是提取符)字符串数组 ----
function queryElements(rule, $, context) {
  if (!rule) return [];
  const tokens = rule.split('@');
  let current = normalizeContext(context, $);
  for (let i = 0; i < tokens.length; i++) {
    current = applyToken(tokens[i], $, current);
  }
  return current;
}

function normalizeContext(context, $) {
  if (context == null) return [];
  if (context === $) return [$.root().get(0)];          // 全局根
  if (Array.isArray(context)) return context;
  if (typeof context === 'string') return $(context).toArray();
  if (context && typeof context === 'object' && typeof context.toArray === 'function') return context.toArray();
  if (context && typeof context === 'object' && typeof context.length === 'number' && context.length >= 0) return Array.from(context);
  return [context];
}

// 每一步 token 应用：返回元素数组（`@text`等提取符返回字符串数组）
function applyToken(tok, $, current) {
  const t = tok.trim();
  if (t === '') return current;
  const extractors = {
    'text': (el) => textOf(el, $),
    'ownText': (el) => ownTextOf(el, $),
    'own': (el) => ownTextOf(el, $),
    'textNodes': (el) => textNodesOf(el, $),
    'html': (el) => $(el).html() || '',
    'content': (el) => $(el).html() || $(el).text() || '',
    'href': (el) => $(el).attr('href') || '',
    'src': (el) => $(el).attr('src') || '',
    'data-src': (el) => $(el).attr('data-src') || '',
    'data-original': (el) => $(el).attr('data-original') || '',
    'div': (el) => $(el).html() || '',
    'title': (el) => $(el).attr('title') || ''
  };
  if (extractors[t]) {
    return current.map((el) => extractors[t](el)).filter((v) => v !== '');
  }
  // 其余一律走 findRel：parseSel 内部处理 class./id./tag. 前缀与索引/区间/排除
  return current.flatMap((el) => findRel(t, el, $));
}

// 在 el 内查找 t 选择器；t 可能带索引/区间/排除/文本搜索/属性
function findRel(t, el, $) {
  const sel = parseSel(t);
  if (!sel) return [];
  // 文本搜索：text.xxx
  if (sel.type === 'text-search') {
    const nodes = $(el).find('*').filter(function () {
      const txt = $(this).text().replace(/\s+/g, '');
      return txt.includes(sel.value);
    });
    return applyIndexAndRange(nodes.toArray(), sel);
  }
  const root = $(el);
  let found;
  if (sel.type === 'node') {
    found = root.find(sel.value).toArray();
  } else if (sel.type === 'class') {
    found = root.find('.' + sel.value).toArray();
  } else {
    found = root.find('#' + sel.value).toArray();
  }
  // 若子级没有匹配，检查当前节点自身是否匹配（Legado 的 .x 语义包含自身）
  if (!found.length) {
    try {
      if (sel.type === 'node' && $(el).is(sel.value)) found = [el];
      else if (sel.type === 'class' && $(el).hasClass(sel.value)) found = [el];
      else if (sel.type === 'id' && $(el).attr('id') === sel.value) found = [el];
    } catch (e) { /* ignore */ }
  }
  return applyIndexAndRange(found, sel);
}

function applyIndexAndRange(arr, sel) {
  let list = arr.slice();
  // !N:M:K 排除
  if (sel.excludes && sel.excludes.length) {
    const set = new Set(sel.excludes);
    list = list.filter((_, i) => !set.has(i));
  }
  // 索引/区间
  if (sel.index != null) {
    if (typeof sel.index === 'number') {
      let idx = sel.index;
      if (idx < 0) idx = list.length + idx; // 负索引=从末尾
      list = list[idx] != null ? [list[idx]] : [];
    } else if (sel.index.range) {
      const { start, end, step } = sel.index;
      const st = step === 0 ? 1 : step;
      const picked = [];
      if (st > 0) {
        for (let i = start; i < end; i += st) if (list[i]) picked.push(list[i]);
      } else {
        // 负步长：先正序取区间再反转
        for (let i = start; i < end; i++) if (list[i]) picked.push(list[i]);
        picked.reverse();
      }
      list = picked;
    }
  }
  return list;
}

// 解析选择器 token → {type, value, index, excludes}
function parseSel(tok) {
  let t = (tok || '').trim();
  if (t === '') return null;
  // 排除符号 !N / !N:M:K（如 class.listmain@dd!0:1:2）
  let excludes = null;
  const excl = t.match(/!([\d:]+)$/);
  if (excl) {
    excludes = excl[1].split(':').map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    t = t.slice(0, t.length - excl[0].length);
  }
  // 文本搜索 text.xxx
  if (/^text\./.test(t)) return { type: 'text-search', value: t.replace(/^text\./, ''), excludes };
  if (t.startsWith('[')) return { type: 'node', value: t, excludes };
  // 前缀识别（先于索引剥离，避免 class.searchTopic.0 丢失 class 前缀）
  let base = t;
  let type = 'node';
  let m2 = t.match(/^class\.(.+)$/);
  if (m2) { type = 'class'; base = m2[1]; }
  else {
    m2 = t.match(/^id\.(.+)$/);
    if (m2) { type = 'id'; base = m2[1]; }
    else {
      m2 = t.match(/^tag\.(.+)$/);
      if (m2) { type = 'node'; base = m2[1]; }
    }
  }
  // 剥离尾部 Legado 索引/区间：.N / .N:M / .N:M:K / .-N
  const m = base.match(/\.(-?\d+(?::\d+)?(?::-?\d+)?)$/);
  let index = null;
  if (m) {
    const seg = m[1].split(':').map((x) => parseInt(x, 10));
    if (seg.length === 1) {
      index = seg[0];
    } else {
      index = { range: true, start: seg[0], end: seg[1] != null ? seg[1] : seg[0], step: seg[2] != null ? seg[2] : 1 };
    }
    base = base.slice(0, base.length - m[0].length);
  }
  if (base === '') return null;
  if (base.startsWith('-')) return null; // 负号开头（少见），忽略
  return { type, value: base, index, excludes };
}

function textOf(el, $) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}
function ownTextOf(el, $) {
  return $(el).contents().filter((i, n) => n.type === 'text').text().replace(/\s+/g, ' ').trim();
}
function textNodesOf(el, $) {
  return $(el).text().replace(/\s+/g, '\n').trim().replace(/\n+/g, '\n');
}
function stripText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ---- 模板替换：用 key/page/baseUrl 填 searchUrl ----
function buildUrl(url, vars) {
  let u = url || '';
  for (const k of Object.keys(vars)) {
    u = u.split('{{' + k + '}}').join(vars[k]);
  }
  u = u.split('{{')[0];
  const comma = u.indexOf(',{');
  if (comma >= 0) u = u.slice(0, comma);
  return u.trim();
}

module.exports = { extractValue, queryElements, buildUrl, cheerio };
