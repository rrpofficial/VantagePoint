/** Domain types for the asset ledger. Types only — no runtime behaviour. */
import type {
  Currency,
  IsoDate,
  IsoDateTime,
  Money,
  Percentage,
  Quantity,
  Rate,
} from '@porttrack/shared-kernel';
// Type-only in both directions (chit-book imports PaymentMode from here), so the
// cycle is erased at compile time and never exists at runtime.
import type { ChitFund } from './chit-book.js';

export type AssetClass =
  | 'DOMESTIC_EQUITY'
  | 'DOMESTIC_ETF'
  | 'DOMESTIC_MUTUAL_FUND'
  | 'FOREIGN_EQUITY'
  | 'FOREIGN_ETF'
  | 'RSU'
  | 'ESPP'
  | 'EPF'
  | 'VPF'
  | 'NPS_TIER_I'
  | 'NPS_TIER_II'
  | 'PPF'
  | 'GRATUITY'
  | 'FIXED_DEPOSIT'
  | 'RECURRING_DEPOSIT'
  | 'REAL_ESTATE'
  | 'UNLISTED_SHARES'
  | 'CRYPTO'
  | 'GOLD_PHYSICAL'
  | 'GOLD_DIGITAL'
  | 'SGB'
  | 'CASH_IN_HAND'
  | 'BANK_BALANCE'
  | 'HAND_LOAN'
  | 'CHIT_FUND';

export type Jurisdiction = 'DOMESTIC' | 'FOREIGN';

/**
 * SEBI-style scheme category. This is what a user recognises and what a CAS
 * import can populate; it is presentational and drives no tax logic directly.
 */
export type MfSchemeCategory =
  | 'EQUITY'
  | 'DEBT'
  | 'HYBRID'
  | 'LIQUID'
  | 'ARBITRAGE'
  | 'SOLUTION_ORIENTED';

/**
 * How a mutual fund is TREATED for capital gains — derived, never chosen.
 *
 * Kept separate from the scheme category because the two genuinely diverge, and
 * the divergence is the whole point: an arbitrage fund behaves like cash but is
 * taxed as equity, because it holds enough equity to qualify. A user shown
 * "Arbitrage" beside "Debt" would reasonably assume debt treatment and be wrong.
 */
export type MfTaxCharacter = 'EQUITY_ORIENTED' | 'DEBT_ORIENTED' | 'HYBRID_MID_BAND';
export type Liquidity = 'LIQUID' | 'LOCKED_UNTIL_60' | 'LOCKED' | 'ILLIQUID';
export type RateSource = 'SBI_ITBR' | 'RBI_REFERENCE' | 'ECB' | 'OANDA' | 'MANUAL';

/** Both rates a foreign transaction must carry (ADR-003). */
export interface DualRate {
  /** Trade-date ITBR — drives portfolio display and net worth. */
  readonly valuationRate: Rate;
  /** Rule 115 rate (last day of preceding month) — drives taxable income. */
  readonly taxRate: Rate;
  readonly valuationRateSource: RateSource;
  readonly taxRateSource: RateSource;
  readonly isFallback: boolean;
  readonly fallbackNote?: string;
}

export interface AcquisitionLot {
  readonly lotId: string;
  readonly acquisitionDate: IsoDate;
  readonly settlementDate: IsoDate;
  readonly quantity: Quantity;
  readonly remainingQuantity: Quantity;
  readonly costPerUnit: Money;
  readonly fees: Money;
  readonly stt: Money;
  readonly otherCharges: Money;
  readonly fx?: DualRate;
  /** 31-Jan-2018 fair market value for grandfathering (OQ-4). */
  readonly grandfatheredFmv?: Money;
  /** ESPP discount / RSU vest value taxable as a perquisite. */
  readonly perquisiteValue?: Money;
  readonly isBonus?: boolean;
}

export interface LotAllocation {
  readonly lotId: string;
  readonly quantity: Quantity;
  readonly costPerUnit: Money;
  /** Carried from the lot so a gain can be classified without re-reading it. */
  readonly acquisitionDate?: IsoDate;
  /** 31-Jan-2018 fair market value, for grandfathering (OQ-4). */
  readonly grandfatheredFmv?: Money;
}

export interface ExitTransaction {
  readonly txnId: string;
  readonly assetId: string;
  readonly exitDate: IsoDate;
  /**
   * Acquisition date of the holding sold. Present on every exit: a holding period
   * needs both endpoints, and long-term vs short-term turns on it.
   */
  readonly acquisitionDate?: IsoDate;
  readonly quantity: Quantity;
  readonly pricePerUnit: Money;
  readonly fees: Money;
  readonly stt: Money;
  readonly allocations: readonly LotAllocation[];
  readonly fx?: DualRate;
  readonly valuationInr?: Money;
  readonly taxableInr?: Money;
}

export type IncomeEventKind =
  | 'DIVIDEND_DOMESTIC'
  | 'DIVIDEND_FOREIGN'
  | 'INTEREST'
  | 'INTEREST_ACCRUED'
  | 'REINVESTMENT';

export interface IncomeEvent {
  readonly eventId: string;
  readonly assetId: string;
  readonly kind: IncomeEventKind;
  readonly date: IsoDate;
  readonly grossAmount: Money;
  readonly taxWithheld: Money;
  readonly netAmount: Money;
  readonly withholdingRatePct?: Percentage;
  readonly eligibleForForeignTaxCredit: boolean;
  readonly taxableInr?: Money;
}

export type CorporateActionKind = 'SPLIT' | 'BONUS' | 'MERGER' | 'DEMERGER';

export interface CorporateAction {
  readonly actionId: string;
  readonly assetId: string;
  readonly kind: CorporateActionKind;
  readonly recordDate: IsoDate;
  /** e.g. 1:5 split → { from: '1', to: '5' }. */
  readonly ratio: { readonly from: string; readonly to: string };
}

export interface Asset {
  readonly assetId: string;
  readonly assetClass: AssetClass;
  readonly jurisdiction: Jurisdiction;
  readonly currency: Currency;
  readonly symbol?: string;
  readonly isin?: string;
  /** Opaque handle; the raw folio never appears in an AI payload. */
  readonly folioRef?: string;
  readonly lots: readonly AcquisitionLot[];
  readonly incomeEvents: readonly IncomeEvent[];
  readonly corporateActions: readonly CorporateAction[];
  readonly liquidity?: Liquidity;
  readonly positionClosed?: boolean;
  /** Present only for HAND_LOAN assets. */
  readonly handLoan?: HandLoan;
  /** Present only for CHIT_FUND assets. */
  readonly chitFund?: ChitFund;
  /** Present only for DOMESTIC_MUTUAL_FUND assets. */
  readonly schemeCategory?: MfSchemeCategory;
  /** Equity allocation, required to place a HYBRID scheme. */
  readonly equityAllocationPct?: Percentage;
}

/** What the capital gains engine needs to know about a holding. */
export interface TaxSubject {
  readonly assetClass: AssetClass;
  readonly schemeCategory?: MfSchemeCategory;
  readonly equityAllocationPct?: Percentage;
}

export interface Liability {
  readonly liabilityId: string;
  readonly kind: 'HOME_LOAN' | 'PERSONAL_LOAN' | 'MORTGAGE' | 'OTHER';
  readonly principalOutstanding: Money;
  readonly interestRatePct: Percentage;
  readonly asOf: IsoDate;
}

/** How a payment reached the lender. Recorded because it is what a dispute turns on. */
export type PaymentMode = 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'CHEQUE' | 'OTHER';

export interface LoanPayment {
  readonly paymentId: string;
  readonly date: IsoDate;
  readonly amount: Money;
  readonly mode: PaymentMode;
  readonly notes?: string;
}

/** A repayment of principal. Interest accrues only on what remains after it. */
export interface PrincipalRepayment {
  readonly date: IsoDate;
  readonly principal: Money;
  readonly paymentId?: string;
  readonly mode?: PaymentMode;
  readonly notes?: string;
}

export interface HandLoan {
  readonly assetId: string;
  /** Masked reference; resolving it requires the local vault. */
  readonly borrowerRef: string;
  /**
   * The borrower's actual name, held ONLY in the encrypted vault.
   *
   * Filtering and sorting a loan register by borrower requires it, so it cannot
   * stay hashed. Everything that leaves this machine — exports, AI payloads —
   * carries `borrowerRef` instead; this field must never be substituted for it.
   */
  readonly borrowerName?: string;
  readonly principal: Money;
  readonly interestRatePct: Percentage;
  readonly interestBasis: 'SIMPLE' | 'COMPOUND';
  readonly startDate: IsoDate;
  readonly repayments: readonly PrincipalRepayment[];
  /**
   * Interest received. Kept separate from principal repayments because paying
   * interest does not reduce what is owed, and treating the two alike would
   * quietly write off principal.
   */
  readonly interestPayments?: readonly LoanPayment[];
  /** Free text: the circumstances of the loan, as the spreadsheet recorded them. */
  readonly notes?: string;
  /**
   * When the lender considers the loan closed. Distinct from "principal fully
   * repaid": interest can still be outstanding after the principal is settled,
   * which is precisely the case the register has to keep visible.
   */
  readonly closedDate?: IsoDate;
}

export interface ValuedPosition {
  readonly assetId: string;
  readonly assetClass: AssetClass;
  readonly jurisdiction: Jurisdiction;
  readonly quantity: Quantity;
  readonly marketValue: Money;
  readonly costBasis: Money;
  readonly navSource?: 'PUBLISHED' | 'LAST_PUBLISHED';
  readonly liquidity?: Liquidity;
  /**
   * Value in the holding's own currency and the rate used to reach INR. Set for
   * every non-INR position so a later comparison can separate price movement from
   * currency movement (US-3.7). Without these carried here, the snapshot layer has
   * nothing to attribute and reports only a combined INR delta.
   */
  readonly nativeValue?: Money;
  readonly fxRate?: Rate;
}

export interface PortfolioValuation {
  readonly asOf: IsoDateTime;
  readonly positions: readonly ValuedPosition[];
  readonly grossAssets: Money;
  readonly totalLiabilities: Money;
  readonly netWorth: Money;
  readonly byAssetClass: Readonly<Partial<Record<AssetClass, Money>>>;
}

/* ------------------------------------------------------- engine input types */

export interface RecordAcquisitionInput {
  readonly assetClass: AssetClass;
  readonly tradeDate: IsoDate;
  readonly settlementDate?: IsoDate;
  readonly quantity: Quantity;
  readonly pricePerUnit: Money;
  readonly fees?: Money;
  readonly stt?: Money;
  readonly otherCharges?: Money;
  readonly fx?: DualRate;
  readonly grandfatheredFmv?: Money;
  readonly perquisiteValue?: Money;
  /** Fair market value per unit at vest/purchase; drives the ESPP discount. */
  readonly fmvPerUnit?: Money;
  readonly lotId?: string;
}

export interface RecordDividendInput {
  readonly assetId: string;
  readonly date: IsoDate;
  readonly grossAmount: Money;
  /** Foreign dividends: treaty withholding rate. Mutually exclusive with taxWithheld. */
  readonly withholdingRatePct?: Percentage;
  /** Domestic dividends: absolute TDS deducted. */
  readonly taxWithheld?: Money;
}

export interface RecordInterestInput {
  readonly assetId: string;
  readonly date: IsoDate;
  readonly grossAmount: Money;
  readonly taxWithheld?: Money;
}

export interface DepositInput {
  readonly principal: Money;
  readonly annualRatePct: Percentage;
  readonly compounding: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  readonly startDate: IsoDate;
  readonly asOf: IsoDate;
}

export interface DepositResult {
  readonly value: Money;
  readonly accruedInterest: Money;
}

export interface EpfInput {
  readonly openingBalance: Money;
  readonly monthlyEmployee: Money;
  readonly monthlyEmployer: Money;
  readonly annualRatePct: Percentage;
  readonly fromDate: IsoDate;
  readonly toDate: IsoDate;
}

export interface EpfResult {
  readonly closingBalance: Money;
  readonly contributions: Money;
  readonly interest: Money;
}

export interface GratuityInput {
  readonly lastDrawnMonthly: Money;
  readonly completedYears: number;
}

/* ------------------------------------------------------------------- ports */

export interface PriceQuote {
  readonly price: Money;
  /** LAST_PUBLISHED when the valuation date had no published price (US-1.7). */
  readonly source: 'PUBLISHED' | 'LAST_PUBLISHED';
}

/**
 * Market price lookup. Injected so the domain stays pure and so 1,000 lots resolve
 * from memory rather than 1,000 round trips (NFR-2). Returning undefined means
 * "no market price" — the position is then valued at cost.
 */
export interface PriceSource {
  priceFor(query: {
    assetId: string;
    assetClass: AssetClass;
    asOf: IsoDate;
    isin?: string;
    symbol?: string;
  }): PriceQuote | undefined;
}

/** Currency conversion for valuation. Tax conversion uses Rule 115 instead (ADR-003). */
export interface FxSource {
  rateFor(currency: Currency, asOf: IsoDate): Rate | undefined;
}

export interface ValuationInput {
  readonly assets: readonly Asset[];
  readonly liabilities: readonly Liability[];
  readonly asOf: IsoDateTime;
  readonly prices?: PriceSource;
  readonly fx?: FxSource;
}
