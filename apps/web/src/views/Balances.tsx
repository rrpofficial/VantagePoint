/**
 * Deposits, retirement schemes and cash (Phase 5, objectives 1 and 4).
 *
 * A separate screen from Holdings because the things on it are a different
 * shape. A holding is a quantity at a price; a fixed deposit is a balance with a
 * rate and a maturity, and the columns that make it legible — contributed,
 * interest accrued, instalments paid, matures on — have no meaning in a trade
 * table. Forcing these through `TradeForm` is exactly what left the accrual
 * engine with no caller for four milestones.
 *
 * The screen shows **contributed and interest separately**, never just a total.
 * The whole point of entering a deposit rather than a number is that the growth
 * is computed, and a single figure would hide whether it had been.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type BalanceClassOption,
  type BalanceRegister,
  type BalanceView,
} from '../api.js';
import { Amount, Card, Chip, GoToImport } from '../components/primitives.js';
import { ExportControl } from '../components/ExportControl.js';
import { useEditMode } from '../edit-mode.js';

/** Fields a kind actually uses. Showing all of them for every kind asks the
 *  user to decide which are irrelevant, which is the app's job to know. */
const SHOWS_RATE = new Set(['TERM_DEPOSIT', 'RECURRING_DEPOSIT', 'PROVIDENT_FUND']);
const SHOWS_MONTHLY = new Set(['RECURRING_DEPOSIT', 'PROVIDENT_FUND']);
const SHOWS_EMPLOYER = new Set(['PROVIDENT_FUND']);
const SHOWS_MATURITY = new Set(['TERM_DEPOSIT', 'RECURRING_DEPOSIT']);
const SHOWS_WAGE = new Set(['GRATUITY']);

function NewBalanceForm({
  classes,
  onSaved,
  onClose,
}: {
  classes: readonly BalanceClassOption[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [assetClass, setAssetClass] = useState(classes[0]?.assetClass ?? 'FIXED_DEPOSIT');
  const [label, setLabel] = useState('');
  const [institutionName, setInstitutionName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openedOn, setOpenedOn] = useState('');
  const [annualRatePct, setAnnualRatePct] = useState('');
  const [compounding, setCompounding] = useState('QUARTERLY');
  const [monthlyContribution, setMonthlyContribution] = useState('');
  const [employerContribution, setEmployerContribution] = useState('');
  const [maturityDate, setMaturityDate] = useState('');
  const [maturityValue, setMaturityValue] = useState('');
  const [lastDrawnMonthly, setLastDrawnMonthly] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const option = classes.find((entry) => entry.assetClass === assetClass);
  const kind = option?.kind ?? 'STATED_BALANCE';

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const trimmed = (value: string) => value.trim();
    const result = await api.recordBalance({
      assetClass,
      label: trimmed(label),
      openingBalance: trimmed(openingBalance).length === 0 ? '0' : trimmed(openingBalance),
      openedOn,
      ...(trimmed(institutionName).length === 0 ? {} : { institutionName: trimmed(institutionName) }),
      ...(trimmed(accountNumber).length === 0 ? {} : { accountNumber: trimmed(accountNumber) }),
      ...(trimmed(annualRatePct).length === 0 ? {} : { annualRatePct: trimmed(annualRatePct) }),
      ...(SHOWS_RATE.has(kind) ? { compounding } : {}),
      ...(trimmed(monthlyContribution).length === 0
        ? {}
        : { monthlyContribution: trimmed(monthlyContribution) }),
      ...(trimmed(employerContribution).length === 0
        ? {}
        : { employerContribution: trimmed(employerContribution) }),
      ...(maturityDate.length === 0 ? {} : { maturityDate }),
      ...(trimmed(maturityValue).length === 0 ? {} : { maturityValue: trimmed(maturityValue) }),
      ...(trimmed(lastDrawnMonthly).length === 0
        ? {}
        : { lastDrawnMonthly: trimmed(lastDrawnMonthly) }),
      ...(trimmed(notes).length === 0 ? {} : { notes: trimmed(notes) }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
    onClose();
  }, [
    assetClass,
    label,
    openingBalance,
    openedOn,
    institutionName,
    accountNumber,
    annualRatePct,
    compounding,
    kind,
    monthlyContribution,
    employerContribution,
    maturityDate,
    maturityValue,
    lastDrawnMonthly,
    notes,
    onSaved,
    onClose,
  ]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="vp-form vp-form--grid" onSubmit={onSubmit} data-testid="new-balance-form">
      <label htmlFor="bal-class">What is it</label>
      <select
        id="bal-class"
        value={assetClass}
        onChange={(event) => {
          setAssetClass(event.target.value);
        }}
      >
        {classes.map((entry) => (
          <option key={entry.assetClass} value={entry.assetClass}>
            {entry.label}
          </option>
        ))}
      </select>

      {option !== undefined && (
        <p className="vp-form__wide vp-muted" data-testid="balance-guidance">
          {option.guidance}
        </p>
      )}

      <label htmlFor="bal-label">Name</label>
      <input
        id="bal-label"
        value={label}
        onChange={(event) => {
          setLabel(event.target.value);
        }}
        placeholder="e.g. HDFC FD 7.1% 2027"
        required
      />

      <label htmlFor="bal-institution">Institution</label>
      <input
        id="bal-institution"
        value={institutionName}
        onChange={(event) => {
          setInstitutionName(event.target.value);
        }}
        placeholder="optional"
      />

      <label htmlFor="bal-account">Account number</label>
      <input
        id="bal-account"
        value={accountNumber}
        onChange={(event) => {
          setAccountNumber(event.target.value);
        }}
        placeholder="optional — stored only as an opaque reference"
      />

      <label htmlFor="bal-balance">
        {kind === 'GRATUITY' ? 'Balance (not used for gratuity)' : 'Balance'}
      </label>
      <input
        id="bal-balance"
        value={openingBalance}
        onChange={(event) => {
          setOpeningBalance(event.target.value);
        }}
        placeholder="e.g. 5,00,000"
        inputMode="decimal"
      />

      <label htmlFor="bal-opened">
        {kind === 'GRATUITY' ? 'Service began on' : 'True as at'}
      </label>
      <input
        id="bal-opened"
        type="date"
        value={openedOn}
        onChange={(event) => {
          setOpenedOn(event.target.value);
        }}
        required
      />

      {SHOWS_RATE.has(kind) && (
        <>
          <label htmlFor="bal-rate">Interest rate %</label>
          <input
            id="bal-rate"
            value={annualRatePct}
            onChange={(event) => {
              setAnnualRatePct(event.target.value);
            }}
            placeholder="leave blank to carry it flat"
            inputMode="decimal"
          />

          <label htmlFor="bal-compounding">Compounding</label>
          <select
            id="bal-compounding"
            value={compounding}
            onChange={(event) => {
              setCompounding(event.target.value);
            }}
          >
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="ANNUAL">Annual</option>
          </select>
        </>
      )}

      {SHOWS_MONTHLY.has(kind) && (
        <>
          <label htmlFor="bal-monthly">
            {kind === 'PROVIDENT_FUND' ? 'Your monthly contribution' : 'Monthly instalment'}
          </label>
          <input
            id="bal-monthly"
            value={monthlyContribution}
            onChange={(event) => {
              setMonthlyContribution(event.target.value);
            }}
            inputMode="decimal"
            required={kind === 'RECURRING_DEPOSIT'}
          />
        </>
      )}

      {SHOWS_EMPLOYER.has(kind) && (
        <>
          <label htmlFor="bal-employer">Employer&rsquo;s monthly contribution</label>
          <input
            id="bal-employer"
            value={employerContribution}
            onChange={(event) => {
              setEmployerContribution(event.target.value);
            }}
            inputMode="decimal"
          />
        </>
      )}

      {SHOWS_MATURITY.has(kind) && (
        <>
          <label htmlFor="bal-maturity">Matures on</label>
          <input
            id="bal-maturity"
            type="date"
            value={maturityDate}
            onChange={(event) => {
              setMaturityDate(event.target.value);
            }}
          />

          <label htmlFor="bal-maturity-value">Maturity amount</label>
          <input
            id="bal-maturity-value"
            value={maturityValue}
            onChange={(event) => {
              setMaturityValue(event.target.value);
            }}
            placeholder="from the certificate — preferred once it matures"
            inputMode="decimal"
          />
        </>
      )}

      {SHOWS_WAGE.has(kind) && (
        <>
          <label htmlFor="bal-wage">Last drawn monthly wage</label>
          <input
            id="bal-wage"
            value={lastDrawnMonthly}
            onChange={(event) => {
              setLastDrawnMonthly(event.target.value);
            }}
            inputMode="decimal"
            required
          />
        </>
      )}

      <label htmlFor="bal-notes">Notes</label>
      <input
        id="bal-notes"
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
        }}
      />

      <div className="vp-actions vp-form__wide">
        <button type="submit" disabled={busy} data-testid="save-balance">
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="vp-button-inline" onClick={onClose}>
          Cancel
        </button>
      </div>

      {error !== undefined && (
        <p className="vp-error vp-form__wide" role="alert" data-testid="balance-error">
          {error}
        </p>
      )}
    </form>
  );
}

function Row({ view, onChanged }: { view: BalanceView; onChanged: () => void }) {
  const editMode = useEditMode();
  const [restating, setRestating] = useState(false);
  const [amount, setAmount] = useState('');
  const [asOf, setAsOf] = useState(view.asOf);
  const [error, setError] = useState<string | undefined>();

  const submit = useCallback(async (): Promise<void> => {
    setError(undefined);
    const result = await api.restateBalance(view.account.assetId, {
      openingBalance: amount.trim(),
      asOf,
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setRestating(false);
    setAmount('');
    onChanged();
  }, [amount, asOf, view.account.assetId, onChanged]);

  return (
    <>
      <tr data-testid="balance-row">
        <td>
          <strong>{view.account.label}</strong>
          {view.account.institutionName !== undefined && (
            <div className="vp-muted">{view.account.institutionName}</div>
          )}
        </td>
        <td className="vp-numeric">{view.account.openedOn}</td>
        <td className="vp-numeric">
          {view.account.annualRatePct === undefined ? '—' : `${view.account.annualRatePct}%`}
        </td>
        <td className="vp-numeric">
          <Amount value={view.contributed} />
        </td>
        <td className="vp-numeric">
          <Amount value={view.accruedInterest} />
        </td>
        <td className="vp-numeric">
          <Amount value={view.value} />
        </td>
        <td>
          {view.closed ? (
            <Chip>Closed</Chip>
          ) : view.matured ? (
            <Chip>Matured</Chip>
          ) : (
            <Chip>Open</Chip>
          )}
          {editMode.enabled && !view.closed && (
            <button
              type="button"
              className="vp-button-inline"
              data-testid="restate-balance"
              onClick={() => {
                setRestating((open) => !open);
              }}
            >
              Restate
            </button>
          )}
        </td>
      </tr>

      {/* Stated, not left to be inferred from a figure that has not moved. */}
      {view.flatReason !== undefined && (
        <tr>
          <td colSpan={7} className="vp-muted" data-testid="balance-flat-reason">
            {view.flatReason}
          </td>
        </tr>
      )}

      {restating && (
        <tr>
          <td colSpan={7}>
            <div className="vp-form vp-form--grid">
              <label htmlFor={`restate-amount-${view.account.assetId}`}>New balance</label>
              <input
                id={`restate-amount-${view.account.assetId}`}
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
                inputMode="decimal"
              />
              <label htmlFor={`restate-date-${view.account.assetId}`}>True as at</label>
              <input
                id={`restate-date-${view.account.assetId}`}
                type="date"
                value={asOf}
                onChange={(event) => {
                  setAsOf(event.target.value);
                }}
              />
              <div className="vp-actions vp-form__wide">
                <button type="button" onClick={() => void submit()}>
                  Restate
                </button>
              </div>
              <p className="vp-muted vp-form__wide">
                Accrual restarts from this date. A new figure with the old start date would
                re-accrue interest that is already inside it.
              </p>
              {error !== undefined && (
                <p className="vp-error vp-form__wide" role="alert">
                  {error}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function Balances() {
  const [register, setRegister] = useState<BalanceRegister | undefined>();
  const [classes, setClasses] = useState<readonly BalanceClassOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    const [list, options] = await Promise.all([api.balances(), api.balanceClasses()]);
    if (list.ok) setRegister(list.value);
    else setError(list.error.message);
    if (options.ok) setClasses(options.value.classes);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = register?.totals;

  return (
    <div className="vp-stack">
      <Card
        title="Deposits, retirement and cash"
        action={
          <div className="vp-actions">
            <button
              type="button"
              className="vp-button-inline"
              data-testid="add-balance"
              onClick={() => {
                setAdding((open) => !open);
              }}
            >
              {adding ? 'Close' : 'Add an account'}
            </button>
            <GoToImport testId="balances-go-to-import" />
            {/* Account numbers are already opaque references by the time they
                reach the vault, so there is nothing further to mask. */}
            <ExportControl register="balances" hasPii={false} />
          </div>
        }
      >
        <p className="vp-muted">
          Fixed and recurring deposits, EPF, VPF, PPF, NPS, gratuity, bank balances and cash. These
          grow without any trade being recorded — a deposit accrues between two valuations on its
          own rate, which is the whole reason they are entered here rather than as a number.
        </p>
        <p className="vp-muted">
          Gold and crypto are <strong>not</strong> here. They are quantities bought at a price and
          sold FIFO, so they are recorded as trades under Non-equity.
        </p>

        {adding && (
          <NewBalanceForm
            classes={classes}
            onSaved={() => void load()}
            onClose={() => {
              setAdding(false);
            }}
          />
        )}
      </Card>

      <Card
        title="Accounts"
        action={<Chip>{`${String(register?.accounts.length ?? 0)} shown`}</Chip>}
      >
        {error !== undefined && (
          <p className="vp-error" role="alert" data-testid="balances-error">
            {error}
          </p>
        )}

        {register !== undefined && register.accounts.length === 0 ? (
          <p className="vp-muted" data-testid="balances-empty">
            Nothing recorded yet. Add a deposit or a balance above, or import a batch.
          </p>
        ) : (
          <div className="vp-table-scroll">
            <table className="vp-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="vp-numeric">From</th>
                  <th className="vp-numeric">Rate</th>
                  <th className="vp-numeric">Contributed</th>
                  <th className="vp-numeric">Interest</th>
                  <th className="vp-numeric">Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(register?.accounts ?? []).map((view) => (
                  <Row key={view.account.assetId} view={view} onChanged={() => void load()} />
                ))}
              </tbody>
              {totals !== undefined && (
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      <strong>{`${String(totals.openCount)} open`}</strong>
                    </td>
                    <td className="vp-numeric">
                      <Amount value={totals.totalContributed} />
                    </td>
                    <td className="vp-numeric">
                      <Amount value={totals.totalAccruedInterest} />
                    </td>
                    <td className="vp-numeric">
                      <Amount value={totals.totalValue} />
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
