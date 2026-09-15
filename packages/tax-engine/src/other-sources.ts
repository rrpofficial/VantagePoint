/**
 * Other-sources income aggregation (US-5.9, PRD FR-5.3).
 *
 * Hand loan interest, deposit interest and dividends all land here, and each
 * component keeps its source so the advance tax figure can be explained rather
 * than merely asserted.
 */
import { Money, type Money as MoneyValue } from '@vantagepoint/shared-kernel';
import type { IncomeEvent } from '@vantagepoint/core-domain';
import type { TraceLine } from './types.js';

const INR = 'INR' as const;

export function aggregate(
  events: readonly IncomeEvent[],
  accruals: readonly { readonly label: string; readonly amount: MoneyValue }[],
): { total: MoneyValue; items: readonly TraceLine[] } {
  const items: TraceLine[] = [];

  for (const accrual of accruals) {
    items.push({
      label: accrual.label,
      ruleRef: 'incomeTaxAct.section56.otherSources',
      inputs: {},
      amount: accrual.amount,
    });
  }

  for (const event of events) {
    items.push({
      label: `${event.kind} ${event.assetId}`,
      ruleRef: 'incomeTaxAct.section56.otherSources',
      inputs: { date: event.date },
      // Gross, not net: withheld tax is a prepayment, credited separately.
      amount: event.taxableInr ?? event.grossAmount,
    });
  }

  return { total: Money.sum(items.map((item) => item.amount), INR), items };
}

/** Tax already remitted on the taxpayer's behalf, creditable against the liability. */
export function withholdingCredit(events: readonly IncomeEvent[]): MoneyValue {
  return Money.sum(
    events.filter((event) => !event.eligibleForForeignTaxCredit).map((event) => event.taxWithheld),
    INR,
  );
}
