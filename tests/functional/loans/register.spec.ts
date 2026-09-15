/**
 * FUNCTIONAL — the hand-loan register, through the use cases.
 *
 * Exercises the whole path a lender takes: record a loan, take interest, take
 * part of the principal back, filter, sort, and export. The engine's arithmetic
 * is pinned in packages/core-domain/test/loan-book.spec.ts; what these check is
 * that it survives persistence and that the API-facing shape is what the screen
 * needs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoanUC, resetPorts } from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2026-04-01';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-loans-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
});

afterEach(async () => {
  await Vault.close();
});

const lend = (
  borrowerName: string,
  amount: string,
  rate = '12',
  loanDate = '2025-04-01',
  confirmDuplicate = false,
) =>
  LoanUC.record({
    borrowerName,
    principal: inr(amount),
    interestRatePct: rate,
    loanDate,
    ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
  });

const register = (query = {}) => LoanUC.register({ asOf: AS_OF, ...query });

describe('Scenario: A loan is recorded and survives a reload', () => {
  it('appears in the register with its terms', async () => {
    expectOk(await lend('Rajesh Sharma', '1200000'));

    const result = expectOk(await register());
    expect(result.loans).toHaveLength(1);
    expect(result.loans[0]?.borrowerName).toBe('Rajesh Sharma');
    expect(result.loans[0]?.principal.amount).toBe('1200000');
    expect(result.loans[0]?.status).toBe('ACTIVE');
    // One year at 12% on ₹12,00,000.
    expect(result.loans[0]?.totalInterestAccrued.amount).toBe('144000');
  });

  it('survives a lock and unlock', async () => {
    expectOk(await lend('Rajesh Sharma', '1200000'));
    const before = expectOk(await register());

    await Vault.lock();
    expectOk(await Vault.unlock(PASSPHRASE));

    expect(expectOk(await register())).toEqual(before);
  });

  it('refuses a loan with no borrower', async () => {
    const result = await LoanUC.record({
      borrowerName: '   ',
      principal: inr('100000'),
      interestRatePct: '12',
      loanDate: '2025-04-01',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a loan of nothing', async () => {
    const result = await LoanUC.record({
      borrowerName: 'Someone',
      principal: inr('0'),
      interestRatePct: '12',
      loanDate: '2025-04-01',
    });
    expect(result.ok).toBe(false);
  });

  it('is locked out when the vault is', async () => {
    await Vault.lock();
    expect((await register()).ok).toBe(false);
  });
});

describe('Scenario: Several loans to one borrower stay distinct', () => {
  it('records them separately, on different days and in different years', async () => {
    expectOk(await lend('Rajesh Sharma', '2600000', '8', '2025-04-01'));
    // Second loan the same day: flagged, and confirmed by the lender.
    expectOk(await lend('Rajesh Sharma', '400000', '9', '2025-04-01', true));
    expectOk(await lend('Rajesh Sharma', '500000', '10', '2026-01-15'));

    const result = expectOk(await register());
    expect(result.loans).toHaveLength(3);
    expect(result.totals.totalPrincipal.amount).toBe('3500000');
    // One person, three loans — the filter list shows them once.
    expect(result.borrowers).toEqual(['Rajesh Sharma']);
  });

  /*
   * This scenario previously asserted that recording identical terms twice
   * produced ONE loan, and called that de-duplication. It was not: the second
   * record overwrote the first, because both derived the same asset id and the
   * assets table upserts. With identical terms the loss was invisible, but the
   * same code path silently destroyed a genuine second loan.
   *
   * The protective intent — a lender who submits the form twice must not end up
   * with two loans — is now met by asking instead of by overwriting.
   */
  it('refuses a loan recorded twice with identical terms, pending confirmation', async () => {
    expectOk(await lend('Rajesh Sharma', '2600000', '8', '2025-04-01'));

    const second = await lend('Rajesh Sharma', '2600000', '8', '2025-04-01');

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DUPLICATE_LOAN');
    expect(expectOk(await register()).loans).toHaveLength(1);
    expect(expectOk(await register()).totals.totalPrincipal.amount).toBe('2600000');
  });

  it('records both when the lender confirms they are genuinely two loans', async () => {
    expectOk(await lend('Rajesh Sharma', '2600000', '8', '2025-04-01'));

    expectOk(await lend('Rajesh Sharma', '2600000', '8', '2025-04-01', true));

    const result = expectOk(await register());
    expect(result.loans).toHaveLength(2);
    expect(result.totals.totalPrincipal.amount).toBe('5200000');
  });
});

describe('Scenario: Interest payments are recorded against a loan', () => {
  it('reduces the balance without touching the principal', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '1200000'));

    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('36000'),
        mode: 'UPI',
        notes: 'Quarterly',
      }),
    );

    const loan = expectOk(await register()).loans[0];
    expect(loan?.interestPaid.amount).toBe('36000');
    expect(loan?.interestBalance.amount).toBe('108000');
    // The distinction that matters: principal untouched.
    expect(loan?.outstandingPrincipal.amount).toBe('1200000');
    expect(loan?.status).toBe('ACTIVE');
  });

  it('keeps as many payments as were made', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '1200000'));

    for (const month of ['05', '06', '07', '08', '09']) {
      expectOk(
        await LoanUC.recordInterestPayment({
          loanId,
          date: `2025-${month}-01`,
          amount: inr('12000'),
          mode: 'CASH',
        }),
      );
    }

    // A spreadsheet had four columns and lost the fifth.
    const loan = expectOk(await register()).loans[0];
    expect(loan?.interestPayments).toHaveLength(5);
    expect(loan?.interestPaid.amount).toBe('60000');
  });

  it('records the mode and notes a dispute would turn on', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '1200000'));
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('36000'),
        mode: 'CHEQUE',
        notes: 'Cheque 004412',
      }),
    );

    const payment = expectOk(await register()).loans[0]?.interestPayments[0];
    expect(payment?.mode).toBe('CHEQUE');
    expect(payment?.notes).toBe('Cheque 004412');
  });
});

describe('Scenario: A partial repayment changes what earns interest', () => {
  it('accrues on the declining balance and reports PARTIALLY_REPAID', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '1200000'));
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2025-10-01',
        amount: inr('600000'),
        mode: 'BANK_TRANSFER',
      }),
    );

    const loan = expectOk(await register()).loans[0];
    expect(loan?.status).toBe('PARTIALLY_REPAID');
    expect(loan?.outstandingPrincipal.amount).toBe('600000');
    // Six months on ₹12,00,000 then six on ₹6,00,000 — not a year on the full sum.
    expect(loan?.totalInterestAccrued.amount).toBe('108000');
    expect(loan?.interestPerMonth.amount).toBe('6000');
  });

  it('reports REPAID once the whole principal is back', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '1200000'));
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2026-04-01',
        amount: inr('1200000'),
        mode: 'BANK_TRANSFER',
      }),
    );

    const loan = expectOk(await register()).loans[0];
    expect(loan?.status).toBe('REPAID');
    // And interest is still owed on it — the case the register exists to keep visible.
    expect(loan?.interestBalance.amount).toBe('144000');
  });
});

describe('Scenario: Filters combine, and totals follow them', () => {
  async function seed(): Promise<void> {
    const active = expectOk(await lend('Rajesh Sharma', '1200000', '12', '2025-04-01'));
    expect(active).toBeTruthy();

    const partial = expectOk(await lend('Priya Menon', '600000', '12', '2025-06-01'));
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId: partial,
        date: '2025-12-01',
        amount: inr('300000'),
        mode: 'UPI',
      }),
    );

    const repaid = expectOk(await lend('Anil Kumar', '400000', '12', '2025-01-01'));
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId: repaid,
        date: '2025-07-01',
        amount: inr('400000'),
        mode: 'BANK_TRANSFER',
      }),
    );
  }

  it('shows everything when nothing is selected', async () => {
    await seed();
    const result = expectOk(await register());
    expect(result.loans).toHaveLength(3);
    expect(result.totals.totalPrincipal.amount).toBe('2200000');
  });

  it('filters by several statuses at once', async () => {
    await seed();
    const result = expectOk(await register({ statuses: ['ACTIVE', 'PARTIALLY_REPAID'] }));
    expect(result.loans).toHaveLength(2);
    expect(result.totals.totalPrincipal.amount).toBe('1800000');
  });

  it('filters by borrower and status together', async () => {
    await seed();
    const result = expectOk(
      await register({ borrowers: ['priya'], statuses: ['PARTIALLY_REPAID'] }),
    );
    expect(result.loans).toHaveLength(1);
    expect(result.totals.totalOutstanding.amount).toBe('300000');
  });

  it('re-totals over the filtered set, not the whole register', async () => {
    await seed();
    const all = expectOk(await register());
    const one = expectOk(await register({ borrowers: ['Anil'] }));

    // Tiles describe what is on screen; totals that ignored the filter would be
    // read as the filtered ones.
    expect(one.totals.loanCount).toBe(1);
    expect(Number(one.totals.totalPrincipal.amount)).toBeLessThan(
      Number(all.totals.totalPrincipal.amount),
    );
  });

  it('separates pending interest on repaid principal from live loans', async () => {
    await seed();
    const { totals } = expectOk(await register());

    // Anil's ₹4,00,000 came back in July; six months of interest did not.
    expect(totals.pendingInterestRepaid.amount).toBe('24000');
    expect(Number(totals.pendingInterestActive.amount)).toBeGreaterThan(0);
  });

  it('keeps the borrower list complete while a filter is applied', async () => {
    await seed();
    const result = expectOk(await register({ statuses: ['REPAID'] }));
    expect(result.borrowers).toEqual(['Anil Kumar', 'Priya Menon', 'Rajesh Sharma']);
  });
});

describe('Scenario: Sorting', () => {
  async function seed(): Promise<void> {
    expectOk(await lend('Rajesh Sharma', '1200000', '12', '2025-04-01'));
    expectOk(await lend('Priya Menon', '600000', '12', '2025-06-01'));
    expectOk(await lend('Anil Kumar', '400000', '12', '2025-01-01'));
  }

  it('sorts by each requested field', async () => {
    await seed();
    const names = async (sortBy: string, direction: string) =>
      expectOk(await register({ sortBy, direction })).loans.map((loan) => loan.borrowerName);

    expect(await names('borrowerName', 'ASC')).toEqual([
      'Anil Kumar',
      'Priya Menon',
      'Rajesh Sharma',
    ]);
    expect(await names('loanDate', 'ASC')).toEqual(['Anil Kumar', 'Rajesh Sharma', 'Priya Menon']);
    // Numeric, not lexicographic: '1200000' sorts before '400000' as text.
    expect(await names('principal', 'DESC')).toEqual([
      'Rajesh Sharma',
      'Priya Menon',
      'Anil Kumar',
    ]);
  });
});

describe('Scenario: Export carries what is on screen', () => {
  it('writes a CSV with the register columns and a labelled total', async () => {
    const loanId = expectOk(await lend('Rajesh Sharma', '1200000'));
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('36000'),
        mode: 'UPI',
      }),
    );

    const csv = expectOk(await LoanUC.exportCsv({ asOf: AS_OF }));
    expect(csv).toContain('Borrower Name');
    expect(csv).toContain('Rajesh Sharma');
    expect(csv).toContain('TOTAL');
    // The two pending-interest figures are labelled separately in the file too.
    expect(csv).toContain('PENDING INTEREST — ACTIVE');
    expect(csv).toContain('PENDING INTEREST — PRINCIPAL REPAID');
    expect(csv).toContain('2025-07-01:36000(UPI)');
  });

  it('exports only the filtered loans', async () => {
    expectOk(await lend('Rajesh Sharma', '1200000'));
    expectOk(await lend('Priya Menon', '600000'));

    const csv = expectOk(await LoanUC.exportCsv({ asOf: AS_OF, borrowers: ['Priya'] }));
    expect(csv).toContain('Priya Menon');
    expect(csv).not.toContain('Rajesh Sharma');
  });

  it('quotes a note containing a comma rather than splitting the row', async () => {
    await LoanUC.record({
      borrowerName: 'Rajesh Sharma',
      principal: inr('100000'),
      interestRatePct: '12',
      loanDate: '2025-04-01',
      notes: 'Lent in cash, to be repaid after Diwali',
    });

    const csv = expectOk(await LoanUC.exportCsv({ asOf: AS_OF }));
    expect(csv).toContain('"Lent in cash, to be repaid after Diwali"');
  });

  it('writes a PDF a reader will open', async () => {
    expectOk(await lend('Rajesh Sharma', '1200000'));
    const pdf = expectOk(await LoanUC.exportPdf({ asOf: AS_OF }));

    const text = Buffer.from(pdf).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // A cross-reference table and trailer are what make it loadable at all.
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('xref');
    expect(text).toContain('trailer');
    expect(text).toContain('startxref');
    expect(text).toContain('Hand Loan Register');
    expect(text).toContain('Rajesh Sharma');
  });

  it('writes a valid PDF for an empty register rather than a broken file', async () => {
    const pdf = expectOk(await LoanUC.exportPdf({ asOf: AS_OF }));
    const text = Buffer.from(pdf).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 1');
  });

  it('paginates a register too long for one page', async () => {
    for (let index = 0; index < 45; index++) {
      expectOk(await lend(`Borrower ${String(index).padStart(2, '0')}`, '100000'));
    }
    const pdf = expectOk(await LoanUC.exportPdf({ asOf: AS_OF }));
    const text = Buffer.from(pdf).toString('latin1');
    // 45 rows at 30 per page.
    expect(text).toContain('/Count 2');
    expect(text).toContain('page 2 of 2');
  });
});
