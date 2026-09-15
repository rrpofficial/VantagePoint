/**
 * Getting the data OUT (Phase 7, §7.2).
 *
 * Hand loans already exported both formats and nothing else exported either.
 * This adds chits, holdings, property and balances through one surface, so the
 * CSV quoting and the PDF layout have a single owner.
 *
 * ## An export is not a backup
 *
 * Easy to conflate and important not to. An export is a *lossy, human-facing*
 * extract of one register — for a CA, a bank, a family member, a spreadsheet. A
 * CSV of holdings cannot reconstruct a vault: it has no provenance, no rates and
 * no disposal history. `BackupUC` is the other thing, and it is labelled as such.
 *
 * ## Two gates
 *
 *  - **PII (ADR-013).** `includePii` is off unless the caller asks, and the file
 *    states which way it was made. A recipient must be able to tell a masked
 *    extract from a full one without being told.
 *  - **Provisional rates.** A disposals table carries a taxable gain and an
 *    assessment year, which is what a filing artifact looks like. It therefore
 *    inherits `assertFilingReady`, and a PROVISIONAL year refuses rather than
 *    producing a document that reads as filed-from.
 */
import {
  Err,
  FyCalendar,
  Ok,
  VaultStateError,
  type FinancialYear,
  type Result,
} from '@porttrack/shared-kernel';
import { ChitLedger, balanceViewOf, type Asset, type BalanceView } from '@porttrack/core-domain';
import { TaxRuleTable } from '@porttrack/tax-engine';
import {
  balanceTable,
  chitTable,
  holdingTables,
  propertyTables,
  toCsv,
  toMultiCsv,
  toPdf,
  type ExportOptions,
  type ExportTable,
} from '@porttrack/exporters';
import {
  AssetRepository,
  ChitScheduleRepository,
  ExitRepository,
  Vault,
} from '@porttrack/persistence';
import { currentPorts } from './context.js';

export type ExportRegister = 'chits' | 'holdings' | 'property' | 'balances';

export interface ExportRequest {
  readonly register: ExportRegister;
  readonly format: 'csv' | 'pdf';
  /** Off unless explicitly asked for. See the PII note in the module comment. */
  readonly includePii?: boolean;
  /** Holdings only: adds the disposals table for that year, and gates on it. */
  readonly financialYear?: FinancialYear;
  readonly filterNote?: string;
}

export interface ExportedFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const requireUnlocked = (): Result<void> =>
  Vault.isUnlocked() ? Ok(undefined) : Err(new VaultStateError('vault is locked'));

const CONTENT_TYPE = {
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
} as const;

async function tablesFor(
  request: ExportRequest,
  options: ExportOptions,
): Promise<Result<readonly ExportTable[]>> {
  const assets = await AssetRepository.all();

  switch (request.register) {
    case 'chits': {
      const chits = assets.flatMap((asset) => (asset.chitFund === undefined ? [] : [asset.chitFund]));
      // The agreed withdrawal column comes from the schedules; without them a
      // chit that HAS one would export a blank, which reads as "not agreed".
      const schedules = await ChitScheduleRepository.all();
      const register = ChitLedger.register({
        chits,
        asOf: currentPorts().clock.today(),
        schedules,
      });
      return Ok([chitTable(register.chits, register.totals, options)]);
    }

    case 'balances': {
      const today = currentPorts().clock.today();
      const views: BalanceView[] = assets.flatMap((asset) =>
        asset.balanceAccount === undefined ? [] : [balanceViewOf(asset.balanceAccount, today)],
      );
      return Ok([balanceTable(views, options)]);
    }

    case 'property': {
      const property = assets.filter((asset) => asset.assetClass === 'REAL_ESTATE');
      return Ok(propertyTables(property, options));
    }

    default: {
      const tradeable = assets.filter(
        (asset: Asset) => asset.assetClass !== 'REAL_ESTATE' && asset.lots.length > 0,
      );

      if (request.financialYear === undefined) {
        // No year, no disposals, and the file says so rather than implying the
        // holder sold nothing.
        return Ok(
          holdingTables(tradeable, [], {
            ...options,
            financialYearNote:
              'No financial year was selected, so no disposals are listed. This is not a statement that none occurred.',
          }),
        );
      }

      /*
       * A disposals table states a taxable gain against an assessment year,
       * which is what a filing artifact looks like. It inherits the gate.
       */
      const rules = TaxRuleTable.rulesFor(request.financialYear);
      if (!rules.ok) return rules;
      const ready = TaxRuleTable.assertFilingReady(rules.value);
      if (!ready.ok) return ready;

      const from = FyCalendar.fyStart(request.financialYear);
      const to = FyCalendar.fyEnd(request.financialYear);
      const exits = (await ExitRepository.all()).filter(
        (exit) => exit.exitDate >= from && exit.exitDate <= to,
      );

      return Ok(
        holdingTables(tradeable, exits, {
          ...options,
          financialYearNote: `Disposals for FY ${request.financialYear} (${from} to ${to}), for assessment year ${FyCalendar.assessmentYearOf(request.financialYear)}.`,
        }),
      );
    }
  }
}

export const ExportUC = {
  async execute(request: ExportRequest): Promise<Result<ExportedFile>> {
    const guard = requireUnlocked();
    if (!guard.ok) return guard;

    const generatedOn = currentPorts().clock.now();
    const options: ExportOptions = {
      includePii: request.includePii === true,
      generatedOn,
      ...(request.filterNote === undefined ? {} : { filterNote: request.filterNote }),
    };

    const tables = await tablesFor(request, options);
    if (!tables.ok) return tables;

    const stamp = generatedOn.slice(0, 10);
    const suffix = options.includePii ? '' : '-masked';
    const fileName = `portTrack-${request.register}${suffix}-${stamp}.${request.format}`;

    const bytes =
      request.format === 'csv'
        ? new Uint8Array(Buffer.from(toMultiCsv(tables.value), 'utf8'))
        : toPdf(tables.value, generatedOn);

    currentPorts().logger.info(`${request.register} exported`);
    return Ok({ fileName, contentType: CONTENT_TYPE[request.format], bytes });
  },

  /** Exposed for a caller that wants one table's CSV without the file wrapper. */
  csvOf: (table: ExportTable): string => toCsv(table),
};
