(function (global) {
  'use strict';

  var NR = global.NR = global.NR || {};
  var KEY = 'nr_reading_stats';
  var HEARTBEAT_MS = 1000;
  var CHECKPOINT_MS = 30000;
  var MAX_INTERVAL_MS = 15000;
  var MAX_IDS = 4096;
  var MAX_TOTAL = Number.MAX_SAFE_INTEGER;

  var store = null;
  var onChange = null;
  var initPromise = null;
  var ready = false;
  var totalMs = 0;
  var readIds = [];
  var active = false;
  var lastTick = null;
  var lastCheckpoint = 0;
  var dirty = false;
  var revision = 0;
  var flushPromise = null;
  var checkpointRequested = false;
  var timerId = null;
  var listenersRegistered = false;

  function now() {
    return global.performance.now();
  }

  function validId(id) {
    return typeof id === 'string' && id.length >= 1 && id.length <= 128;
  }

  function validate(record) {
    if (record === null || record === undefined) return { totalMs: 0, readIds: [] };
    if (!record || typeof record !== 'object' || record.version !== 1 ||
        !Number.isSafeInteger(record.totalMs) || record.totalMs < 0 ||
        !Array.isArray(record.readIds) || record.readIds.length > MAX_IDS) {
      throw new Error('Invalid reading stats record');
    }
    var ids = [];
    record.readIds.forEach(function (id) {
      if (!validId(id)) throw new Error('Invalid reading stats book id');
      if (ids.indexOf(id) < 0) ids.push(id);
    });
    return { totalMs: record.totalMs, readIds: ids };
  }

  function notify() {
    if (!onChange) return;
    try { onChange(); } catch (_) { /* A view callback cannot stop the clock. */ }
  }

  function canCount() {
    return active && global.document.visibilityState === 'visible' && global.document.hasFocus();
  }

  function markDirty() {
    dirty = true;
    revision++;
  }

  function settle() {
    if (lastTick === null) return;
    var current = now();
    var previous = lastTick;
    lastTick = null;
    if (!canCount()) return;
    lastTick = current;
    var elapsed = current - previous;
    if (elapsed <= 0 || elapsed > MAX_INTERVAL_MS) return;
    var wholeMs = Math.floor(elapsed);
    if (!wholeMs || totalMs === MAX_TOTAL) return;
    totalMs = Math.min(MAX_TOTAL, totalMs + wholeMs);
    markDirty();
  }

  function resume() {
    if (canCount() && lastTick === null) lastTick = now();
    notify();
  }

  function checkpoint() {
    lastCheckpoint = now();
    if (flushPromise) {
      checkpointRequested = true;
      return;
    }
    flush();
  }

  function stop() {
    settle();
    lastTick = null;
    notify();
    checkpoint();
  }

  function heartbeat() {
    settle();
    notify();
    if (now() - lastCheckpoint >= CHECKPOINT_MS) checkpoint();
    timerId = global.setTimeout(heartbeat, HEARTBEAT_MS);
  }

  function registerListeners() {
    if (listenersRegistered) return;
    listenersRegistered = true;
    global.addEventListener('focus', resume);
    global.addEventListener('blur', stop);
    global.addEventListener('pagehide', stop);
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'visible') resume();
      else stop();
    });
  }

  function init(options) {
    if (initPromise) return initPromise;
    store = options && options.store;
    onChange = options && options.onChange;
    initPromise = Promise.resolve().then(function () {
      if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
        throw new Error('Invalid reading stats store');
      }
      return store.get(KEY);
    }).then(function (record) {
      var restored = validate(record);
      totalMs = restored.totalMs;
      readIds = restored.readIds;
      active = false;
      lastTick = null;
      dirty = false;
      revision = 0;
      ready = true;
      lastCheckpoint = now();
      registerListeners();
      if (timerId === null) timerId = global.setTimeout(heartbeat, HEARTBEAT_MS);
      notify();
    });
    return initPromise;
  }

  function enter(bookId) {
    settle();
    active = true;
    var added = false;
    if (validId(bookId) && readIds.indexOf(bookId) < 0 && readIds.length < MAX_IDS) {
      readIds.push(bookId);
      markDirty();
      added = true;
    }
    lastTick = canCount() ? now() : null;
    notify();
    if (added) checkpoint();
  }

  function pause() {
    settle();
    active = false;
    lastTick = null;
    notify();
    checkpoint();
  }

  function mergeIdentity(oldId, newId) {
    if (!validId(oldId) || !validId(newId) || oldId === newId) return;
    var oldIndex = readIds.indexOf(oldId);
    if (oldIndex < 0) return;
    var newIndex = readIds.indexOf(newId);
    if (newIndex >= 0) readIds.splice(oldIndex, 1);
    else readIds[oldIndex] = newId;
    markDirty();
    notify();
  }

  function get() {
    settle();
    return { totalMs: totalMs, readCount: readIds.length };
  }

  function flush() {
    if (flushPromise) return flushPromise;
    if (!ready) return Promise.resolve(false);
    settle();
    if (!dirty) return Promise.resolve(true);

    var capturedRevision = revision;
    var record = { version: 1, totalMs: totalMs, readIds: readIds.slice() };
    var write;
    try { write = store.set(KEY, record); }
    catch (error) { write = Promise.reject(error); }
    flushPromise = Promise.resolve(write).then(function () {
      if (revision === capturedRevision) dirty = false;
      return true;
    }, function () {
      return false;
    }).then(function (result) {
      flushPromise = null;
      if (checkpointRequested) {
        checkpointRequested = false;
        if (dirty) checkpoint();
      }
      return result;
    });
    return flushPromise;
  }

  NR.readingStats = {
    init: init,
    enter: enter,
    pause: pause,
    mergeIdentity: mergeIdentity,
    get: get,
    flush: flush
  };
})(window);
