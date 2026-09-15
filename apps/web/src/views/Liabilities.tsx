/**
 * Borrowings — what net worth is reduced BY (Phase 3, objectives 3 and 10).
 *
 * A top-level section, deliberately not a tab under Assets. A borrowing is not
 * an asset, and filing it under an Assets sub-nav is the category error that
 * §1.1 of the evolution plan warns about — the same reason Schedule AL keeps
 * assets and liabilities in separate parts.
 *
 * Built to the shape of `Loans.tsx`, which solves the mirror-image problem:
 * money lent rather than money owed.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { api, type BorrowedRegister, type BorrowedView } from '../api.js';
import { Amount, Card, Chip } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { useEditMode } from '../edit-mode.js';

const humanise = (value: string) =>
  value.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

function NewLoanForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [kinds, setKinds] = useState<readonly string[]>(['HOME_LOAN']);
  const [lenderName, setLenderName] = useState('');
  const [kind, setKind] = useState('HOME_LOAN');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [tenure, setTenure] = useState('');
  const [startDate, setStartDate] = useState('');
  const [statedEmi, setStatedEmi] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      const result = await api.liabilityKinds();
      if (result.ok) setKinds(result.value.kinds);
    })();
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.recordLiability({
      lenderName: lenderName.trim(),
      kind,
      principal: principal.trim(),
      interestRatePct: rate.trim(),
      tenureMonths: tenure.trim(),
      startDate,
      ...(statedEmi.trim().length === 0 ? {} : { statedEmi: statedEmi.trim() }),
      ...(notes.trim().length === 0 ? {} : { notes: notes.trim() }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
    onClose();
  }, [lenderName, kind, principal, rate, tenure, startDate, statedEmi, notes, onSaved, onClose]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="pt-form pt-form--grid" onSubmit={onSubmit} data-testid="new-liability-form">
      <label htmlFor="liab-lender">Lender</label>
      <input
        id="liab-lender"
        value={lenderName}
        onChange={(event) => {
          setLenderName(event.target.value);
        }}
        placeholder="held only in your vault"
        required
      />

      <label htmlFor="liab-kind">Type</label>
      <select
        id="liab-kind"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value);
        }}
      >
        {kinds.map((option) => (
          <option key={option} value={option}>
            {humanise(option)}
          </option>
        ))}
      </select>

      <label htmlFor="liab-principal">Amount borrowed</label>
      <input
        id="liab-principal"
        value={principal}
        onChange={(event) => {
          setPrincipal(event.target.value);
        }}
        placeholder="e.g. 50,00,000"
        inputMode="decimal"
        required
      />

      <label htmlFor="liab-rate">Interest rate %</label>
      <input
        id="liab-rate"
        value={rate}
        onChange={(event) => {
          setRate(event.target.value);
        }}
        placeholder="e.g. 8.5"
        inputMode="decimal"
        required
      />

      <label htmlFor="liab-tenure">Tenure (months)</label>
      <input
        id="liab-tenure"
        value={tenure}
        onChange={(event) => {
          setTenure(event.target.value);
        }}
        placeholder="e.g. 240"
        inputMode="numeric"
        required
      />

      <label htmlFor="liab-start">First instalment due</label>
      <input
        id="liab-start"
        type="date"
        value={startDate}
        onChange={(event) => {
          setStartDate(event.target.value);
        }}
        required
      />

      <label htmlFor="liab-emi">EMI</label>
      <input
        id="liab-emi"
        value={statedEmi}
        onChange={(event) => {
          setStatedEmi(event.target.value);
        }}
        placeholder="optional — computed if blank"
        inputMode="decimal"
      />

      <label htmlFor="liab-notes">Notes</label>
      <input
        id="liab-notes"
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
        }}
      />

      <div className="pt-form__wide">
        <p className="pt-muted">
          If you leave the EMI blank it is computed from the principal, rate and tenure. Where you
          know the lender&rsquo;s own figure, enter it — a lender rounds to the rupee, and a
          schedule three rupees out is one you cannot reconcile against your statement.
        </p>
      </div>

      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Record borrowing'}
      </button>

      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function PaymentForm({ loan, onSaved }: { loan: BorrowedView; onSaved: () => void }) {
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState(loan.emi.amount);
  const [isPrepayment, setIsPrepayment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.recordLiabilityPayment(loan.loanId, {
      date,
      amount: amount.trim(),
      ...(isPrepayment ? { isPrepayment: true } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
  }, [loan.loanId, date, amount, isPrepayment, onSaved]);

  return (
    <div className="pt-form pt-form--grid" data-testid={`payment-form-${loan.loanId}`}>
      <label htmlFor={`pay-date-${loan.loanId}`}>Paid on</label>
      <input
        id={`pay-date-${loan.loanId}`}
        type="date"
        value={date}
        onChange={(event) => {
          setDate(event.target.value);
        }}
      />

      <label htmlFor={`pay-amount-${loan.loanId}`}>Amount</label>
      <input
        id={`pay-amount-${loan.loanId}`}
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
        }}
        inputMode="decimal"
      />

      <label htmlFor={`pay-prepay-${loan.loanId}`}>Prepayment</label>
      <input
        id={`pay-prepay-${loan.loanId}`}
        type="checkbox"
        checked={isPrepayment}
        onChange={(event) => {
          setIsPrepayment(event.target.checked);
        }}
      />

      <button type="button" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Saving…' : 'Record payment'}
      </button>

      <div className="pt-form__wide">
        <p className="pt-muted">
          An EMI services accrued interest first, then principal. A{' '}
          <strong>prepayment</strong> goes entirely against principal — tick the box so it is not
          counted as an instalment.
        </p>
      </div>

      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Liabilities() {
  const editMode = useEditMode();
  const [register, setRegister] = useState<BorrowedRegister | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>();
  const [status, setStatus] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const result = await api.liabilities(status.length === 0 ? {} : { status });
    if (result.ok) {
      setRegister(result.value);
      setError(undefined);
    } else setError(result.error.message);
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== undefined) {
    return (
      <Card title="Borrowings">
        <p className="pt-error" role="alert">
          {error}
        </p>
      </Card>
    );
  }

  if (register === undefined) {
    return (
      <Card title="Borrowings">
        <p className="pt-muted">Loading…</p>
      </Card>
    );
  }

  const { totals } = register;

  return (
    <div className="pt-stack">
      <Card
        title="Borrowings"
        action={
          <div className="pt-actions pt-actions--inline">
            <Chip>{`${String(totals.activeCount)} active`}</Chip>
            <button
              type="button"
              className="pt-button-inline"
              data-testid="add-liability"
              onClick={() => {
                setAdding((open) => !open);
              }}
            >
              Record a borrowing
            </button>
          </div>
        }
      >
        <p className="pt-muted">
          What net worth is reduced <strong>by</strong>. A borrowing is not an asset, so it lives
          here rather than under Assets — the same separation Schedule AL makes.
        </p>

        <dl className="pt-stats">
          <div>
            <dt>Outstanding</dt>
            <dd data-testid="total-outstanding">
              <Amount value={totals.totalOutstanding} />
            </dd>
          </div>
          <div>
            <dt>Borrowed</dt>
            <dd>
              <Amount value={totals.totalBorrowed} />
            </dd>
          </div>
          <div>
            <dt>Principal repaid</dt>
            <dd>
              <Amount value={totals.totalPrincipalRepaid} />
            </dd>
          </div>
          <div>
            <dt>Interest paid</dt>
            <dd>
              <Amount value={totals.totalInterestPaid} />
            </dd>
          </div>
          <div>
            {/* Active loans only — a closed loan's EMI is not a commitment. */}
            <dt>Monthly commitment</dt>
            <dd data-testid="monthly-commitment">
              <Amount value={totals.monthlyCommitment} />
            </dd>
          </div>
        </dl>

        <div className="pt-controls">
          <label htmlFor="liab-status">Status</label>
          <select
            id="liab-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
            }}
          >
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="CLOSED">Closed</option>
          </select>
        </div>

        {adding && (
          <NewLoanForm
            onSaved={() => void load()}
            onClose={() => {
              setAdding(false);
            }}
          />
        )}
      </Card>

      <Card title="Loans">
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="liabilities-table">
            <thead>
              <tr>
                <th scope="col">Lender</th>
                <th scope="col">Type</th>
                <th scope="col">From</th>
                <th scope="col" className="pt-align-end">EMI</th>
                <th scope="col" className="pt-align-end">Outstanding</th>
                <th scope="col" className="pt-align-end">Repaid</th>
                <th scope="col">Status</th>
                {editMode.enabled && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {register.loans.length === 0 && (
                <tr>
                  <td colSpan={editMode.enabled ? 8 : 7} className="pt-muted">
                    No borrowings recorded.
                  </td>
                </tr>
              )}
              {register.loans.map((loan) => {
                const isOpen = expanded === loan.loanId;
                return [
                  <tr key={loan.loanId}>
                    <td>
                      <button
                        type="button"
                        className="pt-link pt-link--inline"
                        aria-expanded={isOpen}
                        onClick={() => {
                          setExpanded(isOpen ? undefined : loan.loanId);
                        }}
                      >
                        {loan.lenderName ?? loan.lenderRef}
                      </button>
                    </td>
                    <td>{humanise(loan.kind)}</td>
                    <td>{loan.startDate}</td>
                    <td className="pt-align-end">
                      <Amount value={loan.emi} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={loan.outstanding} />
                    </td>
                    <td className="pt-align-end pt-numeric">{loan.percentRepaid}%</td>
                    <td>{humanise(loan.status)}</td>
                    {editMode.enabled && (
                      <td>
                        <DeleteControl
                          label="Delete"
                          describes={`this borrowing and every payment against it`}
                          testId={`delete-liability-${loan.loanId}`}
                          onDelete={() => api.deleteLiability(loan.loanId)}
                          onDeleted={() => void load()}
                        />
                      </td>
                    )}
                  </tr>,
                  isOpen ? (
                    <tr key={`${loan.loanId}-detail`} className="pt-table__detail">
                      <td colSpan={editMode.enabled ? 8 : 7}>
                        <dl className="pt-stats">
                          <div>
                            <dt>Instalments paid</dt>
                            <dd className="pt-numeric">
                              {loan.instalmentsPaid} of {loan.tenureMonths}
                            </dd>
                          </div>
                          <div>
                            <dt>Interest paid</dt>
                            <dd>
                              <Amount value={loan.interestPaid} />
                            </dd>
                          </div>
                          <div>
                            <dt>Principal repaid</dt>
                            <dd>
                              <Amount value={loan.principalRepaid} />
                            </dd>
                          </div>
                          <div>
                            <dt>Total interest over the term</dt>
                            <dd>
                              <Amount value={loan.totalInterest} />
                            </dd>
                          </div>
                          {loan.nextDueDate !== undefined && (
                            <div>
                              <dt>Next due</dt>
                              <dd>{loan.nextDueDate}</dd>
                            </div>
                          )}
                        </dl>

                        {!loan.isClosed && <PaymentForm loan={loan} onSaved={() => void load()} />}

                        {/*
                          The first twelve instalments, not all 240: the point is
                          to show that an early EMI is almost entirely interest,
                          and a 240-row table buries it.
                        */}
                        <h4>Schedule — first year</h4>
                        <div className="pt-table-scroll">
                          <table className="pt-table pt-table--nested">
                            <thead>
                              <tr>
                                <th scope="col">#</th>
                                <th scope="col">Due</th>
                                <th scope="col" className="pt-align-end">Payment</th>
                                <th scope="col" className="pt-align-end">Interest</th>
                                <th scope="col" className="pt-align-end">Principal</th>
                                <th scope="col" className="pt-align-end">Balance</th>
                              </tr>
                            </thead>
                            <tbody>
                              {loan.schedule.slice(0, 12).map((instalment) => (
                                <tr key={instalment.number}>
                                  <td className="pt-numeric">{instalment.number}</td>
                                  <td>{instalment.dueDate}</td>
                                  <td className="pt-align-end">
                                    <Amount value={instalment.payment} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={instalment.interest} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={instalment.principal} />
                                  </td>
                                  <td className="pt-align-end">
                                    <Amount value={instalment.closingBalance} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
