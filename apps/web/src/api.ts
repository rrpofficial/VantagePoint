/**
 * The SPA's only contact with the backend.
 *
 * Same-origin `/api` in both development and the container, so there is no base
 * URL to configure and no chance of a build pointing at the wrong host.
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  /** DUPLICATE_LOAN only: ids of the loans the new one would duplicate. */
  readonly duplicates?: readonly string[];
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/**
 * Every request is bounded.
 *
 * `fetch` has no default timeout, so a request the backend never answers leaves
 * the promise pending forever and the UI showing a spinner with no way out. The
 * budget is generous because unlocking runs a deliberately slow key derivation —
 * the point is to convert an infinite hang into a stateable error, not to be
 * impatient.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    /*
     * The JSON content-type goes on only when there IS a body. Declaring it on
     * a bodyless POST makes Fastify try to parse an empty body and answer 400 —
     * which is what silently broke the Lock vault button: it posts nothing, so
     * every click failed and the vault stayed unlocked.
     */
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: controller.signal,
      ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = (body as { error?: ApiError }).error;
      return {
        ok: false,
        error: failure ?? { code: 'HTTP_ERROR', message: `request failed (${String(response.status)})` },
      };
    }
    return { ok: true, value: body as T };
  } catch (cause) {
    // Distinguished so the UI can say "still working, try again" rather than
    // "the backend is down", which would be wrong and alarming.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return {
        ok: false,
        error: { code: 'TIMEOUT', message: 'the portTrack API did not respond in time' },
      };
    }
    // The backend is reachable only over the internal network; a failure here is
    // the API being down, never a CORS or cross-origin problem.
    return { ok: false, error: { code: 'UNREACHABLE', message: 'the portTrack API is not responding' } };
  } finally {
    clearTimeout(timer);
  }
}

export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export interface ValuedPosition {
  readonly assetId: string;
  readonly assetClass: string;
  readonly jurisdiction: string;
  readonly quantity: string;
  readonly marketValue: Money;
  readonly costBasis: Money;
}

export interface Valuation {
  readonly asOf: string;
  readonly positions: readonly ValuedPosition[];
  readonly grossAssets: Money;
  readonly totalLiabilities: Money;
  readonly netWorth: Money;
  readonly byAssetClass: Readonly<Record<string, Money>>;
}

export interface AcquisitionLot {
  readonly lotId: string;
  readonly acquisitionDate: string;
  readonly quantity: string;
  readonly remainingQuantity: string;
  readonly costPerUnit: Money;
  /**
   * Charges are part of the cost of acquisition, not decoration. For property
   * they are the stamp duty and registration a purchase price alone omits, and
   * they are deductible — so the Immovable screen reports them separately.
   *
   * The API has always sent these; the client type simply never declared them.
   */
  readonly fees?: Money;
  readonly stt?: Money;
  readonly otherCharges?: Money;
  /** Present on a REAL_ESTATE lot: the deed's own breakdown. */
  readonly property?: PropertyTransaction;
}

export type AreaUnit = string;
export type PropertyKind = string;
export type ValuationBasis =
  | 'CIRCLE_RATE'
  | 'REGISTERED_VALUER'
  | 'BROKER_ESTIMATE'
  | 'RECENT_COMPARABLE'
  | 'OWNER_ESTIMATE';

export interface Area {
  readonly value: string;
  readonly unit: AreaUnit;
}

/**
 * The duty breakdown of one purchase or sale.
 *
 * Read, never derived here. The screen previously displayed `stt` as "Stamp
 * duty" — a field nothing sets for property — so every property showed ₹0 duty
 * while the real figure sat in an "other" column.
 */
export interface PropertyTransaction {
  readonly area?: Area;
  readonly pricePerAreaUnit?: Money;
  readonly consideration: Money;
  readonly stampDuty: Money;
  readonly registrationFee: Money;
  readonly gst: Money;
  readonly otherTaxes: Money;
  readonly brokerage?: Money;
  readonly stampDutyValue?: Money;
  readonly documentRef?: string;
}

export interface PropertyLocation {
  readonly addressRef: string;
  readonly address?: string;
  readonly city?: string;
  readonly state?: string;
  readonly pincode?: string;
  readonly country?: string;
}

export interface ImmovableProperty {
  readonly assetId: string;
  readonly propertyName: string;
  readonly kind: PropertyKind;
  readonly location?: PropertyLocation;
  readonly area?: Area;
  readonly currentValue?: {
    readonly amount: Money;
    readonly asOf: string;
    readonly basis: ValuationBasis;
    readonly notes?: string;
  };
  readonly registrationNumber?: string;
  readonly surveyNumber?: string;
  readonly notes?: string;
}

/**
 * What the property form posts. Every money field is a STRING, not a `Money`:
 * the server parses Indian digit grouping (`1,00,00,000`), which is exactly how
 * a deed figure gets typed, and pre-parsing it here would be a second parser.
 */
export interface RecordPropertyBody {
  side: 'BUY' | 'SELL';
  transactionDate: string;
  propertyName: string;
  kind: PropertyKind;
  consideration: string;
  areaValue?: string;
  areaUnit?: AreaUnit;
  pricePerAreaUnit?: string;
  stampDuty?: string;
  registrationFee?: string;
  gst?: string;
  otherTaxes?: string;
  brokerage?: string;
  stampDutyValue?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  registrationNumber?: string;
  surveyNumber?: string;
  documentRef?: string;
  notes?: string;
  currentValue?: { amount: string; asOf: string; basis: ValuationBasis };
  confirmDuplicate?: boolean;
}

/** Non-blocking findings the server reports after a property is recorded. */
export interface PropertyAdvisory {
  readonly code: 'CONSIDERATION_MISMATCH' | 'STAMP_DUTY_SHORTFALL';
  readonly message: string;
}

export interface IncomeEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly date: string;
  readonly grossAmount: Money;
  readonly taxWithheld: Money;
}

export interface LedgerAsset {
  readonly assetId: string;
  readonly assetClass: string;
  readonly jurisdiction: string;
  readonly currency: string;
  readonly symbol?: string;
  readonly isin?: string;
  /** How a mutual fund is identified — it has no ticker. */
  readonly folioRef?: string;
  readonly lots: readonly AcquisitionLot[];
  readonly incomeEvents: readonly IncomeEvent[];
  /** Units still held. Summed by the server, in decimal, never in the browser. */
  readonly heldQuantity: string;
  /** What those units cost, in the holding's OWN currency. */
  readonly costBasis: Money;
  /**
   * The same figure in rupees, at the latest published SBI TT buy rate.
   *
   * Absent when no rate could be resolved — a screen must then omit the holding
   * from a rupee total rather than add its foreign amount as though it were one.
   */
  readonly costBasisInr?: Money;
  /** The rate used, so a converted figure can be checked rather than trusted. */
  readonly conversionRate?: string;
  /**
   * What the holding is WORTH, where a price is known. Absent for anything
   * unpriced — property, unlisted shares, loans, chits — which is carried at
   * cost, and must be labelled as such rather than folded into a "value" total.
   */
  readonly marketValue?: Money;
  readonly marketValueInr?: Money;
  readonly marketPricePerUnit?: Money;
  /** When that price was recorded. Prices arrive by import, so it is not today. */
  readonly priceAsOf?: string;
  readonly unrealisedInr?: Money;
  /**
   * Which tab this holding belongs in, decided by the SERVER.
   *
   * Equity and Non-Equity are split by tax character where one exists, not by
   * asset class — a debt-oriented fund and an equity-oriented one share a class
   * and are taxed differently (ADR-016). Recomputing that here would be a second
   * copy of the rule, free to drift from the engine's.
   */
  readonly bucket: AssetBucket;
  /** Present only on REAL_ESTATE: name, type, area, location, current value. */
  readonly property?: ImmovableProperty;
}

/** Mirrors core-domain's AssetBucket. The SPA never derives it, only reads it. */
export type AssetBucket = 'EQUITY' | 'NON_EQUITY' | 'IMMOVABLE' | 'LOAN' | 'CHIT';

export interface LedgerLiability {
  readonly liabilityId: string;
  readonly kind: string;
  readonly principalOutstanding: Money;
  readonly interestRatePct: string;
  readonly asOf: string;
}

export interface LedgerExit {
  readonly txnId: string;
  readonly assetId: string;
  readonly exitDate: string;
  readonly quantity: string;
  readonly pricePerUnit: Money;
}

export interface Ledger {
  readonly assets: readonly LedgerAsset[];
  readonly liabilities: readonly LedgerLiability[];
  readonly exits: readonly LedgerExit[];
}

export type ParserName =
  | 'ZERODHA_TRADEBOOK'
  | 'ZERODHA_TAX_PNL'
  | 'VESTED'
  | 'ETRADE'
  | 'ETRADE_GL'
  | 'ETRADE_HOLDINGS'
  | 'CAMS'
  | 'TEMPLATE';

export interface TrancheDiscrepancy {
  readonly assetId: string;
  readonly lotId: string;
  readonly symbol?: string;
  readonly acquisitionDate: string;
  readonly grantRef?: string;
  readonly stated: string;
  readonly computed: string;
  readonly difference: string;
}

export interface HoldingsReconciliation {
  readonly discrepancies: readonly TrancheDiscrepancy[];
  readonly agreed: number;
  readonly unaccountedUnits: string;
  readonly noStatementLoaded: boolean;
}

export interface RowError {
  readonly row: number;
  readonly column: string;
  readonly value: string;
  readonly reason: string;
  readonly expectedFormat?: string;
}

export interface UnappliedRow {
  readonly kind: string;
  readonly date: string;
  readonly symbol?: string;
  readonly sourceRow: number;
  readonly reason: string;
}

export interface FinancialYearOption {
  readonly financialYear: string;
  readonly assessmentYear: string;
  readonly isCurrent: boolean;
  readonly rulesAvailable: boolean;
  readonly rulesStatus?: 'PROVISIONAL' | 'VERIFIED';
  /** That year's own reason for being provisional; they differ materially. */
  readonly rulesNote?: string;
}

export interface CalendarYearOption {
  readonly calendarYear: number;
  readonly isCurrent: boolean;
  readonly isComplete: boolean;
}

export interface Periods {
  readonly today: string;
  readonly currentFinancialYear: string;
  readonly currentAssessmentYear: string;
  readonly currentCalendarYear: number;
  /** Where a picker starts — not always the current year; see the API doc. */
  readonly defaultFinancialYear: string;
  readonly defaultCalendarYear: number;
  readonly financialYears: readonly FinancialYearOption[];
  readonly calendarYears: readonly CalendarYearOption[];
}

export type LoanStatus = 'ACTIVE' | 'PARTIALLY_REPAID' | 'REPAID';
export type LoanSortKey = 'borrowerName' | 'status' | 'loanDate' | 'principal';
export type PaymentMode = 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'CHEQUE' | 'OTHER';

export interface LoanPaymentView {
  readonly paymentId?: string;
  readonly date: string;
  readonly amount: Money;
  readonly mode: string;
  readonly notes: string;
}

export interface LoanView {
  readonly loanId: string;
  readonly borrowerRef: string;
  readonly borrowerName: string;
  readonly notes: string;
  readonly loanDate: string;
  readonly closedDate?: string;
  readonly principal: Money;
  readonly interestRatePct: string;
  readonly status: LoanStatus;
  readonly principalRepaid: Money;
  readonly outstandingPrincipal: Money;
  readonly totalInterestAccrued: Money;
  readonly interestPaid: Money;
  readonly interestBalance: Money;
  readonly interestPerMonth: Money;
  readonly totalInterestMonths: number;
  readonly interestBalanceMonths: string;
  readonly repayments: readonly LoanPaymentView[];
  readonly interestPayments: readonly LoanPaymentView[];
  readonly lastPaymentDate?: string;
}

export interface LoanTotals {
  readonly loanCount: number;
  readonly totalPrincipal: Money;
  readonly totalOutstanding: Money;
  readonly totalInterestAccrued: Money;
  readonly totalInterestPaid: Money;
  readonly pendingInterestActive: Money;
  readonly pendingInterestRepaid: Money;
  readonly pendingInterestTotal: Money;
}

export interface LoanRegister {
  readonly loans: readonly LoanView[];
  readonly totals: LoanTotals;
  readonly borrowers: readonly string[];
}

export type ChitStatus = 'ACTIVE' | 'WITHDRAWN';
export type ChitEmiType = 'CONSTANT' | 'VARYING';

export interface ChitEmi {
  readonly emiId: string;
  readonly date: string;
  readonly amount: Money;
  readonly mode: PaymentMode;
  readonly paidTo: string;
  readonly comments?: string;
}

export interface ChitView {
  readonly assetId: string;
  readonly org: string;
  readonly label: string;
  readonly targetAmount: Money;
  readonly startDate: string;
  readonly endDate: string;
  readonly durationMonths: number;
  readonly emiType: ChitEmiType;
  readonly scheduleLabel?: string;
  readonly status: ChitStatus;
  readonly withdrawnDate?: string;
  readonly withdrawnAmount?: Money;
  readonly comments?: string;
  readonly emis: readonly ChitEmi[];
  readonly paidToDate: Money;
  readonly emiCount: number;
  readonly monthsElapsed: number;
  readonly monthsRemaining: number;
  readonly remainingCommitment: Money;
  readonly carryingValue: Money;
  readonly expectedWithdrawal?: Money;
  readonly lastPaymentDate?: string;
}

export interface ChitTotals {
  readonly chitCount: number;
  readonly activeCount: number;
  readonly withdrawnCount: number;
  readonly totalTarget: Money;
  readonly totalPaid: Money;
  readonly activeCarryingValue: Money;
  readonly totalWithdrawn: Money;
}

export interface ChitRegister {
  readonly chits: readonly ChitView[];
  readonly totals: ChitTotals;
  readonly orgs: readonly string[];
}

export interface ChitWithdrawalSchedule {
  readonly label: string;
  readonly rows: readonly { readonly month: number; readonly amount: Money }[];
}

export interface ChitQuery {
  readonly statuses?: readonly ChitStatus[];
  readonly orgs?: readonly string[];
  readonly sortBy?: string;
  readonly direction?: 'ASC' | 'DESC';
}

function chitQueryString(query: ChitQuery): string {
  const params = new URLSearchParams();
  if (query.statuses !== undefined && query.statuses.length > 0) {
    params.set('status', query.statuses.join(','));
  }
  if (query.orgs !== undefined && query.orgs.length > 0) params.set('org', query.orgs.join(','));
  if (query.sortBy !== undefined) params.set('sortBy', query.sortBy);
  if (query.direction !== undefined) params.set('direction', query.direction);
  const encoded = params.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

export interface TradeClass {
  readonly assetClass: string;
  readonly label: string;
  /** Which identifier field the form should ask for. */
  readonly identifier: 'SYMBOL' | 'FOLIO' | 'NAME';
}

export interface RecordedTrade {
  readonly assetId: string;
  readonly exits: number;
  readonly unapplied: readonly { readonly reason: string }[];
}

export type LoanAuditAction =
  | 'CREATED'
  | 'CREATED_AS_DUPLICATE'
  | 'EDITED'
  | 'CLOSED'
  | 'REOPENED'
  | 'PRINCIPAL_REPAYMENT'
  | 'INTEREST_PAYMENT'
  /** The loan itself. The entry outlives it — the trail does not cascade. */
  | 'DELETED';

export interface LoanAuditEntry {
  readonly entryId: string;
  readonly loanId: string;
  readonly action: LoanAuditAction;
  readonly field?: string;
  readonly oldValue?: string;
  readonly newValue?: string;
  readonly reason?: string;
  readonly recordedAt: string;
}

export interface LoanQuery {
  readonly statuses?: readonly LoanStatus[];
  readonly borrowers?: readonly string[];
  readonly sortBy?: LoanSortKey;
  readonly direction?: 'ASC' | 'DESC';
}

/** Multi-select filters travel as comma-separated lists. */
function loanQueryString(query: LoanQuery): string {
  const params = new URLSearchParams();
  if (query.statuses !== undefined && query.statuses.length > 0) {
    params.set('status', query.statuses.join(','));
  }
  if (query.borrowers !== undefined && query.borrowers.length > 0) {
    params.set('borrower', query.borrowers.join(','));
  }
  if (query.sortBy !== undefined) params.set('sortBy', query.sortBy);
  if (query.direction !== undefined) params.set('direction', query.direction);
  const encoded = params.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

export interface TemplateSummary {
  readonly name: string;
  readonly description: string;
  readonly assetClass: string;
  readonly columns: readonly string[];
  readonly guidance: string;
}

export interface ImportReport {
  readonly created: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly committed: boolean;
  readonly errors: readonly RowError[];
  readonly unapplied?: readonly UnappliedRow[];
}

export interface SnapshotSummary {
  readonly snapshotId: string;
  readonly kind: string;
  readonly scope: string;
  readonly asOf: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface PositionDelta {
  readonly assetId: string;
  /** Lets a comparison be scoped to one sleeve without a ledger join. */
  readonly assetClass: string;
  readonly bucket: string;
  readonly quantityBefore: string;
  readonly quantityAfter: string;
  readonly valueBefore: Money;
  readonly valueAfter: Money;
  readonly valueDelta: Money;
  readonly valueDeltaPct: string;
  readonly priceEffect?: Money;
  readonly currencyEffect?: Money;
}

export interface AllocationRow {
  readonly assetClass: string;
  readonly beforePct: string;
  readonly afterPct: string;
}

export interface VarianceReport {
  readonly netWorthBefore: Money;
  readonly netWorthAfter: Money;
  readonly netWorthDelta: Money;
  readonly netWorthDeltaPct: string;
  readonly positions: readonly PositionDelta[];
  readonly topGainers: readonly PositionDelta[];
  readonly newAdditions: readonly PositionDelta[];
  readonly liquidations: readonly PositionDelta[];
  readonly allocation: readonly AllocationRow[];
}

/** A borrowing, as the API returns it. */
export interface BorrowedLoan {
  readonly loanId: string;
  readonly kind: string;
  readonly lenderName?: string;
  readonly lenderRef: string;
  readonly principal: Money;
  readonly interestRatePct: string;
  readonly tenureMonths: number;
  readonly startDate: string;
  readonly status: string;
  readonly closedDate?: string;
  readonly notes?: string;
}

export interface ScheduledInstalment {
  readonly number: number;
  readonly dueDate: string;
  readonly openingBalance: Money;
  readonly payment: Money;
  readonly interest: Money;
  readonly principal: Money;
  readonly closingBalance: Money;
}

/** A borrowing with its schedule and its progress against it. */
export interface BorrowedView extends BorrowedLoan {
  readonly emi: Money;
  readonly totalPayable: Money;
  readonly totalInterest: Money;
  readonly paidToDate: Money;
  readonly principalRepaid: Money;
  readonly interestPaid: Money;
  readonly prepaid: Money;
  readonly outstanding: Money;
  readonly instalmentsPaid: number;
  readonly instalmentsRemaining: number;
  readonly percentRepaid: string;
  readonly nextDueDate?: string;
  readonly isClosed: boolean;
  readonly schedule: readonly ScheduledInstalment[];
}

export interface BorrowedRegister {
  readonly loans: readonly BorrowedView[];
  readonly totals: {
    readonly loanCount: number;
    readonly activeCount: number;
    readonly closedCount: number;
    readonly totalBorrowed: Money;
    readonly totalOutstanding: Money;
    readonly totalPrincipalRepaid: Money;
    readonly totalInterestPaid: Money;
    readonly monthlyCommitment: Money;
  };
  readonly lenders: readonly string[];
  readonly asOf: string;
}

export interface AdvanceTaxInstallment {
  readonly quarter: string;
  readonly dueDate: string;
  readonly cumulativePercentage: string;
  readonly totalLiability: Money;
  readonly cumulativeRequired: Money;
  readonly tdsCredit: Money;
  readonly alreadyPaid: Money;
  readonly netPayable: Money;
  /**
   * Gains that could NOT be converted to rupees, and are therefore absent from
   * the figures above. Non-empty means the instalment is understated.
   */
  readonly capitalGains?: {
    readonly unconvertible: readonly {
      readonly txnId: string;
      readonly currency: string;
      readonly exitDate: string;
      readonly reason: string;
    }[];
    readonly excludedSellToCover: readonly {
      readonly txnId: string;
      readonly exitDate: string;
      readonly gainInr?: Money;
      readonly straddlesBasisMonths: boolean;
    }[];
  };
}

export interface AdvanceTaxPayment {
  readonly paymentId: string;
  readonly financialYear: string;
  readonly quarter: string;
  readonly amount: Money;
  readonly paidOn: string;
  readonly challanRef?: string;
  readonly notes?: string;
}

export interface TaxComputation {
  readonly regime: string;
  readonly totalIncome: Money;
  readonly baseTax: Money;
  readonly surcharge: Money;
  readonly cess: Money;
  readonly totalLiability: Money;
}

export interface RegimeComparison {
  readonly old: TaxComputation;
  readonly new: TaxComputation;
  readonly recommended: string;
  readonly deductionsForgone: readonly string[];
  readonly hasIncomeProfile: boolean;
}

export interface IncomeProfileState {
  readonly present: boolean;
  readonly profile: Record<string, unknown> | null;
}

/** Ledger-derived receipts the user has opted INTO taxing. Both off by default. */
export interface IncomeInclusions {
  readonly handLoanInterest: boolean;
  readonly chitFundReturns: boolean;
  /** Charge shares sold on vest day to fund withholding. Off by default. */
  readonly sellToCoverGains: boolean;
}

export interface IncomeInclusionsState {
  readonly inclusions: IncomeInclusions;
  /** Labels for what is switched on, phrased by the API so the two cannot drift. */
  readonly enabled: readonly string[];
}

export interface ScheduleAlSection {
  readonly head: string;
  readonly items: readonly { readonly description: string; readonly costOfAcquisition: Money }[];
  readonly total: Money;
}

export interface ScheduleAl {
  readonly assessmentYear: string;
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

export interface ScheduleFaDRow {
  readonly countryCode: string;
  readonly institutionName: string;
  readonly accountRef: string;
  readonly peakBalanceInr: Money;
  readonly closingBalanceInr: Money;
}

export interface ScheduleFa {
  readonly calendarYear: number;
  readonly tableA3: readonly unknown[] | null;
  readonly tableA3Error: ApiError | null;
  readonly tableD: readonly ScheduleFaDRow[] | null;
  readonly tableDError: ApiError | null;
}

export interface EditModeState {
  readonly enabled: boolean;
  readonly since?: string;
}

export const api = {
  unlock: (passphrase: string) =>
    request<{ unlocked: boolean }>('/vault/unlock', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  lock: () => request<{ unlocked: boolean }>('/vault/lock', { method: 'POST' }),
  valuation: () => request<Valuation>('/portfolio/valuation'),
  ready: () => request<{ status: string }>('/health/ready'),

  editMode: () => request<EditModeState>('/edit-mode'),
  /** Slow: the server re-derives the vault key, exactly as unlocking does. */
  enableEditMode: (passphrase: string) =>
    request<EditModeState>('/edit-mode/enable', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  disableEditMode: () => request<EditModeState>('/edit-mode/disable', { method: 'POST' }),

  ledger: () => request<Ledger>('/ledger/assets'),
  deleteAsset: (assetId: string) =>
    request<{ deleted: boolean }>(`/ledger/assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    }),
  deleteExit: (txnId: string) =>
    request<{ deleted: boolean }>(`/ledger/exits/${encodeURIComponent(txnId)}`, {
      method: 'DELETE',
    }),

  /**
   * Server-derived. The browser must not decide which financial year it is —
   * a client in another timezone would disagree with the engine computing the tax.
   */
  periods: () => request<Periods>('/reference/periods'),

  chits: (query: ChitQuery = {}) => request<ChitRegister>(`/chits${chitQueryString(query)}`),
  openChit: (input: {
    org: string;
    label: string;
    targetAmount: Money;
    startDate: string;
    durationMonths: number;
    emiType: ChitEmiType;
    scheduleLabel?: string;
    comments?: string;
  }) => request<{ chitId: string }>('/chits', { method: 'POST', body: JSON.stringify(input) }),
  editChit: (
    chitId: string,
    input: {
      org?: string;
      label?: string;
      targetAmount?: Money;
      startDate?: string;
      durationMonths?: number;
      emiType?: ChitEmiType;
      scheduleLabel?: string | null;
      comments?: string;
    },
  ) =>
    request<{ updated: boolean }>(`/chits/${encodeURIComponent(chitId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  recordChitEmi: (
    chitId: string,
    input: { date: string; amount: Money; mode: PaymentMode; paidTo: string; comments?: string },
  ) =>
    request<{ recorded: boolean }>(`/chits/${encodeURIComponent(chitId)}/emis`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setChitStatus: (
    chitId: string,
    input: { status: ChitStatus; date?: string; amount?: Money },
  ) =>
    request<{ updated: boolean }>(`/chits/${encodeURIComponent(chitId)}/status`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteChit: (chitId: string) =>
    request<{ deleted: boolean }>(`/chits/${encodeURIComponent(chitId)}`, { method: 'DELETE' }),
  chitSchedules: () =>
    request<{ schedules: readonly ChitWithdrawalSchedule[] }>('/chits/schedules'),
  saveChitSchedule: (schedule: ChitWithdrawalSchedule) =>
    request<{ saved: boolean }>('/chits/schedules', {
      method: 'POST',
      body: JSON.stringify(schedule),
    }),
  deleteChitSchedule: (label: string) =>
    request<{ deleted: boolean }>(`/chits/schedules/${encodeURIComponent(label)}`, {
      method: 'DELETE',
    }),

  tradeClasses: () => request<{ classes: readonly TradeClass[] }>('/trades/classes'),
  recordTrade: (input: {
    assetClass: string;
    side: 'BUY' | 'SELL';
    tradeDate: string;
    symbol?: string;
    isin?: string;
    folioRef?: string;
    schemeName?: string;
    quantity: string;
    pricePerUnit: Money;
    fees?: Money;
    otherCharges?: Money;
    confirmDuplicate?: boolean;
  }) => request<RecordedTrade>('/trades', { method: 'POST', body: JSON.stringify(input) }),

  propertyReference: () =>
    request<{ kinds: readonly PropertyKind[]; areaUnits: readonly AreaUnit[] }>(
      '/property/reference',
    ),
  recordProperty: (input: RecordPropertyBody) =>
    request<{ assetId: string; advisories: readonly PropertyAdvisory[] }>('/property', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  loans: (query: LoanQuery = {}) => request<LoanRegister>(`/loans${loanQueryString(query)}`),
  recordLoan: (input: {
    borrowerName: string;
    principal: Money;
    interestRatePct: string;
    loanDate: string;
    notes?: string;
    /** Re-send the same payload with this set to accept a flagged duplicate. */
    confirmDuplicate?: boolean;
  }) => request<{ loanId: string }>('/loans', { method: 'POST', body: JSON.stringify(input) }),
  editLoan: (
    loanId: string,
    input: {
      borrowerName?: string;
      principalAmount?: string;
      interestRatePct?: string;
      loanDate?: string;
      notes?: string;
      closedDate?: string | null;
      reason?: string;
    },
  ) =>
    request<{ changed: number; entries: readonly LoanAuditEntry[] }>(
      `/loans/${encodeURIComponent(loanId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  deleteLoan: (loanId: string, reason?: string) =>
    request<{ deleted: boolean }>(`/loans/${encodeURIComponent(loanId)}`, {
      method: 'DELETE',
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    }),
  loanAudit: (loanId: string) =>
    request<{ entries: readonly LoanAuditEntry[] }>(
      `/loans/${encodeURIComponent(loanId)}/audit`,
    ),
  recordInterestPayment: (
    loanId: string,
    input: { date: string; amount: Money; mode: PaymentMode; notes?: string },
  ) =>
    request<{ recorded: boolean }>(`/loans/${encodeURIComponent(loanId)}/interest-payments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  recordPrincipalRepayment: (
    loanId: string,
    input: { date: string; amount: Money; mode: PaymentMode; notes?: string },
  ) =>
    request<{ recorded: boolean }>(`/loans/${encodeURIComponent(loanId)}/principal-repayments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Direct hrefs — the browser downloads them, carrying the current filters. */
  loanCsvUrl: (query: LoanQuery = {}) => `/api/loans/export.csv${loanQueryString(query)}`,
  loanPdfUrl: (query: LoanQuery = {}) => `/api/loans/export.pdf${loanQueryString(query)}`,

  templates: () => request<{ templates: readonly TemplateSummary[] }>('/templates'),
  /** Direct href — the browser downloads it, no JSON round trip. */
  templateUrl: (name: string) => `/api/templates/${encodeURIComponent(name)}`,

  importStatement: (input: {
    file: string;
    fileName: string;
    parser: ParserName;
    password?: string;
    templateName?: string;
  }) =>
    request<ImportReport>('/imports', {
      method: 'POST',
      // LENIENT: the report lists every rejected row, so the user sees what was
      // skipped instead of losing a whole statement to one bad line.
      body: JSON.stringify({ ...input, mode: 'LENIENT' }),
    }),

  snapshots: () => request<{ snapshots: readonly SnapshotSummary[] }>('/snapshots'),
  createSnapshot: (asOf?: string) =>
    request<{ snapshotId?: string }>('/snapshots', {
      method: 'POST',
      body: JSON.stringify(asOf === undefined ? {} : { asOf }),
    }),
  compareToLive: (snapshotId: string) =>
    request<VarianceReport>(`/snapshots/${encodeURIComponent(snapshotId)}/compare?target=live`),

  /**
   * Two frozen snapshots, rather than one against the live portfolio.
   *
   * The use case and the route have both existed since the snapshot work; this
   * method is what was missing, so the SPA could only ever ask "how has it moved
   * since?" and never "how did it move between these two dates?" — which is the
   * whole of objective 2.
   */
  liabilityKinds: () => request<{ kinds: readonly string[] }>('/liabilities/kinds'),
  liabilities: (query: { status?: string; kind?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.status !== undefined && query.status.length > 0) params.set('status', query.status);
    if (query.kind !== undefined && query.kind.length > 0) params.set('kind', query.kind);
    const qs = params.toString();
    return request<BorrowedRegister>(`/liabilities${qs.length > 0 ? `?${qs}` : ''}`);
  },
  recordLiability: (input: {
    lenderName: string;
    kind: string;
    principal: string;
    interestRatePct: string;
    tenureMonths: string;
    startDate: string;
    statedEmi?: string;
    notes?: string;
  }) => request<BorrowedLoan>('/liabilities', { method: 'POST', body: JSON.stringify(input) }),
  recordLiabilityPayment: (
    loanId: string,
    input: { date: string; amount: string; isPrepayment?: boolean; notes?: string },
  ) =>
    request<BorrowedLoan>(`/liabilities/${encodeURIComponent(loanId)}/payments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  closeLiability: (loanId: string, closedDate: string) =>
    request<BorrowedLoan>(`/liabilities/${encodeURIComponent(loanId)}/close`, {
      method: 'POST',
      body: JSON.stringify({ closedDate }),
    }),
  deleteLiability: (loanId: string) =>
    request<{ deleted: boolean }>(`/liabilities/${encodeURIComponent(loanId)}`, {
      method: 'DELETE',
    }),

  compareSnapshots: (beforeId: string, afterId: string) =>
    request<VarianceReport>(
      `/snapshots/${encodeURIComponent(beforeId)}/compare?target=${encodeURIComponent(afterId)}`,
    ),

  advanceTax: (fy: string, quarter: string) =>
    request<AdvanceTaxInstallment>(
      `/tax/advance?fy=${encodeURIComponent(fy)}&quarter=${encodeURIComponent(quarter)}`,
    ),
  advanceTaxPayments: (fy: string) =>
    request<{ payments: readonly AdvanceTaxPayment[] }>(
      `/tax/advance/payments?fy=${encodeURIComponent(fy)}`,
    ),
  recordAdvanceTaxPayment: (input: {
    fy: string;
    quarter: string;
    amount: string;
    paidOn: string;
    challanRef?: string;
  }) =>
    request<AdvanceTaxPayment>('/tax/advance/payments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteAdvanceTaxPayment: (paymentId: string) =>
    request<{ deleted?: boolean }>(`/tax/advance/payments/${encodeURIComponent(paymentId)}`, {
      method: 'DELETE',
    }),

  regimes: (fy: string) => request<RegimeComparison>(`/tax/regimes?fy=${encodeURIComponent(fy)}`),
  incomeProfile: () => request<IncomeProfileState>('/tax/income-profile'),
  saveIncomeProfile: (profile: Record<string, unknown>) =>
    request<{ present: boolean }>('/tax/income-profile', {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }),

  reconciliation: () => request<HoldingsReconciliation>('/ledger/reconciliation'),

  incomeInclusions: () => request<IncomeInclusionsState>('/tax/income-inclusions'),
  saveIncomeInclusions: (inclusions: IncomeInclusions) =>
    request<IncomeInclusionsState>('/tax/income-inclusions', {
      method: 'PUT',
      body: JSON.stringify(inclusions),
    }),

  scheduleFa: (calendarYear: number) =>
    request<ScheduleFa>(`/compliance/schedule-fa?cy=${String(calendarYear)}`),
  scheduleAl: (fy: string) =>
    request<ScheduleAl>(`/compliance/schedule-al?fy=${encodeURIComponent(fy)}`),

  egressLog: () => request<{ entries: readonly unknown[] }>('/audit/egress'),
  applicationLog: () => request<{ lines: readonly string[] }>('/audit/log'),
};
