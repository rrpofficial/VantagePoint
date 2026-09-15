/**
 * HNI classification (US-5.6, ADR-004).
 *
 * HNI status is either test: income above ₹50 lakh OR net worth above ₹10 crore.
 * Schedule AL, however, is triggered by the INCOME test alone — a taxpayer with a
 * large portfolio but modest income is an HNI for our purposes without owing that
 * disclosure, and conflating the two would demand a filing that is not required.
 */
import { Money } from '@vantagepoint/shared-kernel';
import type { HniClassification, HniInput } from './types.js';

export function classify(input: HniInput): HniClassification {
  const { rules } = input;
  const incomeAbove = Money.compare(input.totalIncome, rules.hniIncomeThreshold) > 0;
  const netWorthAbove = Money.compare(input.netWorth, rules.hniNetWorthThreshold) > 0;
  const scheduleAlRequired =
    Money.compare(input.totalIncome, rules.scheduleAlIncomeThreshold) > 0;

  if (incomeAbove) return { isHni: true, reason: 'INCOME_ABOVE_50L', scheduleAlRequired };
  if (netWorthAbove) return { isHni: true, reason: 'NET_WORTH_ABOVE_10CR', scheduleAlRequired };
  return { isHni: false, reason: 'NOT_HNI', scheduleAlRequired };
}
