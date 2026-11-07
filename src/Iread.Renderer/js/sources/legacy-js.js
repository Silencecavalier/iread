/* =========================================================================
 * sources/legacy-js.js — 书源 JS 规则的渲染层执行器（Legado 2 的 <js> 块 / 3.x 的 @js:）
 * -------------------------------------------------------------------------
 * 为什么在渲染层：旧规则要用 java.getElement()/setContent() 摸 DOM，DOM 只在页面里；
 * 而 java.ajax() 是「同步」的 —— 渲染层用同步 XHR 打 yedu-net:// 本地代理
 * （主进程替它请求、认字符集、带 Cookie），于是「DOM + 同步请求」同时成立。
 *
 * 作用域（对齐 Legado 的 Rhino 环境）：
 *   result baseUrl key page source book args
 *   java.ajax(url) java.post(url,body,headers) java.connect(url).body()
 *   java.getElement(css) java.getElements(css) java.getString(rule) java.setContent(html)
 *   java.base64Encode/Decode timeFormat randomUUID strToBytes log toast put/get
 *   cookie.getCookie/setCookie/removeCookie
 *
 * 书源本来就是「可执行规则」，所以这里用 eval 跑脚本（CSP 开了 'unsafe-eval'）；
 * 作用域里把 window/globalThis/yedu/require/process 遮蔽成 undefined，
 * 脚本摸不到宿主接口，行为更接近 Rhino（那边也没有 window）。
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};

  /* 「为什么这个源不行」的账本：哪个 api 被撞了多少次（跨 run 调用累积） */
  var STATS = { missing: {}, warned: {} };
  /* cache.putMemory 的存储：按「书源 + key」存，跨 run() 保留 */
  var MEM = Object.create(null);

  /* =========================================================================
   * PATCH SOURCE-API-1：source.* 的键值存储（模块级，跨 run() / 跨阶段保留）
   * -------------------------------------------------------------------------
   * Legado 的 source 是 BookSource 实例，变量挂在实例上：searchUrl 里 source.put()
   * 写进去，ruleToc 里 source.get() 得读得到（语料 43 源 getVariable / 36 源
   * setVariable / 26 源 put / 25 源 get 都这么用）。iread 的 src 门面原来是空壳，
   * put 完下次再取就没了 —— 这里按「书源 key」分开持久化。
   * key 用 rawSource.url（iread 的模型）或 bookSourceUrl（Legado JSON）/ name。
   * ========================================================================= */
  var SOURCE_STORE = Object.create(null);

  function sourceStoreKey(raw) {
    raw = raw || {};
    return String(raw.url || raw.bookSourceUrl || raw.name || raw.bookSourceName || '');
  }

  function sourceStoreOf(raw) {
    var key = sourceStoreKey(raw);
    var st = SOURCE_STORE[key];
    if (!st) {
      st = SOURCE_STORE[key] = {
        key: key,
        map: Object.create(null),      // source.put/get 的字符串表
        raw: '',                       // getVariable()/setVariable() 的整串
        loginInfo: '',                 // putLoginInfo 的 JSON 串
        loginHeader: ''                // putLoginHeader 的 JSON 串
      };
    }
    return st;
  }

  /** 只 warn 一次（不去重会刷屏；`tag` 与 missError 的 api 名分开记，加 `!` 前缀） */
  function warnOnce(tag, msg) {
    var key = '!' + String(tag);
    if (STATS.warned[key]) return;
    STATS.warned[key] = 1;
    try { console.warn('[legacy-js] ' + String(msg)); } catch (e) { /* 无 console 就算了 */ }
  }

  /** 假设备号：同一会话内固定 32 位 hex（真值要 Android 的 ANDROID_ID，渲染层拿不到） */
  var FAKE_DEVICE_ID = null;
  function fakeDeviceId() {
    if (!FAKE_DEVICE_ID) {
      var s = '';
      for (var i = 0; i < 32; i++) s += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
      FAKE_DEVICE_ID = s;
    }
    return FAKE_DEVICE_ID;
  }

  /* ------------------------------------------------------------ 同步请求 */
  function proxyUrl(url, opts) {
    var q = 'yedu-net://net/?u=' + encodeURIComponent(url);
    if (opts.method && String(opts.method).toUpperCase() !== 'GET') {
      q += '&m=' + encodeURIComponent(String(opts.method).toUpperCase());
    }
    if (opts.body != null) q += '&body=' + encodeURIComponent(opts.body);
    if (opts.charset) q += '&cs=' + encodeURIComponent(opts.charset);
    if (opts.headers && Object.keys(opts.headers).length) {
      q += '&h=' + encodeURIComponent(JSON.stringify(opts.headers));
    }
    return q;
  }

  function syncFetch(url, opts) {
    opts = opts || {};
    if (!url) return '';
    var xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', proxyUrl(String(url), opts), false);
      xhr.send(null);
    } catch (e) {
      throw new Error('请求失败：' + ((e && e.message) || e) + '（' + url + '）');
    }
    if (xhr.status >= 400) {
      throw new Error('HTTP ' + xhr.status + '：' + String(xhr.responseText || '').slice(0, 120));
    }
    return String(xhr.responseText || '');
  }

  /* ------------------------------------------------------------ 文本 / DOM */
  function norm(s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/gm, '').trim();
  }

  function parseDoc(html) {
    try { return new DOMParser().parseFromString(String(html || ''), 'text/html'); }
    catch (e) { return null; }
  }

  /** 给 DOM 元素补上 Jsoup 风格的方法（.text() .attr() .select() …） */
  /** 老写法选择器 → CSS（class.x / id.x / tag.x，以及 .box@dl 这种逐级 @） */
  function toCss(sel) {
    var s = String(sel || '').trim();
    if (!s) return { css: '', index: null };
    var idx = null;
    var mIdx = /!(-?\d+)\s*$/.exec(s);
    if (mIdx) { idx = parseInt(mIdx[1], 10); s = s.slice(0, mIdx.index).trim(); }
    var parts = s.split('@');
    var css = parts.map(function (p) {
      var m = /^(class|id|tag)\.(.+)$/.exec(p.trim());
      if (m) {
        if (m[1] === 'class') return '.' + m[2].replace(/\s+/g, '.');
        if (m[1] === 'id') return '#' + m[2].split(/\s+/)[0];
        return m[2].split(/\s+/)[0];
      }
      return p.trim();
    }).filter(Boolean).join(' ');
    return { css: css, index: idx };
  }

  /* =========================================================================
   * PATCH API-1：字节 / 编码 / 摘要
   * -------------------------------------------------------------------------
   * 书源里的 java.* 是 Legado 的 JsExtensions（JVM 侧），大量规则直接在
   * byte[] 上做文章（hexDecodeToString / Base64 / MessageDigest / byte[] 拼接）。
   * 渲染层没有同步 crypto，所以这里补齐：UTF-8 字节化、Base64、hex、
   * MD5 / SHA-1 / SHA-256 的纯 JS 实现（SHA-384/512 走「清楚地失败」）。
   * byte[] 用「数字数组 + 自定义 toString」表示：既能下标运算，又能读到像样的串。
   * ========================================================================= */
  function utf8Binary(s) {
    return unescape(encodeURIComponent(String(s == null ? '' : s)));
  }

  function utf8Bytes(s) {
    var b = utf8Binary(s), out = [];
    for (var i = 0; i < b.length; i++) out.push(b.charCodeAt(i));
    return out;
  }

  function binaryToBytes(bin) {
    var out = [];
    for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i) & 0xFF);
    return out;
  }

  function bytesToBinary(bytes) {
    var s = '', arr = bytes || [];
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i] & 0xFF);
    return s;
  }

  function bytesToUtf8(bytes) {
    var bin = bytesToBinary(bytes);
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }

  /** Java 的 byte[]：数字数组 + 一个「像样的」toString（默认 hex / 文本，见调用点） */
  function byteArray(bytes, asText) {
    var arr = Array.prototype.slice.call(bytes || []);
    if (asText != null) {
      Object.defineProperty(arr, 'toString', {
        value: function () { return String(asText); },
        enumerable: false, configurable: true, writable: true
      });
    }
    return arr;
  }

  /** string / byte[] / java.lang.String → 字节数组 */
  function toBytes(v) {
    if (v == null) return [];
    if (Array.isArray(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(Number(v[i]) & 0xFF);
      return out;
    }
    if (typeof v === 'object') {
      if (v.__javaString) return utf8Bytes(v.__value);
      if (typeof v.length === 'number' && typeof v.BYTES_PER_ELEMENT === 'number') {
        return Array.prototype.slice.call(v);
      }
      if (typeof v.length === 'number') return Array.prototype.slice.call(v).map(function (n) { return n & 0xFF; });
    }
    return utf8Bytes(v);
  }

  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
    return s;
  }

  function hexToBytes(hex) {
    var h = String(hex == null ? '' : hex).replace(/[^0-9a-fA-F]/g, '');
    if (h.length % 2) h = h.slice(0, -1);
    var out = [];
    for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }

  function bytesToBase64(bytes) { return btoa(bytesToBinary(bytes)); }

  function base64ToBytes(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, '')
      .replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    try { return binaryToBytes(atob(t)); }
    catch (e) { throw new Error('base64 解码失败：' + String(text).slice(0, 60)); }
  }

  function charsetName(cs) {
    if (!cs) return 'UTF-8';
    if (typeof cs === 'string') return cs;
    if (cs.name) return String(cs.name);
    return String(cs);
  }

  function normCharset(cs) {
    return charsetName(cs).toUpperCase().replace(/[-_]/g, '');
  }

  function bytesToStr(bytes, cs) {
    var name = normCharset(cs);
    if (name === 'ISO88591' || name === 'LATIN1' || name === 'ISO885915'
      || name === 'USASCII' || name === 'ASCII') {
      return bytesToBinary(bytes);
    }
    if (name !== '' && name !== 'UTF8' && typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder(charsetName(cs)).decode(new Uint8Array(bytes)); } catch (e) { /* 退回 UTF-8 */ }
    }
    return bytesToUtf8(bytes);
  }

  function strToBytesCharset(s, cs) {
    var name = normCharset(cs);
    if (name === 'ISO88591' || name === 'LATIN1') {
      var str = String(s == null ? '' : s), out = [];
      for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xFF);
      return out;
    }
    if (name === 'GBK' || name === 'GB2312' || name === 'GB18030') {
      throw new Error('把字符串编码成 ' + charsetName(cs) + ' 字节暂不支持（浏览器 TextEncoder 只有 UTF-8）');
    }
    return utf8Bytes(s);
  }

  /* ------------------------------------------------------------ MD5（书源里常用，渲染层没有 crypto） */
  function md5Words(bytes) {
    var b = Array.prototype.slice.call(bytes || []);
    var n = b.length, bitLen = n * 8, i;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    var words = [];
    for (i = 0; i < b.length; i += 4) {
      words.push(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    }
    words.push(bitLen & 0xFFFFFFFF);
    words.push((bitLen / 0x100000000) | 0);
    return words;
  }

  function md5Hex(bytes) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function aus(a, b) { return (a + b) & 0xFFFFFFFF; }
    function cmn(q, a, b, x, s, t) { return aus(rl(aus(aus(a, q), aus(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

    var x = md5Words(bytes);
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var k = 0; k < x.length; k += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, x[k], 7, -680876936); d = ff(d, a, b, c, x[k + 1], 12, -389564586);
      c = ff(c, d, a, b, x[k + 2], 17, 606105819); b = ff(b, c, d, a, x[k + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[k + 4], 7, -176418897); d = ff(d, a, b, c, x[k + 5], 12, 1200080426);
      c = ff(c, d, a, b, x[k + 6], 17, -1473231341); b = ff(b, c, d, a, x[k + 7], 22, -45705983);
      a = ff(a, b, c, d, x[k + 8], 7, 1770035416); d = ff(d, a, b, c, x[k + 9], 12, -1958414417);
      c = ff(c, d, a, b, x[k + 10], 17, -42063); b = ff(b, c, d, a, x[k + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[k + 12], 7, 1804603682); d = ff(d, a, b, c, x[k + 13], 12, -40341101);
      c = ff(c, d, a, b, x[k + 14], 17, -1502002290); b = ff(b, c, d, a, x[k + 15], 22, 1236535329);
      a = gg(a, b, c, d, x[k + 1], 5, -165796510); d = gg(d, a, b, c, x[k + 6], 9, -1069501632);
      c = gg(c, d, a, b, x[k + 11], 14, 643717713); b = gg(b, c, d, a, x[k], 20, -373897302);
      a = gg(a, b, c, d, x[k + 5], 5, -701558691); d = gg(d, a, b, c, x[k + 10], 9, 38016083);
      c = gg(c, d, a, b, x[k + 15], 14, -660478335); b = gg(b, c, d, a, x[k + 4], 20, -405537848);
      a = gg(a, b, c, d, x[k + 9], 5, 568446438); d = gg(d, a, b, c, x[k + 14], 9, -1019803690);
      c = gg(c, d, a, b, x[k + 3], 14, -187363961); b = gg(b, c, d, a, x[k + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[k + 13], 5, -1444681467); d = gg(d, a, b, c, x[k + 2], 9, -51403784);
      c = gg(c, d, a, b, x[k + 7], 14, 1735328473); b = gg(b, c, d, a, x[k + 12], 20, -1926607734);
      a = hh(a, b, c, d, x[k + 5], 4, -378558); d = hh(d, a, b, c, x[k + 8], 11, -2022574463);
      c = hh(c, d, a, b, x[k + 11], 16, 1839030562); b = hh(b, c, d, a, x[k + 14], 23, -35309556);
      a = hh(a, b, c, d, x[k + 1], 4, -1530992060); d = hh(d, a, b, c, x[k + 4], 11, 1272893353);
      c = hh(c, d, a, b, x[k + 7], 16, -155497632); b = hh(b, c, d, a, x[k + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[k + 13], 4, 681279174); d = hh(d, a, b, c, x[k], 11, -358537222);
      c = hh(c, d, a, b, x[k + 3], 16, -722521979); b = hh(b, c, d, a, x[k + 6], 23, 76029189);
      a = hh(a, b, c, d, x[k + 9], 4, -640364487); d = hh(d, a, b, c, x[k + 12], 11, -421815835);
      c = hh(c, d, a, b, x[k + 15], 16, 530742520); b = hh(b, c, d, a, x[k + 2], 23, -995338651);
      a = ii(a, b, c, d, x[k], 6, -198630844); d = ii(d, a, b, c, x[k + 7], 10, 1126891415);
      c = ii(c, d, a, b, x[k + 14], 15, -1416354905); b = ii(b, c, d, a, x[k + 5], 21, -57434055);
      a = ii(a, b, c, d, x[k + 12], 6, 1700485571); d = ii(d, a, b, c, x[k + 3], 10, -1894986606);
      c = ii(c, d, a, b, x[k + 10], 15, -1051523); b = ii(b, c, d, a, x[k + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[k + 8], 6, 1873313359); d = ii(d, a, b, c, x[k + 15], 10, -30611744);
      c = ii(c, d, a, b, x[k + 6], 15, -1560198380); b = ii(b, c, d, a, x[k + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[k + 4], 6, -145523070); d = ii(d, a, b, c, x[k + 11], 10, -1120210379);
      c = ii(c, d, a, b, x[k + 2], 15, 718787259); b = ii(b, c, d, a, x[k + 9], 21, -343485551);
      a = aus(a, oa); b = aus(b, ob); c = aus(c, oc); d = aus(d, od);
    }
    function hex(n) {
      var s = '';
      for (var i = 0; i < 4; i++) {
        s += ('0' + ((n >> (i * 8)) & 0xFF).toString(16)).slice(-2);
      }
      return s;
    }
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  function md5(str) { return md5Hex(utf8Bytes(str)); }

  /* ------------------------------------------------------------ SHA-1 / SHA-256（纯 JS） */
  function sha1Bytes(bytes) {
    var msg = Array.prototype.slice.call(bytes || []);
    var bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var hi = Math.floor(bitLen / 0x100000000) >>> 0, lo = bitLen >>> 0;
    msg.push((hi >>> 24) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF);
    msg.push((lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF);

    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Array(80);
    for (var off = 0; off < msg.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16)
          | (msg[off + i * 4 + 2] << 8) | (msg[off + i * 4 + 3]);
      }
      for (i = 16; i < 80; i++) {
        var x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (i = 0; i < 80; i++) {
        var f, k;
        if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var t = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0);
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    var out = [];
    [h0, h1, h2, h3, h4].forEach(function (h) {
      out.push((h >>> 24) & 0xFF, (h >>> 16) & 0xFF, (h >>> 8) & 0xFF, h & 0xFF);
    });
    return out;
  }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256Bytes(bytes) {
    var msg = Array.prototype.slice.call(bytes || []);
    var bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var hi = Math.floor(bitLen / 0x100000000) >>> 0, lo = bitLen >>> 0;
    msg.push((hi >>> 24) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF);
    msg.push((lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < msg.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16)
          | (msg[off + i * 4 + 2] << 8) | (msg[off + i * 4 + 3]);
      }
      for (i = 16; i < 64; i++) {
        var s0 = ror32(w[i - 15], 7) ^ ror32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = ror32(w[i - 2], 17) ^ ror32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25);
        var ch = (e & f) ^ ((~e) & g);
        var t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
        var S0 = ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    H.forEach(function (v) {
      out.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
    });
    return out;
  }

  function ror32(x, n) { return (x >>> n) | (x << (32 - n)); }

  /** 算法名 → 字节摘要函数（只实现渲染层能同步算的三个） */
  var HASHES = {
    MD5: function (b) { return hexToBytes(md5Hex(b)); },
    SHA1: function (b) { return sha1Bytes(b); },
    SHA256: function (b) { return sha256Bytes(b); }
  };

  function hashName(algo) {
    return String(algo == null ? 'MD5' : algo).toUpperCase().replace(/[-_\s]/g, '');
  }

  /* =========================================================================
   * PATCH API-2：jsoup 风格 DOM facade
   * -------------------------------------------------------------------------
   * 语料里 63 个源用 org.jsoup（其中 58 个用 Jsoup.parse）。iread 里它是直接
   * throw 的桩。这里把 DOMParser 的真 DOM 包成 jsoup 风格：
   *   Document: select / selectFirst / text / html / outerHtml / body / head /
   *             title / child / children / size / get / first / last / each / getAllElements
   *   Element : 上面那些 + attr / hasAttr / hasClass / ownText / clone / remove /
   *             parent / absUrl / tagName / id / child(i) / children / toString
   *   Elements: size / get / first / last / eq / text / attr / each / add / remove / isEmpty
   * text() 走 NR.rule.jsoupText（patched/rule.js 导出的同一份 jsoup Element.text()
   * 实现），保证 org.jsoup 路径与 @text 路径逐字一致。
   * ========================================================================= */
  /** Element.text()：复用 patched/rule.js 的 jsoupText（单一实现，别另写一套） */
  function jsoupTextOf(el) {
    if (!el) return '';
    if (NR.rule && typeof NR.rule.jsoupText === 'function') return NR.rule.jsoupText(el);
    return norm(el.textContent);   // rule.js 不在时退化成旧行为
  }

  function unquoteSel(s) {
    var t = String(s == null ? '' : s).trim();
    if (t.length >= 2 && (t.charAt(0) === '"' || t.charAt(0) === "'")
      && t.charAt(t.length - 1) === t.charAt(0)) {
      return t.slice(1, -1);
    }
    return t;
  }

  /** jsoup 允许、CSS 不允许的写法（[href^=/video/] 这种未加引号的属性值）→ 补引号 */
  function repairCss(sel) {
    return String(sel).replace(
      /\[\s*([\w:.-]+)\s*(\^=|\$=|\*=|~=|\|=|!=|=)\s*([^\]"'\s][^\]]*?)\s*\]/g,
      function (m, name, op, val) {
        var v = val.trim();
        if (/^[A-Za-z_][\w-]*$/.test(v)) return m;
        return '[' + name + op + '"' + v.replace(/"/g, '\\"') + '"]';
      });
  }

  /**
   * 选择器求值：jsoup 的 :contains(x) / :eq(n) 在 CSS 里没有 → 摘出来在结果集上后置过滤；
   * 其余按 CSS 走，失败时用 repairCss 修一次，再失败就返回空集（与旧行为一致）。
   */
  function selectNodes(root, sel) {
    if (!root || !root.querySelectorAll) return [];
    var s = String(sel == null ? '' : sel).trim();
    if (!s) return [];
    var post = [];
    s = s.replace(/:contains\(\s*((?:"[^"]*")|(?:'[^']*')|[^()]*)\s*\)/g, function (m, v) {
      post.push({ k: 'contains', v: unquoteSel(v) });
      return '';
    });
    s = s.replace(/:eq\(\s*(-?\d+)\s*\)/g, function (m, n) {
      post.push({ k: 'eq', v: parseInt(n, 10) });
      return '';
    });
    if (!s.trim()) s = '*';
    var list;
    try {
      list = root.querySelectorAll(s);
    } catch (e1) {
      try { list = root.querySelectorAll(repairCss(s)); } catch (e2) { return []; }
    }
    var nodes = Array.prototype.slice.call(list || []);
    post.forEach(function (f) {
      if (f.k === 'contains') {
        var needle = String(f.v).toLowerCase();
        nodes = nodes.filter(function (n) {
          return String(n.textContent || '').toLowerCase().indexOf(needle) >= 0;
        });
      } else if (f.k === 'eq') {
        var i = f.v < 0 ? nodes.length + f.v : f.v;
        nodes = nodes[i] ? [nodes[i]] : [];
      }
    });
    return nodes;
  }

  function baseUriOf(el) {
    var n = el;
    while (n) {
      if (n.__yeduBase) return n.__yeduBase;
      n = n.parentNode;
    }
    try { return (typeof document !== 'undefined' && document.baseURI) || ''; } catch (e) { return ''; }
  }

  /** jsoup Node.absUrl(name) / attr("abs:href") */
  function absUrlOf(el, name) {
    var raw = String(el.getAttribute(name) == null ? '' : el.getAttribute(name));
    if (!raw) return '';
    var base = baseUriOf(el);
    if (!base) return raw;
    try { return new URL(raw, base).href; } catch (e) { return raw; }
  }

  /** 给 DOM 元素挂方法：不能直接赋值（<a>.text / tagName 之类是原生访问器，赋值会被吞掉） */
  function defMethod(obj, name, fn) {
    try {
      Object.defineProperty(obj, name, {
        value: fn, configurable: true, writable: true, enumerable: false
      });
    } catch (e) {
      try { obj[name] = fn; } catch (e2) { /* 挂不上就算了，别把整条规则带崩 */ }
    }
  }

  /** 给一个 DOM 元素挂上 jsoup Element 方法（幂等；wrap() 就是它的别名） */
  function attachElApi(el, baseUri) {
    if (!el || el.nodeType !== 1) return el;
    if (baseUri) el.__yeduBase = String(baseUri);
    if (el.__yeduWrap) return el;
    el.__yeduWrap = true;

    defMethod(el, 'text', function (v) {
      if (v === undefined) return jsoupTextOf(el);
      el.textContent = String(v == null ? '' : v);
      return el;
    });
    defMethod(el, 'ownText', function () {
      var s = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
      }
      return norm(s);
    });
    defMethod(el, 'html', function (v) {
      if (v === undefined) return String(el.innerHTML || '');
      el.innerHTML = String(v == null ? '' : v);
      return el;
    });
    defMethod(el, 'outerHtml', function () { return String(el.outerHTML || ''); });
    defMethod(el, 'attr', function (n, v) {
      var k = String(n == null ? '' : n);
      if (v !== undefined) { el.setAttribute(k, String(v == null ? '' : v)); return el; }
      if (k.length > 4 && k.slice(0, 4) === 'abs:') return absUrlOf(el, k.slice(4));
      return String(el.getAttribute(k) == null ? '' : el.getAttribute(k));
    });
    defMethod(el, 'hasAttr', function (n) { return el.hasAttribute(String(n)); });
    defMethod(el, 'removeAttr', function (n) { el.removeAttribute(String(n)); return el; });
    defMethod(el, 'absUrl', function (n) { return absUrlOf(el, String(n)); });
    defMethod(el, 'hasClass', function (c) { return !!(el.classList && el.classList.contains(String(c))); });
    defMethod(el, 'select', function (sel) { return wrapList(selectNodes(el, sel)); });
    defMethod(el, 'selectFirst', function (sel) {
      var nodes = selectNodes(el, sel);
      return nodes.length ? wrap(nodes[0]) : null;
    });
    defMethod(el, 'size', function () { return 1; });
    defMethod(el, 'get', function (i) { return i === 0 ? el : null; });
    defMethod(el, 'first', function () { return el; });
    defMethod(el, 'last', function () { return el; });
    defMethod(el, 'eq', function (i) { return wrapList(Number(i) === 0 ? [el] : []); });
    defMethod(el, 'each', function (fn) { fn.call(el, 0, el); return wrapList([el]); });
    defMethod(el, 'clone', function () {
      var c = el.cloneNode(true);
      return attachElApi(c, baseUriOf(el));
    });
    defMethod(el, 'remove', function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      return el;
    });
    defMethod(el, 'parent', function () { return el.parentElement ? wrap(el.parentElement) : null; });
    defMethod(el, 'child', function (i) {
      var kids = el.children || [];
      return kids[i] ? wrap(kids[i]) : null;
    });
    defMethod(el, 'childrenList', function () { return wrapList(el.children || []); });
    defMethod(el, 'childNodeSize', function () { return el.childNodes ? el.childNodes.length : 0; });
    defMethod(el, 'toString', function () { return String(el.outerHTML || ''); });
    return el;
  }

  function wrap(el) { return attachElApi(el); }

  function wrapList(nodeList) {
    var arr = Array.prototype.slice.call(nodeList || []).map(function (n) { return wrap(n); });
    arr.size = function () { return arr.length; };
    arr.get = function (i) { return arr[i]; };
    arr.first = function () { return arr[0]; };
    arr.last = function () { return arr[arr.length - 1]; };
    arr.eq = function (i) {
      var n = Number(i);
      if (n < 0) n = arr.length + n;
      return wrapList(arr[n] ? [arr[n]] : []);
    };
    arr.text = function () {
      return arr.map(function (e) { return jsoupTextOf(e); })
        .filter(function (s) { return s; }).join(' ');
    };
    arr.outerHtml = function () {
      return arr.map(function (e) { return String(e.outerHTML || ''); }).join('\n');
    };
    arr.html = function (i) {
      var n = i === undefined ? 0 : Number(i);
      return arr[n] ? String(arr[n].innerHTML || '') : '';
    };
    arr.attr = function (k) { return arr[0] ? String(arr[0].getAttribute(k) == null ? '' : arr[0].getAttribute(k)) : ''; };
    arr.each = function (fn) { arr.forEach(function (e, i) { fn.call(e, i, e); }); return arr; };
    arr.isEmpty = function () { return arr.length === 0; };
    arr.toArray = function () { return arr.slice(); };
    // jsoup 的 Elements 没有 select，但真实书源会写 box.select('…').remove() —— 给个「并集」语义
    arr.select = function (sel) {
      var out = [];
      arr.forEach(function (e) {
        if (!e || !e.querySelectorAll) return;
        selectNodes(e, sel).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
      });
      return wrapList(out);
    };
    arr.selectFirst = function (sel) {
      var l = arr.select(sel);
      return l.length ? l[0] : null;
    };
    arr.add = function (el) { if (el) arr.push(wrap(el)); return arr; };
    arr.remove = function () {
      arr.forEach(function (e) { if (e.parentNode) e.parentNode.removeChild(e); });
      return arr;
    };
    arr.toString = function () { return arr.outerHtml(); };
    return arr;
  }

  /** Jsoup.parse(html[, baseUri]) → jsoup 风格 Document（返回的是 <html> 元素本体） */
  function parseDocFacade(html, baseUri) {
    var d = parseDoc(html);
    if (!d || !d.documentElement) d = parseDoc('<html><body></body></html>');
    if (!d || !d.documentElement) {
      // 连空文档都造不出来时给一个最小可用的假元素
      return wrapList([]);
    }
    var root = d.documentElement;
    var base = baseUri == null ? '' : String(baseUri);
    attachElApi(root, base);
    defMethod(root, 'body', function () { return d.body ? wrap(d.body) : null; });
    defMethod(root, 'head', function () { return d.head ? wrap(d.head) : null; });
    defMethod(root, 'title', function () { return String(d.title || ''); });
    defMethod(root, 'location', function () { return base || baseUriOf(root); });
    defMethod(root, 'text', function () { return jsoupTextOf(d.body || root); });
    defMethod(root, 'getAllElements', function () {
      var all = [root].concat(Array.prototype.slice.call(root.getElementsByTagName('*')));
      return wrapList(all);
    });
    // jsoup 的 Document.createElement(tag)：造一个游离元素，可 attr/text 设值后塞进结果列表
    defMethod(root, 'createElement', function (tag) {
      var name = String(tag == null ? 'div' : tag).toLowerCase();
      var el = null;
      try { el = d.createElement(name); } catch (e) { el = null; }
      if (!el) return null;
      attachElApi(el, base);
      return el;
    });
    defMethod(root, 'clone', function () { return parseDocFacade(String(root.outerHTML || ''), base); });
    return root;
  }

  /* =========================================================================
   * PATCH API-3：java.* 缺失面 —— 别名 / 薄封装 / 命名空间
   * ========================================================================= */

  /** java.lang.String：既能 java.lang.String(x) 当普通函数，也能 new 它拿 .getBytes() */
  function makeJavaStringClass() {
    function JS_(v, cs) {
      // P B 档：Legado 官方测试用 `java.lang.String('k').getBytes('UTF-8')`（非 new 调用也要能拿
      // byte[]），所以非 new 路径也返回实例（带 toString/valueOf，字符串上下文里仍然像字符串）。
      if (!(this instanceof JS_)) return new JS_(v, cs);
      this.__javaString = true;
      this.__charset = cs == null ? '' : charsetName(cs);
      this.__value = javaStr(v, this.__charset);
    }
    function proto(name, fn) { JS_.prototype[name] = fn; }
    proto('toString', function () { return this.__value; });
    proto('valueOf', function () { return this.__value; });
    proto('getBytes', function (cs) {
      return byteArray(strToBytesCharset(this.__value, cs == null ? this.__charset : cs));
    });
    proto('length', function () { return this.__value.length; });
    proto('charAt', function (i) { return this.__value.charAt(i); });
    proto('indexOf', function (s, from) { return this.__value.indexOf(String(s), from || 0); });
    proto('contains', function (s) { return this.__value.indexOf(String(s)) >= 0; });
    proto('substring', function (a, b) {
      return this.__value.substring(a, b === undefined ? this.__value.length : b);
    });
    proto('trim', function () { return this.__value.replace(/^\s+|\s+$/g, ''); });
    proto('toUpperCase', function () { return this.__value.toUpperCase(); });
    proto('toLowerCase', function () { return this.__value.toLowerCase(); });
    proto('isEmpty', function () { return this.__value.length === 0; });
    proto('equals', function (o) { return this.__value === javaStr(o); });
    proto('equalsIgnoreCase', function (o) {
      return this.__value.toLowerCase() === javaStr(o).toLowerCase();
    });
    proto('startsWith', function (s) { return this.__value.indexOf(String(s)) === 0; });
    proto('endsWith', function (s) {
      var t = String(s);
      return this.__value.slice(this.__value.length - t.length) === t;
    });
    proto('replace', function (a, b) { return this.__value.split(String(a)).join(String(b)); });
    proto('split', function (sep) { return this.__value.split(new RegExp(String(sep))); });
    return JS_;
  }

  /** String 语义：字符串直传；byte[] → 按 charset 解码（Java 的 new String(byte[])） */
  function javaStr(v, cs) {
    if (v == null) return 'null';
    if (Array.isArray(v)) return bytesToStr(v, cs);
    if (typeof v === 'object') {
      if (v.__javaString) return v.__value;
      if (typeof v.length === 'number' && typeof v.BYTES_PER_ELEMENT === 'number') {
        return bytesToStr(Array.prototype.slice.call(v), cs);
      }
    }
    return String(v);
  }

  /** java.util.Base64（Encoder / Decoder） */
  function makeBase64Class() {
    function encoder(pad) {
      return {
        encodeToString: function (v) {
          var b64 = bytesToBase64(toBytes(v));
          return pad === false ? b64.replace(/=+$/, '') : b64;
        },
        encode: function (v) { return byteArray(base64ToBytes(encoder(true).encodeToString(v))); },
        withoutPadding: function () { return encoder(false); }
      };
    }
    function decoder() {
      return {
        decode: function (v) {
          var bytes = base64ToBytes(typeof v === 'object' && v != null && !Array.isArray(v)
            ? String(v) : v);
          // Java 返回 byte[]；给一个 UTF-8 文本的 toString，让 .decode(x).toString() 有意义
          return byteArray(bytes, bytesToUtf8(bytes));
        }
      };
    }
    return {
      getEncoder: function () { return encoder(true); },
      getDecoder: function () { return decoder(); },
      getUrlEncoder: function () { return encoder(true); },
      getUrlDecoder: function () { return decoder(); },
      getMimeEncoder: function () { return encoder(true); },
      getMimeDecoder: function () { return decoder(); }
    };
  }

  /** java.security.MessageDigest（同步；只实现 MD5 / SHA-1 / SHA-256） */
  function makeMessageDigestClass(miss) {
    return {
      getInstance: function (algo) {
        var key = hashName(algo);
        if (!HASHES[key]) {
          throw miss('java.security.MessageDigest.getInstance("' + algo + '")',
            '渲染层同步摘要只实现了 MD5 / SHA-1 / SHA-256');
        }
        var buf = [];
        var api = {
          update: function (v) {
            buf = buf.concat(toBytes(v));
            return api;
          },
          digest: function (v) {
            if (v !== undefined) api.update(v);
            var out = HASHES[key](buf);
            buf = [];
            return byteArray(out, bytesToHex(out));
          },
          reset: function () { buf = []; return api; },
          getAlgorithm: function () { return String(algo); }
        };
        return api;
      }
    };
  }

  /** java.util.Arrays（书源里只用 copyOfRange / copyOf / asList 这几个） */
  var JAVA_ARRAYS = {
    asList: function () {
      var a = [];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      return a;
    },
    copyOfRange: function (a, from, to) {
      return byteArray(Array.prototype.slice.call(a || []).slice(Number(from) || 0, Number(to)));
    },
    copyOf: function (a, n) {
      var s = Array.prototype.slice.call(a || []);
      n = Number(n);
      if (isNaN(n) || n <= s.length) return byteArray(s.slice(0, isNaN(n) ? s.length : n));
      while (s.length < n) s.push(0);
      return byteArray(s);
    },
    toString: function (a) { return '[' + Array.prototype.slice.call(a || []).join(', ') + ']'; },
    sort: function (a) { Array.prototype.sort.call(a || []); return a; }
  };

  /** java.io.ByteArrayOutputStream（纸间那几个 jsLib 拼字节用） */
  function ByteArrayOutputStream() {
    var buf = [];
    this.write = function (v, off, len) {
      if (typeof v === 'number') { buf.push(v & 0xFF); return; }
      var b = toBytes(v);
      if (typeof off === 'number') b = b.slice(off, typeof len === 'number' ? off + len : undefined);
      buf = buf.concat(b);
      return this;
    };
    this.toByteArray = function () { return byteArray(buf); };
    this.size = function () { return buf.length; };
    this.reset = function () { buf = []; };
    this.toString = function (cs) { return bytesToStr(buf, cs); };
    return this;
  }

  /** java.security.SecureRandom（纸间拿它生成验证码串，弱随机足够） */
  function SecureRandom() {
    this.nextInt = function (n) {
      var m = Number(n);
      if (!m || m <= 0) return Math.floor(Math.random() * 2147483647);
      return Math.floor(Math.random() * m);
    };
    this.nextBytes = function (a) {
      if (a && typeof a.length === 'number') {
        for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
      }
      return a;
    };
    return this;
  }

  var JAVA_CHARSET = {
    forName: function (n) {
      return { name: String(n), toString: function () { return String(n); } };
    }
  };

  /* =========================================================================
   * PATCH SOURCE-API-2：java.net / java.math 的最小可用类
   * -------------------------------------------------------------------------
   * 语料实测：java.net.URL 8 源（多半是 `new Packages.java.net.URL(u).openConnection()`，
   * 用来绕过 java.ajax 的 header 限制）、URLEncoder/URLDecoder 各 1~2 源（58小说网
   * 拿它替代 encodeURIComponent，**必须**是 Java 语义才拼得对 POST）、
   * InetAddress.getByName 4~8 源（pixiv 系探测线路）、BigInteger 5 源（某站系 DH 换密钥）。
   * 一律实现成「浏览器里能算的那部分」，算不了的走 missError 或 warnOnce。
   * ========================================================================= */

  /* ---- java.net.URLEncoder / URLDecoder：Java 语义（不是 encodeURIComponent） ---- */
  /** Java：字母数字 + `-_.*` 原样，空格→`+`，其余按 UTF-8 逐字节 %XX（大写十六进制） */
  function javaUrlEncode(v) {
    var bytes = utf8Bytes(v == null ? '' : v);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i] & 0xFF;
      var ch = String.fromCharCode(c);
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
        || ch === '-' || ch === '_' || ch === '.' || ch === '*') {
        out += ch;
      } else if (c === 0x20) {
        out += '+';
      } else {
        out += '%' + ('0' + c.toString(16).toUpperCase()).slice(-2);
      }
    }
    return out;
  }

  /** 逆运算：`+`→空格，`%XX`→字节，再按 charset 解（默认 UTF-8） */
  function javaUrlDecode(v, cs) {
    var t = String(v == null ? '' : v);
    var bytes = [];
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (ch === '+') { bytes.push(0x20); continue; }
      if (ch === '%' && i + 2 < t.length) {
        var hex = t.substr(i + 1, 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
      }
      // 原样字符（Java 里 %XX 之外的字符按 charset 编码，这里按 UTF-8 摊成字节）
      var b = utf8Bytes(ch);
      for (var j = 0; j < b.length; j++) bytes.push(b[j]);
    }
    return bytesToStr(bytes, cs);
  }

  var JAVA_URL_ENCODER = { encode: javaUrlEncode, encodeToString: javaUrlEncode };
  var JAVA_URL_DECODER = { decode: javaUrlDecode, decodeToString: javaUrlDecode };

  /* ---- java.net.URL ---- */
  /** 连接门面：只做「链式 setter + 真的发一次同步请求」，够 5 个源的 openConnection 用法 */
  function javaUrlConnection(href) {
    var opts = { headers: {}, method: 'GET' };
    var cache = { body: null, done: false };
    function body() {
      if (!cache.done) { cache.body = syncFetch(href, opts); cache.done = true; }
      return cache.body;
    }
    function chain(name) {
      return function () { if (name === 'setDoOutput') opts.method = opts.method === 'GET' ? 'POST' : opts.method; return api; };
    }
    var api = {
      setRequestMethod: function (m) { opts.method = String(m || 'GET').toUpperCase(); return api; },
      setRequestProperty: function (k, v) { opts.headers[String(k)] = String(v); return api; },
      addRequestProperty: function (k, v) { opts.headers[String(k)] = String(v); return api; },
      setDoOutput: function () { if (opts.method === 'GET') opts.method = 'POST'; return api; },
      setDoInput: chain(), setUseCaches: chain(), setInstanceFollowRedirects: chain(),
      setConnectTimeout: chain(), setReadTimeout: chain(), setFollowRedirects: chain(),
      connect: function () { body(); },
      getResponseCode: function () { body(); return 200; },
      getResponseMessage: function () { return 'OK'; },
      getInputStream: function () { return streamOfText(body()); },
      getErrorStream: function () { return null; },
      getHeaderField: function () { return null; },
      getHeaderFields: function () { return {}; },
      getContentLength: function () { return body().length; },
      getURL: function () { return href; },
      disconnect: function () { },
      toString: function () { return href; }
    };
    return api;
  }

  /** 把一个字符串包成 InputStream 样子（readAllBytes / read / close） */
  function streamOfText(text) {
    var bytes = utf8Bytes(text == null ? '' : text), pos = 0;
    return {
      readAllBytes: function () { var out = byteArray(bytes); pos = bytes.length; return out; },
      read: function () { return pos < bytes.length ? bytes[pos++] : -1; },
      available: function () { return bytes.length - pos; },
      close: function () { },
      toString: function () { return String(text == null ? '' : text); }
    };
  }

  /**
   * java.net.URL：用浏览器的 URL 实现；`new URL(spec)` / `URL(spec, base)` /
   * 相对地址按 baseUrl 补全。既支持 `new Packages.java.net.URL(u)`，
   * 也支持语料里那种忘写 new 的 `Packages.java.net.URL(u).openConnection()`。
   */
  function makeUrlClass(defaultBase) {
    function JavaUrl(spec, base) {
      var raw = String(spec == null ? '' : spec);
      var u = null;
      var bases = [];
      if (base != null && base !== '') bases.push(String(base));
      bases.push(null);                                   // 先按绝对地址试
      if (defaultBase) bases.push(String(defaultBase));   // 相对地址用调用方的 baseUrl
      for (var i = 0; i < bases.length && !u; i++) {
        try { u = bases[i] ? new URL(raw, bases[i]) : new URL(raw); }
        catch (e) { /* 换下一个 base 再试 */ }
      }
      if (!u) {
        try { u = new URL(raw, 'http://relative.invalid/'); }   // 实在不行也别炸
        catch (e2) { return null; }
      }
      var href = u.href;
      var port = u.port ? Number(u.port) : -1;
      var api = {
        getProtocol: function () { return String(u.protocol || '').replace(/:$/, ''); },
        getHost: function () { return String(u.hostname || ''); },
        getPort: function () { return port; },
        getDefaultPort: function () {
          var p = String(u.protocol || '');
          return p === 'https:' ? 443 : (p === 'http:' ? 80 : -1);
        },
        getPath: function () { return String(u.pathname || ''); },
        getFile: function () { return String(u.pathname || '') + String(u.search || ''); },
        getQuery: function () { return String(u.search || '').replace(/^\?/, ''); },
        getRef: function () { return String(u.hash || '').replace(/^#/, ''); },
        getAuthority: function () { return String(u.host || ''); },
        getUserInfo: function () {
          if (!u.username) return '';
          return decodeURIComponent(u.username) + (u.password ? ':' + decodeURIComponent(u.password) : '');
        },
        openConnection: function () { return javaUrlConnection(href); },
        openStream: function () { return streamOfText(syncFetch(href, {})); },
        toURI: function () { return { toString: function () { return href; }, href: href }; },
        toExternalForm: function () { return href; },
        equals: function (o) { return String(o) === href; },
        hashCode: function () { return href.length; },
        toString: function () { return href; }
      };
      return api;
    }
    JavaUrl.__javaUrl = true;
    return JavaUrl;
  }

  /* ---- java.net.InetAddress（浏览器解析不了 IP，返回 host 本身 + warn 一次） ---- */
  function makeInetAddressClass() {
    function handle(host) {
      var h = String(host == null ? '' : host);
      return {
        getHostAddress: function () { return h; },
        getHostName: function () { return h; },
        getCanonicalHostName: function () { return h; },
        isReachable: function () { return false; },
        equals: function (o) { return String(o) === h; },
        hashCode: function () { return h.length; },
        toString: function () { return h; }
      };
    }
    return {
      getByName: function (host) {
        warnOnce('java.net.InetAddress.getByName',
          'java.net.InetAddress.getByName 在渲染层不做 DNS 解析，返回 host 本身（' + String(host) + '）');
        return handle(host);
      },
      getAllByName: function (host) { return [handle(host)]; },
      getLocalHost: function () { return handle('127.0.0.1'); },
      getByAddress: function (a) {
        var arr = Array.prototype.slice.call(a || []);
        return handle(arr.map(function (n) { return Number(n) & 0xFF; }).join('.'));
      },
      getLoopbackAddress: function () { return handle('127.0.0.1'); }
    };
  }

  /* ---- java.math.BigInteger（用原生 BigInt 实现，语料里是 DH 换密钥） ---- */
  function makeBigIntegerClass() {
    var hasNative = (typeof BigInt !== 'undefined');
    var ZERO_N = hasNative ? BigInt(0) : 0;

    function toN(v) {
      if (v == null) return ZERO_N;
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number') return BigInt(Math.floor(v));
      if (typeof v === 'string') return parseN(v, 10);
      if (v.__big !== undefined) return v.__big;
      if (typeof v.length === 'number') {             // byte[]
        var bytes = Array.prototype.slice.call(v).map(function (n) { return Number(n) & 0xFF; });
        var neg = bytes.length && (bytes[0] & 0x80);
        if (neg) {
          for (var i = 0; i < bytes.length; i++) bytes[i] = 0xFF - bytes[i];
          var carry = 1;
          for (var j = bytes.length - 1; j >= 0 && carry; j--) { var s2 = bytes[j] + carry; bytes[j] = s2 & 0xFF; carry = s2 >> 8; }
        }
        var acc = BigInt(0);
        for (var k = 0; k < bytes.length; k++) acc = (acc << BigInt(8)) + BigInt(bytes[k]);
        return neg ? -acc : acc;
      }
      return BigInt(String(v));
    }

    function parseN(s, radix) {
      var t = String(s == null ? '' : s).trim();
      if (t === '') return BigInt(0);
      var r = Number(radix) || 10;
      var negSign = false;
      if (t.charAt(0) === '-') { negSign = true; t = t.slice(1); }
      else if (t.charAt(0) === '+') { t = t.slice(1); }
      var acc = BigInt(0), base = BigInt(r);
      for (var i = 0; i < t.length; i++) {
        var d = parseInt(t.charAt(i), r);
        if (isNaN(d)) break;                          // 与 Java 不同：脏字符就截断，别炸
        acc = acc * base + BigInt(d);
      }
      return negSign ? -acc : acc;
    }

    function wrap(v) {
      var api = {
        __big: v,
        add: function (o) { return wrap(v + toN(o)); },
        subtract: function (o) { return wrap(v - toN(o)); },
        multiply: function (o) { return wrap(v * toN(o)); },
        divide: function (o) { return wrap(v / toN(o)); },
        remainder: function (o) { return wrap(v % toN(o)); },
        mod: function (o) {
          var m = toN(o);
          var r = v % m;
          return wrap(r < ZERO_N ? r + m : r);
        },
        modPow: function (e, m) {
          var exp = toN(e), mod = toN(m);
          if (mod <= ZERO_N) throw new Error('BigInteger.modPow 的模必须为正数');
          if (exp < ZERO_N) throw new Error('BigInteger.modPow 暂不支持负指数');
          var b = ((v % mod) + mod) % mod, r = BigInt(1) % mod;
          while (exp > ZERO_N) {
            if (exp & BigInt(1)) r = (r * b) % mod;
            b = (b * b) % mod;
            exp = exp >> BigInt(1);
          }
          return wrap(r);
        },
        pow: function (n) { return wrap(v ** toN(n)); },
        gcd: function (o) {
          var a = v < ZERO_N ? -v : v, b = toN(o); b = b < ZERO_N ? -b : b;
          while (b) { var t = a % b; a = b; b = t; }
          return wrap(a);
        },
        negate: function () { return wrap(-v); },
        abs: function () { return wrap(v < ZERO_N ? -v : v); },
        shiftLeft: function (n) { return wrap(v << toN(n)); },
        shiftRight: function (n) { return wrap(v >> toN(n)); },
        and: function (o) { return wrap(v & toN(o)); },
        or: function (o) { return wrap(v | toN(o)); },
        xor: function (o) { return wrap(v ^ toN(o)); },
        max: function (o) { return wrap(toN(o) > v ? toN(o) : v); },
        min: function (o) { return wrap(toN(o) < v ? toN(o) : v); },
        compareTo: function (o) { var x = toN(o); return v < x ? -1 : (v > x ? 1 : 0); },
        equals: function (o) { return toN(o) === v; },
        hashCode: function () { return Number(v & BigInt(0xFFFFFFFF)); },
        signum: function () { return v < ZERO_N ? -1 : (v > ZERO_N ? 1 : 0); },
        intValue: function () { return Number(BigInt.asIntN(32, v)); },
        longValue: function () { return Number(BigInt.asIntN(64, v)); },
        doubleValue: function () { return Number(v); },
        floatValue: function () { return Number(v); },
        byteValue: function () { return Number(BigInt.asIntN(8, v)) & 0xFF; },
        bitLength: function () {
          var a = v < ZERO_N ? -v : v, n = 0;
          while (a > ZERO_N) { a = a >> BigInt(1); n++; }
          return n;
        },
        testBit: function (n) { return ((v >> toN(n)) & BigInt(1)) === BigInt(1); },
        toString: function (radix) { return v.toString(radix == null ? 10 : Number(radix) | 0); },
        toByteArray: function () {
          var x = v;
          if (x === ZERO_N) return byteArray([0]);
          var neg = x < ZERO_N, y = neg ? -x : x, bytes = [];
          while (y > ZERO_N) { bytes.unshift(Number(y & BigInt(0xFF))); y = y >> BigInt(8); }
          if (!neg) {
            if (bytes[0] & 0x80) bytes.unshift(0);
          } else {
            for (var i = 0; i < bytes.length; i++) bytes[i] = 0xFF - bytes[i];
            var carry = 1;
            for (var j = bytes.length - 1; j >= 0 && carry; j--) {
              var s3 = bytes[j] + carry; bytes[j] = s3 & 0xFF; carry = s3 >> 8;
            }
            if (!(bytes[0] & 0x80)) bytes.unshift(0xFF);
          }
          return byteArray(bytes);
        }
      };
      return api;
    }

    /** new BigInteger(...)：字符串/数字/进制/比特长度+随机源/符号+byte[] */
    function BigInteger(a, b) {
      if (!hasNative) throw new Error('BigInteger 需要原生 BigInt（当前环境没有）');
      if (typeof a === 'number' && b != null && typeof b === 'object') {
        if (typeof b.length === 'number') return BigInteger.fromBytes(a, b);       // (signum, byte[])
        // (bitLength, rnd)：任意比特长度的非负随机数
        var bits = Math.max(1, Number(a) || 1), nibbles = Math.ceil(bits / 4), s = '';
        for (var i = 0; i < nibbles; i++) s += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
        return wrap(parseN(s, 16) % (BigInt(2) ** BigInt(bits)));
      }
      if (typeof a === 'string' && typeof b === 'number') return wrap(parseN(a, b));
      if (typeof a === 'string' || typeof a === 'number' || typeof a === 'bigint') return wrap(toN(a));
      if (a != null && typeof a.length === 'number') return wrap(toN(a));          // byte[]
      return wrap(ZERO_N);
    }
    BigInteger.fromBytes = function (signum, bytes) {
      var arr = Array.prototype.slice.call(bytes || []).map(function (n) { return Number(n) & 0xFF; });
      var neg = Number(signum) < 0;
      if (neg) {
        for (var i = 0; i < arr.length; i++) arr[i] = 0xFF - arr[i];
        var carry = 1;
        for (var j = arr.length - 1; j >= 0 && carry; j--) { var s2 = arr[j] + carry; arr[j] = s2 & 0xFF; carry = s2 >> 8; }
      }
      var acc = BigInt(0);
      for (var k = 0; k < arr.length; k++) acc = (acc << BigInt(8)) + BigInt(arr[k]);
      return wrap(neg ? -acc : acc);
    };
    BigInteger.valueOf = function (n) { return wrap(toN(n)); };
    BigInteger.ZERO = wrap(ZERO_N);
    BigInteger.ONE = wrap(BigInt(1));
    BigInteger.TWO = wrap(BigInt(2));
    BigInteger.TEN = wrap(BigInt(10));
    BigInteger.probablePrime = function (bits) { return new BigInteger(Math.max(2, Number(bits) || 2), {}); };
    return BigInteger;
  }

  /* BigInteger 与 ctx 无关，模块级建一次（常量共享才谈得上 BigInteger.ONE） */
  var JAVA_BIGINTEGER = makeBigIntegerClass();

  /**
   * 「做不了」的命名空间：属性访问返回下一层（不炸，让 typeof / 探测分支还能跑），
   * 一旦真的调用或 new，就抛一条带书源上下文的、可搜索的错误，并记进 stats.missing。
   */
  function makeUnsupportedNs(path, miss) {
    if (typeof Proxy === 'undefined') return undefined;
    var target = function () { };
    return new Proxy(target, {
      get: function (t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') {
          return function () { return ''; };
        }
        if (prop === 'then') return undefined;
        var p = path ? path + '.' + String(prop) : String(prop);
        return makeUnsupportedNs(p, miss);
      },
      apply: function () { throw miss(path || '未知 Java 类'); },
      construct: function () { throw miss(path || '未知 Java 类'); }
    });
  }

  /* 与 ctx 无关的 Java 类门面，模块级建一次就够 */
  var JAVA_STRING = makeJavaStringClass();
  var JAVA_BASE64 = makeBase64Class();
  var ANDROID_BASE64 = {
    encodeToString: function (v, flags) {
      var s = bytesToBase64(toBytes(v));
      if (typeof flags === 'number' && (flags & 8)) s = s.replace(/\+/g, '-').replace(/\//g, '_');
      return s;
    },
    decode: function (v) { return byteArray(base64ToBytes(String(v)), bytesToUtf8(base64ToBytes(String(v)))); },
    DEFAULT: 0, NO_WRAP: 2, URL_SAFE: 8, NO_PADDING: 1
  };

  /** java.timeFormatUTC(ts, pattern, offset)：offset 按量级判断是小时还是毫秒（语料两种都写过） */
  var DATE_TOKENS = /yyyy|yy|MM|dd|HH|mm|ss|SSS|M|d|H|m|s/g;
  function formatUtc(ts, pattern, offset) {
    var t = Number(ts);
    if (!isFinite(t)) t = Date.now();
    if (t < 1e12) t = t * 1000;                      // 10 位当秒（与 java.timeFormat 一致）
    var off = Number(offset) || 0;
    if (Math.abs(off) < 1000) off = off * 3600 * 1000;
    var d = new Date(t + off);
    var pad = function (n, w) {
      var s = String(n);
      while (s.length < (w || 2)) s = '0' + s;
      return s;
    };
    var map = {
      yyyy: function () { return String(d.getUTCFullYear()); },
      yy: function () { return pad(d.getUTCFullYear() % 100); },
      MM: function () { return pad(d.getUTCMonth() + 1); },
      M: function () { return String(d.getUTCMonth() + 1); },
      dd: function () { return pad(d.getUTCDate()); },
      d: function () { return String(d.getUTCDate()); },
      HH: function () { return pad(d.getUTCHours()); },
      H: function () { return String(d.getUTCHours()); },
      mm: function () { return pad(d.getUTCMinutes()); },
      m: function () { return String(d.getUTCMinutes()); },
      ss: function () { return pad(d.getUTCSeconds()); },
      s: function () { return String(d.getUTCSeconds()); },
      SSS: function () { return pad(d.getUTCMilliseconds(), 3); }
    };
    return String(pattern == null ? 'yyyy-MM-dd HH:mm:ss' : pattern)
      .replace(DATE_TOKENS, function (tk) { return map[tk] ? map[tk]() : tk; });
  }

  /* ------------------------------------------------------------ 环境 */
  function makeEnv(ctx) {    ctx = ctx || {};
    var doc = ctx.doc || (ctx.html ? parseDoc(ctx.html) : null);
    var vars = Object.create(null);
    function memKey(k) { return String(source.url || source.name || '') + '\u0000' + String(k); }
    var source = ctx.source || {};
    var baseUrl = ctx.baseUrl || '';
    var page = Number(ctx.page) || 1;
    var input = ctx.node && ctx.node.nodeType === 1
      ? String(ctx.node.outerHTML || '')
      : (ctx.result != null ? String(ctx.result) : String(ctx.html || ''));

    function ensureDoc() {
      if (!doc) doc = parseDoc('<html><body></body></html>');
      return doc;
    }

    function elements(css) {
      var t = toCss(css);
      var list;
      try { list = ensureDoc().querySelectorAll(t.css); }
      catch (e) { return wrapList([]); }
      var arr = wrapList(list);
      if (t.index != null) {
        var i = t.index < 0 ? arr.length + t.index : t.index;
        arr = wrapList(arr[i] ? [arr[i]] : []);
      }
      return arr;
    }

    /**
     * 「这个源为什么不行」的唯一出口：拼一条带书源上下文的错误 + 记账。
     * 记进 NR.legacyJs.stats.missing[api]，同一个 api 只 warn 一次（避免刷屏）。
     */
    function missError(api, hint) {
      var count = (STATS.missing[api] = (STATS.missing[api] || 0) + 1);
      var where = [];
      if (source && source.name) where.push('书源：' + source.name);
      var ruleText = ctx.rule || ctx.field || '';
      if (ruleText) where.push('规则：' + String(ruleText).replace(/\s+/g, ' ').slice(0, 80));
      var msg = String(api) + ' 暂不支持（' + (where.join('，') || '书源未知')
        + (hint ? '；' + hint : '') + '）';
      if (!STATS.warned[api]) {
        STATS.warned[api] = count;
        try { console.warn('[legacy-js] ' + msg); } catch (e) { /* ignore */ }
      }
      var err = new Error(msg);
      err.code = 'UNSUPPORTED';
      err.api = String(api);
      err.__yeduMissingApi = String(api);
      return err;
    }

    /* ---- jsoup 门面（org.jsoup.Jsoup，58 源） ---- */
    /** jsoup 的 Connection：语料里 `Jsoup.connect(url).ignoreContentType(true).execute().body()` */
    function jsoupConnect(url) {
      var opts = { headers: {}, method: 'GET' };
      var api = {
        header: function (k, v) { opts.headers[String(k)] = String(v); return api; },
        headers: function (o) { Object.assign(opts.headers, o || {}); return api; },
        userAgent: function (v) { opts.headers['User-Agent'] = String(v); return api; },
        referrer: function (v) { opts.headers['Referer'] = String(v); return api; },
        cookie: function (k, v) { api.header('Cookie', String(k) + '=' + String(v)); return api; },
        ignoreContentType: function () { return api; },
        ignoreHttpErrors: function () { return api; },
        timeout: function () { return api; },
        validateTLSCertificates: function () { return api; },
        method: function (m) { opts.method = String(m).toUpperCase(); return api; },
        data: function (k, v) {
          var pair = encodeURIComponent(String(k)) + '=' + encodeURIComponent(String(v));
          opts.body = opts.body ? opts.body + '&' + pair : pair;
          if (opts.method === 'GET') opts.method = 'POST';
          return api;
        },
        post: function (body) {
          opts.method = 'POST';
          if (body !== undefined) opts.body = body;
          return api;
        },
        execute: function () {
          var body = syncFetch(url, opts);
          return {
            body: function () { return body; },
            statusCode: function () { return 200; },
            statusMessage: function () { return 'OK'; },
            headers: function () { return []; },
            header: function () { return ''; },
            charset: function () { return { name: function () { return 'UTF-8'; } }; },
            parse: function () { return parseDocFacade(body, String(url || '')); }
          };
        },
        get: function () { return parseDocFacade(syncFetch(url, opts), String(url || '')); },
        response: function () { return api.execute(); },
        Method: ConnectionMethod     // P：org.jsoup.Connection.Method 枚举（书源引用 DELETE 等）
      };
      return api;
    }

    var Jsoup = {
      parse: function (html, baseUri) {
        return parseDocFacade(html, baseUri == null || baseUri === '' ? baseUrl : baseUri);
      },
      parseBodyFragment: function (html, baseUri) {
        return parseDocFacade(html, baseUri == null || baseUri === '' ? baseUrl : baseUri);
      },
      parseBodyFragmentRelaxed: function (html, baseUri) {
        return parseDocFacade(html, baseUri == null || baseUri === '' ? baseUrl : baseUri);
      },
      connect: function (url) { return jsoupConnect(url); },
      clean: function (bodyHtml) { return String(bodyHtml == null ? '' : bodyHtml); }
    };
    function ElementsCtor() { return wrapList([]); }

    // P：org.jsoup.parser.Parser —— 语料 3+1 源用 Parser.unescapeEntities / Parser 类型引用
    var ParserFacade = {
      unescapeEntities: function (s) {
        // 复用 rule.js 的同一份实现（单趟实体反转义）
        if (NR.rule && typeof NR.rule.unescapeEntities === 'function') return NR.rule.unescapeEntities(s);
        return String(s == null ? '' : s);
      },
      // jsoup Parser 也常被当类型引用（parser.Parser 类名），parse 占位复用 Jsoup 门面
      parse: function (html, baseUri) { return Jsoup.parse(html, baseUri); },
      parseBodyFragment: function (html, baseUri) { return Jsoup.parseBodyFragment(html, baseUri); }
    };

    // P：org.jsoup.Connection.Method 枚举（语料 1 源用 Connection.Method.DELETE）
    var ConnectionMethod = { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', HEAD: 'HEAD', PATCH: 'PATCH' };

    var org = {
      jsoup: {
        Jsoup: Jsoup,
        select: { Elements: ElementsCtor },
        nodes: { Document: ElementsCtor, Element: ElementsCtor },
        parser: { Parser: ParserFacade },
        Connection: { Method: ConnectionMethod }
      }
    };

    /* ---- P：B 档 Java 类 shim（对照 RealWorldSourceScenarioTestBase 行为规格）---- */

    /** java.util.regex.Pattern —— Java 风格 find()/group(n) 迭代（测试 :759-773） */
    function makePatternClass() {
      function Matcher(re, text) {
        var reG = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
        var last = 0;
        return {
          find: function () {
            var m = reG.exec(text);
            if (!m) return false;
            this._m = m;
            return true;
          },
          group: function (n) { return this._m ? (n === undefined ? this._m[0] : this._m[n]) : null; },
          groupCount: function () { return this._m ? this._m.length - 1 : 0; }
        };
      }
      return {
        compile: function (pattern, flags) {
          var re;
          try { re = javaPatternToJsSafe(pattern, flags); }
          catch (e) { throw new Error('Pattern.compile 失败：' + pattern + '（' + e.message + '）'); }
          return { matcher: function (text) { return Matcher(re, String(text == null ? '' : text)); },
                   pattern: pattern, flags: re.flags, toString: function () { return String(pattern); } };
        }
      };
    }
    /* Java 正则 → JS（复用 rule.js 的转换；rule.js 未加载时退化为直编译） */
    function javaPatternToJsSafe(pattern, flags) {
      var g = (typeof global !== 'undefined') ? global : (typeof window !== 'undefined' ? window : null);
      if (g && g.NR && g.NR.rule && typeof g.NR.rule.javaPatternToJs === 'function') {
        var c = g.NR.rule.javaPatternToJs(pattern);
        return { source: c.source, flags: (c.flags || '') + (flags || '') };
      }
      return { source: String(pattern), flags: flags || '' };
    }

    /** org.json.JSONObject / JSONArray —— Java 风格方法包在原生对象上（测试 :736-753） */
    function makeOrgJson() {
      function wrapArray(arr) {
        // P：org.json 的 length() 是**方法**（Legado :746），与 JS 数组的 length 属性同名冲突。
        // 方案：用不可枚举的 length() 方法覆盖数组 length 属性会破坏 JS 迭代——
        // 改为「带方法的子类化数组」：Object.create(数组) 挂方法，length 走原型链上的方法，
        // 迭代需求（for i<arr.length）在书源 JS 里如果遇到再按需兼容；org.json 场景统一 length()。
        var n = arr.length;
        var out = Object.create(arr);
        out.getJSONObject = function (i) { return wrapVal(arr[i]); };
        out.getString = function (i) { return String(arr[i]); };
        out.getInt = function (i) { return Number(arr[i]); };
        out.length = function () { return n; };          // org.json length() 方法（Legado :746）
        out.size = function () { return n; };
        out.toArray = function () { return arr; };
        return out;
      }
      function wrapObj(obj) {
        obj.getJSONObject = function (k) { return wrapVal(obj[k]); };
        obj.getJSONArray = function (k) { return wrapArray(obj[k]); };
        obj.getString = function (k) { return String(obj[k]); };
        obj.getInt = function (k) { return Number(obj[k]); };
        obj.optString = function (k, d) { return obj[k] === undefined ? (d || '') : String(obj[k]); };
        obj.length = obj.length;
        obj.names = function () { return Object.keys(obj); };
        return obj;
      }
      function wrapVal(v) {
        if (Array.isArray(v)) return wrapArray(v);
        if (v && typeof v === 'object') return wrapObj(v);
        return v;
      }
      return {
        JSONObject: function (jsonStr) {
          var o = typeof jsonStr === 'object' ? jsonStr : JSON.parse(String(jsonStr));
          return wrapObj(o);
        },
        JSONArray: function (jsonStr) {
          var a = typeof jsonStr === 'object' ? jsonStr : JSON.parse(String(jsonStr));
          return wrapArray(a);
        }
      };
    }

    /** java.net.HttpCookie —— parse 返回 Java 风格 List（测试 :695-707） */
    function makeHttpCookieClass() {
      function Cookie(name, value, domain) {
        this.getName = function () { return name; };
        this.getValue = function () { return value; };
        this.getDomain = function () { return domain || ''; };
        this.getPath = function () { return '/'; };
      }
      return {
        parse: function (header) {
          var list = [];
          var first = String(header || '').split(';')[0] || '';
          var eq = first.indexOf('=');
          if (eq > 0) {
            var name = first.substring(0, eq).trim();
            var value = first.substring(eq + 1).trim();
            var dm = /domain=([^;]+)/i.exec(String(header));
            list.push(new Cookie(name, value, dm ? dm[1].trim() : ''));
          }
          // Java 风格 List：size()/get(i)
          list.size = function () { return list.length; };
          list.get = function (i) { return list[i]; };
          return list;
        }
      };
    }

    /** java.text.SimpleDateFormat + java.util.Calendar（测试 :713-730；本地时区，月 0 基） */
    function makeSimpleDateFormat() {
      var TWO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      function p4(n) {
        var s = String(n); while (s.length < 4) s = '0' + s; return s;
      }
      function padN(n, len) {
        var s = String(n); while (s.length < len) s = '0' + s; return s;
      }
      function fmt(d, pattern) {
        var out = '', i = 0, p = String(pattern || '');
        while (i < p.length) {
          var ch = p[i], j = i;
          while (j < p.length && p[j] === ch) j++;
          var n = j - i, seg;
          if (ch === 'y') seg = n >= 4 ? p4(d.getFullYear()) : p2(d.getFullYear() % 100);
          else if (ch === 'M') seg = n >= 3 ? TWO[d.getMonth()] : p2(d.getMonth() + 1);
          else if (ch === 'd') seg = p2(d.getDate());
          else if (ch === 'H') seg = p2(d.getHours());
          else if (ch === 'h') seg = p2(((d.getHours() + 11) % 12) + 1);
          else if (ch === 'm') seg = p2(d.getMinutes());
          else if (ch === 's') seg = p2(d.getSeconds());
          else if (ch === 'S') seg = padN(d.getMilliseconds(), n);
          else if (ch === 'a') seg = d.getHours() < 12 ? 'AM' : 'PM';
          else if (ch === 'E') seg = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
          else if (ch === 'D') {
            var start = new Date(d.getFullYear(), 0, 1);
            seg = padN(Math.floor((d - start) / 86400000) + 1, n);
          }
          else if (ch === "'") {                       // '...' 字面量
            if (j < p.length && p[j] === "'") { seg = "'"; }
            else {
              var end = p.indexOf("'", j); if (end < 0) end = p.length;
              seg = p.slice(j, end); j = end + 1;
            }
            out += seg; i = j; continue;
          }
          else seg = p.slice(i, j);                    // 未识别的（z/Z/w/W/F/k/K/u/G/L/Q…）原样吐出
          out += seg; i = j;
        }
        return out;
      }
      function parseRe(pat) {
        var names = { M: 'month', d: 'day', H: 'hour', h: 'hour', m: 'min', s: 'sec' };
        var rx = '', parts = [], i = 0, p = String(pat || '');
        while (i < p.length) {
          var ch = p[i], j = i;
          while (j < p.length && p[j] === ch) j++;
          var n = j - i;
          if (ch === 'y') { rx += '(\\d{' + Math.max(n, 4) + '})'; parts.push('year'); }
          else if (ch === 'M' && n < 3) { rx += '(\\d{1,2})'; parts.push('month'); }
          else if (ch === 'M' && n >= 3) { rx += '([A-Za-z]+)'; parts.push('monName'); }
          else if (ch === 'd') { rx += '(\\d{1,2})'; parts.push('day'); }
          else if (ch === 'H' || ch === 'h') { rx += '(\\d{1,2})'; parts.push('hour'); }
          else if (ch === 'm') { rx += '(\\d{1,2})'; parts.push('min'); }
          else if (ch === 's') { rx += '(\\d{1,2})'; parts.push('sec'); }
          else if (ch === 'S') { rx += '(\\d{1,3})'; parts.push('ms'); }
          else if (ch === "'") {                       // 字面量
            if (p[j] === "'") { rx += "'"; j++; }
            else {
              var end = p.indexOf("'", j); if (end < 0) end = p.length;
              rx += p.slice(j, end).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); j = end + 1;
            }
          }
          else rx += p.slice(i, j).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          i = j;
        }
        return { re: new RegExp('^' + rx + '$'), parts: parts };
      }
      function SDF(pattern) {
        this.pattern = String(pattern || '');
      }
      SDF.prototype.format = function (v) {
        var d = (v && typeof v.getTime === 'function') ? new Date(v.getTime()) : new Date(v);
        if (isNaN(d.getTime())) throw new Error('SimpleDateFormat.format：无效日期');
        return fmt(d, this.pattern);
      };
      SDF.prototype.parse = function (text) {
        var spec = parseRe(this.pattern);
        var m = spec.re.exec(String(text == null ? '' : text).trim());
        if (!m) throw new Error('SimpleDateFormat.parse：无法解析 "' + String(text).slice(0, 60) + '"（pattern: ' + this.pattern + '）');
        var y = 1970, mo = 0, d = 1, h = 0, mi = 0, s = 0, ms = 0;
        for (var i = 0; i < spec.parts.length; i++) {
          var v = m[i + 1], kind = spec.parts[i];
          if (kind === 'year') y = parseInt(v, 10);
          else if (kind === 'month') mo = parseInt(v, 10) - 1;
          else if (kind === 'monName') mo = TWO.indexOf(v.slice(0, 3));
          else if (kind === 'day') d = parseInt(v, 10);
          else if (kind === 'hour') h = parseInt(v, 10);
          else if (kind === 'min') mi = parseInt(v, 10);
          else if (kind === 'sec') s = parseInt(v, 10);
          else if (kind === 'ms') ms = parseInt(v, 10);
        }
        return new Date(y, mo, d, h, mi, s, ms);
      };
      SDF.prototype.toPattern = function () { return this.pattern; };
      return SDF;
    }

    /** java.util.Calendar —— set(y,m,d[,h[,mi[,s]]]) 月 0 基；getInstance() 本地时区 */
    function makeCalendarClass() {
      function Cal(y, mo, d, h, mi, s) {
        this.__d = (arguments.length >= 3)
          ? new Date(y, mo, d, h || 0, mi || 0, s || 0)
          : new Date();
      }
      Cal.prototype.set = function () {
        var a = arguments;
        if (a.length === 1 && typeof a[0] === 'object' && a[0]) { this.__d = new Date(a[0].getTime()); return; }
        if (a.length >= 3) {
          // Java 语义：set 不碰毫秒以下字段，这里清掉 ms 与年份外的进位
          this.__d = new Date(Number(a[0]), Number(a[1]), Number(a[2]),
            a.length > 3 ? Number(a[3]) : this.__d.getHours(),
            a.length > 4 ? Number(a[4]) : this.__d.getMinutes(),
            a.length > 5 ? Number(a[5]) : this.__d.getSeconds(),
            0);
        } else if (a.length === 2) {
          this.__setField(a[0], a[1]);
        }
      };
      // 常量（与 java.util.Calendar 对齐）
      Cal.YEAR = 1; Cal.MONTH = 2; Cal.DATE = 5; Cal.DAY_OF_MONTH = 5;
      Cal.HOUR_OF_DAY = 11; Cal.MINUTE = 12; Cal.SECOND = 13; Cal.MILLISECOND = 14;
      var F = {};
      F[Cal.YEAR] = 'FullYear'; F[Cal.MONTH] = 'Month'; F[Cal.DATE] = 'Date';
      F[Cal.DAY_OF_MONTH] = 'Date'; F[Cal.HOUR_OF_DAY] = 'Hours'; F[Cal.MINUTE] = 'Minutes';
      F[Cal.SECOND] = 'Seconds'; F[Cal.MILLISECOND] = 'Milliseconds';
      Cal.prototype.__setField = function (f, v) { var m = F[f]; if (m) this.__d['set' + m](Number(v)); };
      Cal.prototype.get = function (f) {
        var m = F[f];
        if (m) {
          var v = this.__d['get' + m]();
          return f === Cal.MONTH ? v : v;      // get(MONTH) 已是 0 基，与 Java 一致
        }
        throw new Error('Calendar.get：不支持的字段 ' + f);
      };
      Cal.prototype.getTime = function () { return this.__d; };
      Cal.prototype.getTimeInMillis = function () { return this.__d.getTime(); };
      Cal.prototype.setTime = function (d) { this.__d = new Date(d.getTime()); };
      Cal.getInstance = function () { return new Cal(); };
      return Cal;
    }

    /** javax.crypto.spec.SecretKeySpec —— 最小形态：getEncoded() 返回 byte[]（漏 new 也容忍） */
    function SecretKeySpecCtor(keyBytes, algo) {
      if (!(this instanceof SecretKeySpecCtor)) return new SecretKeySpecCtor(keyBytes, algo);
      this.__bytes = toBytes(keyBytes);
      this.__algo = String(algo || 'HmacSHA256');
    }
    SecretKeySpecCtor.prototype.getEncoded = function () { return byteArray(this.__bytes); };
    SecretKeySpecCtor.prototype.getAlgorithm = function () { return this.__algo || 'HmacSHA256'; };

    function makeMacClass() {
      function normAlgo(a) { return String(a == null ? '' : a).replace(/[-_\s]/g, '').toLowerCase(); }
      return {
        getInstance: function (algo) {
          if (normAlgo(algo) !== 'hmacsha256') {
            throw missError('javax.crypto.Mac.getInstance("' + algo + '")', '只实现了 HmacSHA256');
          }
          var keyBytes = null;
          return {
            init: function (k) {
              keyBytes = toBytes(k && typeof k.getEncoded === 'function' ? k.getEncoded() : k);
              if (keyBytes == null) keyBytes = [];       // 空 key 也允许（HMAC 契约上合法）
            },
            doFinal: function (data) {
              if (!keyBytes) throw new Error('Mac.doFinal：先 init(key)');
              var k = keyBytes.slice(0);
              if (k.length > 64) k = sha256Bytes(k);          // >64 字节 key：先 hash
              while (k.length < 64) k.push(0);
              var ipad = [], opad = [];
              for (var i = 0; i < 64; i++) {
                ipad.push(k[i] ^ 0x36);
                opad.push(k[i] ^ 0x5c);
              }
              var inner = sha256Bytes(ipad.concat(toBytes(data == null ? [] : data)));
              var out = sha256Bytes(opad.concat(inner));
              return byteArray(out);
            },
            update: function () { }   // 状态机不实现（语料都是一次性 doFinal）
          };
        }
      };
    }

    /** java.util.ArrayList —— 可 new + add/size/get（Legado 测试 :698-703） */
    function makeArrayListClass() {
      function ArrayList(init) {
        var a = Array.isArray(init) ? init.slice(0) : [];
        this.add = function (x) { a.push(x); return true; };
        this.size = function () { return a.length; };
        this.get = function (i) { return a[i]; };
        this.isEmpty = function () { return a.length === 0; };
        this.contains = function (x) { return a.indexOf(x) >= 0; };
        this.toString = function () { return a.toString(); };
      }
      return ArrayList;
    }

    /* ---- Java 类路径表：Packages.* / javax.* / android.* 都从这里解析 ---- */
    var NS = {
      'java.lang.String': JAVA_STRING,
      'java.util.Base64': JAVA_BASE64,
      'java.util.Arrays': JAVA_ARRAYS,
      'java.security.MessageDigest': makeMessageDigestClass(missError),
      'java.security.SecureRandom': SecureRandom,
      'java.io.ByteArrayOutputStream': ByteArrayOutputStream,
      'java.nio.charset.Charset': JAVA_CHARSET,
      // PATCH SOURCE-API：java.net / java.math（Packages.java.net.URL 8 源、BigInteger 5 源…）
      'java.net.URL': makeUrlClass(baseUrl),
      'java.net.URLEncoder': JAVA_URL_ENCODER,
      'java.net.URLDecoder': JAVA_URL_DECODER,
      'java.net.InetAddress': makeInetAddressClass(),
      'java.math.BigInteger': JAVA_BIGINTEGER,
      'org.jsoup.Jsoup': Jsoup,
      'org.jsoup.select.Elements': ElementsCtor,
      'org.jsoup.parser.Parser': ParserFacade,
      'org.jsoup.Connection': { Method: ConnectionMethod },
      // P：B 档 shim（对照 RealWorldSourceScenarioTestBase :695/:736/:759）
      'java.util.regex.Pattern': makePatternClass(),
      'org.json.JSONObject': makeOrgJson().JSONObject,
      'org.json.JSONArray': makeOrgJson().JSONArray,
      'java.net.HttpCookie': makeHttpCookieClass(),
      'java.util.ArrayList': makeArrayListClass(),
      // P B 档：日期格式化 + HMAC 签名（RealWorldSourceScenarioTestBase :713/:163）
      'java.text.SimpleDateFormat': makeSimpleDateFormat(),
      'java.util.Calendar': makeCalendarClass(),
      'javax.crypto.Mac': makeMacClass(),
      'javax.crypto.spec.SecretKeySpec': SecretKeySpecCtor,
      'android.util.Base64': ANDROID_BASE64
    };

    /** Java 包路径访问器：命中的返回真门面，没命中的一律「调用即报错」 */
    function makeNs(path) {
      if (typeof Proxy === 'undefined') return undefined;
      var target = function () { };
      return new Proxy(target, {
        get: function (t, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') {
            return function () { return ''; };
          }
          if (prop === 'then') return undefined;
          var p = path ? path + '.' + String(prop) : String(prop);
          if (Object.prototype.hasOwnProperty.call(NS, p)) return NS[p];
          return makeNs(p);
        },
        apply: function () { throw missError(path || 'Java 类'); },
        construct: function () { throw missError(path || 'Java 类'); }
      });
    }

    var Packages = makeNs('');
    var javax = makeNs('javax');
    var android = makeNs('android');

    /* P AES-FAMILY：hutool 便捷方法的共用入口 —— transformation 缺省 AES/CBC/PKCS5Padding
     *（hutool SymmetricCrypto 默认），iv 空 → null（ECB 下忽略）。DES 走同一入口，
     * 由 AES 模块的 parseTransformation 报「暂不支持算法」的清晰错误（语料 AES 之外 0 次）。 */
    function symCrypto(transformation, key, iv, algo) {
      var t = String(transformation || '') || (algo ? algo + '/CBC/PKCS5Padding' : 'AES/CBC/PKCS5Padding');
      if (algo && !/^des/i.test(String(t).split('/')[0])) t = algo + '/CBC/PKCS5Padding';
      if (typeof window !== 'undefined' && window.NR && typeof window.NR._createSymmetricCrypto === 'function') {
        return window.NR._createSymmetricCrypto(t, key, iv == null || iv === '' ? null : iv);
      }
      throw missError('java.' + (algo || 'aes') + '*Decode', 'AES 模块未加载（' + t + '）');
    }

    var java = {
      ajax: function (url, charset) { return syncFetch(url, { charset: charset }); },
      // P：java.get(url[, headers]) —— Legado 核心 API（带自定义头同步 GET）。
      // 语料真实用法：java.get(minUrl, {Referer:..., 'User-Agent':...})（卡拉漫画等图源）。
      // 之前缺失 → 这类源在 tryGet 处静默失败。headers 支持 对象 / [{name,value}] / JSON 串。
      get: function (url, headers) {
        var h = headers;
        if (typeof h === 'string' && h.trim()) {
          try { h = JSON.parse(h); } catch (e0) { h = null; }
        }
        if (Array.isArray(h)) {
          var o = {};
          h.forEach(function (it) { if (it && it.name) o[it.name] = it.value; });
          h = o;
        }
        return syncFetch(url, { headers: h || {} });
      },
      post: function (url, body, headers) {
        var text = syncFetch(url, { method: 'POST', body: body, headers: headers || {} });
        return {
          body: function () { return text; },
          string: function () { return text; },
          str: function () { return text; },
          headers: function () { return {}; },
          header: function () { return ''; },
          code: function () { return 200; },
          status: function () { return 200; },
          url: function () { return String(url || ''); }
        };
      },
      connect: function (url) {
        var opts = { headers: {} };
        var api = {
          header: function (k, v) { opts.headers[k] = v; return api; },
          headers: function (o) { Object.assign(opts.headers, o || {}); return api; },
          method: function (m) { opts.method = m; return api; },
          post: function (b) { opts.method = 'POST'; opts.body = b; return syncFetch(url, opts); },
          get: function () { return syncFetch(url, opts); },
          body: function (b) {
            if (b === undefined) return syncFetch(url, opts);
            opts.body = b; opts.method = opts.method || 'POST'; return api;
          },
          raw: function () { return api; },
          request: function () { return api; },
          // 语料里 Icu 这类源写的是 .getBody() / .ignoreContentType().execute()
          getBody: function () { return syncFetch(url, opts); },
          execute: function () {
            var body = syncFetch(url, opts);
            return {
              body: function () { return body; },
              statusCode: function () { return 200; },
              statusMessage: function () { return 'OK'; },
              headers: function () { return []; },
              header: function () { return ''; }
            };
          },
          ignoreContentType: function () { return api; },
          ignoreHttpErrors: function () { return api; },
          timeout: function () { return api; },
          userAgent: function (v) { opts.headers['User-Agent'] = String(v); return api; },
          url: function () { return String(url || ''); },
          string: function () { return syncFetch(url, opts); }
        };
        return api;
      },
      getElement: function (css) { return elements(css); },
      getElements: function (css) { return elements(css); },
      getElementsByTag: function (tag) {
        try { return wrapList(ensureDoc().getElementsByTagName(String(tag))); }
        catch (e) { return wrapList([]); }
      },
      setContent: function (html) { doc = parseDoc(html); },
      /* ---- PATCH GETSTRING-RESULT：java.getString(rule) 对「当前规则链 result」求值 ----
       * Legado 语义（AnalyzeRuleCore.kt:343 getString）：bindings["java"] = this，
       * java.getString 就是当前分析器实例的 getString —— 对**本轮规则的中间 result**
       * 跑完整规则链（JSONPath / CSS / @js 都行），不是对原页面。
       * 之前这里传的是 {doc: ensureDoc()} —— doc 是「最近一次 setContent 的页面」，
       * 全免漫画 `java.getString("$.data")` 拿到的是页面而非响应 JSON → 恒空。
       * 现在优先用本轮 eval 的输入内容（result / html 原始串），没有才回落 doc。 */
      getString: function (rule) {
        if (!NR.rule || !NR.rule.applySync) return '';
        try {
          var hasResult = ctx.result != null || ctx.html != null;
          var c = hasResult ? {
            value: ctx.result != null ? String(ctx.result) : String(ctx.html),
            baseUrl: baseUrl, key: ctx.key || '', page: page, source: source
          } : {
            doc: ensureDoc(), baseUrl: baseUrl, key: ctx.key || '', page: page, source: source
          };
          return String(NR.rule.applySync(rule, c) || '');
        } catch (e) { return ''; }
      },
      getStringList: function (rule) {
        if (!NR.rule || !NR.rule.applySync) return [];
        try {
          var v = NR.rule.applySync(rule, {
            doc: ensureDoc(), baseUrl: baseUrl, key: ctx.key || '', page: page, source: source
          });
          return String(v || '').split('\n').filter(function (s) { return s.trim(); });
        } catch (e) { return []; }
      },
      htmlFormat: function (s) {
        return String(s == null ? '' : s)
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|h\d)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
      },
      toNumChapter: function (s) { return String(s == null ? '' : s); },
      encodeURI: function (s) { return encodeURIComponent(String(s)); },
      base64Encode: function (s) { return btoa(unescape(encodeURIComponent(String(s)))); },
      base64Decode: function (s) { return decodeURIComponent(escape(atob(String(s)))); },
      md5Encode: function (s) { return md5(String(s)); },
      md5Encode16: function (s) { return md5(String(s)).slice(8, 24); },
      hexEncodeToString: function (s) {
        // PATCH P2：真 Java 的 java.hexEncodeToString 是 str.getBytes(UTF-8) 的 hex，
        // 原来按 charCode 低 8 位取（"中文" → "2d87"），多字节字符全错
        var bytes = unescape(encodeURIComponent(String(s)));
        var out = '';
        for (var i = 0; i < bytes.length; i++) {
          out += ('0' + bytes.charCodeAt(i).toString(16)).slice(-2);
        }
        return out;
      },
      HMacHex: function () { throw missError('java.HMacHex'); },
      ajaxAll: function (urls) {
        return (urls || []).map(function (u) { return syncFetch(u, {}); });
      },
      timeFormat: function (ts) {
        var d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts || Date.now()));
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
          p(d.getHours()) + ':' + p(d.getMinutes());
      },
      randomUUID: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      },
      strToBytes: function (s) {
        return unescape(encodeURIComponent(String(s))).split('').map(function (c) { return c.charCodeAt(0); });
      },
      log: function (m) { console.log('[书源]', typeof m === 'object' ? JSON.stringify(m) : m); },
      toast: function (m) { if (NR.toast) NR.toast(String(m)); },
      // PATCH API-4：longToast（30 源）—— 渲染层没有「长提示」概念，降级成 toast，不算失败
      longToast: function (m) { if (NR.toast) NR.toast(String(m)); },
      put: function (k, v) { vars[k] = v; },
      /* PATCH GET-DISPATCH：java.get 双语义消歧（对齐 Legado）——
       * Legado 里 get(key)（变量存储，AnalyzeRuleCore.kt:808）和 get(urlStr, headers)
       * （HTTP GET，JsExtensionsCommon.kt:503）同名共存，Kotlin 按参数个数分派。
       * iread 原来对象字面量里后面的 get(k) 覆盖了 HTTP 版 → 卡拉漫画的
       * java.get(minUrl, {Referer...}) 拿到 undefined。这里按 Legado 语义：两参/URL 形态走 HTTP，单参走变量存储。 */
      get: function (a, b) {
        if (arguments.length >= 2 && typeof a === 'string' && b != null && typeof b === 'object') {
          var h = b;
          if (Array.isArray(h)) {
            var o = {};
            h.forEach(function (it) { if (it && it.name) o[it.name] = it.value; });
            h = o;
          }
          return syncFetch(a, { headers: h || {} });
        }
        return vars[a];
      },

      /* ---- PATCH API-5：字节 / hex / 摘要 的薄封装（复用上面的纯 JS 实现） ---- */
      // hexDecodeToString：hexDecodeToString 的逆运算（24 源），按 UTF-8 解
      hexDecodeToString: function (hex) { return bytesToUtf8(hexToBytes(hex)); },
      hexDecodeToByteArray: function (hex) { return byteArray(hexToBytes(hex)); },
      base64DecodeToByteArray: function (b64) { return byteArray(base64ToBytes(b64)); },
      bytesToStr: function (b, cs) { return bytesToStr(toBytes(b), cs); },
      strToBytesOf: function (s, cs) { return byteArray(strToBytesCharset(s, cs)); },
      digestHex: function (v, algo) {
        var key = hashName(algo);
        if (!HASHES[key]) throw missError('java.digestHex(…, "' + algo + '")', '只实现了 MD5 / SHA-1 / SHA-256');
        return bytesToHex(HASHES[key](toBytes(v)));
      },
      digestBase64Str: function (v, algo) {
        var key = hashName(algo);
        if (!HASHES[key]) throw missError('java.digestBase64Str(…, "' + algo + '")', '只实现了 MD5 / SHA-1 / SHA-256');
        return bytesToBase64(HASHES[key](toBytes(v)));
      },

      /* ---- PATCH API-6：explore 刷新 / 浏览器类（做不了的「清楚地失败」） ---- */
      refreshExplore: function () { return ''; },   // 19 源：纯 UI 动作，无副作用空操作
      startBrowser: function (url) { throw missError('java.startBrowser', '需要真浏览器打开页面（' + String(url || '').slice(0, 60) + '）'); },
      startBrowserAwait: function (url) { throw missError('java.startBrowserAwait', '需要真浏览器并等页面加载（' + String(url || '').slice(0, 60) + '）'); },
      startBrowserDp: function (url) { throw missError('java.startBrowserDp', '需要真浏览器打开页面'); },
      showBrowser: function () { throw missError('java.showBrowser', '需要宿主 WebView 承载'); },
      open: function () { throw missError('java.open', '需要宿主打开外部页面'); },
      // P：转发到文件尾部追加的纯 JS AES 模块（PATCH SYMMETRIC-CRYPTO 段）
      createSymmetricCrypto: function (t, key, iv) {
        if (typeof window !== 'undefined' && window.NR && typeof window.NR._createSymmetricCrypto === 'function') {
          return window.NR._createSymmetricCrypto(t, key, iv);
        }
        throw missError('java.createSymmetricCrypto', 'AES 模块未加载（' + String(t || '') + '）');
      },
      getVerificationCode: function () { throw missError('java.getVerificationCode', '需要宿主验证码窗口'); },
      // PATCH SOURCE-API：登录态两件套改为读同一份 source 存储（不再一律抛）
      getLoginInfo: function () { return store.loginInfo || ''; },
      getLoginInfoMap: function () { return loginMapOf(store.loginInfo); },
      reLoginView: function () { throw missError('java.reLoginView', '需要宿主登录窗口'); },
      webView: function () { throw missError('java.webView', '需要宿主 WebView'); },

      /* ---- PATCH SOURCE-API-3：语料里真实存在的 java.* 补充 ---- */
      // 规则 Cookie 门面未接入隔离会话；HTTP 自动携带 Cookie 是独立的网络能力。
      getCookie: function () { throw missError('java.getCookie', '规则无法读取网络会话 Cookie'); },
      setCookie: function () { throw missError('java.setCookie', '规则无法修改网络会话 Cookie'); },
      removeCookie: function () { throw missError('java.removeCookie', '规则无法删除网络会话 Cookie'); },
      // java.deviceID() / java.androidId()（7~10 源）：环境探测用，给会话内稳定的假值 + warn 一次
      deviceID: function () {
        warnOnce('java.deviceID', 'java.deviceID 返回的是渲染层假设备号（32 位 hex，会话内固定）');
        return fakeDeviceId();
      },
      androidId: function () {
        warnOnce('java.androidId', 'java.androidId 返回的是渲染层假设备号（32 位 hex，会话内固定）');
        return fakeDeviceId();
      },
      // java.qread(...)（5 源）：轻阅读私有接口，语料里只用来探测「当前是哪个环境」—— 清楚地说做不了
      qread: function () { throw missError('java.qread', '轻阅读（qread）私有接口，渲染层没有对应环境'); },

      /* ---- PATCH AES-FAMILY：hutool 便捷加解密一族（Legado JsExtensions 语义） ----
       * 语料真实调用形态：
       *   禁漫天堂(b09)：java.aesBase64DecodeToString(s, key, 'AES/ECB/PKCS5Padding', '')
       *   影视源(b30)：  java.aesBase64DecodeToString(result, '4395daa50ad6baf7', 'AES/CBC/PKCS5Padding', '0123456789abcdef')
       * hutool SymmetricCrypto(data, key, transformation, iv)：
       *   - data 是 Base64 密文 → 解码 → 解密 → UTF-8 字符串
       *   - transformation 缺省 "AES/CBC/PKCS5Padding"（hutool 默认）；ECB 时 iv 忽略（可传 ''）
       *   - iv 可空（'' / null）
       * aesDecryptDataToString / desBase64DecodeToString / desDecryptDataToString 同构。
       * 加密向（aesBase64EncryptToString 等）语料 0 次出现，只补同名对称成员保持门面完整。 */
      aesBase64DecodeToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv).decryptStr(data);
      },
      aesDecryptDataToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv).decryptStr(data);
      },
      desBase64DecodeToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv, 'DES').decryptStr(data);
      },
      desDecryptDataToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv, 'DES').decryptStr(data);
      },
      aesBase64EncryptToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv).encryptBase64(data);
      },
      aesEncryptDataToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv).encryptBase64(data);
      },
      desBase64EncryptToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv, 'DES').encryptBase64(data);
      },
      desEncryptDataToString: function (data, key, transformation, iv) {
        return symCrypto(transformation, key, iv, 'DES').encryptBase64(data);
      }

    };

    /* ---- PATCH API-7：java.* 上的 Java 类命名空间 + timeFormatUTC ----
     * 书源里 java.lang.String / java.util.Base64 / java.security.MessageDigest
     * 与 Packages.java.* 是同一批类，指向同一份门面。 */
    java['lang'] = { String: JAVA_STRING };
    java['util'] = { Base64: JAVA_BASE64, Arrays: JAVA_ARRAYS };
    java['util'].Calendar = NS['java.util.Calendar'];                   // P B 档：getInstance/set/getTime
    java['security'] = { MessageDigest: NS['java.security.MessageDigest'], SecureRandom: SecureRandom };
    java['io'] = { ByteArrayOutputStream: ByteArrayOutputStream };
    java['nio'] = { charset: { Charset: JAVA_CHARSET } };
    // PATCH SOURCE-API：`java.net.*` / `java.math.*` 与 Packages.java.net.* 同一份门面
    java['net'] = {
      URL: NS['java.net.URL'], URLEncoder: JAVA_URL_ENCODER, URLDecoder: JAVA_URL_DECODER,
      InetAddress: NS['java.net.InetAddress'],
      HttpCookie: NS['java.net.HttpCookie']       // P B 档：HttpCookie.parse
    };
    java['math'] = { BigInteger: JAVA_BIGINTEGER };
    // P B 档：java.util.regex.Pattern（Java 风格 find()/group(n)）
    java['util'].regex = { Pattern: NS['java.util.regex.Pattern'] };
    java['text'] = java['text'] || {};
    java['text'].SimpleDateFormat = NS['java.text.SimpleDateFormat'];   // P B 档：可 new
    javax.crypto = {                                                    // P B 档：HMAC-SHA256
      Mac: NS['javax.crypto.Mac'],
      spec: { SecretKeySpec: NS['javax.crypto.spec.SecretKeySpec'] }
    };
    java.timeFormatUTC = function (ts, fmt, offset) { return formatUtc(ts, fmt, offset); };

    /* =======================================================================
     * PATCH SOURCE-API-4：source.* 门面（语料里最大的缺口：33 种、单条最多 43 源）
     * -----------------------------------------------------------------------
     * 规则代码里的 `source` 就是返回给 eval 的这个对象（env.source），所以
     * 「方法」和「纯属性」都得挂在它身上：
     *   方法  getKey/getKeyUrl/getBookSourceUrl/getName/getTag
     *         get/put/getVariable/setVariable/putVariable      → SOURCE_STORE（跨调用持久）
     *         getLoginInfo/putLoginInfo/removeLoginInfo/getLoginInfoMap
     *         getLoginHeader/putLoginHeader/removeLoginHeader/getLoginHeaderMap
     *         refreshExplore / login
     *   属性  key/bookSourceUrl/bookSourceName/bookSourceComment/exploreUrl/
     *         header/loginUi/loginUrl/ruleExplore …（从原始 source 上取，取不到给 ''）
     * 注意：`login` 在语料里是被**调用**的（4 个 pixiv 源写 `source.login()`），
     * 调用明确报告不支持登录 UI；toString() 仍能还原原始 source.login 串。
     * ======================================================================= */
    var store = sourceStoreOf(source);

    /** 把 JSON 串解析成「Map 样子」：既支持 ['k'] 也支持 .get('k')（语料两种写法都有） */
    function loginMapOf(jsonText) {
      var obj = null;
      if (jsonText && typeof jsonText === 'string') {
        try { obj = JSON.parse(jsonText); } catch (e) { obj = null; }
      } else if (jsonText && typeof jsonText === 'object') {
        obj = jsonText;
      }
      var m = {};
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        Object.keys(obj).forEach(function (k) { m[k] = obj[k]; });
      }
      Object.defineProperty(m, 'get', {
        value: function (k) { return m[k] == null ? null : m[k]; },
        enumerable: false, configurable: true, writable: true
      });
      Object.defineProperty(m, 'size', {
        get: function () { return Object.keys(m).length; },
        enumerable: false, configurable: true
      });
      return m;
    }

    /** 整串存储：put() 之后 getVariable() 要能读到同一份数据（反过来也一样） */
    function variableRaw() {
      if (store.raw !== '') return store.raw;
      var keys = Object.keys(store.map);
      return keys.length ? JSON.stringify(store.map) : '';
    }

    function setVariableAny(a, b) {
      if (arguments.length >= 2) {
        store.map[String(a)] = b == null ? '' : String(b);
        store.raw = JSON.stringify(store.map);
        return;
      }
      if (a == null) { store.raw = ''; store.map = Object.create(null); return; }
      if (typeof a === 'object') {                      // setVariable({...})：整串替换
        store.map = Object.create(null);
        Object.keys(a).forEach(function (k) { store.map[k] = a[k]; });
        store.raw = JSON.stringify(store.map);
        return;
      }
      store.raw = String(a);
      store.map = Object.create(null);
      try {
        var parsed = JSON.parse(store.raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.keys(parsed).forEach(function (k) { store.map[k] = parsed[k]; });
        }
      } catch (e) { /* 不是 JSON 就只保留整串 */ }
    }

    function putLoginInfoAny(v) {
      if (v == null) { store.loginInfo = ''; return; }
      store.loginInfo = typeof v === 'string' ? v : JSON.stringify(v);
    }
    function putLoginHeaderAny(v) {
      if (v == null) { store.loginHeader = ''; return; }
      store.loginHeader = typeof v === 'string' ? v : JSON.stringify(v);
    }

    /** 原始 source 上的字段：iread 用 url/name/group，Legado JSON 用 bookSourceUrl/… */
    function rawField(list, dflt) {
      for (var i = 0; i < list.length; i++) {
        var v = source[list[i]];
        if (v != null && v !== '') return v;
      }
      return dflt;
    }

    var src = {
      /* ---- 身份 ---- */
      getKey: function () { return String(rawField(['url', 'bookSourceUrl'], '')); },
      getKeyUrl: function () { return String(rawField(['url', 'bookSourceUrl'], '')); },
      getBookSourceUrl: function () { return String(rawField(['url', 'bookSourceUrl'], '')); },
      getName: function () { return String(rawField(['name', 'bookSourceName'], '')); },
      getTag: function () { return String(rawField(['group', 'bookSourceGroup'], '')); },

      /* ---- 键值存储（跨调用持久） ---- */
      get: function (k) {
        if (k == null) return store.map;
        return Object.prototype.hasOwnProperty.call(store.map, String(k)) ? store.map[String(k)] : null;
      },
      put: function (k, v) {
        store.map[String(k)] = v == null ? '' : String(v);
        store.raw = JSON.stringify(store.map);
      },
      getVariable: function (k) {
        if (k != null && k !== '') {
          var kk = String(k);
          if (Object.prototype.hasOwnProperty.call(store.map, kk)) return store.map[kk];
          var raw = variableRaw();
          if (!raw) return '';
          try {
            var o = JSON.parse(raw);
            if (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, kk)) return o[kk];
          } catch (e) { /* 非 JSON 整串就当没有这个 key */ }
          return '';
        }
        return variableRaw();
      },
      setVariable: function (a, b) { setVariableAny.apply(null, arguments); },
      putVariable: function (k, v) { setVariableAny(k, v); },

      /* ---- 登录态 ---- */
      getLoginInfo: function () { return store.loginInfo || ''; },
      putLoginInfo: function (v) { putLoginInfoAny(v); },
      removeLoginInfo: function () { store.loginInfo = ''; },
      getLoginInfoMap: function () { return loginMapOf(store.loginInfo); },
      getLoginHeader: function () { return store.loginHeader || ''; },
      putLoginHeader: function (v) { putLoginHeaderAny(v); },
      removeLoginHeader: function () { store.loginHeader = ''; },
      getLoginHeaderMap: function () {
        var m = loginMapOf(store.loginHeader);
        if (!Object.keys(m).length && store.loginHeader) m['Cookie'] = store.loginHeader;
        return m;
      },

      /* ---- UI 动作：刷新仅为无副作用的部分兼容，登录不能伪装成功 ---- */
      refreshExplore: function () { return ''; },
      login: function () { throw missError('source.login', '需要宿主登录窗口，登录信息存储不等于登录'); }
    };

    /* 纯属性映射（不是函数）：从原始 source 上直取，没有就给 '' —— 任何一条都不能抛 */
    var srcProps = {
      key: ['url', 'bookSourceUrl'],
      bookSourceUrl: ['url', 'bookSourceUrl'],
      bookSourceName: ['name', 'bookSourceName'],
      bookSourceComment: ['bookSourceComment', 'comment'],
      bookSourceGroup: ['group', 'bookSourceGroup'],
      bookSourceType: ['bookSourceType'],
      exploreUrl: ['exploreUrl'],
      header: ['header'],
      loginUi: ['loginUi'],
      loginUrl: ['loginUrl'],
      ruleExplore: ['ruleExplore'],
      searchUrl: ['searchUrl'],
      bookUrlPattern: ['bookUrlPattern'],
      customOrder: ['customOrder'],
      weight: ['weight'],
      enabled: ['enabled'],
      enabledExplore: ['enabledExplore']
    };
    Object.keys(srcProps).forEach(function (prop) {
      var v = rawField(srcProps[prop], '');
      if (typeof v === 'function' || typeof v === 'object') {
        Object.defineProperty(src, prop, { value: v, enumerable: true, configurable: true });
      } else {
        Object.defineProperty(src, prop, {
          // 属性访问永远返回值本身（取不到就是 ''），不是函数
          get: function () { return v; },
          enumerable: true, configurable: true
        });
      }
    });
    // `source.login` 既当属性（还原原始串）又能被调用（见上方说明）
    try {
      Object.defineProperty(src.login, 'toString', {
        value: function () { return String(rawField(['login'], '')); },
        enumerable: false, configurable: true, writable: true
      });
      Object.defineProperty(src.login, 'valueOf', {
        value: function () { return String(rawField(['login'], '')); },
        enumerable: false, configurable: true, writable: true
      });
    } catch (e) { /* 改不动就算了 */ }

    /* 兜底：语料里还会直接摸 source.xxx 的其它原始字段（searchUrl / customOrder…），
     * 用 Proxy 回落到原始 source 上，摸不到的照旧 undefined —— 不改变「有没有」的判断 */
    if (typeof Proxy !== 'undefined') {
      src = new Proxy(src, {
        get: function (t, prop) {
          if (typeof prop === 'symbol') return t[prop];
          if (prop === 'then' || prop === 'toJSON') return undefined;
          if (prop in t) return t[prop];
          var v = source[prop];
          return v === undefined ? undefined : v;
        },
        has: function (t, prop) {
          if (typeof prop === 'symbol') return prop in t;
          return (prop in t) || (prop in (source || {}));
        }
      });
    }

    var cookieApi = {
      getCookie: function () { throw missError('cookie.getCookie', '规则 Cookie 读取未接入隔离网络会话'); },
      setCookie: function () { throw missError('cookie.setCookie', '规则 Cookie 写入未接入隔离网络会话'); },
      removeCookie: function () { throw missError('cookie.removeCookie', '规则 Cookie 删除未接入隔离网络会话'); }
    };

    return {
      java: java, cookie: cookieApi,
      source: src, book: ctx.book || {},
      result: input, baseUrl: baseUrl, key: ctx.key || '', page: page, args: ctx.args || {},
      src: ctx.src != null ? ctx.src : input,
      title: ctx.title || '', chapter: ctx.chapter || null, nextChapterUrl: ctx.nextChapterUrl || '',
      cache: {
        // PATCH API-8：Legado 的 cache 还有内存档（pixiv 系 7 条片段用 putMemory/getFromMemory/deleteMemory）。
        // 口径：按书源分开存、跨 run() 保留（同 Legado：putMemory 写在 searchUrl、getFromMemory 在详情页读）。
        get: function () { throw missError('cache.get', '持久缓存未实现，请使用会话内存缓存'); },
        put: function () { throw missError('cache.put', '持久缓存未实现，请使用会话内存缓存'); },
        delete: function () { throw missError('cache.delete', '持久缓存未实现，请使用会话内存缓存'); },
        getFromMemory: function (k) { return MEM[memKey(k)] == null ? '' : MEM[memKey(k)]; },
        putMemory: function (k, v) { MEM[memKey(k)] = v == null ? '' : String(v); return v; },
        deleteMemory: function (k) { delete MEM[memKey(k)]; }
      },
      org: org, javax: javax, android: android, Packages: Packages
    };
  }

  /* ------------------------------------------------------------ jsLib 注入
   * PATCH JSLIB：Legado 把 source.jsLib 注入 Rhino 作用域，规则里可以直接调用
   * 里面定义的函数（真实语料 301 源里 61 源 / 797 处调用依赖这个）。
   * iread 原来把 jsLib 整个丢掉 → 规则一调 getArguments() 就是 ReferenceError。
   *
   * 关键：必须和规则代码在**同一个 eval 作用域**里求值（不能包 IIFE、不能另建函数），
   * 否则严格模式下函数声明不会外泄，规则仍然看不到。
   */
  var JSLIB_CACHE = { src: null, ok: true, err: null };

  function checkJsLib(src) {
    if (JSLIB_CACHE.src === src) return JSLIB_CACHE;
    var ok = true, err = null;
    if (src) {
      try { new Function(src); } catch (e) { ok = false; err = e; }   // 只做语法检查，不执行
    }
    JSLIB_CACHE = { src: src, ok: ok, err: err };
    if (!ok) {
      STATS.jsLibError = (STATS.jsLibError || 0) + 1;
      warnOnce('jsLib', 'jsLib 语法错误，已跳过：' + ((err && err.message) || err));
    }
    return JSLIB_CACHE;
  }

  /* ------------------------------------------------------------ 执行 */
  /**
   * 跑一段书源 JS：最后一条表达式的值优先；否则看脚本有没有改过 result。
   * 所有宿主接口都通过形参传入，并把 window/globalThis/yedu/require/process 遮蔽掉。
   */
  function run(code, ctx) {
    var env = makeEnv(ctx);
    // PATCH JSLIB：把 source.jsLib 前置到同一次 eval 里（严格模式下函数声明才对外可见）
    // PATCH SOURCE-API：env.source 现在是完整的 source 门面（方法 + 原始字段回落），
    //   所以 jsLib 里的 this.source 也用它 —— Legado 的 this.source 本来就是 BookSource 实例
    var rawSource = (ctx && ctx.source) || {};
    var libSrc = String(rawSource.jsLib || (ctx && ctx.jsLib) || '');
    var lib = checkJsLib(libSrc);
    var useLib = !!(libSrc && lib.ok);
    var body = String(code || '');
    if (useLib) body = libSrc + '\n;\n' + body;
    var fn = new Function('env',
      'var java=env.java, cookie=env.cookie, source=env.source, book=env.book;' +
      'var key=env.key, page=env.page, baseUrl=env.baseUrl, base_url=env.baseUrl, args=env.args, result=env.result;' +
      'var src=env.src, title=env.title, chapter=env.chapter, nextChapterUrl=env.nextChapterUrl, cache=env.cache;' +
      'var base64=java.base64Encode, md5=java.md5Encode, timeFormat=java.timeFormat;' +
      'var window, globalThis, yedu, require, process, importScripts, module, exports;' +
      'var org=env.org, javax=env.javax, android=env.android, Packages=env.Packages;' +
      'var getHost=function(u){ try { return new URL(String(u)).host; } catch(e){ return ""; } };' +
      'var getAbsoluteUrl=function(u){ try { return new URL(String(u), baseUrl).href; } catch(e){ return String(u||""); } };' +
      // PATCH EVAL-SCOPE：这里不能是 "use strict"（曾经有）。
      // Rhino 语义：规则的 eval(...) 是 sloppy 直接 eval —— packed JS 里 `var newImgs=…`
      // 与 eval 后续代码同一个变量环境，eval 之后直接可读（酸奶/大树漫画防爬的依赖）。
      // 严格模式会让直接 eval 拿到**自己的**变量环境，eval 注入的 var 外面看不见 → newImgs undefined。
      // V8 的 sloppy 直接 eval 与 Rhino 行为一致（var 注入当前函数作用域），去掉指令即可对齐。
      'var v;' +
      'try { v = eval(env.code); } catch (e) { throw e; }' +
      'if (v !== undefined) return v;' +
      'return result;'
    );
    var out;
    // PATCH THIS：jsLib 里大量用 this.java / this.source / this.book / this.cache（Rhino 全局上的东西）
    // 严格模式下 this 是 undefined → 这里显式给一个作用域对象，并用 call 绑定过去
    // （严格函数的 this 会原样保留，直接 eval 也继承同一个 this）
    var thisScope = {
      java: env.java, cookie: env.cookie, cache: env.cache,
      // PATCH SOURCE-API：门面（带 getVariable/putLoginInfo… 方法，未知字段回落到原始 source）
      source: env.source, book: env.book,
      baseUrl: env.baseUrl, key: env.key, page: env.page, result: env.result,
      getCookie: env.cookie && env.cookie.getCookie,
      setCookie: env.cookie && env.cookie.setCookie,
      removeCookie: env.cookie && env.cookie.removeCookie
    };
    // PATCH THIS2：严格模式下 jsLib 里定义的函数被裸调用时 this 是 undefined，
    // 而 Rhino（sloppy）里 this 指向全局。这里临时把作用域挂到 window 上，
    // 让函数内部的 this.java / this.source 也能解析，结束后原样恢复。
    var G = (typeof window !== 'undefined') ? window : null;
    var saved = {};
    if (G) {
      Object.keys(thisScope).forEach(function (k) {
        saved[k] = { had: Object.prototype.hasOwnProperty.call(G, k), val: G[k] };
        try { G[k] = thisScope[k]; } catch (e) { /* 只读属性就算了 */ }
      });
    }
    try {
      out = fn.call(thisScope, { java: env.java, cookie: env.cookie, source: env.source, book: env.book,
        key: env.key, page: env.page, baseUrl: env.baseUrl, args: env.args,
        result: env.result, src: env.src, title: env.title, chapter: env.chapter,
        nextChapterUrl: env.nextChapterUrl, cache: env.cache, code: body,
        org: env.org, javax: env.javax, android: env.android, Packages: env.Packages });
    } catch (e) {
      // missError 已带书源上下文；不能重新包装丢掉 UNSUPPORTED 和具体 api。
      if (e && e.code === 'UNSUPPORTED') throw e;
      var hint = '';
      if (useLib && e && e.name === 'ReferenceError') {
        hint = '（已注入 jsLib，但该标识符仍未定义：' + ((e.message || '').slice(0, 80)) + '）';
      }
      throw new Error('书源 JS 执行出错：' + ((e && e.message) || e) + hint);
    } finally {
      if (G) {
        Object.keys(saved).forEach(function (k) {
          if (saved[k].had) { try { G[k] = saved[k].val; } catch (e) { } }
          else { try { delete G[k]; } catch (e) { } }
        });
      }
    }
    return out == null ? '' : out;
  }

  NR.legacyJs = {
    run: run, syncFetch: syncFetch, parseDoc: parseDoc, wrap: wrap, wrapList: wrapList,
    // PATCH API：jsoup 门面 + 记账本，供 runner / 调试页直接对照
    parseDocFacade: parseDocFacade, selectNodes: selectNodes, jsoupText: jsoupTextOf,
    stats: STATS,
    // PATCH SOURCE-API：source.* 的持久存储（runner / 调试页可以直接看）
    sourceStore: SOURCE_STORE,
    memoryStore: MEM,
    resetSourceStore: function () {
      Object.keys(SOURCE_STORE).forEach(function (k) { delete SOURCE_STORE[k]; });
    },
    resetStats: function () { STATS.missing = {}; STATS.warned = {}; }
  };
/* ===========================================================================
 * PATCH SYMMETRIC-CRYPTO — java.createSymmetricCrypto（Legado / hutool 语义）
 * ---------------------------------------------------------------------------
 * 纯 JS 同步 AES（ECB / CBC + PKCS7 padding，PKCS5 等价归一）。
 * transformation 解析对齐 hutool SymmetricCrypto（参见 legado SymmetricCryptoAndroid.kt）：
 *   "AES/CBC/PKCS5Padding" | "AES/ECB/PKCS7Padding" | "AES"（默认 ECB/PKCS5）…
 * key / iv 接受字符串（按 UTF-8 转 bytes）或 byte 数组 / {getStrBytes} 形态的门面 byte[]。
 * Crypto 对象方法（对齐 hutool + 语料实际调用）：
 *   encrypt(data)            → byte[] 门面
 *   encryptBase64(data)      → String（标准 Base64）
 *   encryptHex(data)         → String（小写 hex）
 *   decrypt(data)            → byte[] 门面（String 入参自动识别 hex / base64）
 *   decryptStr(data)         → String（String 入参自动识别 hex / base64）
 *   decryptBase64(data)      → String（入参按 Base64）
 *   decryptHex(data)         → String（入参按 hex）
 * DES 第一版不支持：抛出带 transformation 的清晰错误（语料 AES 占绝对多数）。
 * =========================================================================== */
(function (G) {
  'use strict';
  if (!G || !G.NR) return;

  /* ---------- AES 核心：S-box / 逆 S-box / 密钥扩展 / 加解密轮 ---------- */
  // S-box（标准 AES 查找表，按 0x00..0xFF 顺序）
  var SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
  // 逆 S-box
  var ISBOX = new Array(256);
  for (var si = 0; si < 256; si++) ISBOX[SBOX[si]] = si;

  // GF(2^8) 乘法（AES MixColumns 用）
  function gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }

  // 轮常量 Rcon
  var RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];

  // 密钥扩展：key 字节数组（16/24/32），返回 (Nr+1)*4 个 32 位字
  function expandKey(keyBytes) {
    var nk = keyBytes.length / 4;
    var nr = nk + 6;
    var w = new Array(4 * (nr + 1));
    var i, t;
    for (i = 0; i < nk; i++) {
      w[i] = (keyBytes[4 * i] << 24) | (keyBytes[4 * i + 1] << 16) | (keyBytes[4 * i + 2] << 8) | keyBytes[4 * i + 3];
    }
    for (; i < 4 * (nr + 1); i++) {
      t = w[i - 1];
      if (i % nk === 0) {
        // RotWord + SubWord + Rcon
        t = ((t << 8) | (t >>> 24)) >>> 0;
        t = (SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16)
          | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff];
        t = (t ^ (RCON[i / nk - 1] << 24)) >>> 0;
      } else if (nk > 6 && i % nk === 4) {
        t = (SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16)
          | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff];
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    return { words: w, rounds: nr };
  }

  // 对一个 16 字节块加解密（in/out 均为 16 字节数组）
  function encryptBlock(exp, inb) {
    var w = exp.words, nr = exp.rounds;
    var s = new Array(16), t = new Array(16);
    var i, r, c;
    for (i = 0; i < 16; i++) s[i] = inb[i] ^ ((w[i >> 2] >>> (24 - 8 * (i & 3))) & 0xff);
    for (r = 1; r <= nr; r++) {
      // SubBytes
      for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      // ShiftRows（列主序 state[r][c] = s[4c+r]）
      t[0]=s[0]; t[4]=s[4]; t[8]=s[8]; t[12]=s[12];
      t[1]=s[5]; t[5]=s[9]; t[9]=s[13]; t[13]=s[1];
      t[2]=s[10]; t[6]=s[14]; t[10]=s[2]; t[14]=s[6];
      t[3]=s[15]; t[7]=s[3]; t[11]=s[7]; t[15]=s[11];
      // MixColumns（最后一轮不做）
      if (r !== nr) {
        for (c = 0; c < 4; c++) {
          var a0=t[4*c],a1=t[4*c+1],a2=t[4*c+2],a3=t[4*c+3];
          s[4*c]   = gmul(a0,2)^gmul(a1,3)^a2^a3;
          s[4*c+1] = a0^gmul(a1,2)^gmul(a2,3)^a3;
          s[4*c+2] = a0^a1^gmul(a2,2)^gmul(a3,3);
          s[4*c+3] = gmul(a0,3)^a1^a2^gmul(a3,2);
        }
      } else {
        for (i = 0; i < 16; i++) s[i] = t[i];
      }
      // AddRoundKey
      for (i = 0; i < 16; i++) s[i] ^= ((w[4 * r + (i >> 2)] >>> (24 - 8 * (i & 3))) & 0xff);
    }
    return s;
  }

  function decryptBlock(exp, inb) {
    var w = exp.words, nr = exp.rounds;
    var s = new Array(16), t = new Array(16);
    var i, r, c;
    for (i = 0; i < 16; i++) s[i] = inb[i] ^ ((w[4 * nr + (i >> 2)] >>> (24 - 8 * (i & 3))) & 0xff);
    for (r = nr - 1; r >= 0; r--) {
      // InvShiftRows
      t[0]=s[0]; t[4]=s[4]; t[8]=s[8]; t[12]=s[12];
      t[5]=s[1]; t[9]=s[5]; t[13]=s[9]; t[1]=s[13];
      t[10]=s[2]; t[14]=s[6]; t[2]=s[10]; t[6]=s[14];
      t[15]=s[3]; t[3]=s[7]; t[7]=s[11]; t[11]=s[15];
      // InvSubBytes
      for (i = 0; i < 16; i++) t[i] = ISBOX[t[i]];
      // AddRoundKey
      for (i = 0; i < 16; i++) s[i] = t[i] ^ ((w[4 * r + (i >> 2)] >>> (24 - 8 * (i & 3))) & 0xff);
      // InvMixColumns（最后一轮 r=0 之后不做）
      if (r > 0) {
        for (c = 0; c < 4; c++) {
          var a0=s[4*c],a1=s[4*c+1],a2=s[4*c+2],a3=s[4*c+3];
          t[4*c]   = gmul(a0,14)^gmul(a1,11)^gmul(a2,13)^gmul(a3,9);
          t[4*c+1] = gmul(a0,9)^gmul(a1,14)^gmul(a2,11)^gmul(a3,13);
          t[4*c+2] = gmul(a0,13)^gmul(a1,9)^gmul(a2,14)^gmul(a3,11);
          t[4*c+3] = gmul(a0,11)^gmul(a1,13)^gmul(a2,9)^gmul(a3,14);
        }
        for (i = 0; i < 16; i++) s[i] = t[i];
      }
    }
    return s;
  }

  /* ---------- 编解码工具（复用宿主已有 helper，独立兜底） ---------- */
  function strToUtf8(s) {
    s = String(s == null ? '' : s);
    if (typeof strToBytesCharset === 'function') return strToBytesCharset(s, 'UTF-8');
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++;
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else out.push(0xef, 0xbf, 0xbd);
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  function utf8ToStr(b) {
    if (typeof bytesToStr === 'function') return bytesToStr(b, 'UTF-8');
    var out = '', i = 0;
    while (i < b.length) {
      var c = b[i];
      if (c < 0x80) { out += String.fromCharCode(c); i++; }
      else if (c < 0xe0) { out += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
      else if (c < 0xf0) {
        out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3;
      } else {
        var cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4;
      }
    }
    return out;
  }
  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToBase64(b) {
    var out = '', i;
    for (i = 0; i + 2 < b.length; i += 3) {
      out += B64C[b[i] >> 2] + B64C[((b[i] & 3) << 4) | (b[i + 1] >> 4)]
           + B64C[((b[i + 1] & 15) << 2) | (b[i + 2] >> 6)] + B64C[b[i + 2] & 63];
    }
    if (i < b.length) {
      out += B64C[b[i] >> 2];
      if (i + 1 < b.length) {
        out += B64C[((b[i] & 3) << 4) | (b[i + 1] >> 4)] + B64C[(b[i + 1] & 15) << 2] + '=';
      } else {
        out += B64C[(b[i] & 3) << 4] + '==';
      }
    }
    return out;
  }
  function base64ToBytes(s) {
    s = String(s == null ? '' : s).replace(/[\s\r\n]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    s = s.replace(/=+$/, '');
    var out = [], buf = 0, bits = 0, i;
    for (i = 0; i < s.length; i++) {
      var v = B64C.indexOf(s.charAt(i));
      if (v < 0) throw new Error('createSymmetricCrypto：非法 Base64 密文（位置 ' + i + '）');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
    }
    return out;
  }
  function bytesToHex(b) {
    var H = '0123456789abcdef', out = '', i;
    for (i = 0; i < b.length; i++) out += H[b[i] >> 4] + H[b[i] & 15];
    return out;
  }
  function hexToBytes(s) {
    s = String(s == null ? '' : s).replace(/[\s\r\n]/g, '');
    if (s.length % 2) throw new Error('createSymmetricCrypto：非法 hex 密文（长度不是偶数）');
    var out = [], i;
    for (i = 0; i < s.length; i += 2) {
      var v = parseInt(s.substr(i, 2), 16);
      if (isNaN(v)) throw new Error('createSymmetricCrypto：非法 hex 密文（位置 ' + i + '）');
      out.push(v);
    }
    return out;
  }
  function isHexString(s) {
    s = String(s == null ? '' : s).trim();
    return s.length >= 2 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
  }

  // 取「byte 数组 / Java byte[] 门面」里的原始字节
  function bytesOf(v) {
    if (v == null) return [];
    if (typeof v === 'string') return strToUtf8(v);
    if (typeof v.length === 'number') {
      var out = [], i;
      for (i = 0; i < v.length; i++) {
        var x = v[i];
        if (typeof x === 'number') out.push(x & 0xff);
        else if (x && typeof x.getByteValue === 'function') out.push(x.getByteValue() & 0xff);
        else if (x && typeof x.getByte === 'function') out.push(x.getByte() & 0xff);
        else if (x && typeof x.byteValue === 'function') out.push(x.byteValue() & 0xff);
        else if (x && typeof x.valueOf === 'function') out.push(Number(x.valueOf()) & 0xff);
        else throw new Error('createSymmetricCrypto：key/iv 数组里出现无法解释的元素（' + typeof x + '）');
      }
      return out;
    }
    throw new Error('createSymmetricCrypto：key/iv 只接受字符串或字节数组，收到 ' + typeof v);
  }

  /* ---------- PKCS7（=PKCS5 等价）padding ---------- */
  function pkcs7Pad(data) {
    var pad = 16 - (data.length % 16);
    var out = data.slice(0), i;
    for (i = 0; i < pad; i++) out.push(pad);
    return out;
  }
  function pkcs7Unpad(data) {
    if (!data.length || data.length % 16) throw new Error('createSymmetricCrypto：解密结果长度不是 16 的倍数（密文已损坏？）');
    var pad = data[data.length - 1];
    if (pad < 1 || pad > 16) throw new Error('createSymmetricCrypto：PKCS7 填充校验失败（密钥/密文不匹配？）');
    for (var i = data.length - pad; i < data.length; i++) {
      if (data[i] !== pad) throw new Error('createSymmetricCrypto：PKCS7 填充校验失败（密钥/密文不匹配？）');
    }
    return data.slice(0, data.length - pad);
  }

  /* ---------- transformation 解析 ---------- */
  function parseTransformation(t) {
    var s = String(t == null ? 'AES' : t).trim();
    if (!s) s = 'AES';
    var parts = s.split('/').map(function (x) { return x.trim(); });
    var algo = parts[0] || 'AES';
    var mode = (parts[1] || 'ECB').toUpperCase();
    var padding = (parts[2] || 'PKCS5Padding').toUpperCase();
    if (padding === 'PKCS7PADDING') padding = 'PKCS5PADDING';   // hutool/legado 的归一
    if (algo.toUpperCase() !== 'AES') {
      throw new Error('java.createSymmetricCrypto：暂不支持算法 "' + algo + '"（transformation="' + s + '"）。'
        + '第一版只实现了 AES（ECB/CBC + PKCS5/7 padding），DES/DESede/SM4 等待后续版本。');
    }
    if (mode !== 'ECB' && mode !== 'CBC') {
      throw new Error('java.createSymmetricCrypto：暂不支持模式 "' + mode + '"（transformation="' + s + '"）。只实现了 ECB / CBC。');
    }
    if (padding !== 'PKCS5PADDING' && padding !== 'NOPADDING') {
      throw new Error('java.createSymmetricCrypto：暂不支持 padding "' + padding + '"（transformation="' + s + '"）。只实现了 PKCS5/7 / NoPadding。');
    }
    return { algo: 'AES', mode: mode, padding: padding, raw: s };
  }

  /* ---------- Crypto 门面 ---------- */
  function makeCrypto(parsed, keyBytes, ivBytes) {
    var exp = expandKey(keyBytes);
    var blockMode = parsed.mode;

    function encBytes(plain) {
      var data = pkcs7Pad(plain);
      if (blockMode === 'ECB') {
        var out = [], i;
        for (i = 0; i < data.length; i += 16) out = out.concat(encryptBlock(exp, data.slice(i, i + 16)));
        return out;
      }
      // CBC
      if (!ivBytes || ivBytes.length !== 16) {
        throw new Error('java.createSymmetricCrypto：CBC 模式需要 16 字节 iv（transformation="' + parsed.raw + '"）');
      }
      var out = [], prev = ivBytes.slice(0), i, j, blk;
      for (i = 0; i < data.length; i += 16) {
        blk = [];
        for (j = 0; j < 16; j++) blk.push(data[i + j] ^ prev[j]);
        prev = encryptBlock(exp, blk);
        out = out.concat(prev);
      }
      return out;
    }

    function decBytes(cipher) {
      if (cipher.length % 16) throw new Error('java.createSymmetricCrypto：AES 密文长度必须是 16 的倍数（收到 ' + cipher.length + ' 字节）');
      if (blockMode === 'ECB') {
        var out = [], i;
        for (i = 0; i < cipher.length; i += 16) out = out.concat(decryptBlock(exp, cipher.slice(i, i + 16)));
        return parsed.padding === 'NOPADDING' ? out : pkcs7Unpad(out);
      }
      // CBC
      if (!ivBytes || ivBytes.length !== 16) {
        throw new Error('java.createSymmetricCrypto：CBC 模式需要 16 字节 iv（transformation="' + parsed.raw + '"）');
      }
      var out = [], prev = ivBytes.slice(0), i, j, blk, dec;
      for (i = 0; i < cipher.length; i += 16) {
        blk = cipher.slice(i, i + 16);
        dec = decryptBlock(exp, blk);
        for (j = 0; j < 16; j++) out.push(dec[j] ^ prev[j]);
        prev = blk;
      }
      return parsed.padding === 'NOPADDING' ? out : pkcs7Unpad(out);
    }

    // data → String（hex/base64 自动识别）或 byte[] → byte[]
    function toBytesArg(data) {
      if (typeof data === 'string') {
        return isHexString(data) ? hexToBytes(data) : base64ToBytes(data);
      }
      return bytesOf(data);
    }

    var api = {
      encrypt: function (data) { return byteArrayWrapper(encBytes(bytesOf(data))); },
      encryptBase64: function (data) { return bytesToBase64(encBytes(bytesOf(data))); },
      encryptHex: function (data) { return bytesToHex(encBytes(bytesOf(data))); },
      decrypt: function (data) { return byteArrayWrapper(decBytes(toBytesArg(data))); },
      decryptStr: function (data) { return utf8ToStr(decBytes(toBytesArg(data))); },
      decryptBase64: function (data) { return utf8ToStr(decBytes(base64ToBytes(data))); },
      decryptHex: function (data) { return utf8ToStr(decBytes(hexToBytes(data))); }
    };
    // hutool 还有 encryptHex(ByteArray)/encryptBase64(String,charset) —— 语料没用到，先不展开
    return api;
  }

  // byte[] 门面（对齐 legacy-js 其它 byteArray() 的形态）
  function byteArrayWrapper(bytes) {
    if (typeof byteArray === 'function') return byteArray(bytes);
    var arr = bytes.slice(0);
    arr.getStrBytes = function () { return this; };
    return arr;
  }

  /* ---------- 入口：java.createSymmetricCrypto(transformation, key, iv) ---------- */
  G.NR._createSymmetricCrypto = function (transformation, key, iv) {
    var parsed = parseTransformation(transformation);
    var keyBytes = bytesOf(key);
    if (keyBytes.length !== 16 && keyBytes.length !== 24 && keyBytes.length !== 32) {
      throw new Error('java.createSymmetricCrypto：AES key 必须是 16/24/32 字节（收到 ' + keyBytes.length
        + ' 字节）。注意字符串按 UTF-8 编码，中文/emoji 会改变字节数。');
    }
    var ivBytes = (iv == null || iv === '') ? null : bytesOf(iv);
    if (parsed.mode === 'CBC' && (!ivBytes || ivBytes.length !== 16)) {
      throw new Error('java.createSymmetricCrypto：CBC 模式需要 16 字节 iv（transformation="' + parsed.raw
        + '"，收到 ' + (ivBytes ? ivBytes.length : 0) + ' 字节）');
    }
    if (parsed.mode === 'ECB') ivBytes = null;   // ECB 无 iv
    return makeCrypto(parsed, keyBytes, ivBytes);
  };
})(typeof window !== 'undefined' ? window : this);

})(window);
