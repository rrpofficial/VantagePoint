/**
 * The delete affordance, shared by every tab that has one.
 *
 * One component rather than a per-view button, so the confirmation, the busy
 * state and the wording cannot drift apart between screens — a delete that asks
 * differently on the Ledger than on Loans teaches the user to stop reading it.
 *
 * Two deliberate properties:
 *
 *  - **It arms, then deletes.** The first click reveals what is about to go and
 *    a confirm button; nothing is sent until the second. Edit mode already made
 *    this session deliberate, but a single stray click still lands on a row, and
 *    a row is the thing being removed.
 *  - **It renders nothing when edit mode is off.** The caller does not test for
 *    that — every call site forgetting to is how a gated control leaks back in.
 */
import { useCallback, useState } from 'react';
import type { ApiResult } from '../api.js';
import { useEditMode } from '../edit-mode.js';

export function DeleteControl({
  label,
  describes,
  testId,
  onDelete,
  onDeleted,
  withReason = false,
}: {
  /** The button's own text, e.g. "Delete loan". */
  readonly label: string;
  /** What is about to be removed, in the user's terms. Shown in the confirmation. */
  readonly describes: string;
  readonly testId: string;
  readonly onDelete: (reason?: string) => Promise<ApiResult<unknown>>;
  readonly onDeleted: () => void;
  /** Loans only: the reason is written to the audit trail, which outlives them. */
  readonly withReason?: boolean;
}) {
  const editMode = useEditMode();
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const confirm = useCallback(async (): Promise<void> => {
    if (deleting) return;
    setError(undefined);
    setDeleting(true);
    try {
      const result = await onDelete(reason.trim().length === 0 ? undefined : reason.trim());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setArmed(false);
      setReason('');
      onDeleted();
    } finally {
      // In `finally` so a thrown request cannot strand the button disabled.
      setDeleting(false);
    }
  }, [deleting, onDelete, onDeleted, reason]);

  if (!editMode.enabled) return null;

  if (!armed) {
    return (
      <button
        type="button"
        className="vp-button-inline vp-button-inline--danger"
        data-testid={testId}
        onClick={() => {
          setArmed(true);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      className="vp-callout vp-callout--warn"
      role="alertdialog"
      aria-label={label}
      data-testid={`${testId}-confirm`}
    >
      <p className="vp-subhead">Delete {describes}?</p>
      <p className="vp-muted">
        This removes it from the vault permanently. There is no undo inside VantagePoint — the only way
        back is a restore from your own backup of the data directory.
      </p>

      {withReason && (
        <div className="vp-form">
          <label htmlFor={`${testId}-reason`}>Reason (recorded in the audit trail)</label>
          <input
            id={`${testId}-reason`}
            type="text"
            value={reason}
            disabled={deleting}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </div>
      )}

      <div className="vp-actions">
        <button
          type="button"
          className="vp-button-inline vp-button-inline--danger"
          disabled={deleting}
          data-testid={`${testId}-yes`}
          onClick={() => void confirm()}
        >
          {deleting ? 'Deleting…' : 'Yes, delete it'}
        </button>
        <button
          type="button"
          className="vp-button-inline"
          disabled={deleting}
          data-testid={`${testId}-no`}
          onClick={() => {
            setArmed(false);
            setError(undefined);
          }}
        >
          Cancel
        </button>
      </div>

      {error !== undefined && (
        <p className="vp-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
