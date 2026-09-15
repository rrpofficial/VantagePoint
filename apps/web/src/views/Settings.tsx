/**
 * Settings — vault state, egress audit and where the data actually lives.
 *
 * The egress log is the user-facing half of ADR-010. An empty log is the correct
 * and expected state for a default install, so it is labelled as such: "no
 * entries" must not read as "logging is broken".
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { api, type IncomeInclusions, type IncomeInclusionsState } from '../api.js';
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
      <IncomeInclusionsCard />

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
          restores to a vault nobody can open, and you would find out at the worst moment. The
          archive below carries both.
        </p>
        {error !== undefined && (
          <p className="pt-error" role="alert">
            {error}
          </p>
        )}
      </Card>

      <BackupCard />

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
 * Backup and restore (Phase 7).
 *
 * The archive is one file carrying the encrypted database AND the key-derivation
 * salt, because the salt lives beside the database rather than inside it — a
 * backup of `vault.db` alone restores to a vault nobody can open.
 *
 * Restore is the most destructive control in the application and is shaped like
 * it: it names the file it is about to apply, says in words what will be
 * replaced, and needs edit mode whenever there is an existing vault to replace.
 * The vault it overwrites is copied aside first, so a restore from the wrong
 * archive is recoverable.
 */
function BackupCard() {
  const editMode = useEditMode();
  const [busy, setBusy] = useState<'backup' | 'restore' | undefined>();
  const [archive, setArchive] = useState<{ name: string; base64: string } | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const download = useCallback(async (): Promise<void> => {
    setBusy('backup');
    setError(undefined);
    setStatus(undefined);
    const result = await api.backup();
    setBusy(undefined);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // Handed to the browser and released immediately — the archive is the whole
    // vault, and leaving the object URL alive keeps a copy of it in memory.
    const href = URL.createObjectURL(result.value.blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = result.value.fileName;
    anchor.click();
    URL.revokeObjectURL(href);
    setStatus(`Saved ${result.value.fileName}. Keep it somewhere the original disk is not.`);
  }, []);

  const choose = useCallback((event: { target: HTMLInputElement }): void => {
    const file = event.target.files?.[0];
    setError(undefined);
    setStatus(undefined);
    if (file === undefined) {
      setArchive(undefined);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // `readAsDataURL` yields `data:<type>;base64,<payload>`; the API wants the
      // payload alone.
      const payload = String(reader.result).split(',')[1] ?? '';
      setArchive({ name: file.name, base64: payload });
    };
    reader.readAsDataURL(file);
  }, []);

  const restore = useCallback(async (): Promise<void> => {
    if (archive === undefined) return;
    setBusy('restore');
    setError(undefined);
    setStatus(undefined);
    const result = await api.restoreBackup(archive.base64);
    setBusy(undefined);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setArchive(undefined);
    setStatus(
      result.value.supersededCopy === undefined
        ? 'Restored. Unlock with the passphrase that was in force when the backup was taken.'
        : `Restored. The vault it replaced was copied to ${result.value.supersededCopy}. Unlock with the passphrase that was in force when the backup was taken.`,
    );
  }, [archive]);

  return (
    <Card title="Backup and restore" action={<Chip>{busy === undefined ? 'Ready' : 'Working'}</Chip>}>
      <p className="pt-muted">
        One file, carrying the encrypted database and the key-derivation salt together. It stays
        encrypted — it opens only with the vault passphrase that was in force when it was taken —
        and it is written by your browser to a folder you choose. Nothing is uploaded anywhere.
      </p>

      <div className="pt-actions">
        <button
          type="button"
          className="pt-button-inline"
          data-testid="download-backup"
          disabled={busy !== undefined}
          onClick={() => void download()}
        >
          {busy === 'backup' ? 'Preparing…' : 'Download backup'}
        </button>
      </div>

      <p className="pt-callout pt-callout--warn" role="status">
        <strong>Restoring replaces everything in this vault.</strong> Every holding, loan, chit,
        snapshot and rate in it is replaced by whatever the archive holds. The vault being replaced
        is copied aside first, under a timestamped name, so a restore from the wrong file can be
        undone.
      </p>

      <div className="pt-form">
        <label htmlFor="restore-archive">Backup archive</label>
        <input
          id="restore-archive"
          type="file"
          accept=".ptb,application/octet-stream,application/json"
          data-testid="restore-archive"
          disabled={busy !== undefined}
          onChange={choose}
        />
        {archive !== undefined && (
          <p className="pt-muted" data-testid="restore-selected">
            Ready to restore <strong>{archive.name}</strong>.
          </p>
        )}
        <button
          type="button"
          data-testid="restore-backup"
          disabled={archive === undefined || busy !== undefined}
          onClick={() => void restore()}
        >
          {busy === 'restore' ? 'Restoring…' : 'Restore this vault from the archive'}
        </button>
      </div>

      {!editMode.enabled && (
        <p className="pt-muted" data-testid="restore-needs-edit-mode">
          Restoring over a vault that already holds data needs edit mode, above. Restoring into an
          empty data directory — a fresh install recovering from a disk failure — does not.
        </p>
      )}

      {status !== undefined && (
        <p className="pt-banner" role="status" data-testid="backup-status">
          {status}
        </p>
      )}
      {error !== undefined && (
        <p className="pt-error" role="alert" data-testid="backup-error">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * Which ledger-derived receipts count as taxable income.
 *
 * Both are off, and the copy says so in words rather than leaving the reader to
 * infer it from two unchecked boxes. A tax figure that quietly omits something
 * is worse than one that omits it loudly: the user cannot audit an exclusion
 * they were never told about.
 *
 * The toggles are edit-mode gated because switching one moves every advance-tax
 * figure at once — the same reason replacing an income profile is gated.
 */
function IncomeInclusionsCard() {
  const editMode = useEditMode();
  const [state, setState] = useState<IncomeInclusionsState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await api.incomeInclusions();
    if (result.ok) setState(result.value);
    else setError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (key: keyof IncomeInclusions): Promise<void> => {
      if (state === undefined || saving) return;
      setSaving(true);
      setError(undefined);
      const next = { ...state.inclusions, [key]: !state.inclusions[key] };
      const result = await api.saveIncomeInclusions(next);
      setSaving(false);
      if (result.ok) setState(result.value);
      else setError(result.error.message);
    },
    [saving, state],
  );

  const inclusions = state?.inclusions;
  const enabled = state?.enabled ?? [];

  return (
    <Card
      title="What counts as income"
      action={
        <Chip>
          {state === undefined
            ? 'Loading'
            : enabled.length === 0
              ? 'Defaults'
              : `${String(enabled.length)} added`}
        </Chip>
      }
    >
      <p className="pt-muted">
        Hand-loan interest and chit-fund returns are <strong>excluded</strong> from tax
        calculations unless you turn them on here. Both are positions that depend on facts this
        application does not have — whether you are taxed on receipt or on accrual, and whether a
        chit surplus is income at all — so it declines to decide either for you.
      </p>
      <p className="pt-muted">
        They are counted in net worth either way. This setting changes what is taxed, not what you
        are shown to own.
      </p>

      {inclusions !== undefined && (
        <div className="pt-form">
          <label className="pt-check">
            <input
              type="checkbox"
              checked={inclusions.handLoanInterest}
              disabled={saving || !editMode.enabled}
              data-testid="include-hand-loan-interest"
              onChange={() => void toggle('handLoanInterest')}
            />
            <span>
              Tax interest accrued on hand loans given out
            </span>
          </label>
          <label className="pt-check">
            <input
              type="checkbox"
              checked={inclusions.chitFundReturns}
              disabled={saving || !editMode.enabled}
              data-testid="include-chit-fund-returns"
              onChange={() => void toggle('chitFundReturns')}
            />
            <span>Tax dividends and surplus arising on chit funds</span>
          </label>
          <label className="pt-check">
            <input
              type="checkbox"
              checked={inclusions.sellToCoverGains}
              disabled={saving || !editMode.enabled}
              data-testid="include-sell-to-cover"
              onChange={() => void toggle('sellToCoverGains')}
            />
            <span>
              Tax shares sold on vest day to cover withholding{' '}
              <em>(sell-to-cover)</em>
            </span>
          </label>
        </div>
      )}

      {inclusions?.sellToCoverGains === false && (
        <p className="pt-muted">
          Sell-to-cover is sold same-day at roughly the vest price, so the gain is usually a
          rounding error. It stops being one when the vest and the sale fall either side of a
          month end — the two Rule 115 rates then differ, and the amount left out is the whole
          proceeds times that movement. Those disposals are listed on the Tax screen rather than
          dropped quietly.
        </p>
      )}

      {state !== undefined && enabled.length === 0 && (
        <p className="pt-muted" data-testid="income-inclusions-none">
          Nothing extra is being taxed. Tax figures cover trades, disposals and the income you
          record yourself.
        </p>
      )}

      {/* Not the shared EditModeHint: that one sends the reader to Settings,
          and they are already on it — the switch is the card above this one. */}
      {!editMode.enabled && (
        <p className="pt-muted" data-testid="income-inclusions-locked">
          Turn on edit mode above to change these. Switching one moves every tax figure at once.
        </p>
      )}

      {error !== undefined && (
        <p className="pt-error" role="alert" data-testid="income-inclusions-error">
          {error}
        </p>
      )}
    </Card>
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
