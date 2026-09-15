/**
 * Broker statement parsers (US-4.3, US-4.4, US-4.5).
 *
 * Each parser is deliberately dumb: it maps a broker's columns onto
 * ParsedTransaction and validates cell shape, nothing more. Interpretation —
 * FIFO, tax character, currency conversion — belongs to the domain, so a broker
 * changing a column name can never quietly change a tax outcome.
 */
import {
  Err,
  Money,
  Ok,
  TemplateHeaderMismatchError,
  type Money as MoneyValue,
  type Result,
} from '@vantagepoint/shared-kernel';
import { columnIndex, isPositiveNumber, normaliseDate, parseCsv } from './csv.js';
import { deterministicImportedAt, provenanceFor } from './provenance.js';
import type { ParsedTransaction, RowError, TransactionKind } from './types.js';

export interface ParseOutcome {
  readonly transactions: readonly ParsedTransaction[];
  readonly errors: readonly RowError[];
}

const REQUIRED = {
  ZERODHA_TRADEBOOK: ['trade_date', 'symbol', 'isin', 'trade_type', 'quantity', 'price'],
  VESTED: ['date', 'type', 'symbol', 'quantity', 'price', 'currency'],
  ETRADE: ['transactiondate', 'transactiontype', 'symbol', 'quantity', 'price'],
} as const;

function missingColumns(header: readonly string[], required: readonly string[]): string[] {
  return required.filter((column) => !header.includes(column));
}

/* ------------------------------------------------------------------ zerodha */

const ZERODHA_KIND: Readonly<Record<string, TransactionKind>> = { buy: 'BUY', sell: 'SELL' };

export function parseZerodhaTradebook(csv: string, fileName: string): Result<ParseOutcome> {
  const table = parseCsv(csv);
  const missing = missingColumns(table.header, REQUIRED.ZERODHA_TRADEBOOK);
  if (missing.length > 0) {
    return Err(
      new TemplateHeaderMismatchError(
        `tradebook is missing column(s) ${missing.join(', ')}`,
        missing,
      ),
    );
  }

  const at = (name: string) => columnIndex(table.header, name);
  const importedAt = deterministicImportedAt(fileName);
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];

  for (const row of table.rows) {
    const rawDate = row.cells[at('trade_date')] ?? '';
    const date = normaliseDate(rawDate);
    if (date === undefined) {
      errors.push({
        row: row.rowNumber,
        column: 'trade_date',
        value: rawDate,
        reason: 'not a recognisable date',
        expectedFormat: 'YYYY-MM-DD',
      });
      continue;
    }

    const quantity = row.cells[at('quantity')] ?? '';
    if (!isPositiveNumber(quantity)) {
      errors.push({
        row: row.rowNumber,
        column: 'quantity',
        value: quantity,
        reason: 'quantity must be a positive number',
        expectedFormat: 'a decimal greater than zero',
      });
      continue;
    }

    const price = row.cells[at('price')] ?? '';
    if (!isPositiveNumber(price)) {
      errors.push({
        row: row.rowNumber,
        column: 'price',
        value: price,
        reason: 'price must be a positive number',
        expectedFormat: 'a decimal greater than zero',
      });
      continue;
    }

    const kind = ZERODHA_KIND[(row.cells[at('trade_type')] ?? '').toLowerCase()];
    if (kind === undefined) {
      errors.push({
        row: row.rowNumber,
        column: 'trade_type',
        value: row.cells[at('trade_type')] ?? '',
        reason: 'unrecognised trade type',
        expectedFormat: 'buy | sell',
      });
      continue;
    }

    transactions.push({
      kind,
      date,
      symbol: row.cells[at('symbol')] ?? '',
      isin: row.cells[at('isin')] ?? '',
      quantity,
      pricePerUnit: Money.of(price, 'INR'),
      provenance: provenanceFor(fileName, row.rowNumber, 'ZERODHA_TRADEBOOK', importedAt),
    });
  }

  return Ok({ transactions, errors });
}

/* ------------------------------------------------------------------- vested */

const VESTED_KIND: Readonly<Record<string, TransactionKind>> = {
  buy: 'BUY',
  sell: 'SELL',
  dividend: 'DIVIDEND',
  fee: 'FEE',
};

export function parseVested(csv: string, fileName: string): Result<ParseOutcome> {
  const table = parseCsv(csv);
  const at = (name: string) => columnIndex(table.header, name);
  const importedAt = deterministicImportedAt(fileName);
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];

  for (const row of table.rows) {
    const date = normaliseDate(row.cells[at('date')] ?? '');
    const kind = VESTED_KIND[(row.cells[at('type')] ?? '').toLowerCase()];
    if (date === undefined || kind === undefined) {
      errors.push({
        row: row.rowNumber,
        column: date === undefined ? 'Date' : 'Type',
        value: row.cells[at(date === undefined ? 'date' : 'type')] ?? '',
        reason: 'unparseable',
        expectedFormat: date === undefined ? 'YYYY-MM-DD' : 'BUY | SELL | DIVIDEND | FEE',
      });
      continue;
    }

    // Quantities are kept as written: Vested reports fractional shares to six
    // decimals, and normalising them would silently change a cost basis.
    const quantity = (row.cells[at('quantity')] ?? '0').trim();
    const price = (row.cells[at('price')] ?? '0').trim();

    transactions.push({
      kind,
      date,
      symbol: row.cells[at('symbol')] ?? '',
      quantity,
      pricePerUnit: Money.of(price, 'USD'),
      provenance: provenanceFor(fileName, row.rowNumber, 'VESTED', importedAt),
    });
  }

  return Ok({ transactions, errors });
}

/* ------------------------------------------------------------------- etrade */

function etradeKind(type: string): TransactionKind | undefined {
  const value = type.toLowerCase();
  // An RSU release is compensation, not a purchase: it carries a perquisite and
  // must never be folded into ordinary buys (US-1.4).
  if (value.includes('rsu') || value.includes('release')) return 'RSU_VEST';
  if (value.includes('espp')) return 'ESPP_PURCHASE';
  if (value.includes('bought') || value.includes('buy')) return 'BUY';
  if (value.includes('sold') || value.includes('sell')) return 'SELL';
  if (value.includes('dividend')) return 'DIVIDEND';
  return undefined;
}

export function parseEtrade(csv: string, fileName: string): Result<ParseOutcome> {
  const table = parseCsv(csv);
  const at = (name: string) => columnIndex(table.header, name);
  const importedAt = deterministicImportedAt(fileName);
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];

  for (const row of table.rows) {
    const date = normaliseDate(row.cells[at('transactiondate')] ?? '');
    const kind = etradeKind(row.cells[at('transactiontype')] ?? '');
    if (date === undefined || kind === undefined) {
      errors.push({
        row: row.rowNumber,
        column: 'TransactionType',
        value: row.cells[at('transactiontype')] ?? '',
        reason: 'unrecognised transaction type',
        expectedFormat: 'Bought | Sold | RSU Release | ESPP | Dividend',
      });
      continue;
    }

    const fmvIndex = at('fmvatvest');
    const fmv = fmvIndex >= 0 ? (row.cells[fmvIndex] ?? '').trim() : '';
    const perquisite: MoneyValue | undefined =
      kind === 'RSU_VEST' && fmv.length > 0 ? Money.of(fmv, 'USD') : undefined;

    transactions.push({
      kind,
      date,
      symbol: row.cells[at('symbol')] ?? '',
      quantity: (row.cells[at('quantity')] ?? '0').trim(),
      pricePerUnit: Money.of((row.cells[at('price')] ?? '0').trim(), 'USD'),
      ...(perquisite === undefined ? {} : { perquisiteValue: perquisite }),
      provenance: provenanceFor(fileName, row.rowNumber, 'ETRADE', importedAt),
    });
  }

  return Ok({ transactions, errors });
}

/* ----------------------------------------------------------- reconciliation */

/**
 * A broker's own realised-gain figure is a cross-check, never the source of
 * truth: it uses their lot method and rounding. Differences beyond a rupee are
 * surfaced as exceptions rather than absorbed, because a silent absorption is
 * how a wrong capital gain reaches a return.
 */
export function compareRealisedGains(input: {
  brokerStated: MoneyValue;
  computed: MoneyValue;
}): { variance: MoneyValue; isException: boolean } {
  const variance = Money.subtract(input.computed, input.brokerStated);
  const magnitude = Math.abs(Number(variance.amount));
  return { variance, isException: magnitude > 1 };
}
