/**
 * Borrowed loans and their payments (Phase 3, objectives 3 and 10).
 *
 * A loan is an aggregate like an Asset: the row in `borrowed_loans` is
 * meaningless without its payments, so a save replaces them wholesale in one
 * transaction. A partial update that leaves a stale payment behind produces an
 * outstanding balance that is wrong in a way nothing downstream can detect.
 *
 * Money is a decimal string plus a currency column, never REAL (ADR-002).
 */
import {
  Err,
  Ok,
  VaultStateError,
  type Currency,
  type Result,
} from '@vantagepoint/shared-kernel';
import type {
  BorrowedLoan,
  BorrowedLoanStatus,
  LiabilityKind,
  LoanInstalment,
  PaymentMode,
} from '@vantagepoint/core-domain';
import { Vault } from './vault.js';

interface LoanRow {
  readonly loan_id: string;
  readonly kind: string;
  readonly lender_ref: string;
  readonly lender_name: string | null;
  readonly principal: string;
  readonly currency: string;
  readonly interest_rate_pct: string;
  readonly tenure_months: number;
  readonly start_date: string;
  readonly stated_emi: string | null;
  readonly status: string;
  readonly closed_date: string | null;
  readonly secured_against: string | null;
  readonly account_ref: string | null;
  readonly notes: string | null;
}

interface PaymentRow {
  readonly payment_id: string;
  readonly loan_id: string;
  readonly date: string;
  readonly amount: string;
  readonly currency: string;
  readonly is_prepayment: number;
  readonly mode: string | null;
  readonly notes: string | null;
}

const money = (amount: string, currency: string) => ({
  amount,
  currency: currency as Currency,
});

function toPayment(row: PaymentRow): LoanInstalment {
  return {
    paymentId: row.payment_id,
    date: row.date,
    amount: money(row.amount, row.currency),
    ...(row.is_prepayment === 1 ? { isPrepayment: true } : {}),
    ...(row.mode === null ? {} : { mode: row.mode as PaymentMode }),
    ...(row.notes === null ? {} : { notes: row.notes }),
  };
}

function toLoan(row: LoanRow, payments: readonly PaymentRow[]): BorrowedLoan {
  return {
    loanId: row.loan_id,
    kind: row.kind as LiabilityKind,
    lenderRef: row.lender_ref,
    ...(row.lender_name === null ? {} : { lenderName: row.lender_name }),
    principal: money(row.principal, row.currency),
    interestRatePct: row.interest_rate_pct,
    tenureMonths: row.tenure_months,
    startDate: row.start_date,
    ...(row.stated_emi === null ? {} : { statedEmi: money(row.stated_emi, row.currency) }),
    payments: payments.map(toPayment),
    status: row.status as BorrowedLoanStatus,
    ...(row.closed_date === null ? {} : { closedDate: row.closed_date }),
    ...(row.secured_against === null ? {} : { securedAgainstAssetId: row.secured_against }),
    ...(row.account_ref === null ? {} : { accountRef: row.account_ref }),
    ...(row.notes === null ? {} : { notes: row.notes }),
  };
}

const requireUnlocked = (): Result<void> =>
  Vault.isUnlocked() ? Ok(undefined) : Err(new VaultStateError('vault is locked'));

export const BorrowedLoanRepository = {
  save(loan: BorrowedLoan): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);

    const db = Vault.connection();

    db.transaction(() => {
      db.prepare(
        `INSERT INTO borrowed_loans
           (loan_id, kind, lender_ref, lender_name, principal, currency, interest_rate_pct,
            tenure_months, start_date, stated_emi, status, closed_date, secured_against,
            account_ref, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(loan_id) DO UPDATE SET
           kind = excluded.kind,
           lender_ref = excluded.lender_ref,
           lender_name = excluded.lender_name,
           principal = excluded.principal,
           currency = excluded.currency,
           interest_rate_pct = excluded.interest_rate_pct,
           tenure_months = excluded.tenure_months,
           start_date = excluded.start_date,
           stated_emi = excluded.stated_emi,
           status = excluded.status,
           closed_date = excluded.closed_date,
           secured_against = excluded.secured_against,
           account_ref = excluded.account_ref,
           notes = excluded.notes`,
      ).run(
        loan.loanId,
        loan.kind,
        loan.lenderRef,
        loan.lenderName ?? null,
        loan.principal.amount,
        loan.principal.currency,
        loan.interestRatePct,
        loan.tenureMonths,
        loan.startDate,
        loan.statedEmi?.amount ?? null,
        loan.status,
        loan.closedDate ?? null,
        loan.securedAgainstAssetId ?? null,
        loan.accountRef ?? null,
        loan.notes ?? null,
      );

      // Replaced wholesale, like every other aggregate's children. A diff that
      // left a stale payment behind would change the outstanding balance with
      // nothing downstream able to tell.
      db.prepare('DELETE FROM borrowed_loan_payments WHERE loan_id = ?').run(loan.loanId);

      const insert = db.prepare(
        `INSERT INTO borrowed_loan_payments
           (payment_id, loan_id, date, amount, currency, is_prepayment, mode, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const payment of loan.payments) {
        insert.run(
          payment.paymentId,
          loan.loanId,
          payment.date,
          payment.amount.amount,
          payment.amount.currency,
          payment.isPrepayment === true ? 1 : 0,
          payment.mode ?? null,
          payment.notes ?? null,
        );
      }
    })();

    return Promise.resolve(Ok(undefined));
  },

  all(): Promise<readonly BorrowedLoan[]> {
    if (!Vault.isUnlocked()) return Promise.resolve([]);
    const db = Vault.connection();

    const loans = db
      .prepare('SELECT * FROM borrowed_loans ORDER BY start_date DESC, loan_id')
      .all() as LoanRow[];
    // One query for every payment rather than one per loan: the register reads
    // all of them on every render, and N+1 against a local file is still N+1.
    const payments = db
      .prepare('SELECT * FROM borrowed_loan_payments ORDER BY date, payment_id')
      .all() as PaymentRow[];

    const byLoan = new Map<string, PaymentRow[]>();
    for (const payment of payments) {
      const existing = byLoan.get(payment.loan_id);
      if (existing === undefined) byLoan.set(payment.loan_id, [payment]);
      else existing.push(payment);
    }

    return Promise.resolve(loans.map((row) => toLoan(row, byLoan.get(row.loan_id) ?? [])));
  },

  findById(loanId: string): Promise<BorrowedLoan | undefined> {
    if (!Vault.isUnlocked()) return Promise.resolve(undefined);
    const db = Vault.connection();

    const row = db.prepare('SELECT * FROM borrowed_loans WHERE loan_id = ?').get(loanId) as
      | LoanRow
      | undefined;
    if (row === undefined) return Promise.resolve(undefined);

    const payments = db
      .prepare('SELECT * FROM borrowed_loan_payments WHERE loan_id = ? ORDER BY date, payment_id')
      .all(loanId) as PaymentRow[];

    return Promise.resolve(toLoan(row, payments));
  },

  delete(loanId: string): Promise<Result<void>> {
    const guard = requireUnlocked();
    if (!guard.ok) return Promise.resolve(guard);
    // Payments go with it: ON DELETE CASCADE on the foreign key.
    Vault.connection().prepare('DELETE FROM borrowed_loans WHERE loan_id = ?').run(loanId);
    return Promise.resolve(Ok(undefined));
  },
};
