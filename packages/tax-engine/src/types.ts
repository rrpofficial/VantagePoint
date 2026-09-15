/** Tax engine types. Types only — no runtime behaviour. */
import type {
  AssessmentYear,
  Currency,
  FinancialYear,
  IsoDate,
  Money,
  Percentage,
  Quarter,
} from '@vantagepoint/shared-kernel';
import type { AssetClass, ExitTransaction, MfTaxCharacter, TaxSubject } from '@vantagepoint/core-domain';

export type TaxRegime = 'OLD_REGIME' | 'NEW_REGIME';
export type GainKind = 'STCG' | 'LTCG' | 'VDA_GAIN' | 'SLAB';

export interface SlabBand {
  readonly upTo: string | null;
  readonly ratePct: Percentage;
}

export interface SurchargeBand {
  readonly above: string;
  readonly ratePct: Percentage;
}

export interface TaxRuleSet {
  readonly status?: RuleSetStatus;
  readonly provisionalNote?: string;
  readonly financialYear: FinancialYear;
  readonly slabs: Readonly<Record<TaxRegime, readonly SlabBand[]>>;
  readonly standardDeduction: Readonly<Record<TaxRegime, Money>>;
  readonly surchargeBands: readonly SurchargeBand[];
  readonly surchargeCapOnCapitalGainsPct: Percentage;
  readonly cessPct: Percentage;
  readonly ltcgExemptionLimit: Money;
  readonly ltcgRatePct: Percentage;
  readonly stcgListedEquityRatePct: Percentage;
  readonly vdaRatePct: Percentage;
  readonly holdingPeriodMonths: Readonly<Partial<Record<AssetClass, number>>>;
  readonly mutualFundEquityBands?: { readonly equityOrientedMinPct: number; readonly debtOrientedMaxPct: number };
  readonly hniIncomeThreshold: Money;
  readonly hniNetWorthThreshold: Money;
  readonly scheduleAlIncomeThreshold: Money;
}

export interface IncomeProfile {
  readonly financialYear: FinancialYear;
  readonly assessmentYear: AssessmentYear;
  readonly grossSalary: Money;
  readonly exemptAllowances: Money;
  readonly chapterViaDeductions: Money;
  readonly housePropertyIncome: Money;
  readonly otherSourcesIncome: Money;
  readonly tdsRemitted: Money;
  readonly tcsCollected: Money;
}

export interface Form16 {
  readonly partA: {
    readonly quarterlyTds: readonly { readonly quarter: Quarter; readonly amount: Money }[];
    readonly totalTds: Money;
    readonly panRef: string;
    readonly tanRef: string;
  };
  readonly partB: {
    readonly grossSalary: Money;
    readonly exemptAllowances: Money;
    readonly chapterViaDeductions: Money;
    readonly totalTds: Money;
  };
}

export interface TraceLine {
  readonly label: string;
  readonly ruleRef: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly amount: Money;
}

export interface TaxComputation {
  readonly regime: TaxRegime;
  readonly totalIncome: Money;
  readonly baseTax: Money;
  readonly capitalGainsTax: Money;
  readonly surcharge: Money;
  readonly marginalRelief: Money;
  readonly cess: Money;
  readonly totalLiability: Money;
  readonly trace: readonly TraceLine[];
}

export interface RegimeComparison {
  readonly old: TaxComputation;
  readonly new: TaxComputation;
  readonly recommended: TaxRegime;
  readonly deductionsForgone: readonly string[];
}

export interface ClassifiedGain {
  readonly txnId: string;
  readonly assetClass: AssetClass;
  readonly taxCharacter?: MfTaxCharacter;
  readonly kind: GainKind;
  readonly holdingPeriodDays: number;
  readonly gain: Money;
  readonly ratePct: Percentage;
}

/**
 * A disposal whose INR value could not be established, and is therefore ABSENT
 * from every total below.
 *
 * Reported rather than approximated. Rule 115 needs the TT buy rate for a
 * specific month-end, and if no rate is available for it there is no honest
 * figure to produce — the previous behaviour passed the foreign-currency amount
 * through, which the totals then summed as rupees.
 */
export interface UnconvertibleGain {
  readonly txnId: string;
  readonly currency: Currency;
  readonly exitDate: IsoDate;
  readonly reason: string;
}

/**
 * A disposal left out of the totals because it was a sell-to-cover and the
 * taxpayer has chosen not to charge those.
 *
 * **The amount is reported, because it is frequently not small.** The reasoning
 * that makes the exclusion look harmless — "sold same-day at the vest price, so
 * the gain is a rounding error" — holds under US specific-lot matching, where the
 * sale is matched to the shares that just vested. Indian law matches FIFO, so a
 * sell-to-cover disposes of the OLDEST lot held, which may have vested years
 * earlier at a fraction of today's price. In a real file a sell-to-cover of 10
 * units nominally covering a $200 vest was matched to a 2021 lot costing $150
 * and sold at $201: a $510 gain, not a rounding error.
 *
 * So this carries what was actually left out, and every screen showing a gain
 * total must show it too.
 */
export interface ExcludedDisposal {
  readonly txnId: string;
  readonly exitDate: IsoDate;
  /**
   * The taxable gain that was NOT charged, in INR.
   *
   * Absent only when no exchange rate could be resolved for it — in which case
   * the amount is unknown rather than zero, and must not be read as nil.
   */
  readonly gainInr?: Money;
  /**
   * True when the acquisition and the sale fall either side of a month end, so
   * the two Rule 115 legs convert at different rates. Under FIFO this is common
   * even for a same-day sell-to-cover, because the lot it was matched to is
   * rarely the one that just vested.
   */
  readonly straddlesBasisMonths: boolean;
}

export interface CapitalGainsOptions {
  /** Charge sell-to-cover disposals to capital gains. Default false. */
  readonly includeSellToCover?: boolean;
}

export interface CapitalGainsResult {
  readonly gains: readonly ClassifiedGain[];
  readonly ltcgBeforeExemption: Money;
  readonly ltcgExemptionApplied: Money;
  readonly taxableLtcg: Money;
  readonly taxableStcg: Money;
  readonly tax: Money;
  /**
   * Non-empty means the totals are INCOMPLETE. Callers must surface this beside
   * the figure; a filing artifact must refuse outright.
   */
  readonly unconvertible: readonly UnconvertibleGain[];
  /**
   * Sell-to-cover disposals omitted from every total above. Non-empty means the
   * figures reflect a position the taxpayer took, which a filing artifact must
   * state rather than imply.
   */
  readonly excludedSellToCover: readonly ExcludedDisposal[];
}

export interface AdvanceTaxInstallment {
  readonly capitalGains?: CapitalGainsResult;
  readonly trace?: readonly TraceLine[];
  readonly quarter: Quarter;
  readonly dueDate: IsoDate;
  readonly cumulativePercentage: Percentage;
  readonly totalLiability: Money;
  readonly cumulativeRequired: Money;
  readonly tdsCredit: Money;
  readonly alreadyPaid: Money;
  readonly netPayable: Money;
}

export interface HniClassification {
  readonly isHni: boolean;
  readonly reason: 'INCOME_ABOVE_50L' | 'NET_WORTH_ABOVE_10CR' | 'NOT_HNI';
  readonly scheduleAlRequired: boolean;
}

/** Provisional rule sets compute but cannot produce filing artifacts (US-5.2). */
export type RuleSetStatus = 'PROVISIONAL' | 'VERIFIED';

export interface SurchargeInput {
  readonly baseTax: Money;
  readonly capitalGainsTax: Money;
  readonly totalIncome: Money;
  readonly rules: TaxRuleSet;
  /** Tax due at exactly the surcharge threshold; enables exact marginal relief. */
  readonly taxAtThreshold?: Money;
  /** Used to derive the above when it is not supplied. */
  readonly topMarginalRatePct?: Percentage;
}

export interface SurchargeResult {
  readonly surcharge: Money;
  readonly marginalRelief: Money;
  readonly cess: Money;
  readonly total: Money;
  readonly trace: readonly TraceLine[];
}

export interface HniInput {
  readonly totalIncome: Money;
  readonly netWorth: Money;
  readonly rules: TaxRuleSet;
}

export interface AdvanceTaxInput {
  readonly financialYear: FinancialYear;
  readonly quarter: Quarter;
  readonly income: IncomeProfile;
  readonly exits: readonly ExitTransaction[];
  readonly assetClasses: Readonly<Record<string, AssetClass | TaxSubject>>;
  readonly alreadyPaid: Money;
  readonly rules: TaxRuleSet;
  readonly regime?: TaxRegime;
  /**
   * Charge sell-to-cover disposals. Default false — the taxpayer's position,
   * carried here so an instalment reflects the same choice the year-end figure
   * will. An instalment computed on one basis and a return filed on another is a
   * shortfall that only surfaces at assessment.
   */
  readonly includeSellToCover?: boolean;
}
