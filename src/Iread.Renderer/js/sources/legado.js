/* =========================================================================
 * sources/legado.js — 把「开源阅读 Legado」的书源 JSON 跑起来
 * -------------------------------------------------------------------------
 * 一个书源 = 一组规则：
 *   searchUrl / exploreUrl            搜索地址（支持 {{key}} {{page}}，POST 写在 ,{...} 里）
 *   ruleSearch  { bookList,name,author,kind,lastChapter,intro,coverUrl,bookUrl }
 *   ruleBookInfo{ name,author,intro,coverUrl,tocUrl,lastChapter,wordCount }
 *   ruleToc     { chapterList,chapterName,chapterUrl }
 *   ruleContent { content }
 *
 * 兼容两种 JSON：
 *   1. Legado 原生导出（bookSourceName / bookSourceUrl / ruleSearch …）
 *   2. 本项目的简化写法（name / url / search / rules:{list,name,…}）
 *
 * 规则语法见 rule.js。所有函数 async，失败抛 Error（带上下文，便于排查）。
 * ========================================================================= */
(function (global) {
  'use strict';

  var R = global.NR.rule;
  var Y = global.yedu;

  /* ---------------- 结构化错误（筛选判定用）
   * 所有对外抛出的 Error 尽量带 err.code，调用方据此区分「站点死了」和「规则/这本书的问题」：
   *   NET           网络层失败/超时（err.timeout=true 表示超时）
   *   HTTP          HTTP >= 400（err.http 状态码）
   *   BAD_JSON      规则按 JSON 解析，但响应不是 JSON（常见于验证页/改版）
   *   RULE          规则执行异常（选择器/JS 出错）
   *   NO_NODES      列表规则 0 个节点
   *   EMPTY_FIELDS  有节点，但书名/链接全空（常见：站点返回「没有找到」占位行）
   *   EMPTY_TOC     目录为空         EMPTY_CONTENT 正文为空
   *   NO_RULE       书源没配置这一步需要的规则/地址
   *   UNSUPPORTED   写法不支持（如 exploreUrl 是 @js:）
   * 附带诊断：err.http / err.url / err.nodes / err.bodyLen（拿得到才有） */
  function mkErr(code, msg, extra) {
    var e = new Error(msg);
    e.code = code;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined) e[k] = extra[k];
      }
    }
    return e;
  }

  /* 已带 code 的原样返回；没带的贴上 code（不改 message，老调用方按文案匹配的逻辑不受影响） */
  function tagErr(e, code, extra) {
    if (!e || typeof e !== 'object') e = new Error(String(e == null ? '未知错误' : e));
    if (!e.code) {
      e.code = code;
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined && e[k] === undefined) e[k] = extra[k];
        }
      }
    }
    return e;
  }

  /* 把诊断挂成非枚举属性：JSON.stringify / Object.keys / 展开都看不到，老调用方无感 */
  function attachDiag(arr, diag) {
    try { Object.defineProperty(arr, '__diag', { value: diag, enumerable: false, configurable: true, writable: true }); }
    catch (e) { /* 冻结对象等极端情况：忽略 */ }
    return arr;
  }

  function need(v, msg, code) { if (v == null || v === '') throw mkErr(code || 'NO_RULE', msg); return v; }

  function criticalError(e) { return !!(e && /^(UNSUPPORTED|ENCODING|(?:RULE_)?CANCELLED)$/.test(e.code || '')); }

  function noteTrace(ctx, entry) {
    if (!ctx || !entry) return;
    var rows = ctx.diagnostics || (ctx.diagnostics = []);
    if (rows.length >= 64) return;
    var clean = { facet: entry.facet || 'rule', code: entry.code, source: entry.source || 'rule' };
    if (entry.field) clean.field = entry.field;
    if (entry.cause) clean.cause = entry.cause;
    if (Number.isInteger(entry.segmentIndex)) clean.segmentIndex = entry.segmentIndex;
    if (entry.segmentKind) clean.segmentKind = entry.segmentKind;
    rows.push(clean);
  }

  function noteTraceError(ctx, field, error, facet, source) {
    noteTrace(ctx, { facet: facet, field: field, code: error && error.code || 'RULE', cause: error && error.name || 'Error', source: source, segmentIndex: error && error.segmentIndex, segmentKind: error && error.segmentKind });
  }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 's' + Math.abs(h).toString(36);
  }

  /* ------------------------------------------------------------ 归一化 */
  function ruleContainer(value, field) {
    if (value == null || value === '') return {};
    var parsed = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); }
      catch (e) { throw new Error(field + ' 不是合法 JSON 对象字符串'); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(field + ' 必须是对象或严格 JSON 对象字符串');
    }
    return parsed;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('书源不是一个对象');

    var url = raw.bookSourceUrl || raw.url || raw.sourceUrl || '';
    var name = raw.bookSourceName || raw.name || raw.sourceName || url;
    if (!name && !url) throw new Error('书源缺少名称和地址');

    var legado = !!(raw.bookSourceUrl || raw.ruleSearch || raw.ruleToc);

    var src = {
      // 同一个站点可以有多套规则（不同写法/不同分组），所以 id 用「名称+地址」算，
      // 不能只用地址
      id: raw.id || hash(String(name || '') + '|' + String(url || '')),
      name: String(name || '未命名书源').trim(),
      url: String(url || '').trim(),
      group: '',                       // 分组只由用户在界面里分；导入时的 bookSourceGroup 不自动采用
      comment: raw.bookSourceComment || raw.comment || '',
      enabled: raw.enabled !== false,
      charset: String(raw.charset || raw.bookSourceCharset || '').trim(),
      requestCharset: String(raw.requestCharset || '').trim(),
      lenientDecode: raw.lenientDecode === true,
      headers: raw.header || raw.headers || null,
      timeout: raw.timeout || 15000,
      kind: 'legado',
      srcType: Number(raw.bookSourceType || 0),   // 0=文字 4=视频（章节正文是视频地址）
      legado: legado,
      jsLib: raw.jsLib || '',          // E3：保留 jsLib（61 源 20.3% 依赖），legacy-js.js 执行器会注入
      searchUrl: String(raw.searchUrl || raw.search || '').trim(),
      exploreUrl: raw.exploreUrl || '',
      ruleSearch: {},
      ruleExplore: {},                 // 发现页规则（与 ruleSearch 同构；空时 explore() 回退 ruleSearch）
      ruleBookInfo: {},
      ruleToc: {},
      ruleContent: {},
      // 目录倒序（新→旧）时翻成正序：书源里写 reverseChapters:true 或 ruleToc.reverse:true
      reverseChapters: raw.reverseChapters === true || !!(raw.ruleToc && raw.ruleToc.reverse === true),
      addedAt: Date.now()
    };

    if (legado) {
      src.ruleSearch = ruleContainer(raw.ruleSearch, 'ruleSearch');
      src.ruleExplore = ruleContainer(raw.ruleExplore, 'ruleExplore');
      src.ruleBookInfo = ruleContainer(raw.ruleBookInfo, 'ruleBookInfo');
      src.ruleToc = ruleContainer(raw.ruleToc, 'ruleToc');
      src.ruleContent = ruleContainer(raw.ruleContent, 'ruleContent');
    } else {
      // 简化写法
      var rules = raw.rules || raw.rule || {};
      src.ruleSearch = {
        bookList: rules.list || rules.bookList,
        name: rules.name,
        author: rules.author,
        intro: rules.intro,
        lastChapter: rules.lastChapter,
        coverUrl: rules.cover || rules.coverUrl,
        bookUrl: rules.bookUrl || rules.url
      };
      src.ruleBookInfo = {
        name: rules.detailName || rules.name,
        author: rules.author,
        intro: rules.detailIntro || rules.intro,
        coverUrl: rules.cover || rules.coverUrl,
        tocUrl: rules.tocUrl
      };
      src.ruleToc = {
        chapterList: rules.chapterList || rules.chapters,
        chapterName: rules.chapterName,
        chapterUrl: rules.chapterUrl,
        nextTocUrl: rules.nextTocUrl
      };
      src.ruleContent = {
        content: rules.content || rules.text,
        nextContentUrl: rules.nextContentUrl,
        imageDecode: rules.imageDecode || '',      // P：漫画图源解密脚本（Legado imageDecode）
        imageStyle: rules.imageStyle || ''
      };
    }
    return src;
  }

  /* ------------------------------------------------------------ 请求 */
  /* Legado 的 URL 规则：@js / <js> 段先求值（@result 指当前地址），
     再套 {{js}} 与 <a,b,c> 分页，最后拆 ,{...} 选项、编码 query、补绝对地址 */
  async function evalUrlRule(src, raw, vars) {
    var s = String(raw || '').trim();
    if (!s) return '';

    // 1. URL 里的 JS（对齐 AnalyzeUrl.analyzeJs）：结果仍要补成绝对地址
    var re = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/i;
    // 仍按整串匹配，这样 JS 代码不会被截断（例如语料里真实存在的
    //   "@js:result + ',{\"webView\":true}'"，它的 ,{ 就在 JS 代码内部）
    var m = re.exec(s);
    /* r4：但 JS 标记必须落在选项后缀之前才算「URL 的 JS」。
     * 后缀 ,{...} 里也会出现 @js:，例如
     *   /s?q={{key}},{"headers":"@js:JSON.stringify({\"X-T\":java.get(\"tk\")})"}
     * 那是 header 的值，不是 URL 的 JS。若在这里走 JS 分支，整段选项后缀会被吃掉
     * （buildUrl 再也拆不出 headers/method/body），于是 header 全丢、POST 退化成 GET。
     * 这类情况要放给第 2、3 步：expand + buildUrl 拆出选项后，
     * headers 值本身是 @js:/<js> 时由 evalHeaders 去求值。 */
    var optAt = RE_RULE_URL_OPTIONS.exec(s);
    if (m && optAt && m.index > optAt.index) m = null;
    if (m) {
      var code = m[2] != null ? m[2] : m[1];
      var before = s.substring(0, m.index).trim();
      var pushed = before ? before.replace('@result', s) : s;
      var out;
      try {
        var v = await R.apply('@js:' + code, {
          baseUrl: src.url, key: vars.key, page: vars.page, source: src, result: pushed
        });
        out = String(v == null ? '' : v).trim();
      } catch (e) {
        if (criticalError(e)) throw e;
        noteTraceError(vars, 'url', e, 'url', 'fallback');
        out = pushed;
      }
      if (out) return R.buildUrl(out, Object.assign({ source: src }, vars || {}), src.url);
    }

    // 2. {{ }} / <a,b,c>
    var expanded = R.expand(s, Object.assign({ source: src }, vars || {}));

    // 3. 选项 + 编码 + 绝对地址
    var built = R.buildUrl(expanded, Object.assign({ source: src }, vars || {}), src.url);
    return built;
  }

  /* r2：规则算出来的地址（bookUrl / tocUrl / chapterUrl / nextTocUrl / nextContentUrl）
   * 可能自带 Legado 的 ,{...} 选项后缀，例如
   *   "https://www.missevan.com/mdrama/drama/{{$.id}},{\"webView\":true}"
   * 直接丢给 R.resolveUrl（new URL()）会把后缀百分号化进路径：
   *   …/drama/9,%7B%22webView%22:true%7D
   * 之后 fetchPage → buildUrl 再也拆不出选项，请求打到错误地址（404 → 判 dead），
   * method:POST 也会退化成 GET。所以这里先把后缀切出来，只对前半段补绝对地址，
   * 再原样拼回，让 buildUrl 的 splitUrlOptions 去权威地拆。
   * 判定与 rule.js 的 RE_URL_OPTIONS 一致（`,` 后允许空白，且必须紧跟 `{`），
   * 因此 "a,b" 这种普通逗号不会被误切。 */
  var RE_RULE_URL_OPTIONS = /\s*,\s*(?=\{)/;

  function resolveRuleUrl(u, base) {
    var s = String(u == null ? '' : u);
    var m = RE_RULE_URL_OPTIONS.exec(s);
    if (!m) return R.resolveUrl(s, base);          // 没有选项后缀：与旧行为完全一致
    var head = R.resolveUrl(s.substring(0, m.index), base);
    // head 为空表示前半段本身不可用（空串 / data: javascript: 等）——
    // 保持旧语义返回空，让调用方的 `if (!bookUrl) continue` 之类的判空继续生效，
    // 不能只留一个孤零零的 ",{...}" 当成有效地址。
    if (!head) return '';
    return head + s.substring(m.index);            // 选项段逐字符原样拼回
  }

  /* 手机 UA：书源规则绝大多数是按手机页面写的（Legado 默认也用手机 UA） */
  var UA_MOBILE = 'Mozilla/5.0 (Linux; U; Android 8.1.0; zh-CN; MI 8 Lite Build/OPM1.171019.019) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.2.0.1100 Mobile Safari/537.36';
  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

  /* UA 判定：只看不改 —— 大小写不敏感地找 user-agent，但绝不重写键名
   * （header 名称的大小写对某些站点是有意义的，归一化会改变实际发出的请求） */
  function hasUaHeader(h) {
    if (!h || typeof h !== 'object') return false;
    var ks = Object.keys(h);
    for (var i = 0; i < ks.length; i++) {
      if (String(ks[i]).toLowerCase() === 'user-agent' && h[ks[i]]) return true;
    }
    return false;
  }

  async function srcHasUa(src, vars) {
    return hasUaHeader(await hrefHeaders(src, vars));
  }

  function parseOptions(str) {
    if (!str) return {};
    try { return JSON.parse(str) || {}; } catch (e) { return {}; }
  }

  async function fetchPage(src, url, vars, ua) {
    if (!Y || !Y.fetchText) throw mkErr('NET', '网络模块不可用');
    vars = vars || {};
    var built;
    try { built = await evalUrlRule(src, url, vars); }
    catch (e0) { throw tagErr(e0, 'RULE', { url: String(url || '') }); }
    var real = typeof built === 'string' ? built : built.url;
    var o = (typeof built === 'string' ? {} : (built.optionsParsed || parseOptions(built.options)));

    var body = o.body != null ? R.expand(o.body, Object.assign({ source: src }, vars)) : undefined;
    // r4：src.header 与 ,{…} 选项里的 headers 都可能是 @js:/<js> 形式，
    // 两处都走 evalHeaders 求值；选项 header 覆盖同名 src header（Legado 的顺序）
    var hSrc = await evalHeaders(src.headers, src, vars);
    var hOpt = await evalHeaders(o.headers, src, vars);
    var headers = Object.assign({}, hSrc, hOpt);
    if (ua && !hasUaHeader(headers)) headers['User-Agent'] = ua;
    var method = String((typeof built !== 'string' && built.method) || o.method || (body != null ? 'POST' : 'GET')).toUpperCase();
    var charset = String((typeof built !== 'string' && built.charset) || o.charset || src.charset || '').trim();
    var requestCharset = String(o.requestCharset != null ? o.requestCharset : (src.requestCharset || '')).trim();
    var lenientDecode = o.lenientDecode != null ? o.lenientDecode : (src.lenientDecode || false);

    var res;
    try {
      res = await Y.fetchText({
        url: real,
        method: method,
        headers: headers,
        body: body,
        charset: charset,
        requestCharset: requestCharset,
        lenientDecode: lenientDecode,
        timeout: src.timeout || 15000,
        referer: src.url || ''
      });
    } catch (e) {
      if (e && /^(ENCODING|UNSUPPORTED|(?:RULE_)?CANCELLED)$/.test(e.code || '')) throw e;
      // 网络层（Electron net.js / WebView2 宿主）只给 message：
      //   宿主遇 HTTP>=400 直接 reject「HTTP 404：url」；超时是「请求超时：url」/ 取消
      var m = String((e && e.message) || e || '');
      var hm = /\bHTTP\s+(\d{3})\b/.exec(m);
      if (hm && Number(hm[1]) >= 400) throw tagErr(e, 'HTTP', { http: Number(hm[1]), url: real });
      throw tagErr(e, 'NET', { url: real, timeout: /超时|timeout|timed?\s*out|abort|cancel/i.test(m) || undefined });
    }
    if (!res || res.text == null) throw mkErr('NET', '没有拿到内容', { url: real, http: res && res.status });
    if (!res.ok && res.status >= 400) {
      throw mkErr('HTTP', 'HTTP ' + res.status, { http: res.status, url: res.url || real, bodyLen: String(res.text).length });
    }
    var page = { text: res.text, url: res.url || real, charset: res.charset, status: res.status };
    if (vars.diagnostics && vars.diagnostics.length) attachDiag(page, { traces: vars.diagnostics });
    return page;
  }

  /* 一次响应的诊断摘要 */
  function diagOf(res, nodes) {
    if (!res) return { http: undefined, url: '', nodes: nodes || 0, bodyLen: 0 };
    var diag = { http: res.status, url: res.url, nodes: nodes, bodyLen: String(res.text == null ? '' : res.text).length };
    if (res.__diag && res.__diag.traces) diag.traces = res.__diag.traces;
    return diag;
  }

  /* 先用手机 UA 拿；结果为空再换桌面 UA 试一次（有的站两套页面规则不一样）。
   * 显式分类允许真实空列表时只请求指定 URL 一次，不把空分类误判为 UA 差异。 */
  async function fetchWithUa(src, url, vars, parse, allowEmpty) {
    var nonEmpty = function (v) {
      if (v == null) return false;
      if (typeof v === 'string') return v.length > 0;
      return v.length !== undefined ? v.length > 0 : true;
    };
    // 解析阶段的异常：规则执行出错记 RULE（jsonOf 已自带 BAD_JSON），附上这次响应的诊断
    async function run(res) {
      try { return await parse(res); }
      catch (e) {
        var d = diagOf(res);
        throw tagErr(e, 'RULE', { http: d.http, url: d.url, bodyLen: d.bodyLen });
      }
    }
    var first = (await srcHasUa(src, vars)) ? '' : UA_MOBILE;
    var res = await fetchPage(src, url, vars, first);
    var out = await run(res);
    if (allowEmpty || nonEmpty(out)) return { res: res, out: out };

    if (!first) return { res: res, out: out };   // 书源自己指定了 UA，就别乱换
    var res2 = await fetchPage(src, url, vars, UA_DESKTOP);
    var out2 = await run(res2);
    return nonEmpty(out2) ? { res: res2, out: out2 } : { res: res, out: out };
  }

  /* r4：header 的 JS 形式（REPORT.md 第 6 项，影响 26 个源）。
   * Legado 的 header 字段可以是：
   *   1) JSON 字符串   '{"User-Agent":"…","Referer":"…"}'
   *   2) @js: 开头      '@js:JSON.stringify({"token": java.get("tk")})'
   *   3) <js>…</js>     '<js>…</js>'
   * 后两种是「先跑 JS 再 parse」——很多站的 token / 签名 / 时间戳只能算出来，写不死。
   * 原来这里对字符串只做一次 JSON.parse，失败就 return {}，于是 2)、3) 被整个丢掉：
   * 缺 UA/Referer/token → 站点 403 或返回空列表 → 好书源测不通（上一轮起不会再被删，
   * 但仍然判不出可用）。所以这里先识别 JS 形式并求值，再 parse 结果。
   *
   * 求值失败 / parse 失败一律回退 {}，绝不抛错：header 拿不到顶多是少几个头，
   * 不该让整个搜索或详情流程挂掉。
   *
   * 键名大小写一律原样保留（hasUaHeader 只在判定时忽略大小写），因为 header 名
   * 的大小写对部分站点是有意义的，归一化等于改变实际发出的请求。
   */
  var RE_HEADER_JS = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/i;

  async function hrefHeaders(src, vars) {
    return evalHeaders(src && src.headers, src, vars);
  }

  /* header 的统一入口：src.header 与 URL 的 ,{…} 选项里拆出来的 headers 都走这里，
   * 所以「选项里的 header 是 JS」也能被求值（r2 的 resolveRuleUrl / buildUrl 只负责
   * 把选项原样拆出来，值本身是不是 JS 得在这一层判）。 */
  async function evalHeaders(h, src, vars) {
    if (!h) return {};

    if (typeof h === 'string') {
      var s = h.trim();
      var m = RE_HEADER_JS.exec(s);
      if (m) {
        // @js: / <js>…</js>：先求值再 parse。与 evalUrlRule 里 URL 的 JS 处理同源
        // （同样把 @js: 前缀统一交给 R.apply，让 splitJsBlocks 去分派），
        // vars 透传进去，JS 里才拿得到 key / page。
        var code = m[2] != null ? m[2] : m[1];
        var ev;
        try {
          ev = await R.apply('@js:' + code, Object.assign({
            baseUrl: (src && src.url) || '', source: src
          }, vars || {}));
        } catch (e) {
          if (criticalError(e)) throw e;
          if (global.console) console.warn('[书源] header 的 JS 求值失败，已忽略该 header：', (e && e.message) || e);
          return {};
        }
        return headersFromValue(ev);
      }
      return headersFromValue(s);
    }

    return headersFromValue(h);
  }

  /* 求值/配置结果 → header 对象。接受对象、数组、JSON 字符串三种形态；
   * parse 不出来就回退 {}，不抛错。 */
  function headersFromValue(v) {
    var h = v;
    if (typeof h === 'string') {
      var s = h.trim();
      if (!s) return {};
      try { h = JSON.parse(s); } catch (e) { return {}; }
    }
    if (Array.isArray(h)) {
      // 有些书源把 header 写成 [{name,value}, …]
      var out = {};
      h.forEach(function (x) { if (x && x.name) out[x.name] = x.value; });
      return out;
    }
    return (h && typeof h === 'object') ? h : {};
  }

  /* 页面是 JSON 还是 HTML？看第一条规则 */
  function looksJson(rule) {
    var s = String(rule || '').trim();
    return /^\$/.test(s) || /^@json\s*:/i.test(s);
  }

  async function scope(rule) {
    var s = String(rule || '').trim();
    if (looksJson(s)) return 'json';
    if (/^@js\s*:/i.test(s)) return 'js';
    return 'html';
  }

  function docOf(page) {
    return R.parseHtml(page.text);
  }

  function jsonOf(page) {
    try { return JSON.parse(page.text); }
    catch (e) {
      // 有些接口会在 JSON 外面包一层，尽量兜一下
      var m = /[{[][\s\S]*[}\]]/.exec(page.text);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* 继续抛 */ } }
      throw mkErr('BAD_JSON', '返回内容不是合法 JSON', diagOf(page));
    }
  }

  /* ------------------------------------------------------------ 搜索 */
  /* 单条规则出错不该带垮整页：取不到就返回空 */
  async function safe(scope, rule, ctx, field, facet) {
    if (!rule) return '';
    try {
      var value = await R.derive(scope, rule, ctx);
      if (!value) noteTrace(ctx, { facet: facet, field: field, code: 'MISS', segmentIndex: 0, segmentKind: 'group' });
      else if (ctx.source && ctx.source.__trace) noteTrace(ctx, { facet: facet, field: field, code: 'OK', segmentIndex: 0, segmentKind: 'group' });
      return value;
    } catch (e) {
      if (criticalError(e)) throw e;
      noteTraceError(ctx, field, e, facet, 'rule');
      if (global.console) console.warn('[书源] 规则失败：', field || '未定位字段', e && e.code || e && e.name || 'Error');
      return '';
    }
  }

  function flatten(list) {
    var out = [];
    (list || []).forEach(function (x) {
      if (Array.isArray(x)) out = out.concat(flatten(x));
      else out.push(x);
    });
    return out;
  }

  async function search(src, keyword, page) {
    need(src.searchUrl, '这个书源没有配置搜索地址（searchUrl）');
    var vars = { key: keyword, page: page || 1, baseUrl: src.url };

    var listRule = src.ruleSearch.bookList || src.ruleSearch.list;
    var usedRes = null, usedCtx = null, nodeCount = 0;

    async function parseSearch(res) {
      var kind = await scope(listRule);
      var ctx = { baseUrl: res.url, key: keyword, page: page || 1, source: src, diagnostics: [] };
      var its;
      if (kind === 'json') {
        var json = jsonOf(res);
        ctx.json = json; ctx.value = json;
        its = await R.list(listRule, ctx);
      } else {
        ctx.html = res.text;
        ctx.doc = docOf(res);
        its = await R.list(listRule, ctx);
      }
      usedRes = res; usedCtx = ctx;
      its = flatten(its || []);
      nodeCount = its.length;
      return its;
    }

    var got = await fetchWithUa(src, src.searchUrl, vars, parseSearch);
    var items = got.out || [];
    var res = usedRes || got.res;
    var ctx = usedCtx || { baseUrl: (res && res.url) || '', key: keyword, page: page || 1, source: src };
    var diag = diagOf(res, nodeCount);

    if (!items.length) {
      throw mkErr('NO_NODES', '没有解析到搜索结果（规则可能失效）', diag);
    }

    var out = [];
    var ruleErrs = 0, firstRuleErr = null;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var sctx = Object.assign({}, ctx, { key: keyword, page: page || 1 });
      if (item && typeof item === 'object' && !item.nodeType) { sctx.value = item; sctx.node = null; }
      else { sctx.node = item; sctx.value = undefined; }

      try {
        var title = await safe(sctx.node || sctx.value, src.ruleSearch.name || '@text', sctx, 'ruleSearch.name', 'search-field');
        var bookUrl = await safe(sctx.node || sctx.value,
          src.ruleSearch.bookUrl || 'a@href', Object.assign({}, sctx, { baseUrl: res.url }), 'ruleSearch.bookUrl', 'search-field');
        bookUrl = resolveRuleUrl(bookUrl, res.url);   // 规则给的常是相对地址；r2：保留 ,{...} 选项后缀
        if (!title || !bookUrl) continue;
        var coverUrl = await safe(sctx.node || sctx.value, src.ruleSearch.coverUrl, sctx, 'ruleSearch.coverUrl', 'search-field');
        out.push({
          title: title,
          author: await safe(sctx.node || sctx.value, src.ruleSearch.author, sctx, 'ruleSearch.author', 'search-field'),
          intro: await safe(sctx.node || sctx.value, src.ruleSearch.intro, sctx, 'ruleSearch.intro', 'search-field'),
          lastChapter: await safe(sctx.node || sctx.value, src.ruleSearch.lastChapter, sctx, 'ruleSearch.lastChapter', 'search-field'),
          coverUrl: coverUrl ? R.resolveUrl(coverUrl, res.url) : '',
          bookUrl: bookUrl,
          sourceId: src.id,
          sourceName: src.name
        });
      } catch (e) {
        if (criticalError(e)) throw e;
        // 单条解析失败就跳过这条，不影响整页
        ruleErrs++;
        if (!firstRuleErr) firstRuleErr = e;
      }
    }
    if (ctx.diagnostics && ctx.diagnostics.length) diag.traces = ctx.diagnostics;
    // 有节点但一条都没产出：每条都是规则抛错 → RULE；否则是字段全空 → EMPTY_FIELDS
    if (!out.length) {
      if (ruleErrs === items.length) {
        throw mkErr('RULE', '搜索规则执行出错：' + ((firstRuleErr && firstRuleErr.message) || firstRuleErr),
          Object.assign({ cause: firstRuleErr }, diag));
      }
      throw mkErr('EMPTY_FIELDS', '没有解析到搜索结果（有 ' + nodeCount + ' 个节点，但书名/链接全空）', diag);
    }
    attachDiag(out, diag);
    return out;
  }

  /* ------------------------------------------------------------ 发现 */
  /*
   * exploreUrl 支持：
   *   1. 纯 URL：/rank/{{page}}.html
   *   2. 分类名::URL，多行或 && 分隔：玄幻::/x/{{page}}&&都市::/y/{{page}}
   *   3. JSON 数组：[ { "title":"玄幻", "url":"/x/{{page}}" } ]
   * 动态生成地址（@js: / <js>）没有稳定的「第一个分类」，明确报 UNSUPPORTED，交给上层判 unknown。
   */
  function exploreEntries(raw) {
    var arr = raw;
    if (Array.isArray(arr)) {
      // 下面统一处理
    } else {
      var text = String(raw == null ? '' : raw).trim();
      if (!text) return [];
      if (/^\s*\[/.test(text)) {
        try { arr = JSON.parse(text); }
        catch (e) { throw mkErr('UNSUPPORTED', '发现地址（exploreUrl）的 JSON 数组解析失败：' + e.message); }
        if (!Array.isArray(arr)) throw mkErr('UNSUPPORTED', '发现地址（exploreUrl）JSON 必须是数组');
      } else {
        // Legado 分类列表常用换行或 &&；过滤「父分组::」这种没有 URL 的标题行
        arr = text.split(/\r?\n|&&/).map(function (part) {
          part = String(part || '').trim();
          var p = part.indexOf('::');
          return p >= 0
            ? { title: part.substring(0, p).trim(), url: part.substring(p + 2).trim() }
            : { title: '', url: part };
        });
      }
    }

    var out = [];
    (arr || []).forEach(function (x) {
      if (typeof x === 'string') {
        var p = x.indexOf('::');
        out.push(p >= 0 ? { title: x.substring(0, p).trim(), url: x.substring(p + 2).trim() } : { title: '', url: x.trim() });
      } else if (x && typeof x === 'object') {
        out.push({ title: String(x.title || x.name || '').trim(), url: String(x.url || '').trim() });
      }
    });
    out = out.filter(function (x) { return !!x.url; });
    if (!out.length) throw mkErr('UNSUPPORTED', '没有解析到可用的发现地址（exploreUrl 支持纯 URL、分类名::URL、[{title,url}]）');
    for (var i = 0; i < out.length; i++) {
      if (/@js\s*:|<js>[\s\S]*<\/js>/i.test(out[i].url)) {
        throw mkErr('UNSUPPORTED', '暂不支持用 @js:/<js> 动态生成发现地址；请改成纯 URL、分类名::URL 或 [{title,url}]');
      }
    }
    return out;
  }

  function nonEmptyRule(r) {
    return r && typeof r === 'object' && Object.keys(r).some(function (k) { return r[k] != null && r[k] !== ''; });
  }

  async function explore(src, opts) {
    opts = opts || {};
    need(src.exploreUrl, '这个书源没有配置发现地址（exploreUrl）');
    var entries = exploreEntries(src.exploreUrl);
    var ownExplore = nonEmptyRule(src.ruleExplore) && !!(src.ruleExplore.bookList || src.ruleExplore.list);
    var rules = ownExplore ? src.ruleExplore : src.ruleSearch;
    var listRule = rules && (rules.bookList || rules.list);
    need(listRule, '这个书源没有配置发现/搜索列表规则（ruleExplore.bookList / ruleSearch.bookList）');

    // 显式 URL 只执行完全匹配的分类；未声明时不回退到默认第一分类。
    if (opts.url !== undefined) {
      var selected = null;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].url === opts.url) { selected = entries[i]; break; }
      }
      if (!selected) throw mkErr('NO_RULE', '发现分类地址未在 exploreUrl 中声明：' + opts.url);
      return exploreOne(src, selected, rules, listRule, ownExplore, true);
    }

    // 默认只取第一个分类第 1 页；opts.maxTries>1 时前一个分类失败再试下一个（网络类错误不换，直接抛）
    var tries = Math.max(1, Math.min(entries.length, Number(opts.maxTries) || 1));
    var lastErr = null;
    for (var t = 0; t < tries; t++) {
      try { return await exploreOne(src, entries[t], rules, listRule, ownExplore); }
      catch (e) {
        lastErr = e;
        if (e && (e.code === 'NET' || e.code === 'HTTP')) break;
      }
    }
    throw lastErr;
  }

  async function exploreOne(src, ent, rules, listRule, ownExplore, allowEmpty) {
    var vars = { key: '', page: 1, baseUrl: src.url };
    var usedRes = null, usedCtx = null, nodeCount = 0;
    async function parseExplore(res) {
      var kind = await scope(listRule);
      var ctx = { baseUrl: res.url, key: '', page: 1, source: src, diagnostics: [] };
      var its;
      if (kind === 'json') {
        var json = jsonOf(res);
        ctx.json = json; ctx.value = json;
        its = await R.list(listRule, ctx);
      } else {
        ctx.html = res.text; ctx.doc = docOf(res);
        its = await R.list(listRule, ctx);
      }
      usedRes = res; usedCtx = ctx;
      its = flatten(its || []);
      nodeCount = its.length;
      return its;
    }

    var got = await fetchWithUa(src, ent.url, vars, parseExplore, allowEmpty);
    var items = got.out || [];
    var res = usedRes || got.res;
    var ctx = usedCtx || { baseUrl: (res && res.url) || '', key: '', page: 1, source: src };
    var diag = diagOf(res, nodeCount);
    diag.category = ent.title || '';
    diag.ruleFrom = ownExplore ? 'ruleExplore' : 'ruleSearch';
    if (!items.length) {
      if (allowEmpty) return attachDiag([], diag);
      throw mkErr('NO_NODES', '发现页没有解析到书目节点（规则可能失效）', diag);
    }

    var out = [], ruleErrs = 0, firstRuleErr = null;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var sctx = Object.assign({}, ctx, { key: '', page: 1 });
      if (item && typeof item === 'object' && !item.nodeType) { sctx.value = item; sctx.node = null; }
      else { sctx.node = item; sctx.value = undefined; }
      try {
        var target = sctx.node || sctx.value;
        var label = ownExplore ? 'ruleExplore' : 'ruleSearch';
        var title = await R.derive(target, rules.name || '@text', sctx);
        var bookUrl = await R.derive(target, rules.bookUrl || 'a@href', Object.assign({}, sctx, { baseUrl: res.url }));
        bookUrl = resolveRuleUrl(bookUrl, res.url);   // r2：保留 ,{...} 选项后缀
        if (!title || !bookUrl) continue;
        // 封面/简介/最新章节：和 search 走同一套字段规则；封面是相对地址时必须解析成绝对地址，
        // 否则上层拿到的 coverUrl 无法取图，书城整屏都是占位块。
        var coverUrl = await safe(target, rules.coverUrl, sctx, label + '.coverUrl', 'explore-field');
        out.push({
          title: title,
          author: await safe(target, rules.author, sctx, label + '.author', 'explore-field'),
          intro: await safe(target, rules.intro, sctx, label + '.intro', 'explore-field'),
          lastChapter: await safe(target, rules.lastChapter, sctx, label + '.lastChapter', 'explore-field'),
          coverUrl: coverUrl ? R.resolveUrl(coverUrl, res.url) : '',
          bookUrl: bookUrl
        });
      } catch (e) {
        if (criticalError(e)) throw e;
        ruleErrs++;
        if (!firstRuleErr) firstRuleErr = e;
      }
    }
    if (ctx.diagnostics && ctx.diagnostics.length) diag.traces = ctx.diagnostics;
    if (!out.length) {
      if (ruleErrs === items.length) {
        throw mkErr('RULE', '发现规则执行出错：' + ((firstRuleErr && firstRuleErr.message) || firstRuleErr),
          Object.assign({ cause: firstRuleErr }, diag));
      }
      throw mkErr('EMPTY_FIELDS', '发现页有 ' + nodeCount + ' 个节点，但书名/链接全空', diag);
    }
    attachDiag(out, diag);
    return out;
  }

  /* ------------------------------------------------------------ 详情 */
  /* r3：ruleBookInfo.init —— 详情页预处理（REPORT.md 第 3 项，影响 58 个源）。
   * Legado 里 init 先把详情页「收窄 / 换形」：JSON 接口最常见 `init:"$.data"`
   * （外层包着 code/msg，真正的书信息在 data 里），HTML 站常见 `init:"#info"`（只留信息块）。
   *
   * 不实现 init 的后果比「详情字段取空」严重得多：tocUrl 是在**原页面**上算的，
   * 外层 JSON 里根本没有那个字段 → 算不出来 → 回退成当前页 → 目录页取到错地址
   * → EMPTY_TOC → 整本被判 dead。所以 init 必须在取任何字段之前先跑。
   *
   * 求值一律走 R.list，不走 R.apply：evalList 对 JSON / 节点 / 字符串结果都保留原类型
   * （rule.js:1247-1266），而 R.apply 走 evalString 收尾的 strOf，对象会被打成
   * "[object Object]"（实测 init:"$.data" 经 apply 返回的正是这个串，后续字段全空）。
   * 唯一例外是 {{…}} 模板：evalList 没有 evalString 那条 isTemplateBlock 短路，
   * 插值结果会被当成选择器再求一次 → 0 命中返回 []；所以 list 空时回退 R.apply，
   * 让模板拿到插值后的字符串。两条路都试完仍为空 = init 本身没选中东西，保持原 ctx。
   *
   * 以 `:` 开头是 AllInOne 正则形式，本轮明确不支持（rule.js 里没有这个 mode，
   * 丢进去会被当 CSS 选择器抛「CSS 选择器语法错误」）：跳过预处理、只记诊断，不抛错。
   * init 自己求值抛错也不许让 detail 失败——回退到未预处理的 ctx 继续取字段。
   */
  async function applyBookInfoInit(ctx, initRule) {
    var raw = String(initRule == null ? '' : initRule).trim();
    if (!raw) return { used: false, note: '' };
    if (/^:/.test(raw)) {
      return {
        used: false,
        note: 'ruleBookInfo.init 是 AllInOne 正则形式（以 : 开头），本轮未实现，已跳过预处理'
      };
    }

    var val = null;
    try {
      var ls = await R.list(raw, ctx);
      if (ls && ls.length) val = ls[0];
      else val = await R.apply(raw, ctx);          // {{…}} 模板等 list 取不到的形态
    } catch (e) {
      if (criticalError(e)) throw e;
      noteTraceError(ctx, 'ruleBookInfo.init', e, 'detail-init', 'fallback');
      return {
        used: false,
        note: 'ruleBookInfo.init 求值失败（' + (e && e.code || e && e.name || 'Error') + '），已回退到未预处理的详情页'
      };
    }
    if (val == null || val === '') return { used: false, note: '' };

    /* 用 init 的结果替换上下文。三种形态各自对应 contentOf 的取法：
     * 节点 → ctx.node；对象 → ctx.value（isJsonDoc 会把无前缀规则升级成 JSON 模式，
     * 所以 $.book_name 和裸 book_name 都能取到）；字符串 → ctx.value，
     * 看着像 JSON 就顺手解析一份，否则按 HTML 文本交给 parseHtml。 */
    var next = Object.assign({}, ctx);
    delete next.node; delete next.doc; delete next.html; delete next.json; delete next.value;
    // isJsonDoc 按「原始内容引用」缓存结果，换了内容必须把缓存一起作废，
    // 否则对象 init 之后仍沿用旧页面算出来的 isJSON 判定
    delete next.__isJsonRef; delete next.__isJsonDoc;
    if (val.nodeType) {
      next.node = val;
    } else if (typeof val === 'object') {
      next.value = val; next.json = val;
    } else {
      var s = String(val);
      next.value = s;
      if (/^\s*[{[]/.test(s)) {
        try { next.json = JSON.parse(s); } catch (e2) { /* 不是合法 JSON 就当普通文本 */ }
      }
    }
    return { used: true, ctx: next, note: '' };
  }

  /* 诊断信息挂在不可枚举属性上：不进 JSON 序列化（A/B 对比、界面渲染都不受影响），
   * 但调试时 info.__diag.initNote 仍可读。写法与 legacy-js.js 的 __diag 一致。 */
  function noteInitDiag(info, note, ctx) {
    if (!note && (!ctx || !ctx.diagnostics || !ctx.diagnostics.length)) return;
    if (note && global.console) console.warn('[书源] ' + note);
    try {
      var d = info.__diag || {};
      d.initNote = note || '';
      if (ctx && ctx.diagnostics && ctx.diagnostics.length) d.traces = ctx.diagnostics;
      Object.defineProperty(info, '__diag', { value: d, enumerable: false, configurable: true, writable: true });
    } catch (e) { /* 挂不上就算了，不影响取字段 */ }
  }

  async function detail(src, bookUrl) {
    var res = await fetchPage(src, bookUrl, { baseUrl: src.url });
    var kind = await scope(src.ruleBookInfo.name || src.ruleBookInfo.intro);
    var ctx = { baseUrl: res.url, source: src, diagnostics: [] };

    var info = { title: '', author: '', intro: '', coverUrl: '', tocUrl: '', lastChapter: '', wordCount: '' };
    if (kind === 'json') {
      var json = jsonOf(res);
      ctx.json = json; ctx.value = json;
    } else {
      ctx.html = res.text; ctx.doc = docOf(res);
    }

    // r3：init 预处理必须排在所有详情字段之前，tocUrl 也要在处理过的上下文上算。
    // origDoc 留着：init 换成节点/JSON 上下文后 ctx.doc 就没了，但兜底书名仍应回到
    // 原始页面的 <title> 上找（那是整页唯一可靠的书名来源）
    var initNote = '';
    var origDoc = ctx.doc;
    if (src.ruleBookInfo.init) {
      var ir = await applyBookInfoInit(ctx, src.ruleBookInfo.init);
      initNote = ir.note || '';
      if (ir.used && ir.ctx) ctx = ir.ctx;
    }

    info.title = await safe(ctx.value !== undefined ? ctx.value : undefined, src.ruleBookInfo.name, ctx, 'ruleBookInfo.name', 'detail-field');
    info.author = await safe(ctx.value !== undefined ? ctx.value : undefined, src.ruleBookInfo.author, ctx, 'ruleBookInfo.author', 'detail-field');
    info.intro = await safe(ctx.value !== undefined ? ctx.value : undefined, src.ruleBookInfo.intro, ctx, 'ruleBookInfo.intro', 'detail-field');
    info.coverUrl = await safe(ctx.value !== undefined ? ctx.value : undefined, src.ruleBookInfo.coverUrl, ctx, 'ruleBookInfo.coverUrl', 'detail-field');
    // 规则常给相对地址（/uploads/x.jpg），补成绝对地址，否则封面取不到
    if (info.coverUrl) info.coverUrl = R.resolveUrl(info.coverUrl, res.url);
    info.lastChapter = await safe(ctx.value !== undefined ? ctx.value : undefined, src.ruleBookInfo.lastChapter, ctx, 'ruleBookInfo.lastChapter', 'detail-field');
    info.wordCount = await safe(ctx.value !== undefined ? ctx.value : undefined, src.ruleBookInfo.wordCount, ctx, 'ruleBookInfo.wordCount', 'detail-field');
    var tocRule = src.ruleBookInfo.tocUrl;
    var tocGot = tocRule ? await safe(undefined, tocRule, ctx, 'ruleBookInfo.tocUrl', 'detail-field') : '';
    // 规则可能返回「查看目录」这种文字；不是链接就退回当前页
    info.tocUrl = tocGot && /^https?:\/\//i.test(String(tocGot)) ? String(tocGot)
      : (tocGot ? resolveRuleUrl(tocGot, res.url) : res.url);   // r2：保留 ,{...} 选项后缀
    if (tocGot && !/^https?:\/\//i.test(String(tocGot)) && !/[\/.]/.test(String(tocGot))) {
      info.tocUrl = res.url;
    }
    if (!info.title) {
      var t = origDoc && origDoc.querySelector('title');
      info.title = t ? String(t.textContent || '').trim() : '';
    }
    info.pageUrl = res.url;
    noteInitDiag(info, initNote, ctx);   // r3：init 诊断（AllInOne 跳过 / 求值失败回退）挂到 __diag，不进 JSON
    return info;
  }

  function pageUrlKey(raw, base) {
    var s = String(raw == null ? '' : raw);
    var m = RE_RULE_URL_OPTIONS.exec(s);
    if (m) s = s.substring(0, m.index);
    try {
      var parsed = new URL(s, base || undefined);
      if (/^(data:|javascript:|mailto:|file:)$/i.test(parsed.protocol)) return '';
      parsed.hash = '';
      return parsed.href;
    } catch (e) { return ''; }
  }

  function contentContext(src, chapters) {
    if (!Array.isArray(chapters) || !chapters.length || chapters.length > 4096) return { available: false, chapterUrls: [] };
    var urls = [], seen = Object.create(null), size = 0;
    for (var i = 0; i < chapters.length; i++) {
      var raw = chapters[i] && typeof chapters[i] === 'object' ? chapters[i].url : chapters[i];
      if (typeof raw !== 'string' || !raw || raw.length > 2048) return { available: false, chapterUrls: [] };
      var key = pageUrlKey(raw, src.url);
      if (!key) return { available: false, chapterUrls: [] };
      if (seen[key]) continue;
      seen[key] = true;
      urls.push(raw);
      size += raw.length;
      if (size > 2 * 1024 * 1024) return { available: false, chapterUrls: [] };
    }
    return { available: true, chapterUrls: urls };
  }

  async function nextPageUrls(rule, ctx, base) {
    if (!rule) return [];
    var value = Array.isArray(rule) || /<js>|@js:/i.test(String(rule)) ? await R.list(rule, ctx) : await R.apply(rule, ctx);
    var items = Array.isArray(value) ? value : String(value == null ? '' : value).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item && item.nodeType) item = await R.derive(item, item.getAttribute && item.getAttribute('href') ? '@href' : '@text', Object.assign({}, ctx, { node: item, value: undefined }));
      if (item == null || typeof item === 'object') continue;
      var url = resolveRuleUrl(R.squash(item), base);
      if (url) out.push(url);
    }
    return out;
  }

  /* ------------------------------------------------------------ 目录 */
  async function catalog(src, bookUrl, info) {
    info = info || {};
    var listRule = src.ruleToc.chapterList || src.ruleToc.list;
    need(listRule, '这个书源没有配置目录规则（ruleToc.chapterList）');

    var chapters = [];
    var visited = Object.create(null);
    var pages = 0;
    var MAX_PAGES = src.maxTocPages || 20;
    var lastDoc = null, lastPageUrl = '';
    var tocErr = null, tocRes = null, tocNodes = 0, tocTraces = [];
    var stoppedBy = 'end';

    // 目录可能分页：跟着 ruleToc.nextTocUrl 一页页翻（最多 20 页）
    async function readToc(startUrl) {
      var pageUrl = startUrl;
      while (pageUrl) {
        var pageKey = pageUrlKey(pageUrl, lastPageUrl || firstUrl || bookUrl || src.url);
        if (visited[pageKey]) { stoppedBy = 'loop'; break; }
        if (pages >= MAX_PAGES) { stoppedBy = 'cap'; break; }
        visited[pageKey] = 1;
        var usedRes = null, usedCtx = null;
        async function parseToc(res) {
          var kind = await scope(listRule);
          var ctx = { baseUrl: res.url, source: src, diagnostics: tocTraces };
          var its;
          if (kind === 'json') {
            var json = jsonOf(res);
            ctx.json = json; ctx.value = json;
            its = await R.list(listRule, ctx);
          } else {
            ctx.html = res.text; ctx.doc = docOf(res);
            its = await R.list(listRule, ctx);
          }
          usedRes = res; usedCtx = ctx;
          if (ctx.doc) { lastDoc = ctx.doc; lastPageUrl = res.url; }
          return flatten(its || []);
        }
        var got = await fetchWithUa(src, pageUrl, { baseUrl: src.url }, parseToc).catch(function (e) {
          if (criticalError(e)) throw e;
          tocErr = e;
          noteTraceError({ diagnostics: tocTraces }, 'ruleToc.chapterList', e, 'catalog', 'rule');
          return { res: null, out: [] };
        });
        var res = usedRes || got.res;
        var ctx = usedCtx;
        var items = got.out || [];
        pages++;
        if (!res || !ctx) { stoppedBy = 'error'; break; }
        tocRes = res;
        tocNodes += items.length;

        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var sctx = Object.assign({}, ctx);
          if (item && typeof item === 'object' && !item.nodeType) { sctx.value = item; sctx.node = null; }
          else { sctx.node = item; sctx.value = undefined; }

          try {
            var t = await safe(sctx.node || sctx.value, src.ruleToc.chapterName || '@text', sctx, 'ruleToc.chapterName', 'catalog-field');
            var u = await safe(sctx.node || sctx.value, src.ruleToc.chapterUrl || 'a@href',
              Object.assign({}, sctx, { baseUrl: res.url }), 'ruleToc.chapterUrl', 'catalog-field');
            if (!u) continue;
            chapters.push({ t: t || ('第 ' + (chapters.length + 1) + ' 章'), url: resolveRuleUrl(u, res.url) });
          } catch (e) {
            if (criticalError(e)) throw e;
            // 单个章节解析失败跳过
          }
        }

        var nextRule = src.ruleToc.nextTocUrl;
        if (!nextRule) break;
        var candidates;
        try { candidates = await nextPageUrls(nextRule, ctx, res.url); }
        catch (e) {
          if (criticalError(e)) throw e;
          tocErr = e;
          noteTraceError(ctx, 'ruleToc.nextTocUrl', e, 'pagination', 'partial');
          stoppedBy = 'error';
          break;
        }
        if (!candidates.length) break;
        pageUrl = candidates[0];
      }
    }

    var firstUrl = info.tocUrl || bookUrl;
    await readToc(firstUrl);
    // 目录页取不到东西时，回书目页再试一次（很多源的 tocUrl 规则其实指错了）
    if (!chapters.length && bookUrl && bookUrl !== firstUrl) {
      pages = 0;
      await readToc(bookUrl).catch(function (e) { if (criticalError(e)) throw e; });
    }
    // 还是没有：按常见目录结构猜一遍
    if (!chapters.length) {
      chapters = guessChapters(lastDoc, lastPageUrl || firstUrl);
      if (chapters.length) noteTrace({ diagnostics: tocTraces }, { facet: 'catalog-fallback', field: 'ruleToc.chapterList', code: 'GUESS', source: 'guess' });
    }

    if (!chapters.length) {
      // 页面没取到（NET/HTTP）也归到 EMPTY_TOC 下，原因放 cause，http/url 拿得到就带上
      var td = tocRes ? diagOf(tocRes, tocNodes) : {
        http: tocErr && tocErr.http, url: (tocErr && tocErr.url) || firstUrl, nodes: 0, bodyLen: tocErr && tocErr.bodyLen
      };
      throw mkErr('EMPTY_TOC', '目录为空（规则可能失效）', Object.assign({ cause: tocErr || undefined }, td));
    }
    // 去掉「最新章节」置顶造成的重复
    var seen = {}, uniq = [];
    chapters.forEach(function (c) {
      if (seen[c.url]) return;
      seen[c.url] = 1;
      uniq.push(c);
    });
    // 站点目录是「新→旧」倒序时（ruleToc.reverse / reverseChapters），翻成正序再交给阅读器
    if (src.reverseChapters) uniq.reverse();
    return attachDiag({ title: info.title || '', author: info.author || '', intro: info.intro || '', chapters: uniq }, {
      http: tocRes && tocRes.status,
      url: tocRes && tocRes.url,
      nodes: tocNodes,
      traces: tocTraces,
      pagination: { pages: pages, complete: stoppedBy === 'end', stoppedBy: stoppedBy }
    });
  }

  /* ------------------------------------------------------------ 兜底猜测
   * 配置的规则没解析出东西时，按常见站点的结构再试几个「大路货」选择器。
   * 只有明显像目录/正文才采用，避免抓到导航文字。 */
  var TOC_GUESS = ['#list dd a', '.listmain dd a', '#chapter-list a', '.chapter-list a',
    '#list a', '.list a', '.dirlist a', '#catalog a', '.catalog a'];
  var TEXT_GUESS = ['#content', '#chaptercontent', '#chapter-content', '.content', '.read-content',
    '.txt_tcontent', '#txtContent', '.article-content', 'article', '#nr', '.text'];

  function guessChapters(doc, baseUrl) {
    if (!doc) return [];
    for (var i = 0; i < TOC_GUESS.length; i++) {
      var nodes;
      try { nodes = doc.querySelectorAll(TOC_GUESS[i]); } catch (e) { continue; }
      if (!nodes || nodes.length < 5) continue;
      var out = [];
      for (var k = 0; k < nodes.length; k++) {
        var a = nodes[k];
        var href = a.getAttribute && (a.getAttribute('href') || '');
        if (!href) continue;
        out.push({ t: norm(a.textContent) || ('第 ' + (out.length + 1) + ' 章'), url: R.resolveUrl(href, baseUrl) });
      }
      if (out.length >= 5) return out;
    }
    return [];
  }

  function norm(s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/gm, '').trim();
  }

  function guessText(doc) {
    if (!doc) return '';
    var best = '';
    for (var i = 0; i < TEXT_GUESS.length; i++) {
      var n;
      try { n = doc.querySelector(TEXT_GUESS[i]); } catch (e) { continue; }
      if (!n) continue;
      var t = R.domToText(n);
      if (t.length > best.length) best = t;
    }
    return best.length >= 200 ? best : '';
  }

  /* ------------------------------------------------------------ 正文 */
  async function content(src, chapter, pagination) {
    var rule = src.ruleContent.content || src.ruleContent.text;
    need(rule, '这个书源没有配置正文规则（ruleContent.content）');

    var parts = [], visited = Object.create(null), boundary = Object.create(null);
    var available = !!(pagination && Array.isArray(pagination.chapterUrls));
    var currentKey = pageUrlKey(chapter.url, src.url);
    (available ? pagination.chapterUrls : []).forEach(function (url) {
      var key = pageUrlKey(url, src.url);
      if (key && key !== currentKey) boundary[key] = true;
    });
    var pages = 0, MAX_PAGES = 10, lastDoc = null, lastRes = null;
    var pageErr = null, ruleErr = null, stoppedBy = 'end', filteredBoundary = 0, contentTraces = [];

    async function fetchOne(url) {
      var usedRes = null, usedCtx = null;
      async function parseContent(res) {
        var kind = await scope(rule);
        var ctx = { baseUrl: res.url, source: src, chapter: chapter, diagnostics: contentTraces };
        if (kind === 'json') {
          var json = jsonOf(res);
          ctx.json = json; ctx.value = json;
        } else {
          ctx.html = res.text; ctx.doc = docOf(res);
        }
        usedRes = res; usedCtx = ctx;
        if (ctx.doc) lastDoc = ctx.doc;
        var t = await R.contentText(rule, ctx).catch(function (e) {
          if (criticalError(e)) throw e;
          ruleErr = e;
          noteTraceError(ctx, 'ruleContent.content', e, 'content-field', 'rule');
          return '';
        });
        if (ctx.contentError && !ruleErr) {
          ruleErr = ctx.contentError;
          noteTraceError(ctx, 'ruleContent.content', ctx.contentError, 'content-field', 'rule');
        }
        if (!t) noteTrace(ctx, { facet: 'content-field', field: 'ruleContent.content', code: 'MISS', segmentIndex: 0, segmentKind: 'group' });
        else if (src.__trace) noteTrace(ctx, { facet: 'content-field', field: 'ruleContent.content', code: 'OK', segmentIndex: 0, segmentKind: 'group' });
        return t || '';
      }
      pages++;
      visited[pageUrlKey(url, src.url)] = true;
      var got = await fetchWithUa(src, url, { baseUrl: src.url }, parseContent).catch(async function (e) {
        var mediaRule = /^\s*(@js:|<js>)/i.test(String(rule));
        var mediaUrl = /\.(mp4|m4v|webm|mkv|mov|m3u8|mp3|m4a|aac|flac|ogg)(\?|#|$)/i.test(url);
        if (!(mediaRule && mediaUrl) && criticalError(e)) throw e;
        // 视频/音频源常见形态：@js 规则只需要 baseUrl 拼出媒体地址，而 chapter.url 本身就是
        // 媒体文件（fetch 二进制会被字符集解码拦下）。这种情况下不把整章判死，带着空正文
        // 继续跑规则，让规则自己产出 URL。
        var mediaLike = /\.(mp4|m4v|webm|mkv|mov|m3u8|mp3|m4a|aac|flac|ogg)(\?|#|$)/i.test(url);
        if (mediaLike && /^\s*(@js:|<js>)/i.test(String(rule))) {
          var fake = { url: url, text: '', headers: {}, status: 0, ok: false };
          var out2 = await parseContent(fake);
          return { res: fake, out: out2 };
        }
        pageErr = e;
        noteTraceError({ diagnostics: contentTraces }, 'ruleContent.nextContentUrl', e, 'pagination', 'partial');
        stoppedBy = 'error';
        return { res: null, out: '' };
      });
      var res = usedRes || got.res;
      if (!res || !usedCtx) return null;
      lastRes = res;
      if (got.out) parts.push(got.out);
      return { res: res, ctx: usedCtx };
    }

    var url = chapter.url;
    while (url) {
      var key = pageUrlKey(url, src.url);
      if (visited[key]) { stoppedBy = 'loop'; break; }
      if (pages >= MAX_PAGES) { stoppedBy = 'cap'; break; }
      var current = await fetchOne(url);
      if (!current) break;
      var nextRule = src.ruleContent.nextContentUrl;
      if (!nextRule) break;
      var candidates;
      try { candidates = await nextPageUrls(nextRule, current.ctx, current.res.url); }
      catch (e) {
        if (criticalError(e)) throw e;
        ruleErr = e;
        noteTraceError(current.ctx, 'ruleContent.nextContentUrl', e, 'pagination', 'partial');
        stoppedBy = 'error';
        break;
      }
      var allowed = [], seen = Object.create(null);
      for (var i = 0; i < candidates.length; i++) {
        var candidateKey = pageUrlKey(candidates[i], current.res.url);
        if (boundary[candidateKey]) { filteredBoundary++; continue; }
        if (!candidateKey || seen[candidateKey]) continue;
        seen[candidateKey] = true;
        allowed.push(candidates[i]);
      }
      if (!allowed.length) {
        if (filteredBoundary) stoppedBy = 'chapter-boundary';
        else if (candidates.length) stoppedBy = 'loop';
        break;
      }
      if (allowed.length === 1) { url = allowed[0]; continue; }
      url = '';
      for (var j = 0; j < allowed.length; j++) {
        var branchKey = pageUrlKey(allowed[j], current.res.url);
        if (visited[branchKey]) { stoppedBy = 'loop'; break; }
        if (pages >= MAX_PAGES) { stoppedBy = 'cap'; break; }
        if (!await fetchOne(allowed[j])) break;
      }
    }
    if (filteredBoundary && stoppedBy === 'end') stoppedBy = 'chapter-boundary';

    var text = parts.join('\n');
    if ((!text || text.length < 10) && lastDoc) {
      var guessed = guessText(lastDoc);
      if (guessed) {
        text = guessed;
        noteTrace({ diagnostics: contentTraces }, { facet: 'content-fallback', field: 'ruleContent.content', code: 'GUESS', source: 'guess' });
      }
    }
    if (!text || text.length < 10) {
      var cause = pageErr || ruleErr || undefined;
      var cd = lastRes ? diagOf(lastRes) : {
        http: pageErr && pageErr.http, url: (pageErr && pageErr.url) || chapter.url, bodyLen: pageErr && pageErr.bodyLen
      };
      delete cd.nodes;
      throw mkErr('EMPTY_CONTENT', '正文为空（规则可能失效）', Object.assign({ cause: cause, textLen: (text || '').length, guessLen: lastDoc ? guessText(lastDoc).length : 0, traces: contentTraces }, cd));
    }
    return attachDiag({ t: chapter.t || '', text: text.replace(/\n{3,}/g, '\n\n') }, {
      traces: contentTraces,
      pagination: {
        pages: pages,
        complete: stoppedBy === 'end',
        stoppedBy: stoppedBy,
        boundaryCheck: available ? 'available' : 'unavailable',
        filteredBoundary: filteredBoundary,
        failedUrl: stoppedBy === 'error' && pageErr ? pageErr.url : undefined
      }
    });
  }

  /* ------------------------------------------------------------ 探测书源 */
  async function test(src, keyword) {
    var out = { ok: false, name: src.name };
    try {
      var list = await search(src, keyword, 1);
      out.ok = !!list.length;
      out.count = list.length;
      out.sample = list[0] ? (list[0].title + (list[0].author ? ' / ' + list[0].author : '')) : '';
      if (!out.ok) out.error = '搜不到结果';
      return out;
    } catch (e) {
      out.error = (e && e.message) || '未知错误';
      if (e && e.code) out.code = e.code;
      return out;
    }
  }

  /* 漫画图片解密（Legado ruleContent.imageDecode）：在规则 worker 里跑书源自带的解密脚本。
     b64 = 密文图片字节的 base64，code = imageDecode 脚本；返回解密后图片字节的 base64。
     说明：UI 页面本身不加载 legacy-js.js（书源任务都在 worker 里跑），所以解密只能在 worker 里做。 */
  async function decodeImageBytes(b64, code) {
    if (!code) throw mkErr('RULE', '这个书源没有配置 ruleContent.imageDecode');
    var LEGACY = global.NR && global.NR.legacyJs;
    if (!LEGACY || typeof LEGACY.run !== 'function') throw mkErr('RULE', 'JS 执行器不可用，无法解密图片');
    var bin = atob(String(b64 || ''));
    var raw = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    if (!raw.length) throw mkErr('RULE', '图片字节是空的');
    // 注意：Legado 的 imageDecode 里 result 既可能是 byte[] 也可能是 base64 串。
    // 我们的 legacy-js 会把入参序列化一遍，Uint8Array 到不了脚本里（会被当字符串），
    // 所以统一传 base64 串——hutool 的 decrypt(String) 本来也是按 base64 解，语义一致。
    var out = LEGACY.run(code, { result: String(b64 || ''), baseUrl: '', key: '', page: 1, args: {}, book: {} });
    var bytes = out;
    if (bytes && typeof bytes.length !== 'number') {
      var ks = Object.keys(bytes);
      bytes = ks.map(function (k) { return bytes[k]; });
    }
    if (!bytes || !bytes.length) throw mkErr('RULE', '解密结果是空的');
    var arr = new Uint8Array(bytes.length);
    for (var j = 0; j < bytes.length; j++) {
      var x = bytes[j];
      arr[j] = (x && typeof x.getByteValue === 'function') ? (x.getByteValue() & 0xff) : (Number(x) & 0xff);
    }
    var s = '', CH = 0x8000;
    for (var k = 0; k < arr.length; k += CH) {
      s += String.fromCharCode.apply(null, Array.prototype.slice.call(arr, k, k + CH));
    }
    return btoa(s);
  }

  global.NR = global.NR || {};
  global.NR.legado = {
    normalize: normalize,
    contentContext: contentContext,
    pageUrlKey: pageUrlKey,
    search: search,
    exploreEntries: exploreEntries,
    explore: explore,
    detail: detail,
    catalog: catalog,
    content: content,
    test: test,
    fetchPage: fetchPage,
    decodeImageBytes: decodeImageBytes
  };
})(window);
