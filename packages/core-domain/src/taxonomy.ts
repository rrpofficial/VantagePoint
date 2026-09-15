/**
 * Asset taxonomy (US-1.1, PRD FR-1.1).
 *
 * Jurisdiction is derived, never chosen by the user: it decides whether a holding
 * lands in the 31-Mar domestic compliance snapshot or the 31-Dec foreign one, and
 * getting that wrong is a Schedule FA disclosure failure.
 *
 * The map is exhaustive over `AssetClass` by construction — adding a class without
 * a jurisdiction is a compile error, which is the point.
 */
import type { AssetClass, Jurisdiction, Liquidity } from './types.js';

export const JURISDICTION: Readonly<Record<AssetClass, Jurisdiction>> = {
  DOMESTIC_EQUITY: 'DOMESTIC',
  DOMESTIC_ETF: 'DOMESTIC',
  DOMESTIC_MUTUAL_FUND: 'DOMESTIC',
  FOREIGN_EQUITY: 'FOREIGN',
  FOREIGN_ETF: 'FOREIGN',
  EPF: 'DOMESTIC',
  VPF: 'DOMESTIC',
  NPS_TIER_I: 'DOMESTIC',
  NPS_TIER_II: 'DOMESTIC',
  PPF: 'DOMESTIC',
  GRATUITY: 'DOMESTIC',
  FIXED_DEPOSIT: 'DOMESTIC',
  RECURRING_DEPOSIT: 'DOMESTIC',
  REAL_ESTATE: 'DOMESTIC',
  UNLISTED_SHARES: 'DOMESTIC',
  CRYPTO: 'DOMESTIC',
  GOLD_PHYSICAL: 'DOMESTIC',
  GOLD_DIGITAL: 'DOMESTIC',
  SGB: 'DOMESTIC',
  CASH_IN_HAND: 'DOMESTIC',
  BANK_BALANCE: 'DOMESTIC',
  HAND_LOAN: 'DOMESTIC',
  CHIT_FUND: 'DOMESTIC',
};

/**
 * Liquidity classification. Locked holdings still count towards net worth and
 * Schedule AL — they are flagged, not excluded.
 */
export const LIQUIDITY: Readonly<Partial<Record<AssetClass, Liquidity>>> = {
  NPS_TIER_I: 'LOCKED_UNTIL_60',
  EPF: 'LOCKED',
  VPF: 'LOCKED',
  PPF: 'LOCKED',
  GRATUITY: 'LOCKED',
  REAL_ESTATE: 'ILLIQUID',
  UNLISTED_SHARES: 'ILLIQUID',
  CHIT_FUND: 'ILLIQUID',
  HAND_LOAN: 'ILLIQUID',
};

/** Default settlement lag in calendar days, by asset class. */
export const SETTLEMENT_LAG_DAYS: Readonly<Partial<Record<AssetClass, number>>> = {
  DOMESTIC_EQUITY: 1,
  DOMESTIC_ETF: 1,
  DOMESTIC_MUTUAL_FUND: 1,
  FOREIGN_EQUITY: 2,
  FOREIGN_ETF: 2,
};

export const ALL_ASSET_CLASSES = Object.keys(JURISDICTION) as readonly AssetClass[];

export function isAssetClass(value: string): value is AssetClass {
  return Object.hasOwn(JURISDICTION, value);
}
