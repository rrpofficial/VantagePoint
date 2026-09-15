/**
 * SBI Treasury forex card rate sheet parser (US-2.2, PRD FR-2.1).
 *
 * Plan risk R1: SBI's published layout is not a stable contract. A parser that
 * tolerates drift is worse than one that breaks, because a silently mis-parsed
 * column yields plausible-looking rates that flow straight into a tax computation.
 * So this asserts a structural fingerprint — the expected header columns and a set
 * of currencies that must be present — and rejects the whole sheet on any mismatch.
 * A rejected sheet costs a fallback-chain lookup; a mis-parsed one costs a wrong
 * capital gain.
 *
 * Pure: the caller supplies `retrievedAt`, since this package may not read a clock.
 */
import { DomainError, Err, Ok, type Currency, type Result } from '@vantagepoint/shared-kernel';
import type { RateRecord } from './types.js';

/** Columns the sheet must expose, in order. */
const EXPECTED_HEADER = ['CURRENCY', 'TT_BUY', 'TT_SELL', 'BILL_BUY', 'BILL_SELL'] as const;

/**
 * Currencies that must appear for the sheet to be considered intact. USD is the
 * fingerprint: a sheet without it is either a different document or truncated.
 */
const REQUIRED_CURRENCIES: readonly Currency[] = ['USD'];

const SUPPORTED_CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP', 'SGD', 'AED'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SbiParseOptions {
  /** Instant the sheet was retrieved. Defaults to the sheet date at IST midnight. */
  readonly retrievedAt?: string;
  /** Reference to the source document, retained for audit. */
  readonly documentRef?: string;
}

/** Layout drift or a truncated sheet — the ingest is refused wholesale. */
export class SheetFormatError extends DomainError {
  readonly code = 'SBI_SHEET_FORMAT';
}

export function parseSbiSheet(
  sheet: string,
  options: SbiParseOptions = {},
): Result<readonly RateRecord[]> {
  const lines = sheet
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const sheetDateLine = lines.find((line) => line.startsWith('SHEET_DATE'));
  if (sheetDateLine === undefined) {
    return Err(new SheetFormatError('rate sheet has no SHEET_DATE row'));
  }
  const sheetDate = sheetDateLine.split(',')[1]?.trim() ?? '';
  if (!ISO_DATE.test(sheetDate)) {
    return Err(new SheetFormatError(`SHEET_DATE "${sheetDate}" is not a YYYY-MM-DD date`));
  }

  const headerIndex = lines.findIndex((line) => line.startsWith('CURRENCY'));
  if (headerIndex === -1) {
    return Err(new SheetFormatError('rate sheet has no CURRENCY header row'));
  }

  const header = lines[headerIndex]?.split(',').map((cell) => cell.trim().toUpperCase()) ?? [];
  const missingColumns = EXPECTED_HEADER.filter((column) => !header.includes(column));
  if (missingColumns.length > 0) {
    return Err(
      new SheetFormatError(
        `rate sheet layout changed: missing column(s) ${missingColumns.join(', ')}`,
      ),
    );
  }

  const ttBuyIndex = header.indexOf('TT_BUY');
  const records: RateRecord[] = [];
  const seen = new Set<string>();

  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split(',').map((cell) => cell.trim());
    const currency = cells[0]?.toUpperCase() ?? '';
    if (!SUPPORTED_CURRENCIES.includes(currency as Currency)) continue;

    const rate = cells[ttBuyIndex];
    if (rate === undefined || rate.length === 0 || Number.isNaN(Number(rate))) {
      return Err(
        new SheetFormatError(`${currency} row has no usable TT_BUY value ("${rate ?? ''}")`),
      );
    }

    seen.add(currency);
    records.push({
      currency: currency as Currency,
      date: sheetDate,
      rate,
      source: 'SBI_ITBR',
      rateType: 'TTBR',
      retrievedAt: options.retrievedAt ?? `${sheetDate}T00:00:00.000+05:30`,
      sourceDocumentRef: options.documentRef ?? `sbi-forex-${sheetDate}`,
    });
  }

  const missingCurrencies = REQUIRED_CURRENCIES.filter((currency) => !seen.has(currency));
  if (missingCurrencies.length > 0) {
    // Nothing is returned, so nothing reaches the store: a partial sheet must not
    // half-populate rates that later resolve as if they were complete.
    return Err(
      new SheetFormatError(
        `rate sheet is missing required currency ${missingCurrencies.join(', ')} — refusing to ingest`,
      ),
    );
  }

  return Ok(records);
}
