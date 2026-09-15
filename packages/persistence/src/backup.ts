/**
 * Backup and restore (US-8.8, PRD NFR-1).
 *
 * The archive carries BOTH the database and its KDF metadata. The salt lives
 * beside the database rather than inside it, so a backup of `vault.db` alone
 * restores to a vault nobody can open — the failure would surface only when the
 * user needs the backup most.
 *
 * The bytes are produced separately from the write, because the two callers want
 * different things: the container upgrade path wants a file on disk, and the SPA
 * wants a download it never has to clean up afterwards.
 */
import { Err, Ok, VaultStateError, type Result } from '@vantagepoint/shared-kernel';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Vault } from './vault.js';

const META_SUFFIX = '.meta.json';

/**
 * Stamped into every archive so restore can refuse a file that is not one.
 *
 * Without it, pointing restore at an arbitrary JSON file writes whatever
 * `database` happened to decode to over the vault — and the user discovers that
 * at the moment they have nothing else left.
 */
const MAGIC = 'vantagepoint.vault.backup' as const;

interface Archive {
  readonly magic: typeof MAGIC;
  readonly version: 1;
  readonly createdAt: string;
  /** Already encrypted at rest, so the archive inherits that protection. */
  readonly database: string;
  readonly meta: string;
}

function parseArchive(bytes: Uint8Array): Result<Archive> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return Err(new VaultStateError('this file is not a VantagePoint backup archive'));
  }

  /*
   * Typed as unknown fields, not as `Partial<Archive>`. This is arbitrary JSON
   * off a disk — asserting the declared shape would let the compiler narrow
   * `magic` to the literal it is supposed to be and then reason that the check
   * below can never fail, which is exactly backwards: the check exists because
   * the value might be anything at all.
   */
  const archive = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Readonly<
    Record<string, unknown>
  >;

  /*
   * Version 1 archives predate the magic string, so a missing one is accepted
   * where the shape is otherwise right. A WRONG one never is.
   */
  if (archive.magic !== undefined && archive.magic !== MAGIC) {
    return Err(new VaultStateError('this file is not a VantagePoint backup archive'));
  }
  if (typeof archive.database !== 'string' || typeof archive.meta !== 'string') {
    return Err(
      new VaultStateError(
        'this backup archive is incomplete — it is missing the database or its key metadata',
      ),
    );
  }
  return Ok({
    magic: MAGIC,
    version: 1,
    createdAt: typeof archive.createdAt === 'string' ? archive.createdAt : '',
    database: archive.database,
    meta: archive.meta,
  });
}

export const Backup = {
  /** The archive as bytes, for a caller that hands them straight to a browser. */
  archive(createdAt: string): Promise<Result<Uint8Array>> {
    const source = Vault.currentPaths();
    if (source === undefined) {
      return Promise.resolve(Err(new VaultStateError('no vault is open to back up')));
    }

    if (!existsSync(source.dbPath)) {
      // The database file is created when the vault is first unlocked. Backing
      // up before that is a caller mistake, not an I/O accident.
      return Promise.resolve(
        Err(new VaultStateError('vault has never been unlocked, so there is nothing to back up')),
      );
    }

    /*
     * Checkpoint FIRST, or the archive is silently short.
     *
     * The vault runs in WAL mode, so a committed transaction lives in
     * `vault.db-wal` until SQLite folds it back. Reading `vault.db` alone
     * therefore captured the database as it stood at the last checkpoint and
     * dropped everything since — a backup that restores, unlocks, passes every
     * integrity check, and is missing the most recent work. TRUNCATE folds the
     * log in and empties it, so the single file is complete on its own.
     */
    if (Vault.isUnlocked()) {
      Vault.connection().pragma('wal_checkpoint(TRUNCATE)');
    }

    const archive: Archive = {
      magic: MAGIC,
      version: 1,
      createdAt,
      database: readFileSync(source.dbPath).toString('base64'),
      meta: readFileSync(source.metaPath, 'utf8'),
    };
    return Promise.resolve(Ok(new Uint8Array(Buffer.from(JSON.stringify(archive), 'utf8'))));
  },

  async backup(destination: string, createdAt = new Date().toISOString()): Promise<Result<string>> {
    const bytes = await Backup.archive(createdAt);
    if (!bytes.ok) return bytes;

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes.value, { mode: 0o600 });
    return Ok(destination);
  },

  /**
   * Writes an archive into `destination` as a vault directory.
   *
   * Both files land or neither does: the database is written first and the meta
   * second, and a failure between them would leave a database with the WRONG
   * salt beside it — unopenable, and indistinguishable from a corrupted backup.
   * So the meta is validated before either write.
   */
  restoreBytes(bytes: Uint8Array, destination: string, fileName = 'vault.db'): Promise<Result<void>> {
    const archive = parseArchive(bytes);
    if (!archive.ok) return Promise.resolve(archive);

    try {
      JSON.parse(archive.value.meta);
    } catch {
      return Promise.resolve(
        Err(new VaultStateError('this backup archive carries unreadable key metadata')),
      );
    }

    mkdirSync(destination, { recursive: true });
    const dbPath = join(destination, fileName);
    writeFileSync(dbPath, Buffer.from(archive.value.database, 'base64'), { mode: 0o600 });
    writeFileSync(`${dbPath}${META_SUFFIX}`, archive.value.meta, { mode: 0o600 });
    /*
     * A WAL sidecar from the vault being replaced would be replayed over the
     * restored database on the next open, reinstating the very rows the restore
     * was meant to roll back.
     */
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(sidecar)) writeFileSync(sidecar, Buffer.alloc(0));
    }
    return Promise.resolve(Ok(undefined));
  },

  restore(source: string, destination: string, fileName = 'vault.db'): Promise<Result<void>> {
    if (!existsSync(source)) {
      return Promise.resolve(Err(new VaultStateError('backup archive was not found')));
    }
    return Backup.restoreBytes(new Uint8Array(readFileSync(source)), destination, fileName);
  },

  /** Copies a vault directory verbatim; used by the container upgrade path. */
  copyVault(fromDir: string, toDir: string): void {
    mkdirSync(toDir, { recursive: true });
    copyFileSync(join(fromDir, 'vault.db'), join(toDir, 'vault.db'));
    copyFileSync(join(fromDir, `vault.db${META_SUFFIX}`), join(toDir, `vault.db${META_SUFFIX}`));
  },
};
