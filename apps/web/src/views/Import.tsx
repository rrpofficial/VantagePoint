/**
 * Import — statement upload.
 *
 * The statement type is chosen explicitly rather than sniffed from the file.
 * The source format determines the asset class, and asset class determines tax
 * treatment: a wrong guess would file a bank balance as equity and the user
 * would have no reason to look.
 *
 * The file is read in the browser and posted as base64. It never touches a
 * temporary path on the host, and a CAMS password is used for this one request
 * and never stored (NFR-1).
 */
import { useCallback, useEffect, useState, type ChangeEvent, type SyntheticEvent } from 'react';
import { api, type ImportReport, type ParserName, type TemplateSummary } from '../api.js';
import { Card, Chip } from '../components/primitives.js';

const PARSERS: readonly { readonly value: ParserName; readonly label: string }[] = [
  { value: 'ZERODHA_TRADEBOOK', label: 'Zerodha tradebook' },
  { value: 'ZERODHA_TAX_PNL', label: 'Zerodha tax P&L' },
  { value: 'CAMS', label: 'CAMS / KFintech statement (PDF)' },
  { value: 'VESTED', label: 'Vested account activity' },
  { value: 'ETRADE', label: 'E*TRADE transaction history' },
  { value: 'ETRADE_GL', label: 'E*TRADE Gains & Losses (Expanded)' },
  { value: 'ETRADE_HOLDINGS', label: 'E*TRADE stock plan holdings (By Status → Sellable)' },
  { value: 'TEMPLATE', label: 'portTrack CSV template' },
];

/** Base64 without loading the whole file into a string first. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function Import({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | undefined>();
  const [parser, setParser] = useState<ParserName>('ZERODHA_TRADEBOOK');
  const [templateName, setTemplateName] = useState('');
  const [password, setPassword] = useState('');
  const [report, setReport] = useState<ImportReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<readonly TemplateSummary[]>([]);

  useEffect(() => {
    void (async () => {
      const result = await api.templates();
      if (result.ok) setTemplates(result.value.templates);
    })();
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (file === undefined) {
      setError('Choose a statement file first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setReport(undefined);

    const result = await api.importStatement({
      file: toBase64(await file.arrayBuffer()),
      fileName: file.name,
      parser,
      ...(password.length === 0 ? {} : { password }),
      // Only meaningful for a template import; blank means "detect".
      ...(parser !== 'TEMPLATE' || templateName.length === 0 ? {} : { templateName }),
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // Cleared immediately: a CAMS password is never held beyond its request.
    setPassword('');
    setReport(result.value);
    onImported();
  }, [file, parser, templateName, password, onImported]);

  const selectedTemplate = templates.find((template) => template.name === templateName);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    setFile(event.target.files?.[0]);
  }

  return (
    <div className="pt-stack">
      <Card title="Import a statement">
        <p className="pt-muted">
          Parsed entirely on this machine. Nothing is uploaded anywhere — the container that reads
          your file has no route to the internet.
        </p>

        <form onSubmit={onSubmit} className="pt-form">
          <label htmlFor="parser">Statement type</label>
          <select
            id="parser"
            value={parser}
            onChange={(event) => {
              setParser(event.target.value as ParserName);
            }}
          >
            {PARSERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {parser === 'TEMPLATE' && (
            <>
              {/*
                Which template, not just "a template". Naming it turns a generic
                "this matches no portTrack template" into a diff of the exact
                columns at fault, and catches a Hand Loans file uploaded under
                Cash — which would otherwise import cleanly as the wrong asset
                class. Left on "detect" it still works; the header decides.
              */}
              <label htmlFor="template">Template</label>
              <select
                id="template"
                value={templateName}
                onChange={(event) => {
                  setTemplateName(event.target.value);
                }}
              >
                <option value="">Detect from the file's header</option>
                {templates.map((template) => (
                  <option key={template.name} value={template.name}>
                    {template.name} — {template.description}
                  </option>
                ))}
              </select>

              {selectedTemplate !== undefined && (
                <p className="pt-muted" data-testid="template-hint">
                  Records <strong>{selectedTemplate.assetClass.replaceAll('_', ' ').toLowerCase()}</strong>.{' '}
                  {selectedTemplate.guidance}{' '}
                  <a href={api.templateUrl(selectedTemplate.name)} download>
                    Download this template
                  </a>
                </p>
              )}
            </>
          )}

          {/*
            The two E*TRADE options read different files from the same account and
            are easy to pick wrongly, so this says which is which at the point of
            choosing rather than failing afterwards on a header mismatch.
          */}
          {parser === 'ETRADE_GL' && (
            <p className="pt-muted" data-testid="etrade-gl-hint">
              The <strong>Gains &amp; Losses (Expanded)</strong> export, where each row is a
              completed sale with its cost basis — not the plain transaction history. Cost is taken
              from <strong>Adjusted Cost Basis</strong>, which already includes the vest or purchase
              value taxed as salary, so that value is not taxed again as capital gain. Each leg is
              converted to rupees at the SBI TT buy rate for the last day of the month before it
              (Rule 115): the vest month for the cost, the sale month for the proceeds.
            </p>
          )}

          {parser === 'ETRADE_GL' && (
            <p className="pt-callout" data-testid="etrade-gl-fifo-note">
              <strong>Gains here will not match the ones printed on the statement.</strong> E*TRADE
              matches each sale to the specific lot it came from; Indian law matches FIFO, oldest
              lot first. Where you hold more than one lot of a symbol the two disagree row by row,
              and converge once everything is sold. The FIFO figure is the one that belongs on a
              return.
            </p>
          )}

          {parser === 'ETRADE_HOLDINGS' && (
            <p className="pt-muted" data-testid="etrade-holdings-hint">
              The <strong>Sellable</strong> tab of the By Status export — the tranches you still
              hold. It pairs with the Gains &amp; Losses file, which covers the ones you have
              already sold; each tranche appears in one or the other, matched on grant and vest
              date, so importing both counts nothing twice. Export Sellable, not Unvested: unvested
              shares are not yours yet and have no cost basis.
            </p>
          )}

          <label htmlFor="statement">Statement file</label>
          <input id="statement" type="file" onChange={onFile} />

          {parser === 'CAMS' && (
            <>
              <label htmlFor="password">PDF password</label>
              <input
                id="password"
                type="password"
                value={password}
                autoComplete="off"
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </>
          )}

          <button type="submit" disabled={busy}>
            {busy ? 'Importing…' : 'Import'}
          </button>
          {error !== undefined && (
            <p className="pt-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </Card>

      <Card title="Manual entry — portTrack CSV templates">
        <p className="pt-muted">
          For everything with no broker export: hand loans, property, cash, chit funds, unlisted
          shares. Download a template, fill it in a spreadsheet, and import it with{' '}
          <strong>portTrack CSV template</strong> selected above. The template is recognised from
          its header row, so leave the header exactly as it is.
        </p>

        <div className="pt-table-scroll">
          <table className="pt-table" data-testid="template-list">
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Records</th>
                <th scope="col">Columns</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 && (
                <tr>
                  <td colSpan={4} className="pt-muted">
                    Loading templates…
                  </td>
                </tr>
              )}
              {templates.map((template) => (
                <tr key={template.name}>
                  <td>
                    <strong>{template.name}</strong>
                    <div className="pt-muted">{template.description}</div>
                  </td>
                  <td>{template.assetClass.replaceAll('_', ' ').toLowerCase()}</td>
                  <td className="pt-hash">{template.columns.join(', ')}</td>
                  <td className="pt-align-end">
                    <a
                      className="pt-link pt-link--inline"
                      href={api.templateUrl(template.name)}
                      download={`${template.name}.csv`}
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {report !== undefined && (
        <Card
          title="Import result"
          action={<Chip>{report.committed ? 'Committed' : 'Nothing committed'}</Chip>}
        >
          <dl className="pt-stats" data-testid="import-summary">
            <div>
              <dt>Created</dt>
              <dd className="pt-numeric">{report.created}</dd>
            </div>
            <div>
              <dt>Duplicates skipped</dt>
              <dd className="pt-numeric">{report.duplicates}</dd>
            </div>
            <div>
              <dt>Rejected</dt>
              <dd className="pt-numeric">{report.rejected}</dd>
            </div>
          </dl>

          {report.errors.length > 0 && (
            <>
              <h3 className="pt-subhead">Rejected rows</h3>
              <div className="pt-table-scroll">
                <table className="pt-table" data-testid="import-errors">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Column</th>
                      <th scope="col">Value</th>
                      <th scope="col">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.errors.map((rowError) => (
                      <tr key={`${String(rowError.row)}-${rowError.column}`}>
                        <td className="pt-numeric">{rowError.row}</td>
                        <td>{rowError.column}</td>
                        <td>{rowError.value}</td>
                        <td>
                          {rowError.reason}
                          {rowError.expectedFormat !== undefined && (
                            <span className="pt-muted"> — expected {rowError.expectedFormat}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {report.unapplied !== undefined && report.unapplied.length > 0 && (
            <>
              <h3 className="pt-subhead">Parsed but not applied</h3>
              <p className="pt-muted">
                These rows were read correctly but could not be placed on the ledger. They are shown
                rather than discarded.
              </p>
              <div className="pt-table-scroll">
                <table className="pt-table" data-testid="import-unapplied">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Date</th>
                      <th scope="col">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.unapplied.map((row) => (
                      <tr key={`${String(row.sourceRow)}-${row.kind}`}>
                        <td className="pt-numeric">{row.sourceRow}</td>
                        <td>{row.kind}</td>
                        <td>{row.date}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
