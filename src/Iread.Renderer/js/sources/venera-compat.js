/* =========================================================================
 * sources/venera-compat.js — VeneraX（Flutter 漫画阅读器）漫画源兼容层
 * -------------------------------------------------------------------------
 * 为什么有这层：VeneraX 的源是一个 JS 类（`class X extends ComicSource`），
 * 靠 App 内建的运行时提供 Network / HtmlDocument / Comic 等 API。
 * iread 的源是 Legado 规则 JSON，跑不了这类「可执行源」。
 * 但规则 worker 本身就是一个浏览器页面（有 DOM、能发同步请求），
 * 于是这里把 Venera 的那套 API 用页面能力实现出来：
 *
 *   ComicSource（基类）  Comic / ComicDetails   Manga
 *   Network.get / sendRequest / deleteCookies（同步，走 java.get / java.post）
 *   HtmlDocument（DOMParser 包装：querySelector(All) / text / attributes / classNames）
 *   log()
 *
 * 用法：VR.register(sourceText) → VR.keys() → VR.call(key, 'search'|'info'|'chapters'|'images', args)
 * 只做「读」，不做登录 / webview / 下载 / 代理，够 iread 读书用。
 * ========================================================================= */
(function (global) {
  'use strict';
  if (global.VR) return;

  var VR = global.VR = {};
  var REG = Object.create(null);      // key -> instance
  var RAW = Object.create(null);      // key -> 源码（重载用）

  /* ------------------------------------------------------------------ 数据对象 */
  function Comic(o) { Object.assign(this, o || {}); }
  function ComicDetails(o) { Object.assign(this, o || {}); }
  function Manga(o) { Object.assign(this, o || {}); }

  function ComicSource() {}
  ComicSource.prototype = {
    name: '', key: '', version: '', minAppVersion: '', url: '',
    init: function () {},
    settings: {},
    loadSetting: function (k) {
      var s = this.settings && this.settings[k];
      return s && s.default !== undefined ? s.default : '';
    },
    saveSetting: function () {},
    log: function () {}
  };

  /* ------------------------------------------------------------------ Network */
  // 同步：规则 worker 里 java.get / java.post 是同步 XHR（走 yedu-net 本地代理）
  function toHeaders(h) {
    if (!h) return {};
    if (Array.isArray(h)) {
      var o = {};
      for (var i = 0; i < h.length; i++) {
        if (h[i] && h[i].name != null) o[String(h[i].name)] = String(h[i].value);
      }
      return o;
    }
    if (typeof h === 'object') return h;
    return {};
  }

  var Network = {
    get: function (url, headers) { return request('GET', url, headers, null); },
    post: function (url, payload, headers) { return request('POST', url, headers, payload); },
    sendRequest: function (method, url, headers, payload) {
      return request(String(method || 'GET').toUpperCase(), url, headers, payload);
    },
    deleteCookies: function () { return true; },
    getCookies: function () { return ''; },
    setCookies: function () { return true; }
  };

  function request(method, url, headers, payload) {
    var h = toHeaders(headers);
    var body = '';
    try {
      if (method === 'POST') {
        body = global.java.post(url, payload == null ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload)), h);
      } else {
        body = global.java.get(url, h);
      }
    } catch (e) {
      throw new Error('NET ' + String(e && e.message || e) + ' ' + url);
    }
    // yedu-net 代理不回报状态码：拿到内容即视为 200，空内容报 200 但 body 空由调用方判定
    return { status: 200, body: String(body == null ? '' : body), url: url, headers: {} };
  }

  /* -------------------------------------------------------------- HtmlDocument */
  function wrap(node, root) {
    if (!node) return null;
    var w = {
      node: node,
      get text() { return String(node.textContent || '').replace(/\s+/g, ' ').trim(); },
      get textContent() { return String(node.textContent || ''); },
      get html() { return String(node.innerHTML || ''); },
      get attributes() {
        var o = {};
        if (node.attributes) for (var i = 0; i < node.attributes.length; i++) o[node.attributes[i].name] = node.attributes[i].value;
        return o;
      },
      get classNames() {
        return String(node.getAttribute ? (node.getAttribute('class') || '') : '').split(/\s+/).filter(Boolean);
      },
      get children() {
        var out = [];
        for (var i = 0; i < node.children.length; i++) out.push(wrap(node.children[i], root));
        return out;
      },
      querySelector: function (sel) { try { return wrap(node.querySelector(sel), root); } catch (e) { return null; } },
      querySelectorAll: function (sel) {
        try {
          var list = node.querySelectorAll(sel), out = [];
          for (var i = 0; i < list.length; i++) out.push(wrap(list[i], root));
          return out;
        } catch (e) { return []; }
      },
      getAttribute: function (k) { return node.getAttribute ? node.getAttribute(k) : null; },
      toString: function () { return '[element]'; }
    };
    return w;
  }

  function HtmlDocument(html) {
    var doc = new global.DOMParser().parseFromString(String(html || ''), 'text/html');
    var w = wrap(doc.documentElement, doc);
    w.document = doc;
    return w;
  }

  /* ---------------------------------------------------------------- 注册 / 调用 */
  function buildEnv() {
    return {
      ComicSource: ComicSource,
      Comic: Comic,
      ComicDetails: ComicDetails,
      Manga: Manga,
      Network: Network,
      HtmlDocument: HtmlDocument,
      log: function (level, from, msg) {
        try { console.log('[venera] ' + level + ' ' + from + ' ' + msg); } catch (e) {}
      },
      Crypto: global.crypto || {},
      MD5: function (s) { return String(s); },
      Base64: {
        encode: function (s) { return global.btoa(unescape(encodeURIComponent(String(s)))); },
        decode: function (s) { return decodeURIComponent(escape(global.atob(String(s)))); }
      }
    };
  }

  VR.register = function (text) {
    var env = buildEnv();
    var keys = Object.keys(env);
    var code = String(text || '');
    var m = code.match(/class\s+([A-Za-z_$][\w$]*)\s+extends\s+ComicSource/);
    if (!m) throw new Error('不是一个 Venera 漫画源（没找到 class X extends ComicSource）');
    var cls = m[1];
    // 源文件只声明类、不实例化；这里补一句 new 出来（Venera 运行时也是这么干的）
    var body = 'return (function(){\n' + code + '\n;return new ' + cls + '();\n})()';
    var fn = new Function(keys.join(','), body);
    var src = fn.apply(null, keys.map(function (k) { return env[k]; }));
    if (!src || !src.key) throw new Error('不是一个 Venera 漫画源（实例没有 key）');
    var before = Object.keys(REG).length;
    REG[src.key] = src;
    RAW[src.key] = code;
    if (src.init) src.init.call(src);
    return { key: src.key, name: src.name || src.key, before: before, after: Object.keys(REG).length };
  };

  VR.keys = function () { return Object.keys(REG); };
  VR.get = function (k) { return REG[k]; };

  /* 统一入口：把 Venera 的方法名映射成 iread 需要的四个动作 */
  VR.call = function (key, op, args) {
    var s = REG[key];
    if (!s) throw new Error('没有这个源：' + key);
    args = args || {};
    if (op === 'search') {
      if (!s.search || !s.search.load) throw new Error('这个源没有搜索');
      var r = s.search.load(args.keyword || '', [], args.page || 1);
      return r;
    }
    if (op === 'explore') {
      var list = s.explore || [];
      var ent = list[args.index || 0];
      if (!ent) throw new Error('没有这个发现页');
      return ent.load(args.page || 1);
    }
    if (op === 'info') return s.comic.loadInfo(args.id);
    if (op === 'chapters') return s.comic.loadInfo(args.id);
    if (op === 'images') return s.comic.loadEp(args.comicId, args.epId);
    throw new Error('不支持的动作：' + op);
  };

  /* 异步包装：Venera 的 load 是 async，页面里直接 await */
  VR.run = function (key, op, args) {
    return Promise.resolve().then(function () { return VR.call(key, op, args); });
  };
})(this);
