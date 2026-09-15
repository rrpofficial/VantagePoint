/**
 * The hand-loan audit trail (US-1.11).
 *
 * A loan is a claim on another person's money, and the terms of that claim are
 * exactly what gets disputed years later. Once a loan can be edited at all, the
 * value shown on screen stops being evidence of anything on its own: it is only
 * the latest value. What makes it evidence again is the trail of how it got
 * there.
 *
 * Three properties are load-bearing:
 *
 *  1. **Append-only.** A correction is a further entry, never a rewrite of an
 *     earlier one. There is no update or delete for the audit table anywhere in
 *     the codebase, which is what makes the trail worth reading.
 *  2. **Field-level.** One entry per field actually changed, carrying both the
 *     old and the new value. An entry saying only "loan edited" cannot answer
 *     whether the principal moved, which is the question that matters.
 *  3. **Unchanged fields produce nothing.** Submitting the edit form without
 *     touching anything must leave no trace, or the trail fills with noise and
 *     stops being read — which is the same as not having one.
 */
import type { IsoDate } from '@vantagepoint/shared-kernel';
import type { HandLoan } from './types.js';

export type LoanAuditAction =
  | 'CREATED'
  /** Created despite matching an existing loan, with the lender's confirmation. */
  | 'CREATED_AS_DUPLICATE'
  | 'EDITED'
  | 'CLOSED'
  | 'REOPENED'
  | 'PRINCIPAL_REPAYMENT'
  | 'INTEREST_PAYMENT'
  /**
   * The loan itself was removed. The entry outlives it: the trail does not
   * cascade with the record (see the v6 migration), so this is what remains to
   * answer why a loan someone remembers is no longer on the register.
   */
  | 'DELETED';

export interface LoanAuditEntry {
  readonly entryId: string;
  readonly loanId: string;
  readonly action: LoanAuditAction;
  /** Set for EDITED; absent for actions that are not a field-level change. */
  readonly field?: string;
  readonly oldValue?: string;
  readonly newValue?: string;
  readonly reason?: string;
  /** ISO-8601 instant, not a date: two edits on one day must still order. */
  readonly recordedAt: string;
}

/** The fields an edit may change. Everything else about a loan is derived. */
export interface LoanEdit {
  readonly borrowerName?: string;
  readonly principalAmount?: string;
  readonly interestRatePct?: string;
  readonly loanDate?: IsoDate;
  readonly notes?: string;
  readonly closedDate?: IsoDate | null;
}

/** Label shown in the trail. Kept out of the browser so exports read the same. */
const FIELD_LABELS: Readonly<Record<keyof LoanEdit, string>> = {
  borrowerName: 'Borrower',
  principalAmount: 'Principal',
  interestRatePct: 'Interest rate %',
  loanDate: 'Loan date',
  notes: 'Notes',
  closedDate: 'Closed date',
};

/** The loan's current value for each editable field, as the trail records it. */
function currentValues(loan: HandLoan): Readonly<Record<keyof LoanEdit, string>> {
  return {
    borrowerName: loan.borrowerName ?? '',
    principalAmount: loan.principal.amount,
    interestRatePct: loan.interestRatePct,
    loanDate: loan.startDate,
    notes: loan.notes ?? '',
    closedDate: loan.closedDate ?? '',
  };
}

/**
 * Applies an edit, returning the new loan and one entry per field that actually
 * moved. Pure: the caller persists both, or neither.
 *
 * `closedDate: null` clears the date — distinct from `undefined`, which means
 * "not part of this edit". Collapsing the two would make it impossible to
 * reopen a loan through the same form that closes it.
 */
export function applyEdit(
  loan: HandLoan,
  edit: LoanEdit,
  context: { readonly recordedAt: string; readonly reason?: string; readonly entryId: (index: number) => string },
): { readonly loan: HandLoan; readonly entries: readonly LoanAuditEntry[] } {
  const before = currentValues(loan);
  const entries: LoanAuditEntry[] = [];
  let next = loan;

  const note = (field: keyof LoanEdit, newValue: string): void => {
    const oldValue = before[field];
    if (oldValue === newValue) return;
    entries.push({
      entryId: context.entryId(entries.length),
      loanId: loan.assetId,
      action: 'EDITED',
      field: FIELD_LABELS[field],
      oldValue,
      newValue,
      recordedAt: context.recordedAt,
      ...(context.reason === undefined || context.reason.length === 0
        ? {}
        : { reason: context.reason }),
    });
  };

  if (edit.borrowerName !== undefined) {
    note('borrowerName', edit.borrowerName);
    next = { ...next, borrowerName: edit.borrowerName };
  }
  if (edit.principalAmount !== undefined) {
    note('principalAmount', edit.principalAmount);
    next = { ...next, principal: { ...next.principal, amount: edit.principalAmount } };
  }
  if (edit.interestRatePct !== undefined) {
    note('interestRatePct', edit.interestRatePct);
    next = { ...next, interestRatePct: edit.interestRatePct };
  }
  if (edit.loanDate !== undefined) {
    note('loanDate', edit.loanDate);
    next = { ...next, startDate: edit.loanDate };
  }
  if (edit.notes !== undefined) {
    note('notes', edit.notes);
    next = { ...next, notes: edit.notes };
  }
  if (edit.closedDate !== undefined) {
    note('closedDate', edit.closedDate ?? '');
    if (edit.closedDate === null) {
      const { closedDate: _cleared, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, closedDate: edit.closedDate };
    }
  }

  return { loan: next, entries };
}

/**
 * Loans that a newly entered one would duplicate.
 *
 * Same borrower on the same day. The amount is deliberately NOT part of the
 * test: two loans to the same person on one day are worth flagging whether or
 * not they happen to be for the same sum, and a lender who meant to record one
 * loan and typed it twice usually typed the same amount both times.
 *
 * This reports; it does not refuse. Genuine same-day duplicates happen, and a
 * tracker that makes them impossible to record is one the lender stops using.
 */
export function duplicatesOf(
  candidate: { readonly borrowerRef: string; readonly loanDate: IsoDate },
  existing: readonly HandLoan[],
): readonly HandLoan[] {
  return existing.filter(
    (loan) => loan.borrowerRef === candidate.borrowerRef && loan.startDate === candidate.loanDate,
  );
}
