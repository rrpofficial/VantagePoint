/**
 * Entering a balance-shaped holding by hand (Phase 5).
 *
 * Deliberately NOT routed through `LedgerProjector`, which is where trades and
 * property go. A projector exists to match a disposal against acquisition lots
 * FIFO and produce the record the capital-gains engine reads; a fixed deposit has
 * no lots, no disposal and no FIFO queue. Forcing it through that shape is
 * exactly the mistake §3 Phase 5 warns about — it is what left the accrual
 * functions unreachable in the first place.
 *
 * Validation lives here rather than in the use case so it can be exercised
 * without a vault, and so the API and any future importer share one definition
 * of a valid balance entry.
 */
import {
  Err,
  Money,
  Ok,
  VaultStateError,
  type Currency,
  type IsoDate,
  type Money as MoneyValue,
  type Percentage,
  type Result,
} from '@vantagepoint/shared-kernel';
import { JURISDICTION, LIQUIDITY, isAssetClass, type Asset, type AssetClass, type BalanceAccount } from '@vantagepoint/core-domain';
import { createHash } from 'node:crypto';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BalanceClassOption {
  readonly assetClass: AssetClass;
  readonly kind: BalanceAccount['kind'];
  readonly label: string;
  /** One line of guidance about what the opening balance and date mean here. */
  readonly guidance: string;
}

/**
 * The ten classes that are balances rather than quantities at a price.
 *
 * `kind` is the behaviour, and several classes share one: EPF, VPF and PPF are
 * one arithmetic, and NPS I/II, cash and a bank balance are another. That
 * collapse is what keeps the valuer registry to a single balance valuer.
 *
 * Gold and crypto are absent on purpose. They ARE quantities at a price — ten
 * grams bought at a rate, sold FIFO, with a cost basis and a capital gain — so
 * they belong in `MANUAL_TRADE_CLASSES` beside listed equity, not here.
 */
export const BALANCE_CLASSES: readonly BalanceClassOption[] = [
  {
    assetClass: 'FIXED_DEPOSIT',
    kind: 'TERM_DEPOSIT',
    label: 'Fixed deposit',
    guidance:
      'The amount deposited and the date it was booked. Interest compounds to maturity and stops there.',
  },
  {
    assetClass: 'RECURRING_DEPOSIT',
    kind: 'RECURRING_DEPOSIT',
    label: 'Recurring deposit',
    guidance:
      'The monthly instalment and the date of the first one. Each instalment compounds from the date it was paid.',
  },
  {
    assetClass: 'EPF',
    kind: 'PROVIDENT_FUND',
    label: 'Employees’ Provident Fund (EPF)',
    guidance:
      'The balance from your latest statement and ITS date — not the date the account was opened, which would compound contributions already inside that balance.',
  },
  {
    assetClass: 'VPF',
    kind: 'PROVIDENT_FUND',
    label: 'Voluntary Provident Fund (VPF)',
    guidance: 'As EPF: the balance from your latest statement, and the date that balance was true.',
  },
  {
    assetClass: 'PPF',
    kind: 'PROVIDENT_FUND',
    label: 'Public Provident Fund (PPF)',
    guidance:
      'The balance from your latest statement and its date, plus what you pay in each month.',
  },
  {
    assetClass: 'NPS_TIER_I',
    kind: 'STATED_BALANCE',
    label: 'NPS Tier I',
    guidance:
      'The corpus as your last statement shows it. It moves with NAV, which this application has no feed for, so it stays where you put it until you restate it.',
  },
  {
    assetClass: 'NPS_TIER_II',
    kind: 'STATED_BALANCE',
    label: 'NPS Tier II',
    guidance: 'As Tier I: a figure you state and restate.',
  },
  {
    assetClass: 'BANK_BALANCE',
    kind: 'STATED_BALANCE',
    label: 'Bank balance',
    guidance:
      'The balance as at a date you choose. It moves with transactions, not with a rate, so it is carried flat until you restate it.',
  },
  {
    assetClass: 'CASH_IN_HAND',
    kind: 'STATED_BALANCE',
    label: 'Cash in hand',
    guidance: 'What you are holding, as at a date.',
  },
  {
    assetClass: 'GRATUITY',
    kind: 'GRATUITY',
    label: 'Gratuity entitlement',
    guidance:
      'Your last drawn monthly wage and the date service began. The entitlement is 15/26 of a month per completed year, and is nil below five years.',
  },
];

const BY_CLASS = new Map(BALANCE_CLASSES.map((entry) => [entry.assetClass as string, entry]));

export interface RecordBalanceInput {
  readonly assetClass: string;
  readonly label: string;
  readonly openingBalance: string;
  readonly openedOn: IsoDate;
  readonly currency?: Currency;
  readonly institutionName?: string;
  /** The raw account number. Digested here; the plain value is never stored. */
  readonly accountNumber?: string;
  readonly annualRatePct?: string;
  readonly compounding?: string;
  readonly monthlyContribution?: string;
  readonly employerContribution?: string;
  readonly maturityDate?: IsoDate;
  readonly maturityValue?: string;
  readonly lastDrawnMonthly?: string;
  readonly closedOn?: IsoDate;
  readonly notes?: string;
}

const COMPOUNDING = new Set(['MONTHLY', 'QUARTERLY', 'ANNUAL']);

/**
 * An account number identifies a person to their bank, so it follows the
 * borrower-name rule (ADR-013, FR-7.2): the digest is what is stored and what
 * leaves, and the number itself never reaches the vault at all.
 *
 * Deterministic, so re-entering the same account resolves to the same reference
 * rather than fragmenting one deposit into several.
 */
export function accountRefOf(accountNumber: string): string {
  return `acct_${createHash('sha256').update(accountNumber.trim()).digest('hex').slice(0, 16)}`;
}

/**
 * Identity derived from what the account IS, not from when it was typed.
 *
 * Re-entering the same deposit therefore updates it rather than creating a
 * second one — which matters more here than for a trade, because two fills of
 * one order are a real thing and two identical fixed deposits at one bank on one
 * date are almost always the same deposit entered twice.
 */
export function balanceAssetIdOf(input: {
  assetClass: string;
  label: string;
  institutionName?: string;
  openedOn: string;
}): string {
  const token = createHash('sha256')
    .update(
      [
        input.assetClass,
        input.label.trim().toLowerCase(),
        (input.institutionName ?? '').trim().toLowerCase(),
        input.openedOn,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 12);
  return `ast_${input.assetClass.toLowerCase()}_${token}`;
}

/** Parsed, never trusted: `1,00,000` is exactly how a deposit figure is typed. */
function optionalMoney(
  value: string | undefined,
  currency: Currency,
): Result<MoneyValue | undefined> {
  if (value === undefined || value.trim().length === 0) return Ok(undefined);
  const parsed = Money.parse(value, currency);
  return parsed.ok ? Ok(parsed.value) : parsed;
}

/**
 * A rate, as a plain decimal string.
 *
 * Absent stays absent. Returning `'0'` for a blank field would make "no rate was
 * recorded" indistinguishable from "this deposit earns nothing", and the valuer
 * treats those differently on purpose — one is explained on screen, the other is
 * a fact about the deposit.
 */
function optionalRate(value: string | undefined): Result<Percentage | undefined> {
  if (value === undefined || value.trim().length === 0) return Ok(undefined);
  const parsed = Money.parse(value, 'INR');
  if (!parsed.ok) return Err(new VaultStateError('an interest rate must be a number'));
  if (Money.compare(parsed.value, Money.zero('INR')) < 0) {
    return Err(new VaultStateError('an interest rate cannot be negative'));
  }
  return Ok(parsed.value.amount);
}

export function buildBalanceEntry(input: RecordBalanceInput): Result<Asset> {
  const option = BY_CLASS.get(input.assetClass);
  if (option === undefined || !isAssetClass(input.assetClass)) {
    return Err(
      new VaultStateError(
        `${input.assetClass} is not a balance-type holding; record it as a trade instead`,
      ),
    );
  }

  const currency = input.currency ?? 'INR';
  if (!ISO_DATE.test(input.openedOn)) {
    return Err(new VaultStateError('a balance needs the date it was true, as YYYY-MM-DD'));
  }
  if (input.label.trim().length === 0) {
    return Err(new VaultStateError('a balance needs a name you will recognise'));
  }
  for (const [field, value] of [
    ['maturity date', input.maturityDate],
    ['closing date', input.closedOn],
  ] as const) {
    if (value !== undefined && value.length > 0 && !ISO_DATE.test(value)) {
      return Err(new VaultStateError(`a ${field} must be written as YYYY-MM-DD`));
    }
  }

  const opening = Money.parse(
    input.openingBalance.trim().length === 0 ? '0' : input.openingBalance,
    currency,
  );
  if (!opening.ok) return opening;
  if (Money.compare(opening.value, Money.zero(currency)) < 0) {
    return Err(new VaultStateError('a balance cannot be negative'));
  }

  const rate = optionalRate(input.annualRatePct);
  if (!rate.ok) return rate;
  const monthly = optionalMoney(input.monthlyContribution, currency);
  if (!monthly.ok) return monthly;
  const employer = optionalMoney(input.employerContribution, currency);
  if (!employer.ok) return employer;
  const maturityValue = optionalMoney(input.maturityValue, currency);
  if (!maturityValue.ok) return maturityValue;
  const lastDrawn = optionalMoney(input.lastDrawnMonthly, currency);
  if (!lastDrawn.ok) return lastDrawn;

  if (input.compounding !== undefined && !COMPOUNDING.has(input.compounding)) {
    return Err(new VaultStateError('compounding must be MONTHLY, QUARTERLY or ANNUAL'));
  }

  /*
   * The two entries that would otherwise record a holding worth nothing and say
   * nothing about why. Both are the whole basis of their kind's arithmetic.
   */
  if (option.kind === 'GRATUITY' && lastDrawn.value === undefined) {
    return Err(
      new VaultStateError('a gratuity entitlement needs the last drawn monthly wage it is computed from'),
    );
  }
  if (
    option.kind === 'RECURRING_DEPOSIT' &&
    (monthly.value === undefined || Money.compare(monthly.value, Money.zero(currency)) <= 0)
  ) {
    return Err(new VaultStateError('a recurring deposit needs a monthly instalment'));
  }

  const assetId = balanceAssetIdOf({
    assetClass: input.assetClass,
    label: input.label,
    ...(input.institutionName === undefined ? {} : { institutionName: input.institutionName }),
    openedOn: input.openedOn,
  });

  const assetClass: AssetClass = input.assetClass;
  const liquidity = LIQUIDITY[assetClass];
  const institutionName = input.institutionName?.trim();
  const accountNumber = input.accountNumber?.trim();

  const account: BalanceAccount = {
    assetId,
    kind: option.kind,
    label: input.label.trim(),
    ...(institutionName === undefined || institutionName.length === 0 ? {} : { institutionName }),
    ...(accountNumber === undefined || accountNumber.length === 0
      ? {}
      : { accountRef: accountRefOf(accountNumber) }),
    openingBalance: opening.value,
    openedOn: input.openedOn,
    ...(rate.value === undefined ? {} : { annualRatePct: rate.value }),
    ...(input.compounding === undefined
      ? {}
      : { compounding: input.compounding as NonNullable<BalanceAccount['compounding']> }),
    ...(monthly.value === undefined ? {} : { monthlyContribution: monthly.value }),
    ...(employer.value === undefined ? {} : { employerContribution: employer.value }),
    ...(input.maturityDate === undefined || input.maturityDate.length === 0
      ? {}
      : { maturityDate: input.maturityDate }),
    ...(maturityValue.value === undefined ? {} : { maturityValue: maturityValue.value }),
    ...(lastDrawn.value === undefined ? {} : { lastDrawnMonthly: lastDrawn.value }),
    ...(input.closedOn === undefined || input.closedOn.length === 0
      ? {}
      : { closedOn: input.closedOn }),
    ...(input.notes === undefined || input.notes.trim().length === 0
      ? {}
      : { notes: input.notes.trim() }),
  };

  return Ok({
    assetId,
    assetClass,
    jurisdiction: JURISDICTION[assetClass],
    currency,
    // No lots, no disposals, no corporate actions — that is what makes this a
    // balance rather than a position.
    lots: [],
    incomeEvents: [],
    corporateActions: [],
    ...(liquidity === undefined ? {} : { liquidity }),
    balanceAccount: account,
  });
}
