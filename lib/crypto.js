'use strict';

/*
 * Encryption at rest — envelope encryption.
 *
 * A single random 32-byte Data Encryption Key (DEK) encrypts every note,
 * workspace-metadata blob and attachment on disk with AES-256-GCM. The DEK
 * itself is never stored in the clear: it is "wrapped" (encrypted) once per
 * key slot with a Key Encryption Key (KEK) derived via scrypt from a secret —
 * the user's passphrase, and optionally a recovery key.
 *
 * Because data is encrypted with the DEK (not the passphrase directly),
 * changing the passphrase or rotating the recovery key only re-wraps the DEK;
 * the (potentially large) data files never need re-encrypting. The DEK only
 * ever lives in server memory while a session is unlocked.
 *
 * If the data directory (which may be a Google Drive / Box / Dropbox sync
 * folder) is copied by an attacker, everything is unreadable without a secret.
 */

const crypto = require('crypto');

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16;
const SALT_LEN = 16;
const MAGIC = Buffer.from('MN1'); // format marker + version

// scrypt cost parameters. maxmem must accommodate 128 * N * r bytes.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Derive a 32-byte key from a secret + salt. */
function deriveKey(secret, salt) {
  return crypto.scryptSync(Buffer.from(String(secret), 'utf8'), salt, KEY_LEN, SCRYPT);
}

function randomSalt() {
  return crypto.randomBytes(SALT_LEN);
}

/**
 * Encrypt a Buffer. Output layout:
 *   MAGIC(3) | IV(12) | TAG(16) | CIPHERTEXT
 */
function encrypt(key, plaintextBuf) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

/** Decrypt a Buffer produced by encrypt(). Throws on tampering / wrong key. */
function decrypt(key, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + IV_LEN + TAG_LEN) {
    throw new Error('ciphertext too short');
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('bad format marker');
  }
  let off = MAGIC.length;
  const iv = blob.subarray(off, off + IV_LEN); off += IV_LEN;
  const tag = blob.subarray(off, off + TAG_LEN); off += TAG_LEN;
  const ct = blob.subarray(off);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function encryptJSON(key, obj) {
  return encrypt(key, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function decryptJSON(key, blob) {
  return JSON.parse(decrypt(key, blob).toString('utf8'));
}

// ---- key slots (envelope wrapping) ------------------------------------

/** Wrap the DEK with a KEK derived from `secret`. Returns a serializable slot. */
function makeSlot(secret, dek) {
  const salt = randomSalt();
  const kek = deriveKey(secret, salt);
  return { salt: salt.toString('base64'), wrapped: encrypt(kek, dek).toString('base64') };
}

/** Try to unwrap the DEK from a slot using `secret`. Returns DEK or null. */
function openSlot(slot, secret) {
  try {
    if (!slot || !slot.salt || !slot.wrapped) return null;
    const kek = deriveKey(secret, Buffer.from(slot.salt, 'base64'));
    return decrypt(kek, Buffer.from(slot.wrapped, 'base64'));
  } catch (_e) {
    return null;
  }
}

/** A human-writable recovery key, e.g. "3f9a-1c22-8b40-...". */
function generateRecoveryKey() {
  const hex = crypto.randomBytes(16).toString('hex'); // 32 chars
  return hex.match(/.{1,4}/g).join('-');
}
function normalizeRecoveryKey(k) {
  return String(k || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * Create a new v2 vault. Returns the vault descriptor, the in-memory DEK, and
 * the one-time recovery key (show it to the user once, then forget it).
 */
function createVault(passphrase) {
  const dek = crypto.randomBytes(KEY_LEN);
  const recoveryKey = generateRecoveryKey();
  return {
    vault: {
      version: 2,
      kdf: 'scrypt',
      scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      passphrase: makeSlot(String(passphrase), dek),
      recovery: makeSlot(normalizeRecoveryKey(recoveryKey), dek),
      createdAt: new Date().toISOString(),
    },
    dek,
    recoveryKey,
  };
}

/** Unlock the DEK with a passphrase. Returns DEK or null. */
function unlockVault(vault, passphrase) {
  if (vault && vault.version === 1) {
    // legacy: passphrase-derived key WAS the data key
    try {
      const salt = Buffer.from(vault.salt, 'base64');
      const key = deriveKey(passphrase, salt);
      const plain = decrypt(key, Buffer.from(vault.verifier, 'base64')).toString('utf8');
      return plain === 'meeting-notes-vault-ok' ? key : null;
    } catch (_e) { return null; }
  }
  return openSlot(vault.passphrase, String(passphrase));
}

/** Unlock the DEK with the recovery key. Returns DEK or null. */
function unlockWithRecovery(vault, recoveryKey) {
  if (!vault || !vault.recovery) return null;
  return openSlot(vault.recovery, normalizeRecoveryKey(recoveryKey));
}

/** Re-wrap the DEK under a new passphrase, keeping the recovery slot. */
function rewrapPassphrase(vault, dek, newPassphrase) {
  const next = Object.assign({}, vault);
  next.passphrase = makeSlot(String(newPassphrase), dek);
  return next;
}

/** Issue a fresh recovery key and re-wrap the recovery slot. */
function rotateRecovery(vault, dek) {
  const recoveryKey = generateRecoveryKey();
  const next = Object.assign({}, vault);
  next.recovery = makeSlot(normalizeRecoveryKey(recoveryKey), dek);
  return { vault: next, recoveryKey };
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
  deriveKey,
  randomSalt,
  encrypt,
  decrypt,
  encryptJSON,
  decryptJSON,
  createVault,
  unlockVault,
  unlockWithRecovery,
  rewrapPassphrase,
  rotateRecovery,
  generateRecoveryKey,
  randomId,
  randomToken,
  KEY_LEN,
};
