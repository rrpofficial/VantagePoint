/**
 * The encrypted vault (US-8.2, ADR-012, ADR-015).
 *
 * Page-level AES-256-CBC + HMAC-SHA512 over the whole database file, so schema
 * identifiers and index structures are encrypted alongside the values.
 *
 * Two behaviours here are load-bearing and easy to get wrong:
 *
 *  1. Opening a tampered database SUCCEEDS. A byte flipped deep in the file is not
 *     detected by reading `sqlite_schema` — it is only caught by a check that walks
 *     every page. `unlock` therefore runs `quick_check`, and a vault that fails it
 *     is refused. Without this, silent corruption reads back as valid data.
 *  2. The KDF salt is stored in plaintext beside the database. That is by design —
 *     a salt is not secret — but it means the salt file must travel with the vault,
 *     so backup and restore cover both.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Err,
  Ok,
  VaultStateError,
  VaultUnlockError,
  type Result,
} from '@porttrack/shared-kernel';
import {
  KDF_PARAMS,
  deriveKeyAsync,
  newSalt,
  toHex,
  zeroise,
  type KdfParams,
} from './crypto.js';
import { currentVersion, runMigrations } from './migrations.js';

/** SQLite3MultipleCiphers scheme name for AES-256-CBC + HMAC-SHA512. */
const CIPHER_SCHEME = 'sqlcipher';
const META_FILE_SUFFIX = '.meta.json';

export interface VaultConfig {
  /** In-container path backed by the host bind mount (ADR-012). */
  readonly dataDir: string;
  readonly fileName: string;
}

export interface VaultHandle {
  readonly schemaVersion: number;
  readonly locked: boolean;
}

interface VaultMeta {
  readonly version: 1;
  readonly cipher: string;
  readonly kdf: 'argon2id';
  readonly saltHex: string;
  readonly params: KdfParams;
}

interface OpenState {
  config: VaultConfig;
  dbPath: string;
  metaPath: string;
  meta: VaultMeta;
  db?: Database.Database | undefined;
  key?: Uint8Array | undefined;
  sessionId?: number | undefined;
}

let state: OpenState | undefined;

/**
 * Incremented on every successful unlock, never reused.
 *
 * Lets anything holding session-scoped permission — edit mode, today — tell "the
 * session I was granted in" from "a session that happens to be open now". A
 * boolean cannot: lock-then-unlock leaves `isUnlocked()` reading true again, and
 * a permission checked against that alone would silently survive into a session
 * that never authorised it.
 */
let sessions = 0;

function readOrCreateMeta(metaPath: string): VaultMeta {
  if (existsSync(metaPath)) {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as VaultMeta;
  }
  const meta: VaultMeta = {
    version: 1,
    cipher: CIPHER_SCHEME,
    kdf: 'argon2id',
    saltHex: toHex(newSalt()),
    params: KDF_PARAMS,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

export const Vault = {
  open(config: VaultConfig): Promise<Result<VaultHandle>> {
    mkdirSync(config.dataDir, { recursive: true });
    const dbPath = join(config.dataDir, config.fileName);

    // Re-opening the same vault is a no-op. Resetting state here would lock an
    // already-unlocked session merely because another handle was constructed.
    if (state?.dbPath === dbPath && state.db !== undefined) {
      return Promise.resolve(Ok({ schemaVersion: 1, locked: false }));
    }

    const metaPath = `${dbPath}${META_FILE_SUFFIX}`;
    state = { config, dbPath, metaPath, meta: readOrCreateMeta(metaPath) };
    return Promise.resolve(Ok({ schemaVersion: 0, locked: true }));
  },

  async unlock(passphrase: string): Promise<Result<VaultHandle>> {
    if (!state) {
      return Err(new VaultStateError('vault is not open'));
    }
    const current = state;

    /*
     * An empty passphrase is refused outright. On a BRAND-NEW vault there is no
     * stored key to check against, so the first unlock silently becomes the one
     * that sets it — meaning an empty string would quietly create a vault that
     * anyone can open, and it would look like a successful unlock.
     */
    if (passphrase.length === 0) {
      return Err(new VaultUnlockError('a vault passphrase is required and cannot be empty'));
    }

    /*
     * Derived on a worker thread. Argon2id at the OWASP baseline occupies a core
     * for ~350 ms, and doing that on the main thread froze the entire API for the
     * duration — health probes included — so concurrent unlocks serialized and
     * the UI looked hung. See crypto.ts.
     */
    const key = await deriveKeyAsync(
      passphrase,
      Buffer.from(current.meta.saltHex, 'hex'),
      current.meta.params,
    );
    let db: Database.Database | undefined;

    try {
      db = new Database(current.dbPath);
      db.pragma(`cipher='${current.meta.cipher}'`);
      db.pragma(`hexkey='${toHex(key)}'`);

      // Walks every page. A wrong key fails here; so does a tampered file, which a
      // schema read alone would not catch.
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') {
        throw new Error(`integrity check returned ${String(check)}`);
      }

      /*
       * Re-unlocking a vault that is already open is a no-op, not a new session.
       *
       * The passphrase was right — `quick_check` above proved it against the
       * real cipher — but nothing has changed: the same database, opened by the
       * same person, who never locked it. The SPA re-submits exactly this way
       * whenever a browser tab is reloaded, because "unlocked" is client state
       * and starts false on mount. Issuing a new session id here revoked edit
       * mode on every reload, which looked like the mode randomly turning itself
       * off. Replacing the handle also leaked the previous one.
       */
      const alreadyOpen = current.db;
      if (alreadyOpen !== undefined) {
        db.close();
        zeroise(key);
        return Ok({ schemaVersion: currentVersion(alreadyOpen), locked: false });
      }

      db.pragma('journal_mode=WAL');
      db.pragma('synchronous=FULL');
      db.pragma('foreign_keys=ON');

      const schemaVersion = runMigrations(db, new Date().toISOString());

      current.db = db;
      current.key = key;
      current.sessionId = ++sessions;
      return Ok({ schemaVersion, locked: false });
    } catch {
      db?.close();
      zeroise(key);
      // Deliberately uninformative: the message must not reveal whether the vault
      // holds data, nor echo the attempted passphrase.
      return Err(new VaultUnlockError('unable to unlock vault: wrong passphrase or corrupted data'));
    }
  },

  /**
   * Is this the passphrase the open vault was unlocked with?
   *
   * Re-derives with the SAME salt and parameters and compares against the key
   * already in memory. Nothing is stored to support this and nothing new is
   * written: the derived key is itself the only verifier the vault has, so a
   * separate passphrase hash — which would be a second secret on disk, and a
   * second thing to keep in step after a passphrase change — is not needed.
   *
   * Costs a full Argon2id derivation, which is the point: this exists to gate a
   * deliberate action, and a cheap check would be a cheap thing to guess at.
   */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const current = state;
    const key = current?.key;
    // A locked vault has no key to compare against. Answering "no" rather than
    // throwing keeps the caller's failure path single: both mean "refused".
    if (current === undefined || key === undefined || passphrase.length === 0) return false;

    const candidate = await deriveKeyAsync(
      passphrase,
      Buffer.from(current.meta.saltHex, 'hex'),
      current.meta.params,
    );
    try {
      // Constant-time. A byte-by-byte comparison leaks how much of a guess was
      // right through its timing, which is exactly what makes guessing cheap.
      return candidate.length === key.length && timingSafeEqual(candidate, key);
    } finally {
      zeroise(candidate);
    }
  },

  /**
   * Identifies the current unlock session, or undefined while locked. A caller
   * holding a permission granted in one session compares this to decide whether
   * it is still the same one.
   */
  sessionId(): number | undefined {
    return state?.db === undefined ? undefined : state.sessionId;
  },

  lock(): Promise<void> {
    if (!state) return Promise.resolve();
    state.db?.close();
    state.db = undefined;
    state.sessionId = undefined;
    if (state.key) {
      zeroise(state.key);
      state.key = undefined;
    }
    return Promise.resolve();
  },

  async close(): Promise<void> {
    await Vault.lock();
    state = undefined;
  },

  /** Throws unless the vault is unlocked. Repositories depend on this. */
  connection(): Database.Database {
    if (!state?.db) throw new VaultStateError('vault is locked');
    return state.db;
  },

  isUnlocked(): boolean {
    return Boolean(state?.db);
  },

  /** Paths of the open vault, so backup can archive the salt alongside it. */
  currentPaths(): { dbPath: string; metaPath: string } | undefined {
    return state === undefined ? undefined : { dbPath: state.dbPath, metaPath: state.metaPath };
  },
};
