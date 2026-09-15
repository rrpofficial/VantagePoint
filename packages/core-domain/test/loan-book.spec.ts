/**
 * US-1.11 — the hand-loan register.
 *
 * The figures here replace a spreadsheet, so the tests are written as the
 * spreadsheet's own arithmetic: a stated principal at a stated rate over a
 * stated period, with the expected interest worked out by hand in the comment.
 * Anything I cannot derive by hand is not something a lender can check either.
 */
import { describe, it, expect } from 'vitest';
import { HandLoanLedger, loanRegister, type HandLoan } from '@vantagepoint/core-domain';

const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const baseLoan: HandLoan = {
  assetId: 'loan_0001',
  borrowerRef: 'brw_0001',
  borrowerName: 'Rajesh Sharma',
  principal: inr('1200000'),
  interestRatePct: '12',
  interestBasis: 'SIMPLE',
  startDate: '2025-04-01',
  repayments: [],
};

const view = (loan: HandLoan, asOf: string) => HandLoanLedger.viewOf(loan, asOf);

describe('US-1.11 Scenario: A live loan accrues on its full principal', () => {
  it('accrues one year of simple interest exactly', () => {
    // ₹12,00,000 at 12% for exactly one year (30/360) = ₹1,44,000.
    const result = view(baseLoan, '2026-04-01');
    expect(result.totalInterestAccrued.amount).toBe('144000');
    expect(result.status).toBe('ACTIVE');
    expect(result.outstandingPrincipal.amount).toBe('1200000');
  });

  it('reports interest per month on the outstanding principal', () => {
    // 12% of ₹12,00,000 = ₹1,44,000 a year = ₹12,000 a month.
    expect(view(baseLoan, '2026-04-01').interestPerMonth.amount).toBe('12000');
  });

  it('counts the months the loan has been running', () => {
    expect(view(baseLoan, '2026-04-01').totalInterestMonths).toBe(12);
    expect(view(baseLoan, '2025-10-01').totalInterestMonths).toBe(6);
  });

  it('accrues nothing on the day it is lent', () => {
    expect(view(baseLoan, '2025-04-01').totalInterestAccrued.amount).toBe('0');
  });
});

describe('US-1.11 Scenario: A partial repayment reduces what earns interest', () => {
  const partiallyRepaid: HandLoan = {
    ...baseLoan,
    repayments: [{ date: '2025-10-01', principal: inr('600000'), mode: 'BANK_TRANSFER' }],
  };

  it('charges the full principal only until the repayment date', () => {
    /*
     * Six months on ₹12,00,000 at 12% = ₹72,000, then six months on the
     * remaining ₹6,00,000 = ₹36,000. Total ₹1,08,000 — not the ₹1,44,000 a
     * spreadsheet charging the original sum throughout would show.
     */
    const result = view(partiallyRepaid, '2026-04-01');
    expect(result.totalInterestAccrued.amount).toBe('108000');
  });

  it('reports the loan as partially repaid', () => {
    const result = view(partiallyRepaid, '2026-04-01');
    expect(result.status).toBe('PARTIALLY_REPAID');
    expect(result.principalRepaid.amount).toBe('600000');
    expect(result.outstandingPrincipal.amount).toBe('600000');
  });

  it('halves the monthly interest from the repayment date', () => {
    expect(view(partiallyRepaid, '2026-04-01').interestPerMonth.amount).toBe('6000');
  });

  it('still shows the full principal as originally lent', () => {
    expect(view(partiallyRepaid, '2026-04-01').principal.amount).toBe('1200000');
  });
});

describe('US-1.11 Scenario: Interest payments do not repay principal', () => {
  const withInterestPaid: HandLoan = {
    ...baseLoan,
    interestPayments: [
      { paymentId: 'p1', date: '2025-07-01', amount: inr('36000'), mode: 'UPI' },
      { paymentId: 'p2', date: '2025-10-01', amount: inr('36000'), mode: 'UPI' },
    ],
  };

  it('leaves the principal untouched', () => {
    const result = view(withInterestPaid, '2026-04-01');
    // The failure this guards: treating interest as repayment would report
    // ₹11,28,000 outstanding and quietly write off ₹72,000 of principal.
    expect(result.outstandingPrincipal.amount).toBe('1200000');
    expect(result.status).toBe('ACTIVE');
  });

  it('reduces the interest balance by what was paid', () => {
    const result = view(withInterestPaid, '2026-04-01');
    expect(result.totalInterestAccrued.amount).toBe('144000');
    expect(result.interestPaid.amount).toBe('72000');
    expect(result.interestBalance.amount).toBe('72000');
  });

  it('expresses the balance in months at the current rate', () => {
    // ₹72,000 outstanding at ₹12,000 a month = 6.0 months.
    expect(view(withInterestPaid, '2026-04-01').interestBalanceMonths).toBe('6.0');
  });

  it('records every payment, not just the four a spreadsheet had room for', () => {
    const many: HandLoan = {
      ...baseLoan,
      interestPayments: Array.from({ length: 9 }, (_, index) => ({
        paymentId: `p${String(index)}`,
        date: `2025-0${String((index % 9) + 1)}-15`,
        amount: inr('12000'),
        mode: 'CASH' as const,
      })),
    };
    expect(view(many, '2026-04-01').interestPayments).toHaveLength(9);
  });
});

describe('US-1.11 Scenario: Interest can still be owed after the principal comes back', () => {
  const fullyRepaidPrincipal: HandLoan = {
    ...baseLoan,
    repayments: [{ date: '2026-04-01', principal: inr('1200000'), mode: 'BANK_TRANSFER' }],
  };

  it('reports the loan REPAID while interest remains outstanding', () => {
    const result = view(fullyRepaidPrincipal, '2026-04-01');
    expect(result.status).toBe('REPAID');
    expect(result.outstandingPrincipal.amount).toBe('0');
    // The whole reason status tracks principal rather than "settled".
    expect(result.interestBalance.amount).toBe('144000');
  });

  it('accrues nothing further once the principal is repaid', () => {
    const later = view(fullyRepaidPrincipal, '2027-04-01');
    expect(later.totalInterestAccrued.amount).toBe('144000');
    expect(later.interestPerMonth.amount).toBe('0');
  });

  it('does not divide by zero when computing balance months', () => {
    expect(view(fullyRepaidPrincipal, '2027-04-01').interestBalanceMonths).toBe('0.0');
  });
});

describe('US-1.11 Scenario: A closed loan stops accruing', () => {
  it('freezes interest at the closing date', () => {
    const closed: HandLoan = { ...baseLoan, closedDate: '2026-04-01' };
    // Without this a written-off loan grows a balance nobody intends to collect.
    expect(view(closed, '2028-04-01').totalInterestAccrued.amount).toBe('144000');
  });
});

describe('US-1.11 Scenario: Overpaid interest never shows as negative', () => {
  it('clamps the balance at zero', () => {
    const overpaid: HandLoan = {
      ...baseLoan,
      interestPayments: [{ paymentId: 'p1', date: '2025-07-01', amount: inr('200000'), mode: 'CASH' }],
    };
    const result = view(overpaid, '2026-04-01');
    expect(result.interestBalance.amount).toBe('0');
    expect(result.interestPaid.amount).toBe('200000');
  });
});

/* ------------------------------------------------------------- the register */

const loans: readonly HandLoan[] = [
  { ...baseLoan, assetId: 'l1', borrowerName: 'Rajesh Sharma', principal: inr('1200000') },
  {
    ...baseLoan,
    assetId: 'l2',
    borrowerName: 'Priya Menon',
    principal: inr('600000'),
    startDate: '2025-06-01',
    repayments: [{ date: '2025-12-01', principal: inr('300000') }],
  },
  {
    ...baseLoan,
    assetId: 'l3',
    borrowerName: 'Anil Kumar',
    principal: inr('400000'),
    startDate: '2025-01-01',
    repayments: [{ date: '2025-07-01', principal: inr('400000') }],
  },
];

const registerOf = (options: Parameters<typeof loanRegister>[0]) => loanRegister(options);

describe('US-1.11 Scenario: The register filters by status', () => {
  it('returns every loan when no status is selected', () => {
    // "No filter" means all, never none — an empty register would read as
    // "you have lent nothing".
    const result = registerOf({ loans, asOf: '2026-04-01' });
    expect(result.loans).toHaveLength(3);
  });

  it('selects a single status', () => {
    const result = registerOf({ loans, asOf: '2026-04-01', filter: { statuses: ['REPAID'] } });
    expect(result.loans.map((loan) => loan.borrowerName)).toEqual(['Anil Kumar']);
  });

  it('selects several statuses at once', () => {
    const result = registerOf({
      loans,
      asOf: '2026-04-01',
      filter: { statuses: ['ACTIVE', 'PARTIALLY_REPAID'] },
    });
    expect(result.loans).toHaveLength(2);
  });
});

describe('US-1.11 Scenario: The register filters by borrower', () => {
  it('matches on part of a name', () => {
    const result = registerOf({ loans, asOf: '2026-04-01', filter: { borrowers: ['raj'] } });
    expect(result.loans.map((loan) => loan.borrowerName)).toEqual(['Rajesh Sharma']);
  });

  it('combines a borrower filter with a status filter', () => {
    const result = registerOf({
      loans,
      asOf: '2026-04-01',
      filter: { borrowers: ['Priya'], statuses: ['PARTIALLY_REPAID'] },
    });
    expect(result.loans).toHaveLength(1);

    const contradictory = registerOf({
      loans,
      asOf: '2026-04-01',
      filter: { borrowers: ['Priya'], statuses: ['REPAID'] },
    });
    expect(contradictory.loans).toHaveLength(0);
  });

  it('lists every borrower on record, not only the visible ones', () => {
    const result = registerOf({ loans, asOf: '2026-04-01', filter: { statuses: ['REPAID'] } });
    // The filter list must not shrink as you use it, or a borrower becomes
    // unreachable once filtered away.
    expect(result.borrowers).toEqual(['Anil Kumar', 'Priya Menon', 'Rajesh Sharma']);
  });
});

describe('US-1.11 Scenario: The register sorts on every requested field', () => {
  const names = (sortBy: 'borrowerName' | 'status' | 'loanDate' | 'principal', direction: 'ASC' | 'DESC') =>
    registerOf({ loans, asOf: '2026-04-01', sortBy, direction }).loans.map((l) => l.borrowerName);

  it('sorts by borrower name', () => {
    expect(names('borrowerName', 'ASC')).toEqual(['Anil Kumar', 'Priya Menon', 'Rajesh Sharma']);
    expect(names('borrowerName', 'DESC')).toEqual(['Rajesh Sharma', 'Priya Menon', 'Anil Kumar']);
  });

  it('sorts by status, by how far repayment has progressed', () => {
    expect(names('status', 'ASC')).toEqual(['Rajesh Sharma', 'Priya Menon', 'Anil Kumar']);
  });

  it('sorts by loan date', () => {
    expect(names('loanDate', 'ASC')).toEqual(['Anil Kumar', 'Rajesh Sharma', 'Priya Menon']);
  });

  it('sorts by amount numerically, not as text', () => {
    // '1200000' < '400000' as strings; the point of comparing as decimals.
    expect(names('principal', 'DESC')).toEqual(['Rajesh Sharma', 'Priya Menon', 'Anil Kumar']);
  });
});

describe('US-1.11 Scenario: Totals describe what is on screen', () => {
  it('totals the whole register when nothing is filtered', () => {
    const { totals } = registerOf({ loans, asOf: '2026-04-01' });
    expect(totals.loanCount).toBe(3);
    expect(totals.totalPrincipal.amount).toBe('2200000');
    // ₹12,00,000 live + ₹3,00,000 remaining + ₹0 repaid.
    expect(totals.totalOutstanding.amount).toBe('1500000');
  });

  it('re-totals over the filtered set', () => {
    const { totals } = registerOf({
      loans,
      asOf: '2026-04-01',
      filter: { statuses: ['REPAID'] },
    });
    expect(totals.loanCount).toBe(1);
    expect(totals.totalPrincipal.amount).toBe('400000');
    expect(totals.totalOutstanding.amount).toBe('0');
  });

  it('separates pending interest on repaid principal from pending interest on live loans', () => {
    const { totals } = registerOf({ loans, asOf: '2026-04-01' });

    // Anil's principal came back, but six months of interest on ₹4,00,000 at
    // 12% — ₹24,000 — never did. Folded into one figure it disappears inside the
    // larger balance for live loans, and it is the one nobody chases.
    expect(totals.pendingInterestRepaid.amount).toBe('24000');
    expect(Number(totals.pendingInterestActive.amount)).toBeGreaterThan(0);
    expect(totals.pendingInterestTotal.amount).toBe(
      String(
        Number(totals.pendingInterestActive.amount) + Number(totals.pendingInterestRepaid.amount),
      ),
    );
  });

  it('reports zeroes rather than failing on an empty register', () => {
    const { totals } = registerOf({ loans: [], asOf: '2026-04-01' });
    expect(totals.loanCount).toBe(0);
    expect(totals.totalPrincipal.amount).toBe('0');
    expect(totals.pendingInterestTotal.amount).toBe('0');
  });
});

describe('US-1.11 Scenario: Several loans to one borrower stay separate', () => {
  it('keeps them as distinct rows with their own terms', () => {
    const sameBorrower: readonly HandLoan[] = [
      { ...baseLoan, assetId: 'a', principal: inr('2600000'), interestRatePct: '8' },
      { ...baseLoan, assetId: 'b', principal: inr('400000'), interestRatePct: '9' },
    ];
    const result = registerOf({ loans: sameBorrower, asOf: '2026-04-01' });

    expect(result.loans).toHaveLength(2);
    expect(result.totals.totalPrincipal.amount).toBe('3000000');
    // One borrower, two loans — the filter list shows the person once.
    expect(result.borrowers).toEqual(['Rajesh Sharma']);
  });
});
