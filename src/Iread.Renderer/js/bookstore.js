/* =========================================================================
 * bookstore.js — 按启用书源与发现分类浏览；只读、单源、单分类、第一页。
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR || (global.NR = {});
  var el = function (id) { return document.getElementById(id); };
  var operations = { current: null };
  var lifecycle = 0;
  var active = false;
  var frame = null;
  var sources = [];
  var categories = [];
  var selection = { sourceId: '', url: '' };
  var explicitPick = false;   // 用户亲手点过某个源才展开它的分类（用户要求：不点具体源的时候不显示）
  var filters = { source: '', category: '' };
  var categoryCache = {};

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function each(list, fn) { Array.prototype.forEach.call(list || [], function (item, i) { fn(item, i); }); }
  function sourceById(id) { return NR.sources.get(id); }
  function sourceName(id) {
    var source = sourceById(id);
    return source && (source.name || source.bookSourceName) || id || '未知书源';
  }
  function categoryTitle(url) {
    for (var i = 0; i < categories.length; i++) if (categories[i].url === url) return categories[i].title;
    return url || '未选择分类';
  }
  function openSources() {
    if (NR.online && NR.online.openSources) return NR.online.openSources();
  }
  function isCancelled(error) {
    return !!(error && (error.cancelled || error.code === 'CANCELLED' ||
      error.code === 'RULE_CANCELLED' || error.name === 'AbortError'));
  }

  function cancelFrame() {
    if (frame === null) return;
    if (global.cancelAnimationFrame) global.cancelAnimationFrame(frame);
    frame = null;
  }
  function cancelCurrent() {
    lifecycle++;
    cancelFrame();
    var operation = operations.current;
    operations.current = null;
    if (operation) operation.controller.abort();
  }
  function owns(operation) {
    var current = operations.current;
    if (!(active && current === operation && current.id === operation.id && lifecycle === operation.id)) return false;
    if (operation.keyword) {
      // 搜索操作没有分类 url（selection.url 保持原值），只按源 + 关键词判归属
      return current.sourceId === operation.sourceId && current.keyword === operation.keyword &&
        selection.sourceId === operation.sourceId && !operation.controller.signal.aborted;
    }
    return !!(current.sourceId === operation.sourceId && current.url === operation.url &&
      selection.sourceId === operation.sourceId && selection.url === operation.url &&
      !operation.controller.signal.aborted);
  }

  function renderBar(text) {
    var bar = el('bookstoreBar');
    if (!bar) return;
    bar.hidden = !text;
    bar.innerHTML = text ? '<span class="obar__text">' + esc(text) + '</span>' : '';
  }
  /** 左栏每个源都要可见可解释：停用、无推荐页分别是两种真实状态 */
  function sourceState(source) {
    if (!source) return '';
    if (source.enabled === false) return '已停用';
    if (!source.exploreUrl) return '无推荐页';
    return '';
  }
  /** 每源分类数（纯本地解析 exploreUrl，不走网络）；解析不出来就是 0 类 */
  function categoriesOf(id) {
    if (!Object.prototype.hasOwnProperty.call(categoryCache, id)) {
      var list = [];
      try { list = NR.sources.exploreCategories(id) || []; } catch (error) { list = []; }
      categoryCache[id] = Array.isArray(list) ? list : [];
    }
    return categoryCache[id];
  }
  /**
   * 分类区的静态节点永远留在左栏里并保持隐藏：它是无障碍与测试查询的锚点。
   * 真正可见的分类列表渲染在展开行的 `.bsrc__panel` 里（行 HTML 会整体重建，
   * 把静态节点搬进去会被重建连带清掉，所以用「同一份数据两处渲染」）。
   */
  function keepCategories() {
    var box = el('bookstoreCategories');
    var host = el('bookstoreRail') || document.body;
    if (!box || !host) return null;
    if (box.parentNode !== host) host.appendChild(box);
    box.hidden = true;
    return box;
  }
  function renderSources() {
    var box = el('bookstoreSources');
    if (!box) return;
    keepCategories();
    var query = filters.source;
    box.innerHTML = sources.map(function (source) {
      var id = source.id;
      var selected = id === selection.sourceId;
      var expanded = selected && explicitPick;
      var name = source.name || source.bookSourceName || id;
      var count = categoriesOf(id).length;
      var state = sourceState(source);
      // 选中的源永远可见：否则一输入筛选就把展开的源藏起来
      var visible = selected || !query || String(name).toLowerCase().indexOf(query) >= 0;
      var cls = 'bsrc__row' + (selected ? ' on' : '') +
        (source.enabled === false ? ' is-off' : '') + (source.exploreUrl ? '' : ' is-plain');
      var row = '<button class="' + cls + '" data-source="' + esc(id) + '" data-count="' + count + '"' +
        (state ? ' data-state="' + esc(state) + '"' : '') + (visible ? '' : ' hidden') +
        ' type="button"' + (source.enabled === false ? ' disabled' : '') + '>' +
        '<i class="bsrc__mark" aria-hidden="true"></i>' +
        '<span class="bsrc__name">' + esc(name) + '</span>' +
        (state ? '<span class="bsrc__flag">' + esc(state) + '</span>' : '') +
        '</button>';
      if (!expanded) return row;
      return row + '<div class="bsrc__panel" data-panel="' + esc(id) + '">' +
        '<div class="bsrc__cats" data-cat-list="' + esc(id) + '"></div>' +
        '</div>';
    }).join('');
    each(box.querySelectorAll('[data-source]'), function (row) {
      row.onclick = function () {
        if (!active || row.disabled) return;
        if (row.dataset.source === selection.sourceId) {
          // 再点一次同一个源＝取消选中，分类随之收起（用户要求：点击切换选中状态）
          if (explicitPick) {
            explicitPick = false;
            selection = { sourceId: '', url: '' };
            renderCategories();
          } else {
            explicitPick = true;
          }
          renderSources();
          return;
        }
        explicitPick = true;
        selectSource(row.dataset.source, '');
      };
    });
    renderCategories();
  }
  /** 分类列表同一份数据渲染两处：隐藏的静态锚点 + 展开行里的可见副本 */
  function categoryMarkup() {
    var query = filters.category;
    return categories.filter(function (category) {
      return !query || String(category.title || '').toLowerCase().indexOf(query) >= 0;
    }).map(function (category) {
      return '<button class="bsrc__cat' + (category.url === selection.url ? ' on' : '') +
        '" data-category="' + esc(category.url) + '" type="button">' +
        esc(category.title || category.url) + '</button>';
    }).join('');
  }
  function renderCategories() {
    var markup = categoryMarkup();
    var targets = [];
    var anchor = keepCategories();
    if (anchor) targets.push(anchor);
    each(document.querySelectorAll('[data-cat-list]'), function (copy) { targets.push(copy); });
    targets.forEach(function (target) {
      target.innerHTML = markup;
      each(target.querySelectorAll('[data-category]'), function (button) {
        button.onclick = function () {
          if (!active || button.dataset.category === selection.url) return;
          load(selection.sourceId, button.dataset.category);
        };
      });
    });
  }
  /** 顶部「搜索书源」只绑定一次：输入框是静态节点，重渲染的是列表 */
  function bindSourceFilter() {
    var input = el('bookstoreSourceFilter');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.oninput = function () {
      filters.source = String(input.value || '').trim().toLowerCase();
      renderSources();
    };
  }

  function renderNoSources(enabled) {
    categories = [];
    selection = { sourceId: '', url: '' };
    renderSources();
    renderCategories();
    renderBar('');
    var body = el('bookstoreBody');
    if (!body) return;
    var reason = enabled.length
      ? enabled.length + ' 个启用书源未配置发现地址，因此无法按分类浏览。'
      : '还没有启用的书源，请先导入或启用带发现地址的书源。';
    body.innerHTML = '<div class="oempty">' +
      '<span class="oempty__mark" aria-hidden="true"></span>' +
      '<p class="oempty__title">没有可浏览的书源</p>' +
      '<p class="oitem__intro">' + esc(reason) + '</p>' +
      '<button class="btn btn--primary" id="btnBookstoreEmptySources" type="button">管理书源</button></div>';
    var button = el('btnBookstoreEmptySources');
    if (button) button.onclick = openSources;
  }

  function renderError(error, retry) {
    cancelFrame();
    renderBar('');
    var body = el('bookstoreBody');
    if (!body) return;
    var code = error && error.code ? '[' + error.code + '] ' : '';
    var message = error && error.message ? error.message : String(error || '未知错误');
    body.innerHTML = '<div class="oempty">' +
      '<span class="oempty__mark" aria-hidden="true"></span>' +
      '<p class="oempty__title">加载失败</p>' +
      '<p class="oitem__intro">' + esc(code + message) + '</p>' +
      '<button class="btn btn--primary" id="btnBookstoreRetry" type="button">重试</button></div>';
    var button = el('btnBookstoreRetry');
    if (button) button.onclick = retry;
  }

  function coverMarkup(book, operation, index) {
    var cls = 'obook__cover';
    var empty = '<span class="' + cls + ' ' + cls + '--none"' +
      (book.bookUrl ? ' data-book-url="' + esc(book.bookUrl) + '"' : '') + '></span>';
    if (!book.coverUrl) return empty;
    if (!NR.cover) return '';
    var key = operation.sourceId + '|' + (book.bookUrl || index);
    return NR.cover.markup(book.coverUrl, cls, key, book.bookUrl) || empty;
  }
  /** 右栏抬头：只留分类名（+ 更淡的「共 N 本」），不再显示源名与顺序说明 */
  function bodyHead(operation, total) {
    return '<header class="bhead">' +
      '<h2 class="bhead__title">' + esc(categoryTitle(operation.url)) + '</h2>' +
      (total ? '<p class="bhead__note">共 ' + total + ' 本</p>' : '') +
      '</header>';
  }
  function renderBooks(operation, books) {
    if (!owns(operation)) return;
    // 抬头由 bodyHead 表达（分类名 + 共 N 本），状态条不再重复同一句话
    renderBar('');
    renderList(operation, books, function (total) { return bodyHead(operation, total); }, '这个分类暂时没有书籍');
  }
  /** 卡片网格：抬头由调用方给（分类浏览与「在当前书源里搜」共用同一套书卡） */
  function renderList(operation, books, head, emptyText) {
    var body = el('bookstoreBody');
    if (!body) return;
    if (!books.length) {
      body.innerHTML = head(0) + '<div class="oempty oempty--soft">' +
        '<span class="oempty__mark" aria-hidden="true"></span>' +
        '<p class="oempty__title">' + esc(emptyText) + '</p></div>';
      return;
    }
    var html = head(books.length) + '<div class="olist">';
    books.forEach(function (book, index) {
      html += '<article class="obook" data-i="' + index + '" tabindex="0">' +
        coverMarkup(book, operation, index) +
        '<div class="obook__main"><h3 class="obook__title">' + esc(book.title || '未命名') + '</h3>' +
        '<p class="obook__meta"><span>' + esc(book.author || '佚名') + '</span>' +
        (book.lastChapter ? '<i class="oitem__dot"></i><span class="oitem__src">' + esc(book.lastChapter) + '</span>' : '') +
        '</p>' + (book.intro ? '<p class="oitem__intro">' + esc(String(book.intro).slice(0, 80)) + '</p>' : '') +
        '</div></article>';
    });
    body.innerHTML = html + '</div>';
    if (NR.cover) NR.cover.fill(body);
    if (NR.coverAuto) NR.coverAuto.fill(body);
    each(body.querySelectorAll('.obook'), function (node) {
      var open = function () { return openBook(books[+node.dataset.i], operation.sourceId); };
      node.onclick = open;
      node.onkeydown = function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      };
    });
  }
  function scheduleBooks(operation, books) {
    cancelFrame();
    frame = global.requestAnimationFrame(function () {
      frame = null;
      if (owns(operation)) renderBooks(operation, books);
    });
  }

  function load(sourceId, url) {
    cancelCurrent();
    selection.sourceId = sourceId;
    selection.url = url;
    renderSources();
    renderCategories();
    var operation = {
      id: lifecycle,
      controller: new AbortController(),
      sourceId: sourceId,
      url: url
    };
    operations.current = operation;
    renderBar('');                              // 抬头已含源名/分类名，状态条只在出错时才写字
    var body = el('bookstoreBody');
    if (body) {
      body.innerHTML = bodyHead(operation, 0) +
        '<div class="oempty oempty--soft"><p class="oempty__title">正在加载…</p></div>';
    }
    var settings = NR.getSettings ? NR.getSettings() : {};
    var timeout = settings.searchTimeout || 15000;
    return Promise.resolve().then(function () {
      if (!owns(operation)) return [];
      return NR.sources.explore(sourceId, url, {
        signal: operation.controller.signal,
        deadline: Date.now() + timeout
      });
    }).then(function (books) {
      if (!owns(operation)) return books;
      books = Array.isArray(books) ? books : [];
      scheduleBooks(operation, books);
      return books;
    }, function (error) {
      if (!owns(operation) || isCancelled(error)) return [];
      renderError(error, function () {
        if (active && selection.sourceId === sourceId && selection.url === url) load(sourceId, url);
      });
      return [];
    });
  }

  /* ---------- 右栏顶部搜索：只在当前书源里搜（不跨源，用户明确选的） ---------- */
  function searchHead(operation, total) {
    return '<header class="bhead">' +
      '<h2 class="bhead__title">搜索：' + esc(operation.keyword || '') + '</h2>' +
      '<p class="bhead__note">只在这个书源里搜' + (total ? ' · 共 ' + total + ' 本' : '') + '</p>' +
      '</header>';
  }
  function search(sourceId, keyword) {
    keyword = String(keyword || '').trim();
    if (!sourceId || !keyword) return Promise.resolve([]);
    cancelCurrent();
    selection.sourceId = sourceId;
    var operation = {
      id: lifecycle,
      controller: new AbortController(),
      sourceId: sourceId,
      url: '',
      keyword: keyword
    };
    operations.current = operation;
    renderSources();
    renderBar('');
    var body = el('bookstoreBody');
    if (body) {
      body.innerHTML = searchHead(operation, 0) +
        '<div class="oempty oempty--soft"><p class="oempty__title">正在搜索…</p></div>';
    }
    var settings = NR.getSettings ? NR.getSettings() : {};
    var timeout = settings.searchTimeout || 15000;
    return Promise.resolve().then(function () {
      if (!owns(operation)) return [];
      return NR.sources.search(keyword, {
        sources: [sourceId],                    // search() 的 opts.sources 就是「限定书源」
        signal: operation.controller.signal,
        timeout: timeout
      });
    }).then(function (books) {
      if (!owns(operation)) return books;
      var list = Array.isArray(books) ? books.slice() : [];
      renderList(operation, list, function (total) { return searchHead(operation, total); }, '这个书源里没有搜到');
      return list;
    }, function (error) {
      if (!owns(operation) || isCancelled(error)) return [];
      renderError(error, function () {
        if (active && selection.sourceId === sourceId) search(sourceId, keyword);
      });
      return [];
    });
  }
  /** 清空搜索框 / 按 Esc：回到当前书源的分类浏览 */
  function clearSearch() {
    var sourceId = selection.sourceId;
    if (!sourceId) return Promise.resolve([]);
    if (selection.url) return load(sourceId, selection.url);
    return selectSource(sourceId, '');
  }
  function bindSearch() {
    var input = el('bookstoreSearch');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.onkeydown = function (event) {
      var keyword = String(input.value || '').trim();
      if (event.key === 'Escape') { input.value = ''; clearSearch(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!selection.sourceId) return;
      if (!keyword) { clearSearch(); return; }
      search(selection.sourceId, keyword);
    };
    input.oninput = function () {
      if (String(input.value || '').trim()) return;
      if (operations.current && operations.current.keyword) clearSearch();
    };
  }

  function selectSource(sourceId, preferredUrl) {
    var selected = sourceById(sourceId);
    if (selected && selected.enabled === false) return Promise.resolve([]);  // 停用源直接返回，不联网
    cancelCurrent();
    selection.sourceId = sourceId;
    selection.url = '';
    categories = [];
    renderSources();
    renderCategories();
    try {
      categories = NR.sources.exploreCategories(sourceId) || [];
    } catch (error) {
      renderError(error, function () {
        if (active && selection.sourceId === sourceId) selectSource(sourceId, preferredUrl || '');
      });
      return Promise.resolve([]);
    }
    if (!categories.length) {
      renderBar('');
      var body = el('bookstoreBody');
      if (body) {
        body.innerHTML = '<div class="oempty oempty--soft">' +
          '<span class="oempty__mark" aria-hidden="true"></span>' +
          '<p class="oempty__title">此源没有可浏览的分类</p></div>';
      }
      return Promise.resolve([]);
    }
    var url = categories[0].url;
    if (preferredUrl) {
      for (var i = 0; i < categories.length; i++) {
        if (categories[i].url === preferredUrl) { url = preferredUrl; break; }
      }
    }
    renderCategories();
    return load(sourceId, url);
  }

  function enter() {
    active = true;
    explicitPick = false;
    cancelCurrent();
    categoryCache = {};                        // 书源可能被导入/停用/换规则，分类数每次进视图重算
    bindSourceFilter();
    bindSearch();
    var all = NR.sources.list();
    var enabled = NR.sources.enabled();
    var candidates = enabled.filter(function (source) { return !!source.exploreUrl; });
    sources = all.slice();                     // 左栏列全部源（含停用与无推荐页）
    renderSources();
    if (!candidates.length) {
      renderNoSources(enabled);
      return Promise.resolve([]);
    }
    var source = candidates[0];
    var preferredUrl = '';
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].id === selection.sourceId) {
        source = candidates[i];
        preferredUrl = selection.url;
        break;
      }
    }
    return selectSource(source.id, preferredUrl);
  }

  function leave() {
    active = false;
    cancelCurrent();
  }

  /** returnView：'online' 表示从发现页热门打开，返回时回到发现页（可传字符串或 { returnView }） */
  function openBook(book, sourceId, returnView) {
    if (!book) return null;
    var id = sourceId || book.sourceId || selection.sourceId;
    var source = sourceById(id) || { id: id, name: book.sourceName || id };
    var sourceName = source.name || source.bookSourceName || book.sourceName || id;
    var detail = {
      key: id + '|' + (book.bookUrl || book.title || ''),
      title: book.title,
      author: book.author || '',
      intro: book.intro || '',
      coverUrl: book.coverUrl || '',
      lastChapter: book.lastChapter || '',
      sources: [{ sourceId: id, sourceName: sourceName, bookUrl: book.bookUrl }]
        .concat(book.alsoOn || []),
      rank: 0
    };
    var backView = returnView && typeof returnView === 'object' ? returnView.returnView : returnView;
    NR.online.setReturnView(backView === 'online' ? 'online' : 'bookstore');
    NR.switchView('online');
    return NR.online.openDetail(detail);
  }

  NR.bookstore = {
    enter: enter,
    leave: leave,
    openBook: openBook
  };
})(window);
