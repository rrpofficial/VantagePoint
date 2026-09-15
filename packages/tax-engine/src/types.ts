/** Tax engine types. Types only — no runtime behaviour. */
import type {
  AssessmentYear,
  Currency,
  FinancialYear,
  IsoDate,
  Money,
  Percentage,
  Quarter,
} from '@porttrack/shared-kernel';
import type { AssetClass, ExitTransaction, MfTaxCharacter, TaxSubject } from '@porttrack/core-domain';

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
}
