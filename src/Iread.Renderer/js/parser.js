/* =========================================================================
 * parser.js — 文件解析：编码识别 / 目录自动识别 / EPUB 拆解
 * 统一输出：{ title, chapters: [{ t: 标题, text: 正文(\n 分段) }], totalChars }
 * ========================================================================= */
(function (global) {
  'use strict';

  var store = global.NR.store;

  /* ---------------- 编码识别 ---------------- */
  function decodeText(buf) {
    var b = new Uint8Array(buf);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(b.subarray(3));
    }
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));

    // UTF-8 严格校验
    var i = 0, ok = true;
    while (i < b.length) {
      var c = b[i], n = 0;
      if (c < 0x80) { i += 1; continue; }
      else if (c >= 0xC2 && c <= 0xDF) n = 1;
      else if (c >= 0xE0 && c <= 0xEF) n = 2;
      else if (c >= 0xF0 && c <= 0xF4) n = 3;
      else { ok = false; break; }
      if (i + n >= b.length) { ok = false; break; }
      for (var k = 1; k <= n; k++) {
        if ((b[i + k] & 0xC0) !== 0x80) { ok = false; break; }
      }
      if (!ok) break;
      i += n + 1;
    }
    if (ok) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { /* fall */ }
    }
    // 大概率是 GBK / GB18030（中文 txt 最常见）
    try { return new TextDecoder('gb18030').decode(b); } catch (e) { }
    try { return new TextDecoder('gbk').decode(b); } catch (e) { }
    return new TextDecoder('utf-8').decode(b);
  }

  /* ---------------- 广告/垃圾行过滤 ---------------- */
  var JUNK_RE = [
    /笔趣[阁看]/i, /顶点小说/i, /www\./i, /https?:\/\//i, /手机阅读/i, /txt下载/i,
    /请记住本站/i, /最新网址/i, /电脑访问/i, /备用网址/i, /免费小说/i, /小手一抖/i,
    /VIP章节/i, /本章未完/i, /【.*?提示.*?】/, /^ *本章免费/, /看书的朋友/i,
    /\.(com|net|org|cn|cc|me|io)\b/i, /公众号/i, /扫码/i, /加入书签/i, /返回目录/i,
    /新书上传/i, /求票/i, /推荐票/i, /月票/i, /打赏/i, /^广告$/, /^—+\s*广告/,
    /^[=\-—*#~_+·．。\s]{4,}$/
  ];
  function isJunk(line) {
    if (!line) return true;
    if (line.length > 200) return false;
    for (var i = 0; i < JUNK_RE.length; i++) if (JUNK_RE[i].test(line)) return true;
    return false;
  }

  /* ---------------- 目录识别 ---------------- */
  var NUM = '0-9零一二三四五六七八九十百千万两〇两１-９';
  var RE_STRONG = new RegExp('^\\s*(?:第\\s*[' + NUM + ']{1,14}\\s*[章节回巻卷部篇集话話折幕]\\s*[:：、.．·\\-]?\\s*.*)$');
  var RE_MEDIUM = /^\s*(楔子|序章|序言|序|前言|引子|自序|后记|後記|尾声|尾聲|终章|終章|番外|附录|附錄|内容简介|內容簡介|人物介绍|主要人物|尾声后记|开卷)\s*[:：、.．·\-]?\s*.*$/;
  var RE_CHAPTER_EN = /^\s*chapter\s*[0-9ivxlc]{1,8}\b[\s:.\-]*.*$/i;
  var RE_VOLUME = new RegExp('^\\s*(?:卷|篇)\\s*[' + NUM + ']{1,10}\\s*[:：、.．·\\-]?\\s*.*$');
  var RE_NUMDOT = /^\s*[0-9]{1,4}\s*[.、]\s*.{1,40}$/;

  function titleScore(line, prevBlank, nextBlank) {
    var s = line.trim();
    if (!s || s.length > 60) return 0;
    var hasPunct = /[，。！？；、,!?;]/.test(s.slice(0, -1));
    if (RE_STRONG.test(s)) return hasPunct ? 2 : 3;
    if (RE_VOLUME.test(s)) return hasPunct ? 2 : 3;
    if (RE_MEDIUM.test(s)) return hasPunct ? 2 : 3;
    if (RE_CHAPTER_EN.test(s)) return 3;
    if (RE_NUMDOT.test(s)) return (prevBlank && nextBlank) ? 2 : 0;
    return 0;
  }

  function normalizeTitle(s) {
    return s.replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function buildChapters(text) {
    var rawLines = text.replace(/\r\n?/g, '\n').split('\n');
    var lines = [], i;
    for (i = 0; i < rawLines.length; i++) {
      var l = rawLines[i].replace(/\u3000/g, ' ').replace(/[ \t]+$|^[ \t]+/g, '');
      lines.push(l);
    }

    var marks = [], skippedLines = {};
    for (i = 0; i < lines.length; i++) {
      var cur = lines[i].trim();
      if (!cur) continue;
      var prevBlank = i === 0 || lines[i - 1].trim() === '';
      var nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
      var sc = titleScore(cur, prevBlank, nextBlank);
      if (sc < 2) continue;
      if (isJunk(cur)) continue;
      marks.push({ line: i, title: normalizeTitle(cur) });
    }

    // 目录页去重：同一标题出现多次时，只保留最后一次（目录在前、正文在后）
    var lastSeen = Object.create(null), j;
    for (j = marks.length - 1; j >= 0; j--) {
      var key = marks[j].title.replace(/[.\s·]+/g, '');
      if (lastSeen[key] === undefined) lastSeen[key] = j;
    }
    var keep = Object.create(null);
    for (var k in lastSeen) keep[lastSeen[k]] = 1;
    marks = marks.filter(function (m, idx) { return keep[idx]; });

    // 卷/篇标题紧挨章标题时，合并为「第一卷 XX · 第一章 YY」
    var merged = [], skipVol = {};
    for (j = 0; j < marks.length; j++) {
      var isVol = !skipVol[j] && (RE_VOLUME.test(marks[j].title) ||
        new RegExp('^第\\s*[' + NUM + ']{1,10}\\s*[巻卷篇部]').test(marks[j].title));
      if (isVol && j + 1 < marks.length && marks[j + 1].line - marks[j].line <= 3) {
        marks[j + 1].title = normalizeTitle(marks[j].title + ' · ' + marks[j + 1].title);
        skipVol[j + 1] = true;
        skippedLines[marks[j].line] = true;
        continue;
      }
      merged.push(marks[j]);
    }
    marks = merged;

    var chapters = [];
    function pushChapter(title, bodyLines, startIdx) {
      var body = [], n;
      startIdx = startIdx || 0;
      for (n = 0; n < bodyLines.length; n++) {
        if (skippedLines[startIdx + n]) continue;
        var s = bodyLines[n].trim();
        if (!s) continue;
        if (isJunk(s)) continue;
        body.push(s);
      }
      var t = body.join('\n');
      if (!t) return;
      chapters.push({ t: title, text: t });
    }

    if (marks.length >= 2) {
      // 正文开始前：判断是否为目录页（含大量标题式短行则丢弃）
      var head = lines.slice(0, marks[0].line);
      var headHit = 0;
      for (i = 0; i < head.length; i++) {
        var hs = head[i].trim();
        if (hs && hs.length <= 60 && (RE_STRONG.test(hs) || RE_VOLUME.test(hs) || RE_MEDIUM.test(hs))) headHit++;
      }
      var isTocPage = headHit >= 5 || (headHit >= 3 && marks[0].line > 0 && head.length < 400);
      if (marks[0].line > 0 && !isTocPage) pushChapter('开篇', head, 0);
      for (var m = 0; m < marks.length; m++) {
        var from = marks[m].line + 1;
        var to = (m + 1 < marks.length) ? marks[m + 1].line : lines.length;
        pushChapter(marks[m].title, lines.slice(from, to), from);
      }
    }

    // 兜底：识别不出足够章节时按字数切片
    if (chapters.length < 2) {
      chapters = [];
      var clean = [];
      for (i = 0; i < lines.length; i++) {
        var s2 = lines[i].trim();
        if (!s2 || isJunk(s2)) continue;
        clean.push(s2);
      }
      var buf = [], bufLen = 0, no = 1;
      var flush = function () {
        if (!buf.length) return;
        chapters.push({ t: '第 ' + no + ' 节', text: buf.join('\n') });
        buf = []; bufLen = 0; no++;
      };
      for (i = 0; i < clean.length; i++) {
        buf.push(clean[i]);
        bufLen += clean[i].length;
        if (bufLen >= 3000) flush();
      }
      flush();
      if (!chapters.length) chapters.push({ t: '全文', text: lines.join('\n').trim() || '（空文件）' });
    }
    return chapters;
  }

  /* ---------------- TXT / MD ---------------- */
  function parsePlain(buf, fileName) {
    var text = decodeText(buf);
    var chapters = buildChapters(text);
    var total = 0;
    chapters.forEach(function (c) { total += c.text.length; });
    return {
      title: (fileName || '未命名').replace(/\.(txt|md|markdown)$/i, ''),
      chapters: chapters,
      totalChars: total,
      format: 'txt'
    };
  }

  /* ---------------- EPUB ---------------- */
  function joinPath(base, rel) {
    var parts = base.split('/');
    parts.pop();
    var rp = rel.split('/');
    for (var i = 0; i < rp.length; i++) {
      if (rp[i] === '' || rp[i] === '.') continue;
      if (rp[i] === '..') parts.pop();
      else parts.push(rp[i]);
    }
    return parts.join('/');
  }
  function decodeStr(u8) {
    if (u8[0] === 0xEF) return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    return new TextDecoder('utf-8').decode(u8);
  }
  function attr(tag, name) {
    var m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag);
    if (m) return m[1];
    m = new RegExp(name + "\\s*=\\s*'([^']*)'", 'i').exec(tag);
    return m ? m[1] : null;
  }
  function stripTags(s) {
    return s.replace(/<[^>]*>/g, '');
  }
  function unesc(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  function parseEpub(buf) {
    var files = global.NR.readZip(new Uint8Array(buf));
    var names = Object.keys(files);
    var i, name;

    var container = null;
    for (i = 0; i < names.length; i++) {
      if (/^META-INF\/container\.xml$/i.test(names[i])) container = decodeStr(files[names[i]]);
    }
    var opfPath = null;
    if (container) {
      var rf = /<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i.exec(container);
      if (rf) opfPath = rf[1];
    }
    if (!opfPath) {
      for (i = 0; i < names.length; i++) if (/\.opf$/i.test(names[i])) { opfPath = names[i]; break; }
    }
    if (!opfPath || !files[opfPath]) throw new Error('EPUB 结构异常：找不到 OPF');
    var opf = decodeStr(files[opfPath]);

    var dcTitle = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
    var title = dcTitle ? unesc(stripTags(dcTitle[1])).trim() : '未命名';

    // manifest
    var manifest = {}, mtags = opf.match(/<item\b[^>]*>/gi) || [];
    for (i = 0; i < mtags.length; i++) {
      var id = attr(mtags[i], 'id'), href = attr(mtags[i], 'href'),
        mt = attr(mtags[i], 'media-type'), prop = attr(mtags[i], 'properties');
      if (!id || !href) continue;
      manifest[id] = { href: joinPath(opfPath, href), mt: mt || '', prop: prop || '' };
    }
    // spine
    var spineBody = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf);
    var spine = [];
    if (spineBody) {
      var irefs = spineBody[1].match(/<itemref\b[^>]*>/gi) || [];
      for (i = 0; i < irefs.length; i++) {
        var idref = attr(irefs[i], 'idref');
        var lin = attr(irefs[i], 'linear');
        if (idref && manifest[idref]) {
          var mt2 = manifest[idref].mt;
          if (/xhtml|html|xml/i.test(mt2) && lin !== 'no') spine.push(manifest[idref].href);
        }
      }
    }
    if (!spine.length) {
      for (i = 0; i < names.length; i++) {
        if (/\.(x?html|htm)$/i.test(names[i]) && !/nav|toc/i.test(names[i])) spine.push(names[i]);
      }
    }

    // 把每个 spine 文件拆成 block
    var blocks = [];          // { text, file, id }
    var fileStart = {};       // file -> blocks 起始下标
    for (i = 0; i < spine.length; i++) {
      var f = spine[i];
      var u8 = files[f];
      if (!u8) continue;
      fileStart[f] = blocks.length;
      var html = decodeStr(u8);
      var bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
      var bodyHtml = bodyM ? bodyM[1] : html;
      var doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
      var els = doc.body ? doc.body.children : [];
      var walk = function (node) {
        var tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (tag === 'script' || tag === 'style') return;
        if (/^(p|div|h1|h2|h3|h4|h5|h6|blockquote|li|pre)$/.test(tag)) {
          var txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt) {
            blocks.push({ text: txt, file: f, id: node.getAttribute && node.getAttribute('id') || '' });
          }
          // 若该容器里还有块级子标签，则不再重复取自身
          var hasBlock = false, ch = node.children;
          for (var c2 = 0; c2 < ch.length; c2++) {
            if (/^(p|div|h1|h2|h3|h4|h5|h6|blockquote|li|pre)$/.test(ch[c2].tagName.toLowerCase())) { hasBlock = true; break; }
          }
          if (hasBlock) {
            blocks.pop();
            for (var c3 = 0; c3 < ch.length; c3++) walk(ch[c3]);
            return;
          }
          return;
        }
        for (var c = 0; c < (node.children ? node.children.length : 0); c++) walk(node.children[c]);
      };
      for (var e = 0; e < els.length; e++) walk(els[e]);
      if (blocks.length === fileStart[f]) {
        var plain = stripTags(bodyHtml).replace(/\s+/g, ' ').trim();
        if (plain) blocks.push({ text: plain, file: f, id: '' });
      }
    }

    // 目录：优先 nav.xhtml
    var navList = [];
    var navFile = null;
    for (var id2 in manifest) {
      if (/nav/i.test(manifest[id2].prop)) { navFile = manifest[id2].href; break; }
    }
    if (!navFile) {
      for (i = 0; i < names.length; i++) if (/nav\.(x?html)$/i.test(names[i])) { navFile = names[i]; break; }
    }
    if (navFile && files[navFile]) {
      var navHtml = decodeStr(files[navFile]);
      var navDoc = new DOMParser().parseFromString(navHtml, 'text/html');
      var as = navDoc.querySelectorAll('nav a, nav ol li a');
      for (i = 0; i < as.length; i++) {
        var href = as[i].getAttribute('href') || '';
        var t = (as[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        navList.push({ href: href, title: t, base: navFile });
      }
    }
    if (!navList.length) {
      var tocFile = null;
      for (var id3 in manifest) if (/ncx/i.test(manifest[id3].mt)) tocFile = manifest[id3].href;
      if (!tocFile) for (i = 0; i < names.length; i++) if (/\.ncx$/i.test(names[i])) tocFile = names[i];
      if (tocFile && files[tocFile]) {
        var ncx = decodeStr(files[tocFile]);
        var pts = ncx.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) || [];
        for (i = 0; i < pts.length; i++) {
          var lb = /<navLabel>\s*<text>([\s\S]*?)<\/text>/i.exec(pts[i]);
          var ct = /<content\s+src\s*=\s*"([^"]+)"/i.exec(pts[i]);
          if (lb && ct) navList.push({ href: ct[1], title: unesc(stripTags(lb[1])).trim(), base: tocFile });
        }
      }
    }

    // 定位 nav → block index（href 相对于 nav / ncx 文件本身）
    function locate(href, base) {
      var anchor = '';
      var hi = href.indexOf('#');
      if (hi >= 0) { anchor = href.slice(hi + 1); href = href.slice(0, hi); }
      try { href = decodeURIComponent(href || ''); } catch (e) { }
      var f = joinPath(base || opfPath, href);
      if (!files[f]) {
        var tail = href.split('/').pop();
        var cands = Object.keys(files).filter(function (n) {
          return n === href || n.split('/').pop() === tail || n.indexOf(href) >= 0;
        });
        if (cands.length) f = cands[0]; else return -1;
      }
      if (anchor) {
        for (var b = 0; b < blocks.length; b++) {
          if (blocks[b].file === f && blocks[b].id === anchor) return b;
        }
      }
      if (fileStart[f] !== undefined) return fileStart[f];
      return -1;
    }

    var bounds = [];   // [{ index, title }]
    for (i = 0; i < navList.length; i++) {
      var pos = locate(navList[i].href, navList[i].base);
      if (pos < 0) continue;
      var last = bounds.length ? bounds[bounds.length - 1].index : -1;
      if (pos <= last) continue;
      bounds.push({ index: pos, title: navList[i].title });
    }
    if (!bounds.length) {
      // 无有效目录：每个 spine 文件一章
      for (i = 0; i < spine.length; i++) {
        if (fileStart[spine[i]] !== undefined) bounds.push({ index: fileStart[spine[i]], title: '' });
      }
    }

    var chapters = [];
    for (i = 0; i < bounds.length; i++) {
      var from = bounds[i].index;
      var to = (i + 1 < bounds.length) ? bounds[i + 1].index : blocks.length;
      var texts = [];
      for (var b2 = from; b2 < to; b2++) {
        var tx = blocks[b2].text.trim();
        if (!tx || isJunk(tx)) continue;
        texts.push(tx);
      }
      var nt = (bounds[i].title || '').trim();
      var cmp = nt.replace(/\s+/g, '');
      if (!nt) {
        if (!texts.length) continue;
        nt = texts.shift().slice(0, 26);
      } else if (texts.length && texts[0].replace(/\s+/g, '') === cmp) {
        texts.shift();
      }
      if (!texts.length) continue;
      chapters.push({ t: nt, text: texts.join('\n') });
    }
    if (!chapters.length) {
      var all = blocks.map(function (b) { return b.text; }).filter(function (t) { return !isJunk(t); });
      chapters.push({ t: '全文', text: all.join('\n') });
    }
    if (chapters.length === 1 && chapters[0].text.length > 20000) {
      // 单章太长，按 3000 字切
      var ls = chapters[0].text.split('\n'), out = [], no = 1, p = 0;
      while (p < ls.length) {
        out.push({ t: '第 ' + no + ' 节', text: ls.slice(p, p + 3000).join('\n') });
        p += 3000; no++;
      }
      chapters = out;
    }

    var total = 0;
    chapters.forEach(function (c) { total += c.text.length; });
    return { title: title, chapters: chapters, totalChars: total, format: 'epub' };
  }

  /* ---------------- 入口 ---------------- */
  function parseFile(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var buf = fr.result;
          if (/\.epub$/i.test(file.name)) res(parseEpub(buf));
          else res(parsePlain(buf, file.name));
        } catch (e) { rej(e); }
      };
      fr.onerror = function () { rej(new Error('读取失败')); };
      if (/\.epub$/i.test(file.name)) fr.readAsArrayBuffer(file);
      else fr.readAsArrayBuffer(file);
    });
  }

  global.NR = global.NR || {};
  global.NR.parser = {
    parseFile: parseFile,
    decodeText: decodeText,
    buildChapters: buildChapters
  };
})(window);
