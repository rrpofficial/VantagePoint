/**
 * FUNCTIONAL — genuine duplicate loans, and the audited edit.
 *
 * The first scenario is a regression test for real, silent data loss. Loan ids
 * were derived from borrower + date + amount, and `assets` upserts on that id,
 * so recording a second genuine loan to one borrower on one day for one amount
 * OVERWROTE the first: the register showed one loan, the total halved, and
 * nothing anywhere reported a problem. Anyone lending the same person twice in
 * a day would have lost the money from their own books.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditModeUC, LoanUC, configure, resetPorts } from '@porttrack/app-services';
import { DuplicateLoanError } from '@porttrack/shared-kernel';
import { Vault } from '@porttrack/persistence';
import { expectOk } from '@porttrack/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2026-04-01';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porttrack-loan-dup-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
  /*
   * Through the real door, not a test seam. Editing and closing a loan are
   * gated on edit mode, and enabling it here with the actual passphrase is what
   * keeps these scenarios exercising the path a user takes — a seam that flipped
   * the flag directly would let the gate rot without a single test noticing.
   */
  expectOk(await EditModeUC.enable(PASSPHRASE));
});

afterEach(async () => {
  await Vault.close();
});

const lend = (input: {
  name?: string;
  amount?: string;
  rate?: string;
  date?: string;
  notes?: string;
  confirm?: boolean;
}) =>
  LoanUC.record({
    borrowerName: input.name ?? 'Rajesh Sharma',
    principal: inr(input.amount ?? '100000'),
    interestRatePct: input.rate ?? '12',
    loanDate: input.date ?? '2025-04-01',
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.confirm === undefined ? {} : { confirmDuplicate: input.confirm }),
  });

const register = () => LoanUC.register({ asOf: AS_OF });

describe('Scenario: A second loan to the same borrower on the same day', () => {
  it('is refused until confirmed, naming the loan it would duplicate', async () => {
    const first = expectOk(await lend({ notes: 'shop renovation' }));

    const second = await lend({ notes: 'medical' });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected a duplicate to be flagged');
    expect(second.error).toBeInstanceOf(DuplicateLoanError);
    // The ids travel on the error so the screen can show WHICH loan matched,
    // rather than only that one did.
    if (second.error instanceof DuplicateLoanError) {
      expect(second.error.loanIds).toEqual([first]);
    }
  });

  it('records BOTH loans once confirmed, and does not overwrite the first', async () => {
    const first = expectOk(await lend({ amount: '100000', rate: '12', notes: 'shop renovation' }));
    const second = expectOk(
      await lend({ amount: '100000', rate: '18', notes: 'medical', confirm: true }),
    );

    expect(second).not.toBe(first);

    const result = expectOk(await register());
    expect(result.loans).toHaveLength(2);
    // ₹1,00,000 + ₹1,00,000. Before the fix this read ₹1,00,000 and one loan.
    expect(result.totals.totalPrincipal.amount).toBe('200000');
    expect(result.loans.map((loan) => loan.notes).sort()).toEqual(['medical', 'shop renovation']);
    // Each keeps its own terms; the second did not inherit the first's rate.
    expect(result.loans.map((loan) => loan.interestRatePct).sort()).toEqual(['12', '18']);
  });

  it('keeps giving distinct ids to a third and fourth same-day loan', async () => {
    expectOk(await lend({}));
    expectOk(await lend({ confirm: true }));
    expectOk(await lend({ confirm: true }));
    expectOk(await lend({ confirm: true }));

    const result = expectOk(await register());
    expect(result.loans).toHaveLength(4);
    expect(new Set(result.loans.map((loan) => loan.loanId)).size).toBe(4);
    expect(result.totals.totalPrincipal.amount).toBe('400000');
  });

  it('flags a same-day loan for a different amount too', async () => {
    expectOk(await lend({ amount: '100000' }));

    const second = await lend({ amount: '250000' });

    expect(second.ok).toBe(false);
  });

  it('does not flag a loan on a different day', async () => {
    expectOk(await lend({ date: '2025-04-01' }));

    expectOk(await lend({ date: '2025-04-02' }));

    expect(expectOk(await register()).loans).toHaveLength(2);
  });

  it('does not flag a different borrower on the same day', async () => {
    expectOk(await lend({ name: 'Rajesh Sharma' }));

    expectOk(await lend({ name: 'Priya Nair' }));

    expect(expectOk(await register()).loans).toHaveLength(2);
  });
});

describe('Scenario: The audit trail', () => {
  it('records the creation, so the trail shows what was originally entered', async () => {
    const loanId = expectOk(await lend({ amount: '100000', rate: '12' }));

    const entries = expectOk(await LoanUC.auditFor(loanId));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('CREATED');
    expect(entries[0]?.newValue).toContain('100000');
  });

  it('marks a confirmed duplicate as such, naming what it duplicates', async () => {
    const first = expectOk(await lend({}));
    const second = expectOk(await lend({ confirm: true }));

    const entries = expectOk(await LoanUC.auditFor(second));
    expect(entries[0]?.action).toBe('CREATED_AS_DUPLICATE');
    expect(entries[0]?.reason).toContain(first);
  });

  it('records an edit field by field, with old and new values', async () => {
    const loanId = expectOk(await lend({ amount: '100000', rate: '12' }));

    expectOk(
      await LoanUC.edit(
        loanId,
        { principalAmount: '150000', interestRatePct: '18' },
        { reason: 'amount was mistyped at entry' },
      ),
    );

    const entries = expectOk(await LoanUC.auditFor(loanId));
    const edits = entries.filter((entry) => entry.action === 'EDITED');
    expect(edits).toHaveLength(2);
    expect(edits.find((entry) => entry.field === 'Principal')).toMatchObject({
      oldValue: '100000',
      newValue: '150000',
      reason: 'amount was mistyped at entry',
    });
    expect(edits.find((entry) => entry.field === 'Interest rate %')).toMatchObject({
      oldValue: '12',
      newValue: '18',
    });
  });

  it('records payments and closure alongside edits, in one trail', async () => {
    const loanId = expectOk(await lend({}));

    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('3000'),
        mode: 'UPI',
      }),
    );
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2025-10-01',
        amount: inr('40000'),
        mode: 'BANK_TRANSFER',
      }),
    );
    expectOk(await LoanUC.close(loanId, '2026-03-31'));

    const actions = expectOk(await LoanUC.auditFor(loanId)).map((entry) => entry.action);
    expect(actions).toContain('INTEREST_PAYMENT');
    expect(actions).toContain('PRINCIPAL_REPAYMENT');
    expect(actions).toContain('CLOSED');
    expect(actions).toContain('CREATED');
  });

  it('survives a lock and reload — the trail is in the vault, not in memory', async () => {
    const loanId = expectOk(await lend({}));
    expectOk(await LoanUC.edit(loanId, { notes: 'chased by phone' }, { reason: 'called borrower' }));

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));

    const entries = expectOk(await LoanUC.auditFor(loanId));
    expect(entries.filter((entry) => entry.action === 'EDITED')).toHaveLength(1);
  });
});

describe('Scenario: An edit changes what the register reports', () => {
  it('moves the loan under the new borrower, so the filter still finds it', async () => {
    const loanId = expectOk(await lend({ name: 'Rajesh Sharma' }));

    expectOk(await LoanUC.edit(loanId, { borrowerName: 'Rajesh Sharman' }, {}));

    const result = expectOk(await register());
    expect(result.loans[0]?.borrowerName).toBe('Rajesh Sharman');
    // The hash must follow the name, or the register groups it under the old
    // borrower and the dropdown filter silently loses the loan.
    expect(result.borrowers).toEqual(['Rajesh Sharman']);
    const filtered = expectOk(
      await LoanUC.register({ asOf: AS_OF, borrowers: ['Rajesh Sharman'] }),
    );
    expect(filtered.loans).toHaveLength(1);
  });

  it('changes the outstanding principal the dashboard values', async () => {
    const loanId = expectOk(await lend({ amount: '100000' }));

    expectOk(await LoanUC.edit(loanId, { principalAmount: '250000' }, {}));

    expect(expectOk(await register()).totals.totalOutstanding.amount).toBe('250000');
  });

  it('writes nothing when the form is saved unchanged', async () => {
    const loanId = expectOk(await lend({ name: 'Rajesh Sharma', amount: '100000' }));

    const changed = expectOk(
      await LoanUC.edit(loanId, { borrowerName: 'Rajesh Sharma', principalAmount: '100000' }, {}),
    );

    expect(changed).toEqual([]);
    expect(expectOk(await LoanUC.auditFor(loanId)).filter((e) => e.action === 'EDITED')).toEqual([]);
  });

  it('refuses an amount that is not a number, rather than persisting it', async () => {
    // Parse-level only, but load-bearing: an unparseable amount in the vault
    // made every later read of the whole register throw a 500, with no way to
    // find the offending row from inside the app.
    const loanId = expectOk(await lend({}));

    const result = await LoanUC.edit(loanId, { principalAmount: 'not a number' }, {});

    expect(result.ok).toBe(false);
    expect(expectOk(await register()).loans[0]?.principal.amount).toBe('100000');
  });

  it('accepts an Indian-format amount, as the entry form does', async () => {
    const loanId = expectOk(await lend({}));

    expectOk(await LoanUC.edit(loanId, { principalAmount: '2,50,000' }, {}));

    expect(expectOk(await register()).loans[0]?.principal.amount).toBe('250000');
  });

  it('reports a loan that is not there rather than creating one', async () => {
    const result = await LoanUC.edit('ast_hand_loan_nope', { notes: 'x' }, {});

    expect(result.ok).toBe(false);
    expect(expectOk(await register()).loans).toHaveLength(0);
  });
});

describe('Scenario: The trail is unrestricted but honest', () => {
  it('permits a principal below what has been repaid, and records it', async () => {
    const loanId = expectOk(await lend({ amount: '100000' }));
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2025-10-01',
        amount: inr('80000'),
        mode: 'CASH',
      }),
    );

    expectOk(
      await LoanUC.edit(loanId, { principalAmount: '50000' }, { reason: 'original figure wrong' }),
    );

    const entries = expectOk(await LoanUC.auditFor(loanId));
    expect(entries.find((entry) => entry.field === 'Principal')).toMatchObject({
      oldValue: '100000',
      newValue: '50000',
      reason: 'original figure wrong',
    });
  });

  it('orders the trail newest first', async () => {
    let tick = 0;
    // A frozen clock would give every entry the same instant and make the order
    // untestable; this advances one minute per read.
    configure({
      clock: {
        now: () => {
          tick += 1;
          return `2026-08-09T10:${String(tick).padStart(2, '0')}:00+00:00`;
        },
        today: () => '2026-08-09',
      },
    });

    const loanId = expectOk(await lend({}));
    expectOk(await LoanUC.edit(loanId, { notes: 'first note' }, {}));
    expectOk(await LoanUC.edit(loanId, { notes: 'second note' }, {}));

    const entries = expectOk(await LoanUC.auditFor(loanId));
    expect(entries[0]?.newValue).toBe('second note');
    expect(entries[entries.length - 1]?.action).toBe('CREATED');
  });
});
