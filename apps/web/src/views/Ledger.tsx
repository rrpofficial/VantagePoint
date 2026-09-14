/**
 * Ledger — every holding, its lots, its disposals, its loans and its liabilities.
 *
 * Shows REMAINING quantity beside original, because those two diverging is the
 * only visible sign that a disposal was applied. A view that showed only the
 * original quantity would look identical whether or not sells had been recorded.
 *
 * **Hand loans get their own section rather than a row in Holdings.** A loan is a
 * receivable, not a holding of units: it has no acquisition lots, no quantity and
 * no cost per unit, so rendering it through the instrument table produced a row
 * reading `0 lots · 0 held · ₹0` under a raw asset id — every column meaningless
 * and the one figure that matters, what is still owed, absent entirely.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  api,
  type Ledger as LedgerData,
  type LoanRegister,
  type RecordedTrade,
  type TradeClass,
} from '../api.js';
import { Amount, Card, Chip } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { useEditMode } from '../edit-mode.js';
import { navigate } from '../router.js';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  ACTIVE: 'Active',
  PARTIALLY_REPAID: 'Partially repaid',
  REPAID: 'Repaid',
};

export function Ledger() {
  const editMode = useEditMode();
  const [ledger, setLedger] = useState<LedgerData | undefined>();
  const [loans, setLoans] = useState<LoanRegister | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [recording, setRecording] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    // The loan register rather than the raw assets: it already carries the
    // borrower, the outstanding principal and the interest owed, computed the
    // same way the Loans tab computes them, so the two cannot disagree.
    const [ledgerResult, loanResult] = await Promise.all([api.ledger(), api.loans()]);
    if (ledgerResult.ok) setLedger(ledgerResult.value);
    else setError(ledgerResult.error.message);
    if (loanResult.ok) setLoans(loanResult.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== undefined) {
    return (
      <Card title="Ledger">
        <p className="pt-error" role="alert">
          {error}
        </p>
      </Card>
    );
  }

  if (ledger === undefined) {
    return (
      <Card title="Ledger">
        <p className="pt-muted">Loading your holdings…</p>
      </Card>
    );
  }

  // Instruments only. Loans are receivables and are reported below.
  const holdings = ledger.assets.filter((asset) => asset.assetClass !== 'HAND_LOAN');

  if (holdings.length === 0 && ledger.liabilities.length === 0 && (loans?.loans.length ?? 0) === 0) {
    return (
      <div className="pt-stack">
        <Card
          title="Ledger"
          action={
            <button
              type="button"
              className="pt-button-inline"
              onClick={() => {
                setRecording((open) => !open);
              }}
            >
              {recording ? 'Cancel' : 'Record a trade'}
            </button>
          }
        >
          <p className="pt-muted" data-testid="ledger-empty">
            Nothing recorded yet. Import a broker or fund statement, or record a trade by hand.
          </p>
          {recording && (
            <TradeForm
              onSaved={() => void load()}
              onClose={() => {
                setRecording(false);
              }}
            />
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="pt-stack">
      <Card
        title="Record a trade"
        action={
          <button
            type="button"
            className="pt-button-inline"
            onClick={() => {
              setRecording((open) => !open);
            }}
          >
            {recording ? 'Cancel' : 'Record a trade'}
          </button>
        }
      >
        <p className="pt-muted">
          For a buy or sell with no broker export — or one the export missed. A hand-typed trade
          goes through the same engine an imported one does: the same FIFO, the same disposal
          record, the same capital-gains treatment.
        </p>
        {recording && (
          <TradeForm
            onSaved={() => void load()}
            onClose={() => {
              setRecording(false);
            }}
          />
        )}
      </Card>

      {loans !== undefined && loans.loans.length > 0 && (
        <Card
          title="Loans receivable"
          action={
            <button
              type="button"
              className="pt-link pt-link--inline"
              onClick={() => {
                navigate('Loans');
              }}
            >
              Open the loan register
            </button>
          }
        >
          <p className="pt-muted">
            Money lent out, carried at the principal still owed plus interest accrued and not yet
            received. Lots and quantity do not apply to a receivable.
          </p>
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="loans-receivable-table">
              <thead>
                <tr>
                  <th scope="col">Borrower</th>
                  <th scope="col">Lent on</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="pt-align-end">
                    Principal lent
                  </th>
                  <th scope="col" className="pt-align-end">
                    Outstanding
                  </th>
                  <th scope="col" className="pt-align-end">
                    Interest owed
                  </th>
                  <th scope="col" className="pt-align-end">
                    Carrying value
                  </th>
                </tr>
              </thead>
              <tbody>
                {loans.loans.map((loan) => (
                  <tr key={loan.loanId}>
                    <td>{loan.borrowerName}</td>
                    <td>{loan.loanDate}</td>
                    <td>
                      <span className={`pt-status pt-status--${loan.status.toLowerCase()}`}>
                        {STATUS_LABEL[loan.status] ?? loan.status}
                      </span>
                    </td>
                    <td className="pt-align-end">
                      <Amount value={loan.principal} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={loan.outstandingPrincipal} />
                    </td>
                    <td className="pt-align-end">
                      <Amount value={loan.interestBalance} />
                    </td>
                    <td className="pt-align-end">
                      {/* What this contributes to net worth: outstanding + owed. */}
                      <Amount
                        value={{
                          amount: String(
                            Number(loan.outstandingPrincipal.amount) +
                              Number(loan.interestBalance.amount),
                          ),
                          currency: loan.principal.currency,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {holdings.length > 0 && (
      <Card title="Holdings" action={<Chip>{`${String(holdings.length)} assets`}</Chip>}>
        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="ledger-table">
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Class</th>
                <th scope="col">Where</th>
                <th scope="col" className="pt-align-end">
                  Lots
                </th>
                <th scope="col" className="pt-align-end">
                  Held
                </th>
                <th scope="col" className="pt-align-end">
                  Cost
                </th>
                {editMode.enabled && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {holdings.map((asset) => {
                const held = asset.lots.reduce(
                  (sum, lot) => sum + Number(lot.remainingQuantity),
                  0,
                );
                const cost = asset.lots.reduce(
                  (sum, lot) => sum + Number(lot.remainingQuantity) * Number(lot.costPerUnit.amount),
                  0,
                );
                const isOpen = expanded === asset.assetId;

                return [
                  <tr key={asset.assetId}>
                    <td>
                      <button
                        type="button"
                        className="pt-link pt-link--inline"
                        aria-expanded={isOpen}
                        onClick={() => {
                          setExpanded(isOpen ? undefined : asset.assetId);
                        }}
                      >
                        {/*
                          The folio belongs in this chain. A mutual fund has no
                          ticker, so without it every fund fell through to the
                          raw asset id — `ast_domestic_mutual_fund_e2e_folio_1`
                          — which is unreadable and, worse, identical in shape
                          between two funds a user needs to tell apart.
                        */}
                        {asset.symbol ?? asset.isin ?? asset.folioRef ?? asset.assetId}
                      </button>
                    </td>
                    <td>{asset.assetClass.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>{asset.jurisdiction.toLowerCase()}</td>
                    <td className="pt-align-end pt-numeric">{asset.lots.length}</td>
                    <td className="pt-align-end pt-numeric">{held}</td>
                    <td className="pt-align-end">
                      <Amount value={{ amount: String(cost), currency: asset.currency }} />
                    </td>
                    {editMode.enabled && (
                      <td>
                        <DeleteControl
                          label="Delete"
                          describes={`${asset.symbol ?? asset.isin ?? asset.folioRef ?? asset.assetId}, its ${String(asset.lots.length)} lot(s), its income events and any disposals recorded against it`}
                          testId={`delete-asset-${asset.assetId}`}
                          onDelete={() => api.deleteAsset(asset.assetId)}
                          onDeleted={() => void load()}
                        />
                      </td>
                    )}
                  </tr>,
                  isOpen ? (
                    <tr key={`${asset.assetId}-lots`} className="pt-table__detail">
                      <td colSpan={editMode.enabled ? 7 : 6}>
                        <table className="pt-table pt-table--nested">
                          <thead>
                            <tr>
                              <th scope="col">Acquired</th>
                              <th scope="col" className="pt-align-end">
                                Quantity
                              </th>
                              <th scope="col" className="pt-align-end">
                                Remaining
                              </th>
                              <th scope="col" className="pt-align-end">
                                Cost per unit
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {asset.lots.map((lot) => (
                              <tr key={lot.lotId}>
                                <td>{lot.acquisitionDate}</td>
                                <td className="pt-align-end pt-numeric">{lot.quantity}</td>
                                <td className="pt-align-end pt-numeric">{lot.remainingQuantity}</td>
                                <td className="pt-align-end">
                                  <Amount value={lot.costPerUnit} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {ledger.exits.length > 0 && (
        <Card title="Disposals" action={<Chip>{`${String(ledger.exits.length)} exits`}</Chip>}>
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid="exit-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Asset</th>
                  <th scope="col" className="pt-align-end">
                    Quantity
                  </th>
                  <th scope="col" className="pt-align-end">
                    Price
                  </th>
                  {editMode.enabled && <th scope="col" />}
                </tr>
              </thead>
              <tbody>
                {ledger.exits.map((exit) => (
                  <tr key={exit.txnId}>
                    <td>{exit.exitDate}</td>
                    <td>{exit.assetId}</td>
                    <td className="pt-align-end pt-numeric">{exit.quantity}</td>
                    <td className="pt-align-end">
                      <Amount value={exit.pricePerUnit} />
                    </td>
                    {editMode.enabled && (
                      <td>
                        {/*
                          Says what deleting a disposal DOES, because it is not
                          obvious: the units go back onto the lots they were
                          sold from, so the holding grows again.
                        */}
                        <DeleteControl
                          label="Delete"
                          describes={`this sale of ${exit.quantity} on ${exit.exitDate}, returning those units to the lots they came from`}
                          testId={`delete-exit-${exit.txnId}`}
                          onDelete={() => api.deleteExit(exit.txnId)}
                          onDeleted={() => void load()}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {ledger.liabilities.length > 0 && (
        <Card title="Liabilities">
          <div className="pt-table-scroll">
            <table className="pt-table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">As of</th>
                  <th scope="col" className="pt-align-end">
                    Rate
                  </th>
                  <th scope="col" className="pt-align-end">
                    Outstanding
                  </th>
                </tr>
              </thead>
              <tbody>
                {ledger.liabilities.map((liability) => (
                  <tr key={liability.liabilityId}>
                    <td>{liability.kind.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>{liability.asOf}</td>
                    <td className="pt-align-end pt-numeric">{liability.interestRatePct}%</td>
                    <td className="pt-align-end">
                      <Amount value={liability.principalOutstanding} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

const IDENTIFIER_LABEL: Readonly<Record<string, string>> = {
  SYMBOL: 'Symbol or ticker',
  FOLIO: 'Folio number',
  NAME: 'Company name',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Manual trade entry.
 *
 * The identifier field follows the asset class, because what identifies a
 * holding genuinely differs: a listed share has a ticker, a mutual fund has a
 * folio, an unlisted company has neither. Asking for "symbol" against a fund
 * invites a scheme name typed into a field the importer treats as a ticker, and
 * the same fund imported later from CAMS would then not match it.
 */
function TradeForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [classes, setClasses] = useState<readonly TradeClass[]>([]);
  const [assetClass, setAssetClass] = useState('DOMESTIC_EQUITY');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [tradeDate, setTradeDate] = useState(today);
  const [identifier, setIdentifier] = useState('');
  const [isin, setIsin] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [fees, setFees] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<string | undefined>();
  const [result, setResult] = useState<RecordedTrade | undefined>();

  useEffect(() => {
    void (async () => {
      const loaded = await api.tradeClasses();
      if (loaded.ok) setClasses(loaded.value.classes);
    })();
  }, []);

  const selected = classes.find((entry) => entry.assetClass === assetClass);
  const identifierKind = selected?.identifier ?? 'SYMBOL';

  const submit = useCallback(
    async (confirmDuplicate: boolean): Promise<void> => {
      setBusy(true);
      setError(undefined);

      const trimmed = identifier.trim();
      const saved = await api.recordTrade({
        assetClass,
        side,
        tradeDate,
        quantity: quantity.trim(),
        pricePerUnit: { amount: price.trim(), currency },
        ...(identifierKind === 'FOLIO' ? { folioRef: trimmed } : {}),
        ...(identifierKind === 'NAME' ? { schemeName: trimmed } : {}),
        ...(identifierKind === 'SYMBOL' ? { symbol: trimmed } : {}),
        ...(isin.trim().length === 0 ? {} : { isin: isin.trim() }),
        ...(fees.trim().length === 0 ? {} : { fees: { amount: fees.trim(), currency } }),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      });

      setBusy(false);
      if (!saved.ok) {
        // A question, not a failure — two fills of one order is ordinary.
        if (saved.error.code === 'DUPLICATE_TRADE') {
          setDuplicate(saved.error.message);
          return;
        }
        setError(saved.error.message);
        return;
      }

      setDuplicate(undefined);
      setResult(saved.value);
      setQuantity('');
      setPrice('');
      onSaved();
      // A sell that found nothing to sell is reported rather than celebrated,
      // so the form stays open with the explanation on screen.
      if (saved.value.unapplied.length === 0) onClose();
    },
    [assetClass, side, tradeDate, identifier, identifierKind, isin, quantity, price, currency, fees, onSaved, onClose],
  );

  function onFormSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit(false);
  }

  if (duplicate !== undefined) {
    return (
      <div className="pt-callout pt-callout--warn" role="alertdialog" data-testid="duplicate-trade-warning">
        <h3 className="pt-subhead">This trade is already on the ledger</h3>
        <p className="pt-muted">
          {duplicate}. If this is a second fill of the same order, record it — the ledger keeps
          both. If you are entering a trade you already recorded, cancel.
        </p>
        <div className="pt-actions">
          <button
            type="button"
            disabled={busy}
            data-testid="confirm-duplicate-trade"
            onClick={() => void submit(true)}
          >
            {busy ? 'Recording…' : 'Yes, record it as a separate fill'}
          </button>
          <button
            type="button"
            className="pt-button-inline"
            onClick={() => {
              setDuplicate(undefined);
            }}
          >
            Cancel and go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="pt-form pt-form--grid" onSubmit={onFormSubmit} data-testid="trade-form">
      <div>
        <label htmlFor="trade-class">What kind of holding</label>
        <select
          id="trade-class"
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
      </div>
      <div>
        <label htmlFor="trade-side">Buy or sell</label>
        <select
          id="trade-side"
          value={side}
          onChange={(event) => {
            setSide(event.target.value as 'BUY' | 'SELL');
          }}
        >
          <option value="BUY">Buy</option>
          <option value="SELL">Sell</option>
        </select>
      </div>
      <div>
        <label htmlFor="trade-identifier">{IDENTIFIER_LABEL[identifierKind]}</label>
        <input
          id="trade-identifier"
          type="text"
          value={identifier}
          onChange={(event) => {
            setIdentifier(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="trade-isin">ISIN (optional)</label>
        <input
          id="trade-isin"
          type="text"
          value={isin}
          onChange={(event) => {
            setIsin(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="trade-date">Trade date</label>
        <input
          id="trade-date"
          type="date"
          value={tradeDate}
          onChange={(event) => {
            setTradeDate(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="trade-quantity">Quantity or units</label>
        <input
          id="trade-quantity"
          type="text"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="trade-price">Price per unit</label>
        <input
          id="trade-price"
          type="text"
          inputMode="decimal"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
          }}
        />
      </div>
      <div>
        <label htmlFor="trade-currency">Currency</label>
        <select
          id="trade-currency"
          value={currency}
          onChange={(event) => {
            setCurrency(event.target.value);
          }}
        >
          <option value="INR">INR</option>
          <option value="USD">USD</option>
        </select>
      </div>
      <div>
        <label htmlFor="trade-fees">Brokerage and charges</label>
        <input
          id="trade-fees"
          type="text"
          inputMode="decimal"
          value={fees}
          onChange={(event) => {
            setFees(event.target.value);
          }}
        />
      </div>
      <button type="submit" disabled={busy}>
        {busy ? 'Recording…' : side === 'BUY' ? 'Record purchase' : 'Record sale'}
      </button>
      {error !== undefined && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
      {result !== undefined && result.unapplied.length > 0 && (
        <p className="pt-error" role="alert" data-testid="trade-unapplied">
          {result.unapplied.map((row) => row.reason).join('; ')}
        </p>
      )}
    </form>
  );
}
