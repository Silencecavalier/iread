/* =========================================================================
 * mpv.js — 内置播放器（宿主侧 mpv 子进程）的渲染层封装
 *
 *   为什么需要它：WebView2 没有 HEVC/H.265 解码器。实测 <video> 播 HEVC 时
 *   只有声音（videoWidth/videoHeight 恒为 0），canPlayType('hvc1') 返回空串。
 *   宿主带一个 mpv 子进程：首次使用时下载（约 45MB），播放时宿主在窗口里铺一块
 *   黑色面板、用 --wid 把 mpv 画进去，下面留一条 WebView2 条带画我们自己的控制栏。
 *
 *   用法：
 *     NR.mpv.supported()            —— 当前壳是否提供内置播放器（桌面版才有）
 *     NR.mpv.ensure()               —— 确保播放器已就绪（缺了就下载），resolve {ok}
 *     NR.mpv.play(url, {title,start,headers,barHeight}) —— 起播
 *     NR.mpv.stop()                 —— 停掉
 *     NR.mpv.layout(h)              —— 控制条高度（0 = WebView2 全隐藏，mpv 占满）
 *     NR.mpv.cmd(['set_property','pause',true]) —— 发一条 mpv 命令，resolve 解析后的结果
 *     NR.mpv.onEnded(fn)            —— mpv 退出后回调（宿主会调 NR.mpv._ended）
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var bridge = global.yedu || null;

  function supported() {
    return !!(bridge && typeof bridge.mpvPlay === 'function' && typeof bridge.mpvEnsure === 'function');
  }

  var state = { on: false, busy: false, url: '', title: '', error: '', ended: null };

  function fail(e) {
    var msg = (e && (e.message || e.error)) || String(e || '未知错误');
    return { ok: false, error: msg };
  }

  function ensure() {
    if (!supported()) return Promise.resolve({ ok: false, error: 'unsupported' });
    return Promise.resolve(bridge.mpvEnsure()).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: !!r };
    }, fail);
  }

  function play(url, opts) {
    opts = opts || {};
    if (!supported()) return Promise.resolve({ ok: false, error: 'unsupported' });
    if (!url) return Promise.resolve({ ok: false, error: 'url required' });
    if (state.busy) return Promise.resolve({ ok: false, error: 'busy' });
    state.busy = true;
    state.error = '';
    return ensure().then(function (r) {
      if (!r || !r.ok) { state.busy = false; state.error = (r && r.error) || 'download failed'; return r || { ok: false }; }
      var payload = { url: String(url), title: String(opts.title || ''), start: Number(opts.start) || 0 };
      if (opts.headers) payload.headers = String(opts.headers);
      if (opts.barHeight != null) payload.barHeight = Number(opts.barHeight) || 0;
      return Promise.resolve(bridge.mpvPlay(payload)).then(function (res) {
        state.busy = false;
        if (res && res.ok) { state.on = true; state.url = payload.url; state.title = payload.title; }
        else state.error = (res && res.error) || 'launch failed';
        return res || { ok: false };
      }, function (e) { state.busy = false; state.error = String(e && e.message || e); return fail(e); });
    }, function (e) { state.busy = false; state.error = String(e && e.message || e); return fail(e); });
  }

  function stop() {
    if (!supported()) return Promise.resolve(false);
    state.on = false;
    return Promise.resolve(bridge.mpvStop()).catch(function () { return false; });
  }

  /* 控制条高度：>0 时宿主把 WebView2 缩成底部条带，让出上面的视频区给 mpv */
  // mpv 模式下 WebView2 只剩底部一条，网页的全屏没有意义，交给宿主把窗口最大化/还原
  function full(on) {
    if (!supported()) return Promise.resolve(false);
    if (typeof bridge.mpvFull !== 'function') return Promise.resolve(false);
    return Promise.resolve(bridge.mpvFull(on === undefined ? null : !!on)).then(function (r) { return !!(r && r.ok); }, function () { return false; });
  }

  function back(show) {
    if (!supported()) return Promise.resolve(false);
    if (typeof bridge.mpvBack !== 'function') return Promise.resolve(false);
    return Promise.resolve(bridge.mpvBack(!!show)).then(function (r) { return !!(r && r.show); }, function () { return false; });
  }

  function layout(h) {
    if (!supported() || typeof bridge.mpvLayout !== 'function') return Promise.resolve({ ok: false });
    return Promise.resolve(bridge.mpvLayout({ height: Number(h) || 0 })).catch(function () { return { ok: false }; });
  }

  /* 发一条 mpv 命令（JSON IPC）。返回值：property 取读的是值本身，命令是 true/null。
     mpv 刚起时 IPC 管道可能还没建好（第一次查询会拿到 null），这里补一次重试。 */
  function cmdOnce(args) {
    if (!supported() || typeof bridge.mpvCmd !== 'function') return Promise.resolve(null);
    var line = JSON.stringify({ command: args });
    return Promise.resolve(bridge.mpvCmd(line)).then(function (raw) {
      if (raw == null) return null;
      var text = String(raw).split('\n')[0];
      if (!text) return null;
      var obj;
      try { obj = JSON.parse(text); } catch (e) { return null; }
      if (obj && obj.error && obj.error !== 'success') return null;
      return obj && ('data' in obj) ? obj.data : true;
    }, function () { return null; });
  }

  function cmd(args) {
    return cmdOnce(args).then(function (v) {
      if (v !== null) return v;
      return new Promise(function (res) { setTimeout(res, 160); }).then(function () {
        return cmdOnce(args);
      });
    });
  }

  function onEnded(fn) { state.ended = typeof fn === 'function' ? fn : null; }

  /* 宿主在 mpv 退出后调用：恢复 WebView2 之后触发 */
  function _ended() {
    state.on = false;
    state.busy = false;
    var fn = state.ended;
    if (fn) { try { fn(); } catch (e) { } }
  }

  function status() { return { supported: supported(), on: state.on, busy: state.busy, url: state.url, title: state.title, error: state.error }; }

  NR.mpv = {
    supported: supported,
    ensure: ensure,
    play: play,
    stop: stop,
    layout: layout,
    back: back,
    full: full,
    cmd: cmd,
    onEnded: onEnded,
    status: status,
    _ended: _ended
  };
})(window);
