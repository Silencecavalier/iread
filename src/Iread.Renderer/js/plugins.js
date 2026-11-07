/* ============================================================================
 * 插件运行时（C 类：真 JS 插件）
 * ---------------------------------------------------------------------------
 * 加载方式：
 *   内置插件 —— <程序目录>\wwwroot\plugins\<id>\main.js（同源，走 CSP 'self'）
 *   用户插件 —— <数据根>\plugins\<id>\main.js（宿主映射为 https://plugins.local）
 * 插件协议：
 *   文件里调用 LampPlugin.define({ setup: function (api) { ... } })
 * api 按 manifest.permissions 逐项放行；未声明的权限调用会直接抛错。
 *
 * 安全边界（务必如实告知使用者）：插件与本程序同源执行，权限检查是「声明式」的，
 * 它只能拦住"误用"，挡不住"恶意"。装插件＝把书架和数据交给对方，只装你信任的。
 * ========================================================================== */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var pf = NR.platform || {};

  // 注意：不能用 nr_ 前缀 —— store.js 的 application() 把 nr_* 当成自己的数据，
  // 迁移到 IndexedDB 后会把这些键从 localStorage 里删掉（实测会导致启用状态丢失）。
  var ENABLED_KEY = 'plg:enabled';
  var STORE_PREFIX = 'plg:';

  /* v2：权限不再拦截，只用来在管理面板里「告诉用户这个插件会用到什么」。
     所以这里的名字是「能力」，不是「申请」。 */
  var PERM_LABEL = {
    'shelf:read': '读取书架与阅读进度',
    'shelf:write': '修改书架（加书、删书）',
    'net': '联网抓取页面与图片',
    'ui': '显示界面（插槽 / 弹窗 / 提示）',
    'commands': '注册命令（命令面板）',
    'events': '订阅应用事件',
    'store': '保存自己的配置与缓存',
    'fs': '读写自己的私有文件',
    'reader': '在阅读页显示内容',
    'shortcuts': '注册快捷键',
    'theme': '读取当前主题配色'
  };

  var SLOT_LABEL = {
    'mine.top': '「我的」顶部',
    'mine.bottom': '「我的」底部',
    'discover.top': '发现页顶部',
    'discover.bottom': '发现页底部',
    'detail.bottom': '书籍详情页底部',
    'bookstore.top': '书城顶部',
    'reader.top': '阅读页顶部',
    'reader.bottom': '阅读页底部'
  };

  /* 插件插槽里「像原生按钮」的两个固定零件：图标与右侧箭头（与 index.html 里的一致） */
  var ROW_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.4v2.6M13 3.4v2.6"/><rect x="4.4" y="6" width="11.2" height="6.2" rx="2.2"/><path d="M10 12.2v2.6"/><path d="M7.4 16.6h5.2"/></svg>';
  var ROW_CHEV = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l5 5-5 5"/></svg>';

  var state = {
    loaded: false,
    loading: null,
    discovered: [],       // 发现的全部插件（含未启用）
    active: [],           // 已加载成功的插件
    slots: {},            // slot -> [{ id, render }]
    pages: {},            // "pluginId:pageId" -> { box, def, nav }
    commands: [],         // [{ id, label, run, plugin }]
    listeners: {},        // event -> [{ id, fn }]
    shortcuts: [],        // [{ id, combo, fn }]
    errors: [],           // [{ id, message }]
    usage: {},            // id -> { 能力: true }（实际调用过的）
    cleanups: {},         // id -> [fn]（热重载时逐个调用）
    dir: '',
    builtin: '',
    pending: null,        // 正在加载的插件 id
    managerOpen: false,
    bodyHidden: null,
    ready: null,          // app:ready 的 Promise（给 api.app.ready()）
    readyResolve: null
  };

  /* ---------------- 启用状态（localStorage，不进备份） ---------------- */
  function readEnabled() {
    var raw = null;
    try { raw = global.localStorage.getItem(ENABLED_KEY); } catch (e) { raw = null; }
    if (!raw) return null;                 // null = 还没选过，按默认策略
    try {
      var obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }

  function writeEnabled(map) {
    try { global.localStorage.setItem(ENABLED_KEY, JSON.stringify(map || {})); } catch (e) { /* 忽略 */ }
  }

  function isEnabled(id, source) {
    var map = readEnabled();
    // 插件不再随包分发，都是用户自己装进来的 → 默认启用；只有显式停用过才关。
    if (!map) return true;
    return map[id] !== false;
  }

  function setEnabled(id, on) {
    var map = readEnabled() || {};
    if (on) delete map[id]; else map[id] = false;
    writeEnabled(map);
  }

  /* ---------------- 插件自带存储（localStorage 命名空间） ---------------- */
  /* 每个插件最多 512KB：插件和主程序共用同一个 localStorage 配额（一般 5–10MB），
     不设上限的话一个插件写满会把书架索引一起拖死。 */
  var STORE_QUOTA = 512 * 1024;

  function storeFor(id) {
    var base = STORE_PREFIX + id + ':';
    function usedBytes(exceptKey) {
      var total = 0;
      try {
        for (var i = 0; i < global.localStorage.length; i++) {
          var k = global.localStorage.key(i);
          if (!k || k.indexOf(base) !== 0) continue;
          if (exceptKey && k === base + exceptKey) continue;
          total += k.length + String(global.localStorage.getItem(k) || '').length;
        }
      } catch (e) { /* 忽略 */ }
      return total;
    }
    return {
      get: function (key, fallback) {
        var raw = null;
        try { raw = global.localStorage.getItem(base + key); } catch (e) { raw = null; }
        if (raw === null || raw === undefined) return fallback === undefined ? null : fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback === undefined ? null : fallback; }
      },
      set: function (key, value) {
        var text = JSON.stringify(value === undefined ? null : value);
        var extra = usedBytes(key) + String(key).length + String(text || '').length;
        if (extra > STORE_QUOTA) {
          throw new Error('插件存储已满（每个插件上限 ' + Math.round(STORE_QUOTA / 1024) + 'KB，当前约 '
            + Math.round(extra / 1024) + 'KB）。用 api.fs 写文件，不要在 store 里存大块数据。');
        }
        try { global.localStorage.setItem(base + key, text); } catch (e) { throw new Error('插件存储写入失败：' + (e && e.message || e)); }
        return true;
      },
      del: function (key) {
        try { global.localStorage.removeItem(base + key); } catch (e) { /* 忽略 */ }
        return true;
      },
      keys: function () {
        var out = [];
        try {
          for (var i = 0; i < global.localStorage.length; i++) {
            var k = global.localStorage.key(i);
            if (k && k.indexOf(base) === 0) out.push(k.slice(base.length));
          }
        } catch (e) { /* 忽略 */ }
        return out;
      },
      used: function () { return usedBytes(null); }
    };
  }

  /* ---------------- 书架 / 统计读取 ---------------- */
  function shelfList() {
    if (!NR.store || !NR.store.get) return Promise.resolve([]);
    return Promise.resolve(NR.store.get('nr_index')).then(function (list) {
      return Array.isArray(list) ? list.slice() : [];
    }, function () { return []; });
  }

  function progressOf(meta) {
    if (!meta) return { ci: 0, ratio: 0, percent: 0 };
    var p = meta.progress || { ci: 0, ratio: 0 };
    var total = meta.chapterCount || (meta.chapterTitles && meta.chapterTitles.length) || 0;
    var percent = total > 0 ? Math.min(100, Math.round(((p.ci || 0) + (p.ratio || 0)) / total * 100)) : 0;
    return { ci: p.ci || 0, ratio: p.ratio || 0, percent: percent, total: total };
  }

  /* 相对亮度（0=黑 1=白）；认 #rgb/#rrggbb/rgb()/rgba()，认不出返回 null */
  function hexLum(s) {
    s = String(s || '').trim();
    var r, g, b, m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(s))) {
      r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16);
    } else if ((m = /^#([0-9a-f]{6})$/i.exec(s))) {
      r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16);
    } else if ((m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s))) {
      r = +m[1]; g = +m[2]; b = +m[3];
    } else {
      return null;
    }
    function ch(x) { x = x / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }

  /* 'Ctrl + Shift + K' → 'ctrl+shift+k'（统一小写、去空格、修饰键排序） */
  function normalizeCombo(combo) {
    var parts = String(combo || '').toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
    var mods = [], key = '';
    parts.forEach(function (p) {
      if (p === 'ctrl' || p === 'control' || p === 'cmd' || p === 'meta' || p === 'alt' || p === 'shift') mods.push(p === 'control' ? 'ctrl' : (p === 'cmd' ? 'meta' : p));
      else key = p;
    });
    mods.sort();
    return mods.concat(key ? [key] : []).join('+');
  }

  function comboOfEvent(ev) {
    var mods = [];
    if (ev.ctrlKey) mods.push('ctrl');
    if (ev.metaKey) mods.push('meta');
    if (ev.altKey) mods.push('alt');
    if (ev.shiftKey) mods.push('shift');
    mods.sort();
    var k = String(ev.key || '').toLowerCase();
    if (k === ' ') k = 'space';
    return mods.concat(k ? [k] : []).join('+');
  }

  /* ---------------- 权限（v2：不拦截，只记账） ---------------- */
  function apiFor(rec) {
    var perms = (rec.manifest.permissions || []).slice();

    /* 老版本这里会抛「没有声明权限」。现在按用户要求「自由度最高」：
       全部能力默认开放，manifest 里的 permissions 只表示「作者说它会用到」，
       真正调用到的能力记到 state.usage，管理面板里如实显示。 */
    function need(perm) {
      var box = state.usage[rec.id] || (state.usage[rec.id] = {});
      box[perm] = true;
      return true;
    }

    function fsCall(opts) {
      need('fs');
      if (!pf.pluginFs) return Promise.reject(new Error('当前环境不支持插件文件读写'));
      return pf.pluginFs(Object.assign({ id: rec.id }, opts || {})).then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || '文件操作失败');
        return r;
      });
    }

    function themeNow() {
      var cs = global.getComputedStyle ? global.getComputedStyle(document.documentElement) : null;
      function v(name) { return cs ? String(cs.getPropertyValue(name) || '').trim() : ''; }
      var name = document.documentElement.getAttribute('data-ui-theme') || 'ink';
      var bg = v('--ink-0');
      var rgb = hexLum(bg);
      return {
        name: name,
        dark: rgb === null ? true : rgb < 0.45,
        bg: bg,
        panel: v('--ink-1'),
        fg: v('--fg'),
        fg2: v('--fg-2'),
        fg3: v('--fg-3'),
        hair: v('--hair'),
        lamp: v('--lamp'),
        radius: v('--radius-panel')
      };
    }

    var api = {
      id: rec.id,
      version: rec.manifest.version || '0.0.0',
      permissions: perms,
      log: function () {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[plugin:' + rec.id + ']');
        if (global.console && console.log) console.log.apply(console, args);
      }
    };

    api.store = storeFor(rec.id);

    api.shelf = {
      list: function () { need('shelf:read'); return shelfList(); },
      get: function (id) {
        need('shelf:read');
        return shelfList().then(function (list) {
          for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
          return null;
        });
      },
      progress: function (id) {
        need('shelf:read');
        return api.shelf.get(id).then(function (meta) { return progressOf(meta); });
      },
      add: function (book) {
        need('shelf:write');
        if (!NR.importBook) return Promise.reject(new Error('当前版本不支持从插件加书'));
        return NR.importBook(book);
      },
      remove: function (id) {
        need('shelf:write');
        if (!NR.removeBook) return Promise.reject(new Error('当前版本不支持从插件删书'));
        return Promise.resolve(NR.removeBook(id));
      }
    };

    api.stats = {
      summary: function () {
        need('shelf:read');
        var s = NR.readingStats && NR.readingStats.get ? NR.readingStats.get() : null;
        return s || { totalMs: 0, readCount: 0 };
      }
    };

    api.net = {
      fetchText: function (url, opts) {
        need('net');
        if (!pf.fetchText) return Promise.reject(new Error('当前环境不支持联网'));
        return pf.fetchText(Object.assign({ url: String(url || '') }, opts || {}));
      },
      fetchImage: function (url, opts) {
        need('net');
        if (!pf.fetchImage) return Promise.reject(new Error('当前环境不支持取图'));
        return pf.fetchImage(Object.assign({ url: String(url || '') }, opts || {}));
      }
    };

    api.ui = {
      mount: function (slot, render) {
        need('ui');
        if (!SLOT_LABEL[slot]) throw new Error('未知插槽：' + slot);
        if (typeof render !== 'function') throw new Error('mount(slot, render) 需要函数');
        state.slots[slot] = state.slots[slot] || [];
        state.slots[slot].push({ id: rec.id, render: render });
        refreshSlot(slot);
        return true;
      },
      /* 注册一个插件自己的页面：会在侧边栏「书城」下面多一个入口。
         def = { id, title, icon, render(box, ctx), badge } */
      page: function (def) {
        need('ui');
        return addPage(rec, def || {});
      },
      /* 统一的「我的」原生行样式。插件入口按钮一律用这个，
         出来的东西和「阅读设置」「关于 iread」长得完全一样。 */
      rowHTML: function (opts) {
        var o = opts || {};
        return '<button class="mine-row"' + (o.id ? ' id="' + escapeHTML(o.id) + '"' : '') + ' type="button">' +
          '<span class="mine-row__icon" aria-hidden="true">' + (o.icon || ROW_ICON) + '</span>' +
          '<span class="mine-row__text">' + escapeHTML(o.title || '') + '</span>' +
          (o.meta ? '<span class="mine-row__meta">' + escapeHTML(o.meta) + '</span>' : '') +
          (o.chev === false ? '' : '<span class="mine-row__chev" aria-hidden="true">' + ROW_CHEV + '</span>') +
          '</button>';
      },
      /* 直接给一个 <button class="mine-row"> 元素，绑好点击 */
      row: function (opts) {
        need('ui');
        var o = opts || {};
        var box = document.createElement('div');
        box.innerHTML = api.ui.rowHTML(o);
        var btn = box.firstElementChild;
        if (btn && typeof o.onClick === 'function') btn.onclick = o.onClick;
        return btn;
      },
      toast: function (msg) {
        need('ui');
        if (NR.toast) NR.toast(String(msg == null ? '' : msg));
        return true;
      },
      /* 原生样式的设置表单：弹一次、返回填好的对象（取消返回 null），
         同时自动写进 api.store 的 settings 键，下次直接 get('settings')。 */
      form: function (spec) {
        need('ui');
        var s = spec || {};
        var fields = Array.isArray(s.fields) ? s.fields : [];
        return new Promise(function (resolve) {
          var wrap = document.createElement('div');
          wrap.className = 'plg-form-mask';
          var rows = fields.map(function (f, i) {
            var fid = 'plgf-' + rec.id + '-' + i;
            var val = f.value === undefined ? '' : f.value;
            var ctl;
            if (f.type === 'textarea') {
              ctl = '<textarea class="plg-form__input" id="' + fid + '" rows="4">' + escapeHTML(String(val)) + '</textarea>';
            } else if (f.type === 'select') {
              ctl = '<select class="plg-form__input" id="' + fid + '">' + (f.options || []).map(function (o) {
                var ov = (o && o.value !== undefined) ? o.value : o;
                var ot = (o && o.text !== undefined) ? o.text : o;
                return '<option value="' + escapeHTML(String(ov)) + '"' + (String(ov) === String(val) ? ' selected' : '') + '>' + escapeHTML(String(ot)) + '</option>';
              }).join('') + '</select>';
            } else if (f.type === 'switch' || f.type === 'checkbox') {
              ctl = '<input class="plg-form__check" type="checkbox" id="' + fid + '"' + (val ? ' checked' : '') + '>';
            } else {
              ctl = '<input class="plg-form__input" id="' + fid + '" type="' + (f.type === 'number' ? 'number' : 'text') + '" value="'
                + escapeHTML(String(val)) + '"' + (f.placeholder ? ' placeholder="' + escapeHTML(String(f.placeholder)) + '"' : '') + '>';
            }
            return '<div class="plg-form__row" data-key="' + escapeHTML(String(f.key || ('field' + i))) + '">'
              + '<label class="plg-form__label" for="' + fid + '">' + escapeHTML(String(f.label || f.key || '')) + '</label>'
              + ctl + (f.hint ? '<p class="plg-form__hint">' + escapeHTML(String(f.hint)) + '</p>' : '') + '</div>';
          }).join('');

          wrap.innerHTML = '<div class="plg-form" role="dialog" aria-modal="true">'
            + '<h3 class="plg-form__title">' + escapeHTML(String(s.title || '设置')) + '</h3>'
            + (s.desc ? '<p class="plg-form__desc">' + escapeHTML(String(s.desc)) + '</p>' : '')
            + '<div class="plg-form__body">' + rows + '</div>'
            + '<div class="plg-form__foot">'
            + '<button class="btn" type="button" data-plg-form="cancel">取消</button>'
            + '<button class="btn btn--primary" type="button" data-plg-form="ok">保存</button>'
            + '</div></div>';

          function close(out) { wrap.remove(); resolve(out); }
          wrap.addEventListener('click', function (ev) {
            var act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-plg-form');
            if (act === 'cancel') { close(null); return; }
            if (act !== 'ok') {
              if (ev.target === wrap) close(null);
              return;
            }
            var out = {}, rowEls = wrap.querySelectorAll('.plg-form__row');
            fields.forEach(function (f, i) {
              var row = rowEls[i];
              if (!row) return;
              var ctl = row.querySelector('.plg-form__input,.plg-form__check');
              if (!ctl) return;
              var key = f.key || ('field' + i);
              if (f.type === 'switch' || f.type === 'checkbox') out[key] = !!ctl.checked;
              else if (f.type === 'number') out[key] = ctl.value === '' ? null : Number(ctl.value);
              else out[key] = ctl.value;
            });
            try { api.store.set('settings', out); } catch (e) { /* 存不下也不挡 */ }
            close(out);
          });
          document.body.appendChild(wrap);
          var first = wrap.querySelector('.plg-form__input,.plg-form__check');
          if (first && first.focus) setTimeout(function () { first.focus(); }, 30);
        });
      },
      refresh: function () { refreshSlots(); return true; }
    };

    api.commands = {
      register: function (cmd) {
        need('commands');
        if (!cmd || !cmd.id || typeof cmd.run !== 'function') throw new Error('register 需要 { id, label, run }');
        state.commands.push({ id: rec.id + ':' + cmd.id, label: String(cmd.label || cmd.id), hint: cmd.hint || '', run: cmd.run, plugin: rec.id });
        return true;
      }
    };

    api.events = {
      on: function (name, fn) {
        need('events');
        if (typeof fn !== 'function') throw new Error('on(name, fn) 需要函数');
        (state.listeners[name] = state.listeners[name] || []).push({ id: rec.id, fn: fn });
        return true;
      }
    };

    api.app = {
      version: function () { return global.__ireadVersion || '1.0.0-plugin.1'; },
      /* 应用初始化完成（书架、主题、书源都就绪）→ resolve */
      ready: function () { return state.ready || Promise.resolve(); },
      view: function () { var s = NR.state ? NR.state() : null; return s ? s.view : ''; },
      switchView: function (name) { if (NR.switchView) NR.switchView(String(name || '')); return true; },
      openBook: function (id) { if (NR.openBook) return Promise.resolve(NR.openBook(String(id || ''))); return Promise.reject(new Error('当前版本不支持从插件开书')); },
      openSources: function () {
        if (NR.online && typeof NR.online.openSources === 'function') { NR.online.openSources(); return true; }
        if (NR.plugins) NR.plugins.openManager();
        return true;
      }
    };

    /* 私有文件：<数据根>\plugin-data\<插件 id>\ 里随便读写，别的插件看不到 */
    api.fs = {
      dir: function () { return fsCall({ op: 'dir' }); },
      list: function () { return fsCall({ op: 'list' }).then(function (r) { return r.files || []; }); },
      read: function (name) { return fsCall({ op: 'read', name: String(name || '') }).then(function (r) { return r.text; }); },
      write: function (name, text) { return fsCall({ op: 'write', name: String(name || ''), text: String(text == null ? '' : text) }); },
      append: function (name, text) { return fsCall({ op: 'append', name: String(name || ''), text: String(text == null ? '' : text) }); },
      remove: function (name) { return fsCall({ op: 'remove', name: String(name || '') }); }
    };

    /* 快捷键：'Ctrl+Shift+K' / 'Alt+1' / 'F2' */
    api.shortcuts = {
      bind: function (combo, fn) {
        need('shortcuts');
        if (typeof fn !== 'function') throw new Error('bind(combo, fn) 需要函数');
        state.shortcuts.push({ id: rec.id, combo: normalizeCombo(combo), fn: fn });
        return true;
      }
    };

    /* 主题：读当前配色 + 订阅切换 */
    api.theme = {
      current: function () { need('theme'); return themeNow(); },
      on: function (fn) {
        need('theme');
        if (typeof fn !== 'function') throw new Error('on(fn) 需要函数');
        (state.listeners['theme:change'] = state.listeners['theme:change'] || []).push({ id: rec.id, fn: fn });
        return true;
      }
    };

    /* 插件之间与自身 */
    api.plugins = {
      list: function () {
        return state.discovered.map(function (r) {
          return { id: r.id, name: r.manifest.name || r.id, version: r.manifest.version || '0.0.0', enabled: isEnabled(r.id, r.source) };
        });
      },
      reload: function () { return reloadAll(); }
    };

    /* 热重载支持：插件可以登记「卸载时要清理的东西」（自建面板、定时器等），
       reloadAll() 卸载时逐个调用；不登记的话，重载后旧面板会残留在 body 上。 */
    api.onUnload = function (fn) {
      if (typeof fn === 'function') {
        (state.cleanups[rec.id] = state.cleanups[rec.id] || []).push(fn);
      }
      return true;
    };

    return api;
  }

  /* ---------------- 插槽渲染 ---------------- */
  /* 有的插槽容器会被主程序整块重写（详情页 #bookdBody），静态节点会被冲掉，
     所以每次渲染前先确保宿主存在；丢失就重新挂到该页滚动容器的最底下。 */
  function ensureHost(slot) {
    var host = document.querySelector('[data-plg-slot="' + slot + '"]');
    if (slot === 'detail.bottom') {
      /* 详情页的滚动容器是 #bookdBody，插槽必须挂在它内部才会跟着内容滚；
         静态节点在 index.html 里、并且每次渲染都会被 innerHTML 冲掉，所以这里负责搬回去/重建。 */
      var body = document.getElementById('bookdBody');
      if (body) {
        if (!host) {
          host = document.createElement('div');
          host.className = 'plg-slot plg-slot--detail';
          host.setAttribute('data-plg-slot', slot);
        }
        if (host.parentElement !== body) body.appendChild(host);
        return host;
      }
    }
    return host;
  }

  function refreshSlot(slot) {
    var host = ensureHost(slot);
    if (!host) return;
    var list = state.slots[slot] || [];
    host.innerHTML = '';
    host.classList.toggle('plg-slot--empty', list.length === 0);
    list.forEach(function (entry) {
      var box = document.createElement('section');
      box.className = 'plg-card';
      box.setAttribute('data-plugin', entry.id);
      box.setAttribute('data-slot', slot);
      host.appendChild(box);
      /* 必须用「这个插槽这一次注册的」render：同一个插件给多个插槽挂内容时，
         以前按 id 找第一个 render，四个插槽会全都画成第一个插槽的内容。 */
      exitReporting(entry, box);
    });
  }

  function refreshSlots() {
    Object.keys(SLOT_LABEL).forEach(refreshSlot);
  }


  /* ---------------- 插件页面（侧边栏入口 + 独立视图） ---------------- */

  function pageKey(pluginId, pageId) {
    return String(pluginId) + ':' + String(pageId || 'main');
  }

  function addPage(rec, def) {
    var id = String(def.id || 'main').replace(/[^\w-]/g, '');
    var key = pageKey(rec.id, id);
    if (state.pages[key]) removePage(key);

    var title = String(def.title || rec.name || '插件');
    var btn = document.createElement('button');
    btn.className = 'nav__tab plg-nav';
    btn.type = 'button';
    btn.setAttribute('data-view', 'plg:' + key);
    btn.setAttribute('aria-label', title);
    btn.setAttribute('aria-controls', 'plgView_' + key.replace(':', '_'));
    btn.innerHTML = (def.icon
        ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + def.icon + '</svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></svg>')
      + '<span class="nav__label">' + escapeHTML(title) + '</span>';

    // 位置：紧跟在「书城」后面；没有书城就放最后一组末尾
    var group = document.querySelector('#mainNav .main-nav__group') || document.getElementById('mainNav');
    var anchor = null;
    [].forEach.call(document.querySelectorAll('#mainNav .nav__tab'), function (b) {
      if (b.getAttribute('data-view') === 'bookstore') anchor = b;
    });
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else if (group) group.appendChild(btn);

    var box = document.createElement('section');
    box.className = 'view plg-view hidden';
    box.id = 'plgView_' + key.replace(':', '_');
    box.setAttribute('data-plg-view', key);

    /* 插件页原本是空 section，插件自己画满整页，于是没有 data-win-drag 区域 ——
       无边框窗口在插件页里点哪儿都拖不动。这里补一条和 views 一致的顶带：
       它只是一个可拖动窗口的空条，插件内容放进 .plg-body，
       插件 render() 清空 body 时不会把顶带一起清掉。 */
    var grip = document.createElement('div');
    grip.className = 'plg-grip';
    grip.setAttribute('data-win-drag', '1');
    grip.setAttribute('aria-hidden', 'true');
    box.appendChild(grip);

    var body = document.createElement('div');
    body.className = 'plg-body';
    box.appendChild(body);

    (document.getElementById('app') || document.body).appendChild(box);

    btn.onclick = function () {
      try { NR.switchView('plg:' + key); } catch (e) { /* 主程序异常不影响插件 */ }
    };

    state.pages[key] = {
      key: key,
      id: id,
      title: title,
      nav: btn,
      box: box,
      body: body,
      def: def,
      rec: rec,
      plugin: rec.id
    };
    return {
      key: key,
      show: function () { if (NR.switchView) NR.switchView('plg:' + key); return true; },
      render: function () { renderPage(key); return true; },
      remove: function () { removePage(key); return true; },
      box: box
    };
  }

  function removePage(key) {
    var pg = state.pages[key];
    if (!pg) return;
    if (pg.nav && pg.nav.parentNode) pg.nav.parentNode.removeChild(pg.nav);
    if (pg.box && pg.box.parentNode) pg.box.parentNode.removeChild(pg.box);
    delete state.pages[key];
  }

  function renderPage(key) {
    var pg = state.pages[key];
    if (!pg) return;
    if (typeof pg.def.render !== 'function') {
      pg.body.innerHTML = '<div class="plg-view__empty">这个插件页面没有实现 render()</div>';
      return;
    }
    try {
      pg.def.render(pg.body, { api: apiFor(pg.rec), plugin: pg.plugin });
    } catch (e) {
      pg.body.innerHTML = '';
      var err = document.createElement('div');
      err.className = 'plg-view__err';
      err.textContent = '插件页面出错：' + (e && e.message ? e.message : e);
      pg.body.appendChild(err);
      state.errors.push({ id: pg.plugin, message: 'page ' + key + ': ' + (e && e.message ? e.message : e) });
    }
  }

  /* 当前正在显示的插件页 key（app.js 的视图名是 'plg:<plugin>:<page>'） */
  function currentPageKey() {
    var v = '';
    try { v = String((NR.state && NR.state().view) || ''); } catch (e) { v = ''; }
    return v.indexOf('plg:') === 0 ? v.slice(4) : '';
  }

  /** 返回键交给插件自己处理：page 定义里可提供 onBack()，
   *  返回 true 表示「我退了一层」（例如详情 → 列表），false 表示已在最上级。
   *  app.js 的 backStep 会先调它；返回 false 且当前就在插件页 → 交给宿主退出应用。 */
  function back() {
    var key = currentPageKey();
    if (!key) return false;
    var pg = state.pages[key];
    if (!pg || typeof pg.def.onBack !== 'function') return false;
    try {
      return !!pg.def.onBack({ page: pg.key, api: apiFor(pg.rec) });
    } catch (e) {
      state.errors.push({ id: pg.plugin, message: 'onBack ' + key + ': ' + (e && e.message ? e.message : e) });
      return false;
    }
  }

  /** 主程序切换视图时调用（app.js 的 paintView） */
  function showPage(key) {
    var pg = state.pages[key];
    if (!pg) return false;
    renderPage(key);
    return true;
  }

  function clearPages(pluginId) {
    Object.keys(state.pages).forEach(function (k) {
      if (state.pages[k].plugin === pluginId) removePage(k);
    });
  }

  function exitReporting(entry, box) {
    var render = entry && entry.render;
    if (!render) return;
    var fail = function (err) {
      box.innerHTML = '<p class="plg-card__err">插件出错：' + escapeHTML(err && err.message || err) + '</p>';
    };
    try {
      var out = render(box);
      if (out && typeof out.then === 'function') {
        out.then(function () { markRowCard(box); }, fail);
      } else {
        markRowCard(box);
      }
    } catch (err) {
      fail(err);
    }
  }

  /* 插槽卡片如果渲染出来的是原生行（.mine-row），就把外面那层卡片样式去掉，
     让它看起来就是「我的」里的一行，而不是套了个框。 */
  function markRowCard(box) {
    var first = box.firstElementChild;
    var isRow = !!(first && first.classList && first.classList.contains('mine-row'));
    box.classList.toggle('plg-card--bare', isRow);
    var host = box.parentNode;
    if (host && host.classList && isRow) host.classList.add('plg-slot--row');
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 发现与加载 ---------------- */
  function discover() {
    if (!pf.plugins) return Promise.resolve([]);
    return Promise.resolve(pf.plugins()).then(function (res) {
      res = res || {};
      state.dir = res.dir || '';
      state.builtin = res.builtin || '';
      state.discovered = [];
      state.errors = [];
      (res.entries || []).forEach(function (entry) {
        var man = null;
        try { man = JSON.parse(entry.manifest); } catch (e) { state.errors.push({ id: entry.id, message: 'manifest.json 不是合法 JSON' }); return; }
        if (!man || !man.id || man.id !== entry.id) { state.errors.push({ id: entry.id, message: 'manifest.id 必须与目录名一致' }); return; }
        var entryFile = String(man.entry || 'main.js').replace(/^\/+/, '');
        state.discovered.push({
          id: entry.id,
          source: entry.source || 'user',
          manifest: man,
          url: (entry.source === 'user' ? 'https://plugins.local/' : 'plugins/') + entry.id + '/' + entryFile
        });
      });
      state.discovered.sort(function (a, b) {
        if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1;
        return String(a.manifest.name || a.id).localeCompare(String(b.manifest.name || b.id), 'zh-Hans-CN');
      });
      return state.discovered;
    }, function (err) {
      state.errors.push({ id: '*', message: '读取插件清单失败：' + (err && err.message || err) });
      return [];
    });
  }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('插件脚本加载失败：' + url)); };
      document.head.appendChild(s);
    });
  }

  /* 单个插件的 setup 最多等 3 秒：一个插件卡死不能拖垮其它插件（v2 修） */
  var SETUP_TIMEOUT = 3000;

  function loadOne(rec) {
    state.pending = rec.id;
    var captured = null;
    global.LampPlugin = {
      define: function (def) {
        if (!def || typeof def.setup !== 'function') throw new Error('LampPlugin.define 需要 { setup }');
        captured = def;
      }
    };
    return loadScript(rec.url).then(function () {
      state.pending = null;
      if (!captured) throw new Error('插件没有调用 LampPlugin.define');
      var api = apiFor(rec);
      var out = captured.setup(api);
      if (out && typeof out.then === 'function') {
        return Promise.race([
          out.then(function () { return { rec: rec, api: api }; }),
          new Promise(function (_, reject) {
            setTimeout(function () {
              reject(new Error('插件初始化超时（' + SETUP_TIMEOUT + 'ms 内 setup 没有返回），已跳过'));
            }, SETUP_TIMEOUT);
          })
        ]);
      }
      return { rec: rec, api: api };
    }, function (err) {
      state.pending = null;
      throw err;
    });
  }

  function load() {
    if (state.loading) return state.loading;
    state.loading = discover().then(function (list) {
      var wanted = list.filter(function (rec) { return isEnabled(rec.id, rec.source); });
      var chain = Promise.resolve();
      wanted.forEach(function (rec) {
        chain = chain.then(function () {
          return loadOne(rec).then(function (ok) {
            state.active.push(ok);
          }, function (err) {
            state.errors.push({ id: rec.id, message: err && err.message || String(err) });
          });
        });
      });
      return chain.then(function () {
        state.loaded = true;
        refreshSlots();
        emit('app:ready', { plugins: state.active.map(function (p) { return p.rec.id; }) });
        if (state.readyResolve) { state.readyResolve({ plugins: state.active.slice(), errors: state.errors.slice() }); state.readyResolve = null; }
        return state.active;
      });
    }).finally(function () { state.loading = null; });
    return state.loading;
  }

  /* ---------------- 热重载 ----------------
     不刷新页面：卸载现有插件（插槽/命令/快捷键/页面/事件/插件自建面板）→ 重新发现 → 重新加载。
     插件可以通过 api.onUnload(fn) 登记自己的清理逻辑（移除面板、清定时器）。 */
  function teardownPlugin(id) {
    (state.cleanups[id] || []).forEach(function (fn) {
      try { fn(); } catch (e) { if (global.console && console.warn) console.warn('[plugin:' + id + '] 卸载清理出错', e); }
    });
    delete state.cleanups[id];
    Object.keys(state.slots).forEach(function (slot) {
      var kept = (state.slots[slot] || []).filter(function (e) { return e.id !== id; });
      state.slots[slot] = kept;
      refreshSlot(slot);
    });
    state.commands = state.commands.filter(function (c) { return c.plugin !== id; });
    state.shortcuts = state.shortcuts.filter(function (s) { return s.id !== id; });
    Object.keys(state.listeners).forEach(function (name) {
      state.listeners[name] = (state.listeners[name] || []).filter(function (e) { return e.id !== id; });
    });
    state.usage[id] = {};
    clearPages(id);
    state.active = state.active.filter(function (p) { return p.rec.id !== id; });
  }

  function reloadAll() {
    /* 先关掉自己开的层（命令面板/管理面板/插件表单），避免重载后指向旧实例。
       管理面板是接管 #mineList/#mineDetail 的：移除它的同时必须把「我的」还原成列表态，
       否则 mineList 还 hidden、detailBody 空着，整个「我的」页就是一片空白（黑屏卡死）。 */
    try {
      var layers = document.querySelectorAll('.plg-palette,.plg-manager,.plg-form-mask');
      Array.prototype.forEach.call(layers, function (n) { n.remove(); });
    } catch (e) { /* 忽略 */ }
    managerPanel = null;
    var wasManagerOpen = state.managerOpen;
    state.managerOpen = false;
    state.bodyHidden = null;
    if (wasManagerOpen) {
      var mList = document.getElementById('mineList');
      var mDetail = document.getElementById('mineDetail');
      var mTitle = document.getElementById('mineDetailTitle');
      if (mDetail) mDetail.classList.add('hidden');
      if (mList) mList.classList.remove('hidden');
      if (mTitle) mTitle.textContent = '阅读设置';
      var setBody = document.getElementById('setBody');
      if (setBody) setBody.classList.remove('hidden');
    }

    var ids = state.active.map(function (p) { return p.rec.id; });
    ids.forEach(teardownPlugin);
    state.discovered = [];
    state.errors = [];
    state.loaded = false;

    return discover().then(function (list) {
      var wanted = list.filter(function (rec) { return isEnabled(rec.id, rec.source); });
      var chain = Promise.resolve();
      wanted.forEach(function (rec) {
        chain = chain.then(function () {
          return loadOne(rec).then(function (ok) {
            state.active.push(ok);
          }, function (err) {
            state.errors.push({ id: rec.id, message: err && err.message || String(err) });
          });
        });
      });
      return chain.then(function () {
        state.loaded = true;
        refreshSlots();
        emit('app:ready', { plugins: state.active.map(function (p) { return p.rec.id; }), reloaded: true });
        var bad = state.errors.length;
        if (NR.toast) NR.toast('插件已重载' + (bad ? '（' + bad + ' 个出错）' : ''));
        return { ok: true, errors: state.errors.slice() };
      });
    }, function (err) {
      if (NR.toast) NR.toast('插件重载失败：' + (err && err.message || err) + '，刷新页面可恢复');
      return { ok: false, error: String(err && err.message || err) };
    });
  }

  /* ---------------- 事件 ---------------- */
  function emit(name, payload) {
    var list = state.listeners[name] || [];
    list.forEach(function (item) {
      try { item.fn(payload == null ? {} : payload); } catch (e) {
        if (global.console && console.warn) console.warn('[plugin:' + item.id + '] 事件 ' + name + ' 处理出错', e);
      }
    });
  }

  /* ---------------- 命令面板 ---------------- */
  var paletteOpen = false;

  function openPalette() {
    if (paletteOpen) return;
    if (!state.commands.length) {
      if (NR.toast) NR.toast('还没有插件注册命令');
      return;
    }
    paletteOpen = true;
    var wrap = document.createElement('div');
    wrap.className = 'plg-palette';
    wrap.innerHTML =
      '<div class="plg-palette__mask"></div>' +
      '<div class="plg-palette__box" role="dialog" aria-label="命令面板">' +
      '  <input class="plg-palette__input" type="text" placeholder="输入命令名，回车执行" aria-label="搜索命令">' +
      '  <div class="plg-palette__list" role="listbox"></div>' +
      '  <div class="plg-palette__foot"><span>Ctrl + K 打开 / Esc 关闭</span></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var input = wrap.querySelector('.plg-palette__input');
    var list = wrap.querySelector('.plg-palette__list');
    var shown = [];
    var cursor = 0;

    function paint() {
      var kw = String(input.value || '').trim().toLowerCase();
      shown = state.commands.filter(function (c) {
        return !kw || c.label.toLowerCase().indexOf(kw) >= 0 || c.id.toLowerCase().indexOf(kw) >= 0;
      });
      cursor = Math.min(cursor, Math.max(0, shown.length - 1));
      list.innerHTML = '';
      if (!shown.length) { list.innerHTML = '<p class="plg-palette__empty">没有匹配的命令</p>'; return; }
      shown.forEach(function (c, i) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'plg-palette__row' + (i === cursor ? ' on' : '');
        row.innerHTML = '<span class="plg-palette__label">' + escapeHTML(c.label) + '</span>' +
          '<span class="plg-palette__hint">' + escapeHTML(c.plugin) + (c.hint ? ' · ' + escapeHTML(c.hint) : '') + '</span>';
        row.onclick = function () { closePalette(); runCommand(c); };
        list.appendChild(row);
      });
    }

    function closePalette() {
      paletteOpen = false;
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
    }

    function runCommand(c) {
      try {
        var out = c.run();
        if (out && typeof out.catch === 'function') out.catch(function (e) { if (NR.toast) NR.toast('命令执行失败：' + (e && e.message || e)); });
      } catch (e) {
        if (NR.toast) NR.toast('命令执行失败：' + (e && e.message || e));
      }
    }

    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePalette(); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); cursor = Math.min(cursor + 1, shown.length - 1); paint(); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); if (shown[cursor]) { var c = shown[cursor]; closePalette(); runCommand(c); } }
    }

    input.addEventListener('input', function () { cursor = 0; paint(); });
    document.addEventListener('keydown', onKey, true);
    wrap.querySelector('.plg-palette__mask').onclick = closePalette;
    paint();
    input.focus();
  }

  /* ---------------- 插件管理面板（「我的 → 插件」） ---------------- */
  function pluginCard(rec) {
    var man = rec.manifest;
    var on = isEnabled(rec.id, rec.source);
    var err = null;
    state.errors.forEach(function (e) { if (e.id === rec.id) err = e.message; });
    var perms = (man.permissions || []).map(function (p) {
      return '<span class="plg-perm" title="' + escapeHTML(p) + '">' + escapeHTML(PERM_LABEL[p] || p) + '</span>';
    }).join('') || '<span class="plg-perm plg-perm--none">没声明会用哪些能力</span>';
    var slots = (man.slots || []).map(function (s) { return SLOT_LABEL[s] || s; }).join('、');
    var storeKB = 0;
    try { storeKB = Math.round((storeFor(rec.id).used() || 0) / 1024); } catch (e) { storeKB = 0; }

    var card = document.createElement('div');
    card.className = 'plg-item' + (on ? '' : ' is-off');
    card.innerHTML =
      '<div class="plg-item__top">' +
      '  <div class="plg-item__name">' + escapeHTML(man.name || rec.id) +
      '    <span class="plg-item__ver">v' + escapeHTML(man.version || '0.0.0') + '</span>' +
      '    <span class="plg-item__src">' + (rec.source === 'builtin' ? '内置示例' : '用户插件') + '</span>' +
      '  </div>' +
      '  <button class="plg-item__toggle btn' + (on ? ' btn--lamp' : '') + '" type="button">' + (on ? '已启用' : '已停用') + '</button>' +
      '</div>' +
      '<p class="plg-item__desc">' + escapeHTML(man.description || '（没有写说明）') + '</p>' +
      '<div class="plg-item__perms">' + perms + '</div>' +
      (slots ? '<p class="plg-item__meta">显示位置：' + escapeHTML(slots) + '</p>' : '') +
      (storeKB ? '<p class="plg-item__meta">存储 ' + storeKB + 'KB</p>' : '') +
      (man.author ? '<p class="plg-item__meta">作者：' + escapeHTML(man.author) + '</p>' : '') +
      (err ? '<p class="plg-card__err">加载失败：' + escapeHTML(err) + '</p>' : '');

    card.querySelector('.plg-item__toggle').onclick = function () {
      setEnabled(rec.id, !isEnabled(rec.id, rec.source));
      if (NR.toast) NR.toast('已' + (isEnabled(rec.id, rec.source) ? '启用' : '停用') + '，点「重新加载」生效');
      paintManager();
    };
    return card;
  }

  /* 载入插件后的「它会用到什么」清单：只告知、不拦截（v2） */
  function showCapabilitySheet(res) {
    var ids = (res.plugins || []).map(function (p) { return p.id; });
    if (!ids.length && res.id) ids.push(res.id);
    return Promise.resolve(pf.plugins ? pf.plugins() : { entries: [] }).then(function (all) {
      var entries = ((all && all.entries) || []).filter(function (e) { return ids.indexOf(e.id) >= 0; });
      return new Promise(function (resolve) {
        var wrap = document.createElement('div');
        wrap.className = 'plg-form-mask';
        var rows = entries.map(function (e) {
          var man = {};
          try { man = JSON.parse(e.manifest) || {}; } catch (err) { man = {}; }
          var perms = (man.permissions || []).map(function (p) {
            return '<span class="plg-perm">' + escapeHTML(PERM_LABEL[p] || p) + '</span>';
          }).join('') || '<span class="plg-perm plg-perm--none">没声明</span>';
          var slots = (man.slots || []).map(function (s) { return SLOT_LABEL[s] || s; }).join('、');
          return '<div class="plg-sheet__item">' +
            '<p class="plg-sheet__name">' + escapeHTML(man.name || e.id) +
            ' <span class="plg-item__ver">v' + escapeHTML(man.version || '0.0.0') + '</span></p>' +
            (man.description ? '<p class="plg-sheet__meta">' + escapeHTML(man.description) + '</p>' : '') +
            '<div class="plg-item__perms">' + perms + '</div>' +
            (slots ? '<p class="plg-sheet__meta">显示位置：' + escapeHTML(slots) + '</p>' : '') +
            '</div>';
        }).join('');
        wrap.innerHTML = '<div class="plg-form plg-sheet" role="dialog" aria-modal="true">' +
          '<h3 class="plg-form__title">已载入 ' + (entries.length || ids.length) + ' 个插件</h3>' +
          '<p class="plg-form__desc">插件能力默认全部开放：读书架、联网、读写自己的文件、改界面、注册快捷键、读主题配色。' +
          '下面只是它会用到的能力，开始用之前请确认来源可信。</p>' +
          '<div class="plg-form__body">' + (rows || '<p class="plg-sheet__meta">（读不到插件清单）</p>') + '</div>' +
          '<div class="plg-form__foot">' +
          '<button class="btn" type="button" data-plg-form="cancel">先不启用</button>' +
          '<button class="btn btn--primary" type="button" data-plg-form="ok">好的，开始用</button>' +
          '</div></div>';
        wrap.addEventListener('click', function (ev) {
          var act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-plg-form');
          if (act === 'ok') { wrap.remove(); resolve(true); }
          else if (act === 'cancel' || ev.target === wrap) { wrap.remove(); resolve(false); }
        });
        document.body.appendChild(wrap);
      });
    });
  }

  var managerPanel = null;

  function paintManager() {
    if (!managerPanel) return;
    managerPanel.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'plg-manager__head';
    head.innerHTML =
      '<h2 class="plg-manager__title">插件</h2>' +
      '<p class="plg-manager__sub">插件是直接跑在主页面里的 JavaScript：书架、联网、自己的文件、界面、快捷键、主题都能用。' +
      '能力默认全部开放（不弹授权），下面标签只说明「作者说它会用到什么」，装之前请确认来源可信。</p>' +
      '<p class="plg-manager__path">用户插件目录：<code>' + escapeHTML(state.dir || '（未就绪）') + '</code></p>' +
      '<div class="plg-manager__actions">' +
      '  <button class="btn" type="button" data-plg-act="open">打开插件目录</button>' +
      '  <button class="btn" type="button" data-plg-act="import">载入插件</button>' +
      '  <button class="btn" type="button" data-plg-act="reload">重新加载</button>' +
      '</div>';
    managerPanel.appendChild(head);

    var list = document.createElement('div');
    list.className = 'plg-manager__list';
    state.discovered.forEach(function (rec) { list.appendChild(pluginCard(rec)); });
    if (!state.discovered.length) {
      list.innerHTML = '<p class="plg-manager__empty">还没有插件。点上面的「载入插件」选一个插件压缩包（.zip）即可。</p>';
    }
    managerPanel.appendChild(list);

    var foot = document.createElement('div');
    foot.className = 'plg-manager__foot';
    foot.innerHTML = '<p>插件协议：<code>LampPlugin.define({ setup(api) { … } })</code>；' +
      '可用能力按 manifest.json 的 permissions 逐项放行。</p>';
    managerPanel.appendChild(foot);

    managerPanel.querySelector('[data-plg-act="open"]').onclick = function () {
      if (pf.openFolder && state.dir) pf.openFolder(state.dir).catch(function () { /* 忽略 */ });
    };
    managerPanel.querySelector('[data-plg-act="import"]').onclick = function () {
      if (!pf.importPlugin) { if (NR.toast) NR.toast('这个版本不支持载入插件压缩包'); return; }
      pf.importPlugin().then(function (res) {
        if (!res || res.canceled) return;
        if (!res.ok) { if (NR.toast) NR.toast('载入失败：' + (res.error || '未知原因')); return; }
        showCapabilitySheet(res).then(function (go) {
          if (!go) { paintManager(); return; }
          reloadAll().then(function (r) {
            if (r && r.ok) { if (managerPanel) paintManager(); return; }
            global.location.reload();      // 热重载失败兜底
          });
        });
      }).catch(function (e) { if (NR.toast) NR.toast('载入失败：' + ((e && e.message) || e)); });
    };
    managerPanel.querySelector('[data-plg-act="reload"]').onclick = function () {
      reloadAll().then(function (r) {
        if (r && r.ok && managerPanel) paintManager();
      });
    };
  }

  function openManager() {
    var list = document.getElementById('mineList');
    var detail = document.getElementById('mineDetail');
    var body = document.getElementById('mineDetailBody');
    if (!list || !detail || !body) return false;
    if (NR.switchView) NR.switchView('mine');
    var title = document.getElementById('mineDetailTitle');
    if (title) title.textContent = '插件';

    var setBody = document.getElementById('setBody');
    if (setBody && setBody.parentNode === body) {
      // 设置面板此刻挂在详情里 → 先藏起来，退出插件面板时恢复
      state.bodyHidden = setBody;
      setBody.classList.add('hidden');
    }

    if (!managerPanel) {
      managerPanel = document.createElement('div');
      managerPanel.className = 'plg-manager';
      body.appendChild(managerPanel);
    }
    paintManager();
    list.classList.add('hidden');
    detail.classList.remove('hidden');
    state.managerOpen = true;
    return true;
  }

  function closeManager() {
    if (!state.managerOpen) return false;
    state.managerOpen = false;
    if (state.bodyHidden) {
      state.bodyHidden.classList.remove('hidden');
      state.bodyHidden = null;
    }
    if (managerPanel) { managerPanel.remove(); managerPanel = null; }
    // 插件面板是自带的一套 DOM：退出时自己把「我的」恢复成列表态，
    // 因为 app.js 的 closeMinePane 在没有设置子页时会提前 return。
    var list = document.getElementById('mineList');
    var detail = document.getElementById('mineDetail');
    var title = document.getElementById('mineDetailTitle');
    if (detail) detail.classList.add('hidden');
    if (list) list.classList.remove('hidden');
    if (title) title.textContent = '阅读设置';
    return true;
  }

  /* ---------------- 键盘：插件快捷键 + 命令面板 ---------------- */
  function onGlobalKey(ev) {
    var k = ev.key;
    if (!k) return;

    /* 插件注册的快捷键优先（冲突时先注册的先赢） */
    if (state.shortcuts.length) {
      var combo = comboOfEvent(ev);
      for (var i = 0; i < state.shortcuts.length; i++) {
        if (state.shortcuts[i].combo !== combo) continue;
        ev.preventDefault();
        try { state.shortcuts[i].fn(ev); } catch (e) {
          if (global.console && console.warn) console.warn('[plugin:' + state.shortcuts[i].id + '] 快捷键出错', e);
        }
        return;
      }
    }

    var cmdK = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (k === 'k' || k === 'K');
    var cmdP = (ev.ctrlKey || ev.metaKey) && ev.shiftKey && (k === 'p' || k === 'P');
    if (!cmdK && !cmdP) return;
    ev.preventDefault();
    openPalette();
  }

  /* ---------------- 对外接口 ---------------- */
  NR.plugins = {
    load: load,
    discover: discover,
    openManager: openManager,
    closeManager: closeManager,
    refresh: refreshSlots,
    emit: emit,
    openPalette: openPalette,
    isEnabled: isEnabled,
    reload: reloadAll,
    list: function () { return state.discovered.slice(); },
    active: function () { return state.active.map(function (p) { return p.rec.id; }); },
    errors: function () { return state.errors.slice(); },
    showPage: function (key) { return showPage(String(key || '')); },
    back: back,
    currentPage: currentPageKey,
    pages: function () {
      return Object.keys(state.pages).map(function (k) {
        var pg = state.pages[k];
        return { key: k, plugin: pg.plugin, id: pg.id, title: pg.title };
      });
    },
    usage: function () { return JSON.parse(JSON.stringify(state.usage || {})); },
    shortcuts: function () { return state.shortcuts.map(function (s) { return { id: s.id, combo: s.combo }; }); },
    ready: function () { return state.ready || Promise.resolve(); },
    slots: function () { return Object.keys(SLOT_LABEL); },
    get dir() { return state.dir; }
  };

  state.ready = new Promise(function (resolve) { state.readyResolve = resolve; });

  if (global.document) {
    document.addEventListener('keydown', onGlobalKey, false);
    var kick = function () { load(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(kick, 60); });
    else setTimeout(kick, 60);
  }
})(window);
