/** Compliance types. Types only — no runtime behaviour. */
import type { AssessmentYear, IsoDate, Money, Rate } from '@vantagepoint/shared-kernel';
import type { Snapshot } from '@vantagepoint/snapshot';

export interface PeakValue {
  readonly peakNative: Money;
  readonly peakInr: Money;
  readonly peakDate: IsoDate;
}

export interface ScheduleFaA3Row {
  readonly countryCode: string;
  readonly entityName: string;
  readonly address: string;
  readonly natureOfEntity: string;
  readonly acquisitionDate: IsoDate;
  readonly initialInvestmentInr: Money;
  readonly peakValueInr: Money;
  readonly peakValueNative: Money;
  readonly closingValueInr: Money;
  readonly grossDividendInr: Money;
  readonly grossProceedsInr: Money;
}

export interface ScheduleFaDRow {
  readonly countryCode: string;
  readonly institutionName: string;
  /** Masked reference, never the raw account number. */
  readonly accountRef: string;
  readonly accountOpenDate: IsoDate;
  readonly peakBalanceInr: Money;
  readonly closingBalanceInr: Money;
}

export interface ScheduleAlSection {
  readonly head: string;
  readonly items: readonly ScheduleAlItem[];
  readonly total: Money;
}

export interface ScheduleAl {
  readonly assessmentYear: AssessmentYear;
  readonly required: boolean;
  readonly notRequiredReason?: string;
  readonly immovableProperty: ScheduleAlSection;
  readonly financialAssets: ScheduleAlSection;
  readonly cashInHand: ScheduleAlSection;
  readonly loansAndAdvancesGiven: ScheduleAlSection;
  readonly jewellery: ScheduleAlSection;
  readonly vehicles: ScheduleAlSection;
  readonly liabilities: ScheduleAlSection;
}

/** A foreign holding as Schedule FA Table A3 needs to see it. */
export interface ForeignHoldingDisclosure {
  readonly assetId: string;
  readonly countryCode: string;
  readonly entityName: string;
  readonly address: string;
  readonly natureOfEntity: string;
  readonly acquisitionDate: IsoDate;
  readonly initialInvestment: Money;
  readonly dailyQuantities: ReadonlyMap<IsoDate, string>;
  readonly dailyPrices: ReadonlyMap<IsoDate, Money>;
  readonly dailyRates: ReadonlyMap<IsoDate, Rate>;
  readonly closingValueNative: Money;
  readonly closingRate: Rate;
  readonly grossDividend: Money;
  readonly grossProceeds: Money;
}

/** A foreign bank or custodial account, for Table D. */
export interface ForeignAccountDisclosure {
  readonly countryCode: string;
  readonly institutionName: string;
  /** Raw; masked to an opaque reference before it reaches a row. */
  readonly accountNumber: string;
  readonly accountOpenDate: IsoDate;
  readonly peakBalance: Money;
  readonly closingBalance: Money;
  readonly closingRate: Rate;
}

export interface ScheduleFaInput {
  readonly foreignSnapshot: Snapshot;
  /** CALENDAR year, not financial year — Schedule FA runs 1 Jan to 31 Dec. */
  readonly calendarYear: number;
  readonly holdings?: readonly ForeignHoldingDisclosure[];
  readonly accounts?: readonly ForeignAccountDisclosure[];
}

export type ScheduleAlHead =
  | 'IMMOVABLE_PROPERTY'
  | 'FINANCIAL_ASSETS'
  | 'CASH_IN_HAND'
  | 'LOANS_AND_ADVANCES'
  | 'JEWELLERY'
  | 'VEHICLES'
  | 'LIABILITIES';

export interface ScheduleAlItem {
  readonly head: ScheduleAlHead;
  readonly description: string;
  /** Cost of acquisition — never market value (FR-6.2). */
  readonly costOfAcquisition: Money;
}

export interface ScheduleAlInput {
  readonly domesticSnapshot: Snapshot;
  readonly totalIncome: Money;
  readonly assessmentYear: AssessmentYear;
  readonly items?: readonly ScheduleAlItem[];
  readonly threshold?: Money;
}
