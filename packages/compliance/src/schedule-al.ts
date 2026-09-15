/**
 * Schedule AL — assets and liabilities at year end (US-6.4, PRD FR-6.2).
 *
 * **Reported at COST OF ACQUISITION, not market value.** A property bought for
 * ₹1.59 crore and now worth ₹3.2 crore is disclosed at ₹1.59 crore. Substituting
 * market value overstates the schedule and contradicts every other figure the
 * return carries for the same asset.
 *
 * Required only when total income exceeds the statutory threshold. Generating it
 * regardless would invite a filing that is not owed.
 */
import { Money, Ok, type Money as MoneyValue, type Result } from '@vantagepoint/shared-kernel';
import type { ScheduleAl, ScheduleAlInput, ScheduleAlItem, ScheduleAlSection } from './types.js';

const INR = 'INR' as const;

const section = (head: string, items: readonly ScheduleAlItem[]): ScheduleAlSection => ({
  head,
  items,
  total: Money.sum(items.map((item) => item.costOfAcquisition), INR),
});

const pick = (items: readonly ScheduleAlItem[], head: string): ScheduleAlItem[] =>
  items.filter((item) => item.head === head);

export function generate(input: ScheduleAlInput): Result<ScheduleAl> {
  const required = Money.compare(input.totalIncome, input.threshold ?? DEFAULT_THRESHOLD) > 0;
  const items = input.items ?? [];

  const schedule: ScheduleAl = {
    assessmentYear: input.assessmentYear,
    required,
    ...(required
      ? {}
      : {
          notRequiredReason:
            'Schedule AL applies only where total income exceeds the statutory threshold',
        }),
    immovableProperty: section('Immovable property', pick(items, 'IMMOVABLE_PROPERTY')),
    financialAssets: section('Financial assets', pick(items, 'FINANCIAL_ASSETS')),
    cashInHand: section('Cash in hand', pick(items, 'CASH_IN_HAND')),
    loansAndAdvancesGiven: section('Loans and advances given', pick(items, 'LOANS_AND_ADVANCES')),
    jewellery: section('Jewellery, bullion etc.', pick(items, 'JEWELLERY')),
    vehicles: section('Vehicles, yachts, aircraft', pick(items, 'VEHICLES')),
    // Reported under their own head, never as negative assets (ADR-009).
    liabilities: section('Liabilities', pick(items, 'LIABILITIES')),
  };

  return Ok(schedule);
}

const DEFAULT_THRESHOLD: MoneyValue = { amount: '5000000', currency: INR };
