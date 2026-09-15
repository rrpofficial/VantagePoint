/**
 * US-1.11 — duplicate detection and the audit trail.
 *
 * The scenarios are written from the lender's side of the desk: two loans to
 * one person on one day, and a principal that was typed wrong and has to be
 * corrected years later without destroying the evidence of what it said before.
 */
import { describe, it, expect } from 'vitest';
import { applyLoanEdit, loanDuplicatesOf, type HandLoan } from '@vantagepoint/core-domain';

const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const loan = (overrides: Partial<HandLoan> = {}): HandLoan => ({
  assetId: 'ast_hand_loan_brw_0001_2025_04_01_100000',
  borrowerRef: 'brw_0001',
  borrowerName: 'Rajesh Sharma',
  principal: inr('100000'),
  interestRatePct: '12',
  interestBasis: 'SIMPLE',
  startDate: '2025-04-01',
  repayments: [],
  ...overrides,
});

const context = { recordedAt: '2026-08-09T10:00:00+00:00', entryId: (i: number) => `aud_${String(i)}` };

describe('US-1.11 Scenario: A second loan to the same borrower on the same day', () => {
  it('reports the existing loan rather than silently accepting the new one', () => {
    const existing = [loan()];

    const matches = loanDuplicatesOf({ borrowerRef: 'brw_0001', loanDate: '2025-04-01' }, existing);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.assetId).toBe('ast_hand_loan_brw_0001_2025_04_01_100000');
  });

  it('flags a same-day loan even when the amount differs', () => {
    // The amount is deliberately not part of the test. Two loans to one person
    // on one day are worth a question whatever the sums involved.
    const existing = [loan({ principal: inr('250000') })];

    const matches = loanDuplicatesOf({ borrowerRef: 'brw_0001', loanDate: '2025-04-01' }, existing);

    expect(matches).toHaveLength(1);
  });

  it('does not flag the same borrower on a different day', () => {
    const existing = [loan()];

    expect(
      loanDuplicatesOf({ borrowerRef: 'brw_0001', loanDate: '2025-04-02' }, existing),
    ).toHaveLength(0);
  });

  it('does not flag a different borrower on the same day', () => {
    const existing = [loan()];

    expect(
      loanDuplicatesOf({ borrowerRef: 'brw_9999', loanDate: '2025-04-01' }, existing),
    ).toHaveLength(0);
  });
});

describe('US-1.11 Scenario: A mistyped principal is corrected', () => {
  it('records the old and the new value, with the reason', () => {
    const result = applyLoanEdit(loan(), { principalAmount: '150000' }, {
      ...context,
      reason: 'amount was mistyped at entry',
    });

    expect(result.loan.principal.amount).toBe('150000');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      action: 'EDITED',
      field: 'Principal',
      oldValue: '100000',
      newValue: '150000',
      reason: 'amount was mistyped at entry',
      recordedAt: '2026-08-09T10:00:00+00:00',
    });
  });

  it('writes one entry per field that actually moved, and none for the rest', () => {
    const result = applyLoanEdit(
      loan(),
      // Borrower and date are resubmitted unchanged; only the rate moves.
      { borrowerName: 'Rajesh Sharma', loanDate: '2025-04-01', interestRatePct: '18' },
      context,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.field).toBe('Interest rate %');
  });

  it('leaves no trace at all when nothing changed', () => {
    // Opening the edit form and pressing save must not fill the trail with
    // entries that say nothing — a noisy trail stops being read.
    const result = applyLoanEdit(loan(), { borrowerName: 'Rajesh Sharma', notes: '' }, context);

    expect(result.entries).toEqual([]);
  });
});

describe('US-1.11 Scenario: Closing and reopening through the edit form', () => {
  it('records a closed date', () => {
    const result = applyLoanEdit(loan(), { closedDate: '2026-03-31' }, context);

    expect(result.loan.closedDate).toBe('2026-03-31');
    expect(result.entries[0]).toMatchObject({ field: 'Closed date', oldValue: '', newValue: '2026-03-31' });
  });

  it('clears the closed date on null, which is how a loan reopens', () => {
    // null and undefined are genuinely different here: undefined means "not
    // part of this edit", and collapsing them would make reopening impossible
    // through the form that closes.
    const closed = loan({ closedDate: '2026-03-31' });

    const result = applyLoanEdit(closed, { closedDate: null }, context);

    expect(result.loan.closedDate).toBeUndefined();
    expect(result.entries[0]).toMatchObject({ oldValue: '2026-03-31', newValue: '' });
  });

  it('leaves the loan untouched when closedDate is absent from the edit', () => {
    const closed = loan({ closedDate: '2026-03-31' });

    const result = applyLoanEdit(closed, { notes: 'chased by phone' }, context);

    expect(result.loan.closedDate).toBe('2026-03-31');
  });
});

describe('US-1.11 Scenario: The edit is unrestricted by design', () => {
  it('permits a principal below what has already been repaid', () => {
    // A deliberate product decision: the lender knows why, and a tracker that
    // refuses the correction sends them back to the spreadsheet.
    const repaid = loan({
      repayments: [{ paymentId: 'rep_1', date: '2025-06-01', principal: inr('80000') }],
    });

    const result = applyLoanEdit(repaid, { principalAmount: '50000' }, context);

    expect(result.loan.principal.amount).toBe('50000');
    expect(result.entries).toHaveLength(1);
  });

  it('permits a loan date after an existing repayment', () => {
    const repaid = loan({
      repayments: [{ paymentId: 'rep_1', date: '2025-06-01', principal: inr('10000') }],
    });

    const result = applyLoanEdit(repaid, { loanDate: '2025-12-01' }, context);

    expect(result.loan.startDate).toBe('2025-12-01');
  });
});
