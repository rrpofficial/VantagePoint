/**
 * Edit mode, as the SPA sees it.
 *
 * One piece of state for the whole application rather than a flag per screen.
 * The user turns it on once, in Settings, and every tab honours it — a Loans tab
 * that still hid its delete button after the mode was enabled elsewhere would be
 * indistinguishable from the feature not working.
 *
 * What this does is REVEAL controls, not permit changes. The server refuses a
 * gated call whatever the browser believes (see `packages/app-services/src/
 * edit-mode.ts`), so this context being wrong can only mean a button is shown
 * that then fails honestly — never that something is changed which should not
 * have been.
 *
 * Read from the server at mount rather than assumed off. The API process outlives
 * a page reload, so a refresh in the middle of a session must come back with the
 * mode the session actually has.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type EditModeState } from './api.js';

interface EditModeContextValue extends EditModeState {
  /** False until the first read returns, so nothing flashes the wrong state. */
  readonly loaded: boolean;
  readonly refresh: () => Promise<void>;
  readonly enable: (passphrase: string) => Promise<string | undefined>;
  readonly disable: () => Promise<void>;
}

const EditModeContext = createContext<EditModeContextValue>({
  enabled: false,
  loaded: false,
  refresh: () => Promise.resolve(),
  enable: () => Promise.resolve('edit mode is unavailable'),
  disable: () => Promise.resolve(),
});

export function EditModeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditModeState>({ enabled: false });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const result = await api.editMode();
    // A failed read leaves the mode reported as OFF. That is the safe direction:
    // it hides controls that would have failed at the server anyway.
    setState(result.ok ? result.value : { enabled: false });
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Resolves to an error message, or undefined when the mode is now on. */
  const enable = useCallback(async (passphrase: string): Promise<string | undefined> => {
    const result = await api.enableEditMode(passphrase);
    if (!result.ok) {
      return result.error.code === 'TIMEOUT'
        ? 'The vault did not respond. It may still be busy — wait a moment and try again.'
        : 'That passphrase did not enable edit mode.';
    }
    setState(result.value);
    return undefined;
  }, []);

  const disable = useCallback(async (): Promise<void> => {
    const result = await api.disableEditMode();
    setState(result.ok ? result.value : { enabled: false });
  }, []);

  const value = useMemo<EditModeContextValue>(
    () => ({ ...state, loaded, refresh, enable, disable }),
    [state, loaded, refresh, enable, disable],
  );

  return <EditModeContext.Provider value={value}>{children}</EditModeContext.Provider>;
}

export const useEditMode = (): EditModeContextValue => useContext(EditModeContext);

/**
 * Shown in place of a hidden edit or delete control, so the absence of the
 * control is explained rather than looking like a missing feature.
 */
export function EditModeHint({ action }: { action: string }) {
  return (
    <p className="vp-muted" data-testid="edit-mode-hint">
      Turn on edit mode under Settings to {action}.
    </p>
  );
}
