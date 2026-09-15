/**
 * Holdings for one bucket — Equity or Non-Equity.
 *
 * One component for both, parameterised by bucket, because they differ in what
 * they contain and not in how they read. Two near-identical files would drift the
 * first time a column was added to one of them.
 *
 * This replaces the Ledger's Holdings table. The Ledger rendered instruments,
 * disposals, liabilities and loans in a single view, which meant the screen had
 * no subject: nothing on it shared a shape, so every column was meaningful for
 * some rows and blank for others.
 *
 * **The bucket is decided by the server.** Equity and Non-Equity are split by tax
 * character where one exists, not by asset class — a debt-oriented fund and an
 * equity-oriented one share a class and are taxed differently (ADR-016). The SPA
 * reads `asset.bucket` and never derives it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AssetBucket,
  type Ledger as LedgerData,
  type LedgerAsset,
  type LedgerExit,
  type TradeClass,
} from '../api.js';
import { Amount, Card, Chip, Delta, GoToImport } from '../components/primitives.js';
import { DeleteControl } from '../components/DeleteControl.js';
import { useEditMode } from '../edit-mode.js';
import { TradeForm } from './TradeForm.js';

export interface HoldingsProps {
  readonly bucket: AssetBucket;
  readonly title: string;
  /** What this tab is for, in one line. Shown when it is empty. */
  readonly blurb: string;
  /** Asset classes the trade form should offer here, if any. */
  readonly tradeClasses: readonly string[];
}

export function Holdings({ bucket, title, blurb, tradeClasses }: HoldingsProps) {
  const editMode = useEditMode();
  const [ledger, setLedger] = useState<LedgerData | undefined>();
  const [classes, setClasses] = useState<readonly TradeClass[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [recording, setRecording] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [ledgerResult, classResult] = await Promise.all([api.ledger(), api.tradeClasses()]);
    if (ledgerResult.ok) {
      setLedger(ledgerResult.value);
      setError(undefined);
    } else setError(ledgerResult.error.message);
    if (classResult.ok) setClasses(classResult.value.classes);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Closes the row detail when the tab changes, so a row expanded under Equity
  // does not leave a stray open panel behind on Non-Equity.
  useEffect(() => {
    setExpanded(undefined);
    setRecording(false);
  }, [bucket]);

  if (error !== undefined) {
    return (
      <Card title={title}>
        <p className="pt-error" role="alert">
          {error}
        </p>
      </Card>
    );
  }

  if (ledger === undefined) {
    return (
      <Card title={title}>
        <p className="pt-muted">Loading…</p>
      </Card>
    );
  }

  const holdings = ledger.assets.filter((asset) => asset.bucket === bucket);
  const held = new Set(holdings.map((asset) => asset.assetId));
  // A disposal belongs beside the holding it came from, not in a combined list.
  const exits = ledger.exits.filter((exit) => held.has(exit.assetId));
  const offered = classes.filter((option) => tradeClasses.includes(option.assetClass));

  const recordButton = offered.length > 0 && (
    <button
      type="button"
      className="pt-button-inline"
      data-testid={`record-trade-${bucket.toLowerCase()}`}
      onClick={() => {
        setRecording((open) => !open);
      }}
    >
      {recording ? 'Cancel' : 'Record a trade'}
    </button>
  );

  /*
   * Both routes into this tab, side by side: one trade by hand, or a whole
   * statement at once. Import is the one that scales, so it is not hidden behind
   * an empty state.
   */
  const actions = (
    <div className="pt-actions pt-actions--inline">
      {recordButton}
      <GoToImport testId={`go-to-import-${bucket.toLowerCase()}`} />
    </div>
  );

  return (
    <div className="pt-stack">
      <Card title={title} action={actions}>
        <p className="pt-muted">{blurb}</p>
        {/*
          `onSaved` RELOADS, `onClose` closes — deliberately separate. A sell that
          found nothing to sell is reported rather than celebrated, so the form
          calls onSaved and keeps itself open with the explanation on screen,
          calling onClose only when the trade applied cleanly. Closing on save
          would take that message away with it.
        */}
        {recording && (
          <TradeForm
            classes={offered}
            onSaved={() => void load()}
            onClose={() => {
              setRecording(false);
            }}
          />
        )}
      </Card>

      {holdings.length === 0 ? (
        <Card title="Holdings">
          <p className="pt-muted" data-testid={`holdings-empty-${bucket.toLowerCase()}`}>
            Nothing here yet. Import a statement, or record a trade above.
          </p>
        </Card>
      ) : (
        <Card title="Holdings" action={<Chip>{`${String(holdings.length)} assets`}</Chip>}>
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid={`holdings-table-${bucket.toLowerCase()}`}>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col">Class</th>
                  <th scope="col">Where</th>
                  <th scope="col" className="pt-align-end">Lots</th>
                  <th scope="col" className="pt-align-end">Held</th>
                  <th scope="col" className="pt-align-end">Value</th>
                  {/*
                    Blank for a rupee holding rather than a repeat of the column
                    beside it: an Indian equity has no "source currency" distinct
                    from the one it is reported in, and echoing ₹ twice invites
                    the reader to look for a difference that cannot exist.
                  */}
                  <th scope="col" className="pt-align-end">Cost (source currency)</th>
                  <th scope="col" className="pt-align-end">Cost</th>
                  <th scope="col" className="pt-align-end">Unrealised</th>
                  {editMode.enabled && <th scope="col" />}
                </tr>
              </thead>
              <tbody>
                {holdings.map((asset) => (
                  <HoldingRow
                    key={asset.assetId}
                    asset={asset}
                    expanded={expanded === asset.assetId}
                    showActions={editMode.enabled}
                    onToggle={() => {
                      setExpanded(expanded === asset.assetId ? undefined : asset.assetId);
                    }}
                    onChanged={() => void load()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {exits.length > 0 && (
        <Card title="Disposals" action={<Chip>{`${String(exits.length)} exits`}</Chip>}>
          <p className="pt-muted">
            Sales of the holdings above. Deleting one returns its units to the lots it took them
            from, so the holding becomes whole again.
          </p>
          <div className="pt-table-scroll">
            <table className="pt-table" data-testid={`exit-table-${bucket.toLowerCase()}`}>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Asset</th>
                  <th scope="col" className="pt-align-end">Quantity</th>
                  <th scope="col" className="pt-align-end">Price</th>
                  {editMode.enabled && <th scope="col" />}
                </tr>
              </thead>
              <tbody>
                {exits.map((exit) => (
                  <ExitRow
                    key={exit.txnId}
                    exit={exit}
                    showActions={editMode.enabled}
                    onChanged={() => void load()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/** The instrument's own name, falling back through every identifier it might carry. */
const nameOf = (asset: LedgerAsset) =>
  asset.symbol ?? asset.isin ?? asset.folioRef ?? asset.assetId;

function HoldingRow({
  asset,
  expanded,
  showActions,
  onToggle,
  onChanged,
}: {
  asset: LedgerAsset;
  expanded: boolean;
  showActions: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  /*
   * Both figures come from the SERVER. They used to be summed here out of
   * `Number(...)` products, which broke twice over: it reintroduced the float
   * drift ADR-002 forbids, and it ignored currency entirely — a dollar cost
   * was rendered as a bare number in a column of rupees.
   */
  const held = asset.heldQuantity;
  const cost = asset.costBasis;
  const costInr = asset.costBasisInr;
  const value = asset.marketValue;
  const valueInr = asset.marketValueInr;
  const unrealised = asset.unrealisedInr;

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
            {nameOf(asset)}
          </button>
        </td>
        <td>{asset.assetClass.replaceAll('_', ' ').toLowerCase()}</td>
        <td>{asset.jurisdiction.toLowerCase()}</td>
        <td className="pt-align-end pt-numeric">{asset.lots.length}</td>
        <td className="pt-align-end pt-numeric">{held}</td>

        {/*
          Value first, cost second, difference third — and the value column says
          when its price was taken. Prices reach this product only inside an
          imported statement (ADR-010: no outbound network), so "market value"
          without a date would go quietly stale.

          An unpriced holding shows "at cost" rather than a blank or a zero:
          property, unlisted shares, loans and chits have no market price and
          never will, and carrying them at cost is the correct answer, not a
          missing one.
        */}
        <td className="pt-align-end">
          {value === undefined ? (
            <span className="pt-muted" data-testid={`value-at-cost-${asset.assetId}`}>
              at cost
            </span>
          ) : (
            <>
              <Amount value={value} />
              {valueInr !== undefined && asset.currency !== 'INR' && (
                <div className="pt-muted pt-numeric" data-testid={`value-inr-${asset.assetId}`}>
                  <Amount value={valueInr} />
                </div>
              )}
              {asset.priceAsOf !== undefined && (
                <div className="pt-tile__hint" data-testid={`price-as-of-${asset.assetId}`}>
                  {asset.marketPricePerUnit !== undefined && (
                    <>
                      <Amount value={asset.marketPricePerUnit} /> as at{' '}
                    </>
                  )}
                  {asset.priceAsOf}
                </div>
              )}
            </>
          )}
        </td>

        {/*
          What it cost in the currency it was actually bought in. Empty for a
          rupee holding, where the next column already says it.
        */}
        <td className="pt-align-end">
          {asset.currency === 'INR' ? (
            <span className="pt-muted">—</span>
          ) : (
            <span data-testid={`cost-source-${asset.assetId}`}>
              <Amount value={cost} />
              {asset.conversionRate !== undefined && (
                <div className="pt-tile__hint">@ {asset.conversionRate}</div>
              )}
            </span>
          )}
        </td>

        {/* Always rupees, so the column adds up down the page. */}
        <td className="pt-align-end">
          {costInr === undefined ? (
            <span className="pt-muted" data-testid={`cost-inr-missing-${asset.assetId}`}>
              rate unavailable
            </span>
          ) : (
            <span data-testid={`cost-inr-${asset.assetId}`}>
              <Amount value={costInr} />
            </span>
          )}
        </td>

        <td className="pt-align-end">
          {unrealised === undefined ? (
            <span className="pt-muted">—</span>
          ) : (
            <span data-testid={`unrealised-${asset.assetId}`}>
              <Delta value={unrealised} />
            </span>
          )}
        </td>
        {showActions && (
          <td>
            <DeleteControl
              label="Delete"
              describes={`${nameOf(asset)}, its ${String(asset.lots.length)} lot(s), its income events and any disposals recorded against it`}
              testId={`delete-asset-${asset.assetId}`}
              onDelete={() => api.deleteAsset(asset.assetId)}
              onDeleted={onChanged}
            />
          </td>
        )}
      </tr>
      {expanded && (
        <tr className="pt-table__detail">
          <td colSpan={showActions ? 10 : 9}>
            <table className="pt-table pt-table--nested">
              <thead>
                <tr>
                  <th scope="col">Acquired</th>
                  <th scope="col" className="pt-align-end">Quantity</th>
                  {/* Remaining beside original is the only visible sign that a
                      disposal was applied — showing one alone looks identical
                      whether or not sells have been recorded. */}
                  <th scope="col" className="pt-align-end">Remaining</th>
                  <th scope="col" className="pt-align-end">Cost per unit</th>
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
      )}
    </>
  );
}

function ExitRow({
  exit,
  showActions,
  onChanged,
}: {
  exit: LedgerExit;
  showActions: boolean;
  onChanged: () => void;
}) {
  return (
    <tr>
      <td>{exit.exitDate}</td>
      <td>{exit.assetId}</td>
      <td className="pt-align-end pt-numeric">{exit.quantity}</td>
      <td className="pt-align-end">
        <Amount value={exit.pricePerUnit} />
      </td>
      {showActions && (
        <td>
          <DeleteControl
            label="Delete"
            describes={`this sale of ${exit.quantity} on ${exit.exitDate}, returning those units to the lots they came from`}
            testId={`delete-exit-${exit.txnId}`}
            onDelete={() => api.deleteExit(exit.txnId)}
            onDeleted={onChanged}
          />
        </td>
      )}
    </tr>
  );
}
