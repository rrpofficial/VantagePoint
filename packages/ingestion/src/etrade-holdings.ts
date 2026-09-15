/**
 * E*TRADE "By Status → Sellable" — open stock-plan positions (US-4.5d).
 *
 * The other half of the picture. A Gains & Losses export describes tranches that
 * CLOSED; this describes the ones still held. Neither is complete alone, and the
 * gap is exactly the case that prompted it: a portfolio showing 100 shares today
 * says nothing about the 50 sold earlier in the year.
 *
 * ## The two quantities, and why both matter
 *
 * Each row states `Purchased Qty.` — the size of the tranche when it vested —
 * and `Sellable Qty.`, what is left of it now. A vest of 16 with 10 sellable
 * means 6 were sold, and those 6 are rows in the G&L export.
 *
 * The lot is therefore created at its FULL size, and the disposals deplete it.
 * Recording it at the sellable figure instead would count the tranche twice: once
 * shrunk, and once again through the disposals that shrank it.
 *
 * `Sellable Qty.` is carried through as the source's own claim about what
 * remains, so the projection can compare it against what the ledger computes.
 * When the two disagree the difference is disposal history that has not been
 * imported — which is the one thing a user cannot otherwise discover.
 *
 * ## Identity, not row position
 *
 * Rows carry `Grant Number` and `Vest Date`, the same keys the G&L export uses,
 * so a tranche appearing in both resolves to ONE lot rather than two. That is the
 * whole reason lot identity moved off the file name and row number.
 *
 * ## Duplicate column names
 *
 * The sheet flattens a master-detail layout into one wide row, and reuses header
 * names across the two blocks: `Type`, `Class`, `Expected Gain/Loss` and
 * `Tax Status` each appear twice. Every column read here is one of the unique
 * ones — checked, not assumed — so first-match lookup is safe. Anything added
 * later must be re-checked against that.
 */
import {
  Err,
  Money,
  Ok,
  TemplateHeaderMismatchError,
  type Money as MoneyValue,
  type Result,
} from '@porttrack/shared-kernel';
import { Decimal } from 'decimal.js';
import { grantRefOf, type EquityAward } from '@porttrack/core-domain';
import { parseCsv, columnIndex, normaliseDate } from './csv.js';
import { deterministicImportedAt, provenanceFor } from './provenance.js';
import type { ParsedTransaction, RowError } from './types.js';
import type { ParseOutcome } from './brokers.js';

const USD = 'USD' as const;

/**
 * Deliberately a small subset. The export's column set varies with the plan
 * types an account holds, and demanding all 34 would reject a good file from
 * someone who has only ever held RSUs.
 */
const REQUIRED_COLUMNS = [
  'record type',
  'symbol',
  'plan type',
  'date acquired',
  'sellable qty.',
  'grant number',
] as const;

function isBlank(raw: string | undefined): boolean {
  const value = (raw ?? '').trim();
  return value.length === 0 || value === '--';
}

/** `$207.87`, `"$2,594.30 "` and `-$73.70` all read as numbers. */
function parseUsd(raw: string | undefined): MoneyValue | undefined {
  if (isBlank(raw)) return undefined;
  let value = (raw ?? '').trim();
  if (value.startsWith('(') && value.endsWith(')')) value = `-${value.slice(1, -1)}`;
  const parsed = Money.parse(value, USD);
  return parsed.ok ? parsed.value : undefined;
}

function parseQuantity(raw: string | undefined): Decimal | undefined {
  if (isBlank(raw)) return undefined;
  try {
    const value = new Decimal((raw ?? '').replace(/,/g, '').trim());
    return value.isFinite() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The plan type as this export words it, which is not how the G&L words it.
 *
 * `Rest. Stock` here is `RS` there. Mapped explicitly rather than by substring,
 * so an unrecognised plan is REFUSED — filing an ESPP lot as an RSU would apply
 * the wrong perquisite and the wrong cost basis.
 */
function planOf(planType: string): { assetClass: 'RSU' | 'ESPP'; kind: 'RSU_VEST' | 'ESPP_PURCHASE' } | undefined {
  const value = planType.trim().toUpperCase();
  if (value.startsWith('REST') || value === 'RS' || value === 'RSU') {
    return { assetClass: 'RSU', kind: 'RSU_VEST' };
  }
  if (value.includes('ESPP')) return { assetClass: 'ESPP', kind: 'ESPP_PURCHASE' };
  return undefined;
}

export function parseEtradeHoldings(csv: string, fileName: string): Result<ParseOutcome> {
  const table = parseCsv(csv);

  const missing = REQUIRED_COLUMNS.filter((column) => !table.header.includes(column));
  if (missing.length > 0) {
    return Err(
      new TemplateHeaderMismatchError(
        `this does not look like an E*TRADE "By Status — Sellable" export — missing column(s) ${missing.join(', ')}. Export the Sellable tab, not Unvested: unvested shares are not held yet and have no cost basis.`,
        [...missing],
      ),
    );
  }

  const at = (name: string) => columnIndex(table.header, name);
  const cell = (row: { readonly cells: readonly string[] }, name: string): string => {
    const index = at(name);
    return index < 0 ? '' : (row.cells[index] ?? '');
  };

  const importedAt = deterministicImportedAt(fileName);
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];

  for (const row of table.rows) {
    const reject = (column: string, value: string, reason: string, expectedFormat?: string) => {
      errors.push({
        row: row.rowNumber,
        column,
        value,
        reason,
        ...(expectedFormat === undefined ? {} : { expectedFormat }),
      });
    };

    /*
     * The export ends with an `Overall Total` row carrying only a market value.
     * Skipped in silence — reporting it would put a permanent error on every
     * clean import.
     */
    const recordType = cell(row, 'record type').trim().toLowerCase();
    if (recordType.length === 0 || recordType.startsWith('overall')) continue;
    if (recordType !== 'grant') {
      reject('Record Type', cell(row, 'record type'), 'not a holding row', 'Grant');
      continue;
    }

    const symbol = cell(row, 'symbol').trim();
    if (symbol.length === 0) {
      reject('Symbol', '', 'a holding needs the symbol it is held in');
      continue;
    }

    const plan = planOf(cell(row, 'plan type'));
    if (plan === undefined) {
      reject(
        'Plan Type',
        cell(row, 'plan type'),
        'unrecognised plan type — cannot tell an RSU from an ESPP, and they are taxed differently',
        'Rest. Stock | ESPP',
      );
      continue;
    }

    const acquiredOn = normaliseDate(cell(row, 'date acquired'));
    if (acquiredOn === undefined) {
      reject('Date Acquired', cell(row, 'date acquired'), 'not a date', 'DD-MON-YYYY');
      continue;
    }

    const sellable = parseQuantity(cell(row, 'sellable qty.'));
    if (sellable === undefined || sellable.lessThan(0)) {
      reject('Sellable Qty.', cell(row, 'sellable qty.'), 'not a quantity');
      continue;
    }
    /*
     * Nothing left of this tranche. It is not a holding, and its disposals are
     * the G&L export's business — recording a zero-unit lot here would add a
     * position that does not exist.
     */
    if (sellable.isZero()) continue;

    /*
     * The tranche's FULL size, falling back to the sellable figure.
     *
     * `Purchased Qty.` is what vested; `Sellable Qty.` is what is left. The lot
     * is created at the full size so the disposals in the G&L export deplete it
     * to the remainder. Where the column is absent the sellable figure is the
     * best available, and the reconciliation below then simply agrees.
     */
    const purchased = parseQuantity(cell(row, 'purchased qty.'));
    const quantity =
      purchased !== undefined && purchased.greaterThanOrEqualTo(sellable) ? purchased : sellable;

    /*
     * Cost basis per share. `Est. Cost Basis (per share):` is the figure E*TRADE
     * states; `Purchase Date FMV` is the same number for an RSU and the fallback
     * for it. Both are fair market value at acquisition — the §49(2AA) basis,
     * NOT any amount paid.
     */
    const costPerUnit =
      parseUsd(cell(row, 'est. cost basis (per share):')) ??
      parseUsd(cell(row, 'purchase date fmv'));
    if (costPerUnit === undefined) {
      reject(
        'Est. Cost Basis (per share):',
        cell(row, 'est. cost basis (per share):'),
        'a holding needs a cost basis; without one no gain can be computed when it is sold',
      );
      continue;
    }

    const grantDate = normaliseDate(cell(row, 'grant date'));
    const vestDate = normaliseDate(cell(row, 'vest date'));

    const grantRef = grantRefOf({
      ...(isBlank(cell(row, 'grant number'))
        ? {}
        : { grantNumber: cell(row, 'grant number').trim() }),
      ...(grantDate === undefined ? {} : { grantDate }),
    });
    if (grantRef === undefined) {
      reject(
        'Grant Number',
        '',
        'a holding needs a grant reference, or it cannot be matched to the disposals recorded against it',
      );
      continue;
    }

    const award: EquityAward = {
      kind: plan.assetClass,
      grantRef,
      ...(grantDate === undefined ? {} : { grantDate }),
      ...(plan.assetClass === 'RSU'
        ? { vestDate: vestDate ?? acquiredOn }
        : { purchaseDate: acquiredOn }),
      ...(plan.assetClass === 'ESPP'
        ? (() => {
            const paid = parseUsd(cell(row, 'purchase price'));
            return paid === undefined ? {} : { purchasePrice: paid };
          })()
        : {}),
      fmvAtAcquisition: costPerUnit,
    };

    transactions.push({
      symbol,
      assetClass: plan.assetClass,
      kind: plan.kind,
      date: acquiredOn,
      quantity: quantity.toFixed(),
      pricePerUnit: costPerUnit,
      equityAward: award,
      // What the SOURCE says is left, for the projection to check its own
      // arithmetic against.
      statedRemainingQuantity: sellable.toFixed(),
      provenance: provenanceFor(fileName, row.rowNumber, 'ETRADE_HOLDINGS', importedAt),
    });
  }

  return Ok({ transactions, errors });
}
