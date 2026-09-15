/**
 * Edit mode — the session-scoped permission to change or destroy an existing
 * record.
 *
 * Everything VantagePoint holds is a record of money that has already moved. Adding
 * to that is routine and additive: a wrong entry is visible, and correcting it
 * leaves a trail. Changing or deleting one is neither — a mistaken delete looks
 * exactly like a record that was never made, and there is nothing left to notice
 * it by. So the destructive half of the application is off by default and is
 * turned on by an act that cannot happen by accident: re-entering the vault
 * passphrase.
 *
 * Three properties are load-bearing:
 *
 *  1. **It is verified against the vault key itself.** No second secret is
 *     stored for this, so there is nothing to keep in step and nothing extra to
 *     steal — see `Vault.verifyPassphrase`.
 *  2. **It lives in memory only.** A restart, a lock, a crash all leave it off.
 *     Persisting it would turn one deliberate decision into a standing one.
 *  3. **It is enforced here, not in the browser.** The SPA hides the buttons,
 *     which is courtesy; the use cases refuse the call, which is the control. A
 *     UI-only gate is bypassed by anything that speaks HTTP, including the next
 *     careless script written against this API.
 *
 * Deliberately process-wide rather than per-connection. There is exactly one
 * vault and one user (ADR-012), so a per-tab mode would be a distinction with no
 * owner — and would mean the SPA's tabs disagreed about whether an edit is
 * currently allowed, which is precisely what the user asked not to happen.
 */
import { EditModeRequiredError, Err, Ok, type IsoDateTime, type Result } from '@vantagepoint/shared-kernel';
import { Vault } from '@vantagepoint/persistence';
import { currentPorts } from './context.js';

export interface EditModeState {
  readonly enabled: boolean;
  /** When it was turned on, so the UI can say how long it has been open. */
  readonly since?: IsoDateTime;
}

const OFF: EditModeState = { enabled: false };

let state: EditModeState = OFF;
/** The unlock session the mode was granted in. See `current`. */
let grantedIn: number | undefined;

/**
 * The stored flag, discarded unless the vault is still in the session that
 * granted it.
 *
 * `VaultUC.lock` calls `resetEditMode`, and that is the path the API takes — but
 * relying on it alone makes the invariant procedural: it holds only while every
 * present and future caller remembers to lock through that one door. Checking
 * the session id instead makes "edit mode belongs to one unlock" structurally
 * true, whatever did the locking, and closes the case nothing observes at all —
 * a lock followed immediately by an unlock, where `isUnlocked()` reads true
 * again at both ends and a permission would otherwise slip across the gap.
 */
function current(): EditModeState {
  if (state.enabled && Vault.sessionId() !== grantedIn) {
    state = OFF;
    grantedIn = undefined;
  }
  return state;
}

export const EditModeUC = {
  /**
   * Turns edit mode on for the rest of the session.
   *
   * Slow by design — it runs the same Argon2id derivation an unlock does. That
   * is the cost of making this deliberate, and the caller must show it as
   * progress rather than let the screen sit still.
   */
  async enable(passphrase: string): Promise<Result<EditModeState>> {
    if (!Vault.isUnlocked()) {
      return Err(new EditModeRequiredError('the vault must be unlocked before edit mode can be turned on'));
    }

    const verified = await Vault.verifyPassphrase(passphrase);
    if (!verified) {
      // No detail, for the same reason unlock gives none: the response must not
      // tell the difference between a wrong passphrase and an empty one.
      currentPorts().logger.info('edit mode refused');
      return Err(new EditModeRequiredError('that passphrase did not enable edit mode'));
    }

    grantedIn = Vault.sessionId();
    state = { enabled: true, since: currentPorts().clock.now() };
    currentPorts().logger.info('edit mode enabled');
    return Ok(state);
  },

  /** Turned off explicitly. Always succeeds — refusing to close a door is absurd. */
  disable(): EditModeState {
    if (state.enabled) currentPorts().logger.info('edit mode disabled');
    state = OFF;
    grantedIn = undefined;
    return state;
  },

  state: (): EditModeState => current(),

  isEnabled: (): boolean => current().enabled,
};

/**
 * Called when the vault locks. Edit mode cannot outlive the session that
 * authorised it — the passphrase was entered to open one window, not to leave it
 * open for whoever unlocks next.
 */
export function resetEditMode(): void {
  state = OFF;
  grantedIn = undefined;
}

/** The guard every mutating and destroying use case runs before it touches the vault. */
export const requireEditMode = (action: string): Result<void> =>
  current().enabled
    ? Ok(undefined)
    : Err(
        new EditModeRequiredError(
          `edit mode is off, so ${action} was refused; turn it on under Settings and try again`,
        ),
      );
