/**
 * Snapshots — the frozen record, and variance against it.
 *
 * The content hash is shown, truncated, on every row. A compliance snapshot's
 * whole value is that it cannot change quietly; displaying the hash is what lets
 * a user verify that claim rather than take it on trust.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type AssetBucket, type SnapshotSummary, type VarianceReport } from '../api.js';
import { Amount, Card, Chip, Delta } from '../components/primitives.js';

/**
 * Asset class → tab bucket, mirroring `core-domain/src/asset-bucket.ts`.
 *
 * A LOCAL map rather than an import: `bucketOf` takes an Asset and decides
 * Equity vs Non-Equity by tax character (ADR-016), which a frozen position
 * cannot supply — a debt-oriented fund and an equity-oriented one share a class.
 * This is the coarser reading, and it is honest about that: a mutual fund lands
 * under Non-Equity here whatever its allocation was.
 */
const BUCKET_OF: Readonly<Record<string, AssetBucket>> = {
  DOMESTIC_EQUITY: 'EQUITY',
  DOMESTIC_ETF: 'EQUITY',
  FOREIGN_EQUITY: 'EQUITY',
  FOREIGN_ETF: 'EQUITY',
  UNLISTED_SHARES: 'EQUITY',
  REAL_ESTATE: 'IMMOVABLE',
  HAND_LOAN: 'LOAN',
  CHIT_FUND: 'CHIT',
};

const bucketFor = (assetClass: string): AssetBucket => BUCKET_OF[assetClass] ?? 'NON_EQUITY';

const BUCKET_LABELS: readonly { value: AssetBucket | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All assets' },
  { value: 'EQUITY', label: 'Equity' },
  { value: 'NON_EQUITY', label: 'Non-equity' },
  { value: 'IMMOVABLE', label: 'Immovable' },
  { value: 'LOAN', label: 'Loans' },
  { value: 'CHIT', label: 'Chits' },
];

/**
 * The most recent fully-elapsed day.
 *
 * A custom snapshot is taken as of the END of its date, so asking for today
 * means asking for a moment that has not happened — the domain refuses it, and
 * rightly: today's closing position is not yet knowable. Defaulting to yesterday
 * makes the default action succeed instead of teaching the user that the button
 * is broken.
 */
function latestCompleteDay(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function Snapshots() {
  const [asOf, setAsOf] = useState<string>(latestCompleteDay);
  const [snapshots, setSnapshots] = useState<readonly SnapshotSummary[] | undefined>();
  const [variance, setVariance] = useState<VarianceReport | undefined>();
  const [comparing, setComparing] = useState<string | undefined>();
  /** `'live'` or a second snapshot id — what the comparison ran against. */
  const [comparedWith, setComparedWith] = useState<string>('live');
  /**
   * Which sleeve the variance table is filtered to.
   *
   * A CLIENT-side reading of a full snapshot, not a snapshot of its own. "How
   * did the equity sleeve move between these dates" is a way of looking at the
   * frozen record, and freezing a class-scoped artifact instead would multiply
   * the snapshot-per-date count with ADR-006's immutability guarantees then
   * applying to each one individually. See §3 Phase 4 of the evolution plan.
   */
  const [bucket, setBucket] = useState<AssetBucket | 'ALL'>('ALL');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await api.snapshots();
    if (result.ok) setSnapshots(result.value.snapshots);
    else setError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await api.createSnapshot(asOf);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await load();
  }, [asOf, load]);

  /**
   * `'live'` compares against the current portfolio; any other value is a second
   * snapshot id.
   *
   * Both routes have existed since the snapshot work — only the snapshot-to-live
   * one was reachable, so the product could answer "how has it moved since?" and
   * never "how did it move between these two dates?", which is objective 2.
   */
  const compare = useCallback(
    async (beforeId: string, against: string): Promise<void> => {
      setError(undefined);
      setComparing(beforeId);
      setComparedWith(against);

      const result =
        against === 'live'
          ? await api.compareToLive(beforeId)
          : await api.compareSnapshots(beforeId, against);

      if (result.ok) setVariance(result.value);
      else {
        setVariance(undefined);
        setError(result.error.message);
      }
    },
    [],
  );

  return (
    <div className="vp-stack">
      <Card
        title="Snapshots"
        action={
          <button type="button" className="vp-button-inline" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create snapshot'}
          </button>
        }
      >
        <p className="vp-muted">
          Statutory snapshots freeze on 31 March (domestic) and 31 December (foreign). A frozen
          snapshot is never rewritten — re-running the scheduler returns the existing one.
        </p>

        <div className="vp-controls">
          <label htmlFor="as-of">As of</label>
          <input
            id="as-of"
            type="date"
            value={asOf}
            max={latestCompleteDay()}
            onChange={(event) => {
              setAsOf(event.target.value);
            }}
          />
          <span className="vp-muted">
            A snapshot covers a whole day, so the latest available date is yesterday.
          </span>
        </div>

        {error !== undefined && (
          <p className="vp-error" role="alert">
            {error}
          </p>
        )}

        <div className="vp-table-scroll">
          <table className="vp-table" data-testid="snapshot-list">
            <thead>
              <tr>
                <th scope="col">Snapshot</th>
                <th scope="col">Kind</th>
                <th scope="col">Scope</th>
                <th scope="col">As of</th>
                <th scope="col">Content hash</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {snapshots === undefined && (
                <tr>
                  <td colSpan={6} className="vp-muted">
                    Loading…
                  </td>
                </tr>
              )}
              {snapshots?.length === 0 && (
                <tr>
                  <td colSpan={6} className="vp-muted">
                    No snapshots yet.
                  </td>
                </tr>
              )}
              {snapshots?.map((snapshot) => (
                <tr key={snapshot.snapshotId}>
                  <td>{snapshot.snapshotId}</td>
                  <td>{snapshot.kind}</td>
                  <td>{snapshot.scope}</td>
                  <td>{snapshot.asOf.slice(0, 10)}</td>
                  <td className="vp-numeric vp-hash">{snapshot.contentHash.slice(0, 12)}…</td>
                  <td className="vp-align-end">
                    {/*
                      A select rather than two buttons: "against what" is one
                      question with several answers, and a row of buttons per
                      snapshot grows with the snapshot count.
                    */}
                    <select
                      aria-label={`Compare ${snapshot.snapshotId} against`}
                      defaultValue=""
                      data-testid={`compare-${snapshot.snapshotId}`}
                      onChange={(event) => {
                        const against = event.target.value;
                        if (against.length === 0) return;
                        void compare(snapshot.snapshotId, against);
                        // Reset, so picking the same target twice re-runs it.
                        event.target.value = '';
                      }}
                    >
                      <option value="">Compare with…</option>
                      <option value="live">the live portfolio</option>
                      {snapshots
                        .filter((other) => other.snapshotId !== snapshot.snapshotId)
                        .map((other) => (
                          <option key={other.snapshotId} value={other.snapshotId}>
                            {other.asOf.slice(0, 10)} · {other.snapshotId}
                          </option>
                        ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {variance !== undefined && (
        <Card
          title={comparedWith === 'live' ? 'Variance against live' : 'Variance between snapshots'}
          action={comparing === undefined ? undefined : <Chip>{comparing}</Chip>}
        >
          <dl className="vp-stats">
            <div>
              <dt>Then</dt>
              <dd>
                <Amount value={variance.netWorthBefore} />
              </dd>
            </div>
            <div>
              <dt>Now</dt>
              <dd>
                <Amount value={variance.netWorthAfter} />
              </dd>
            </div>
            <div>
              <dt>Change</dt>
              <dd>
                <Delta value={variance.netWorthDelta} />
              </dd>
            </div>
            <div>
              <dt>Change %</dt>
              <dd className="vp-numeric">{variance.netWorthDeltaPct}%</dd>
            </div>
          </dl>

          <div className="vp-controls">
            <label htmlFor="variance-bucket">Show</label>
            <select
              id="variance-bucket"
              value={bucket}
              data-testid="variance-bucket"
              onChange={(event) => {
                setBucket(event.target.value as AssetBucket | 'ALL');
              }}
            >
              {BUCKET_LABELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {/*
              The net-worth figures above are the WHOLE portfolio and do not
              change with this filter. Saying so beats letting a reader assume
              the ₹ change at the top belongs to the sleeve below it.
            */}
            <span className="vp-muted">
              Filters the rows below. The net worth figures above cover the whole portfolio.
            </span>
          </div>

          <div className="vp-table-scroll">
            <table className="vp-table" data-testid="variance-table">
              <thead>
                <tr>
                  <th scope="col">Movement</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Class</th>
                  <th scope="col" className="vp-align-end">
                    Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = variance.positions.filter(
                    (row) => bucket === 'ALL' || bucketFor(row.assetClass) === bucket,
                  );

                  if (rows.length === 0) {
                    return (
                      <tr>
                        <td colSpan={4} className="vp-muted">
                          {variance.positions.length === 0
                            ? 'Nothing moved between the two points being compared.'
                            : 'Nothing in this asset class moved. Widen the filter to see the rest.'}
                        </td>
                      </tr>
                    );
                  }

                  return rows.map((row) => (
                    <tr key={row.assetId}>
                      <td>{row.bucket.replaceAll('_', ' ').toLowerCase()}</td>
                      <td>{row.assetId}</td>
                      <td>{row.assetClass.replaceAll('_', ' ').toLowerCase()}</td>
                      <td className="vp-align-end">
                        <Delta value={row.valueDelta} />
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
