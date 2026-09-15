/**
 * Chits — the chit-fund register (US-1.12).
 *
 * The tiles lead with **what is still an asset**, not with the total of every
 * chit's face value. A chit is named after its pot — "5L", "10L" — and that
 * number is the one thing on the screen that must never be mistaken for what it
 * is worth. What it is worth is what has been paid into it, and nothing once the
 * pot has been drawn.
 *
 * Every figure is computed by the API. Summing decimal strings here would
 * reintroduce the float drift ADR-002 exists to prevent, and these are amounts
 * a holder reconciles against a passbook.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type ChitEmiType,
  type ChitRegister,
  type ChitStatus,
  type ChitView,
  type ChitWithdrawalSchedule,
  type PaymentMode,
} from '../api.js';
import { Amount, Card, Chip, GoToImport } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { EditModeHint, useEditMode } from '../edit-mode.js';

const STATUSES: readonly { readonly value: ChitStatus; readonly label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
];

const STATUS_LABEL: Readonly<Record<ChitStatus, string>> = {
  ACTIVE: 'Active',
  WITHDRAWN: 'Withdrawn',
};

const MODES: readonly PaymentMode[] = ['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'OTHER'];

const SORTABLE: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'startDate', label: 'Start date' },
  { key: 'label', label: 'Chit' },
  { key: 'org', label: 'Organisation' },
  { key: 'targetAmount', label: 'Chit amount' },
  { key: 'paidToDate', label: 'Paid in' },
  { key: 'status', label: 'Status' },
];

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const today = () => new Date().toISOString().slice(0, 10);

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

export function Chits() {
  const [register, setRegister] = useState<ChitRegister | undefined>();
  const [schedules, setSchedules] = useState<readonly ChitWithdrawalSchedule[]>([]);
  const [statuses, setStatuses] = useState<readonly ChitStatus[]>([]);
  const [orgs, setOrgs] = useState<readonly string[]>([]);
  const [sortBy, setSortBy] = useState('startDate');
  const [direction, setDirection] = useState<'ASC' | 'DESC'>('DESC');
  const [expanded, setExpanded] = useState<string | undefined>();
  const [showNew, setShowNew] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    const [result, scheduleResult] = await Promise.all([
      api.chits({
        ...(statuses.length === 0 ? {} : { statuses }),
        ...(orgs.length === 0 ? {} : { orgs }),
        sortBy,
        direction,
      }),
      api.chitSchedules(),
    ]);
    if (result.ok) {
      setRegister(result.value);
      setError(undefined);
    } else setError(result.error.message);
    if (scheduleResult.ok) setSchedules(scheduleResult.value.schedules);
  }, [statuses, orgs, sortBy, direction]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = (status: ChitStatus): void => {
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  };

  const totals = register?.totals;

  return (
    <div className="pt-stack">
      <Card
        title="Chit funds"
        action={
          <div className="pt-actions pt-actions--inline">
            <button
              type="button"
              className="pt-button-inline"
              onClick={() => {
                setShowNew((open) => !open);
              }}
            >
              {showNew ? 'Cancel' : 'Record a chit'}
            </button>
            <GoToImport testId="go-to-import-chits" />
          </div>
        }
      >
        <div className="pt-tiles" data-testid="chit-tiles">
          <Tile
            testId="chit-carrying"
            label="Counted in net worth"
            value={INR.format(Number(totals?.activeCarryingValue.amount ?? '0'))}
            hint="Active chits, at instalments paid in"
          />
          <Tile
            testId="chit-paid"
            label="Paid in, all chits"
            value={INR.format(Number(totals?.totalPaid.amount ?? '0'))}
            hint="Including chits already drawn"
          />
          <Tile
            testId="chit-target"
            label="Chit value committed"
            value={INR.format(Number(totals?.totalTarget.amount ?? '0'))}
            hint="What the pots are worth — not an asset figure"
          />
          <Tile
            testId="chit-withdrawn"
            label="Drawn to date"
            value={INR.format(Number(totals?.totalWithdrawn.amount ?? '0'))}
            hint={`${String(totals?.withdrawnCount ?? 0)} of ${String(totals?.chitCount ?? 0)} drawn`}
          />
        </div>

        <p className="pt-muted">
          A chit is carried at what has been <strong>paid into it</strong>, not at the amount it is
          named after. Once you draw the pot the money is in your bank account and counted there, so
          the chit stops contributing to net worth — while the instalments carry on.
        </p>

        {showNew && (
          <NewChitForm
            schedules={schedules}
            onSaved={() => void load()}
            onClose={() => {
              setShowNew(false);
            }}
          />
        )}
      </Card>

      <Card
        title="Withdrawal schedules"
        action={
          <button
            type="button"
            className="pt-button-inline"
            onClick={() => {
              setShowSchedules((open) => !open);
            }}
          >
            {showSchedules ? 'Hide' : `${String(schedules.length)} set up`}
          </button>
        }
      >
        <p className="pt-muted">
          What the chit company pays out for a draw in a given month, agreed up front for a
          fixed-instalment chit. Set one up once and every chit of that shape can point at it.
        </p>
        {showSchedules && (
          <ScheduleEditor
            schedules={schedules}
            onSaved={() => void load()}
          />
        )}
      </Card>

      <Card title="Register" action={<Chip>{`${String(totals?.chitCount ?? 0)} chits`}</Chip>}>
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

          <label htmlFor="chit-org">Organisation</label>
          <select
            id="chit-org"
            value={orgs[0] ?? ''}
            onChange={(event) => {
              setOrgs(event.target.value === '' ? [] : [event.target.value]);
            }}
          >
            <option value="">All organisations</option>
            {(register?.orgs ?? []).map((org) => (
              <option key={org} value={org}>
                {org}
              </option>
            ))}
          </select>

          <label htmlFor="chit-sort">Sort by</label>
          <select
            id="chit-sort"
            value={sortBy}
            onChange={(event) => {
              setSortBy(event.target.value);
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
            className="pt-button-inline"
            onClick={() => {
              setDirection((current) => (current === 'ASC' ? 'DESC' : 'ASC'));
            }}
          >
            {direction === 'ASC' ? 'Ascending' : 'Descending'}
          </button>
        </div>

        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}

        {register !== undefined && register.chits.length === 0 ? (
          <p className="pt-muted" data-testid="chit-empty">
            No chits match. Record one above, or clear the filters.
          </p>
        ) : (
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="chit-table">
              <thead>
                <tr>
                  <th scope="col">Chit</th>
                  <th scope="col">Organisation</th>
                  <th scope="col">Started</th>
                  <th scope="col">Term</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="pt-align-end">Chit amount</th>
                  <th scope="col" className="pt-align-end">Paid in</th>
                  <th scope="col" className="pt-align-end">Counted as asset</th>
                </tr>
              </thead>
              <tbody>
                {(register?.chits ?? []).map((chit) => (
                  <ChitRow
                    key={chit.assetId}
                    chit={chit}
                    schedules={schedules}
                    expanded={expanded === chit.assetId}
                    onToggle={() => {
                      setExpanded(expanded === chit.assetId ? undefined : chit.assetId);
                    }}
                    onChanged={() => void load()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ChitRow({
  chit,
  schedules,
  expanded,
  onToggle,
  onChanged,
}: {
  chit: ChitView;
  schedules: readonly ChitWithdrawalSchedule[];
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className="pt-link pt-link--inline"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {chit.label}
          </button>
        </td>
        <td>{chit.org}</td>
        <td>{chit.startDate}</td>
        <td className="pt-numeric">
          {chit.monthsElapsed} / {chit.durationMonths}
        </td>
        <td>
          <span className={`pt-status pt-status--${chit.status.toLowerCase()}`}>
            {STATUS_LABEL[chit.status]}
          </span>
        </td>
        <td className="pt-align-end">
          <Amount value={chit.targetAmount} />
        </td>
        <td className="pt-align-end">
          <Amount value={chit.paidToDate} />
        </td>
        <td className="pt-align-end">
          {/* Zero for a drawn chit, and that is the headline of this row. */}
          <Amount value={chit.carryingValue} />
        </td>
      </tr>
      {expanded && (
        <tr className="pt-table__detail">
          <td colSpan={8}>
            <ChitDetail chit={chit} schedules={schedules} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function ChitDetail({
  chit,
  schedules,
  onChanged,
}: {
  chit: ChitView;
  schedules: readonly ChitWithdrawalSchedule[];
  onChanged: () => void;
}) {
  const editMode = useEditMode();
  const [editing, setEditing] = useState(false);

  return (
    <div className="pt-stack" data-testid={`chit-detail-${chit.assetId}`}>
      <dl className="pt-stats">
        <div>
          <dt>Still to pay</dt>
          <dd>
            <Amount value={chit.remainingCommitment} />
          </dd>
        </div>
        <div>
          <dt>Months remaining</dt>
          <dd className="pt-numeric">{chit.monthsRemaining}</dd>
        </div>
        <div>
          <dt>Instalments recorded</dt>
          <dd className="pt-numeric">{chit.emiCount}</dd>
        </div>
        <div>
          <dt>Instalment type</dt>
          <dd>{chit.emiType === 'CONSTANT' ? 'Constant' : 'Varying'}</dd>
        </div>
        {chit.expectedWithdrawal !== undefined && (
          <div>
            <dt>If drawn this month</dt>
            <dd data-testid="chit-expected-withdrawal">
              <Amount value={chit.expectedWithdrawal} />
            </dd>
          </div>
        )}
        {chit.withdrawnAmount !== undefined && (
          <div>
            <dt>Drawn</dt>
            <dd>
              <Amount value={chit.withdrawnAmount} /> on {chit.withdrawnDate}
            </dd>
          </div>
        )}
      </dl>

      {chit.comments !== undefined && chit.comments.length > 0 && (
        <p className="pt-muted">{chit.comments}</p>
      )}

      {/*
        Recording an instalment stays below whatever this shows: paying into a
        chit is the monthly routine, and gating it would make the mode something
        the user leaves permanently on — which is the opposite of the intent.
      */}
      {editMode.enabled ? (
        <div className="pt-actions">
          <button
            type="button"
            className="pt-button-inline"
            data-testid={`chit-edit-toggle-${chit.assetId}`}
            onClick={() => {
              setEditing((open) => !open);
            }}
          >
            {editing ? 'Cancel edit' : 'Edit chit'}
          </button>
          <DeleteControl
            label="Delete chit"
            describes={`the chit "${chit.label}" with ${chit.org}, and its ${String(chit.emiCount)} recorded instalment(s)`}
            testId={`delete-chit-${chit.assetId}`}
            onDelete={() => api.deleteChit(chit.assetId)}
            onDeleted={onChanged}
          />
        </div>
      ) : (
        <EditModeHint action="edit or delete this chit" />
      )}

      {editing && (
        <EditChitForm
          chit={chit}
          schedules={schedules}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}

      <h4 className="pt-subhead">Instalments paid</h4>
      <div className="pt-table-scroll">
        <table className="pt-table" data-testid={`chit-emis-${chit.assetId}`}>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="pt-align-end">Amount</th>
              <th scope="col">Mode</th>
              <th scope="col">Paid to</th>
              <th scope="col">Comments</th>
            </tr>
          </thead>
          <tbody>
            {chit.emis.length === 0 && (
              <tr>
                <td colSpan={5} className="pt-muted">
                  No instalments recorded yet.
                </td>
              </tr>
            )}
            {chit.emis.map((instalment) => (
              <tr key={instalment.emiId}>
                <td>{instalment.date}</td>
                <td className="pt-align-end">
                  <Amount value={instalment.amount} />
                </td>
                <td>{instalment.mode.replaceAll('_', ' ').toLowerCase()}</td>
                <td>{instalment.paidTo}</td>
                <td>{instalment.comments ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pt-grid">
        <EmiForm chit={chit} onDone={onChanged} />
        <StatusForm chit={chit} onDone={onChanged} />
      </div>
    </div>
  );
}

function EmiForm({ chit, onDone }: { chit: ChitView; onDone: () => void }) {
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('BANK_TRANSFER');
  const [paidTo, setPaidTo] = useState(chit.org);
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.recordChitEmi(chit.assetId, {
      date,
      amount: { amount: amount.trim(), currency: chit.targetAmount.currency },
      mode,
      paidTo: paidTo.trim(),
      ...(comments.trim().length === 0 ? {} : { comments: comments.trim() }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setAmount('');
    setComments('');
    onDone();
  }, [chit, date, amount, mode, paidTo, comments, onDone]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form
      className="pt-form"
      onSubmit={onSubmit}
      data-testid={`chit-emi-form-${chit.assetId}`}
    >
      <h4 className="pt-subhead">Record an instalment</h4>
      {chit.status === 'WITHDRAWN' && (
        <p className="pt-muted">
          This chit has been drawn. Instalments continue to the end of the term, so they are still
          recorded here — they just no longer add to net worth.
        </p>
      )}
      <label htmlFor={`emi-date-${chit.assetId}`}>Date</label>
      <input
        id={`emi-date-${chit.assetId}`}
        type="date"
        value={date}
        onChange={(event) => {
          setDate(event.target.value);
        }}
      />
      <label htmlFor={`emi-amount-${chit.assetId}`}>Amount</label>
      <input
        id={`emi-amount-${chit.assetId}`}
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
        }}
      />
      <label htmlFor={`emi-mode-${chit.assetId}`}>Mode</label>
      <select
        id={`emi-mode-${chit.assetId}`}
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
      <label htmlFor={`emi-paidto-${chit.assetId}`}>Paid to</label>
      <input
        id={`emi-paidto-${chit.assetId}`}
        type="text"
        value={paidTo}
        onChange={(event) => {
          setPaidTo(event.target.value);
        }}
      />
      <label htmlFor={`emi-comments-${chit.assetId}`}>Comments</label>
      <input
        id={`emi-comments-${chit.assetId}`}
        type="text"
        value={comments}
        onChange={(event) => {
          setComments(event.target.value);
        }}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Recording…' : 'Record instalment'}
      </button>
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function StatusForm({ chit, onDone }: { chit: ChitView; onDone: () => void }) {
  const editMode = useEditMode();
  const [date, setDate] = useState(chit.withdrawnDate ?? today());
  const [amount, setAmount] = useState(chit.withdrawnAmount?.amount ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const apply = useCallback(
    async (status: ChitStatus): Promise<void> => {
      setBusy(true);
      setError(undefined);
      const result = await api.setChitStatus(chit.assetId, {
        status,
        ...(status === 'WITHDRAWN'
          ? { date, amount: { amount: amount.trim(), currency: chit.targetAmount.currency } }
          : {}),
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onDone();
    },
    [chit, date, amount, onDone],
  );

  return (
    <div className="pt-form" data-testid={`chit-status-form-${chit.assetId}`}>
      <h4 className="pt-subhead">Status</h4>
      {/*
        Gated with the edits, not with the instalments. A draw moves the chit off
        the asset side entirely — net worth changes the moment it is recorded —
        so it is a change to what this chit IS, not another payment into it.
      */}
      {!editMode.enabled ? (
        <EditModeHint action="change this chit’s status" />
      ) : chit.status === 'ACTIVE' ? (
        <>
          <p className="pt-muted">
            Marking this drawn removes it from net worth: the pot becomes cash you hold elsewhere,
            and counting both would be counting the same money twice.
          </p>
          <label htmlFor={`wd-date-${chit.assetId}`}>Date drawn</label>
          <input
            id={`wd-date-${chit.assetId}`}
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
          <label htmlFor={`wd-amount-${chit.assetId}`}>Amount received</label>
          <input
            id={`wd-amount-${chit.assetId}`}
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          <button
            type="button"
            disabled={busy}
            data-testid={`chit-withdraw-${chit.assetId}`}
            onClick={() => void apply('WITHDRAWN')}
          >
            {busy ? 'Saving…' : 'Mark as withdrawn'}
          </button>
        </>
      ) : (
        <>
          <p className="pt-muted">
            Drawn on {chit.withdrawnDate}. Putting it back to active returns the instalments paid to
            net worth — use this if the draw was recorded in error.
          </p>
          <button
            type="button"
            disabled={busy}
            data-testid={`chit-reactivate-${chit.assetId}`}
            onClick={() => void apply('ACTIVE')}
          >
            {busy ? 'Saving…' : 'Put back to active'}
          </button>
        </>
      )}
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shared by the new-chit and edit-chit forms — the same fields either way. */
function ChitFields({
  org,
  setOrg,
  label,
  setLabel,
  target,
  setTarget,
  startDate,
  setStartDate,
  months,
  setMonths,
  emiType,
  setEmiType,
  scheduleLabel,
  setScheduleLabel,
  comments,
  setComments,
  schedules,
  idPrefix,
}: {
  org: string;
  setOrg: (value: string) => void;
  label: string;
  setLabel: (value: string) => void;
  target: string;
  setTarget: (value: string) => void;
  startDate: string;
  setStartDate: (value: string) => void;
  months: string;
  setMonths: (value: string) => void;
  emiType: ChitEmiType;
  setEmiType: (value: ChitEmiType) => void;
  scheduleLabel: string;
  setScheduleLabel: (value: string) => void;
  comments: string;
  setComments: (value: string) => void;
  schedules: readonly ChitWithdrawalSchedule[];
  idPrefix: string;
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-org`}>Chit fund organisation</label>
        <input
          id={`${idPrefix}-org`}
          type="text"
          value={org}
          onChange={(event) => {
            setOrg(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-label`}>Chit label</label>
        <input
          id={`${idPrefix}-label`}
          type="text"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-target`}>Chit amount</label>
        <input
          id={`${idPrefix}-target`}
          type="text"
          inputMode="decimal"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-start`}>Start date</label>
        <input
          id={`${idPrefix}-start`}
          type="date"
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-months`}>Duration in months</label>
        <input
          id={`${idPrefix}-months`}
          type="text"
          inputMode="numeric"
          value={months}
          onChange={(event) => {
            setMonths(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-emitype`}>Instalment</label>
        <select
          id={`${idPrefix}-emitype`}
          value={emiType}
          onChange={(event) => {
            setEmiType(event.target.value as ChitEmiType);
          }}
        >
          <option value="CONSTANT">Constant every month</option>
          <option value="VARYING">Varying</option>
        </select>
      </div>
      {/*
        Only a constant-instalment chit has an agreed payout table. Offering the
        selector for a varying chit would imply a figure nobody promised.
      */}
      {emiType === 'CONSTANT' && (
        <div>
          <label htmlFor={`${idPrefix}-schedule`}>Withdrawal schedule</label>
          <select
            id={`${idPrefix}-schedule`}
            value={scheduleLabel}
            onChange={(event) => {
              setScheduleLabel(event.target.value);
            }}
          >
            <option value="">None</option>
            {schedules.map((schedule) => (
              <option key={schedule.label} value={schedule.label}>
                {schedule.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="pt-form__wide">
        <label htmlFor={`${idPrefix}-comments`}>Comments</label>
        <input
          id={`${idPrefix}-comments`}
          type="text"
          value={comments}
          onChange={(event) => {
            setComments(event.target.value);
          }}
        />
      </div>
    </>
  );
}

function NewChitForm({
  schedules,
  onSaved,
  onClose,
}: {
  schedules: readonly ChitWithdrawalSchedule[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [org, setOrg] = useState('');
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [months, setMonths] = useState('25');
  const [emiType, setEmiType] = useState<ChitEmiType>('CONSTANT');
  const [scheduleLabel, setScheduleLabel] = useState('');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.openChit({
      org: org.trim(),
      label: label.trim(),
      targetAmount: { amount: target.trim(), currency: 'INR' },
      startDate,
      durationMonths: Number(months),
      emiType,
      ...(scheduleLabel.length === 0 || emiType !== 'CONSTANT' ? {} : { scheduleLabel }),
      ...(comments.trim().length === 0 ? {} : { comments: comments.trim() }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
    onClose();
  }, [org, label, target, startDate, months, emiType, scheduleLabel, comments, onSaved, onClose]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="pt-form pt-form--grid" onSubmit={onSubmit} data-testid="new-chit-form">
      <ChitFields
        org={org}
        setOrg={setOrg}
        label={label}
        setLabel={setLabel}
        target={target}
        setTarget={setTarget}
        startDate={startDate}
        setStartDate={setStartDate}
        months={months}
        setMonths={setMonths}
        emiType={emiType}
        setEmiType={setEmiType}
        scheduleLabel={scheduleLabel}
        setScheduleLabel={setScheduleLabel}
        comments={comments}
        setComments={setComments}
        schedules={schedules}
        idPrefix="new-chit"
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save chit'}
      </button>
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function EditChitForm({
  chit,
  schedules,
  onSaved,
}: {
  chit: ChitView;
  schedules: readonly ChitWithdrawalSchedule[];
  onSaved: () => void;
}) {
  const [org, setOrg] = useState(chit.org);
  const [label, setLabel] = useState(chit.label);
  const [target, setTarget] = useState(chit.targetAmount.amount);
  const [startDate, setStartDate] = useState(chit.startDate);
  const [months, setMonths] = useState(String(chit.durationMonths));
  const [emiType, setEmiType] = useState<ChitEmiType>(chit.emiType);
  const [scheduleLabel, setScheduleLabel] = useState(chit.scheduleLabel ?? '');
  const [comments, setComments] = useState(chit.comments ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.editChit(chit.assetId, {
      org: org.trim(),
      label: label.trim(),
      targetAmount: { amount: target.trim(), currency: chit.targetAmount.currency },
      startDate,
      durationMonths: Number(months),
      emiType,
      scheduleLabel: emiType === 'CONSTANT' && scheduleLabel.length > 0 ? scheduleLabel : null,
      comments,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
  }, [chit, org, label, target, startDate, months, emiType, scheduleLabel, comments, onSaved]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form
      className="pt-form pt-form--grid"
      onSubmit={onSubmit}
      data-testid={`edit-chit-form-${chit.assetId}`}
    >
      <ChitFields
        org={org}
        setOrg={setOrg}
        label={label}
        setLabel={setLabel}
        target={target}
        setTarget={setTarget}
        startDate={startDate}
        setStartDate={setStartDate}
        months={months}
        setMonths={setMonths}
        emiType={emiType}
        setEmiType={setEmiType}
        scheduleLabel={scheduleLabel}
        setScheduleLabel={setScheduleLabel}
        comments={comments}
        setComments={setComments}
        schedules={schedules}
        idPrefix={`edit-chit-${chit.assetId}`}
      />
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

/**
 * The agreed payout table, entered as "month → amount" pairs.
 *
 * Saving replaces every row: a schedule is one agreed table, and a stale month
 * left behind would show a payout figure matching no agreement anyone made.
 */
function ScheduleEditor({
  schedules,
  onSaved,
}: {
  schedules: readonly ChitWithdrawalSchedule[];
  onSaved: () => void;
}) {
  const editMode = useEditMode();
  const [label, setLabel] = useState('');
  const [rows, setRows] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const overwrites = schedules.some((schedule) => schedule.label === label.trim());

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    const parsed: { month: number; amount: { amount: string; currency: string } }[] = [];
    for (const line of rows.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const [month, amount] = trimmed.split(/[,:]/).map((part) => part.trim());
      if (month === undefined || amount === undefined) {
        setBusy(false);
        setError(`could not read "${trimmed}" — write one line per month, as "12, 440000"`);
        return;
      }
      parsed.push({ month: Number(month), amount: { amount, currency: 'INR' } });
    }

    const result = await api.saveChitSchedule({ label: label.trim(), rows: parsed });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setLabel('');
    setRows('');
    onSaved();
  }, [label, rows, onSaved]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <div className="pt-stack">
      {schedules.length > 0 && (
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="chit-schedule-table">
            <thead>
              <tr>
                <th scope="col">Schedule</th>
                <th scope="col">Months covered</th>
                <th scope="col">Payouts</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.label}>
                  <td>
                    <strong>{schedule.label}</strong>
                  </td>
                  <td className="pt-numeric">{schedule.rows.length}</td>
                  <td className="pt-hash">
                    {schedule.rows
                      .map((row) => `m${String(row.month)}: ${row.amount.amount}`)
                      .join(' · ')}
                  </td>
                  <td>
                    <DeleteControl
                      label="Delete"
                      describes={`the "${schedule.label}" withdrawal schedule`}
                      testId={`delete-schedule-${schedule.label}`}
                      onDelete={() => api.deleteChitSchedule(schedule.label)}
                      onDeleted={onSaved}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="pt-form" onSubmit={onSubmit} data-testid="chit-schedule-form">
        <label htmlFor="schedule-label">Schedule label</label>
        <input
          id="schedule-label"
          type="text"
          placeholder="5L / 25 months"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
        <label htmlFor="schedule-rows">Month and payout, one per line</label>
        <textarea
          id="schedule-rows"
          rows={5}
          placeholder={'1, 350000\n9, 420000\n25, 500000'}
          value={rows}
          onChange={(event) => {
            setRows(event.target.value);
          }}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save schedule'}
        </button>
        {/*
          Warned rather than blocked. Saving under a new label is an ordinary
          addition; reusing an existing one replaces that schedule's rows for
          every chit pointing at it, which is a change to existing records and is
          refused unless edit mode is on. Saying so before the submit is better
          than a 403 the user has to interpret.
        */}
        {overwrites && (
          <p className="pt-muted" data-testid="schedule-overwrite-warning">
            <strong>&quot;{label.trim()}&quot; already exists.</strong> Saving replaces its rows for
            every chit that uses it
            {editMode.enabled ? '.' : ', which needs edit mode — turn it on under Settings.'}
          </p>
        )}
        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
