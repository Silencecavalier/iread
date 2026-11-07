/* =========================================================================
 * audioview.js — 听书音频章节播放模式（bookSourceType=1，归一化后 srcType=1）
 * -------------------------------------------------------------------------
 * 听书源（src.type=1）的正文求值结果通常是一个音频地址（mp3/m4a/aac/…）。
 * 这里在 chapterHTML 的嗅探分发链里排在视频之后、漫画之前：
 *   视频（srcType=4 / .m3u8/.mp4 单 URL）→ 音频（srcType=1 / 音频扩展名单 URL）
 *   → 漫画 → 文本。
 *
 * 播放器：
 *   - mp3/m4a Chromium 原生支持，直接 audio.src = url
 *   - 播放/暂停、时间显示、seek 拖动、倍速（playbackRate）
 *   - 进度记忆 NR.store（IndexedDB），键 aprog:<bookId>:<ci>（对齐视频 vprog）
 *   - 下一章按钮对齐视频（goChapter(1) 由 app.js 传入）
 *   - destroyAplayer() 挂到与 destroyVplayer 相同的三个销毁点
 *     （app.js 翻章 jumpTo / 返回书架 backToShelf / switchView）
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};

  /* ------------------------------------------------------------ 嗅探 */
  var AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac|opus)(\?|#|$)/i;

  /** 音频扩展名单 URL（srcType=1 时不做扩展名限制） */
  function isAudioUrl(u) {
    return /^https?:\/\/\S+$/i.test(u) && AUDIO_RE.test(u);
  }

  /** 正文文本 → 音频地址（非音频模式返回 null） */
  function sniffAudio(text, srcType) {
    var t = String(text || '').trim();
    if (!t) return null;
    var urls = t.split(/\s+/).filter(function (u) { return /^https?:\/\//i.test(u); });
    if (!urls.length) return null;
    if (Number(srcType) === 1) return { url: urls[0] };        // 听书源：正文即音频地址
    if (urls.length === 1 && isAudioUrl(urls[0])) return { url: urls[0] };
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------ 状态 */
  // { audio, progTimer, bookId, ci, key, url, onNext, disposed }
  var state = null;

  function progKey(bookId, ci) { return 'aprog:' + bookId + ':' + ci; }
  function S() { return global.NR.store; }
  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /** 销毁：pause + 释放网络流 + 摘事件（对齐 destroyVplayer） */
  function destroyAplayer() {
    if (!state) return;
    var st = state; state = null;
    st.disposed = true;
    try { if (st.audio) st.audio.pause(); } catch (e) { }
    try { if (st.progTimer) clearInterval(st.progTimer); } catch (e) { }
    try { if (st.audio) { st.audio.removeAttribute('src'); st.audio.load(); } } catch (e) { }
  }

  /* ------------------------------------------------------------ 渲染 */
  var HTML =
    '<div class="audio-view" data-audio="1">' +
    '  <div class="audio-view__disc">🎵</div>' +
    '  <p class="audio-view__title">本章音频</p>' +
    '  <audio id="aplayer" preload="metadata"></audio>' +
    '  <div class="audio-view__bar">' +
    '    <button class="audio-view__btn" data-act="prev" title="上一章">⏮</button>' +
    '    <button class="audio-view__btn audio-view__btn--main" data-act="play" title="播放/暂停">▶</button>' +
    '    <button class="audio-view__btn" data-act="next" title="下一章">⏭</button>' +
    '    <span class="audio-view__time">0:00 / 0:00</span>' +
    '    <select class="audio-view__rate" title="倍速">' +
    '      <option value="1">1.0x</option>' +
    '      <option value="1.25">1.25x</option>' +
    '      <option value="1.5">1.5x</option>' +
    '      <option value="2">2.0x</option>' +
    '      <option value="0.75">0.75x</option>' +
    '    </select>' +
    '  </div>' +
    '  <input class="audio-view__seek" type="range" min="0" max="1000" value="0">' +
    '  <p class="audio-view__err" hidden>音频加载失败 ' +
    '    <button class="btn btn--tiny" data-act="retry">重试</button></p>' +
    '</div>';

  /**
   * 音频章节 DOM（app.js chapterHTML 拼接用；交互由 bindAudio 接管）
   * opts: { ci, url, bookId, onNext }
   */
  function audioHTML(ci, url, bookId, onNext) {
    destroyAplayer();
    var wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    var view = wrap.firstElementChild;
    // 防盗链referer（章节 origin；网络层由 aplayer 直接请求，多数源无 referer 校验，
    // 这里把地址留到 data-src，真正赋 src 放到 bindAudio 内部，便于失败重试）
    view.dataset.audioUrl = url;
    view.dataset.audioKey = progKey(bookId, ci);
    bindAudio(view, onNext);
    return view;
  }

  function bindAudio(view, onNext) {
    var audio = view.querySelector('#aplayer');
    var url = view.dataset.audioUrl;
    var key = view.dataset.audioKey;
    var bookId = String(key || '').split(':')[1] || '';
    var ci = Number(String(key || '').split(':')[2]) || 0;

    state = { audio: audio, progTimer: null, bookId: bookId, ci: ci, key: key, url: url, disposed: false };
    var st = state;

    var btnPlay = view.querySelector('[data-act="play"]');
    var timeEl = view.querySelector('.audio-view__time');
    var seek = view.querySelector('.audio-view__seek');
    var rate = view.querySelector('.audio-view__rate');
    var errEl = view.querySelector('.audio-view__err');

    var alive = function () { return state === st && !st.disposed; };

    var saveNow = function () {
      if (!alive() || !audio.currentTime) return;
      S().set(key, audio.currentTime).catch(function () { });
    };
    // timeupdate 节流 500ms 更新 UI；每 5 秒落一次进度
    var lastUi = 0, lastSave = 0;

    var onTime = function () {
      if (!alive()) return;
      var now = Date.now();
      if (now - lastUi >= 500) {
        lastUi = now;
        timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
        if (isFinite(audio.duration) && audio.duration > 0) {
          seek.value = Math.round(1000 * audio.currentTime / audio.duration);
        }
      }
      if (now - lastSave >= 5000) { lastSave = now; saveNow(); }
    };
    var onMeta = function () {
      if (!alive()) return;
      timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
      restore();
    };
    var onEnd = function () {
      if (!alive()) return;
      S().del(key).catch(function () { });
      btnPlay.textContent = '▶';
      seek.value = 0;
      timeEl.textContent = '0:00 / ' + fmt(audio.duration);
      NR.toast('本章播完，可看下一章');
    };
    var onErr = function () {
      if (!alive()) return;
      errEl.hidden = false;
      btnPlay.textContent = '▶';
    };
    var saved = 0, restored = false;
    var restore = function () {
      if (restored || !alive()) return;
      if (!(isFinite(audio.duration) && audio.duration > 0)) return;
      restored = true;
      if (saved > 0 && saved < audio.duration - 2) {
        audio.currentTime = saved;
        NR.toast('已恢复到 ' + fmt(saved));
      } else if (saved > 0) {
        S().del(key).catch(function () { });   // 已听完
      }
    };

    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onErr);

    // 恢复进度（store 异步取）
    S().get(key).then(function (v) {
      saved = parseFloat(v) || 0;
      restore();
    }).catch(function () { });

    // 播放/暂停
    var toggle = function () {
      if (!alive()) return;
      if (audio.paused) {
        var p = audio.play();
        if (p && p.catch) p.catch(function () { });   // 无头/自动播放限制不抛错
      } else {
        audio.pause();
      }
    };
    audio.addEventListener('play', function () { if (alive()) btnPlay.textContent = '⏸'; });
    audio.addEventListener('pause', function () { if (alive()) btnPlay.textContent = '▶'; });

    btnPlay.onclick = toggle;
    view.querySelector('[data-act="prev"]').onclick = function () {
      if (alive() && onNext) onNext(-1);
    };
    view.querySelector('[data-act="next"]').onclick = function () {
      if (alive() && onNext) onNext(1);
    };
    view.querySelector('[data-act="retry"]').onclick = function () {
      if (!alive()) return;
      errEl.hidden = true;
      audio.src = url;
      audio.load();
    };
    rate.onchange = function () {
      audio.playbackRate = parseFloat(rate.value) || 1;
    };
    seek.addEventListener('input', function () {
      if (alive() && isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = seek.value / 1000 * audio.duration;
      }
    });

    // 每 5 秒兜底落盘（对齐视频 progTimer）
    st.progTimer = setInterval(saveNow, 5000);

    audio.src = url;
  }

  NR.audioview = {
    sniffAudio: sniffAudio,
    isAudioUrl: isAudioUrl,
    audioHTML: audioHTML,
    destroyAplayer: destroyAplayer
  };
})(window);
