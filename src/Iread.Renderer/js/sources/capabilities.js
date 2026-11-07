(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var matrix = [
    { id: 'css', label: 'CSS 规则', status: 'supported', reason: '支持当前规则引擎的 CSS 选择、取值和组合规则；边界是已实现语法，不等于完整 JSoup。' },
    { id: 'xpath', label: 'XPath 规则', status: 'supported', reason: '支持浏览器 XPath 求值范围内的规则；边界是浏览器实现，不保证所有 JVM XPath 扩展。' },
    { id: 'json', label: 'JSON / JSONPath 规则', status: 'supported', reason: '支持当前引擎已实现的 JSONPath 子集；不保证任意 JSONPath 方言。' },
    { id: 'js', label: 'JavaScript 规则', status: 'supported', reason: '支持隔离书源进程中的 JS 规则、表达式和 jsLib；边界不包含完整 Rhino、JVM、Android 或浏览器交互 API。' },
    { id: 'jsoup', label: 'JSoup 门面', status: 'partial', reason: '仅实现浏览器 DOM 上的部分 JSoup 选择、文本和连接门面，不是完整 Java JSoup。' },
    { id: 'java', label: '纯 Java 门面', status: 'partial', reason: '仅兼容已实现的字符串、编码、摘要等纯计算及规则辅助 API；没有完整 JVM，未知成员需运行验证。' },
    { id: 'http-cookie', label: 'HTTP 会话 Cookie', status: 'supported', reason: '原生网络传输仅在隔离书源会话内自动携带 Cookie；不共享浏览器登录态，不代表规则 Cookie API 可用或跨会话持久化。' },
    { id: 'rule-cookie', label: '规则 Cookie API', status: 'unsupported', reason: 'cookie.* 及 java.getCookie/setCookie/removeCookie 未接入网络会话，调用会明确报 UNSUPPORTED；不影响 HTTP 自动携带 Cookie。' },
    { id: 'login-storage', label: '登录信息 / 请求头存储', status: 'partial', reason: '仅保存和读取书源会话中的登录信息与请求头，不执行登录，也不是登录 UI；已有请求头可能仍允许正常请求。' },
    { id: 'login-ui', label: '手动登录 / 登录 UI', status: 'unsupported', reason: '没有宿主登录窗口；source.login()、java.reLoginView() 和 loginUi 不能完成手动登录。' },
    { id: 'webview', label: 'WebView 请求', status: 'unsupported', reason: '没有规则可用的 WebView 交互环境；webView:true 或 java.webView 不能由普通 HTTP 请求替代。' },
    { id: 'browser', label: '打开浏览器', status: 'unsupported', reason: 'java.startBrowser/startBrowserAwait/startBrowserDp/showBrowser/open 无法打开或等待真实浏览器。' },
    { id: 'verification', label: '交互验证码', status: 'unsupported', reason: 'java.getVerificationCode 没有对应的宿主验证码窗口，不能完成交互验证。' },
    { id: 'persistent-cache', label: '持久缓存 API', status: 'unsupported', reason: 'cache.get/put/delete 未实现磁盘持久缓存，调用会明确报 UNSUPPORTED；与内存缓存不同。' },
    { id: 'memory-cache', label: '内存缓存 / 变量', status: 'supported', reason: 'cache.putMemory/getFromMemory/deleteMemory 与 source.put/get 在书源会话内有效；java.put/get 变量仅在一次规则调用内有效，不承诺磁盘持久化。' },
    { id: 'ui-refresh', label: '刷新发现页', status: 'partial', reason: 'java.refreshExplore/source.refreshExplore 仅保留无副作用空操作，不实际刷新 UI。' },
    { id: 'manga', label: '漫画书源', status: 'unverified', reason: '漫画规则和阅读链路未完成兼容性验证；不禁止执行，也不改动现有媒体实现。' },
    { id: 'audio', label: '音频书源', status: 'unverified', reason: '音频规则和播放链路未完成兼容性验证；不禁止执行，也不改动现有媒体实现。' },
    { id: 'dynamic-api', label: '动态 API 引用', status: 'unverified', reason: '发现计算属性 API 引用，静态启发式检查不能证明实际调用目标；需要运行验证，不禁止执行。' }
  ];
  var byId = Object.create(null);
  matrix.forEach(function (row) { byId[row.id] = row; });

  // 只给出能力提示，不执行脚本、不修改书源、不作为执行禁用条件。
  // normalize 不保留原始登录字段：导入时应先 assess(raw)，归一化后只能检查保留的内容。
  function assess(source) {
    var found = Object.create(null);
    var seen = new WeakSet();
    function add(id) { found[id] = true; }

    function inspectText(value) {
      var text = value;
      // URL 选项可能整体编码，JS 字符串内的 JSON 键可能带反斜线。
      if (/%[0-9a-f]{2}/i.test(text)) {
        try { text = decodeURIComponent(text); } catch (e) { /* 保留原文检查 */ }
      }
      text = text.replace(/\\+["']/g, function (quote) { return quote.slice(-1); });
      // 已知字符串下标视为普通成员；计算下标只标为未验证，不能静态猜测目标。
      text = text.replace(/\b([\w$]+)\s*\[\s*(['"])([\w$]+)\2\s*\]/g, '$1.$3');
      if (/(?:["']\s*webView\s*["']|\bwebView)\s*:\s*true\b/i.test(text)) add('webview');
      if (/\bjava\s*\.\s*webView\b/.test(text)) add('webview');
      if (/\bjava\s*\.\s*(?:startBrowser(?:Await|Dp)?|showBrowser|open)\b/.test(text)) add('browser');
      if (/\bjava\s*\.\s*getVerificationCode\b/.test(text)) add('verification');
      if (/\bsource\s*\.\s*login\s*\(/.test(text) || /\bjava\s*\.\s*reLoginView\b/.test(text)) add('login-ui');
      if (/\bcookie\s*\.\s*[\w$]+/.test(text)
        || /\b(?:java|this)\s*\.\s*(?:getCookie|setCookie|removeCookie)\b/.test(text)) add('rule-cookie');
      if (/\bcache\s*\.\s*(?:get|put|delete)\b/.test(text)) add('persistent-cache');
      if (/\b(?:source|java)\s*\.\s*(?:get|put|remove)Login(?:Info|Header)(?:Map)?\b/.test(text)) add('login-storage');
      if (/\b(?:java|source)\s*\.\s*refreshExplore\b/.test(text)) add('ui-refresh');
      if (/\b(?:org\s*\.\s*jsoup|Jsoup)\b/.test(text)) add('jsoup');
      if (/\b(?:java|javax|Packages)\s*\./.test(text)) add('java');
      if (/\b(?:java|source|cookie|cache)\s*\[/.test(text)) add('dynamic-api');
    }

    function visit(value) {
      if (typeof value === 'string') { inspectText(value); return; }
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      Object.keys(value).forEach(function (key) {
        var child = value[key];
        if (key.toLowerCase() === 'webview' && child === true) add('webview');
        if (/^(?:loginUrl|login|loginInfo|loginHeader)$/i.test(key) && child != null && child !== '') add('login-storage');
        if (/^loginUi$/i.test(key) && child != null && child !== '' && child !== false) add('login-ui');
        if (/^(?:bookSourceType|srcType)$/i.test(key)) {
          if (Number(child) === 2) add('manga');
          if (Number(child) === 1) add('audio');
        }
        visit(child);
      });
    }
    visit(source);
    return matrix.filter(function (row) { return found[row.id]; }).map(function (row) {
      return { id: row.id, label: row.label, status: row.status, reason: row.reason };
    });
  }

  function summary(source) {
    var names = { supported: '支持', partial: '部分支持', unsupported: '不支持', unverified: '未验证' };
    var rows = assess(source);
    var text = rows.length ? rows.map(function (row) {
      return row.label + '：' + names[row.status];
    }).join('；') : '未发现已知能力风险';
    return text + '（静态启发式检查，不保证完整兼容；提示不禁止执行）';
  }

  NR.sourceCapabilities = { matrix: matrix, assess: assess, summary: summary };
})(window);
