/**
 * core-domain — asset lifecycle, FIFO allocation, corporate actions, accruals and
 * valuation. Pure: no I/O, no ambient clock. Time, prices and FX arrive as ports.
 */
import {
  Err,
  Ok,
  UnsupportedAssetClassError,
  type Currency,
  type Result,
} from '@porttrack/shared-kernel';
import {
  allocateFifo,
  recordAcquisition,
  restoreAllocations,
  totalCostBasis,
} from './lots.js';
import { applyCorporateAction } from './corporate-actions.js';
import {
  depositAccruedValue,
  epfProjection,
  gratuity,
  handLoanAccruedInterest,
  handLoanOutstandingPrincipal,
  recurringContributions,
} from './accruals.js';
import { recordDividend, recordInterest } from './income.js';
import { value as valuePortfolio, valueNow } from './valuation.js';
import { ALL_ASSET_CLASSES, JURISDICTION, LIQUIDITY, isAssetClass } from './taxonomy.js';
import { register as loanRegister, totalsOf as loanTotalsOf, viewOf as loanViewOf } from './loan-book.js';
import { toCsv as loanToCsv, toPdf as loanToPdf } from './loan-export.js';
import type { Asset, AssetClass, Jurisdiction } from './types.js';

export * from './types.js';
export {
  ALL_ASSET_CLASSES,
  JURISDICTION,
  LIQUIDITY,
  isAssetClass,
} from './taxonomy.js';
export { days30360, yearFraction, monthsBetween, addCalendarDays } from './daycount.js';
export {
  register as loanRegister,
  viewOf as loanViewOf,
  sortViews as sortLoanViews,
  totalsOf as loanTotalsOf,
  matches as loanMatches,
  type LoanFilter,
  type LoanRegister,
  type LoanSortKey,
  type LoanStatus,
  type LoanTotals,
  type LoanView,
  type SortDirection,
} from './loan-book.js';
export {
  ChitLedger,
  register as chitRegister,
  viewOf as chitViewOf,
  totalsOf as chitTotalsOf,
  sortViews as sortChitViews,
  withdrawalAmountFor as chitWithdrawalAmountFor,
  type ChitEmi,
  type ChitEmiType,
  type ChitFilter,
  type ChitFund,
  type ChitRegister,
  type ChitSortKey,
  type ChitStatus,
  type ChitTotals,
  type ChitView,
  type ChitWithdrawalSchedule,
} from './chit-book.js';
export {
  applyEdit as applyLoanEdit,
  duplicatesOf as loanDuplicatesOf,
  type LoanAuditAction,
  type LoanAuditEntry,
  type LoanEdit,
} from './loan-audit.js';
export {
  DEFAULT_EQUITY_BANDS,
  taxCharacterFor,
  taxCharacterOf,
  type EquityBands,
} from './mf-tax-character.js';
export { HOLDING_BUCKETS, bucketOf, type AssetBucket } from './asset-bucket.js';

let assetCounter = 0;

/** US-1.1 — asset taxonomy and registration. */
export const AssetRegistry = {
  jurisdictionOf(assetClass: AssetClass): Jurisdiction {
    if (!isAssetClass(assetClass)) {
      throw new UnsupportedAssetClassError(`unknown asset class "${String(assetClass)}"`);
    }
    return JURISDICTION[assetClass];
  },

  register(input: { assetClass: string; currency: Currency }): Result<Asset> {
    if (!isAssetClass(input.assetClass)) {
      // Rejected at the boundary so no partial record is ever created.
      return Err(new UnsupportedAssetClassError(`unsupported asset class "${input.assetClass}"`));
    }
    const assetClass = input.assetClass;
    const liquidity = LIQUIDITY[assetClass];
    return Ok({
      assetId: `ast_${assetClass.toLowerCase()}_${String(++assetCounter).padStart(4, '0')}`,
      assetClass,
      jurisdiction: JURISDICTION[assetClass],
      currency: input.currency,
      lots: [],
      incomeEvents: [],
      corporateActions: [],
      ...(liquidity === undefined ? {} : { liquidity }),
    });
  },

  allClasses: () => ALL_ASSET_CLASSES,
};

/** US-1.2 — acquisition lots and cost basis. */
export const LotBook = { recordAcquisition, totalCostBasis };

/** US-1.3 — FIFO lot allocation, and its reversal when a disposal is deleted. */
export const FifoAllocator = { allocate: allocateFifo, restore: restoreAllocations };

/** US-1.6 — splits, bonuses, mergers, demergers. */
export const CorporateActionEngine = { apply: applyCorporateAction };

/** US-1.5 — dividend and interest events. */
export const IncomeLedger = { recordDividend, recordInterest };

/** US-1.8, US-1.9, US-1.11, US-1.12 — interest accrual. */
export const AccrualEngine = {
  handLoanAccruedInterest,
  handLoanOutstandingPrincipal,
  depositAccruedValue,
  recurringContributions,
  epfProjection,
  gratuity,
};

/** US-1.7, US-1.15 — portfolio valuation. */
export const ValuationEngine = { value: valuePortfolio, valueNow };

/** US-1.11 — the hand-loan register: status, accrual, filtering, totals. */
export const HandLoanLedger = {
  register: loanRegister,
  viewOf: loanViewOf,
  totalsOf: loanTotalsOf,
};

/** Requirement 5 — the register as a CSV or PDF the borrower can read. */
export const LoanExporter = { toCsv: loanToCsv, toPdf: loanToPdf };
