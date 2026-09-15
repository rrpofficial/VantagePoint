/**
 * US-1.12 — the chit-fund register.
 *
 * A chit is a commitment to pay an instalment every month for a fixed term, in
 * exchange for the right to take the pot once. Two things about that shape drive
 * every test here:
 *
 *  1. **What it is worth is what has been PAID IN**, not the chit's face value.
 *     A ₹5,00,000 chit three instalments old is not a ₹5,00,000 asset, and
 *     carrying it at face would overstate net worth by the whole undrawn amount.
 *  2. **Once withdrawn, it is worth nothing as an asset.** The money has been
 *     taken and is now sitting in a bank account. Continuing to carry the
 *     accumulated instalments would count the same rupees twice.
 *
 * The arithmetic is written out by hand in the comments, because a chit holder
 * checking these figures has only a passbook to check them against.
 */
import { describe, it, expect } from 'vitest';
import {
  ChitLedger,
  chitRegister,
  chitWithdrawalAmountFor,
  type ChitFund,
  type ChitWithdrawalSchedule,
} from '@vantagepoint/core-domain';

const inr = (amount: string) => ({ amount, currency: 'INR' as const });

const emi = (date: string, amount: string, id = `emi_${date}`) => ({
  emiId: id,
  date,
  amount: inr(amount),
  mode: 'BANK_TRANSFER' as const,
  paidTo: 'Sri Balaji Chits',
});

const baseChit: ChitFund = {
  assetId: 'chit_0001',
  org: 'Sri Balaji Chits',
  label: '5L / 25 months',
  targetAmount: inr('500000'),
  startDate: '2025-04-01',
  endDate: '2027-04-01',
  durationMonths: 25,
  emiType: 'CONSTANT',
  status: 'ACTIVE',
  emis: [],
};

const view = (chit: ChitFund, asOf: string) => ChitLedger.viewOf(chit, asOf);

describe('US-1.12 Scenario: An active chit is worth what has been paid into it', () => {
  it('accumulates the instalments actually paid', () => {
    // Three instalments of ₹20,000 = ₹60,000.
    const chit: ChitFund = {
      ...baseChit,
      emis: [emi('2025-04-05', '20000'), emi('2025-05-05', '20000'), emi('2025-06-05', '20000')],
    };

    const result = view(chit, '2025-06-30');

    expect(result.paidToDate.amount).toBe('60000');
    expect(result.emiCount).toBe(3);
  });

  it('carries the accumulated amount, NOT the chit face value', () => {
    const chit: ChitFund = { ...baseChit, emis: [emi('2025-04-05', '20000')] };

    const result = view(chit, '2025-04-30');

    // ₹20,000 paid against a ₹5,00,000 chit. Carrying it at face would
    // overstate net worth by ₹4,80,000.
    expect(result.carryingValue.amount).toBe('20000');
    expect(result.targetAmount.amount).toBe('500000');
  });

  it('reports what is still committed', () => {
    const chit: ChitFund = {
      ...baseChit,
      emis: [emi('2025-04-05', '20000'), emi('2025-05-05', '20000')],
    };

    // ₹5,00,000 − ₹40,000 = ₹4,60,000 still to pay.
    expect(view(chit, '2025-05-30').remainingCommitment.amount).toBe('460000');
  });

  it('never reports a negative commitment once the chit is overpaid', () => {
    const chit: ChitFund = {
      ...baseChit,
      targetAmount: inr('50000'),
      emis: [emi('2025-04-05', '30000'), emi('2025-05-05', '30000')],
    };

    expect(view(chit, '2025-05-30').remainingCommitment.amount).toBe('0');
  });

  it('is worth nothing before the first instalment', () => {
    expect(view(baseChit, '2025-04-01').carryingValue.amount).toBe('0');
  });

  it('ignores an instalment dated after the valuation date', () => {
    // A future-dated payment is not money in the pot yet, and counting it would
    // make net worth depend on what has merely been scheduled.
    const chit: ChitFund = {
      ...baseChit,
      emis: [emi('2025-04-05', '20000'), emi('2025-12-05', '20000')],
    };

    expect(view(chit, '2025-06-30').paidToDate.amount).toBe('20000');
  });
});

describe('US-1.12 Scenario: A varying instalment is summed as paid, not assumed', () => {
  it('adds up instalments that increase month on month', () => {
    // ₹10,000 + ₹12,000 + ₹15,000 = ₹37,000. A chit with a rising instalment
    // cannot be valued as months × a single figure.
    const chit: ChitFund = {
      ...baseChit,
      emiType: 'VARYING',
      emis: [emi('2025-04-05', '10000'), emi('2025-05-05', '12000'), emi('2025-06-05', '15000')],
    };

    expect(view(chit, '2025-06-30').paidToDate.amount).toBe('37000');
  });

  it('offers no expected withdrawal figure for a varying chit', () => {
    // The pre-agreed schedule exists only for a fixed instalment. Showing one
    // here would be a number nobody promised.
    const chit: ChitFund = { ...baseChit, emiType: 'VARYING', emis: [emi('2025-04-05', '10000')] };

    expect(view(chit, '2025-05-30').expectedWithdrawal).toBeUndefined();
  });
});

describe('US-1.12 Scenario: A withdrawn chit leaves the asset side', () => {
  const withdrawn: ChitFund = {
    ...baseChit,
    status: 'WITHDRAWN',
    withdrawnDate: '2025-08-10',
    withdrawnAmount: inr('420000'),
    emis: [emi('2025-04-05', '20000'), emi('2025-05-05', '20000'), emi('2025-06-05', '20000')],
  };

  it('carries nothing once withdrawn', () => {
    // The ₹4,20,000 taken is now cash in a bank account. Carrying the ₹60,000
    // of instalments as well would count the same money twice.
    expect(view(withdrawn, '2025-12-31').carryingValue.amount).toBe('0');
  });

  it('still reports what was paid in and what was taken out', () => {
    const result = view(withdrawn, '2025-12-31');

    // Gone from net worth, but not gone from the record.
    expect(result.paidToDate.amount).toBe('60000');
    expect(result.withdrawnAmount?.amount).toBe('420000');
    expect(result.status).toBe('WITHDRAWN');
  });

  it('keeps counting instalments paid after withdrawal, which a chit still owes', () => {
    // Taking the pot early does not end the obligation: the holder keeps paying
    // to the end of the term. Those instalments are a real outgoing and the
    // register must not pretend they stopped.
    const stillPaying: ChitFund = {
      ...withdrawn,
      emis: [...withdrawn.emis, emi('2025-09-05', '20000')],
    };

    const result = view(stillPaying, '2025-12-31');
    expect(result.paidToDate.amount).toBe('80000');
    expect(result.carryingValue.amount).toBe('0');
  });
});

describe('US-1.12 Scenario: Term and progress', () => {
  it('counts months elapsed from the start date', () => {
    expect(view(baseChit, '2025-07-01').monthsElapsed).toBe(3);
  });

  it('does not run past the agreed term', () => {
    // Five years after a 25-month chit began, 25 months have elapsed, not 60.
    expect(view(baseChit, '2030-04-01').monthsElapsed).toBe(25);
  });

  it('reports months remaining', () => {
    expect(view(baseChit, '2025-07-01').monthsRemaining).toBe(22);
  });

  it('reports the last instalment paid', () => {
    const chit: ChitFund = {
      ...baseChit,
      emis: [emi('2025-04-05', '20000'), emi('2025-06-05', '20000')],
    };

    expect(view(chit, '2025-12-31').lastPaymentDate).toBe('2025-06-05');
  });
});

describe('US-1.12 Scenario: The pre-agreed withdrawal schedule', () => {
  const schedule: ChitWithdrawalSchedule = {
    label: '5L / 25 months',
    rows: [
      { month: 1, amount: inr('350000') },
      { month: 2, amount: inr('360000') },
      { month: 12, amount: inr('440000') },
      { month: 25, amount: inr('500000') },
    ],
  };

  it('reads the amount agreed for a given month', () => {
    expect(chitWithdrawalAmountFor(schedule, 12)?.amount).toBe('440000');
  });

  it('has nothing to say about a month the schedule does not cover', () => {
    // Interpolating between stated months would invent a figure the chit
    // company never agreed to.
    expect(chitWithdrawalAmountFor(schedule, 7)).toBeUndefined();
  });

  it('shows a fixed-instalment chit what it would receive this month', () => {
    const chit: ChitFund = { ...baseChit, scheduleLabel: '5L / 25 months' };

    // 12 months after 2025-04-01.
    const result = ChitLedger.viewOf(chit, '2026-04-01', schedule);

    expect(result.expectedWithdrawal?.amount).toBe('440000');
  });

  it('shows nothing when the chit names no schedule', () => {
    expect(ChitLedger.viewOf(baseChit, '2026-04-01', schedule).expectedWithdrawal).toBeUndefined();
  });
});

describe('US-1.12 Scenario: The register totals only what is still an asset', () => {
  const active: ChitFund = {
    ...baseChit,
    assetId: 'chit_active',
    emis: [emi('2025-04-05', '20000'), emi('2025-05-05', '20000')],
  };
  const gone: ChitFund = {
    ...baseChit,
    assetId: 'chit_withdrawn',
    label: '10L / 40 months',
    targetAmount: inr('1000000'),
    status: 'WITHDRAWN',
    withdrawnDate: '2025-06-01',
    withdrawnAmount: inr('820000'),
    emis: [emi('2025-04-05', '25000'), emi('2025-05-05', '25000')],
  };

  it('excludes a withdrawn chit from the figure that reaches net worth', () => {
    const result = chitRegister({ chits: [active, gone], asOf: '2025-12-31' });

    // Active: ₹40,000. Withdrawn: ₹50,000 paid, but nil as an asset.
    expect(result.totals.activeCarryingValue.amount).toBe('40000');
    expect(result.totals.totalPaid.amount).toBe('90000');
    expect(result.totals.chitCount).toBe(2);
    expect(result.totals.activeCount).toBe(1);
    expect(result.totals.withdrawnCount).toBe(1);
  });

  it('totals what has been taken out', () => {
    const result = chitRegister({ chits: [active, gone], asOf: '2025-12-31' });

    expect(result.totals.totalWithdrawn.amount).toBe('820000');
  });

  it('filters by status', () => {
    const result = chitRegister({
      chits: [active, gone],
      asOf: '2025-12-31',
      filter: { statuses: ['ACTIVE'] },
    });

    expect(result.chits).toHaveLength(1);
    expect(result.chits[0]?.assetId).toBe('chit_active');
    // Totals follow the filter, so what is on screen adds up to what is shown.
    expect(result.totals.totalPaid.amount).toBe('40000');
  });

  it('filters by organisation', () => {
    const other: ChitFund = { ...active, assetId: 'chit_other', org: 'Margadarsi' };

    const result = chitRegister({
      chits: [active, other],
      asOf: '2025-12-31',
      filter: { orgs: ['Margadarsi'] },
    });

    expect(result.chits).toHaveLength(1);
    expect(result.chits[0]?.org).toBe('Margadarsi');
  });

  it('lists every organisation once, for the filter control', () => {
    const other: ChitFund = { ...active, assetId: 'chit_other', org: 'Margadarsi' };

    const result = chitRegister({ chits: [active, other, gone], asOf: '2025-12-31' });

    expect(result.orgs).toEqual(['Margadarsi', 'Sri Balaji Chits']);
  });

  it('sorts by what has been paid in, descending', () => {
    const result = chitRegister({
      chits: [active, gone],
      asOf: '2025-12-31',
      sortBy: 'paidToDate',
      direction: 'DESC',
    });

    expect(result.chits[0]?.assetId).toBe('chit_withdrawn');
  });

  it('totals nothing, rather than failing, on an empty register', () => {
    const result = chitRegister({ chits: [], asOf: '2025-12-31' });

    expect(result.totals.chitCount).toBe(0);
    expect(result.totals.activeCarryingValue.amount).toBe('0');
    expect(result.chits).toEqual([]);
  });
});
