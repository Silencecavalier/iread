/* =========================================================================
 * app.js — iread · 主逻辑
 * ========================================================================= */
(function (global) {
  'use strict';

  var S = global.NR.store, P = global.NR.parser;
  var dataTools = global.NR.dataTools;
  var el = function (id) { return document.getElementById(id); };

  /* 版本号：插件 api.app.version() 读这个 */
  global.__ireadVersion = global.__ireadVersion || '1.0.0-plugin.1';

  /* 转发事件给插件（plugins.js 不在时静默跳过） */
  function pluginEmit(name, payload) {
    try { if (global.NR.plugins && typeof global.NR.plugins.emit === 'function') global.NR.plugins.emit(name, payload); } catch (e) { /* 插件出错不影响主流程 */ }
  }

  // online.js 在 DOMContentLoaded 中提前调用 sources.init；不让它读取未就绪的存储。
  var resolveStorage, rejectStorage;
  var storageInitialized = new Promise(function (resolve, reject) { resolveStorage = resolve; rejectStorage = reject; });
  storageInitialized.catch(function () { });
  if (global.NR.sources && global.NR.sources.init) {
    var initializeSources = global.NR.sources.init;
    global.NR.sources.init = function () {
      var self = this, args = arguments;
      return storageInitialized.then(function () {
        if (!storageWritable()) throw new Error('存储已暂停，请先重试');
        return initializeSources.apply(self, args);
      });
    };
  }
  function storageWritable() { return booted && S.status().writable && !dataTools.isPaused(); }
  function pausedStorage() { dataTools.updateStatus(); toast('存储尚未就绪或已暂停，请先处理存储提示'); }

  var CFG = 'nr_settings', IDX = 'nr_index', LAST = 'nr_last';
  var FONTS = {
    serif: '"Georgia","Songti SC","SimSun","Source Han Serif SC","Noto Serif CJK SC",serif',
    sans: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",sans-serif',
    kai: '"Kaiti SC","KaiTi","STKaiti","楷体",serif',
    hei2: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif'
  };
  // 手机上默认给更舒服的排版：字号大一点、行距松一点、左右留白小一点，左右点按翻章也默认打开
  var MOBILE_UI = (typeof matchMedia === 'function') && matchMedia('(max-width: 760px)').matches;
  var DEFAULTS = {
    fontSize: MOBILE_UI ? 19 : 18, charsPerLine: 32, lineHeight: MOBILE_UI ? 200 : 190, paraGap: MOBILE_UI ? 90 : 100,
    font: MOBILE_UI ? 'hei2' : 'serif', theme: 0, dim: 0, brightness: 0, mode: 'scroll',
    indent: 2, letter: 0.02, weight: 400, pad: MOBILE_UI ? 18 : 36, pageAnim: 'fade',
    sortBy: 'recent', showCover: true, libraryLayout: 'single', trayOnClose: false,
    searchTimeout: 5000, searchConcurrency: 12, resultLimit: 100, autoPurge: true,
    autoHideBar: false, tapTurn: MOBILE_UI, startAtLogin: false,   // autoHideBar: 兼容老配置残留键，功能已删
    continuous: false, autoResume: MOBILE_UI, keepAwake: false, motion: true,
    autoScroll: false, autoScrollSpeed: 1,
    videoSharpen: true, adSkip: true
  };

  var DISCLAIMER_TEXT = [
    '免责声明',
    '',
    '1. iread 不自带书籍、不运营内容分发服务；导入或获取的正文与缓存保存在本机，并包含在完整备份中。',
    '2. 在线书源由第三方提供，与本软件无关；书源抓取什么内容由书源作者决定。',
    '3. 通过书源获取的内容版权归原作者或发布方所有，请支持正版。',
    '4. 使用本软件及第三方书源产生的任何后果由使用者自行承担。',
    '5. 程序不主动向开发者上传书架与配置；第三方书源及其脚本仍可通过网络发送相关信息，请只使用可信书源。',
    '6. 请遵守你所在地区的法律法规，仅将本软件用于个人学习与测试。'
  ].join('\n');

  var settings = Object.assign({}, DEFAULTS);
  var index = [];          // 书架元数据
  var cur = null;          // 当前书 { meta, chapters }
  var view = 'online';     // online | bookstore | shelf | mine | read（默认落在发现页）
  var readerReturnView = 'online';
  var pageState = { pages: 1, page: 0, colW: 0, gap: 30 };
  var wakeLock = null;
  var saveTimer = null;
  var lastProgValue = null, lastProgScrollTop = -1;   // 进度抖动防护（见 computeProgress）
  var pendingPlace = null;                            // { ci, ratio } 等正文到位后再定位
  var readingTask = null;

  function stopReading() {
    if (readingTask) readingTask.controller.abort();
    readingTask = null;
    remoteBusy = Object.create(null);
    clearTimeout(saveTimer);
  }
  function beginReading(id) {
    stopReading();
    readingTask = { id: id, controller: new AbortController() };
    return readingTask;
  }
  function activeReading(task) { return readingTask === task && !task.controller.signal.aborted; }

  /* ---------------- 界面主题（整窗配色，见 theme.js） ---------------- */
  function renderUiThemes() {
    var box = el('uiThemeChips');
    if (!box || !global.NR.theme) return;
    var cur = global.NR.theme.current();
    box.innerHTML = global.NR.theme.list().map(function (t) {
      return '<button class="swatch' + (t.id === cur ? ' on' : '') + '" data-ui="' + t.id + '" type="button" ' +
        'title="' + t.name + '"><i style="background:' + t.bg + ';box-shadow:inset 0 0 0 1px ' + t.fg + '33"></i>' +
        '<span>' + t.name + '</span></button>';
    }).join('');
    each(box.children, function (b) {
      b.onclick = function () {
        global.NR.theme.save(b.dataset.ui);
        renderUiThemes();
        applySettings();
        syncWindowColor();
      };
    });
  }


  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function fmtTime(ts) {
    if (!ts) return '未读';
    var d = new Date(ts), n = new Date(), diff = n - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    var sameDay = d.toDateString() === n.toDateString();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (sameDay) return '今天 ' + hm;
    if (diff < 86400000 * 2) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function fmtSize(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万字';
    return n + ' 字';
  }
  function hueOf(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function coverBg(name) {
    var h = hueOf(name);
    return 'linear-gradient(150deg,hsl(' + h + ',30%,34%),hsl(' + ((h + 45) % 360) + ',27%,19%))';
  }
  var toastTimer = null;
  function toast(msg) {
    var t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }
  function loading(on, text) {
    el('loading').classList.toggle('show', !!on);
    if (text) el('loadingText').textContent = text;
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }

  /* ---------------- 设置 ---------------- */
  /* 无边框窗口：右上角按钮区底色跟随当前视图 / 阅读配色 */
  function syncWindowColor() {
    var pf = global.NR.platform;
    if (!pf || !pf.syncChrome) return;
    var ink1 = '';
    try {
      ink1 = getComputedStyle(document.documentElement).getPropertyValue('--ink-1').trim();
    } catch (e) { ink1 = ''; }
    var read = global.NR.theme ? global.NR.theme.readColors(global.NR.theme.current()) : null;
    pf.syncChrome(view === 'read' ? ((read && read.bg) || '#12141a') : (ink1 || '#14171e'));
  }

  function applySettings() {
    var r = document.documentElement.style;
    r.setProperty('--r-font', settings.fontSize + 'px');
    r.setProperty('--r-line', settings.lineHeight / 100);
    r.setProperty('--r-para', settings.paraGap / 100 + 'em');
    r.setProperty('--r-width', settings.charsPerLine + 'em');
    r.setProperty('--r-family', FONTS[settings.font] || FONTS.serif);
    r.setProperty('--r-indent', (settings.indent == null ? 2 : settings.indent) + 'em');
    r.setProperty('--r-letter', (settings.letter == null ? 0.02 : settings.letter) + 'em');
    r.setProperty('--r-weight', settings.weight || 400);
    r.setProperty('--r-pad', (settings.pad == null ? 36 : settings.pad) + 'px');
    document.body.classList.toggle('anim-none', settings.pageAnim === 'none');
    document.body.classList.toggle('anim-slide', settings.pageAnim === 'slide');
    // 阅读区配色跟界面主题同步
    var th = (global.NR.theme && global.NR.theme.readColors(global.NR.theme.current()))
      || { bg: '#12141a', fg: '#c3c9d4' };
    r.setProperty('--r-bg', th.bg);
    r.setProperty('--r-fg', th.fg);
    r.setProperty('--r-glow2', 'rgba(120,120,140,.06)');
    // 亮度：0 = 原亮度，越大越暗（只在阅读界面生效）
    var b = Math.max(0, Math.min(70, settings.brightness || 0));
    r.setProperty('--dim', (b / 100).toFixed(3));
    if (el('vBright')) el('vBright').textContent = b;
    if (el('sBright')) el('sBright').value = b;
    // 面板同步
    el('vFont').textContent = settings.fontSize;
    el('vWidth').textContent = settings.charsPerLine;
    el('vLine').textContent = (settings.lineHeight / 100).toFixed(2);
    el('vPara').textContent = (settings.paraGap / 100).toFixed(2);
    el('sFont').value = settings.fontSize;
    el('sWidth').value = settings.charsPerLine;
    el('sLine').value = settings.lineHeight;
    el('sPara').value = settings.paraGap;
    el('sContinuous').checked = settings.continuous;
    el('sAutoResume').checked = settings.autoResume;
    el('sKeepAwake').checked = settings.keepAwake;
    if (el('sMotion')) el('sMotion').checked = settings.motion !== false;
    if (el('sTapTurn')) el('sTapTurn').checked = !!settings.tapTurn;
    if (el('sVideoSharpen')) el('sVideoSharpen').checked = settings.videoSharpen !== false;
    if (el('sAdSkip')) el('sAdSkip').checked = settings.adSkip !== false;
    if (el('sShowCover')) el('sShowCover').checked = settings.showCover !== false;
    syncChips('layoutChips', 'layout', settings.libraryLayout || 'single');
    if (el('sTray')) el('sTray').checked = !!settings.trayOnClose;
    if (el('sAutoPurge')) el('sAutoPurge').checked = settings.autoPurge !== false;
    if (el('sStartLogin')) el('sStartLogin').checked = !!settings.startAtLogin;
    if (el('sPad')) el('sPad').value = settings.pad == null ? 36 : settings.pad;
    if (el('vPad')) el('vPad').textContent = settings.pad == null ? 36 : settings.pad;
    syncChips('indentChips', 'indent', settings.indent == null ? 2 : settings.indent);
    syncChips('letterChips', 'letter', settings.letter == null ? 0.02 : settings.letter);
    syncChips('weightChips', 'weight', settings.weight || 400);
    syncChips('animChips', 'anim', settings.pageAnim || 'fade');
    syncChips('sortChips', 'sort', settings.sortBy || 'recent');
    syncChips('timeoutChips', 'timeout', settings.searchTimeout || 5000);
    syncChips('concChips', 'conc', settings.searchConcurrency || 12);
    syncChips('limitChips', 'limit', settings.resultLimit == null ? 100 : settings.resultLimit);
    // 动效开关：不跟随系统 prefers-reduced-motion（很多机器关了系统动画，
    // 但用户要的是这个 App 有过渡效果），改由这里显式控制
    document.documentElement.classList.toggle('no-motion', settings.motion === false);
    each(el('fontChips').children, function (b) {
      b.classList.toggle('on', b.dataset.font === settings.font);
    });
    each(el('modeChips').children, function (b) {
      b.classList.toggle('on', b.dataset.mode === settings.mode);
    });
    if (view === 'read') setTimeout(relayout, 30);
    paintRanges();
    syncWindowColor();
    var rst = el('rsThemes');
    if (rst && rst.children.length && global.NR.theme) {
      var curUi = global.NR.theme.current();
      each(rst.children, function (x) { x.classList.toggle('on', x.dataset.ui === curUi); });
    }
  }
  /* 滑杆的已选部分用一条暖光填充（--p 由这里算） */
  function paintRange(r) {
    var min = +r.min || 0, max = +r.max || 100;
    var p = max > min ? ((+r.value - min) / (max - min)) * 100 : 0;
    r.style.setProperty('--p', Math.max(0, Math.min(100, p)).toFixed(2) + '%');
  }
  function paintRanges() { each(document.querySelectorAll('input[type=range]'), paintRange); }
  function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }

  /** 把某一组 chip 按 data-* 值点亮 */
  function syncChips(boxId, dataKey, value) {
    var box = el(boxId);
    if (!box) return;
    each(box.children, function (b) {
      b.classList.toggle('on', String(b.dataset[dataKey]) === String(value));
    });
  }

  /** 绑定一组 chip：点哪个就把值写进 settings */
  function bindChipGroup(boxId, dataKey, apply) {
    var box = el(boxId);
    if (!box) return;
    each(box.children, function (b) {
      b.onclick = function () {
        apply(b.dataset[dataKey]);
        syncChips(boxId, dataKey, b.dataset[dataKey]);
      };
    });
  }
  var saveSettings = debounce(function () { if (storageWritable()) S.set(CFG, settings); }, 300);

  /* ---------------- 动效辅助 ---------------- */
  /* 视图切换只淡入：阅读页的顶栏/底栏是 fixed，父级带 transform 会跟着抖 */
  function fadeView(node) {
    if (!node) return;
    node.classList.remove('view-in');
    void node.offsetWidth;          // 强制回流，让动画能重新播放
    node.classList.add('view-in');
    setTimeout(function () { node.classList.remove('view-in'); }, 260);
  }
  /* 重新触发一次性的 CSS 动画类 */
  function replayAnim(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(function () { node.classList.remove(cls); }, 320);
  }

  /* ---------------- 书架 ---------------- */
  function saveIndex() { return S.set(IDX, index); }

  function sortedIndex() {
    var list = index.slice();
    var by = settings.sortBy || 'recent';
    if (by === 'title') {
      return list.sort(function (a, b) {
        return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
      });
    }
    if (by === 'added') {
      return list.sort(function (a, b) {
        return (b.addedAt || 0) - (a.addedAt || 0);
      });
    }
    return list.sort(function (a, b) {
      var ta = a.lastReadAt || a.addedAt || 0, tb = b.lastReadAt || b.addedAt || 0;
      return tb - ta;
    });
  }

  function renderShelf() {
    var grid = el('shelfGrid'), empty = el('emptyState');
    var list = sortedIndex();
    var layout = settings.libraryLayout || 'single';
    grid.classList.toggle('shelf--double', layout === 'double');
    grid.classList.toggle('shelf--grid', layout === 'grid');
    el('shelfHead').hidden = list.length === 0;
    el('shelfCount').textContent = list.length ? list.length + ' 本' : '';
    empty.hidden = list.length > 0 || dataTools.isPaused();
    empty.classList.toggle('hidden', empty.hidden);
    grid.innerHTML = '';
    list.forEach(function (b, bi) {
      var pct = Math.round(progressOf(b) * 100);
      var meta = b.progress
        ? '读到 ' + chapterName(b)
        : (b.remote ? (b.sourceName ? b.sourceName + '，共 ' + b.chapterCount + ' 章'
          : '共 ' + b.chapterCount + ' 章') : fmtSize(b.totalChars));
      var d = document.createElement('article');
      d.className = 'row';
      d.tabIndex = 0;
      d.setAttribute('role', 'button');
      d.style.setProperty('--i', Math.min(bi, 14));   // 逐条入场，最多错开 14 条
      var gridMode = (settings.libraryLayout || 'single') === 'grid';
      var cover = (settings.showCover !== false && global.NR.cover)
        ? (b.coverData || b.coverUrl
          ? global.NR.cover.markup(b.coverData || b.coverUrl, 'row__cover', b.id)
          : ((b.remote || gridMode) ? '<span class="row__cover row__cover--none" data-key="' + b.id + '"></span>' : ''))
        : '';
      d.innerHTML =
        '<span class="row__spine"><i style="height:' + (b.progress && pct > 0 ? Math.max(pct, 6) : 0) + '%"></i></span>' +
        cover +
        '<div class="row__main">' +
        '<h3 class="row__title">' + esc(b.title) + shelfTypeBadge(b) + '</h3>' +
        '<p class="row__meta">' + esc(meta) + '</p>' +
        '</div>' +
        '<span class="row__pct' + (b.progress ? '' : ' is-unread') + '">' + (b.progress ? pct + '%' : '未读') + '</span>' +
        '<button class="row__del" title="删除" aria-label="删除">' +
        '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>' +
        '</button>';
      d.querySelector('.row__del').onclick = function (e) {
        e.stopPropagation();
        if (confirm('确定从书架删除《' + b.title + '》？\n进度也会一并清除。')) removeBook(b.id).catch(deleteFailed);
      };
      d.onclick = function () { openBook(b.id); };
      d.oncontextmenu = function (e) {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, b);
      };
      d.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(b.id); }
      };
      grid.appendChild(d);
    });
    fillShelfCovers(list);
    renderContinue();
  }

  /** 书架封面：有地址直接取，没地址问详情页要一次；取到后原地换图，不整页重绘 */
  var coverSaveTimer = 0;
  var coverJobs = [];
  var coverWorking = false;
  var coverTries = Object.create(null);
  var coverQueued = Object.create(null);

  function saveIndexSoon() {
    clearTimeout(coverSaveTimer);
    coverSaveTimer = setTimeout(function () { saveIndex(); }, 800);
  }

  function fillShelfCovers(list) {
    if (!global.NR.cover) return;
    var grid = el('shelfGrid');
    global.NR.cover.fill(grid);
    var queued = 0;
    list.forEach(function (b) {
      if (b.coverData) return;
      if (!b.remote) return;
      if (!b.bookUrl || !b.sourceId) return;
      var tries = coverTries[b.id] || 0;
      if (!b.coverUrl && tries >= 2) return;          // 一个书最多问两次详情
      if (queued >= 16) return;                        // 一次最多 16 个，剩下的下次
      if (coverQueued[b.id]) return;                   // 已经在队列里，别重复排队
      queued++;
      if (!b.coverUrl) coverTries[b.id] = tries + 1;
      coverQueued[b.id] = 1;
      coverJobs.push(b);
    });
    pumpCoverJobs();
  }

  async function pumpCoverJobs() {
    if (coverWorking || !coverJobs.length) return;
    coverWorking = true;
    try {
      while (coverJobs.length) {
        var b = coverJobs.shift();
        delete coverQueued[b.id];
        try {
          var url = b.coverUrl;
          if (!url && global.NR.sources && b.sourceId && global.NR.sources.get(b.sourceId)) {
            var info = await global.NR.sources.detail(b.sourceId, b.bookUrl).catch(function () { return null; });
            url = info && info.coverUrl;
            if (url) { b.coverUrl = url; saveIndexSoon(); }
          }
          if (!url) { paintCoverEmpty(b); continue; }
          var data = await global.NR.cover.get(url, b.bookUrl);
          if (!data) { paintCoverEmpty(b); continue; }
          b.coverData = data;
          saveIndexSoon();
          paintCover(b);
        } catch (e) { /* 单个失败不影响其它 */ }
        await new Promise(function (r) { setTimeout(r, 30); });
      }
    } finally {
      coverWorking = false;
    }
  }

  function paintCover(b) {
    var grid = el('shelfGrid');
    if (!grid) return;
    var img = grid.querySelector('img.row__cover[data-key="' + b.id + '"]');
    if (img) { img.src = b.coverData; img.hidden = false; return; }
    var cell = grid.querySelector('.row__cover--none[data-key="' + b.id + '"]');
    if (cell && b.coverData) {
      var im = document.createElement('img');
      im.className = 'row__cover';
      im.src = b.coverData;
      im.alt = '';
      cell.parentNode.replaceChild(im, cell);
    }
  }

  /** 取不到图时退回占位块，别留一个透明空位 */
  function paintCoverEmpty(b) {
    var grid = el('shelfGrid');
    if (!grid) return;
    var img = grid.querySelector('img.row__cover[data-key="' + b.id + '"]');
    if (img && !img.src) {
      var cell = document.createElement('span');
      cell.className = 'row__cover row__cover--none';
      cell.dataset.key = b.id;
      img.parentNode.replaceChild(cell, img);
    }
  }

  /* ---------------- 右键菜单 ---------------- */
  var ctxBook = null;
  function showCtxMenu(x, y, book) {
    var m = el('ctxMenu');
    if (!m) return;
    ctxBook = book;
    m.innerHTML =
      '<button type="button" data-ctx="detail">进入详情页</button>' +
      '<button type="button" data-ctx="read">' + (book.progress ? '继续阅读' : '开始阅读') + '</button>' +
      (book.remote ? '<button type="button" data-ctx="src">查看书源</button>' : '') +
      '<button type="button" class="danger" data-ctx="del">从书架删除</button>';
    m.hidden = false;
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    each(m.querySelectorAll('[data-ctx]'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        hideCtxMenu();
        var act = b.dataset.ctx;
        if (act === 'detail') openBookDetail(book.id);
        else if (act === 'read') openBook(book.id);
        else if (act === 'src') {
          if (global.NR.online && global.NR.online.showSourceInfo) {
            openBook(book.id);
            setTimeout(function () {
              if (cur && cur.meta) global.NR.online.showSourceInfo(cur.meta);
            }, 900);
          }
        } else if (act === 'del') {
          if (confirm('确定从书架删除《' + book.title + '》？\n进度也会一并清除。')) removeBook(book.id).catch(deleteFailed);
        }
      };
    });
  }
  function hideCtxMenu() {
    var m = el('ctxMenu');
    if (m) m.hidden = true;
    ctxBook = null;
  }

  /* ---------------- 书架详情页 ---------------- */
  function openBookDetail(id) {
    var meta = index.filter(function (x) { return x.id === id; })[0];
    if (!meta) { toast('找不到这本书'); return; }
    loading(true, '正在打开…');
    S.get('nr_book_' + id).then(function (data) {
      loading(false);
      /* 视频书（插件带进来的剧集）没有 chapters，直接进播放器，不进详情页 */
      if (data && data.video) { openVideoBook(meta, data); return; }
      if (!data || !data.chapters) { toast('书籍数据已丢失，请重新导入'); return; }
      renderBookDetail(meta, data.chapters);
    }).catch(function (e) {
      loading(false);
      toast('打开失败：' + (e.message || e));
    });
  }

  function renderBookDetail(meta, chapters) {
    var cover = global.NR.cover
      ? (meta.coverData || meta.coverUrl
        ? global.NR.cover.markup(meta.coverData || meta.coverUrl, 'bookd__cover', meta.id)
        : '<span class="bookd__cover bookd__cover--none"></span>')
      : '';
    var pct = Math.round(progressOf(meta) * 100);
    var metaLine = [];
    if (meta.author) metaLine.push(esc(meta.author));
    metaLine.push(esc(meta.remote ? ('在线 · ' + (meta.sourceName || '未知来源')) : '本地' + (meta.format ? ' · ' + meta.format.toUpperCase() : '')));
    metaLine.push(chapters.length + ' 章');
    if (!meta.remote) metaLine.push(esc(fmtSize(meta.totalChars || 0)));
    if (meta.progress) metaLine.push('已读 ' + pct + '%');

    var h = '<div class="bookd__bar" style="padding:0;background:none;position:static">' +
      '<button class="btn btn--ghost bookd__back" id="btnBookdBack2" type="button">← 返回书架</button></div>' +
      '<div class="bookd__top">' + cover +
      '<div class="bookd__head">' +
      '<h1 class="bookd__title">' + esc(meta.title) + shelfTypeBadge(meta) + '</h1>' +
      '<p class="bookd__meta">' + metaLine.join('<i></i>') + '</p>' +
      '<div class="bookd__actions">' +
      '<button class="btn btn--primary" id="bdRead" type="button">' +
      (meta.progress ? '继续阅读' : '开始阅读') + '</button>' +
      (meta.remote ? '<button class="btn" id="bdSrc" type="button">查看书源</button>' +
        '<button class="btn" id="bdSwitch" type="button">换源</button>' : '') +
      '<button class="btn btn--danger" id="bdDel" type="button">删除</button>' +
      '</div></div></div>' +
      (meta.intro ? '<p class="bookd__intro">' + esc(meta.intro) + '</p>' : '');

    h += '<div class="bookd__toc"><p class="bookd__tochead"><span>目录</span><span>共 ' + chapters.length + ' 章</span></p><ul class="bookd__toclist">';
    chapters.forEach(function (c, i) {
      var curCi = meta.progress ? meta.progress.ci : -1;
      h += '<li' + (i === curCi ? ' class="is-current"' : '') + '><button type="button" data-ci="' + i + '">' +
        esc(c.t || ('第 ' + (i + 1) + ' 章')) + '</button></li>';
    });
    h += '</ul></div>';

    el('bookdBody').innerHTML = h;
    el('bookDetail').hidden = false;
    el('bookDetail').classList.remove('hidden');   /* .hidden 是 !important 的 display:none，只清属性面板还是看不见 */
    if (global.NR.plugins && global.NR.plugins.refresh) { try { global.NR.plugins.refresh(); } catch (e) { } }
    el('bookDetail').scrollTop = 0;

    if (el('btnBookdBack2')) el('btnBookdBack2').onclick = closeBookDetail;
    if (el('bdRead')) el('bdRead').onclick = function () { closeBookDetail(); openBook(meta.id); };
    if (el('bdSrc')) el('bdSrc').onclick = function () {
      closeBookDetail(); openBook(meta.id);
      setTimeout(function () { if (global.NR.online) global.NR.online.showSourceInfo(meta); }, 900);
    };
    if (el('bdSwitch')) el('bdSwitch').onclick = function () {
      closeBookDetail(); openBook(meta.id);
      setTimeout(pickSource, 1200);
    };
    if (el('bdDel')) el('bdDel').onclick = function () {
      if (!confirm('确定从书架删除《' + meta.title + '》？')) return;
      removeBook(meta.id).then(closeBookDetail).catch(deleteFailed);
    };
    each(el('bookdBody').querySelectorAll('[data-ci]'), function (b) {
      b.onclick = function () {
        var ci = +b.dataset.ci;
        closeBookDetail();
        openBook(meta.id, ci);
      };
    });
    fillBookDetailCover(meta);
  }

  function fillBookDetailCover(meta) {
    if (!global.NR.cover || meta.coverData) return;
    if (!meta.coverUrl) return;
    global.NR.cover.get(meta.coverUrl, meta.bookUrl).then(function (data) {
      if (!data) return;
      meta.coverData = data;
      saveIndexSoon();
      var img = el('bookdBody').querySelector('img.bookd__cover');
      if (img) { img.src = data; img.hidden = false; }
      else {
        var cell = el('bookdBody').querySelector('.bookd__cover--none');
        if (cell) {
          var im = document.createElement('img');
          im.className = 'bookd__cover';
          im.src = data;
          cell.parentNode.replaceChild(im, cell);
        }
      }
    });
  }

  function closeBookDetail() {
    el('bookDetail').hidden = true;
    renderShelf();
  }

  function chapterName(b) {
    if (!b || !b.progress) return '';
    var n = '第 ' + (b.progress.ci + 1) + ' 章';
    if (b.chapterTitles && b.chapterTitles[b.progress.ci]) n = b.chapterTitles[b.progress.ci];
    return n;
  }

  function renderContinue() {
    var box = el('continueCard');
    var last = sortedIndex().filter(function (b) { return b.progress; })[0];
    if (!last) { box.innerHTML = ''; return; }
    var pct = Math.round(progressOf(last) * 100);
    box.innerHTML =
      '<button class="hero" type="button">' +
      '<p class="hero__label">继续阅读</p>' +
      '<h2 class="hero__title">' + esc(last.title) + '</h2>' +
      '<div class="hero__meta">' +
      '<span class="hero__chapter">' + esc(chapterName(last)) + '</span>' +
      '<i class="hero__sep"></i><span>已读 ' + pct + '%</span>' +
      '<i class="hero__sep"></i><span>' + fmtTime(last.lastReadAt) + '</span>' +
      '</div>' +
      '<div class="hero__rule"><i style="width:' + pct + '%"></i></div>' +
      '</button>';
    box.querySelector('.hero').onclick = function () { openBook(last.id); };
  }

  function progressOf(b) {
    if (!b || !b.progress || !b.totalChars) return 0;
    var acc = 0;
    var lens = b.lens || [];
    for (var i = 0; i < b.progress.ci && i < lens.length; i++) acc += lens[i];
    var cl = lens[b.progress.ci] || 0;
    acc += cl * (b.progress.ratio || 0);
    return Math.max(0, Math.min(1, acc / b.totalChars));
  }

  function deleteBooks(ids) {
    if (!storageWritable()) return Promise.reject(new Error('存储尚未就绪或已暂停写入'));
    var affectsReading = ids === null || readingTask && ids.indexOf(readingTask.id) >= 0 || cur && ids.indexOf(cur.meta.id) >= 0;
    if (affectsReading) {
      stopReading();
      destroyVplayer();
      destroyAplayer();
      cur = null;
      loading(false);
      if (view === 'read') switchView('shelf');
      if (NR.sources && NR.sources.clearCache) NR.sources.clearCache();
    }
    return S.deleteBooks(ids).then(function (committed) {
      index = committed;
      renderShelf();
      pluginEmit('shelf:change', { action: 'remove', ids: ids });
      toast(ids === null ? '已清空' : '已删除');
      return true;
    });
  }
  function removeBook(id) { return deleteBooks([id]); }
  function deleteFailed(e) { loading(false); toast('删除失败：' + (e.message || e)); }

  /* ---------------- 导入 ---------------- */
  /* 书目结构统一：{ title, chapters:[{t,text}], totalChars, format, sourceId? }
     本地解析和在线书源最终都走 addBook()，书架/阅读逻辑不需要区分来源。
     在线书：chapters 只有 {t,url}，正文按章懒加载（见 remoteFill）。 */
  function addBook(book) {
    if (!storageWritable()) return Promise.reject(new Error('存储尚未就绪或已暂停写入'));
    if (!book || !book.chapters || !book.chapters.length) return Promise.reject(new Error('没有读到内容'));
    var id = uid();
    var remote = !!book.remote;
    var meta = {
      id: id, title: book.title || '未命名', format: book.format || (remote ? 'online' : 'txt'),
      // 在线书没有字数：用「章数」当总量，进度条就是「读到第几章」
      totalChars: remote ? book.chapters.length : (book.totalChars || 0),
      chapterCount: book.chapters.length,
      lens: remote ? book.chapters.map(function () { return 1; })
        : book.chapters.map(function (c) { return c.text.length; }),
      chapterTitles: book.chapters.map(function (c) { return c.t; }),
      addedAt: Date.now(), lastReadAt: 0, progress: null
    };
    if (book.author) meta.author = book.author;
    if (book.intro) meta.intro = book.intro;
    if (book.coverUrl) meta.coverUrl = book.coverUrl;
    if (book.coverData) meta.coverData = book.coverData;
    if (book.alsoOn && book.alsoOn.length) {
      meta.alsoOn = book.alsoOn.filter(function (a) { return a && a.sourceId; }).slice(0, 20);
    }
    if (remote) {
      meta.remote = true;
      meta.sourceId = book.sourceId || '';
      meta.sourceName = book.sourceName || '';
      meta.bookUrl = book.bookUrl || '';
    } else if (book.sourceId) {
      meta.sourceId = book.sourceId; meta.sourceBookId = book.sourceBookId || '';
    }
    var payload = remote
      ? { remote: true, chapters: book.chapters.map(function (c) { return { t: c.t, url: c.url }; }) }
      : { chapters: book.chapters };
    return S.set('nr_book_' + id, payload).then(function () {
      index.push(meta);
      pluginEmit('shelf:change', { action: 'add', id: id, title: meta.title });
      return meta;
    });
  }

  /* ---------------- 影视条目（播放页点「书架」或书架里点开） ---------------- */
  function normVideoLines(lines) {
    return (lines || []).map(function (l) {
      return {
        from: String(l.from || ''),
        eps: (l.eps || []).map(function (e) { return { t: String(e.t || ''), url: String(e.url || '') }; })
          .filter(function (e) { return e.url; })
      };
    }).filter(function (l) { return l.eps.length; });
  }

  /* 播放页里点「书架」→ 建一条 format='video' 的书架条目（存线路结构，不存文字章节） */
  function addVideoBook(spec) {
    if (!storageWritable()) return Promise.reject(new Error('存储尚未就绪或已暂停写入'));
    spec = spec || {};
    var lines = normVideoLines(spec.lines);
    if (!lines.length) return Promise.reject(new Error('没有可播的剧集'));
    var title = String(spec.title || '').trim() || '未命名影视';
    var bookUrl = String(spec.bookUrl || title);
    for (var i = 0; i < index.length; i++) {
      var old = index[i];
      if (old && old.format === 'video' && (old.bookUrl === bookUrl || old.title === title)) {
        return Promise.resolve({ added: false, id: old.id });
      }
    }
    var li = Math.max(0, Math.min(lines.length - 1, Number(spec.lineIdx) || 0));
    var ei = Math.max(0, Math.min(lines[li].eps.length - 1, Number(spec.index) || 0));
    var total = 0;
    lines.forEach(function (l) { total += l.eps.length; });
    var id = uid();
    var meta = {
      id: id, title: title, format: 'video', srcType: 4, remote: true,
      totalChars: total, chapterCount: total,
      lens: lines[li].eps.map(function () { return 1; }),
      chapterTitles: lines[li].eps.map(function (ep) { return ep.t; }),
      addedAt: Date.now(), lastReadAt: Date.now(),
      progress: { ci: ei, ratio: 0 },
      sourceName: String(spec.sourceName || ''),
      bookUrl: bookUrl,
      vline: li, vep: ei, vt: Math.max(0, Number(spec.current) || 0)
    };
    if (spec.intro) meta.intro = String(spec.intro);
    if (spec.coverUrl) meta.coverUrl = String(spec.coverUrl);
    return S.set('nr_book_' + id, { video: true, lines: lines }).then(function () {
      index.push(meta);
      saveIndex();
      pluginEmit('shelf:change', { action: 'add', id: id, title: meta.title });
      try { renderShelf(); } catch (e) { /* 界面没画出来不影响入库 */ }
      return { added: true, id: id };
    });
  }

  /* 书架点开影视条目 → 直接回播放页（断点由播放页自己记） */
  function openVideoBook(meta, data) {
    if (!global.NR.video || typeof global.NR.video.open !== 'function') { toast('这个版本不支持影视播放'); return; }
    var lines = normVideoLines(data && data.lines);
    if (!lines.length) { toast('这部剧没有可播的线路'); return; }
    meta.lastReadAt = Date.now();
    saveIndexSoon();
    global.NR.video.open({
      title: meta.title,
      intro: meta.intro || '',
      cover: meta.coverUrl || '',
      sourceName: meta.sourceName || '',
      bookUrl: meta.bookUrl || meta.title,
      lines: lines,
      lineIdx: meta.vline || 0,
      index: meta.vep || 0,
      from: 'shelf'
    });
  }

  function handleFiles(files) {
    if (!storageWritable()) { pausedStorage(); return; }
    var arr = Array.prototype.slice.call(files).filter(function (f) {
      return /\.(txt|md|markdown|epub)$/i.test(f.name);
    });
    if (!arr.length) { toast('只支持 .txt / .md / .epub'); return; }
    var i = 0;
    function next() {
      if (!storageWritable()) { loading(false); pausedStorage(); return; }
      if (i >= arr.length) {
        loading(false); saveIndex(); renderShelf();
        toast('导入完成：' + arr.length + ' 本');
        return;
      }
      var f = arr[i++];
      loading(true, '正在解析《' + f.name + '》… (' + i + '/' + arr.length + ')');
      setTimeout(function () {
        P.parseFile(f).then(function (book) {
          return addBook(book);
        }).catch(function (e) {
          console.error(e);
          toast('《' + f.name + '》解析失败：' + (e.message || e));
        }).then(next);
      }, 30);
    }
    next();
  }

  /* 桌面端：走原生文件对话框；浏览器里退回 <input type=file> */
  function importBooks() {
    if (!storageWritable()) { pausedStorage(); return; }
    var pf = global.NR.platform;
    if (pf && pf.isDesktop) {
      pf.pickFiles().then(function (files) {
        if (files && files.length) handleFiles(files);
      }).catch(function (e) { toast('打开文件失败：' + (e.message || e)); });
    } else {
      el('fileInput').click();
    }
  }

  /* ---------------- 打开书 ---------------- */
  function openBook(id, at) {
    if (!storageWritable()) { pausedStorage(); return; }
    var meta = null;
    for (var i = 0; i < index.length; i++) if (index[i].id === id) meta = index[i];
    if (!meta) { toast('找不到这本书'); return; }
    if (at != null) meta.progress = { ci: Math.max(0, at | 0), ratio: 0 };
    if (global.NR.plugins) {
      try { global.NR.plugins.emit('book:open', { id: id, title: meta.title || '', sourceId: meta.sourceId || '' }); } catch (e) { /* 插件事件出错不影响开书 */ }
    }
    var task = beginReading(id);
    loading(true, '正在打开…');
    S.get('nr_book_' + id).then(function (data) {
      if (!activeReading(task)) return;
      /* 影视条目：里面存的是线路结构，直接进播放页，不走阅读器 */
      if (data && data.video) {
        stopReading();
        loading(false);
        openVideoBook(meta, data);
        return;
      }
      if (!data || !data.chapters) { loading(false); toast('书籍数据已丢失，请重新导入'); return; }
      cur = { meta: meta, chapters: data.chapters };
      if (meta.remote) {
        var p0 = meta.progress ? meta.progress.ci : 0;
        loading(true, '正在加载章节…');
        return primeRemote(p0, 2).then(function () {
          if (!activeReading(task)) return;
          loading(false);
          enterReader(meta);
        });
      }
      loading(false);
      enterReader(meta);
    }).catch(function (e) {
      if (!activeReading(task)) return;
      loading(false);
      toast('打开失败：' + (e.message || e));
    });
  }

  /* ---------------- 未入架的在线书：先读，看过再决定收不收藏 ---------------- */
  function openTransient(book) {
    if (!book || !book.title) { toast('这本书没有可用信息'); return; }
    var chapters = (book.chapters || []).map(function (c) { return { t: c.t, url: c.url }; });
    if (!chapters.length) { toast('这个源没有目录'); return; }
    // 从目录里点某一章进来时直接从那一章开始（缺省第 0 章）
    var startIndex = Math.max(0, Math.min(chapters.length - 1, Number(book.startIndex) || 0));
    var meta = {
      id: 'tmp-' + Date.now().toString(36),
      title: book.title,
      author: book.author || '',
      intro: book.intro || '',
      format: 'online',
      remote: true,
      temp: true,                       // 不在书架里，进度只存在内存
      sourceId: book.sourceId || '',
      sourceName: book.sourceName || '',
      bookUrl: book.bookUrl || '',
      totalChars: chapters.length,
      chapterCount: chapters.length,
      lens: chapters.map(function () { return 1; }),
      chapterTitles: chapters.map(function (c) { return c.t; }),
      addedAt: Date.now(), lastReadAt: 0,
      progress: { ci: startIndex, ratio: 0 },
      alsoOn: (book.alsoOn || []).slice()
    };
    var task = beginReading(meta.id);
    cur = { meta: meta, chapters: chapters };
    loading(true, '正在加载章节…');
    primeRemote(startIndex, 2).then(function () {
      if (!activeReading(task)) return;
      loading(false);
      enterReader(meta);
    });
  }

  function updateAddCurButton() {
    var b = el('btnAddCur');
    if (!b) return;
    b.hidden = !(cur && cur.meta && cur.meta.remote && cur.meta.temp);
  }

  function addCurrentToShelf(skipConfirm) {
    if (!cur || !cur.meta || !cur.meta.temp) return;
    var m = cur.meta;
    var p = computeProgress();
    var doAdd = function () {
      loading(true, '正在加入书架…');
      NR.importBook({
        title: m.title, author: m.author, intro: m.intro,
        coverUrl: m.coverUrl || '',
        remote: true, format: 'online',
        sourceId: m.sourceId, sourceName: m.sourceName, bookUrl: m.bookUrl,
        alsoOn: m.alsoOn || [],
        chapters: cur.chapters.map(function (c) { return { t: c.t, url: c.url }; })
      }).then(function (meta) {
        loading(false);
        meta.progress = { ci: p.ci, ratio: p.ratio };
        meta.lastReadAt = Date.now();
        NR.readingStats.mergeIdentity(m.id, meta.id);
        cur.meta = meta;
        S.set(LAST, meta.id);
        saveIndex();
        renderShelf();
        updateAddCurButton();
        renderToc();
        toast('已加入书架');
      }).catch(function (e) {
        loading(false);
        toast('加入失败：' + (e.message || e));
      });
    };
    if (skipConfirm) { doAdd(); return; }
    NR.ui.confirm('把《' + m.title + '》加入书架？\n\n来源：' + (m.sourceName || '在线') +
      ' · ' + m.chapterCount + ' 章', doAdd, '加入书架');
  }

  function enterReader(meta) {
    if (view !== 'read') readerReturnView = view;
    if (view === 'online' && NR.online && NR.online.leave) NR.online.leave();
    view = 'read';
    syncWindowColor();
    el('app').classList.add('reading');
    el('shelfView').classList.add('hidden');
    el('onlineView').classList.add('hidden');
    el('bookstoreView').classList.add('hidden');
    el('mineView').classList.add('hidden');
    el('readView').classList.remove('hidden');
    fadeView(el('readView'));
    el('readTitle').textContent = meta.title;
    switchMode();
    var p = meta.progress || { ci: 0, ratio: 0 };
    jumpTo(p.ci, p.ratio || 0, true);
    if (!meta.temp) S.set(LAST, meta.id);
    updateWakeLock();
    renderToc();
    updateSwitchButtons();
    updateAddCurButton();
    NR.readingStats.enter(meta.id);
  }

  /* ---------------- 阅读器：点击翻页 ---------------- */
  /** 点击翻页（设置里开启时） */
  function bindTapTurn() {
    var box = el('readView');
    if (!box || box.dataset.tapTurn) return;
    box.dataset.tapTurn = '1';
    box.addEventListener('click', function (e) {
      if (!settings.tapTurn || view !== 'read') return;
      if (e.target.closest('button, a, input, .drawer, .modal')) return;
      var x = e.clientX - box.getBoundingClientRect().left;
      var w = box.getBoundingClientRect().width;
      if (x < w * 0.3) { goChapter(-1); }
      else if (x > w * 0.7) { goChapter(1); }
      else if (MOBILE_UI) { el('readView').classList.toggle('reading-ui-hidden'); }
    }, true);
  }

  /* ---------------- 在线书：按章懒加载 ---------------- */
  var remoteBusy = Object.create(null);

  /** 取一章正文：内存 → 本地缓存 → 书源；成功后回调 patchChapter 重绘 */
  function remoteFill(ci) {
    if (!cur || !cur.meta.remote) return Promise.resolve('');
    var ch = cur.chapters[ci];
    if (!ch) return Promise.resolve('');

    var meta = cur.meta, bookId = meta.id, task = readingTask;
    if (!task || !activeReading(task)) return Promise.resolve('');
    var identity = NR.sources.contentGeneration(meta.sourceId, cur.chapters);
    var generation = identity.generation, chapterUrl = ch.url;
    if (ch.text != null && ch.generation === generation && ch.chapterUrl === chapterUrl) return Promise.resolve(ch.text);
    if (ch.error && ch.generation === generation && ch.chapterUrl === chapterUrl) return Promise.resolve('');
    if (ch.generation !== generation || ch.chapterUrl !== chapterUrl) {
      ch.text = null;
      delete ch.error;
      delete ch.__diag;
    }

    var key = 'nr_ch_' + bookId + '_' + ci;
    var busyKey = key + '::' + generation + '::' + chapterUrl;
    if (remoteBusy[busyKey]) return remoteBusy[busyKey];

    var isMine = function () {
      if (!activeReading(task) || !cur || cur.meta.id !== bookId || cur.chapters[ci] !== ch || ch.url !== chapterUrl) return false;
      return NR.sources.contentGeneration(meta.sourceId, cur.chapters).generation === generation;
    };
    var p = S.get(key).then(function (cached) {
      if (!isMine()) throw NR.tasks.error(false);
      if (cached && typeof cached.text === 'string' && cached.text && cached.generation === generation && cached.chapterUrl === chapterUrl) {
        ch.__diag = cached.diag || {};
        return cached.text;
      }
      return NR.sources.content(meta.sourceId, ch, { signal: task.controller.signal, chapterUrls: identity.chapterUrls }).then(function (r) {
        if (!isMine()) throw NR.tasks.error(false);
        ch.__diag = r.__diag || {};
        var record = { generation: generation, chapterUrl: chapterUrl, text: r.text, diag: r.__diag || {} };
        return S.set(key, record).then(function () { return r.text; });
      });
    }).then(function (text) {
      if (remoteBusy[busyKey] === p) delete remoteBusy[busyKey];
      if (!isMine()) return '';
      ch.text = text;
      ch.generation = generation;
      ch.chapterUrl = chapterUrl;
      patchChapter(ci);
      return text;
    }).catch(function (e) {
      if (remoteBusy[busyKey] === p) delete remoteBusy[busyKey];
      if (!isMine() || e.code === 'CANCELLED') return '';
      ch.error = (e && e.message) || '加载失败';
      ch.generation = generation;
      ch.chapterUrl = chapterUrl;
      patchChapter(ci);
      return '';
    });
    remoteBusy[busyKey] = p;
    return p;
  }

  /** 预取 [ci, ci+n) 的正文，失败不打断 */
  function primeRemote(ci, n) {
    if (!cur || !cur.meta.remote) return Promise.resolve();
    var jobs = [];
    for (var i = ci; i < ci + (n || 1); i++) {
      if (i >= 0 && i < cur.chapters.length) jobs.push(remoteFill(i));
    }
    return Promise.all(jobs).then(function () { }, function () { });
  }

  /** 某一章从「加载中」变成「有正文」后，只重绘那一块，别整页跳 */
  function patchChapter(ci) {
    if (!cur || view !== 'read') return;
    if (settings.mode === 'page') {
      var p = cur.meta.progress || { ci: 0, ratio: 0 };
      if (p.ci === ci) {
        renderPageChapter(ci);
        var r = p.ratio || 0;
        setTimeout(function () {
          if (!cur || !cur.meta || cur.meta.progress && cur.meta.progress.ci !== ci) return;
          pageState.page = Math.round(r * Math.max(0, pageState.pages - 1));
          applyPage();
        }, 70);
      }
      return;
    }
    var blk = el('content').querySelector('.ch-block[data-ci="' + ci + '"]');
    if (!blk) return;
    var head = blk.querySelector('.ch-split') ? '<div class="ch-split"></div>' : '';
    var anchor0 = currentBlock();
    var anchor0Top = anchor0 ? anchor0.getBoundingClientRect().top : null;
    blk.innerHTML = head + chapterHTML(ci);
    hydratePlayers(blk);
    // 补正文改变了块高：浏览器若已自动补偿，这里差值为 0；否则把正在读的位置拉回原处
    anchorFix(anchor0, anchor0Top);
    // 打开书时正文没到、定位被推迟到这里：现在按真实高度重定位
    if (pendingPlace && pendingPlace.ci === ci) {
      var pg = pendingPlace;
      pendingPlace = null;
      var w2 = el('scrollWrap');
      var blk2 = el('content').querySelector('.ch-block[data-ci="' + ci + '"]');
      if (blk2) {
        var wr2 = w2.getBoundingClientRect(), br2 = blk2.getBoundingClientRect();
        w2.scrollTop = Math.max(0, w2.scrollTop + (br2.top - wr2.top - 8) + pg.ratio * blk2.offsetHeight);
        lastProgValue = { ci: ci, ratio: pg.ratio };
        lastProgScrollTop = w2.scrollTop;
        var curM = cur.meta.progress;
        if (!curM || curM.ci !== ci || (curM.ratio || 0) < pg.ratio) cur.meta.progress = { ci: ci, ratio: pg.ratio };
      }
    }
  }

  function backToShelf() {
    destroyVplayer();
    destroyAplayer();
    saveProgress(true);
    stopReading();
    // 临时书（没入架）退出时问一句要不要加书架
    var temp = cur && cur.meta && cur.meta.temp;
    var title = temp ? cur.meta.title : '';
    el('app').classList.remove('reading');
    el('app').classList.remove('video-mode');
    switchView(readerReturnView);
    if (temp && cur) {
      NR.ui.confirm('把《' + title + '》加入书架？\n\n不加的话，下次还得重新搜。',
        function () { addCurrentToShelf(true); }, '加入书架');
    }
  }

  /* ---------------- 换源（阅读页 / 目录） ---------------- */
  function updateSwitchButtons() {
    // 在线书都显示换源：没有现成的其它源时，还能「搜索其它书源」
    var show = !!(cur && cur.meta && cur.meta.remote);
    each([el('btnSwitchSrc'), el('btnTocSwitch'), el('btnCurSrc')], function (b) {
      if (!b) return;
      b.hidden = !show;
    });
    var curBtn = el('btnCurSrc');
    if (curBtn && show) {
      var name = cur.meta.sourceName || '当前源';
      curBtn.textContent = name.length > 8 ? name.slice(0, 8) + '…' : name;
      curBtn.title = '当前书源：' + name;
      curBtn.onclick = function () {
        if (NR.online && NR.online.showSourceInfo) NR.online.showSourceInfo(cur.meta);
      };
    }
  }

  function liveAlts() {
    if (!cur || !cur.meta.remote) return [];
    return (cur.meta.alsoOn || []).filter(function (a) {
      return a.sourceId !== cur.meta.sourceId && !!NR.sources.get(a.sourceId);
    });
  }

  function pickSource() {
    if (!cur || !cur.meta.remote) return;
    var alts = liveAlts();
    var items = alts.map(function (a) { return { label: a.sourceName }; });
    items.push({ label: '搜索其它书源…' });
    NR.ui.pick('换一个书源', items, function (i) {
      if (i === items.length - 1) {
        if (!NR.online || !NR.online.findSourcesFor) { toast('书源模块不可用'); return; }
        NR.online.findSourcesFor(cur.meta.title, cur.meta.sourceId, function (b) {
          switchToSource({ sourceId: b.sourceId, sourceName: b.sourceName, bookUrl: b.bookUrl });
        });
        return;
      }
      switchToSource(alts[i]);
    });
  }

  function switchToSource(alt) {
    if (!cur || !alt) return;
    if (!NR.sources.get(alt.sourceId)) { toast('那个书源已经不在了'); return; }
    loading(true, '正在换源…');
    var old = cur.meta;
    var p = computeProgress();
    var task = beginReading(old.id);

    NR.sources.catalog(alt.sourceId, alt.bookUrl, {}, { signal: task.controller.signal, deadline: Date.now() + 30000 }).then(function (cat) {
      if (!activeReading(task) || !cur || cur.meta !== old) return;
      var chapters = (cat.chapters || []).map(function (c) { return { t: c.t, url: c.url }; });
      if (!chapters.length) throw new Error('这个源没有目录');

      // 尽量按「章节名」对齐进度，对不上就按原章号夹一下
      var newCi = Math.min(chapters.length - 1, Math.max(0, p.ci));
      var oldTitle = (old.chapterTitles && old.chapterTitles[p.ci]) || '';
      if (oldTitle) {
        for (var i = 0; i < chapters.length; i++) {
          if (chapters[i].t === oldTitle) { newCi = i; break; }
        }
      }

      // 换之前的源留在「可换回去」的列表里
      var prev = { sourceId: old.sourceId, sourceName: old.sourceName, bookUrl: old.bookUrl };

      return S.set('nr_book_' + old.id, { remote: true, chapters: chapters }).then(function () {
        if (!activeReading(task) || !cur || cur.meta !== old) return;
        // 正文缓存是按「章序号」存的，换源后序号含义变了 → 清掉
        for (var k = 0; k < (old.chapterCount || 0); k++) S.del('nr_ch_' + old.id + '_' + k);
        if (NR.sources && NR.sources.clearCache) NR.sources.clearCache();

        old.sourceId = alt.sourceId;
        old.sourceName = alt.sourceName;
        old.bookUrl = alt.bookUrl;
        old.chapterTitles = chapters.map(function (c) { return c.t; });
        old.lens = chapters.map(function () { return 1; });
        old.totalChars = chapters.length;
        old.chapterCount = chapters.length;

        var rest = (old.alsoOn || []).filter(function (a) { return a.sourceId !== alt.sourceId; });
        if (prev.sourceId && prev.sourceId !== alt.sourceId) rest.push(prev);
        old.alsoOn = rest.slice(0, 20);

        cur.chapters = chapters;
        loading(false);
        jumpTo(newCi, 0, true, true);
        renderToc();
        updateSwitchButtons();
        saveIndex();
        renderShelf();
        toast('已换到「' + alt.sourceName + '」');
      });
    }).catch(function (e) {
      if (!activeReading(task) || e.code === 'CANCELLED') return;
      loading(false);
      toast('换源失败：' + (e.message || e));
    });
  }

  /* ---------------- 通用弹层：确认 / 选择 ---------------- */
  var modalKeyHandler = null;

  /* 复位弹层样式：长文档模式（modal--doc）用完必须还原，否则后面的确认框会跟着变宽 */
  function resetModalCard() {
    var m = el('modal');
    if (m) m.classList.remove('modal--doc');
    var t = el('modalText');
    if (t) t.className = 'modal__text';
    var c = el('modalCancel');
    if (c) c.hidden = false;
  }

  function closeModal() {
    var m = el('modal');
    if (!m) return;
    m.hidden = true;
    resetModalCard();
    if (modalKeyHandler) {
      document.removeEventListener('keydown', modalKeyHandler, true);
      modalKeyHandler = null;
    }
  }

  function bindModalKeys(onOk) {
    if (modalKeyHandler) document.removeEventListener('keydown', modalKeyHandler, true);
    modalKeyHandler = function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
      else if (e.key === 'Enter' && onOk) { e.stopPropagation(); e.preventDefault(); onOk(); }
    };
    document.addEventListener('keydown', modalKeyHandler, true);
  }

  function uiConfirm(text, onYes, okLabel) {
    var m = el('modal');
    if (!m) { if (onYes) onYes(); return; }
    resetModalCard();
    el('modalText').textContent = text;
    var list = el('modalList');
    list.hidden = true;
    list.innerHTML = '';
    var ok = el('modalOk');
    ok.hidden = false;
    ok.textContent = okLabel || '确定';
    ok.onclick = function () { closeModal(); if (onYes) onYes(); };
    el('modalCancel').onclick = closeModal;
    m.querySelector('.modal__mask').onclick = closeModal;
    bindModalKeys(ok.onclick);
    m.hidden = false;
    setTimeout(function () { ok.focus(); }, 30);
  }

  function uiPrompt(title, def, onOk, okLabel, placeholder) {
    var m = el('modal');
    if (!m) { if (onOk) onOk(''); return; }
    resetModalCard();
    el('modalText').textContent = title;
    var list = el('modalList');
    list.hidden = false;
    list.innerHTML = '<input id="modalInput" class="modal__input" type="text" spellcheck="false" ' +
      (placeholder ? 'placeholder="' + esc(placeholder) + '" ' : '') + '>';
    var inp = el('modalInput');
    inp.value = def || '';
    var ok = el('modalOk');
    ok.hidden = false;
    ok.textContent = okLabel || '确定';
    var fire = function () {
      var v = String(inp.value || '').trim();
      closeModal();
      if (onOk) onOk(v);
    };
    ok.onclick = fire;
    inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); fire(); } };
    el('modalCancel').onclick = closeModal;
    m.querySelector('.modal__mask').onclick = closeModal;
    bindModalKeys(null);
    m.hidden = false;
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }

  function uiPick(title, items, onPick) {
    var m = el('modal');
    if (!m) return;
    resetModalCard();
    el('modalText').textContent = title;
    var list = el('modalList');
    list.hidden = false;
    list.innerHTML = '';
    (items || []).forEach(function (it, i) {
      var b = document.createElement('button');
      b.type = 'button';
      if (it.on) b.className = 'on';
      b.textContent = it.label;
      b.onclick = function () { closeModal(); onPick(i); };
      list.appendChild(b);
    });
    el('modalOk').hidden = true;
    el('modalCancel').onclick = closeModal;
    m.querySelector('.modal__mask').onclick = closeModal;
    bindModalKeys(null);
    m.hidden = false;
  }

  /* 长文档弹层：隐私政策 / 开源许可这类要滚动阅读的文本 */
  function uiDoc(title, body, okLabel) {
    var m = el('modal');
    if (!m) return;
    resetModalCard();
    m.classList.add('modal--doc');
    var t = el('modalText');
    t.className = 'modal__text modal__text--doc';
    t.textContent = (title ? title + '\n\n' : '') + (body || '');
    var list = el('modalList');
    list.hidden = true;
    list.innerHTML = '';
    var ok = el('modalOk');
    ok.hidden = false;
    ok.textContent = okLabel || '关闭';
    ok.onclick = closeModal;
    var cancel = el('modalCancel');
    cancel.hidden = true;
    cancel.onclick = closeModal;
    m.querySelector('.modal__mask').onclick = closeModal;
    bindModalKeys(closeModal);
    m.hidden = false;
    t.scrollTop = 0;
    setTimeout(function () { ok.focus(); }, 30);
  }

  /* ---------------- 视图切换：推荐 / 书城 / 书架 / 我的 ---------------- */
  function setNavExpanded(on) {
    el('app').classList.toggle('nav-expanded', !!on);
    el('mainNav').setAttribute('aria-expanded', String(!!on));
  }

  function syncNav(name) {
    each(document.querySelectorAll('.nav__tab'), function (b) {
      var selected = b.dataset.view === name;
      b.classList.toggle('on', selected);
      b.setAttribute('aria-current', selected ? 'page' : 'false');
    });
  }

  function renderReadingStats() {
    var stats = NR.readingStats.get();
    var rows = el('readingStats').querySelectorAll('.reading-stat strong');
    rows[0].innerHTML = stats.readCount + ' <small>本</small>';
    var minutes = Math.floor(stats.totalMs / 60000);
    rows[1].innerHTML = minutes < 60
      ? minutes + ' <small>分钟</small>'
      : (minutes / 60).toFixed(1) + ' <small>小时</small>';
  }

  /** 把视图容器的显隐同步成 name（启动时也要跑一次，默认视图不再是书架） */
  function paintView(name) {
    // 离开「我的」时必须把 #setBody 搬回抽屉，否则阅读器里的 ⚙ 打开是空白
    if (name !== 'mine') closeMinePane();
    el('app').classList.remove('reading');
    el('app').classList.toggle('video-mode', name === 'video');
    el('readView').classList.add('hidden');
    el('shelfView').classList.toggle('hidden', name !== 'shelf');
    el('onlineView').classList.toggle('hidden', name !== 'online');
    el('bookstoreView').classList.toggle('hidden', name !== 'bookstore');
    el('mineView').classList.toggle('hidden', name !== 'mine');
    if (el('videoView')) el('videoView').classList.toggle('hidden', name !== 'video');
    // 插件页面：只有当前这个显示
    var plgKey = String(name).indexOf('plg:') === 0 ? String(name).slice(4) : '';
    [].forEach.call(document.querySelectorAll('[data-plg-view]'), function (s) {
      s.classList.toggle('hidden', !plgKey || s.getAttribute('data-plg-view') !== plgKey);
    });
    syncWindowColor();
    syncNav(name);
    if (plgKey && global.NR.plugins) {
      try { global.NR.plugins.showPage(plgKey); } catch (e) { /* 插件页面出错不影响主流程 */ }
    }
    // 插件：视图切换后刷新插槽内容并广播事件
    if (global.NR.plugins) {
      try { global.NR.plugins.refresh(); } catch (e) { /* 插件出错不影响主流程 */ }
      try { global.NR.plugins.emit('view:change', { view: name }); } catch (e) { /* 同上 */ }
    }
  }

  function switchView(name) {
    if (name === view) return;
    if (view === 'read') { destroyVplayer(); destroyAplayer(); saveProgress(true); NR.readingStats.pause(); }
    if (view === 'video' && name !== 'video' && NR.video && NR.video.pauseOnly) { try { NR.video.pauseOnly(); } catch (e) { } }
    stopReading();
    if (view === 'online' && NR.online && NR.online.leave) NR.online.leave();
    if (view === 'bookstore' && NR.bookstore && NR.bookstore.leave) NR.bookstore.leave();
    view = name;
    paintView(name);
    if (name === 'shelf') {
      renderShelf();
      fadeView(el('shelfView'));
    } else if (name === 'online') {
      fadeView(el('onlineView'));
      if (global.NR.online) global.NR.online.enter();
    } else if (name === 'bookstore') {
      fadeView(el('bookstoreView'));
      if (global.NR.bookstore) global.NR.bookstore.enter();
    } else if (name === 'video') {
      fadeView(el('videoView'));
    } else if (name === 'mine') {
      fadeView(el('mineView'));
    }
    updateWakeLock();
  }

  function switchMode() {    var isPage = settings.mode === 'page';
    el('scrollWrap').classList.toggle('hidden', isPage);
    el('pageWrap').classList.toggle('hidden', !isPage);
    el('chapterNav').classList.toggle('hidden', isPage || settings.continuous);
  }

  /* ---------------- 内容渲染（滚动模式） ---------------- */
  /* ---- 视频章节模式：书源 srcType=4 或正文本身是视频地址时，渲染内嵌播放器 ---- */
  var vplayerState = null;   // { url, hls, video, progTimer, bookId, ci }
  /* 调试钩子：最近一次 mountVplayer 的 {url, headers, lines, isHls}，供自动化断言读 */
  window.__VP = window.__VP || { last: null };

  /* 当前书源对象（漫画解密等需要读 ruleContent.imageDecode） */
  function curSource() {
    try {
      var s = cur && cur.meta && cur.meta.sourceId && NR.sources && NR.sources.get(cur.meta.sourceId);
      return s || null;
    } catch (e) { return null; }
  }

  function curSrcType() {
    try {
      var s = cur && cur.meta && cur.meta.sourceId && NR.sources && NR.sources.get(cur.meta.sourceId);
      return s ? Number(s.srcType || 0) : 0;
    } catch (e) { return 0; }
  }

  /* P：书架/详情的类型徽标——书本身不存类型，从其源（或换源记录）继承。
   * b.srcType 在加书架时由导入路径写入（sources/index.js 加书时挂），老书走源反查。 */
  var TYPE_BADGE = { 1: '🎵', 2: '🖼️', 4: '🎬' };
  function srcTypeBadgeHtml(t) {
    var m = TYPE_BADGE[Number(t || 0)];
    return m ? ' <span class="row__typebadge" title="多媒体内容">' + m + '</span>' : '';
  }
  function shelfTypeBadge(b) {
    try {
      var t = Number(b.srcType || 0);
      if (!t && b.sourceId && NR.sources) {
        var s = NR.sources.get(b.sourceId);
        if (s) t = Number(s.srcType || 0);
      }
      return srcTypeBadgeHtml(t);
    } catch (e) { return ''; }
  }

  function isVideoUrl(u) {
    return /^https?:\/\/\S+$/i.test(u) &&
      (/\.(m3u8|mp4|webm|ogv|mov)(\?|#|$)/i.test(u) || /m3u8|\.mp4/i.test(u));
  }

  /* P：多媒体约定——地址后可拼请求头：`https://x/a.m3u8,{"headers":{…}}`（逗号紧接 `{`）。
   * 请求头里的 User-Agent 可能含空格和逗号，所以不能按逗号/空白切 token：
   * 先取到 `,{` 分界，再对 JSON 做「字符串感知的平衡括号」扫描（思路同 mediaview 的 extractImages）。 */
  function parseMediaUrl(token) {
    var s = String(token == null ? '' : token).trim();
    if (!s) return { url: '', headers: null };
    var at = -1, i, c;
    for (i = 0; i < s.length - 1; i++) {
      if (s.charAt(i) === ',' && s.charAt(i + 1) === '{') { at = i; break; }
    }
    if (at < 0) return { url: s, headers: null };
    var depth = 0, inStr = false, escp = false, end = s.length;
    for (i = at + 1; i < s.length; i++) {
      c = s.charAt(i);
      if (inStr) {
        if (escp) escp = false;
        else if (c === '\\') escp = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth <= 0) { end = i + 1; break; } }
    }
    var url = s.slice(0, at).trim();     // JSON 解析失败也保留 `,` 之前的地址
    var headers = null;
    try {
      var obj = JSON.parse(s.slice(at + 1, end));
      if (obj && typeof obj === 'object') {
        headers = (obj.headers && typeof obj.headers === 'object') ? obj.headers : obj;
      }
    } catch (e) { headers = null; }
    // 只留可用的字符串头（剔除 null / 嵌套对象），一个都不剩就当没有头
    var clean = {}, has = false;
    if (headers) {
      Object.keys(headers).forEach(function (k) {
        var v = headers[k];
        if (v == null || typeof v === 'object') return;
        clean[k] = String(v); has = true;
      });
    }
    return { url: url, headers: has ? clean : null };
  }

  /** 整段正文 → 多条线路 [{url, headers}]（地址之间可能是换行或空格；请求头里的空白不算分隔） */
  function parseVideoText(text) {
    var t = String(text == null ? '' : text);
    var list = [], seen = {};
    if (!t) return { list: list, first: null };
    var re = /https?:\/\//gi, m;
    var BREAK = /[\s"'<>\\，。；：、！？（）「」]/;   // 正文里紧贴 URL 的中文标点也要断开
    while ((m = re.exec(t))) {
      var st = m.index, ei = st;
      while (ei < t.length && !BREAK.test(t.charAt(ei))) {
        if (t.charAt(ei) === ',' && t.charAt(ei + 1) === '{') break;
        ei++;
      }
      var end = ei;
      if (t.charAt(ei) === ',' && t.charAt(ei + 1) === '{') {
        var depth = 0, inStr = false, escp = false, k = ei + 1;
        for (; k < t.length; k++) {
          var c = t.charAt(k);
          if (inStr) {
            if (escp) escp = false;
            else if (c === '\\') escp = true;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') { depth--; if (depth <= 0) { k++; break; } }
        }
        end = k;
      }
      var one = parseMediaUrl(t.slice(st, end));
      if (one.url) {
        var sig = one.url + '|' + (one.headers ? JSON.stringify(one.headers) : '');
        if (!seen[sig]) { seen[sig] = 1; list.push(one); }
      }
      re.lastIndex = end > st ? end : st + 1;
    }
    return { list: list, first: list.length ? list[0] : null };
  }

  /** 正文文本 → 视频地址（非视频模式返回 null）；带请求头与全部线路 */
  function sniffVideo(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    var parsed = parseVideoText(t);
    if (curSrcType() === 4) {
      // 视频源：正文即视频地址，多行/多地址 = 多条线路
      return parsed.list.length
        ? { url: parsed.list[0].url, headers: parsed.list[0].headers, list: parsed.list }
        : null;
    }
    var hits = [];
    for (var i = 0; i < parsed.list.length; i++) {
      if (isVideoUrl(parsed.list[i].url)) hits.push(parsed.list[i]);
    }
    if (!hits.length) return null;
    return { url: hits[0].url, headers: hits[0].headers, list: hits };
  }

  function vprogKey(bookId, ci) { return 'vprog:' + bookId + ':' + ci; }

  /** 音频播放器销毁桥（实现在 audioview.js，与 destroyVplayer 同挂点调用） */
  function destroyAplayer() {
    if (NR.audioview) NR.audioview.destroyAplayer();
  }

  function vprogSave(key, t) { S.set(key, t).catch(function () { }); }
  function vprogGet(key) { return S.get(key).then(function (v) { return parseFloat(v) || 0; }).catch(function () { return 0; }); }
  function vprogDel(key) { return S.del(key).catch(function () { }); }

  function destroyVplayer() {
    if (!vplayerState) return;
    try { if (vplayerState.video) vplayerState.video.pause(); } catch (e) { }
    try { if (vplayerState.hls) vplayerState.hls.destroy(); } catch (e) { }
    try { if (vplayerState.progTimer) clearInterval(vplayerState.progTimer); } catch (e) { }
    try { if (vplayerState.video) vplayerState.video.removeAttribute('src'); } catch (e) { }
    // P：mp4 带请求头时走 fetch→blob，blob 会一直占内存，销毁/切线路必须回收
    try { if (vplayerState.blobUrl) URL.revokeObjectURL(vplayerState.blobUrl); } catch (e) { }
    vplayerState = null;
  }

  /* P：多线路按钮走文档级事件委托——章节块是 innerHTML 序列化出来的，
   * 直接挂在 wrap 上的 onclick 会在序列化时丢失（原「重试」按钮同理）。 */
  var vlineBound = false;
  function bindVlineDelegate() {
    if (vlineBound) return;
    vlineBound = true;
    document.addEventListener('click', function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('[data-vline]') : null;
      if (!btn) return;
      var st = vplayerState;
      if (!st || !st.lines || st.lines.length < 2) return;
      var idx = parseInt(btn.getAttribute('data-vline'), 10);
      if (!(idx >= 0) || idx >= st.lines.length || idx === st.activeIdx) return;
      var oldWrap = btn.closest('.vplayer-wrap');
      if (!oldWrap || !oldWrap.parentNode) return;
      // 整块重建（mountVplayer 内部先 destroyVplayer），不在回调里递归挂载
      var nw = mountVplayer(st.ci, st.lines[idx].url, st.lines[idx].headers, st.lines, idx);
      oldWrap.parentNode.replaceChild(nw, oldWrap);
    });
  }

  function mountVplayer(ci, url, headers, list, activeIdx) {
    destroyVplayer();
    bindVlineDelegate();
    var meta = cur.meta, bookId = meta.id;
    var key = vprogKey(bookId, ci);
    // 线路表：单条时就是当前 url；activeIdx 没给就按 url 反查
    list = (list && list.length) ? list : [{ url: url, headers: headers || null }];
    if (activeIdx == null || activeIdx < 0 || activeIdx >= list.length) {
      activeIdx = 0;
      for (var li0 = 0; li0 < list.length; li0++) {
        if (list[li0].url === url) { activeIdx = li0; break; }
      }
    }
    var pick = list[activeIdx];
    url = pick.url;
    headers = pick.headers || null;
    var isHls = /\.m3u8(\?|#|$)/i.test(url);
    // 调试钩子：自动化断言用（只读，不参与播放逻辑）
    window.__VP = window.__VP || { last: null };
    window.__VP.last = { url: url, headers: headers || null, lines: list.length, isHls: isHls };

    var wrap = document.createElement('div');
    wrap.className = 'vplayer-wrap';
    var linesHtml = '';
    if (list.length > 1) {
      linesHtml = '<div class="vplayer__lines" style="margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">';
      for (var li = 0; li < list.length; li++) {
        linesHtml += '<button class="btn btn--tiny' + (li === activeIdx ? ' btn--primary' : '') +
          '" data-vline="' + li + '">线路 ' + (li + 1) + '</button>';
      }
      linesHtml += '</div>';
    }
    wrap.innerHTML =
      '<video id="vplayer" controls playsinline></video>' +
      '<p class="vplayer__title">本章视频 · <span>加载中…</span></p>' +
      linesHtml +
      '<div class="vplayer__err" hidden><p>视频加载失败（可能已失效/防盗链）</p>' +
      '<button class="btn btn--tiny" data-retry>重试</button></div>' +
      '<div class="chapter-nav" style="margin-top:14px">' +
      '<button class="btn btn--primary" data-vnext>下一章</button></div>';
    wrap.querySelector('[data-retry]').onclick = function () {
      wrap.querySelector('.vplayer__err').hidden = true;
      loadVideo(url, ci, key, wrap, headers, list, activeIdx);
    };
    wrap.querySelector('[data-vnext]').onclick = function () { goChapter(1); };
    loadVideo(url, ci, key, wrap, headers, list, activeIdx);
    return wrap;
  }

  function loadVideo(url, ci, key, wrap, headers, list, activeIdx) {
    var video = wrap.querySelector('#vplayer');
    var stat = wrap.querySelector('.vplayer__title span');
    var err = wrap.querySelector('.vplayer__err');
    var state = {
      url: url, video: video, hls: null, progTimer: null, bookId: key,
      ci: ci, headers: headers || null, lines: list || null,
      activeIdx: activeIdx || 0, blobUrl: null
    };
    vplayerState = state;
    var hasHeaders = !!(headers && Object.keys(headers).length);
    var showErr = function (msg) {
      if (vplayerState !== state) return;
      if (msg && stat) stat.textContent = msg;
      if (err) err.hidden = false;
    };
    var setState = function (m) { if (vplayerState === state && stat) stat.textContent = m; };

    video.addEventListener('loadedmetadata', function () {
      setState('就绪 · ' + (isFinite(video.duration) ? Math.round(video.duration) + ' 秒' : ''));
    });
    video.addEventListener('error', function () {
      showErr('加载失败');
      setState('加载失败');
    });
    video.addEventListener('ended', function () {
      vprogDel(key);
      toast('本章看完啦，看下一章吧');
    });
    video.addEventListener('timeupdate', function () {
      if (vplayerState !== state) return;
      vprogSave(key, video.currentTime);
    });
    // 每 5 秒补写一次进度（timeupdate 已较频繁，这里只兜底 seek 期间的进度）
    state.progTimer = setInterval(function () {
      if (vplayerState !== state || !video.currentTime) return;
      vprogSave(key, video.currentTime);
    }, 5000);

    var isHls = /\.m3u8(\?|#|$)/i.test(url);
    var saved = 0;

    var resume = function () {
      if (saved > 0 && isFinite(video.duration) && video.duration > 0) {
        if (saved < video.duration - 2) {
          video.currentTime = saved;
          toast('已恢复到上次进度');
        } else {
          vprogDel(key);
        }
        saved = 0;
      }
    };
    video.addEventListener('loadedmetadata', resume);
    vprogGet(key).then(function (v) { saved = v; if (video.duration > 0) resume(); });

    // 浏览器禁设 Referer/UA：交给宿主在 WebResourceRequested 层补（<video> 与 hls.js 都改不了）
    if (hasHeaders && window.NR && NR.platform && NR.platform.mediaHeaders) {
      try {
        var hostOf = (function(){ try { return new URL(url).hostname; } catch(e) { return String(url).split("/")[2].split(":")[0]; } })();
        if (hostOf) NR.platform.mediaHeaders([{ host: hostOf, headers: headers }]);
      } catch (e) { }
    }

    if (isHls) {
      if (window.Hls && window.Hls.isSupported()) {
        var hlsCfg = { maxBufferLength: 30 };
        if (hasHeaders) {
          // P：hls.js 的 xhrSetup 由 XhrLoader 在「open() 之前」调用（1.7.3 loadInternal），
          // 而 setRequestHeader 只允许在 open 之后——所以这里自己先 open 一次；
          // hls 的 openAndSendXhr 有 `readyState || open()` 守卫，不会重复 open。
          // m3u8 播放列表与 ts/fmp4 分片都走同一个 XhrLoader（见交付说明）
          hlsCfg.xhrSetup = function (xhr, u) {
            if (!xhr.readyState) xhr.open('GET', u, true);
            Object.keys(headers).forEach(function (k) {
              try { xhr.setRequestHeader(k, headers[k]); } catch (e) { }
            });
          };
        }
        var hls = new window.Hls(hlsCfg);
        state.hls = hls;
        hls.on(window.Hls.Events.ERROR, function (_evt, data) {
          if (data && data.fatal) showErr('加载失败');
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;   // Safari 系原生 HLS（原生管线拿不到自定义请求头）
      } else {
        showErr('当前环境不支持 m3u8');
        setState('不支持 m3u8');
      }
    } else if (hasHeaders && window.fetch) {
      // P：mp4 直连无法附带自定义头（防盗链），先 fetch 成 blob 再喂 <video>；
      // 失败（CORS/网络）回退原来的直连写法。
      var st0 = state;
      window.fetch(url, { headers: headers, credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        var bu = URL.createObjectURL(blob);
        if (vplayerState !== st0) {          // 期间已切线路/销毁：立刻回收，别泄漏
          try { URL.revokeObjectURL(bu); } catch (e) { }
          return;
        }
        st0.blobUrl = bu;
        video.src = bu;
      }).catch(function () {
        if (vplayerState !== st0) return;
        video.src = url;
      });
    } else {
      video.src = url;
    }
  }

  function chapterHTML(ci) {
    var ch = cur.chapters[ci];
    var h = '<h2 class="ch-title">' + esc(ch.t) + '</h2>';
    if (ch.text == null) {
      if (ch.error) {
        return h + '<div class="ch-note"><p>本章没加载出来：' + esc(ch.error) + '</p>' +
          '<button class="btn btn--tiny ch-retry" data-ci="' + ci + '">重试</button></div>';
      }
      remoteFill(ci);
      return h + '<div class="ch-note"><p>正在加载本章…</p></div>';
    }
    var vid = sniffVideo(ch.text);
    if (vid && vid.url) {
      // 注意：这里绝不能建 DOM 再 innerHTML 序列化 —— hls 把 MediaSource 挂在元素上，
      // 序列化只搬走属性（一个已死掉的 blob: 地址），新元素因此报 media error 4。
      return h + '<div class="vplayer-slot" data-vci="' + ci + '"></div>';
    }
    /* ---- 音频章节模式（嗅探分发：视频 → 音频 → 漫画 → 文本） ---- */
    var aud = NR.audioview ? NR.audioview.sniffAudio(ch.text, curSrcType()) : null;
    if (aud && aud.url) {
      var aw = NR.audioview.audioHTML(ci, aud.url, cur.meta.id, goChapter);
      var afrag = document.createElement('div');
      afrag.appendChild(aw);
      return h + afrag.innerHTML;
    }
    /* ---- 漫画图片章节模式（嗅探分发：视频 → 音频 → 漫画 → 文本） ---- */
    if (NR.mediaview && NR.mediaview.shouldManga(ch.text, curSrcType())) {
      return h + NR.mediaview.mangaHTML(ch, ci, curSource());
    }
    var ps = ch.text.split('\n');
    for (var i = 0; i < ps.length; i++) {
      var s = ps[i].trim();
      if (!s) continue;
      h += '<p>' + esc(s) + '</p>';
    }
    return h;
  }

  /** 把章节里的 .vplayer-slot 占位换成真播放器（必须在节点已进入文档之后调用） */
  function hydratePlayers(root) {
    var box = root || el('content');
    if (!box || !cur) return;
    var slots = box.querySelectorAll('.vplayer-slot');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.dataset.done) continue;
      var ci = parseInt(slot.dataset.vci, 10);
      var ch = cur.chapters[ci];
      if (!ch || ch.text == null) continue;
      var vid = sniffVideo(ch.text);
      if (!vid || !vid.url) continue;
      slot.dataset.done = '1';
      var vw = mountVplayer(ci, vid.url, vid.headers, vid.list);
      if (slot.parentNode) slot.parentNode.replaceChild(vw, slot);
    }
  }

  var renderFrom = -1, renderCount = 0;
  function renderRange(from, count) {
    var c = el('content');
    var n = cur.chapters.length;
    from = Math.max(0, Math.min(from, n - 1));
    var to = Math.min(n, from + count);
    var h = '';
    for (var i = from; i < to; i++) {
      h += '<section class="ch-block" data-ci="' + i + '">' + chapterHTML(i) + '</section>';
    }
    c.innerHTML = h;
    renderFrom = from; renderCount = to - from;
    hydratePlayers(c);
    c.querySelectorAll('.ch-block').forEach(function (b, i) {
      if (i > 0) b.insertAdjacentHTML('afterbegin', '<div class="ch-split"></div>');
    });
  }

  /** 末尾那一章还在加载（占位很矮）时不能继续追加，否则会一直满足「到底」而无限加章 */
  function canAppendNext() {
    var blocks = el('content').querySelectorAll('.ch-block');
    if (!blocks.length) return true;
    var last = blocks[blocks.length - 1];
    var ci = parseInt(last.dataset.ci, 10);
    var ch = cur && cur.chapters[ci];
    if (!ch) return true;
    return ch.text != null || !!ch.error;
  }

  function appendNextChapter() {
    if (renderFrom + renderCount >= cur.chapters.length) return false;
    var next = renderFrom + renderCount;
    var c = el('content');
    var sec = document.createElement('section');
    sec.className = 'ch-block';
    sec.dataset.ci = next;
    sec.innerHTML = '<div class="ch-split"></div>' + chapterHTML(next);
    // 记下视口里正在读的那个块：追加在下方不该动它，回收在视口上方会把它顶走，用实测位移补回来
    var anchor = currentBlock();
    var anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    c.appendChild(sec);
    hydratePlayers(c);
    renderCount++;
    if (renderCount > 4) { // 保持 DOM 不过大：移除最前面一章
      var first = c.querySelector('.ch-block');
      var h = first.offsetHeight;
      var wrapR = el('scrollWrap');
      // 只有确实翻过这一章（余量 240px）、且它不是正在读的那一块时才回收
      if (first !== anchor && wrapR.scrollTop > h + 240) {
        c.removeChild(first);
        renderFrom++; renderCount--;
      }
    }
    anchorFix(anchor, anchorTop);
    return true;
  }

  /** 以视口内锚点块的实际位移补偿 scrollTop：浏览器已 auto 补偿过时差值为 0，不会双重补偿 */
  function anchorFix(anchor, before) {
    if (!anchor || before == null) return;
    var d = anchor.getBoundingClientRect().top - before;
    if (Math.abs(d) >= 1) el('scrollWrap').scrollTop += d;
  }

  function currentBlock() {
    var blocks = el('content').querySelectorAll('.ch-block');
    if (!blocks.length) return null;
    var top = 70, best = blocks[0];
    for (var i = 0; i < blocks.length; i++) {
      var r = blocks[i].getBoundingClientRect();
      if (r.top <= top) best = blocks[i];
      else break;
    }
    return best;
  }

  /* ---------------- 翻页模式 ---------------- */
  function renderPageChapter(ci) {
    var inner = el('pageInner');
    inner.innerHTML = chapterHTML(ci);
    pageState.page = 0;
    replayAnim(inner, 'page-in');
    relayout();
  }

  function relayout() {
    if (settings.mode !== 'page' || !cur) return;
    var vp = el('pageViewport'), inner = el('pageInner');
    var avail = vp.parentElement.clientWidth - 52;
    var indent = 76;   // 面板两侧文字留白
    var want = settings.fontSize * settings.charsPerLine + indent;
    var colW = Math.max(220, Math.min(avail, want));
    var gap = 34;
    inner.style.width = colW + 'px';
    inner.style.columnWidth = colW + 'px';
    inner.style.columnGap = gap + 'px';
    inner.style.height = '100%';
    vp.style.width = colW + 'px';
    requestAnimationFrame(function () {
      var sw = inner.scrollWidth;
      var pages = Math.max(1, Math.round((sw + gap) / (colW + gap)));
      pageState.pages = pages;
      pageState.colW = colW; pageState.gap = gap;
      if (pageState.page >= pages) pageState.page = pages - 1;
      applyPage();
    });
  }

  function applyPage() {
    el('pageInner').style.transform = 'translateX(' + (-pageState.page * (pageState.colW + pageState.gap)) + 'px)';
    updateBottom();
  }

  function pageGo(d) {
    if (pageState.page + d < 0) {
      if (cur.meta.progress && cur.meta.progress.ci > 0) { goChapter(-1); }
      return;
    }
    if (pageState.page + d >= pageState.pages) { goChapter(1); return; }
    pageState.page += d;
    applyPage();
    saveProgress();
  }

  /* ---------------- 跳转 / 进度 ---------------- */
  function jumpTo(ci, ratio, immediate, fromTop) {
    if (!cur) return;
    destroyVplayer();   // 换章：销毁旧播放器，防后台播声音/内存泄漏
    destroyAplayer();   // 音频播放器同上（audioview.js）
    ci = Math.max(0, Math.min(cur.chapters.length - 1, ci));
    if (settings.mode === 'scroll') {
      renderRange(ci, settings.continuous ? 2 : 1);
      replayAnim(el('content'), 'chap-in');
      var blk = el('content').querySelector('[data-ci="' + ci + '"]');
      // 换章节（或本来就在章首）一律回到顶部，保证章节标题可见；
      // 恢复上次阅读位置时才保留章内比例
      var place = function () {
        var w = el('scrollWrap');
        if (fromTop || !ratio || !blk) { w.scrollTop = 0; return; }
        var wr = w.getBoundingClientRect(), br = blk.getBoundingClientRect();
        var delta = br.top - wr.top - 8;
        w.scrollTop = Math.max(0, w.scrollTop + delta + ratio * blk.offsetHeight);
      };
      // 目标章正文还没加载：此刻块只有占位高度，按比例定位会落到章首（表现为进度回跳）。
      // 记下目标比例，等 patchedChapter 补上正文后再定位一次。
      var chT = cur.chapters[ci];
      if (!fromTop && ratio && chT && chT.text == null) {
        pendingPlace = { ci: ci, ratio: ratio };
      } else {
        pendingPlace = null;
        place();
        requestAnimationFrame(place);   // 布局稳定后校准一次
      }
    } else {
      renderPageChapter(ci);
      setTimeout(function () {
        pageState.page = Math.round(ratio * (pageState.pages - 1));
        applyPage();
      }, 60);
    }
    cur.meta.progress = { ci: ci, ratio: ratio };
    pluginEmit('chapter:change', { ci: ci, ratio: ratio, total: cur.chapters.length, title: cur.title });
    lastProgValue = { ci: ci, ratio: ratio };
    lastProgScrollTop = settings.mode === 'scroll' ? el('scrollWrap').scrollTop : -1;
    updateBottom();
    if (cur.meta.remote) { primeRemote(ci, 1); primeRemote(ci + 1, 2); }
    if (!immediate) saveProgress();
  }

  function goChapter(d) {
    if (!cur) return;
    var ci = (cur.meta.progress ? cur.meta.progress.ci : 0) + d;
    if (ci < 0) { toast('已经是第一章'); return; }
    if (ci >= cur.chapters.length) { toast('已经是最后一章'); return; }
    jumpTo(ci, 0, false, true);
    saveProgress(true);
  }

  function computeProgress() {
    if (!cur) return { ci: 0, ratio: 0 };
    if (settings.mode === 'page') {
      var ci = cur.meta.progress ? cur.meta.progress.ci : 0;
      var r = pageState.pages > 1 ? pageState.page / (pageState.pages - 1) : 0;
      return { ci: ci, ratio: r };
    }
    var wrap = el('scrollWrap');
    // 容器不可见时（已返回书架）不能重算，否则会写入错误位置
    if (!wrap.clientHeight) return cur.meta.progress || { ci: 0, ratio: 0 };
    var blk = currentBlock();
    if (!blk) return cur.meta.progress || { ci: 0, ratio: 0 };
    var ci2 = parseInt(blk.dataset.ci, 10);
    var ch2 = cur.chapters[ci2];
    // 本章正文还在加载（占位块很矮），DOM 位置不可信，沿用上次进度，避免把进度写回去
    if (!ch2 || ch2.text == null) return cur.meta.progress || { ci: ci2, ratio: 0 };
    var wr = el('scrollWrap').getBoundingClientRect(), br = blk.getBoundingClientRect();
    var seen = (70 - br.top) / Math.max(1, br.height);
    seen = Math.max(0, Math.min(1, seen));
    var next = { ci: ci2, ratio: seen };
    // 没往上滚却算出更靠前的位置 → 是换章/补正文引起的布局抖动，不采纳（真回滚时 scrollTop 一定变小）
    var topNow = el('scrollWrap').scrollTop;
    if (lastProgValue && topNow >= lastProgScrollTop - 2) {
      var prevPos = lastProgValue;
      if (next.ci < prevPos.ci || (next.ci === prevPos.ci && next.ratio + 0.02 < prevPos.ratio)) {
        next = { ci: prevPos.ci, ratio: prevPos.ratio };
      }
    }
    lastProgScrollTop = topNow;
    lastProgValue = { ci: next.ci, ratio: next.ratio };
    return next;
  }

  function updateBottom() {
    if (!cur) return;
    var p = computeProgress();
    var meta = cur.meta;
    var acc = 0;
    for (var i = 0; i < p.ci && i < meta.lens.length; i++) acc += meta.lens[i];
    var cl = meta.lens[p.ci] || 0;
    acc += cl * p.ratio;
    var pctv = meta.totalChars ? Math.max(0, Math.min(1, acc / meta.totalChars)) : 0;
    var pct = Math.round(pctv * 1000) / 10;
    el('bbChapter').textContent = chapterName({ progress: p, chapterTitles: meta.chapterTitles });
    el('bbPct').textContent = pct.toFixed(1) + '%';
    if (document.activeElement !== el('bbRange')) {
      el('bbRange').value = Math.round(pctv * 1000);
      paintRange(el('bbRange'));
    }
    el('bbPage').textContent = settings.mode === 'page'
      ? (pageState.page + 1) + '/' + pageState.pages
      : (p.ci + 1) + '/' + cur.chapters.length;
    // 顶部章节实时进度条
    var bar = el('chProg').firstElementChild;
    if (bar) bar.style.width = (Math.max(0, Math.min(1, p.ratio)) * 100).toFixed(1) + '%';
  }

  function saveProgress(now) {
    if (!storageWritable()) return;
    if (!cur || view !== 'read') return;   // 离开阅读页后不再改动进度
    var p = computeProgress();
    cur.meta.progress = p;
    cur.meta.lastReadAt = Date.now();
    if (cur.meta.temp) return;             // 没入架的书不写书架/最后阅读
    var book = cur, task = readingTask;
    var doSave = function () {
      if (!storageWritable() || cur !== book || !task || !activeReading(task)) return;
      saveIndex();
      S.set(LAST, book.meta.id);
    };
    clearTimeout(saveTimer);
    if (now) doSave(); else saveTimer = setTimeout(doSave, 400);
  }

  function jumpByPercent(p) {
    if (!cur) return;
    var target = p * cur.meta.totalChars;
    var acc = 0, ci = 0;
    for (ci = 0; ci < cur.chapters.length; ci++) {
      var len = cur.chapters[ci].text.length;
      if (acc + len >= target) break;
      acc += len;
    }
    if (ci >= cur.chapters.length) ci = cur.chapters.length - 1;
    var len2 = cur.chapters[ci].text.length || 1;
    var ratio = Math.max(0, Math.min(1, (target - acc) / len2));
    jumpTo(ci, ratio);
    saveProgress(true);
  }

  /* ---------------- 目录 ---------------- */
  function renderToc() {
    if (!cur) return;
    var list = el('tocList');
    var q = (el('tocSearch').value || '').trim();
    var curCi = cur.meta.progress ? cur.meta.progress.ci : 0;
    var html = '';
    var shown = 0;
    for (var i = 0; i < cur.chapters.length; i++) {
      var t = cur.chapters[i].t;
      if (q && t.indexOf(q) < 0) continue;
      shown++;
      html += '<div class="toc-item' + (i === curCi ? ' active' : '') + '" data-ci="' + i + '">' +
        '<span class="n">' + (i + 1) + '</span><span class="t">' + esc(t) + '</span></div>';
    }
    if (!shown) html = '<div class="toc-empty">没有匹配的章节</div>';
    list.innerHTML = html;
    el('tocCount').textContent = cur.chapters.length + ' 章';
    each(list.children, function (it) {
      it.onclick = function () {
        var ci = parseInt(it.dataset.ci, 10);
        if (isNaN(ci)) return;
        jumpTo(ci, 0, false, true);
        saveProgress(true);
        closeDrawer('toc');
      };
    });
    var act = list.querySelector('.toc-item.active');
    if (act) act.scrollIntoView({ block: 'center' });
  }

  function openDrawer(name) { el(name + 'Drawer').classList.add('open'); }
  function closeDrawer(name) {
    el(name + 'Drawer').classList.remove('open');
    if (name === 'set' && el('setDrawer')) el('setDrawer').classList.remove('set--limited');
  }

  /* ---------------- 设置：左栏分组切换 ---------------- */
  var setPane = 'read';
  function showSetPane(name) {
    var nav = el('setNav');
    if (!nav) return;
    var items = nav.querySelectorAll('.set-nav__item');
    var exists = false;
    each(items, function (b) { if (b.dataset.pane === name) exists = true; });
    if (!exists) name = 'read';
    each(items, function (b) { b.classList.toggle('on', b.dataset.pane === name); });
    each(document.querySelectorAll('#setBody .pane'), function (p) {
      p.classList.toggle('on', p.dataset.pane === name);
    });
    setPane = name;
    if (el('setPaneTitle')) {
      var cur = nav.querySelector('.set-nav__item.on');
      el('setPaneTitle').textContent = cur ? cur.textContent : '';
    }
    if (el('setBody')) el('setBody').scrollTop = 0;
    paintRanges();          // 隐藏的 pane 里 range 也要算好填充比例
    if (name === 'data') refreshCacheInfo();
  }

  /* ---------------- 缓存目录（封面） ---------------- */
  function humanSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function paintCacheInfo(info) {
    var path = el('cacheCoverPath');
    var stat = el('cacheCoverStat');
    if (!info) {
      if (path) path.textContent = '只有桌面版能改缓存目录';
      if (stat) stat.textContent = '';
      return;
    }
    if (path) path.textContent = info.dir || '—';
    if (stat) {
      stat.textContent = (info.count || 0) + ' 个文件 · ' + humanSize(info.size) +
        (info.custom ? ' · 自定义位置' : ' · 默认位置');
    }
  }

  function refreshCacheInfo() {
    var pf = global.NR.platform;
    if (!pf || !pf.cacheDir) { paintCacheInfo(null); return; }
    Promise.resolve(pf.cacheDir()).then(paintCacheInfo, function () { paintCacheInfo(null); });
  }

  function applyCacheDir(dir) {
    var pf = global.NR.platform;
    if (!pf || !pf.setCacheDir) return;
    pf.setCacheDir(dir).then(function (info) {
      paintCacheInfo(info);
      toast(dir ? '封面缓存目录已改到新位置' : '封面缓存已恢复默认位置');
    }).catch(function (e) {
      toast('改不了这个目录：' + ((e && e.message) || '权限不足'));
    });
  }

  function bindCacheSettings() {
    var pf = global.NR.platform;
    if (el('btnCachePick')) el('btnCachePick').onclick = function () {
      if (!pf || !pf.pickFolder) return;
      pf.pickFolder('选择封面缓存目录').then(function (dir) {
        if (dir) applyCacheDir(dir);
      }).catch(function () { });
    };
    if (el('btnCacheOpen')) el('btnCacheOpen').onclick = function () {
      if (!pf || !pf.openFolder) return;
      pf.cacheDir().then(function (info) {
        if (info && info.dir) pf.openFolder(info.dir);
      }).catch(function () { });
    };
    if (el('btnCacheDefault')) el('btnCacheDefault').onclick = function () { applyCacheDir(''); };
    if (el('btnCacheClear')) el('btnCacheClear').onclick = function () {
      if (!pf || !pf.clearCache) return;
      pf.clearCache().then(function (info) {
        paintCacheInfo(info);
        toast('已清空封面缓存（' + ((info && info.removed) || 0) + ' 个文件）');
      }).catch(function (e) {
        toast('清不掉：' + ((e && e.message) || '文件被占用'));
      });
    };
  }
  /* ---------------- 手机端：阅读设置底部抽屉 ---------------- */
  var rsheetOpenFlag = false;
  var autoScrollTimer = null;

  function rsheetSync() {
    var caps = function (id, cur2) {
      var box = el(id); if (!box) return;
      each(box.querySelectorAll('button'), function (b) {
        b.classList.toggle('on', String(b.dataset.val) === String(cur2));
      });
    };
    if (el('rsFontVal')) el('rsFontVal').textContent = settings.fontSize;
    var fbox = el('rsFontCaps');
    if (fbox) each(fbox.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.font === settings.font);
    });
    caps('rsLineCaps', settings.lineHeight);
    caps('rsPadCaps', settings.pad);
    caps('rsParaCaps', settings.paraGap);
    var modeBox = el('rsModeCaps');
    if (modeBox) each(modeBox.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.mode === settings.mode && String(b.dataset.tap) === (settings.tapTurn ? '1' : '0'));
    });
    if (el('rsAutoScroll')) el('rsAutoScroll').checked = !!settings.autoScroll;
    if (el('rsSpeedVal')) el('rsSpeedVal').textContent = (settings.autoScrollSpeed || 1).toFixed(1);
    var th = el('rsThemes');
    if (th && global.NR.theme && !th.children.length) {
      var cur2 = global.NR.theme.current();
      th.innerHTML = global.NR.theme.list().map(function (t) {
        return '<button type="button" class="rsheet__sw' + (t.id === cur2 ? ' on' : '') + '" data-ui="' + t.id + '" title="' + esc(t.name) + '" style="background:' + esc(t.bg) + '"></button>';
      }).join('');
      each(th.children, function (b) {
        b.onclick = function () {
          global.NR.theme.save(b.dataset.ui);
          applySettings(); saveSettings();
          renderUiThemes();
          each(th.children, function (x) { x.classList.toggle('on', x.dataset.ui === global.NR.theme.current()); });
        };
      });
    }
    updateAutoScroll();
  }

  function openReadSetSheet() {
    var s = el('readSetSheet'); if (!s) return;
    s.hidden = false;
    rsheetSync();
    requestAnimationFrame(function () { s.classList.add('open'); });
    rsheetOpenFlag = true;
  }
  function closeReadSetSheet() {
    var s = el('readSetSheet'); if (!s) return;
    s.classList.remove('open');
    rsheetOpenFlag = false;
    setTimeout(function () { if (!rsheetOpenFlag) s.hidden = true; }, 240);
  }
  global.NR.readSetSheetOpen = function () { return rsheetOpenFlag; };
  /* ---------------- 统一的「返回上一层」栈 ----------------
     true  = 已消费（关掉了一层：抽屉/弹层/详情/子页/阅读页…）
     false = 已经在各视图的最上级
     返回键（宿主 MainActivity）拿到 false 就直接退出应用；
     以前这里对非书架视图一律 switchView('shelf')，于是「不管从哪返回都回书架」。 */
  function backStep() {
    try {
      if (rsheetOpenFlag) { closeReadSetSheet(); return true; }
      var toc = el('tocDrawer'); if (toc && toc.classList.contains('open')) { closeDrawer('toc'); return true; }
      var sd = el('setDrawer'); if (sd && sd.classList.contains('open')) { closeDrawer('set'); return true; }
      // 归入分组小窗（hidden 控制）
      var aov = document.getElementById('assignOverlay');
      if (aov && !aov.hidden) { aov.hidden = true; return true; }
      if (document.querySelector('.cmodal.show, .modal.show')) { closeModal(); return true; }
      // 插件管理面板（接管了「我的」页，退出时要还原，不能只删节点）
      if (global.NR.plugins && global.NR.plugins.closeManager && global.NR.plugins.closeManager()) return true;
      // 视频播放页
      if (global.NR.video && global.NR.video.state && global.NR.video.state().open) { global.NR.video.close(); return true; }
      // 插件页面：先让插件自己退一层（详情 → 列表）；
      // 退不动就说明已经在该插件的最上级，直接返回 false 交给宿主退出应用
      if (String(view).indexOf('plg:') === 0) {
        if (global.NR.plugins && typeof global.NR.plugins.back === 'function') {
          var plgDone = false;
          try { plgDone = !!global.NR.plugins.back(); } catch (e) { plgDone = false; }
          if (plgDone) return true;
        }
        return false;
      }
      // 阅读页 → 回到「从哪本书进来的」那一页（readerReturnView）
      if (view === 'read') { backToShelf(); return true; }
      // 发现页 / 书城：详情、搜索结果都在 online 模块里，逐级退
      if (view === 'online' || view === 'bookstore') {
        if (global.NR.online && global.NR.online.back && global.NR.online.back()) return true;
        return false;
      }
      // 我的：书源管理内部的二级页 → 我的子页 → 我的最上级
      if (view === 'mine') {
        if (global.NR.sourcePaneBack && global.NR.sourcePaneBack()) return true;
        if (closeMinePane()) return true;
        return false;
      }
    } catch (e) { /* 兜底交给宿主 */ }
    return false;
  }
  // Android 硬件返回键（宿主 MainActivity 调 NR.androidBack()）
  global.NR.androidBack = function () { return backStep(); };
  global.NR.backStep = backStep;

  function updateAutoScroll() {
    if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; }
    if (!settings.autoScroll || view !== 'read' || settings.mode !== 'scroll') return;
    var px = Math.max(0.5, (settings.autoScrollSpeed || 1) * 0.6);
    autoScrollTimer = setInterval(function () {
      if (view !== 'read') return;
      var w = el('scrollWrap'); if (w) w.scrollTop += px;
    }, 16);
  }

  function bindReadSetSheet() {
    var s = el('readSetSheet'); if (!s) return;
    if (el('rsheetMask')) el('rsheetMask').onclick = closeReadSetSheet;
    if (el('rsheetClose')) el('rsheetClose').onclick = closeReadSetSheet;
    if (el('btnReadSetM')) el('btnReadSetM').onclick = openReadSetSheet;
    if (el('rsFontMinus')) el('rsFontMinus').onclick = function () {
      settings.fontSize = Math.max(14, settings.fontSize - 1);
      applySettings(); saveSettings(); relayoutSoft(); rsheetSync();
    };
    if (el('rsFontPlus')) el('rsFontPlus').onclick = function () {
      settings.fontSize = Math.min(24, settings.fontSize + 1);
      applySettings(); saveSettings(); relayoutSoft(); rsheetSync();
    };
    var capBind = function (id, key) {
      var box = el(id); if (!box) return;
      each(box.querySelectorAll('button'), function (b) {
        b.onclick = function () {
          settings[key] = +b.dataset.val;
          applySettings(); saveSettings(); relayoutSoft(); rsheetSync();
        };
      });
    };
    var fcaps = el('rsFontCaps');
    if (fcaps) each(fcaps.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        settings.font = b.dataset.font;
        settings.fontPicked = true;
        applySettings(); saveSettings(); relayoutSoft(); rsheetSync();
      };
    });
    capBind('rsLineCaps', 'lineHeight');
    capBind('rsPadCaps', 'pad');
    capBind('rsParaCaps', 'paraGap');
    var modeBox = el('rsModeCaps');
    if (modeBox) each(modeBox.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        var m = b.dataset.mode, tap = b.dataset.tap === '1';
        var p = cur ? computeProgress() : null;
        settings.mode = m;
        settings.tapTurn = tap;
        applySettings(); saveSettings();
        switchMode();
        if (cur && p) setTimeout(function () { jumpTo(p.ci, p.ratio, true); }, 60);
        rsheetSync();
      };
    });
    if (el('rsAutoScroll')) el('rsAutoScroll').onchange = function () {
      settings.autoScroll = this.checked; saveSettings(); updateAutoScroll();
    };
    if (el('rsSpeedMinus')) el('rsSpeedMinus').onclick = function () {
      settings.autoScrollSpeed = Math.max(0.5, +((settings.autoScrollSpeed || 1) - 0.5).toFixed(1));
      saveSettings(); rsheetSync();
    };
    if (el('rsSpeedPlus')) el('rsSpeedPlus').onclick = function () {
      settings.autoScrollSpeed = Math.min(3, +((settings.autoScrollSpeed || 1) + 0.5).toFixed(1));
      saveSettings(); rsheetSync();
    };
  }

  function openSettings(pane, limited) {
    if (el('setDrawer')) el('setDrawer').classList.toggle('set--limited', !!limited);
    openDrawer('set');
    showSetPane(pane || setPane || 'read');
  }

  /* ---------------- 我的：页内设置子页（抽屉与子页共用同一份 #setBody） ----------------
     只有一份设置 DOM：打开子页时把 #setBody 移动到 #mineDetailBody，
     返回/离开「我的」时再搬回抽屉里的原父节点（bodyHome），绝不 clone。 */
  var minePane = '';          // 当前打开的子页名（'' = 列表态）
  var bodyHome = null;        // #setBody 在设置抽屉里的原父节点
  var MINE_PANE_TITLES = {
    read: '阅读设置', look: '外观设置', shelf: '书架设置', search: '搜索设置',
    behavior: '行为设置', data: '数据与备份', about: '关于 iread'
  };

  /** 书源管理子页：把 #sourcePanel 搬进详情区（与设置面板同一套「移动不克隆」策略） */
  var sourceHome = null;
  function openSourcePane() {
    var panel = el('sourcePanel');
    var mount = el('mineDetailBody');
    var host = el('sourceHost');
    if (!panel || !mount || !host) return false;
    if (view !== 'mine') paintView('mine');
    if (!sourceHome) sourceHome = host;
    // 设置面板若还挂在详情区，先让它回抽屉
    var body = el('setBody');
    if (body && body.parentNode === mount) (bodyHome || body.parentNode).appendChild(body);
    mount.appendChild(panel);
    var scroll = document.querySelector('.mine-scroll');
    if (scroll) scroll.scrollTop = 0;
    minePane = 'sources';
    if (el('mineDetailTitle')) el('mineDetailTitle').textContent = '书源管理';
    if (el('mineList')) el('mineList').classList.add('hidden');
    if (el('mineDetail')) el('mineDetail').classList.remove('hidden');
    return true;
  }
  function closeSourcePane() {
    var panel = el('sourcePanel');
    if (!panel || !sourceHome || panel.parentNode === sourceHome) return;
    sourceHome.appendChild(panel);
  }
  global.NR.sourcePaneOpen = function () { return minePane === 'sources'; };
  global.NR.openSourcePane = openSourcePane;

  function openMinePane(pane) {
    if (pane === 'sources') {
      if (global.NR.online && global.NR.online.openSources) global.NR.online.openSources();
      else openSourcePane();
      return;
    }
    var body = el('setBody');
    var mount = el('mineDetailBody');
    var list = el('mineList');
    var detail = el('mineDetail');
    if (!body || !mount || !list || !detail) return;   // 结构未就绪时不做事
    // 插件面板不走设置面板：plugins.js 自己渲染进 #mineDetailBody
    if (pane === 'plugins' && global.NR.plugins && global.NR.plugins.openManager) {
      global.NR.plugins.openManager();
      return;
    }
    if (view !== 'mine') paintView('mine');
    if (!bodyHome) bodyHome = body.parentNode;
    if (body.parentNode !== mount) mount.appendChild(body);
    minePane = MINE_PANE_TITLES[pane] ? pane : 'read';
    showSetPane(minePane);                              // 复用抽屉的切 pane 逻辑
    if (el('mineDetailTitle')) el('mineDetailTitle').textContent = MINE_PANE_TITLES[minePane];
    list.classList.add('hidden');
    detail.classList.remove('hidden');
  }

  /** 关闭子页并还原 DOM；未打开时是空操作（幂等：paintView 会反复调用它） */
  function closeMinePane() {
    if (global.NR.plugins && global.NR.plugins.closeManager) global.NR.plugins.closeManager();
    if (!minePane) return false;
    if (minePane === 'sources') closeSourcePane();
    minePane = '';
    var body = el('setBody');
    if (body && bodyHome && body.parentNode !== bodyHome) bodyHome.appendChild(body);
    if (el('mineDetail')) el('mineDetail').classList.add('hidden');
    if (el('mineList')) el('mineList').classList.remove('hidden');
    return true;
  }

  /* ---------------- 常亮 ---------------- */
  function updateWakeLock() {
    var want = settings.keepAwake && view === 'read';
    if (want && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function (l) {
        wakeLock = l;
      }).catch(function () { });
    } else if (wakeLock) {
      try { wakeLock.release(); } catch (e) { }
      wakeLock = null;
    }
  }

  /* ---------------- 事件 ---------------- */
  var binded = false;
  function bind() {
    if (binded) return;
    binded = true;
    el('btnImport').onclick = importBooks;
    if (el('btnImportEmpty')) el('btnImportEmpty').onclick = importBooks;
    var pf = global.NR.platform;
    if (pf && pf.onMenuImport) pf.onMenuImport(importBooks);   // 菜单 / Ctrl+O
    el('fileInput').onchange = function () {
      handleFiles(this.files);
      this.value = '';
    };

    // 拖拽导入（带一圈"松手就导入"的提示）
    var dragDepth = 0;
    document.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('dragleave', function (e) {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging');
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    el('btnBack').onclick = backToShelf;
    bindReadSetSheet();
    if (el('btnBookdBack')) el('btnBookdBack').onclick = closeBookDetail;

    /* 右键菜单：点空白 / 滚动 / Esc 都关掉 */
    document.addEventListener('mousedown', function (e) {
      var m = el('ctxMenu');
      if (!m || m.hidden) return;
      if (!m.contains(e.target)) hideCtxMenu();
    }, true);
    document.addEventListener('scroll', hideCtxMenu, true);
    window.addEventListener('resize', hideCtxMenu);
    window.addEventListener('blur', hideCtxMenu);
    /* 阅读器顶栏自动隐藏功能已删除（2025-XX 全局功能变更） */
    bindTapTurn();
    el('btnToc').onclick = function () { renderToc(); openDrawer('toc'); };
    el('fabToc').onclick = function () { renderToc(); openDrawer('toc'); };
    el('btnSetRead').onclick = function () {
      if (MOBILE_UI) { openReadSetSheet(); }
      else { openSettings('read', true); }
    };
    if (el('setNav')) each(el('setNav').querySelectorAll('.set-nav__item'), function (b) {
      b.onclick = function () { showSetPane(b.dataset.pane); };
    });
    if (el('btnSwitchSrc')) el('btnSwitchSrc').onclick = pickSource;
    if (el('btnTocSwitch')) el('btnTocSwitch').onclick = pickSource;
    if (el('btnAddCur')) el('btnAddCur').onclick = function () { addCurrentToShelf(); };

    // 主导航：点击任一真实按钮后展开侧栏并切换视图。
    each(document.querySelectorAll('.nav__tab'), function (b) {
      b.onclick = function () { setNavExpanded(true); switchView(b.dataset.view); };
    });
    // 书源管理：直接进子页（先加载书源再渲染）；其余行仍走 #mineList 的委托
    if (el('mineSources')) el('mineSources').onclick = function () {
      if (global.NR.online && global.NR.online.openSources) global.NR.online.openSources();
      else openSourcePane();
    };
    // 「我的」里的设置入口 → 页内子页（不再弹右侧抽屉）；行按钮事件委托，ui-visual 静态渲染即可
    // 手机端：阅读设置挪进阅读页内抽屉，「我的」列表里不再出现该入口
    if (MOBILE_UI && el('mineList')) {
      var readRow = el('mineList').querySelector('[data-mine-pane="read"]');
      if (readRow) readRow.hidden = true;
    }
    if (el('mineList')) el('mineList').addEventListener('click', function (e) {
      var t = e.target;
      var row = t && t.closest ? t.closest('[data-mine-pane]') : null;
      if (!row) return;
      openMinePane(row.dataset.minePane);
    });
    if (el('mineBack')) el('mineBack').onclick = function () {
      // 书源管理有自己的子页层级：先让它在内部回退，退到入口列表后再关整页
      if (global.NR.sourcePaneBack && global.NR.sourcePaneBack()) return;
      closeMinePane();
    };
    bindCacheSettings();

    // 在线章节加载失败 → 重试（事件委托，章节块会被重绘）
    document.addEventListener('click', function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('.ch-retry') : null;
      if (!btn) return;
      var ci = parseInt(btn.dataset.ci, 10);
      if (!cur || !cur.chapters[ci]) return;
      cur.chapters[ci].error = '';
      primeRemote(ci, 1);
      patchChapter(ci);
    });

    each(document.querySelectorAll('[data-close]'), function (b) {
      b.onclick = function () { closeDrawer(b.dataset.close); };
    });
    el('tocSearch').oninput = debounce(renderToc, 150);

    el('btnPrevCh').onclick = function () { goChapter(-1); };
    el('btnNextCh').onclick = function () { goChapter(1); };

    // 滚动
    var wrap = el('scrollWrap');
    var ticking = false;
    wrap.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        updateBottom();
        saveProgress();
        if (settings.continuous) {
          if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 400 && canAppendNext()) {
            appendNextChapter();
          }
        }
      });
    });

    // 翻页点击
    el('hitLeft').onclick = function () { pageGo(-1); };
    el('hitRight').onclick = function () { pageGo(1); };
    // 翻页滑动
    var sx = 0, sy = 0;
    el('pageWrap').addEventListener('touchstart', function (e) {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    el('pageWrap').addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) pageGo(dx < 0 ? 1 : -1);
    });

    // 进度条
    el('bbRange').oninput = function () {
      el('bbPct').textContent = (this.value / 10).toFixed(1) + '%';
    };
    el('bbRange').onchange = function () { jumpByPercent(this.value / 1000); };
    document.addEventListener('input', function (e) {
      if (e.target && e.target.type === 'range') paintRange(e.target);
    }, true);
    // 设置
    el('sFont').oninput = function () { settings.fontSize = +this.value; applySettings(); saveSettings(); relayoutSoft(); };
    el('sWidth').oninput = function () { settings.charsPerLine = +this.value; applySettings(); saveSettings(); relayoutSoft(); };
    el('sLine').oninput = function () { settings.lineHeight = +this.value; applySettings(); saveSettings(); relayoutSoft(); };
    el('sPara').oninput = function () { settings.paraGap = +this.value; applySettings(); saveSettings(); relayoutSoft(); };
    if (el('sBright')) {
      el('sBright').oninput = function () {
        settings.brightness = +this.value;
        applySettings();
        saveSettings();
      };
    }
    each(el('fontChips').children, function (b) {
      b.onclick = function () { settings.font = b.dataset.font; settings.fontPicked = true; applySettings(); saveSettings(); relayoutSoft(); };
    });
    each(el('modeChips').children, function (b) {
      b.onclick = function () {
        var m = b.dataset.mode;
        if (m === settings.mode) return;
        var p = cur ? computeProgress() : null;
        settings.mode = m;
        applySettings(); saveSettings();
        switchMode();
        if (cur && p) setTimeout(function () { jumpTo(p.ci, p.ratio, true); }, 60);
      };
    });
    each(document.querySelectorAll('[data-step]'), function (b) {
      b.onclick = function () {
        var k = { fontSize: 'fontSize' }[b.dataset.step];
        settings[k] = Math.max(14, Math.min(34, settings[k] + (+b.dataset.delta)));
        applySettings(); saveSettings(); relayoutSoft();
      };
    });
    el('sContinuous').onchange = function () {
      settings.continuous = this.checked; saveSettings();
      if (cur && settings.mode === 'scroll') {
        var p = computeProgress();
        jumpTo(p.ci, p.ratio, true);
        el('chapterNav').classList.toggle('hidden', settings.continuous);
      }
    };
    el('sAutoResume').onchange = function () { settings.autoResume = this.checked; saveSettings(); };
    el('sKeepAwake').onchange = function () { settings.keepAwake = this.checked; saveSettings(); updateWakeLock(); };
    if (el('sTapTurn')) el('sTapTurn').onchange = function () { settings.tapTurn = this.checked; saveSettings(); };
    if (el('sVideoSharpen')) el('sVideoSharpen').onchange = function () { settings.videoSharpen = this.checked; saveSettings(); if (NR.video && NR.video.applySharpen) NR.video.applySharpen(); };
    if (el('sAdSkip')) el('sAdSkip').onchange = function () { settings.adSkip = this.checked; saveSettings(); };
    if (el('sShowCover')) el('sShowCover').onchange = function () { settings.showCover = this.checked; saveSettings(); renderShelf(); };
    bindChipGroup('layoutChips', 'layout', function (v) { settings.libraryLayout = v; saveSettings(); renderShelf(); });
    if (el('sTray')) el('sTray').onchange = function () {
      settings.trayOnClose = this.checked; saveSettings();
      var pf = global.NR.platform;
      if (pf && pf.setTrayMode) pf.setTrayMode(this.checked);
    };
    if (el('sAutoPurge')) el('sAutoPurge').onchange = function () { settings.autoPurge = this.checked; saveSettings(); };
    if (el('sStartLogin')) {
      settings.startAtLogin = false;
      el('sStartLogin').checked = false;
      el('sStartLogin').disabled = true;
      el('sStartLogin').title = '当前外壳不支持设置开机启动';
    }
    if (el('sPad')) el('sPad').oninput = function () {
      settings.pad = +this.value; applySettings(); saveSettings(); relayoutSoft();
    };
    bindChipGroup('indentChips', 'indent', function (v) { settings.indent = +v; applySettings(); saveSettings(); relayoutSoft(); });
    bindChipGroup('letterChips', 'letter', function (v) { settings.letter = +v; applySettings(); saveSettings(); relayoutSoft(); });
    bindChipGroup('weightChips', 'weight', function (v) { settings.weight = +v; applySettings(); saveSettings(); relayoutSoft(); });
    bindChipGroup('animChips', 'anim', function (v) { settings.pageAnim = v; applySettings(); saveSettings(); });
    bindChipGroup('sortChips', 'sort', function (v) { settings.sortBy = v; saveSettings(); renderShelf(); });
    bindChipGroup('timeoutChips', 'timeout', function (v) { settings.searchTimeout = +v; saveSettings(); });
    bindChipGroup('concChips', 'conc', function (v) { settings.searchConcurrency = +v; saveSettings(); });
    bindChipGroup('limitChips', 'limit', function (v) { settings.resultLimit = +v; saveSettings(); });
    if (el('sMotion')) el('sMotion').onchange = function () {
      settings.motion = this.checked;
      saveSettings();
      applySettings();
      if (this.checked) { fadeView(view === 'read' ? el('readView') : el('shelfView')); renderShelf(); }
    };

    if (el('btnOpenData')) el('btnOpenData').onclick = function () {
      var pf = global.NR.platform;
      if (pf && pf.openUserData) pf.openUserData();
      else toast('只有桌面版能打开数据目录');
    };
    if (el('btnDisclaimer')) el('btnDisclaimer').onclick = function () {
      NR.ui.confirm(DISCLAIMER_TEXT, null, '我知道了');
    };
    /* P：壳上下文——法律文本按壳（Electron / WebView2）生成准确的数据目录与组件清单 */
    function shellCtx() {
      var pf = global.NR.platform;
      return (pf && pf.info ? pf.info() : Promise.resolve(null)).then(function (info) {
        return {
          info: info,
          isWV2: !!(info && info.electron === 'none (WebView2 shell)'),
          dataDir: (info && info.userData && info.userData !== 'spike') ? info.userData : ''
        };
      }).catch(function () { return { info: null, isWV2: false, dataDir: '' }; });
    }

    /* P：关于 iread——重写为结构化产品信息（长文档弹层，可滚动） */
    function aboutText(ctx) {
      var info = ctx.info || {};
      var v = info.version || '1.0.0-plugin.1';
      var lines = ['版本 ' + v, ''];
      lines.push(
        '产品简介',
        'iread 是一款完全在本机运行的免费阅读器。支持本地 TXT / EPUB 直接打开，',
        '支持部分 Legado 规则的在线阅读；漫画与音频链路尚未完成兼容验证，具体边界请查看书源能力提示。',
        ''
      );
      if (ctx.isWV2) {
        lines.push(
          '运行环境',
          '  · 外壳：WebView2（WinForms 宿主）',
          '  · 内核：Chromium ' + (info.chrome || '（版本获取失败）') + '（Microsoft Edge WebView2 Runtime）',
          ''
        );
      } else {
        lines.push(
          '运行环境',
          '  · 外壳：Electron ' + (info.electron || ''),
          '  · 内核：Chromium ' + (info.chrome || ''),
          ''
        );
      }
      lines.push(
        '数据与隐私',
        '书架、阅读进度、书源与设置全部保存在本机' + (ctx.dataDir ? '：\n  ' + ctx.dataDir : '。'),
        '无账号、无遥测、无广告，不主动向开发者上传书架与配置；第三方书源仍会联网。详见「隐私政策」。',
        ''
      );
      lines.push(
        '版权与免责声明',
        '本软件不自带书籍、不运营内容分发服务；导入或获取的正文与缓存保存在本机，',
        '内容版权归原作者或发布方所有。请支持正版，并仅将本软件用于个人学习与研究。',
        ''
      );
      lines.push(
        '开源信息',
        '本项目代码以 MIT 许可发布；规则引擎移植自 Legado（GPL-3.0），许可边界见',
        '「开源许可」第四节与仓库 THIRD-PARTY-NOTICES.md。'
      );
      return lines.join('\n');
    }

    if (el('btnPrivacy')) el('btnPrivacy').onclick = function () {
      var L = global.NR.legal;
      uiDoc('隐私政策', (L && L.privacy) || '隐私政策文本缺失，请查看仓库 PRIVACY.md。', '关闭');
    };
    if (el('btnLicenses')) el('btnLicenses').onclick = function () {
      var L = global.NR.legal;
      uiDoc('开源许可', (L && L.licenses) || '开源许可文本缺失，请查看仓库 THIRD-PARTY-NOTICES.md。', '关闭');
    };
    if (el('btnAbout')) el('btnAbout').onclick = function () {
      shellCtx().then(function (ctx) { uiDoc('关于 iread', aboutText(ctx), '关闭'); });
    };
    setTimeout(function () {
      var pf = global.NR.platform;
      if (pf && pf.info && el('setVersion')) {
        pf.info().then(function (info) {
          if (info && info.version && el('setVersion')) el('setVersion').textContent = 'v' + info.version;
        }).catch(function () { });
      }
    }, 600);
    el('btnExportCfg').onclick = function () {
      var json = JSON.stringify(settings, null, 2);
      var pf = global.NR.platform;
      if (pf && pf.isDesktop) {
        pf.saveText('iread设置.json', json).then(function (r) {
          if (r && !r.canceled) toast('设置已导出');
        }).catch(function (e) { toast('导出失败：' + (e.message || e)); });
        return;
      }
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'iread设置.json';
      a.click();
      toast('设置已导出');
    };
    el('btnWipe').onclick = function () {
      if (!confirm('将清空书架上的全部书籍和阅读进度，且无法恢复。确定？')) return;
      deleteBooks(null).catch(deleteFailed);
    };

    // 键盘
    document.addEventListener('keydown', function (e) {
      if (!storageWritable()) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault(); importBooks(); return;
      }
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      var k = e.key;
      if (k === 'Escape') { backStep(); return; }
      if (view !== 'read') return;
      if (k === 'ArrowLeft') { settings.mode === 'page' ? pageGo(-1) : goChapter(-1); e.preventDefault(); }
      else if (k === 'ArrowRight') { settings.mode === 'page' ? pageGo(1) : goChapter(1); e.preventDefault(); }
      else if (k === ' ' && settings.mode === 'page') { pageGo(1); e.preventDefault(); }
      else if (k === '+' || k === '=') { settings.fontSize = Math.min(34, settings.fontSize + 1); applySettings(); saveSettings(); relayoutSoft(); }
      else if (k === '-' || k === '_') { settings.fontSize = Math.max(14, settings.fontSize - 1); applySettings(); saveSettings(); relayoutSoft(); }
      else if (k === 't' || k === 'T') { renderToc(); openDrawer('toc'); }
      else if (k === 's' || k === 'S') { openSettings(); }
    });

    window.addEventListener('resize', debounce(function () {
      if (settings.mode === 'page') { var r = pageState.pages > 1 ? pageState.page / (pageState.pages - 1) : 0; relayout(); setTimeout(function () { pageState.page = Math.round(r * (pageState.pages - 1)); applyPage(); }, 80); }
    }, 150));

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) saveProgress(true);
    });
    window.addEventListener('beforeunload', function () { saveProgress(true); });
  }

  function relayoutSoft() {
    if (settings.mode !== 'page' || !cur) return;
    var r = pageState.pages > 1 ? pageState.page / (pageState.pages - 1) : 0;
    relayout();
    setTimeout(function () {
      pageState.page = Math.round(r * (pageState.pages - 1));
      applyPage();
    }, 90);
  }

  /* ---------------- 启动 ---------------- */
  var booted = false;
  function finishBoot() {
    if (booted) return;
    applySettings(); renderUiThemes(); bind(); paintView(view); renderShelf(); loading(false);
    // 默认视图可能不是书架（当前默认发现页），启动时按 state 进入一次
    if (view === 'online' && global.NR.online && global.NR.online.enter) { fadeView(el('onlineView')); global.NR.online.enter(); }
    else if (view === 'bookstore' && global.NR.bookstore && global.NR.bookstore.enter) { fadeView(el('bookstoreView')); global.NR.bookstore.enter(); }
    else if (view === 'mine') { fadeView(el('mineView')); }
    booted = true;
    if (settings.trayOnClose && global.NR.platform && global.NR.platform.setTrayMode) {
      global.NR.platform.setTrayMode(true);
    }
  }
  /* ---------------- 全局兜底：任何未捕获异常都提示，不让窗口静默卡死 ---------------- */
  var errShownAt = 0;
  function reportError(msg) {
    var now = Date.now();
    if (now - errShownAt < 4000) return;      // 同一个错误刷屏只提示一次
    errShownAt = now;
    try { toast('出了点问题：' + msg); } catch (e) { }
    try { console.error('[nr]', msg); } catch (e2) { }
  }
  window.addEventListener('error', function (e) {
    reportError((e && e.message) || '脚本错误');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    reportError((r && (r.message || r)) || '异步任务失败');
  });

  async function boot() {
    dataTools.wire();
    dataTools.updateStatus({ blocked: true, error: '' });
    // 声明只依赖静态 DOM。不要用全屏 loading 遮住声明或存储恢复入口。
    loading(false);
    var disclaimer = showDisclaimer();
    disclaimer.catch(function (e) { reportError(e.message || e); });
    try {
      await S.init();
      // 存储层自己会修复（跳过外来键 / 搬走损坏元数据 / 极端情况降级到 localStorage）。
      // 这里只把结果告诉用户，别让它静默发生。
      var storeState = S.status();
      if (storeState.degraded) {
        toast('数据库暂时打不开，已切换到本地存储，书架和设置仍可正常读写');
      } else if (storeState.repaired) {
        toast('已自动修复存储异常（' + (storeState.foreign.length ? '清理了 ' + storeState.foreign.length + ' 条外来键' : '重建了元数据') + '）');
      }
      if (!S.status().writable) {
        dataTools.updateStatus();
        rejectStorage(new Error('存储不可写入，请先解决冲突或重试'));
        return;
      }
      await NR.readingStats.init({ store: S, onChange: renderReadingStats });
      // 原先的 inline boot 被 CSP 拦截；此处在任何应用设置读取之前初始化主题。
      if (global.NR.theme) global.NR.theme.boot();
      var cfg = await S.get(CFG);
      if (cfg) settings = Object.assign({}, DEFAULTS, cfg);
      if (cfg && cfg.compact && !cfg.libraryLayout) settings.libraryLayout = 'double';
      /* 手机端字体默认「圆黑」：没手动挑过字体的老配置，一次性从桌面默认的宋体迁过来 */
      if (MOBILE_UI && !settings.fontPicked && (!settings.font || settings.font === 'serif')) {
        settings.font = 'hei2';
        settings.fontPicked = true;
        S.set(CFG, settings);
      }
      // 手机首次升级：把桌面那套排版换成手机上更舒服的一套（只做一次，之后完全听用户的）
      if (MOBILE_UI && !settings.mobileTuned) {
        settings.fontSize = 19;
        settings.lineHeight = 200;
        settings.paraGap = 90;
        settings.pad = 18;
        if (settings.tapTurn == null || settings.tapTurn === false) settings.tapTurn = true;
        if (!settings.libraryLayout || settings.libraryLayout === 'single') settings.libraryLayout = 'double';
        settings.mobileTuned = true;
        S.set(CFG, settings);
      }
      var idx = await S.get(IDX);
      if (idx !== null && !Array.isArray(idx)) throw new Error('书架数据格式异常，请重试或恢复备份');
      index = idx || [];
      if (!S.status().writable) throw new Error('初始化期间存储已暂停，请重试');
      dataTools.updateStatus({ blocked: false, error: '' });
      finishBoot();
      resolveStorage();
      // 声明必须等存储就绪后再收尾，避免抢 frModal。
      await disclaimer;
      if (!storageWritable()) return;
      // 首次引导教程已移除（只保留用户须知）。
      if (settings.autoResume && storageWritable()) {
        var id = await S.get(LAST);
        if (id && view === 'shelf') openBook(id);
      }
    } catch (e) {
      rejectStorage(e);
      loading(false);
      dataTools.updateStatus({ blocked: !booted, error: e });
      console.error('[nr] boot:', e);
      toast('初始化异常：' + (e.message || e));
    }
  }

  /* ---------------- 首启：用户须知 + 引导教程 ----------------
   * 复用 frModal（index.html 静态结构 + base.css 样式）。
   * 须知：每次启动都无条件弹，单按钮「我已知晓」，纯告知不设同意/退出分支。
   * 两个壳共用渲染层，e 版同样生效。 */
  function frClose() {
    var m = el('frModal');
    if (m) m.hidden = true;
  }

  /* 用户须知「下次不再弹出」：标记放在 localStorage 里，
     键名不带 nr_ 前缀，避免被 NR.store 的迁移当成业务数据比对出「存储冲突」。 */
  var DISCLAIMER_KEY = 'ui_disclaimer_ack';
  function disclaimerAcked() {
    try { return global.localStorage.getItem(DISCLAIMER_KEY) === '1'; } catch (e) { return false; }
  }
  function ackDisclaimer() {
    try { global.localStorage.setItem(DISCLAIMER_KEY, '1'); } catch (e) { /* 隐私模式等情况，忽略 */ }
  }
  global.NR.showDisclaimer = function () {
    try { global.localStorage.removeItem(DISCLAIMER_KEY); } catch (e) {}
    return showDisclaimer();
  };

  function showDisclaimer() {
    return new Promise(function (resolve) {
      var m = el('frModal');
      if (!m) { resolve(); return; }
      if (disclaimerAcked()) { m.hidden = true; resolve(); return; }
      el('frTitle').textContent = '用户须知';
      el('frBody').innerHTML =
        '<b>支持说明</b>\n' +
        '本应用为免费工具，支持部分 Legado 书源规则；漫画与音频链路尚未完成兼容验证。\n' +
        '应用自身不提供任何内容；若喜欢某部作品，请通过正版渠道支持作者。\n\n' +
        '<b>免责声明</b>\n' +
        '应用不自带书籍；导入或获取的正文与缓存保存在本机，并包含在完整备份中。\n' +
        '第三方书源及其脚本仍可联网发送相关信息，请只使用可信书源。\n' +
        '使用产生的一切风险由使用者自行承担；请遵守所在地区法律法规，\n' +
        '仅用于个人学习与研究。';
      // P：单按钮「我已知晓」——去掉同意/不同意二选一，退出分支整体移除
      var ok = el('frOk');
      ok.hidden = false;
      ok.textContent = '我已知晓';
      var never = el('frNever');
      if (never) never.checked = false;
      ok.onclick = function () {
        if (never && never.checked) ackDisclaimer();
        frClose();
        resolve();
      };
      m.hidden = false;
      setTimeout(function () { ok.focus(); }, 30);
    });
  }

  /* ---------------- 对外接口（书源 / 自动化用） ----------------
     NR.addBook({ title, chapters:[{t,text}], totalChars, sourceId? }) → 直接进书架
     NR.openFiles(File[])  → 等价于用户拖入文件
     NR.openBook(id)       → 打开某本书
     NR.importBook(book)   → 下载完的在线书入库并刷新书架
   ------------------------------------------------------------- */
  global.NR.notify = toast;
  global.NR.openFiles = handleFiles;
  global.NR.addBook = addBook;
  global.NR.addVideoBook = addVideoBook;
  global.NR.openBook = openBook;
  global.NR.openTransient = openTransient;
  global.NR.openBookDetail = openBookDetail;
  global.NR.getSettings = function () { return settings; };
  global.NR.removeBook = removeBook;
  global.NR.importBook = function (book) {
    return addBook(book).then(function (meta) {
      return saveIndex().then(function () { renderShelf(); return meta; });
    });
  };
  global.NR.settings = function () { return settings; };
  global.NR.state = function () { return { view: view, index: index, cur: cur }; };
  global.NR.switchView = switchView;
  global.NR.openSettings = openSettings;
  global.NR.setPane = showSetPane;
  global.NR.toast = toast;
  global.NR.loading = loading;
  global.NR.ui = {
    confirm: uiConfirm,
    pick: uiPick,
    prompt: uiPrompt,
    doc: uiDoc,
    close: closeModal
  };
  global.NR.switchSource = function (alt) { switchToSource(alt); };
  global.NR.pickSource = pickSource;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
