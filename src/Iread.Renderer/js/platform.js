/* =========================================================================
 * platform.js — 桌面壳适配层
 *   Electron 下走原生文件对话框 + 自绘窗口按钮；用浏览器直接打开 index.html
 *   时自动退化，保证同一份渲染层代码两边都能跑。
 * ========================================================================= */
(function (global) {
  'use strict';

  var bridge = (global.yedu && global.yedu.isDesktop) ? global.yedu : null;
  var sequence = 0;
  global.NR = global.NR || {};
  global.NR.tasks = {
    error: function (timeout) {
      var e = new Error(timeout ? '任务超时' : '任务已取消');
      e.code = timeout ? 'TIMEOUT' : 'CANCELLED';
      if (timeout) e.timeout = true; else e.cancelled = true;
      return e;
    },
    run: function (invoke, options, previous) {
      options = options || {};
      var timeout = Math.max(1, Math.min(120000, Number(options.timeout) || Number(global.__NR_TASK_TIMEOUT) || 15000));
      var deadline = Math.min(Date.now() + timeout, Number(options.deadline) || Infinity);
      var id = 'task-' + Date.now().toString(36) + '-' + (++sequence).toString(36);
      var signal = options.signal, stopped = null, started = false, timer;
      var resolve, reject;
      var result = new Promise(function (a, b) { resolve = a; reject = b; });
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
      function stop(timeoutError) {
        if (stopped) return;
        stopped = global.NR.tasks.error(timeoutError);
        cleanup();
        if (started && bridge && bridge.cancelTask) {
          Promise.resolve(bridge.cancelTask(id)).catch(function () {});
        }
        reject(stopped);
      }
      function abort() { stop(false); }
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
      if (!stopped) timer = setTimeout(function () { stop(true); }, Math.max(0, deadline - Date.now()));
      var completion = Promise.resolve(previous).catch(function () {}).then(function () {
        if (stopped) throw stopped;
        var remaining = Math.floor(deadline - Date.now());
        if (remaining <= 0) { stop(true); throw stopped; }
        started = true;
        return invoke({ taskId: id, timeout: remaining });
      }).then(function (value) {
        if (stopped) throw stopped;
        cleanup(); resolve(value); return value;
      }, function (error) {
        cleanup(); reject(stopped || error); throw stopped || error;
      });
      result.completion = completion.catch(function () {});
      return result;
    }
  };

  if (bridge) {
    // 桌面端：顶栏做窗口拖动区、右上角给自绘窗口按钮让位（见 css/app.css）
    document.documentElement.classList.add('desktop');
  }

  function notify(msg) {
    if (global.NR && typeof global.NR.notify === 'function') global.NR.notify(msg);
    else console.log('[iread]', msg);
  }

  /** 主进程返回的 Uint8Array → 标准 File，交给 parser.js 原样解析 */
  function toFile(item) {
    var file = new File([item.data], item.name, {
      type: item.type || 'application/octet-stream',
      lastModified: item.mtime || Date.now()
    });
    try {
      Object.defineProperty(file, 'path', { value: item.path, enumerable: false });
    } catch (e) { /* 不可配置就罢了 */ }
    return file;
  }

  /* 筛选日志：文件名白名单 + 单次 2MB 上限（宿主侧也会再校验一次） */
  var LOG_NAME_RE = /^[A-Za-z0-9._-]+$/;
  var LOG_MAX_BYTES = 2 * 1024 * 1024;
  function utf8Bytes(s) {
    // 快路径：字符数 × 3 都不超限就不用细算
    if (s.length * 3 <= LOG_MAX_BYTES) return s.length;
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 3; }
  }

  var api = {
    isDesktop: !!bridge,

    /* P：Bug4 修复——app.js 首启须知「不同意」走 NR.platform.winControls.exit/close，
     * 但 api 上从来没透传过 winControls 这个键（undefined.exit 抛错被吞=点了没反应）。
     * 直接把 bridge.winControls 整个透传（两壳 shim 结构一致：minimize/toggleMaximize/
     * close/exit/startResize/endResize/onState）。 */
    winControls: (bridge && bridge.winControls) ? bridge.winControls : null,

    info: function () {
      return bridge ? bridge.info() : Promise.resolve(null);
    },

    /** 关闭窗口时隐藏到托盘 */
    setTrayMode: function (on) {
      if (!bridge || !bridge.setTrayMode) return Promise.resolve(false);
      return bridge.setTrayMode(!!on);
    },

    /** 打开数据目录 */
    openUserData: function () {
      if (!bridge || !bridge.openUserData) return Promise.resolve(false);
      return bridge.openUserData();
    },

    /** 开机自启（桌面端） */
    setLoginItem: function (on) {
      if (!bridge || !bridge.setLoginItem) return Promise.resolve(false);
      return bridge.setLoginItem(!!on);
    },
    getLoginItem: function () {
      if (!bridge || !bridge.getLoginItem) return Promise.resolve(false);
      return bridge.getLoginItem();
    },

    /**
     * 选书。
     * @returns {Promise<File[]|null>} desktop: 选中的文件；browser: null（由调用方点 <input>）
     */
    pickFiles: function () {
      if (!bridge) return Promise.resolve(null);
      return bridge.pickBooks().then(function (list) {
        var files = [], errors = [];
        (list || []).forEach(function (it) {
          if (!it) return;
          if (it.data) files.push(toFile(it));
          else if (it.error) errors.push(it.name + '：' + it.error);
        });
        if (errors.length) notify('有 ' + errors.length + ' 个文件打不开：' + errors[0]);
        return files;
      });
    },

    /** 拖入的 File → 磁盘绝对路径（拿不到返回 null） */
    pathForFile: function (file) {
      return bridge ? bridge.pathForFile(file) : null;
    },

    /** 另存为（导出设置用它，比 a[download] 更像桌面软件） */
    saveText: function (name, text) {
      if (!bridge) {
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        return Promise.resolve({ canceled: false });
      }
      return bridge.saveJSON(name, text);
    },

    /** 数据替换前的完整备份必须由原生外壳持久保存，不能退化为浏览器下载。 */
    saveRecoveryBackup: function (text) {
      if (!bridge || typeof bridge.saveRecoveryBackup !== 'function') {
        return Promise.reject(new Error('当前外壳无法保存恢复前备份，请使用支持此功能的 WebView2 版本'));
      }
      return Promise.resolve().then(function () { return bridge.saveRecoveryBackup(text); });
    },

    /**
     * 筛选报错日志：静默追加写到 <日志目录>\logs\screen\<name>（不弹对话框）。
     * name 只允许 [A-Za-z0-9._-]、≤100 字符；单次 text ≤ 2MB。
     * 无桥（浏览器/测试）时降级到 window.__nrLogs[name] 字符串累加。
     * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
     */
    appendLog: function (name, text) {
      var n = String(name == null ? '' : name);
      if (!LOG_NAME_RE.test(n) || n.length > 100 || /^\.+$/.test(n)) {
        return Promise.resolve({ ok: false, error: '日志文件名非法：' + n.slice(0, 120) });
      }
      var s = String(text == null ? '' : text);
      if (utf8Bytes(s) > LOG_MAX_BYTES) {
        return Promise.resolve({ ok: false, error: '单次日志超过 2MB 上限' });
      }
      if (!bridge || !bridge.appendLog) {
        var store = global.__nrLogs || (global.__nrLogs = {});
        store[n] = (store[n] || '') + s;
        return Promise.resolve({ ok: true, path: 'memory:' + n });
      }
      return Promise.resolve(bridge.appendLog(n, s)).catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) };
      });
    },

    /** 日志目录绝对路径（无桥时返回 'memory:'） */
    logsDir: function () {
      if (!bridge || !bridge.logsDir) return Promise.resolve('memory:');
      return Promise.resolve(bridge.logsDir()).catch(function () { return ''; });
    },

    /** 用资源管理器打开日志目录 */
    openLogsDir: function () {
      if (!bridge || !bridge.openLogsDir) return Promise.resolve({ ok: false, error: '只有桌面版能打开日志目录' });
      return Promise.resolve(bridge.openLogsDir()).catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) };
      });
    },

    /** 无边框窗口的按钮组：最小化 / 最大化还原 / 关闭 */
    wireWindowControls: function () {
      var box = document.getElementById('winCtrl');
      if (!box || !bridge || !bridge.winControls) return;
      box.classList.add('on');

      document.getElementById('wcMin').onclick = function () { bridge.winControls.minimize(); };
      document.getElementById('wcMax').onclick = function () { bridge.winControls.toggleMaximize(); };
      document.getElementById('wcClose').onclick = function () { bridge.winControls.close(); };

      bridge.winControls.onState(function (state) {
        var btn = document.getElementById('wcMax');
        if (!btn) return;
        var maxed = !!(state && state.maximized);
        btn.classList.toggle('restore', maxed);
        btn.title = maxed ? '还原' : '最大化';
        document.documentElement.classList.toggle('window-maxed', maxed);
        document.documentElement.classList.toggle('fullscreen', !!(state && state.fullScreen));
      });
    },

    /**
     * 透明窗口没有原生缩放边框，靠窗口四边/四角的 8 条热区：
     * 按下把方向交给主进程，主进程跟着鼠标改 setBounds，松手结束。
     */
    wireResize: function () {
      if (!bridge || !bridge.winControls) return;
      var box = document.getElementById('winResize');
      if (!box) return;
      var zones = box.querySelectorAll('.rz');
      for (var i = 0; i < zones.length; i++) {
        zones[i].addEventListener('mousedown', function (e) {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          bridge.winControls.startResize(this.getAttribute('data-dir'));
        });
      }
      document.addEventListener('mouseup', function () { bridge.winControls.endResize(); });
      window.addEventListener('blur', function () { bridge.winControls.endResize(); });
    },

    /** 旧接口：换成自绘窗口按钮后不再需要同步系统标题栏颜色 */
    syncChrome: function () { },

    /** 菜单「导入书籍」(Ctrl+O) */
    onMenuImport: function (cb) {
      if (bridge) bridge.onMenuImport(cb);
    },

    /** 选书源 JSON 文件 → [{ name, text, error? }] */
    pickSources: function () {
      if (!bridge || !bridge.pickSources) return Promise.resolve([]);
      return bridge.pickSources();
    },

    /** 缓存目录信息 → { dir, custom, size, count, max, ttlDays } */
    cacheDir: function () {
      if (!bridge || !bridge.cacheDir) return Promise.resolve(null);
      return bridge.cacheDir();
    },

    /** 设置封面缓存目录；传空字符串恢复默认 */
    setCacheDir: function (dir) {
      if (!bridge || !bridge.setCacheDir) return Promise.reject(new Error('只有桌面版能改缓存目录'));
      return bridge.setCacheDir(dir);
    },

    /** 选文件夹（系统对话框）→ 路径或 '' */
    pickFolder: function (title) {
      if (!bridge || !bridge.pickFolder) return Promise.resolve('');
      return bridge.pickFolder(title);
    },

    /** 用资源管理器打开目录 */
    openFolder: function (dir) {
      if (!bridge || !bridge.openFolder) return Promise.resolve(false);
      return bridge.openFolder(dir);
    },

    /** 清空封面缓存 → 最新目录信息（含 removed 数量） */
    clearCache: function () {
      if (!bridge || !bridge.clearCache) return Promise.reject(new Error('只有桌面版能清缓存'));
      return bridge.clearCache();
    },

    /** 插件清单（宿主读 manifest.json）；浏览器环境返回空表 */
    importPlugin: function () {
      if (!bridge || !bridge.importPlugin) return Promise.resolve({ canceled: true });
      return bridge.importPlugin();
    },
    /** 插件私有文件读写：{ op: 'dir'|'list'|'read'|'write'|'append'|'remove', id, name, text } */
    pluginFs: function (opts) {
      if (!bridge || !bridge.pluginFs) {
        return Promise.reject(new Error('只有桌面版支持插件文件读写'));
      }
      return bridge.pluginFs(opts || {});
    },
    plugins: function () {
      if (!bridge || !bridge.plugins) return Promise.resolve({ dir: '', builtin: '', entries: [] });
      return bridge.plugins();
    },
    /** 漫画图片解密：{ url, code, referer, source } → data URL（宿主导出密文字节交给规则 worker 解密） */
    decodeImage: function (opts) {
      if (!bridge || !bridge.decodeImage) return Promise.resolve('');
      return bridge.decodeImage(opts || {});
    },

    /** 视频地址嗅探：{ url, sourceRegex, notSourceRegex, webviewJs, webviewJsDelay, timeout, referer }
     *  → JSON 字符串 {ok,url,via,elapsed} / {ok:false,error,candidates} */
    mediaHeaders: function (list) {
    if (!bridge || !bridge.mediaHeaders) return Promise.resolve({ ok: false });
    return bridge.mediaHeaders(list || []).catch(function () { return { ok: false }; });
  },
  sniffVideo: function (opts) {
      if (!bridge || !bridge.sniffVideo) return Promise.reject(new Error('只有桌面版支持视频嗅探'));
      return bridge.sniffVideo(opts || {});
    },

    /** 书源请求走主进程（绕 CORS、认 charset、共享 Cookie） */
    fetchText: function (opts) {
      if (!bridge || !bridge.fetchText) {
        return Promise.reject(new Error('只有桌面版能联网取书'));
      }
      return bridge.fetchText(opts);
    },

    /** 封面图 → data URL（主进程带 UA/Referer，绕开防盗链） */
    fetchImage: function (opts) {
      if (!bridge || !bridge.fetchImage) {
        return Promise.reject(new Error('只有桌面版能取封面'));
      }
      return bridge.fetchImage(opts);
    },

    runRuleJs: function (code, ctx) {
      if (!bridge || !bridge.runRuleJs) {
        return Promise.resolve({ ok: false, error: '只有桌面版支持 @js 规则' });
      }
      return bridge.runRuleJs(code, ctx);
    },

    /** 外部 yuedu:// 链接唤起（浏览器点分享链接 / 命令行带参数） */
    onYueduLink: function (cb) {
      if (!bridge || !bridge.onYueduLink) return;
      bridge.onYueduLink(cb);
    }
  };

  function boot() {
    api.wireWindowControls();
    api.wireResize();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.NR = global.NR || {};
  global.NR.platform = api;
})(window);

/* ---------------------------------------------------------------- 关闭确认
 * 点标题栏关闭 / Alt+F4 时，宿主先问渲染层要不要真的关：
 * 这里弹「最小化至托盘 / 退出」+「记住我的选择」，选择结果回传给宿主执行。
 * 宿主已记住选择时不会调用这个函数，直接照记住的做。
 */
(function (global) {
  'use strict';
  var dlg = null, ok = null, remember = null, choice = 'tray', bound = false;

  function byId(id) { return document.getElementById(id); }

  function sync() {
    if (!dlg) return;
    var rows = dlg.querySelectorAll('[data-closemode]');
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].getAttribute('data-closemode') === choice;
      rows[i].classList.toggle('on', on);
      rows[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (ok) ok.textContent = choice === 'tray' ? '最小化至托盘' : '退出 iread';
  }

  function finish(kind, remembered) {
    if (dlg) dlg.hidden = true;
    var bridge = (global.yedu && global.yedu.isDesktop) ? global.yedu : null;
    var wc = bridge && bridge.winControls;
    if (wc && wc.confirmClose) {
      Promise.resolve(wc.confirmClose(kind, remembered)).catch(function () {});
      return;
    }
    if (!wc) return;
    if (kind === 'tray') {
      if (bridge.setTrayMode) Promise.resolve(bridge.setTrayMode(true)).catch(function () {});
      if (wc.close) Promise.resolve(wc.close()).catch(function () {});
      return;
    }
    if (wc.exit) Promise.resolve(wc.exit()).catch(function () {});
  }

  function onKey(e) {
    if (!dlg || dlg.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); dlg.hidden = true; }
    else if (e.key === 'Enter') { e.preventDefault(); finish(choice, !!(remember && remember.checked)); }
  }

  function bind() {
    if (bound) return;
    dlg = byId('closeDlg');
    if (!dlg) return;
    bound = true;
    ok = byId('closeOk');
    remember = byId('closeRemember');
    var rows = dlg.querySelectorAll('[data-closemode]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].onclick = function () { choice = this.getAttribute('data-closemode'); sync(); };
    }
    var cancel = byId('closeCancel');
    if (cancel) cancel.onclick = function () { dlg.hidden = true; };
    if (ok) ok.onclick = function () { finish(choice, !!(remember && remember.checked)); };
    var mask = dlg.querySelector('.cmodal__mask');
    if (mask) mask.onclick = function () { dlg.hidden = true; };
    document.addEventListener('keydown', onKey, true);
  }

  /** 宿主调用：弹出关闭确认 */
  global.__ireadAskClose = function () {
    bind();
    if (!dlg) return;
    choice = 'tray';
    if (remember) remember.checked = false;
    sync();
    dlg.hidden = false;
    if (ok) { try { ok.focus(); } catch (e) {} }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(window);
