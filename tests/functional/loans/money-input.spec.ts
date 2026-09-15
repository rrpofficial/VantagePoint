/**
 * FUNCTIONAL — a typed amount must never be able to break the register.
 *
 * Reported from the running app: the Loans tab sat at "Loading…" forever. The
 * API was returning 500 with `[DecimalError] Invalid argument: 1,00,000` — an
 * interest payment had been entered as `1,00,000`, which is a completely
 * reasonable thing to type, and the recorders validated nothing. The string
 * reached the vault, and every subsequent read of ANY loan threw on it.
 *
 * That is the shape worth pinning: not "bad input is rejected" but "bad input
 * cannot poison later reads", because the failure was total and left no way to
 * find the offending row from inside the application.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '@vantagepoint/shared-kernel';
import { LoanUC, ValuePortfolioUC, resetPorts } from '@vantagepoint/app-services';
import { AssetRepository, Vault } from '@vantagepoint/persistence';
import { expectOk } from '@vantagepoint/test-kit';

const PASSPHRASE = 'correct horse battery staple';
const AS_OF = '2026-04-01';
const inr = (amount: string) => ({ amount, currency: 'INR' as const });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantagepoint-money-'));
  expectOk(await Vault.open({ dataDir: dir, fileName: 'vault.db' }));
  expectOk(await Vault.unlock(PASSPHRASE));
  resetPorts();
});

afterEach(async () => {
  await Vault.close();
});

const lend = (amount = '1200000') =>
  LoanUC.record({
    borrowerName: 'Rajesh Sharma',
    principal: inr(amount),
    interestRatePct: '12',
    loanDate: '2025-04-01',
  });

describe('Scenario: Amounts are accepted the way people write them', () => {
  it('reads Indian digit grouping', () => {
    expect(expectOk(Money.parse('1,00,000', 'INR')).amount).toBe('100000');
    expect(expectOk(Money.parse('12,34,567.89', 'INR')).amount).toBe('1234567.89');
  });

  it('reads Western grouping too', () => {
    expect(expectOk(Money.parse('100,000', 'INR')).amount).toBe('100000');
  });

  it('reads a currency symbol and stray spaces', () => {
    expect(expectOk(Money.parse('  ₹ 1,00,000 ', 'INR')).amount).toBe('100000');
    expect(expectOk(Money.parse('Rs. 5000', 'INR')).amount).toBe('5000');
  });

  it('refuses what is genuinely not a number, without throwing', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '--5']) {
      const result = Money.parse(bad, 'INR');
      expect(result.ok, `"${bad}" should be refused`).toBe(false);
    }
  });

  it('treats a comma as a separator, never as a decimal point', () => {
    // INR-first: Indian grouping is irregular, so `1,5` cannot be one-and-a-half.
    expect(expectOk(Money.parse('1,5', 'INR')).amount).toBe('15');
  });
});

describe('Scenario: A payment typed as 1,00,000 is recorded, not rejected or corrupted', () => {
  it('accepts it and stores a canonical amount', async () => {
    const loanId = expectOk(await lend());
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('1,00,000'),
        mode: 'UPI',
      }),
    );

    const register = expectOk(await LoanUC.register({ asOf: AS_OF }));
    expect(register.loans[0]?.interestPaid.amount).toBe('100000');
  });

  it('leaves the register readable afterwards', async () => {
    const loanId = expectOk(await lend());
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2025-10-01',
        amount: inr('6,00,000'),
        mode: 'BANK_TRANSFER',
      }),
    );

    // The exact failure reported: this call used to throw and 500.
    const register = expectOk(await LoanUC.register({ asOf: AS_OF }));
    expect(register.loans[0]?.outstandingPrincipal.amount).toBe('600000');
    expect(register.loans[0]?.status).toBe('PARTIALLY_REPAID');
  });

  it('refuses a payment that is not a number at all', async () => {
    const loanId = expectOk(await lend());
    const result = await LoanUC.recordInterestPayment({
      loanId,
      date: '2025-07-01',
      amount: inr('a lakh'),
      mode: 'UPI',
    });
    expect(result.ok).toBe(false);

    // And nothing was written, so the register still loads.
    expect(expectOk(await LoanUC.register({ asOf: AS_OF })).loans[0]?.interestPaid.amount).toBe('0');
  });

  it('refuses a payment of zero or less', async () => {
    const loanId = expectOk(await lend());
    for (const amount of ['0', '-5000']) {
      expect((await LoanUC.recordInterestPayment({ loanId, date: '2025-07-01', amount: inr(amount), mode: 'UPI' })).ok).toBe(false);
    }
  });

  it('refuses a payment with no usable date', async () => {
    const loanId = expectOk(await lend());
    const result = await LoanUC.recordInterestPayment({
      loanId,
      date: 'last Tuesday',
      amount: inr('1000'),
      mode: 'CASH',
    });
    expect(result.ok).toBe(false);
  });
});

describe('Scenario: A vault already holding a malformed amount still opens', () => {
  it('recovers a stored "1,00,000" rather than failing every read', async () => {
    const loanId = expectOk(await lend());

    // Write the corrupt shape directly, as the unvalidated recorder once did.
    const asset = await AssetRepository.findById(loanId);
    expectOk(
      await AssetRepository.save({
        ...asset!,
        handLoan: {
          ...asset!.handLoan!,
          interestPayments: [
            { paymentId: 'legacy', date: '2025-07-01', amount: inr('1,00,000'), mode: 'UPI' },
          ],
        },
      }),
    );

    // The register must still load — one bad row costs that row, never the ledger.
    const register = expectOk(await LoanUC.register({ asOf: AS_OF }));
    expect(register.loans).toHaveLength(1);
    expect(register.loans[0]?.interestPaid.amount).toBe('100000');
  });
});

describe('Scenario: A hand loan counts toward net worth', () => {
  it('counts the outstanding principal as an asset', async () => {
    expectOk(await lend('1200000'));

    const valuation = expectOk(await ValuePortfolioUC.execute(`${AS_OF}T23:59:59.999+05:30`));
    // ₹12,00,000 lent, plus a year of interest at 12% that has not been paid.
    expect(valuation.byAssetClass['HAND_LOAN']?.amount).toBe('1344000');
    expect(valuation.netWorth.amount).toBe('1344000');
  });

  it('counts interest that is owed but NOT interest already received', async () => {
    const loanId = expectOk(await lend('1200000'));
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('72000'),
        mode: 'UPI',
      }),
    );

    const valuation = expectOk(await ValuePortfolioUC.execute(`${AS_OF}T23:59:59.999+05:30`));
    /*
     * ₹1,44,000 accrued, ₹72,000 of it already received and now sitting in a
     * bank account. Counting the full accrual here as well would report that
     * ₹72,000 twice — once as cash, once as a receivable.
     */
    expect(valuation.byAssetClass['HAND_LOAN']?.amount).toBe('1272000');
  });

  it('drops the receivable to the principal alone once interest is settled', async () => {
    const loanId = expectOk(await lend('1200000'));
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2026-04-01',
        amount: inr('144000'),
        mode: 'BANK_TRANSFER',
      }),
    );

    const valuation = expectOk(await ValuePortfolioUC.execute(`${AS_OF}T23:59:59.999+05:30`));
    expect(valuation.byAssetClass['HAND_LOAN']?.amount).toBe('1200000');
  });

  it('never counts an overpayment of interest as an extra asset', async () => {
    const loanId = expectOk(await lend('1200000'));
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2026-04-01',
        amount: inr('200000'),
        mode: 'CASH',
      }),
    );

    const valuation = expectOk(await ValuePortfolioUC.execute(`${AS_OF}T23:59:59.999+05:30`));
    // Clamped: a negative receivable would quietly reduce net worth.
    expect(valuation.byAssetClass['HAND_LOAN']?.amount).toBe('1200000');
  });

  it('stops counting the principal once it has been repaid', async () => {
    const loanId = expectOk(await lend('1200000'));
    expectOk(
      await LoanUC.recordPrincipalRepayment({
        loanId,
        date: '2026-04-01',
        amount: inr('1200000'),
        mode: 'BANK_TRANSFER',
      }),
    );

    const valuation = expectOk(await ValuePortfolioUC.execute(`${AS_OF}T23:59:59.999+05:30`));
    // Principal gone, but a year of unpaid interest is still owed to us.
    expect(valuation.byAssetClass['HAND_LOAN']?.amount).toBe('144000');
  });

  it('agrees with what the Loans register reports as owed', async () => {
    const loanId = expectOk(await lend('1200000'));
    expectOk(
      await LoanUC.recordInterestPayment({
        loanId,
        date: '2025-07-01',
        amount: inr('36000'),
        mode: 'UPI',
      }),
    );

    const register = expectOk(await LoanUC.register({ asOf: AS_OF }));
    const loan = register.loans[0]!;
    const valuation = expectOk(await ValuePortfolioUC.execute(`${AS_OF}T23:59:59.999+05:30`));

    // The two screens must not disagree about the same money.
    const expected = Number(loan.outstandingPrincipal.amount) + Number(loan.interestBalance.amount);
    expect(Number(valuation.byAssetClass['HAND_LOAN']?.amount)).toBe(expected);
  });
});
