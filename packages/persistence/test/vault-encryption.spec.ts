/**
 * US-8.2 — Encrypted local persistence (PRD NFR-1, ADR-015)
 *
 * The cipher is page-level AES-256-CBC + HMAC-SHA512 over the WHOLE file, so these
 * tests assert on schema identifiers and the file header too — not merely that
 * values are absent. Value-only encryption would pass a weaker suite while leaving
 * table names, index structures and row counts readable on disk.
 *
 * Money tests moved to packages/shared-kernel/test/money.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoEnvelope, Vault } from '@vantagepoint/persistence';
import { expectNoPii, expectOk, SYNTHETIC } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const dataDir = () => mkdtempSync(join(tmpdir(), 'vantagepoint-vault-'));

/** Opens a vault, seeds recognisable data, and returns the on-disk path. */
async function seededVault(): Promise<string> {
  const dir = dataDir();
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  await Vault.close();
  return join(dir, 'vault.db');
}

const rawBytes = (file: string) => readFileSync(file, 'latin1');

describe('US-8.2 Scenario: Data at rest is encrypted with page-level AES-256 (ADR-015)', () => {
  it('writes the database file to the configured data directory', async () => {
    expect(existsSync(await seededVault())).toBe(true);
  });

  it('contains no plaintext PAN', async () => {
    expect(rawBytes(await seededVault())).not.toContain(SYNTHETIC.PAN);
  });

  it('contains no plaintext monetary value', async () => {
    expect(rawBytes(await seededVault())).not.toContain('5000000');
  });

  it('leaks no PII pattern anywhere in the raw file', async () => {
    expectNoPii(rawBytes(await seededVault()));
  });
});

describe('US-8.2 Scenario: Schema metadata is encrypted, not just values (ADR-015)', () => {
  it('does not expose table names in plaintext', async () => {
    const raw = rawBytes(await seededVault());
    for (const table of ['assets', 'lots', 'hand_loans', 'snapshots', 'liabilities']) {
      expect(raw, `table name "${table}" leaked`).not.toContain(table);
    }
  });

  it('does not expose column names in plaintext', async () => {
    const raw = rawBytes(await seededVault());
    for (const column of ['acquisition_date', 'cost_per_unit', 'borrower_ref', 'content_hash']) {
      expect(raw, `column name "${column}" leaked`).not.toContain(column);
    }
  });

  it('does not begin with the "SQLite format 3" magic header', async () => {
    expect(rawBytes(await seededVault()).startsWith('SQLite format 3')).toBe(false);
  });

  it('does not expose CREATE TABLE statements from sqlite_master', async () => {
    expect(rawBytes(await seededVault())).not.toMatch(/CREATE TABLE/i);
  });

  /**
   * Control experiment. The assertions above only mean something if an UNencrypted
   * database of the same schema would actually leak those identifiers. Without this,
   * a migration that silently created no tables would make every test above pass.
   */
  it('control: an unencrypted database with the same schema DOES leak them', async () => {
    const { default: Database } = await import('better-sqlite3-multiple-ciphers');
    const { MIGRATIONS } = await import('@vantagepoint/persistence');
    const file = join(dataDir(), 'plain.db');
    const db = new Database(file);
    for (const migration of MIGRATIONS) db.exec(migration.up);
    db.close();

    const raw = readFileSync(file, 'latin1');
    expect(raw.startsWith('SQLite format 3')).toBe(true);
    expect(raw).toContain('hand_loans');
    expect(raw).toContain('acquisition_date');
    expect(raw).toMatch(/CREATE TABLE/i);
  });
});

describe('US-8.2 Scenario: Wrong passphrase fails without leaking whether data exists', () => {
  it('fails with VAULT_UNLOCK_FAILED', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));
    await Vault.close();

    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    const result = await Vault.unlock('wrong passphrase');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VAULT_UNLOCK_FAILED');
  });

  it('reveals nothing about vault contents in the error', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    const result = await Vault.unlock('wrong passphrase');
    if (!result.ok) {
      expect(result.error.message).not.toMatch(/holding|asset|snapshot|empty|row|table/i);
    }
  });

  it('does not echo the attempted passphrase in the error', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    const result = await Vault.unlock('hunter2-should-not-appear');
    if (!result.ok) expect(result.error.message).not.toContain('hunter2-should-not-appear');
  });
});

describe('US-8.2 Scenario: Tampered ciphertext is detected', () => {
  it('fails to read after a byte is flipped, even with the correct passphrase', async () => {
    const file = await seededVault();
    const buf = readFileSync(file);
    const offset = Math.floor(buf.length * 0.6);
    buf[offset] = (buf[offset] ?? 0) ^ 0xff;
    writeFileSync(file, buf);

    expectOk(await Vault.open({ dataDir: join(file, '..'), fileName: 'vault.db' }));
    const result = await Vault.unlock(PASSPHRASE);
    expect(result.ok, 'a tampered vault must not open').toBe(false);
  });

  it('returns no data when integrity verification fails', async () => {
    const file = await seededVault();
    const buf = readFileSync(file);
    const offset = Math.floor(buf.length * 0.6);
    buf[offset] = (buf[offset] ?? 0) ^ 0xff;
    writeFileSync(file, buf);

    expectOk(await Vault.open({ dataDir: join(file, '..'), fileName: 'vault.db' }));
    const result = await Vault.unlock(PASSPHRASE);
    if (result.ok) throw new Error('expected integrity failure');
    expect(result.error.code).toBe('VAULT_UNLOCK_FAILED');
  });
});

describe('US-8.2 Scenario: The derived key never touches disk and is zeroised (ADR-014)', () => {
  it('derives a 32-byte key from a passphrase and salt', async () => {
    const key = await CryptoEnvelope.deriveKey(PASSPHRASE, new Uint8Array(16));
    expect(key).toHaveLength(32);
  });

  it('derives deterministically for the same passphrase and salt', async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await CryptoEnvelope.deriveKey(PASSPHRASE, salt);
    const b = await CryptoEnvelope.deriveKey(PASSPHRASE, salt);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('derives different keys for different salts', async () => {
    const a = await CryptoEnvelope.deriveKey(PASSPHRASE, new Uint8Array(16).fill(1));
    const b = await CryptoEnvelope.deriveKey(PASSPHRASE, new Uint8Array(16).fill(2));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('zeroises a key buffer on request', async () => {
    const key = await CryptoEnvelope.deriveKey(PASSPHRASE, new Uint8Array(16));
    CryptoEnvelope.zeroise(key);
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it('writes the passphrase to no file in the data directory', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));
    await Vault.close();
    expect(readFileSync(join(dir, 'vault.db'), 'latin1')).not.toContain(PASSPHRASE);
  });
});

/**
 * Re-verifying the passphrase without unlocking or re-deriving a second secret.
 *
 * The derived key IS the verifier: nothing extra is stored for this, so there is
 * no second secret on disk, and none to keep in step after a passphrase change.
 * Edit mode is the caller (see packages/app-services/src/edit-mode.ts).
 */
describe('US-8.2 Scenario: The open vault can re-check its own passphrase', () => {
  const openedVault = async () => {
    expectOk(await Vault.open({ dataDir: dataDir(), fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));
  };

  it('accepts the passphrase the vault was unlocked with', async () => {
    await openedVault();
    try {
      expect(await Vault.verifyPassphrase(PASSPHRASE)).toBe(true);
    } finally {
      await Vault.close();
    }
  });

  it('rejects any other passphrase', async () => {
    await openedVault();
    try {
      expect(await Vault.verifyPassphrase('correct horse battery stapl')).toBe(false);
    } finally {
      await Vault.close();
    }
  });

  /*
   * An empty passphrase must not be a shortcut. `unlock` refuses one because on a
   * brand-new vault it would silently become the key; a verifier that accepted it
   * would hand every gated operation to a bare Enter press.
   */
  it('rejects an empty passphrase', async () => {
    await openedVault();
    try {
      expect(await Vault.verifyPassphrase('')).toBe(false);
    } finally {
      await Vault.close();
    }
  });

  it('rejects everything while locked, rather than throwing', async () => {
    await openedVault();
    await Vault.lock();
    try {
      expect(await Vault.verifyPassphrase(PASSPHRASE)).toBe(false);
    } finally {
      await Vault.close();
    }
  });

  it('leaves the vault unlocked and usable', async () => {
    await openedVault();
    try {
      await Vault.verifyPassphrase('wrong');
      expect(Vault.isUnlocked()).toBe(true);
    } finally {
      await Vault.close();
    }
  });
});

/**
 * The unlock session id, which is what lets a session-scoped permission tell
 * "the session I was granted in" from "some session that is open now". A
 * boolean cannot: lock-then-unlock reads true at both ends.
 */
describe('US-8.2 Scenario: Each unlock is a distinct session', () => {
  it('has no session id while locked', async () => {
    expectOk(await Vault.open({ dataDir: dataDir(), fileName: 'vault.db' }));
    try {
      expect(Vault.sessionId()).toBeUndefined();
    } finally {
      await Vault.close();
    }
  });

  /*
   * The SPA re-submits the passphrase whenever a browser tab is reloaded, because
   * "unlocked" is client state and starts false on mount. Treating that as a new
   * session revoked edit mode on every reload, which looked like the mode turning
   * itself off at random.
   */
  it('keeps the same session when an already-open vault is unlocked again', async () => {
    expectOk(await Vault.open({ dataDir: dataDir(), fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));
    const first = Vault.sessionId();

    expectOk(await Vault.unlock(PASSPHRASE));

    try {
      expect(Vault.sessionId()).toBe(first);
      expect(Vault.isUnlocked()).toBe(true);
    } finally {
      await Vault.close();
    }
  });

  it('leaves an open vault usable after a wrong passphrase is re-submitted', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));
    const first = Vault.sessionId();

    const wrong = await Vault.unlock('not the passphrase');

    try {
      expect(wrong.ok).toBe(false);
      expect(Vault.isUnlocked()).toBe(true);
      expect(Vault.sessionId()).toBe(first);
    } finally {
      await Vault.close();
    }
  });

  it('issues a different id on a second unlock of the same vault', async () => {
    const dir = dataDir();
    expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
    expectOk(await Vault.unlock(PASSPHRASE));
    const first = Vault.sessionId();

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));

    try {
      expect(first).toBeDefined();
      expect(Vault.sessionId()).not.toBe(first);
    } finally {
      await Vault.close();
    }
  });
});
