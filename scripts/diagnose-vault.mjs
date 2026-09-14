/**
 * Read-only vault diagnostic.
 *
 * Answers the one question the app cannot: is this a WRONG PASSPHRASE, or a
 * vault that opens but fails its integrity walk? `Vault.unlock` reports both as
 * the same error by design, so the screen cannot distinguish them.
 *
 * Works on a COPY. It never touches the live vault, and it prints no passphrase,
 * no salt and no row contents — only counts.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { argon2id } from '@noble/hashes/argon2.js';
import { readFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceDir = process.argv[2];
const passphrase = process.env.PORTTRACK_PASSPHRASE ?? '';
if (!sourceDir || passphrase.length === 0) {
  console.error('usage: PORTTRACK_PASSPHRASE=... node diagnose-vault.mjs <data-dir>');
  process.exit(2);
}

// A scratch copy, so nothing here can checkpoint, truncate or lock the original.
const work = mkdtempSync(join(tmpdir(), 'porttrack-diag-'));
const db = join(work, 'vault.db');
for (const suffix of ['', '-wal', '-shm']) {
  const from = join(sourceDir, `vault.db${suffix}`);
  if (existsSync(from)) copyFileSync(from, `${db}${suffix}`);
}

const meta = JSON.parse(readFileSync(join(sourceDir, 'vault.db.meta.json'), 'utf8'));
console.log(`cipher=${meta.cipher} kdf=${meta.kdf} params=${JSON.stringify(meta.params)}`);

const key = argon2id(passphrase, Buffer.from(meta.saltHex, 'hex'), meta.params);
const hex = Buffer.from(key).toString('hex');

let handle;
try {
  handle = new Database(db);
  handle.pragma(`cipher='${meta.cipher}'`);
  handle.pragma(`hexkey='${hex}'`);

  // If the key is WRONG this throws "file is not a database". If the key is
  // RIGHT but the file is damaged, this succeeds and quick_check below fails.
  const tables = handle
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'")
    .get().n;
  console.log(`KEY ACCEPTED — schema readable, ${tables} tables`);

  const check = handle.pragma('quick_check', { simple: true });
  console.log(`quick_check: ${check}`);

  for (const table of ['assets', 'lots', 'exits', 'hand_loans', 'chit_funds']) {
    try {
      const n = handle.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      console.log(`  ${table}: ${n} rows`);
    } catch (cause) {
      console.log(`  ${table}: unreadable (${cause.message})`);
    }
  }
} catch (cause) {
  console.log(`KEY REJECTED or file unreadable: ${cause.message}`);
  console.log('  -> that message means the derived key did not decrypt page 1,');
  console.log('     i.e. a different passphrase than the one this vault was made with.');
} finally {
  handle?.close();
}
