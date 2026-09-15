/**
 * ITR-ready export (US-6.5, PRD FR-6.1).
 *
 * The ITR utility takes whole rupees. Exporting paise either fails validation or
 * is silently truncated, so rounding happens HERE, once, rather than being left
 * to whatever reads the file.
 *
 * Rounding is half-up on the absolute value, so a disclosure is never rounded
 * DOWN toward a smaller declared figure.
 */
import { Err, Ok, Money, type Money as MoneyValue, type Result } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import type { ScheduleAl, ScheduleFaA3Row, ScheduleFaDRow } from './types.js';

/** Column order the ITR utility expects for Table A3. */
export const A3_COLUMNS = [
  'countryCode',
  'entityName',
  'address',
  'natureOfEntity',
  'acquisitionDate',
  'initialInvestmentInr',
  'peakValueInr',
  'closingValueInr',
  'grossDividendInr',
  'grossProceedsInr',
] as const;

export const D_COLUMNS = [
  'countryCode',
  'institutionName',
  'accountRef',
  'accountOpenDate',
  'peakBalanceInr',
  'closingBalanceInr',
] as const;

const isMoney = (value: unknown): value is MoneyValue =>
  typeof value === 'object' && value !== null && 'amount' in value && 'currency' in value;

/** Whole rupees, never rounding a declared figure downward. */
function toWholeRupees(money: MoneyValue): MoneyValue {
  const value = new Decimal(money.amount);
  const rounded = value.abs().toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return Money.of(value.isNegative() ? rounded.negated().toFixed() : rounded.toFixed(), money.currency);
}

function normalise(value: unknown): unknown {
  if (isMoney(value)) return toWholeRupees(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalise(item)]));
  }
  return value;
}

export function toJson(data: readonly ScheduleFaA3Row[] | ScheduleAl): string {
  return JSON.stringify(normalise(data), null, 2);
}

const cell = (value: unknown): string => {
  // Only primitives and Money reach a cell; anything else would stringify to
  // "[object Object]" and silently corrupt the export.
  const text = isMoney(value)
    ? toWholeRupees(value).amount
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toCsv(data: readonly ScheduleFaA3Row[] | ScheduleAl): string {
  if (!Array.isArray(data)) return scheduleAlToCsv(data as ScheduleAl);

  const rows = data as readonly (ScheduleFaA3Row | ScheduleFaDRow)[];
  const first = rows[0];
  const columns =
    first !== undefined && 'institutionName' in first ? D_COLUMNS : A3_COLUMNS;
  const lines: string[] = [columns.join(',')];
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    lines.push(columns.map((column) => cell(record[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function scheduleAlToCsv(schedule: ScheduleAl): string {
  const lines = ['head,description,costOfAcquisition'];
  for (const section of [
    schedule.immovableProperty,
    schedule.financialAssets,
    schedule.cashInHand,
    schedule.loansAndAdvancesGiven,
    schedule.jewellery,
    schedule.vehicles,
    schedule.liabilities,
  ]) {
    for (const item of section.items) {
      lines.push([cell(section.head), cell(item.description), cell(item.costOfAcquisition)].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Structural validation against the bundled shape for each schedule. */
export function validate(json: string, schemaName: string): Result<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return Err(new SchemaValidationError(`${schemaName} export is not valid JSON`));
  }

  if (schemaName === 'schedule-fa-a3') {
    if (!Array.isArray(parsed)) {
      return Err(new SchemaValidationError('Table A3 export must be an array of rows'));
    }
    for (const [index, row] of parsed.entries()) {
      const record = row as Record<string, unknown>;
      for (const column of A3_COLUMNS) {
        if (!(column in record)) {
          return Err(
            new SchemaValidationError(`Table A3 row ${String(index)} is missing "${column}"`),
          );
        }
      }
    }
    return Ok(undefined);
  }

  if (schemaName === 'schedule-al') {
    const record = parsed as Record<string, unknown>;
    for (const head of ['immovableProperty', 'financialAssets', 'liabilities']) {
      if (!(head in record)) {
        return Err(new SchemaValidationError(`Schedule AL export is missing "${head}"`));
      }
    }
    return Ok(undefined);
  }

  return Err(new SchemaValidationError(`unknown export schema "${schemaName}"`));
}

import { DomainError } from '@vantagepoint/shared-kernel';

export class SchemaValidationError extends DomainError {
  readonly code = 'SCHEMA_VALIDATION_FAILED';
}
