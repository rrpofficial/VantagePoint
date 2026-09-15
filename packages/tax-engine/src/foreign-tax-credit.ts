/**
 * Foreign tax credit / DTAA relief (US-5.11).
 *
 * Relief is the LOWER of foreign tax actually paid and the Indian tax on the same
 * doubly-taxed income. Granting the full foreign tax would refund another
 * country's excess out of the Indian exchequer; the excess is therefore reported
 * as non-creditable rather than silently dropped, because the taxpayer may be
 * able to reclaim it in the source country.
 */
import { Money, type Money as MoneyValue } from '@vantagepoint/shared-kernel';

export function compute(input: {
  foreignTaxPaid: MoneyValue;
  indianTaxOnDoublyTaxedIncome: MoneyValue;
}): { credit: MoneyValue; nonCreditable: MoneyValue } {
  const capped = Money.compare(input.foreignTaxPaid, input.indianTaxOnDoublyTaxedIncome) > 0;
  const credit = capped ? input.indianTaxOnDoublyTaxedIncome : input.foreignTaxPaid;
  return { credit, nonCreditable: Money.subtract(input.foreignTaxPaid, credit) };
}
