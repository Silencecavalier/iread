(function (global) {
  'use strict';

  var S = global.NR.store;
  var P = global.NR.platform;
  var busy = false, wired = false, startupBlocked = false, reportedError = '';
  var locked = [], hiddenEmpty = null;
  var controls = ['btnBackup', 'btnRestore', 'btnStorageBackup', 'btnStorageRestore',
    'btnStorageRetry', 'btnResolveIdb', 'btnResolveLocal', 'backupFile'];
  function element(id) { return document.getElementById(id); }
  function message(error) {
    var text = String(error && error.message || error || '未知错误');
    if (error && error.cause && error.cause !== error) text += '：' + message(error.cause);
    return text;
  }
  function notify(text) {
    if (global.NR.notify) global.NR.notify(text);
    else console.log(text);
  }
  // 抽屉是 app 的兄弟节点；只锁 app 会漏掉设置和书源写入入口。
  // 不锁 body/modal/frModal，否则恢复确认或静态声明会无法关闭。
  function lockSurfaces(on) {
    if (on) {
      var nodes = [element('app'), element('fileInput')];
      if (document.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(document.querySelectorAll('.drawer, #sourceHost')));
      nodes.forEach(function (node) {
        if (!node || locked.some(function (entry) { return entry.node === node; })) return;
        locked.push({ node: node, inert: node.inert });
        node.inert = true;
      });
    } else {
      locked.forEach(function (entry) { entry.node.inert = entry.inert; });
      locked = [];
    }
  }
  function isPaused() {
    var state = S.status();
    return busy || startupBlocked || !state.writable || !!(state.conflicts && state.conflicts.length);
  }
  function updateStatus(issue) {
    // DOM storage events may carry Event.detail; always read the store's current state.
    if (issue && typeof issue.blocked === 'boolean') startupBlocked = issue.blocked;
    if (issue && typeof issue.error !== 'undefined') reportedError = issue.error ? message(issue.error) : '';
    else if (typeof issue === 'string' || issue && issue.message) reportedError = message(issue);
    var state = S.status();
    var box = element('storageNotice'), text = element('storageStatus');
    var conflicts = state.conflicts || [];
    var paused = isPaused();
    lockSurfaces(paused);
    var status = conflicts.length
      ? '检测到 ' + conflicts.length + ' 项旧存储冲突，已暂停写入。请先导出完整备份，再选择要保留的数据版本。'
      : state.error
        ? '存储不可用，已暂停写入，不会创建空库覆盖原数据。' + message(state.error) + '（点「重试」会自动修复能修的部分）'
        : busy
          ? '正在处理备份或恢复，已暂停导入和写入，请稍候。'
          : startupBlocked || !state.writable
            ? '正在等待存储就绪，已暂停导入和写入；不会以临时空书架启动。'
            : state.degraded
              ? '数据库暂时打不开，已自动降级到本地存储（' + state.mode + '），现在可以正常读写。点「重试」可再尝试回到数据库。'
              : '存储已就绪（' + state.mode + '）' + (state.repaired ? '，本次启动已自动修复存储异常' : '') + '。';
    if (reportedError) status += '\n数据操作失败：' + reportedError;
    if (box) box.hidden = !paused && !reportedError;
    if (text) text.textContent = status;
    if (paused) {
      var empty = element('emptyState');
      if (empty) {
        if (!hiddenEmpty) hiddenEmpty = { node: empty, hidden: empty.hidden };
        empty.hidden = true;
      }
    } else if (hiddenEmpty) {
      hiddenEmpty.node.hidden = hiddenEmpty.hidden;
      hiddenEmpty = null;
    }
    ['btnResolveIdb', 'btnResolveLocal'].forEach(function (id) {
      var button = element(id);
      if (button) button.hidden = !conflicts.length;
    });
    controls.forEach(function (id) {
      var control = element(id);
      if (control) control.disabled = busy;
    });
  }
  async function run(action) {
    if (busy) throw new Error('数据操作正在进行，请稍候');
    busy = true;
    reportedError = '';
    updateStatus();
    try { return await action(); }
    catch (error) { updateStatus(error); throw error; }
    finally { busy = false; updateStatus(); }
  }
  async function recoveryBackup() {
    var snapshot = await S.exportSnapshot();
    if (!P.saveRecoveryBackup) throw new Error('当前外壳无法保存恢复前备份，请使用 WebView2 版本');
    var result = await P.saveRecoveryBackup(JSON.stringify(snapshot));
    if (!result || !result.ok || !result.path) throw new Error('恢复前备份未保存，已取消数据替换' + (result && result.error ? '：' + message(result.error) : ''));
    return result.path;
  }
  async function exportBackup() {
    return run(async function () {
      var snapshot = await S.exportSnapshot();
      var name = 'iread-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      var result = await P.saveText(name, JSON.stringify(snapshot));
      if (result && result.canceled) return false;
      if (!result || result.ok === false || result.error) throw new Error('完整备份导出失败' + (result && result.error ? '：' + message(result.error) : '：外壳未确认保存'));
      notify('完整备份已导出，包含书架、进度、书源和章节缓存；请妥善保管');
      return true;
    });
  }
  async function restoreFile(file) {
    if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > 128 * 1024 * 1024)
      throw new Error('备份文件为空或超过 128 MiB');
    var raw;
    try { raw = await file.text(); }
    catch (error) { throw new Error('读取备份文件失败：' + message(error)); }
    var snapshot;
    try { snapshot = JSON.parse(raw); }
    catch (error) { throw new Error('不是合法的备份 JSON 文件：' + message(error)); }
    if (!snapshot || snapshot.format !== 'iread-backup' || snapshot.version !== 1 || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.local))
      throw new Error('不支持的备份格式或版本');
    if (!global.confirm('恢复将替换当前书架、进度、书源、设置和缓存。会先在数据目录保存当前完整备份。确定恢复？')) return false;
    return run(async function () {
      var saved = await recoveryBackup();
      await S.restoreSnapshot(snapshot);
      notify('恢复完成，恢复前备份保存在：' + saved);
      global.location.reload();
      return true;
    });
  }
  async function resolve(choice) {
    if (choice !== 'idb' && choice !== 'local') throw new Error('请选择旧存储数据版本');
    return run(async function () {
      await recoveryBackup();
      await S.resolveConflicts(choice);
      global.location.reload();
    });
  }
  function showError(error) { notify(message(error)); updateStatus(error); }
  function wire() {
    if (wired) return;
    wired = true;
    function bind(id, handler) {
      var button = element(id);
      if (button) button.onclick = function () { Promise.resolve().then(handler).catch(showError); };
    }
    function pickBackup() { var input = element('backupFile'); if (input && !busy) input.click(); }
    bind('btnBackup', exportBackup);
    bind('btnRestore', pickBackup);
    bind('btnStorageBackup', exportBackup);
    bind('btnStorageRestore', pickBackup);
    bind('btnStorageRetry', function () {
      return run(async function () {
        await (S.repair ? S.repair() : S.retry());
        if (S.status().writable) global.location.reload();
      });
    });
    bind('btnResolveIdb', function () { return resolve('idb'); });
    bind('btnResolveLocal', function () { return resolve('local'); });
    var input = element('backupFile');
    if (input) input.onchange = function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (file) restoreFile(file).catch(showError);
    };
  }
  global.NR.dataTools = { exportBackup: exportBackup, restoreFile: restoreFile, resolve: resolve,
    updateStatus: updateStatus, wire: wire, isPaused: isPaused };
  global.addEventListener('unhandledrejection', function (event) { updateStatus(event && event.reason); });
  global.addEventListener('nr-storage-state', function () { updateStatus(); });
})(window);
