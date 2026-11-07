/* 热榜（发现页数据源）
 *
 * 数据来自 www.uukan.org 的排行榜页（静态服务端渲染，直接就是能读的 HTML）：
 *   1. 榜单页 /ranking/<board>.html 里每个条目是一个 <div class="bookbox"><div class="p10">：
 *      <span class="num">名次</span> + h2.bookname > a[href=/book/<slug>.html] + 两个 div.author
 *      （作者：X / 字数：X万）+ div.cat（更新到：…）+ div.update（简介：…）。
 *   2. 榜单页**没有封面图**（实测 0 个 <img>），封面在书籍页 /book/<slug>.html 的
 *      <div class="bookcover"><img class="thumbnail" src=…>，所以再按需补一次书页。
 *   3. 补封面的书页顺便把更完整的简介（p.bookintro）与字数取回来。
 *   4. 本模块只做「发现页展示 + 点书名去书源里搜」，不碰正文，也不写任何书源健康数据。
 *
 * 网络请求一律走宿主桥（NR.platform.fetchText，兜底 NR.legado.fetchPage），
 * 主界面自身不发请求：严格 CSP + 跨域，renderer 直接 fetch 这些页面拿不到内容。
 */
(function (global) {
  'use strict';

  var HOST = 'https://fanqienovel.com';

  /* 七个榜单：数据由本地爬虫从 daosearch.io 抓取后推到 GitHub（见 hotrank 缓存服务器），
   * 客户端只读缓存；缓存拿不到时回退番茄原生榜单页直抓（ranks 为番茄 rank id）。 */
  var BOARDS = [
    { id: 'reading', name: '阅读榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=reading', ranks: ['1_1', '1_1_1140', '1_1_8'] },
    { id: 'recommend', name: '推荐榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=recommend', ranks: ['1_1_1141', '1_1_1140', '1_2_1140'] },
    { id: 'peak', name: '巅峰榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=peak', ranks: ['1_1', '1_2'] },
    { id: 'darkhorse', name: '黑马榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=darkhorse', ranks: ['1_2', '1_2_8'] },
    { id: 'newbook', name: '新书榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=newbook', ranks: ['1_2', '1_2_1140', '1_2_8'] },
    { id: 'following', name: '追更榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=following', ranks: ['1_1_261', '1_1_262', '1_2_261'] },
    { id: 'completed', name: '完本榜', url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=completed', ranks: ['1_1'] }
  ];
  var CHANNEL_FALLBACK = BOARDS.slice();
  var DEFAULT_CHANNEL = 'reading';
  var CACHE_MS = 10 * 60 * 1000;
  var DETAIL_CONCURRENCY = 8;
  var DETAIL_LIMIT = 30;   // 榜首这么多本都要补封面/简介（默认展示 30 本，即全部都要）
  var MAX_CHARS = 4 * 1024 * 1024;

  /* 每日缓存服务器（NAT 小鸡抓取 → GitHub 仓库 → gh-proxy 加速）。
   * 先拉缓存（一次 HTTP 请求拿到整榜，含封面/简介），失败才回退直抓 uukan（要 1+30 次请求）。
   * localStorage 记最近一次成功的数据与日期：当天已成功过就不再请求（每天首次打开拉一次）。 */
  var GH_REPO = 'Silencecavalier/iread-hotrank';
  var GH_BRANCH = 'main';
  var CACHE_URLS = [
    'https://gh-proxy.com/https://raw.githubusercontent.com/' + GH_REPO + '/' + GH_BRANCH + '/',
    'https://raw.githubusercontent.com/' + GH_REPO + '/' + GH_BRANCH + '/'
  ];
  /* 缓存键不能用 nr_ 前缀：NR.store 把 nr_ 当成自己的业务数据拿 JSON.parse 去解，
   * 而这里的日期/URL 不是 JSON——历史上的「双端存储不能用」就是这么来的。改用 hr2_ 独立命名空间。 */
  var LS_KEY = 'hr2_cache_';   // + board.id
  var LS_DAY = 'hr2_day';
  var LS_INDEX = 'hr2_index';

  /* 顺手清掉老版本写在 nr_ 命名空间里的热榜缓存键，别让它们继续被存储层看到。 */
  (function dropLegacyKeys() {
    try {
      var storage = global.localStorage, doomed = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (/^nr_hotrank/.test(key)) doomed.push(key);
      }
      for (var j = 0; j < doomed.length; j++) storage.removeItem(doomed[j]);
    } catch (e) { /* 隐私模式等情况忽略 */ }
  })();

  var pseudoSource = { url: HOST + '/', bookSourceUrl: HOST, timeout: 20000, charset: 'utf-8' };
  var cache = Object.create(null);

  function fail(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function cached(key, ttl, work) {
    var hit = cache[key];
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    return Promise.resolve().then(work).then(function (value) {
      cache[key] = { at: Date.now(), value: value };
      return value;
    });
  }

  function clearCache() { cache = Object.create(null); }

  function pageText(page) {
    var text = page && page.text != null ? page.text : '';
    if (!text) throw fail('EMPTY', '页面没有内容');
    if (text.length > MAX_CHARS) throw fail('TOO_BIG', '页面过大');
    return text;
  }

  /* 宿主桥取页面文本。
   * 优先 NR.platform.fetchText（主进程共享的 HttpClient，一次请求几百毫秒）；
   * NR.legado.fetchPage 每次都要起一个独立书源进程（实测固定 ~2.6 秒/次），
   * 只在没有 platform 通道时兜底，别拿它抓静态页面。 */
  function fetchText(url) {
    var plat = global.NR && global.NR.platform;
    if (plat && typeof plat.fetchText === 'function') {
      return Promise.resolve(plat.fetchText({
        url: url,
        source: pseudoSource,
        timeout: 15000
      })).then(pageText).catch(function (error) {
        if (error && error.code) throw error;
        throw fail('NET', (error && error.message) || '请求失败');
      });
    }
    var legado = global.NR && global.NR.legado;
    if (legado && typeof legado.fetchPage === 'function') {
      return Promise.resolve(legado.fetchPage(pseudoSource, url)).then(pageText);
    }
    return Promise.reject(fail('UNSUPPORTED', '没有可用的取页通道'));
  }

  function decodeEntities(text) {
    return String(text == null ? '' : text)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&amp;/gi, '&');
  }

  function textOf(html) {
    return decodeEntities(String(html == null ? '' : html).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function clip(text, max) {
    var s = textOf(text);
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/[，。、；：\s]$/, '') + '…';
  }

  /* 「426.4万」→ 4264000；「1234」→ 1234 */
  function wordsOf(text) {
    var m = /([\d.]+)\s*(亿|万)?字?/.exec(textOf(text));
    if (!m) return 0;
    var n = Number(m[1]);
    if (!isFinite(n) || n <= 0) return 0;
    if (m[2] === '亿') return Math.round(n * 100000000);
    if (m[2] === '万') return Math.round(n * 10000);
    return Math.round(n);
  }

  /* 榜单页导航：/ranking/<board>.html 的标签，认得的 board 用页面上的名字，其余用固定表 */
  function parseChannels(html) {
    var text = String(html || '');
    var known = Object.create(null), out = [], i;
    for (i = 0; i < BOARDS.length; i++) known[BOARDS[i].id] = BOARDS[i];
    var seen = Object.create(null);
    var re = /href="\/ranking\/([a-z]+)\.html"[^>]*>([^<]{1,24})<\/a>/g, m;
    while ((m = re.exec(text))) {
      var id = m[1];
      if (!known[id] || seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, name: known[id].name || textOf(m[2]), url: known[id].url });
    }
    /* 页面顺序可能变，兜底表补齐没解析到的榜 */
    for (i = 0; i < BOARDS.length; i++) {
      if (!seen[BOARDS[i].id]) out.push({ id: BOARDS[i].id, name: BOARDS[i].name, url: BOARDS[i].url });
    }
    return out.length ? out : CHANNEL_FALLBACK;
  }

  /* 榜单页：书单（书名/作者/字数/简介都在页面上，封面要另外补） */
  function parseRankItems(html) {
    var text = String(html || '');
    var m = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/.exec(text);
    if (!m) return [];
    var state = null;
    try { state = JSON.parse(m[1].replace(/\\u002F/g, '/')); } catch (e) { return []; }
    var list = state && state.rank && state.rank.book_list;
    if (!list || !list.length) return [];
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.bookId) continue;
      items.push({
        id: String(b.bookId),
        title: '', /* 榜单页书名是 PUA 字体混淆，明文要等详情页补 */
        author: b.author || '',
        cover: b.thumbUri || '',
        intro: '',
        words: Number(b.wordNumber) || 0,
        latest: b.lastChapterTitle || '',
        bookUrl: HOST + '/page/' + b.bookId,
        readUrl: HOST + '/page/' + b.bookId
      });
    }
    return items;
  }

  /* 书籍页：封面（img.thumbnail）+ 更完整的简介 + 作者/字数 */
  function parseBook(html) {
    var text = String(html || '');
    if (!text) return null;
    var m = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/.exec(text);
    if (!m) return null;
    var state = null;
    try { state = JSON.parse(m[1].replace(/\\u002F/g, '/')); } catch (e) { return null; }
    var p = state && state.page;
    if (!p || !p.bookName) return null;
    return {
      cover: '',
      title: p.bookName,
      author: p.author || '',
      words: 0,
      intro: clip(String(p.abstract || '').split('\n').join(' '), 72)
    };
  }

  /* 有限并发地跑一组任务，保持原顺序；单个失败不连坐；
   * 每结束一个就回调一次 onSettle(results, settled)，给上面的渐进渲染用 */
  function mapLimit(items, limit, work, onSettle) {
    var results = new Array(items.length);
    var settled = 0;
    var next = 0;
    function run() {
      if (next >= items.length) return Promise.resolve();
      var index = next++;
      return Promise.resolve()
        .then(function () { return work(items[index], index); })
        .then(function (value) { results[index] = value; },
              function (error) { results[index] = { __error: error }; })
        .then(function () {
          settled++;
          if (typeof onSettle === 'function') onSettle(results, settled);
          return run();
        });
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, items.length); i++) workers.push(run());
    return Promise.all(workers).then(function () { return results; });
  }

  /* 把结果整理成 items/failed：还没回来的槽位（undefined）跳过不计数 */
  function pickItems(channel, rows) {
    var items = [], failed = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row === undefined) continue;
      if (!row || row.__error || !row.title) { failed++; continue; }
      row.rankName = channel.name;
      items.push(row);
    }
    return { items: items, failed: failed };
  }

  function channels() {
    /* 榜单表内置，不再为它多跑一次网络往返 */
    return Promise.resolve(CHANNEL_FALLBACK.slice());
  }

  /* ---- 每日缓存（GitHub 经 gh-proxy） ---- */

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* 配额满就算了 */ }
  }

  /* 从缓存服务器拉一个榜单；成功返回 {channel, items, fromCache:true}
   * force=true 时跳过「今天已经拉过」的本地存档，重新联网取（手动刷新用）。 */
  function fromDailyCache(channel, force) {
    var day = lsGet(LS_DAY);
    var raw = lsGet(LS_KEY + channel.id);
    /* 当天已经成功拉过 → 直接用本地存档，不联网 */
    if (!force && day === todayStr() && raw) {
      try {
        var saved = JSON.parse(raw);
        if (saved && saved.items && saved.items.length) {
          return Promise.resolve({ channel: saved.channel || channel, items: saved.items, failed: 0, fromCache: true });
        }
      } catch (e) { /* 存档坏了就走网络 */ }
    }
    var base = lsGet(LS_INDEX);
    var urls = base ? [base] : CACHE_URLS.slice();
    var tryUrls = function (i) {
      if (i >= urls.length) return Promise.reject(fail('NET', '缓存不可用'));
      return fetchText(urls[i] + 'hot-' + channel.id + '.json').then(function (text) {
        var data = JSON.parse(text);
        if (!data || !data.items || !data.items.length) throw fail('EMPTY', '缓存为空');
        lsSet(LS_INDEX, urls[i]);
        lsSet(LS_DAY, todayStr());
        lsSet(LS_KEY + channel.id, JSON.stringify({ channel: channel, items: data.items }));
        return { channel: channel, items: data.items, failed: 0, fromCache: true };
      }).catch(function () { return tryUrls(i + 1); });
    };
    return tryUrls(0);
  }

  /* 热榜：channelId 缺省取第一个榜单；返回 {channel, items, failed}
   * options.onProgress({channel, channels, items, done, total, failed}) 每拿到一批就回调，
   * 让界面先把已到手的书画出来（榜单页本来就有书名/作者/简介），封面再由书页补上。 */
  function hot(channelId, options) {
    options = options || {};
    var limit = Math.max(1, Math.min(120, Number(options.limit) || 30));
    var notify = typeof options.onProgress === 'function' ? options.onProgress : null;
    var refresh = !!options.refresh;
    var key = 'hot:' + (channelId || DEFAULT_CHANNEL) + ':' + limit;
    /* 手动刷新：清掉进程内缓存，并且跳过当日存档重新联网 */
    if (refresh) clearCache();
    return cached(key, CACHE_MS, function () {
      /* 先用内置榜单表开跑，渠道名随后由 /ranking.html 校正：省掉首屏那一次固定网络往返 */
      var chips = CHANNEL_FALLBACK;
      var channel = null, i;
      for (i = 0; i < chips.length; i++) if (chips[i].id === channelId) { channel = chips[i]; break; }
      if (!channel) for (i = 0; i < chips.length; i++) if (chips[i].id === DEFAULT_CHANNEL) { channel = chips[i]; break; }
      if (!channel) channel = chips[0];
      channels().then(function (list) { if (list && list.length) chips = list; }, function () { });
      /* 缓存服务器整本数据里的 items 已经带封面/简介，且正好是 30 本 —— 命中就整体返回，
       * 不再走「榜单页翻页 + 逐本书页补详情」那条重链路。失败/不足再回退直抓。 */
      var cacheTry = fromDailyCache(channel, refresh).then(function (hit) {
        if (!hit.items.length) return Promise.reject(fail('SHORT', '缓存条数不足'));
        if (hit.items.length > limit) hit.items = hit.items.slice(0, limit);
        return hit;
      });
      var cacheOnly = options.cacheOnly;
      if (cacheOnly) return cacheTry;
      return cacheTry.catch(function () {
        var ranks = channel.ranks || [String((channel.url || '').split('/').pop()) || '1_1'];
        var acc = [];
        var preview = function () {
          if (!notify || !acc.length) return;
          var picked = pickItems(channel, acc.slice(0, limit));
          notify({
            channel: channel, channels: chips, items: picked.items, failed: picked.failed,
            done: 0, total: Math.min(acc.length, limit), stage: 'pages'
          });
        };
        var collect = function () {
          return mapLimit(ranks, 3, function (rid) {
            return fetchText(HOST + '/rank/' + rid).then(parseRankItems, function () { return []; });
          }, null).then(function (lists) {
            var seen = {};
            for (var k = 0; k < lists.length; k++) {
              var got = lists[k] || [];
              for (var j = 0; j < got.length; j++) {
                if (seen[got[j].id]) continue;
                seen[got[j].id] = 1;
                acc.push(got[j]);
              }
            }
            preview();
            return acc;
          });
        };
        return collect().then(function (all) {
          var rows = all.slice(0, limit);
          if (!rows.length) throw fail('NO_LIST', '榜单没有拿到书目');
          var emit = function (done) {
            if (!notify) return;
            var picked = pickItems(channel, rows);
            notify({
              channel: channel, channels: chips, items: picked.items, failed: picked.failed,
              done: done, total: Math.min(rows.length, DETAIL_LIMIT)
            });
          };
          emit(0);
          /* 每本补封面/简介都要再取一次书籍页：只为前面这些补，其余的先用榜单上的书名/作者/字数 */
          var targets = rows.slice(0, DETAIL_LIMIT);
          return mapLimit(targets, DETAIL_CONCURRENCY, function (row) {
            return fetchText(row.bookUrl).then(function (page) {
              var extra = parseBook(page);
              if (extra) {
                if (extra.cover) row.cover = extra.cover;
                if (extra.intro) row.intro = extra.intro;
                if (extra.author && !row.author) row.author = extra.author;
                if (extra.words) row.words = extra.words;
                if (extra.title && !row.title) row.title = extra.title;
              }
              return row;
            }).catch(function () { return row; }); /* 封面/简介补不到不算失败 */
          }, function (results, settled) { emit(settled); }).then(function () {
            var picked = pickItems(channel, rows);
            if (!picked.items.length) throw fail('NO_ITEMS', '榜单没有解析出书目');
            return { channel: channel, channels: chips, items: picked.items, failed: picked.failed };
          });
        });
      });
    });
  }

  global.NR = global.NR || {};
  global.NR.hotrank = {
    host: HOST,
    channels: channels,
    hot: hot,
    clearCache: clearCache,
    /* 供离线测试使用 */
    __parse: {
      parseChannels: parseChannels,
      parseRankItems: parseRankItems,
      parseBook: parseBook,
      wordsOf: wordsOf,
      textOf: textOf
    }
  };
})(window);
