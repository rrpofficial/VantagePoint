/**
 * E*TRADE "Gains & Losses — Expanded" (US-4.5b).
 *
 * A different document from the transaction history `parseEtrade` reads, and it
 * must not be confused with it: the transaction history lists events (a release,
 * a purchase, a sale) one per row, while this lists CLOSED ROUND TRIPS — each row
 * is an acquisition and the disposal that ended it, with the cost basis already
 * worked out. It is the file a taxpayer actually has at filing time.
 *
 * ## Each row becomes two transactions
 *
 * One acquisition (`RSU_VEST` or `ESPP_PURCHASE`) and one `SELL`, rather than a
 * single pre-computed gain. The gain then falls out of the same FIFO lot machinery
 * every other parser feeds, and Rule 115 conversion happens on the two legs
 * independently — which is the entire point, because the two legs are converted at
 * rates from different months and a pre-computed USD gain cannot be.
 *
 * ## Which cost figure is the cost basis
 *
 * `Adjusted Cost Basis`, never `Acquisition Cost`.
 *
 * For an RSU the acquisition cost is $0.00 — the shares were granted. What the
 * taxpayer was already taxed on is the fair market value at vest, as salary
 * perquisite. Using $0.00 as the cost basis would tax that same value a second
 * time as capital gain: a double charge on the entire vest value, which for a
 * long-held RSU is most of the proceeds. `Adjusted Cost Basis` is exactly the
 * perquisite-inclusive figure, for both RSU and ESPP.
 *
 * ## Wash sales are ignored on purpose
 *
 * The file carries a parallel set of `Wash Sale Adjusted …` columns. India has no
 * wash-sale rule, so those columns describe a US adjustment that has no effect on
 * an Indian return. The unadjusted figures are the ones read here.
 *
 * ## Sell-to-cover is imported, not skipped
 *
 * `RS STC` rows are the shares sold immediately on vest to fund US withholding.
 * They are genuine disposals producing a genuine (usually tiny) gain, and leaving
 * them out would understate both the disposal count and the proceeds.
 *
 * ## Per-row gains will NOT match E*TRADE's, and should not
 *
 * E*TRADE matches each sale to the specific lot it came from, which is what US
 * rules permit. Section 45 and Rule 37BA give an Indian resident no such choice:
 * shares are matched FIFO. The projector therefore re-matches every disposal
 * against the oldest lot held, and the gain on any individual row will differ
 * from the `Adjusted Gain/Loss` the file states whenever more than one lot of the
 * same symbol is open.
 *
 * The totals converge once every lot is sold; the per-row figures do not. This
 * is a deliberate divergence from the source document, not a defect — but it is
 * exactly the kind of difference a user will otherwise find on their own and
 * assume is a bug, so the Import screen says so before the file is chosen.
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
import { grantRefOf, isSellToCover, type EquityAward } from '@porttrack/core-domain';
import { parseCsv, columnIndex } from './csv.js';
import { deterministicImportedAt, provenanceFor } from './provenance.js';
import type { ParsedTransaction, RowError } from './types.js';
import type { ParseOutcome } from './brokers.js';

const USD = 'USD' as const;

/**
 * The columns this parser cannot proceed without.
 *
 * Deliberately a SMALL subset of the 47 the file carries: the export's column set
 * varies with the plan types an account holds, and demanding all of them would
 * reject a perfectly good file from someone who has only ever held RSUs.
 */
const REQUIRED_COLUMNS = [
  'record type',
  'symbol',
  'quantity',
  'date acquired',
  'adjusted cost basis',
  'date sold',
  'total proceeds',
] as const;

/**
 * `MM/DD/YYYY`, strictly, and never inferred.
 *
 * This is a US broker's export and the order is fixed. It is parsed here rather
 * than through the shared `normaliseDate` precisely so that it cannot be reached
 * by a file using the other convention: `03/04/2026` is a valid date under both
 * readings and four weeks apart, and a silent misreading moves a disposal into a
 * different month — which under Rule 115 selects a different exchange rate, and
 * near a year end, a different financial year.
 */
function parseUsDate(raw: string): string | undefined {
  const value = raw.trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (match === null) return undefined;

  const [, month = '', day = '', year = ''] = match;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;

  // Round-tripped through Date so 02/30 is rejected rather than stored.
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    return undefined;
  }
  return iso;
}

/** `--` and an empty cell both mean "not applicable on this plan type". */
function isBlank(raw: string | undefined): boolean {
  const value = (raw ?? '').trim();
  return value.length === 0 || value === '--';
}

/**
 * `$1,824.72`, `-$0.02` and `($0.02)` all read as numbers.
 *
 * `Money.parse` already strips the symbol and the grouping commas; what it does
 * not know is the accounting convention of wrapping a negative in parentheses,
 * which some E*TRADE exports use in place of a leading minus.
 */
function parseUsd(raw: string | undefined): MoneyValue | undefined {
  if (isBlank(raw)) return undefined;
  let value = (raw ?? '').trim();

  if (value.startsWith('(') && value.endsWith(')')) {
    value = `-${value.slice(1, -1)}`;
  }
  const parsed = Money.parse(value, USD);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * A per-unit figure derived from the TOTAL, not read from the per-share column.
 *
 * The per-share columns are rounded to two decimals, and quantities here are
 * fractional — a vest of 10.556 shares is ordinary. Reconstructing the total from
 * a rounded per-share figure loses money against the total the file states, and
 * the loss lands directly in a capital gain. Dividing the total instead
 * reproduces it to the precision Decimal carries.
 */
function perUnit(total: MoneyValue, quantity: Decimal): MoneyValue {
  return Money.of(new Decimal(total.amount).dividedBy(quantity).toFixed(), USD);
}

/** Which plan a row belongs to, and therefore how the acquisition is recorded. */
function planOf(
  planType: string,
  orderType: string,
): { assetClass: 'RSU' | 'ESPP'; kind: 'RSU_VEST' | 'ESPP_PURCHASE' } | undefined {
  const plan = planType.trim().toUpperCase();
  if (plan === 'RS' || plan === 'RSU') return { assetClass: 'RSU', kind: 'RSU_VEST' };
  if (plan === 'ESPP') return { assetClass: 'ESPP', kind: 'ESPP_PURCHASE' };

  /*
   * Plan Type is occasionally blank on an older export while Order Type is not,
   * so the order type is consulted as a fallback rather than the row being lost.
   * Anything still unrecognised is REJECTED, never defaulted: guessing RSU for an
   * ESPP row would apply the wrong perquisite and the wrong holding-period rule.
   */
  const order = orderType.trim().toUpperCase();
  if (order.includes('ESPP')) return { assetClass: 'ESPP', kind: 'ESPP_PURCHASE' };
  if (order.includes('RS')) return { assetClass: 'RSU', kind: 'RSU_VEST' };
  return undefined;
}

export function parseEtradeGainsLosses(csv: string, fileName: string): Result<ParseOutcome> {
  const table = parseCsv(csv);

  const missing = REQUIRED_COLUMNS.filter((column) => !table.header.includes(column));
  if (missing.length > 0) {
    return Err(
      new TemplateHeaderMismatchError(
        `this does not look like an E*TRADE Gains & Losses (Expanded) export — missing column(s) ${missing.join(', ')}. The plain transaction history is a different file; import it as "E*TRADE transaction history".`,
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
     * The export opens with a `Summary` row carrying the totals and no dates.
     * It is not a transaction and is skipped silently — reporting it as a
     * rejected row would put a permanent error on every clean import.
     */
    const recordType = cell(row, 'record type').trim().toLowerCase();
    if (recordType === 'summary' || recordType.length === 0) continue;
    if (recordType !== 'sell') {
      reject('Record Type', cell(row, 'record type'), 'not a disposal row', 'Sell');
      continue;
    }

    const symbol = cell(row, 'symbol').trim();
    if (symbol.length === 0) {
      reject('Symbol', '', 'a disposal needs the symbol it disposed of');
      continue;
    }

    const plan = planOf(cell(row, 'plan type'), cell(row, 'order type'));
    if (plan === undefined) {
      reject(
        'Plan Type',
        cell(row, 'plan type'),
        'unrecognised plan type — cannot tell an RSU from an ESPP, and they are taxed differently',
        'RS | ESPP',
      );
      continue;
    }

    const acquiredOn = parseUsDate(cell(row, 'date acquired'));
    if (acquiredOn === undefined) {
      reject('Date Acquired', cell(row, 'date acquired'), 'not a date', 'MM/DD/YYYY');
      continue;
    }
    const soldOn = parseUsDate(cell(row, 'date sold'));
    if (soldOn === undefined) {
      reject('Date Sold', cell(row, 'date sold'), 'not a date', 'MM/DD/YYYY');
      continue;
    }
    /*
     * A disposal before its own acquisition is impossible, and the holding period
     * it implies decides long-term versus short-term. Far better to refuse the
     * row than to classify a gain from a negative holding period.
     */
    if (soldOn < acquiredOn) {
      reject(
        'Date Sold',
        `${cell(row, 'date sold')} before ${cell(row, 'date acquired')}`,
        'sold before it was acquired',
      );
      continue;
    }

    const rawQuantity = cell(row, 'quantity').replace(/,/g, '').trim();
    let quantity: Decimal;
    try {
      quantity = new Decimal(rawQuantity);
    } catch {
      reject('Quantity', cell(row, 'quantity'), 'not a number');
      continue;
    }
    if (!quantity.isFinite() || quantity.lessThanOrEqualTo(0)) {
      reject('Quantity', cell(row, 'quantity'), 'quantity must be greater than zero');
      continue;
    }

    const costBasis = parseUsd(cell(row, 'adjusted cost basis'));
    if (costBasis === undefined) {
      reject('Adjusted Cost Basis', cell(row, 'adjusted cost basis'), 'not an amount');
      continue;
    }
    const proceeds = parseUsd(cell(row, 'total proceeds'));
    if (proceeds === undefined) {
      reject('Total Proceeds', cell(row, 'total proceeds'), 'not an amount');
      continue;
    }

    /*
     * Integrity check, not a tax calculation.
     *
     * The file states its own gain, and proceeds minus adjusted cost basis must
     * reproduce it. When it does not, this parser has read a column that is not
     * the column it thinks it is — a shifted or renamed header — and every figure
     * from the row is suspect. A silently mis-mapped column is the one failure
     * here that produces a plausible wrong number rather than an obvious one, so
     * the row is refused rather than imported on trust.
     *
     * A cent of tolerance for the file's own rounding.
     */
    const statedGain = parseUsd(cell(row, 'adjusted gain/loss'));
    if (statedGain !== undefined) {
      const computed = new Decimal(proceeds.amount).minus(costBasis.amount);
      if (computed.minus(statedGain.amount).abs().greaterThan('0.011')) {
        reject(
          'Adjusted Gain/Loss',
          cell(row, 'adjusted gain/loss'),
          `the file states ${statedGain.amount} but proceeds less cost basis is ${computed.toFixed(2)} — the columns do not line up, so this row was not imported`,
        );
        continue;
      }
    }

    /*
     * Grant-level dates. Optional, and a row is NOT rejected for missing them —
     * they enrich identity and audit, and losing a disposal because an older
     * export omitted a grant date would trade a real figure for a reference.
     */
    const grantDate = parseUsDate(cell(row, 'grant date'));
    const vestDate = parseUsDate(cell(row, 'vest date'));
    const purchaseDate = parseUsDate(cell(row, 'purchase date'));
    // ESPP only: the discounted price actually paid per share.
    const purchasePrice = parseUsd(cell(row, 'purchase price'));

    const provenance = provenanceFor(fileName, row.rowNumber, 'ETRADE_GL', importedAt);

    /*
     * The asset class is stated on BOTH legs, from the row's own Plan Type.
     *
     * Without it the acquisition resolves to asset `RSU` (from its kind) while the
     * disposal resolves to whatever the parser's default class is — two different
     * asset ids for one holding, and the sale then finds no lot to deplete and is
     * reported as unapplied. The file states the plan type, so this is read, not
     * guessed.
     */
    const identity = { symbol, assetClass: plan.assetClass } as const;

    // Per-share ordinary income is the perquisite already taxed as salary: the
    // whole vest value for an RSU, the discount to FMV for an ESPP.
    const ordinaryIncome = parseUsd(cell(row, 'ordinary income recognized'));
    const perquisitePerUnit =
      ordinaryIncome === undefined ? undefined : perUnit(ordinaryIncome, quantity);

    const costPerUnit = perUnit(costBasis, quantity);

    /*
     * Grant, tranche and order.
     *
     * ESPP rows carry no Grant Number, so `grantRefOf` falls back to the
     * offering's grant date — and the tranche is then the PURCHASE date, because
     * one offering commonly has several purchase dates and the grant date alone
     * would collapse them into a single lot.
     */
    const grantRef = grantRefOf({
      ...(isBlank(cell(row, 'grant number'))
        ? {}
        : { grantNumber: cell(row, 'grant number').trim() }),
      ...(grantDate === undefined ? {} : { grantDate }),
    });

    const award: EquityAward | undefined =
      grantRef === undefined
        ? undefined
        : {
            kind: plan.assetClass,
            grantRef,
            ...(grantDate === undefined ? {} : { grantDate }),
            ...(plan.assetClass === 'RSU'
              ? { vestDate: vestDate ?? acquiredOn }
              : { purchaseDate: purchaseDate ?? acquiredOn }),
            // What was actually PAID, which for an ESPP is below the cost basis
            // by the discount already charged as salary.
            ...(purchasePrice === undefined ? {} : { purchasePrice }),
            ...(perquisitePerUnit === undefined ? {} : { discountPerUnit: perquisitePerUnit }),
            fmvAtAcquisition: costPerUnit,
          };

    const orderRef = isBlank(cell(row, 'order number'))
      ? undefined
      : cell(row, 'order number').trim();

    transactions.push({
      ...identity,
      kind: plan.kind,
      date: acquiredOn,
      quantity: quantity.toFixed(),
      pricePerUnit: costPerUnit,
      ...(perquisitePerUnit === undefined ? {} : { perquisiteValue: perquisitePerUnit }),
      ...(award === undefined ? {} : { equityAward: award }),
      // This row states what ONE sale disposed of, not the size of the vest. A
      // tranche sold across several orders yields several such rows, and they
      // are slices of one lot.
      lotQuantityIsPartial: true,
      /*
       * Carried on the ACQUISITION leg too, not only on the sale.
       *
       * Slices of one tranche sum, so the stored lot ends up larger than any row
       * that built it — and the duplicate detector, which rebuilds its keys from
       * stored lots, can then no longer recognise those rows on a re-import. The
       * order reference lets the projection identify the slice by the disposal it
       * belongs to, which IS deduplicated, so re-importing a file adds nothing.
       */
      ...(orderRef === undefined ? {} : { orderRef }),
      provenance,
    });

    transactions.push({
      ...identity,
      kind: 'SELL',
      date: soldOn,
      quantity: quantity.toFixed(),
      pricePerUnit: perUnit(proceeds, quantity),
      ...(award === undefined ? {} : { equityAward: award }),
      // Read from the broker's order type, never inferred from the dates: a
      // same-day sale is not necessarily a sell-to-cover, and treating one as
      // the other would drop a real disposal when the exclusion is switched on.
      disposalKind: isSellToCover(cell(row, 'order type')) ? 'SELL_TO_COVER' : 'SALE',
      ...(orderRef === undefined ? {} : { orderRef }),
      provenance,
    });
  }

  return Ok({ transactions, errors });
}
