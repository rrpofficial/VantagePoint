/**
 * Tax — advance tax instalments, regime comparison and the income behind them.
 *
 * Every figure here carries the provisional banner. The rule set this build
 * ships is unverified, and a tax number that cannot be filed must never look
 * like one that can.
 *
 * The "no income recorded" state is shown explicitly beside any nil figure:
 * ₹0 payable computed from a missing Form 16 is not the same answer as ₹0
 * payable computed from a real one, and the user is the only one who can tell
 * the difference.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type AdvanceTaxInstallment,
  type AdvanceTaxPayment,
  type RegimeComparison,
  type DerivedOtherSources,
} from '../api.js';
import { Amount, Card, Chip, ProvisionalBanner } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { EditModeHint, useEditMode } from '../edit-mode.js';
import { financialYearLabel, usePeriods } from '../usePeriods.js';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

const INCOME_FIELDS = [
  ['grossSalary', 'Gross salary'],
  ['exemptAllowances', 'Exempt allowances'],
  ['chapterViaDeductions', 'Chapter VI-A deductions'],
  ['housePropertyIncome', 'House property income'],
  ['otherSourcesIncome', 'Other sources income'],
  ['tdsRemitted', 'TDS already remitted'],
] as const;

export function Tax() {
  const editMode = useEditMode();
  const periods = usePeriods();
  // Empty until the server says what year it is, then defaulted to the current
  // one. Hardcoding a starting year meant the picker silently went stale every
  // April, offering a year the user had already finished filing for.
  const [financialYear, setFinancialYear] = useState<string>('');
  const [quarter, setQuarter] = useState<string>('Q1');
  const [installment, setInstallment] = useState<AdvanceTaxInstallment | undefined>();
  const [regimes, setRegimes] = useState<RegimeComparison | undefined>();
  const [hasProfile, setHasProfile] = useState(false);
  const [income, setIncome] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const loadProfile = useCallback(async (): Promise<void> => {
    const result = await api.incomeProfile();
    if (result.ok) setHasProfile(result.value.present);
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (periods !== undefined && financialYear === '') {
      setFinancialYear(periods.defaultFinancialYear);
    }
  }, [periods, financialYear]);

  const compute = useCallback(async (): Promise<void> => {
    setError(undefined);
    const [advance, comparison] = await Promise.all([
      api.advanceTax(financialYear, quarter),
      api.regimes(financialYear),
    ]);

    if (advance.ok) setInstallment(advance.value);
    else {
      setInstallment(undefined);
      setError(advance.error.message);
    }
    if (comparison.ok) {
      setRegimes(comparison.value);
      setHasProfile(comparison.value.hasIncomeProfile);
    }
  }, [financialYear, quarter]);

  const selectedYear = periods?.financialYears.find(
    (option) => option.financialYear === financialYear,
  );

  const saveIncome = useCallback(async (): Promise<void> => {
    setError(undefined);
    const zero = { amount: '0', currency: 'INR' };
    const money = (key: string) => ({ amount: income[key] ?? '0', currency: 'INR' });

    const result = await api.saveIncomeProfile({
      financialYear,
      // FY + 1, from the server. Repeating the FY here labelled the profile with
      // the wrong assessment year, which is what a return is actually filed under.
      assessmentYear: selectedYear?.assessmentYear ?? financialYear,
      grossSalary: money('grossSalary'),
      exemptAllowances: money('exemptAllowances'),
      chapterViaDeductions: money('chapterViaDeductions'),
      housePropertyIncome: money('housePropertyIncome'),
      otherSourcesIncome: money('otherSourcesIncome'),
      tdsRemitted: money('tdsRemitted'),
      tcsCollected: zero,
    });

    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSaved(true);
    setHasProfile(true);
    await compute();
  }, [financialYear, selectedYear, income, compute]);

  function onSubmitIncome(event: SyntheticEvent): void {
    event.preventDefault();
    void saveIncome();
  }

  return (
    <div className="pt-stack">
      <Card
        title="Advance tax"
        action={
          <button type="button" className="pt-button-inline" onClick={() => void compute()}>
            Compute advance tax
          </button>
        }
      >
        <ProvisionalBanner status={selectedYear?.rulesStatus} note={selectedYear?.rulesNote} />

        <div className="pt-controls">
          <label htmlFor="fy">Financial year</label>
          <select
            id="fy"
            value={financialYear}
            onChange={(event) => {
              setFinancialYear(event.target.value);
            }}
          >
            {(periods?.financialYears ?? []).map((option) => (
              <option key={option.financialYear} value={option.financialYear}>
                {financialYearLabel(option)}
              </option>
            ))}
          </select>

          <label htmlFor="quarter">Instalment</label>
          <select
            id="quarter"
            value={quarter}
            onChange={(event) => {
              setQuarter(event.target.value);
            }}
          >
            {QUARTERS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {selectedYear !== undefined && periods !== undefined && (
          <p className="pt-muted" data-testid="selected-period">
            FY {selectedYear.financialYear} is assessed in{' '}
            <strong>AY {selectedYear.assessmentYear}</strong>
            {selectedYear.isCurrent ? ' — the current financial year.' : '.'}
            {!selectedYear.rulesAvailable && (
              <>
                {' '}
                No rate set has been loaded for FY {selectedYear.financialYear}, so nothing can be
                computed for it — rates are never carried over from an adjacent year.
              </>
            )}
            {!selectedYear.isCurrent &&
              periods.currentFinancialYear !== periods.defaultFinancialYear && (
                <>
                  {' '}
                  The current year, FY {periods.currentFinancialYear}, has no rates yet, so this
                  opens on the most recent year that can be computed.
                </>
              )}
          </p>
        )}

        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}

        {installment !== undefined && (
          <>
            {!hasProfile && (
              <p className="pt-muted" data-testid="no-income-profile">
                No income has been recorded for {financialYear}, so this is computed from zero
                income. Enter your income below for a figure that means something.
              </p>
            )}
            <p className="pt-display pt-numeric" data-testid="advance-tax-payable">
              {new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: 'INR',
                maximumFractionDigits: 0,
              }).format(Number(installment.netPayable.amount))}
            </p>
            <dl className="pt-stats">
              <div>
                <dt>Due by</dt>
                <dd>{installment.dueDate}</dd>
              </div>
              <div>
                <dt>Cumulative</dt>
                <dd className="pt-numeric">{installment.cumulativePercentage}%</dd>
              </div>
              <div>
                <dt>Total liability</dt>
                <dd>
                  <Amount value={installment.totalLiability} />
                </dd>
              </div>
              <div>
                <dt>TDS credit</dt>
                <dd>
                  <Amount value={installment.tdsCredit} />
                </dd>
              </div>
              <div>
                <dt>Already paid</dt>
                <dd>
                  <Amount value={installment.alreadyPaid} />
                </dd>
              </div>
            </dl>

            {/*
              A gain with no exchange rate is ABSENT from the figure above, not
              approximated into it. Saying so beside the number is the whole
              point: an instalment that is quietly short is indistinguishable
              from a correct one, and the shortfall surfaces at assessment.
            */}
            {(installment.capitalGains?.unconvertible.length ?? 0) > 0 && (
              <p className="pt-error" role="alert" data-testid="unconvertible-gains">
                <strong>This figure is incomplete.</strong>{' '}
                {installment.capitalGains?.unconvertible.length} disposal
                {installment.capitalGains?.unconvertible.length === 1 ? '' : 's'} could not be
                converted to rupees — no SBI TT buy rate is held for the month-end that Rule 115
                names — so {installment.capitalGains?.unconvertible.length === 1 ? 'it is' : 'they are'}{' '}
                left out entirely. Import the rate archive covering{' '}
                {installment.capitalGains?.unconvertible.map((g) => g.exitDate).join(', ')} before
                relying on this.
              </p>
            )}

            {(installment.capitalGains?.excludedSellToCover.length ?? 0) > 0 && (
              <p className="pt-callout" role="status" data-testid="excluded-sell-to-cover">
                Excludes {installment.capitalGains?.excludedSellToCover.length} sell-to-cover
                disposal
                {installment.capitalGains?.excludedSellToCover.length === 1 ? '' : 's'}, by your
                setting under <strong>What counts as income</strong>. Gains left out:{' '}
                <strong>
                  ₹
                  {(installment.capitalGains?.excludedSellToCover ?? [])
                    .reduce((sum, d) => sum + Number(d.gainInr?.amount ?? 0), 0)
                    .toFixed(2)}
                </strong>
                {(installment.capitalGains?.excludedSellToCover ?? []).some(
                  (d) => d.straddlesBasisMonths,
                ) && ' — some span two Rule 115 months, where the amount is not a rounding error'}
                .
              </p>
            )}
          </>
        )}
      </Card>

      {/*
        Where the "other sources" figure came from (Phase 2).
        Without this the composition is invisible: a dividend both typed into the
        profile AND recorded against a holding is counted twice, and the only
        defence is that the user can SEE both lines and remove one.
      */}
      <OtherSourcesPanel financialYear={financialYear} />

      {/* Recomputes the instalment above: it is stated net of what is paid. */}
      <AdvanceTaxPayments financialYear={financialYear} onRecorded={() => void compute()} />

      {regimes !== undefined && (
        <Card title="Regime comparison" action={<Chip>{regimes.recommended} regime</Chip>}>
          <ProvisionalBanner status={selectedYear?.rulesStatus} note={selectedYear?.rulesNote} />
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="regime-table">
              <thead>
                <tr>
                  <th scope="col">Regime</th>
                  <th scope="col" className="pt-align-end">
                    Total income
                  </th>
                  <th scope="col" className="pt-align-end">
                    Base tax
                  </th>
                  <th scope="col" className="pt-align-end">
                    Surcharge
                  </th>
                  <th scope="col" className="pt-align-end">
                    Cess
                  </th>
                  <th scope="col" className="pt-align-end">
                    Liability
                  </th>
                </tr>
              </thead>
              <tbody>
                {[regimes.old, regimes.new].map((computation) => (
                  <tr key={computation.regime}>
                    <td>{computation.regime.toLowerCase()}</td>
                    <td className="pt-align-end">
                      <Amount value={computation.totalIncome} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.baseTax} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.surcharge} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.cess} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={computation.totalLiability} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {regimes.deductionsForgone.length > 0 && (
            <p className="pt-muted">
              Forgone under the new regime: {regimes.deductionsForgone.join(', ')}.
            </p>
          )}
        </Card>
      )}

      <Card title="Income for the year" action={hasProfile ? <Chip>Recorded</Chip> : undefined}>
        <p className="pt-muted">
          Stored in your encrypted vault, never sent anywhere. Salary is as sensitive as holdings,
          and it is cleared from memory when the vault locks.
        </p>
        <form onSubmit={onSubmitIncome} className="pt-form pt-form--grid">
          {INCOME_FIELDS.map(([key, fieldLabel]) => (
            <div key={key}>
              <label htmlFor={key}>{fieldLabel}</label>
              <input
                id={key}
                type="text"
                inputMode="decimal"
                value={income[key] ?? ''}
                placeholder="0"
                onChange={(event) => {
                  setSaved(false);
                  setIncome((current) => ({ ...current, [key]: event.target.value }));
                }}
              />
            </div>
          ))}
          <button type="submit" disabled={hasProfile && !editMode.enabled}>
            Save income
          </button>
          {/*
            Entering a profile for the first time is an addition and stays open.
            REPLACING one is not: every advance-tax figure on this screen is
            computed from it, and they all move silently when it changes.
          */}
          {hasProfile && !editMode.enabled && (
            <EditModeHint action="replace the income already recorded for this year" />
          )}
          {saved && (
            <p className="pt-muted" role="status">
              Saved.
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}

/**
 * Advance tax already paid, and the form to record it.
 *
 * Instalments are cumulative — 15/45/75/100% of the year's liability — so every
 * quarter after the first is net of what came before. Until a payment is
 * recorded the engine assumes nothing was paid, and each quarter re-demands tax
 * the taxpayer already has a challan for.
 *
 * Recording is ungated; deleting is not. Adding a payment that happened can only
 * make the demand more accurate, while removing one RAISES every later
 * instalment — which is the direction edit mode exists to guard.
 */
function AdvanceTaxPayments({
  financialYear,
  onRecorded,
}: {
  financialYear: string;
  onRecorded: () => void;
}) {
  const editMode = useEditMode();
  const [payments, setPayments] = useState<readonly AdvanceTaxPayment[]>([]);
  const [quarter, setQuarter] = useState<string>('Q1');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [challanRef, setChallanRef] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await api.advanceTaxPayments(financialYear);
    if (result.ok) setPayments(result.value.payments);
  }, [financialYear]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.recordAdvanceTaxPayment({
      fy: financialYear,
      quarter,
      amount,
      paidOn,
      ...(challanRef.trim().length === 0 ? {} : { challanRef }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setAmount('');
    setPaidOn('');
    setChallanRef('');
    await load();
    // The instalment above is now net of this payment, so it has to be recomputed.
    onRecorded();
  }, [amount, challanRef, financialYear, load, onRecorded, paidOn, quarter]);

  const total = payments.reduce((sum, payment) => sum + Number(payment.amount.amount), 0);

  return (
    <Card
      title="Advance tax paid"
      action={<Chip>{`₹${total.toLocaleString('en-IN')}`}</Chip>}
    >
      <p className="pt-muted">
        Each quarter&rsquo;s demand is the year&rsquo;s liability at 15, 45, 75 or 100 per cent,
        less TDS and less everything already paid. Record each challan here or every quarter after
        the first will ask again for tax you have already remitted.
      </p>

      {payments.length > 0 && (
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="advance-tax-payments">
            <thead>
              <tr>
                <th scope="col">Quarter</th>
                <th scope="col">Paid on</th>
                <th scope="col">Challan</th>
                <th scope="col" className="pt-align-end">Amount</th>
                {editMode.enabled && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.paymentId}>
                  <td>{payment.quarter}</td>
                  <td>{payment.paidOn}</td>
                  <td>{payment.challanRef ?? '—'}</td>
                  <td className="pt-align-end">
                    <Amount value={payment.amount} />
                  </td>
                  {editMode.enabled && (
                    <td>
                      <DeleteControl
                        label="Delete"
                        describes={`this ₹${payment.amount.amount} payment for ${payment.quarter}, which will RAISE every later instalment`}
                        testId={`delete-payment-${payment.paymentId}`}
                        onDelete={() => api.deleteAdvanceTaxPayment(payment.paymentId)}
                        onDeleted={() => {
                          void load();
                          onRecorded();
                        }}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="pt-form"
        data-testid="record-advance-tax-payment"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="payment-quarter">Quarter</label>
        <select
          id="payment-quarter"
          value={quarter}
          onChange={(event) => {
            setQuarter(event.target.value);
          }}
        >
          {QUARTERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <label htmlFor="payment-amount">Amount paid</label>
        <input
          id="payment-amount"
          inputMode="decimal"
          value={amount}
          placeholder="1,00,000"
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />

        <label htmlFor="payment-date">Paid on</label>
        <input
          id="payment-date"
          type="date"
          value={paidOn}
          onChange={(event) => {
            setPaidOn(event.target.value);
          }}
        />

        <label htmlFor="payment-challan">Challan reference (optional)</label>
        <input
          id="payment-challan"
          value={challanRef}
          onChange={(event) => {
            setChallanRef(event.target.value);
          }}
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Record payment'}
        </button>

        {error !== undefined && (
          <p className="pt-error" role="alert" data-testid="payment-error">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}

/**
 * Other-sources income, and where each rupee of it came from.
 *
 * Exists because the derivation COMPOSES the typed figure with the ledger's
 * rather than replacing it — which is right (the user has income this ledger
 * does not know about) but means a dividend entered in both places is counted
 * twice. That is not detectable from here, so the defence is that every
 * component is named and the user can remove the duplicate. A defence nobody
 * can see is not a defence, which is what this panel fixes.
 *
 * It also shows what was EXCLUDED. Hand-loan interest and chit returns default
 * to off; a user who recorded a loan and finds no interest in the figure needs
 * to know it is a setting, and how large the choice is.
 */
function OtherSourcesPanel({ financialYear }: { financialYear: string }) {
  const [income, setIncome] = useState<DerivedOtherSources | undefined>();

  useEffect(() => {
    if (financialYear.length === 0) return;
    void (async () => {
      const result = await api.derivedIncome(financialYear);
      setIncome(result.ok ? result.value : undefined);
    })();
  }, [financialYear]);

  if (income === undefined) return null;
  if (income.items.length === 0 && income.excluded.length === 0) return null;

  return (
    <Card title="Income from other sources" action={<Chip>{`FY ${financialYear}`}</Chip>}>
      <dl className="pt-stats">
        <div>
          <dt>From the ledger</dt>
          <dd data-testid="other-sources-derived">
            <Amount value={income.derived} />
          </dd>
        </div>
        <div>
          <dt>Entered by hand</dt>
          <dd>
            <Amount value={income.manual} />
          </dd>
        </div>
        <div>
          <dt>Counted as income</dt>
          <dd data-testid="other-sources-total">
            <Amount value={income.total} />
          </dd>
        </div>
      </dl>

      {income.items.length > 0 && (
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="other-sources-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col" className="pt-align-end">Amount</th>
              </tr>
            </thead>
            <tbody>
              {income.items.map((item, index) => (
                <tr key={`${item.label}-${String(index)}`}>
                  <td>{item.label}</td>
                  <td className="pt-align-end">
                    <Amount value={item.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {income.items.length > 1 && (
        <p className="pt-muted">
          Each line is counted once. If something here is <strong>also</strong> in the
          &ldquo;other sources&rdquo; box of your income profile, it is being counted twice —
          remove it from one of the two.
        </p>
      )}

      {income.excluded.length > 0 && (
        <>
          <h4>Recorded, but not counted</h4>
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="other-sources-excluded">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col" className="pt-align-end">Amount</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {income.excluded.map((row, index) => (
                  <tr key={`${row.label}-${String(index)}`}>
                    <td>{row.label}</td>
                    <td className="pt-align-end">
                      <Amount value={row.amount} />
                    </td>
                    <td className="pt-muted">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
