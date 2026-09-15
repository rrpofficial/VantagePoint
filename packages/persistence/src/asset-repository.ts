/**
 * Asset and liability persistence (US-8.3).
 *
 * An Asset is an aggregate: the row in `assets` is meaningless without its lots,
 * income events and corporate actions, so every write is one transaction and
 * every read reassembles the whole thing. Saving is upsert-by-aggregate — child
 * rows are replaced wholesale rather than diffed, because a partial update that
 * leaves a stale lot behind produces a cost basis that is wrong in a way nothing
 * downstream can detect.
 *
 * Money is stored as a decimal string plus a currency column, never REAL
 * (ADR-002). `exactOptionalPropertyTypes` is why optional fields are rebuilt
 * with conditional spreads instead of being assigned `undefined`: the two are
 * genuinely different here, and a column that is NULL must come back absent.
 */
import {
  Err,
  Money,
  Ok,
  VaultStateError,
  type Currency,
  type Money as MoneyValue,
  type Result,
} from '@porttrack/shared-kernel';
import type {
  AcquisitionLot,
  AdvanceTaxPayment,
  AreaUnit,
  Asset,
  AssetClass,
  BalanceAccount,
  ChitFund,
  CorporateAction,
  DualRate,
  EquityAward,
  ExitTransaction,
  HandLoan,
  ImmovableProperty,
  IncomeEvent,
  Jurisdiction,
  Liability,
  Liquidity,
  LotAllocation,
  MfSchemeCategory,
  PaymentMode,
  PropertyLocation,
  PropertyTransaction,
  RateSource,
  ValuationBasis,
} from '@porttrack/core-domain';
import { Vault } from './vault.js';

interface AssetRow {
  readonly asset_id: string;
  readonly asset_class: string;
  readonly jurisdiction: string;
  readonly currency: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly folio_ref: string | null;
  readonly liquidity: string | null;
  readonly position_closed: number;
  readonly scheme_category: string | null;
  readonly equity_allocation_pct: string | null;
}

interface LotRow {
  readonly lot_id: string;
  readonly asset_id: string;
  readonly acquisition_date: string;
  readonly settlement_date: string;
  readonly quantity: string;
  readonly remaining_quantity: string;
  readonly cost_per_unit: string;
  readonly cost_currency: string;
  readonly fees: string;
  readonly stt: string;
  readonly other_charges: string;
  readonly valuation_rate: string | null;
  readonly tax_rate: string | null;
  readonly rate_source: string | null;
  readonly tax_rate_source: string | null;
  readonly fx_is_fallback: number | null;
  readonly fx_fallback_note: string | null;
  readonly grandfathered_fmv: string | null;
  readonly perquisite_value: string | null;
  readonly is_bonus: number;
  readonly award_kind: string | null;
  readonly grant_ref: string | null;
  readonly grant_date: string | null;
  readonly vest_date: string | null;
  readonly purchase_date: string | null;
  readonly purchase_price: string | null;
  readonly discount_per_unit: string | null;
  readonly fmv_at_acquisition: string | null;
  readonly stated_remaining_quantity: string | null;
  readonly prop_area_value: string | null;
  readonly prop_area_unit: string | null;
  readonly prop_price_per_area: string | null;
  readonly prop_consideration: string | null;
  readonly prop_stamp_duty: string | null;
  readonly prop_registration_fee: string | null;
  readonly prop_gst: string | null;
  readonly prop_other_taxes: string | null;
  readonly prop_brokerage: string | null;
  readonly prop_stamp_duty_value: string | null;
  readonly prop_document_ref: string | null;
}

/** The property columns a lot and an exit share, so one reader serves both. */
interface PropertyTxnRow {
  readonly prop_area_value: string | null;
  readonly prop_area_unit: string | null;
  readonly prop_price_per_area: string | null;
  readonly prop_consideration: string | null;
  readonly prop_stamp_duty: string | null;
  readonly prop_registration_fee: string | null;
  readonly prop_gst: string | null;
  readonly prop_other_taxes: string | null;
  readonly prop_brokerage: string | null;
  readonly prop_stamp_duty_value: string | null;
  readonly prop_document_ref: string | null;
}

interface BalanceAccountRow {
  readonly asset_id: string;
  readonly kind: string;
  readonly label: string;
  readonly institution_name: string | null;
  readonly account_ref: string | null;
  readonly opening_balance: string;
  readonly currency: string;
  readonly opened_on: string;
  readonly annual_rate_pct: string | null;
  readonly compounding: string | null;
  readonly monthly_contribution: string | null;
  readonly employer_contribution: string | null;
  readonly maturity_date: string | null;
  readonly maturity_value: string | null;
  readonly last_drawn_monthly: string | null;
  readonly closed_on: string | null;
  readonly notes: string | null;
}

interface PropertyRow {
  readonly asset_id: string;
  readonly property_name: string;
  readonly kind: string;
  readonly address_ref: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  readonly country: string | null;
  readonly area_value: string | null;
  readonly area_unit: string | null;
  readonly current_value: string | null;
  readonly current_value_ccy: string | null;
  readonly current_value_as_of: string | null;
  readonly current_value_basis: string | null;
  readonly registration_number: string | null;
  readonly survey_number: string | null;
  readonly notes: string | null;
}

/**
 * `consideration` is the presence test: it is the one figure a property
 * transaction cannot lack, so a row without it has no property detail rather
 * than an all-zero one. The duties default to zero because "not stated" and
 * "nil" are the same thing for a charge.
 */
function toPropertyTxn(row: PropertyTxnRow, currency: string): PropertyTransaction | undefined {
  if (row.prop_consideration === null) return undefined;

  const amount = (value: string | null): MoneyValue => money(value ?? '0', currency);

  return {
    ...(row.prop_area_value === null || row.prop_area_unit === null
      ? {}
      : { area: { value: row.prop_area_value, unit: row.prop_area_unit as AreaUnit } }),
    ...(row.prop_price_per_area === null
      ? {}
      : { pricePerAreaUnit: money(row.prop_price_per_area, currency) }),
    consideration: money(row.prop_consideration, currency),
    stampDuty: amount(row.prop_stamp_duty),
    registrationFee: amount(row.prop_registration_fee),
    gst: amount(row.prop_gst),
    otherTaxes: amount(row.prop_other_taxes),
    ...(row.prop_brokerage === null ? {} : { brokerage: money(row.prop_brokerage, currency) }),
    ...(row.prop_stamp_duty_value === null
      ? {}
      : { stampDutyValue: money(row.prop_stamp_duty_value, currency) }),
    ...(row.prop_document_ref === null ? {} : { documentRef: row.prop_document_ref }),
  };
}

/**
 * The eleven property columns, in the order both INSERT statements declare them.
 *
 * One function because the lot and the exit take the identical tail; two copies
 * of an eleven-placeholder argument list is a silent column-shift waiting to
 * happen, and a shifted TEXT column would store stamp duty as a GST figure
 * without any error.
 */
function propertyTxnArgs(txn: PropertyTransaction | undefined): readonly (string | null)[] {
  if (txn === undefined) return [null, null, null, null, null, null, null, null, null, null, null];
  return [
    txn.area?.value ?? null,
    txn.area?.unit ?? null,
    txn.pricePerAreaUnit?.amount ?? null,
    txn.consideration.amount,
    txn.stampDuty.amount,
    txn.registrationFee.amount,
    txn.gst.amount,
    txn.otherTaxes.amount,
    txn.brokerage?.amount ?? null,
    txn.stampDutyValue?.amount ?? null,
    txn.documentRef ?? null,
  ];
}

/**
 * A NULL rate comes back ABSENT, never as zero.
 *
 * `money(row.x ?? '0', …)` is the idiom two columns above, and it is wrong for
 * a rate: absent means "no rate was recorded, carry the balance flat and say
 * so", while zero means "this deposit earns nothing" — and the valuer treats
 * them differently on purpose. The same distinction bit the property import,
 * where a blank per-unit price read back as ₹0 and zeroed the price.
 */
function toBalanceAccount(row: BalanceAccountRow): BalanceAccount {
  const optional = (value: string | null): MoneyValue | undefined =>
    value === null ? undefined : money(value, row.currency);

  const monthly = optional(row.monthly_contribution);
  const employer = optional(row.employer_contribution);
  const maturityValue = optional(row.maturity_value);
  const lastDrawn = optional(row.last_drawn_monthly);

  return {
    assetId: row.asset_id,
    kind: row.kind as BalanceAccount['kind'],
    label: row.label,
    ...(row.institution_name === null ? {} : { institutionName: row.institution_name }),
    ...(row.account_ref === null ? {} : { accountRef: row.account_ref }),
    openingBalance: money(row.opening_balance, row.currency),
    openedOn: row.opened_on,
    ...(row.annual_rate_pct === null ? {} : { annualRatePct: row.annual_rate_pct }),
    ...(row.compounding === null
      ? {}
      : { compounding: row.compounding as NonNullable<BalanceAccount['compounding']> }),
    ...(monthly === undefined ? {} : { monthlyContribution: monthly }),
    ...(employer === undefined ? {} : { employerContribution: employer }),
    ...(row.maturity_date === null ? {} : { maturityDate: row.maturity_date }),
    ...(maturityValue === undefined ? {} : { maturityValue }),
    ...(lastDrawn === undefined ? {} : { lastDrawnMonthly: lastDrawn }),
    ...(row.closed_on === null ? {} : { closedOn: row.closed_on }),
    ...(row.notes === null ? {} : { notes: row.notes }),
  };
}

function toProperty(row: PropertyRow): ImmovableProperty {
  const location: PropertyLocation | undefined =
    row.address_ref === null &&
    row.address === null &&
    row.city === null &&
    row.state === null &&
    row.pincode === null
      ? undefined
      : {
          addressRef: row.address_ref ?? '',
          ...(row.address === null ? {} : { address: row.address }),
          ...(row.city === null ? {} : { city: row.city }),
          ...(row.state === null ? {} : { state: row.state }),
          ...(row.pincode === null ? {} : { pincode: row.pincode }),
          ...(row.country === null ? {} : { country: row.country }),
        };

  return {
    assetId: row.asset_id,
    propertyName: row.property_name,
    kind: row.kind as ImmovableProperty['kind'],
    ...(location === undefined ? {} : { location }),
    ...(row.area_value === null || row.area_unit === null
      ? {}
      : { area: { value: row.area_value, unit: row.area_unit as AreaUnit } }),
    // All four written together or not at all, so a value can never appear
    // without the basis and date that qualify it.
    ...(row.current_value === null ||
    row.current_value_as_of === null ||
    row.current_value_basis === null
      ? {}
      : {
          currentValue: {
            amount: money(row.current_value, row.current_value_ccy ?? 'INR'),
            asOf: row.current_value_as_of,
            basis: row.current_value_basis as ValuationBasis,
          },
        }),
    ...(row.registration_number === null ? {} : { registrationNumber: row.registration_number }),
    ...(row.survey_number === null ? {} : { surveyNumber: row.survey_number }),
    ...(row.notes === null ? {} : { notes: row.notes }),
  };
}

interface IncomeRow {
  readonly event_id: string;
  readonly asset_id: string;
  readonly kind: string;
  readonly date: string;
  readonly gross_amount: string;
  readonly tax_withheld: string;
  readonly net_amount: string;
  readonly currency: string;
  readonly withholding_rate_pct: string | null;
  readonly eligible_for_ftc: number;
  readonly taxable_inr: string | null;
}

interface ActionRow {
  readonly action_id: string;
  readonly asset_id: string;
  readonly kind: string;
  readonly record_date: string;
  readonly ratio_from: string;
  readonly ratio_to: string;
}

interface HandLoanRow {
  readonly asset_id: string;
  readonly borrower_ref: string;
  readonly borrower_name: string | null;
  readonly notes: string | null;
  readonly closed_date: string | null;
  readonly principal: string;
  readonly currency: string;
  readonly interest_rate_pct: string;
  readonly interest_basis: string;
  readonly start_date: string;
}

interface ChitFundRow {
  readonly asset_id: string;
  readonly org: string;
  readonly label: string;
  readonly target_amount: string;
  readonly currency: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly duration_months: number;
  readonly emi_type: string;
  readonly schedule_label: string | null;
  readonly status: string;
  readonly withdrawn_date: string | null;
  readonly withdrawn_amount: string | null;
  readonly comments: string | null;
}

interface ChitEmiRow {
  readonly emi_id: string;
  readonly asset_id: string;
  readonly date: string;
  readonly amount: string;
  readonly currency: string;
  readonly mode: string;
  readonly paid_to: string;
  readonly comments: string | null;
}

interface RepaymentRow {
  readonly repayment_id: string;
  readonly asset_id: string;
  readonly date: string;
  readonly principal: string;
  readonly currency: string;
  readonly mode: string | null;
  readonly notes: string | null;
}

interface InterestPaymentRow {
  readonly payment_id: string;
  readonly asset_id: string;
  readonly date: string;
  readonly amount: string;
  readonly currency: string;
  readonly mode: string;
  readonly notes: string | null;
}

interface AdvanceTaxPaymentRow {
  readonly payment_id: string;
  readonly financial_year: string;
  readonly quarter: string;
  readonly amount: string;
  readonly currency: string;
  readonly paid_on: string;
  readonly challan_ref: string | null;
  readonly notes: string | null;
}

interface LiabilityRow {
  readonly liability_id: string;
  readonly kind: string;
  readonly principal_outstanding: string;
  readonly currency: string;
  readonly interest_rate_pct: string;
  readonly as_of: string;
}

/**
 * Canonicalises on the way out of storage.
 *
 * The domain assumes every `Money.amount` is a bare decimal string; that was an
 * assumption rather than an enforced invariant, and a single row written as
 * `1,00,000` made `new Decimal(...)` throw on EVERY subsequent read — the loan
 * register returned 500 and the user could not even see which row to fix. This
 * is where the assumption becomes true.
 */
const money = (amount: string, currency: string): MoneyValue =>
  Money.fromStorage(amount, currency as Currency);

function requireUnlocked(): Result<void> {
  return Vault.isUnlocked() ? Ok(undefined) : Err(new VaultStateError('vault is locked'));
}

/* ------------------------------------------------------------------- read */

function toDualRate(row: LotRow): DualRate | undefined {
  if (row.valuation_rate === null || row.tax_rate === null) return undefined;
  return {
    valuationRate: row.valuation_rate,
    taxRate: row.tax_rate,
    valuationRateSource: (row.rate_source ?? 'MANUAL') as RateSource,
    taxRateSource: (row.tax_rate_source ?? row.rate_source ?? 'MANUAL') as RateSource,
    isFallback: row.fx_is_fallback === 1,
    ...(row.fx_fallback_note === null ? {} : { fallbackNote: row.fx_fallback_note }),
  };
}

/**
 * The grant this lot came out of.
 *
 * Keyed on `grant_ref` being present: every equity-award lot has one, and an
 * ordinary purchase has none. Rebuilt whole rather than field by field so a
 * half-written award can never masquerade as a complete one.
 */
function toEquityAward(row: LotRow): EquityAward | undefined {
  if (row.grant_ref === null || row.award_kind === null) return undefined;
  return {
    kind: row.award_kind as EquityAward['kind'],
    grantRef: row.grant_ref,
    ...(row.grant_date === null ? {} : { grantDate: row.grant_date }),
    ...(row.vest_date === null ? {} : { vestDate: row.vest_date }),
    ...(row.purchase_date === null ? {} : { purchaseDate: row.purchase_date }),
    ...(row.purchase_price === null
      ? {}
      : { purchasePrice: money(row.purchase_price, row.cost_currency) }),
    ...(row.discount_per_unit === null
      ? {}
      : { discountPerUnit: money(row.discount_per_unit, row.cost_currency) }),
    ...(row.fmv_at_acquisition === null
      ? {}
      : { fmvAtAcquisition: money(row.fmv_at_acquisition, row.cost_currency) }),
  };
}

function toLot(row: LotRow): AcquisitionLot {
  const fx = toDualRate(row);
  const equityAward = toEquityAward(row);
  return {
    lotId: row.lot_id,
    ...(equityAward === undefined ? {} : { equityAward }),
    acquisitionDate: row.acquisition_date,
    settlementDate: row.settlement_date,
    quantity: row.quantity,
    remainingQuantity: row.remaining_quantity,
    costPerUnit: money(row.cost_per_unit, row.cost_currency),
    fees: money(row.fees, row.cost_currency),
    stt: money(row.stt, row.cost_currency),
    otherCharges: money(row.other_charges, row.cost_currency),
    ...(fx === undefined ? {} : { fx }),
    ...(row.grandfathered_fmv === null
      ? {}
      : { grandfatheredFmv: money(row.grandfathered_fmv, row.cost_currency) }),
    ...(row.perquisite_value === null
      ? {}
      : { perquisiteValue: money(row.perquisite_value, row.cost_currency) }),
    ...(row.stated_remaining_quantity === null
      ? {}
      : { statedRemainingQuantity: row.stated_remaining_quantity }),
    ...(row.is_bonus === 1 ? { isBonus: true } : {}),
    ...(() => {
      const property = toPropertyTxn(row, row.cost_currency);
      return property === undefined ? {} : { property };
    })(),
  };
}

function toIncomeEvent(row: IncomeRow): IncomeEvent {
  return {
    eventId: row.event_id,
    assetId: row.asset_id,
    kind: row.kind as IncomeEvent['kind'],
    date: row.date,
    grossAmount: money(row.gross_amount, row.currency),
    taxWithheld: money(row.tax_withheld, row.currency),
    netAmount: money(row.net_amount, row.currency),
    ...(row.withholding_rate_pct === null
      ? {}
      : { withholdingRatePct: row.withholding_rate_pct }),
    eligibleForForeignTaxCredit: row.eligible_for_ftc === 1,
    ...(row.taxable_inr === null ? {} : { taxableInr: money(row.taxable_inr, 'INR') }),
  };
}

function toCorporateAction(row: ActionRow): CorporateAction {
  return {
    actionId: row.action_id,
    assetId: row.asset_id,
    kind: row.kind as CorporateAction['kind'],
    recordDate: row.record_date,
    ratio: { from: row.ratio_from, to: row.ratio_to },
  };
}

function toChitFund(row: ChitFundRow, emis: readonly ChitEmiRow[]): ChitFund {
  return {
    assetId: row.asset_id,
    org: row.org,
    label: row.label,
    targetAmount: money(row.target_amount, row.currency),
    startDate: row.start_date,
    endDate: row.end_date,
    durationMonths: row.duration_months,
    emiType: row.emi_type as ChitFund['emiType'],
    status: row.status as ChitFund['status'],
    ...(row.schedule_label === null ? {} : { scheduleLabel: row.schedule_label }),
    ...(row.withdrawn_date === null ? {} : { withdrawnDate: row.withdrawn_date }),
    ...(row.withdrawn_amount === null
      ? {}
      : { withdrawnAmount: money(row.withdrawn_amount, row.currency) }),
    ...(row.comments === null ? {} : { comments: row.comments }),
    emis: emis.map((emi) => ({
      emiId: emi.emi_id,
      date: emi.date,
      amount: money(emi.amount, emi.currency),
      mode: emi.mode as PaymentMode,
      paidTo: emi.paid_to,
      ...(emi.comments === null ? {} : { comments: emi.comments }),
    })),
  };
}

function toHandLoan(
  row: HandLoanRow,
  repayments: readonly RepaymentRow[],
  interestPayments: readonly InterestPaymentRow[],
): HandLoan {
  return {
    assetId: row.asset_id,
    borrowerRef: row.borrower_ref,
    ...(row.borrower_name === null ? {} : { borrowerName: row.borrower_name }),
    ...(row.notes === null ? {} : { notes: row.notes }),
    ...(row.closed_date === null ? {} : { closedDate: row.closed_date }),
    principal: money(row.principal, row.currency),
    interestRatePct: row.interest_rate_pct,
    interestBasis: row.interest_basis as HandLoan['interestBasis'],
    startDate: row.start_date,
    repayments: repayments.map((repayment) => ({
      date: repayment.date,
      principal: money(repayment.principal, repayment.currency),
      paymentId: repayment.repayment_id,
      ...(repayment.mode === null ? {} : { mode: repayment.mode as PaymentMode }),
      ...(repayment.notes === null ? {} : { notes: repayment.notes }),
    })),
    interestPayments: interestPayments.map((payment) => ({
      paymentId: payment.payment_id,
      date: payment.date,
      amount: money(payment.amount, payment.currency),
      mode: payment.mode as PaymentMode,
      ...(payment.notes === null ? {} : { notes: payment.notes }),
    })),
  };
}

function hydrate(row: AssetRow): Asset {
  const db = Vault.connection();
  const lots = db.prepare('SELECT * FROM lots WHERE asset_id = ? ORDER BY acquisition_date, lot_id')
    .all(row.asset_id) as LotRow[];
  const income = db.prepare('SELECT * FROM income_events WHERE asset_id = ? ORDER BY date, event_id')
    .all(row.asset_id) as IncomeRow[];
  const actions = db
    .prepare('SELECT * FROM corporate_actions WHERE asset_id = ? ORDER BY record_date, action_id')
    .all(row.asset_id) as ActionRow[];
  const loan = db.prepare('SELECT * FROM hand_loans WHERE asset_id = ?').get(row.asset_id) as
    | HandLoanRow
    | undefined;
  const repayments =
    loan === undefined
      ? []
      : (db
          .prepare('SELECT * FROM hand_loan_repayments WHERE asset_id = ? ORDER BY date')
          .all(row.asset_id) as RepaymentRow[]);
  const interestPayments =
    loan === undefined
      ? []
      : (db
          .prepare(
            'SELECT * FROM hand_loan_interest_payments WHERE asset_id = ? ORDER BY date, payment_id',
          )
          .all(row.asset_id) as InterestPaymentRow[]);

  const property = db.prepare('SELECT * FROM properties WHERE asset_id = ?').get(row.asset_id) as
    | PropertyRow
    | undefined;

  const balance = db
    .prepare('SELECT * FROM balance_accounts WHERE asset_id = ?')
    .get(row.asset_id) as BalanceAccountRow | undefined;

  const chit = db.prepare('SELECT * FROM chit_funds WHERE asset_id = ?').get(row.asset_id) as
    | ChitFundRow
    | undefined;
  const emis =
    chit === undefined
      ? []
      : (db
          .prepare('SELECT * FROM chit_emis WHERE asset_id = ? ORDER BY date, emi_id')
          .all(row.asset_id) as ChitEmiRow[]);

  return {
    assetId: row.asset_id,
    assetClass: row.asset_class as AssetClass,
    jurisdiction: row.jurisdiction as Jurisdiction,
    currency: row.currency as Currency,
    ...(row.symbol === null ? {} : { symbol: row.symbol }),
    ...(row.isin === null ? {} : { isin: row.isin }),
    ...(row.folio_ref === null ? {} : { folioRef: row.folio_ref }),
    lots: lots.map(toLot),
    incomeEvents: income.map(toIncomeEvent),
    corporateActions: actions.map(toCorporateAction),
    ...(row.liquidity === null ? {} : { liquidity: row.liquidity as Liquidity }),
    ...(row.position_closed === 1 ? { positionClosed: true } : {}),
    ...(loan === undefined ? {} : { handLoan: toHandLoan(loan, repayments, interestPayments) }),
    ...(chit === undefined ? {} : { chitFund: toChitFund(chit, emis) }),
    ...(property === undefined ? {} : { property: toProperty(property) }),
    ...(balance === undefined ? {} : { balanceAccount: toBalanceAccount(balance) }),
    ...(row.scheme_category === null
      ? {}
      : { schemeCategory: row.scheme_category as MfSchemeCategory }),
    ...(row.equity_allocation_pct === null
      ? {}
      : { equityAllocationPct: row.equity_allocation_pct }),
  };
}

/* ------------------------------------------------------------------ write */

function writeAsset(asset: Asset): void {
  const db = Vault.connection();

  db.prepare(
    `INSERT INTO assets
       (asset_id, asset_class, jurisdiction, currency, symbol, isin, folio_ref, liquidity,
        position_closed, scheme_category, equity_allocation_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       asset_class = excluded.asset_class,
       jurisdiction = excluded.jurisdiction,
       currency = excluded.currency,
       symbol = excluded.symbol,
       isin = excluded.isin,
       folio_ref = excluded.folio_ref,
       liquidity = excluded.liquidity,
       position_closed = excluded.position_closed,
       scheme_category = excluded.scheme_category,
       equity_allocation_pct = excluded.equity_allocation_pct`,
  ).run(
    asset.assetId,
    asset.assetClass,
    asset.jurisdiction,
    asset.currency,
    asset.symbol ?? null,
    asset.isin ?? null,
    asset.folioRef ?? null,
    asset.liquidity ?? null,
    asset.positionClosed === true ? 1 : 0,
    asset.schemeCategory ?? null,
    asset.equityAllocationPct ?? null,
  );

  // Replace-by-aggregate. Diffing children would leave a superseded lot in place
  // whenever one is removed, and a stale lot silently inflates the cost basis.
  for (const table of [
    'lots',
    'income_events',
    'corporate_actions',
    'hand_loan_repayments',
    'hand_loan_interest_payments',
    'chit_emis',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE asset_id = ?`).run(asset.assetId);
  }
  db.prepare('DELETE FROM hand_loans WHERE asset_id = ?').run(asset.assetId);
  db.prepare('DELETE FROM chit_funds WHERE asset_id = ?').run(asset.assetId);
  db.prepare('DELETE FROM properties WHERE asset_id = ?').run(asset.assetId);
  db.prepare('DELETE FROM balance_accounts WHERE asset_id = ?').run(asset.assetId);

  const insertLot = db.prepare(
    `INSERT INTO lots
       (lot_id, asset_id, acquisition_date, settlement_date, quantity, remaining_quantity,
        cost_per_unit, cost_currency, fees, stt, other_charges, valuation_rate, tax_rate,
        rate_source, tax_rate_source, fx_is_fallback, fx_fallback_note, grandfathered_fmv,
        perquisite_value, is_bonus, award_kind, grant_ref, grant_date, vest_date,
        purchase_date, purchase_price, discount_per_unit, fmv_at_acquisition,
        stated_remaining_quantity,
        prop_area_value, prop_area_unit, prop_price_per_area, prop_consideration,
        prop_stamp_duty, prop_registration_fee, prop_gst, prop_other_taxes,
        prop_brokerage, prop_stamp_duty_value, prop_document_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const lot of asset.lots) {
    insertLot.run(
      lot.lotId,
      asset.assetId,
      lot.acquisitionDate,
      lot.settlementDate,
      lot.quantity,
      lot.remainingQuantity,
      lot.costPerUnit.amount,
      lot.costPerUnit.currency,
      lot.fees.amount,
      lot.stt.amount,
      lot.otherCharges.amount,
      lot.fx?.valuationRate ?? null,
      lot.fx?.taxRate ?? null,
      lot.fx?.valuationRateSource ?? null,
      lot.fx?.taxRateSource ?? null,
      lot.fx === undefined ? null : lot.fx.isFallback ? 1 : 0,
      lot.fx?.fallbackNote ?? null,
      lot.grandfatheredFmv?.amount ?? null,
      lot.perquisiteValue?.amount ?? null,
      lot.isBonus === true ? 1 : 0,
      lot.equityAward?.kind ?? null,
      lot.equityAward?.grantRef ?? null,
      lot.equityAward?.grantDate ?? null,
      lot.equityAward?.vestDate ?? null,
      lot.equityAward?.purchaseDate ?? null,
      lot.equityAward?.purchasePrice?.amount ?? null,
      lot.equityAward?.discountPerUnit?.amount ?? null,
      lot.equityAward?.fmvAtAcquisition?.amount ?? null,
      lot.statedRemainingQuantity ?? null,
      ...propertyTxnArgs(lot.property),
    );
  }

  const insertIncome = db.prepare(
    `INSERT INTO income_events
       (event_id, asset_id, kind, date, gross_amount, tax_withheld, net_amount, currency,
        withholding_rate_pct, eligible_for_ftc, taxable_inr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of asset.incomeEvents) {
    insertIncome.run(
      event.eventId,
      asset.assetId,
      event.kind,
      event.date,
      event.grossAmount.amount,
      event.taxWithheld.amount,
      event.netAmount.amount,
      event.grossAmount.currency,
      event.withholdingRatePct ?? null,
      event.eligibleForForeignTaxCredit ? 1 : 0,
      event.taxableInr?.amount ?? null,
    );
  }

  const insertAction = db.prepare(
    `INSERT INTO corporate_actions (action_id, asset_id, kind, record_date, ratio_from, ratio_to)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const action of asset.corporateActions) {
    insertAction.run(
      action.actionId,
      asset.assetId,
      action.kind,
      action.recordDate,
      action.ratio.from,
      action.ratio.to,
    );
  }

  if (asset.handLoan !== undefined) {
    const loan = asset.handLoan;
    db.prepare(
      `INSERT INTO hand_loans
         (asset_id, borrower_ref, borrower_name, notes, closed_date, principal, currency,
          interest_rate_pct, interest_basis, start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.assetId,
      loan.borrowerRef,
      loan.borrowerName ?? null,
      loan.notes ?? null,
      loan.closedDate ?? null,
      loan.principal.amount,
      loan.principal.currency,
      loan.interestRatePct,
      loan.interestBasis,
      loan.startDate,
    );

    const insertRepayment = db.prepare(
      `INSERT INTO hand_loan_repayments
         (repayment_id, asset_id, date, principal, currency, mode, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    loan.repayments.forEach((repayment, index) => {
      insertRepayment.run(
        // Keeps its own id where it has one, so a repayment survives a re-save
        // with the same identity rather than being renumbered by position.
        repayment.paymentId ?? `${asset.assetId}_rep_${String(index).padStart(4, '0')}`,
        asset.assetId,
        repayment.date,
        repayment.principal.amount,
        repayment.principal.currency,
        repayment.mode ?? null,
        repayment.notes ?? null,
      );
    });

    const insertInterest = db.prepare(
      `INSERT INTO hand_loan_interest_payments
         (payment_id, asset_id, date, amount, currency, mode, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const payment of loan.interestPayments ?? []) {
      insertInterest.run(
        payment.paymentId,
        asset.assetId,
        payment.date,
        payment.amount.amount,
        payment.amount.currency,
        payment.mode,
        payment.notes ?? null,
      );
    }
  }

  if (asset.chitFund !== undefined) {
    const chit = asset.chitFund;
    db.prepare(
      `INSERT INTO chit_funds
         (asset_id, org, label, target_amount, currency, start_date, end_date, duration_months,
          emi_type, schedule_label, status, withdrawn_date, withdrawn_amount, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.assetId,
      chit.org,
      chit.label,
      chit.targetAmount.amount,
      chit.targetAmount.currency,
      chit.startDate,
      chit.endDate,
      chit.durationMonths,
      chit.emiType,
      chit.scheduleLabel ?? null,
      chit.status,
      chit.withdrawnDate ?? null,
      chit.withdrawnAmount?.amount ?? null,
      chit.comments ?? null,
    );

    const insertEmi = db.prepare(
      `INSERT INTO chit_emis (emi_id, asset_id, date, amount, currency, mode, paid_to, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const instalment of chit.emis) {
      insertEmi.run(
        instalment.emiId,
        asset.assetId,
        instalment.date,
        instalment.amount.amount,
        instalment.amount.currency,
        instalment.mode,
        instalment.paidTo,
        instalment.comments ?? null,
      );
    }
  }

  if (asset.property !== undefined) {
    const property = asset.property;
    db.prepare(
      `INSERT INTO properties
         (asset_id, property_name, kind, address_ref, address, city, state, pincode, country,
          area_value, area_unit, current_value, current_value_ccy, current_value_as_of,
          current_value_basis, registration_number, survey_number, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.assetId,
      property.propertyName,
      property.kind,
      property.location?.addressRef ?? null,
      property.location?.address ?? null,
      property.location?.city ?? null,
      property.location?.state ?? null,
      property.location?.pincode ?? null,
      property.location?.country ?? null,
      property.area?.value ?? null,
      property.area?.unit ?? null,
      // All four together. A value whose basis or date failed to write would be
      // read back as no value at all, which is the safe direction.
      property.currentValue?.amount.amount ?? null,
      property.currentValue?.amount.currency ?? null,
      property.currentValue?.asOf ?? null,
      property.currentValue?.basis ?? null,
      property.registrationNumber ?? null,
      property.surveyNumber ?? null,
      property.notes ?? null,
    );
  }

  if (asset.balanceAccount !== undefined) {
    const account = asset.balanceAccount;
    db.prepare(
      `INSERT INTO balance_accounts
         (asset_id, kind, label, institution_name, account_ref, opening_balance, currency,
          opened_on, annual_rate_pct, compounding, monthly_contribution, employer_contribution,
          maturity_date, maturity_value, last_drawn_monthly, closed_on, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.assetId,
      account.kind,
      account.label,
      account.institutionName ?? null,
      account.accountRef ?? null,
      account.openingBalance.amount,
      account.openingBalance.currency,
      account.openedOn,
      // `?? null`, not `?? '0'`: an absent rate is carried flat and explained,
      // and writing a zero here would make that indistinguishable from a
      // deposit that genuinely earns nothing.
      account.annualRatePct ?? null,
      account.compounding ?? null,
      account.monthlyContribution?.amount ?? null,
      account.employerContribution?.amount ?? null,
      account.maturityDate ?? null,
      account.maturityValue?.amount ?? null,
      account.lastDrawnMonthly?.amount ?? null,
      account.closedOn ?? null,
      account.notes ?? null,
    );
  }
}

export const AssetRepository = {
  save(asset: Asset): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection().transaction(() => { writeAsset(asset); })();
    return Promise.resolve(Ok(undefined));
  },

  /** One transaction for the whole batch: an import is all-or-nothing (US-4.1). */
  saveAll(assets: readonly Asset[]): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection().transaction(() => {
      for (const asset of assets) writeAsset(asset);
    })();
    return Promise.resolve(Ok(undefined));
  },

  findById(assetId: string): Promise<Asset | undefined> {
    if (!Vault.isUnlocked()) return Promise.resolve(undefined);
    const row = Vault.connection().prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId) as
      | AssetRow
      | undefined;
    return Promise.resolve(row === undefined ? undefined : hydrate(row));
  },

  all(): Promise<readonly Asset[]> {
    // A locked vault has no assets to report. Throwing here would make every
    // read path responsible for the lock state; returning empty keeps "locked"
    // and "empty" distinguishable at the one layer that can tell them apart.
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare('SELECT * FROM assets ORDER BY asset_class, symbol, asset_id')
      .all() as AssetRow[];
    return Promise.resolve(rows.map(hydrate));
  },

  /**
   * Removes one asset and everything hanging off it.
   *
   * The child rows go by `ON DELETE CASCADE`, which only fires because the vault
   * sets `foreign_keys=ON` at unlock — without that pragma SQLite would leave
   * orphaned lots behind and this would look like it had worked.
   *
   * `hand_loan_audit` deliberately does NOT cascade (see the v6 migration): the
   * trail for a deleted loan is the one thing that can still answer what
   * happened to it.
   */
  delete(assetId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection().prepare('DELETE FROM assets WHERE asset_id = ?').run(assetId);
    return Promise.resolve(Ok(undefined));
  },

  deleteAll(): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection().exec('DELETE FROM assets');
    return Promise.resolve(Ok(undefined));
  },
};

interface ExitRow {
  readonly txn_id: string;
  readonly asset_id: string;
  readonly exit_date: string;
  readonly acquisition_date: string | null;
  readonly quantity: string;
  readonly price_per_unit: string;
  readonly currency: string;
  readonly fees: string;
  readonly stt: string;
  readonly allocations: string;
  readonly valuation_rate: string | null;
  readonly tax_rate: string | null;
  readonly rate_source: string | null;
  readonly tax_rate_source: string | null;
  readonly fx_is_fallback: number | null;
  readonly fx_fallback_note: string | null;
  readonly valuation_inr: string | null;
  readonly proceeds_tax_inr: string | null;
  readonly cost_basis_tax_inr: string | null;
  readonly taxable_gain_inr: string | null;
  readonly disposal_kind: string | null;
  readonly order_ref: string | null;
  readonly lot_matching: string | null;
  readonly prop_area_value: string | null;
  readonly prop_area_unit: string | null;
  readonly prop_price_per_area: string | null;
  readonly prop_consideration: string | null;
  readonly prop_stamp_duty: string | null;
  readonly prop_registration_fee: string | null;
  readonly prop_gst: string | null;
  readonly prop_other_taxes: string | null;
  readonly prop_brokerage: string | null;
  readonly prop_stamp_duty_value: string | null;
  readonly prop_document_ref: string | null;
}

function toExit(row: ExitRow): ExitTransaction {
  const fx: DualRate | undefined =
    row.valuation_rate === null || row.tax_rate === null
      ? undefined
      : {
          valuationRate: row.valuation_rate,
          taxRate: row.tax_rate,
          valuationRateSource: (row.rate_source ?? 'MANUAL') as RateSource,
          taxRateSource: (row.tax_rate_source ?? row.rate_source ?? 'MANUAL') as RateSource,
          isFallback: row.fx_is_fallback === 1,
          ...(row.fx_fallback_note === null ? {} : { fallbackNote: row.fx_fallback_note }),
        };

  return {
    txnId: row.txn_id,
    assetId: row.asset_id,
    exitDate: row.exit_date,
    ...(row.acquisition_date === null ? {} : { acquisitionDate: row.acquisition_date }),
    quantity: row.quantity,
    pricePerUnit: money(row.price_per_unit, row.currency),
    fees: money(row.fees, row.currency),
    stt: money(row.stt, row.currency),
    allocations: JSON.parse(row.allocations) as LotAllocation[],
    ...(fx === undefined ? {} : { fx }),
    ...(row.valuation_inr === null ? {} : { valuationInr: money(row.valuation_inr, 'INR') }),
    ...(row.proceeds_tax_inr === null
      ? {}
      : { proceedsTaxInr: money(row.proceeds_tax_inr, 'INR') }),
    ...(row.cost_basis_tax_inr === null
      ? {}
      : { costBasisTaxInr: money(row.cost_basis_tax_inr, 'INR') }),
    ...(row.taxable_gain_inr === null
      ? {}
      : { taxableGainInr: money(row.taxable_gain_inr, 'INR') }),
    ...(row.disposal_kind === null
      ? {}
      : { disposalKind: row.disposal_kind as NonNullable<ExitTransaction['disposalKind']> }),
    ...(row.order_ref === null ? {} : { orderRef: row.order_ref }),
    // NULL reads as FIFO: every disposal written before the column existed was
    // matched that way, and leaving it absent would make them look unrecorded.
    lotMatching: (row.lot_matching ?? 'FIFO') as NonNullable<ExitTransaction['lotMatching']>,
    ...(() => {
      const property = toPropertyTxn(row, row.currency);
      return property === undefined ? {} : { property };
    })(),
  };
}

/**
 * Disposals (US-1.3, US-2.x).
 *
 * Kept separate from the Asset aggregate on purpose: `AssetRepository.save`
 * replaces an asset's children wholesale, and an exit must NOT be erased by a
 * later re-save of the holding it came from.
 */
export const ExitRepository = {
  saveAll(exits: readonly ExitTransaction[]): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);

    const db = Vault.connection();
    const insert = db.prepare(
      `INSERT INTO exits
         (txn_id, asset_id, exit_date, acquisition_date, quantity, price_per_unit, currency,
          fees, stt, allocations, valuation_rate, tax_rate, rate_source, tax_rate_source,
          fx_is_fallback, fx_fallback_note, valuation_inr, proceeds_tax_inr,
          cost_basis_tax_inr, taxable_gain_inr, disposal_kind, order_ref, lot_matching,
          prop_area_value, prop_area_unit, prop_price_per_area, prop_consideration,
          prop_stamp_duty, prop_registration_fee, prop_gst, prop_other_taxes,
          prop_brokerage, prop_stamp_duty_value, prop_document_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txn_id) DO NOTHING`,
    );

    db.transaction(() => {
      for (const exit of exits) {
        insert.run(
          exit.txnId,
          exit.assetId,
          exit.exitDate,
          exit.acquisitionDate ?? null,
          exit.quantity,
          exit.pricePerUnit.amount,
          exit.pricePerUnit.currency,
          exit.fees.amount,
          exit.stt.amount,
          JSON.stringify(exit.allocations),
          exit.fx?.valuationRate ?? null,
          exit.fx?.taxRate ?? null,
          exit.fx?.valuationRateSource ?? null,
          exit.fx?.taxRateSource ?? null,
          exit.fx === undefined ? null : exit.fx.isFallback ? 1 : 0,
          exit.fx?.fallbackNote ?? null,
          exit.valuationInr?.amount ?? null,
          exit.proceedsTaxInr?.amount ?? null,
          exit.costBasisTaxInr?.amount ?? null,
          exit.taxableGainInr?.amount ?? null,
          exit.disposalKind ?? null,
          exit.orderRef ?? null,
          exit.lotMatching ?? null,
          ...propertyTxnArgs(exit.property),
        );
      }
    })();
    return Promise.resolve(Ok(undefined));
  },

  findById(txnId: string): Promise<ExitTransaction | undefined> {
    if (!Vault.isUnlocked()) return Promise.resolve(undefined);
    const row = Vault.connection().prepare('SELECT * FROM exits WHERE txn_id = ?').get(txnId) as
      | ExitRow
      | undefined;
    return Promise.resolve(row === undefined ? undefined : toExit(row));
  },

  all(): Promise<readonly ExitTransaction[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare('SELECT * FROM exits ORDER BY exit_date, txn_id')
      .all() as ExitRow[];
    return Promise.resolve(rows.map(toExit));
  },

  /**
   * Removes a disposal and re-saves the holdings it depleted, in ONE transaction.
   *
   * The two halves cannot be separate calls. Deleting the exit without restoring
   * the lots understates the holding; restoring the lots without deleting the
   * exit counts the same units twice. Either failing alone leaves a ledger whose
   * quantity nothing downstream can tell is wrong.
   *
   * The restored assets are computed by the caller and merely written here —
   * this layer decides nothing about what a reversal means.
   */
  deleteWithAssets(txnId: string, assets: readonly Asset[]): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);

    const db = Vault.connection();
    db.transaction(() => {
      db.prepare('DELETE FROM exits WHERE txn_id = ?').run(txnId);
      for (const asset of assets) writeAsset(asset);
    })();
    return Promise.resolve(Ok(undefined));
  },
};

/**
 * Small singular application state, inside the encrypted vault.
 *
 * Values are opaque JSON to this layer on purpose: it stores and returns them
 * without interpretation, so adding a setting never requires a migration.
 */
export const SettingsRepository = {
  get(key: string): Promise<string | undefined> {
    if (!Vault.isUnlocked()) return Promise.resolve(undefined);
    const row = Vault.connection().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return Promise.resolve(row?.value);
  },

  set(key: string, value: string, updatedAt: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedAt);
    return Promise.resolve(Ok(undefined));
  },

  delete(key: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection().prepare('DELETE FROM settings WHERE key = ?').run(key);
    return Promise.resolve(Ok(undefined));
  },
};

/**
 * Advance tax already paid (US-5.10).
 *
 * Read on every instalment computation: the quarters are cumulative, so Q3's
 * demand is the year's liability at 75% LESS everything already remitted. A
 * missing payment here does not under-report — it over-demands, asking again for
 * tax the taxpayer has a challan for.
 */
export const AdvanceTaxPaymentRepository = {
  save(payment: AdvanceTaxPayment): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);

    Vault.connection()
      .prepare(
        `INSERT INTO advance_tax_payments
           (payment_id, financial_year, quarter, amount, currency, paid_on, challan_ref, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(payment_id) DO UPDATE SET
           amount = excluded.amount, paid_on = excluded.paid_on,
           challan_ref = excluded.challan_ref, notes = excluded.notes`,
      )
      .run(
        payment.paymentId,
        payment.financialYear,
        payment.quarter,
        payment.amount.amount,
        payment.amount.currency,
        payment.paidOn,
        payment.challanRef ?? null,
        payment.notes ?? null,
      );
    return Promise.resolve(Ok(undefined));
  },

  forYear(financialYear: string): Promise<readonly AdvanceTaxPayment[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare(
        'SELECT * FROM advance_tax_payments WHERE financial_year = ? ORDER BY paid_on, payment_id',
      )
      .all(financialYear) as AdvanceTaxPaymentRow[];

    return Promise.resolve(
      rows.map((row) => ({
        paymentId: row.payment_id,
        financialYear: row.financial_year,
        quarter: row.quarter as AdvanceTaxPayment['quarter'],
        amount: money(row.amount, row.currency),
        paidOn: row.paid_on,
        ...(row.challan_ref === null ? {} : { challanRef: row.challan_ref }),
        ...(row.notes === null ? {} : { notes: row.notes }),
      })),
    );
  },

  delete(paymentId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection()
      .prepare('DELETE FROM advance_tax_payments WHERE payment_id = ?')
      .run(paymentId);
    return Promise.resolve(Ok(undefined));
  },
};

export const LiabilityRepository = {
  save(liability: Liability): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    Vault.connection()
      .prepare(
        `INSERT INTO liabilities
           (liability_id, kind, principal_outstanding, currency, interest_rate_pct, as_of)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(liability_id) DO UPDATE SET
           kind = excluded.kind,
           principal_outstanding = excluded.principal_outstanding,
           currency = excluded.currency,
           interest_rate_pct = excluded.interest_rate_pct,
           as_of = excluded.as_of`,
      )
      .run(
        liability.liabilityId,
        liability.kind,
        liability.principalOutstanding.amount,
        liability.principalOutstanding.currency,
        liability.interestRatePct,
        liability.asOf,
      );
    return Promise.resolve(Ok(undefined));
  },

  all(): Promise<readonly Liability[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const rows = Vault.connection()
      .prepare('SELECT * FROM liabilities ORDER BY liability_id')
      .all() as LiabilityRow[];
    return Promise.resolve(
      rows.map((row) => ({
        liabilityId: row.liability_id,
        kind: row.kind as Liability['kind'],
        principalOutstanding: money(row.principal_outstanding, row.currency),
        interestRatePct: row.interest_rate_pct,
        asOf: row.as_of,
      })),
    );
  },
};
