/**
 * FUNCTIONAL — money BORROWED, and what it does to net worth (Phase 3).
 *
 * ADR-009 made liabilities first class and the decision was never honoured.
 * `liabilities` held one frozen principal figure with **no write path at all**,
 * so net worth equalled gross assets in every vault that has ever existed — and
 * even with a row, six months of EMIs would have moved nothing, because the
 * stored figure had no way to reduce.
 *
 * What these pin:
 *   - a borrowing reduces net worth, and each EMI reduces it further;
 *   - the schedule splits interest from principal, and the split crosses over;
 *   - a prepayment is principal in full, not an instalment;
 *   - a missed instalment leaves MORE owed than the schedule says;
 *   - closing a loan is gated, because it removes a liability from net worth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EditModeUC,
  LiabilityUC,
  TradeUC,
  ValuePortfolioUC,
  VaultUC,
  resetPorts,
} from '@vantagepoint/app-services';
import { Vault } from '@vantagepoint/persistence';
import { expectErr, expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });
const AS_OF = '2026-09-15T10:00:00+05:30';

/** A 20-year home loan: ₹50,00,000 at 8.5%. */
const HOME_LOAN = {
  lenderName: 'A Bank',
  kind: 'HOME_LOAN' as const,
  principal: '50,00,000',
  interestRatePct: '8.5',
  tenureMonths: 240,
  startDate: '2026-01-05',
};

const registerOf = async () => expectOk(await LiabilityUC.register({ asOf: '2026-09-15' }));

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-borrowed-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await VaultUC.unlock(PASSPHRASE));
  resetPorts();
  expectOk(await EditModeUC.enable(PASSPHRASE));
});

afterEach(async () => {
  await VaultUC.lock();
  await Vault.close();
  EditModeUC.disable();
});

describe('Scenario: A borrowing is recorded and reduces net worth', () => {
  it('computes the lender’s EMI from principal, rate and tenure', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));

    // ₹50,00,000 at 8.5% over 240 months ≈ ₹43,391.16.
    const view = (await registerOf()).loans[0];
    expect(Number(view?.emi.amount)).toBeCloseTo(43_391, -1);
  });

  it('prefers the lender’s own EMI when the borrower states one', async () => {
    expectOk(await LiabilityUC.record({ ...HOME_LOAN, statedEmi: '43,400' }));

    expect(Number((await registerOf()).loans[0]?.emi.amount)).toBeCloseTo(43_400, 0);
  });

  /*
   * The headline of objective 3. Net worth equalled gross assets in every vault
   * because there was no way to create a liability at all.
   */
  it('makes net worth differ from gross assets, for the first time', async () => {
    expectOk(
      await TradeUC.record({
        assetClass: 'DOMESTIC_EQUITY',
        side: 'BUY',
        tradeDate: '2026-02-10',
        symbol: 'ACME',
        quantity: '1000',
        pricePerUnit: inr('1000'),
      }),
    );
    expectOk(await LiabilityUC.record(HOME_LOAN));

    const valuation = expectOk(await ValuePortfolioUC.execute(AS_OF));
    expect(Number(valuation.grossAssets.amount)).toBeCloseTo(1_000_000, 0);
    expect(Number(valuation.totalLiabilities.amount)).toBeGreaterThan(4_900_000);
    expect(Number(valuation.netWorth.amount)).toBeLessThan(0);
  });

  it('starts with the whole principal outstanding', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));

    expect(Number((await registerOf()).loans[0]?.outstanding.amount)).toBeCloseTo(5_000_000, -2);
  });
});

describe('Scenario: EMIs reduce what is owed', () => {
  const payEmis = async (loanId: string, count: number) => {
    for (let month = 1; month <= count; month++) {
      const date = `2026-${String(month + 1).padStart(2, '0')}-05`;
      expectOk(await LiabilityUC.recordPayment({ loanId, date, amount: '43391.16' }));
    }
  };

  it('reduces the outstanding balance with every instalment', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    const before = (await registerOf()).loans[0]?.outstanding.amount;

    await payEmis(loan.loanId, 6);

    const after = (await registerOf()).loans[0];
    expect(Number(after?.outstanding.amount)).toBeLessThan(Number(before));
    expect(after?.instalmentsPaid).toBe(6);
  });

  /*
   * Objective 10. Early instalments are almost all interest — on this loan the
   * first is ₹35,417 interest against ₹7,974 principal — and that is precisely
   * what a borrower wants to see.
   */
  it('splits each instalment into interest and principal', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));
    const schedule = (await registerOf()).loans[0]?.schedule ?? [];

    const first = schedule[0];
    expect(Number(first?.interest.amount)).toBeCloseTo(35_417, -1);
    expect(Number(first?.principal.amount)).toBeCloseTo(7_974, -1);
    expect(Number(first?.interest.amount)).toBeGreaterThan(Number(first?.principal.amount));
  });

  /** The crossover: principal overtakes interest partway through the tenure. */
  it('shows the interest/principal crossover', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));
    const schedule = (await registerOf()).loans[0]?.schedule ?? [];

    const crossover = schedule.findIndex(
      (instalment) => Number(instalment.principal.amount) > Number(instalment.interest.amount),
    );
    expect(crossover).toBeGreaterThan(0);
    expect(crossover).toBeLessThan(schedule.length);

    // And the last instalment clears the balance exactly, absorbing the rounding
    // that 240 rupee-rounded instalments accumulate.
    expect(Number(schedule[schedule.length - 1]?.closingBalance.amount)).toBe(0);
  });

  it('counts interest paid separately from principal repaid', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    await payEmis(loan.loanId, 6);

    const view = (await registerOf()).loans[0];
    expect(Number(view?.interestPaid.amount)).toBeGreaterThan(200_000);
    expect(Number(view?.principalRepaid.amount)).toBeGreaterThan(0);
    // Early in a 20-year loan, interest dwarfs principal.
    expect(Number(view?.interestPaid.amount)).toBeGreaterThan(
      Number(view?.principalRepaid.amount),
    );
  });

  it('reduces net worth further as EMIs are paid', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    const before = expectOk(await ValuePortfolioUC.execute(AS_OF)).totalLiabilities.amount;

    await payEmis(loan.loanId, 6);

    const after = expectOk(await ValuePortfolioUC.execute(AS_OF)).totalLiabilities.amount;
    expect(Number(after)).toBeLessThan(Number(before));
  });
});

describe('Scenario: A prepayment is principal in full', () => {
  /*
   * An EMI services accrued interest first; a prepayment does not. Treating one
   * as the other either overstates the interest paid or understates the balance.
   */
  it('applies the whole amount to principal', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(
      await LiabilityUC.recordPayment({
        loanId: loan.loanId,
        date: '2026-04-05',
        amount: '5,00,000',
        isPrepayment: true,
      }),
    );

    const view = (await registerOf()).loans[0];
    expect(Number(view?.prepaid.amount)).toBeCloseTo(500_000, 0);
    expect(Number(view?.principalRepaid.amount)).toBeCloseTo(500_000, 0);
    expect(Number(view?.interestPaid.amount)).toBe(0);
    expect(Number(view?.outstanding.amount)).toBeCloseTo(4_500_000, -2);
  });

  it('does not count a prepayment as an instalment', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(
      await LiabilityUC.recordPayment({
        loanId: loan.loanId,
        date: '2026-04-05',
        amount: '500000',
        isPrepayment: true,
      }),
    );

    expect((await registerOf()).loans[0]?.instalmentsPaid).toBe(0);
  });
});

describe('Scenario: Progress reflects what was PAID, not the schedule', () => {
  /*
   * A borrower who misses instalments owes more than the schedule says. Reading
   * progress off the contractual schedule would be wrong and would look right.
   */
  it('leaves more owed when instalments were missed', async () => {
    const paid = expectOk(await LiabilityUC.record(HOME_LOAN));
    for (let month = 2; month <= 9; month++) {
      expectOk(
        await LiabilityUC.recordPayment({
          loanId: paid.loanId,
          date: `2026-${String(month).padStart(2, '0')}-05`,
          amount: '43391.16',
        }),
      );
    }
    const onTime = Number((await registerOf()).loans[0]?.outstanding.amount);

    expectOk(await LiabilityUC.delete(paid.loanId));
    const missed = expectOk(await LiabilityUC.record(HOME_LOAN));
    // Only three of the eight instalments paid.
    for (const month of ['02', '03', '04']) {
      expectOk(
        await LiabilityUC.recordPayment({
          loanId: missed.loanId,
          date: `2026-${month}-05`,
          amount: '43391.16',
        }),
      );
    }

    expect(Number((await registerOf()).loans[0]?.outstanding.amount)).toBeGreaterThan(onTime);
  });

  it('reports progress as a percentage of the ORIGINAL principal', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(
      await LiabilityUC.recordPayment({
        loanId: loan.loanId,
        date: '2026-04-05',
        amount: '25,00,000',
        isPrepayment: true,
      }),
    );

    expect(Number((await registerOf()).loans[0]?.percentRepaid)).toBeCloseTo(50, 0);
  });
});

describe('Scenario: The register filters and totals like the loan book', () => {
  it('totals only the filtered rows, so the screen adds up', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(
      await LiabilityUC.record({
        lenderName: 'B Finance',
        kind: 'VEHICLE_LOAN',
        principal: '8,00,000',
        interestRatePct: '9.5',
        tenureMonths: 60,
        startDate: '2026-03-01',
      }),
    );

    const all = await registerOf();
    expect(all.totals.loanCount).toBe(2);

    const filtered = expectOk(
      await LiabilityUC.register({ kinds: ['VEHICLE_LOAN'], asOf: '2026-09-15' }),
    );
    expect(filtered.totals.loanCount).toBe(1);
    expect(Number(filtered.totals.totalBorrowed.amount)).toBeCloseTo(800_000, 0);
  });

  it('offers every lender for the filter control, not only the filtered ones', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(
      await LiabilityUC.record({
        lenderName: 'B Finance',
        kind: 'VEHICLE_LOAN',
        principal: '800000',
        interestRatePct: '9.5',
        tenureMonths: 60,
        startDate: '2026-03-01',
      }),
    );

    const filtered = expectOk(
      await LiabilityUC.register({ kinds: ['VEHICLE_LOAN'], asOf: '2026-09-15' }),
    );
    expect(filtered.lenders).toEqual(['A Bank', 'B Finance']);
  });

  it('counts only ACTIVE loans in the monthly commitment', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expect(Number((await registerOf()).totals.monthlyCommitment.amount)).toBeGreaterThan(0);

    expectOk(await LiabilityUC.close(loan.loanId, '2026-08-01'));
    expect(Number((await registerOf()).totals.monthlyCommitment.amount)).toBe(0);
  });
});

describe('Scenario: Closing a borrowing is gated', () => {
  /*
   * Closing REMOVES a liability from net worth, so it changes a figure rather
   * than adding one — the same rule that gates a deletion. A loan closed but not
   * settled overstates net worth by the whole outstanding balance.
   */
  it('refuses to close without edit mode', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    EditModeUC.disable();

    expectErr(await LiabilityUC.close(loan.loanId, '2026-08-01'), 'EDIT_MODE_REQUIRED');
  });

  it('drops a closed loan out of net worth entirely', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expect(
      Number(expectOk(await ValuePortfolioUC.execute(AS_OF)).totalLiabilities.amount),
    ).toBeGreaterThan(0);

    expectOk(await LiabilityUC.close(loan.loanId, '2026-08-01'));

    expect(Number(expectOk(await ValuePortfolioUC.execute(AS_OF)).totalLiabilities.amount)).toBe(0);
  });

  it('can put it back', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(await LiabilityUC.close(loan.loanId, '2026-08-01'));
    expectOk(await LiabilityUC.reopen(loan.loanId));

    expect((await registerOf()).loans[0]?.status).toBe('ACTIVE');
    expect(Number((await registerOf()).loans[0]?.outstanding.amount)).toBeGreaterThan(0);
  });
});

describe('Scenario: Input that would corrupt the register is refused', () => {
  it('refuses a loan with no lender', async () => {
    expectErr(await LiabilityUC.record({ ...HOME_LOAN, lenderName: '  ' }), 'VAULT_STATE');
  });

  it('refuses a principal of zero', async () => {
    expectErr(await LiabilityUC.record({ ...HOME_LOAN, principal: '0' }), 'VAULT_STATE');
  });

  it('refuses a tenure of zero months', async () => {
    expectErr(await LiabilityUC.record({ ...HOME_LOAN, tenureMonths: 0 }), 'VAULT_STATE');
  });

  it('refuses a start date that is not ISO', async () => {
    expectErr(await LiabilityUC.record({ ...HOME_LOAN, startDate: '05-01-2026' }), 'VAULT_STATE');
  });

  it('refuses the same loan twice', async () => {
    expectOk(await LiabilityUC.record(HOME_LOAN));
    expectErr(await LiabilityUC.record(HOME_LOAN), 'DUPLICATE_LOAN');
  });

  it('refuses a payment against a loan that does not exist', async () => {
    expectErr(
      await LiabilityUC.recordPayment({ loanId: 'bwl_nope', date: '2026-04-05', amount: '1000' }),
      'VAULT_STATE',
    );
  });

  /** Re-posting one payment must not double what has been repaid. */
  it('is idempotent on an identical payment', async () => {
    const loan = expectOk(await LiabilityUC.record(HOME_LOAN));
    expectOk(
      await LiabilityUC.recordPayment({ loanId: loan.loanId, date: '2026-02-05', amount: '43391.16' }),
    );
    expectOk(
      await LiabilityUC.recordPayment({ loanId: loan.loanId, date: '2026-02-05', amount: '43391.16' }),
    );

    expect((await registerOf()).loans[0]?.instalmentsPaid).toBe(1);
  });
});
