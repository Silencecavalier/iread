/* =========================================================================
 * sources/index.js — 书源管理（导入 / 启停 / 搜索 / 目录 / 正文）
 * -------------------------------------------------------------------------
 * 书源就是「开源阅读 Legado」的那套 JSON，直接导入即可用（见 legado.js）。
 * 数据存在 IndexedDB 的 nr_sources 里，和书架同一套存储层。
 *
 * 对外（页面里用）：
 *   await NR.sources.init()
 *   NR.sources.list()                          → 全部书源
 *   NR.sources.enabled()                       → 启用的书源
 *   await NR.sources.importText(text)          → 导入 JSON 文本（对象/数组/JSONL 都行）
 *   await NR.sources.remove(id) / setEnabled(id, on)
 *   await NR.sources.search(kw, {page})        → 合并去重后的结果
 *   await NR.sources.detail(id, bookUrl)
 *   await NR.sources.catalog(id, bookUrl)
 *   await NR.sources.content(id, chapter)
 *   await NR.sources.test(id, kw)
 *   await NR.sources.sampleSources()           → 内置示例（模板，默认禁用）
 * ========================================================================= */
(function (global) {
  'use strict';

  var S = global.NR.store;
  var L = global.NR.legado;
  var KEY = 'nr_sources';

  var list = [];            // 书源数组
  var ready = null;
  var memCache = Object.create(null);   // 正文内存缓存
  var inflight = Object.create(null);

  function fail(msg) { throw new Error(msg); }

  function canonical(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + canonical(value[key]);
    }).join(',') + '}';
  }

  function safeDiagUrl(value) {
    try { var url = new URL(String(value || '')); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : ''; }
    catch (e) { return ''; }
  }

  function safeTrace(row) {
    if (!row || typeof row !== 'object') return null;
    var out = {};
    ['facet', 'field', 'code', 'cause', 'source', 'segmentKind'].forEach(function (key) {
      if (typeof row[key] === 'string' || typeof row[key] === 'number') out[key] = String(row[key]).slice(0, 200);
    });
    if (Number.isInteger(row.segmentIndex)) out.segmentIndex = row.segmentIndex;
    return out;
  }

  function safePagination(row) {
    if (!row || typeof row !== 'object') return undefined;
    var out = {};
    if (Number.isFinite(row.pages)) out.pages = Math.max(0, Math.floor(row.pages));
    if (typeof row.complete === 'boolean') out.complete = row.complete;
    if (/^(end|loop|cap|chapter-boundary|error)$/.test(row.stoppedBy)) out.stoppedBy = row.stoppedBy;
    if (/^(available|unavailable)$/.test(row.boundaryCheck)) out.boundaryCheck = row.boundaryCheck;
    if (Number.isFinite(row.filteredBoundary)) out.filteredBoundary = Math.max(0, Math.floor(row.filteredBoundary));
    return out;
  }

  function safeEvidence(ev) {
    if (!ev || typeof ev !== 'object') return null;
    var out = {
      keywordsTried: Array.isArray(ev.keywordsTried) ? ev.keywordsTried.slice(0, 16).map(function (x) { return String(x).slice(0, 256); }) : [],
      probe: String(ev.probe || ''), http: ev.http, url: safeDiagUrl(ev.url), nodes: ev.nodes, bodyLen: ev.bodyLen,
      chaptersTested: Array.isArray(ev.chaptersTested) ? ev.chaptersTested.slice(0, 16).map(function (row) { return { idx: row.idx, len: row.len }; }) : [],
      ms: ev.ms,
      attempts: Array.isArray(ev.attempts) ? ev.attempts.slice(0, 64).map(function (row) {
        return { stage: row.stage, code: row.code, cause: row.cause, url: safeDiagUrl(row.url), http: row.http, ms: row.ms };
      }) : [],
      traces: Array.isArray(ev.traces) ? ev.traces.slice(0, 64).map(safeTrace).filter(Boolean) : []
    };
    if (ev.probeBook) out.probeBook = { title: ev.probeBook.title, author: ev.probeBook.author, bookUrl: safeDiagUrl(ev.probeBook.bookUrl) };
    if (ev.site) out.site = { ok: ev.site.ok, http: ev.site.http, ms: ev.site.ms, url: safeDiagUrl(ev.site.url) };
    if (ev.listLevel) { out.listLevel = true; out.listCount = ev.listCount || 0; }
    var pagination = safePagination(ev.pagination);
    if (pagination) out.pagination = pagination;
    return out;
  }

  function contentGeneration(src, chapters) {
    var context = L.contentContext(src, chapters);
    var boundary = context.available ? context.chapterUrls.map(function (url) { return L.pageUrlKey(url, src.url); }).sort() : null;
    var text = canonical({
      url: src.url,
      ruleToc: src.ruleToc,
      ruleContent: src.ruleContent,
      init: src.ruleBookInfo && src.ruleBookInfo.init,
      tocUrl: src.ruleBookInfo && src.ruleBookInfo.tocUrl,
      headers: src.headers,
      jsLib: src.jsLib,
      charset: src.charset,
      requestCharset: src.requestCharset,
      lenientDecode: src.lenientDecode,
      boundary: boundary
    });
    var left = 5381, right = 52711;
    for (var i = 0; i < text.length; i++) {
      left = ((left << 5) + left + text.charCodeAt(i)) | 0;
      right = ((right << 5) + right ^ text.charCodeAt(i)) | 0;
    }
    return { generation: 'g' + (left >>> 0).toString(36) + (right >>> 0).toString(36), chapterUrls: context.chapterUrls };
  }

  function withDiag(value, diag) {
    if (diag) Object.defineProperty(value, '__diag', { value: diag, enumerable: false, configurable: true });
    return value;
  }

  /* ------------------------------------------------------------ 读写 */
  function load() {
    if (ready) return ready;
    ready = S.get(KEY).then(function (raw) {
      list = Array.isArray(raw) ? raw.filter(function (s) { return s && s.name; }) : [];
      return list;
    }).catch(function () { list = []; return list; });
    return ready;
  }

  function save() { return S.set(KEY, list); }

  /* ------------------------------------------------------------ 导入解析 */
  function parseImport(text) {
    var original = String(text || '');
    var s = original.trim();
    if (!s) return { sources: [], errors: ['没有内容'], warnings: [] };
    var data, lineErrors = [];
    try { data = JSON.parse(s); }
    catch (e) {
      // JSONL / 一行一个书源：保留有效行，并按原始文本报告物理行号。
      var arr = [];
      original.split(/\r?\n/).forEach(function (ln, index) {
        if (!ln.trim()) return;
        try { arr.push(JSON.parse(ln)); }
        catch (e2) { lineErrors.push('第 ' + (index + 1) + ' 行：JSON 语法错误'); }
      });
      data = arr;
    }
    if (data && data.bookSources) data = data.bookSources;      // 某些导出格式
    if (data && data.sources) data = data.sources;
    if (!Array.isArray(data)) data = [data];

    var out = [], errors = lineErrors, warnings = [];
    var capabilities = global.NR.sourceCapabilities;
    data.forEach(function (raw) {
      try {
        // 订阅源（RSS）长得像书源，但字段是 ruleArticles/sortUrl
        if (raw && !raw.bookSourceName && !raw.ruleSearch && (raw.ruleArticles || raw.sortUrl)) {
          throw new Error('这是订阅源（RSS），不是书源');
        }
        // 登录字段会被 normalize 丢弃：先检查原始导入对象，只保留普通数据提示。
        var assessment = capabilities ? capabilities.assess(raw) : [];
        var normalized = L.normalize(raw);
        normalized.capabilityWarnings = assessment;
        out.push(normalized);
        assessment.forEach(function (row) {
          if (row.status !== 'supported') {
            warnings.push(Object.assign({ sourceId: normalized.id, sourceName: normalized.name }, row));
          }
        });
      } catch (e) {
        errors.push(((raw && (raw.bookSourceName || raw.sourceName || raw.name)) || '?') + '：' + e.message);
      }
    });
    if (!out.length) {
      return { sources: [], errors: ['没有可用的书源' + (errors.length ? '：' + errors.join('，') : '')], warnings: warnings };
    }
    return { sources: out, errors: errors, warnings: warnings };
  }

  /* ------------------------------------------------------------ 链接解析 */
  /* yuedu://booksource/importonline?src=<书源地址>（开源阅读的分享链接） */
  function extractLinks(text, yueduOnly) {
    var out = [], seen = Object.create(null), m;
    var re = /yuedu:\/\/[^\s"'<>]+/gi;
    while ((m = re.exec(text))) {
      var raw = m[0].replace(/[.,;，。；、]+$/, '');
      var url = '', host = '';
      try {
        var u = new URL(raw);
        host = String(u.host || '').toLowerCase();
        url = u.searchParams.get('src') || '';
      } catch (e) { /* 老链接可能不合法，下面兜底 */ }
      if (!url && /[?&]src=/i.test(raw)) {
        var tail = raw.split(/[?&]src=/i)[1] || '';
        url = tail.split('&')[0];
        try { url = decodeURIComponent(url); } catch (e2) { }
      }
      if (url && !seen[url]) { seen[url] = 1; out.push({ kind: host, url: url }); }
    }
    if (!yueduOnly) {
      var re2 = /https?:\/\/[^\s"'<>]+/gi;
      while ((m = re2.exec(text))) {
        var raw2 = m[0].replace(/[.,;，。；、]+$/, '');
        if (!seen[raw2]) { seen[raw2] = 1; out.push({ kind: 'http', url: raw2 }); }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ 对外 API */
  var ephemeral = Object.create(null);

  var api = {
    init: function () { return load().then(function () { return list.length; }); },

    list: function () { return list.slice(); },

    /* 临时书源：只给 get() 用（插件自带的源走这里，不进 list，
       所以搜索/筛选/书源管理都看不到，但原生阅读器能正常取正文。
       注意：不落盘、不随备份走，重启后由插件重新注册。 */
    putEphemeral: function (src) {
      if (!src || !src.id) throw new Error('putEphemeral 需要带 id 的书源对象');
      ephemeral[src.id] = src;
      return src.id;
    },
    delEphemeral: function (id) { delete ephemeral[id]; },
    ephemeral: function () { return Object.keys(ephemeral).map(function (k) { return ephemeral[k]; }); },
    enabled: function () { return list.filter(function (s) { return s.enabled !== false; }); },
    get: function (id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return ephemeral[id] || null;
    },
    need: function (id) {
      var s = api.get(id);
      if (!s) fail('书源不存在：' + id);
      return s;
    },

    /** 导入 JSON 文本，返回 { added, updated, total, errors, warnings }；提示不禁用书源 */
    importText: async function (text, opts) {
      opts = opts || {};
      dtCheckSignal(opts.signal);
      await load();
      dtCheckSignal(opts.signal);
      var got = parseImport(text);
      var bl = await api.blacklist();
      dtCheckSignal(opts.signal);
      var added = 0, updated = 0, skipped = 0;
      var touched = [];                       // 这一批真正导进来的 id（用来归组）
      got.sources.forEach(function (ns) {
        // 黑名单里的源（之前测出来失效的）不再加回来
        if (api.blacklistHas(ns.name, ns.url, bl)) { skipped++; return; }
        var hit = -1;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === ns.id) { hit = i; break; }
        }
        if (hit >= 0) {
          // 只搬运旧记录里真实存在的字段：老版本写下的记录可能没有 enabled/lastOk/lastFail/lastError，
          // 直接赋值会把 undefined 带进内存列表，之后每次保存都会被判定成「非 JSON 值」而失败。
          var old = list[hit];
          ns.addedAt = old.addedAt || Date.now();
          if (old.enabled !== undefined) ns.enabled = old.enabled;
          if (old.starred !== undefined) ns.starred = old.starred;  // 收藏 / 失效状态跟着旧记录走
          ns.group = old.group || '';        // 用户分好的组也别被冲掉
          if (old.lastOk !== undefined) ns.lastOk = old.lastOk;
          if (old.lastFail !== undefined) ns.lastFail = old.lastFail;
          if (old.lastError !== undefined) ns.lastError = old.lastError;
          list[hit] = ns;
          updated++;
          touched.push(ns.id);
        } else {
          list.push(ns);
          added++;
          touched.push(ns.id);
        }
      });
      await save();
      return { added: added, updated: updated, skipped: skipped, ids: touched, total: list.length, errors: got.errors, warnings: got.warnings };
    },

    /**
     * 从 yuedu:// 链接 / 网页地址导入（开源阅读的分享链接就是这个格式）：
     *   yuedu://booksource/importonline?src=<书源 json 地址>
     *   yuedu://rsssource/importonline?src=<订阅源 json 地址>  → 顺着订阅源的地址继续找书源
     *   直接给 json 地址、或者给一个列着一堆 yuedu:// 链接的网页也行
     * 返回 { added, updated, failed[], notes[], warnings[] }
     */
    importFromLinks: async function (text, opts) {
      opts = opts || {};
      dtCheckSignal(opts.signal);
      await load();
      dtCheckSignal(opts.signal);
      var links = extractLinks(String(text || ''), false);
      if (!links.length) fail('没找到 yuedu:// 链接或 http(s) 地址');
      var P = global.NR.platform;
      if (!P || !P.fetchText) fail('网络模块不可用');

      var summary = { added: 0, updated: 0, failed: [], notes: [], warnings: [], links: links.length };
      var visited = Object.create(null);
      var budget = opts.maxRequests || 40;

      async function importDownloaded(txt, url) {
        var r = await api.importText(txt, opts);
        summary.added += r.added;
        summary.updated += r.updated;
        summary.warnings = summary.warnings.concat(r.warnings || []);
        (r.errors || []).forEach(function (error) { summary.notes.push(url + '：' + error); });
      }

      async function handle(url, depth) {
        dtCheckSignal(opts.signal);
        if (!url || visited[url] || budget <= 0) return;
        visited[url] = 1;
        budget--;

        var res = await P.fetchText({ url: url, timeout: opts.timeout || 20000, signal: opts.signal, deadline: opts.deadline });
        dtCheckSignal(opts.signal);
        var txt = String((res && res.text) || '');
        if (!txt) { summary.notes.push('空内容：' + url); return; }

        var parsed = null;
        try { parsed = JSON.parse(txt); } catch (e) { parsed = null; }

        if (parsed) {
          var arr = Array.isArray(parsed) ? parsed : [parsed];
          var isRss = arr.length > 0 && arr.every(function (o) {
            return o && !o.bookSourceName && !o.ruleSearch && (o.ruleArticles || o.sortUrl);
          });
          if (isRss) {
            summary.notes.push('这条是订阅源，顺着它给的地址找书源');
            for (var i = 0; i < arr.length; i++) {
              if (arr[i].sourceUrl) await handle(arr[i].sourceUrl, depth + 1);
            }
            return;
          }
          await importDownloaded(txt, url);
          return;
        }

        // JSONL 也是书源数据，不能落入网页链接提取；导入错误经 notes 返回。
        if (/^\s*[{[]/.test(txt)) {
          await importDownloaded(txt, url);
          return;
        }

        // 不是 JSON：当网页，抽里面的 yuedu:// 书源链接
        if (depth >= 2) return;
        var found = extractLinks(txt, true).filter(function (x) { return x.url !== url; });
        if (!found.length) { summary.notes.push('这个地址里没有书源链接'); return; }
        summary.notes.push('网页里找到 ' + found.length + ' 个书源链接');
        for (var k = 0; k < found.length; k++) {
          try { await handle(found[k].url, depth + 1); }
          catch (e) {
            dtCheckSignal(opts.signal);
            if (/^(CANCELLED|UNSUPPORTED|ENCODING)$/.test(dtCode(e))) throw e;
            summary.failed.push(found[k].url + '：' + ((e && e.message) || e));
          }
        }
      }

      for (var i = 0; i < links.length; i++) {
        try { await handle(links[i].url, 0); }
        catch (e) {
          dtCheckSignal(opts.signal);
          if (/^(CANCELLED|UNSUPPORTED|ENCODING)$/.test(dtCode(e))) throw e;
          summary.failed.push(links[i].url + '：' + ((e && e.message) || e));
        }
      }
      dtCheckSignal(opts.signal);
      return summary;
    },

    extractLinks: extractLinks,

    remove: async function (id) {
      await load();
      var gone = list.filter(function (s) { return s.id === id; });
      list = list.filter(function (s) { return s.id !== id; });
      await save();
      await api.binAdd(gone);
      return list.length;
    },

    /* ------------------------------------------------ 回收站（删除的源）*/
    /** 被删掉的源留一份完整快照，阅读页「重新导入这个源」时能原样恢复 */
    binAdd: async function (items) {
      if (!items || !items.length) return 0;
      var bin = [];
      try { bin = (await S.get('nr_source_bin')) || []; } catch (e) { bin = []; }
      var seen = Object.create(null);
      bin.forEach(function (x) { if (x && x.id) seen[x.id] = 1; });
      (items || []).forEach(function (s) {
        if (!s) return;
        var i = bin.findIndex(function (x) { return x && x.id === s.id; });
        var entry = { id: s.id, name: s.name, url: s.url, at: Date.now(), src: s };
        if (i >= 0) bin[i] = entry; else bin.push(entry);
      });
      if (bin.length > 300) bin = bin.slice(bin.length - 300);
      await S.set('nr_source_bin', bin);
      return bin.length;
    },

    binList: async function () {
      try { return (await S.get('nr_source_bin')) || []; } catch (e) { return []; }
    },

    /** 按 id 或名字从回收站恢复一个源（会顺带把它从黑名单拿掉） */
    restoreFromBin: async function (idOrName) {
      await load();
      var bin = await api.binList();
      var hit = bin.filter(function (x) {
        return x && (x.id === idOrName || x.name === idOrName);
      })[0];
      if (!hit || !hit.src) return null;
      var exist = api.get(hit.id);
      if (exist) { await api.setEnabled(hit.id, true); return exist; }
      var r = await api.importText(JSON.stringify([hit.src]));
      if (r.skipped) {
        await api.blacklistRemove(hit.name);
        r = await api.importText(JSON.stringify([hit.src]));
      }
      var got = api.get(hit.id);
      if (got) { got.enabled = true; got.lastFail = 0; await save(); }
      return got || null;
    },

    setEnabled: async function (id, on) {
      await load();
      var s = api.get(id);
      if (!s) return false;
      s.enabled = !!on;
      await save();
      return true;
    },

    clear: async function () {
      list = [];
      await save();
    },

    /* -------------------------------------------------- 搜索 */
    /**
     * 流式搜索（对齐 Legado SearchModel：每个源一个任务，谁先回来先输出）
     * opts: { page, timeout=5000, concurrency=12, sources[], signal{stop},
     *         onSource({source, items, ok, error, ms, done, total}), onProgress }
     * 收藏的源排在最前面；超时/网络错误的源会被记成失效（持久化）
     */
    searchStream: async function (keyword, opts) {
      await load();
      opts = opts || {};
      var kw = String(keyword || '').trim();
      if (!kw) return { done: 0, total: 0 };
      var page = opts.page || 1;
      var timeout = opts.timeout || 5000;
      var only = opts.sources && opts.sources.length ? opts.sources : null;
      var concurrency = Math.max(1, Math.min(24, opts.concurrency || 12));

      var pool = api.enabled().filter(function (s) {
        if (!s.searchUrl) return false;
        return !only || only.indexOf(s.id) >= 0;
      });
      // 收藏源优先，其次最近能用的、再其次没试过的
      pool = pool.slice().sort(function (a, b) {
        var sa = a.starred ? 1 : 0, sb = b.starred ? 1 : 0;
        if (sa !== sb) return sb - sa;
        var oa = a.lastOk || 0, ob = b.lastOk || 0;
        if (oa !== ob) return ob - oa;
        var fa = a.lastFail || 0, fb = b.lastFail || 0;
        return fa - fb;
      });

      var total = pool.length;
      var done = 0, idx = 0;
      var stop = opts.signal;

      async function worker() {
        while (idx < pool.length) {
          if (stop && stop.aborted) return;
          var src = pool[idx++];
          var t0 = Date.now();
          try {
            var items;
            try { items = await L.run('search', src, [kw, page], { timeout: timeout, signal: stop }); }
            catch (e0) {
              // legado.search 现在对「有节点但书名/链接全空」抛 EMPTY_FIELDS；
              // 普通搜索沿用旧行为：当成功、0 条结果（旧版这里直接返回 []）
              if (e0 && e0.code === 'EMPTY_FIELDS') items = [];
              else throw e0;
            }
            if (stop && stop.aborted) return;
            done++;
            src.lastOk = Date.now();
            src.lastError = '';
            if (opts.onSource) {
              try { opts.onSource({ source: src, items: items || [], ok: true, ms: Date.now() - t0, done: done, total: total }); } catch (e) { window.__nrOnSourceErr = (e && e.stack) || String(e); }
            }
          } catch (e) {
            if (e && e.code === 'CANCELLED' || stop && stop.aborted) return;
            done++;
            var msg = (e && e.message) || '失败';
            var isTimeout = !!(e && e.timeout) || /超时/.test(msg);
            if (e && e.code === 'UNSUPPORTED') src.lastError = '[不兼容] ' + msg;
            if (isTimeout) msg = '超时';
            // 超时 / 网络错误 / HTTP 错误 → 区分站点确实没了（404/410 → lastFail）和临时问题（其余 → lastUnknown）
            if (isTimeout || /ERR_|net::|HTTP (4|5)\d\d|超时/.test(msg)) {
              var h4 = /\bHTTP\s+(404|410)\b/.test(msg);
              if (h4) { src.lastFail = Date.now(); }
              else { src.lastUnknown = Date.now(); }
              src.lastError = msg;
            }
            if (opts.onSource) {
              try { opts.onSource({ source: src, items: [], ok: false, error: msg, code: e && e.code, timeout: isTimeout, ms: Date.now() - t0, done: done, total: total }); } catch (e2) { }
            }
          }
          if (opts.onProgress) {
            try { opts.onProgress(done, total); } catch (e3) { }
          }
        }
      }

      var workers = [];
      for (var w = 0; w < Math.min(concurrency, pool.length); w++) workers.push(worker());
      await Promise.all(workers);
      await save();     // 把 lastOk/lastFail 记下来
      return { done: done, total: total, stopped: !!(stop && stop.aborted) };
    },

    /** 同步版搜索（测试/脚本用）：跑完再返回，内部就是 searchStream 收集 */
    search: async function (keyword, opts) {
      opts = opts || {};
      var items = [], reports = [];
      var only = opts.sources && opts.sources.length ? opts.sources : null;
      var timeout = opts.timeout || 5000;
      var concurrency = Math.max(1, Math.min(24, opts.concurrency || 12));
      await api.searchStream(keyword, {
        page: opts.page || 1, timeout: timeout, concurrency: concurrency,
        sources: only, signal: opts.signal,
        onProgress: opts.onProgress,
        onSource: function (r) {
          reports.push({
            sourceId: r.source.id, name: r.source.name, ok: r.ok,
            count: (r.items || []).length, ms: r.ms, error: r.error || ''
          });
          (r.items || []).forEach(function (b) { items.push(b); });
        }
      });
      // 按「书名+作者」合并，其它源记到 alsoOn（同一站点不同源也算，换源要靠它）
      var seen = Object.create(null), merged = [];
      items.forEach(function (b) {
        var key = (b.title || '') + '|' + (b.author || '');
        var old = seen[key];
        if (old) {
          if (b.sourceId && b.sourceId !== old.sourceId) {
            old.alsoOn = old.alsoOn || [];
            if (!old.alsoOn.some(function (x) { return x.sourceId === b.sourceId && x.bookUrl === b.bookUrl; })) {
              old.alsoOn.push({ sourceId: b.sourceId, sourceName: b.sourceName, bookUrl: b.bookUrl });
            }
          }
          return;
        }
        seen[key] = b;
        merged.push(b);
      });
      return { items: merged, reports: reports, total: reports.length, empty: !reports.length };
    },

    /** 收藏 / 取消收藏书源（收藏的排在最前） */
    setStarred: async function (id, on) {
      await load();
      var s = api.get(id);
      if (!s) return false;
      s.starred = !!on;
      await save();
      return true;
    },
    starred: function () { return list.filter(function (s) { return s.starred; }); },

    /**
     * 手动判定（用户 2026-10-30）：在书源抽屉里把某个源手动定为「可用 / 失效」，纠正误杀。
     *   verdict = 'ok' | 'dead' 写入 s.manual；'' 表示清掉手动判定、回到自动结论。
     * 约定：
     *   - 只有 'dead' 的源才写 lastFail 吗？不写。手动失效只挂 manual 标记 + 说明文案，
     *     这样 autoPurge / removeInvalid / 删除失效源都不会把它删掉（手动结论不触发自动清理）。
     *   - 'ok' 时把 lastOk 顶到当前时间，行内/筛选立刻显示可用。
     */
    markVerdict: async function (id, verdict) {
      await load();
      var s = api.get(id);
      if (!s) return false;
      var v = String(verdict || '');
      if (v !== 'ok' && v !== 'dead') {
        delete s.manual;
        if (/^\[手工\]/.test(String(s.lastError || ''))) s.lastError = '';
        await save();
        return true;
      }
      s.manual = v;
      s.lastVerdictAt = Date.now();
      if (v === 'ok') {
        s.lastVerdict = 'ok';
        s.lastOk = Date.now();
        s.lastError = '';
      } else {
        s.lastVerdict = 'dead';
        s.lastError = '[手工] 手动标记为失效';
      }
      await save();
      return true;
    },

    /** 手动把某个源的失效状态清掉 */
    clearFail: async function (id) {
      await load();
      var s = api.get(id);
      if (!s) return;
      s.lastFail = 0;
      s.lastError = '';
      await save();
    },

    /** 批量删除（先改内存，一次落盘、一次渲染，几百个也不卡） */
    removeMany: async function (ids) {
      await load();
      var set = Object.create(null);
      (ids || []).forEach(function (id) { set[id] = 1; });
      var before = list.length;
      var gone = list.filter(function (s) { return set[s.id]; });
      list = list.filter(function (s) { return !set[s.id]; });
      if (list.length === before) return 0;
      await save();
      await api.binAdd(gone);
      return before - list.length;
    },

    /* ------------------------------------------------ 黑名单（隐藏功能） */
    blacklist: async function () {
      try { return (await S.get('nr_blacklist')) || []; } catch (e) { return []; }
    },
    blacklistAdd: async function (items) {
      var bl = await api.blacklist();
      var seen = Object.create(null);
      bl.forEach(function (x) { seen[(x.url || '') + '|' + (x.name || '')] = 1; });
      (items || []).forEach(function (s) {
        if (!s) return;
        var k = (s.url || '') + '|' + (s.name || '');
        if (seen[k]) return;
        seen[k] = 1;
        bl.push({ name: s.name || '', url: s.url || '', at: Date.now() });
      });
      if (bl.length > 5000) bl = bl.slice(bl.length - 5000);
      await S.set('nr_blacklist', bl);
      return bl.length;
    },
    blacklistHas: function (name, url, bl) {
      // 按「名字 + 站点地址」认源：同一个站点下有很多源，不能只看域名
      return (bl || []).some(function (x) {
        if (!name || x.name !== name) return false;
        if (url && x.url && x.url !== url) return false;
        return true;
      });
    },
    blacklistClear: async function () { await S.set('nr_blacklist', []); return 0; },
    blacklistRemove: async function (name) {
      var bl = await api.blacklist();
      var before = bl.length;
      bl = bl.filter(function (x) { return x.name !== name; });
      await S.set('nr_blacklist', bl);
      return before - bl.length;
    },

    /* ------------------------------------------------ 分组 */
    /** 分组名列表 = 自定义分组（可空组）∪ 书源里出现过的分组 */
    groupNames: async function () {
      await load();
      var seen = {};
      var out = [];
      function push(n) {
        n = String(n || '').trim();
        if (n && !seen[n]) { seen[n] = 1; out.push(n); }
      }
      // 1) 用户自己建的分组（nr_groups）
      var custom = [];
      try { custom = (await S.get('nr_groups')) || []; } catch (e) { custom = []; }
      custom.forEach(function (g) { push(typeof g === 'string' ? g : g.name); });
      // 2) 数据里实际存在的分组（导入时 bookSourceGroup 带进来的、归组归进去的）
      //    修复：之前只认 nr_groups，导致"导入的源带着分组名，但分组列表里永远不出现"
      list.forEach(function (s) {
        String(s.group || '').split(/,/).forEach(function (x) { push(x); });
      });
      return out;
    },

    addGroup: async function (name) {
      await load();
      var n = String(name || '').trim();
      if (!n) return false;
      var custom = (await S.get('nr_groups')) || [];
      var names = custom.map(function (g) { return typeof g === 'string' ? g : g.name; });
      if (names.indexOf(n) < 0) { custom.push({ name: n, createdAt: Date.now() }); await S.set('nr_groups', custom); }
      return true;
    },

    renameGroup: async function (from, to) {
      await load();
      var a = String(from || '').trim(), b = String(to || '').trim();
      if (!a || !b || a === b) return 0;
      var n = 0;
      list.forEach(function (s) {
        var gs = String(s.group || '').split(/,/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (gs.indexOf(a) < 0) return;
        gs = gs.map(function (g) { return g === a ? b : g; });
        s.group = gs.join(',');
        n++;
      });
      var custom = (await S.get('nr_groups')) || [];
      custom = custom.map(function (g) {
        var name = typeof g === 'string' ? g : g.name;
        return name === a ? Object.assign({}, typeof g === 'string' ? {} : g, { name: b }) : g;
      });
      var names = custom.map(function (g) { return typeof g === 'string' ? g : g.name; });
      if (names.indexOf(b) < 0) custom.push({ name: b, createdAt: Date.now() });
      await S.set('nr_groups', custom);
      await save();
      return n;
    },

    deleteGroup: async function (name) {
      await load();
      var a = String(name || '').trim();
      if (!a) return 0;
      var n = 0;
      list.forEach(function (s) {
        var gs = String(s.group || '').split(/,/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (gs.indexOf(a) < 0) return;
        gs = gs.filter(function (g) { return g !== a; });
        s.group = gs.join(',');
        n++;
      });
      var custom = (await S.get('nr_groups')) || [];
      custom = custom.filter(function (g) { return (typeof g === 'string' ? g : g.name) !== a; });
      await S.set('nr_groups', custom);
      await save();
      return n;
    },

    /** 给选中的书源设置分组（覆盖） */
    setGroupOf: async function (ids, name) {
      await load();
      var n = 0;
      (ids || []).forEach(function (id) {
        var s = api.get(id);
        if (!s) return;
        s.group = name || '';
        n++;
      });
      await save();
      return n;
    },

    /** 每个用户分组的统计（只统计用户分过组的源；不再自动出现「未分组」） */
    groups: function () {
      var map = Object.create(null);
      list.forEach(function (s) {
        var gs = String(s.group || '').split(/,/).map(function (x) { return x.trim(); }).filter(Boolean);
        gs.forEach(function (g) {
          if (!map[g]) map[g] = { name: g, total: 0, enabled: 0, bad: 0, ids: [] };
          map[g].total++;
          if (s.enabled !== false) map[g].enabled++;
          if (s.lastFail && s.lastFail > (s.lastOk || 0)) map[g].bad++;
          map[g].ids.push(s.id);
        });
      });
      return Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return b.total - a.total; });
    },

    /** 一键启用 / 停用整组 */
    setGroupEnabled: async function (group, on) {
      await load();
      var changed = 0;
      list.forEach(function (s) {
        var gs = String(s.group || '').split(/,/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (gs.indexOf(group) >= 0) { s.enabled = !!on; changed++; }
      });
      await save();
      return changed;
    },

    /* ------------------------------------------------ 筛选（分层探针） */
    /**
     * 筛选（快筛/慢筛/筛本组共用）：分层探针 + 五态判定。
     *   L1 发现页自证（有 exploreUrl 才走，≤6s，失败跳过）→ L2 用自证书名搜索
     *   → L3 兜底关键词（无自证书时；固定 8 词，整段 ≤8s）→ L0 站点可达（只在前面全是网络错时补测，写证据）
     *   → L4 书级：前 3 条结果依次 详情→目录→正文（首章有效即早停；慢筛首章失败再测中间章/末章）
     * verdict: ok | degraded | noResult | dead | unknown | capability
     * opts: { retries, stageTimeout, keywords, chapters, signal, deadline }
     *   retries 只对普通 unknown 类错误（NET/超时/5xx/403/429）重试，且共用同一个总期限；编码错误不重试
     *   keywords 关键词个数（快筛 3、慢筛 8）；chapters 测试章数（快筛 1、慢筛 3；缺省按 retries>0 推断）
     * 返回 { ok, verdict, stage, error, book, chapters, len, evidence:{...} }
     */
    deepTest: async function (id, timeout, forcedKw, opts) {
      opts = opts || {};
      dtCheckSignal(opts.signal);
      var t0 = Date.now();
      var deadline = Math.min(t0 + (timeout || 6000), Number(opts.deadline) || Infinity);
      await load();
      dtCheckSignal(opts.signal);
      var src = api.need(id), runSrc = Object.assign({}, src, { __trace: true });
      var retries = Math.max(0, Math.min(3, opts.retries || 0));
      var budget = Math.max(0, deadline - t0);
      var stageCap = opts.stageTimeout || 4500;
      // 慢筛（有重试/给了阶段超时/要测 3 章）关键词取满 8 个；快筛取 opts.keywords（缺省 3）
      var slow = retries > 0 || !!opts.stageTimeout || (opts.chapters || 0) >= 3;
      // 快筛（listOnly）：只验证「能不能列出一本书」，不读目录/正文，也不会判成失效
      var listOnly = opts.listOnly ? true : !slow;
      var maxKw = forcedKw ? 1 : (slow ? DT_KEYWORDS.length
        : Math.max(1, Math.min(DT_KEYWORDS.length, opts.keywords || 3)));
      var maxCh = Math.max(1, Math.min(3, opts.chapters || (slow ? 3 : 1)));
      var media = Number(src.srcType || 0) !== 0;
      var stage = '搜索';
      var flaws = [];
      var searchBroken = '';   // L2 搜索失效但发现页有书时记录，最终并入 flaws（降级而非失效）
      var ev = {
        keywordsTried: [], probe: forcedKw ? 'keyword' : '', probeBook: null,
        http: undefined, url: '', nodes: undefined, bodyLen: undefined,
        chaptersTested: [], ms: 0, attempts: [], traces: []
      };

      /* 剩余时间：<=0 立即抛 BUDGET；sub 是阶段子期限（发现页 6s / 关键词 8s） */
      function left(cap, sub) {
        dtCheckSignal(opts.signal);
        var dl = Math.min(deadline, sub || Infinity);
        var ms = Math.max(0, Math.min(cap || stageCap, stageCap, dl - Date.now()));
        if (ms <= 0) {
          var mainOut = deadline - Date.now() <= 0;
          throw dtErr('BUDGET', mainOut ? '预算耗尽' : '阶段时限已到', { sub: !mainOut });
        }
        return ms;
      }
      function note(st, e, ms) {
        ev.attempts.push({
          stage: st, code: dtCode(e), cause: e && e.name || 'Error',
          url: safeDiagUrl(e && e.url), http: dtHttp(e), ms: ms
        });
      }
      function searchDiag(x) {
        var d = x && (x.__diag || x);
        if (!d) return;
        if (d.http !== undefined) ev.http = d.http;
        if (d.url) ev.url = safeDiagUrl(d.url);
        if (d.nodes !== undefined) ev.nodes = d.nodes;
        if (d.bodyLen !== undefined) ev.bodyLen = d.bodyLen;
      }
      function collectDiag(value) {
        var diag = value && value.__diag;
        if (diag && diag.pagination) ev.pagination = safePagination(diag.pagination);
        var rows = diag && diag.traces || value && value.traces;
        if (!Array.isArray(rows)) return;
        for (var i = 0; i < rows.length && ev.traces.length < 64; i++) {
          var row = safeTrace(rows[i]);
          if (row) ev.traces.push(row);
        }
      }
      /* 跑一个子请求：超时用剩余预算；只对 unknown 类错误在同一预算内重试 */
      async function call(st, operation, args, cap, sub) {
        var lastErr = null;
        for (var i = 0; i <= retries; i++) {
          var ms;
          try { ms = left(cap, sub); }
          catch (be) { if (dtCritical(be)) throw be; if (lastErr) throw lastErr; note(st, be, 0); throw be; }
          var a0 = Date.now();
          try {
            var value = await L.run(operation, runSrc, args, {
              timeout: ms, signal: opts.signal, deadline: Math.min(deadline, sub || Infinity)
            });
            dtCheckSignal(opts.signal);
            collectDiag(value);
            return value;
          } catch (e) {
            dtCheckSignal(opts.signal);
            lastErr = e;
            collectDiag(e);
            note(st, e, Date.now() - a0);
            if (dtCritical(e) || dtClass(e) !== 'unknown') throw e;
          }
        }
        throw lastErr;
      }
      function errText(st, e) {
        var c = dtCode(e);
        if (c === 'TIMEOUT' || (e && e.timeout)) return st + '超时';
        if (c === 'BUDGET') return st + '：' + ((e && e.message) || '预算耗尽');
        return st + '：' + String((e && e.message) || e || '失败');
      }
      async function finish(verdict, msg, book, chapters, len) {
        dtCheckSignal(opts.signal);
        var now = Date.now();
        ev.ms = now - t0;
        src.lastVerdict = verdict;
        src.lastVerdictAt = now;
        if (verdict === 'ok') { src.lastOk = now; src.lastError = ''; }
        else if (verdict === 'degraded') { src.lastOk = now; src.lastError = '[降级] ' + msg; }
        else if (verdict === 'noResult') { src.lastError = '[未搜到] ' + msg; }
        else if (verdict === 'dead') { src.lastFail = now; src.lastError = '[失效] ' + msg; }
        else if (verdict === 'capability') { src.lastError = '[不兼容] ' + msg; }
        // 不确定（超时/网络/5xx/403/429/编码）：不写 lastFail → removeInvalid / autoPurge 不会删它，只记时间和原因
        else { src.lastUnknown = now; src.lastError = '[不确定] ' + msg; }
        await save();
        return {
          ok: verdict === 'ok' || verdict === 'degraded', verdict: verdict, stage: stage,
          error: verdict === 'ok' ? '' : msg, book: book || '', chapters: chapters || 0, len: len || 0,
          evidence: safeEvidence(ev)
        };
      }
      /* L0：前面全是网络错时补测站点首页，只写证据，结论仍是 unknown */
      async function siteProbe() {
        dtCheckSignal(opts.signal);
        var P = global.NR.platform;
        if (!src.url || !P || !P.fetchText) return;
        var ms;
        try { ms = left(3000); } catch (e) { if (dtCritical(e)) throw e; return; }
        var a0 = Date.now(), previousStage = stage;
        stage = '站点';
        try {
          var r = await P.fetchText({ url: src.url, timeout: ms, signal: opts.signal, deadline: deadline });
          dtCheckSignal(opts.signal);
          ev.site = { ok: !!(r && r.ok), http: r && r.status, ms: Date.now() - a0, url: safeDiagUrl(src.url) };
        } catch (e) {
          dtCheckSignal(opts.signal);
          note('站点', e, Date.now() - a0);
          if (dtCritical(e)) throw e;
          ev.site = { ok: false, http: dtHttp(e), ms: Date.now() - a0, url: safeDiagUrl(src.url), cause: e && e.name || 'Error' };
        }
        stage = previousStage;
      }

      try {
        var items = null;
        var exItems = null;           // L1 发现页拿到的书（搜索失效时直接当 L4 候选）
        var netOnly = true;          // L1/L3 到目前为止是否全是 unknown 类失败

        /* ---------- L1 发现页自证 ---------- */
        if (!forcedKw && src.exploreUrl && deadline - Date.now() > 0) {
          stage = '发现';
          var exCap = Math.min(opts._exploreMs || DT_EXPLORE_MS, Math.max(1000, Math.floor(budget / 2)));
          var exSub = Date.now() + exCap;
          try {
            var ex = await call('发现', 'explore', [], exCap, exSub);
            netOnly = false;
            if (ex && ex.length) exItems = ex;
            for (var xi = 0; ex && xi < ex.length; xi++) {
              var xb = ex[xi];
              if (xb && String(xb.title || '').trim()) {
                ev.probeBook = { title: String(xb.title).trim(), author: xb.author || '', bookUrl: safeDiagUrl(xb.bookUrl) };
                break;
              }
            }
          } catch (e) {
            if (dtCritical(e)) throw e;
            if (dtClass(e) !== 'unknown') netOnly = false;
            // 普通发现页失败/超时：跳过，改走关键词，不算失败
          }
        }

        if (ev.probeBook) {
          /* ---------- L2 用自证书名搜索 ----------
           * 用户决定（2026-10-26）：发现页有书 = 源可用。搜索失效/搜不到不再判 dead，
           * 记 searchBroken 并入 flaws（最终至少 degraded），并直接用发现页的书进 L4
           * 验详情/目录/正文——可读就是 ok/degraded（都算可用），真不可读才可能 dead/unknown。 */
          ev.probe = 'explore';
          stage = '搜索';
          var pt = ev.probeBook.title;
          ev.keywordsTried.push(pt);
          /* 本源没配 searchUrl（站内搜索被站点挡住/策略上不提供）是正常形态，不是失效：
           * 直接拿发现页的书进 L4 验详情/目录/正文，通过就是 ok，不该因此降级或判死。
           * 用户口径（2026-10-30）：这类源只有发现页可用，不能被筛掉。 */
          if (!src.searchUrl) {
            items = exItems;
          } else {
            try {
              items = await call('搜索', 'search', [pt, 1]);
              searchDiag(items);
            } catch (e) {
              if (dtCritical(e)) throw e;
              searchDiag(e);
              if (dtClass(e) !== 'empty') {
                // 网络/超时类：源本身已被发现页自证活着 → 搜索不可用（降级），用发现页的书继续
                searchBroken = '搜索请求失败（' + errText('搜索', e) + '），已改用发现页的书验证';
              } else {
                searchBroken = '发现页有书但搜索不到（' + pt + '）：搜索规则失效';
              }
            }
            if (!items || !items.length) {
              if (!searchBroken) searchBroken = '发现页有书但搜索不到（' + pt + '）：搜索规则失效';
              items = exItems;   // L1 发现页的书直接当候选
            }
          }
        } else {
          /* ---------- L3 兜底关键词：固定顺序，整段共用 8 秒 ---------- */
          ev.probe = 'keyword';
          stage = '搜索';
          var kws = forcedKw ? [String(forcedKw)] : DT_KEYWORDS.slice(0, maxKw);
          var kwMs = opts._kwMs || DT_KW_MS;
          // 给 L0 站点探测留一点预算（≤1.5s、总预算的 20%），否则关键词全挂起时没时间补测
          var l0Reserve = Math.min(1500, Math.floor(budget * 0.2));
          var kwSub = Math.min(Date.now() + kwMs, deadline - l0Reserve);
          var kwByCap = Date.now() + kwMs <= deadline - l0Reserve;
          var kwStop = '', anyEmpty = false, lastUnknown = null;
          for (var ki = 0; ki < kws.length; ki++) {
            if (Math.min(deadline, kwSub) - Date.now() <= 0) {
              kwStop = kwByCap ? 'kwLimit' : 'budget';
              break;
            }
            var kw = kws[ki];
            ev.keywordsTried.push(kw);
            try {
              var got = await call('搜索', 'search', [kw, 1], stageCap, kwSub);
              searchDiag(got);
              netOnly = false;
              if (got && got.length) { items = got; break; }
              anyEmpty = true;
            } catch (e) {
              if (dtCritical(e)) throw e;
              searchDiag(e);
              if (dtCode(e) === 'BUDGET') {
                ev.keywordsTried.pop();     // 时间到了没真正发出去
                kwStop = kwByCap ? 'kwLimit' : 'budget';
                if (!lastUnknown && !anyEmpty) lastUnknown = e;
                break;
              }
              var cls = dtClass(e);
              if (cls === 'empty') { anyEmpty = true; netOnly = false; continue; }
              if (cls === 'dead') {                 // HTTP 404/410、RULE、NO_RULE
                if (listOnly) { lastUnknown = e; continue; }   // 快筛不下死结论
                throw e;
              }
              lastUnknown = e;                      // 网络/超时/5xx/403/429：换下一个词
            }
          }
          if (!items) {
            if (anyEmpty) {
              var tried = ev.keywordsTried.join('、');
              var why = kwStop === 'kwLimit' ? '；关键词阶段 ' + Math.round(kwMs / 1000) + ' 秒上限已到，实际试了 ' + ev.keywordsTried.length + ' 个'
                : (kwStop === 'budget' ? '；总预算用完，实际试了 ' + ev.keywordsTried.length + ' 个' : '');
              ev.kwStop = kwStop || 'all';
              return await finish('noResult', '试过：' + tried + why +
                (lastUnknown ? '（其中有请求失败：' + errText('搜索', lastUnknown) + '）' : ''));
            }
            if (netOnly) await siteProbe();
            var ue = lastUnknown || dtErr('BUDGET', '预算耗尽');
            var um = errText('搜索', ue);
            if (ev.site) um += ev.site.ok ? '（站点首页可达）' : '（站点首页也打不开）';
            return await finish('unknown', um);
          }
        }

        /* ---------- L4 书级：前 3 条依次 详情 → 目录 → 正文 ---------- */
        var cands = items.filter(function (b) { return b && b.bookUrl; }).slice(0, 3);
        if (!cands.length) {
          stage = '搜索';
          // 快筛不下死结论：列表解析不出书链接，可能只是规则细节不对，留给深筛或人工
          return await finish(listOnly ? 'unknown' : 'dead', '搜索结果没有书籍链接');
        }
        if (listOnly) {
          stage = '列表';
          ev.listLevel = true;
          ev.listCount = items.length;
          var hit0 = cands[0];
          var lf = searchBroken ? [searchBroken] : [];
          return await finish(lf.length ? 'degraded' : 'ok', lf.join('；'), (hit0 && hit0.title) || '', 0, 0);
        }
        var bookErrs = [];
        for (var bi = 0; bi < cands.length; bi++) {
          var it = cands[bi];
          var bookFlaws = [];
          var info = {};
          stage = '详情';
          try { info = (await call('详情', 'detail', [it.bookUrl])) || {}; }
          catch (e) {
            if (dtCritical(e)) throw e;
            if (dtCode(e) === 'BUDGET') { bookErrs.push(e); break; }
            bookFlaws.push('详情页失败已跳过（' + errText('详情', e) + '）');
            info = {};
          }
          stage = '目录';
          var cat;
          try {
            cat = await call('目录', 'catalog', [it.bookUrl, info]);
            if (!cat || !cat.chapters || !cat.chapters.length) throw dtErr('EMPTY_TOC', '目录为空');
          } catch (e) {
            if (dtCritical(e)) throw e;
            if (dtClass(e) === 'empty') e = dtErr('EMPTY_TOC', '目录为空（' + ((e && e.message) || '') + '）', { cause: e });
            bookErrs.push(e);
            if (dtCode(e) === 'BUDGET') break;
            continue;
          }
          var chs = cat.chapters, n = chs.length;
          var contentCtx = L.contentContext(src, chs);
          stage = '正文';
          var idxs = [0];
          if (maxCh >= 2 && n > 2) idxs.push(Math.floor((n - 1) / 2));
          if (maxCh >= 3 && n > 1) idxs.push(n - 1);
          else if (maxCh >= 2 && n === 2) idxs.push(1);
          var pass = null, shortHit = null, chErr = null, budgetOut = null;
          for (var ci = 0; ci < idxs.length; ci++) {
            var idx = idxs[ci], chObj = chs[idx];
            var j;
            try {
              var otherUrls = contentCtx.available ? contentCtx.chapterUrls.filter(function (url) {
                return L.pageUrlKey(url, src.url) !== L.pageUrlKey(chObj.url, src.url);
              }) : null;
              var c = await call('正文', 'content', otherUrls ? [chObj, { chapterUrls: otherUrls }] : [chObj]);
              j = dtJudge(c, media);
            } catch (e) {
              if (dtCritical(e)) throw e;
              if (dtCode(e) === 'BUDGET') { budgetOut = e; break; }
              chErr = e;
              j = { len: 0, level: 'bad' };
            }
            ev.chaptersTested.push({ idx: idx, len: j.len });
            if (j.level === 'ok') { pass = { idx: idx, len: j.len }; break; }   // 早停
            if (j.level === 'short' && !shortHit) shortHit = { idx: idx, len: j.len };
          }
          if (!pass && shortHit) { pass = shortHit; bookFlaws.push('正文偏短（' + shortHit.len + ' 字）'); }
          if (pass) {
            if (pass.idx !== 0) {
              var first = ev.chaptersTested.filter(function (x) { return x.idx === 0; })[0];
              bookFlaws.push(first && first.len >= 10 ? '首章正文偏短' : '首章不可读');
            }
            if (bi > 0) bookFlaws.push('前 ' + bi + ' 本书失败，第 ' + (bi + 1) + ' 本才成功');
            flaws = searchBroken ? [searchBroken].concat(bookFlaws) : bookFlaws;
            return await finish(flaws.length ? 'degraded' : 'ok', flaws.join('；'), it.title, n, pass.len);
          }
          if (budgetOut) { bookErrs.push(budgetOut); break; }
          bookErrs.push(chErr && dtClass(chErr) === 'unknown' ? chErr
            : dtErr('EMPTY_CONTENT', '所有测试章正文无效（测了 ' + idxs.length + ' 章）', { cause: chErr || undefined }));
        }
        // 3 本都没过：全是 dead 类 → dead；夹着网络/预算问题 → unknown。
        // 但发现页已自证有书（searchBroken）→ 用户决定判可用：降为 degraded，不删不拉黑。
        var unk = bookErrs.filter(function (e) { return dtClass(e) === 'unknown'; });
        var pick = unk.length ? unk[unk.length - 1] : bookErrs[bookErrs.length - 1];
        if (!pick) pick = dtErr('BUDGET', '预算耗尽');
        if (searchBroken) {
          flaws = [searchBroken, errText(stage, pick)];
          return await finish('degraded', flaws.join('；'));
        }
        return await finish((listOnly || unk.length) ? 'unknown' : 'dead', errText(stage, pick));
      } catch (e) {
        dtCheckSignal(opts.signal);
        if (dtCode(e) === 'CANCELLED') throw e;
        if (stage === '搜索') searchDiag(e);
        var cls2 = dtClass(e);
        if (cls2 === 'capability') return await finish('capability', errText(stage, e));
        if (dtCode(e) === 'ENCODING') return await finish('unknown', errText(stage, e));
        if (searchBroken) return await finish('degraded', searchBroken + '；' + errText(stage, e));
        return await finish((listOnly || cls2 === 'unknown') ? 'unknown' : 'dead', errText(stage, e));
      }
    },

    /* ------------------------------------------------ 失效源自动清理 */
    /** 删掉所有「失效」的源（收藏的不删），顺手记进黑名单，返回删掉的个数 */
    removeInvalid: async function (opts) {
      await load();
      opts = opts || {};
      var keepStar = opts.keepStarred !== false;
      var bad = list.filter(function (s) {
        if (keepStar && s.starred || /^\[不兼容\]/.test(s.lastError || '')) return false;
        if (s.manual) return false;   // 手动判定过的源（可用/失效）一律不自动删
        return !!(s.lastFail && s.lastFail > (s.lastOk || 0));
      });
      if (!bad.length) return 0;
      await api.blacklistAdd(bad.map(function (s) { return { name: s.name, url: s.url }; }));
      await api.binAdd(bad);
      var ids = bad.map(function (s) { return s.id; });
      var set = Object.create(null);
      ids.forEach(function (id) { set[id] = 1; });
      list = list.filter(function (s) { return !set[s.id]; });
      await save();
      return ids.length;
    },

    /* ------------------------------------------------ 书源站（yckceo） */
    /**
     * 该站「全选 → 生成」的本质：
     *   勾选的 ids 拼成 /yuedu/shuyuan/jsons?id=a-b-c 就是书源 JSON。
     * 这里直接按同样的规则取，不依赖它的临时短链。
     */
    YCK_BASE: 'https://www.yckceo.com',

    /** 列表页每页 100 个 checkbox；返回 { ids, page } */
    fetchYckPageIds: async function (page) {
      var Y = global.yedu;
      if (!Y || !Y.fetchText) throw new Error('网络模块不可用');
      var p = Math.max(1, parseInt(page, 10) || 1);
      var url = api.YCK_BASE + '/yuedu/shuyuan/index.html' + (p > 1 ? '?page=' + p : '');
      var r = await Y.fetchText({ url: url, timeout: 25000 });
      if (!r || !r.ok) throw new Error('书源列表打不开（HTTP ' + ((r && r.status) || '?') + '）');
      var ids = [];
      var re = /name="ids\[\]"\s+value="(\d+)"/g;
      var m;
      while ((m = re.exec(r.text))) ids.push(m[1]);
      if (!ids.length) throw new Error('这一页没有解析到书源');
      return { ids: ids, page: p };
    },

    /** 按 id 批量取书源 JSON：返回 { text, count } */
    fetchYckSources: async function (ids) {
      var Y = global.yedu;
      if (!Y || !Y.fetchText) throw new Error('网络模块不可用');
      var list = (ids || []).filter(Boolean);
      if (!list.length) throw new Error('没有书源 id');
      var url = api.YCK_BASE + '/yuedu/shuyuan/jsons?id=' + list.join('-');
      var r = await Y.fetchText({ url: url, timeout: 60000 });
      if (!r || !r.ok) throw new Error('书源内容取不到（HTTP ' + ((r && r.status) || '?') + '）');
      var arr;
      try { arr = JSON.parse(r.text); } catch (e) { throw new Error('返回的不是书源 JSON'); }
      if (!Array.isArray(arr) || !arr.length) throw new Error('这批书源是空的');
      return { text: JSON.stringify(arr), count: arr.length };
    },

    /**
     * 合集列表（第一页全部）：名称 / 时间 / 源数量 全部来自站点页面，
     * 这里只做解析，不改写。limit<=0 表示不限。
     */
    fetchYckCollections: async function (limit) {
      var Y = global.yedu;
      if (!Y || !Y.fetchText) throw new Error('网络模块不可用');
      var n = limit > 0 ? Math.min(200, limit) : 0;
      var r = await Y.fetchText({ url: api.YCK_BASE + '/yuedu/shuyuans/index.html', timeout: 25000 });
      if (!r || !r.ok) throw new Error('合集列表打不开（HTTP ' + ((r && r.status) || '?') + '）');
      var out = [];
      var blocks = String(r.text).split('class="ylist"').slice(1);
      for (var i = 0; i < blocks.length; i++) {
        if (n && out.length >= n) break;
        var b = blocks[i];
        var m = /content\/id\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p class="m-right"[^>]*>([\s\S]*?)<\/p>/.exec(b);
        if (!m) continue;
        var cnt = /源数量[:：]\s*(\d+)/.exec(b);
        out.push({
          id: m[1],
          name: String(m[2]).replace(/<[^>]+>/g, '').trim(),
          time: String(m[3]).replace(/<[^>]+>/g, '').trim(),
          count: cnt ? parseInt(cnt[1], 10) : 0
        });
      }
      return out;
    },

    /** 合集里的全部书源（站点直接给了 json 直链） */
    fetchYckCollectionJson: async function (id) {
      var Y = global.yedu;
      if (!Y || !Y.fetchText) throw new Error('网络模块不可用');
      var cid = String(id || '').replace(/[^\d]/g, '');
      if (!cid) throw new Error('合集 id 不对');
      var r = await Y.fetchText({
        url: api.YCK_BASE + '/yuedu/shuyuans/json/id/' + cid + '.json', timeout: 90000
      });
      if (!r || !r.ok) throw new Error('合集内容取不到（HTTP ' + ((r && r.status) || '?') + '）');
      var arr;
      try { arr = JSON.parse(r.text); } catch (e) { throw new Error('合集返回的不是书源 JSON'); }
      if (!Array.isArray(arr) || !arr.length) throw new Error('合集是空的');
      return { text: JSON.stringify(arr), count: arr.length };
    },

    /* -------------------------------------------------- 只读分类 / 详情 / 目录 / 正文 */
    exploreCategories: function (id) {
      var src = api.need(id);
      if (!src.exploreUrl) return [];
      return L.exploreEntries(src.exploreUrl).map(function (entry) {
        return { title: entry.title, url: entry.url };
      });
    },

    explore: function (id, url, options) {
      var src = api.need(id);
      if (!src.exploreUrl) return Promise.resolve([]);
      return L.run('explore', src, [{ url: url, maxTries: 1 }], options || {});
    },

    detail: function (id, bookUrl, options) { return L.run('detail', api.need(id), [bookUrl], options); },

    contentGeneration: function (id, chapters) { return contentGeneration(api.need(id), chapters); },
    sanitizeEvidence: safeEvidence,

    catalog: async function (id, bookUrl, info, options) {
      var src = api.need(id);
      if (!info || !info.tocUrl) {
        try {
          var d = await L.run('detail', src, [bookUrl], options);
          info = Object.assign({}, d, info || {});
        } catch (e) { if (e.code === 'CANCELLED' || e.code === 'UNSUPPORTED' || e.code === 'ENCODING') throw e; }
      }
      var got = await L.run('catalog', src, [bookUrl, info || {}], options);
      if (!got.chapters.length) fail('目录为空');
      return got;
    },

    content: function (id, chapter, options) {
      options = options || {};
      if (options.signal && options.signal.aborted) return Promise.reject(global.NR.tasks.error(false));
      var src = api.need(id), identity = contentGeneration(src, options.chapterUrls || []);
      var key = id + '::' + identity.generation + '::' + (chapter.url || chapter.t);
      if (memCache[key]) return Promise.resolve(memCache[key]);
      if (inflight[key]) return inflight[key].promise;
      var controller = new AbortController();
      var abort = function () { controller.abort(); };
      if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
      var entry = { controller: controller };
      var context = L.contentContext(src, identity.chapterUrls);
      var otherUrls = context.available ? context.chapterUrls.filter(function (url) {
        return L.pageUrlKey(url, src.url) !== L.pageUrlKey(chapter.url, src.url);
      }) : null;
      var args = otherUrls ? [chapter, { chapterUrls: otherUrls }] : [chapter];
      var p = L.run('content', src, args, Object.assign({}, options, { signal: controller.signal })).then(function (res) {
        if (controller.signal.aborted) throw global.NR.tasks.error(false);
        var out = withDiag({ t: res.t || chapter.t || '', text: res.text }, res.__diag);
        memCache[key] = out;
        evictContent();
        return out;
      }).finally(function () {
        if (options.signal) options.signal.removeEventListener('abort', abort);
        if (inflight[key] === entry) delete inflight[key];
      });
      entry.promise = p;
      inflight[key] = entry;
      return p;
    },

    /** 一键测试单个源（只看搜索能不能出结果）
     * r1-t1：与 deepTest / searchStream 对齐——「搜不到书」不再写 lastFail
     *   （写了就会被 removeInvalid / autoPurge 当失效删掉），改为 deepTest 的 noResult 同款语义：
     *   不写 lastFail，lastError 用 [未搜到] 前缀。只有明确坏了（HTTP 404/410、RULE、NO_RULE、
     *   UNSUPPORTED）才写 lastFail；说不准的（超时/网络/5xx/403）写 lastUnknown。 */
    test: async function (id, kw, options) {
      await load();
      var src = api.need(id);
      try {
        var r = await L.run('test', src, [kw || '剑来'], options);
        if (r && r.ok) { src.lastOk = Date.now(); src.lastError = ''; }
        else {
          var msg = (r && r.error) || '搜不到书';
          // L.test 跑完但 0 条结果（count===0 且没带 code）＝「站里没这本书」→ 未搜到
          var cls = (r && r.count === 0 && !r.code) ? 'empty'
            : dtClass({ code: r && r.code, message: msg });
          if (r && r.code === 'CANCELLED') throw global.NR.tasks.error(false);
          if (cls === 'capability') src.lastError = '[不兼容] ' + msg;
          else if (cls === 'empty') src.lastError = '[未搜到] ' + msg;
          else if (cls === 'dead') { src.lastFail = Date.now(); src.lastError = '[失效] ' + msg; }
          else { src.lastUnknown = Date.now(); src.lastError = '[不确定] ' + msg; }
        }
        await save();
        return r;
      } catch (e) {
        if (e && e.code === 'CANCELLED') throw e;
        var em = (e && e.message) || '测试失败';
        var ecls = dtClass(e);
        if (ecls === 'capability') src.lastError = '[不兼容] ' + em;
        else if (ecls === 'dead') { src.lastFail = Date.now(); src.lastError = '[失效] ' + em; }
        else if (ecls === 'empty') src.lastError = '[未搜到] ' + em;
        else { src.lastUnknown = Date.now(); src.lastError = '[不确定] ' + em; }
        await save();
        return { ok: false, code: e && e.code, error: src.lastError };
      }
    },

    clearCache: function () {
      Object.keys(inflight).forEach(function (key) { inflight[key].controller.abort(); });
      inflight = Object.create(null);
      memCache = Object.create(null);
    },

    /* -------------------------------------------------- 内置示例 */
    sampleSources: function () {
      return [
        {
          bookSourceName: '示例 · 本地演示站',
          bookSourceUrl: 'http://127.0.0.1:8123',
          bookSourceGroup: '示例',
          bookSourceComment: 'iread 自带的演示书源，指向 tools/fixture-server.js 起的本地站点。\n' +
            '想验证书源引擎、或自己写书源时拿它当模板：\n' +
            '  searchUrl  /search?q={{key}}&page={{page}}\n' +
            '  列表用 CSS，详情/目录/正文用 XPath 或 CSS 都行，也能 ##正则## 清洗。',
          enabled: false,
          searchUrl: '/search?q={{key}}&page={{page}}',
          ruleSearch: {
            bookList: '.book-item',
            name: 'h3 a@text',
            author: '.author@text',
            intro: '.intro@text',
            lastChapter: '.latest@text',
            bookUrl: 'h3 a@href'
          },
          ruleBookInfo: {
            name: '//h1[@class="book-title"]/text()',
            author: '//span[@class="book-author"]/text()',
            intro: '//div[@class="book-intro"]',
            tocUrl: '//a[@class="toc-link"]/@href'
          },
          ruleToc: {
            chapterList: '#chapter-list li a',
            chapterName: '@text',
            chapterUrl: '@href'
          },
          ruleContent: { content: '#content' }
        },
        {
          bookSourceName: '示例 · JSON 接口站',
          bookSourceUrl: 'http://127.0.0.1:8123/api',
          bookSourceGroup: '示例',
          bookSourceComment: '演示 JSON 书源：列表、目录、正文都走 JSONPath（$. 开头）。',
          enabled: false,
          searchUrl: '/api/search?q={{key}}',
          ruleSearch: {
            bookList: '$.data[*]',
            name: '$.title',
            author: '$.author',
            intro: '$.intro',
            bookUrl: '$.url'
          },
          ruleBookInfo: { name: '$.title', author: '$.author', intro: '$.intro' },
          ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },
          ruleContent: { content: '$.text' }
        }
      ];
    }
  };

  /* 并发池：同时最多 n 个任务，按原顺序返回结果；signal.stop 为真时不再领新任务 */
  async function runPool(list, n, fn, signal) {
    var out = new Array(list.length);
    var i = 0;
    async function worker() {
      while (i < list.length) {
        if (signal && signal.stop) break;
        var k = i++;
        out[k] = await fn(list[k], k);
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(n, list.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /* 正文内存缓存：最多 60 章，按写入顺序丢最早的（磁盘缓存还在，重取很快） */
  function evictContent() {
    var keys = Object.keys(memCache);
    for (var i = 0; i < keys.length - 60; i++) delete memCache[keys[i]];
  }

  /* ---------------- 筛选（deepTest）用的小工具 ---------------- */
  /* 兜底关键词：固定顺序、不按源轮换；快筛取前 3，慢筛最多 8 */
  var DT_KEYWORDS = ['重生', '斗罗大陆', '修仙', '总裁', '末世', '三国', '侦探', 'love'];
  var DT_EXPLORE_MS = 6000;   // 发现页自证阶段上限（超时跳过，不算失败）
  var DT_KW_MS = 8000;        // 关键词阶段总上限

  function dtErr(code, msg, extra) {
    var e = new Error(msg);
    e.code = code;
    if (extra) for (var k in extra) if (extra[k] !== undefined) e[k] = extra[k];
    return e;
  }

  /* 统一错误码：没 code 的宿主超时 → NET
   * r1-t1：rule.js 的 CSS 0 匹配不再抛「CSS 选择器写法有误：…」（改成返回空 → 列表规则由
   * legado.js 抛 NO_NODES），所以这里也删掉了靠 message 前缀识别的 dtIsCssEmpty 兼容。 */
  function dtCode(e) {
    if (!e) return 'UNKNOWN';
    if (e.code) return e.code;
    var m = String(e.message || e);
    if (/超时|timeout|timed?\s*out/i.test(m)) return 'NET';
    var hm = /\bHTTP\s+(\d{3})\b/.exec(m);
    if (hm && Number(hm[1]) >= 400) return 'HTTP';
    if (/ERR_|net::/.test(m)) return 'NET';
    return 'UNKNOWN';
  }

  function dtHttp(e) {
    if (!e) return undefined;
    if (e.http != null) return Number(e.http);
    var hm = /\bHTTP\s+(\d{3})\b/.exec(String(e.message || ''));
    return hm ? Number(hm[1]) : undefined;
  }

  /**
   * 错误分类（能力限制和取消不属于站点失效）：
   *   empty      —— 请求正常但没东西（NO_NODES / EMPTY_FIELDS / EMPTY_TOC / EMPTY_CONTENT）
   *   dead       —— 明确坏了（HTTP 404/410、RULE、NO_RULE）
   *   capability —— 不兼容（UNSUPPORTED）；cancelled —— 取消（CANCELLED）
   *   unknown    —— 说不准（NET/超时/BUDGET、HTTP 5xx/403/429/其他 4xx、BAD_JSON、ENCODING、无码异常）
   */
  function dtClass(e) {
    var c = dtCode(e);
    if (c === 'NO_NODES' || c === 'EMPTY_FIELDS' || c === 'EMPTY_TOC' || c === 'EMPTY_CONTENT') return 'empty';
    if (c === 'HTTP') {
      var h = dtHttp(e);
      return (h === 404 || h === 410) ? 'dead' : 'unknown';
    }
    if (c === 'UNSUPPORTED') return 'capability';
    if (c === 'CANCELLED') return 'cancelled';
    if (c === 'RULE' || c === 'NO_RULE' || c === 'SELECTOR' || c === 'XPATH') return 'dead';
    return 'unknown';
  }

  /* 关键错误不能进入普通站点/书籍/章节回退，也不能重试编码诊断。 */
  function dtCritical(e) {
    var c = dtCode(e);
    return c === 'CANCELLED' || c === 'UNSUPPORTED' || c === 'ENCODING';
  }

  function dtCheckSignal(signal) {
    if (signal && signal.aborted) throw global.NR.tasks.error(false);
  }

  /**
   * 正文是否有效：
   *   文字源（srcType 0/未设）：去空白后 ≥50 字 ok；10–49 字 short（算通过但降级）；<10 字 bad
   *   音频/视频/图片/文件源（srcType≠0）：正文非空或含 http 链接即 ok
   */
  function dtJudge(c, media) {
    var raw = c == null ? '' : (typeof c === 'string' ? c : (c.text != null ? c.text : (c.content != null ? c.content : '')));
    if (Array.isArray(raw)) raw = raw.join('\n');
    var s = String(raw == null ? '' : raw);
    var len = s.replace(/\s+/g, '').length;
    if (media) return { len: len, level: (len > 0 || /https?:\/\//i.test(s)) ? 'ok' : 'bad' };
    return { len: len, level: len >= 50 ? 'ok' : (len >= 10 ? 'short' : 'bad') };
  }

  global.NR = global.NR || {};
  global.NR.sources = api;
})(window);
