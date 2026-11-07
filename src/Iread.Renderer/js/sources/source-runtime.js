(function (global) {
  'use strict';

  var original = global.NR.legado;
  var bridge = global.yedu;
  var lanes = Object.create(null);
  var states = Object.create(null);
  var api = { normalize: original.normalize, contentContext: original.contentContext, pageUrlKey: original.pageUrlKey, exploreEntries: original.exploreEntries };

  function execute(operation, source, args, options) {
    if (!bridge || typeof bridge.runSourceTask !== 'function') {
      // 没有独立书源进程的外壳（安卓 WebView）：直接在页面内跑同一套规则实现
      var fn = original[operation];
      if (typeof fn !== 'function') {
        var missing = new Error('当前外壳不支持书源操作：' + operation);
        missing.code = 'UNSUPPORTED';
        return Promise.reject(missing);
      }
      return Promise.resolve(fn.apply(null, [source].concat(args || []))).then(function (value) {
        return value;
      });
    }
    options = Object.assign({ timeout: Math.max(1000, Math.min(30000, Number(source.timeout) || 15000)) }, options || {});
    var key = String(source.url || source.bookSourceUrl || source.id || source.name || '');
    // 同一书源的不同操作（目录 / 正文 / 发现 / 搜索…）可以并行，只有同操作才排队，
    // 否则「目录 + 正文」这类组合会被无谓地串成两倍时间。
    var lane = key + '\u0000' + operation;
    var pending = global.NR.tasks.run(function (task) {
      var state = states[key] || { sourceStore: {}, vars: source.__vars || {} };
      return bridge.runSourceTask({ operation: operation, source: source, args: args, state: state, timeout: task.timeout, taskId: task.taskId });
    }, options, lanes[lane]);
    lanes[lane] = pending.completion;
    pending.completion.then(function () { if (lanes[lane] === pending.completion) delete lanes[lane]; });
    return pending.then(function (reply) {
      if (reply.state) {
        // 并行的不同操作各自会带回整份状态：合并而不是覆盖，避免互相抹掉对方的 @put 变量。
        var prev = states[key] || {};
        var merged = Object.assign({}, prev, reply.state);
        if (prev.vars || reply.state.vars) merged.vars = Object.assign({}, prev.vars, reply.state.vars);
        if (prev.sourceStore || reply.state.sourceStore) merged.sourceStore = Object.assign({}, prev.sourceStore, reply.state.sourceStore);
        if (prev.memory || reply.state.memory) merged.memory = Object.assign({}, prev.memory, reply.state.memory);
        states[key] = merged;
        if (merged.vars) source.__vars = merged.vars;
      }
      var value = reply.value;
      if (reply.diag && value && typeof value === 'object') {
        Object.defineProperty(value, '__diag', { value: reply.diag, enumerable: false, configurable: true });
      }
      return value;
    }).catch(function (error) {
      if (error && (error.code === 'RULE_TIMEOUT' || /RULE_TIMEOUT|host timeout/.test(error.message || ''))) {
        error.code = 'TIMEOUT';
        error.timeout = true;
      }
      if (error && error.code === 'RULE_CANCELLED') { error.code = 'CANCELLED'; error.cancelled = true; }
      throw error;
    });
  }

  ['search', 'explore', 'detail', 'catalog', 'content', 'test', 'fetchPage'].forEach(function (operation) {
    api[operation] = function (source) {
      return execute(operation, source, Array.prototype.slice.call(arguments, 1));
    };
  });
  api.run = execute;
  api.resetState = function () { states = Object.create(null); };
  global.NR.legado = api;
})(window);
