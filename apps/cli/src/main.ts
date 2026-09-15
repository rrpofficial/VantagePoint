/**
 * Headless CLI (US-8.6, PRD §4.3).
 *
 * Shares `app-services` with the API and holds no logic of its own. It exists so
 * a snapshot, an import or an advance tax figure can be produced from a cron job
 * or a script without a browser — which matters for a compliance tool whose
 * statutory snapshots must happen whether or not anyone opens the UI.
 *
 * Failures print machine-readable JSON on stderr so a wrapper script can branch
 * on the code rather than parse prose.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputeAdvanceTaxUC,
  GenerateSnapshotUC,
  ImportStatementUC,
  VaultUC,
  hasIncomeProfile,
} from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { MaskingPipeline } from '@vantagepoint/pii-masker';

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  /** Machine-readable `{ code, message }` JSON on failure. */
  readonly stderr: string;
}

const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (code: string, message: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  // Masked before it is printed: a parser error can quote a source row, and a
  // source row can contain a name or a folio.
  stderr: JSON.stringify({ code, message: MaskingPipeline.maskText(message) }),
});

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ensureVault(): Promise<void> {
  if (Vault.isUnlocked()) return;
  const dataDir = process.env.VANTAGEPOINT_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'vantagepoint-cli-'));
  await Vault.open({ dataDir, fileName: 'vault.db' });
  const passphrase = process.env.VANTAGEPOINT_PASSPHRASE ?? 'correct horse battery staple';
  await VaultUC.unlock(passphrase);
}

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const [command, subcommand] = argv;

  try {
    switch (command) {
      case 'import': {
        const file = flag(argv, 'file');
        const parser = (flag(argv, 'parser') ?? 'template').toUpperCase();
        if (file === undefined) return fail('MISSING_ARGUMENT', '--file is required');

        await ensureVault();
        const result = await ImportStatementUC.execute({
          file: new Uint8Array(readFileSync(file)),
          fileName: file,
          parser: parser === 'ZERODHA' ? 'ZERODHA_TRADEBOOK' : (parser as 'TEMPLATE'),
          mode: 'LENIENT',
        });
        return result.ok
          ? ok(JSON.stringify({ created: result.value.created, rejected: result.value.rejected }))
          : fail(result.error.code, result.error.message);
      }

      case 'snapshot': {
        const asOf = flag(argv, 'as-of');
        if (asOf === undefined || !ISO_DATE.test(asOf)) {
          return fail('INVALID_DATE', `--as-of must be YYYY-MM-DD, received "${asOf ?? ''}"`);
        }
        await ensureVault();
        const result = await GenerateSnapshotUC.custom(asOf);
        return result.ok
          ? ok(JSON.stringify({ snapshotId: result.value.snapshotId, hash: result.value.contentHash }))
          : fail(result.error.code, result.error.message);
      }

      case 'tax': {
        if (subcommand !== 'advance') {
          return fail('UNKNOWN_COMMAND', `unknown tax subcommand "${subcommand ?? ''}"`);
        }
        await ensureVault();
        const result = await ComputeAdvanceTaxUC.execute({
          financialYear: flag(argv, 'fy') ?? '2025-26',
          quarter: (flag(argv, 'quarter') ?? 'Q1') as 'Q1' | 'Q2' | 'Q3' | 'Q4',
        });
        return result.ok
          ? ok(
              JSON.stringify({
                quarter: result.value.quarter,
                netPayable: result.value.netPayable,
                // Without this a forgotten Form 16 reads as "nothing to pay".
                incomeRecorded: hasIncomeProfile(),
              }),
            )
          : fail(result.error.code, result.error.message);
      }

      default:
        return fail('UNKNOWN_COMMAND', `unknown command "${command ?? ''}"`);
    }
  } catch (cause) {
    return fail('UNEXPECTED', cause instanceof Error ? cause.message : 'unexpected failure');
  }
}
