/**
 * Shared test kit. This is TEST code — it may not be imported by any package under
 * `packages/` or `apps/`. It deliberately implements its own decimal helpers so the
 * acceptance tests do not depend on the very `Money` implementation they will verify.
 */
import { expect } from 'vitest';
import type {
  Clock,
  Currency,
  IdGenerator,
  IsoDateTime,
  Money,
  Result,
} from '@vantagepoint/shared-kernel';
import type {
  AcquisitionLot,
  Asset,
  DualRate,
  ExitTransaction,
  Liability,
} from '@vantagepoint/core-domain';

/* ------------------------------------------------------------------- money */

/** Builds the Money shape directly, without exercising the implementation under test. */
export function money(amount: string | number, currency: Currency = 'INR'): Money {
  return { amount: typeof amount === 'number' ? amount.toFixed(2) : amount, currency };
}

export const inr = (amount: string | number): Money => money(amount, 'INR');
export const usd = (amount: string | number): Money => money(amount, 'USD');

/**
 * Exact monetary equality. Compares numeric value and currency — never `toBeCloseTo`,
 * which would let a rounding defect through (plan §8).
 */
export function expectMoney(actual: Money, expected: Money): void {
  expect(actual.currency).toBe(expected.currency);
  expect(Number(actual.amount)).toBe(Number(expected.amount));
}

/* -------------------------------------------------------------------- time */

/** Deterministic clock. Every test that touches time injects one (plan §8). */
export function fixedClock(instant: IsoDateTime): Clock {
  return {
    now: () => instant,
    today: () => instant.slice(0, 10),
  };
}

export function seededIds(seed = 0): IdGenerator {
  let n = seed;
  return { next: (prefix: string) => `${prefix}_${String(++n).padStart(4, '0')}` };
}

/* ---------------------------------------------------------------- builders */

export function aLot(overrides: Partial<AcquisitionLot> = {}): AcquisitionLot {
  const costPerUnit = overrides.costPerUnit ?? inr('100');
  // Charges default to the lot's own currency: a USD lot with INR fees is not a
  // thing, and Money refuses to sum across currencies.
  const zero = money('0', costPerUnit.currency);
  return {
    lotId: 'lot_0001',
    acquisitionDate: '2023-05-10',
    settlementDate: '2023-05-11',
    quantity: '100',
    remainingQuantity: '100',
    fees: zero,
    stt: zero,
    otherCharges: zero,
    ...overrides,
    costPerUnit,
  };
}

export function anAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    assetId: 'ast_domestic_equity_0001',
    assetClass: 'DOMESTIC_EQUITY',
    jurisdiction: 'DOMESTIC',
    currency: 'INR',
    symbol: 'TCS',
    lots: [aLot()],
    incomeEvents: [],
    corporateActions: [],
    ...overrides,
  };
}

export function aForeignAsset(overrides: Partial<Asset> = {}): Asset {
  return anAsset({
    assetId: 'ast_foreign_equity_0001',
    assetClass: 'FOREIGN_EQUITY',
    jurisdiction: 'FOREIGN',
    currency: 'USD',
    symbol: 'AAPL',
    lots: [
      aLot({
        lotId: 'lot_aapl_01',
        acquisitionDate: '2023-05-10',
        settlementDate: '2023-05-12',
        quantity: '100',
        remainingQuantity: '100',
        costPerUnit: usd('172.50'),
      }),
    ],
    ...overrides,
  });
}

export function aLiability(overrides: Partial<Liability> = {}): Liability {
  return {
    liabilityId: 'lia_0001',
    kind: 'HOME_LOAN',
    principalOutstanding: inr('8000000'),
    interestRatePct: '8.5',
    asOf: '2026-03-31',
    ...overrides,
  };
}

export function aDualRate(overrides: Partial<DualRate> = {}): DualRate {
  return {
    valuationRate: '84.10',
    taxRate: '83.55',
    valuationRateSource: 'SBI_ITBR',
    taxRateSource: 'SBI_ITBR',
    isFallback: false,
    ...overrides,
  };
}

export function anExit(overrides: Partial<ExitTransaction> = {}): ExitTransaction {
  return {
    txnId: 'txn_0001',
    assetId: 'ast_foreign_equity_0001',
    acquisitionDate: '2023-05-10',
    exitDate: '2026-02-15',
    quantity: '40',
    pricePerUnit: usd('180.00'),
    fees: usd('0'),
    stt: usd('0'),
    allocations: [],
    ...overrides,
  };
}

/** Generates `count` synthetic lots for performance budget tests. */
export function manyLots(count: number): AcquisitionLot[] {
  return Array.from({ length: count }, (_, i) =>
    aLot({
      lotId: `lot_${String(i).padStart(5, '0')}`,
      acquisitionDate: `20${String(20 + (i % 6))}-0${String((i % 9) + 1)}-1${String(i % 10)}`,
      quantity: String(10 + (i % 90)),
      remainingQuantity: String(10 + (i % 90)),
      costPerUnit: inr(String(100 + (i % 500))),
    }),
  );
}

/* --------------------------------------------------------------------- pii */

/**
 * Structurally valid but never-issued identifiers. No real PII enters this repo (plan §8).
 * `SYNTHETIC_PAN` follows the PAN grammar; it is not an allotted number.
 */
export const SYNTHETIC = {
  PAN: 'ABCDE1234F',
  AADHAAR_SPACED: '2345 6789 0123',
  AADHAAR_PLAIN: '234567890123',
  DPID: '1208160000123456',
  FOLIO: '91234567/89',
  EMAIL: 'rajesh@example.com',
  PHONE: '+91 98765 43210',
  ADDRESS: 'Flat 4B, MG Road, Bengaluru 560001',
  ORDER_ID: '250810400123456',
  PERSON: 'Rajesh Sharma',
  PERSON_2: 'Priya Menon',
  ORG: 'Tata Consultancy Services',
} as const;

const PII_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['PAN', /\b[A-Z]{5}[0-9]{4}[A-Z]\b/],
  ['AADHAAR', /\b[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\b/],
  ['EMAIL', /\b[\w.+-]+@[\w-]+\.[\w.]+\b/],
  ['PHONE', /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/],
  ['DEMAT', /\b\d{16}\b/],
];

/** Asserts a string carries no PII. Used for logs, errors and outbound payloads (D7). */
export function expectNoPii(text: string): void {
  for (const [kind, pattern] of PII_PATTERNS) {
    expect(pattern.test(text), `${kind} pattern leaked into: ${text.slice(0, 80)}`).toBe(false);
  }
}

/* ------------------------------------------------------------------ result */

export function expectOk<T>(result: Result<T>): T {
  expect(result.ok, `expected Ok, got error: ${result.ok ? '' : result.error.code}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

export function expectErr<T>(result: Result<T>, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.error.code).toBe(code);
}

/* ------------------------------------------------------------------- ports */

import type { FxSource, HandLoan, PriceQuote, PriceSource } from '@vantagepoint/core-domain';

/** Deterministic price source. Keyed by assetId, ISIN or symbol, first match wins. */
export function stubPrices(
  quotes: Record<string, Money | PriceQuote>,
): PriceSource {
  const normalise = (q: Money | PriceQuote): PriceQuote =>
    'price' in q ? q : { price: q, source: 'PUBLISHED' };
  return {
    priceFor: ({ assetId, isin, symbol }) => {
      for (const key of [assetId, isin, symbol]) {
        if (key !== undefined && key in quotes) return normalise(quotes[key]!);
      }
      return undefined;
    },
  };
}

/** Deterministic FX source. `rates` maps currency → rate against INR. */
export function stubFx(rates: Partial<Record<Currency, string>>): FxSource {
  return { rateFor: (currency) => rates[currency] };
}

export function aHandLoan(overrides: Partial<HandLoan> = {}): HandLoan {
  return {
    assetId: 'ast_hand_loan_0001',
    borrowerRef: 'pii_ref_0001',
    principal: inr('5000000'),
    interestRatePct: '8.0',
    interestBasis: 'SIMPLE',
    startDate: '2025-04-01',
    repayments: [],
    ...overrides,
  };
}

/** A HAND_LOAN asset carrying its loan detail, as the valuation engine expects. */
export function aHandLoanAsset(loan: HandLoan = aHandLoan()) {
  return anAsset({
    assetId: loan.assetId,
    assetClass: 'HAND_LOAN',
    jurisdiction: 'DOMESTIC',
    currency: 'INR',
    lots: [],
    handLoan: loan,
  });
}

/* --------------------------------------------------------------- fx seeding */

import { RateStore } from '@vantagepoint/fx-itbr';
import type { RateRecord } from '@vantagepoint/fx-itbr';

const rate = (
  date: string,
  value: string,
  source: RateRecord['source'],
  currency: Currency = 'USD',
): RateRecord => ({
  currency,
  date,
  rate: value,
  source,
  rateType: source === 'SBI_ITBR' ? 'TTBR' : 'REFERENCE',
  retrievedAt: '2026-08-02T00:00:00.000+05:30',
  sourceDocumentRef: `${source.toLowerCase()}-${date}`,
});

/**
 * The rate history the acceptance scenarios are written against. Deliberately
 * sparse: 2025-08-15 and 2025-12-25 have no SBI rate so the fallback chain is
 * genuinely exercised rather than assumed.
 */
export function seedStandardRates(): void {
  RateStore.clear();
  for (const record of [
    rate('2025-07-31', '83.4500', 'SBI_ITBR'),
    rate('2025-08-29', '83.6000', 'SBI_ITBR'),
    rate('2025-12-31', '83.8000', 'SBI_ITBR'),
    rate('2026-01-31', '83.5500', 'SBI_ITBR'),
    rate('2026-02-15', '84.1000', 'SBI_ITBR'),
    rate('2025-08-14', '83.6800', 'RBI_REFERENCE'),
    rate('2025-12-24', '83.9100', 'ECB'),
  ]) {
    RateStore.put(record);
  }
}
