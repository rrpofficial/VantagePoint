/**
 * Application shell (US-8.5).
 *
 * Deliberately small: the SPA renders what the API returns and holds no domain
 * logic. Everything shown here is computed server-side by the engines, so the
 * browser cannot disagree with a snapshot or a tax figure.
 *
 * The nav used to set a `section` state that nothing read, so every link
 * highlighted and rendered the dashboard regardless. Sections are now real
 * routes; `useSection` is the single source of truth and the address bar stays
 * in step, so a deep link and the back button both work.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { api, type Valuation } from './api.js';
import { Card } from './components/primitives.js';
import { SECTIONS, hrefFor, useSection } from './router.js';
import { Compliance } from './views/Compliance.js';
import { Dashboard } from './views/Dashboard.js';
import { Import } from './views/Import.js';
import { Ledger } from './views/Ledger.js';
import { Loans } from './views/Loans.js';
import { Chits } from './views/Chits.js';
import { Settings } from './views/Settings.js';
import { Snapshots } from './views/Snapshots.js';
import { Tax } from './views/Tax.js';

export function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);
  const [valuation, setValuation] = useState<Valuation | undefined>();
  const [valuedAt, setValuedAt] = useState<string | undefined>();
  const [valuing, setValuing] = useState(false);
  const section = useSection();

  const refresh = useCallback(async () => {
    setValuing(true);
    const result = await api.valuation();
    if (result.ok) {
      setValuation(result.value);
      setValuedAt(new Date().toLocaleTimeString());
    }
    setValuing(false);
  }, []);

  /*
   * Re-valued every time the Dashboard is opened, not once at unlock.
   *
   * The valuation was fetched a single time and then held for the session, so
   * anything recorded afterwards — a loan, an import, a payment — left the
   * Dashboard showing ₹0 while the Ledger and Loans tabs showed the money. Two
   * screens disagreeing about net worth is worse than either being briefly
   * stale, and the tab change is the natural moment to reconcile them.
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
  }, []);

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
        <nav>
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
      </header>

      <main>
        {section === 'Dashboard' && (
          <Dashboard
            valuation={valuation}
            valuedAt={valuedAt}
            valuing={valuing}
            onRefresh={() => void refresh()}
          />
        )}
        {section === 'Ledger' && <Ledger />}
        {section === 'Loans' && <Loans />}
        {section === 'Chits' && <Chits />}
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
