/**
 * Income under the head "other sources", derived from the ledger (Phase 2, D-4).
 *
 * `OtherSourcesAggregator` was written, unit-tested, and had **zero callers**.
 * The only route into the tax computation was `IncomeProfile.otherSourcesIncome`
 * — a number the user types — so a dividend recorded against a holding, and
 * interest accruing on a hand loan, reached no tax figure at all.
 *
 * ## Manual and derived are composed, not substituted
 *
 * The typed figure stays. A user has income this ledger does not know about —
 * a savings account nobody imported, a bond held elsewhere — and discarding what
 * they typed in favour of what could be derived would silently drop it.
 *
 * The consequence is that a dividend BOTH typed into the profile and recorded
 * against a holding is counted twice. That is not something this can detect, so
 * the trace names every component and its source: the user can see the two
 * lines and remove one. Silent netting would be the worse answer, because an
 * under-reported income is the direction that carries interest under s.234B/C.
 *
 * ## Nothing is included by the product's own choice
 *
 * Hand-loan interest and chit returns are gated on `IncomeInclusions`, which
 * defaults every one of them to OFF. These are tax positions the taxpayer takes,
 * not defaults this application is entitled to assume on their behalf — see the
 * note on that module.
 */
import { Money, FyCalendar, type FinancialYear, type IsoDate, type Money as MoneyValue } from '@vantagepoint/shared-kernel';
import {
  AccrualEngine,
  balanceInterestAccruedBetween,
  chitViewOf,
  type Asset,
  type IncomeEvent,
} from '@vantagepoint/core-domain';
import { OtherSourcesAggregator } from '@vantagepoint/tax-engine';
import type { TraceLine } from '@vantagepoint/tax-engine';
import { AssetRepository } from '@vantagepoint/persistence';
import { incomeInclusionsOf } from './income-inclusions.js';

export interface DerivedOtherSources {
  /** What the ledger says, before the typed figure is added to it. */
  readonly derived: MoneyValue;
  /** The typed figure from the income profile, carried through unchanged. */
  readonly manual: MoneyValue;
  /** `derived + manual` — what the tax computation should use. */
  readonly total: MoneyValue;
  /** One line per component, each with its rule reference and source. */
  readonly items: readonly TraceLine[];
  /**
   * Income this ledger holds but was NOT counted, and why.
   *
   * Reported rather than dropped: a user who has recorded hand-loan interest and
   * sees it missing from the tax figure needs to know it is a setting, not a
   * bug. The amounts are stated so the size of the choice is visible.
   */
  readonly excluded: readonly { label: string; amount: MoneyValue; reason: string }[];
}

/** Income events recorded against a holding, inside the financial year. */
function eventsInYear(
  assets: readonly Asset[],
  from: IsoDate,
  to: IsoDate,
): readonly IncomeEvent[] {
  return assets.flatMap((asset) =>
    asset.incomeEvents.filter((event) => event.date >= from && event.date <= to),
  );
}

/**
 * Interest that accrued DURING the year, not the cumulative figure.
 *
 * `handLoanAccruedInterest` is cumulative from the loan's start date, so the
 * year's income is the difference across the two boundaries. Using the closing
 * figure alone would tax the whole life of the loan in every year it is open —
 * an error that grows with the age of the loan and never corrects itself.
 */
function accruedDuring(
  loan: NonNullable<Asset['handLoan']>,
  from: IsoDate,
  to: IsoDate,
): MoneyValue {
  const opening = AccrualEngine.handLoanAccruedInterest(loan, from);
  const closing = AccrualEngine.handLoanAccruedInterest(loan, to);
  const difference = Money.subtract(closing, opening);
  // Clamped: a repayment dated inside the year can move the opening figure past
  // the closing one, and negative income from a loan is not a thing.
  return Money.compare(difference, Money.zero(difference.currency)) < 0
    ? Money.zero(difference.currency)
    : difference;
}

/**
 * Composes every other-sources component for the year.
 *
 * `manual` is the profile's typed figure; pass `Money.zero('INR')` to see what
 * the ledger alone accounts for.
 */
export async function deriveOtherSources(
  financialYear: FinancialYear,
  manual: MoneyValue,
): Promise<DerivedOtherSources> {
  const inclusions = incomeInclusionsOf();
  const assets = await AssetRepository.all();

  const from = FyCalendar.fyStart(financialYear);
  const to = FyCalendar.fyEnd(financialYear);

  const excluded: { label: string; amount: MoneyValue; reason: string }[] = [];
  const accruals: { label: string; amount: MoneyValue }[] = [];

  for (const asset of assets) {
    if (asset.handLoan !== undefined) {
      const amount = accruedDuring(asset.handLoan, from, to);
      if (Money.compare(amount, Money.zero(amount.currency)) <= 0) continue;

      const label = `Hand loan interest · ${asset.handLoan.borrowerName ?? asset.handLoan.borrowerRef}`;
      if (inclusions.handLoanInterest) {
        accruals.push({ label, amount });
      } else {
        excluded.push({
          label,
          amount,
          reason: 'hand-loan interest is switched off in Settings → income inclusions',
        });
      }
    }

    /*
     * Deposit interest (Phase 5).
     *
     * Unconditional, unlike hand-loan interest and chit returns. Those are gated
     * because whether they are income at all is a position the taxpayer takes;
     * interest on a fixed or recurring deposit is not — it is chargeable under
     * s.56(2)(viii) / s.93 of the 2025 Act whether or not it has been withdrawn,
     * and a switch would imply a choice that does not exist.
     *
     * Provident-fund interest is the genuine exception and is EXCLUDED with its
     * reason stated: it is exempt under s.10(11)/(12), except on contributions
     * above the ₹2,50,000 annual threshold, and this application does not hold
     * the contribution history that decides which part of a balance is which.
     * Taxing the whole of it would be worse than reporting it and saying so.
     */
    if (asset.balanceAccount !== undefined) {
      const account = asset.balanceAccount;
      const amount = balanceInterestAccruedBetween(account, from, to);
      if (Money.compare(amount, Money.zero(amount.currency)) > 0) {
        const label = `Deposit interest · ${account.label}`;
        if (account.kind === 'PROVIDENT_FUND') {
          excluded.push({
            label: `Provident fund interest · ${account.label}`,
            amount,
            reason:
              'provident fund interest is exempt under s.10(11)/(12) except on contributions above the ₹2,50,000 annual threshold, and VantagePoint does not hold the contribution history that decides the split',
          });
        } else {
          accruals.push({ label, amount });
        }
      }
    }

    if (asset.chitFund !== undefined) {
      /*
       * A chit's surplus is the amount drawn above what was paid in. It arises
       * only on a withdrawn chit, and only when the draw exceeded contributions
       * — an early bidder pays a discount and has no surplus at all.
       */
      const view = chitViewOf(asset.chitFund, to);
      const drawn = asset.chitFund.withdrawnAmount;
      if (drawn === undefined || asset.chitFund.withdrawnDate === undefined) continue;
      if (asset.chitFund.withdrawnDate < from || asset.chitFund.withdrawnDate > to) continue;

      const surplus = Money.subtract(drawn, view.paidToDate);
      if (Money.compare(surplus, Money.zero(surplus.currency)) <= 0) continue;

      const label = `Chit surplus · ${asset.chitFund.label}`;
      if (inclusions.chitFundReturns) {
        accruals.push({ label, amount: surplus });
      } else {
        excluded.push({
          label,
          amount: surplus,
          reason: 'chit fund returns are switched off in Settings → income inclusions',
        });
      }
    }
  }

  const events = eventsInYear(assets, from, to);
  const aggregated = OtherSourcesAggregator.aggregate(events, accruals);

  const items: TraceLine[] = [...aggregated.items];
  if (Money.compare(manual, Money.zero('INR')) > 0) {
    items.push({
      label: 'Entered manually in the income profile',
      ruleRef: 'incomeTaxAct.section56.otherSources',
      inputs: { source: 'income profile' },
      amount: manual,
    });
  }

  return {
    derived: aggregated.total,
    manual,
    total: Money.sum([aggregated.total, manual], 'INR'),
    items,
    excluded,
  };
}
