/**
 * Recording a trade by hand.
 *
 * Extracted from the Ledger when holdings were split into Equity, Non-Equity and
 * Immovable. The form now appears on whichever tab offers the asset classes it
 * can record, and is handed that list rather than fetching the whole set — `SGB`
 * is a manual trade class but belongs under Non-Equity, so one shared form with
 * a filtered list keeps entry beside the holdings it produces.
 *
 * Routed through the SAME projection an imported statement takes: a hand-typed
 * sell must deplete FIFO exactly as an imported one does and produce the same
 * disposal the capital-gains engine reads. A second write path would be a second
 * set of rules to keep in step, and tax is where the divergence would surface.
 */
import { useCallback, useState, type SyntheticEvent } from 'react';
import { api, type RecordedTrade, type TradeClass } from '../api.js';

/**
 * What identifies a holding genuinely differs by asset class: a listed share has
 * a ticker, a mutual fund has a folio, an unlisted company has neither. Asking
 * for "symbol" against a fund invites a scheme name typed into a field the
 * importer treats as a ticker, and the same fund imported later from CAMS would
 * then not match it.
 */
const IDENTIFIER_LABEL: Readonly<Record<string, string>> = {
  SYMBOL: 'Symbol or ticker',
  FOLIO: 'Folio number',
  NAME: 'Company name',
};

const today = () => new Date().toISOString().slice(0, 10);

export function TradeForm({
  classes,
  onSaved,
  onClose,
}: {
  /** Only the classes valid for the tab this form is rendered on. */
  readonly classes: readonly TradeClass[];
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  // Defaults to the first class this tab offers, so the form opens on something
  // it can actually record rather than on a class that belongs to another tab.
  const [assetClass, setAssetClass] = useState(classes[0]?.assetClass ?? 'DOMESTIC_EQUITY');
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
      <div className="vp-callout vp-callout--warn" role="alertdialog" data-testid="duplicate-trade-warning">
        <h3 className="vp-subhead">This trade is already on the ledger</h3>
        <p className="vp-muted">
          {duplicate}. If this is a second fill of the same order, record it — the ledger keeps
          both. If you are entering a trade you already recorded, cancel.
        </p>
        <div className="vp-actions">
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
            className="vp-button-inline"
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
    <form className="vp-form vp-form--grid" onSubmit={onFormSubmit} data-testid="trade-form">
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
        <p className="vp-error" role="alert">
          {error}
        </p>
      )}
      {result !== undefined && result.unapplied.length > 0 && (
        <p className="vp-error" role="alert" data-testid="trade-unapplied">
          {result.unapplied.map((row) => row.reason).join('; ')}
        </p>
      )}
    </form>
  );
}
