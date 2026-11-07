/* =========================================================================
 * sources/rule.js — 书源规则引擎
 * -------------------------------------------------------------------------
 * 这一版是照着开源阅读（Legado v3.26）的 AnalyzeRule / AnalyzeByJSoup /
 * AnalyzeUrl / RuleAnalyzer 移植的，尽量保持语义一致：
 *
 *   · 规则切分：<js></js> / @js: 单独成段；余下按 && || %% 平衡切分；
 *     每段按 @ 切成多级（逐级缩小范围），最后一级按关键字取值
 *   · 前缀：@CSS:（整条当 CSS）、@@（去掉前缀）、@XPath:、@Json:、$. / $[ / / 自动识别
 *   · 每级选择器：children / class.X / tag.X / id.X / text.X / 普通 CSS
 *   · 索引：tag.div.0（取第 0 个）、tag.div!0（排除）、tag.div[1,3:-1:2]（列表/区间）
 *   · 取值：text / textNodes / ownText / html / all / 其它一律当属性名
 *   · @put:{k:v} 存变量、@get:{k} 取变量、{{js}} 求值、$1 取正则分组
 *   · ##正则##替换###  （### 结尾表示只替换第一个匹配）
 * ========================================================================= */
(function (global) {
  'use strict';

  var Y = global.yedu;
  var NR = global.NR = global.NR || {};

  /* ------------------------------------------------------------ 基础工具 */
  function enc(s) { try { return encodeURIComponent(String(s)); } catch (e) { return String(s); } }

  function segmentError(error, code, index, kind) {
    if (error && typeof error === 'object') {
      if (code && !error.code) error.code = code;
      if (index !== undefined && error.segmentIndex === undefined) error.segmentIndex = index;
      if (kind && !error.segmentKind) error.segmentKind = kind;
    }
    return error;
  }

  function validateSelectorSyntax(selector) {
    var quote = '', round = 0, square = 0, comment = false;
    for (var i = 0; i < selector.length; i++) {
      var c = selector[i], next = selector[i + 1];
      if (comment) { if (c === '*' && next === '/') { comment = false; i++; } continue; }
      if (!quote && c === '/' && next === '*') { comment = true; i++; continue; }
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(') round++;
      else if (c === ')') round--;
      else if (c === '[') square++;
      else if (c === ']') square--;
      if (round < 0 || square < 0) break;
    }
    if (quote || round || square) throw segmentError(new Error('CSS 选择器语法错误'), 'SELECTOR');
  }

  function squash(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\v]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(/^ +| +$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function resolveUrl(v, base) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^(data:|javascript:|mailto:|file:)/i.test(s)) return '';
    try { return new URL(s, base || undefined).href; } catch (e) { return s; }
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(String(html || ''), 'text/html');
  }

  /* ------------------------------------------------------------ 文本提取（对齐 Element.text()） */
  function collapse(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function ownText(node) {
    if (!node || !node.childNodes) return '';
    var arr = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) arr.push(String(c.nodeValue));
    }
    // P：对齐 jsoup Element.ownText()——逐文本节点 normalize 后直接拼接，
    // 节点之间**不插空格**（原来 join(' ') 会在多文本节点间多出空格）
    return arr.map(function (t) { return collapse(t); }).join('').trim();
  }

  function textNodesText(node) {
    if (!node || !node.childNodes) return '';
    var out = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) {
        // P：对齐 Legado（AnalyzeByJSoup.kt:207-219）——item.text().trim()，非空才收；
        // 不做 \u00a0→空格 的归一（Legado 没有这一步）
        var t = String(c.nodeValue).trim();
        if (t) out.push(t);
      }
    }
    return out.join('\n');
  }

  /* ------------------------------------------------------------ jsoup Element.text()（P1-1）
   * 原实现是 collapse(el.textContent)，与 jsoup 差三处：
   *   1. script/style 的内容是 DataNode，不进 text()（textContent 会带出来）
   *   2. 进入块级元素前补空格（head）
   *   3. 离开块级元素、下一个兄弟是文本节点时补空格（tail）——少了这条，嵌套表格就是 innerouter
   * 逐行对齐 jsoup 1.14.3：Element.text() / StringUtil.appendNormalisedWhitespace / Tag.isBlock()
   */
  var BLOCK_TAGS = {};
  ('html head body frameset script noscript style meta link title frame noframes section nav '
    + 'aside hgroup header footer p h1 h2 h3 h4 h5 h6 ul ol pre div blockquote hr address figure '
    + 'figcaption form fieldset ins del dl dt dd li table caption colgroup col thead tfoot tbody '
    + 'tr th td video audio canvas details menu plaintext template article main svg math center '
    + 'dir applet marquee').split(' ').forEach(function (t) { BLOCK_TAGS[t] = 1; });

  var PRESERVE_TAGS = { pre: 1, plaintext: 1, title: 1, textarea: 1 };

  function isWsChar(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === '\u00a0';
  }

  function lastCharIsWs(s) {
    return s.length === 0 || isWsChar(s.charAt(s.length - 1));
  }

  /* jsoup: StringUtil.appendNormalisedWhitespace */
  function appendNormalised(buf, str, stripLeading) {
    var lastWasWhite = false, reachedNonWhite = false;
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (isWsChar(c)) {
        if ((stripLeading && !reachedNonWhite) || lastWasWhite) continue;
        buf.s += ' ';
        lastWasWhite = true;
      } else {
        buf.s += c;
        lastWasWhite = false;
        reachedNonWhite = true;
      }
    }
  }

  function jsoupText(root) {
    if (!root) return '';
    if (root.nodeType !== 1 && root.nodeType !== 9) return collapse(root.textContent);
    var buf = { s: '' };
    (function walkChildren(parent) {
      var kids = parent.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 3) {                       // TextNode
          var ptag = (n.parentNode && n.parentNode.tagName)
            ? n.parentNode.tagName.toLowerCase() : '';
          if (PRESERVE_TAGS[ptag]) buf.s += n.nodeValue;
          else appendNormalised(buf, String(n.nodeValue), lastCharIsWs(buf.s));
          continue;
        }
        if (n.nodeType !== 1) continue;               // 注释等直接跳过
        var tag = String(n.tagName || '').toLowerCase();
        // head：进入块级元素前补空格
        if (buf.s.length > 0 && (BLOCK_TAGS[tag] || tag === 'br') && !lastCharIsWs(buf.s)) {
          buf.s += ' ';
        }
        // script / style 的内容在 jsoup 里是 DataNode，不进 text()
        if (tag !== 'script' && tag !== 'style' && tag !== 'br'
          && tag !== 'hr' && tag !== 'img' && tag !== 'input') {
          walkChildren(n);
        }
        // tail：离开块级元素、且下一个兄弟是文本节点时补空格
        var next = kids[i + 1];
        if (BLOCK_TAGS[tag] && next && next.nodeType === 3 && !lastCharIsWs(buf.s)) {
          buf.s += ' ';
        }
      }
    })(root);
    return buf.s.trim();
  }

  /* ------------------------------------------------------------ Entities.unescape（P2）
   * Legado 在 AnalyzeRule.getString() 收尾统一做一次 Entities.unescape(result)，
   * "&amp;lt;b&amp;gt;" 这种被转义过两层的正文会还原成 "<b>"。单趟替换。
   */
  var UNESCAPE_NAMED = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function unescapeEntities(s) {
    return String(s == null ? '' : s).replace(
      /&(?:#x([0-9a-fA-F]+)|#(\d+)|(nbsp|amp|lt|gt|quot|apos));/g,
      function (m, hex, dec, name) {
        if (hex) {
          var c1 = parseInt(hex, 16);
          return isNaN(c1) ? m : String.fromCodePoint(c1);
        }
        if (dec) {
          var c2 = parseInt(dec, 10);
          return isNaN(c2) ? m : String.fromCodePoint(c2);
        }
        var v = UNESCAPE_NAMED[String(name).toLowerCase()];
        return v === undefined ? m : v;
      }
    );
  }

  /** HTML → 纯文本（保留段落/换行），用于正文与 @html 取值 */
  function domToText(node) {
    if (!node) return '';
    if (!node.cloneNode) return collapse(node);
    var box = node.cloneNode(true);
    Array.prototype.forEach.call(box.querySelectorAll('script,style'), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    Array.prototype.forEach.call(box.querySelectorAll('br'), function (br) {
      br.parentNode.replaceChild(box.ownerDocument.createTextNode('\n'), br);
    });
    Array.prototype.forEach.call(
      box.querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,h5,h6,blockquote,tr,dd,dt'),
      function (b) { b.appendChild(box.ownerDocument.createTextNode('\n')); }
    );
    var text = String(box.textContent || '');
    return text.replace(/\u00a0/g, ' ')
      .split('\n')
      .map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); })
      .filter(function (l) { return l.length > 0; })
      .join('\n');
  }

  function htmlToText(html) {
    var s = String(html || '');
    if (!s) return '';
    if (s.indexOf('<') < 0) return squash(s);
    var doc = parseHtml(s);
    return domToText(doc.body || doc.documentElement);
  }

  /* ------------------------------------------------------------ 平衡切分（RuleAnalyzer.splitRule） */
  /**
   * 按分隔符切分，跳过引号和 [] () 里的内容。
   * 对齐 Legado：多种分隔符时，取最先出现的那个作为分割符（elementsType）。
   */
  function splitRule(str, delims) {
    var s = String(str || '');
    var i, inQuote = false, quoteCh = '', depth = 0, firstIdx = -1, firstDelim = '';

    for (i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuote) { if (c === quoteCh) inQuote = false; continue; }
      if (c === '"' || c === "'") { inQuote = true; quoteCh = c; continue; }
      if (c === '\\') { i++; continue; }
      if (c === '[' || c === '(') { depth++; continue; }
      if (c === ']' || c === ')') { if (depth > 0) depth--; continue; }
      if (depth > 0) continue;
      for (var k = 0; k < delims.length; k++) {
        if (s.substr(i, delims[k].length) === delims[k]) {
          if (firstIdx < 0) { firstIdx = i; firstDelim = delims[k]; }
          i = firstIdx; // 已经确定分割符，跳出双层
          k = delims.length;
          i = firstIdx;
          break;
        }
      }
      if (firstIdx >= 0) break;
    }

    if (firstIdx < 0) return { parts: [s], type: '' };

    var parts = [], start = 0, j = 0;
    inQuote = false; depth = 0;
    for (j = 0; j < s.length; j++) {
      var ch = s[j];
      if (inQuote) { if (ch === quoteCh) inQuote = false; continue; }
      if (ch === '"' || ch === "'") { inQuote = true; quoteCh = ch; continue; }
      if (ch === '\\') { j++; continue; }
      if (ch === '[' || ch === '(') { depth++; continue; }
      if (ch === ']' || ch === ')') { if (depth > 0) depth--; continue; }
      if (depth > 0) continue;
      if (s.substr(j, firstDelim.length) === firstDelim) {
        parts.push(s.substring(start, j));
        j += firstDelim.length - 1;
        start = j + 1;
      }
    }
    parts.push(s.substring(start));
    return { parts: parts, type: firstDelim };
  }

  /* ------------------------------------------------------------ 选择器（AnalyzeByJSoup.ElementsSingle） */
  function allDescendants(el) {
    if (!el || !el.querySelectorAll) return [];
    return Array.prototype.slice.call(el.querySelectorAll('*'));
  }

  /** 解析结尾的索引写法：[...] 或 .N / !N / :N */
  function parseIndexSpec(stage) {
    var s = String(stage || '');
    var res = { before: s, split: '.', indexes: [] };

    // [ ... ] 写法
    if (s.length && s[s.length - 1] === ']') {
      var open = s.lastIndexOf('[');
      if (open >= 0) {
        var inner = s.substring(open + 1, s.length - 1).trim();
        var before = s.substring(0, open);
        var exclude = false;
        if (inner[0] === '!') { exclude = true; inner = inner.substring(1); }
        var list = [];
        inner.split(',').forEach(function (piece) {
          piece = piece.trim();
          if (!piece) return;
          var seg = piece.split(':');
          if (seg.length > 1) {
            list.push({
              range: true,
              start: seg[0] === '' ? 0 : parseInt(seg[0], 10),
              end: seg[1] === '' ? -1 : parseInt(seg[1], 10),
              step: seg.length > 2 && seg[2] !== '' ? parseInt(seg[2], 10) : 1
            });
          } else {
            var n = parseInt(piece, 10);
            if (!isNaN(n)) list.push({ range: false, index: n });
          }
        });
        // 只有 [] 内容和前置规则都合法才当索引，否则当普通选择器
        var looksIndex = list.length > 0;
        if (looksIndex) {
          res.before = before;
          res.split = exclude ? '!' : '.';
          res.indexes = list;
          return res;
        }
      }
    }

    // 老写法 .N / !N / :N（P2：`:` 只是"再要一个索引"的分隔符，不是切片）
    //   tag.div.-1:10:2 → 索引 -1、10、2      tag.div!0:3 → 排除 0 和 3
    var m = /^(.*?)([.!:])(-?\d+(?::-?\d+)*)$/.exec(s);
    if (m && (m[1] !== '' || m[2] === '!')) {
      res.before = m[1];
      res.split = m[2] === '!' ? '!' : '.';
      res.indexes = m[3].split(':').map(function (n) {
        return { range: false, index: parseInt(n, 10) };
      });
      return res;
    }
    return res;
  }

  function applyIndexes(elements, spec) {
    if (!spec.indexes.length) return elements;
    var len = elements.length;
    var picked = [];
    var pickedSet = {};
    var exclude = spec.split === '!';

    spec.indexes.forEach(function (it) {
      if (it.range) {
        var start = it.start < 0 ? len + it.start : it.start;
        var end = it.end < 0 ? len + it.end : it.end;
        if (start < 0) start = 0;
        if (start >= len) start = len - 1;
        if (end < 0) end = 0;
        if (end >= len) end = len - 1;
        var step = it.step || 1;
        if (step < 0) step = -step;
        if (end >= start) {
          for (var i = start; i <= end; i += step) pushed(i);
        } else {
          for (var j = start; j >= end; j -= step) pushed(j);
        }
      } else {
        var idx = it.index < 0 ? len + it.index : it.index;
        if (idx >= 0 && idx < len) pushed(idx);
      }
    });

    function pushed(i) {
      if (pickedSet[i]) return;
      pickedSet[i] = 1;
      picked.push(i);
    }

    if (!picked.length) return [];
    if (exclude) {
      var rest = [];
      for (var k = 0; k < len; k++) if (!pickedSet[k]) rest.push(elements[k]);
      return rest;
    }
    return picked.map(function (i) { return elements[i]; });
  }

  /** 一级选择器：children / class.X / tag.X / id.X / text.X / CSS */
  function elementsSingle(el, stage) {
    if (!el || !el.querySelectorAll) return [];
    var spec = parseIndexSpec(stage);
    var before = String(spec.before || '').trim();
    var elements;

    if (!before) {
      elements = Array.prototype.slice.call(el.children || []);
    } else {
      // P2：糖正则不再要求点号后有内容，裸 `children` / `children.0` 也能匹配
      //   （原写法 `^(children|class|tag|id|text)\.([\s\S]+)$` 让裸 `children` 落到 querySelectorAll("children") → 空）
      var m = /^(children|class|tag|id|text)(?:\.([\s\S]*))?$/.exec(before);
      if (m) {
        var kind = m[1], name = (m[2] || '').trim();
        if (kind === 'children') {
          elements = Array.prototype.slice.call(el.children || []);
        } else if (kind === 'class') {
          try { elements = Array.prototype.slice.call(el.querySelectorAll('.' + name.replace(/\s+/g, '.'))); }
          catch (e) { elements = []; }
        } else if (kind === 'tag') {
          elements = Array.prototype.slice.call(el.getElementsByTagName(name));
        } else if (kind === 'id') {
          try { elements = Array.prototype.slice.call(el.querySelectorAll('[id="' + name + '"]')); }
          catch (e) { elements = []; }
          if (!elements.length && el.id === name) elements = [el];
        } else {
          elements = allDescendants(el).filter(function (n) {
            return ownText(n).indexOf(name) >= 0;
          });
        }
      } else {
        var cssErr = null;
        validateSelectorSyntax(before);
        try { elements = Array.prototype.slice.call(el.querySelectorAll(before)); }
        catch (e) { elements = []; cssErr = e; }
        // P：源里常见的 "-ul.xxx" 前缀（阅读系方言/笔误）——Chromium CSS 匹配不到任何
        // 元素（-ul 被当自定义标签名），剥掉开头的 '-' 重试一次，救活这类源
        if (!elements.length && before.charAt(0) === '-') {
          try { elements = Array.prototype.slice.call(el.querySelectorAll(before.substring(1))); }
          catch (e) { elements = []; if (!cssErr) cssErr = e; }
        }
        // r1-t1（对齐 Legado AnalyzeByJSoup）：匹配 0 个元素不是错误，就是「空」——
        //   jsoup select 匹配不到时返回空列表，`||` 接着试下一个备选，页面换版式的源因此能被救活。
        //   原来这里一律抛「CSS 选择器写法有误：…」，异常冒出 `||`，57 个「首备选是普通 CSS」的源
        //   被误判失效。现在只有选择器本身语法非法（querySelectorAll 抛 SyntaxError）才抛错。
        if (!elements.length && cssErr) {
          throw segmentError(new Error('CSS 选择器语法错误：' + before + '（' + ((cssErr && cssErr.message) || cssErr) + '）'), 'SELECTOR');
        }
      }
    }
    return applyIndexes(elements, spec);
  }

  /* ------------------------------------------------------------ 取值（getResultLast） */
  var EXTRACT_KEYS = { text: 1, textNodes: 1, ownText: 1, html: 1, all: 1 };

  function getResultLast(elements, lastRule) {
    var out = [];
    if (!elements.length) return out;
    if (lastRule === 'text') {
      elements.forEach(function (el) {
        var t = collapse(jsoupText(el));   // P1-1：jsoup text() 语义（script 不进 text、块级补空格）
        if (t) out.push(t);
      });
    } else if (lastRule === 'textNodes') {
      elements.forEach(function (el) {
        var t = textNodesText(el);
        if (t) out.push(t);
      });
    } else if (lastRule === 'ownText') {
      elements.forEach(function (el) {
        var t = ownText(el);
        if (t) out.push(t);
      });
    } else if (lastRule === 'html' || lastRule === 'all') {
      var htmls = elements.map(function (el) {
        var clone = el.cloneNode(true);
        Array.prototype.forEach.call(clone.querySelectorAll('script,style'), function (n) {
          if (n.parentNode) n.parentNode.removeChild(n);
        });
        return clone.outerHTML;
      });
      if (htmls.length) out.push(htmls.join(''));
    } else {
      elements.forEach(function (el) {
        var v = el.getAttribute ? el.getAttribute(lastRule) : '';
        if (v && out.indexOf(v) < 0) out.push(v);
      });
    }
    return out;
  }

  /* ------------------------------------------------------------ JSoup 规则执行 */
  /** 列表：返回元素数组 */
  function jsoupElements(root, ruleStr) {
    var src = String(ruleStr || '');
    var isCss = false;
    if (/^@CSS:/i.test(src)) { isCss = true; src = src.substring(5).trim(); }
    if (/^@@/.test(src)) src = src.substring(2);

    var split = splitRule(src, ['&&', '||', '%%']);
    var groups = [];

    if (isCss) {
      split.parts.forEach(function (p, segmentIndex) {
        var lastAt = p.lastIndexOf('@');
        var sel = lastAt > 0 ? p.substring(0, lastAt) : p;
        var ext = lastAt > 0 ? p.substring(lastAt + 1) : '';
        var els;
        try { validateSelectorSyntax(sel); els = Array.prototype.slice.call(root.querySelectorAll(sel)); }
        catch (e) { throw segmentError(e, 'SELECTOR', segmentIndex, 'group'); }
        if (ext) els = getResultLast(els, ext).map(textToEl);
        groups.push(els);
      });
    } else {
      split.parts.forEach(function (p) {
        var stages = splitRule(p, ['@']).parts.map(function (x) { return x.trim(); });
        var last = stages.length ? stages[stages.length - 1] : '';
        // 最后一段是取值关键字（text/html/...）时，元素取到前一段为止
        var end = (last && EXTRACT_KEYS[last]) ? stages.length - 1 : stages.length;
        var current = [root];
        for (var si = 0; si < end; si++) {
          var stg = stages[si];
          if (!stg) continue;
          var next = [];
          current.forEach(function (el) { next = next.concat(elementsSingle(el, stg)); });
          current = next;
          if (!current.length) break;
        }
        groups.push(current);
      });
    }

    if (split.type === '||') {
      for (var i = 0; i < groups.length; i++) if (groups[i].length) return groups[i];
      return [];
    }
    if (split.type === '%%') {
      var out = [];
      // P2：Legado 的 AnalyzeByJSoup 用 results[0] 的长度当基准（不是 max）
      var maxLen = groups.length ? groups[0].length : 0;
      for (var k = 0; k < maxLen; k++) {
        groups.forEach(function (g) { if (g[k]) out.push(g[k]); });
      }
      return out;
    }
    var all = [];
    groups.forEach(function (g) { all = all.concat(g); });
    return all;
  }

  function textToEl() { return null; }

  /** 字符串列表：对齐 AnalyzeByJSoup.getStringList */
  function jsoupStrings(root, ruleStr) {
    var src = String(ruleStr || '');
    var isCss = false;
    if (/^@CSS:/i.test(src)) { isCss = true; src = src.substring(5).trim(); }
    if (/^@@/.test(src)) src = src.substring(2);
    if (!src) return [collapse(root.textContent)];

    var split = splitRule(src, ['&&', '||', '%%']);
    var groups = [];

    if (isCss) {
      split.parts.forEach(function (p, segmentIndex) {
        var lastAt = p.lastIndexOf('@');
        var sel = lastAt > 0 ? p.substring(0, lastAt) : p;
        var ext = lastAt > 0 ? p.substring(lastAt + 1) : 'text';
        var els = [];
        try { validateSelectorSyntax(sel); els = Array.prototype.slice.call(root.querySelectorAll(sel)); }
        catch (e) { throw segmentError(e, 'SELECTOR', segmentIndex, 'group'); }
        groups.push(getResultLast(els, ext));
      });
    } else {
      split.parts.forEach(function (p) {
        var stages = splitRule(p, ['@']).parts.map(function (x) { return x.trim(); });
        // 开头的空段表示「从当前内容开始取」（如 @text / @href）
        var current = [root];
        for (var i = 0; i < stages.length - 1; i++) {
          var stg = stages[i];
          if (!stg) continue;
          var next = [];
          current.forEach(function (el) { next = next.concat(elementsSingle(el, stg)); });
          current = next;
          if (!current.length) break;
        }
        var last = stages.length ? stages[stages.length - 1] : '';
        if (!last) { groups.push(getResultLast([root], 'text')); return; }
        if (!current.length) { groups.push([]); return; }
        var isExtract = !!EXTRACT_KEYS[last] || current.some(function (el) {
          return el.getAttribute && el.getAttribute(last) != null && el.getAttribute(last) !== '';
        });
        if (stages.length === 1) {
          // 单级规则：最后一段是选择器（Legado 要求显式 @text，这里放宽）
          var els = [];
          current.forEach(function (el) { els = els.concat(elementsSingle(el, stages[0])); });
          groups.push(getResultLast(els, 'text'));
        } else if (isExtract) {
          groups.push(getResultLast(current, last));
        } else {
          var els2 = [];
          current.forEach(function (el) { els2 = els2.concat(elementsSingle(el, last)); });
          groups.push(getResultLast(els2, 'text'));
        }
      });
    }

    if (split.type === '||') {
      for (var i2 = 0; i2 < groups.length; i2++) if (groups[i2].length) return groups[i2];
      return [];
    }
    if (split.type === '%%') {
      var out = [];
      // P2：基准是第一组的长度（Legado results[0].indices）
      var maxLen = groups.length ? groups[0].length : 0;
      for (var k = 0; k < maxLen; k++) {
        groups.forEach(function (g) { if (g[k] != null) out.push(g[k]); });
      }
      return out;
    }
    var all = [];
    groups.forEach(function (g) { all = all.concat(g); });
    return all;
  }

  /* ------------------------------------------------------------ JSONPath（P2-1 重写）
   * 修掉四处：① '@' 前缀没剥（过滤器恒失效）② '..' 递归下降静默退化 ③ bracket 键带引号失效
   * ④ 多值只取第一个（Legado 是 joinToString("\n")）⑤ 过滤器不支持 > < >= <=
   */
  function jsonWalk(root, path) {
    var p = String(path).trim().replace(/^[$@]/, '');
    if (!p) return [root];
    var steps = [];
    var buf = '', i = 0, deep = false;
    function flush() {
      if (buf) { steps.push({ key: buf, deep: deep }); buf = ''; deep = false; }
    }
    while (i < p.length) {
      var ch = p[i];
      if (ch === '.' && p[i + 1] === '.') { flush(); deep = true; i += 2; continue; }
      if (ch === '.') { flush(); i++; continue; }
      if (ch === '[') {
        flush();
        var depth = 0, j = i, inner = '';
        for (; j < p.length; j++) {
          var c2 = p[j];
          if (c2 === '[') { depth++; if (depth === 1) continue; }
          if (c2 === ']') { depth--; if (depth === 0) break; }
          inner += c2;
        }
        steps.push({ bracket: inner, deep: deep });
        deep = false;
        i = j + 1;
        continue;
      }
      buf += ch; i++;
    }
    flush();
    if (!steps.length) return [root];

    var cur = [root];
    for (var s = 0; s < steps.length; s++) {
      var st = steps[s], next = [];
      for (var k = 0; k < cur.length; k++) {
        var v = cur[k];
        if (v == null) continue;
        if (st.deep) {
          if (st.key) {
            deepCollectKey(v, st.key, next);
          } else {
            applyStep(v, st, next);
            walkAll(v, function (val) { applyStep(val, st, next); });
          }
          continue;
        }
        applyStep(v, st, next);
      }
      cur = next;
      if (!cur.length) break;
    }
    return cur;
  }

  /* Legado 的字符串化 —— 多值 join("\n")，对象/null 按 Java toString 风格 */
  function javaStr(v) {
    if (v === null) return 'null';
    if (v === undefined) return '';
    if (Array.isArray(v)) {
      if (!v.length) return '';
      var allScalar = v.every(function (x) { return x === null || typeof x !== 'object'; });
      if (allScalar) {
        return '[' + v.map(function (x) { return x === null ? 'null' : JSON.stringify(x); }).join(',') + ']';
      }
      return '[' + v.map(javaStr).join(', ') + ']';
    }
    if (typeof v === 'object') {
      return '{' + Object.keys(v).map(function (k) { return k + '=' + javaStr(v[k]); }).join(', ') + '}';
    }
    return String(v);
  }

  /* 多值取字符串（Legado: List → joinToString("\n")） */
  function jsonValsToStr(vals, keepSingleObject) {
    if (!vals.length) return '';
    if (keepSingleObject && vals.length === 1 && vals[0] !== null && typeof vals[0] === 'object') return vals[0];
    return vals.map(javaStr).join('\n');
  }

  /* $..key —— 先看当前节点自己，再下钻（对齐 jayway 的文档序） */
  function deepCollectKey(node, key, out) {
    if (node == null || typeof node !== 'object') return;
    if (!Array.isArray(node) && node[key] !== undefined) out.push(node[key]);
    if (Array.isArray(node)) {
      for (var i2 = 0; i2 < node.length; i2++) deepCollectKey(node[i2], key, out);
      return;
    }
    Object.keys(node).forEach(function (k) { deepCollectKey(node[k], key, out); });
  }

  /* 递归下降遍历（给 $..[...] 用） */
  function walkAll(node, fn) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i3 = 0; i3 < node.length; i3++) { fn(node[i3], i3, node); walkAll(node[i3], fn); }
      return;
    }
    Object.keys(node).forEach(function (key) {
      fn(node[key], key, node);
      walkAll(node[key], fn);
    });
  }

  /* 单个路径步 —— key / [*] / [?()] / [a:b] / [k1,k2] / ['key'] */
  function applyStep(v, st, out) {
    if (v == null) return;
    if (st && typeof st === 'object' && st.bracket !== undefined) {
      var inner = st.bracket.trim();
      if (inner === '*') {
        if (Array.isArray(v)) Array.prototype.push.apply(out, v);
        else if (typeof v === 'object') Object.keys(v).forEach(function (kk) { out.push(v[kk]); });
        return;
      }
      var f = /^\?\(\s*@\.([\w$.]+)\s*(==|!=|>=|<=|>|<|contains)\s*["']?([^"')]*)["']?\s*\)$/.exec(inner);
      if (f) {
        (Array.isArray(v) ? v : []).forEach(function (item) {
          var got = jsonWalk(item, '@.' + f[1])[0];
          var rhs = f[3];
          var na = Number(got), nb = Number(rhs);
          var bothNum = got !== '' && got != null && rhs !== '' && !isNaN(na) && !isNaN(nb);
          var ok;
          switch (f[2]) {
            case '==': ok = bothNum ? na === nb : String(got) === rhs; break;
            case '!=': ok = bothNum ? na !== nb : String(got) !== rhs; break;
            case '>=': ok = bothNum && na >= nb; break;
            case '<=': ok = bothNum && na <= nb; break;
            case '>': ok = bothNum && na > nb; break;
            case '<': ok = bothNum && na < nb; break;
            default: ok = String(got).indexOf(rhs) >= 0;   // contains
          }
          if (ok) out.push(item);
        });
        return;
      }
      if (inner.indexOf(':') > 0) {
        var seg = inner.split(':');
        var a1 = seg[0] === '' ? 0 : +seg[0];
        var a2 = seg[1] === '' ? undefined : +seg[1];
        if (Array.isArray(v)) Array.prototype.push.apply(out, v.slice(a1, a2));
        return;
      }
      inner.split(',').forEach(function (piece) {
        var q = piece.trim().replace(/^['"]/, '').replace(/['"]$/, '');
        if (!q) return;
        var idx = parseInt(q, 10);
        if (!isNaN(idx) && String(idx) === q && Array.isArray(v)) {
          if (idx < 0) idx = v.length + idx;
          if (v[idx] !== undefined) out.push(v[idx]);
        } else if (!Array.isArray(v) && typeof v === 'object' && v[q] !== undefined) {
          out.push(v[q]);
        } else if (Array.isArray(v)) {
          v.forEach(function (item) {
            if (item && typeof item === 'object' && item[q] !== undefined) out.push(item[q]);
          });
        }
      });
      return;
    }
    var key = (st && typeof st === 'object') ? st.key : st;
    if (key === undefined || key === '') return;
    if (key === '*') {
      if (Array.isArray(v)) Array.prototype.push.apply(out, v);
      else if (typeof v === 'object') Object.keys(v).forEach(function (k) { out.push(v[k]); });
      return;
    }
    if (Array.isArray(v)) {
      var idx2 = parseInt(key, 10);
      if (!isNaN(idx2) && String(idx2) === String(key)) {
        if (idx2 < 0) idx2 = v.length + idx2;
        if (v[idx2] !== undefined) out.push(v[idx2]);
        return;
      }
      v.forEach(function (item) { if (item && item[key] !== undefined) out.push(item[key]); });
      return;
    }
    if (typeof v === 'object' && v[key] !== undefined) out.push(v[key]);
  }

  /* ------------------------------------------------------------ XPath */
  function xpathNodes(doc, expr, ctxNode) {
    var out = [];
    if (!doc) return out;
    try {
      var res = doc.evaluate(expr, ctxNode || doc, null, XPathResult.ANY_TYPE, null);
      if (res.resultType === XPathResult.STRING_TYPE) return [res.stringValue];
      if (res.resultType === XPathResult.NUMBER_TYPE) return [res.numberValue];
      if (res.resultType === XPathResult.BOOLEAN_TYPE) return [res.booleanValue];
      var n;
      while ((n = res.iterateNext())) out.push(n);
    } catch (e) {
      throw segmentError(new Error('XPath 写法有误：' + expr + '（' + ((e && e.message) || e) + '）'), 'XPATH');
    }
    return out;
  }

  /* ------------------------------------------------------------ 内容/上下文 */
  function contentOf(ctx) {
    if (ctx.node) return ctx.node;
    if (ctx.value !== undefined) return ctx.value;
    if (ctx.html != null) {
      ctx.doc = ctx.doc || parseHtml(ctx.html);
      return ctx.doc.documentElement;
    }
    // P0-1：调用方只给 Document 的情况（legacy-js 的 java.getString 传的就是 {doc}）
    if (ctx.doc && ctx.doc.nodeType) {
      return ctx.doc.nodeType === 9 ? (ctx.doc.documentElement || ctx.doc) : ctx.doc;
    }
    return null;
  }

  function strOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (v.nodeType) return String(v.textContent || '');
    return String(v);
  }

  /* ---------------- {{规则}} 模板（P1-3）
   * Legado AnalyzeRule.kt:601-606 的 isRule()：@ / $. / $[ / // 开头当规则，否则 JS；
   * SourceRule.init（:470-506）：规则里出现 {{…}} / @get:{…} 时 mode 被强制改成 Mode.Regex，
   * getString 对 Regex 走 `else -> sourceRule.rule`（:225-235）——插值结果就是答案，不再二次求值。
   * iread 原来缺这一步：{{$.source}} 插值成 "豆瓣阅读" 之后又拿它当 CSS 选择器 → 空。
   */

  /** Legado AnalyzeRule.SourceRule.isRule() —— @ / $. / $[ / // 开头当规则 */
  function isRuleExpr(expr) {
    var t = String(expr == null ? '' : expr).trim();
    if (!t) return false;
    if (t.charAt(0) === '@') return true;
    return t.indexOf('$.') === 0 || t.indexOf('$[') === 0 || t.indexOf('//') === 0;
  }

  /* 同一个失败只 warn 一次（同一条规则原样重复 200 次不该刷 200 行日志） */
  var _warnedOnce = Object.create(null);
  function warnOnce(what, msg) {
    var k = what + '\u0000' + msg;
    if (_warnedOnce[k]) return;
    _warnedOnce[k] = 1;
    var c = global.console;
    if (c && c.warn) c.warn('[NR.rule] ' + what + '：' + msg);
  }

  /** Legado evalPattern：`@get:{…}` 或 `{{…}}` */
  var RE_TEMPLATE_PART = /@get:\{[^}]*\}|\{\{[\w\W]*?\}\}/i;

  /* SourceRule.init：含 {{…}} / @get:{…} 时强制 Mode.Regex（条件：`{{` 之前没有 ##）。
   * 返回 true 表示「这一块是模板块，插值结果就是答案」。 */
  function isTemplateBlock(blockText, mode) {
    var s = String(blockText || '');
    var m = RE_TEMPLATE_PART.exec(s);
    if (!m) return false;
    return s.substring(0, m.index).indexOf('##') < 0;
  }

  /* `##` 切点要在 `{{…}}` 之外找（先插值后切 ## 是 Legado 的顺序） */
  function headBeforeRegex(text) {
    var s = String(text == null ? '' : text);
    var inTpl = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (!inTpl && c === '{' && s.charAt(i + 1) === '{') { inTpl = true; i++; continue; }
      if (inTpl && c === '}' && s.charAt(i + 1) === '}') { inTpl = false; i++; continue; }
      if (!inTpl && c === '#' && s.charAt(i + 1) === '#') return s.substring(0, i);
    }
    return s;
  }

  /* ---------------- {{ }} / @get / $n 展开 */
  async function expandExpr(expr, result, ctx) {
    var s = String(expr);
    // {{规则}}：以 @ / $. / $[ / // 开头当规则，否则当 JS（判定见 isRuleExpr）
    if (isRuleExpr(s)) {
      return await evalString(s, result, ctx);
    }
    return runJs(s, result, ctx);
  }

  function runJs(code, result, ctx) {
    var LEGACY = global.NR && global.NR.legacyJs;
    if (!LEGACY) return '';
    // Legado 里 JS 的 result：元素给 HTML（脚本里常直接当字符串处理），其它给原值
    var legacyResult;
    if (result && result.nodeType === 1) legacyResult = String(result.outerHTML || '');
    else if (result == null) legacyResult = '';
    else if (typeof result === 'string') legacyResult = result;
    else legacyResult = String(result);
    try {
      var v = LEGACY.run(code, {
        result: legacyResult,
        html: legacyResult,
        baseUrl: ctx.baseUrl || '',
        key: ctx.key || '',
        page: ctx.page || 1,
        source: ctx.source,
        book: ctx.book,
        chapter: ctx.chapter,
        title: ctx.title || ''
      });
      return v == null ? '' : v;
    } catch (e) {
      if (e && e.code) throw e;
      throw new Error('书源 JS 出错：' + ((e && e.message) || e));
    }
  }

  async function makeUpRule(rule, result, ctx) {
    var s = String(rule || '');
    var out = '';
    var i = 0;
    while (i < s.length) {
      var at = s.indexOf('{{', i);
      var gt = s.toLowerCase().indexOf('@get:', i);
      var next = -1, kind = '';
      if (at >= 0) { next = at; kind = 'expr'; }
      if (gt >= 0 && (next < 0 || gt < next)) { next = gt; kind = 'get'; }
      if (next < 0) { out += s.substring(i); break; }
      out += s.substring(i, next);
      if (kind === 'get') {
        var close = s.indexOf('}', next);
        var key = s.substring(next + 5, close).replace(/^\{/, '').trim();
        out += getVar(key, ctx);
        i = close + 1;
      } else {
        var end = s.indexOf('}}', next + 2);
        if (end < 0) { out += s.substring(next); break; }
        var expr = s.substring(next + 2, end);
        out += await expandExpr(expr, result, ctx);
        i = end + 2;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ 变量 */
  function varsOf(ctx) {
    if (!ctx.source) ctx.source = {};
    if (!ctx.source.__vars) ctx.source.__vars = Object.create(null);
    return ctx.source.__vars;
  }
  function putVar(k, v, ctx) { varsOf(ctx)[k] = v; return v; }
  function getVar(k, ctx) {
    var vars = ctx.source && ctx.source.__vars;
    return vars && vars[k] != null ? vars[k] : '';
  }

  /* ------------------------------------------------------------ 单条规则求值 */
  function splitJsBlocks(rule) {
    var s = String(rule || '');
    var blocks = [];
    var re = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/i;
    var rest = s, m;
    while ((m = re.exec(rest))) {
      if (m.index > 0) blocks.push({ type: 'text', value: rest.substring(0, m.index).trim() });
      blocks.push({ type: 'js', value: m[2] != null ? m[2] : m[1] });
      rest = rest.substring(m.index + m[0].length);
      if (m[2] != null) break;
    }
    if (rest) blocks.push({ type: 'text', value: rest.trim() });
    return blocks;
  }

  function parseSourceText(ruleStr, ctx) {
    var s = String(ruleStr || '').trim();
    var mode = 'default';
    var isCss = false;
    // P：本条规则是否完全无前缀（对齐 Legado SourceRule.init 的 when 链——只有落到
    // else/$. 分支的规则才允许被 isJSON 升级为 Json 模式，AnalyzeRuleCore.kt:600-633）
    var noPrefix = true;
    if (/^@CSS:/i.test(s)) { isCss = true; noPrefix = false; s = s.substring(5).trim(); }
    else if (/^@@/.test(s)) { noPrefix = false; s = s.substring(2); }
    else if (/^@XPath:/i.test(s)) { mode = 'xpath'; noPrefix = false; s = s.substring(7); }
    else if (/^@Json:/i.test(s)) { mode = 'json'; noPrefix = false; s = s.substring(6); }
    else if (/^\$[.[]/.test(s)) { mode = 'json'; noPrefix = false; }
    else if (/^\//.test(s)) { mode = 'xpath'; noPrefix = false; }

    // @put:{...}
    var puts = [];
    s = s.replace(/@put:(\{[^}]+?\})/gi, function (_m, json) {
      var obj = null;
      try { obj = JSON.parse(json); } catch (e) {
        try { obj = JSON.parse(json.replace(/([{,]\s*)([\w$.]+)\s*:/g, '$1"$2":')); } catch (e2) { obj = null; }
      }
      if (obj) Object.keys(obj).forEach(function (k) { puts.push([k, String(obj[k])]); });
      return '';
    });

    return { mode: mode, css: isCss, rule: s.trim(), puts: puts, noPrefix: noPrefix };
  }

  /** P：对齐 Legado（AnalyzeRuleCore.kt:92-94 + StringExtensions.shared.kt:28）——
   *  内容本身是 JSON（首尾非空白字符为 {} 或 []）时，任何规则都按 Json 模式走，
   *  不只 `$.` 开头。 */
  function isJsonContent(v) {
    var s = String(v == null ? '' : v);
    var first = -1, last = -1;
    for (var i = 0; i < s.length; i++) {
      if (!/\s/.test(s.charAt(i))) { first = i; break; }
    }
    for (var j = s.length - 1; j >= 0; j--) {
      if (!/\s/.test(s.charAt(j))) { last = j; break; }
    }
    if (first < 0 || last < first) return false;
    var a = s.charAt(first), b = s.charAt(last);
    return (a === '{' && b === '}') || (a === '[' && b === ']');
  }

  /** P：isJSON 的等价物。Legado 在 setContent(content) 时对「原始文档」算一次 isJSON
   *  并存到实例字段（AnalyzeRuleCore.kt:89-95），消费点在 SourceRule.init（:622）：
   *  `isJSON || $. / $[ 前缀 → Mode.Json`，排在 @CSS:/@@/@XPath:/@Json: 之后、
   *  /（XPath）之前——带前缀的规则不受 isJSON 影响。
   *  这里对齐：在 evalString/evalStringSync 入口对本轮原始 content 算一次并缓存到 ctx
   *  （ctx 对应 AnalyzeRuleCore 实例生命周期），分派时只把「无任何前缀」的 default
   *  模式升级为 json。绝不放在 mode 分派处动态判 result——中间产物（上一条规则产出
   *  的 HTML 片段、{{...}} 插值、<js> 返回值）首尾恰似 {} / [] 时会误伤 CSS 源。 */
  function isJsonDoc(ctx) {
    // P：等价于 Legado setContent(content) 里的原始 content——iread 里是 ctx.value /
    // ctx.html 这两处「未经 DOM 解析的原始输入」（contentOf 会把 html 包成 DOM，
    // 那之后永远判不出 JSON，必须在这里取原始字符串）
    var raw = ctx.value !== undefined ? ctx.value : (ctx.html != null ? ctx.html : null);
    var isNode = raw != null && typeof raw === 'object' && raw.nodeType;
    var ref = isNode ? null : raw;
    if (ctx.__isJsonRef !== ref) {          // 按内容引用缓存，ctx 复用换内容时重算
      ctx.__isJsonRef = ref;
      ctx.__isJsonDoc = (!isNode && ref != null) ? isJsonContent(ref) : false;
    }
    return ctx.__isJsonDoc;
  }

  /** P：无前缀 default 规则 + 文档是 JSON → 升级为 Json 模式（对齐 SourceRule.init:622） */
  function maybeJsonMode(sr, ctx) {
    return sr.mode === 'default' && sr.noPrefix && isJsonDoc(ctx) ? 'json' : sr.mode;
  }

  /* ------------------------------------------------------------ ##正则##替换（P1-2）
   * Legado 的 pattern / replacement 是 java.util.regex 语法，V8 的 RegExp 有几处不认：
   *   (?i)(?s)(?m) 内联标志、\Q…\E、占有量词 a++、\p{IsHan}、${name} 命名组引用、
   *   替换串里的 \1（Java 里 \ 只转义下一个字符）
   * 这里做一次"能翻就翻"的转换；翻完仍编译失败就退回原来的 catch 行为（返回原文），
   * 但留一条 console.warn，不再完全静默。
   */
  var RE_WARNED = Object.create(null);

  function escapeRegexLiteral(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }

  /** Java pattern → { source, flags } */
  function javaPatternToJs(pattern) {
    var p = String(pattern);
    var flags = '';

    // 1) 开头的内联标志 (?i) / (?s) / (?m)，可叠加
    var inline = /^\(\?([ims]+)\)/;
    var mm;
    while ((mm = inline.exec(p))) {
      for (var fi = 0; fi < mm[1].length; fi++) {
        if (flags.indexOf(mm[1][fi]) < 0) flags += mm[1][fi];
      }
      p = p.substring(mm[0].length);
    }

    // 2) \Q…\E → 字面量转义（没写 \E 时吃到结尾）
    p = p.replace(/\\Q([\s\S]*?)(?:\\E|$)/g, function (_m, lit) {
      return escapeRegexLiteral(lit);
    });

    // 3) 占有量词 a++ / a*+ / a?+ / a{m,n}+ → 去掉末尾的 +（JS 不支持，退化成贪婪）
    p = p.replace(/([*+]|\?|\{\d+(?:,\d*)?\})\+/g, '$1');

    // 4) \p{IsHan} → \p{Script=Han}（Java 的 IsXxx 写法），并需要 u 标志
    if (/\\[pP]\{Is[A-Za-z_]+\}/.test(p)) {
      p = p.replace(/\\p\{Is([A-Za-z_]+)\}/g, '\\p{Script=$1}')
        .replace(/\\P\{Is([A-Za-z_]+)\}/g, '\\P{Script=$1}');
    }
    if (/\\[pP]\{/.test(p) && flags.indexOf('u') < 0) flags += 'u';

    return { source: p, flags: flags };
  }

  /** Java replacement → JS replacement（${name} → $<name>；\1 → 1；$ 后不是 $/数字/{ 时按字面） */
  function javaReplacementToJs(repl) {
    var s = String(repl);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\') {
        var n = s.charAt(i + 1);
        if (n === '') { out += '\\\\'; continue; }   // 结尾单个 \
        out += (n === '$' ? '$$' : n);               // Java: \X = 字面 X
        i++;
        continue;
      }
      if (c === '$') {
        var d = s.charAt(i + 1);
        if (d === '{') {                              // ${name} → $<name>
          var close = s.indexOf('}', i + 2);
          if (close > 0) {
            out += '$<' + s.substring(i + 2, close) + '>';
            i = close;
            continue;
          }
        } else if (d >= '0' && d <= '9') {            // $1…$99 语义相同
          var num = d;
          var d2 = s.charAt(i + 2);
          if (d2 >= '0' && d2 <= '9') num += d2;
          out += '$' + num;
          i += num.length;
          continue;
        }
        // Java 里 $ 后面不是数字/{ 就是非法；这里按字面 $ 处理（JS 里写作 $$）
        out += '$$';
        continue;
      }
      out += c;
    }
    return out;
  }

  function applyReplace(result, ruleStr) {
    var s = String(ruleStr);
    if (s.indexOf('##') < 0) return result;
    // P：first 判定取两种方言的并集——
    //   ① `###` 结尾（iread/多数书源习惯）
    //   ② Legado 语义（AnalyzeRuleCore.kt:768-773）：split('##') 后第 4 段存在
    //      且第 4 段**非空**（`a##b##c###` split 出尾部空串不算，避免误伤 `#` 结尾的替换串）
    var parts0 = s.split('##');
    var first = /###\s*$/.test(s)
      || (parts0.length > 3 && parts0[3].replace(/#+\s*$/, '') !== '');
    if (first) s = parts0[0] + '##' + parts0[1] + '##' + parts0[2];
    var parts = s.split('##');
    if (parts.length < 3) return result;
    var re = parts[1], repl = parts[2];
    if (!re) return result;
    var conv = javaPatternToJs(re);
    var jsRepl = javaReplacementToJs(repl);
    try {
      if (first) {
        var rx1 = new RegExp(conv.source, conv.flags);
        var m = rx1.exec(String(result));
        return m ? m[0].replace(new RegExp(conv.source, conv.flags), jsRepl) : '';
      }
      return String(result).replace(new RegExp(conv.source, conv.flags + 'g'), jsRepl);
    } catch (e) {
      // P：兜底对齐 Legado（AnalyzeRuleCore.kt:512）——正则编译失败退化为**字面量**首次替换
      //（Kotlin `result.replace(replaceRegex, replacement)` 的 String 重载），
      // 不再返回原文；保留一条 warn
      if (!RE_WARNED[re]) {
        RE_WARNED[re] = 1;
        if (global.console && global.console.warn) {
          global.console.warn('[rule.js] 正则无法按 JS 语法编译，已退化为字面量替换：' + re
            + '（' + ((e && e.message) || e) + '）');
        }
      }
      var lit = String(result);
      if (first) {
        var at = lit.indexOf(re);
        return at < 0 ? lit : lit.substring(0, at) + jsRepl + lit.substring(at + re.length);
      }
      return lit.split(re).join(jsRepl);
    }
  }

  /** 求值一条规则 → 字符串 */
  async function evalString(rule, content, ctx) {
    var blocks = splitJsBlocks(rule);
    var result = content;
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      if (b.type === 'js') {
        try { result = runJs(b.value, result, ctx); }
        catch (e) { throw segmentError(e, e && e.code, bi, 'js-block'); }
        continue;
      }
      if (!b.value) continue;
      // ## 正则替换要在分析之前先剥掉（Legado: rule = ruleStrS[0]）；
      // 切点用花括号感知版（P1-3）：{{…}} 内层的 ## 不算切点
      var head = headBeforeRegex(b.value);
      var sr = parseSourceText(head, ctx);
      for (var pi = 0; pi < sr.puts.length; pi++) {
        var pv = await evalString(sr.puts[pi][1], content, ctx);
        putVar(sr.puts[pi][0], pv, ctx);
      }
      var ruleText = await makeUpRule(sr.rule, result, ctx);
      if (!ruleText.trim()) continue;
      // P1-3：模板块（含 {{…}} / @get:{…}）——Legado 强制 Mode.Regex，
      // 插值结果就是答案，不再二次当规则求值
      if (isTemplateBlock(b.value, sr.mode)) {
        var tplSrc = parseSourceText(b.value, ctx).rule;
        var tplOut = await makeUpRule(tplSrc, result, ctx);
        result = applyReplace(tplOut, tplOut);
        continue;
      }
      var value;
      var effMode = maybeJsonMode(sr, ctx);   // P：对齐 Legado isJSON 消费点（SourceRule.init:622）
      if (effMode === 'json') {
        var root = result;
        if (typeof root === 'string') {
          try { root = JSON.parse(root); } catch (e) { root = null; }
        }
        var vals = root == null ? [] : jsonWalk(root, ruleText);
        value = jsonValsToStr(vals, true);   // P2-1：多值 join("\n")，单值对象保留供后续链式
        result = value;
      } else if (effMode === 'xpath') {
        var doc = result && result.ownerDocument ? result.ownerDocument : (result && result.nodeType === 9 ? result : parseHtml(strOf(result)));
        var node = result && result.nodeType === 1 ? result : null;
        var nodes = xpathNodes(doc, ruleText, node);
        var strs = nodes.map(function (n) {
          if (n == null) return '';
          if (n.nodeType === 2 || n.nodeType === 3) return String(n.nodeValue || '');
          if (n.nodeType === 1) return collapse(n.textContent);
          return String(n);
        }).filter(function (x) { return x !== ''; });
        result = strs.join('\n');
      } else {
        var rootEl = result && result.nodeType === 9
          ? (result.documentElement || result)
          : (result && result.nodeType ? result : parseHtml(strOf(result)));
        var list = jsoupStrings(rootEl, sr.css ? '@CSS:' + ruleText : ruleText);
        result = list.join('\n');
      }
      result = applyReplace(result, b.value);
    }
    return unescapeEntities(result == null ? '' : strOf(result));   // P2：对齐 Legado getString 收尾
  }

  /** 求值一条规则 → 元素/对象列表 */
  async function evalList(rule, content, ctx) {
    var blocks = splitJsBlocks(rule);
    var result = content;
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      if (b.type === 'js') {
        var v;
        try { v = runJs(b.value, result, ctx); }
        catch (e) { throw segmentError(e, e && e.code, bi, 'js-block'); }
        if (Array.isArray(v)) {
          var flat = [];
          v.forEach(function (x) {
            if (x && x.nodeType) flat.push(x);
            else if (x != null && x !== '') flat.push(x);
          });
          result = flat;
        } else result = v;
        continue;
      }
      if (!b.value) continue;
      var headL = b.value.split('##')[0];
      var sr = parseSourceText(headL, ctx);
      for (var pi = 0; pi < sr.puts.length; pi++) {
        putVar(sr.puts[pi][0], await evalString(sr.puts[pi][1], content, ctx), ctx);
      }
      var ruleText = await makeUpRule(sr.rule, result, ctx);
      if (!ruleText.trim()) continue;
      if (sr.mode === 'json') {
        var rootJ = result;
        if (typeof rootJ === 'string') {
          try { rootJ = JSON.parse(rootJ); } catch (e) { rootJ = null; }
        }
        result = rootJ == null ? [] : jsonWalk(rootJ, ruleText);
      } else if (sr.mode === 'xpath') {
        var docX = result && result.nodeType === 9 ? result : parseHtml(strOf(result));
        result = xpathNodes(docX, ruleText, result && result.nodeType === 1 ? result : null);
      } else {
        var rootEl2 = result && result.nodeType === 9
          ? (result.documentElement || result)
          : (result && result.nodeType ? result : parseHtml(strOf(result)));
        result = jsoupElements(rootEl2, sr.css ? '@CSS:' + ruleText : ruleText);
      }
    }
    if (result == null) return [];
    if (Array.isArray(result)) return result;
    if (result && result.nodeType) return [result];
    return [result];
  }

  /* ------------------------------------------------------------ 对外 API */
  async function apply(rule, ctx) {
    if (rule == null) return '';
    if (Array.isArray(rule)) {
      for (var i = 0; i < rule.length; i++) {
        var v = await apply(rule[i], ctx);
        if (v !== '' && v != null) return v;
      }
      return '';
    }
    var content = contentOf(ctx);
    var out = await evalString(rule, content, ctx);
    // P：Legado getString 收尾有 `indexOf("::")>-1` 短路（AnalyzeRuleCore.kt:369-371，
    // 含 :: 时跳过 isUrl 转绝对地址）；iread 的 apply 出口后面没有加工步骤，
    // 无需短路，这里只留对照注释
    return out;
  }

  async function list(rule, ctx) {
    if (rule == null) return [];
    if (Array.isArray(rule)) {
      for (var i = 0; i < rule.length; i++) {
        var got = await list(rule[i], ctx);
        if (got && got.length) return got;
      }
      return [];
    }
    return evalList(rule, contentOf(ctx), ctx);
  }

  async function derive(scope, rule, ctx) {
    if (!rule) return '';
    var next = Object.assign({}, ctx);
    if (scope && scope.nodeType) next.node = scope;
    else if (scope !== undefined) { next.value = scope; next.node = null; }
    var v = await apply(rule, next);
    if (Array.isArray(v)) return squash(v.join(' '));
    if (v && typeof v === 'object') return squash(strOf(v));
    return squash(v);
  }

  /* ---------------- 同步孪生（P0-2）
   * 原来 applySync 只是个「只走 CSS」的残缺分支：不判 mode（//xpath、$.jsonpath 全当 CSS）、
   * 不支持 <js>/@js:、不剥 ##、不展开 @put/@get/{{}}。
   * 这里按 evalString / makeUpRule / expandExpr 逐行镜像出同步版本（runJs 本来就是同步的）。
   * 注意：改 evalString 时必须同步改 evalStringSync，否则两条路会漂。
   */
  function expandExprSync(expr, result, ctx) {
    var s = String(expr);
    if (/^@/.test(s.trim()) || /^\$[.[]/.test(s.trim()) || /^\/\//.test(s.trim())) {
      return evalStringSync(s, result, ctx);
    }
    return runJs(s, result, ctx);
  }

  function makeUpRuleSync(rule, result, ctx) {
    var s = String(rule || '');
    var out = '';
    var i = 0;
    while (i < s.length) {
      var at = s.indexOf('{{', i);
      var gt = s.toLowerCase().indexOf('@get:', i);
      var next = -1, kind = '';
      if (at >= 0) { next = at; kind = 'expr'; }
      if (gt >= 0 && (next < 0 || gt < next)) { next = gt; kind = 'get'; }
      if (next < 0) { out += s.substring(i); break; }
      out += s.substring(i, next);
      if (kind === 'get') {
        var close = s.indexOf('}', next);
        var key = s.substring(next + 5, close).replace(/^\{/, '').trim();
        out += getVar(key, ctx);
        i = close + 1;
      } else {
        var end = s.indexOf('}}', next + 2);
        if (end < 0) { out += s.substring(next); break; }
        out += expandExprSync(s.substring(next + 2, end), result, ctx);
        i = end + 2;
      }
    }
    return out;
  }

  function evalStringSync(rule, content, ctx) {
    var blocks = splitJsBlocks(rule);
    var result = content;
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      if (b.type === 'js') {
        try { result = runJs(b.value, result, ctx); }
        catch (e) { throw segmentError(e, e && e.code, bi, 'js-block'); }
        continue;
      }
      if (!b.value) continue;
      var head = headBeforeRegex(b.value);   // P1-3：花括号感知的 ## 切点
      var sr = parseSourceText(head, ctx);
      for (var pi = 0; pi < sr.puts.length; pi++) {
        putVar(sr.puts[pi][0], evalStringSync(sr.puts[pi][1], content, ctx), ctx);
      }
      var ruleText = makeUpRuleSync(sr.rule, result, ctx);
      if (!ruleText.trim()) continue;
      // P1-3：模板块——插值结果就是答案（同步版与 evalString 对齐）
      if (isTemplateBlock(b.value, sr.mode)) {
        var tplSrcS = parseSourceText(b.value, ctx).rule;
        var tplOutS = makeUpRuleSync(tplSrcS, result, ctx);
        result = applyReplace(tplOutS, tplOutS);
        continue;
      }
      var value;
      var effModeS = maybeJsonMode(sr, ctx);  // P：对齐 Legado isJSON 消费点（SourceRule.init:622）
      if (effModeS === 'json') {
        var root = result;
        if (typeof root === 'string') {
          try { root = JSON.parse(root); } catch (e) { root = null; }
        }
        var vals = root == null ? [] : jsonWalk(root, ruleText);
        value = jsonValsToStr(vals, false);   // P2-1：同步路径统一字符串化（对齐 Legado getString）
        result = value;
      } else if (effModeS === 'xpath') {
        var doc = result && result.ownerDocument ? result.ownerDocument
          : (result && result.nodeType === 9 ? result : parseHtml(strOf(result)));
        var ctxNode = result && result.nodeType === 1 ? result : null;
        var nodes = xpathNodes(doc, ruleText, ctxNode);
        var strs = nodes.map(function (n) {
          if (n == null) return '';
          if (n.nodeType === 2 || n.nodeType === 3) return String(n.nodeValue || '');
          if (n.nodeType === 1) return collapse(n.textContent);
          return String(n);
        }).filter(function (x) { return x !== ''; });
        result = strs.join('\n');
      } else {
        var rootEl = result && result.nodeType === 9
          ? (result.documentElement || result)
          : (result && result.nodeType ? result : parseHtml(strOf(result)));
        var list = jsoupStrings(rootEl, sr.css ? '@CSS:' + ruleText : ruleText);
        result = list.join('\n');
      }
      result = applyReplace(result, b.value);
    }
    return unescapeEntities(result == null ? '' : strOf(result));   // P2：对齐 Legado getString 收尾
  }

  /** 同步求值（给 java.getString 用）：与 apply 走同一套逻辑，只是同步 */
  function applySync(rule, ctx) {
    if (rule == null) return '';
    if (Array.isArray(rule)) {
      for (var i = 0; i < rule.length; i++) {
        var v = applySync(rule[i], ctx);
        if (v !== '' && v != null) return v;
      }
      return '';
    }
    return evalStringSync(String(rule), contentOf(ctx), ctx);
  }

  /* ------------------------------------------------------------ URL 模板（AnalyzeUrl） */

  /** 取「内容」用于 URL 模板里的 {{规则}} 求值（无内容 → undefined，走 JS 分支） */
  function expandContent(vars) {
    if (vars.value !== undefined && vars.value !== null) return vars.value;
    if (vars.node !== undefined && vars.node !== null) return vars.node;
    if (vars.html != null) return vars.html;
    if (vars.doc != null) return vars.doc;
    return undefined;
  }

  function expand(str, vars) {
    var s = String(str == null ? '' : str);
    vars = vars || {};
    // PATCH P0-5：URL 模板里的 {{规则}}（@ / $. / $[ / // 开头，判定同 AnalyzeRule.SourceRule.isRule）
    // 需要"内容"才能求值；调用方没给内容时（legado.js 的 URL 路径就是这样）保持上一轮的行为，
    // 与 AnalyzeUrl.replaceKeyPageJs（那里 {{}} 一律 evalJS）一致。
    var ruleContent = expandContent(vars);
    var ruleCtx = {
      doc: vars.doc || null,
      html: vars.html,
      node: vars.node || null,
      baseUrl: vars.baseUrl || '', key: vars.key || '', page: vars.page || 1,
      source: vars.source, result: vars.result
    };
    // {{js}} / {{规则}}
    s = s.replace(/\{\{([\s\S]*?)\}\}/g, function (_m, expr) {
      var LEGACY = global.NR && global.NR.legacyJs;
      var name = String(expr).trim();
      /* PATCH P0-5：规则形态 → 走同步规则求值（evalStringSync），对齐 AnalyzeRule.makeUpRule
       * 里 `isRule → getString(SourceRule(内容))` 那条分支。求值失败按 Legado getString 的口径
       * 返回空串（规则没匹配到就是空），但留一条（去重的）console.warn，不再完全静默。 */
      if (isRuleExpr(expr) && ruleContent !== undefined) {
        try {
          return strOf(evalStringSync(expr, ruleContent, ruleCtx));
        } catch (e) {
          warnOnce('URL 规则 {{' + name + '}}', '求值失败：' + ((e && e.message) || e)
            + '（地址模板：' + s + '）');
          return '';
        }
      }
      if (!LEGACY) {
        var direct = vars[name];
        return direct == null ? '' : String(direct);
      }
      var v;
      try {
        v = LEGACY.run(expr, {
          baseUrl: vars.baseUrl || '', key: vars.key || '', page: vars.page || 1,
          source: vars.source, result: vars.result
        });
      } catch (e) {
        /* PATCH P1：`{{表达式}}` 求值失败（语法错 / 引用了不存在的名字）原来被 catch 掉、
         * 退回 vars[name] → 空串，于是搜索 URL 静默变空（`?kw=`），用户只看到"搜不到书"。
         * 对齐 Legado（AnalyzeUrl.replaceKeyPageJs 里 evalJS 抛异常会中止 AnalyzeUrl）：
         * 这里不再是"静默空串"，而是 ① console.warn 留痕 ② 抛一个带规则原文的错误给上层。
         * 注意只对**异常**这么做；求值为 null/'' 是正常情况，仍然返回空串（见下一行）。*/
        var why = (e && e.message) || e;
        var msg = 'URL 规则 {{' + name + '}} 求值失败：' + why;
        warnOnce('URL 规则 {{' + name + '}}', msg + '（地址模板：' + s + '）');
        var err = new Error(msg);
        err.ruleExpr = name;
        err.ruleTemplate = s;
        if (e && e.code) err.code = e.code;
        if (e && e.api) err.api = e.api;
        err.cause = e;
        throw err;
      }
      return v == null ? '' : String(v);
    });
    // <a,b,c> 分页
    s = s.replace(/<([^<>]*)>/g, function (m, list) {
      var arr = String(list).split(',');
      var p = Number(vars.page || 1);
      return (p > 0 && p <= arr.length ? arr[p - 1] : arr[arr.length - 1]).trim();
    });
    return s;
  }

  /** 已经是编码过的就原样保留 */
  function looksEncoded(v) {
    return /^[A-Za-z0-9._~!$&'()*+,;=:@%\/?#\-]*$/.test(v) && /%[0-9A-Fa-f]{2}/.test(v);
  }

  function encodeQueryPart(part) {
    var eq = part.indexOf('=');
    if (eq < 0) return looksEncoded(part) ? part : enc(part);
    var k = part.substring(0, eq);
    var v = part.substring(eq + 1);
    return (looksEncoded(k) ? k : enc(k)) + '=' + (looksEncoded(v) ? v : enc(v));
  }

  /* AnalyzeUrl.PARAM_PATTERN */
  var RE_URL_OPTIONS = /\s*,\s*(?=\{)\s*/;

  /** 把 `url,{options}` 拆成 { urlPart, optionsRaw }（对齐 AnalyzeUrl.analyzeUrl 前半段） */
  function splitUrlOptions(raw) {
    var s = String(raw == null ? '' : raw);
    var m = RE_URL_OPTIONS.exec(s);
    if (!m) return { urlPart: s, optionsRaw: '' };
    var urlPart = s.substring(0, m.index);
    var rest = s.substring(m.index + m[0].length).trim();
    if (rest.charAt(0) !== '{') return { urlPart: urlPart, optionsRaw: rest };
    var depth = 0, end = -1;
    for (var i = 0; i < rest.length; i++) {
      var c = rest.charAt(i);
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) {                       // 括号不平衡：选项残缺，丢弃并留痕（老实现也丢）
      warnOnce('URL 选项', '选项串括号不平衡，已忽略：' + rest.slice(0, 120));
      return { urlPart: urlPart, optionsRaw: '' };
    }
    return { urlPart: urlPart, optionsRaw: rest.substring(0, end + 1) };
  }

  /** GSON（UrlOption）宽松解析：裸键、单引号、尾逗号、// 与 /* *\/ 注释、裸值 */
  function parseUrlOptions(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return null;
    if (s.charAt(0) !== '{') {
      warnOnce('URL 选项', '选项串不是对象，已忽略：' + s.slice(0, 120));
      return null;
    }
    try { return JSON.parse(s); } catch (e) { /* 落到宽松解析 */ }
    try {
      var v = parseLenientJson(s);
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch (e2) {
      warnOnce('URL 选项', '选项串解析失败（' + ((e2 && e2.message) || e2) + '）：' + s.slice(0, 120));
      return null;
    }
  }

  function parseLenientJson(text) {
    var s = String(text), i = 0, n = s.length;
    function fail(msg) { throw new Error(msg + '（第 ' + (i + 1) + ' 字符）'); }
    function skip() {
      for (;;) {
        while (i < n && /\s/.test(s.charAt(i))) i++;
        if (s.charAt(i) === '/' && s.charAt(i + 1) === '/') {
          while (i < n && s.charAt(i) !== '\n') i++;
          continue;
        }
        if (s.charAt(i) === '/' && s.charAt(i + 1) === '*') {
          i += 2;
          while (i < n && !(s.charAt(i) === '*' && s.charAt(i + 1) === '/')) i++;
          i += 2;
          continue;
        }
        return;
      }
    }
    function parseString(quote) {
      i++;
      var out = '';
      while (i < n) {
        var c = s.charAt(i++);
        if (c === quote) return out;
        if (c !== '\\') { out += c; continue; }
        var e = s.charAt(i++);
        if (e === 'u') { out += String.fromCharCode(parseInt(s.substr(i, 4), 16)); i += 4; }
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else out += e;                       // \" \' \\ \/ 以及未知转义按字面
      }
      fail('字符串没有闭合');
    }
    function parseValue() {
      skip();
      var c = s.charAt(i);
      if (c === '{') return parseObject();
      if (c === '[') return parseArray();
      if (c === '"' || c === "'") return parseString(c);
      var num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (num) { i += num[0].length; return Number(num[0]); }
      var bare = /^[^\s,:\[\]{}"']+/.exec(s.slice(i));
      if (!bare) fail('无法识别的值');
      i += bare[0].length;
      if (bare[0] === 'true') return true;
      if (bare[0] === 'false') return false;
      if (bare[0] === 'null') return null;
      return bare[0];                        // GSON lenient：未加引号的字符串
    }
    function parseObject() {
      i++;
      var obj = {};
      for (;;) {
        skip();
        if (s.charAt(i) === '}') { i++; return obj; }
        var k, c = s.charAt(i);
        if (c === '"' || c === "'") k = parseString(c);
        else {
          var bare = /^[^\s:]+/.exec(s.slice(i));
          if (!bare) fail('键名缺失');
          k = bare[0];
          i += bare[0].length;
        }
        skip();
        if (s.charAt(i) !== ':') fail('缺冒号');
        i++;
        obj[k] = parseValue();
        skip();
        if (s.charAt(i) === ',') { i++; continue; }
        if (s.charAt(i) === '}') { i++; return obj; }
        fail('对象里缺 , 或 }');
      }
    }
    function parseArray() {
      i++;
      var arr = [];
      for (;;) {
        skip();
        if (s.charAt(i) === ']') { i++; return arr; }
        arr.push(parseValue());
        skip();
        if (s.charAt(i) === ',') { i++; continue; }
        if (s.charAt(i) === ']') { i++; return arr; }
        fail('数组里缺 , 或 ]');
      }
    }
    var v = parseValue();
    skip();
    if (i < n) fail('多余字符');
    return v;
  }

  /* ------------------------------------------------ charset → 字节（替代 iconv） */

  /** Java charset 名 → WHATWG 解码器 label（TextDecoder 只认 WHATWG 名） */
  var CHARSET_LABEL = {
    'utf-8': 'utf-8', 'utf8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
    'ascii': 'utf-8', 'us-ascii': 'utf-8',
    'gbk': 'gbk', 'gb2312': 'gbk', 'gb_2312': 'gbk', 'gb_2312-80': 'gbk',
    'gb18030': 'gb18030', 'x-gbk': 'gbk', 'cp936': 'gbk', 'ms936': 'gbk', 'windows-936': 'gbk',
    'big5': 'big5', 'big5-hkscs': 'big5', 'cp950': 'big5', 'x-x-big5': 'big5',
    'shift_jis': 'shift_jis', 'shift-jis': 'shift_jis', 'sjis': 'shift_jis',
    'ms_kanji': 'shift_jis', 'cp932': 'shift_jis', 'windows-31j': 'shift_jis', 'x-sjis': 'shift_jis',
    'euc-jp': 'euc-jp', 'x-euc-jp': 'euc-jp',
    'euc-kr': 'euc-kr', 'ks_c_5601-1987': 'euc-kr', 'cp949': 'euc-kr', 'windows-949': 'euc-kr',
    'iso-8859-1': 'iso-8859-1', 'latin1': 'iso-8859-1', 'iso8859-1': 'iso-8859-1',
    'windows-1252': 'windows-1252', 'cp1252': 'windows-1252'
  };

  function charsetLabel(cs) {
    var s = String(cs == null ? '' : cs).trim().toLowerCase()
      .replace(/^["']+|["']+$/g, '').replace(/_/g, '-');
    if (!s) return '';
    if (CHARSET_LABEL[s]) return CHARSET_LABEL[s];
    if (CHARSET_LABEL[s.replace(/-/g, '')]) return CHARSET_LABEL[s.replace(/-/g, '')];
    return '';                                // 不认识 → 上层按 UTF-8 兜底并告警
  }

  var _CHARSET_MAPS = {};

  /**
   * 反推「字符 → 字节」表。
   * JS 里没有 GBK/BIG5 编码器（TextEncoder 只支持 UTF-8），但 TextDecoder **能解**
   * 这些编码。于是把 1 字节空间（0x00-0xFF）和 2 字节空间（lead 0x81-0xFE ×
   * trail 0x40-0xFE，跳过 0x7F）全扫一遍，解出来的字符反过来建索引，就得到编码表。
   * 24k 次 decode ≈ 50ms，且每种 charset 只建一次（缓存）。
   * 核验：out/ab/probe-gbk/check.js 与 JDK "GBK" 编码器逐字对比：23965/24067 字节
   * 完全一致，剩下 101 个是 Java GBK 的用户自定义区（PUA），1 个是 €（已特判）。
   */
  function charsetMap(label) {
    if (Object.prototype.hasOwnProperty.call(_CHARSET_MAPS, label)) return _CHARSET_MAPS[label];
    var dec;
    try { dec = new TextDecoder(label, { fatal: true }); }
    catch (e) { _CHARSET_MAPS[label] = null; return null; }
    if (!dec) { _CHARSET_MAPS[label] = null; return null; }
    var map = Object.create(null);
    function put(bytes) {
      var ch;
      try { ch = dec.decode(bytes); } catch (e) { return; }
      if (ch.length !== 1 || ch === '\uFFFD' || map[ch] !== undefined) return;
      map[ch] = [bytes[0], bytes.length > 1 ? bytes[1] : -1];
    }
    var i, b;
    for (b = 0; b <= 0xFF; b++) put(new Uint8Array([b]));
    for (i = 0x81; i <= 0xFE; i++) {
      for (b = 0x40; b <= 0xFE; b++) {
        if (b === 0x7F) continue;
        put(new Uint8Array([i, b]));
      }
    }
    // Java GBK/GB18030 把 € (U+20AC) 编成 A2E3；WHATWG 解码器把单字节 0x80 解成 €
    if (label === 'gbk' || label === 'gb18030') map['\u20AC'] = [0xA2, 0xE3];
    _CHARSET_MAPS[label] = map;
    return map;
  }

  /** Java `URLEncoder.encode(s, charset)` 的等价物：不可编码字符按 '?'（Java 也是） */
  function javaUrlEncode(str, label) {
    var map = charsetMap(label);
    var s = String(str == null ? '' : str);
    if (!map) {
      warnOnce('charset', 'TextDecoder 不支持 ' + label + '，按 UTF-8 编码');
      return enc(s);
    }
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      var ch = s.charAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) { ch = s.substr(i, 2); i++; }
      var bytes = map[ch];
      if (!bytes) { out += '%3F'; continue; }              // 编不出 → '?' → %3F
      for (var j = 0; j < bytes.length; j++) {
        var b = bytes[j];
        if (b < 0) continue;
        if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
          || b === 0x2E || b === 0x2D || b === 0x2A || b === 0x5F) {
          out += String.fromCharCode(b);                   // Java 只保留这几个
        } else if (b === 0x20) {
          out += '+';                                      // Java 空格 → '+'
        } else {
          out += '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
        }
      }
    }
    return out;
  }

  /** 给网络层 / body 用：按 charset 编一个值（UTF-8 走原来的 encodeURIComponent） */
  function encodeCharsetValue(str, charset) {
    var label = charsetLabel(charset);
    if (!label || label === 'utf-8') return enc(str);
    return javaUrlEncode(str, label);
  }

  /** 从 UrlOption 决定这次怎么编 query（对齐 RefUrl.analyzeFields 的三个分支） */
  function charsetPlan(opt) {
    var raw = opt ? opt.charset : '';
    var cs = String(raw == null ? '' : raw).trim();
    if (!cs) return { charset: '', label: 'utf-8', transcode: false };
    if (cs.toLowerCase() === 'escape') {
      // P：escape 是 Legado 的独立第三分支（EncoderUtils.escape：不 URL 编码，
      // 只把非字母数字转 %XX/%uXXXX），不是「未知 charset 兜底」
      return { charset: cs, label: 'escape', transcode: false };
    }
    var label = charsetLabel(cs);
    if (!label) {
      warnOnce('charset', '不认识 charset:' + cs + '，按 UTF-8 编码');
      return { charset: cs, label: 'utf-8', transcode: false };
    }
    if (label === 'utf-8') return { charset: cs, label: 'utf-8', transcode: false };
    if (!charsetMap(label)) {
      warnOnce('charset', '当前环境编不了 charset:' + cs + '，按 UTF-8 编码');
      return { charset: cs, label: 'utf-8', transcode: false };
    }
    return { charset: cs, label: label, transcode: true };
  }

  /** Legado EncoderUtils.escape：字母数字原样；charCode<16 → %0X；<256 → %XX；其余 → %uXXXX（小写 hex） */
  function javaEscape(s) {
    var out = '';
    var str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      var ch = str.charAt(i);
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        out += ch;
        continue;
      }
      if (code < 16) out += '%0' + code.toString(16);
      else if (code < 256) out += '%' + code.toString(16);
      else out += '%u' + code.toString(16);
    }
    return out;
  }

  /** charset 分支：键原样（同 RefUrl 的 fieldMap.put(queryM[0], …)），值按 charset 编 */
  function encodeQueryPartCharset(part, label) {
    var eq = part.indexOf('=');
    if (eq < 0) return javaUrlEncode(part, label);
    return part.substring(0, eq) + '=' + javaUrlEncode(part.substring(eq + 1), label);
  }

  /** 把非 ASCII 字符百分号化（UTF-8），保持老实现逐字节一致 */
  function pctUtf8(url) {
    return url.replace(/[^\x00-\x7F]/g, function (c) { return enc(c).toUpperCase(); });
  }

  /** 把规则地址变成真正能请求的地址（含 options 拆分、query 编码） */
  function buildUrl(ruleUrl, vars, baseUrl) {
    var raw = String(ruleUrl == null ? '' : ruleUrl).trim();
    var split = splitUrlOptions(raw);
    var opt = parseUrlOptions(split.optionsRaw);
    var plan = charsetPlan(opt);
    var base = baseUrl || vars.baseUrl;

    var url = expand(split.urlPart, vars);
    var qPos = url.indexOf('?');

    if (plan.label === 'escape') {
      // P：escape 分支（Legado EncoderUtils.escape）——非字母数字转 %XX/%uXXXX，
      // 且不经过 pctUtf8 预处理（escape 是完全不 URL 编码的独立路径）
      if (qPos >= 0) {
        var headE = url.substring(0, qPos);
        var queryE = url.substring(qPos + 1);
        url = headE + '?' + queryE.split('&').map(function (p) {
          var eq = p.indexOf('=');
          if (eq < 0) return javaEscape(p);
          return p.substring(0, eq) + '=' + javaEscape(p.substring(eq + 1));
        }).join('&');
      }
      try { url = resolveUrl(url, base); } catch (e) { }
    } else if (plan.transcode) {
      /* PATCH P0：charset 非 UTF-8 → query 值当场按 charset 编（同 URLEncoder.encode(v, charset)）。
       * 两个必须注意的点（都是这一轮踩出来的）：
       *   1. 必须在 resolveUrl 之前编：WHATWG URL 会把 `?kw=中文` 的汉字直接百分号化成
       *      UTF-8（%E4%B8%AD…），再来按 charset 编就成了双重编码 %25E4%25B8…
       *   2. 不走 looksEncoded 白名单：Legado 在 charset 分支里是无条件编码的
       *      （RefUrl.analyzeFields：charset 非空 → 直接 encOrRaw(value, charset)） */
      if (qPos >= 0) {
        var headC = pctUtf8(url.substring(0, qPos));
        var queryC = url.substring(qPos + 1);
        url = headC + '?' + queryC.split('&').map(function (p) {
          return encodeQueryPartCharset(p, plan.label);
        }).join('&');
      } else {
        url = pctUtf8(url);
      }
      try { url = resolveUrl(url, base); } catch (e) { }
    } else {
      try { url = resolveUrl(url, base); } catch (e) { }
      url = pctUtf8(url);            // 与老实现完全一致：先整条百分号化，再逐段编码
      qPos = url.indexOf('?');
      if (qPos >= 0) {
        var head2 = url.substring(0, qPos);
        var query2 = url.substring(qPos + 1);
        url = head2 + '?' + query2.split('&').map(encodeQueryPart).join('&');
      }
    }

    return {
      url: url,
      options: split.optionsRaw,                    // 原始选项串（legado.js 的 JSON.parse 还靠它）
      optionsParsed: opt,                           // PATCH P0：解析后的 UrlOption 对象
      charset: plan.charset,                        // 交给网络层（响应解码 / body 转码）
      method: (opt && String(opt.method == null ? '' : opt.method).toUpperCase() === 'POST') ? 'POST' : 'GET',
      body: opt && opt.body != null ? String(opt.body) : null
    };
  }

  /* ------------------------------------------------------------ 正文 */
  async function contentText(rule, ctx) {
    var s = String(rule || '').trim();
    if (!s) return '';
    var content = contentOf(ctx);

    // JS / JSON / XPath 规则照常取字符串，再转文本
    if (/<js>|@js:|@[Jj]son:|@XPath:|^\$[.[]|^\//.test(s)) {
      var v0 = await evalString(s, content, ctx);
      return v0.indexOf('<') >= 0 ? htmlToText(v0) : String(v0 || '');
    }

    // 选择器规则：直接拿元素 HTML 转段落文本（保留分段）
    try {
      var els = await evalList(s, content, ctx);
      var nodes = els.filter(function (e) { return e && e.nodeType === 1; });
      if (nodes.length) {
        return nodes.map(function (n) { return domToText(n); })
          .filter(function (t) { return t && t.length; }).join('\n');
      }
    } catch (e) { ctx.contentError = e; }

    var v = await evalString(s, content, ctx);
    return v.indexOf('<') >= 0 ? htmlToText(v) : String(v || '');
  }

  global.NR.rule = {
    apply: apply,
    applySync: applySync,
    list: list,
    derive: derive,
    parse: parseSourceText,
    expand: expand,
    buildUrl: buildUrl,
    resolveUrl: resolveUrl,
    // URL 选项 / charset 相关（网络层、body 处理可以复用）
    splitUrlOptions: splitUrlOptions,
    parseUrlOptions: parseUrlOptions,
    charsetLabel: charsetLabel,
    encodeCharsetValue: encodeCharsetValue,
    parseHtml: parseHtml,
    htmlToText: htmlToText,
    domToText: domToText,
    contentText: contentText,
    squash: squash,
    splitRule: splitRule,
    unescapeEntities: unescapeEntities,   // P：给 legacy-js 的 org.jsoup.parser.Parser 门面复用
    // 兼容旧调用
    template: function (str, vars) { return expand(str, vars); }
  };
})(window);
