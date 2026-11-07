(function (global) {
  'use strict';

  var DB_NAME = 'yedu-reader', STORE = 'kv';
  var BACKEND = '__nr_backend', BACKUPS = '__nr_migration_backups';
  var CONFLICTS = '__nr_conflicts', JOURNAL = '__nr_restore_journal';
  var LS_JOURNAL = '__nr_ls_restore_journal';
  var MAX_BYTES = 128 * 1024 * 1024, MAX_ENTRIES = 100000;
  var mode = 'idb', db = null, opening = null, initializing = null;
  var ready = false, failed = false, pending = false, busy = false, blockReads = false;
  var error = null, conflicts = [], conflictRecord = null, queue = Promise.resolve();
  var foreign = [], degraded = false, repaired = false;

  function special(key) { return key === 'nr_ui_theme' || key === 'nr_screen_log_name'; }
  // 这两个键历史上被模块直接写进了 localStorage，又落在 nr_ 前缀里，
  // 每次启动都会被当成「数据库与本地快照不一致」报存储冲突。它们已经迁到各自的键，
  // 这里把旧键排除在迁移之外，已有的冲突记录也会被自动清掉。
  // nr_hotrank* 是热榜模块直接写进 localStorage 的缓存（老版本叫 nr_hotrank_*，新版本 nr_hotrank2_*）。
  // 里面的日期/URL 不是 JSON，被当成业务数据解码必然抛错——历史教训：一条这样的键
  // 就让 initialize() 整个失败、存储进入 failed 状态，双端都变成「存储不能用」。
  function stray(key) {
    return key === 'nr_bs_rail' || key === 'nr_vresume' || /^nr_hotrank/.test(key);
  }
  function application(key) {
    return typeof key === 'string' && !/^(?:__nr_t|nr_(?:test|probe)(?:_|:|$))/.test(key) &&
      (key.indexOf('nr_') === 0 || key === 'guideOk' || key.indexOf('aprog:') === 0 || key.indexOf('vprog:') === 0);
  }
  function business(key) { return application(key) && !special(key); }
  function internal(key) { return key === BACKUPS || key === CONFLICTS; }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function announce() { global.dispatchEvent(new CustomEvent('nr-storage-state')); }
  function problem(message, cause, pause) {
    error = message;
    if (pause) failed = true;
    announce();
    var e = new Error(message);
    if (cause) e.cause = cause;
    return e;
  }
  function writable() { return ready && !failed && !pending && !busy && conflicts.length === 0; }
  function readGuard() {
    if (!ready || failed || pending || blockReads) throw problem('存储暂不可读取，请重试恢复', null, false);
  }
  function writeGuard() {
    if (!writable()) throw problem(conflicts.length ? '存在存储冲突，请先选择保留的数据' : '存储暂不可写入，请重试', null, false);
  }
  function operationalGuard() {
    if (!ready || failed || pending) throw problem('存储尚未就绪，请先重试', null, false);
  }

  function jsonValue(value, depth, seen, budget, inArray) {
    if (depth > 100) throw new Error('数据嵌套过深');
    if (++budget.nodes > 1000000) throw new Error('数据条目过多');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('数值不合法'); return; }
    if (typeof value === 'string') {
      budget.bytes += value.length;
      if (budget.bytes > MAX_BYTES) throw new Error('备份超过大小限制');
      return;
    }
    // 按 JSON.stringify 的语义放过三种「不可序列化」的值：对象的属性值直接省略，
    // 数组里的元素写成 null。否则调用方传进来的 undefined（例如书源合并时把旧记录
    // 缺失的字段原样搬过去）会让整次保存失败，表现为「存储不可用 / 删不掉书源」。
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      if (inArray) { budget.bytes += 4; return; }
      if (depth === 0) throw new Error('数据必须是完整的 JSON 值');
      return;
    }
    if (!value || typeof value !== 'object') throw new Error('数据必须是完整的 JSON 值');
    if (seen.has(value)) throw new Error('数据存在循环引用');
    var array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (!array && proto !== null && (Object.getPrototypeOf(proto) !== null ||
        !Object.prototype.hasOwnProperty.call(proto, 'constructor') || proto.constructor.name !== 'Object')) {
      throw new Error('对象类型不合法');
    }
    var names = Reflect.ownKeys(value);
    if (array && names.length !== value.length + 1) throw new Error('数组条目不完整');
    seen.add(value);
    names.forEach(function (key) {
      if (array && key === 'length') return;
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('数据包含危险属性');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error('数组类型不合法');
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('数据包含非 JSON 属性');
      budget.bytes += key.length;
      jsonValue(descriptor.value, depth + 1, seen, budget, array);
    });
    seen.delete(value);
  }
  function checkedJSON(value) {
    jsonValue(value, 0, new Set(), { bytes: 0, nodes: 0 });
    var serialized = JSON.stringify(value);
    if (serialized.length > MAX_BYTES || new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error('备份超过大小限制');
    return JSON.parse(serialized);
  }
  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    var ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every(function (k, i) { return k === bk[i] && same(a[k], b[k]); });
  }
  function fields(value, expected) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || !same(Object.keys(value).sort(), expected.slice().sort())) throw new Error('备份字段不合法');
  }
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('备份时间不合法');
  }
  function pairs(value, local, allowInternal) {
    if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error('备份条目不合法');
    var keys = new Set();
    value.forEach(function (pair) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('备份条目必须是二元数组');
      var key = pair[0];
      if (typeof key !== 'string' || key.length > 1024 || !(local ? application(key) : business(key) || (allowInternal && internal(key)))) throw new Error('备份包含非应用键');
      if (keys.has(key)) throw new Error('备份包含重复键');
      keys.add(key);
      if (local) {
        if (typeof pair[1] !== 'string') throw new Error('本地原值必须是字符串');
        if (!special(key)) checkedJSON(decode(pair[1]));
      }
    });
  }
  function checkBackups(value) {
    if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error('迁移备份记录不合法');
    value.forEach(function (record) {
      fields(record, ['kind', 'createdAt', 'entries', 'local']);
      if (['migration', 'resolve', 'restore'].indexOf(record.kind) === -1) throw new Error('备份记录类型不合法');
      timestamp(record.createdAt); pairs(record.entries, false, false); pairs(record.local, true, false);
    });
  }
  function checkConflict(value, entries) {
    fields(value, ['snapshot', 'conflicts', 'local']);
    if (typeof value.snapshot !== 'boolean' || !Array.isArray(value.conflicts) || !value.conflicts.length) throw new Error('冲突记录不合法');
    pairs(value.local, true, false);
    var raw = new Map(value.local), keys = new Set();
    value.conflicts.forEach(function (c) {
      fields(c, ['key', 'idb', 'local']);
      if (!business(c.key) || keys.has(c.key) || !entries.has(c.key) || !raw.has(c.key) ||
          !same(entries.get(c.key), c.idb) || !same(decode(raw.get(c.key)), c.local) || same(c.idb, c.local)) throw new Error('冲突原值不一致');
      keys.add(c.key);
    });
    if (value.snapshot !== keys.has('nr_index')) throw new Error('书架冲突类型不合法');
  }
  function checkMetadata(entries) {
    if (entries.has(BACKUPS)) checkBackups(entries.get(BACKUPS));
    if (entries.has(CONFLICTS)) checkConflict(entries.get(CONFLICTS), entries);
  }
  function validateSnapshot(snapshot) {
    var value = checkedJSON(snapshot);
    fields(value, ['format', 'version', 'createdAt', 'entries', 'local']);
    if (value.format !== 'iread-backup' || value.version !== 1) throw new Error('备份格式或版本不支持');
    timestamp(value.createdAt); pairs(value.entries, false, true); pairs(value.local, true, false);
    checkMetadata(new Map(value.entries));
    return value;
  }

  function lzwDecompress(s) {
    if (typeof s !== 'string' || !s.length) throw new Error('压缩数据不合法');
    var dict = new Array(65536), next = 256, out = [], length = 0;
    for (var i = 0; i < 256; i++) dict[i] = String.fromCharCode(i);
    var first = s.charCodeAt(0);
    if (first >= 256) throw new Error('压缩首字符不合法');
    var w = dict[first]; out.push(w); length += w.length;
    for (i = 1; i < s.length; i++) {
      var code = s.charCodeAt(i), entry;
      if (code < next && dict[code] !== undefined) entry = dict[code];
      else if (code === next) entry = w + w.charAt(0);
      else throw new Error('压缩编码不合法');
      length += entry.length;
      if (length > MAX_BYTES) throw new Error('解压数据超过大小限制');
      out.push(entry);
      if (next < 65535) dict[next++] = w + entry.charAt(0);
      w = entry;
    }
    return out.join('');
  }
  function decode(raw) {
    var value = JSON.parse(raw);
    if (value && value.__c === 1) value = JSON.parse(lzwDecompress(value.d));
    return value;
  }
  /* 容错解码：localStorage 里凡是 nr_ 前缀的键都可能被别的模块直接写过（历史遗留）。
   * 一条解不开的键只代表「这条不是我们的数据」，绝不能连锁到整次初始化失败。 */
  function tryDecode(raw) {
    try { return { value: checkedJSON(decode(raw)) }; }
    catch (e) { return { error: e }; }
  }
  function noteForeign(key) {
    if (foreign.indexOf(key) === -1 && foreign.length < 50) foreign.push(key);
  }
  /* 损坏的元数据（备份/冲突记录）会永久卡死初始化。把它另存成不带 nr_ 前缀的原文本留档，
   * 再从本地摘掉，让下一次启动能正常走；数据库里的副本由 repairMetadata 删。 */
  function quarantine(key, raw) {
    try { global.localStorage.setItem('__nr_quarantine_' + key, typeof raw === 'string' ? raw : String(raw)); } catch (e) { }
    try { global.localStorage.removeItem(key); } catch (e) { }
    noteForeign(key);
    repaired = true;
  }
  function localPairs() {
    var out = [], storage = global.localStorage;
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (application(key)) out.push([key, storage.getItem(key)]);
    }
    return out.sort(function (a, b) { return a[0].localeCompare(b[0]); });
  }
  function businessEntries(entries) { return entries.filter(function (pair) { return business(pair[0]); }); }
  function retainedLocal(local) { return local.filter(function (pair) { return special(pair[0]) || stray(pair[0]); }); }
  function bookCacheKey(key, ids) {
    if (typeof key !== 'string') return false;
    if (key.indexOf('nr_book_') === 0) return ids === null || ids.has(key.slice(8));
    var boundary;
    if (key.indexOf('nr_ch_') === 0) {
      boundary = key.indexOf('_', 6);
      return ids === null || boundary !== -1 && ids.has(key.slice(6, boundary));
    }
    if (key.indexOf('aprog:') === 0 || key.indexOf('vprog:') === 0) {
      boundary = key.indexOf(':', 6);
      return ids === null || boundary !== -1 && ids.has(key.slice(6, boundary));
    }
    return false;
  }
  function shelfAfterDeletion(value, ids) {
    if (ids === null) return [];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('书架索引不合法，未删除书籍');
    return value.filter(function (book) { return !book || !ids.has(book.id); });
  }
  function record(kind, entries, local) {
    var preserved = new Map(local), unresolved = new Map(entries).get(CONFLICTS);
    if (unresolved) unresolved.local.forEach(function (pair) {
      if (business(pair[0]) || !preserved.has(pair[0])) preserved.set(pair[0], pair[1]);
    });
    return { kind: kind, createdAt: new Date().toISOString(), entries: copy(businessEntries(entries)), local: copy(Array.from(preserved)) };
  }
  function backupList(entries) { return entries.has(BACKUPS) ? copy(entries.get(BACKUPS)) : []; }
  function state(entries) {
    checkMetadata(entries);
    conflictRecord = entries.has(CONFLICTS) ? copy(entries.get(CONFLICTS)) : null;
    conflicts = conflictRecord ? copy(conflictRecord.conflicts) : [];
  }

  function openDB() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      var request, done = false;
      var timer = setTimeout(function () { finish(new Error('数据库打开超时')); }, 3000);
      function finish(e, connection) {
        if (done) { if (connection) connection.close(); return; }
        done = true; clearTimeout(timer);
        if (e) reject(e); else resolve(connection);
      }
      try { request = global.indexedDB.open(DB_NAME, 1); }
      catch (e) { finish(e); return; }
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = function () { finish(request.error || new Error('数据库无法打开')); };
      request.onblocked = function () { finish(new Error('数据库被其他页面占用')); };
      request.onsuccess = function () {
        var connection = request.result;
        if (done) { connection.close(); return; }
        if (!connection.objectStoreNames.contains(STORE)) { connection.close(); finish(new Error('数据库结构不合法')); return; }
        db = connection;
        connection.onversionchange = function () {
          connection.close(); db = null; opening = null;
          problem('数据库连接已变更，请重试', null, true);
        };
        connection.onclose = function () {
          if (db === connection) { db = null; opening = null; problem('数据库连接已中断，请重试', null, true); }
        };
        finish(null, connection);
      };
    });
    return opening;
  }
  function transaction(access, work) {
    return new Promise(function (resolve, reject) {
      var tx, result, done = false, failure, timer;
      function finish(e) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (e) reject(e); else resolve(result);
      }
      try {
        if (!db) throw new Error('数据库未连接');
        tx = db.transaction(STORE, access);
        tx.oncomplete = function () { finish(); };
        tx.onerror = function () { failure = tx.error; };
        tx.onabort = function () { finish(failure || tx.error || new Error('数据库事务已取消')); };
        timer = setTimeout(function () {
          failure = new Error('数据库事务超时');
          try { tx.abort(); } catch (e) { finish(failure); }
          finish(failure);
        }, access === 'readonly' ? 6000 : 20000);
        work(tx.objectStore(STORE), function (value) { result = value; }, function (e) {
          failure = e;
          try { tx.abort(); } catch (_) { finish(e); }
        });
      } catch (e) {
        failure = e;
        if (tx) { try { tx.abort(); } catch (_) { finish(e); } }
        else finish(e);
      }
    });
  }
  function readAll() {
    if (mode === 'ls') {
      var entries = [];
      localPairs().forEach(function (p) {
        if (!business(p[0])) return;
        var got = tryDecode(p[1]);
        if (got.error) { noteForeign(p[0]); return; }
        entries.push([p[0], got.value]);
      });
      [BACKUPS, CONFLICTS].forEach(function (key) {
        var raw = global.localStorage.getItem(key);
        if (raw === null) return;
        try { entries.push([key, checkedJSON(JSON.parse(raw))]); }
        catch (e) { quarantine(key, raw); }
      });
      return Promise.resolve(entries);
    }
    return transaction('readonly', function (store, result) {
      var entries = [], request = store.openCursor();
      request.onsuccess = function () {
        var cursor = request.result;
        if (cursor) { entries.push([cursor.key, cursor.value]); cursor.continue(); }
        else result(entries);
      };
    });
  }
  function replaceLocal(pairsToApply) {
    var storage = global.localStorage, keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (application(key) || internal(key)) keys.push(key);
    }
    keys.forEach(function (key) { storage.removeItem(key); });
    pairsToApply.forEach(function (pair) { storage.setItem(pair[0], pair[1]); });
  }
  // IDB 数据和 LS 重放意图同事务落盘；重放可重复，完成前不开放读写。
  async function replay(journal, localMode) {
    pending = true;
    if (!journal || !Array.isArray(journal.local)) throw new Error('恢复日志不合法');
    if (localMode) {
      var checked = checkedJSON(journal);
      checked.local.forEach(function (pair) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== 'string' || !(application(pair[0]) || internal(pair[0]))) throw new Error('恢复日志条目不合法');
      });
    } else pairs(journal.local, true, false);
    replaceLocal(journal.local);
    if (localMode) global.localStorage.removeItem(LS_JOURNAL);
    else await transaction('readwrite', function (store) { store.delete(JOURNAL); });
    pending = false;
  }
  async function commit(entries, local) {
    if (mode === 'idb') {
      await transaction('readwrite', function (store) {
        store.clear();
        entries.forEach(function (value, key) { store.put(value, key); });
        store.put({ local: local }, JOURNAL);
      });
      await replay({ local: local }, false);
    } else {
      var raw = new Map();
      entries.forEach(function (value, key) { if (business(key) || internal(key)) raw.set(key, JSON.stringify(value)); });
      local.forEach(function (pair) { if (special(pair[0]) || !raw.has(pair[0])) raw.set(pair[0], pair[1]); });
      var journal = { local: Array.from(raw) };
      global.localStorage.setItem(LS_JOURNAL, JSON.stringify(journal));
      await replay(journal, true);
    }
  }
  // 老版本留下的冲突记录里如果只有 stray 键，直接摘掉，别让用户去点「保留哪一份」
  async function pruneStrayConflicts() {
    if (!conflictRecord) return;
    var all = conflictRecord.conflicts || [];
    var left = all.filter(function (c) { return !stray(c.key); });
    if (left.length === all.length) return;
    if (left.length) {
      conflictRecord = { snapshot: !!conflictRecord.snapshot, conflicts: copy(left), local: copy(conflictRecord.local || []) };
      conflicts = copy(left);
    } else { conflictRecord = null; conflicts = []; }
    if (mode === 'ls') {
      if (conflictRecord) global.localStorage.setItem(CONFLICTS, JSON.stringify(conflictRecord));
      else global.localStorage.removeItem(CONFLICTS);
    } else {
      await transaction('readwrite', function (store) {
        if (conflictRecord) store.put(conflictRecord, CONFLICTS);
        else store.delete(CONFLICTS);
      });
    }
  }
  async function migrate(entries) {
    var data = new Map(entries);
    state(data);
    await pruneStrayConflicts();
    if (conflictRecord) return;
    var local = localPairs(), legacy = local.filter(function (pair) { return business(pair[0]) && !stray(pair[0]); });
    var metadata = new Map();
    [BACKUPS, CONFLICTS].forEach(function (key) {
      var raw = global.localStorage.getItem(key);
      if (raw === null) return;
      try { metadata.set(key, checkedJSON(JSON.parse(raw))); }
      catch (e) { quarantine(key, raw); }
    });
    if (!legacy.length && !metadata.size) return;
    var decoded = [];
    legacy.forEach(function (pair) {
      var got = tryDecode(pair[1]);
      if (got.error) { noteForeign(pair[0]); return; }
      decoded.push([pair[0], got.value]);
    });
    if (!decoded.length && !metadata.size) return;
    var localData = new Map(decoded);
    metadata.forEach(function (value, key) { localData.set(key, value); });
    checkMetadata(localData);
    var found = [];
    decoded.forEach(function (pair) {
      if (data.has(pair[0]) && !same(data.get(pair[0]), pair[1])) found.push({ key: pair[0], idb: copy(data.get(pair[0])), local: copy(pair[1]) });
    });
    if (metadata.has(CONFLICTS) && found.length) throw new Error('请先解决本地快照的未决冲突');
    var snapshotConflict = found.some(function (c) { return c.key === 'nr_index'; });
    var backups = backupList(data);
    backupList(metadata).forEach(function (item) { if (!backups.some(function (saved) { return same(item, saved); })) backups.push(item); });
    backups.push(record('migration', entries, local));
    var nextConflict = found.length ? { snapshot: snapshotConflict, conflicts: found, local: copy(local) } : metadata.get(CONFLICTS) || null;
    await transaction('readwrite', function (store) {
      store.put(backups, BACKUPS);
      if (!snapshotConflict) decoded.forEach(function (pair) { if (!data.has(pair[0])) store.put(pair[1], pair[0]); });
      if (nextConflict) store.put(nextConflict, CONFLICTS);
      else store.put({ local: retainedLocal(local) }, JOURNAL);
    });
    if (nextConflict) { conflictRecord = nextConflict; conflicts = copy(nextConflict.conflicts); }
    else await replay({ local: retainedLocal(local) }, false);
  }
  /* 损坏的备份/冲突记录是死循环源头：每次启动都在 checkMetadata 抛错。
   * 修复 = 把两份元数据搬走（本地留档 + 数据库删除），业务数据一字不动。 */
  async function repairMetadata() {
    [BACKUPS, CONFLICTS].forEach(function (key) {
      var raw = null;
      try { raw = global.localStorage.getItem(key); } catch (e) { }
      if (raw !== null) quarantine(key, raw);
    });
    try { global.localStorage.removeItem(LS_JOURNAL); } catch (e) { }
    // 顺带清掉旧版本热榜留下的 nr_hotrank* 缓存键（它们已经改到 hr2_ 命名空间）
    try {
      var storage = global.localStorage, doomed = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (/^nr_hotrank/.test(key)) doomed.push(key);
      }
      doomed.forEach(function (key) { storage.removeItem(key); });
    } catch (e) { }
    if (!db) return;
    try {
      await transaction('readwrite', function (store) {
        store.delete(BACKUPS); store.delete(CONFLICTS); store.delete(JOURNAL);
      });
      repaired = true;
    } catch (e) { /* 数据库写不动就算了，下面还会再试一次打开 */ }
  }
  async function openBackend() {
    var storage = global.localStorage, binding = storage.getItem(BACKEND);
    var lsJournal = storage.getItem(LS_JOURNAL);
    if (lsJournal !== null) {
      var parsed = null;
      try { parsed = JSON.parse(lsJournal); } catch (e) { quarantine(LS_JOURNAL, lsJournal); }
      if (parsed) await replay(parsed, true);
    }
    if (binding !== null && binding !== 'idb' && binding !== 'ls') throw new Error('存储绑定标记不合法');
    try {
      if (!global.indexedDB) throw new Error('浏览器未提供数据库');
      await openDB();
    } catch (e) {
      if (binding === 'idb' || global.indexedDB && binding !== 'ls') throw e;
      mode = 'ls';
      storage.setItem(BACKEND, 'ls');
      var lsData = new Map();
      [BACKUPS, CONFLICTS].forEach(function (key) {
        var raw = storage.getItem(key);
        if (raw === null) return;
        try { lsData.set(key, checkedJSON(JSON.parse(raw))); }
        catch (err) { quarantine(key, raw); }
      });
      if (lsData.has(CONFLICTS)) {
        var live = await readAll(); state(new Map(live));
      } else { state(lsData); }
      await pruneStrayConflicts();
      pending = false; ready = true; return 'ls';
    }
    mode = 'idb';
    storage.setItem(BACKEND, 'idb');
    var entries = await readAll(), journal = new Map(entries).get(JOURNAL);
    if (journal !== undefined) { await replay(journal, false); entries = await readAll(); }
    await migrate(entries);
    pending = false; ready = true; return 'idb';
  }
  async function initialize() {
    ready = false; failed = false; error = null;
    try {
      return await openBackend();
    } catch (e) {
      error = null;
      // 第一步自愈：搬走损坏的元数据、清掉外来键，然后重来一次。
      try {
        pending = false;
        await repairMetadata();
        return await openBackend();
      } catch (e2) {
        // 第二步兜底：数据库彻底不可用时退到 localStorage 模式。
        // 宁可让用户先能用（书架可能有偏差，比「整个应用锁死」强），
        // 也不能把 failed 一直挂在那里——那正是「双端存储都不能用了」的成因。
        try {
          if (db) { try { db.close(); } catch (e3) { } }
          db = null; opening = null;
          mode = 'ls'; degraded = true;
          try { global.localStorage.setItem(BACKEND, 'ls'); } catch (e3) { }
          var fallback = new Map();
          try { fallback = new Map(await readAll()); } catch (e3) { }
          state(fallback);
          pending = false; ready = true; failed = false;
          announce();
          return 'ls';
        } catch (e3) {
          throw problem('初始化存储失败，请重试；原数据仍保留', e2, true);
        }
      }
    }
  }
  function enqueue(work) {
    try { writeGuard(); } catch (e) { return Promise.reject(e); }
    var operation = queue.then(async function () {
      if (failed || pending || !ready) throw problem('存储已暂停写入，请重试', null, false);
      try { return await work(); }
      catch (e) { throw problem('保存数据失败，请重试；未切换存储后端', e, true); }
    });
    queue = operation.catch(function () {});
    return operation;
  }
  function exclusive(work, reads) {
    if (busy) return Promise.reject(problem('正在处理存储，请稍后重试', null, false));
    busy = true; blockReads = !!reads;
    var operation = queue.then(work);
    queue = operation.catch(function () {});
    return operation.finally(function () { busy = false; blockReads = false; announce(); });
  }

  var api = {
    get mode() { return mode; },
    status: function () {
      return {
        mode: mode, writable: writable(), error: error, conflicts: copy(conflicts),
        degraded: degraded, repaired: repaired, foreign: foreign.slice()
      };
    },
    init: function () {
      if (!initializing) initializing = exclusive(initialize, true);
      return initializing;
    },
    retry: function () {
      return exclusive(async function () {
        if (db) db.close();
        db = null; opening = null; initializing = null;
        degraded = false;
        await repairMetadata();
        return initialize();
      }, true).then(function (result) { initializing = Promise.resolve(result); return result; });
    },
    /* 「一键修复」：同 retry，但会先把损坏的元数据和外来缓存键清掉，
     * 并把之前自动降级的状态复位，重新争取走数据库。 */
    repair: function () {
      return api.retry();
    },
    get: async function (key) {
      readGuard();
      try {
        if (!application(key)) throw new Error('读取键不属于应用');
        if (mode === 'ls' || special(key)) {
          var raw = global.localStorage.getItem(key);
          if (raw === null) return null;
          if (special(key)) return raw;
          var got = tryDecode(raw);
          // 外来模块写进 nr_ 命名空间的原始值：当作「没有这条数据」，不要因此把存储标成失败。
          if (got.error) { noteForeign(key); return null; }
          return got.value;
        }
        return await transaction('readonly', function (store, result) {
          var request = store.get(key);
          request.onsuccess = function () { result(request.result === undefined ? null : request.result); };
        });
      } catch (e) { throw problem('读取数据失败，请重试；未切换存储后端', e, true); }
    },
    set: function (key, value) {
      var checked;
      try {
        if (!application(key) || key.length > 1024 || special(key) && typeof value !== 'string') throw new Error('保存键或值不合法');
        checked = checkedJSON(value);
      } catch (e) { return Promise.reject(problem('保存数据校验失败' + (e && e.message ? '：' + e.message : ''), e, false)); }
      return enqueue(function () {
        if (mode === 'ls' || special(key)) { global.localStorage.setItem(key, special(key) ? checked : JSON.stringify(checked)); return; }
        return transaction('readwrite', function (store) { store.put(checked, key); });
      });
    },
    del: function (key) {
      if (!application(key)) return Promise.reject(problem('删除键不属于应用', null, false));
      return enqueue(function () {
        if (mode === 'ls' || special(key)) { global.localStorage.removeItem(key); return; }
        return transaction('readwrite', function (store) { store.delete(key); });
      });
    },
    deleteBooks: function (ids) {
      var selected;
      try {
        if (ids === null) selected = null;
        else {
          if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ENTRIES) throw new Error('请选择要删除的书籍');
          var checked = checkedJSON(ids);
          checked.forEach(function (id) {
            // IDs cannot contain either cache delimiter; never coerce or interpolate a regex.
            if (typeof id !== 'string' || !id.length || id.length > 1000 || /[^A-Za-z0-9-]/.test(id)) throw new Error('书籍 ID 不合法');
          });
          selected = new Set(checked);
        }
      } catch (e) { return Promise.reject(problem('删除书籍参数校验失败，未改动任何数据', e, false)); }
      try { writeGuard(); } catch (e) { return Promise.reject(e); }
      // Claim exclusivity now, but execute only after previously accepted writes drain.
      return exclusive(async function () {
        operationalGuard();
        try {
          if (mode === 'ls') {
            var data = new Map(await readAll()), removed = new Set();
            var next = shelfAfterDeletion(data.get('nr_index'), selected);
            data.forEach(function (value, key) {
              if (bookCacheKey(key, selected) || key === 'nr_last' && (selected === null || selected.has(value))) {
                data.delete(key); removed.add(key);
              }
            });
            data.set('nr_index', next);
            // Recoverable LS journal, not a localStorage transaction; do not reintroduce deleted raw pairs.
            await commit(data, localPairs().filter(function (pair) { return !removed.has(pair[0]); }));
            return next;
          }
          return await transaction('readwrite', function (store, result, abort) {
            var next = [], request = store.openCursor();
            request.onerror = function () { abort(request.error || new Error('删除书籍游标读取失败')); };
            request.onsuccess = function () {
              try {
                var cursor = request.result;
                if (!cursor) { store.put(next, 'nr_index'); result(next); return; }
                if (cursor.key === 'nr_index') next = shelfAfterDeletion(cursor.value, selected);
                if (bookCacheKey(cursor.key, selected) || cursor.key === 'nr_last' && (selected === null || selected.has(cursor.value))) store.delete(cursor.key);
                cursor.continue();
              } catch (e) { abort(e); }
            };
          });
        } catch (e) { throw problem('删除书籍失败，存储已暂停；请重试恢复，未切换存储后端', e, true); }
      }, true);
    },
    usage: async function () {
      readGuard();
      if (mode !== 'ls') return null;
      try { return localPairs().reduce(function (n, pair) { return n + pair[1].length; }, 0); }
      catch (e) { throw problem('读取存储用量失败，请重试', e, true); }
    },
    resolveConflicts: function (choice) {
      if (choice !== 'idb' && choice !== 'local') return Promise.reject(problem('请选择数据库或本地数据', null, false));
      return exclusive(async function () {
        operationalGuard();
        if (!conflictRecord) return;
        try {
          var entries = await readAll(), data = new Map(entries), old = copy(conflictRecord);
          var local = localPairs(), backups = backupList(data);
          backups.push(record('resolve', entries, old.local));
          if (choice === 'local') {
            if (old.snapshot) {
              data.forEach(function (_, key) { if (business(key)) data.delete(key); });
              old.local.forEach(function (pair) { if (business(pair[0])) data.set(pair[0], checkedJSON(decode(pair[1]))); });
            } else old.conflicts.forEach(function (c) { data.set(c.key, copy(c.local)); });
          }
          data.set(BACKUPS, backups); data.delete(CONFLICTS);
          await commit(data, retainedLocal(choice === 'local' && old.snapshot ? old.local : local));
          state(data); error = null;
        } catch (e) { throw problem('解决存储冲突失败，请重试；原值备份仍保留', e, true); }
      }, true);
    },
    exportSnapshot: function () {
      return exclusive(async function () {
        operationalGuard();
        try {
          var entries = await readAll();
          entries = entries.filter(function (pair) { return internal(pair[0]) || business(pair[0]); });
          var snapshot = { format: 'iread-backup', version: 1, createdAt: new Date().toISOString(), entries: entries, local: localPairs() };
          return validateSnapshot(snapshot);
        } catch (e) { throw problem('导出备份失败，请重试', e, true); }
      }, false);
    },
    restoreSnapshot: function (snapshot) {
      var checked;
      try { checked = validateSnapshot(snapshot); }
      catch (e) { return Promise.reject(problem('备份校验失败，未改动任何数据', e, false)); }
      return exclusive(async function () {
        operationalGuard();
        try {
          var oldEntries = await readAll(), old = new Map(oldEntries), data = new Map(checked.entries);
          var backups = backupList(old);
          backupList(data).forEach(function (item) { if (!backups.some(function (saved) { return same(item, saved); })) backups.push(item); });
          backups.push(record('restore', oldEntries, localPairs()));
          data.set(BACKUPS, backups);
          await commit(data, checked.local);
          state(data); error = null;
        } catch (e) { throw problem('恢复备份失败，存储已暂停；请重试恢复日志', e, true); }
      }, true);
    }
  };
  global.NR = global.NR || {};
  global.NR.store = api;
})(window);
