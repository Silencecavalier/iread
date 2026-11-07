/* =========================================================================
 * mediaview.js — 漫画图片章节阅读模式（预留给视频/音频共用的媒体嗅探入口）
 * -------------------------------------------------------------------------
 * 漫画源（bookSourceType=2，归一化后 src.type=2）的正文求值结果通常是：
 *   1. 图片 URL 列表（每行一个，@js join('\n') 或选择器逐行取出）
 *   2. HTML 块（内含 <img src=...>）
 *   3. @js 返回的数组 / join 后的复杂结果
 * 这里统一嗅探成图片 URL 数组，逐张渲染成漫画阅读器：
 *   - 图片加载走 NR.cover.get(url, referer)（fetchImage 桥，防盗链已解决）
 *   - 并发上限 3 的懒加载（视口附近才取，参照 covers.js 的 pending 风格）
 *   - 点击图片切换 适宽 / 原图
 *
 * 视频模式由 video 功能接入（app.js sniffVideo 先行，srcType=4 不进这里）。
 * 嗅探顺序约定：视频（.m3u8/.mp4 单 URL / srcType=4）→ 漫画（srcType=2
 * 或提取到图片）→ 文本。
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};

  /* ------------------------------------------------------------ 嗅探 */
  // 视频扩展名：漫画嗅探时排除，避免把视频地址误收成图片（与 app.js isVideoUrl 对齐）
  var VIDEO_RE = /\.(m3u8|mp4|webm|ogv|mov)([?#]|$)/i;

  /** P：Legado 图源约定——src="url,{json}" 逗号后是该图的请求头（防盗链 referer 等）。
   *  拆出干净 URL 和 headers 对象。 */
  function splitImgHeader(u) {
    var s = String(u || '').trim();
    var headers = null, url = s;
    if (s.charAt(0) === '{') {           // 整段就是 {"url":...,"headers":...}? 不处理，按原文
      return { url: s, headers: null };
    }
    // 找第一个 ",{"（URL 后拼 JSON 的模式）；URL 里合法出现 ",{" 的概率极低
    var at = s.indexOf(',{');
    if (at > 0 && /\}\s*$/.test(s)) {
      try {
        var h = JSON.parse(s.substring(at + 1));
        if (h && typeof h === 'object') { headers = h; url = s.substring(0, at); }
      } catch (e) { /* 不是 JSON 就整段当 URL */ }
    }
    return { url: url, headers: headers };
  }

  /** 正文文本 → 图片 URL 数组（去重、保序）；元素为 {url, headers} */
  function extractImages(text) {
    var t = String(text == null ? '' : text);
    var urls = [];
    var push = function (u) {
      u = String(u || '').trim();
      if (!u || u.indexOf('data:') === 0) return;      // data: 内联图不作为漫画页
      if (VIDEO_RE.test(u)) return;
      var sp = splitImgHeader(u);
      for (var i = 0; i < urls.length; i++) {
        if (urls[i].url === sp.url) return;             // 去重按干净 URL
      }
      urls.push(sp);
    };
    if (/<img/i.test(t)) {
      // P：Legado 图源常见的 src="url,{"headers":...}" 会在属性里嵌未转义的引号——
      // 传统「取到闭合引号」的正则会提前截断。改为按 <img 出现位置切行，
      // 每段先抽引号内（若引号配对正常）或整段到段尾，再交给 splitImgHeader 拆 url+headers
      var parts = t.split(/<img/i);
      for (var pi = 1; pi < parts.length; pi++) {
        var seg = parts[pi];
        // 段尾：下一个 > 之前的一段 src= 值（值可能因嵌套引号残缺，取到段尾再清洗）
        var sm = /src\s*=\s*"?([^>]+?)"?\s*(?:>|$)/i.exec(seg);
        if (sm) {
          var v = sm[1].replace(/\s*(?:alt|width|height|style|class)\s*=\s*[^'"\s]+.*$/i, '').trim()
                       .replace(/^["']|["']+$/g, '');
          if (v) push(v);
        }
      }
      // 兜一层标准引号正则（处理正常写法且上面没抽到的情况）
      if (!urls.length) {
        var re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi, m;
        while ((m = re.exec(t))) push(m[1]);
      }
    }
    if (!urls.length) {
      /* 纯文本形态：引擎把属性列表拼成一行（空格分隔）或每行一个，两种都要吃得下。
         要点：`url,{"headers":{…}}` 里的请求头可能含空格（User-Agent），所以不能按空白切 token ——
         改为按 URL 起点扫描，再往后吃掉一段平衡括号里的 JSON，整段交给 splitImgHeader。 */
      var reUrl = /(?:https?:)?\/\//gi, mu;
      while ((mu = reUrl.exec(t))) {
        var st = mu.index, ei = st;
        while (ei < t.length && !/[\s"'<>]/.test(t.charAt(ei))) {
          if (t.charAt(ei) === "," && t.charAt(ei + 1) === "{") break;
          ei++;
        }
        var raw = t.slice(st, ei);
        if (t.charAt(ei) === "," && t.charAt(ei + 1) === "{") {
          var depth = 0, inStr = false, escp = false, k = ei;
          for (; k < t.length; k++) {
            var ch = t.charAt(k);
            if (inStr) {
              if (escp) escp = false;
              else if (ch === "\\") escp = true;
              else if (ch === '"') inStr = false;
              continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { k++; break; } }
          }
          raw = t.slice(st, k);
          reUrl.lastIndex = k;
        }
        if (raw) push(raw);
      }
    }
    return urls;
  }

  /** 是否进入漫画模式：srcType=2 恒为漫画（提取为空显示占位）；否则提取到 ≥1 张才算 */
  function shouldManga(text, srcType) {
    if (Number(srcType) === 2) return true;
    if (/<img[^>]+src\s*=/i.test(String(text || ''))) return true;   // P：HTML img 形态恒漫画（源没标 type 的 eval 混淆图站）
    return extractImages(text).length >= 1;
  }

  /* ------------------------------------------------------------ 渲染 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 章节 baseUrl 的 origin，做防盗链 referer */
  function originOf(u) {
    try { return new URL(u).origin; } catch (e) { return ''; }
  }

  /**
   * 漫画章节 HTML（app.js chapterHTML 拼接用；加载由 bindAll 的观察器接管）
   * ch: { t, url }，ci: 章节下标（进度条展示用，暂未参与交互）
   */
  function mangaHTML(ch, ci, src) {
    var urls = extractImages(ch && ch.text);
    var referer = originOf(ch && ch.url);
    var sid = (src && (src.id || src.bookSourceUrl)) ? String(src.id || src.bookSourceUrl) : '';
    var h = '<div class="manga-view" data-manga="1"' +
      (referer ? ' data-manga-ref="' + esc(referer) + '"' : '') +
      (sid ? ' data-manga-srcid="' + esc(sid) + '"' : '') + '>' +
      '<div class="manga-view__bar">第 0/' + urls.length + ' 张 · ' +
      '<span class="manga-view__load">加载中 0</span></div>';
    if (!urls.length) {
      h += '<div class="manga-view__empty">未取到图片（规则可能失效）</div>';
    } else {
      h += '<div class="manga-view__list">';
      for (var i = 0; i < urls.length; i++) {
        // P：extractImages 已返回 {url, headers} 对象（splitImgHeader 在 push 时已拆）；
        // 兼容旧调用直接传字符串数组的场景
        var it = urls[i];
        var sp = (it && typeof it === 'object') ? it : splitImgHeader(it);
        h += '<div class="manga-view__item" data-manga-i="' + i + '">' +
          '<img data-manga-src="' + esc(sp.url) + '"' +
          (sp.headers ? ' data-manga-headers="' + esc(JSON.stringify(sp.headers)) + '"' : '') +
          ' alt="第' + (i + 1) + '页" hidden></div>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ------------------------------------------------------------ 加载调度 */
  /* ---- 漫画图片解密（Legado ruleContent.imageDecode）---- */
  function dataUrlToBytes(u) {
    var s = String(u || ''), i = s.indexOf(',');
    if (i < 0) return null;
    var b = atob(s.slice(i + 1));
    var out = new Uint8Array(b.length);
    for (var k = 0; k < b.length; k++) out[k] = b.charCodeAt(k);
    return out;
  }
  function mimeOfBytes(b) {
    if (!b || b.length < 4) return '';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    return '';
  }
  function bytesToDataUrl(bytes, mime) {
    var CH = 0x8000, out = [];
    for (var i = 0; i < bytes.length; i += CH) {
      out.push(String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + CH)));
    }
    return 'data:' + (mime || 'image/jpeg') + ';base64,' + btoa(out.join(''));
  }
  function toBytes(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
      if (/^data:/.test(v)) return dataUrlToBytes(v);
      var arr = new Uint8Array(v.length);
      for (var i = 0; i < v.length; i++) arr[i] = v.charCodeAt(i) & 0xff;
      return arr;
    }
    var out = [];
    for (var j = 0; j < v.length; j++) {
      var x = v[j];
      if (typeof x === 'number') out.push(x & 0xff);
      else if (x && typeof x.getByteValue === 'function') out.push(x.getByteValue() & 0xff);
      else out.push(Number(x) & 0xff);
    }
    return new Uint8Array(out);
  }
  /** 读当前章节所属书源的 imageDecode 脚本 */
  function codecOf(view) {
    var id = view && view.dataset ? view.dataset.mangaSrcid : '';
    if (!id) return null;
    try {
      var s = NR.sources && NR.sources.get(id);
      var c = s && s.ruleContent && s.ruleContent.imageDecode;
      return c ? String(c) : null;
    } catch (e) {
      return null;
    }
  }
  /** 用书源的 imageDecode 把密文图变成可显示的 data URL；失败返回 null（调用方回退原图）。
      两条路：①UI 里若有 legacy-js（老 Electron 外壳）就地跑；②否则交给宿主 → 规则 worker 跑（WebView2 的主路径）。 */
  function decodeImage(dataUrl, code, url, view) {
    var localBytes = dataUrl ? dataUrlToBytes(dataUrl) : null;
    if (NR.legacyJs && typeof NR.legacyJs.run === 'function' && localBytes && localBytes.length) {
      try {
        var raw = localBytes;
        var b64in = String(dataUrl || '').split(',')[1] || '';
        var out = NR.legacyJs.run(code, { result: b64in, baseUrl: url || '', key: '', page: 1, args: {}, book: {} });
        var bytes = toBytes(out);
        if (!bytes || !bytes.length) return null;
        return bytesToDataUrl(bytes, mimeOfBytes(bytes) || 'image/jpeg');
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[manga] 图片解密失败：', (e && e.message) || e);
        return null;
      }
    }
    var pf = NR.platform;
    if (!pf || typeof pf.decodeImage !== 'function') return null;
    var src = null;
    try {
      var sid = view && view.dataset ? view.dataset.mangaSrcid : '';
      if (sid && NR.sources && typeof NR.sources.get === 'function') {
        var full = NR.sources.get(sid);
        if (full) src = JSON.parse(JSON.stringify(full));
      }
    } catch (e) { src = null; }
    var referer = (view && view.dataset && view.dataset.mangaRef) || '';
    /* 优先用页面自己（浏览器网络栈）把密文图抓下来：不少图站的 TLS 指纹只放行浏览器，
       宿主的 .NET HttpClient 会被 reset。抓不到再把 url 交给宿主去下载。 */
    var grab = function () {
      if (typeof fetch !== 'function') return Promise.resolve('');
      var got = fetch(url, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var bytes = new Uint8Array(buf), s = '', CH = 0x8000;
        for (var i = 0; i < bytes.length; i += CH) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(s);
      }).catch(function () { return ''; });
      // 页面 fetch 有时会一直吊着（跨域/被拦时既不 resolve 也不 reject），给个上限
      return Promise.race([got, new Promise(function (res) { setTimeout(function () { res(''); }, 8000); })]);
    };
    var chain = grab().then(function (b64) {
      return pf.decodeImage({ url: url, code: code, referer: referer, source: src, b64: b64, timeout: 45000 });
    }).then(function (d) {
      return d || null;
    }, function (e) {
      return null;
    });;
    // 兜底：worker 卡住时也要让图片进入失败态，别永远挂着
    return Promise.race([chain, new Promise(function (res) { setTimeout(function () { res(null); }, 30000); })]);
  }

  var CONCURRENCY = 3;
  var IMG_TIMEOUT = 12000;   // 单张图的取图上限（ms），超时算失败、继续下一张

  function bindOne(view) {
    if (view.dataset.mangaInit) return;
    view.dataset.mangaInit = '1';
    var list = view.querySelector('.manga-view__list');
    if (!list) return;                                 // 空占位（未取到图片）
    var bar = view.querySelector('.manga-view__load');
    var items = Array.prototype.slice.call(list.querySelectorAll('.manga-view__item'));
    var total = items.length;
    var ok = 0, fail = 0, running = 0, started = 0;
    var queue = items.slice();

    function refresh() {
      if (bar) {
        var left = total - ok - fail;
        bar.textContent = left > 0 ? ('加载中 ' + left)
          : (fail > 0 ? ('已加载 ' + ok + ' · 失败 ' + fail) : '完成');
      }
      var idx = view.querySelector('.manga-view__bar');
      if (idx) {
        idx.firstChild.nodeValue = '第 ' + (ok + fail) + '/' + total + ' 张 · ';
      }
    }

    function next() {
      while (running < CONCURRENCY && queue.length) start(queue.shift());
      refresh();
    }

    function start(it) {
      if (it.dataset.mangaGo) return;                  // 队列/观察器两条路只跑一次
      it.dataset.mangaGo = '1';
      running++; started++;
      var img = it.querySelector('img');
      var url = img ? img.dataset.mangaSrc : '';
      var done = function () { running--; next(); };
      if (!img || !url) { it.classList.add('err'); fail++; done(); return; }
      if (url.indexOf('data:') === 0) {                 // 内联图直接给 src
        img.src = url; img.hidden = false; ok++; done(); return;
      }
      var ref = view.dataset.mangaRef || '';
      // P：Legado 图源约定——data-manga-headers 是该图的请求头（{headers:{...}} 或 {Referer:...}）
      var hdrs = null;
      if (img.dataset.mangaHeaders) {
        try {
          var hp = JSON.parse(img.dataset.mangaHeaders);
          hdrs = hp && hp.headers ? hp.headers : hp;    // 源里拼的是 {"headers":JSON.stringify(header)} 双层
        } catch (e) { hdrs = null; }
      }
      var code = codecOf(view);
      // 有 imageDecode 的书源：不去宿主导图（图站会随机掐 .NET 的 TLS 握手，白跑一趟），
      // 直接由解密流程用页面自己的网络栈取字节。
      var seed = code ? Promise.resolve('') : Promise.race([
        NR.cover.get(url, ref, hdrs).catch(function () { return ''; }),
        new Promise(function (res) { setTimeout(function () { res(''); }, IMG_TIMEOUT); })
      ]);
      seed.then(function (data) {
        if (!code) return data;
        var dec = decodeImage(data, code, url, view);
        if (dec && typeof dec.then === 'function') {
          return dec.then(function (d) { return d || data; }, function () { return data; });
        }
        return dec || data;
      }).then(function (data) {
        if (view.dataset.mangaInit !== '1' || !view.isConnected) { done(); return; }
        if (data) {
          img.src = data; img.hidden = false;
          it.classList.add('ok'); ok++;
        } else {
          it.classList.add('err'); fail++;
          img.insertAdjacentHTML('afterend',
            '<span class="manga-view__retry">加载失败 · 点击重试</span>');
        }
        done();
      }, function () {
        if (view.dataset.mangaInit !== '1' || !view.isConnected) { done(); return; }
        it.classList.add('err'); fail++; done();
      });
    }

    // 懒加载：有 IntersectionObserver 就只在视口附近取；否则全量排队（并发 3）
    if (typeof IntersectionObserver === 'function') {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var it = en.target;
          if (it.dataset.mangaGo || it.dataset.mangaWish) return;
          /* 只登记「想看」，不直接发车：并发上限必须由 next() 统一把住，
             否则一屏报 40 个可见就会同时发 40 个请求，图床直接把我们按死。 */
          it.dataset.mangaWish = '1';
          io.unobserve(it);
          var q = queue.indexOf(it);
          if (q >= 0) { queue.splice(q, 1); queue.unshift(it); }  // 提到队首，下一轮先取它
          next();
        });
      }, { rootMargin: '800px 0px' });
      items.forEach(function (it) { io.observe(it); });
    }
    next();
  }

  /* 重试：点失败条目重取（事件委托，条目会被重绘） */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var item = t.closest('.manga-view__item.err');
    if (item) {
      var view = item.closest('.manga-view');
      if (view) { delete view.dataset.mangaInit; }
      var retry = item.querySelector('.manga-view__retry');
      if (retry) retry.remove();
      item.classList.remove('err');
      var list = item.parentNode;
      // 重排到队首重新加载：简单起见直接重建一个新 item 状态
      var idx = Array.prototype.indexOf.call(list.children, item);
      var fresh = document.createElement('div');
      fresh.className = 'manga-view__item';
      fresh.dataset.mangaI = idx;
      fresh.innerHTML = '<img data-manga-src="' +
        item.querySelector('img').dataset.mangaSrc + '" alt="第' + (idx + 1) + '页" hidden>';
      list.replaceChild(fresh, item);
      delete view.dataset.mangaInit;
      bindOne(view);
      return;
    }
    // 点击图片切换适应模式（适宽 / 原图）
    var img2 = t.closest('.manga-view img');
    if (img2) {
      var v = img2.closest('.manga-view');
      if (v) v.classList.toggle('manga-view--orig');
    }
  });

  /* 章节重绘走 innerHTML（renderRange / patchChapter / appendNextChapter /
   * renderPageChapter），这里用观察器接管 .manga-view 的初始化，
   * app.js 只需在 chapterHTML 里做一次嗅探分发。 */
  function bindAll(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('.manga-view'), bindOne);
  }
  function hookContainer() {
    var c = document.getElementById('content');
    var p = document.getElementById('pageInner');
    [c, p].forEach(function (n) {
      if (!n || n.dataset.mangaObs) return;
      n.dataset.mangaObs = '1';
      new MutationObserver(function () { bindAll(n); })
        .observe(n, { childList: true, subtree: true });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookContainer);
  } else {
    hookContainer();
  }

  NR.mediaview = {
    extractImages: extractImages,
    shouldManga: shouldManga,
    mangaHTML: mangaHTML
  };
})(window);
