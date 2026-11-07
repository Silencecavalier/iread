/* adskip.js — m3u8 广告块识别与剔除
 *
 * 事实依据（2026-11 抓 18 条真实线路得出）：
 *  1. 魔都系：广告段放在**另一个目录** —— 日期与正片不同、码率目录固定叫 10134kb，
 *     且广告块自带独立 #EXT-X-KEY，前后各一个 #EXT-X-DISCONTINUITY。
 *     例：正片 /20240829/IoQP6k8a/2000kb/hls/…  → 广告 /20261101/O7e8rUyC/10134kb/hls/…
 *  2. 最大/极速系：广告段与正片同目录、同命名规则，唯一稳定特征是
 *     「被两个 DISCONTINUITY 夹住、总时长 8~21 秒」的块（实测 6~9 段，17.6~18s）。
 *  3. 判定：目录不属于主干 → 广告；否则「短块且明显短于前后邻居」→ 广告。
 *  误伤控制：首块/末块不判；与邻居时长接近的块不判；邻居不足 20s 的短块不判。
 */
(function (global) {
  var NR = global.NR = global.NR || {};

  var MIN_DUR = 8;
  var MAX_DUR = 21;
  var NEIGHBOR_RATIO = 0.4;
  var NEIGHBOR_MIN = 20;

  function originOf(u) {
    var m = String(u || '').match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : '';
  }
  function dirOf(u, base) {
    var s = String(u || '');
    if (!/^https?:/i.test(s)) {
      if (s.charAt(0) === '/') s = originOf(base) + s;
      else s = String(base || '').replace(/[^/]*$/, '') + s;
    }
    var m = s.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
    if (!m) return '';
    var path = (m[2] || '/').replace(/[?#].*$/, '');
    return m[1] + path.replace(/[^/]*$/, '');
  }

  function parse(text, base) {
    var lines = String(text || '').split(/\r?\n/);
    var segs = [], cur = null, pendingDisc = false, pendingKey = null;
    for (var i = 0; i < lines.length; i++) {
      var t = String(lines[i] || '').replace(/^\s+|\s+$/g, '');
      if (!t) continue;
      if (t.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE') === 0) continue;
      if (t.indexOf('#EXT-X-DISCONTINUITY') === 0) { pendingDisc = true; continue; }
      if (t.indexOf('#EXT-X-KEY') === 0) { pendingKey = t; continue; }
      if (t.indexOf('#EXTINF:') === 0) {
        var d = parseFloat(t.slice(8));
        cur = { dur: (d >= 0 ? d : 0), disc: pendingDisc, key: pendingKey, lineIdx: i };
        pendingDisc = false;
        continue;
      }
      if (t.charAt(0) === '#') continue;
      if (cur) {
        cur.uri = t;
        cur.i = segs.length;
        cur.uriLine = i;
        cur.dir = dirOf(t, base);
        segs.push(cur);
        cur = null;
      }
    }
    return { lines: lines, segs: segs };
  }

  function blocksOf(segs) {
    var out = [], b = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!b || s.disc) { b = { from: i, to: i, dur: 0, dirs: {} }; out.push(b); }
      b.to = i;
      b.dur += s.dur;
      b.dirs[s.dir] = (b.dirs[s.dir] || 0) + 1;
    }
    return out;
  }

  function analyze(text, base) {
    var p = parse(text, base);
    if (!p.segs.length) return { lines: p.lines, segs: [], blocks: [], mainDir: '', ads: [] };
    var tally = {};
    p.segs.forEach(function (s) { tally[s.dir] = (tally[s.dir] || 0) + 1; });
    var mainDir = '', best = -1;
    Object.keys(tally).forEach(function (d) { if (tally[d] > best) { best = tally[d]; mainDir = d; } });
    var blocks = blocksOf(p.segs);
    var ads = [];
    for (var i = 1; i < blocks.length - 1; i++) {   // 首末块不判
      var b = blocks[i];
      if (b.dur < MIN_DUR || b.dur > MAX_DUR) continue;
      var prev = blocks[i - 1], next = blocks[i + 1];
      var offMain = !!mainDir && !b.dirs[mainDir];
      var neighborMin = Math.min(prev ? prev.dur : 0, next ? next.dur : 0);
      var muchShorter = neighborMin >= NEIGHBOR_MIN && b.dur <= neighborMin * NEIGHBOR_RATIO;
      if (offMain || muchShorter) {
        ads.push({ from: b.from, to: b.to, dur: Math.round(b.dur * 10) / 10, why: offMain ? 'off-main-dir' : 'short-block' });
      }
    }
    return { lines: p.lines, segs: p.segs, blocks: blocks, mainDir: mainDir, ads: ads };
  }

  function rewrite(text, base) {
    var a = analyze(text, base);
    if (!a.ads.length) return { text: text, removed: [], savedSec: 0 };
    var kill = {};
    a.ads.forEach(function (x) { for (var i = x.from; i <= x.to; i++) kill[i] = 1; });
    var byLine = {};
    a.segs.forEach(function (s) { byLine[s.uriLine] = s; });

    var out = [];
    var lastNonEmpty = function () {
      for (var k = out.length - 1; k >= 0; k--) if (String(out[k] || '').trim()) return String(out[k]).trim();
      return '';
    };
    for (var i = 0; i < a.lines.length; i++) {
      var line = a.lines[i], t = String(line || '').replace(/^\s+|\s+$/g, '');
      if (!t) { out.push(line); continue; }

      if (t.indexOf('#EXT-X-KEY') === 0) { out.push(line); continue; }   // KEY 一律保留，多一个无害

      if (t.indexOf('#EXTINF:') === 0) {
        var j = i + 1, uriLine = null;
        while (j < a.lines.length) {
          var tt = String(a.lines[j] || '').replace(/^\s+|\s+$/g, '');
          if (tt.indexOf('#EXTINF:') === 0) break;
          if (tt && tt.charAt(0) !== '#') { uriLine = j; break; }
          j++;
        }
        var sg = uriLine != null ? byLine[uriLine] : null;
        if (sg && kill[sg.i]) continue;      // 广告段的 #EXTINF / #EXT-X-KEY 一起丢
        out.push(line);
        continue;
      }
      if (t.indexOf('#EXT-X-DISCONTINUITY') === 0) {
        if (lastNonEmpty().indexOf('#EXT-X-DISCONTINUITY') === 0) continue;  // 合并相邻 discontinuity
        out.push(line);
        continue;
      }
      if (t.charAt(0) === '#') { out.push(line); continue; }

      var s3 = byLine[i];
      if (s3 && kill[s3.i]) continue;
      out.push(line);
    }
    var savedSec = 0;
    a.ads.forEach(function (x) { savedSec += x.dur; });
    return { text: out.join('\n'), removed: a.ads, savedSec: Math.round(savedSec * 10) / 10 };
  }

  NR.adskip = { analyze: analyze, rewrite: rewrite, dirOf: dirOf, MIN_DUR: MIN_DUR, MAX_DUR: MAX_DUR };
})(window);
