/**
 * Settings — vault state, egress audit and where the data actually lives.
 *
 * The egress log is the user-facing half of ADR-010. An empty log is the correct
 * and expected state for a default install, so it is labelled as such: "no
 * entries" must not read as "logging is broken".
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { api } from '../api.js';
import { Card, Chip } from '../components/primitives.js';
import { useEditMode } from '../edit-mode.js';

export function Settings({ onLocked }: { onLocked: () => void }) {
  const [egressEntries, setEgressEntries] = useState<readonly unknown[] | undefined>();
  const [logLines, setLogLines] = useState<readonly string[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    const [egress, log] = await Promise.all([api.egressLog(), api.applicationLog()]);
    if (egress.ok) setEgressEntries(egress.value.entries);
    if (log.ok) setLogLines(log.value.lines);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const lock = useCallback(async (): Promise<void> => {
    const result = await api.lock();
    if (result.ok) onLocked();
    else setError(result.error.message);
  }, [onLocked]);

  return (
    <div className="pt-stack">
      <EditModeCard />

      <Card
        title="Vault"
        action={
          <button type="button" className="pt-button-inline" onClick={() => void lock()}>
            Lock vault
          </button>
        }
      >
        <p className="pt-muted">
          Your database is encrypted at rest with page-level AES-256-CBC and HMAC-SHA512, on a disk
          you control. The passphrase is never written anywhere — not to a file, not to a log, not
          to an image layer.
        </p>
        <p className="pt-banner" role="status">
          <strong>Back up the whole data directory, not just vault.db.</strong> The key derivation
          salt lives in <code>vault.db.meta.json</code> beside it. A backup of the database alone
          restores to a vault nobody can open, and you would find out at the worst moment.
        </p>
        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}
      </Card>

      <Card
        title="Network egress"
        action={
          <Chip>
            {egressEntries === undefined
              ? 'Loading'
              : egressEntries.length === 0
                ? 'None'
                : `${String(egressEntries.length)} calls`}
          </Chip>
        }
      >
        <p className="pt-muted">
          portTrack makes no outbound request by default. The API container sits on a network with
          no gateway, so this is not the application policing itself — there is no route out.
        </p>
        {egressEntries !== undefined && egressEntries.length === 0 ? (
          <p className="pt-muted" data-testid="egress-log-empty">
            No outbound call has been made. For a default install this is the expected state, not a
            missing log.
          </p>
        ) : (
          <ul className="pt-log" data-testid="egress-log">
            {(egressEntries ?? []).map((entry, index) => (
              <li key={index} className="pt-numeric">
                {JSON.stringify(entry)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Application log">
        <p className="pt-muted">
          Structured and PII-free by construction — a functional test asserts that no PAN, folio or
          account number can reach a log line.
        </p>
        {logLines === undefined || logLines.length === 0 ? (
          <p className="pt-muted">Nothing logged this session.</p>
        ) : (
          <ul className="pt-log" data-testid="application-log">
            {logLines.slice(-50).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Edit mode — the switch that lets the rest of the application change and delete
 * what it holds.
 *
 * The passphrase is asked for again on purpose, and it is the vault passphrase
 * rather than a second one: a confirmation dialog is dismissed by reflex, while
 * typing a passphrase is not something anyone does by accident. That is the
 * whole point of the control.
 *
 * It ends with the session. There is no "remember this" and no expiry setting,
 * because both would turn a decision made once into a standing permission —
 * which is the state this exists to avoid.
 */
function EditModeCard() {
  const editMode = useEditMode();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [enabling, setEnabling] = useState(false);

  /*
   * Enabling runs the same Argon2id derivation an unlock does — a few hundred
   * milliseconds of deliberate work. Without a busy state the screen does not
   * move, and the natural response is to click again; each extra click queues
   * another derivation behind the first. `enabling` is both the indicator and
   * the re-entry guard, exactly as on the unlock screen.
   */
  const submit = useCallback(async (): Promise<void> => {
    if (enabling) return;
    setError(undefined);
    setEnabling(true);
    try {
      const failure = await editMode.enable(passphrase);
      // Cleared either way: never held in state longer than the request.
      setPassphrase('');
      if (failure !== undefined) setError(failure);
    } finally {
      setEnabling(false);
    }
  }, [editMode, enabling, passphrase]);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  return (
    <Card
      title="Edit mode"
      action={
        <Chip>
          {!editMode.loaded ? 'Loading' : editMode.enabled ? 'On' : 'Off'}
        </Chip>
      }
    >
      <p className="pt-muted">
        Adding records is always available. Changing or deleting one is not: everything here is a
        record of money that has already moved, and a mistaken delete leaves nothing behind to
        notice it by. Edit mode turns those operations on across every tab.
      </p>

      {editMode.enabled ? (
        <>
          <p className="pt-callout pt-callout--warn" role="status" data-testid="edit-mode-on">
            <strong>Edit mode is on.</strong> Edit and delete controls are visible on the Equity,
            Non-Equity, Immovable, Loans and Chits tabs. It turns itself off when the vault is locked or the API restarts
            — it is never remembered between sessions.
          </p>
          <div className="pt-actions">
            <button
              type="button"
              className="pt-button-inline"
              data-testid="disable-edit-mode"
              onClick={() => void editMode.disable()}
            >
              Turn edit mode off
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={onSubmit} className="pt-form" data-testid="enable-edit-mode-form">
          <label htmlFor="edit-mode-passphrase">Vault passphrase</label>
          <input
            id="edit-mode-passphrase"
            type="password"
            value={passphrase}
            autoComplete="current-password"
            disabled={enabling}
            onChange={(event) => {
              setPassphrase(event.target.value);
            }}
          />
          <button type="submit" disabled={enabling} data-testid="enable-edit-mode">
            {enabling ? 'Checking…' : 'Turn edit mode on'}
          </button>
          {enabling && (
            // Says WHY it is slow, for the same reason the unlock screen does.
            <p className="pt-muted" role="status" data-testid="edit-mode-progress">
              Checking your passphrase against the vault key. This takes a moment by design.
            </p>
          )}
          {error !== undefined && (
            <p className="pt-error" role="alert" data-testid="edit-mode-error">
              {error}
            </p>
          )}
        </form>
      )}
    </Card>
  );
}
