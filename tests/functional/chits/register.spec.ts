/**
 * FUNCTIONAL — the chit-fund register, through the use cases.
 *
 * The whole path a chit holder takes: set up the agreed withdrawal table once,
 * record a chit against it, pay instalments month by month, mark it withdrawn,
 * and see net worth react correctly at every step.
 *
 * The arithmetic is pinned in packages/core-domain/test/chit-book.spec.ts. What
 * these check is that it survives persistence and that the register and the
 * valuation agree — two figures for the same money disagreeing is the exact bug
 * that had hand loans reading ₹4,00,000 on the dashboard and ₹30,00,000 on their
 * own tab.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChitUC, ValuePortfolioUC, resetPorts } from '@porttrack/app-services';
import { Vault } from '@porttrack/persistence';
import { expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2025-12-31';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-chits-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
});

afterEach(async () => {
  await Vault.close();
});

const open = (input: {
  org?: string;
  label?: string;
  target?: string;
  start?: string;
  months?: number;
  emiType?: 'CONSTANT' | 'VARYING';
  scheduleLabel?: string;
  comments?: string;
} = {}) =>
  ChitUC.open({
    org: input.org ?? 'Sri Balaji Chits',
    label: input.label ?? '5L / 25 months',
    targetAmount: inr(input.target ?? '500000'),
    startDate: input.start ?? '2025-04-01',
    durationMonths: input.months ?? 25,
    emiType: input.emiType ?? 'CONSTANT',
    ...(input.scheduleLabel === undefined ? {} : { scheduleLabel: input.scheduleLabel }),
    ...(input.comments === undefined ? {} : { comments: input.comments }),
  });

const payEmi = (chitId: string, date: string, amount: string, paidTo = 'Balaji branch') =>
  ChitUC.recordEmi({
    chitId,
    date,
    amount: inr(amount),
    mode: 'BANK_TRANSFER',
    paidTo,
  });

const register = (query = {}) => ChitUC.register({ asOf: AS_OF, ...query });
const netWorth = () => ValuePortfolioUC.execute(`${AS_OF}T00:00:00+05:30`);

describe('Scenario: A chit is opened and instalments are paid', () => {
  it('appears in the register with its agreed terms', async () => {
    const chitId = expectOk(await open({ label: '5L / 25 months', target: '500000' }));

    const result = expectOk(await register());
    expect(result.chits).toHaveLength(1);
    expect(result.chits[0]?.assetId).toBe(chitId);
    expect(result.chits[0]?.org).toBe('Sri Balaji Chits');
    expect(result.chits[0]?.targetAmount.amount).toBe('500000');
    expect(result.chits[0]?.durationMonths).toBe(25);
    expect(result.chits[0]?.status).toBe('ACTIVE');
  });

  it('derives the end date from the start date and the term', async () => {
    expectOk(await open({ start: '2025-04-01', months: 25 }));

    // 25 months from April 2025 is May 2027.
    expect(expectOk(await register()).chits[0]?.endDate).toBe('2027-05-01');
  });

  it('accumulates the instalments actually paid', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await payEmi(chitId, '2025-05-05', '20000'));
    expectOk(await payEmi(chitId, '2025-06-05', '20000'));

    const chit = expectOk(await register()).chits[0];
    expect(chit?.paidToDate.amount).toBe('60000');
    expect(chit?.emiCount).toBe(3);
    expect(chit?.remainingCommitment.amount).toBe('440000');
  });

  it('records who each instalment was paid to and how', async () => {
    const chitId = expectOk(await open());
    expectOk(
      await ChitUC.recordEmi({
        chitId,
        date: '2025-04-05',
        amount: inr('20000'),
        mode: 'UPI',
        paidTo: 'Balaji agent — Ramesh',
        comments: 'collected at home',
      }),
    );

    const instalment = expectOk(await register()).chits[0]?.emis[0];
    expect(instalment?.mode).toBe('UPI');
    expect(instalment?.paidTo).toBe('Balaji agent — Ramesh');
    expect(instalment?.comments).toBe('collected at home');
  });

  it('survives a lock and reload', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));

    expect(expectOk(await register()).chits[0]?.paidToDate.amount).toBe('20000');
  });
});

describe('Scenario: A varying-instalment chit', () => {
  it('sums instalments that rise month on month', async () => {
    const chitId = expectOk(await open({ emiType: 'VARYING' }));
    expectOk(await payEmi(chitId, '2025-04-05', '10000'));
    expectOk(await payEmi(chitId, '2025-05-05', '12000'));
    expectOk(await payEmi(chitId, '2025-06-05', '15000'));

    // ₹37,000 — a rising chit cannot be valued as months × one figure.
    expect(expectOk(await register()).chits[0]?.paidToDate.amount).toBe('37000');
  });

  it('offers no expected withdrawal figure, because none was agreed', async () => {
    const chitId = expectOk(await open({ emiType: 'VARYING' }));
    expectOk(await payEmi(chitId, '2025-04-05', '10000'));

    expect(expectOk(await register()).chits[0]?.expectedWithdrawal).toBeUndefined();
  });
});

describe('Scenario: The agreed withdrawal table', () => {
  const schedule = {
    label: '5L / 25 months',
    rows: [
      { month: 1, amount: inr('350000') },
      { month: 9, amount: inr('420000') },
      { month: 25, amount: inr('500000') },
    ],
  };

  it('is set up once and reused by every chit of that shape', async () => {
    expectOk(await ChitUC.saveSchedule(schedule));

    const all = expectOk(await ChitUC.schedules());
    expect(all).toHaveLength(1);
    expect(all[0]?.rows).toHaveLength(3);
  });

  it('shows a fixed chit what it would receive this month', async () => {
    expectOk(await ChitUC.saveSchedule(schedule));
    expectOk(await open({ start: '2025-04-01', scheduleLabel: '5L / 25 months' }));

    // 2025-04-01 → 2025-12-31 is 8 months elapsed... month 9 is the agreed row
    // at nine months, so check the exact month the schedule states.
    const chit = expectOk(await ChitUC.register({ asOf: '2026-01-01' })).chits[0];
    expect(chit?.expectedWithdrawal?.amount).toBe('420000');
  });

  it('says nothing for a month the table does not cover', async () => {
    expectOk(await ChitUC.saveSchedule(schedule));
    expectOk(await open({ start: '2025-04-01', scheduleLabel: '5L / 25 months' }));

    // Five months in — not a month the chit company put a figure against.
    const chit = expectOk(await ChitUC.register({ asOf: '2025-09-01' })).chits[0];
    expect(chit?.expectedWithdrawal).toBeUndefined();
  });

  it('replaces a schedule wholesale rather than merging rows', async () => {
    expectOk(await ChitUC.saveSchedule(schedule));

    expectOk(
      await ChitUC.saveSchedule({
        label: '5L / 25 months',
        rows: [{ month: 1, amount: inr('355000') }],
      }),
    );

    const all = expectOk(await ChitUC.schedules());
    // A stale month left behind would produce a payout figure matching no
    // agreement anyone made.
    expect(all[0]?.rows).toHaveLength(1);
    expect(all[0]?.rows[0]?.amount.amount).toBe('355000');
  });

  it('refuses a schedule with no label', async () => {
    const result = await ChitUC.saveSchedule({ label: '  ', rows: [] });

    expect(result.ok).toBe(false);
  });
});

describe('Scenario: A chit contributes to net worth while it is active', () => {
  it('adds the accumulated instalments to gross assets', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await payEmi(chitId, '2025-05-05', '20000'));

    const valuation = expectOk(await netWorth());
    expect(valuation.grossAssets.amount).toBe('40000');
    expect(valuation.netWorth.amount).toBe('40000');
  });

  it('reports the SAME figure the register does', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await payEmi(chitId, '2025-05-05', '25000'));

    const fromRegister = expectOk(await register()).totals.activeCarryingValue.amount;
    const fromValuation = expectOk(await netWorth()).grossAssets.amount;

    // Two figures for the same money must never disagree.
    expect(fromRegister).toBe('45000');
    expect(fromValuation).toBe(fromRegister);
  });

  it('does not carry the chit at its face value', async () => {
    const chitId = expectOk(await open({ target: '500000' }));
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));

    // ₹20,000, not ₹5,00,000. The face value is the number the chit is named
    // after, which is exactly why it is the easy mistake.
    expect(expectOk(await netWorth()).grossAssets.amount).toBe('20000');
  });
});

describe('Scenario: A withdrawn chit leaves the asset side', () => {
  it('drops out of net worth entirely once marked withdrawn', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await payEmi(chitId, '2025-05-05', '20000'));
    expect(expectOk(await netWorth()).grossAssets.amount).toBe('40000');

    expectOk(await ChitUC.withdraw(chitId, { date: '2025-06-01', amount: inr('420000') }));

    // The pot taken is cash in a bank account, counted there. Carrying the
    // ₹40,000 of instalments here too would count the same money twice.
    expect(expectOk(await netWorth()).grossAssets.amount).toBe('0');
  });

  it('keeps the record of what was paid in and what was taken out', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await ChitUC.withdraw(chitId, { date: '2025-06-01', amount: inr('420000') }));

    const chit = expectOk(await register()).chits[0];
    expect(chit?.status).toBe('WITHDRAWN');
    expect(chit?.paidToDate.amount).toBe('20000');
    expect(chit?.withdrawnAmount?.amount).toBe('420000');
    expect(chit?.withdrawnDate).toBe('2025-06-01');
    expect(chit?.carryingValue.amount).toBe('0');
  });

  it('goes on accepting instalments, because the obligation continues', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await ChitUC.withdraw(chitId, { date: '2025-06-01', amount: inr('420000') }));

    // Drawing in month 3 of 25 does not end the payments.
    expectOk(await payEmi(chitId, '2025-07-05', '20000'));

    const chit = expectOk(await register()).chits[0];
    expect(chit?.paidToDate.amount).toBe('40000');
    expect(chit?.carryingValue.amount).toBe('0');
  });

  it('can be put back to active, and returns to net worth', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));
    expectOk(await ChitUC.withdraw(chitId, { date: '2025-06-01', amount: inr('420000') }));

    expectOk(await ChitUC.setStatus(chitId, 'ACTIVE'));

    expect(expectOk(await register()).chits[0]?.status).toBe('ACTIVE');
    expect(expectOk(await netWorth()).grossAssets.amount).toBe('20000');
  });

  it('excludes only the withdrawn chit, leaving the rest counted', async () => {
    const first = expectOk(await open({ label: 'A' }));
    const second = expectOk(await open({ label: 'B' }));
    expectOk(await payEmi(first, '2025-04-05', '20000'));
    expectOk(await payEmi(second, '2025-04-05', '30000'));

    expectOk(await ChitUC.withdraw(first, { date: '2025-06-01', amount: inr('420000') }));

    expect(expectOk(await netWorth()).grossAssets.amount).toBe('30000');
  });
});

describe('Scenario: The chit is edited', () => {
  it('changes the terms the register reports', async () => {
    const chitId = expectOk(await open({ label: '5L / 25 months', target: '500000' }));

    expectOk(
      await ChitUC.edit(chitId, {
        label: '5L / 30 months',
        targetAmount: inr('600000'),
        durationMonths: 30,
        comments: 'term extended by the company',
      }),
    );

    const chit = expectOk(await register()).chits[0];
    expect(chit?.label).toBe('5L / 30 months');
    expect(chit?.targetAmount.amount).toBe('600000');
    expect(chit?.durationMonths).toBe(30);
    expect(chit?.comments).toBe('term extended by the company');
  });

  it('keeps the instalments already recorded against it', async () => {
    const chitId = expectOk(await open());
    expectOk(await payEmi(chitId, '2025-04-05', '20000'));

    expectOk(await ChitUC.edit(chitId, { label: 'renamed' }));

    expect(expectOk(await register()).chits[0]?.paidToDate.amount).toBe('20000');
  });
});

describe('Scenario: Filtering and totals', () => {
  it('totals only the filtered rows, so the screen adds up', async () => {
    const first = expectOk(await open({ org: 'Sri Balaji Chits', label: 'A' }));
    const second = expectOk(await open({ org: 'Margadarsi', label: 'B' }));
    expectOk(await payEmi(first, '2025-04-05', '20000'));
    expectOk(await payEmi(second, '2025-04-05', '30000'));

    const filtered = expectOk(await ChitUC.register({ asOf: AS_OF, orgs: ['Margadarsi'] }));
    expect(filtered.chits).toHaveLength(1);
    expect(filtered.totals.totalPaid.amount).toBe('30000');
  });

  it('lists every organisation for the filter control', async () => {
    expectOk(await open({ org: 'Sri Balaji Chits', label: 'A' }));
    expectOk(await open({ org: 'Margadarsi', label: 'B' }));

    expect(expectOk(await register()).orgs).toEqual(['Margadarsi', 'Sri Balaji Chits']);
  });

  it('filters by status', async () => {
    const first = expectOk(await open({ label: 'A' }));
    expectOk(await open({ label: 'B' }));
    expectOk(await ChitUC.withdraw(first, { date: '2025-06-01', amount: inr('420000') }));

    const active = expectOk(await ChitUC.register({ asOf: AS_OF, statuses: ['ACTIVE'] }));
    expect(active.chits).toHaveLength(1);
    expect(active.chits[0]?.label).toBe('B');
  });
});

describe('Scenario: Input that would corrupt the register is refused', () => {
  it('refuses a chit with no label', async () => {
    expect((await open({ label: '  ' })).ok).toBe(false);
  });

  it('refuses a chit with no organisation', async () => {
    expect((await open({ org: '' })).ok).toBe(false);
  });

  it('refuses a target amount of zero', async () => {
    expect((await open({ target: '0' })).ok).toBe(false);
  });

  it('refuses a term of zero months', async () => {
    expect((await open({ months: 0 })).ok).toBe(false);
  });

  it('refuses a start date that is not ISO', async () => {
    expect((await open({ start: '01/04/2025' })).ok).toBe(false);
  });

  it('accepts an Indian-format target amount, as the form allows', async () => {
    expectOk(await open({ target: '5,00,000' }));

    expect(expectOk(await register()).chits[0]?.targetAmount.amount).toBe('500000');
  });

  it('refuses an instalment that is not a number, rather than persisting it', async () => {
    const chitId = expectOk(await open());

    const result = await ChitUC.recordEmi({
      chitId,
      date: '2025-04-05',
      amount: inr('twenty thousand'),
      mode: 'CASH',
      paidTo: 'branch',
    });

    expect(result.ok).toBe(false);
    // The register must still read, which is what an unparseable amount in the
    // vault previously broke.
    expect(expectOk(await register()).chits[0]?.paidToDate.amount).toBe('0');
  });

  it('refuses an instalment with no payee', async () => {
    const chitId = expectOk(await open());

    const result = await ChitUC.recordEmi({
      chitId,
      date: '2025-04-05',
      amount: inr('20000'),
      mode: 'CASH',
      paidTo: '   ',
    });

    expect(result.ok).toBe(false);
  });

  it('refuses an instalment against a chit that does not exist', async () => {
    expect((await payEmi('chit_nope', '2025-04-05', '20000')).ok).toBe(false);
  });

  it('is locked out when the vault is', async () => {
    await Vault.lock();

    expect((await open()).ok).toBe(false);
    expect((await register()).ok).toBe(false);
  });
});
