/**
 * Application shell (US-8.5).
 *
 * Deliberately small: the SPA renders what the API returns and holds no domain
 * logic. Everything shown here is computed server-side by the engines, so the
 * browser cannot disagree with a snapshot or a tax figure.
 *
 * Sections are real routes and the address bar stays in step, so a deep link and
 * the back button both work. The Assets area is two levels deep — see router.ts
 * for why, and for how pre-grouping links like `#/equity` still resolve.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { api, type Valuation } from './api.js';
import { Card } from './components/primitives.js';
import { EditModeProvider, useEditMode } from './edit-mode.js';
import { ASSET_TABS, SECTIONS, assetHrefFor, hrefFor, useRoute } from './router.js';
import { AssetsOverview } from './views/AssetsOverview.js';
import { Balances } from './views/Balances.js';
import { Chits } from './views/Chits.js';
import { Compliance } from './views/Compliance.js';
import { Dashboard } from './views/Dashboard.js';
import { Liabilities } from './views/Liabilities.js';
import { Holdings } from './views/Holdings.js';
import { Immovable } from './views/Immovable.js';
import { Import } from './views/Import.js';
import { Loans } from './views/Loans.js';
import { Settings } from './views/Settings.js';
import { Snapshots } from './views/Snapshots.js';
import { Tax } from './views/Tax.js';

/**
 * Which manual trade classes each holdings tab offers.
 *
 * Split rather than shared because `SGB` is a tradeable class that belongs under
 * Non-Equity — offering the full list on both tabs would let a user record a gold
 * bond from the Equity screen and then not find it there.
 *
 * A fund is the one case that can cross: it is entered by asset class, and lands
 * under Non-Equity if its scheme turns out to be debt-oriented.
 */
const EQUITY_TRADE_CLASSES = [
  'DOMESTIC_EQUITY',
  'DOMESTIC_ETF',
  'DOMESTIC_MUTUAL_FUND',
  'FOREIGN_EQUITY',
  'FOREIGN_ETF',
  'UNLISTED_SHARES',
];
/*
 * Bullion and crypto sit here rather than on the Deposits tab because they are
 * trades — a quantity bought at a price, sold FIFO, with a cost basis and a
 * capital gain. A deposit is a balance with a rate (Phase 5).
 */
const NON_EQUITY_TRADE_CLASSES = ['SGB', 'GOLD_PHYSICAL', 'GOLD_DIGITAL', 'CRYPTO'];

/**
 * The provider sits OUTSIDE the unlock gate so the mode is read once and stays
 * consistent across a lock and a re-unlock. The server is the authority on
 * whether it is on; this only mirrors it.
 */
export function App() {
  return (
    <EditModeProvider>
      <AppShell />
    </EditModeProvider>
  );
}

function AppShell() {
  const [unlocked, setUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);
  const [valuation, setValuation] = useState<Valuation | undefined>();
  const [valuedAt, setValuedAt] = useState<string | undefined>();
  const [valuing, setValuing] = useState(false);
  const { section, assetTab } = useRoute();
  const editMode = useEditMode();

  /*
   * A failed valuation used to fall on the floor — `if (result.ok)` and nothing
   * else — which left `valuation` undefined and the Dashboard on "Loading your
   * portfolio…" indefinitely. There was no loading in progress; the request had
   * come back, refused. A missing exchange rate for a single foreign holding
   * therefore looked exactly like a hung fetch, and the one message that would
   * have explained it never reached the screen.
   */
  const [valuationError, setValuationError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setValuing(true);
    const result = await api.valuation();
    if (result.ok) {
      setValuation(result.value);
      setValuationError(undefined);
      setValuedAt(new Date().toLocaleTimeString());
    } else {
      setValuationError(result.error.message);
    }
    setValuing(false);
  }, []);

  /*
   * Re-valued every time the Dashboard is opened, not once at unlock.
   *
   * The valuation was fetched a single time and then held for the session, so
   * anything recorded afterwards — a loan, an import, a payment — left the
   * Dashboard showing ₹0 while the asset tabs showed the money. Two screens
   * disagreeing about net worth is worse than either being briefly stale, and
   * the tab change is the natural moment to reconcile them.
   */
  useEffect(() => {
    if (unlocked && section === 'Dashboard') void refresh();
  }, [unlocked, section, refresh]);

  /**
   * Unlocking is SLOW by design — Argon2id at the OWASP baseline takes a few
   * hundred milliseconds, and deliberately so. Without a busy state the screen
   * did not change at all while it ran, so the natural response was to click
   * again; every extra click queued another key derivation behind the first,
   * and the wait grew linearly until the app looked frozen.
   *
   * `unlocking` is therefore both the progress indicator and the re-entry guard.
   */
  const submitUnlock = useCallback(async (): Promise<void> => {
    if (unlocking) return;

    setError(undefined);
    setUnlocking(true);
    try {
      const result = await api.unlock(passphrase);
      if (!result.ok) {
        setError(
          result.error.code === 'TIMEOUT'
            ? 'The vault did not respond. It may still be busy — wait a moment and try again.'
            : 'That passphrase did not unlock the vault.',
        );
        return;
      }
      // Cleared immediately: never held in state longer than the request.
      setPassphrase('');
      setUnlocked(true);
    } finally {
      // In `finally` so a thrown request cannot strand the button disabled with
      // no way back except a reload.
      setUnlocking(false);
    }
  }, [passphrase, unlocking]);

  /** React discards a returned promise, so rejections are handled here. */
  function unlock(event: SyntheticEvent): void {
    event.preventDefault();
    void submitUnlock();
  }

  const onLocked = useCallback(() => {
    setUnlocked(false);
    setValuation(undefined);
    // Locking turns edit mode off server-side. Re-reading rather than assuming
    // keeps one authority for the answer, and the indicator clears with it.
    void editMode.refresh();
  }, [editMode]);

  if (!unlocked) {
    return (
      <main className="pt-shell pt-shell--centred">
        <Card title="Unlock your vault">
          <p className="pt-muted">
            Your portfolio is encrypted on this machine. Nothing leaves it without your say-so.
          </p>
          <form onSubmit={unlock} className="pt-form">
            <label htmlFor="passphrase">Vault passphrase</label>
            <input
              id="passphrase"
              type="password"
              value={passphrase}
              autoComplete="current-password"
              disabled={unlocking}
              onChange={(event) => {
                setPassphrase(event.target.value);
              }}
            />
            <button type="submit" disabled={unlocking} data-testid="unlock-button">
              {unlocking ? 'Unlocking…' : 'Unlock'}
            </button>
            {unlocking && (
              // Says WHY it is slow. A deliberate work factor that looks like a
              // stall is indistinguishable from a broken app.
              <p className="pt-muted" role="status" data-testid="unlock-progress">
                Deriving your encryption key. This takes a moment by design — it is what makes a
                guessed passphrase expensive to try.
              </p>
            )}
            {error !== undefined && (
              <p className="pt-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </Card>
      </main>
    );
  }

  return (
    <div className="pt-shell">
      <header className="pt-topbar">
        <div className="pt-brand">
          <span className="pt-brand__mark" aria-hidden="true" />
          portTrack
        </div>
        <nav aria-label="Sections">
          {SECTIONS.map((name) => (
            <a
              key={name}
              href={hrefFor(name)}
              className={name === section ? 'is-active' : ''}
              aria-current={name === section ? 'page' : undefined}
            >
              {name}
            </a>
          ))}
        </nav>
        {/*
          Persistent, and on every screen rather than only on Settings. A mode
          that quietly permits deletion must be visible from wherever the
          deleting would happen, or it is left on without anyone noticing.
        */}
        {editMode.enabled && (
          <span className="pt-mode-flag" role="status" data-testid="edit-mode-flag">
            Edit mode on
          </span>
        )}
      </header>

      {/*
        The asset tabs stay on screen throughout the Assets area, so the extra
        level is paid once on entry and lateral movement between the five costs
        nothing. Hiding them behind the Assets tab would make every switch two
        clicks, which is the usual reason a grouping level gets resented.
      */}
      {section === 'Assets' && (
        <nav className="pt-subnav" aria-label="Asset kinds" data-testid="asset-subnav">
          {ASSET_TABS.map((tab) => (
            <a
              key={tab}
              href={assetHrefFor(tab)}
              className={tab === assetTab ? 'is-active' : ''}
              aria-current={tab === assetTab ? 'page' : undefined}
            >
              {tab}
            </a>
          ))}
        </nav>
      )}

      <main>
        {section === 'Dashboard' && (
          <Dashboard
            valuation={valuation}
            valuedAt={valuedAt}
            valuing={valuing}
            valuationError={valuationError}
            onRefresh={() => void refresh()}
          />
        )}

        {section === 'Liabilities' && <Liabilities />}

        {section === 'Assets' && (
          <>
            {assetTab === 'Overview' && <AssetsOverview />}
            {/*
              Two tabs, one component. They differ in what they contain, not in
              how they read, and the bucket each filters on is decided by the
              SERVER — equity versus debt turns on tax character (ADR-016).
            */}
            {assetTab === 'Equity' && (
              <Holdings
                bucket="EQUITY"
                title="Equity"
                blurb="Listed shares, equity funds and ETFs, unlisted shares, and your RSUs and ESPP. A fund appears here when its scheme is equity-oriented."
                tradeClasses={EQUITY_TRADE_CLASSES}
              />
            )}
            {assetTab === 'Non-Equity' && (
              <Holdings
                bucket="NON_EQUITY"
                title="Non-equity"
                blurb="Deposits, retirement schemes, bullion and sovereign gold bonds, crypto, cash and bank balances — and any debt-oriented fund."
                tradeClasses={NON_EQUITY_TRADE_CLASSES}
              />
            )}
            {assetTab === 'Deposits' && <Balances />}
            {assetTab === 'Immovable' && <Immovable />}
            {assetTab === 'Loans' && <Loans />}
            {assetTab === 'Chits' && <Chits />}
          </>
        )}

        {/* Also re-valued after an import, so the Dashboard is already correct
            by the time the user navigates back to it. */}
        {section === 'Import' && <Import onImported={() => void refresh()} />}
        {section === 'Snapshots' && <Snapshots />}
        {section === 'Tax' && <Tax />}
        {section === 'Compliance' && <Compliance />}
        {section === 'Settings' && <Settings onLocked={onLocked} />}
      </main>
    </div>
  );
}
