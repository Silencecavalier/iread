/* =========================================================================
 * cover-auto.js — 列表封面自动补齐
 * -------------------------------------------------------------------------
 * 有些书源的列表规则没声明 coverUrl（explore/search 都把封面留空），卡片就只剩
 * 「无封面」占位块。这里在列表渲染完之后自动跑一遍：拿书的详情页地址去抓页面，
 * 从页面里挑出最像封面的那张图，走 covers.js 的图像管线（主进程带 UA/Referer
 * 拉字节转 data URL，不受 CSP 限制）补到卡片上。
 *
 * 设计约束：
 *   - 不出现任何按钮、不打扰用户；补不上就保留占位块，不报错、不弹提示。
 *   - 并发 4，单次渲染最多 120 张，避免一次开几百个请求把宿主拖住。
 *   - 只碰「当前这次渲染」的节点：列表重渲染时旧任务自动作废（token 比对）。
 *   - 不写书源健康度/日志/黑名单，纯展示层行为。
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};

  var CONCURRENCY = 4;
  var MAX_JOBS = 120;
  var CACHE_LIMIT = 600;
  var FETCH_TIMEOUT = 15000;

  var cache = Object.create(null);       // bookUrl → coverUrl
  var cacheKeys = [];
  var inflight = Object.create(null);    // bookUrl → Promise<coverUrl>
  var token = 0;                          // 渲染代次

  /* 明显不是封面的图 */
  var BAD = /(logo|avatar|icon|favicon|banner|sprite|advert|ads?[_-]|placeholder|blank|loading|spinner|qr|qrcode|weixin|weibo|share|emoji)/i;
  /* 像封面的线索 */
  var GOOD = /(cover|thumb|bookimg|book-?photo|book-?pic|book_?cover|bookface|poster)/i;
  var IMGISH = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|#|$)/i;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function absolute(url, base) {
    url = String(url == null ? '' : url).trim();
    if (!url) return '';
    if (/^data:/i.test(url)) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.charAt(0) === '/') {
      var m = /^(https?:\/\/[^\/]+)/i.exec(base || '');
      return m ? m[1] + url : url;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '';   // javascript: / blob: 之类
    var dir = String(base || '').replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
    return dir ? dir + url : url;
  }

  function attrOf(tag, name) {
    var re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
    var m = re.exec(tag);
    if (!m) return '';
    return m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] || ''));
  }

  /** 从详情页 HTML 里挑封面地址；挑不到返回空串 */
  function pick(html, pageUrl) {
    html = String(html || '');
    if (!html) return '';

    /* 1. og:image / twitter:image */
    var metas = html.match(/<meta\b[^>]*>/gi) || [];
    for (var i = 0; i < metas.length; i++) {
      var tag = metas[i];
      var key = (attrOf(tag, 'property') || attrOf(tag, 'name') || '').toLowerCase();
      if (key === 'og:image' || key === 'og:image:url' || key === 'twitter:image') {
        var u = absolute(attrOf(tag, 'content'), pageUrl);
        if (u) return u;
      }
    }

    /* 2. <img> 打分 */
    var imgs = html.match(/<img\b[^>]*>/gi) || [];
    var best = '';
    var bestScore = 0;
    for (var j = 0; j < imgs.length; j++) {
      var it = imgs[j];
      var src = absolute(attrOf(it, 'src') || attrOf(it, 'data-src') || attrOf(it, 'data-original') ||
        attrOf(it, 'data-echo') || attrOf(it, 'data-lazy-src') || attrOf(it, 'data-url'), pageUrl);
      if (!src || !IMGISH.test(src)) continue;
      var cls = (attrOf(it, 'class') + ' ' + attrOf(it, 'id') + ' ' + attrOf(it, 'alt'));
      var score = 0;
      if (GOOD.test(cls)) score += 4;
      if (GOOD.test(src)) score += 2;
      if (BAD.test(cls) || BAD.test(src)) score -= 6;
      var w = Number(attrOf(it, 'width')) || 0;
      var h = Number(attrOf(it, 'height')) || 0;
      if (w >= 100 && h >= 100) score += 2;
      else if (w && h && (w < 60 || h < 60)) score -= 3;
      if (!score) score = 1;                     // 没线索的图先记 1 分，有更好的就换
      if (score > bestScore) { bestScore = score; best = src; }
    }
    if (best) return best;

    /* 3. 内联样式里的 background-image */
    var bg = /background(?:-image)?\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    var m2;
    while ((m2 = bg.exec(html))) {
      var bu = absolute(m2[2], pageUrl);
      if (bu && IMGISH.test(bu) && !BAD.test(bu)) return bu;
    }
    return '';
  }

  function fetchText(url) {
    var pf = NR.platform;
    if (pf && pf.fetchText) {
      return pf.fetchText({ url: url, timeout: FETCH_TIMEOUT }).then(function (r) {
        return (r && (r.text || r.body)) || '';
      });
    }
    if (NR.legado && NR.legado.fetchPage) {
      return NR.legado.fetchPage(null, url).then(function (r) { return (r && r.text) || ''; });
    }
    return Promise.resolve('');
  }

  function remember(bookUrl, coverUrl) {
    if (!bookUrl || !coverUrl) return;
    if (!cache[bookUrl]) cacheKeys.push(bookUrl);
    cache[bookUrl] = coverUrl;
    while (cacheKeys.length > CACHE_LIMIT) {
      var k = cacheKeys.shift();
      if (cache[k] === coverUrl || cache[k]) delete cache[k];
    }
  }

  /** 详情页地址 → 封面地址（带内存缓存与同址去重） */
  function coverOf(bookUrl) {
    if (!bookUrl) return Promise.resolve('');
    if (cache[bookUrl]) return Promise.resolve(cache[bookUrl]);
    if (inflight[bookUrl]) return inflight[bookUrl];
    inflight[bookUrl] = fetchText(bookUrl).then(function (html) {
      delete inflight[bookUrl];
      var cover = pick(html, bookUrl);
      if (cover) remember(bookUrl, cover);
      return cover;
    }).catch(function () {
      delete inflight[bookUrl];
      return '';
    });
    return inflight[bookUrl];
  }

  function swap(node, dataUrl) {
    if (!node || !node.parentNode || !dataUrl) return false;
    var img = global.document.createElement('img');
    img.className = 'obook__cover';
    img.alt = '';
    img.src = dataUrl;
    node.parentNode.replaceChild(img, node);
    return true;
  }

  function runJobs(jobs, myToken) {
    var index = 0;
    var active = 0;

    function next() {
      if (myToken !== token) return;
      while (active < CONCURRENCY && index < jobs.length) {
        var job = jobs[index++];
        active++;
        (function (job) {
          coverOf(job.bookUrl).then(function (cover) {
            if (myToken !== token || !cover) return '';
            return NR.cover.get(cover, job.bookUrl).then(function (dataUrl) {
              if (myToken === token && dataUrl) swap(job.node, dataUrl);
            });
          }).catch(function () { }).then(function () {
            active--;
            next();
          });
        })(job);
      }
    }
    next();
  }

  /**
   * 给 root 里所有「无封面」占位块自动补封面。
   * 占位块由各列表渲染成 <span class="obook__cover obook__cover--none" data-book-url="…">。
   */
  function fill(root) {
    if (!root || !root.querySelectorAll || !NR.cover) return;
    token += 1;
    var myToken = token;
    var nodes = root.querySelectorAll('[data-book-url]');
    var jobs = [];
    for (var i = 0; i < nodes.length && jobs.length < MAX_JOBS; i++) {
      var node = nodes[i];
      if (!node || node.dataset.done === '1') continue;
      if (node.tagName && String(node.tagName).toLowerCase() !== 'span') continue;   // 已经有图了
      var bookUrl = node.getAttribute('data-book-url');
      if (!bookUrl) continue;
      node.dataset.done = '1';
      jobs.push({ node: node, bookUrl: bookUrl });
    }
    if (jobs.length) runJobs(jobs, myToken);
  }

  NR.coverAuto = {
    fill: fill,
    coverOf: coverOf,
    clearCache: function () { cache = Object.create(null); cacheKeys = []; },
    __parse: { pick: pick, absolute: absolute, attrOf: attrOf, esc: esc }
  };
})(typeof window !== 'undefined' ? window : this);
