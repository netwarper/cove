'use strict';

/*
 * Encryption at rest.
 *
 * Every note, workspace metadata blob and attachment stored on disk is
 * encrypted with AES-256-GCM using a key derived from the user's passphrase
 * via scrypt. The key only ever lives in server memory while a session is
 * unlocked; it is never written to disk. If the data directory (which may be
 * a Google Drive / Box / Dropbox sync folder) is copied by an attacker, the
 * contents are unreadable without the passphrase.
 */

const crypto = require('crypto');

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16;
const SALT_LEN = 16;
const MAGIC = Buffer.from('MN1'); // format marker + version

// scrypt cost parameters. maxmem must accommodate 128 * N * r bytes.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Derive a 32-byte key from a passphrase + salt. */
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, KEY_LEN, SCRYPT);
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

/**
 * Build the vault descriptor written on first setup. Contains the KDF salt
 * and an encrypted verifier token used to check the passphrase on login.
 * The salt is not secret; the verifier proves knowledge of the key.
 */
function createVault(passphrase) {
  const salt = randomSalt();
  const key = deriveKey(passphrase, salt);
  const verifier = encrypt(key, Buffer.from('meeting-notes-vault-ok', 'utf8')).toString('base64');
  return {
    vault: {
      version: 1,
      kdf: 'scrypt',
      scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      salt: salt.toString('base64'),
      verifier,
      createdAt: new Date().toISOString(),
    },
    key,
  };
}

/** Verify a passphrase against a stored vault descriptor. Returns key or null. */
function unlockVault(vault, passphrase) {
  try {
    const salt = Buffer.from(vault.salt, 'base64');
    const key = deriveKey(passphrase, salt);
    const plain = decrypt(key, Buffer.from(vault.verifier, 'base64')).toString('utf8');
    if (plain === 'meeting-notes-vault-ok') return key;
    return null;
  } catch (_e) {
    return null;
  }
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
  randomId,
  randomToken,
};
