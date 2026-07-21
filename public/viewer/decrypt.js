/*
 * Offline decryptor for the standalone notes viewer.
 *
 * Reimplements exactly what lib/crypto.js does, but for the browser, so the
 * viewer can decrypt on-device with only the passphrase:
 *   - scrypt (N=16384, r=8, p=1) key derivation
 *   - AES-256-GCM with the MN1 | iv(12) | tag(16) | ciphertext layout
 *   - envelope unwrap: passphrase -> KEK -> unwrap the DEK -> decrypt data
 *
 * AES-GCM and PBKDF2 use WebCrypto (present in browsers and Node >= 20);
 * scrypt's ROMix/Salsa20 core is pure JS. Works in both environments so the
 * exact same code is unit-tested in Node and shipped inside the HTML file.
 */
(function (root) {
  'use strict';
  var C = (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof window !== 'undefined' && window.crypto);

  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      var bin = atob(b64), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
  function bytesToStr(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  // ---- pure-JS fallback crypto (for file:// on iOS Safari, where WebCrypto's
  //      crypto.subtle is unavailable because file:// is not a secure context) ----
  function hasSubtle() {
    return !(typeof globalThis !== 'undefined' && globalThis.MN_FORCE_PURE) && C && C.subtle && C.subtle.decrypt;
  }

  // SHA-256
  var K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(msg) {
    var H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var l = msg.length, withOne = l + 1, k = (56 - withOne % 64 + 64) % 64;
    var total = withOne + k + 8, buf = new Uint8Array(total);
    buf.set(msg); buf[l] = 0x80;
    var bits = l * 8;
    buf[total - 4] = (bits >>> 24) & 0xff; buf[total - 3] = (bits >>> 16) & 0xff; buf[total - 2] = (bits >>> 8) & 0xff; buf[total - 1] = bits & 0xff;
    var w = new Uint32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = (buf[off + 4 * i] << 24) | (buf[off + 4 * i + 1] << 16) | (buf[off + 4 * i + 2] << 8) | buf[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], cc = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & cc) ^ (b & cc);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = cc; cc = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + cc) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = (H[i] >>> 16) & 0xff; out[4 * i + 2] = (H[i] >>> 8) & 0xff; out[4 * i + 3] = H[i] & 0xff; }
    return out;
  }
  function hmacSha256(key, data) {
    if (key.length > 64) key = sha256(key);
    var k = new Uint8Array(64); k.set(key);
    var ip = new Uint8Array(64), op = new Uint8Array(64);
    for (var i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    var inner = sha256(concat(ip, data));
    return sha256(concat(op, inner));
  }
  function pbkdf2Pure(pw, salt, iters, dkLen) {
    var out = new Uint8Array(dkLen), blocks = Math.ceil(dkLen / 32), pos = 0;
    for (var b = 1; b <= blocks; b++) {
      var bb = new Uint8Array(salt.length + 4); bb.set(salt); bb[salt.length] = (b >>> 24) & 0xff; bb[salt.length + 1] = (b >>> 16) & 0xff; bb[salt.length + 2] = (b >>> 8) & 0xff; bb[salt.length + 3] = b & 0xff;
      var u = hmacSha256(pw, bb), t = u.slice();
      for (var it = 1; it < iters; it++) { u = hmacSha256(pw, u); for (var k = 0; k < 32; k++) t[k] ^= u[k]; }
      var n = Math.min(32, dkLen - pos); out.set(t.slice(0, n), pos); pos += n;
    }
    return out;
  }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

  // AES-256 (encrypt block only — enough for GCM)
  var SBOX = (function () {
    var p = 1, q = 1, sbox = new Uint8Array(256);
    do {
      p = p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0); p &= 0xff;
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
      var x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4)); x &= 0xff;
      sbox[p] = x ^ 0x63;
    } while (p !== 1);
    sbox[0] = 0x63; return sbox;
  })();
  function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
  function aesExpandKey(key) {
    var Nk = 8, Nr = 14, rk = new Uint8Array(4 * 4 * (Nr + 1));
    rk.set(key);
    var rcon = 1;
    for (var i = Nk; i < 4 * (Nr + 1); i++) {
      var t0 = rk[4 * (i - 1)], t1 = rk[4 * (i - 1) + 1], t2 = rk[4 * (i - 1) + 2], t3 = rk[4 * (i - 1) + 3];
      if (i % Nk === 0) {
        var tmp = t0; t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp];
        rcon = xtime(rcon);
      } else if (i % Nk === 4) { t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3]; }
      rk[4 * i] = rk[4 * (i - Nk)] ^ t0; rk[4 * i + 1] = rk[4 * (i - Nk) + 1] ^ t1; rk[4 * i + 2] = rk[4 * (i - Nk) + 2] ^ t2; rk[4 * i + 3] = rk[4 * (i - Nk) + 3] ^ t3;
    }
    return rk;
  }
  function aesEncryptBlock(rk, inp) {
    var Nr = 14, s = inp.slice(0, 16), i, r;
    for (i = 0; i < 16; i++) s[i] ^= rk[i];
    for (r = 1; r < Nr; r++) {
      for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      var t = s.slice();
      s[1] = t[5]; s[5] = t[9]; s[9] = t[13]; s[13] = t[1];
      s[2] = t[10]; s[6] = t[14]; s[10] = t[2]; s[14] = t[6];
      s[3] = t[15]; s[7] = t[3]; s[11] = t[7]; s[15] = t[11];
      for (i = 0; i < 16; i += 4) {
        var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3], all = a0 ^ a1 ^ a2 ^ a3;
        s[i] ^= all ^ xtime(a0 ^ a1); s[i + 1] ^= all ^ xtime(a1 ^ a2); s[i + 2] ^= all ^ xtime(a2 ^ a3); s[i + 3] ^= all ^ xtime(a3 ^ a0);
      }
      for (i = 0; i < 16; i++) s[i] ^= rk[16 * r + i];
    }
    for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    var t2 = s.slice();
    s[1] = t2[5]; s[5] = t2[9]; s[9] = t2[13]; s[13] = t2[1];
    s[2] = t2[10]; s[6] = t2[14]; s[10] = t2[2]; s[14] = t2[6];
    s[3] = t2[15]; s[7] = t2[3]; s[11] = t2[7]; s[15] = t2[11];
    for (i = 0; i < 16; i++) s[i] ^= rk[16 * Nr + i];
    return s;
  }
  function gfMul(X, Y) {
    var Z = new Uint8Array(16), V = Y.slice(), i, k;
    for (i = 0; i < 128; i++) {
      if ((X[i >> 3] >> (7 - (i & 7))) & 1) for (k = 0; k < 16; k++) Z[k] ^= V[k];
      var lsb = V[15] & 1;
      for (k = 15; k > 0; k--) V[k] = ((V[k] >> 1) | ((V[k - 1] & 1) << 7)) & 0xff;
      V[0] = V[0] >> 1; if (lsb) V[0] ^= 0xe1;
    }
    return Z;
  }
  function ghash(H, data) {
    var Y = new Uint8Array(16);
    for (var i = 0; i < data.length; i += 16) { for (var k = 0; k < 16; k++) Y[k] ^= data[i + k]; Y = gfMul(Y, H); }
    return Y;
  }
  function gcmDecryptPure(keyBytes, iv, ct, tag) {
    var rk = aesExpandKey(keyBytes);
    var H = aesEncryptBlock(rk, new Uint8Array(16));
    var J0 = new Uint8Array(16); J0.set(iv.slice(0, 12)); J0[15] = 1;
    // GHASH over zero-padded ciphertext + length block
    var padLen = Math.ceil(ct.length / 16) * 16;
    var ghIn = new Uint8Array(padLen + 16); ghIn.set(ct);
    var bits = ct.length * 8;
    var dv = ghIn.subarray(padLen); // AAD len = 0 (first 8 bytes), ct bit-len (last 8)
    dv[12] = (bits >>> 24) & 0xff; dv[13] = (bits >>> 16) & 0xff; dv[14] = (bits >>> 8) & 0xff; dv[15] = bits & 0xff;
    var S = ghash(H, ghIn);
    var eJ0 = aesEncryptBlock(rk, J0), calc = new Uint8Array(16);
    for (var i = 0; i < 16; i++) calc[i] = S[i] ^ eJ0[i];
    var diff = 0; for (i = 0; i < 16; i++) diff |= (calc[i] ^ tag[i]);
    if (diff !== 0) throw new Error('authentication failed');
    // CTR decrypt starting at inc32(J0)
    var counter = J0.slice(); inc32(counter);
    var out = new Uint8Array(ct.length);
    for (var off = 0; off < ct.length; off += 16) {
      var ks = aesEncryptBlock(rk, counter);
      for (var j = 0; j < 16 && off + j < ct.length; j++) out[off + j] = ct[off + j] ^ ks[j];
      inc32(counter);
    }
    return out;
  }
  function inc32(block) {
    for (var i = 15; i >= 12; i--) { block[i] = (block[i] + 1) & 0xff; if (block[i] !== 0) break; }
  }

  // ---- scrypt (RFC 7914) ----
  function R(a, b) { return ((a << b) | (a >>> (32 - b))) >>> 0; }
  function salsa20_8(B) {
    var x = new Uint32Array(16), i;
    for (i = 0; i < 16; i++) x[i] = B[i];
    for (i = 0; i < 8; i += 2) {
      x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
    }
    for (i = 0; i < 16; i++) B[i] = (B[i] + x[i]) >>> 0;
  }
  function blockMix(inW, outW, r, X) {
    var i, k;
    for (k = 0; k < 16; k++) X[k] = inW[(2 * r - 1) * 16 + k];
    for (i = 0; i < 2 * r; i++) {
      for (k = 0; k < 16; k++) X[k] ^= inW[i * 16 + k];
      salsa20_8(X);
      var blk = (i % 2 === 0) ? (i / 2) : (r + (i - 1) / 2);
      for (k = 0; k < 16; k++) outW[blk * 16 + k] = X[k];
    }
  }
  function romix(B, off, N, r) {
    var n32 = 32 * r, i, k;
    var X = B.slice(off, off + n32);
    var Y = new Uint32Array(n32);
    var V = new Uint32Array(n32 * N);
    var scratch = new Uint32Array(16);
    for (i = 0; i < N; i++) { V.set(X, i * n32); blockMix(X, Y, r, scratch); var t = X; X = Y; Y = t; }
    for (i = 0; i < N; i++) {
      var j = (X[(2 * r - 1) * 16] >>> 0) % N;
      for (k = 0; k < n32; k++) X[k] ^= V[j * n32 + k];
      blockMix(X, Y, r, scratch); var t2 = X; X = Y; Y = t2;
    }
    for (k = 0; k < n32; k++) B[off + k] = X[k];
  }
  function bytesToU32LE(bytes) {
    var n = bytes.length / 4, u = new Uint32Array(n);
    for (var i = 0; i < n; i++) u[i] = (bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24)) >>> 0;
    return u;
  }
  function u32LEToBytes(u) {
    var b = new Uint8Array(u.length * 4);
    for (var i = 0; i < u.length; i++) { b[4 * i] = u[i] & 0xff; b[4 * i + 1] = (u[i] >>> 8) & 0xff; b[4 * i + 2] = (u[i] >>> 16) & 0xff; b[4 * i + 3] = (u[i] >>> 24) & 0xff; }
    return b;
  }
  async function pbkdf2(passwordBytes, saltBytes, bits) {
    if (hasSubtle()) {
      var key = await C.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
      var out = await C.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 1, hash: 'SHA-256' }, key, bits);
      return new Uint8Array(out);
    }
    return pbkdf2Pure(passwordBytes, saltBytes, 1, bits / 8);
  }
  async function scrypt(passwordBytes, saltBytes, N, r, p, dkLen) {
    var B = await pbkdf2(passwordBytes, saltBytes, 8 * p * 128 * r);
    var B32 = bytesToU32LE(B);
    for (var i = 0; i < p; i++) romix(B32, i * 32 * r, N, r);
    return pbkdf2(passwordBytes, u32LEToBytes(B32), 8 * dkLen);
  }

  // ---- AES-256-GCM (MN1 layout) ----
  async function aesGcmDecrypt(keyBytes, blob) {
    if (blob.length < 31 || bytesToStr(blob.slice(0, 3)) !== 'MN1') throw new Error('bad format marker');
    var iv = blob.slice(3, 15), tag = blob.slice(15, 31), ct = blob.slice(31);
    if (hasSubtle()) {
      var data = new Uint8Array(ct.length + tag.length); data.set(ct, 0); data.set(tag, ct.length);
      var key = await C.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      var pt = await C.subtle.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, key, data);
      return new Uint8Array(pt);
    }
    return gcmDecryptPure(keyBytes, iv, ct, tag);
  }

  // ---- envelope unwrap ----
  var SCRYPT = { N: 16384, r: 8, p: 1 };
  async function deriveKEK(secretStr, saltB64, params) {
    params = params || SCRYPT;
    return scrypt(utf8(secretStr), b64ToBytes(saltB64), params.N, params.r, params.p, 32);
  }
  /** Given a vault key slot {salt, wrapped} and a secret, return the DEK or throw. */
  async function unwrapDEK(slot, secretStr, params) {
    var kek = await deriveKEK(secretStr, slot.salt, params);
    return aesGcmDecrypt(kek, b64ToBytes(slot.wrapped));
  }
  function normalizeRecoveryKey(k) { return String(k || '').toLowerCase().replace(/[^0-9a-f]/g, ''); }

  async function decryptJSON(dek, b64) { return JSON.parse(bytesToStr(await aesGcmDecrypt(dek, b64ToBytes(b64)))); }
  async function decryptBytes(dek, b64) { return aesGcmDecrypt(dek, b64ToBytes(b64)); }

  var api = { scrypt, aesGcmDecrypt, unwrapDEK, deriveKEK, decryptJSON, decryptBytes, b64ToBytes, normalizeRecoveryKey };
  root.MNDecrypt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
