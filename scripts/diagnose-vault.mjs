/**
 * Offline vault diagnostic — the recovery tool for "it won't unlock".
 *
 * `Vault.unlock` reports a wrong passphrase and a damaged vault as the SAME
 * error, deliberately: the response must not reveal whether a vault holds data
 * (ADR-014). That is right for a network-facing API and useless to the one
 * person entitled to know, so this answers the question offline instead.
 *
 * It distinguishes four outcomes and exits with a distinct code for each, so it
 * is usable from a script as well as by eye:
 *
 *   0  the passphrase is right and the database is sound
 *   1  the passphrase is right and the database FAILS its integrity walk
 *   3  the passphrase is wrong — page 1 did not decrypt
 *   4  there is no vault at that path to check
 *   2  the arguments were unusable
 *
 * Three safety properties, each of which this tool got wrong at first:
 *
 *  - **It never creates a vault.** `new Database(path)` CREATES the file when it
 *    is absent, so an earlier version answered "KEY ACCEPTED, 0 tables" for a
 *    passphrase nobody had ever used, pointed at an empty directory. That is the
 *    exact state someone checks in a panic, and a false reassurance there is
 *    worse than no tool. `fileMustExist` plus an explicit check now refuse it.
 *  - **It works on a COPY, and removes the copy.** The live vault is never
 *    opened, so nothing here can checkpoint, truncate or lock it. The copy is
 *    deleted in `finally` — an earlier version leaked one per run into /tmp,
 *    which meant a vault the owner had deliberately deleted survived in a
 *    world-readable directory.
 *  - **It prints no secrets.** No passphrase, no salt, no row contents — the
 *    cipher parameters, table names and row counts only.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { argon2id } from '@noble/hashes/argon2.js';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const EXIT = { SOUND: 0, DAMAGED: 1, USAGE: 2, WRONG_KEY: 3, NO_VAULT: 4 };

const sourceDir = process.argv[2];
const passphrase = process.env.VANTAGEPOINT_PASSPHRASE ?? '';

if (sourceDir === undefined || passphrase.length === 0) {
  console.error(
    [
      'usage: VANTAGEPOINT_PASSPHRASE=... pnpm vault:diagnose <data-dir>',
      '',
      'Type the passphrase into a prompt rather than the command line, so it',
      'does not land in your shell history:',
      '',
      "  read -rs -p 'passphrase: ' VANTAGEPOINT_PASSPHRASE && export VANTAGEPOINT_PASSPHRASE",
      '  pnpm vault:diagnose ./data',
      '  unset VANTAGEPOINT_PASSPHRASE',
    ].join('\n'),
  );
  process.exit(EXIT.USAGE);
}

const metaPath = join(sourceDir, 'vault.db.meta.json');
const dbPath = join(sourceDir, 'vault.db');
const walPath = `${dbPath}-wal`;

/*
 * Refused before anything is derived or copied. A directory holding only the
 * salt file is a vault that has been created but never unlocked — there is
 * nothing to check, and saying so is the useful answer.
 */
if (!existsSync(metaPath)) {
  console.error(`no vault metadata at ${metaPath}`);
  console.error('  -> this directory has never held a VantagePoint vault.');
  process.exit(EXIT.NO_VAULT);
}
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} (the salt file is present)`);
  console.error('  -> the vault was initialised but never unlocked, so no data exists yet.');
  console.error('     The NEXT unlock will set the passphrase; nothing can be verified before then.');
  process.exit(EXIT.NO_VAULT);
}

let meta;
try {
  meta = JSON.parse(readFileSync(metaPath, 'utf8'));
} catch (cause) {
  console.error(`${basename(metaPath)} is unreadable: ${cause.message}`);
  console.error('  -> without the salt the key cannot be derived, and the vault cannot be opened');
  console.error('     by anything. Restore it from a backup of the WHOLE data directory.');
  process.exit(EXIT.NO_VAULT);
}

console.log(`vault   : ${dbPath}`);
console.log(`cipher  : ${meta.cipher}   kdf: ${meta.kdf}   params: ${JSON.stringify(meta.params)}`);
console.log(`database: ${statSync(dbPath).size} bytes`);

/*
 * Reported because it is load-bearing and invisible. A process killed without a
 * clean close leaves every committed page in the write-ahead log, so a large WAL
 * beside a tiny database is normal — and means a backup of `vault.db` ALONE
 * restores an empty vault.
 */
if (existsSync(walPath)) {
  const walSize = statSync(walPath).size;
  const frames = walSize > 32 ? Math.floor((walSize - 32) / (24 + 4096)) : 0;
  console.log(`wal     : ${walSize} bytes (~${frames} pages not yet checkpointed)`);
} else {
  console.log('wal     : none (fully checkpointed into the database)');
}

// The `-shm` is deliberately NOT copied: it is a rebuildable index of the WAL,
// and a stale one copied alongside would be a source of false failures.
const work = mkdtempSync(join(tmpdir(), 'vantagepoint-diag-'));
const copy = join(work, 'vault.db');
let handle;
let exitCode = EXIT.SOUND;

try {
  copyFileSync(dbPath, copy);
  if (existsSync(walPath)) copyFileSync(walPath, `${copy}-wal`);

  const key = argon2id(passphrase, Buffer.from(meta.saltHex, 'hex'), meta.params);
  // The pragma takes hex, and a JavaScript string cannot be overwritten in
  // place. The raw key bytes are wiped below; this is the same defence-in-depth
  // limit `crypto.ts` documents, not a guarantee.
  const hex = Buffer.from(key).toString('hex');
  key.fill(0);

  try {
    // `fileMustExist` is the real guard: without it this call would CREATE an
    // empty database and every check below would pass against nothing.
    handle = new Database(copy, { fileMustExist: true });
    handle.pragma(`cipher='${meta.cipher}'`);
    handle.pragma(`hexkey='${hex}'`);

    // Reading the schema is what proves the key: page 1 must decrypt for this to
    // return at all. A wrong key throws "file is not a database" here.
    const tables = handle
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);

    console.log(`\nPASSPHRASE ACCEPTED — ${tables.length} tables readable`);

    // Walks every page, so it catches damage a schema read alone would not.
    const check = handle.pragma('quick_check', { simple: true });
    if (check === 'ok') {
      console.log('INTEGRITY  ok');
    } else {
      console.log(`INTEGRITY  FAILED: ${String(check)}`);
      exitCode = EXIT.DAMAGED;
    }

    // Derived from the schema rather than hardcoded, so this keeps reporting the
    // whole vault as tables are added by later migrations.
    let rows = 0;
    for (const table of tables) {
      try {
        // Identifier, not a value — it comes from sqlite_schema, not from input.
        const n = handle.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
        rows += n;
        if (n > 0) console.log(`  ${table.padEnd(32)} ${String(n).padStart(6)} rows`);
      } catch (cause) {
        console.log(`  ${table.padEnd(32)} UNREADABLE (${cause.message})`);
        exitCode = EXIT.DAMAGED;
      }
    }
    console.log(`  ${'total'.padEnd(32)} ${String(rows).padStart(6)} rows`);

    if (exitCode === EXIT.SOUND) {
      console.log('\nVERDICT: this passphrase opens this vault and the data is intact.');
    } else {
      console.log('\nVERDICT: the passphrase is CORRECT but the database is damaged.');
      console.log('         Restore the whole data directory from a backup — vault.db AND');
      console.log('         vault.db.meta.json AND vault.db-wal, not just the database.');
    }
  } catch (cause) {
    console.log(`\nPASSPHRASE REJECTED — ${cause.message}`);
    console.log('  -> the derived key did not decrypt page 1, so this is a different');
    console.log('     passphrase from the one the vault was created with. There is no');
    console.log('     recovery path: the key exists nowhere but in what you type.');
    exitCode = EXIT.WRONG_KEY;
  }
} finally {
  handle?.close();
  // Always. An earlier version left one copy of the vault per run in /tmp.
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
