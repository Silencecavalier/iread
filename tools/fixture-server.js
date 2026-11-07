/* =========================================================================
 * fixture-server.js — 书源测试用的本地站点（只有测试用，不打进成品）
 *   起法：node tools/fixture-server.js [端口]
 *   提供两套接口：
 *     HTML： /search?q=&page=  /book/:id  /toc/:id  /chapter/:id-:n
 *     JSON： /api/search?q=   /api/book/:id  /api/chapter/:id-:n
 * ========================================================================= */
'use strict';

const http = require('http');
const url = require('url');

const BOOKS = [
  {
    id: 1,
    title: '长夜行',
    author: '沈砚',
    intro: '一个守夜人的第七年。他记得每一盏灯，却记不住自己的名字。城里的人说，长夜将要结束。',
    chapters: ['开篇', '第一章 雨夜来客', '第二章 书里的字', '第三章 铜钉', '第四章 守夜人', '第五章 一页空白', '第六章 莫回头']
  },
  {
    id: 2,
    title: '灯下集',
    author: '江秋白',
    intro: '十二个短篇，都在同一盏灯下发生。有人在灯里等一个人，有人把灯吹灭了才敢说话。',
    chapters: ['灯下·一', '灯下·二', '灯下·三', '灯下·四', '灯下·五', '灯下·六']
  },
  {
    id: 3,
    title: '旧城的雨',
    author: '无名',
    intro: '雨下了四十年。旧城的人学会了在雨里写字、走路、告别。',
    chapters: ['雨起', '雨密', '雨歇', '雨别']
  }
];

const LINES = [
  '灯芯剪到第七次的时候，窗外的雨还没有停。他数着檐下的水痕，一条一条，像谁在墙上写了又擦掉的字。',
  '“你还在等？”来人站在门口，身上滴着水，声音却干得像一块旧木头。',
  '他没有回头。铜钉在灯影里泛着哑光，一枚一枚，钉着他不肯说出口的那些年。',
  '钥匙不在锁孔里，在书里。翻到第三十七页，字迹会自己挪开，露出一道窄门。',
  '“长夜不是没有尽头，”他说，“是有人不肯让它过去。”',
  '雨声忽然低了下去。整座城像屏住了呼吸，等着谁先把那口气吐出来。'
];

function chapterText(book, n) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push(LINES[(n + i) % LINES.length] + '（第 ' + n + ' 章 · 第 ' + (i + 1) + ' 段）');
  }
  return out;
}

function page(inner) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>示例站</title></head><body>' +
    '<div class="wrap">' + inner + '</div></body></html>';
}

/* 发现页「热门」分类专用书目：标题与既有夹具书目不同，避免与本地书架断言互相污染 */
const HOT_BOOKS = [
  { id: 9101, title: '热门夹具一', author: '夹具甲', intro: '热门分类夹具正文简介一。', chapters: ['开篇', '第一章 热一'] },
  { id: 9102, title: '热门夹具二', author: '夹具乙', intro: '热门分类夹具正文简介二。', chapters: ['开篇', '第一章 热二'] }
];

function searchHtml(q) {
  const list = BOOKS.filter(b => !q || b.title.includes(q) || b.author.includes(q) || q === '');
  return page('<div class="list">' + list.map(b =>
    '<div class="book-item">' +
    '<img class="cover" src="/cover/' + b.id + '.png" alt="">' +
    '<h3><a href="/book/' + b.id + '">' + b.title + '</a></h3>' +
    '<span class="author">' + b.author + '</span>' +
    '<p class="intro">' + b.intro + '</p>' +
    '<span class="latest">' + b.chapters[b.chapters.length - 1] + '</span>' +
    '</div>'
  ).join('') + '</div>');
}

function exploreHtml(books) {
  return page('<div class="list">' + books.map(b =>
    '<div class="explore-item">' +
    '<img class="explore-cover" src="/cover/' + b.id + '.png" alt="">' +
    '<h3 class="explore-title"><a href="/book/' + b.id + '">' + b.title + '</a></h3>' +
    '<span class="explore-author">' + b.author + '</span>' +
    '<p class="explore-intro">' + b.intro + '</p>' +
    '</div>'
  ).join('') + '</div>');
}

function bookHtml(b) {
  return page(
    '<img class="book-cover" src="/cover/' + b.id + '.png" alt="">' +
    '<h1 class="book-title">' + b.title + '</h1>' +
    '<span class="book-author">' + b.author + '</span>' +
    '<div class="book-intro">' + b.intro + '</div>' +
    '<a class="toc-link" href="/toc/' + b.id + '">查看目录</a>'
  );
}

function tocHtml(b) {
  return page('<ul id="chapter-list">' + b.chapters.map((t, i) =>
    '<li><a href="/chapter/' + b.id + '-' + (i + 1) + '">' + t + '</a></li>'
  ).join('') + '</ul>');
}

function chapterHtml(b, n) {
  return page('<h1>' + b.chapters[n - 1] + '</h1><div id="content">' +
    chapterText(b, n).map(p => '<p>' + p + '</p>').join('') + '</div>');
}

/* ------------------------------ 分页夹具（目录分页 + 正文分页） ------------------------------ */
function book2Html(b) {
  return page(
    '<h1 class="book-title">' + b.title + '</h1>' +
    '<span class="book-author">' + b.author + '</span>' +
    '<div class="book-intro">' + b.intro + '</div>' +
    '<a class="toc-link" href="/toc2/' + b.id + '">查看目录</a>'
  );
}

function toc2Html(b, pageNo) {
  const start = pageNo === 2 ? 3 : 0;
  const part = pageNo === 2 ? b.chapters.slice(3) : b.chapters.slice(0, 3);
  let h = '<ul id="chapter-list">';
  part.forEach(function (t, i) {
    h += '<li><a href="/chapter2/' + b.id + '-' + (start + i + 1) + '">' + t + '</a></li>';
  });
  h += '</ul>';
  if (pageNo !== 2) h += '<a class="next" href="/toc2/' + b.id + '?page=2">下一页</a>';
  return page(h);
}

function chapter2Html(b, n, pageNo) {
  const mark = pageNo === 2 ? '正文下半页' : '正文上半页';
  let h = '<h1>' + b.chapters[n - 1] + '</h1><div id="content">' +
    chapterText(b, n).map(p => '<p>' + p + '</p>').join('') +
    '<p>' + mark + '</p></div>';
  if (pageNo !== 2) h += '<a id="nextpage" href="/chapter2/' + b.id + '-' + n + '?p=2">下一页</a>';
  return page(h);
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ---------------------------------------------- 链接导入用的夹具 */
/* 一个 IG 源：结构与 tools/fixtures/sources.json 里第一条一致，只换名字（id 就不同了） */
function bookSource(name, port) {
  return {
    bookSourceName: name,
    bookSourceUrl: 'http://127.0.0.1:' + port,
    bookSourceGroup: '测试',
    enabled: true,
    searchUrl: '/search?q={{key}}&page={{page}}',
    ruleSearch: {
      bookList: '.book-item',
      name: 'h3 a@text',
      author: '.author@text',
      bookUrl: 'h3 a@href'
    },
    ruleBookInfo: {
      name: '//h1[@class=\'book-title\']/text()',
      tocUrl: '//a[@class=\'toc-link\']/@href'
    },
    ruleToc: {
      chapterList: '#chapter-list li a',
      chapterName: '@text',
      chapterUrl: '@href'
    },
    ruleContent: { content: '#content' }
  };
}

/* 订阅源（RSS）：字段和书源很像，但没有 ruleSearch，用的是 ruleArticles/sortUrl */
function rssSource(port) {
  return {
    sourceName: '夹具 · 书源订阅',
    sourceUrl: 'http://127.0.0.1:' + port + '/fixtures/link-page.html',
    sourceGroup: '测试',
    sourceIcon: '',
    enabled: true,
    type: 0,
    sortUrl: 'http://127.0.0.1:' + port + '/fixtures/link-page.html',
    ruleArticles: '.item',
    ruleTitle: '.title@text',
    ruleLink: 'a@href',
    articleStyle: 0
  };
}

/* 一个列着 yuedu:// 分享链接的网页（模拟 miaogongzi 那种「书源管理」页） */
function linkPage(port) {
  const base = 'http://127.0.0.1:' + port + '/fixtures/';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>书源订阅</title></head><body>' +
    '<div class="item"><a class="title" href="yuedu://booksource/importonline?src=' +
    base + 'book-a.json">夹具书源 A</a></div>' +
    '<div class="item"><a class="title" href="yuedu://booksource/importonline?src=' +
    encodeURIComponent(base + 'book-b.json') + '">夹具书源 B</a></div>' +
    '</body></html>';
}

function start(port) {
  port = port || 8123;
  let exploreRetryAttempts = 0;
  let exploreHotRetryAttempts = 0;
  const server = http.createServer(function (req, res) {
    const u = url.parse(req.url, true);
    const p = u.pathname;
    let m;

    // ---------------- POST 搜索（有些书源是表单提交） ----------------
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', function (c) { raw += c; });
      req.on('end', function () {
        const form = new URLSearchParams(raw);
        const q = form.get('q') || form.get('searchkey') || '';
        if (p === '/search') return send(res, 200, 'text/html', searchHtml(q));
        send(res, 404, 'text/plain', 'not found: ' + p);
      });
      return;
    }

    // ---------------- 封面（1x1 PNG，测试用；真实站点走同一条链路） ----------------
    if ((m = /^\/cover\/(\d+)\.png$/.exec(p))) {
      const buf = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    // ---------------- 慢源（测超时判定） ----------------
    if (p === '/slow') {
      setTimeout(function () {
        try { send(res, 200, 'text/html', searchHtml(String(u.query.q || ''))); } catch (e) { }
      }, 7000);
      return;
    }

    // ---------------- 只读分类夹具 ----------------
    if (p === '/explore/fantasy') return send(res, 200, 'text/html', exploreHtml([BOOKS[0], BOOKS[2]]));
    if (p === '/explore/city') return send(res, 200, 'text/html', exploreHtml([BOOKS[1], BOOKS[0]]));
    if (p === '/explore/empty') return send(res, 200, 'text/html', exploreHtml([]));
    if (p === '/explore/slow' || p === '/explore/cancelled') {
      setTimeout(function () {
        try { send(res, 200, 'text/html', exploreHtml([p === '/explore/slow' ? BOOKS[2] : BOOKS[0]])); } catch (e) { }
      }, p === '/explore/slow' ? 900 : 250);
      return;
    }
    if (p === '/explore/retry') {
      exploreRetryAttempts++;
      if (exploreRetryAttempts === 1) return send(res, 503, 'text/plain', 'fixture explore retry error');
      return send(res, 200, 'text/html', exploreHtml([BOOKS[1]]));
    }
    if (p === '/explore/encoding') return send(res, 200, 'text/html', exploreHtml([BOOKS[1]]));
    if (p === '/explore/http-error') return send(res, 503, 'text/plain', 'fixture explore error');

    // ---------------- 发现页「热门」分类夹具（独立书目，标题不与其他夹具重名） ----------------
    if (p === '/explore/hot') return send(res, 200, 'text/html', exploreHtml(HOT_BOOKS));
    if (p === '/explore/slow-hot') {
      setTimeout(function () {
        try { send(res, 200, 'text/html', exploreHtml(HOT_BOOKS)); } catch (e) { }
      }, 2500);
      return;
    }
    if (p === '/explore/hot-retry') {
      exploreHotRetryAttempts++;
      if (exploreHotRetryAttempts === 1) return send(res, 503, 'text/plain', 'fixture hot error');
      return send(res, 200, 'text/html', exploreHtml([HOT_BOOKS[0]]));
    }

    // ---------------- HTML ----------------
    if (p === '/search') return send(res, 200, 'text/html', searchHtml(String(u.query.q || '')));
    if ((m = /^\/book\/(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/html', bookHtml(b));
    }
    if ((m = /^\/toc\/(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/html', tocHtml(b));
    }
    if ((m = /^\/chapter\/(\d+)-(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/html', chapterHtml(b, +m[2]));
    }

    // 分页夹具：目录两页、正文两页
    if ((m = /^\/book2\/(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/html', book2Html(b));
    }
    if ((m = /^\/toc2\/(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/html', toc2Html(b, Number(u.query.page) === 2 ? 2 : 1));
    }
    if ((m = /^\/chapter2\/(\d+)-(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'text/html', chapter2Html(b, +m[2], Number(u.query.p) === 2 ? 2 : 1));
    }

    // ---------------- JSON ----------------
    if (p === '/api/search') {
      const q = String(u.query.q || '');
      const list = BOOKS.filter(b => !q || b.title.includes(q) || b.author.includes(q));
      return send(res, 200, 'application/json', JSON.stringify({
        code: 0,
        data: list.map(b => ({
          title: b.title, author: b.author, intro: b.intro,
          url: 'http://127.0.0.1:' + port + '/api/book/' + b.id
        }))
      }));
    }
    if ((m = /^\/api\/book\/(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'application/json', '{"code":1}');
      return send(res, 200, 'application/json', JSON.stringify({
        code: 0,
        title: b.title,
        author: b.author,
        intro: b.intro,
        chapters: b.chapters.map((t, i) => ({
          title: t,
          url: 'http://127.0.0.1:' + port + '/api/chapter/' + b.id + '-' + (i + 1)
        }))
      }));
    }
    if ((m = /^\/api\/chapter\/(\d+)-(\d+)$/.exec(p))) {
      const b = BOOKS.find(x => x.id === +m[1]);
      if (!b) return send(res, 404, 'application/json', '{"code":1}');
      return send(res, 200, 'application/json', JSON.stringify({
        code: 0,
        title: b.chapters[+m[2] - 1],
        text: chapterText(b, +m[2]).join('\n')
      }));
    }

    if (p === '/') return send(res, 200, 'text/html', searchHtml(''));

    // ---------------- 链接导入夹具 ----------------
    if (p === '/fixtures/link-page.html') return send(res, 200, 'text/html', linkPage(port));
    if (p === '/fixtures/rss-source.json') {
      return send(res, 200, 'application/json', JSON.stringify([rssSource(port)]));
    }
    if (p === '/fixtures/book-a.json') {
      return send(res, 200, 'application/json', JSON.stringify([bookSource('夹具 · 链接 A', port)]));
    }
    if (p === '/fixtures/book-b.json') {
      return send(res, 200, 'application/json', JSON.stringify([bookSource('夹具 · 链接 B', port)]));
    }

    send(res, 404, 'text/plain', 'not found: ' + p);
  });

  return new Promise(function (resolve) {
    server.listen(port, '127.0.0.1', function () {
      resolve({ server: server, port: port });
    });
  });
}

module.exports = { start, BOOKS, LINES };

if (require.main === module) {
  start(Number(process.argv[2]) || 8123).then(function (r) {
    console.log('示例站已启动：http://127.0.0.1:' + r.port + '/');
  });
}
