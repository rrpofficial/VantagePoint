/**
 * Schedule FA — foreign asset disclosure (US-6.2, US-6.3, PRD FR-6.1).
 *
 * **Schedule FA runs on the CALENDAR year (1 Jan – 31 Dec), not the financial
 * year.** Everything else in this product is FY-aligned, which makes this the
 * single easiest mistake to make here: a holding sold in February would be
 * reported in the wrong disclosure year, and the Black Money Act treats an
 * omitted foreign asset far more harshly than an understated domestic one.
 *
 * Account numbers are masked to opaque references (FR-7.2) — a disclosure export
 * is exactly the kind of file that gets emailed to an accountant.
 */
import { DomainError, Err, Ok, Money, type IsoDate, type Result } from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { computeFromAcquisition } from './peak-value.js';
import type {
  ForeignAccountDisclosure,
  ForeignHoldingDisclosure,
  ScheduleFaA3Row,
  ScheduleFaDRow,
  ScheduleFaInput,
} from './types.js';

/** Generating a foreign disclosure from a domestic snapshot files the wrong year. */
export class WrongSnapshotScopeError extends DomainError {
  readonly code = 'WRONG_SNAPSHOT_SCOPE';
}

const INR = 'INR' as const;

const inr = (value: Decimal) => Money.round(Money.of(value.toFixed(), INR), 2, 'HALF_UP');

/** Calendar-year window. Named to make the FY/CY distinction impossible to miss. */
export function calendarYearWindow(year: number): { from: IsoDate; to: IsoDate } {
  return { from: `${String(year)}-01-01`, to: `${String(year)}-12-31` };
}

export function accountRef(rawAccountNumber: string): string {
  return `acct_${createHash('sha256').update(rawAccountNumber.trim()).digest('hex').slice(0, 12)}`;
}

function a3Row(holding: ForeignHoldingDisclosure, year: number): ScheduleFaA3Row {
  const { from, to } = calendarYearWindow(year);
  const peak = computeFromAcquisition({
    assetId: holding.assetId,
    acquisitionDate: holding.acquisitionDate,
    from,
    to,
    dailyQuantities: holding.dailyQuantities,
    dailyPrices: holding.dailyPrices,
    dailyRates: holding.dailyRates,
  });

  const closingRate = new Decimal(holding.closingRate);
  return {
    countryCode: holding.countryCode,
    entityName: holding.entityName,
    address: holding.address,
    natureOfEntity: holding.natureOfEntity,
    acquisitionDate: holding.acquisitionDate,
    initialInvestmentInr: inr(new Decimal(holding.initialInvestment.amount).times(closingRate)),
    peakValueInr: peak.peakInr,
    peakValueNative: peak.peakNative,
    closingValueInr: inr(new Decimal(holding.closingValueNative.amount).times(closingRate)),
    // Gross, per the schedule: withholding is disclosed separately, and netting
    // it here would understate what was credited.
    grossDividendInr: inr(new Decimal(holding.grossDividend.amount).times(closingRate)),
    grossProceedsInr: inr(new Decimal(holding.grossProceeds.amount).times(closingRate)),
  };
}

export function tableA3(input: ScheduleFaInput): Result<readonly ScheduleFaA3Row[]> {
  if (input.foreignSnapshot.scope !== 'FOREIGN') {
    return Err(
      new WrongSnapshotScopeError('Schedule FA must be generated from a FOREIGN-scope snapshot'),
    );
  }
  return Ok(
    (input.holdings ?? []).map((holding: ForeignHoldingDisclosure) =>
      a3Row(holding, input.calendarYear),
    ),
  );
}

function dRow(account: ForeignAccountDisclosure): ScheduleFaDRow {
  const rate = new Decimal(account.closingRate);
  return {
    countryCode: account.countryCode,
    institutionName: account.institutionName,
    // Never the raw account number (FR-7.2).
    accountRef: accountRef(account.accountNumber),
    accountOpenDate: account.accountOpenDate,
    peakBalanceInr: inr(new Decimal(account.peakBalance.amount).times(rate)),
    closingBalanceInr: inr(new Decimal(account.closingBalance.amount).times(rate)),
  };
}

export function tableD(input: ScheduleFaInput): Result<readonly ScheduleFaDRow[]> {
  return Ok((input.accounts ?? []).map((account: ForeignAccountDisclosure) => dRow(account)));
}
