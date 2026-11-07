/* =========================================================================
 * covers.js — 封面（书架 / 发现 / 详情共用）
 * -------------------------------------------------------------------------
 * 图片在主进程拉（带 UA + Referer），转成 data URL 再给 <img>，
 * 这样不会因为防盗链显示不出来，也不受 CSP 限制。
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var mem = Object.create(null);        // url → dataURL
  var pending = Object.create(null);    // url → Promise

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* P：封面 URL 唯一入口归一——历史数据/异常路径可能存进非字符串（对象/URL 实例），
   * url.indexOf 直接炸 boot。非字符串或空一律按无封面处理。 */
  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    return u;
  }

  function get(url, referer, headers) {
    url = safeUrl(url);
    if (!url) return Promise.resolve('');
    if (mem[url]) { touch(url); return Promise.resolve(mem[url]); }
    if (pending[url]) return pending[url];
    var pf = NR.platform;
    if (!pf || !pf.fetchImage) return Promise.resolve('');
    pending[url] = pf.fetchImage({ url: url, referer: String(referer || ''), headers: headers || null }).then(function (d) {
      delete pending[url];
      if (d) { mem[url] = d; evict(); }
      return d || '';
    }).catch(function () {
      delete pending[url];
      return '';
    });
    return pending[url];
  }

  /* 封面缓存最多 240 张，超了按最久未用的丢（避免开几百本书把内存吃掉） */
  var LIMIT = 240;
  function touch(url) {
    var v = mem[url];
    delete mem[url];
    mem[url] = v;
  }
  function evict() {
    var keys = Object.keys(mem);
    for (var i = 0; i < keys.length - LIMIT; i++) delete mem[keys[i]];
  }

  /** 生成 <img>（有缓存就直接给 src）或占位块；key 用 data-cover 标记 */
  function markup(url, cls, extra, bookUrl) {
    url = safeUrl(url);
    var book = bookUrl ? ' data-book-url="' + esc(bookUrl) + '"' : '';
    if (!url) return '';
    if (url.indexOf('data:') === 0) return '<img class="' + cls + '" src="' + url + '" alt="">';
    if (mem[url]) return '<img class="' + cls + '" src="' + mem[url] + '" alt="">';
    return '<img class="' + cls + '" data-cover="' + esc(url) + '" alt="" hidden' +
      (extra ? ' data-key="' + esc(extra) + '"' : '') + book + '>';
  }

  /* 声明的封面取不到时：① 试详情页自动补图（cover-auto.js）② 仍不行就换回「无封面」占位块，
   * 否则 <img hidden> 没有 src，卡片会塌成一条窄栏（历史上踩过）。 */
  function degrade(img) {
    var bookUrl = img.getAttribute('data-book-url') || '';
    var auto = NR.coverAuto;
    if (bookUrl && auto && auto.coverOf) {
      auto.coverOf(bookUrl).then(function (cover) {
        if (!cover) return placeholder(img);
        return get(cover, bookUrl).then(function (data) {
          if (data) { img.src = data; img.hidden = false; }
          else placeholder(img);
        });
      }).catch(function () { placeholder(img); });
      return;
    }
    placeholder(img);
  }

  function placeholder(img) {
    if (!img || !img.parentNode) return;
    var cls = String(img.className || 'obook__cover');
    var span = img.ownerDocument.createElement('span');
    span.className = cls + ' ' + cls + '--none';
    var bookUrl = img.getAttribute('data-book-url') || '';
    if (bookUrl) span.setAttribute('data-book-url', bookUrl);
    img.parentNode.replaceChild(span, img);
  }

  /** 把 root 里所有 data-cover 的图补上 */
  function fill(root, refererFor) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('img[data-cover]'), function (img) {
      if (img.dataset.filled) return;
      img.dataset.filled = '1';
      var url = img.dataset.cover;
      var ref = refererFor ? refererFor(url, img) : '';
      get(url, ref).then(function (data) {
        if (!data) { degrade(img); return; }
        img.src = data;
        img.hidden = false;
      });
    });
  }

  function put(url, data) { if (url && data) mem[url] = data; }
  function has(url) { return !!mem[url]; }

  NR.cover = { get: get, markup: markup, fill: fill, put: put, has: has, cache: mem };
})(window);
