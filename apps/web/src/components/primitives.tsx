/**
 * Presentational primitives, styled entirely from design tokens (PRD FR-9.1).
 * No component declares a raw colour — a guard test asserts it.
 */
import type { ReactNode } from 'react';
import type { Money } from '../api.js';
import { navigate } from '../router.js';

export function Card({ children, title, action }: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <section className="pt-card">
      {title !== undefined && (
        <header className="pt-card__head">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * Symbols for the currencies this product actually holds. Anything else falls
 * back to its ISO code, which is unambiguous even when unfamiliar.
 */
const SYMBOL: Readonly<Record<string, string>> = {
  INR: '₹',
  USD: '$',
  GBP: '£',
  EUR: '€',
};

/**
 * Always marks the currency. Never a bare number.
 *
 * A foreign amount previously rendered with NO symbol at all, so a column of
 * rupees ended with `88,711` that was in fact dollars — indistinguishable from
 * the ₹ figures above it, and out by the exchange rate. An unlabelled number in
 * a money column is read as the currency of the column.
 */
export function formatMoney(money: Money): string {
  const value = Number(money.amount);
  const symbol = SYMBOL[money.currency];
  return symbol === undefined
    ? `${money.currency} ${INR.format(value)}`
    : `${symbol}${INR.format(value)}`;
}

/**
 * Financial direction is shown by sign AND colour, never colour alone (NFR-4).
 * Roughly one man in twelve cannot separate the gain and loss hues reliably.
 */
export function Delta({ value }: { value: Money }) {
  const amount = Number(value.amount);
  const direction = amount > 0 ? 'gain' : amount < 0 ? 'loss' : 'flat';
  const arrow = amount > 0 ? '▲' : amount < 0 ? '▼' : '■';
  const sign = amount > 0 ? '+' : '';
  return (
    <span className={`pt-delta pt-delta--${direction} pt-numeric`}>
      <span aria-hidden="true">{arrow}</span> {sign}
      {formatMoney(value)}
    </span>
  );
}

export function Amount({ value }: { value: Money }) {
  return <span className="pt-numeric">{formatMoney(value)}</span>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="pt-chip">{children}</span>;
}

/**
 * Sends the reader to the Import screen from whichever asset tab they are on.
 *
 * On every tab whose holdings can arrive by import, not only on the empty ones.
 * A tab that offers the route into bulk entry while it is empty and withdraws it
 * once a single row exists is offering it at exactly the wrong moment: the
 * second statement of the year is the one nobody wants to retype.
 *
 * One component rather than five copies, because the label is the affordance —
 * five tabs each inventing their own wording for the same destination is how a
 * nav stops being predictable.
 */
export function GoToImport({ testId }: { testId?: string }) {
  return (
    <button
      type="button"
      className="pt-button-inline"
      data-testid={testId ?? 'go-to-import'}
      onClick={() => {
        navigate('Import');
      }}
    >
      Go to Import
    </button>
  );
}

/**
 * Shown wherever a tax figure appears while the FY rule set is provisional.
 * A number that cannot be filed must not look like one that can.
 */
export function ProvisionalBanner() {
  return (
    <div className="pt-banner" role="status">
      <strong>Provisional tax rates.</strong> These figures are computed from an unverified rule set
      and cannot be used for filing until the rates are sourced from the Finance Act.
    </div>
  );
}
