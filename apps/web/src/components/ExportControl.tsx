/**
 * The export control every register shares (Phase 7).
 *
 * One component rather than a pair of links per screen, because the part that
 * must not drift is the **PII choice**: a borrower's name and a property's
 * street address live in the vault in the clear and are replaced by opaque
 * references in anything that leaves (ADR-013). An export is a file the user
 * will email, so the choice is made here, visibly, before the download — never
 * by a default they did not see.
 *
 * The checkbox is OFF to start. That is the conservative direction: a masked
 * file that turns out to need names is re-exported in a click, while a file with
 * names in it that has already been sent cannot be recalled.
 */
import { useState } from 'react';
import { api } from '../api.js';

export type ExportRegister = 'chits' | 'holdings' | 'property' | 'balances';

export function ExportControl({
  register,
  financialYear,
  filterNote,
  hasPii = true,
  testId,
}: {
  readonly register: ExportRegister;
  /** Holdings only: adds the disposals table, and inherits the filing gate. */
  readonly financialYear?: string;
  /** What the screen is filtered to, stamped into the file. */
  readonly filterNote?: string;
  /** False for a register with no name or address in it, so no toggle is shown. */
  readonly hasPii?: boolean;
  readonly testId?: string;
}) {
  const [includePii, setIncludePii] = useState(false);

  const options = {
    includePii,
    ...(financialYear === undefined ? {} : { financialYear }),
    ...(filterNote === undefined ? {} : { filterNote }),
  };

  return (
    <div className="vp-actions" data-testid={testId ?? `export-${register}`}>
      {hasPii && (
        <label className="vp-check vp-check--inline">
          <input
            type="checkbox"
            checked={includePii}
            data-testid={`${register}-include-pii`}
            onChange={(event) => {
              setIncludePii(event.target.checked);
            }}
          />
          <span>Include names and addresses</span>
        </label>
      )}
      <a
        className="vp-link vp-link--inline"
        href={api.exportUrl(register, 'csv', options)}
        data-testid={`${register}-export-csv`}
        download
      >
        Export CSV
      </a>
      <a
        className="vp-link vp-link--inline"
        href={api.exportUrl(register, 'pdf', options)}
        data-testid={`${register}-export-pdf`}
        download
      >
        Export PDF
      </a>
    </div>
  );
}
