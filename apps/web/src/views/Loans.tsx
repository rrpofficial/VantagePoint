/**
 * Loans — the hand-loan register.
 *
 * Replaces a tracking spreadsheet, so it shows the same columns and answers the
 * same question first: how much is out there, and how much interest is owed.
 *
 * Two decisions are worth stating because both are visible on screen:
 *
 *  1. **Pending interest is split into two tiles.** Interest still owed on a
 *     loan whose principal came back has no repayment arriving alongside it, so
 *     it is the balance most easily forgotten. Folded into one number it hides
 *     inside the larger figure for live loans.
 *  2. **The tiles describe the FILTERED set.** Filter to one borrower and the
 *     totals become that borrower's. Totals that ignored the filter would be
 *     read as the filtered ones and quietly mislead.
 *
 * Every figure is computed by the API. Summing decimal strings in the browser
 * would reintroduce the float drift ADR-002 exists to prevent, and these are
 * amounts someone is owed.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type LoanAuditEntry,
  type LoanQuery,
  type LoanRegister,
  type LoanSortKey,
  type LoanStatus,
  type LoanView,
  type PaymentMode,
} from '../api.js';
import { Amount, Card, Chip } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { EditModeHint, useEditMode } from '../edit-mode.js';

const STATUSES: readonly { readonly value: LoanStatus; readonly label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PARTIALLY_REPAID', label: 'Partially repaid' },
  { value: 'REPAID', label: 'Repaid' },
];

const MODES: readonly PaymentMode[] = ['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'OTHER'];

const SORTABLE: readonly { readonly key: LoanSortKey; readonly label: string }[] = [
  { key: 'borrowerName', label: 'Borrower' },
  { key: 'status', label: 'Status' },
  { key: 'loanDate', label: 'Loan date' },
  { key: 'principal', label: 'Amount' },
];

const STATUS_LABEL: Readonly<Record<LoanStatus, string>> = {
  ACTIVE: 'Active',
  PARTIALLY_REPAID: 'Partially repaid',
  REPAID: 'Repaid',
};

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function Tile({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="pt-tile" data-testid={testId}>
      <span className="pt-tile__label">{label}</span>
      <strong className="pt-tile__value pt-numeric">{value}</strong>
      {hint !== undefined && <span className="pt-tile__hint">{hint}</span>}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

export function Loans() {
  const [register, setRegister] = useState<LoanRegister | undefined>();
  const [statuses, setStatuses] = useState<readonly LoanStatus[]>([]);
  const [borrowers, setBorrowers] = useState<readonly string[]>([]);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<LoanSortKey>('loanDate');
  const [direction, setDirection] = useState<'ASC' | 'DESC'>('DESC');
  const [expanded, setExpanded] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [showNewLoan, setShowNewLoan] = useState(false);

  const query: LoanQuery = {
    ...(statuses.length === 0 ? {} : { statuses }),
    ...(borrowers.length === 0 && search.trim().length === 0
      ? {}
      : { borrowers: [...borrowers, ...(search.trim().length === 0 ? [] : [search.trim()])] }),
    sortBy,
    direction,
  };

  const load = useCallback(async (): Promise<void> => {
    const result = await api.loans(query);
    if (result.ok) {
      setRegister(result.value);
      setError(undefined);
    } else setError(result.error.message);
    // The query object is rebuilt each render; its VALUES are the dependency.
  }, [statuses, borrowers, search, sortBy, direction]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = (status: LoanStatus): void => {
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  };

  const toggleBorrower = (name: string): void => {
    setBorrowers((current) =>
      current.includes(name) ? current.filter((b) => b !== name) : [...current, name],
    );
  };

  const totals = register?.totals;

  return (
    <div className="pt-stack">
      <Card
        title="Hand loans"
        action={
          <button
            type="button"
            className="pt-button-inline"
            onClick={() => {
              setShowNewLoan((open) => !open);
            }}
          >
            {showNewLoan ? 'Cancel' : 'Record a loan'}
          </button>
        }
      >
        <div className="pt-tiles" data-testid="loan-tiles">
          <Tile
            label="Total lent"
            value={INR.format(Number(totals?.totalPrincipal.amount ?? '0'))}
            hint={`${String(totals?.loanCount ?? 0)} loan(s) shown`}
            testId="tile-total-lent"
          />
          <Tile
            label="Principal outstanding"
            value={INR.format(Number(totals?.totalOutstanding.amount ?? '0'))}
            hint="Still to come back"
            testId="tile-outstanding"
          />
          <Tile
            label="Pending interest — active"
            value={INR.format(Number(totals?.pendingInterestActive.amount ?? '0'))}
            hint="On loans not yet fully repaid"
            testId="tile-pending-active"
          />
          <Tile
            label="Pending interest — principal repaid"
            value={INR.format(Number(totals?.pendingInterestRepaid.amount ?? '0'))}
            // Kept separate on purpose: nothing else is due on these loans, so
            // this is the balance that quietly goes uncollected.
            hint="Owed after the money came back"
            testId="tile-pending-repaid"
          />
        </div>

        {showNewLoan && (
          <NewLoanForm
            onSaved={() => void load()}
            onClose={() => {
              setShowNewLoan(false);
            }}
            known={register?.loans ?? []}
          />
        )}
      </Card>

      <Card title="Filter and sort">
        <div className="pt-controls">
          <span className="pt-controls__label">Status</span>
          {STATUSES.map((status) => (
            <label key={status.value} className="pt-check">
              <input
                type="checkbox"
                checked={statuses.includes(status.value)}
                onChange={() => {
                  toggleStatus(status.value);
                }}
              />
              {status.label}
            </label>
          ))}
          {statuses.length === 0 && <span className="pt-muted">none selected — showing all</span>}
        </div>

        <div className="pt-controls">
          <label htmlFor="borrower-search">Borrower</label>
          <input
            id="borrower-search"
            type="search"
            value={search}
            placeholder="Search by name"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />

          {/*
            A dropdown, not a checkbox per borrower. A checkbox list is readable
            at three names and unusable at fifty — it pushes the register itself
            off the screen. Selecting from the list adds a removable chip, which
            keeps multi-select without the wall of controls.
          */}
          <label htmlFor="borrower-select">Add</label>
          <select
            id="borrower-select"
            value=""
            onChange={(event) => {
              if (event.target.value.length > 0) toggleBorrower(event.target.value);
            }}
          >
            <option value="">Choose a borrower…</option>
            {(register?.borrowers ?? [])
              .filter((name) => !borrowers.includes(name))
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        </div>

        {borrowers.length > 0 && (
          <div className="pt-controls" data-testid="borrower-chips">
            {borrowers.map((name) => (
              <button
                key={name}
                type="button"
                className="pt-chip pt-chip--removable"
                aria-label={`Remove ${name} from the filter`}
                onClick={() => {
                  toggleBorrower(name);
                }}
              >
                {name} <span aria-hidden="true">×</span>
              </button>
            ))}
            <button
              type="button"
              className="pt-link pt-link--inline"
              onClick={() => {
                setBorrowers([]);
              }}
            >
              Clear all
            </button>
          </div>
        )}

        <div className="pt-controls">
          <label htmlFor="sort-by">Sort by</label>
          <select
            id="sort-by"
            value={sortBy}
            onChange={(event) => {
              setSortBy(event.target.value as LoanSortKey);
            }}
          >
            {SORTABLE.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="pt-link pt-link--inline"
            onClick={() => {
              setDirection((current) => (current === 'ASC' ? 'DESC' : 'ASC'));
            }}
          >
            {direction === 'ASC' ? 'Ascending' : 'Descending'}
          </button>

          <span className="pt-controls__spacer" />
          {/* Carry the current filters, so the file matches the screen. */}
          <a className="pt-link pt-link--inline" href={api.loanCsvUrl(query)} download>
            Export CSV
          </a>
          <a className="pt-link pt-link--inline" href={api.loanPdfUrl(query)} download>
            Export PDF
          </a>
        </div>
      </Card>

      <Card title="Register" action={<Chip>{`${String(register?.loans.length ?? 0)} shown`}</Chip>}>
        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}

        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="loan-table">
            <thead>
              <tr>
                <th scope="col">Borrower</th>
                <th scope="col">Loan date</th>
                <th scope="col">Status</th>
                <th scope="col" className="pt-align-end">
                  Amount
                </th>
                <th scope="col" className="pt-align-end">
                  Outstanding
                </th>
                <th scope="col" className="pt-align-end">
                  Rate
                </th>
                <th scope="col" className="pt-align-end">
                  Interest owed
                </th>
                <th scope="col" className="pt-align-end">
                  Months
                </th>
              </tr>
            </thead>
            <tbody>
              {register === undefined && (
                <tr>
                  <td colSpan={8} className="pt-muted">
                    Loading…
                  </td>
                </tr>
              )}
              {register?.loans.length === 0 && (
                <tr>
                  <td colSpan={8} className="pt-muted" data-testid="loan-empty">
                    No loans match these filters.
                  </td>
                </tr>
              )}
              {register?.loans.map((loan) => (
                <LoanRow
                  key={loan.loanId}
                  loan={loan}
                  expanded={expanded === loan.loanId}
                  onToggle={() => {
                    setExpanded(expanded === loan.loanId ? undefined : loan.loanId);
                  }}
                  onChanged={() => void load()}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function LoanRow({
  loan,
  expanded,
  onToggle,
  onChanged,
}: {
  loan: LoanView;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button type="button" className="pt-link pt-link--inline" aria-expanded={expanded} onClick={onToggle}>
            {loan.borrowerName}
          </button>
          {loan.notes.length > 0 && <div className="pt-muted">{loan.notes}</div>}
        </td>
        <td>{loan.loanDate}</td>
        <td>
          <span className={`pt-status pt-status--${loan.status.toLowerCase()}`}>
            {STATUS_LABEL[loan.status]}
          </span>
        </td>
        <td className="pt-align-end">
          <Amount value={loan.principal} />
        </td>
        <td className="pt-align-end">
          <Amount value={loan.outstandingPrincipal} />
        </td>
        <td className="pt-align-end pt-numeric">{loan.interestRatePct}%</td>
        <td className="pt-align-end">
          <Amount value={loan.interestBalance} />
        </td>
        <td className="pt-align-end pt-numeric">{loan.totalInterestMonths}</td>
      </tr>
      {expanded && (
        <tr className="pt-table__detail">
          <td colSpan={8}>
            <LoanDetail loan={loan} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function LoanDetail({ loan, onChanged }: { loan: LoanView; onChanged: () => void }) {
  const editMode = useEditMode();
  const [editing, setEditing] = useState(false);
  /*
   * Bumped by anything that writes a trail entry. The history is fetched once
   * per loan, so without this an edit made with the panel open left the trail
   * showing the state before it — the user would reasonably conclude the change
   * had not been recorded.
   */
  const [revision, setRevision] = useState(0);

  const changed = useCallback((): void => {
    setRevision((current) => current + 1);
    onChanged();
  }, [onChanged]);

  return (
    <div className="pt-stack" data-testid={`loan-detail-${loan.loanId}`}>
      {/*
        Editing and deleting appear together, and only in edit mode. Recording a
        payment stays below regardless: adding to a loan's history is the
        everyday path and nothing about it is destructive.
      */}
      {editMode.enabled ? (
        <div className="pt-actions">
          <button
            type="button"
            className="pt-button-inline"
            data-testid={`edit-toggle-${loan.loanId}`}
            onClick={() => {
              setEditing((open) => !open);
            }}
          >
            {editing ? 'Cancel edit' : 'Edit loan'}
          </button>
          <DeleteControl
            label="Delete loan"
            describes={`the loan to ${loan.borrowerName}`}
            testId={`delete-loan-${loan.loanId}`}
            withReason
            onDelete={(reason) => api.deleteLoan(loan.loanId, reason)}
            onDeleted={onChanged}
          />
        </div>
      ) : (
        <EditModeHint action="edit or delete this loan" />
      )}

      {editing && (
        <EditLoanForm
          loan={loan}
          onSaved={() => {
            setEditing(false);
            changed();
          }}
        />
      )}

      <dl className="pt-stats">
        <div>
          <dt>Interest accrued</dt>
          <dd>
            <Amount value={loan.totalInterestAccrued} />
          </dd>
        </div>
        <div>
          <dt>Interest received</dt>
          <dd>
            <Amount value={loan.interestPaid} />
          </dd>
        </div>
        <div>
          <dt>Interest / month</dt>
          <dd>
            <Amount value={loan.interestPerMonth} />
          </dd>
        </div>
        <div>
          <dt>Balance months</dt>
          <dd className="pt-numeric">{loan.interestBalanceMonths}</dd>
        </div>
        <div>
          <dt>Principal repaid</dt>
          <dd>
            <Amount value={loan.principalRepaid} />
          </dd>
        </div>
      </dl>

      <PaymentHistory title="Principal repayments" payments={loan.repayments} empty="None yet." />
      <PaymentHistory
        title="Interest payments"
        payments={loan.interestPayments}
        empty="No interest received yet."
      />

      <div className="pt-grid">
        <PaymentForm
          title="Record an interest payment"
          testId={`interest-form-${loan.loanId}`}
          submitLabel="Record interest"
          onSubmit={(input) => api.recordInterestPayment(loan.loanId, input)}
          onDone={changed}
        />
        <PaymentForm
          title="Record a principal repayment"
          testId={`principal-form-${loan.loanId}`}
          submitLabel="Record repayment"
          hint="Interest accrues only on what remains, from this date."
          onSubmit={(input) => api.recordPrincipalRepayment(loan.loanId, input)}
          onDone={changed}
        />
      </div>

      <AuditTrail loanId={loan.loanId} revision={revision} />
    </div>
  );
}

const ACTION_LABEL: Readonly<Record<LoanAuditEntry['action'], string>> = {
  CREATED: 'Recorded',
  CREATED_AS_DUPLICATE: 'Recorded as a confirmed duplicate',
  EDITED: 'Edited',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  PRINCIPAL_REPAYMENT: 'Principal repayment',
  INTEREST_PAYMENT: 'Interest payment',
  DELETED: 'Deleted',
};

/**
 * The trail, read from the vault rather than reconstructed in the browser.
 *
 * Reloaded whenever the detail panel is opened: an edit made in this session
 * must appear without a page refresh, or the user cannot tell whether it was
 * recorded.
 */
function AuditTrail({ loanId, revision }: { loanId: string; revision: number }) {
  const [entries, setEntries] = useState<readonly LoanAuditEntry[] | undefined>();

  useEffect(() => {
    void (async () => {
      const result = await api.loanAudit(loanId);
      setEntries(result.ok ? result.value.entries : []);
    })();
  }, [loanId, revision]);

  return (
    <div>
      <h4 className="pt-subhead">History</h4>
      <div className="pt-table-scroll">
        <table className="pt-table" data-testid={`loan-audit-${loanId}`}>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Field</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {entries === undefined && (
              <tr>
                <td colSpan={6} className="pt-muted">
                  Loading history…
                </td>
              </tr>
            )}
            {entries?.length === 0 && (
              <tr>
                <td colSpan={6} className="pt-muted">
                  Nothing recorded against this loan yet.
                </td>
              </tr>
            )}
            {entries?.map((entry) => (
              <tr key={entry.entryId}>
                <td className="pt-hash">{entry.recordedAt.replace('T', ' ').slice(0, 19)}</td>
                <td>{ACTION_LABEL[entry.action]}</td>
                <td>{entry.field ?? '—'}</td>
                <td>{entry.oldValue ?? '—'}</td>
                <td>{entry.newValue ?? '—'}</td>
                <td>{entry.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Every field is editable, by design. A mistyped principal is the main reason
 * anyone wants an edit at all, and the alternative — closing the loan and
 * re-entering it — leaves a settled loan on the register that was never settled.
 *
 * Only fields the user actually changed are sent, so the trail records the edit
 * rather than a restatement of every field.
 */
function EditLoanForm({ loan, onSaved }: { loan: LoanView; onSaved: () => void }) {
  const [borrowerName, setBorrowerName] = useState(loan.borrowerName);
  const [principal, setPrincipal] = useState(loan.principal.amount);
  const [rate, setRate] = useState(loan.interestRatePct);
  const [loanDate, setLoanDate] = useState(loan.loanDate);
  const [notes, setNotes] = useState(loan.notes);
  const [closedDate, setClosedDate] = useState(loan.closedDate ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    const result = await api.editLoan(loan.loanId, {
      ...(borrowerName === loan.borrowerName ? {} : { borrowerName }),
      ...(principal === loan.principal.amount ? {} : { principalAmount: principal.trim() }),
      ...(rate === loan.interestRatePct ? {} : { interestRatePct: rate.trim() }),
      ...(loanDate === loan.loanDate ? {} : { loanDate }),
      ...(notes === loan.notes ? {} : { notes }),
      // '' clears the date and reopens the loan; null is how the API says so.
      ...(closedDate === (loan.closedDate ?? '')
        ? {}
        : { closedDate: closedDate === '' ? null : closedDate }),
      ...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
  }, [loan, borrowerName, principal, rate, loanDate, notes, closedDate, reason, onSaved]);

  function onFormSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form
      className="pt-form pt-form--grid"
      onSubmit={onFormSubmit}
      data-testid={`edit-loan-form-${loan.loanId}`}
    >
      <div>
        <label htmlFor={`edit-borrower-${loan.loanId}`}>Borrower name</label>
        <input
          id={`edit-borrower-${loan.loanId}`}
          type="text"
          value={borrowerName}
          onChange={(event) => {
            setBorrowerName(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`edit-amount-${loan.loanId}`}>Loan amount</label>
        <input
          id={`edit-amount-${loan.loanId}`}
          type="text"
          inputMode="decimal"
          value={principal}
          onChange={(event) => {
            setPrincipal(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`edit-rate-${loan.loanId}`}>Interest rate %</label>
        <input
          id={`edit-rate-${loan.loanId}`}
          type="text"
          inputMode="decimal"
          value={rate}
          onChange={(event) => {
            setRate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`edit-date-${loan.loanId}`}>Loan date</label>
        <input
          id={`edit-date-${loan.loanId}`}
          type="date"
          value={loanDate}
          onChange={(event) => {
            setLoanDate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`edit-closed-${loan.loanId}`}>Closed date</label>
        <input
          id={`edit-closed-${loan.loanId}`}
          type="date"
          value={closedDate}
          onChange={(event) => {
            setClosedDate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`edit-notes-${loan.loanId}`}>Notes</label>
        <input
          id={`edit-notes-${loan.loanId}`}
          type="text"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
        />
      </div>
      <div className="pt-form__wide">
        <label htmlFor={`edit-reason-${loan.loanId}`}>Reason for this change</label>
        <input
          id={`edit-reason-${loan.loanId}`}
          type="text"
          value={reason}
          placeholder="e.g. amount was mistyped at entry"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </div>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function PaymentHistory({
  title,
  payments,
  empty,
}: {
  title: string;
  payments: readonly LoanView['interestPayments'][number][];
  empty: string;
}) {
  return (
    <div>
      <h3 className="pt-subhead">{title}</h3>
      {payments.length === 0 ? (
        <p className="pt-muted">{empty}</p>
      ) : (
        <table className="pt-table pt-table--nested">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="pt-align-end">
                Amount
              </th>
              <th scope="col">Mode</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment, index) => (
              <tr key={payment.paymentId ?? `${payment.date}-${String(index)}`}>
                <td>{payment.date}</td>
                <td className="pt-align-end">
                  <Amount value={payment.amount} />
                </td>
                <td>{payment.mode.replaceAll('_', ' ').toLowerCase()}</td>
                <td>{payment.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface PaymentInput {
  date: string;
  amount: { amount: string; currency: string };
  mode: PaymentMode;
  notes?: string;
}

function PaymentForm({
  title,
  testId,
  submitLabel,
  hint,
  onSubmit,
  onDone,
}: {
  title: string;
  testId: string;
  submitLabel: string;
  hint?: string;
  onSubmit: (input: PaymentInput) => Promise<{ ok: boolean }>;
  onDone: () => void;
}) {
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('BANK_TRANSFER');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    if (amount.trim().length === 0) {
      setError('Enter an amount.');
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await onSubmit({
      date,
      amount: { amount: amount.trim(), currency: 'INR' },
      mode,
      ...(notes.trim().length === 0 ? {} : { notes: notes.trim() }),
    });
    setBusy(false);
    if (!result.ok) {
      setError('That payment could not be recorded.');
      return;
    }
    setAmount('');
    setNotes('');
    onDone();
  }, [amount, date, mode, notes, onSubmit, onDone]);

  function onFormSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="pt-form" onSubmit={onFormSubmit} data-testid={testId}>
      <h3 className="pt-subhead">{title}</h3>
      {hint !== undefined && <p className="pt-muted">{hint}</p>}

      <label htmlFor={`${testId}-date`}>Date</label>
      <input
        id={`${testId}-date`}
        type="date"
        value={date}
        onChange={(event) => {
          setDate(event.target.value);
        }}
      />

      <label htmlFor={`${testId}-amount`}>Amount</label>
      <input
        id={`${testId}-amount`}
        type="text"
        inputMode="decimal"
        value={amount}
        placeholder="0"
        onChange={(event) => {
          setAmount(event.target.value);
        }}
      />

      <label htmlFor={`${testId}-mode`}>Mode</label>
      <select
        id={`${testId}-mode`}
        value={mode}
        onChange={(event) => {
          setMode(event.target.value as PaymentMode);
        }}
      >
        {MODES.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll('_', ' ').toLowerCase()}
          </option>
        ))}
      </select>

      <label htmlFor={`${testId}-notes`}>Notes</label>
      <input
        id={`${testId}-notes`}
        type="text"
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
        }}
      />

      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function NewLoanForm({
  onSaved,
  onClose,
  known,
}: {
  onSaved: () => void;
  onClose: () => void;
  /** The loans already on screen, so a flagged duplicate can be shown in full. */
  known: readonly LoanView[];
}) {
  const [borrowerName, setBorrowerName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('12');
  const [loanDate, setLoanDate] = useState(today);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState<readonly string[] | undefined>();

  const submit = useCallback(
    async (confirmDuplicate: boolean): Promise<void> => {
      setBusy(true);
      setError(undefined);
      const result = await api.recordLoan({
        borrowerName,
        principal: { amount: principal.trim(), currency: 'INR' },
        interestRatePct: rate.trim(),
        loanDate,
        ...(notes.trim().length === 0 ? {} : { notes: notes.trim() }),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      });
      setBusy(false);

      if (!result.ok) {
        // Not a failure the user should have to decode — it is a question, and
        // the answer is a button. The typed payload is what makes it possible
        // to show WHICH loans matched rather than just saying one did.
        if (result.error.code === 'DUPLICATE_LOAN') {
          setDuplicates(result.error.duplicates ?? []);
          return;
        }
        setError(result.error.message);
        return;
      }

      setDuplicates(undefined);
      setBorrowerName('');
      setPrincipal('');
      setNotes('');
      onSaved();
      onClose();
    },
    [borrowerName, principal, rate, loanDate, notes, onSaved, onClose],
  );

  function onFormSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit(false);
  }

  const matched = known.filter((loan) => duplicates?.includes(loan.loanId) === true);

  if (duplicates !== undefined) {
    return (
      <div className="pt-callout pt-callout--warn" role="alertdialog" data-testid="duplicate-warning">
        <h3 className="pt-subhead">This borrower already has a loan dated {loanDate}</h3>
        <p className="pt-muted">
          {matched.length === 1
            ? 'One loan already on the register matches. '
            : `${String(duplicates.length)} loans already on the register match. `}
          If this is a further, separate loan, record it — the register keeps both. If you are
          re-entering a loan you already recorded, cancel and edit the existing one instead.
        </p>

        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="duplicate-matches">
            <thead>
              <tr>
                <th scope="col">Borrower</th>
                <th scope="col">Loan date</th>
                <th scope="col" className="pt-align-end">Amount</th>
                <th scope="col" className="pt-align-end">Outstanding</th>
                <th scope="col">Status</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {matched.map((loan) => (
                <tr key={loan.loanId}>
                  <td>{loan.borrowerName}</td>
                  <td>{loan.loanDate}</td>
                  <td className="pt-numeric">
                    <Amount value={loan.principal} />
                  </td>
                  <td className="pt-numeric">
                    <Amount value={loan.outstandingPrincipal} />
                  </td>
                  <td>{STATUS_LABEL[loan.status]}</td>
                  <td>{loan.notes}</td>
                </tr>
              ))}
              {matched.length === 0 && (
                <tr>
                  <td colSpan={6} className="pt-muted">
                    The matching loans are outside the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="pt-actions">
          <button
            type="button"
            disabled={busy}
            data-testid="confirm-duplicate"
            onClick={() => void submit(true)}
          >
            {busy ? 'Recording…' : 'Yes, record it as a separate loan'}
          </button>
          <button
            type="button"
            className="pt-button-inline"
            onClick={() => {
              setDuplicates(undefined);
            }}
          >
            Cancel and go back
          </button>
        </div>
        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="pt-form pt-form--grid" onSubmit={onFormSubmit} data-testid="new-loan-form">
      <div>
        <label htmlFor="loan-borrower">Borrower name</label>
        <input
          id="loan-borrower"
          type="text"
          value={borrowerName}
          onChange={(event) => {
            setBorrowerName(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="loan-amount">Loan amount</label>
        <input
          id="loan-amount"
          type="text"
          inputMode="decimal"
          value={principal}
          onChange={(event) => {
            setPrincipal(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="loan-rate">Interest rate %</label>
        <input
          id="loan-rate"
          type="text"
          inputMode="decimal"
          value={rate}
          onChange={(event) => {
            setRate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="loan-date">Loan date</label>
        <input
          id="loan-date"
          type="date"
          value={loanDate}
          onChange={(event) => {
            setLoanDate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="loan-notes">Notes</label>
        <input
          id="loan-notes"
          type="text"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
        />
      </div>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save loan'}
      </button>
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
