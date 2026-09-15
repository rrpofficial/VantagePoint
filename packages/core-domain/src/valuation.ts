/**
 * Portfolio valuation (US-1.7, US-1.15, PRD NFR-2).
 *
 * Prices and FX rates arrive through injected ports, not by reaching out — that is
 * what keeps this package pure and the sub-1.5s budget attainable: every rate is
 * resolved from an in-memory map, never per-lot I/O.
 *
 * Where no market price exists (real estate, unlisted shares, hand loans), the
 * position is valued at cost. That is a deliberate conservative default: inventing
 * a market value for an illiquid asset would corrupt net worth, and Schedule AL
 * wants cost anyway.
 */
import {
  Money,
  RateUnavailableError,
  type Clock,
  type Money as MoneyValue,
} from '@vantagepoint/shared-kernel';
import { Decimal } from 'decimal.js';
import { totalCostBasis } from './lots.js';
import { handLoanAccruedInterest, handLoanOutstandingPrincipal } from './accruals.js';
import { viewOf as chitViewOf } from './chit-book.js';
import { viewOf as balanceViewOf } from './balance-account.js';
import { JURISDICTION, LIQUIDITY } from './taxonomy.js';
import type {
  Asset,
  AssetClass,
  Liability,
  PortfolioValuation,
  PriceQuote,
  PriceSource,
  FxSource,
  ValuationInput,
  ValuedPosition,
} from './types.js';

const INR = 'INR' as const;

function positionCostBasis(asset: Asset): MoneyValue {
  const lots = asset.lots.filter((lot) => new Decimal(lot.remainingQuantity).greaterThan(0));
  if (lots.length === 0) return Money.zero(asset.currency);
  // Cost of the units still held, plus the charges that formed the basis.
  const parts = lots.map((lot) => {
    const proportion = new Decimal(lot.remainingQuantity).dividedBy(lot.quantity);
    return Money.multiply(totalCostBasis(lot), proportion.toFixed());
  });
  return Money.sum(parts, asset.currency);
}

/**
 * Whether the single `handLoan` block can speak for the whole asset.
 *
 * A `HandLoan` carries ONE principal, rate and start date, so it describes one
 * receivable. An asset that somehow accumulated several lots holds several
 * loans, and valuing it from that one block reports the first and discards the
 * rest — which is exactly how ₹26,00,000 of money lent vanished from a net worth
 * that still looked plausible.
 *
 * Falling back to cost basis here loses accrued interest, which is a visible
 * understatement of a few percent. Reading one principal loses an entire loan.
 * Between two imperfect answers this is the one a user can notice.
 */
function describesEveryLot(asset: Asset): boolean {
  return asset.lots.length <= 1;
}

/**
 * Interest accrued but not yet received — the part that is still a receivable.
 *
 * Clamped at zero: a borrower who has overpaid interest is not an extra asset,
 * and a negative here would quietly reduce net worth.
 */
function unpaidInterest(loan: NonNullable<Asset['handLoan']>, asOf: string): MoneyValue {
  const accrued = handLoanAccruedInterest(loan, asOf);
  const paid = Money.sum(
    (loan.interestPayments ?? []).map((payment) => payment.amount),
    accrued.currency,
  );
  return Money.compare(paid, accrued) >= 0 ? Money.zero(accrued.currency) : Money.subtract(accrued, paid);
}

function heldQuantity(asset: Asset): string {
  return asset.lots
    .reduce((sum, lot) => sum.plus(lot.remainingQuantity), new Decimal(0))
    .toFixed();
}

function toInr(amount: MoneyValue, asOf: string, fx: FxSource | undefined): MoneyValue {
  if (amount.currency === INR) return amount;
  const rate = fx?.rateFor(amount.currency, asOf);
  if (rate === undefined) {
    // Never substitute 1.0 and never pass the foreign amount through: either would
    // understate net worth by roughly the exchange rate. Fail loudly instead.
    throw new RateUnavailableError(
      `no ${amount.currency}/INR valuation rate available for ${asOf}`,
    );
  }
  return Money.round(
    Money.of(new Decimal(amount.amount).times(rate).toFixed(), INR),
    2,
    'HALF_UP',
  );
}

function marketValueOf(
  asset: Asset,
  quantity: string,
  asOf: string,
  prices: PriceSource | undefined,
): { value: MoneyValue; quote: PriceQuote | undefined } {
  const quote = prices?.priceFor({
    assetId: asset.assetId,
    assetClass: asset.assetClass,
    asOf,
    ...(asset.isin === undefined ? {} : { isin: asset.isin }),
    ...(asset.symbol === undefined ? {} : { symbol: asset.symbol }),
  });

  if (quote === undefined) return { value: positionCostBasis(asset), quote: undefined };

  const value = Money.round(
    Money.multiply(quote.price, quantity),
    2,
    'HALF_UP',
  );
  return { value, quote };
}

/**
 * What a valuer is handed, and what it must answer with.
 *
 * `costBasis` comes back alongside the value because for several kinds the two
 * are not the price and the quantity: a hand loan's basis is the principal still
 * owed, a chit's is what has been paid in, and a gratuity entitlement has no
 * cost at all.
 */
interface ValuerInput {
  readonly asset: Asset;
  readonly quantity: string;
  readonly asOf: string;
  readonly prices: PriceSource | undefined;
}

interface ValuerOutput {
  readonly value: MoneyValue;
  readonly costBasis: MoneyValue;
  readonly navSource?: ValuedPosition['navSource'];
}

type Valuer = (input: ValuerInput) => ValuerOutput;

/**
 * Market price where one exists, cost where none does.
 *
 * The conservative default, and deliberately the fallback for every kind whose
 * own valuer cannot speak: inventing a market value for an illiquid asset would
 * corrupt net worth, and Schedule AL wants cost anyway.
 */
const marketElseCost: Valuer = ({ asset, quantity, asOf, prices }) => {
  const { value: marketValue, quote } = marketValueOf(asset, quantity, asOf, prices);
  return {
    value: marketValue,
    costBasis: positionCostBasis(asset),
    ...(quote === undefined ? {} : { navSource: quote.source }),
  };
};

const handLoanValuer: Valuer = (input) => {
  const loan = input.asset.handLoan;
  if (loan === undefined || !describesEveryLot(input.asset)) return marketElseCost(input);

  /*
   * ONE loan. Its cost basis is the principal still owed, and its value is that
   * principal plus the interest still OUTSTANDING.
   *
   * Outstanding, not accrued: interest the borrower has already paid is now cash
   * in a bank account, and counting it here as well would report it twice. The
   * receivable is what has not arrived.
   */
  const costBasis = handLoanOutstandingPrincipal(loan, input.asOf);
  return { value: Money.add(costBasis, unpaidInterest(loan, input.asOf)), costBasis };
};

const chitValuer: Valuer = (input) => {
  const chit = input.asset.chitFund;
  if (chit === undefined) return marketElseCost(input);

  /*
   * Contributions at cost, and nil once withdrawn.
   *
   * NOT the chit's face value: a ₹5,00,000 chit two instalments old is a
   * ₹40,000 asset, and carrying it at face would overstate net worth by the
   * entire undrawn amount. And once the pot is drawn it is cash in a bank
   * account, counted there — carrying the instalments here as well would count
   * the same rupees twice.
   */
  const view = chitViewOf(chit, input.asOf);
  return { value: view.carryingValue, costBasis: view.carryingValue };
};

/**
 * Deposits, retirement schemes, cash and gratuity (Phase 5).
 *
 * One valuer for ten asset classes, because they differ by asset class and agree
 * by behaviour — see `BalanceAccountKind`. This is the whole point of the
 * registry: before it, each of these would have been another `else if` in the
 * function every net-worth figure passes through.
 */
const balanceValuer: Valuer = (input) => {
  const account = input.asset.balanceAccount;
  // No bag yet — an asset class that CAN be a balance but was imported as
  // something else. Cost basis is the honest answer, not an assumed rate.
  if (account === undefined) return marketElseCost(input);

  const view = balanceViewOf(account, input.asOf);
  return { value: view.value, costBasis: view.contributed };
};

/**
 * The dispatch table D-3 asks for, replacing a closed `if/else if` chain.
 *
 * Anything absent here uses `marketElseCost`, so adding an asset class is a
 * compile-clean no-op until someone writes a valuer for it — rather than silently
 * falling into whichever branch happened to be last.
 */
const VALUERS: Readonly<Partial<Record<AssetClass, Valuer>>> = {
  HAND_LOAN: handLoanValuer,
  CHIT_FUND: chitValuer,
  FIXED_DEPOSIT: balanceValuer,
  RECURRING_DEPOSIT: balanceValuer,
  EPF: balanceValuer,
  VPF: balanceValuer,
  PPF: balanceValuer,
  NPS_TIER_I: balanceValuer,
  NPS_TIER_II: balanceValuer,
  GRATUITY: balanceValuer,
  CASH_IN_HAND: balanceValuer,
  BANK_BALANCE: balanceValuer,
};

export function value(input: ValuationInput): PortfolioValuation {
  const asOfDate = input.asOf.slice(0, 10);
  const positions: ValuedPosition[] = [];

  for (const asset of input.assets) {
    const quantity = heldQuantity(asset);
    const valuer = VALUERS[asset.assetClass] ?? marketElseCost;
    const {
      value: native,
      costBasis,
      navSource,
    } = valuer({ asset, quantity, asOf: asOfDate, prices: input.prices });

    // Retained for price-vs-currency attribution downstream (US-3.7).
    const fxRate = asset.currency === INR ? undefined : input.fx?.rateFor(asset.currency, asOfDate);

    positions.push({
      assetId: asset.assetId,
      assetClass: asset.assetClass,
      jurisdiction: JURISDICTION[asset.assetClass],
      quantity,
      marketValue: toInr(native, asOfDate, input.fx),
      costBasis: toInr(costBasis, asOfDate, input.fx),
      ...(asset.currency === INR ? {} : { nativeValue: native }),
      ...(fxRate === undefined ? {} : { fxRate }),
      ...(navSource === undefined ? {} : { navSource }),
      ...(LIQUIDITY[asset.assetClass] === undefined
        ? {}
        : { liquidity: LIQUIDITY[asset.assetClass] }),
    });
  }

  const byAssetClass: Partial<Record<AssetClass, MoneyValue>> = {};
  for (const position of positions) {
    const running = byAssetClass[position.assetClass];
    byAssetClass[position.assetClass] =
      running === undefined ? position.marketValue : Money.add(running, position.marketValue);
  }

  const grossAssets = Money.sum(
    positions.map((p) => p.marketValue),
    INR,
  );
  const totalLiabilities = Money.sum(
    input.liabilities.map((liability: Liability) =>
      toInr(liability.principalOutstanding, asOfDate, input.fx),
    ),
    INR,
  );

  return {
    asOf: input.asOf,
    positions,
    grossAssets,
    totalLiabilities,
    netWorth: Money.subtract(grossAssets, totalLiabilities),
    byAssetClass,
  };
}

/** Convenience for callers holding a Clock rather than an explicit instant. */
export function valueNow(
  input: Omit<ValuationInput, 'asOf'> & { clock: Clock },
): PortfolioValuation {
  return value({ ...input, asOf: input.clock.now() });
}
