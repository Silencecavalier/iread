/* ==========================================================================
   视频播放页（独立 UI）
   - 不占用阅读器：视频源 / 影视插件调 NR.video.open(...) 直接进这个页面
   - 播放器自己管：hls.js（m3u8）/ 原生（mp4）、断点续播、自动下一集、多线路
   - 交互惯例参考 Netflix / Disney+ / B 站：控件 3 秒淡出、大播放按钮、
     进度条悬停放大并显示时间气泡、双击全屏、键盘快捷键
   ========================================================================== */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var el = null, built = false;
  var store = null;          /* 断点续播：{ [key]: {lineIdx,index,t,at} } */
  var STORE_KEY = 'ui_vresume';
  var LEGACY_KEY = 'nr_vresume';

  var S = {
    mpvMode: false,
    mpvTimer: null,
    mpvBarH: 76, mpvFull: false,                  /* 运行时状态（探针可读） */
    open: false,
    title: '',
    lines: [],
    lineIdx: 0,
    index: 0,
    playing: false,
    duration: 0,
    current: 0,
    error: '',
    hls: null,
    url: '',
    key: '',
    bookUrl: '',
    sourceName: '',
    intro: '',
    poster: '',
    locked: false,
    adBlocks: 0,
    adSec: 0
  };

  var dom = {};
  var hideTimer = 0;
  var tickTimer = 0;
  var resumeTimer = 0;
  var lockTimer = 0;
  /* 进度条拖动（timeupdate 里要判断，所以放模块级） */
  var dragging = false, dragRatio = 0, pendingRatio = null;
  /* 长按快进 */
  var lpTimer = 0, lpFired = false, lpBaseRate = 1, suppressTap = false;

  /* ---------- 小工具 ---------- */
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  function fmt(t) {
    t = Math.max(0, Math.floor(Number(t) || 0));
    var hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    var mm2 = hh ? ('0' + mm).slice(-2) : String(mm);
    return (hh ? hh + ':' : '') + mm2 + ':' + ('0' + ss).slice(-2);
  }
  function readStore() {
    if (store) return store;
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      if (raw === null) {
        /* 旧版把续播位置存在 nr_vresume（nr_ 前缀归 NR.store 管，会跟数据库打架），
           这里搬一次到自己的键，然后把旧键清掉，避免每次启动都报「存储冲突」。 */
        raw = global.localStorage.getItem(LEGACY_KEY);
        if (raw !== null) {
          try { global.localStorage.setItem(STORE_KEY, raw); } catch (e) { }
          try { global.localStorage.removeItem(LEGACY_KEY); } catch (e) { }
        }
      }
      store = JSON.parse(raw || '{}') || {};
    } catch (e) { store = {}; }
    return store;
  }
  function writeStore() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(store || {})); } catch (e) { }
  }
  function keyOf(o) {
    return String(o.bookUrl || o.title || 'untitled').slice(0, 160);
  }
  function hostOfUrl(u) {
    try { return new URL(u).hostname; } catch (e) { return String(u).split('/')[2] || ''; }
  }
  function isHlsUrl(u) { return /\.m3u8(\?|#|$)/i.test(String(u)); }
  /* 直链判定：WebView2 的 <video> 只吃 m3u8/mp4/webm，但宿主内置 mpv 能吃 mkv/avi/ts 等容器，
     所以这些扩展名也算直链；真正走哪条路在下面按 S.forceMpv 分流。 */
  function isDirect(u) { return /\.(m3u8|mp4|m4v|webm|mkv|avi|ts|flv|m2ts|mov)(\?|#|$)/i.test(String(u)); }

  /* 手机（≤760px）判定：决定隐藏延迟、选集开合等小交互 */
  function isMobile() {
    return global.innerWidth <= 760 ||
      (global.matchMedia && global.matchMedia('(max-width:760px)').matches);
  }

  /* 全屏时的屏幕方向：跟视频自己的宽高走（竖版短剧就竖屏、横版影视才转横屏），
     安卓壳提供 setOrientation，桌面壳没有就静默跳过 */
  function setOrient(mode) {
    try {
      if (global.yedu && typeof global.yedu.setOrientation === 'function') {
        global.yedu.setOrientation(mode || 'auto');
      }
    } catch (e) { }
  }

  function fullscreenOrient() {
    var v = dom && dom.video;
    var w = v && Number(v.videoWidth) || 0;
    var h = v && Number(v.videoHeight) || 0;
    if (w > 0 && h > 0) return w >= h ? 'landscape' : 'portrait';
    // 元数据还没到：按当前窗口形状猜
    return global.innerWidth > global.innerHeight ? 'landscape' : 'portrait';
  }

  /* ---------- 构建 DOM ---------- */
  function build() {
    if (built) return;
    el = function (id) { return document.getElementById(id); };
    var app = el('app') || document.body;

    var view = h('section', 'view hidden');
    view.id = 'videoView';

    /* 顶栏 */
    var top = h('div', 'vv-top');
    var back = h('button', 'vv-back');
    back.type = 'button';
    back.title = '返回（Esc）';
    back.innerHTML = svg('<path d="M15 5l-7 7 7 7"/>');
    back.onclick = function () { close(); };
    var titles = h('div', 'vv-titles');
    var ttl = h('h1', 'vv-title', '');
    var sub = h('div', 'vv-sub', '');
    titles.appendChild(ttl); titles.appendChild(sub);

    /* 顶栏右侧动作：加入书架 / 切换线路（播放页里就能做，不必退回详情页） */
    var acts = h('div', 'vv-acts');
    var btnSave = h('button', 'vv-topbtn');
    btnSave.type = 'button';
    btnSave.title = '加入书架';
    btnSave.innerHTML = svg('<path d="M6 4h12v17l-6-4-6 4z"/>') + '<span>书架</span>';
    var btnLine = h('button', 'vv-topbtn');
    btnLine.type = 'button';
    btnLine.title = '切换线路';
    btnLine.innerHTML = svg('<path d="M4 7h10a4 4 0 010 8H8"/><path d="M7 4L4 7l3 3"/><path d="M17 17l3-2-3-3"/>') + '<span>线路</span>';
    acts.appendChild(btnSave); acts.appendChild(btnLine);

    top.appendChild(back); top.appendChild(titles); top.appendChild(acts);

    /* 主体 */
    var body = h('div', 'vv-body');

    var stage = h('div', 'vv-stage');
    var video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'metadata');
    video.controls = false;
    stage.appendChild(video);

    var poster = h('div', 'vv-poster is-gone');
    stage.appendChild(poster);

    var bigplay = h('button', 'vv-bigplay');
    bigplay.type = 'button';
    bigplay.innerHTML = svg('<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>');
    bigplay.onclick = function () { togglePlay(); };
    stage.appendChild(bigplay);

    var status = h('div', 'vv-status is-hidden');
    stage.appendChild(status);

    var resumeBox = h('div', 'vv-resume is-hidden');
    stage.appendChild(resumeBox);

    var nextBox = h('div', 'vv-next is-hidden');
    stage.appendChild(nextBox);

    /* 长按快进时的角标 */
    var rateTip = h('div', 'vv-rate is-hidden');
    stage.appendChild(rateTip);

    /* 锁定小锁：锁住后点屏幕只唤它，点它解锁 */
    var lockBtn = h('button', 'vv-lock is-hidden');
    lockBtn.type = 'button';
    lockBtn.title = '解锁';
    lockBtn.innerHTML = svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>');
    stage.appendChild(lockBtn);

    /* 控制条 */
    var ctrl = h('div', 'vv-ctrl');
    var seek = h('div', 'vv-seek');
    var track = h('div', 'vv-seek__track');
    var buf = h('div', 'vv-seek__buf');
    var fill = h('div', 'vv-seek__fill');
    var knob = h('div', 'vv-seek__knob');
    var tip = h('div', 'vv-tip', '0:00');
    track.appendChild(buf); track.appendChild(fill);
    seek.appendChild(track); seek.appendChild(knob); seek.appendChild(tip);

    var bar = h('div', 'vv-bar');
    var btnPlay = h('button', 'vv-btn');
    btnPlay.type = 'button'; btnPlay.title = '播放/暂停（空格）';
    var btnPrev = h('button', 'vv-btn');
    btnPrev.type = 'button'; btnPrev.title = '上一集';
    btnPrev.innerHTML = svg('<path d="M19 6v12L9 12l10-6z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>');
    var btnNext = h('button', 'vv-btn');
    btnNext.type = 'button'; btnNext.title = '下一集（N）';
    btnNext.innerHTML = svg('<path d="M5 6v12l10-6L5 6z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>');
    var time = h('div', 'vv-time');

    var volBox = h('div', 'vv-vol');
    var btnMute = h('button', 'vv-btn');
    btnMute.type = 'button'; btnMute.title = '静音（M）';
    var vol = document.createElement('input');
    vol.className = 'vv-vol__range';
    vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.02'; vol.value = '1';
    volBox.appendChild(btnMute); volBox.appendChild(vol);

    var spacer = h('div', 'vv-spacer');
    var btnSpeed = h('button', 'vv-btn is-text', '1.0x');
    btnSpeed.type = 'button'; btnSpeed.title = '倍速';
    var btnSide = h('button', 'vv-btn');
    btnSide.type = 'button'; btnSide.title = '选集（C）';
    btnSide.innerHTML = svg('<path d="M4 6h16M4 12h16M4 18h10"/>');
    var btnPip = h('button', 'vv-btn');
    btnPip.type = 'button'; btnPip.title = '画中画';
    btnPip.innerHTML = svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/>');
    var btnFull = h('button', 'vv-btn');
    btnFull.type = 'button'; btnFull.title = '全屏（F）';
    btnFull.innerHTML = svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>');
    var btnLock = h('button', 'vv-btn vv-btn--lock');
    btnLock.type = 'button'; btnLock.title = '锁定屏幕（点屏幕不再弹控制栏）';
    btnLock.innerHTML = svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>');

    bar.appendChild(btnPlay); bar.appendChild(btnPrev); bar.appendChild(btnNext);
    bar.appendChild(time); bar.appendChild(volBox); bar.appendChild(spacer);
    bar.appendChild(btnLock);
    bar.appendChild(btnPip); bar.appendChild(btnFull);

    var menu = h('div', 'vv-menu');
    ctrl.appendChild(seek); ctrl.appendChild(bar); ctrl.appendChild(menu);
    stage.appendChild(ctrl);

    /* 选集侧栏 */
    var side = h('div', 'vv-side');
    var shead = h('div', 'vv-side__head');
    var stitle = h('div', 'vv-side__title');
    var smeta = h('div', 'vv-side__meta', '');
    var srow = h('div', 'vv-side__row');
    var btnBack = h('button', 'vv-side__back');
    btnBack.type = 'button';
    btnBack.title = '收起选集（C）';
    btnBack.innerHTML = svg('<path d="M14 6l-6 6 6 6"/>') + '<span>收起</span>';
    srow.appendChild(stitle); srow.appendChild(btnBack);
    shead.appendChild(srow); shead.appendChild(smeta);
    var linesRow = h('div', 'vv-lines');
    var epsBox = h('div', 'vv-eps');
    var sfoot = h('div', 'vv-side__foot');
    var btnPrev2 = h('button', '', '上一集');
    var btnNext2 = h('button', '', '下一集');
    sfoot.appendChild(btnPrev2); sfoot.appendChild(btnNext2);
    side.appendChild(shead); side.appendChild(linesRow); side.appendChild(epsBox); side.appendChild(sfoot);

    body.appendChild(stage);
    view.appendChild(top); view.appendChild(body);

    var root = el('app') || document.body;
    root.appendChild(view);

    dom = {
      view: view, top: top, body: body, stage: stage, video: video, poster: poster,
      bigplay: bigplay, status: status, resume: resumeBox, next: nextBox,
      ctrl: ctrl, seek: seek, buf: buf, fill: fill, knob: knob, tip: tip,
      bar: bar, btnPlay: btnPlay, btnPrev: btnPrev, btnNext: btnNext, time: time,
      btnMute: btnMute, vol: vol, btnSpeed: btnSpeed, btnSide: btnSide,
      btnPip: btnPip, btnFull: btnFull, btnLock: btnLock, menu: menu,
      lock: lockBtn, rate: rateTip, acts: acts, btnSave: btnSave, btnLine: btnLine,
      side: side, stitle: stitle, smeta: smeta, linesRow: linesRow, eps: epsBox,
      btnBack: btnBack,
      btnPrev2: btnPrev2, btnNext2: btnNext2, title: ttl, sub: sub
    };

    bindEvents();
    built = true;
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    var v = dom.video;

    /* 点画面只唤起 / 收起控制栏，绝不碰播放状态（暂停只认控制栏那个小三角）。
       控件、选集、按钮上的点击一律不参与。 */
    /* 绑在舞台上而不是 video 上：缓冲/海报/状态遮罩盖住画面时，点一下也要能切换控制栏 */
    dom.stage.addEventListener('click', function (e) { onStageTap(e); });
    v.addEventListener('dblclick', function () { if (!isMobile()) toggleFull(); });
    /* 长按画面 = 3 倍速快进（松手复位），拖动进度条/点按钮都不算 */
    dom.stage.addEventListener('pointerdown', stagePressStart);
    dom.stage.addEventListener('pointerup', stagePressEnd);
    dom.stage.addEventListener('pointercancel', stagePressEnd);
    dom.stage.addEventListener('pointerleave', stagePressEnd);
    v.addEventListener('play', function () { S.playing = true; paintPlayBtn(); wake(); });
    v.addEventListener('pause', function () { S.playing = false; paintPlayBtn(); wake(true); });
    v.addEventListener('timeupdate', function () {
      S.current = v.currentTime || 0;
      if (dragging) { paintSeek(dragRatio); paintTime(dragRatio * (S.duration || 0)); return; }
      if (pendingRatio != null) {
        var want = pendingRatio * (S.duration || 0);
        if (!S.duration || Math.abs(S.current - want) < 1.2) { pendingRatio = null; paintSeek(); paintTime(); return; }
        paintSeek(pendingRatio); paintTime(want);
        return;
      }
      paintSeek(); paintTime();
    });
    v.addEventListener('seeked', function () { if (!dragging) { pendingRatio = null; paintSeek(); paintTime(); } });
    v.addEventListener('durationchange', function () { S.duration = v.duration || 0; paintSeek(); paintTime(); });
    v.addEventListener('progress', paintBuf);
    v.addEventListener('waiting', function () { showStatus('正在缓冲…', true); });
    v.addEventListener('playing', function () { hideStatus(); hidePoster(); S.error = ''; });
    v.addEventListener('canplay', function () { hideStatus(); });
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', function () {
      var code = v.error ? v.error.code : 0;
      S.error = '播放失败（' + code + '）';
      showStatus('这条线路播不了（错误码 ' + code + '），换一条线路或下一集试试。', false);
    });

    dom.bigplay.addEventListener('click', function () { togglePlay(); });
    dom.btnPlay.onclick = function () { togglePlay(); };
    dom.btnPrev.onclick = function () { step(-1); };
    dom.btnNext.onclick = function () { step(1); };
    dom.btnPrev2.onclick = function () { step(-1); };
    dom.btnNext2.onclick = function () { step(1); };
    dom.btnMute.onclick = function () {
      dom.video.muted = !dom.video.muted;
      dom.vol.value = dom.video.muted ? 0 : (dom.video.volume || 1);
      paintVolBtn();
      if (S.mpvMode) {
        var Mm = mpvApi();
        if (Mm) Mm.cmd(['set_property', 'mute', !!dom.video.muted]);
      }
    };
    dom.vol.oninput = function () {
      dom.video.volume = Number(dom.vol.value);
      dom.video.muted = Number(dom.vol.value) <= 0.001;
      paintVolBtn();
      if (S.mpvMode) {
        var Mv = mpvApi();
        if (Mv) {
          Mv.cmd(['set_property', 'volume', Math.round(Number(dom.vol.value) * 100)]);
          Mv.cmd(['set_property', 'mute', Number(dom.vol.value) <= 0.001]);
        }
      }
    };
    dom.btnSpeed.onclick = function (e) {
      e.stopPropagation();
      toggleMenu('rate');
    };
    dom.btnLine.onclick = function (e) {
      e.stopPropagation();
      if (S.lines.length < 2) { toast('这个片子只有一条线路'); return; }
      toggleMenu('line');
    };
    dom.btnSave.onclick = function (e) {
      e.stopPropagation();
      addToShelf();
    };
    dom.btnLock.onclick = function (e) {
      e.stopPropagation();
      setLock(true);
    };
    dom.lock.onclick = function (e) {
      e.stopPropagation();
      setLock(false);
    };
    dom.btnSide.onclick = function () {
      dom.body.classList.toggle('is-side-off');
      setTimeout(paintSeek, 240);
      /* mpv 模式：选集抽屉要把 WebView2 临时铺满窗口，否则只有 76px 条带，抽屉看不见 */
      if (S.mpvMode) {
        var Ms = mpvApi();
        if (Ms && Ms.layout) Ms.layout(dom.body.classList.contains('is-side-off') ? S.mpvBarH : 0);
      }
    };
    dom.btnBack.onclick = function () { closeSide(); };
    /* 点舞台空白处也能收起选集 */
    dom.stage.addEventListener('click', function (e) {
      if (e.target === dom.stage && sideOpen()) closeSide();
    });
    /* 手机：在抽屉头部 / 线路条上向下滑超过 60px 关闭选集抽屉 */
    var sideTouchY = null;
    dom.side.addEventListener('touchstart', function (e) {
      if (!isMobile()) return;
      var t = e.target;
      if (t && t.closest && t.closest('.vv-side__head, .vv-lines')) {
        sideTouchY = e.touches[0].clientY;
      } else { sideTouchY = null; }
    }, { passive: true });
    dom.side.addEventListener('touchend', function (e) {
      if (sideTouchY == null) return;
      var dy = e.changedTouches[0].clientY - sideTouchY;
      sideTouchY = null;
      if (dy > 60 && sideOpen()) closeSide();
    }, { passive: true });
    dom.btnFull.onclick = function () { toggleFull(); };
    dom.btnPip.onclick = function () {
      var v = dom.video;
      try {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else if (v.requestPictureInPicture) { var pp = v.requestPictureInPicture(); if (pp && pp.catch) pp.catch(function () { }); }
      } catch (e) { toast('这个视频不支持画中画'); }
    };

    /* 进度条：按下即跟手（拖动时只改显示，松手才真正 seek）。
       旧版每移动一次就写 video.currentTime，同时 timeupdate 又把显示拉回真实播放点，
       于是「拖了不跟手、还乱跳」——现在拖动期间由 dragRatio 全权驱动显示。 */
    function seekRatio(ev) {
      var r = dom.seek.getBoundingClientRect();
      return Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
    }
    function tipAt(r) {
      dom.tip.style.left = (r * 100) + '%';
      dom.tip.textContent = fmt(r * (S.duration || 0));
      dom.tip.classList.add('is-on');
    }
    function dragTo(ev) {
      dragRatio = seekRatio(ev);
      paintSeek(dragRatio);
      paintTime(dragRatio * (S.duration || 0));
      tipAt(dragRatio);
    }
    dom.seek.addEventListener('pointerdown', function (ev) {
      if (!S.duration) return;
      dragging = true;
      pendingRatio = null;
      dom.seek.classList.add('is-drag');
      try { dom.seek.setPointerCapture(ev.pointerId); } catch (e) { }
      dragTo(ev);
      ev.preventDefault();
    });
    dom.seek.addEventListener('pointermove', function (ev) {
      if (!S.duration) return;
      if (dragging) { dragTo(ev); return; }
      /* 没按下的悬停：只给时间提示，不动进度 */
      var r = seekRatio(ev);
      dom.tip.style.left = (r * 100) + '%';
      dom.tip.textContent = fmt(r * S.duration);
      dom.tip.classList.add('is-on');
    });
    function endDrag(ev) {
      if (!dragging || !S.duration) return;
      if (ev && typeof ev.clientX === 'number') dragTo(ev);
      dragging = false;
      dom.seek.classList.remove('is-drag');
      pendingRatio = dragRatio;
      var want = dragRatio * S.duration;
      S.current = want;
      if (S.mpvMode) {
        var Ms = mpvApi();
        if (Ms) Ms.cmd(['seek', want, 'absolute']);
      } else {
        try { dom.video.currentTime = want; } catch (e) { }
      }
      paintSeek(pendingRatio);
      paintTime(want);
      dom.tip.classList.remove('is-on');
      setTimeout(function () { if (!dragging) { pendingRatio = null; paintSeek(); paintTime(); } }, 1200);
    }
    dom.seek.addEventListener('pointerup', endDrag);
    dom.seek.addEventListener('pointercancel', endDrag);
    dom.seek.addEventListener('pointerleave', function () {
      if (!dragging) dom.tip.classList.remove('is-on');
    });

    /* 鼠标 / 键盘唤醒控件 */
    dom.stage.addEventListener('mouseleave', function () { if (Date.now() - lastTouchAt < 900) return; if (S.playing) sleep(); });
    /* 手指点击时浏览器会补一个 mousemove，不能让它把控制栏又唤出来（否则一点等于「唤出+收起」） */
    dom.view.addEventListener('touchstart', function () { lastTouchAt = Date.now(); }, true);
    dom.view.addEventListener('mousemove', function () {
      if (Date.now() - lastTouchAt < 900) return;
      wake();
    });

    document.addEventListener('keydown', onKey);
    global.addEventListener('resize', function () { paintSeek(); });
    document.addEventListener('click', function () {
      if (dom.menu.classList.contains('is-open')) dom.menu.classList.remove('is-open');
    });
  }

  function onKey(ev) {
    if (!S.open) return;
    var tag = (ev.target && ev.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    var k = ev.key.toLowerCase();
    var v = dom.video;
    if (k === ' ' || k === 'k') { ev.preventDefault(); togglePlay(); }
    else if (k === 'arrowright') { ev.preventDefault(); v.currentTime = Math.min(S.duration || 1e9, (v.currentTime || 0) + (ev.shiftKey ? 60 : 10)); wake(); }
    else if (k === 'arrowleft') { ev.preventDefault(); v.currentTime = Math.max(0, (v.currentTime || 0) - (ev.shiftKey ? 60 : 10)); wake(); }
    else if (k === 'arrowup') { ev.preventDefault(); v.volume = Math.min(1, (v.volume || 0) + 0.1); dom.vol.value = v.volume; paintVolBtn(); wake(); }
    else if (k === 'arrowdown') { ev.preventDefault(); v.volume = Math.max(0, (v.volume || 0) - 0.1); dom.vol.value = v.volume; paintVolBtn(); wake(); }
    else if (k === 'm') { dom.btnMute.onclick(); }
    else if (k === 'f') { toggleFull(); }
    else if (k === 'n') { step(1); }
    else if (k === 'c') { /* 选集已移除 */ }
    else if (k === 'escape') {
      if (isFull()) toggleFull();
      else close();
    }
  }

  /* ---------- 控件小状态 ---------- */
  function paintPlayBtn() {
    var p = '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
    var s = '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>';
    dom.btnPlay.innerHTML = svg(S.playing ? s : p);
    dom.bigplay.classList.toggle('is-hidden', S.playing);
  }
  function paintSeek(ratio) {
    var d = S.duration || 0;
    var pct;
    if (typeof ratio === 'number') pct = Math.max(0, Math.min(100, ratio * 100));
    else pct = d ? Math.min(100, ((S.current || 0) / d) * 100) : 0;
    dom.fill.style.width = pct + '%';
    dom.knob.style.left = pct + '%';
  }
  function paintBuf() {
    var v = dom.video;
    try {
      if (v.buffered && v.buffered.length && S.duration) {
        var end = v.buffered.end(v.buffered.length - 1);
        dom.buf.style.width = Math.min(100, (end / S.duration) * 100) + '%';
      }
    } catch (e) { }
  }
  function paintTime(cur) {
    var c = typeof cur === 'number' ? cur : (S.current || 0);
    dom.time.innerHTML = fmt(c) + ' <i>/ ' + fmt(S.duration) + '</i>';
  }
  function paintVolBtn() {
    var v = dom.video;
    var mute = v.muted || (v.volume || 0) <= 0.001;
    dom.btnMute.innerHTML = svg(mute
      ? '<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M17 9l4 6M21 9l-4 6"/>'
      : '<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none"/><path d="M16 8.5a4.5 4.5 0 010 7"/><path d="M19 6a8 8 0 010 12"/>');
  }
  /* 一个小菜单两用：kind='rate' 倍速、kind='line' 切线路 */
  /* mpv 模式下弹菜单：先把 WebView2 撑满，菜单才看得见；关菜单再收回底部一条 */
  function mpvMenuLayout(open) {
    if (!S.mpvMode) return;
    var M = mpvApi();
    if (M && M.layout) { try { M.layout(open ? 0 : S.mpvBarH); } catch (e) {} }
  }

  function toggleMenu(kind) {
    kind = kind || 'rate';
    var isOpen = dom.menu.classList.contains('is-open') && dom.menu.getAttribute('data-kind') === kind;
    dom.menu.innerHTML = '';
    dom.menu.setAttribute('data-kind', kind);
    if (kind === 'line') {
      S.lines.forEach(function (ln, i) {
        var b = h('button', '');
        var here = i === S.lineIdx;
        b.innerHTML = '<span>' + (ln.from || ('线路' + (i + 1))) + '（' + ln.eps.length + '）</span><span>' + (here ? '✓' : '') + '</span>';
        if (here) b.className = 'is-on';
        b.onclick = function (e) {
          e.stopPropagation();
          dom.menu.classList.remove('is-open');
          mpvMenuLayout(false);
          if (!here) switchLine(i);
        };
        dom.menu.appendChild(b);
      });
    } else {
      [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3].forEach(function (r) {
        var b = h('button', '');
        b.innerHTML = '<span>' + r.toFixed(2).replace(/0$/, '') + 'x</span><span>' +
          (Math.abs((dom.video.playbackRate || 1) - r) < 0.001 ? '✓' : '') + '</span>';
        if (Math.abs((dom.video.playbackRate || 1) - r) < 0.001) b.className = 'is-on';
        b.onclick = function (e) {
          e.stopPropagation();
          if (S.mpvMode) {
            var Mr = mpvApi();
            if (Mr) Mr.cmd(['set_property', 'speed', r]);
          } else {
            dom.video.playbackRate = r;
          }
          S.rate = r;
          if (dom.btnSpeed) dom.btnSpeed.textContent = r.toFixed(1).replace(/\.0$/, '') + 'x';
          dom.menu.classList.remove('is-open');
          mpvMenuLayout(false);
        };
        dom.menu.appendChild(b);
      });
    }
    dom.menu.classList.toggle('is-open', !isOpen);
    mpvMenuLayout(!isOpen);
  }

  /* ---------- 控制栏显隐 / 锁定 ---------- */
  function wake(sticky) {
    clearTimeout(hideTimer);
    if (S.locked) { showLock(); return; }   /* 锁定态：永远不弹控制栏 */
    dom.top.classList.remove('is-hidden');
    dom.ctrl.classList.remove('is-hidden');
    mpvBackSync(true);
    /* 手机上顶部标题栏 / 控制栏 2.5s 自动隐藏（桌面 3.2s 不变） */
    if (!sticky) hideTimer = setTimeout(sleep, isMobile() ? 2500 : 3200);
  }
  function sleep() {
    if (S.mpvMode) return;   /* mpv 模式下控制条常驻 */
    if (S.locked) return;
    if (!S.playing) return;
    if (dom.menu.classList.contains('is-open')) return;
    dom.top.classList.add('is-hidden');
    dom.ctrl.classList.add('is-hidden');
    mpvBackSync(false);
  }
  /* 立刻收起控制栏（不管在不在播放）；tap 用它做「再点一下收起」 */
  function hideCtrl() {
    clearTimeout(hideTimer);
    dom.menu.classList.remove('is-open');
    mpvMenuLayout(false);
    dom.top.classList.add('is-hidden');
    dom.ctrl.classList.add('is-hidden');
    mpvBackSync(false);
    if (S.locked) showLock();
  }
  function showLock() {
    dom.lock.classList.remove('is-hidden');
    clearTimeout(lockTimer);
    lockTimer = setTimeout(function () { if (S.locked) dom.lock.classList.add('is-hidden'); }, 2600);
  }
  function setLock(on) {
    S.locked = !!on;
    dom.lock.classList.toggle('is-locked', S.locked);
    if (S.locked) {
      hideCtrl();
      showLock();
    } else {
      dom.lock.classList.add('is-hidden');
      clearTimeout(lockTimer);
      wake();
    }
  }
  /* 长按快进的提示角标 */
  function showRateBubble(text) {
    dom.rate.textContent = text;
    dom.rate.classList.remove('is-hidden');
  }
  function hideRateBubble() { dom.rate.classList.add('is-hidden'); }
  function stagePressStart(e) {
    var t = e.target;
    if (t && t.closest && t.closest('.vv-ctrl, .vv-side, .vv-top, .vv-menu, .vv-lock, button, input')) return;
    if (S.locked || !S.open || !S.url) return;
    try { dom.stage.setPointerCapture(e.pointerId); } catch (err) { }
    lpFired = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(function () {
      if (!S.open || !S.url) return;
      lpFired = true;
      lpBaseRate = dom.video.playbackRate || 1;
      try { dom.video.playbackRate = 3; } catch (err) { }
      if (dom.video.paused) tryPlay();
      showRateBubble('⏩ 3× 快进中');
    }, 480);
  }
  function stagePressEnd() {
    clearTimeout(lpTimer);
    lpTimer = 0;
    if (!lpFired) return;
    lpFired = false;
    suppressTap = true;                       /* 松手后紧跟的 click 不要当成单击 */
    try { dom.video.playbackRate = lpBaseRate; } catch (e) { }
    hideRateBubble();
  }
  function showStatus(text, spin) {
    dom.status.innerHTML = '';
    if (spin) dom.status.appendChild(h('div', 'vv-spin'));
    dom.status.appendChild(h('div', 'vv-status__text', text));
    if (!spin) {
      var acts = h('div', 'vv-status__acts');
      var b1 = h('button', 'vv-btn is-text', '重试');
      b1.onclick = function () { load(S.lineIdx, S.index, S.current); };
      var b2 = h('button', 'vv-btn is-text', '换线路');
      b2.onclick = function () { nextPlayableLine(); };
      acts.appendChild(b1); acts.appendChild(b2);
      dom.status.appendChild(acts);
    }
    dom.status.classList.remove('is-hidden');
  }
  function hideStatus() { dom.status.classList.add('is-hidden'); }
  function hidePoster() { dom.poster.classList.add('is-gone'); }
  function toast(msg) {
    if (NR.plugins && NR.plugins.toastAny) { try { NR.plugins.toastAny(msg); return; } catch (e) { } }
    showStatus(msg, false);
  }

  /* ---------- 播放 ---------- */
  function currentLine() { return S.lines[S.lineIdx] || null; }
  function currentEp() {
    var ln = currentLine();
    return ln && ln.eps ? (ln.eps[S.index] || null) : null;
  }

  /* ---------- 画面锐化（+20%）----------
     3x3 卷积核 [0,-0.2,0; -0.2,1.8,-0.2; 0,-0.2,0]，只提边缘、不动色彩；
     比单纯加对比度干净，也不像 CSS unsharp 那样把暗部糊成噪点。 */
  var SHARPEN_ID = 'vvSharpen20';
  function ensureSharpenDefs() {
    if (!el || !el('vvSharpenDefs')) {
      var host = document.getElementById('vvSharpenDefs');
      if (host) return host;
    }
    var host = document.getElementById('vvSharpenDefs');
    if (host) return host;
    var wrap = document.createElement('div');
    wrap.id = 'vvSharpenDefs';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    wrap.innerHTML = '<svg width="0" height="0" focusable="false">' +
      '<filter id="' + SHARPEN_ID + '" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
      '<feConvolveMatrix order="3" preserveAlpha="true" divisor="1" bias="0" ' +
      'kernelMatrix="0 -0.2 0 -0.2 1.8 -0.2 0 -0.2 0"/></filter></svg>';
    (document.body || document.documentElement).appendChild(wrap);
    return wrap;
  }
  function sharpenOn() {
    try { var st = NR.settings ? NR.settings() : null; return !st || st.videoSharpen !== false; } catch (e) { return true; }
  }
  function applySharpen() {
    if (!dom.video) return;
    if (!sharpenOn()) { dom.video.style.filter = ''; return; }
    ensureSharpenDefs();
    dom.video.style.filter = 'url(#' + SHARPEN_ID + ')';
  }

  /* ---------- 广告块剔除（m3u8 播放列表级）----------
     魔都系把广告段放在另一个目录（日期不同 + 码率目录固定 10134kb）并用独立 KEY、
     前后各一个 DISCONTINUITY 夹住，实测每块恒为 17.6 秒；adskip.js 负责判定与重写。 */
  function adLoaderClass() {
    var H = global.Hls;
    if (!H || !NR.adskip) return null;
    var Base = (H.DefaultConfig && H.DefaultConfig.loader) || H.Loader;
    if (!Base || !Base.prototype || !Base.prototype.load) return null;
    function L(cfg) { Base.call(this, cfg); }
    L.prototype = Object.create(Base.prototype);
    L.prototype.constructor = L;
    L.prototype.load = function (ctx, config, callbacks) {
      var url = String((ctx && ctx.url) || '');
      var type = String((ctx && ctx.type) || '');
      var want = type === 'manifest' || type === 'level' || /\.m3u8(\?|#|$)/i.test(url);
      var enabled = true;
      try { enabled = !(NR.settings && NR.settings().adSkip === false); } catch (e) { }
      if (!want || !enabled) return Base.prototype.load.call(this, ctx, config, callbacks);
      var ok = callbacks && callbacks.onSuccess;
      if (ok) {
        callbacks.onSuccess = function (res, stats, context, xhr) {
          try {
            if (res && typeof res.data === 'string' && res.data.indexOf('#EXTM3U') >= 0) {
              var out = NR.adskip.rewrite(res.data, (context && context.url) || url);
              if (out.removed && out.removed.length) {
                S.adBlocks += out.removed.length;
                S.adSec = Math.round((S.adSec + out.savedSec) * 10) / 10;
                res.data = out.text;
              }
            }
          } catch (e) { }
          return ok(res, stats, context, xhr);
        };
      }
      return Base.prototype.load.call(this, ctx, config, callbacks);
    };
    return L;
  }

  function destroyHls() {
    if (S.hls) { try { S.hls.destroy(); } catch (e) { } S.hls = null; }
  }

  /* HEVC/H.265 这类浏览器解不了的编码：<video> 只有声音、videoWidth 恒为 0。
     用事件驱动判断（loadedmetadata / timeupdate / 3.5s 兜底），命中就转交宿主的
     内置播放器（mpv），播完回到原来的页面。 */
  function armCodecWatch(url) {
    disarmCodecWatch();
    var v = dom.video;
    var fired = false;
    function go(reason) {
      if (fired || !S.open) return;
      if (!v || Number(v.videoWidth) > 0) return;
      fired = true;
      try { (global.__cwVv = global.__cwVv || []).push(reason); } catch (e) { }
      var M = global.NR && global.NR.mpv;
      if (M && M.supported && M.supported()) { useMpv(url); return; }
      if (v && v.error) showStatus('这条线路播不了（编码不支持），换一条线路试试。', false);
    }
    function onMeta() { if (Number(v.videoWidth) === 0) setTimeout(function () { go('meta'); }, 300); }
    function onTime() {
      if (Number(v.readyState) >= 2 && Number(v.currentTime) > 1.5 && Number(v.videoWidth) === 0) go('timeupdate');
    }
    function onErr() { go('error'); }
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('error', onErr);
    S.codecTimer = setTimeout(function () {
      if (Number(v.readyState) >= 2 && Number(v.videoWidth) === 0) go('timeout');
    }, 4000);
    S.codecCleanup = function () {
      clearTimeout(S.codecTimer);
      try { v.removeEventListener('loadedmetadata', onMeta); } catch (e) { }
      try { v.removeEventListener('timeupdate', onTime); } catch (e) { }
      try { v.removeEventListener('error', onErr); } catch (e) { }
      S.codecCleanup = null;
    };
  }

  function disarmCodecWatch() {
    if (S.codecCleanup) { try { S.codecCleanup(); } catch (e) { } }
    clearTimeout(S.codecTimer);
  }

  /* ---- 内置 mpv 播放器模式 ----
     视频由宿主的 mpv 画在上面，宿主把 WebView2 缩成底部一条，
     这一条里画的就是我们原有的控制栏（播放/进度/倍速/选集/退出）。 */
  function mpvApi() {
    var M = global.NR && global.NR.mpv;
    return (M && M.supported && M.supported()) ? M : null;
  }

  /* mpv 模式下 WebView2 只剩底部一条，左上角返回键由宿主画（顶层半透明小窗），
     这里只负责让它跟控制栏一起显隐。 */
  function mpvBackSync(show) {
    if (!S.mpvMode) return;
    if (NR.mpv && NR.mpv.back) { try { NR.mpv.back(!!show); } catch (e) {} }
  }

  function enterMpvMode() {
    S.mpvMode = true;
    try { dom.view.classList.add('is-mpv'); } catch (e) { }
    /* 页面自绘的红黄绿窗口按钮是 position:fixed，mpv 模式下 WebView2 只剩底部一条，
       它会掉到进度条上；这时由宿主提供原生标题条，这里把网页那组藏掉。 */
    try { document.body.classList.add('mpv-mode'); } catch (e) { }
    try { dom.ctrl.classList.remove('is-hidden'); } catch (e) { }
    try { dom.seek.classList.remove('is-drag'); } catch (e) { }
    /* mpv 接管画面后，网页这层的缓冲提示 / 转圈圈就收掉，否则会压在下方的控制条上 */
    try { dom.status.classList.add('is-hidden'); } catch (e) { }
    paintPlayBtn();
  }

  function exitMpvMode() {
    try { if (NR.mpv && NR.mpv.back) NR.mpv.back(false); } catch (e) {}
    if (S.mpvFull) { S.mpvFull = false; try { if (NR.mpv && NR.mpv.full) NR.mpv.full(false); } catch (e) {} }
    paintFullBtn();
    S.mpvMode = false;
    if (S.mpvTimer) { clearInterval(S.mpvTimer); S.mpvTimer = null; }
    try { dom.view.classList.remove('is-mpv'); } catch (e) { }
    try { document.body.classList.remove('mpv-mode'); } catch (e) { }
  }

  function mpvPoll() {
    if (S.mpvTimer) clearInterval(S.mpvTimer);
    var M = mpvApi();
    if (!M) return;
    var n = 0;
    S.mpvTimer = setInterval(function () {
      if (!S.mpvMode) return;
      n++;
      M.cmd(['get_property', 'time-pos']).then(function (t) {
        if (!S.mpvMode) return;
        var cur = Number(t) || 0;
        if (n === 1) hideStatus();
        S.current = cur;
        if (n % 3 === 1) {
          M.cmd(['get_property', 'duration']).then(function (d) {
            var dur = Number(d) || 0;
            if (dur > 0) S.duration = dur;
            paintSeek(S.duration > 0 ? cur / S.duration : 0);
            paintTime(cur);
            M.cmd(['get_property', 'pause']).then(function (pz) {
              var paused = !!pz;
              if (paused !== !S.playing) { S.playing = !paused; paintPlayBtn(); }
            });
          });
        } else {
          paintSeek(S.duration > 0 ? cur / S.duration : 0);
          paintTime(cur);
        }
      });
    }, 500);
  }

  function mpvStart(url, startAt) {
    var M = mpvApi();
    if (!M) return false;
    enterMpvMode();
    M.onEnded(function () { if (S.mpvMode) { exitMpvMode(); close(); } });
    M.play(url, { title: S.title, start: startAt || 0, barHeight: S.mpvBarH }).then(function (r) {
      if (!r || !r.ok) {
        exitMpvMode();
        close();
        toast('内置播放器打不开：' + ((r && r.error) || '未知'));
        return;
      }
      S.playing = true;
      paintPlayBtn();
      mpvPoll();
      mpvBackSync(true);
    });
    return true;
  }

  function mpvJump(i) {
    var ln = currentLine();
    if (!ln || !ln.eps || !ln.eps.length) return;
    i = Math.max(0, Math.min(ln.eps.length - 1, Number(i) || 0));
    saveResume(true);
    S.index = i;
    var ep = ln.eps[i];
    S.url = String((ep && ep.url) || '');
    S.current = 0;
    var M = mpvApi();
    if (M) M.play(S.url, { title: S.title, start: 0, barHeight: S.mpvBarH });
    paintSeek(0); paintTime(0);
  }

  function mpvStep(delta) {
    var ln = currentLine();
    if (!ln) return;
    var next = S.index + delta;
    if (next < 0) { toast('已经是第一集了'); return; }
    if (next >= ln.eps.length) { toast('已经是最后一集了'); return; }
    mpvJump(next);
  }

  function useMpv(url) {
    var start = Number(dom.video.currentTime) || 0;
    try { dom.video.pause(); } catch (e) { }
    try { dom.video.removeAttribute('src'); dom.video.load(); } catch (e) { }
    showStatus('这个编码浏览器解不了，正在用内置播放器打开（首次使用要先下载播放器，约 45MB）…', true);
    if (!mpvStart(url, start > 1 ? start : 0)) {
      hideStatus();
      showStatus('这条线路播不了（编码不支持），换一条线路试试。', false);
    }
  }

  function load(lineIdx, index, startAt) {
    var ln = S.lines[lineIdx] || S.lines[0];
    if (!ln || !ln.eps || !ln.eps.length) { showStatus('这条线路没有可播的剧集。', false); return; }
    S.lineIdx = S.lines.indexOf(ln) >= 0 ? S.lines.indexOf(ln) : 0;
    S.index = Math.max(0, Math.min(ln.eps.length - 1, Number(index) || 0));
    var ep = ln.eps[S.index];
    var url = String((ep && ep.url) || '');
    S.url = url;
    S.error = '';
    S.current = Number(startAt) || 0;
    disarmCodecWatch();
    var MpvPrev = global.NR && global.NR.mpv;
    if (MpvPrev && MpvPrev.status && MpvPrev.status().on) { try { MpvPrev.stop(); } catch (e) { } }
    destroyHls();
    hideStatus();
    showStatus('正在连接「' + (ln.from || '线路') + '」…', true);
    paintSide();
    paintSub();

    var v = dom.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    dom.poster.classList.remove('is-gone');
    if (S.poster) dom.poster.style.backgroundImage = 'url("' + S.poster + '")';

    if (!isDirect(url)) {
      showStatus('这条线路给的是播放页（要解析接口才能出流），换一条线路吧。', false);
      return;
    }

    applySharpen();

    if (S.forceMpv && mpvApi()) { mpvStart(url, S.current); return; }

    var isHls = isHlsUrl(url);
    /* 需要 Referer 之类的站，交给宿主在 WebResourceRequested 里注入（浏览器禁设这些头） */
    if (S.headers && Object.keys(S.headers).length && NR.platform && NR.platform.mediaHeaders) {
      try { NR.platform.mediaHeaders([{ host: hostOfUrl(url), headers: S.headers }]); } catch (e) { }
    }

    if (isHls) {
      if (global.Hls && global.Hls.isSupported()) {
        var hlsOpts = { maxBufferLength: 30, enableWorker: true };
        var Ld = adLoaderClass();
        if (Ld) hlsOpts.pLoader = Ld;
        S.adBlocks = 0; S.adSec = 0;
        var hls = new global.Hls(hlsOpts);
        S.hls = hls;
        hls.on(global.Hls.Events.ERROR, function (_e, data) {
          if (!data || !data.fatal) return;
          S.error = 'HLS ' + (data.type || '') + ' ' + (data.details || '');
          if (data.type === global.Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); return; } catch (e) { } }
          showStatus('这条线路播不了（' + S.error + '），换一条线路试试。', false);
        });
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(global.Hls.Events.MANIFEST_PARSED, function () { tryPlay(); });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        tryPlay();
      } else {
        showStatus('这台机器不支持 HLS 播放。', false);
      }
    } else {
      v.src = url;
      tryPlay();
    }

    armCodecWatch(url);

    if (S.current > 0.5) {
      v.addEventListener('loadedmetadata', function once() {
        v.removeEventListener('loadedmetadata', once);
        try { v.currentTime = S.current; } catch (e) { }
      });
    }
  }

  /* 选集面板开合（宽屏是右侧栏，窄屏是底部抽屉） */
  function sideOpen() {
    if (!dom) return false;
    return !dom.body.classList.contains('is-side-off');
  }
  function openSide() {
    if (!dom) return;
    if (S.mpvMode) { var Mo = mpvApi(); if (Mo && Mo.layout) Mo.layout(0); }
    dom.body.classList.remove('is-side-off');
    setTimeout(paintSeek, 240);
  }
  function closeSide() {
    if (!dom) return;
    if (S.mpvMode) { var Mc = mpvApi(); if (Mc && Mc.layout) Mc.layout(S.mpvBarH); }
    dom.body.classList.add('is-side-off');
    setTimeout(paintSeek, 240);
    wake(true);
  }

  function tryPlay() {
    var v = dom.video;
    var p = v.play();
    if (p && p.catch) {
      p.catch(function () {
        /* 自动播放被拦：显示大播放按钮，等用户点 */
        S.playing = false; paintPlayBtn(); wake(true);
      });
    }
  }

  var lastTapEvent = null, lastTapAt = 0, lastTouchAt = 0;
  function ctrlHidden() { return dom.ctrl.classList.contains('is-hidden'); }

  /* 画面上的点击统一在这里判定，控件区 / 选集 / 按钮上的点击直接放行。
     规矩：单击只唤起 / 收起控制栏，绝不暂停；暂停只认控制栏的小三角。 */
  function onStageTap(e) {
    var t = e.target;
    if (t && t.closest && t.closest('.vv-ctrl, .vv-side, .vv-top, .vv-menu, .vv-resume, .vv-next, .vv-lock, button, input')) return;
    if (suppressTap) { suppressTap = false; return; }   /* 刚长按完，松手那一下不算单击 */
    if (S.locked) { showLock(); return; }               /* 锁定态：只闪小锁 */
    if (sideOpen()) { closeSide(); return; }
    /* 手机一次点按可能派发两个 click（touch + 兼容鼠标），时间窗内只认一次 */
    var now = Date.now();
    if (e === lastTapEvent || now - lastTapAt < 260) return;
    lastTapEvent = e;
    lastTapAt = now;
    if (ctrlHidden()) wake(); else hideCtrl();
  }

  /* 切线路：优先停在「同名的那一集」，找不到就按同样的序号 */
  function switchLine(i) {
    var target = S.lines[i];
    if (!target) return;
    saveResume(true);
    var epName = currentEp() ? currentEp().t : '';
    var j = 0, found = false;
    for (var k = 0; k < target.eps.length; k++) {
      if (epName && target.eps[k].t === epName) { j = k; found = true; break; }
    }
    if (!found) j = Math.max(0, Math.min(target.eps.length - 1, S.index));
    load(i, j, 0);
  }

  /* 加入书架：交给主程序落库（books 里存线路结构，书架点开直接回到播放页） */
  function addToShelf() {
    var api = global.NR;
    if (!api || typeof api.addVideoBook !== 'function') return;
    if (!S.lines.length) return;
    var cur = dom.video && dom.video.currentTime || 0;
    try {
      Promise.resolve(api.addVideoBook({
        title: S.title,
        intro: S.intro,
        coverUrl: S.poster,
        sourceName: S.sourceName,
        bookUrl: S.bookUrl || S.key,
        lines: S.lines,
        lineIdx: S.lineIdx,
        index: S.index,
        current: cur
      })).then(function (r) {
      }).catch(function (err) {
        console.warn('[video] 加入书架失败', err);
      });
    } catch (err) {
      console.warn('[video] 加入书架失败', err);
    }
  }

  function togglePlay() {
    var v = dom.video;
    if (!S.url) return;
    if (S.mpvMode) {
      var Mm = mpvApi();
      if (Mm) {
        /* mpv 的 cycle/toggle 在个别构建上没反应，直接读一次真实状态再取反 */
        Mm.cmd(['get_property', 'pause']).then(function (p) {
          var want = !p;
          S.playing = want;
          paintPlayBtn();
          return Mm.cmd(['set_property', 'pause', want]);
        }, function () {
          S.playing = !S.playing;
          paintPlayBtn();
          return Mm.cmd(['set_property', 'pause', !S.playing]);
        });
      } else {
        S.playing = !S.playing;
        paintPlayBtn();
      }
      wake();
      return;
    }
    if (v.paused) {
      if (v.ended) { try { v.currentTime = 0; } catch (e) { } }
      tryPlay();
    } else {
      v.pause();
    }
    wake();
  }

  function step(delta) {
    var ln = currentLine();
    if (!ln) return;
    if (S.mpvMode) { mpvStep(delta); return; }
    var next = S.index + delta;
    if (next < 0) { toast('已经是第一集了'); return; }
    if (next >= ln.eps.length) { toast('已经是最后一集了'); return; }
    saveResume(true);
    load(S.lineIdx, next, 0);
  }

  function nextPlayableLine() {
    for (var i = 1; i <= S.lines.length; i++) {
      var idx = (S.lineIdx + i) % S.lines.length;
      var ln = S.lines[idx];
      if (ln && ln.eps && isDirect(ln.eps[S.index < ln.eps.length ? S.index : 0] && ln.eps[S.index < ln.eps.length ? S.index : 0].url)) {
        load(idx, Math.min(S.index, ln.eps.length - 1), 0);
        return;
      }
    }
    toast('没有别的可播线路了');
  }

  function onEnded() {
    var ln = currentLine();
    if (!ln) return;
    if (S.index + 1 < ln.eps.length) {
      dom.next.innerHTML = '';
      var txt = h('div', 'vv-next__text');
      txt.innerHTML = '即将播放 <b>第 ' + (S.index + 2) + ' 集</b>　<span id="vvCount">5</span> 秒';
      var go = h('button', '', '立即播放');
      go.onclick = function () { dom.next.classList.add('is-hidden'); step(1); };
      var cancel = h('button', 'is-ghost', '取消');
      cancel.onclick = function () { dom.next.classList.add('is-hidden'); };
      dom.next.appendChild(txt); dom.next.appendChild(go); dom.next.appendChild(cancel);
      dom.next.classList.remove('is-hidden');
      var left = 5;
      var id = setInterval(function () {
        left--;
        var c = document.getElementById('vvCount');
        if (c) c.textContent = String(left);
        if (left <= 0) {
          clearInterval(id);
          dom.next.classList.add('is-hidden');
          if (!S.open) return;
          step(1);
        }
      }, 1000);
    } else {
      showStatus('已经是最后一集了。', false);
      dom.bigplay.classList.remove('is-hidden');
    }
  }

  /* ---------- 侧栏 ---------- */
  function paintSub() {
    var ep = currentEp();
    var ln = currentLine();
    dom.title.textContent = S.title || '视频';
    dom.sub.innerHTML = (S.sourceName ? '源 <b>' + S.sourceName + '</b> · ' : '') +
      (ln ? ln.from + ' · ' : '') + (ep ? ep.t : '') +
      (S.lines.length > 1 ? ' · 共 ' + S.lines.length + ' 条线路' : '');
  }

  function paintSide() {
    var ln = currentLine();
    dom.stitle.innerHTML = '选集 <span>' + (ln ? ln.eps.length + ' 集' : '') + '</span>';
    dom.smeta.textContent = S.intro ? String(S.intro).replace(/\s+/g, ' ').slice(0, 80) : '';
    dom.stitle.title = S.intro || '';

    /* 线路 tabs */
    dom.linesRow.innerHTML = '';
    S.lines.forEach(function (l, i) {
      var direct = l.eps && l.eps[0] && isDirect(l.eps[0].url);
      var b = h('button', 'vv-line' + (i === S.lineIdx ? ' is-on' : '') + (direct ? '' : ' is-dim'),
        (l.from || ('线路' + (i + 1))) + '（' + (l.eps ? l.eps.length : 0) + '）' + (direct ? '' : ' · 需解析'));
      b.title = direct ? '直出视频流' : '播放页线路，需要解析接口（不做）';
      b.onclick = function () {
        if (!direct) { toast('这条线路是播放页，需要解析接口，换一条吧'); return; }
        saveResume(true);
        load(i, Math.min(S.index, (l.eps.length || 1) - 1), 0);
      };
      dom.linesRow.appendChild(b);
    });

    /* 剧集网格 */
    dom.eps.innerHTML = '';
    var seen = (readStore()[S.key] || {}).seen || {};
    (ln ? ln.eps : []).forEach(function (ep, i) {
      var b = h('button', 'vv-ep' + (i === S.index ? ' is-on' : '') + (seen[i] ? ' is-seen' : ''), ep.t || String(i + 1));
      b.title = ep.t || '';
      b.onclick = function () {
        if (S.mpvMode) { mpvJump(i); closeSide(); return; }
        saveResume(true); load(S.lineIdx, i, 0);
      };
      dom.eps.appendChild(b);
    });
    dom.btnPrev.disabled = S.index <= 0;
    dom.btnNext.disabled = !ln || S.index >= ln.eps.length - 1;
  }

  /* ---------- 断点续播 ---------- */
  function saveResume(force) {
    if (!S.open || !S.key) return;
    if (!force && (!S.current || S.current < 3)) return;
    var all = readStore();
    var rec = all[S.key] || {};
    rec.lineIdx = S.lineIdx;
    rec.index = S.index;
    rec.t = Math.round(S.current || 0);
    rec.at = Date.now();
    rec.title = S.title;
    rec.total = S.lines[S.lineIdx] ? S.lines[S.lineIdx].eps.length : 0;
    if (S.duration && S.current > (S.duration - 5)) rec.t = 0;   /* 看完了就下一集从头 */
    var seen = rec.seen || {};
    if (S.current > 30 || (S.duration && S.current > S.duration * 0.6)) seen[S.index] = 1;
    rec.seen = seen;
    all[S.key] = rec;
    writeStore();
  }

  function startTick() {
    clearInterval(tickTimer);
    clearTimeout(S.codecTimer);
    tickTimer = setInterval(function () {
      if (!S.open) return;
      paintBuf();
      saveResume(false);
    }, 5000);
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open(opts) {
    build();
    opts = opts || {};
    var lines = (opts.lines || []).map(function (l) {
      return { from: String(l.from || ''), eps: (l.eps || []).map(function (e) { return { t: String(e.t || ''), url: String(e.url || '') }; }) };
    }).filter(function (l) { return l.eps.length; });
    if (!lines.length) { toast('没有可播的剧集'); return; }

    S.open = true;
    S.title = String(opts.title || '视频');
    S.intro = String(opts.intro || '');
    S.sourceName = String(opts.sourceName || '');
    S.poster = String(opts.cover || opts.poster || '');
    S.bookUrl = String(opts.bookUrl || '');
    S.headers = opts.headers || null;
    S.lines = lines;
    S.lineIdx = Math.max(0, Math.min(lines.length - 1, Number(opts.lineIdx) || 0));
    S.index = Math.max(0, Math.min(lines[S.lineIdx].eps.length - 1, Number(opts.index) || 0));
    S.key = keyOf(opts);
    S.prevView = opts.from || 'plg:cmstv:main';
    /* 宿主内置播放器：mkv/HEVC 这类 WebView2 啃不动的直接交给 mpv，不试 <video> */
    S.forceMpv = !!opts.mpv;

    var rec = readStore()[S.key];
    var startAt = 0;
    if (rec && Number.isFinite(rec.t) && rec.t > 5) {
      S.lineIdx = Math.max(0, Math.min(S.lines.length - 1, Number(rec.lineIdx) || 0));
      S.index = Math.max(0, Math.min(S.lines[S.lineIdx].eps.length - 1, Number(rec.index) || 0));
      startAt = rec.t;
    }

    /* 窄屏：选集做成从底部滑出的抽屉，默认收起，先让视频占满（手机上固定收起） */
    dom.body.classList.toggle('is-side-off', global.innerWidth < 980 || isMobile());
    dom.view.classList.remove('hidden');
    if (typeof global.NR.switchView === 'function') {
      try { global.NR.switchView('video'); } catch (e) { dom.view.classList.remove('hidden'); }
    }
    load(S.lineIdx, S.index, startAt);
    paintPlayBtn(); paintVolBtn(); paintTime(); paintSeek();
    /* 每次进播放页都从「未锁定、控制栏可见」开始 */
    S.locked = false;
    dom.lock.classList.add('is-hidden'); dom.lock.classList.remove('is-locked');
    clearTimeout(lockTimer);
    dragging = false; dragRatio = 0; pendingRatio = null; suppressTap = false; lpFired = false;
    hideRateBubble();
    dom.seek.classList.remove('is-drag'); dom.tip.classList.remove('is-on');

    /* 继续观看提示（3 秒后自动消失） */
    clearTimeout(resumeTimer);
    dom.resume.innerHTML = '';
    dom.resume.classList.toggle('is-hidden', !(startAt > 5));
    if (startAt > 5) {
      dom.resume.appendChild(h('span', '', '上次看到 ' + fmt(startAt) + '，已从这儿继续'));
      var b = h('button', '', '从头开始');
      b.onclick = function () {
        dom.video.currentTime = 0; S.current = 0;
        clearTimeout(resumeTimer);
        dom.resume.classList.add('is-hidden');
        saveResume(true);
      };
      dom.resume.appendChild(b);
      resumeTimer = setTimeout(function () { dom.resume.classList.add('is-hidden'); }, 3000);
    }
    wake(true);
    startTick();
  }

  function close() {
    if (!S.open) return;
    if (S.mpvMode) {
      var Mk = mpvApi();
      if (Mk) Mk.stop();
      exitMpvMode();
    }
    saveResume(true);
    clearTimeout(resumeTimer);
    clearTimeout(lockTimer);
    clearTimeout(lpTimer);
    S.open = false;
    S.locked = false;
    hideRateBubble();
    dom.lock.classList.add('is-hidden'); dom.lock.classList.remove('is-locked');
    clearInterval(tickTimer);
    destroyHls();
    try { dom.video.pause(); dom.video.removeAttribute('src'); dom.video.load(); } catch (e) { }
    dom.stage.classList.remove('is-full');
    dom.view.classList.remove('is-fakefull');
    document.documentElement.classList.remove('vv-noscroll');
    setOrient('auto');
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { } }
    dom.view.classList.add('hidden');
    var back = S.prevView || 'plg:cmstv:main';
    if (typeof global.NR.switchView === 'function') {
      try { global.NR.switchView(back); } catch (e) { }
    }
  }

  function paintFullBtn() {
    if (!dom.btnFull) return;
    var on = isFull();
    dom.btnFull.title = on ? '退出全屏（F）' : '全屏（F）';
    dom.btnFull.classList.toggle('is-on', on);
  }

  function isFull() {
    if (S.mpvMode) return !!S.mpvFull;
    return dom.stage.classList.contains('is-full') || document.fullscreenElement === dom.stage;
  }

  /* 全屏：WebView 里 requestFullscreen 常常没反应（宿主没实现 onShowCustomView），
     所以直接铺满窗口（CSS .vv-stage.is-full），再顺手试一次原生全屏，失败也不影响。 */
  function toggleFull() {
    /* mpv 模式：网页这层只剩底部一条控制栏，铺满窗口是宿主的事 */
    if (S.mpvMode) {
      var Mf = mpvApi();
      var goFull = !S.mpvFull;
      S.mpvFull = goFull;
      if (Mf && Mf.full) Mf.full(goFull);
      paintFullBtn();
      wake();
      return;
    }
    if (isFull()) {
      dom.stage.classList.remove('is-full');
      dom.view.classList.remove('is-fakefull');
      document.documentElement.classList.remove('vv-noscroll');
      setOrient('auto');
      if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { } }
      setTimeout(paintSeek, 60);
      return;
    }
    if (sideOpen()) closeSide();
    dom.stage.classList.add('is-full');
    dom.view.classList.add('is-fakefull');
    document.documentElement.classList.add('vv-noscroll');
    if (isMobile()) setOrient(fullscreenOrient());
    try {
      var p = dom.stage.requestFullscreen ? dom.stage.requestFullscreen() : null;
      if (p && p.catch) p.catch(function () { });
    } catch (e) { }
    wake();
    setTimeout(paintSeek, 60);
  }

  NR.video = {
    open: open,
    close: close,
    state: function () {
      return {
        open: S.open, title: S.title, url: S.url, lineIdx: S.lineIdx, index: S.index,
        lines: S.lines.map(function (l) { return l.from + '(' + l.eps.length + ')'; }),
        duration: dom.video ? (dom.video.duration || 0) : 0,
        current: dom.video ? (dom.video.currentTime || 0) : 0,
        readyState: dom.video ? dom.video.readyState : 0,
        error: S.error || (dom.video && dom.video.error ? dom.video.error.code : ''),
        playing: S.playing,
        locked: S.locked,
        rate: dom.video ? (dom.video.playbackRate || 1) : 1,
        ctrlHidden: dom.ctrl ? dom.ctrl.classList.contains('is-hidden') : null,
        bookUrl: S.bookUrl
      };
    },
    setLock: setLock,
    applySharpen: function () { applySharpen(); },
    adStats: function () { return { blocks: S.adBlocks || 0, sec: S.adSec || 0 }; },
    switchLine: switchLine,
    addToShelf: addToShelf,
    resumeOf: function (k) { return readStore()[k] || null; },
    pauseOnly: function () { try { if (dom.video) dom.video.pause(); } catch (e) { } },
    clearResume: function (k) { var a = readStore(); delete a[k]; writeStore(); },
    keyOf: keyOf
  };
})(typeof window !== 'undefined' ? window : this);
