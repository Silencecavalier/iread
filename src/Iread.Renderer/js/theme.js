/* =========================================================================
 * theme.js — 界面主题（整窗配色）
 * -------------------------------------------------------------------------
 * 一个主题 = 一组颜色变量；切换时把它们写到 :root 上，
 * 所有组件都只引用变量，所以换主题不需要改任何组件样式。
 *
 * 配色参考现成方案：
 *   ink    墨刻（默认，暖纸灯）
 *   night  纯黑（OLED）
 *   solar  Solarized Dark
 *   nord   Nord
 *   forest 墨绿
 *   sepia  羊皮纸（浅色）
 *   light  GitHub Light（浅色）
 * ========================================================================= */
(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var KEY = 'nr_ui_theme';
  var PICK_KEY = 'ui_theme_picked';   /* 用户手动选过主题（没有它才允许按端默认值切换） */
  var current = 'ink';

  /* 手机壳默认「薄荷」，桌面默认「墨刻」 */
  function isMobileShell() {
    try { return typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches; } catch (e) { return false; }
  }
  function defId() { return isMobileShell() ? 'kazumi-light' : 'ink'; }

  /* 每个主题给全同一批变量，避免切换后残留上一个主题的颜色 */
  function palette(name) {
    switch (name) {
      case 'night':
        return {
          ink0: '#000000', ink1: '#050506', ink2: '#0b0b0d', ink3: '#121214', ink4: '#1a1a1d',
          fg: '#e8e8ea', fg2: '#a0a0a6', fg3: '#6c6c73', fg4: '#4a4a50',
          hair: 'rgba(255,255,255,.06)', hair2: 'rgba(255,255,255,.11)', hair3: 'rgba(255,255,255,.18)',
          lamp: '#e3b47c', lamp2: '#f4cd97', lampWash: 'rgba(227,180,124,.10)',
          lampLine: 'rgba(227,180,124,.34)', danger: '#e0716b'
        };
      case 'solar':
        /* Solarized Dark: base03/02/01 + 蓝青强调（#268bd2 / #2aa198 / #b58900） */
        return {
          ink0: '#002b36', ink1: '#073642', ink2: '#0a3d4a', ink3: '#0f4553', ink4: '#15505f',
          fg: '#eee8d5', fg2: '#a8b3ae', fg3: '#7c8b86', fg4: '#5b6a66',
          hair: 'rgba(147,161,161,.10)', hair2: 'rgba(147,161,161,.18)', hair3: 'rgba(147,161,161,.28)',
          lamp: '#b58900', lamp2: '#cb9c1a', lampWash: 'rgba(181,137,0,.12)',
          lampLine: 'rgba(181,137,0,.38)', danger: '#dc322f'
        };
      case 'nord':
        /* Nord: nord0..3 + frost 蓝 */
        return {
          ink0: '#2e3440', ink1: '#2b303b', ink2: '#333a46', ink3: '#3b4252', ink4: '#434c5e',
          fg: '#eceff4', fg2: '#d8dee9', fg3: '#9aa4b5', fg4: '#6d788c',
          hair: 'rgba(216,222,233,.10)', hair2: 'rgba(216,222,233,.18)', hair3: 'rgba(216,222,233,.28)',
          lamp: '#88c0d0', lamp2: '#a3d4e0', lampWash: 'rgba(136,192,208,.13)',
          lampLine: 'rgba(136,192,208,.4)', danger: '#bf616a'
        };
      case 'forest':
        return {
          ink0: '#0d1512', ink1: '#111c18', ink2: '#16241f', ink3: '#1c2c26', ink4: '#23362e',
          fg: '#e2e8e3', fg2: '#a8b8ad', fg3: '#75897c', fg4: '#54665a',
          hair: 'rgba(210,230,215,.08)', hair2: 'rgba(210,230,215,.14)', hair3: 'rgba(210,230,215,.22)',
          lamp: '#8fbf9f', lamp2: '#aad4b8', lampWash: 'rgba(143,191,159,.12)',
          lampLine: 'rgba(143,191,159,.36)', danger: '#d97a72'
        };
      case 'sepia':
        /* 浅色：羊皮纸（对比度按 WCAG 调过，正文 ≥ 7:1） */
        return {
          ink0: '#f4efe6', ink1: '#efe8dc', ink2: '#e7dfd0', ink3: '#ddd3c1', ink4: '#d0c4af',
          fg: '#2a231c', fg2: '#4e4438', fg3: '#6f6353', fg4: '#8b7d69',
          hair: 'rgba(60,45,25,.10)', hair2: 'rgba(60,45,25,.18)', hair3: 'rgba(60,45,25,.28)',
          lamp: '#9a6b2f', lamp2: '#b58340', lampWash: 'rgba(154,107,47,.12)',
          lampLine: 'rgba(154,107,47,.38)', danger: '#b03b32'
        };
      case 'light':
        /* GitHub Light */
        return {
          ink0: '#ffffff', ink1: '#f6f8fa', ink2: '#eef1f4', ink3: '#e4e8ec', ink4: '#d8dee4',
          fg: '#1f2328', fg2: '#424a53', fg3: '#656d76', fg4: '#8b949e',
          hair: 'rgba(31,35,40,.09)', hair2: 'rgba(31,35,40,.16)', hair3: 'rgba(31,35,40,.26)',
          lamp: '#9a6700', lamp2: '#b8860b', lampWash: 'rgba(154,103,0,.10)',
          lampLine: 'rgba(154,103,0,.34)', danger: '#cf222e'
        };
      case 'kazumi-light':
        return {
          ink0: '#f5f7ef', ink1: '#e7eedf', ink2: '#fffef9', ink3: '#edf2e7', ink4: '#dce6d5',
          fg: '#273329', fg2: '#52604f', fg3: '#73806f', fg4: '#96a091',
          hair: 'rgba(39,51,41,.08)', hair2: 'rgba(39,51,41,.14)', hair3: 'rgba(39,51,41,.22)',
          lamp: '#9dce96', lamp2: '#b5dfad', lampWash: 'rgba(157,206,150,.18)',
          lampLine: 'rgba(91,137,82,.34)', danger: '#b95148'
        };
      case 'kazumi-dark':
        return {
          ink0: '#10150f', ink1: '#182117', ink2: '#202a1e', ink3: '#293625', ink4: '#354431',
          fg: '#edf3e9', fg2: '#b8c5b1', fg3: '#87957f', fg4: '#63705d',
          hair: 'rgba(230,243,222,.07)', hair2: 'rgba(230,243,222,.13)', hair3: 'rgba(230,243,222,.21)',
          lamp: '#9dce96', lamp2: '#b5dfad', lampWash: 'rgba(157,206,150,.12)',
          lampLine: 'rgba(181,223,173,.34)', danger: '#e07b70'
        };
      case 'ink':
      default:
        return {
          ink0: '#0a0b0d', ink1: '#0e1013', ink2: '#14171b', ink3: '#191d22', ink4: '#22272e',
          fg: '#eceef2', fg2: '#a4abb6', fg3: '#6d7480', fg4: '#4d545e',
          hair: 'rgba(255,255,255,.055)', hair2: 'rgba(255,255,255,.10)', hair3: 'rgba(255,255,255,.16)',
          lamp: '#e0b07b', lamp2: '#f0c896', lampWash: 'rgba(224,176,123,.10)',
          lampLine: 'rgba(224,176,123,.30)', danger: '#e0655d'
        };
    }
  }

  /* 普通十六进制颜色解析：按钮底色来自各主题色板，前景必须自己算，
     不能再用一个固定的暖金深字（浅底主题上会直接失去对比度）。 */
  function luminance(hex) {
    var channels = hex.match(/[a-f0-9]{2}/gi).map(function (x) { return parseInt(x, 16) / 255; })
      .map(function (x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function foreground(background) {
    var dark = '#171a16', light = '#ffffff';
    return contrast(background, dark) >= contrast(background, light) ? dark : light;
  }
  function alpha(hex, opacity) {
    var c = hex.match(/[a-f0-9]{2}/gi).map(function (x) { return parseInt(x, 16); });
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + opacity + ')';
  }
  /* 用户反馈「字发灰发虚」：正文前景不再用色板里的柔和值，而是按页面底色取极端色——
     浅色主题纯黑 #000、深色主题纯白 #fff。次要文字把前景向底色混 18%，既压住灰雾又保持层级。 */
  function extreme(background) {
    return contrast(background, '#ffffff') >= contrast(background, '#000000') ? '#ffffff' : '#000000';
  }
  function mix(a, b, weightOfB) {
    var pa = a.match(/[a-f0-9]{2}/gi).map(function (x) { return parseInt(x, 16); });
    var pb = b.match(/[a-f0-9]{2}/gi).map(function (x) { return parseInt(x, 16); });
    var out = pa.map(function (v, i) { return Math.round(v * (1 - weightOfB) + pb[i] * weightOfB); });
    return '#' + out.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  }

  function apply(name) {
    var p = palette(name);
    var root = document.documentElement;
    var buttonFg = foreground(p.lamp);
    var buttonFg2 = foreground(p.lamp2);
    var textFg = extreme(p.ink0);
    var textFg2 = mix(textFg, p.ink0, 0.18);
    var map = {
      '--ink-0': p.ink0, '--ink-1': p.ink1, '--ink-2': p.ink2,
      '--ink-3': p.ink3, '--ink-4': p.ink4,
      /* 正文/次要文字按底色取极端色（见 extreme/mix 注释），--fg-3/--fg-4 仍是色板原值 */
      '--fg': textFg, '--fg-2': textFg2, '--fg-3': p.fg3, '--fg-4': p.fg4,
      '--hair': p.hair, '--hair-2': p.hair2, '--hair-3': p.hair3,
      '--lamp': p.lamp, '--lamp-2': p.lamp2, '--lamp-wash': p.lampWash,
      '--lamp-line': p.lampLine, '--danger': p.danger,
      /* 主按钮与统计面板：底色/前景/分隔线全部由当前色板派生 */
      '--btn-solid': p.lamp,
      '--btn-solid-2': p.lamp2,
      '--btn-solid-fg': buttonFg,
      '--btn-solid-fg-2': buttonFg2,
      '--stats-bg': p.lamp,
      '--stats-fg': buttonFg,
      '--stats-line': alpha(buttonFg, 0.18)
    };
    Object.keys(map).forEach(function (k) { root.style.setProperty(k, map[k]); });
    /* 存一份色板快照：boot-theme.js 在 <head> 里同步贴回，首帧就是正确主题（不会先闪墨刻） */
    try { localStorage.setItem('ui_theme_vars', JSON.stringify(map)); } catch (e) { }
    root.setAttribute('data-ui-theme', name);
    // 浅色主题下滚动条/表单控件也跟着亮
    var light = (name === 'sepia' || name === 'light' || name === 'kazumi-light');
    root.style.colorScheme = light ? 'light' : 'dark';
    current = name;
    /* 通知插件：主题变了（plugins.js 转发给 api.theme.on 的订阅者） */
    try {
      if (window.NR && NR.plugins && typeof NR.plugins.emit === 'function') NR.plugins.emit('theme:change', { name: name });
    } catch (e) { /* 插件出错不影响主题 */ }
    return name;
  }

  function list() {
    return [
      { id: 'ink', name: '墨刻', bg: '#0a0b0d', fg: '#eceef2', read: { bg: '#12141a', fg: '#c3c9d4' } },
      { id: 'night', name: '纯黑', bg: '#000000', fg: '#e8e8ea', read: { bg: '#000000', fg: '#a9aeb6' } },
      { id: 'solar', name: '青瓷', bg: '#002b36', fg: '#eee8d5', read: { bg: '#002b36', fg: '#d7d2c3' } },
      { id: 'nord', name: '雾蓝', bg: '#2e3440', fg: '#eceff4', read: { bg: '#2e3440', fg: '#d8dee9' } },
      { id: 'forest', name: '墨绿', bg: '#0d1512', fg: '#e2e8e3', read: { bg: '#101a16', fg: '#b5c9b8' } },
      { id: 'sepia', name: '羊皮纸', bg: '#f4efe6', fg: '#2a231c', read: { bg: '#f4efe6', fg: '#3a3026' } },
      { id: 'light', name: '明亮', bg: '#ffffff', fg: '#1f2328', read: { bg: '#ffffff', fg: '#2f353c' } },
      { id: 'kazumi-light', name: '薄荷', bg: '#f5f7ef', fg: '#273329', read: { bg: '#f5f7ef', fg: '#303b31' } },
      { id: 'kazumi-dark', name: '薄荷暗色', bg: '#10150f', fg: '#edf3e9', read: { bg: '#10150f', fg: '#c7d3c0' } }
    ];
  }

  /** 阅读区配色跟界面主题走：返回 { bg, fg } */
  function readColors(name) {
    var t = list().filter(function (x) { return x.id === (name || current); })[0];
    return (t && t.read) || { bg: '#12141a', fg: '#c3c9d4' };
  }

  function save(name) {
    try { localStorage.setItem(KEY, name); localStorage.setItem(PICK_KEY, '1'); } catch (e) { }
    return apply(name);
  }

  function boot() {
    var saved = '', picked = false;
    try { saved = localStorage.getItem(KEY) || ''; } catch (e) { }
    try { picked = localStorage.getItem(PICK_KEY) === '1'; } catch (e) { }
    /* 手机端默认换成「薄荷」：没手动选过、且还停在旧默认「墨刻」的，一次性切过去 */
    if (isMobileShell() && !picked && (!saved || saved === 'ink')) {
      saved = 'kazumi-light';
      try { localStorage.setItem(KEY, saved); } catch (e) { }
    }
    if (!saved || !list().some(function (t) { return t.id === saved; })) saved = defId();
    apply(saved);
    return saved;
  }

  NR.theme = {
    apply: apply, save: save, boot: boot, list: list,
    palette: palette, readColors: readColors,
    current: function () { return current; }
  };
})(window);
