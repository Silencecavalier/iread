/* =========================================================================
 * online.js — 「发现」：流式搜索 / 书源聚合详情 / 书源抽屉
 * -------------------------------------------------------------------------
 * 搜索完全照 Legado 的 SearchModel 思路：
 *   · 一个书源一个任务，谁先回来谁先上屏（不等全部）
 *   · 单个源 5 秒不响应就判失效，并记到书源上（下次自动跳过）
 *   · 结果按「书名 + 作者」聚合成一本，详情里列出所有命中的源
 *   · 点进详情后搜索继续在后台跑，新源随时并入
 *   · 收藏的源排最前
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR || (global.NR = {});
  var el = function (id) { return document.getElementById(id); };

  var SEARCH_TIMEOUT = 5000;     // 单源超时（设置里可改）
  var CONCURRENCY = 12;          // 并发数（设置里可改）

  var state = {
    mode: 'idle',                // idle | searching | results | detail
    query: '',
    books: [],
    byKey: Object.create(null),
    searching: false,
    cancel: false,
    done: 0,
    total: 0,
    found: 0,
    detail: null,                // { book, srcIndex, info, catalog, error }
    returnView: 'online',        // 详情返回上下文；阅读返回详情时保留，back 后清除
    tested: {},                  // 书源 id → 手动测试结果
    selected: {},                // 书源抽屉里的勾选
    filter: 'all',
    group: '',                   // 分组筛选（'' = 全部）
    groupNames: [],             // 自定义 + 现有的分组名
    scanScope: 'all',          // 检测范围：all | group | untested
    groupPick: false,           // 分组页处于「多选」模式
    groupSel: {},               // 多选模式下已勾选的分组名
    q: '',                       // 书源抽屉里的搜索词
    renderQueued: false,
    feed: null,                  // 发现页热门：{ key, status, sourceId, url, title, books, error }
    hotrank: null,                // 发现页热榜：{ status, channelId, channelName, channels, items, failed, error }
    fromIdle: false,             // 详情是从发现页空态屏（热门/本地历史）打开的，返回要回空态屏
    pendingIdleDetail: false     // bindFeed 发出「从发现页打开详情」的意图，等 openDetail 消费
  };
  var operations = { search: null, deep: null, detail: null, find: null, feed: null, hotrank: null };
  var lifecycle = 0;

  function isCancelled(r) {
    return !!(r && (r.cancelled || r.code === 'CANCELLED' || r.code === 'RULE_CANCELLED' || r.name === 'AbortError'));
  }
  function owns(kind, op) { return operations[kind] === op; }
  function active(kind, op) { return owns(kind, op) && !op.controller.signal.aborted; }
  function cancelOperation(kind) {
    var op = operations[kind];
    operations[kind] = null;
    if (op) op.controller.abort();
    return op;
  }
  function beginOperation(kind) {
    cancelOperation(kind);
    var op = { controller: new AbortController() };
    operations[kind] = op;
    return op;
  }
  function searchSummary(stopped) {
    renderBar('共 ' + state.books.length + ' 本 · 来自 ' +
      state.books.reduce(function (n, b) { return n + b.sources.length; }, 0) + ' 个书源' +
      (stopped ? '（已停止）' : ''));
  }
  function stopSearch(render) {
    var op = cancelOperation('search');
    if (!op) return;
    state.cancel = true;
    state.searching = false;
    if (el('btnSearch')) el('btnSearch').textContent = '搜索';
    if (state.mode !== 'detail') state.mode = 'results';
    if (render) { searchSummary(true); if (state.mode !== 'detail') renderResults(); }
  }
  function resetDeepButton(op) {
    if (!op || !op.btn) return;
    op.btn.textContent = op.btnText;
    op.btn.classList.remove('is-running');
    op.btn.style.setProperty('--p', '0%');
  }
  function stopDeep() {
    var op = cancelOperation('deep');
    if (!op) return;
    state.cancelDeep = true;
    state.deepRunning = false;
    resetDeepButton(op);
  }
  function cancelFind() {
    if (cancelOperation('find')) loading(false);
  }
  function leave() {
    lifecycle++;
    state.renderQueued = false;
    stopSearch(false);
    stopDeep();
    cancelOperation('detail');
    cancelFind();
    cancelOperation('feed');
    if (state.feed && state.feed.status === 'loading') state.feed = null;
    cancelOperation('hotrank');
    if (state.hotrank && state.hotrank.status === 'loading') state.hotrank = null;
    state.fromIdle = false;
    state.pendingIdleDetail = false;
  }

  /* ------------------------------------------------------------ 小工具 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function toast(m) { if (NR.toast) NR.toast(m); }
  function loading(on, text) { if (NR.loading) NR.loading(on, text); }
  function each(list, fn) { Array.prototype.forEach.call(list || [], function (x, i) { fn(x, i); }); }

  function normKey(s) {
    return String(s || '').toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[（）()【】\[\]《》〈〉「」『』·・:：,，。.!！?？'"“”‘’\-—_/\\|]/g, '');
  }

  function longestCommon(a, b) {
    var best = 0;
    var prev = new Array(b.length + 1).fill(0);
    for (var i = 1; i <= a.length; i++) {
      var cur = new Array(b.length + 1).fill(0);
      for (var j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  /** 命中程度：0 完全一致 → 1 含搜索词 → 1.5 被包含 → 2 两字以上重合 → 99 丢弃 */
  function rankOf(title, kw) {
    var q = normKey(kw), t = normKey(title);
    if (!q || !t) return 99;
    if (t === q) return 0;
    if (t.indexOf(q) >= 0) return 1;
    if (q.indexOf(t) >= 0) return 1.5;
    if (longestCommon(t, q) >= 2) return 2;
    return 99;
  }

  function rankItems(kw, items) {
    var out = [];
    (items || []).forEach(function (b, i) {
      var r = rankOf(b.title, kw);
      if (r === 99) return;
      out.push({ b: b, rank: r, gap: Math.abs(normKey(b.title).length - normKey(kw).length), i: i });
    });
    out.sort(function (x, y) { return x.rank - y.rank || x.gap - y.gap || x.i - y.i; });
    return out.map(function (x) { return x.b; });
  }

  /* ------------------------------------------------------------ 封面（走 covers.js） */
  function coverFor(book) {
    if (!book || !book.coverUrl) return Promise.resolve('');
    return NR.cover ? NR.cover.get(book.coverUrl, book.bookUrl) : Promise.resolve('');
  }

  function fillCovers(root) {
    if (!NR.cover) return;
    // 热榜封面同样是远程地址，CSP 不含远程域，一律经 covers.js 取成 data URI；封面源不校验 Referer
    NR.cover.fill(root, function () { return ''; });
    // 规则没给 coverUrl 的书：拿详情页地址自动补一次封面（无按钮、静默）
    if (NR.coverAuto) NR.coverAuto.fill(root);
  }

  /* 合并后的书可能来自多个源，挑第一个源详情页作为补封面用的地址 */
  function coverBookUrl(book) {
    if (!book) return '';
    if (book.sources && book.sources.length) {
      for (var i = 0; i < book.sources.length; i++) {
        if (book.sources[i] && book.sources[i].bookUrl) return book.sources[i].bookUrl;
      }
    }
    return book.bookUrl || '';
  }

  function coverMarkup(url, key, cls, bookUrl) {
    var empty = '<span class="' + cls + ' ' + cls + '--none"' +
      (bookUrl ? ' data-book-url="' + esc(bookUrl) + '"' : '') + '></span>';
    if (!url) return empty;
    if (!NR.cover) return '';
    var html = NR.cover.markup(url, cls, key, bookUrl);
    return html || empty;
  }

  /* ------------------------------------------------------------ 结果聚合 */
  function bookKeyOf(title, author) {
    return normKey(title) + '|' + normKey(author || '');
  }

  /** 把一批搜索结果并进 state.books（同名同作者算一本） */
  function mergeHits(items, src) {
    var changed = false;
    (items || []).forEach(function (b) {
      if (!b || !b.title || !b.bookUrl) return;
      var rank = rankOf(b.title, state.query);
      if (rank === 99) return;                    // 书名和搜索词不重合，直接丢
      var key = bookKeyOf(b.title, b.author);
      var book = state.byKey[key];
      if (!book) {
        book = {
          key: key, title: b.title, author: b.author || '',
          intro: b.intro || '', coverUrl: b.coverUrl || '',
          lastChapter: b.lastChapter || '',
          rank: rank,
          sources: []
        };
        state.byKey[key] = book;
        state.books.push(book);
        changed = true;
      } else if (rank < book.rank) {
        book.rank = rank; changed = true;
      }
      if (!book.coverUrl && b.coverUrl) { book.coverUrl = b.coverUrl; changed = true; }
      if (!book.intro && b.intro) { book.intro = b.intro; changed = true; }
      if (!book.author && b.author) { book.author = b.author; changed = true; }

      if (!book.sources.some(function (x) { return x.sourceId === b.sourceId && x.bookUrl === b.bookUrl; })) {
        book.sources.push({
          sourceId: b.sourceId, sourceName: b.sourceName || (src && src.name) || '',
          bookUrl: b.bookUrl, latestChapter: b.lastChapter || b.latestChapter || ''
        });
        changed = true;
      }
      // 合并结果里带的其它来源
      (b.alsoOn || []).forEach(function (a) {
        if (!a || !a.bookUrl) return;
        if (book.sources.some(function (x) { return x.sourceId === a.sourceId && x.bookUrl === a.bookUrl; })) return;
        book.sources.push({
          sourceId: a.sourceId, sourceName: a.sourceName || '',
          bookUrl: a.bookUrl, latestChapter: ''
        });
        changed = true;
      });
    });
    if (changed) {
      state.found = state.books.length;
      scheduleRender();
      if (state.detail && state.byKey[state.detail.book.key]) {
        state.detail.book = state.byKey[state.detail.book.key];
        updateDetailSources();
      }
    }
  }

  function settingsOf() {
    return (NR.getSettings && NR.getSettings()) || {};
  }

  /** 结果列表：按设置里的上限截断（0 = 全部） */
  function sortedBooks() {
    var list = state.books.slice().sort(function (a, b) {
      return a.rank - b.rank ||
        a.title.length - b.title.length ||
        b.sources.length - a.sources.length;
    });
    var limit = settingsOf().resultLimit;
    if (limit > 0 && list.length > limit) list = list.slice(0, limit);
    return list;
  }

  /* ------------------------------------------------------------ 结果渲染 */
  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    var epoch = lifecycle;
    requestAnimationFrame(function () {
      if (epoch !== lifecycle) return;
      state.renderQueued = false;
      if (state.mode === 'detail') return;
      renderResults();
    });
  }

  /* ------------------------------------------------------------ 本地真实历史 */
  function historyTime(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function localHistory() {
    var index = NR.state && NR.state() && NR.state().index || [];
    var continuing = index.filter(function (b) {
      return b && b.id && b.progress && historyTime(b.lastReadAt);
    }).slice().sort(function (a, b) {
      return historyTime(b.lastReadAt) - historyTime(a.lastReadAt);
    });
    var recent = index.filter(function (b) {
      return b && b.id && (historyTime(b.lastReadAt) || historyTime(b.addedAt));
    }).slice().sort(function (a, b) {
      return (historyTime(b.lastReadAt) || historyTime(b.addedAt)) -
        (historyTime(a.lastReadAt) || historyTime(a.addedAt));
    });
    return { continuing: continuing, recent: recent };
  }
  function localProgress(book) {
    var p = book.progress;
    if (!p) return '最近入架';
    var ci = Math.max(0, Number(p.ci) || 0);
    return book.chapterTitles && book.chapterTitles[ci] || '读至第 ' + (ci + 1) + ' 章';
  }
  function localSection(kind, title, books) {
    if (!books.length) return '';
    var h = '<section class="orecommend" data-recommend-section="' + kind + '">' +
      '<p class="odetail__tochead">' + title + '</p><div class="olist">';
    books.forEach(function (b) {
      h += '<article class="obook" data-local-book="' + esc(b.id) + '" tabindex="0">' +
        coverMarkup(b.coverUrl, b.id, 'obook__cover') +
        '<div class="obook__main"><h3 class="obook__title">' + esc(b.title || '未命名') + '</h3>' +
        '<p class="obook__meta"><span>' + esc(b.author || '佚名') + '</span>' +
        '<i class="oitem__dot"></i><span>' + esc(localProgress(b)) + '</span></p></div></article>';
    });
    return h + '</div></section>';
  }
  function localMarkup() {
    var history = localHistory();
    return localSection('continue', '继续阅读', history.continuing) +
      localSection('recent', '最近阅读 / 最近入架', history.recent);
  }
  function bindLocalBooks(body) {
    each(body.querySelectorAll('[data-local-book]'), function (node) {
      var open = function () {
        var index = NR.state && NR.state() && NR.state().index || [];
        var id = node.dataset.localBook;
        for (var i = 0; i < index.length; i++) {
          if (String(index[i].id) === id) { NR.openBook(index[i].id); return; }
        }
      };
      node.onclick = open;
      node.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      };
    });
  }
  /* 发现页空态屏：封面 + 本地历史 + 热门 一起绑定 */
  function bindIdleBooks(body) {
    fillCovers(body);
    bindLocalBooks(body);
    bindFeed(body);
    bindHotrank(body);
  }

  /** 结果页顶部「返回发现」：搜索中/结果态都能一键回到空态屏（热榜 + 热门 + 本地历史） */
  function resultsBack() {
    return '<button class="btn btn--ghost odetail__back" id="btnResultsBack" type="button">' +
      '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.4L5.2 8l4.6 4.6"/></svg>' +
      '返回发现</button>';
  }
  function bindResultsBack() {
    var btn = el('btnResultsBack');
    if (!btn) return;
    btn.onclick = function () { backToIdle(); };
  }
  /** 回到发现页空态：取消在途搜索（迟到结果由 owns/active 守卫丢弃），恢复热榜与热门 */
  function backToIdle() {
    if (state.searching) stopSearch(false);
    cancelOperation('search');
    state.searching = false;
    state.cancel = true;
    state.query = '';
    state.books = [];
    state.byKey = Object.create(null);
    state.detail = null;
    state.returnView = 'online';
    state.fromIdle = false;
    state.pendingIdleDetail = false;
    state.mode = 'idle';
    if (el('btnSearch')) el('btnSearch').textContent = '搜索';
    renderBar('');
    ensureHotrank();
    ensureFeed();
    renderIdle();
  }

  function renderResults() {
    var body = el('onlineBody');
    if (!body) return;

    if (state.mode === 'idle') { renderIdle(); return; }

    var books = sortedBooks();
    if (!books.length) {
      if (state.searching) {
        body.innerHTML = resultsBack() + '<div class="oempty oempty--soft">' +
          '<p class="oempty__title">正在搜索…</p></div>';
      } else {
        body.innerHTML = resultsBack() + '<div class="oempty"><p class="oempty__title">没找到</p></div>';
      }
      bindResultsBack();
      return;
    }

    var h = resultsBack() + '<div class="olist" id="onlineSearchResults">';
    books.forEach(function (b, i) {
      h += '<article class="obook" data-i="' + i + '" tabindex="0">' +
        coverMarkup(b.coverUrl, b.key, 'obook__cover', coverBookUrl(b)) +
        '<div class="obook__main">' +
        '<h3 class="obook__title">' + esc(b.title) + '</h3>' +
        '<p class="obook__meta">' +
        '<span>' + esc(b.author || '佚名') + '</span>' +
        '<i class="oitem__dot"></i><span class="obook__n">' + b.sources.length + ' 个源</span>' +
        (b.lastChapter ? '<i class="oitem__dot"></i><span class="oitem__src">' + esc(b.lastChapter) + '</span>' : '') +
        '</p>' +
        (b.intro ? '<p class="oitem__intro">' + esc(b.intro.slice(0, 80)) + '</p>' : '') +
        '</div>' +
        '</article>';
    });
    h += '</div>';
    body.innerHTML = h;
    fillCovers(body);
    bindResultsBack();

    each(el('onlineSearchResults').querySelectorAll('.obook'), function (node) {
      var open = function () { state.returnView = 'online'; openDetail(sortedBooks()[+node.dataset.i]); };
      node.onclick = open;
      node.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      };
    });
  }

  function renderBar(text) {
    var bar = el('onlineBar');
    if (!bar) return;
    if (!text) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = '<span class="obar__text">' + text + '</span>';
  }

  /* ------------------------------------------------------------ 搜索（流式） */
  async function doSearch(q) {
    if (state.searching) {            // 再点一次 = 停止，保留已到达的结果
      stopSearch(true);
      toast('搜索已停止');
      return;
    }
    var kw = String(q || '').trim();
    if (!kw) return;
    cancelOperation('feed');
    state.feed = null;
    cancelOperation('hotrank');
    state.hotrank = null;
    cancelOperation('detail');
    cancelFind();
    state.detail = null;
    state.returnView = 'online';
    state.fromIdle = false;
    state.pendingIdleDetail = false;
    var list = NR.sources.enabled().filter(function (s) { return s.searchUrl; });
    if (!list.length) { openSources(); return; }
    var op = beginOperation('search');
    var cancelled = false;

    state.query = kw;
    state.books = [];
    state.byKey = Object.create(null);
    state.mode = 'searching';
    state.searching = true;
    state.cancel = false;
    state.done = 0;
    state.total = list.length;
    state.found = 0;
    el('btnSearch').textContent = '停止';
    renderBar('正在搜索「' + esc(kw) + '」…');
    renderResults();

    try {
      await NR.sources.searchStream(kw, {
        timeout: settingsOf().searchTimeout || SEARCH_TIMEOUT,
        concurrency: settingsOf().searchConcurrency || CONCURRENCY,
        signal: op.controller.signal,
        onSource: function (r) {
          if (!active('search', op)) return;
          if (isCancelled(r)) { cancelled = true; return; }
          if (r.ok && r.items && r.items.length) {
            mergeHits(r.items, r.source);
            state.tested[r.source.id] = true;
          } else if (r.code !== 'UNSUPPORTED' && r.code !== 'ENCODING' && /\bHTTP\s+(404|410)\b/.test(r.error || '')) {
            state.tested[r.source.id] = false;      // 临时网络问题 / 能力限制不等于站点失效
            if (sourcesVisible()) renderSources();
          }
          state.done = r.done;
          state.total = r.total;
          // 只显示进度和命中数，不显示失败明细（要求 5）
          renderBar('已搜 ' + r.done + '/' + r.total + ' 个源 · 找到 ' + state.books.length + ' 本');
        }
      });
    } catch (e) {
      if (!active('search', op)) return;
      if (isCancelled(e)) cancelled = true;
      else toast('搜索失败：' + ((e && e.message) || e));
    } finally {
      if (owns('search', op)) {
        state.searching = false;
        state.cancel = cancelled || op.controller.signal.aborted;
        el('btnSearch').textContent = '搜索';
        if (state.mode !== 'detail') state.mode = 'results';
        searchSummary(state.cancel);
        if (state.mode !== 'detail') renderResults();
        if (!state.cancel && active('search', op)) {
          await autoPurge(true, function () { return active('search', op); }).catch(function () { });
        }
        if (owns('search', op)) operations.search = null;
      }
    }
  }

  /* ------------------------------------------------------------ 详情 */
  function openDetail(book) {
    if (!book) return;
    var fromIdle = !!state.pendingIdleDetail;
    state.pendingIdleDetail = false;
    cancelOperation('detail');
    cancelFind();
    if (!book.sources && book.bookUrl) {              // 兼容旧结构
      book = {
        key: bookKeyOf(book.title, book.author), title: book.title, author: book.author || '',
        intro: book.intro || '', coverUrl: book.coverUrl || '',
        sources: [{ sourceId: book.sourceId, sourceName: book.sourceName, bookUrl: book.bookUrl }]
          .concat(book.alsoOn || []),
        rank: rankOf(book.title, state.query)
      };
    }
    state.mode = 'detail';
    state.fromIdle = fromIdle;
    state.detail = { book: book, srcIndex: 0, info: null, catalog: null, error: '', desc: false };
    renderDetail();
    loadDetailFor(0);
  }

  function renderDetail() {
    var d = state.detail;
    if (!d) return;
    var b = d.book;
    var src = b.sources[d.srcIndex] || b.sources[0];

    var h = '<div class="odetail">' +
      '<button class="btn btn--ghost odetail__back" id="btnDetailBack" type="button">' +
      '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.4L5.2 8l4.6 4.6"/></svg>' +
      (state.fromIdle ? '返回发现' : '返回结果') + '</button>' +
      '<div class="odetail__top">' +
      coverMarkup(b.coverUrl, b.key, 'odetail__cover') +
      '<div class="odetail__head">' +
      '<h2 class="odetail__title">' + esc(b.title) + '</h2>' +
      '<p class="odetail__meta">' +
      '<span>' + esc(b.author || '佚名') + '</span>' +
      '<i class="oitem__dot"></i><span>' + b.sources.length + ' 个源</span>' +
      (d.catalog ? '<i class="oitem__dot"></i><span>' + d.catalog.chapters.length + ' 章</span>' : '') +
      '</p>' +
      '</div></div>';

    // 可用源（要求 2）：一行 chips，点哪个看哪个
    h += '<div class="odetail__sources" id="detailSources">';
    b.sources.forEach(function (s, i) {
      h += '<button class="odetail__switch' + (i === d.srcIndex ? ' on' : '') + '" data-src="' + i +
        '" type="button" title="' + esc(s.bookUrl) + '">' + esc(s.sourceName) + '</button>';
    });
    h += '</div>';

    if (d.error) {
      h += '<p class="odetail__err">这个源取不到目录：' + esc(d.error) + '</p>';
    } else if (d.catalog) {
      if (b.intro) {
        h += '<p class="odetail__intro" id="introText">' + esc(b.intro) + '</p>' +
          '<button class="odetail__more" id="btnIntroMore" type="button" hidden>展开</button>';
      }
    } else {
      h += '<p class="odetail__loading">正在取目录…</p>';
    }

    h += '<div class="odetail__actions">' +
      '<button class="btn btn--primary" id="btnAddRead" type="button"' + (d.catalog ? '' : ' disabled') +
      '>开始阅读</button>' +
      '<button class="btn" id="btnAddShelf" type="button"' + (d.catalog ? '' : ' disabled') +
      '>加入书架</button>' +
      '<button class="odetail__switch" id="btnFindSrc" type="button">找其它源</button>' +
      '<button class="odetail__switch' + (curStarred() ? ' on' : '') + '" id="btnStarSrc" type="button">' +
      (curStarred() ? '★ 已收藏' : '☆ 收藏源') + '</button>' +
      '<button class="odetail__switch' + (d.desc ? ' on' : '') + '" id="btnTocOrder" type="button">目录倒序</button>' +
      '</div>';

    if (d.catalog) {
      var n = d.catalog.chapters.length;
      var shown = d.desc ? d.catalog.chapters.slice().reverse() : d.catalog.chapters;
      h += '<div class="odetail__toc"><p class="odetail__tochead">目录 · ' +
        (d.desc ? '倒序' : '正序') + ' · 共 ' + n + ' 章</p>' +
        '<ul class="odetail__toclist">';
      shown.forEach(function (c, idx) {
        var real = d.desc ? n - 1 - idx : idx;   // data-i 永远是正序下标，倒序只是显示顺序
        h += '<li class="otoc__row" data-i="' + real + '" tabindex="0" role="button"><span>' + esc(c.t) + '</span></li>';
      });
      h += '</ul></div>';
    }
    h += '</div>';
    el('onlineBody').innerHTML = h;
    fillCovers(el('onlineBody'));

    if (el('btnDetailBack')) el('btnDetailBack').onclick = back;
    if (el('btnAddRead')) el('btnAddRead').onclick = function () { if (d.catalog) readNow(); };
    if (el('btnAddShelf')) el('btnAddShelf').onclick = function () { if (d.catalog) addToShelf(); };
    if (el('btnFindSrc')) el('btnFindSrc').onclick = function () {
      findSourcesFor(b.title, (b.sources[d.srcIndex] || {}).sourceId, function (hit) {
        if (state.detail !== d || state.mode !== 'detail') return;
        var exists = b.sources.some(function (x) { return x.sourceId === hit.sourceId && x.bookUrl === hit.bookUrl; });
        if (!exists) b.sources.push({ sourceId: hit.sourceId, sourceName: hit.sourceName, bookUrl: hit.bookUrl });
        var idx = b.sources.findIndex(function (x) { return x.sourceId === hit.sourceId && x.bookUrl === hit.bookUrl; });
        state.detail.srcIndex = idx < 0 ? 0 : idx;
        state.detail.info = null; state.detail.catalog = null; state.detail.error = '';
        renderDetail();
        loadDetailFor(state.detail.srcIndex);
      });
    };
    if (el('btnStarSrc')) el('btnStarSrc').onclick = async function () {
      var s = currentSource();
      if (!s) return;
      var src = NR.sources.get(s.sourceId);
      await NR.sources.setStarred(s.sourceId, !(src && src.starred));
      toast(src && src.starred ? '已取消收藏这个源' : '已收藏这个源');
      renderDetail();
      if (sourcesVisible()) renderSources();
    };
    if (el('btnTocOrder')) el('btnTocOrder').onclick = function () {
      state.detail.desc = !state.detail.desc;
      renderDetail();
    };
    each(el('onlineBody').querySelectorAll('[data-src]'), function (btn) {
      btn.onclick = function () {
        var i = +btn.dataset.src;
        if (i === state.detail.srcIndex && state.detail.catalog) return;
        state.detail.srcIndex = i;
        state.detail.info = null; state.detail.catalog = null; state.detail.error = '';
        renderDetail();
        loadDetailFor(i);
      };
    });

    each(el('onlineBody').querySelectorAll('.otoc__row'), function (row) {
      var open = function () { openChapter(+row.dataset.i); };
      row.onclick = open;
      row.onkeydown = function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      };
    });

    var ip = el('introText');
    if (ip) {
      requestAnimationFrame(function () {
        if (ip.scrollHeight > ip.clientHeight + 4) {
          var more = el('btnIntroMore');
          if (!more) return;
          more.hidden = false;
          more.onclick = function () {
            var open = ip.classList.toggle('is-open');
            more.textContent = open ? '收起' : '展开';
          };
        }
      });
    }
  }

  /** 只刷新详情里的源 chips（搜索还在后台跑时新源会加进来） */
  function updateDetailSources() {
    var box = el('detailSources');
    if (!box || !state.detail) return;
    var b = state.detail.book, cur = state.detail.srcIndex;
    box.innerHTML = b.sources.map(function (s, i) {
      return '<button class="odetail__switch' + (i === cur ? ' on' : '') + '" data-src="' + i +
        '" type="button" title="' + esc(s.bookUrl) + '">' + esc(s.sourceName) + '</button>';
    }).join('');
    each(box.querySelectorAll('[data-src]'), function (btn) {
      btn.onclick = function () {
        var i = +btn.dataset.src;
        if (i === state.detail.srcIndex && state.detail.catalog) return;
        state.detail.srcIndex = i;
        state.detail.info = null; state.detail.catalog = null; state.detail.error = '';
        renderDetail();
        loadDetailFor(i);
      };
    });
  }

  async function loadDetailFor(i) {
    cancelOperation('detail');
    cancelFind();
    var d = state.detail;
    if (!d) return;
    var src = d.book.sources[i];
    if (!src) return;
    var op = beginOperation('detail');
    var timeout = Math.max(1000, Math.min(30000, Number((NR.sources.get(src.sourceId) || {}).timeout) || 15000));
    var options = { signal: op.controller.signal, timeout: timeout, deadline: Date.now() + timeout };
    function current() { return active('detail', op) && state.detail === d && d.srcIndex === i; }
    try {
      var info;
      try { info = await NR.sources.detail(src.sourceId, src.bookUrl, options); }
      catch (e) {
        if (isCancelled(e) || (e && (e.code === 'UNSUPPORTED' || e.code === 'ENCODING'))) throw e;
        info = {};                  // 普通详情失败仍可直接尝试目录
      }
      if (!current()) return;
      d.info = info;
      var cat = await NR.sources.catalog(src.sourceId, src.bookUrl, info || {}, options);
      if (!current()) return;
      d.catalog = cat;
      renderDetail();
    } catch (e) {
      if (!current() || isCancelled(e)) return;
      d.error = (e && e.message) || '取目录失败';
      renderDetail();
    } finally {
      if (owns('detail', op)) operations.detail = null;
    }
  }

  /** 返回上一层：true = 已消费（关掉了一层），false = 已在最上级（发现页空态）
   *  宿主拿到 false 会退出应用；这里不再自己 switchView('shelf')，
   *  否则「从任何页面返回都回到书架」——返回就该一级一级往上退。 */
  function back() {
    cancelOperation('detail');
    cancelFind();
    if (state.mode === 'detail') {
      var returnView = state.returnView || 'online';
      state.returnView = 'online';
      if (state.fromIdle && returnView === 'online') {   // 从发现页热门/本地历史进的详情，返回空态屏
        state.fromIdle = false;
        state.mode = 'idle';
        state.detail = null;
        ensureFeed();
        ensureHotrank();
        renderIdle();
        return true;
      }
      state.fromIdle = false;
      state.mode = state.searching ? 'searching' : 'results';
      state.detail = null;
      if (returnView !== 'online') {                     // 从书城进的详情：退回书城
        NR.switchView(returnView);
        return true;
      }
      renderBar(state.searching
        ? '已搜 ' + state.done + '/' + state.total + ' 个源 · 找到 ' + state.books.length + ' 本'
        : '共 ' + state.books.length + ' 本 · 来自 ' +
          state.books.reduce(function (n, b) { return n + b.sources.length; }, 0) + ' 个书源');
      renderResults();
      return true;
    }
    if (state.mode === 'idle') return false;             // 发现页最上级：交给宿主退出
    backToIdle();                                        // 搜索结果 / 搜索中 → 发现页空态
    return true;
  }

  function currentSource() {
    var d = state.detail;
    if (!d) return null;
    return d.book.sources[d.srcIndex] || d.book.sources[0];
  }

  function curStarred() {
    var s = currentSource();
    if (!s) return false;
    var src = NR.sources.get(s.sourceId);
    return !!(src && src.starred);
  }

  /** 详情里实际展示 / 阅读用的章节顺序（勾了倒序就反着来） */
  function orderedChapters() {
    var d = state.detail;
    if (!d || !d.catalog) return [];
    var arr = d.catalog.chapters;
    return d.desc ? arr.slice().reverse() : arr.slice();
  }

  /** 点目录里的任意一章：从那一章开始读（倒序时把显示的序位映射回正序章序） */
  function openChapter(index) {
    var d = state.detail;
    if (!d || !d.catalog) return;
    var n = d.catalog.chapters.length;
    var real = Math.max(0, Math.min(n - 1, Number(index) || 0));
    readNow(d.desc ? n - 1 - real : real);
  }

  /** 未入架直接读（要求 1）：看过内容再决定加不加书架 */
  function readNow(startIndex) {
    var d = state.detail;
    if (!d || !d.catalog) return;
    var src = currentSource();
    var previous = NR.state && NR.state().cur && NR.state().cur.meta;
    var previousId = previous && previous.temp && previous.sourceId === src.sourceId &&
      previous.bookUrl === src.bookUrl ? previous.id : '';
    NR.openTransient({
      title: d.book.title, author: d.book.author, intro: d.book.intro,
      coverUrl: d.book.coverUrl,
      sourceId: src.sourceId, sourceName: src.sourceName, bookUrl: src.bookUrl,
      chapters: orderedChapters(),
      startIndex: Math.max(0, Number(startIndex) || 0),
      alsoOn: d.book.sources.filter(function (s) { return s !== src; })
        .map(function (s) { return { sourceId: s.sourceId, sourceName: s.sourceName, bookUrl: s.bookUrl }; })
    });
    var reopened = NR.state && NR.state().cur && NR.state().cur.meta;
    if (previousId && reopened && reopened.temp && reopened.id !== previousId && NR.readingStats) {
      NR.readingStats.mergeIdentity(previousId, reopened.id);
    }
  }

  async function addToShelf() {
    var d = state.detail;
    if (!d || !d.catalog) return;
    var src = currentSource();
    var exist = findExisting(src);
    if (exist) { toast('书架上已经有了，直接打开'); NR.openBook(exist.id); return; }
    NR.ui.confirm('把《' + d.book.title + '》加入书架？\n\n来源：' + src.sourceName + ' · ' +
      d.catalog.chapters.length + ' 章', function () { doAdd(src); }, '加入书架');
  }

  function findExisting(src) {
    var idx = (NR.state() && NR.state().index) || [];
    for (var i = 0; i < idx.length; i++) {
      var b = idx[i];
      if (b.remote && b.sourceId === src.sourceId && b.bookUrl === src.bookUrl) return b;
    }
    return null;
  }

  async function doAdd(src) {
    var d = state.detail;
    if (!d || !d.catalog) return;
    loading(true, '正在加入书架…');
    try {
      var meta = await NR.importBook({
        title: d.book.title, author: d.book.author, intro: d.book.intro,
        coverUrl: d.book.coverUrl,
        remote: true, format: 'online',
        sourceId: src.sourceId, sourceName: src.sourceName, bookUrl: src.bookUrl,
        alsoOn: d.book.sources.filter(function (s) { return s !== src; })
          .map(function (s) { return { sourceId: s.sourceId, sourceName: s.sourceName, bookUrl: s.bookUrl }; }),
        chapters: orderedChapters()
      });
      loading(false);
      toast('已加入书架');
      if (meta) NR.openBook(meta.id);
    } catch (e) {
      loading(false);
      toast('加入失败：' + (e.message || e));
    }
  }

  /* ------------------------------------------------------------ 找其它源 */
  async function findSourcesFor(title, excludeSourceId, cb) {
    var kw = String(title || '').trim();
    if (!kw) return;
    cancelFind();
    var op = beginOperation('find');
    loading(true, '正在找其它书源…');
    var found = [];
    try {
      await NR.sources.searchStream(kw, {
        timeout: settingsOf().searchTimeout || SEARCH_TIMEOUT,
        concurrency: settingsOf().searchConcurrency || CONCURRENCY,
        signal: op.controller.signal,
        onSource: function (r) {
          if (!active('find', op) || isCancelled(r)) return;
          (r.items || []).forEach(function (b) {
            if (rankOf(b.title, kw) === 99) return;
            if (b.sourceId === excludeSourceId) return;
            if (found.some(function (x) { return x.sourceId === b.sourceId && x.bookUrl === b.bookUrl; })) return;
            found.push({ sourceId: b.sourceId, sourceName: b.sourceName, bookUrl: b.bookUrl, title: b.title });
          });
          loading(true, '正在找其它书源… ' + r.done + '/' + r.total);
        }
      });
    } catch (e) {
      if (!active('find', op)) return;
      loading(false);
      operations.find = null;
      if (!isCancelled(e)) toast('搜索失败：' + (e.message || e));
      return;
    }
    if (!active('find', op)) return;
    loading(false);
    if (!found.length) { operations.find = null; toast('没找到别的书源'); return; }
    NR.ui.pick('《' + kw + '》的其它书源（' + found.length + ' 个）',
      found.slice(0, 40).map(function (x) { return { label: x.sourceName + ' · ' + x.title }; }),
      function (i) {
        if (!active('find', op) || !found[i]) return;
        operations.find = null;
        cb(found[i]);
      });
  }

  /* ------------------------------------------------------------ 发现页热门（真实分类） */
  /* 只认名称匹配 热门|热榜|排行|人气|推荐 的真实分类；名次/热度/书籍都来自书源返回，
   * 不伪造、不补位、不写健康字段/日志/黑名单/回收站。 */
  var HOT_TITLE = /热门|热榜|排行|人气|推荐/;

  /** 当前展示的是「发现页空态屏」：真 idle，或搜索结束但没有结果 */
  function onIdleScreen() {
    return state.mode === 'idle' ||
      (state.mode === 'results' && !state.books.length && !state.searching);
  }

  /** 在启用且声明了发现页的书源里找第一个名称匹配的真实分类 */
  function hotCandidate() {
    var list = [];
    try { list = NR.sources.enabled() || []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var source = list[i];
      if (!source || !source.exploreUrl) continue;
      var categories = [];
      try { categories = NR.sources.exploreCategories(source.id) || []; } catch (e2) { categories = []; }
      for (var j = 0; j < categories.length; j++) {
        var title = (categories[j] && categories[j].title) || '';
        if (HOT_TITLE.test(title)) return { source: source, category: categories[j] };
      }
    }
    return null;
  }

  function feedSourceName(source) {
    return (source && (source.name || source.bookSourceName || source.id)) || '书源';
  }

  /** 同一 sourceId|url 的 loading/loaded 不重复拉；force 只由「重试」使用 */
  function ensureFeed(force) {
    if (!onIdleScreen()) return null;
    var candidate = hotCandidate();
    if (!candidate) { state.feed = null; return null; }
    var key = candidate.source.id + '|' + candidate.category.url;
    var cur = state.feed;
    // 取消后底层请求可能没落地（不 reject），loading 会永久占着缓存键 → 没人持有操作时视为失效
    if (cur && cur.status === 'loading' && !operations.feed) { cur = state.feed = null; }
    if (!force && cur && cur.key === key && (cur.status === 'loading' || cur.status === 'loaded')) {
      return null;
    }
    var op = beginOperation('feed');
    op.key = key;
    var feed = state.feed = {
      key: key,
      status: 'loading',
      sourceId: candidate.source.id,
      sourceName: feedSourceName(candidate.source),
      url: candidate.category.url,
      title: candidate.category.title || '热门',
      books: [],
      error: null
    };
    var timeout = settingsOf().searchTimeout || SEARCH_TIMEOUT;
    return Promise.resolve().then(function () {
      if (!active('feed', op)) return [];
      return NR.sources.explore(feed.sourceId, feed.url, {
        signal: op.controller.signal,
        deadline: Date.now() + timeout
      });
    }).then(function (books) {
      if (!active('feed', op) || !onIdleScreen() || state.feed !== feed) return;
      operations.feed = null;
      feed.status = 'loaded';
      feed.books = Array.isArray(books) ? books : [];
      renderIdle();
    }, function (error) {
      if (!active('feed', op) || isCancelled(error) || !onIdleScreen() || state.feed !== feed) return;
      operations.feed = null;
      feed.status = 'error';
      feed.error = {
        code: (error && error.code) || '',
        message: (error && error.message) || String(error || '未知错误')
      };
      renderIdle();
    });
  }

  function feedMarkup() {
    var feed = state.feed;
    if (!feed) return '';
    var head = '<p class="odetail__tochead">' + esc(feed.title) + '</p>' +
      '<p class="oitem__src">' + esc(feed.sourceName) + '</p>';
    var open = '<section class="orecommend ofeed" data-feed-section="hot" ' +
      'data-feed-source="' + esc(feed.sourceId) + '">';
    if (feed.status === 'error') {
      var code = (feed.error && feed.error.code) || '';
      var msg = (feed.error && feed.error.message) || '未知错误';
      return open + head +
        '<div class="oempty oempty--soft">' +
        '<p class="oempty__title">热门加载失败</p>' +
        '<p class="oitem__intro">' + esc((code ? '[' + code + '] ' : '') + msg) + '</p>' +
        '<button class="btn btn--primary" id="btnFeedRetry" type="button">重试</button>' +
        '</div></section>';
    }
    if (feed.status === 'loading') {
      return open + head +
        '<div class="oempty oempty--soft"><p class="oempty__title">正在加载热门…</p></div></section>';
    }
    if (!feed.books.length) {
      return open + head +
        '<div class="oempty oempty--soft"><p class="oempty__title">这个热门分类暂时没有书</p></div></section>';
    }
    var h = open + head + '<div class="olist">';
    feed.books.forEach(function (book, index) {
      h += '<article class="obook" data-feed-book="' + index + '" tabindex="0">' +
        coverMarkup(book.coverUrl, feed.sourceId + '|' + (book.bookUrl || index), 'obook__cover', book.bookUrl) +
        '<div class="obook__main">' +
        '<h3 class="obook__title">' + esc(book.title || '未命名') + '</h3>' +
        '<p class="obook__meta">' +
        '<span>' + esc(book.author || '佚名') + '</span>' +
        (book.lastChapter ? '<i class="oitem__dot"></i><span class="oitem__src">' + esc(book.lastChapter) + '</span>' : '') +
        '</p>' +
        (book.intro ? '<p class="oitem__intro">' + esc(String(book.intro).slice(0, 80)) + '</p>' : '') +
        '</div></article>';
    });
    return h + '</div></section>';
  }

  function bindFeed(body) {
    var feed = state.feed;
    if (!feed) return;
    each(body.querySelectorAll('[data-feed-book]'), function (node) {
      var index = +node.dataset.feedBook;
      var book = feed.books[index];
      if (!book) return;
      var open = function () {
        if (NR.bookstore && NR.bookstore.openBook) {
          state.pendingIdleDetail = true;
          NR.bookstore.openBook(book, feed.sourceId, 'online');
        }
      };
      node.onclick = open;
      node.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      };
    });
    var retry = el('btnFeedRetry');
    if (retry) {
      retry.onclick = function () {
        ensureFeed(true);
        renderIdle();
      };
    }
  }

  /* ------------------------------------------------------------ 热榜 */
  /* 数据来自 NR.hotrank（renderer/js/hotrank.js，走宿主桥抓取）；
   * 失败只进界面：不写书源健康/日志/黑名单/回收站，也不调 autoPurge。 */
  function hotrankApi() {
    var tp = NR.hotrank;
    return tp && typeof tp.hot === 'function' ? tp : null;
  }

  function hotrankWords(n) {
    var count = Number(n) || 0;
    if (!count) return '';
    if (count >= 10000) return (Math.round(count / 1000) / 10) + ' 万字';
    return count + ' 字';
  }

  function hotrankRefreshIcon() {
    return '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">' +
      '<path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" stroke-width="1.9"' +
      ' stroke-linecap="round"/><path d="M20 4.5V10h-5.5" fill="none" stroke="currentColor"' +
      ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function hotrankChips(section) {
    var list = section && section.channels;
    var busy = !!(section && section.status === 'loading');
    var h = '<div class="ohotrank__head">';
    if (list && list.length >= 2) {
      h += '<div class="ohotrank__chips" data-hotrank-channels>';
      list.forEach(function (channel) {
        var on = channel && channel.id === section.channelId;
        h += '<button class="chip' + (on ? ' on' : '') + '" type="button"' +
          ' data-hotrank-channel-id="' + esc(channel.id) + '"' +
          ' aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(channel.name || channel.id) + '</button>';
      });
      h += '</div>';
    }
    /* 刷新：重新向缓存服务器取今天的榜单，绕过当日缓存 */
    h += '<button class="ohotrank__refresh' + (busy ? ' is-busy' : '') + '" type="button"' +
      ' data-hotrank-refresh="1" title="刷新榜单" aria-label="刷新榜单"' +
      (busy ? ' disabled aria-disabled="true"' : '') + '>' + hotrankRefreshIcon() + '</button>';
    return h + '</div>';
  }

  /** 切渠道/首屏拉榜/手动刷新：同一 operation 键串行，迟到的旧渠道结果一律丢弃 */
  function ensureHotrank(channelId, force, refresh) {
    if (!onIdleScreen()) return null;
    var api = hotrankApi();
    if (!api) { state.hotrank = null; return null; }
    var want = String(channelId || '');
    var cur = state.hotrank;
    // 取消后底层 promise 可能不 reject，loading 会永久占位 → 没人持有操作时视为失效
    if (cur && cur.status === 'loading' && !operations.hotrank) cur = state.hotrank = null;
    if (!force && cur && (!want || cur.channelId === want) &&
        (cur.status === 'loading' || cur.status === 'loaded')) {
      return null;
    }
    var op = beginOperation('hotrank');
    /* 手动刷新时先把旧榜留在原位：新数据回来只做原地替换，页面不会先空一下 */
    var reuse = refresh && cur && cur.items ? cur : null;
    var section = state.hotrank = {
      status: 'loading',
      channelId: want || (cur && cur.channelId) || '',
      channelName: (cur && cur.channelName) || '',
      channels: (cur && cur.channels) || [],
      items: reuse ? reuse.items.slice() : [],
      done: 0,
      total: 0,
      failed: 0,
      error: null
    };
    /* 渐进渲染：第一批回来就先画，后续每批只补热榜区块内部（不重建整页，滚动位置不跳） */
    var paint = function (snapshot) {
      if (!snapshot) return;
      if (!active('hotrank', op) || !onIdleScreen() || state.hotrank !== section) return;
      if (Array.isArray(snapshot.channels) && snapshot.channels.length) section.channels = snapshot.channels;
      if (snapshot.channel) {
        section.channelId = snapshot.channel.id || section.channelId;
        section.channelName = snapshot.channel.name || '';
      }
      if (Array.isArray(snapshot.items)) section.items = snapshot.items.slice();
      section.done = Number(snapshot.done) || 0;
      section.total = Number(snapshot.total) || 0;
      section.failed = Number(snapshot.failed) || 0;
      patchHotrank(section);
    };
    return Promise.resolve().then(function () {
      if (!active('hotrank', op)) return null;
      return typeof api.channels === 'function' ? api.channels() : [];
    }).then(function (list) {
      if (!active('hotrank', op) || !onIdleScreen() || state.hotrank !== section) return null;
      if (Array.isArray(list) && list.length) section.channels = list;
      var id = section.channelId || (section.channels[0] && section.channels[0].id) || '';
      section.channelId = id;
      return api.hot(id || undefined, { onProgress: paint, refresh: !!refresh });
    }).then(function (result) {
      if (!active('hotrank', op) || !onIdleScreen() || state.hotrank !== section) return;
      operations.hotrank = null;
      if (!result) {                       // 外壳不支持：不渲染这一块
        state.hotrank = null;
        renderIdle();
        return;
      }
      section.status = 'loaded';
      if (result.channels && result.channels.length) section.channels = result.channels;
      if (result.channel) {
        section.channelId = result.channel.id || section.channelId;
        section.channelName = result.channel.name || '';
      }
      section.items = Array.isArray(result.items) ? result.items : [];
      section.failed = Number(result.failed) || 0;
      section.done = section.total || (section.items.length + section.failed);
      patchHotrank(section);
    }, function (error) {
      if (!active('hotrank', op) || isCancelled(error) || !onIdleScreen() || state.hotrank !== section) return;
      operations.hotrank = null;
      if (section.items.length) {
        // 半成功：已画出来的书留着，底部小字改成「还有 N 本没加载出来」
        var missing = (section.total || 0) - (section.done || 0);
        if (missing > 0) section.failed = Math.max(section.failed, missing);
        section.status = 'loaded';
        section.done = section.total || section.done;
        patchHotrank(section);
        return;
      }
      section.status = 'error';
      section.error = {
        code: (error && error.code) || '',
        message: (error && error.message) || String(error || '未知错误')
      };
      patchHotrank(section);
    });
  }

  /* 热榜默认展示 30 本；加载期间就按这个数摆好占位，高度从一开始就定住 */
  var HOTRANK_SLOTS = 30;

  /* 区块底部一行小字（复用 .obar__text，不新增 CSS 类） */
  function hotrankNote(section) {
    if (!section) return '';
    if (section.status === 'loading' && section.items.length && section.done < section.total) {
      return '正在加载热榜… ' + section.done + '/' + (section.total || '?');
    }
    if (section.status === 'loaded' && section.failed > 0 && section.items.length) {
      return '还有 ' + section.failed + ' 本没加载出来';
    }
    return '';
  }

  /* 一张热榜卡片。key 用 bookUrl（退到 id / 书名），增量刷新靠它对齐同一张卡 */
  function hotrankCardKey(item, index) {
    if (!item) return 'i' + index;
    return String(item.bookUrl || item.id || ('t:' + (item.title || '')) || ('i' + index));
  }

  function hotrankCardMain(item) {
    var words = hotrankWords(item.words);
    return '<h3 class="obook__title">' + esc(item.title || '未命名') + '</h3>' +
      '<p class="obook__meta">' +
      '<span>' + esc(item.author || '佚名') + '</span>' +
      (words ? '<i class="oitem__dot"></i><span class="oitem__src">' + esc(words) + '</span>' : '') +
      '</p>' +
      (item.intro ? '<p class="oitem__intro">' + esc(item.intro) + '</p>' : '');
  }

  function hotrankCard(item, index) {
    return '<article class="obook" data-hotrank-book="' + index + '"' +
      ' data-hotrank-key="' + esc(hotrankCardKey(item, index)) + '" tabindex="0">' +
      coverMarkup(item.cover, 'hotrank|' + (item.id || index), 'obook__cover') +
      '<div class="obook__main">' + hotrankCardMain(item) + '</div></article>';
  }

  function hotrankBody(section) {
    if (section.status === 'error') {
      var code = (section.error && section.error.code) || '';
      var msg = (section.error && section.error.message) || '未知错误';
      return '<div class="oempty oempty--soft">' +
        '<p class="oempty__title">热榜加载失败</p>' +
        '<p class="oitem__intro">' + esc((code ? '[' + code + '] ' : '') + msg) + '</p>' +
        '<button class="btn btn--primary" id="btnHotrankRetry" type="button">重试</button>' +
        '</div>';
    }
    if (!section.items.length) {
      // 加载中先摆满占位卡：等第一批书回来时只是原地替换，页面不会整体往下跳
      if (section.status === 'loading') {
        var sk = '<div class="olist">';
        for (var i = 0; i < HOTRANK_SLOTS; i++) sk += hotrankSkeleton(i);
        sk += '</div>';
        return sk;
      }
      return '<div class="oempty oempty--soft"><p class="oempty__title">这个榜单暂时没有书</p></div>';
    }
    var h = '<div class="olist">';
    section.items.forEach(function (item, index) { h += hotrankCard(item, index); });
    h += '</div>';
    var note = hotrankNote(section);
    if (note) h += '<p class="obar__text" data-hotrank-note>' + esc(note) + '</p>';
    return h;
  }

  function hotrankMarkup() {
    var section = state.hotrank;
    if (!section) return '';
    return '<section class="orecommend ofeed ohotrank" data-hotrank-section="hot"' +
      ' data-hotrank-channel="' + esc(section.channelId || '') + '"' +
      (section.channelName ? ' data-hotrank-channel-name="' + esc(section.channelName) + '"' : '') + '>' +
      '<p class="odetail__tochead">热榜</p>' +
      '<div data-hotrank-head>' + hotrankChips(section) + '</div>' +
      '<div data-hotrank-body>' + hotrankBody(section) + '</div>' +
      '</section>';
  }

  /** 只重画热榜区块：其它区块与滚动位置都不动 */
  function patchHotrank(section) {
    var host = document.querySelector('[data-hotrank-section="hot"]');
    var body = host ? host.querySelector('[data-hotrank-body]') : null;
    if (!host || !body) { renderIdle(); return; }
    var head = host.querySelector('[data-hotrank-head]');
    if (head) {
      var chipsHtml = hotrankChips(section);
      if (head.__chips !== chipsHtml) { head.innerHTML = chipsHtml; head.__chips = chipsHtml; }
    }
    host.dataset.hotrankChannel = section.channelId || '';
    patchHotrankBody(body, section);
    bindHotrank(host);
  }

  /* 加载中的占位卡：结构、行数与真实卡一致（正文用不换行空格撑高），
     这样卡片陆续到达时只是原地替换，页面高度不再一次次往下跳。 */
  function hotrankSkeleton(index) {
    return '<article class="obook is-skel" data-hotrank-skel="1"' +
      ' data-hotrank-key="~' + index + '" aria-hidden="true">' +
      '<span class="obook__cover obook__cover--none"></span>' +
      '<div class="obook__main">' +
      '<h3 class="obook__title">\u00a0</h3>' +
      '<p class="obook__meta"><span>\u00a0</span></p>' +
      '</div></article>';
  }

  /* 增量刷新：首屏或换榜才整体重建，之后只补文字与封面。
     以前每次 onProgress 都 body.innerHTML 全量重画（一次热榜最多回调 30+ 次），
     卡片里的 <img> 被反复销毁重建，看着就是「一闪一闪」。 */
  function patchHotrankBody(body, section) {
    var loading = section.status === 'loading';
    // 加载中按 30 个位置摆好占位：总数未知时高度也不变，不会一闪一闪
    var total = loading ? Math.max(section.items.length, section.total || 0, HOTRANK_SLOTS) : section.items.length;
    if (section.status === 'error' || (!section.items.length && !total)) {
      var html = hotrankBody(section);
      if (body.__html !== html) { body.innerHTML = html; body.__html = html; }
      return;
    }
    body.__html = '';
    var list = body.querySelector('.olist');
    if (!list) {
      body.innerHTML = '';
      list = document.createElement('div');
      list.className = 'olist';
      body.appendChild(list);
    }
    var keep = Object.create(null);
    var fresh = [];
    section.items.forEach(function (item, index) {
      var key = hotrankCardKey(item, index);
      keep[key] = 1;
      var card = list.querySelector('[data-hotrank-key="' + esc(key) + '"]');
      if (!card) {
        var box = document.createElement('div');
        box.innerHTML = hotrankCard(item, index);
        card = box.firstChild;
        if (!card) return;
        // 有同号占位卡就原地换掉（高度不变、后面的卡不动），没有才插到对应位置
        var skel = list.querySelector('[data-hotrank-key="~' + index + '"]');
        if (skel) list.replaceChild(card, skel);
        else list.insertBefore(card, list.children[index] || null);
        fresh.push(card);
        return;
      }
      card.dataset.hotrankBook = String(index);
      updateHotrankCard(card, item);
      var at = list.children[index] || null;
      if (at !== card) list.insertBefore(card, at);
    });
    var i;
    for (i = section.items.length; i < total; i++) {
      var skey = '~' + i;
      keep[skey] = 1;
      if (!list.querySelector('[data-hotrank-key="' + skey + '"]')) {
        var sbox = document.createElement('div');
        sbox.innerHTML = hotrankSkeleton(i);
        var scard = sbox.firstChild;
        if (scard) list.insertBefore(scard, list.children[i] || null);
      }
    }
    each(Array.prototype.slice.call(list.children), function (node) {
      if (!keep[node.dataset.hotrankKey]) list.removeChild(node);
    });
    // 只给新加的卡补封面：已经加载出来的图不再动，也就不会闪
    each(fresh, function (card) { fillCovers(card); });
    var note = hotrankNote(section);
    var noteEl = body.querySelector('[data-hotrank-note]');
    if (note) {
      if (!noteEl) {
        noteEl = document.createElement('p');
        noteEl.className = 'obar__text';
        noteEl.setAttribute('data-hotrank-note', '');
        body.appendChild(noteEl);
      }
      if (noteEl.textContent !== note) noteEl.textContent = note;
    } else if (noteEl) {
      body.removeChild(noteEl);
    }
  }

  /* 已存在的卡：只改文字，封面只补不换 */
  function updateHotrankCard(card, item) {
    var main = card.querySelector('.obook__main');
    var want = hotrankCardMain(item);
    if (main && main.__html !== want) { main.innerHTML = want; main.__html = want; }
    if (!item || !item.cover) return;
    var cover = card.querySelector('.obook__cover');
    if (!cover) return;
    if (cover.tagName === 'IMG' && !cover.hidden) return;          // 已经显示出来了
    if (cover.tagName === 'IMG' && cover.getAttribute('data-cover')) return;  // 正在取
    var box = document.createElement('div');
    box.innerHTML = coverMarkup(item.cover, 'hotrank|' + (item.id || ''), 'obook__cover');
    var next = box.firstChild;
    if (!next) return;
    card.replaceChild(next, cover);
    fillCovers(card);
  }

  /** 点热榜的书 = 直接拿书名去书源里搜，不跳原站、不走 openBook */
  function searchHotrankTitle(title) {
    var kw = String(title || '').trim();
    if (!kw) return;
    var input = el('searchInput');
    if (input) input.value = kw;
    doSearch(kw);
  }

  function bindHotrank(body) {
    var section = state.hotrank;
    if (!section) return;
    each(body.querySelectorAll('[data-hotrank-book]'), function (node) {
      var item = section.items[+node.dataset.hotrankBook];
      if (!item) return;
      var go = function () { searchHotrankTitle(item.title); };
      node.onclick = go;
      node.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      };
    });
    each(body.querySelectorAll('[data-hotrank-channel-id]'), function (chip) {
      chip.onclick = function () {
        var id = chip.dataset.hotrankChannelId;
        if (!id || (state.hotrank && state.hotrank.channelId === id)) return;
        ensureHotrank(id, true);
        renderIdle();
      };
    });
    each(body.querySelectorAll('[data-hotrank-refresh]'), function (btn) {
      btn.onclick = function () {
        if (btn.disabled) return;
        // 立即置忙，避免连点重复开请求
        btn.disabled = true;
        btn.classList.add('is-busy');
        ensureHotrank(null, true, true);
        renderIdle();
      };
    });
    var retry = el('btnHotrankRetry');
    if (retry) {
      retry.onclick = function () {
        ensureHotrank(null, true);
        renderIdle();
      };
    }
  }

  /* ------------------------------------------------------------ 空态 */
  function sourcesBrief() {
    var all = NR.sources.list();
    var on = NR.sources.enabled().filter(function (s) { return !!s.searchUrl; });
    var starred = all.filter(function (s) { return s.starred; });
    return { all: all, searchable: on, starred: starred };
  }

  function renderIdle() {
    var b = sourcesBrief();
    var body = el('onlineBody');
    if (!b.all.length) {
      body.innerHTML = hotrankMarkup() + feedMarkup() + localMarkup() +
        '<div class="oempty">' +
        '<span class="oempty__mark" aria-hidden="true"></span>' +
        '<p class="oempty__title">还没有书源</p>' +
        '<button class="btn btn--primary" id="btnEmptyImport" type="button">导入书源</button>' +
        '</div>';
      bindIdleBooks(body);
      var btn = el('btnEmptyImport');
      if (btn) btn.onclick = openSources;
      return;
    }
    if (!b.searchable.length) {
      body.innerHTML = hotrankMarkup() + feedMarkup() + localMarkup() +
        '<div class="oempty">' +
        '<span class="oempty__mark" aria-hidden="true"></span>' +
        '<p class="oempty__title">书源都关着</p>' +
        '<button class="btn btn--primary" id="btnEmptySources" type="button">管理书源</button>' +
        '</div>';
      bindIdleBooks(body);
      var b2 = el('btnEmptySources');
      if (b2) b2.onclick = openSources;
      return;
    }
    body.innerHTML = hotrankMarkup() + feedMarkup() + localMarkup() +
      '<div class="oempty oempty--soft"><p class="oempty__title">搜一本想看的</p></div>';
    bindIdleBooks(body);
  }

  /* ------------------------------------------------------------ 书源抽屉 */
  /* 筛选四态（+不确定）：deepTest 写 src.lastVerdict/lastVerdictAt；之后若有更新的
   * 搜索成败（lastOk/lastFail 更晚）说明判定已过期，回退到旧的可用/失效显示 */
  var VERDICT_LABEL = { ok: '可用', degraded: '降级', noResult: '未搜到', dead: '失效', unknown: '不确定', capability: '不兼容' };
  var VERDICT_CLASS = { ok: 'is-ok', degraded: 'is-degraded', noResult: 'is-noresult', dead: 'is-warn', unknown: 'is-unknown', capability: 'is-unknown' };
  function freshVerdict(s) {
    var v = s && s.lastVerdict;
    if (!v || !VERDICT_LABEL[v]) return '';
    var at = s.lastVerdictAt || 0;
    if (at < (s.lastOk || 0) || at < (s.lastFail || 0)) return '';
    return v;
  }
  function verdictHtml(s, v) {
    var msg = String(s.lastError || '').replace(/^\[(降级|未搜到|失效|不确定)\]\s*/, '');
    var tip = s.lastError ? ' title="' + esc(s.lastError) + '"' : '';
    return '<span class="' + VERDICT_CLASS[v] + '"' + tip + '>' + VERDICT_LABEL[v] +
      (v !== 'ok' && msg ? '：' + esc(msg) : '') + '</span>';
  }

  var CAPABILITY_LABEL = { supported: '支持', partial: '部分支持', unsupported: '不支持', unverified: '未验证' };
  var CAPABILITY_NOTE = '静态启发式检查，不保证完整兼容；能力提示不禁止执行，也不代表站点失效。';
  function capabilityRows(s) {
    var model = NR.sourceCapabilities;
    var rows = [], seen = Object.create(null);
    var stored = s && Array.isArray(s.capabilityWarnings) ? s.capabilityWarnings : [];
    stored.concat(model ? model.assess(s) : []).forEach(function (row) {
      if (!row || typeof row !== 'object' || !CAPABILITY_LABEL[row.status]) return;
      var key = String(row.id || row.label || '');
      if (!key || seen[key]) return;
      seen[key] = true;
      rows.push(row);
    });
    if (s && /^\[不兼容\]/.test(s.lastError || '')) {
      rows.push({ id: 'runtime-capability', label: '运行能力限制', status: 'unsupported', reason: String(s.lastError) });
    }
    return rows;
  }
  function capabilityText(row) {
    return String(row.label || row.id || '能力提示') + '：' + (CAPABILITY_LABEL[row.status] || '未验证') +
      (row.reason ? ' — ' + String(row.reason) : '');
  }
  function capabilitySummary(s) {
    var model = NR.sourceCapabilities;
    var summary = model ? model.summary(s) : CAPABILITY_NOTE;
    var rows = capabilityRows(s);
    return summary + (rows.length ? '\n' + rows.map(capabilityText).join('\n') : '');
  }
  function capabilityBadge(s) {
    var rows = capabilityRows(s).filter(function (row) { return row.status !== 'supported'; });
    if (!rows.length) return '';
    var summary = ['unsupported', 'partial', 'unverified'].map(function (status) {
      var count = rows.filter(function (row) { return row.status === status; }).length;
      return count ? CAPABILITY_LABEL[status] + ' ' + count + ' 项' : '';
    }).filter(Boolean).join('、');
    return '<button class="btn btn--tiny src-item__capability" data-role="capability" type="button" title="' +
      esc(rows.map(capabilityText).join('\n')) + '">能力提示 · ' + esc(summary) + '</button>';
  }
  function showCapabilities(s) {
    if (!NR.ui || !NR.ui.doc) return;
    var model = NR.sourceCapabilities;
    // 矩阵由实现提供；导入字段只能作为纯文本线索，不能宣称已完整兼容。
    NR.ui.doc('书源能力 · ' + String((s && s.name) || ''), CAPABILITY_NOTE + '\n\n' +
      capabilityRows(s).map(capabilityText).join('\n') + '\n\n能力矩阵：\n' +
      ((model && model.matrix) || []).map(capabilityText).join('\n'));
  }
  function showImportWarnings(warnings) {
    if (!Array.isArray(warnings) || !warnings.length) return;
    var texts = [];
    function visit(w) {
      if (typeof w === 'string') { texts.push(w); return; }
      if (!w || typeof w !== 'object') return;
      var nested = w.warnings || w.capabilityWarnings;
      var source = w.sourceId ? NR.sources.get(w.sourceId) : null;
      var name = w.sourceName || w.name || (source && source.name) || w.sourceId || '';
      var url = w.url || w.sourceUrl || w.link || (source && source.url) || '';
      texts.push((name ? String(name) + '：' : '') + (w.label || w.id ? capabilityText(w) : String(w.text || w.message || w.reason || '能力提示')) +
        (url ? '\n' + String(url) : ''));
      if (Array.isArray(nested)) nested.forEach(visit);
    }
    warnings.forEach(visit);
    if (NR.ui && NR.ui.doc) NR.ui.doc('导入完成 · 能力提示（未禁用书源）', CAPABILITY_NOTE + '\n\n' + texts.join('\n\n'));
    else toast('导入能力提示：' + texts.join('；'));
  }

  function isBad(s) {
    if (state.tested[s.id] === false) return true;
    if (state.tested[s.id] === true) return false;
    return !!(s.lastFail && s.lastFail > (s.lastOk || 0));
  }

  /* r1-t5：「未搜到」是一类独立状态 —— 规则正常、请求也通，只是站里没有这本书。
   * 它既不写 lastFail（引擎/autoPurge 不会删），也不算「可用」，更不该被算进「未测」。
   * 三条判定来源，任一成立即算：
   *   ① state.tested[id] === 'noResult'：本轮筛选 / 单源「测试」按钮的即时判定（screenTested）
   *   ② lastError 以 [未搜到] 开头：deepTest 与旧 test() 都会写这个前缀
   *   ③ freshVerdict() === 'noResult'：deepTest 落库且没过期的 lastVerdict
   * 注意：isBad 优先于本判定（计数与筛选都按 失效 > 未搜到 > 可用 > 未测 的顺序），
   * 所以「既标了失效又残留 [未搜到] 文本」的源仍归失效，跟列表里显示的状态一致。 */
  function isNoResult(s) {
    if (!s) return false;
    if (state.tested[s.id] === 'noResult') return true;
    if (/^\[未搜到\]/.test(String(s.lastError || ''))) return true;
    return freshVerdict(s) === 'noResult';
  }

  /* 「没有搜索地址」不等于失效（用户 2026-10-30 反馈：互书阁这类站站内搜索被 Cloudflare 挡住，
   * 本源故意不配 searchUrl、只有发现页能用，却被标成「失效」——属于误杀）。
   * 现在只有「既没有搜索地址、又没有发现页」才算没有任何入口的死源；
   * 有发现页但没搜索的源，必须真测通（发现页→书级，lastOk 已写）才算「可用」，没测过仍是「未测」。 */
  function noEntry(s) { return !s ? false : (!s.searchUrl && !s.exploreUrl); }
  function okSource(s) {
    if (!s) return false;
    if (s.manual === 'ok') return true;      // 手动判定优先（纠正误杀）
    if (s.manual === 'dead') return false;
    if (isBad(s) || noEntry(s)) return false;
    if (s.searchUrl) return !!(s.lastOk || state.tested[s.id] === true || isNoResult(s));
    return !!(s.lastOk || state.tested[s.id] === true);
  }
  function badSource(s) {
    if (!s) return false;
    if (s.manual === 'dead') return true;
    if (s.manual === 'ok') return false;
    return isBad(s) || noEntry(s);
  }

  function filterMatch(s) {
    if (state.q) {
      var q = state.q.toLowerCase();
      var hay = [s.name, s.url, s.group].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (state.group) {
      // P：与数据层（index.js）一致，只按英文逗号切——组名含中文标点是合法的整体名
      var gs = String(s.group || '').split(/,/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!gs.length) gs = ['未分组'];
      if (gs.indexOf(state.group) < 0) return false;
    }
    if (state.filter === 'ok') return okSource(s);
    if (state.filter === 'bad') return badSource(s);
    /* 用户口径（2026-10-26）：未搜到归入「可用」，不单独设筛选；未测=一次都没测过 */
    if (state.filter === 'untested') {
      return !noEntry(s) && !isNoResult(s) && !s.lastOk && !s.lastFail && state.tested[s.id] === undefined;
    }
    if (state.filter === 'star') return !!s.starred;
    return true;
  }

  /** 分组 chips：点一个只看这组；再点一下取消。名字可自定义（空分组也会列出来） */
  function renderGroups() {
    var box = el('srcGroups');
    if (!box) return;
    var stats = Object.create(null);
    NR.sources.groups().forEach(function (g) { stats[g.name] = g; });
    var names = (state.groupNames || []).slice();
    Object.keys(stats).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    if (!names.length) { box.innerHTML = ''; return; }
    var h = names.map(function (n) {
      var g = stats[n] || { total: 0, enabled: 0 };
      // P：chip 文本用 [] 标出组名边界（组名可能含逗号/顿号等标点）；匹配仍用原始名
      return '<button class="chip chip--group' + (state.group === n ? ' on' : '') +
        '" data-group="' + esc(n) + '" type="button" title="' + g.total + ' 个 / 启用 ' + g.enabled + '">' +
        esc(n) + '<span class="chip__n">' + g.total + '</span></button>';
    }).join('');
    box.innerHTML = h;
    each(box.querySelectorAll('[data-group]'), function (b) {
      b.onclick = function () {
        // P：再点同一个 = 取消筛选；重复 chip 时按 data-group 精确比较
        state.group = (state.group === b.dataset.group) ? '' : (b.dataset.group || '');
        renderSources();
      };
    });
  }

  async function refreshGroupNames() {
    try { state.groupNames = await NR.sources.groupNames(); }
    catch (e) { state.groupNames = []; }
    return state.groupNames;
  }

  function visibleSources() { return NR.sources.list().filter(filterMatch); }

  function selectedIds() {
    return Object.keys(state.selected).filter(function (id) { return !!NR.sources.get(id); });
  }

  /* r1-t5：筛选栏的「未搜到」chip 注入。用户口径（2026-10-26）：界面只留 可用/失效/未测，
   * 「未搜到」不再显示和计数（详情进筛选日志），已有 chip 移除后不再注入。 */
  function ensureNoResultChip() {
    var bar = el('sourceFilter');
    if (!bar) return null;
    var old = bar.querySelector('[data-filter="noresult"]');
    if (old) old.remove();
    return null;
  }

  function updateFilterBar() {
    var bar = el('sourceFilter');
    if (!bar) return;
    ensureNoResultChip();          // 注入后立刻就在 bar.children 里，下面的计数/高亮一次遍历搞定
    var all = NR.sources.list();
    /* 用户口径（2026-10-26）：未搜到归入「可用」计数，不单独显示。
     * 用户口径（2026-10-30 修正）：只有「没有搜索地址又没有发现页」才算失效；
     * 无搜索但有发现页的源，测通算可用、没测过算未测。 */
    var c = { all: all.length, ok: 0, bad: 0, untested: 0, star: 0 };
    all.forEach(function (s) {
      if (s.starred) c.star++;
      if (badSource(s)) c.bad++;
      else if (okSource(s)) c.ok++;
      else c.untested++;
    });
    var nodes = bar.children;
    each(nodes, function (b) {
      var k = b.dataset.filter;
      if (!k || c[k] === undefined) return;   // noresult chip 已移除，遗留节点不计数
      b.classList.toggle('on', state.filter === k);
      var n = b.querySelector('.chip__n');
      if (n) n.textContent = c[k] ? String(c[k]) : '';
    });
  }

  function renderSources() {
    var all = NR.sources.list();
    // P：分组名列表异步刷新（导入/归组/删组后 nr_groups 与数据里的组名会变），
    //    刷到与缓存不同就重渲一次（脏检查防死循环）
    NR.sources.groupNames().then(function (names) {
      var changed = JSON.stringify(names) !== JSON.stringify(state.groupNames);
      state.groupNames = names;
      if (changed) renderSources();
    }).catch(function () { });
    var list = visibleSources();
    var sel = selectedIds().length;
    var RENDER_MAX = 300;                 // 一次最多渲染 300 行，几百个源也不卡
    var shown = list.length > RENDER_MAX ? list.slice(0, RENDER_MAX) : list;
    el('sourceCount').textContent = all.length
      ? (list.length === all.length ? all.length + ' 个' : list.length + '/' + all.length + ' 个')
      : '';
    updateFilterBar();
    renderGroups();
    var box = el('sourceList');
    if (!all.length) {
      box.innerHTML = '<p class="src-empty">还没有书源。<br>导入 Legado 书源 JSON，或粘贴 yuedu:// 分享链接。</p>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<p class="src-empty">这个筛选条件下没有书源。</p>';
      return;
    }

    var h = '';
    shown.forEach(function (s) {
      var v = freshVerdict(s);
      /* 用户口径（2026-10-26）：行内状态只显示三态 —— 可用 / 失效 / 未测。
       * 降级→可用；未搜到→可用（发现页有书即源可用）。
       * 用户口径（2026-10-30 修正）：没配搜索地址不再等于失效，见 badSource/okSource。
       * 详细原因一律进筛选日志，不在行内铺开。 */
      var shownBad = badSource(s);
      var shownOk = !shownBad && (okSource(s) || v === 'ok' || v === 'degraded' || v === 'noResult');
      var status = shownBad
        ? '<span class="is-warn"' + (s.lastError ? ' title="' + esc(s.lastError) + '"' : '') + '>失效</span>'
        : shownOk
          ? '<span class="is-ok">可用</span>'
          : '';
      var on = !!state.selected[s.id];
      h += '<div class="src-item' + (on ? ' on' : '') + '" data-id="' + esc(s.id) + '">' +
        '<button class="src-item__check' + (on ? ' on' : '') + '" data-role="check" aria-pressed="' + on + '"></button>' +
        '<button class="src-item__star' + (s.starred ? ' on' : '') + '" data-role="star" title="收藏书源">' +
        (s.starred ? '★' : '☆') + '</button>' +
        '<div class="src-item__main">' +
        '<p class="src-item__name">' + esc(s.name) + '</p>' +
        '<p class="src-item__status" data-role="status">' + status + '</p>' +
        capabilityBadge(s) +
        '</div>' +
        '<label class="switchswitch" title="启用 / 停用">' +
        '<input type="checkbox" data-role="toggle"' + (s.enabled !== false ? ' checked' : '') + '>' +
        '<i></i></label>' +
        '<button class="btn btn--tiny btn--danger" data-role="black" title="加入黑名单并移除">拉黑</button>' +
        '<button class="btn btn--tiny" data-role="verdict" title="手动判定可用 / 失效（纠正误杀）">判定</button>' +
        '</div>';
    });
    if (list.length > RENDER_MAX) {
      h += '<p class="src-more">还有 ' + (list.length - RENDER_MAX) + ' 个没显示，用搜索或筛选收窄一下</p>';
    }
    box.innerHTML = h;
    updateDeleteButton(sel);

    each(box.querySelectorAll('.src-item'), function (node) {
      var id = node.dataset.id;
      var capability = node.querySelector('[data-role="capability"]');
      if (capability) capability.onclick = function () { showCapabilities(NR.sources.get(id)); };
      var check = node.querySelector('[data-role="check"]');
      check.onclick = function () {
        if (state.selected[id]) delete state.selected[id];
        else state.selected[id] = true;
        check.classList.toggle('on', !!state.selected[id]);
        node.classList.toggle('on', !!state.selected[id]);
        check.setAttribute('aria-pressed', state.selected[id] ? 'true' : 'false');
        updateDeleteButton(selectedIds().length);
      };
      var star = node.querySelector('[data-role="star"]');
      star.onclick = async function () {
        var s = NR.sources.get(id);
        await NR.sources.setStarred(id, !(s && s.starred));
        renderSources();
      };
      node.querySelector('[data-role="toggle"]').onchange = function () {
        NR.sources.setEnabled(id, this.checked);
      };
      node.querySelector('[data-role="black"]').onclick = async function () {
        var s = NR.sources.get(id);
        if (!s) return;
        await NR.sources.blacklistAdd([{ name: s.name, url: s.url }]);
        await NR.sources.remove(id);
        delete state.selected[id];
        delete state.tested[id];
        renderSources();
        if (!NR.sources.list().length) renderIdle();
        toast('已加入黑名单并移除：「' + s.name + '」');
      };
      node.querySelector('[data-role="verdict"]').onclick = function () { openVerdict(id); };
    });
  }

  /* 手动判定（用户 2026-10-30）：抽屉里点「判定」→ 选可用 / 失效 / 恢复自动。
   * 目的是手动纠正误杀；结果存在书源的 manual 字段，
   * 判成「可用」的源永远不参与 autoPurge / removeInvalid / 删除失效源。 */
  var verdictTarget = '';

  function openVerdict(id) {
    var s = NR.sources.get(id);
    var dlg = el('verdictDlg');
    if (!s || !dlg) return;
    verdictTarget = id;
    var sub = el('verdictDlgSub');
    if (sub) sub.textContent = '「' + (s.name || '书源') + '」手动指定为可用或失效';
    var cur = s.manual === 'ok' ? 'ok' : (s.manual === 'dead' ? 'dead' : '');
    each(dlg.querySelectorAll('[data-verdict]'), function (b) {
      var on = b.dataset.verdict === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    dlg.hidden = false;
    var first = dlg.querySelector('[data-verdict]');
    if (first && first.focus) first.focus();
  }

  function closeVerdict() {
    var dlg = el('verdictDlg');
    if (dlg) dlg.hidden = true;
    verdictTarget = '';
  }

  async function applyVerdict(kind) {
    var id = verdictTarget;
    if (!id) return;
    var s = NR.sources.get(id);
    var name = (s && s.name) || '';
    closeVerdict();
    try {
      await NR.sources.markVerdict(id, kind);
    } catch (e) {
      toast('判定失败：' + ((e && e.message) || e));
      return;
    }
    /* 手动判定要压过本轮筛选的即时结论，否则重渲染又变回旧状态 */
    if (kind === 'ok') state.tested[id] = true;
    else if (kind === 'dead') state.tested[id] = false;
    else delete state.tested[id];
    renderSources();
    toast(kind === 'ok' ? '已判定为可用：「' + name + '」'
      : kind === 'dead' ? '已判定为失效：「' + name + '」（不会被自动删除）'
        : '已恢复自动判定：「' + name + '」');
  }

  function bindVerdict() {
    var dlg = el('verdictDlg');
    if (!dlg) return;
    each(dlg.querySelectorAll('[data-verdict]'), function (b) {
      b.onclick = function () { applyVerdict(b.dataset.verdict); };
    });
    var mask = dlg.querySelector('.cmodal__mask');
    if (mask) mask.onclick = closeVerdict;
    var cancel = el('verdictCancel');
    if (cancel) cancel.onclick = closeVerdict;
    var autoBtn = el('verdictAuto');
    if (autoBtn) autoBtn.onclick = function () { applyVerdict(''); };
  }

  function updateDeleteButton(n) {
    var b = el('btnSourceDelete');
    if (!b) return;
    b.textContent = n ? '删除选中(' + n + ')' : '删除选中';
    b.disabled = !n;
  }

  function selectAllVisible() {
    state.selected = {};
    visibleSources().forEach(function (s) { state.selected[s.id] = true; });
    renderSources();
  }

  function invertVisible() {
    var before = {};
    visibleSources().forEach(function (s) { if (!state.selected[s.id]) before[s.id] = true; });
    state.selected = before;
    renderSources();
  }

  async function deleteSelected() {
    var ids = selectedIds();
    if (!ids.length) { toast('先勾选要删的书源'); return; }
    // 手动删除不进黑名单（只有判失效的才记），一次性批量删除
    NR.ui.confirm('删除选中的 ' + ids.length + ' 个书源？\n\n书架里已加入的书不受影响。', async function () {
      var n = await NR.sources.removeMany(ids);
      ids.forEach(function (id) { delete state.selected[id]; delete state.tested[id]; });
      renderSources();
      if (!NR.sources.list().length) renderIdle();
      toast('已删除 ' + n + ' 个书源');
    }, '删除');
  }

  /** 手动「删除失效源」：立刻删掉所有失效的（收藏的、手动判定过的跳过），不再弹确认 */
  async function purgeInvalid() {
    var bad = NR.sources.list().filter(function (s) { return badSource(s) && !s.manual; });
    var starred = bad.filter(function (s) { return s.starred; });
    var targets = bad.filter(function (s) { return !s.starred; });
    if (!targets.length) {
      toast(bad.length ? '失效的都是收藏源，没动它们' : '还没有测出失效书源');
      return;
    }
    await NR.sources.blacklistAdd(targets.map(function (s) { return { name: s.name, url: s.url }; }));
    var n = await NR.sources.removeMany(targets.map(function (s) { return s.id; }));
    targets.forEach(function (s) { delete state.tested[s.id]; delete state.selected[s.id]; });
    renderSources();
    if (!NR.sources.list().length) renderIdle();
    toast('已删除 ' + n + ' 个失效书源' + (starred.length ? '（' + starred.length + ' 个收藏的保留）' : ''));
  }

  /** 一键删掉失效的书源（收藏的保留）—— 不再让用户确认 */
  async function autoPurge(silent, isCurrent) {
    if (settingsOf().autoPurge === false || (isCurrent && !isCurrent())) return 0;
    var n = 0;
    try { n = await NR.sources.removeInvalid({ keepStarred: true }); } catch (e) { n = 0; }
    // 已开始的存储清理不可撤销；失去页面 / 任务所有权后不再更新 UI 或本轮状态。
    if (isCurrent && !isCurrent()) return n;
    if (n) {
      Object.keys(state.tested).forEach(function (id) {
        if (!NR.sources.get(id)) delete state.tested[id];
      });
      renderSources();
      if (!NR.sources.list().length) renderIdle();
      if (!silent) toast('已自动移除 ' + n + ' 个失效书源');
    }
    return n;
  }

  async function runPool(items, n, fn) {
    var i = 0;
    async function worker() {
      while (i < items.length) {
        var idx = i++;
        try { await fn(items[idx], idx); } catch (e) { }
      }
    }
    var ws = [];
    for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
    await Promise.all(ws);
  }

  /* 筛选日志：一轮一文件，按本地秒命名；localStorage 记同秒序号，跨页面重载也不覆盖。 */
  var screenLogNames = Object.create(null);
  function screenPad(n) { return n < 10 ? '0' + n : String(n); }
  function screenTime(d) { return screenPad(d.getHours()) + ':' + screenPad(d.getMinutes()) + ':' + screenPad(d.getSeconds()); }
  function screenDate(d) { return d.getFullYear() + '-' + screenPad(d.getMonth() + 1) + '-' + screenPad(d.getDate()) + ' ' + screenTime(d); }
  function screenLogName(mode, d) {
    var stem = 'screen-' + mode + '-' + d.getFullYear() + screenPad(d.getMonth() + 1) + screenPad(d.getDate()) +
      '-' + screenPad(d.getHours()) + screenPad(d.getMinutes()) + screenPad(d.getSeconds());
    var n = screenLogNames[stem] || 0;
    try {
      var saved = JSON.parse(global.localStorage.getItem('nr_screen_log_name') || 'null');
      if (saved && saved.stem === stem) n = Math.max(n, Number(saved.n) || 0);
    } catch (e) { /* 内存计数兜底 */ }
    n++;
    screenLogNames[stem] = n;
    try { global.localStorage.setItem('nr_screen_log_name', JSON.stringify({ stem: stem, n: n })); } catch (e) { }
    return stem + (n > 1 ? '-' + n : '') + '.log';
  }
  function screenOneLine(x) { return String(x == null ? '' : x).replace(/[\r\n\t]+/g, ' '); }
  function screenLogger(name) {
    var log = { name: name, ok: true, path: '', chain: Promise.resolve() };
    log.write = function (text) {
      // 并发完成的源也按入队顺序追加；所有写入错误隔离，不影响筛选。
      log.chain = log.chain.then(function () {
        if (!NR.platform || !NR.platform.appendLog) throw new Error('日志接口不可用');
        return NR.platform.appendLog(name, text);
      }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '写日志失败');
        log.path = r.path || log.path;
      }).catch(function (e) {
        log.ok = false;
        console.warn('[iread] 筛选日志写入失败：' + name, e);
      });
      return log.chain;
    };
    return log;
  }
  async function screenVersion() {
    var timer;
    try {
      var info = await Promise.race([
        Promise.resolve().then(function () { return NR.platform && NR.platform.info ? NR.platform.info() : null; }),
        new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, 1500); })
      ]);
      return info && info.version ? info.version : '未知';
    } catch (e) { return '未知'; }
    finally { if (timer) clearTimeout(timer); }
  }
  function screenResult(r) {
    r = r || {};
    // 兼容旧壳/测试 stub 的 {ok}，正式引擎始终有 verdict。
    var v = VERDICT_LABEL[r.verdict] ? r.verdict : (r.ok ? 'ok' : 'unknown');
    r.verdict = v;
    return r;
  }
  function screenTested(v) { return v === 'ok' || v === 'degraded' ? true : (v === 'noResult' ? 'noResult' : false); }
  async function openScreenLogs() {
    try {
      var pf = NR.platform;
      var dir = pf && pf.logsDir ? await pf.logsDir() : 'memory:';
      if (!pf || !pf.isDesktop || String(dir).indexOf('memory:') === 0) {
        toast('筛选日志在内存里（window.__nrLogs）');
        return;
      }
      var r = pf.openLogsDir ? await pf.openLogsDir() : { ok: false };
      if (r && r.ok === false) toast('打开筛选日志目录失败：' + (r.error || '宿主不支持'));
    } catch (e) { console.warn('[iread] 打开筛选日志目录失败', e); toast('打开筛选日志目录失败'); }
  }

  /* ---------------- 检测范围：全部 / 分组 / 未测 ---------------- */
  function scopeLabel(scope, group) {
    if (scope === 'group') return '分组「' + (group || '') + '」';
    if (scope === 'untested') return '未测的源';
    return '全部书源';
  }

  function paintScope() {
    var box = el('scanScope');
    if (!box) return;
    each(box.querySelectorAll('[data-scope]'), function (b) {
      var on = b.dataset.scope === state.scanScope;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var st = el('scanStatus');
    if (st && !state.deepRunning) {
      st.textContent = '当前范围：' + scopeLabel(state.scanScope, state.scanGroup) +
        '。检测会依次验证：发现页、搜索、书目、目录、正文。';
    }
  }

  /** 分组选择小窗：选完回调 cb(组名) */
  function openGroupPicker(title, cb) {
    var names = (state.groupNames || []).slice();
    (NR.sources.groups() || []).forEach(function (g) { if (names.indexOf(g.name) < 0) names.push(g.name); });
    var box = document.getElementById('groupPickOverlay');
    if (!box) {
      box = document.createElement('div');
      box.className = 'gs';
      box.id = 'groupPickOverlay';
      box.hidden = true;
      box.innerHTML =
        '<div class="gs__mask"></div>' +
        '<div class="gs__panel gs__panel--sm" role="dialog">' +
        '<header class="gs__head"><span class="gs__title" id="groupPickTitle"></span>' +
        '<button class="btn btn--icon" type="button" data-gp-close title="关闭">' +
        '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>' +
        '</button></header>' +
        '<div class="gs__body" id="groupPickBody"></div>' +
        '</div>';
      document.body.appendChild(box);
      box.querySelector('.gs__mask').onclick = function () { box.hidden = true; };
      box.querySelector('[data-gp-close]').onclick = function () { box.hidden = true; };
    }
    box.querySelector('#groupPickTitle').textContent = title || '选择分组';
    var body = box.querySelector('#groupPickBody');
    var stats = NR.sources.groups() || [];
    if (!names.length) {
      body.innerHTML = '<p class="gs__status">还没有分组。可以先去「分组」页新建一个。</p>';
    } else {
      body.innerHTML = '<p class="gs__hint">点一个分组，只检测这个组里的书源：</p><div class="gs__list">' +
        names.map(function (n) {
          var g = stats.filter(function (x) { return x.name === n; })[0];
          return '<button class="gs__item gs__item--pick" data-gp="' + esc(n) + '" type="button">' +
            '<div class="gs__item-main"><p class="gs__item-name">' + esc(n) + '</p>' +
            (g ? '<p class="gs__item-meta">' + g.total + ' 个书源</p>' : '<p class="gs__item-meta">0 个书源</p>') +
            '</div><span class="gs__item-meta">开始</span></button>';
        }).join('') + '</div>';
      each(body.querySelectorAll('[data-gp]'), function (b) {
        b.onclick = function () {
          box.hidden = true;
          cb(b.dataset.gp);
        };
      });
    }
    box.hidden = false;
  }

  /** 点筛选按钮的统一入口：按范围决定要不要先选分组 */
  function startScan(mode) {
    if (state.deepRunning) { deepTest({ mode: mode }); return; }   // 正在跑 → 变成「停止」
    if (state.scanScope === 'group') {
      openGroupPicker('筛选分组', function (name) {
        state.scanGroup = name;
        state.scanScope = 'group';
        paintScope();
        deepTest({ mode: mode, scope: 'group', group: name });
      });
      return;
    }
    deepTest({ mode: mode, scope: state.scanScope });
  }

  /** 筛选：分层探针 → 可用 / 降级 / 未搜到 / 失效 / 不确定；重试由引擎在总预算内处理。 */
  /* 转发给插件：筛选（快筛/慢筛）跑完 */
  function emitPlugin(name, payload) {
    try { if (NR.plugins && typeof NR.plugins.emit === 'function') NR.plugins.emit(name, payload); } catch (e) { /* 插件出错不影响主流程 */ }
  }

  async function deepTest(opts) {
    opts = opts || {};
    if (state.deepRunning) { stopDeep(); renderSources(); toast('筛选已停止'); return; }
    var mode = opts.mode || 'fast';            // fast | slow
    var slow = mode === 'slow';
    var btn = el(slow ? 'btnScanSlow' : 'btnScanFast');

    var scope = opts.scope || state.scanScope || 'all';
    var groupName = opts.group || (scope === 'group' ? state.scanGroup : '');
    // 有搜索地址或有发现地址的源都能测（只有搜索地址的旧数据也照旧）
    var all = NR.sources.enabled().filter(function (s) { return !!(s.searchUrl || s.exploreUrl); });
    if (scope === 'group') {
      if (!groupName) { openGroupPicker('筛选分组', function (name) { state.scanGroup = name; state.scanScope = 'group'; paintScope(); deepTest({ mode: mode, scope: 'group', group: name }); }); return; }
      all = all.filter(function (s) {
        var gs = String(s.group || '').split(',').map(function (x) { return x.trim(); });
        return gs.indexOf(groupName) >= 0;
      });
      if (!all.length) { toast('分组「' + groupName + '」里没有可筛的源'); return; }
    } else if (scope === 'untested') {
      all = all.filter(function (s) {
        if (state.tested && state.tested[s.id] !== undefined) return false;
        return !(s.lastVerdict || s.lastOk || s.lastFail || s.lastUnknown);
      });
      if (!all.length) { toast('没有未测过的源'); return; }
    }
    var now = Date.now();
    var forced = opts.force || scope === 'untested';
    var pool = forced
      ? all
      : all.filter(function (s) { return !(s.lastOk && now - s.lastOk < 10 * 60 * 1000 && s.lastOk > (s.lastFail || 0)); });
    if (!pool.length) {
      // 不闷声放弃：问一句要不要强制重筛
      NR.ui.confirm('这些源 10 分钟内刚测过，结果还在有效期里。\n\n要强制重筛一遍吗？', function () {
        deepTest({ mode: mode, scope: scope, group: groupName, force: true });
      }, '强制重筛');
      return;
    }
    var label = slow ? '慢筛' : '快筛';
    var op = beginOperation('deep');
    var cancelled = false;
    op.btn = btn;
    op.btnText = btn ? btn.textContent : '';
    state.deepRunning = true;
    state.cancelDeep = false;
    if (btn) { btn.textContent = '停止' + label; btn.classList.add('is-running'); btn.style.setProperty('--p', '0%'); }
    var done = 0, total = pool.length;
    var counts = { ok: 0, degraded: 0, noResult: 0, dead: 0, unknown: 0, capability: 0 };
    // 快筛：并发 16、单源 6 秒、不重试；慢筛：并发 4、单源 30 秒（引擎内只对 unknown 重试）
    var conc = slow ? 4 : 8;
    var budget = slow ? 30000 : 15000;
    var testOpts = slow
      ? { retries: 1, stageTimeout: 12000, keywords: 8, chapters: 3 }
      : { retries: 0, keywords: 3, chapters: 1, listOnly: true };
    testOpts.signal = op.controller.signal;
    var startedAt = new Date();
    var log = screenLogger(screenLogName(slow ? 'slow' : 'fast', startedAt));
    var removed = 0, removedNames = [];
    function progressText() {
      return label + '（' + scopeLabel(scope, groupName) + '）' + done + '/' + total + ' · 可用 ' + (counts.ok + counts.degraded) +
        ' · 未搜到 ' + counts.noResult + ' · 失效 ' + counts.dead +
        (counts.unknown ? ' · 不确定 ' + counts.unknown : '') +
        (counts.capability ? ' · 能力限制 ' + counts.capability : '');
    }
    try {
      var version = await screenVersion();
      if (!active('deep', op)) return;
      log.write([
        'iread 书源筛选日志',
        '版本: ' + version,
        '模式: ' + label + ' (' + (slow ? 'slow' : 'fast') + ')',
        '分组: ' + (state.group || '全部'),
        '待筛源数: ' + total,
        '并发: ' + conc,
        '单源预算: ' + budget + 'ms',
        '参数: ' + JSON.stringify(testOpts),
        '开始时间: ' + screenDate(startedAt),
        '只记录非「可用」的源：每条一行摘要 + 一行 JSON',
        '',
        ''
      ].join('\n'));
      var hostBusy = Object.create(null), hostWait = Object.create(null);
      function hostKey(x) { try { return new URL(x.url || '').hostname || 'x'; } catch (e) { return 'x'; } }
      function takeHost(k) {
        return new Promise(function (res) {
          if (!hostBusy[k]) { hostBusy[k] = 1; return res(); }
          if (hostBusy[k] < 2) { hostBusy[k]++; return res(); }
          (hostWait[k] = hostWait[k] || []).push(res);
        });
      }
      function freeHost(k) {
        var q = hostWait[k];
        if (q && q.length) { q.shift()(); return; }
        if (hostBusy[k] > 1) hostBusy[k]--; else delete hostBusy[k];
      }
      await runPool(pool, conc, async function (s) {
        if (!active('deep', op)) return;
        var hk = hostKey(s);
        await takeHost(hk);
        var r = await NR.sources.deepTest(s.id, budget, '', testOpts)
          .catch(function (e) {
            if (isCancelled(e)) return { code: 'CANCELLED', cancelled: true };
            return { ok: false, verdict: 'unknown', stage: '筛选', code: e && e.code, error: String((e && e.message) || e || '筛选异常'), evidence: null };
          });
        freeHost(hk);
        if (!active('deep', op)) return;
        if (isCancelled(r)) { cancelled = true; return; }
        if (r && r.code === 'UNSUPPORTED') r.verdict = 'capability';
        r = screenResult(r);
        var v = r.verdict;
        done++;
        counts[v]++;
        if (v !== 'capability') state.tested[s.id] = screenTested(v);
        if (v !== 'ok') {
          var at = new Date();
          log.write('[' + screenTime(at) + '] [' + VERDICT_LABEL[v] + '] ' + screenOneLine(s.name) + ' | ' +
            screenOneLine(r.stage || '') + ' | ' + screenOneLine(r.error || '') + ' | ' + screenOneLine(s.url || '') + '\n' +
            JSON.stringify({
              id: s.id, name: s.name, url: s.url || '', group: s.group || '', verdict: v,
              stage: r.stage || '', error: r.error || '', evidence: r.evidence == null ? null :
                (NR.sources.sanitizeEvidence ? NR.sources.sanitizeEvidence(r.evidence) : r.evidence)
            }) + '\n');
        }
        if (btn) btn.style.setProperty('--p', Math.round(done / total * 100) + '%');
        if (el('sourceCount')) el('sourceCount').textContent = progressText();
        if (el('scanStatus')) el('scanStatus').textContent = progressText();
      });
    } finally {
      if (active('deep', op)) {
        try {
          var before = NR.sources.list().map(function (s) { return { id: s.id, name: s.name }; });
          if (!cancelled) removed = await autoPurge(true, function () { return active('deep', op); });
          if (active('deep', op)) {
            if (removed) {
              removedNames = before.filter(function (s) { return !NR.sources.get(s.id); })
                .map(function (s) { return s.name; });
            }
            renderSources();
            var endedAt = new Date();
            log.write([
              '',
              '==== 汇总 ====',
              '结束时间: ' + screenDate(endedAt),
              '总耗时: ' + ((endedAt - startedAt) / 1000).toFixed(1) + 's',
              '已筛: ' + done + '/' + total,
              '被取消: ' + (cancelled ? '是' : '否'),
              '可用: ' + counts.ok,
              '降级: ' + counts.degraded,
              '未搜到: ' + counts.noResult,
              '失效: ' + counts.dead,
              '不确定: ' + counts.unknown,
              '能力限制: ' + counts.capability,
              '自动移除: ' + removed + (removedNames.length ? '（' + removedNames.map(screenOneLine).join('、') + '）' : ''),
              ''
            ].join('\n'));
            await log.chain;
            if (active('deep', op)) {
              var logNote = log.ok ? '（日志已保存）' : '（日志保存失败）';
              toast((cancelled ? '筛选已停止：' : '筛选完成：') + '可用 ' + counts.ok + '/降级 ' + counts.degraded +
                '/未搜到 ' + counts.noResult + '/失效 ' + counts.dead + '/不确定 ' + counts.unknown +
                (counts.capability ? '/能力限制 ' + counts.capability : '') + logNote +
                (removed ? '，自动移除 ' + removed + ' 个' : ''));
            }
            emitPlugin('screen:done', {
              mode: slow ? 'slow' : 'fast',
              done: done, total: total, cancelled: !!cancelled, removed: removed || 0,
              counts: { ok: counts.ok, degraded: counts.degraded, noResult: counts.noResult, dead: counts.dead, unknown: counts.unknown }
            });
          }
        } finally {
          if (owns('deep', op)) {
            operations.deep = null;
            state.deepRunning = false;
            state.cancelDeep = cancelled;
            resetDeepButton(op);
          }
        }
      }
    }
  }

  /* ============================================================ 获取书源
   * 数据来源：yckceo.com（散源列表 / 书源合集）。站点上的「全选 → 生成」
   * 本质是把勾选的 id 拼成 /yuedu/shuyuan/jsons?id=a-b-c，这里直接按同样
   * 规则取；合集则是 /yuedu/shuyuans/json/id/<id>.json 直链。
   * ============================================================ */
  var gs = {
    mode: 'source',
    busy: false
  };

  function gsEl() { return document.getElementById('gsOverlay'); }

  function gsEnsure() {
    var box = gsEl();
    if (box) return box;
    box = document.createElement('div');
    box.className = 'gs';
    box.id = 'gsOverlay';
    box.hidden = true;
    box.innerHTML =
      '<div class="gs__mask"></div>' +
      '<div class="gs__panel" role="dialog" aria-label="获取书源">' +
      '<header class="gs__head"><span class="gs__title">获取书源</span>' +
      '<button class="btn btn--icon" type="button" data-gs-close title="关闭">' +
      '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>' +
      '</button></header>' +
      '<div class="gs__body" id="gsBody"></div>' +
      '</div>';
    document.body.appendChild(box);
    box.querySelector('.gs__mask').onclick = function () { gsClose(); };
    box.querySelector('[data-gs-close]').onclick = function () { gsClose(); };
    return box;
  }

  function gsClose() {
    var box = gsEl();
    if (box) box.hidden = true;
  }

  function gsOpen(mode) {
    gs.mode = mode || 'source';
    var box = gsEnsure();
    box.hidden = false;
    gsRender();
  }

  function gsStatus(text) {
    var s = document.getElementById('gsStatus');
    if (s) s.textContent = text || '';
  }

  function gsRender() {
    var body = document.getElementById('gsBody');
    if (!body) return;
    if (gs.mode === 'source') return gsRenderSource(body);
  }

  /* ------------------------------------------------------------ 当前书源 */
  /** 重新导入当前这本书用的源：先从回收站原样恢复，实在没有才引导去「获取书源」 */
  async function restoreCurrentSource(meta) {
    if (!meta) return false;
    var src = meta.sourceId ? NR.sources.get(meta.sourceId) : null;
    if (src) { toast('这个源还在列表里'); return true; }
    var got = null;
    try {
      got = await NR.sources.restoreFromBin(meta.sourceId);
      if (!got && meta.sourceName) got = await NR.sources.restoreFromBin(meta.sourceName);
    } catch (e) { got = null; }
    if (got) {
      renderSources();
      toast('已重新导入「' + (got.name || meta.sourceName || '书源') + '」');
      gs.source = meta;
      gs.blacklist = await NR.sources.blacklist().catch(function () { return []; });
      gsRender();
      return true;
    }
    toast('回收站里没有这个源，去「我的 → Yckceo仓库」重新拉一份吧');
    gsClose();
    return false;
  }

  async function showSourceInfo(meta) {
    if (!meta) return;
    gs.source = meta;
    gs.blacklist = await NR.sources.blacklist().catch(function () { return []; });
    gs.mode = 'source';
    var box = gsEnsure();
    box.hidden = false;
    gsRender();
  }

  function gsRenderSource(body) {
    var meta = gs.source || {};
    var src = meta.sourceId ? NR.sources.get(meta.sourceId) : null;
    var inList = !!src;
    var bad = inList && src.lastFail && src.lastFail > (src.lastOk || 0);
    var bl = gs.blacklist || [];
    var blacklisted = NR.sources.blacklistHas(meta.sourceName, src && src.url, bl);

    var status = !inList
      ? '<span class="gs__bad">这个书源已经不在书源列表里了</span>'
      : (bad ? '<span class="gs__bad">已标记失效' + (src.lastError ? '：' + esc(src.lastError) : '') + '</span>'
        : (src.lastOk ? '<span class="gs__ok">可用</span>'
          : '<span class="gs__dim">还没筛过</span>'));

    body.innerHTML =
      '<div class="gs__row"><button class="gs__back" type="button" data-gs-close2>关闭</button>' +
      '<h3 class="gs__sub">当前书源</h3></div>' +
      '<div class="gs__src">' +
      '<p class="gs__src-name">' + esc(meta.sourceName || '（没有记录书源）') + '</p>' +
      '<p class="gs__src-line">状态：' + status + '</p>' +
      (src ? '<p class="gs__src-line">地址：' + esc(src.url || '') + '</p>' +
        '<p class="gs__src-line">能力：' + esc(capabilitySummary(src)) + '</p>' +
        '<button class="btn btn--tiny" type="button" data-src-capability>能力矩阵 / 详情</button>' : '') +
      '<p class="gs__src-line">书目页：' + esc(meta.bookUrl || '') + '</p>' +
      (inList && src.group ? '<p class="gs__src-line">分组：' + esc(src.group) + '</p>' : '') +
      (blacklisted ? '<p class="gs__src-line gs__hint--warn">它在失效黑名单里，重新导入会被跳过</p>' : '') +
      '</div>' +
      '<div class="gs__src-btns">' +
      (inList
        ? '<button class="btn btn--primary" type="button" data-src-act="switch">换一个书源</button>' +
          '<button class="btn" type="button" data-src-act="drawer">打开书源抽屉</button>'
        : '<button class="btn btn--primary" type="button" data-src-act="import">导入书源</button>' +
          (blacklisted ? '<button class="btn" type="button" data-src-act="unblack">从黑名单移除</button>' : '') +
          '<button class="btn" type="button" data-src-act="drawer">打开书源抽屉</button>') +
      '</div>' +
      '<p class="gs__status" id="gsStatus"></p>';

    each(body.querySelectorAll('[data-gs-close2]'), function (b) { b.onclick = gsClose; });
    each(body.querySelectorAll('[data-src-capability]'), function (b) { b.onclick = function () { showCapabilities(src); }; });
    each(body.querySelectorAll('[data-src-act]'), function (b) {
      b.onclick = async function () {
        var act = b.dataset.srcAct;
        if (act === 'switch') { gsClose(); if (NR.pickSource) NR.pickSource(); return; }
        if (act === 'drawer') { gsClose(); openSources(); return; }
        if (act === 'import') { await restoreCurrentSource(meta); return; }
        if (act === 'unblack') {
          var n = await NR.sources.blacklistRemove(meta.sourceName);
          gs.blacklist = await NR.sources.blacklist().catch(function () { return []; });
          gsRender();
          toast(n ? '已从黑名单移除' : '它不在黑名单里');
        }
      };
    });
  }

  /* ---------------- 归入组：选源后弹分组列表小窗（复用 gs 弹层结构） ----------------
     结构抄 gsOverlay：mask + panel + head + body。点某个分组 → 所选书源归入该组。 */
  function blEl() { return document.getElementById('blOverlay'); }

  function blClose() {
    var box = blEl();
    if (box) box.hidden = true;
  }

  /** 归入组小窗：列出所有现有分组，点一个 → 所选书源归入该组 */
  /* ---------------- 归入分组：小窗（书源页勾选后调起） ---------------- */
  function assignClose() {
    var box = document.getElementById('assignOverlay');
    if (box) box.hidden = true;
  }

  async function assignTo(ids, name) {
    try {
      var n = await NR.sources.setGroupOf(ids, name);
      await refreshGroupNames();
      renderSources();
      renderGroupManage();
      renderHub();
      assignClose();
      toast(name ? ('已把 ' + n + ' 个书源归入「' + name + '」') : ('已把 ' + n + ' 个书源移出所有分组'));
    } catch (e) { toast('归组失败：' + (e.message || e)); }
  }

  function openAssignGroupOverlay() {
    var ids = selectedIds();
    if (!ids.length) { toast('先在列表里勾选要归组的书源'); return; }
    var names = (state.groupNames || []).slice();
    NR.sources.groups().forEach(function (g) { if (names.indexOf(g.name) < 0) names.push(g.name); });

    var box = document.getElementById('assignOverlay');
    if (!box) {
      box = document.createElement('div');
      box.className = 'gs';
      box.id = 'assignOverlay';
      box.hidden = true;
      box.innerHTML =
        '<div class="gs__mask"></div>' +
        '<div class="gs__panel gs__panel--sm" role="dialog" aria-label="归入分组">' +
        '<header class="gs__head"><span class="gs__title">归入分组</span>' +
        '<button class="btn btn--icon" type="button" data-assign-close title="关闭">' +
        '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>' +
        '</button></header>' +
        '<div class="gs__body" id="assignBody"></div>' +
        '</div>';
      document.body.appendChild(box);
      box.querySelector('.gs__mask').onclick = assignClose;
      box.querySelector('[data-assign-close]').onclick = assignClose;
    }
    var body = box.querySelector('#assignBody');
    var listHtml = names.length
      ? '<div class="gs__list">' + names.map(function (n) {
        var g = (NR.sources.groups() || []).filter(function (x) { return x.name === n; })[0];
        return '<button class="gs__item gs__item--pick" data-assign-group="' + esc(n) + '" type="button">' +
          '<div class="gs__item-main"><p class="gs__item-name">' + esc(n) + '</p>' +
          (g ? '<p class="gs__item-meta">' + g.total + ' 个书源</p>' : '') + '</div>' +
          '<span class="gs__item-meta">归入</span></button>';
      }).join('') + '</div>'
      : '<p class="gs__status">还没有分组，直接在下面输入一个名字新建。</p>';

    body.innerHTML = '<p class="gs__hint">已勾选 ' + ids.length + ' 个书源，点一个分组归进去：</p>' +
      listHtml +
      '<div style="display:flex;gap:8px;margin:12px 0 4px">' +
      '<input class="modal__input" id="assignNewName" type="text" placeholder="新建分组名" spellcheck="false" style="flex:1;min-width:0">' +
      '<button class="btn btn--lamp" id="assignNewBtn" type="button">新建并归入</button></div>' +
      '<div style="display:flex;gap:8px;margin-top:6px">' +
      '<button class="btn btn--ghost" id="assignNone" type="button">移出所有分组</button></div>';

    each(body.querySelectorAll('[data-assign-group]'), function (b) {
      b.onclick = function () { assignTo(ids, b.dataset.assignGroup); };
    });
    var noneBtn = body.querySelector('#assignNone');
    if (noneBtn) noneBtn.onclick = function () { assignTo(ids, ''); };
    var newInput = body.querySelector('#assignNewName');
    var newBtn = body.querySelector('#assignNewBtn');
    var doNew = async function () {
      var name = String((newInput && newInput.value) || '').trim();
      if (!name) { toast('先输入分组名'); return; }
      await NR.sources.addGroup(name);
      await assignTo(ids, name);
    };
    if (newBtn) newBtn.onclick = doNew;
    if (newInput) newInput.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); doNew(); } };
    box.hidden = false;
  }

  /* ---------------- 查看黑名单：小窗 + 搜索 + 单条清除 + 一键清除 ---------------- */
  var blFilter = '';

  async function openBlacklistOverlay() {
    var box = document.getElementById('blOverlay');
    if (!box) {
      box = document.createElement('div');
      box.className = 'gs';
      box.id = 'blOverlay';
      box.hidden = true;
      box.innerHTML =
        '<div class="gs__mask"></div>' +
        '<div class="gs__panel gs__panel--sm" role="dialog" aria-label="黑名单">' +
        '<header class="gs__head"><span class="gs__title">黑名单</span>' +
        '<button class="btn btn--icon" type="button" data-bl-close title="关闭">' +
        '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>' +
        '</button></header>' +
        '<div class="gs__body" id="blBody"></div>' +
        '</div>';
      document.body.appendChild(box);
      box.querySelector('.gs__mask').onclick = blClose;
      box.querySelector('[data-bl-close]').onclick = blClose;
    }
    box.hidden = false;
    await blRender();
  }

  async function blRender() {
    var body = document.getElementById('blBody');
    if (!body) return;
    var bl = await NR.sources.blacklist().catch(function () { return []; });
    var q = (blFilter || '').toLowerCase();
    var shown = bl.filter(function (it) {
      if (!q) return true;
      var hay = ((it && (it.name || it.bookSourceName || '')) + ' ' +
        ((it && (it.url || it.bookSourceUrl || '')) || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    body.innerHTML =
      '<div class="bl-search"><input id="blSearch" type="search" placeholder="搜黑名单记录" ' +
      'autocomplete="off" spellcheck="false" value="' + esc(blFilter || '') + '"></div>' +
      (bl.length
        ? '<div class="gs__list" id="blList">' + (shown.length ? shown.map(function (it) {
          var name = it.name || it.bookSourceName || '（未记录名字）';
          var url = it.url || it.bookSourceUrl || '';
          return '<div class="gs__item">' +
            '<div class="gs__item-main">' +
            '<p class="gs__item-name">' + esc(name) + '</p>' +
            (url ? '<p class="gs__item-meta">' + esc(url) + '</p>' : '') +
            '</div>' +
            '<button class="btn btn--tiny btn--danger" type="button" data-bl-one="' + esc(name) + '">清除</button>' +
            '</div>';
        }).join('') : '<p class="gs__status">没有匹配「' + esc(blFilter) + '」的记录。</p>') + '</div>'
        : '<p class="gs__status">黑名单是空的。</p>') +
      '<div class="bl-foot">' +
      '<button class="btn btn--danger bl-clear" id="blClearAll" type="button"' + (bl.length ? '' : ' disabled') + '>一键清除全部</button>' +
      '</div>';
    var search = body.querySelector('#blSearch');
    if (search) {
      var timer = 0;
      search.oninput = function () {
        var v = String(search.value || '').trim();
        clearTimeout(timer);
        timer = setTimeout(function () { blFilter = v; blRender(); }, 150);
      };
    }
    each(body.querySelectorAll('[data-bl-one]'), function (b) {
      b.onclick = async function () {
        var n = await NR.sources.blacklistRemove(b.dataset.blOne);
        toast(n ? '已从黑名单移除' : '它不在黑名单里');
        blRender();
      };
    });
    var clearAll = body.querySelector('#blClearAll');
    if (clearAll) {
      clearAll.onclick = function () {
        if (!bl.length) return;
        NR.ui.confirm('清除黑名单里的 ' + bl.length + ' 个书源记录？\n\n清除后，之后导入这些源时不会再被自动跳过。', async function () {
          await NR.sources.blacklistClear();
          toast('已清空黑名单（' + bl.length + ' 条）');
          blRender();
        }, '清除');
      };
    }
  }

  /* ------------------------------------------------------------ 导出（选中源 → Legado 兼容 JSON） */
  /** 把内部源对象反向重建为 Legado 书源 JSON（保留全部规则字段，别的阅读器可直接导入） */
  function sourceToLegado(s) {
    var o = {
      bookSourceName: s.name || '',
      bookSourceUrl: s.url || '',
      bookSourceGroup: s.group || '',
      bookSourceComment: s.comment || '',
      enabled: s.enabled !== false,
      bookSourceType: Number(s.srcType || 0),
      header: s.headers || '',
      enabledCookieJar: s.enabledCookieJar !== false
    };
    if (s.charset) o.bookSourceCharset = s.charset;
    if (s.jsLib) o.jsLib = s.jsLib;
    if (s.searchUrl) o.searchUrl = s.searchUrl;
    if (s.exploreUrl) o.exploreUrl = s.exploreUrl;
    // 规则块只在非空时导出：空 {} 会让其它阅读器导入出坏源
    function nonEmptyRule(r) { return r && typeof r === 'object' && Object.keys(r).length > 0; }
    if (nonEmptyRule(s.ruleSearch)) o.ruleSearch = s.ruleSearch;
    if (nonEmptyRule(s.ruleBookInfo)) o.ruleBookInfo = s.ruleBookInfo;
    if (nonEmptyRule(s.ruleToc)) o.ruleToc = s.ruleToc;
    if (nonEmptyRule(s.ruleContent)) o.ruleContent = s.ruleContent;
    return o;
  }

  async function exportSelectedSources() {
    var ids = selectedIds();
    if (!ids.length) { toast('先勾选要导出的书源'); return; }
    var list = [];
    ids.forEach(function (id) {
      var s = NR.sources.get(id);
      if (s) list.push(sourceToLegado(s));
    });
    if (!list.length) { toast('选中的源都不存在了'); return; }
    var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    var text = JSON.stringify(list, null, 2);
    try {
      var r = await NR.platform.saveText('iread书源-' + stamp + '.json', text);
      if (r && r.canceled) return;
      toast('已导出 ' + list.length + ' 个书源');
    } catch (e) {
      // 桥失败降级浏览器下载（platform.saveText 自带，这里兜 download）
      try {
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'iread书源-' + stamp + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        toast('已导出 ' + list.length + ' 个书源（浏览器下载）');
      } catch (e2) { toast('导出失败：' + (e2.message || e2)); }
    }
  }

  /* ------------------------------------------------------------ 导入 */
  async function importFromFiles() {
    var pf = NR.platform;
    if (!pf || !pf.pickSources) { toast('这个环境不支持导入文件'); return; }
    var files;
    try { files = await pf.pickSources(); }
    catch (e) { toast('打开文件失败：' + (e.message || e)); return; }
    if (!files || !files.length) return;
    await importTexts(files);
  }

  async function importTexts(files) {
    var added = 0, updated = 0, errs = [], warnings = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].error) { errs.push(files[i].name + '：' + files[i].error); continue; }
      try {
        var r = await NR.sources.importText(files[i].text);
        added += r.added; updated += r.updated;
        if (r.errors && r.errors.length) errs.push(r.errors.join('，'));
        if (Array.isArray(r.warnings)) warnings = warnings.concat(r.warnings);
      } catch (e) {
        errs.push(files[i].name + '：' + (e.message || e));
      }
    }
    renderSources();
    if (!NR.sources.list().length) renderIdle();
    toast('书源：新增 ' + added + ' 个' + (updated ? '，更新 ' + updated + ' 个' : '') +
      (errs.length ? '；' + errs.join('；') : ''));
    showImportWarnings(warnings);
  }

  async function importLinks(text, autoOpen) {
    if (autoOpen) await openSources();
    loading(true, '正在导入书源…');
    try {
      var r = await NR.sources.importFromLinks(text);
      loading(false);
      renderSources();
      if (!NR.sources.list().length) renderIdle();
      var msg = '书源：新增 ' + r.added + ' 个' + (r.updated ? '，更新 ' + r.updated + ' 个' : '');
      if (r.failed.length) msg += '；' + r.failed.length + ' 个链接失败';
      if (r.notes.length) msg += '；' + r.notes[0];
      toast(msg);
      showImportWarnings(r.warnings);
    } catch (e) {
      loading(false);
      toast('导入失败：' + (e.message || e));
    }
  }

  /** 网络导入：贴一个地址（yuedu:// / JSON / 网页 / 仓库链接）→ 抓回来导入 */
  async function netImport() {
    if (!NR.ui || !NR.ui.prompt) { toast('弹层不可用'); return; }
    NR.ui.prompt('网络导入', '', async function (url) {
      if (!url) return;
      if (!/^(https?:\/\/|yuedu:\/\/)/i.test(url)) { toast('地址要以 http(s):// 或 yuedu:// 开头'); return; }
      loading(true, '正在下载书源…');
      try {
        var text = url;
        if (/^https?:\/\//i.test(url)) {
          var r = await NR.platform.fetchText({ url: url, timeout: 30000 });
          if (!r || !r.text) throw new Error('下载失败');
          text = r.text;
        }
        var t = String(text || '').trim();
        // 内容是网页 → 从页面里抽链接；否则按 JSON / 分享链接导入
        if (/^</.test(t) && !/yuedu:\/\//i.test(t) && !/^\s*[\[{]/.test(t)) {
          await importLinks(t);
        } else if (/^\s*[\[{]/.test(t)) {
          await importTexts([{ name: '网络导入', text: t }]);
        } else {
          await importLinks(t);
        }
      } catch (e) {
        loading(false);
        toast('网络导入失败：' + (e.message || e));
      }
    }, '导入', 'https://… 或 yuedu://…');
  }

  /* ---------------- 书源管理：入口列表 + 三个子页 ---------------- */
  var srcPage = 'hub';
  function srcNav(name) {
    srcPage = name || 'hub';
    each(document.querySelectorAll('[data-srcpane]'), function (s) {
      if (s.dataset.srcpane === srcPage) s.removeAttribute('hidden');
      else s.setAttribute('hidden', '');
    });
    if (srcPage === 'hub') renderHub();
    if (srcPage === 'sources') renderSources();
    if (srcPage === 'groups') renderGroupManage();
    var panel = el('sourcePanel');
    if (panel) panel.scrollTop = 0;
  }
  /** 子页返回：还在子页就回入口列表（返回 true，app.js 不再关整页） */
  function srcBack() {
    if (srcPage && srcPage !== 'hub') { srcNav('hub'); return true; }
    return false;
  }
  if (global.NR) { global.NR.sourcePaneBack = srcBack; global.NR.sourcePaneNav = srcNav; }

  function renderHub() {
    var all = NR.sources.list();
    var ok = 0, bad = 0;
    all.forEach(function (s) { if (okSource(s)) ok++; else if (badSource(s)) bad++; });
    if (el('srcHubSources')) {
      el('srcHubSources').textContent = all.length
        ? (all.length + ' 个 · 可用 ' + ok + ' · 失效 ' + bad)
        : '还没有书源，先导入一个';
    }
    if (el('srcHubGroups')) {
      var list = (NR.sources.groups && NR.sources.groups()) || [];
      el('srcHubGroups').textContent = list.length ? (list.length + ' 个组') : '还没有分组';
    }
  }

  function renderGroupManage() {
    var box = el('groupManage');
    if (!box) return;
    var stats = (NR.sources.groups && NR.sources.groups()) || [];
    // 兜底：某些源只带 group 字符串没被统计到时，也把名字列出来
    NR.sources.list().forEach(function (s) {
      String(s.group || '').split(',').forEach(function (x) {
        var n = x.trim();
        if (n && !stats.some(function (g) { return g.name === n; })) stats.push({ name: n, total: 0, enabled: 0 });
      });
    });
    var names = (state.groupNames || []).slice();
    stats.forEach(function (g) { if (names.indexOf(g.name) < 0) names.push(g.name); });
    var byName = Object.create(null);
    stats.forEach(function (g) { byName[g.name] = g; });

    var selBtn = el('btnGroupSelect');
    if (selBtn) {
      selBtn.textContent = state.groupPick ? '取消选择' : '选择';
      selBtn.classList.toggle('is-on', !!state.groupPick);
    }
    var batch = ['btnGroupSelAll', 'btnGroupSelDel'];
    batch.forEach(function (id) {
      var b = el(id);
      if (b) b.hidden = !state.groupPick;
    });

    if (!names.length) {
      box.innerHTML = '<p class="src-empty">还没有分组。导入书源后，可以在下面「新建分组」。</p>';
      return;
    }
    box.innerHTML = names.map(function (n) {
      var g = byName[n] || { total: 0, enabled: 0 };
      var picked = !!state.groupSel[n];
      return '<button class="src-group-row' +
        (!state.groupPick && state.group === n ? ' on' : '') +
        (picked ? ' sel' : '') + '" data-group="' + esc(n) + '" type="button">' +
        (state.groupPick ? '<span class="src-group-row__check' + (picked ? ' on' : '') + '"></span>' : '') +
        '<span class="src-group-row__name">' + esc(n) + '</span>' +
        '<span class="src-group-row__meta">' + g.total + ' 个 · 启用 ' + g.enabled + '</span></button>';
    }).join('');
    each(box.querySelectorAll('[data-group]'), function (b) {
      b.onclick = function () {
        var name = b.dataset.group;
        if (state.groupPick) {
          if (state.groupSel[name]) delete state.groupSel[name];
          else state.groupSel[name] = true;
          renderGroupManage();
          return;
        }
        state.group = name;
        srcNav('sources');
        renderSources();
      };
    });
  }

  /** 分组发生增删改后：名字表、分组页、入口列表一起刷新（否则删了还挂在页面上） */
  async function refreshGroupViews() {
    await refreshGroupNames();
    renderGroupManage();
    renderHub();
  }

  async function openSources(page) {
    if (!NR.sources.list().length) await NR.sources.init();
    await refreshGroupNames();
    renderSources();
    // 书源抽屉已并入「我的 → 书源管理」子页，进去先是入口列表
    if (global.NR.openSourcePane) global.NR.openSourcePane();
    else openDrawer('source');
    srcNav(page || 'hub');
  }

  function sourcesVisible() {
    return !!(global.NR.sourcePaneOpen && global.NR.sourcePaneOpen());
  }

  function openDrawer(name) {
    var d = el(name + 'Drawer');
    if (!d) return;
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
  }

  /* ------------------------------------------------------------ 对外 */
  var api = {
    enter: function () {
      if (state.mode === 'idle' || (state.mode === 'results' && !state.books.length && !state.searching)) {
        ensureFeed();
        ensureHotrank();
        renderIdle();
      } else if (state.mode === 'detail' && state.detail) {
        renderDetail();
        if (!state.detail.catalog && !state.detail.error && !operations.detail) loadDetailFor(state.detail.srcIndex);
      } else {
        renderResults();
      }
      if (!state.searching && state.query) searchSummary(state.cancel);
      var input = el('searchInput');
      if (input && !input.value && state.query) input.value = state.query;
      var epoch = lifecycle;
      if (input) setTimeout(function () { if (epoch === lifecycle) input.focus(); }, 60);
    },
    leave: leave,
    back: back,
    search: doSearch,
    openSources: openSources,
    setReturnView: function (view) { state.returnView = view || 'online'; },
    openDetail: openDetail,
    addToShelf: addToShelf,
    readNow: readNow,
    importLinks: importLinks,
    findSourcesFor: findSourcesFor,
    deepTest: deepTest,
    openScreenLogs: openScreenLogs,
    /* 「获取书源」已做成插件「Yckceo仓库」，这里只转发，保留老调用点可用 */
    getSources: function () {
      if (global.NR.yckceo && global.NR.yckceo.open) return global.NR.yckceo.open('scatter');
      toast('插件「Yckceo仓库」还没加载');
    },
    refreshSources: function () { return renderSources(); },
    showSourceInfo: showSourceInfo,
    autoPurge: autoPurge,
    purgeInvalid: purgeInvalid,
    selectAll: selectAllVisible,
    invertSelection: invertVisible,
    deleteSelected: deleteSelected,
    tested: function () { return state.tested; },
    selected: function () { return state.selected; },
    rankItems: rankItems,
    books: function () { return state.books; },
    state: function () { return state; }
  };

  /* ------------------------------------------------------------ 绑定 */
  /** 分组按钮区三行重排（不改 index.html，纯 JS 调整现有 footer）：
      第一行 启用组/停用组/删组；第二行 新建组/编辑组/归入组；
      顺带删掉「筛本组」按钮、把「清除黑名单」文案改成「查看黑名单」。 */
  function relayoutSourceFoot() {
    return;   // 新结构（入口列表 + 子页）已经把按钮放好了，不再用 JS 重排旧页脚
    // eslint-disable-next-line no-unreachable
    var grpRow = document.querySelector('.src-foot__row--groups');
    if (!grpRow) return;
    var scanGroup = el('btnScanGroup');
    if (scanGroup && scanGroup.parentNode) scanGroup.parentNode.removeChild(scanGroup);   // 「筛本组」删掉：筛选就是点分组 chip 本身
    var bl = el('btnBlackClear');
    if (bl) bl.textContent = '查看黑名单';
    // 「筛选日志」小文字按钮：放在快筛/慢筛同一行末尾（不改 index.html）
    var slowB = el('btnScanSlow');
    if (slowB && slowB.parentNode && !el('btnScreenLogs')) {
      var logB = document.createElement('button');
      logB.className = 'src-loglink';
      logB.id = 'btnScreenLogs';
      logB.type = 'button';
      logB.title = '打开筛选日志目录（每轮筛选一个文件）';
      logB.textContent = '筛选日志';
      slowB.parentNode.insertBefore(logB, slowB.nextSibling);
    }
    if (grpRow.dataset.relaid) return;
    grpRow.dataset.relaid = '1';
    var order = ['btnGroupOn', 'btnGroupOff', 'btnGroupDel'];
    var order2 = ['btnGroupAdd', 'btnGroupRename', 'btnGroupAssign'];
    order.forEach(function (id) { var b = el(id); if (b) grpRow.appendChild(b); });        // 第一行：启用组 / 停用组 / 删除组
    var row2 = document.createElement('div');
    row2.className = 'src-foot__row src-foot__row--groups2';
    order2.forEach(function (id) { var b = el(id); if (b) row2.appendChild(b); });         // 第二行：新建组 / 编辑组 / 归入组
    grpRow.parentNode.insertBefore(row2, grpRow.nextSibling);
  }

  function bind() {
    var form = el('searchForm');
    if (!form) return;
    form.onsubmit = function (e) {
      e.preventDefault();
      doSearch(el('searchInput').value);
    };
    var srcBtn = el('btnSources');
    if (srcBtn) srcBtn.onclick = openSources;
    bindVerdict();
    relayoutSourceFoot();
    each(document.querySelectorAll('[data-srcgo]'), function (b) {
      b.onclick = function () { srcNav(b.dataset.srcgo); };
    });

    var importBtn = el('btnSourceImport');
    if (importBtn) importBtn.onclick = importFromFiles;
    var netBtn = el('btnSourceNet');
    if (netBtn) netBtn.onclick = netImport;
    var expBtn = el('btnSourceExport');
    if (expBtn) expBtn.onclick = exportSelectedSources;   // P：导出选中源（Legado 兼容 JSON）
    var blBtn = el('btnBlackClear');
    if (blBtn) blBtn.onclick = openBlacklistOverlay;   // 「查看黑名单」小窗
    var fastBtn = el('btnScanFast');
    if (fastBtn) fastBtn.onclick = function () { startScan('fast'); };
    var slowBtn = el('btnScanSlow');
    if (slowBtn) slowBtn.onclick = function () { startScan('slow'); };
    var scopeBox = el('scanScope');
    if (scopeBox) each(scopeBox.querySelectorAll('[data-scope]'), function (b) {
      b.onclick = function () {
        state.scanScope = b.dataset.scope;
        if (state.scanScope !== 'group') state.scanGroup = '';
        paintScope();
      };
    });
    paintScope();
    var logsBtn = el('btnScreenLogs');
    if (logsBtn) logsBtn.onclick = openScreenLogs;
    var gAdd = el('btnGroupAdd');
    if (gAdd) gAdd.onclick = function () {
      NR.ui.prompt('新增分组', '', async function (name) {
        if (!name) return;
        await NR.sources.addGroup(name);
        state.group = name;
        await refreshGroupViews();
        renderSources();
        toast('已新增分组「' + name + '」');
      }, '新建', '比如：小说、漫画、备用');
    };
    var gRen = el('btnGroupRename');
    if (gRen) gRen.onclick = function () {
      if (!state.group) { toast('先选中一个分组'); return; }
      var from = state.group;
      var cur = NR.sources.list().find(function (s) {
        return String(s.group || '').split(/,/).indexOf(from) >= 0;
      });
      var curW = cur && cur.searchWeight ? String(cur.searchWeight) : '';
      NR.ui.prompt('编辑组「' + from + '」：改名（可选搜索优先权重 1-9）', from, async function (name) {
        if (!name || name === from) return;
        var n = await NR.sources.renameGroup(from, name);
        state.group = name;
        await refreshGroupViews();
        renderSources();
        toast('已重命名（' + n + ' 个书源）');
      }, '改名', '分组名');
      // 在改名 prompt 的输入框后面补一个可选的权重输入（复用 modalList）
      setTimeout(function () {
        var list = document.getElementById('modalList');
        if (!list || list.hidden) return;
        var w = document.createElement('input');
        w.id = 'modalWeight';
        w.className = 'modal__input';
        w.type = 'number';
        w.min = '1'; w.max = '9';
        w.placeholder = '搜索优先权重 1-9（可选）';
        w.value = curW;
        w.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); el('modalOk').click(); } };
        list.appendChild(w);
        var ok = document.getElementById('modalOk');
        if (ok) {
          var prev = ok.onclick;
          ok.onclick = function () {
            var v = parseInt(document.getElementById('modalWeight') &&
              document.getElementById('modalWeight').value, 10);
            if (v >= 1 && v <= 9) {
              NR.sources.list().forEach(function (s) {
                if (String(s.group || '').split(/,/).indexOf(from) >= 0) {
                  s.searchWeight = v;      // 权重先只存到源对象上（数据层在另一个任务里）
                }
              });
              toast('已设置搜索权重 ' + v);
            }
            if (prev) prev();
          };
        }
      }, 50);
    };
    var gDel = el('btnGroupDel');
    if (gDel) gDel.onclick = function () {
      if (!state.group) { toast('先选中一个分组'); return; }
      var name = state.group;
      NR.ui.confirm('删除分组「' + name + '」？\n\n组里的书源不会被删除，只是归到「未分组」。', async function () {
        var n = await NR.sources.deleteGroup(name);
        state.group = '';
        await refreshGroupViews();
        renderSources();
        toast('已删除分组（' + n + ' 个书源归到未分组）');
      }, '删除分组');
    };
    var gOn = el('btnGroupOn');
    if (gOn) gOn.onclick = async function () {
      if (!state.group) { toast('先在上面的分组里选一个'); return; }
      var n = await NR.sources.setGroupEnabled(state.group, true);
      renderSources();
      toast('已启用「' + state.group + '」' + n + ' 个书源');
    };
    var gOff = el('btnGroupOff');
    if (gOff) gOff.onclick = async function () {
      if (!state.group) { toast('先在上面的分组里选一个'); return; }
      var n = await NR.sources.setGroupEnabled(state.group, false);
      renderSources();
      toast('已停用「' + state.group + '」' + n + ' 个书源');
    };
    var gAssign = el('btnGroupAssign');
    if (gAssign) gAssign.onclick = openAssignGroupOverlay;   // 弹分组列表小窗，点一个归进去
    var srcAssign = el('btnSourceAssign');
    if (srcAssign) srcAssign.onclick = openAssignGroupOverlay;   // 书源页：把勾选的源归入某个分组

    var gPick = el('btnGroupSelect');
    if (gPick) gPick.onclick = function () {
      state.groupPick = !state.groupPick;
      if (!state.groupPick) state.groupSel = {};
      renderGroupManage();
    };
    var gSelAll = el('btnGroupSelAll');
    if (gSelAll) gSelAll.onclick = function () {
      var names = (state.groupNames || []).slice();
      (NR.sources.groups() || []).forEach(function (g) { if (names.indexOf(g.name) < 0) names.push(g.name); });
      var all = names.every(function (n) { return !!state.groupSel[n]; });
      state.groupSel = {};
      if (!all) names.forEach(function (n) { state.groupSel[n] = true; });
      renderGroupManage();
    };
    var gSelDel = el('btnGroupSelDel');
    if (gSelDel) gSelDel.onclick = function () {
      var names = Object.keys(state.groupSel || {});
      if (!names.length) { toast('先勾选要删除的分组'); return; }
      NR.ui.confirm('删除 ' + names.length + ' 个分组？\n\n' + names.join('、') +
        '\n\n组里的书源不会被删除，只是不再属于这些组。', async function () {
        var total = 0;
        for (var i = 0; i < names.length; i++) total += await NR.sources.deleteGroup(names[i]);
        state.groupSel = {};
        state.groupPick = false;
        if (names.indexOf(state.group) >= 0) state.group = '';
        await refreshGroupViews();
        renderSources();
        toast('已删除 ' + names.length + ' 个分组（' + total + ' 个书源改了归属）');
      }, '删除 ' + names.length + ' 个分组');
    };
    var search = el('srcSearch');
    if (search) {
      var debounce = 0;
      search.oninput = function () {
        var v = String(search.value || '').trim();
        clearTimeout(debounce);
        debounce = setTimeout(function () {
          state.q = v;
          renderSources();
        }, 180);                       // 输入防抖：一边打字一边重绘会卡
      };
    }
    var allBtn = el('btnSourceAll');
    if (allBtn) allBtn.onclick = selectAllVisible;
    var purgeBtn = el('btnSourcePurge');
    if (purgeBtn) purgeBtn.onclick = purgeInvalid;
    var invertBtn = el('btnSourceInvert');
    if (invertBtn) invertBtn.onclick = invertVisible;
    var delBtn = el('btnSourceDelete');
    if (delBtn) delBtn.onclick = deleteSelected;

    /* r1-t5：先把「未搜到」chip 注进筛选栏，再统一绑点击（否则注入的 chip 没有 onclick） */
    ensureNoResultChip();
    each(document.querySelectorAll('#sourceFilter .chip'), function (b) {
      b.onclick = function () {
        state.filter = b.dataset.filter || 'all';
        renderSources();
      };
    });

    if (NR.platform && NR.platform.onYueduLink) {
      NR.platform.onYueduLink(function (link) {
        if (!link) return;
        toast('收到书源链接，正在导入…');
        importLinks(link, true);
      });
    }
  }

  NR.online = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bind();
      NR.sources.init().catch(function () { });
    });
  } else {
    bind();
    NR.sources.init().catch(function () { });
  }
})(window);
