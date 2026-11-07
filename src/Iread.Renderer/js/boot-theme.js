/* 首帧主题：在 <head> 里同步执行，早于任何一次绘制。
   目的：避免启动瞬间先闪一下默认色板（墨刻）再切到用户主题。
   数据来源：theme.js 的 apply() 会把整张色板变量表存进 localStorage 的 ui_theme_vars，
   这里原样贴回 <html> 的行内样式，颜色与正式 boot 完全一致。
   注意：键名不能带 nr_ 前缀，否则会被 store.js 当成业务数据比对出「存储冲突」。 */
(function () {
  var root = document.documentElement;
  var isMobile = false;
  try { isMobile = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches; } catch (e) { }
  var DEF = isMobile ? 'kazumi-light' : 'ink';
  var name = DEF;
  var vars = null;
  try {
    var saved = localStorage.getItem('nr_ui_theme') || '';
    var picked = localStorage.getItem('ui_theme_picked') === '1';
    if (isMobile && !picked && (!saved || saved === 'ink')) saved = 'kazumi-light';
    name = saved || DEF;
    if (isMobile && (!localStorage.getItem('nr_ui_theme'))) localStorage.setItem('nr_ui_theme', name);
    vars = JSON.parse(localStorage.getItem('ui_theme_vars') || 'null');
  } catch (e) { vars = null; }
  root.setAttribute('data-ui-theme', name);
  /* 首次装上新版时还没有快照，至少把底色和明暗方案摆对，避免白底闪一下 */
  if (!vars) {
    var BG = {
      ink: '#0a0b0d', night: '#000000', solar: '#002b36', nord: '#2e3440', forest: '#0d1512',
      sepia: '#f4efe6', light: '#ffffff', 'kazumi-light': '#f5f7ef', 'kazumi-dark': '#10150f'
    };
    var light = (name === 'sepia' || name === 'light' || name === 'kazumi-light');
    try {
      root.style.setProperty('--ink-0', BG[name] || BG.ink);
      root.style.colorScheme = light ? 'light' : 'dark';
    } catch (e) { }
  }
  /* 画布底色也一起定死，避免首帧白底 */
  try {
    var base = (vars && vars['--ink-0']) || (BG && BG[name]) || '#0a0b0d';
    root.style.backgroundColor = base;
  } catch (e) { }
  if (vars && typeof vars === 'object') {
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        try { root.style.setProperty(k, vars[k]); } catch (e) { }
      }
    }
  }
})();
