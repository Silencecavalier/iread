/* =========================================================================
 * inflate.js — 精简 raw DEFLATE 解压器（用于解析 EPUB 内部的 ZIP）
 * 无依赖，纯本地实现。支持 method 8（deflate）与 method 0（store）。
 * ========================================================================= */
(function (global) {
  'use strict';

  var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  function Huffman(lengths, n) {
    var i, maxBits = 0, offs, b, sym;
    for (i = 0; i < n; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
    this.maxBits = maxBits;
    this.count = new Int32Array(maxBits + 2);
    for (i = 0; i < n; i++) this.count[lengths[i]]++;
    this.count[0] = 0;
    offs = new Int32Array(maxBits + 2);
    for (b = 1; b <= maxBits; b++) offs[b] = offs[b - 1] + this.count[b - 1];
    sym = new Int32Array(n);
    for (i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
    this.symbol = sym;
  }

  function inflate(input) {
    var inPos = 0, bitBuf = 0, bitCnt = 0;
    var out = new Uint8Array(Math.max(1024, input.length * 4)), outLen = 0;

    function ensure(n) {
      if (outLen + n <= out.length) return;
      var cap = out.length;
      while (cap < outLen + n) cap *= 2;
      var nb = new Uint8Array(cap);
      nb.set(out.subarray(0, outLen));
      out = nb;
    }
    function bits(need) {
      var val = bitBuf;
      while (bitCnt < need) { val |= input[inPos++] << bitCnt; bitCnt += 8; }
      bitBuf = val >>> need;
      bitCnt -= need;
      return val & ((1 << need) - 1);
    }
    function decode(h) {
      var code = 0, first = 0, index = 0, len, count;
      for (len = 1; len <= 16; len++) {
        code |= bits(1);
        count = h.count[len];
        if (code - first < count) return h.symbol[index + (code - first)];
        index += count; first = (first + count) << 1; code <<= 1;
      }
      throw new Error('bad huffman code');
    }

    var last, i;
    do {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        var len = input[inPos] | (input[inPos + 1] << 8);
        inPos += 4;
        ensure(len);
        out.set(input.subarray(inPos, inPos + len), outLen);
        outLen += len; inPos += len;
      } else if (type === 1 || type === 2) {
        var litTree, distTree;
        if (type === 1) {
          var fl = new Uint8Array(288), fd = new Uint8Array(30);
          for (i = 0; i < 144; i++) fl[i] = 8;
          for (i = 144; i < 256; i++) fl[i] = 9;
          for (i = 256; i < 280; i++) fl[i] = 7;
          for (i = 280; i < 288; i++) fl[i] = 8;
          for (i = 0; i < 30; i++) fd[i] = 5;
          litTree = new Huffman(fl, 288);
          distTree = new Huffman(fd, 30);
        } else {
          var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          var cl = new Uint8Array(19);
          for (i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
          var clTree = new Huffman(cl, 19);
          var lens = new Uint8Array(hlit + hdist), n, sym;
          n = 0;
          while (n < hlit + hdist) {
            sym = decode(clTree);
            if (sym < 16) lens[n++] = sym;
            else if (sym === 16) { var r = lens[n - 1], rc = 3 + bits(2); while (rc--) lens[n++] = r; }
            else if (sym === 17) { var rc2 = 3 + bits(3); while (rc2--) lens[n++] = 0; }
            else { var rc3 = 11 + bits(7); while (rc3--) lens[n++] = 0; }
          }
          litTree = new Huffman(lens.subarray(0, hlit), hlit);
          distTree = new Huffman(lens.subarray(hlit, hlit + hdist), hdist);
        }
        for (;;) {
          var s = decode(litTree);
          if (s < 256) { ensure(1); out[outLen++] = s; }
          else if (s === 256) break;
          else {
            s -= 257;
            if (s >= 29) throw new Error('bad length');
            var l = LBASE[s] + bits(LEXT[s]);
            var ds = decode(distTree);
            var d = DBASE[ds] + bits(DEXT[ds]);
            ensure(l);
            var from = outLen - d;
            for (i = 0; i < l; i++) out[outLen++] = out[from++];
          }
        }
      } else throw new Error('bad block type');
    } while (!last);

    return out.subarray(0, outLen);
  }

  /* ---------- ZIP 读取：返回 { name: Uint8Array } ---------- */
  function readZip(buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    var i, eocd = -1;
    for (i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件');
    var total = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var files = {}, p = cdOff;
    for (i = 0; i < total; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true);
      var elen = dv.getUint16(p + 30, true);
      var clen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = utf8(u8.subarray(p + 46, p + 46 + nlen));
      var lhNameLen = dv.getUint16(lho + 26, true);
      var lhExtraLen = dv.getUint16(lho + 28, true);
      var dataOff = lho + 30 + lhNameLen + lhExtraLen;
      var raw = u8.subarray(dataOff, dataOff + csize);
      var data;
      if (method === 0) { data = raw; }
      else if (method === 8) { data = inflate(raw); }
      else { data = new Uint8Array(0); }
      files[name] = data;
      if (data.length !== usize) { /* 允许 zip64 等情况 */ }
      p += 46 + nlen + elen + clen;
    }
    return files;
  }

  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
  }

  global.NR = global.NR || {};
  global.NR.inflate = inflate;
  global.NR.readZip = readZip;
})(window);
