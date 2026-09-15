/** Domain types for the asset ledger. Types only — no runtime behaviour. */
import type {
  Currency,
  IsoDate,
  IsoDateTime,
  Money,
  Percentage,
  Quantity,
  Rate,
} from '@vantagepoint/shared-kernel';
// Type-only in both directions (chit-book imports PaymentMode from here), so the
// cycle is erased at compile time and never exists at runtime.
import type { ChitFund } from './chit-book.js';

export type AssetClass =
  | 'DOMESTIC_EQUITY'
  | 'DOMESTIC_ETF'
  | 'DOMESTIC_MUTUAL_FUND'
  /*
   * Covers equity compensation too. RSU and ESPP were once asset classes of
   * their own, which split one company's shares across two holdings: the same
   * symbol bought outright and received as an RSU became two assets, double
   * counted on screen and — worse — matched FIFO in two separate queues, when
   * the law treats them as one pool of one security.
   *
   * They were identical to this class in every tax dimension anyway: same
   * 24-month holding period, same jurisdiction, same settlement lag, same
   * bucket. How a tranche was acquired now lives on the lot, as `equityAward`.
   */
  | 'FOREIGN_EQUITY'
  | 'FOREIGN_ETF'
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

/**
 * Where an equity-compensation lot came from: the grant, and the event that
 * turned part of that grant into shares.
 *
 * Three levels, because the broker's own data has three:
 *
 *   grant   →  many vests / purchases  →  many sell orders
 *
 * One grant vests in tranches over years; one tranche is commonly sold across
 * several orders (a sell-to-cover on vest day, a manual sale later). A real
 * E*TRADE export shows 33 disposal rows resolving to 28 tranches from 5 grants.
 *
 * **This is what makes a lot identifiable across FILES.** Lot ids were derived
 * from the source file name and row number, so the same vest read from a Gains &
 * Losses export and from a holdings export produced two different ids, and
 * deduplication fell back to matching quantity and price — which breaks on a
 * cent of rounding. A grant reference plus the acquisition date is stable
 * wherever it is read from.
 */
/**
 * How shares of an equity-compensation award came to be held.
 *
 * A property of the LOT, not of the asset. Once acquired, a share received as an
 * RSU and a share bought on the market are the same security: same holding
 * period, same rate, same FIFO pool. What differs is the acquisition — which
 * perquisite was charged and what the cost basis became — and that belongs to
 * the tranche, not to the holding.
 *
 * Every value here is grounded in a column of the E*TRADE exports this product
 * reads: `Plan Type` distinguishes RS from ESPP; `Exercise Date` and
 * `Grant Price` exist for options; `83(b) Election` applies to a restricted
 * stock AWARD rather than a unit; the unvested schedule carries
 * `Performance Metric`, `Target %` and `% Achieved` for performance awards.
 */
export type EquityAwardKind =
  /** Restricted stock unit — vests, FMV at vest is the perquisite and the basis. */
  | 'RSU'
  /** Employee share purchase plan — bought at a discount; the discount is the perquisite. */
  | 'ESPP'
  /** Exercised stock option — FMV at exercise less the exercise price. */
  | 'ESOP'
  /** Restricted stock award — issued up front, the 83(b) election applies to it. */
  | 'RSA'
  /** Performance share unit — vests on a metric rather than on time alone. */
  | 'PSU';

export interface EquityAward {
  readonly kind: EquityAwardKind;
  /**
   * The grant's own identifier.
   *
   * E*TRADE gives RSUs a `Grant Number`. ESPP rows carry no grant number, so the
   * offering's grant date stands in — see `grantDate`.
   */
  readonly grantRef: string;
  /** When the grant (RSU) or the offering period (ESPP) was made. */
  readonly grantDate?: IsoDate;
  /** RSU: when this tranche vested. Absent on ESPP, which does not vest. */
  readonly vestDate?: IsoDate;
  /** ESPP: when the shares were bought under the offering. Absent on RSU. */
  readonly purchaseDate?: IsoDate;
  /**
   * ESPP: what was actually PAID per share, after the plan discount.
   *
   * Kept beside `costPerUnit` rather than replacing it, because they differ and
   * only one of them is the cost basis. Section 49(2AA) sets the basis at fair
   * market value on the acquisition date; the discount below it was already
   * charged as a salary perquisite. Using the price paid would tax that discount
   * a second time.
   */
  readonly purchasePrice?: Money;
  /** ESPP: FMV less price paid — the per-share discount taxed as salary. */
  readonly discountPerUnit?: Money;
  /** Fair market value per share on the vest or purchase date: the cost basis. */
  readonly fmvAtAcquisition?: Money;
}

export interface AcquisitionLot {
  readonly lotId: string;
  /** Present on RSU and ESPP lots; absent on ordinary purchases. */
  readonly equityAward?: EquityAward;
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
  /**
   * What the BROKER says is still held of this tranche, when a holdings export
   * has stated it.
   *
   * Kept beside `remainingQuantity`, which the ledger derives by applying its own
   * disposals — deliberately not merged with it. The two disagreeing is the
   * single most useful fact a holdings import can produce: it means disposals
   * exist that were never imported, and no figure on screen can reveal that
   * otherwise, because every one of them is internally consistent and wrong.
   *
   * Stored on the lot rather than computed at import so the check stands
   * afterwards. An import-time comparison only fires on the import that happened
   * to carry the stated figure — load the holdings file first and the disposals
   * second, and nothing would ever be compared.
   */
  readonly statedRemainingQuantity?: Quantity;
  readonly isBonus?: boolean;
  /** Present on REAL_ESTATE lots: the duty and area detail of the purchase. */
  readonly property?: PropertyTransaction;
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

  /**
   * Why the shares left.
   *
   * `SELL_TO_COVER` is the block sold on vest day to fund the employer's
   * withholding. It is a genuine transfer and is recorded like any other — the
   * units must deplete the lot, and Schedule FA counts them — but whether it is
   * charged to capital gains is a position the taxpayer takes, not a fact, so it
   * is flagged here and filtered downstream rather than dropped at import.
   *
   * The gain on one is usually a rounding error, because the sale is same-day at
   * roughly the vest price. That holds only while both legs fall in the SAME
   * month: a vest on the 31st sold on the 1st takes Rule 115 basis rates a month
   * apart, and the taxable difference is then the whole proceeds times the rate
   * movement, not the few dollars of price movement.
   */
  readonly disposalKind?: 'SALE' | 'SELL_TO_COVER';
  /** The broker's own order identifier, where the source states one. */
  readonly orderRef?: string;
  /**
   * Which lot-identification convention produced this disposal's allocations.
   *
   * Recorded rather than assumed, because the two give different answers and a
   * filed figure should say which one it rests on. `SPECIFIC` means the source
   * named the tranche and it was matched to it; `FIFO` means oldest-first, the
   * convention CBDT Circular 768 prescribes for fungible demat holdings.
   */
  readonly lotMatching?: 'SPECIFIC' | 'FIFO';
  readonly fx?: DualRate;

  /*
   * ---------------------------------------------------------------------------
   * The rupee figures. FOUR of them, and the distinction between them is not
   * cosmetic — mixing two up misstates a tax liability by the whole cost basis.
   *
   * For a lot vested on d1 at vp$ and sold on d2 at sp$, quantity q:
   *
   *   valuationInr    = sp$ × q × rate(d2)              ← trade-date rate
   *   proceedsTaxInr  = sp$ × q × rate(month-end before d2)
   *   costBasisTaxInr = vp$ × q × rate(month-end before d1)
   *   taxableGainInr  = proceedsTaxInr − costBasisTaxInr
   *
   * Only the last is the figure tax is charged on. The first uses a DIFFERENT
   * rate from the other three (ADR-003) and must never reach a tax computation.
   * ---------------------------------------------------------------------------
   */

  /**
   * Gross proceeds at the rate on the SALE DAY ITSELF.
   *
   * Portfolio display only. Present so a holding's realised value reads
   * consistently with the rest of the portfolio, which is marked at trade-date
   * rates. **Never a tax figure** — Rule 115 names the preceding month-end, not
   * the transaction date, and these differ by real money.
   */
  readonly valuationInr?: Money;

  /** Gross proceeds at the Rule 115 rate for the month preceding the SALE. */
  readonly proceedsTaxInr?: Money;

  /**
   * Cost of the units sold, each allocation converted at the Rule 115 rate for
   * the month preceding ITS OWN acquisition.
   *
   * Summed per allocation rather than converted once, because one sale order
   * routinely consumes lots from several vests with basis months years apart.
   */
  readonly costBasisTaxInr?: Money;

  /**
   * `proceedsTaxInr − costBasisTaxInr`. The figure tax is charged on.
   *
   * Named for what it IS rather than for the rate that produced it. Its
   * predecessor was `taxableInr`, which sat beside `valuationInr` and read as
   * the same quantity at a second rate — so it was populated with converted
   * PROCEEDS at least once, while the capital-gains engine reads it as the
   * finished GAIN and returns it unchanged. That substitutes the whole sale
   * value for the profit, and the resulting number looks entirely ordinary.
   */
  readonly taxableGainInr?: Money;

  /**
   * Present on a REAL_ESTATE disposal: the duty and area detail of the sale.
   *
   * A sale carries duties too — the buyer usually pays stamp duty, but the
   * seller's brokerage and any TDS deducted under s.194-IA belong to this
   * transaction, and `stampDutyValue` on a sale is what s.50C substitutes for
   * the consideration when it is higher.
   */
  readonly property?: PropertyTransaction;
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
  /** Present only for REAL_ESTATE assets. */
  readonly property?: ImmovableProperty;
  /**
   * Present on a BALANCE-shaped holding — a deposit, a retirement scheme, cash
   * (Phase 5). One bag for ten asset classes rather than one per class: the
   * valuer registry dispatches on the bag, so a new balance kind adds a variant
   * here and nothing in `valuation.ts`.
   */
  readonly balanceAccount?: BalanceAccount;
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

/**
 * One advance-tax instalment actually paid.
 *
 * Instalments are cumulative, so every quarter after the first is computed net
 * of these. Recorded rather than inferred: the engine cannot know what reached
 * the exchequer, and assuming nothing did re-demands tax the taxpayer has
 * already remitted.
 */
export interface AdvanceTaxPayment {
  readonly paymentId: string;
  readonly financialYear: string;
  readonly quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  readonly amount: Money;
  readonly paidOn: IsoDate;
  /** The challan identifier — the taxpayer's evidence the payment happened. */
  readonly challanRef?: string;
  readonly notes?: string;
}

export type LiabilityKind =
  | 'HOME_LOAN'
  | 'PERSONAL_LOAN'
  | 'MORTGAGE'
  | 'VEHICLE_LOAN'
  | 'EDUCATION_LOAN'
  | 'LOAN_AGAINST_PROPERTY'
  | 'LOAN_AGAINST_SECURITIES'
  | 'GOLD_LOAN'
  | 'CREDIT_CARD'
  | 'OTHER';

/**
 * What net worth is reduced BY (ADR-009).
 *
 * Deliberately UNCHANGED in shape. `valuation.ts` and `al-items.ts` read exactly
 * these five fields, and Phase 3 added the schedule beside this rather than
 * through it — a borrowing now lives in `BorrowedLoan`, and `liabilityOf`
 * projects one of these from it at whatever date is being valued.
 *
 * Keeping the projection means the reducing balance reaches net worth without
 * either consumer learning what an EMI is.
 */
export interface Liability {
  readonly liabilityId: string;
  readonly kind: LiabilityKind;
  readonly principalOutstanding: Money;
  readonly interestRatePct: Percentage;
  readonly asOf: IsoDate;
}

export type BorrowedLoanStatus = 'ACTIVE' | 'CLOSED';

/**
 * Money BORROWED, with its contractual schedule and what was actually paid
 * against it (Phase 3, objectives 3 and 10).
 *
 * The mirror of `HandLoan`, and named so it can never be confused with one. The
 * two sit on opposite sides of net worth and in different Schedule AL sections,
 * and a sign error between them is the failure this separation exists to
 * prevent — a borrowing counted as an asset moves net worth by twice the loan.
 */
export interface BorrowedLoan {
  readonly loanId: string;
  readonly kind: LiabilityKind;
  /** Opaque handle; the lender's name never appears in an AI payload. */
  readonly lenderRef: string;
  /** The lender's actual name, held ONLY in the encrypted vault. */
  readonly lenderName?: string;
  readonly principal: Money;
  readonly interestRatePct: Percentage;
  readonly tenureMonths: number;
  readonly startDate: IsoDate;
  /** The lender's own EMI, where the borrower knows it. Preferred over computed. */
  readonly statedEmi?: Money;
  readonly payments: readonly LoanInstalment[];
  readonly status: BorrowedLoanStatus;
  readonly closedDate?: IsoDate;
  /** The asset this borrowing financed, where there is one. */
  readonly securedAgainstAssetId?: string;
  readonly accountRef?: string;
  readonly notes?: string;
}

/** One payment made against a borrowing. */
export interface LoanInstalment {
  readonly paymentId: string;
  readonly date: IsoDate;
  readonly amount: Money;
  /**
   * A lump sum against principal, outside the EMI schedule.
   *
   * Distinct because it behaves differently: an EMI is split between interest
   * and principal, a prepayment is principal in full.
   */
  readonly isPrepayment?: boolean;
  readonly mode?: PaymentMode;
  readonly notes?: string;
}

/** How a payment reached the lender. Recorded because it is what a dispute turns on. */
export type PaymentMode = 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'CHEQUE' | 'OTHER';

/* ------------------------------------------------------ immovable property */

/**
 * Units land and buildings are actually measured in here.
 *
 * Not a tidy SI subset: a Chennai sale deed says "ground", a Punjab one says
 * "kanal and marla", a Bengal one "katha", and an agricultural record "guntha" or
 * "bigha". Storing everything as square feet would mean converting at import —
 * and the regional units are not exact across states (a bigha is not one size),
 * so a conversion would be a guess baked into the stored figure.
 *
 * The unit is therefore recorded AS STATED and converted only for display, where
 * a wrong conversion is visible rather than permanent.
 */
export type AreaUnit =
  | 'SQ_FT'
  | 'SQ_M'
  | 'SQ_YARD'
  | 'SQ_KM'
  | 'ACRE'
  | 'HECTARE'
  | 'ARE'
  | 'CENT'
  | 'GUNTHA'
  | 'GROUND'
  | 'AANKADAM'
  | 'BIGHA'
  | 'BISWA'
  | 'KATHA'
  | 'DECIMAL'
  | 'KANAL'
  | 'MARLA'
  | 'ROOD'
  | 'PERCH';

/**
 * What the property is.
 *
 * Recorded because it changes the tax treatment, not for tidiness: agricultural
 * land outside the s.2(14) limits is not a capital asset at all, and a let-out
 * building produces house property income where a plot produces none.
 */
export type PropertyKind =
  | 'LAND'
  | 'PLOT'
  | 'AGRICULTURAL_LAND'
  | 'FLAT'
  | 'APARTMENT'
  | 'INDEPENDENT_HOUSE'
  | 'VILLA'
  | 'COMMERCIAL'
  | 'SHOP'
  | 'OFFICE'
  | 'WAREHOUSE'
  | 'INDUSTRIAL'
  | 'PARKING'
  | 'OTHER';

export interface Area {
  readonly value: Quantity;
  readonly unit: AreaUnit;
}

/**
 * Where the property is.
 *
 * A street address identifies a household, so it follows the same rule as a
 * borrower's name (ADR-013): the full address lives ONLY in the encrypted vault
 * and `addressRef` is what leaves this machine. City and state are kept in the
 * clear because Schedule AL asks for them and they do not identify anyone.
 */
export interface PropertyLocation {
  /** Masked reference; resolving it requires the local vault. */
  readonly addressRef: string;
  /** The real address, held only in the vault. Never substitute it for the ref. */
  readonly address?: string;
  readonly city?: string;
  readonly state?: string;
  readonly pincode?: string;
  readonly country?: string;
}

/**
 * How a current value was arrived at.
 *
 * REQUIRED whenever a current value is recorded. A valuation with no stated
 * basis is the figure this module exists to keep out of net worth: "someone said
 * it's worth ₹2 crore" and a registered valuer's report are not the same fact,
 * and once stored as a bare number they become indistinguishable.
 */
export type ValuationBasis =
  | 'CIRCLE_RATE'
  | 'REGISTERED_VALUER'
  | 'BROKER_ESTIMATE'
  | 'RECENT_COMPARABLE'
  | 'OWNER_ESTIMATE';

export interface PropertyValuation {
  readonly amount: Money;
  readonly asOf: IsoDate;
  readonly basis: ValuationBasis;
  readonly notes?: string;
}

/**
 * The property itself — the facts that do not change when it is bought or sold.
 *
 * Present only on REAL_ESTATE assets, following `handLoan` and `chitFund`: an
 * asset class whose shape differs from an instrument gets a block of its own
 * rather than having its fields smuggled into `symbol` and `otherCharges`, which
 * is what happened here before.
 */
export interface ImmovableProperty {
  readonly assetId: string;
  readonly propertyName: string;
  readonly kind: PropertyKind;
  readonly location?: PropertyLocation;
  /** Total extent of the property, as the deed states it. */
  readonly area?: Area;
  /**
   * An optional current value, for when one is genuinely known.
   *
   * Deliberately NOT what the asset is carried at. Schedule AL asks for cost,
   * and `ValuationEngine` values property at cost for the reason the Immovable
   * screen states: a valuation nobody performed is not an asset figure. This is
   * shown beside the cost, labelled with its basis and date, and is never summed
   * into net worth silently.
   */
  readonly currentValue?: PropertyValuation;
  /** Sub-registrar document number, as on the deed. */
  readonly registrationNumber?: string;
  readonly surveyNumber?: string;
  readonly notes?: string;
}

/**
 * The property-specific detail of ONE purchase or sale.
 *
 * Sits beside the canonical money fields rather than replacing them. The lot's
 * `quantity`, `costPerUnit`, `fees`, `stt` and `otherCharges` remain what the
 * tax engine and valuation read — this block is the BREAKDOWN, so a screen can
 * show stamp duty as stamp duty instead of as an undifferentiated charge.
 *
 * The mapping onto those fields is fixed and enforced by `propertyChargesOf`:
 *
 *   quantity      = area.value, or '1' when no area is stated
 *   costPerUnit   = pricePerAreaUnit, or the whole consideration when quantity is 1
 *   fees          = registrationFee + brokerage
 *   stt           = 0, ALWAYS — securities transaction tax cannot arise on land,
 *                   and the importer previously wrote stamp duty here
 *   otherCharges  = stampDuty + gst + otherTaxes
 */
export interface PropertyTransaction {
  /** Area transacted, which can be less than the property's total extent. */
  readonly area?: Area;
  /** Price per unit of area — the "rate" a deed quotes. */
  readonly pricePerAreaUnit?: Money;
  /** Total price for this transaction, before duties and fees. */
  readonly consideration: Money;
  readonly stampDuty: Money;
  readonly registrationFee: Money;
  /** GST, which arises on an under-construction purchase and not on resale. */
  readonly gst: Money;
  /** Cess, local body tax, TDS under s.194-IA — anything not named above. */
  readonly otherTaxes: Money;
  readonly brokerage?: Money;
  /**
   * The value the sub-registrar assessed, where it differs from the price paid.
   *
   * Recorded because the difference is itself taxable: s.50C substitutes the
   * stamp duty value for the seller's consideration, and s.56(2)(x) charges the
   * shortfall in the buyer's hands. Both are invisible without this number.
   */
  readonly stampDutyValue?: Money;
  readonly documentRef?: string;
}

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
  /** Grant and tranche detail, for an RSU or ESPP lot. */
  readonly equityAward?: EquityAward;
  /** Area and duty detail, for a REAL_ESTATE lot. */
  readonly property?: PropertyTransaction;
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

/* -------------------------------------------- balance accounts (Phase 5) */

/**
 * How a balance behaves over time — which is a different question from which
 * asset class it is.
 *
 * EPF, VPF and PPF are three asset classes with one arithmetic (`PROVIDENT_FUND`),
 * and NPS Tier I, NPS Tier II, cash and a bank balance are four with another
 * (`STATED_BALANCE`). Keying the valuer on behaviour rather than on class is what
 * keeps `valuation.ts` from growing a branch per class — the defect D-3 names.
 */
export type BalanceAccountKind =
  /** A lump sum that compounds to maturity. FD, and anything shaped like one. */
  | 'TERM_DEPOSIT'
  /** A monthly instalment, each tranche compounding from the date it was paid. */
  | 'RECURRING_DEPOSIT'
  /** Opening balance plus monthly contributions, interest on the running balance. */
  | 'PROVIDENT_FUND'
  /**
   * A figure the user states and re-states, which accrues NOTHING on its own.
   *
   * An NPS corpus moves with NAV and a bank balance moves with transactions.
   * This application has neither feed, and growing the figure from an assumed
   * rate would be fabricating a return — the thing this codebase refuses to do
   * with exchange rates, for the same reason.
   */
  | 'STATED_BALANCE'
  /** The statutory 15/26 formula, which grows with completed years of service. */
  | 'GRATUITY';

export interface BalanceAccount {
  readonly assetId: string;
  readonly kind: BalanceAccountKind;
  /** What the user calls it: "HDFC FD 7.1% 2027", "EPF — Acme Corp". */
  readonly label: string;
  readonly institutionName?: string;
  /**
   * Opaque handle for the account number, never the number itself (ADR-013,
   * FR-7.2) — the same rule the borrower name and the property address follow.
   */
  readonly accountRef?: string;
  /**
   * The balance as at `openedOn`. Zero for a recurring deposit opened with no
   * lump sum, and zero for gratuity, which has no balance at all.
   */
  readonly openingBalance: Money;
  /**
   * Where accrual starts, and the date `openingBalance` is stated as at.
   *
   * For a term deposit, the booking date. For a provident fund, the date of the
   * balance the user copied off a statement — NOT the date the account was
   * opened years earlier, which would compound contributions that were already
   * inside that balance. For gratuity, the date service began.
   */
  readonly openedOn: IsoDate;
  /** Absent means no accrual: a balance with no stated rate is carried flat. */
  readonly annualRatePct?: Percentage;
  readonly compounding?: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  /** RD instalment, or the employee's monthly provident-fund contribution. */
  readonly monthlyContribution?: Money;
  readonly employerContribution?: Money;
  readonly maturityDate?: IsoDate;
  /**
   * The institution's own maturity figure, preferred over the computed one once
   * the deposit matures — for the same reason a lender's stated EMI is preferred
   * over a derived one: a bank rounds, and a figure that disagrees with the
   * certificate is one the holder cannot reconcile.
   */
  readonly maturityValue?: Money;
  /** GRATUITY only: last drawn monthly wage, the base of the 15/26 formula. */
  readonly lastDrawnMonthly?: Money;
  /**
   * When the money left — an FD withdrawn, a PF transferred out. From this date
   * the account is worth nil here, because the proceeds are a bank balance now
   * and counting both would report the same rupees twice.
   */
  readonly closedOn?: IsoDate;
  readonly notes?: string;
}

export interface BalanceView {
  readonly account: BalanceAccount;
  readonly asOf: IsoDate;
  readonly value: Money;
  /** What actually went in — the cost basis, and what Schedule AL wants. */
  readonly contributed: Money;
  readonly accruedInterest: Money;
  readonly instalmentsPaid?: number;
  readonly completedYears?: number;
  readonly matured: boolean;
  readonly closed: boolean;
  /**
   * Why the figure is flat when a reader expects it to grow. Stated rather than
   * left to be inferred from a number that has not moved.
   */
  readonly flatReason?: string;
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
