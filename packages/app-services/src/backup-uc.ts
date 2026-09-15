/**
 * Backup and restore, as use cases (Phase 7).
 *
 * `Backup` has been correct and complete since US-8.8 and had no caller — the
 * same defect class as the `prices` and `fx` ports: built, tested, unreachable.
 * A vault with no reachable backup path is one disk failure from zero, which is
 * why this is the half of Phase 7 worth pulling forward.
 *
 * ## Restore is the most destructive operation in the application
 *
 * Everything else here edits one record. This replaces the entire vault, and the
 * thing it replaces is usually the only copy. Three rules follow:
 *
 *  1. **Restoring over an existing vault needs edit mode.** Restoring into a
 *     directory with no vault does not — that is the disaster-recovery path, on
 *     a fresh install where edit mode cannot be turned on because there is no
 *     passphrase to verify against yet, and where there is nothing to lose.
 *  2. **The vault being replaced is copied aside first**, under a timestamped
 *     name. A restore from the wrong archive is otherwise unrecoverable.
 *  3. **The restored vault is left LOCKED.** It opens with the passphrase that
 *     was in force when the backup was taken, which is not necessarily the one
 *     in force now, and silently re-unlocking would either fail confusingly or
 *     succeed against the wrong key.
 */
import { EditModeRequiredError, Err, Ok, VaultStateError, type Result } from '@porttrack/shared-kernel';
import { copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Backup, Vault } from '@porttrack/persistence';
import { currentPorts } from './context.js';
import { requireEditMode } from './edit-mode.js';
import { VaultUC } from './use-cases.js';

export interface BackupArchive {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly createdAt: string;
}

export interface RestoreReport {
  readonly restoredInto: string;
  /** Where the vault this replaced was copied, or absent if there was none. */
  readonly supersededCopy?: string;
  readonly replacedExistingVault: boolean;
}

/** `portTrack-backup-2026-09-15T101530Z.ptb` — sorts chronologically in a folder. */
function fileNameFor(createdAt: string): string {
  return `portTrack-backup-${createdAt.replace(/[-:]/g, '').replace(/\.\d+/, '')}.ptb`;
}

export const BackupUC = {
  /**
   * The whole vault as bytes the browser downloads.
   *
   * Requires an unlocked vault. The archive is encrypted either way, so this is
   * not about protecting the contents — it is that a backup of a vault whose
   * passphrase nobody currently holds is a file that cannot be verified, and
   * offering one invites a user to trust it.
   */
  async create(): Promise<Result<BackupArchive>> {
    if (!Vault.isUnlocked()) {
      return Err(new VaultStateError('unlock the vault before taking a backup'));
    }

    const createdAt = currentPorts().clock.now();
    const bytes = await Backup.archive(createdAt);
    if (!bytes.ok) return bytes;

    currentPorts().logger.info('vault backup taken');
    return Ok({ fileName: fileNameFor(createdAt), bytes: bytes.value, createdAt });
  },

  async restore(bytes: Uint8Array): Promise<Result<RestoreReport>> {
    const paths = Vault.currentPaths();
    if (paths === undefined) {
      return Err(new VaultStateError('no vault directory is open to restore into'));
    }

    // `Vault.open` builds dbPath as join(dataDir, fileName), so splitting it
    // back recovers exactly the config needed to re-open the same vault.
    const dataDir = dirname(paths.dbPath);
    const fileName = basename(paths.dbPath);
    const replacing = existsSync(paths.dbPath);

    if (replacing) {
      const guard = requireEditMode('restoring a backup over the vault already in this directory');
      if (!guard.ok) return guard;
      if (!Vault.isUnlocked()) {
        // Unreachable through edit mode, which requires an unlock — stated so a
        // future caller cannot reach the destructive path by another door.
        return Err(
          new EditModeRequiredError('unlock the vault before restoring over the one already here'),
        );
      }
    }

    /*
     * Closed BEFORE anything is written. SQLite holds the database open with a
     * WAL sidecar; overwriting the file underneath a live handle corrupts both
     * the new contents and whatever the handle still believes it has.
     */
    await VaultUC.lock();

    let supersededCopy: string | undefined;
    if (replacing) {
      const stamp = currentPorts().clock.now().replace(/[-:]/g, '').replace(/\.\d+/, '');
      supersededCopy = join(dataDir, `${fileName}.superseded-${stamp}`);
      copyFileSync(paths.dbPath, supersededCopy);
      if (existsSync(paths.metaPath)) copyFileSync(paths.metaPath, `${supersededCopy}.meta.json`);
    }

    const restored = await Backup.restoreBytes(bytes, dataDir, fileName);
    if (!restored.ok) {
      // Nothing was written — `restoreBytes` validates the archive before it
      // touches the directory — so re-opening returns the vault untouched.
      await Vault.open({ dataDir, fileName });
      return restored;
    }

    const reopened = await Vault.open({ dataDir, fileName });
    if (!reopened.ok) return reopened;

    currentPorts().logger.info('vault restored from backup');
    return Ok({
      restoredInto: dataDir,
      replacedExistingVault: replacing,
      ...(supersededCopy === undefined ? {} : { supersededCopy }),
    });
  },
};
