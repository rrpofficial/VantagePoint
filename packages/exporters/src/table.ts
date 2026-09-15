/**
 * One export surface, not four ad-hoc ones (Phase 7, §7.2 item 5).
 *
 * `loan-export.ts` already solved the parts that are easy to get wrong — RFC 4180
 * quoting, decimal-string money that never becomes a float, a hand-written PDF
 * with pagination and a generated-on stamp — and it solved them for hand loans
 * only. Chits, holdings and property each needed the same thing, and four copies
 * of a CSV quoter is four places for a comma to corrupt a row.
 *
 * So the mechanics live here and each register supplies **columns and rows**.
 * Nothing in this file knows what a loan or a chit is.
 *
 * ## Money never becomes a float (ADR-002)
 *
 * There is no `Number()` in this file and no arithmetic on an amount. A cell is
 * the decimal string the domain produced, carried to the byte. A CSV cell that
 * round-tripped through a float is a corrupted figure that still looks fine,
 * which is the worst kind.
 *
 * ## The PDF is written by hand, on purpose
 *
 * Egress is denied by default (ADR-010), so a new dependency is a structural
 * decision. The subset needed — one base-14 font, a table, page breaks — is
 * small enough that owning it is cheaper than owning a supply-chain risk.
 */
export interface ExportColumn {
  readonly label: string;
  /** Points in the PDF. Ignored by the CSV, which has no widths. */
  readonly width: number;
  /** Right-aligned in the PDF and marked as a figure. */
  readonly numeric?: boolean;
}

export interface ExportTable {
  readonly title: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly (readonly string[])[];
  /**
   * Rows rendered under a rule at the end, as totals rather than as data. Kept
   * separate so a reader — and a spreadsheet — cannot mistake one for a record.
   */
  readonly totals?: readonly (readonly string[])[];
  /** Lines printed under the title: the as-at date, the filter, the caveats. */
  readonly notes?: readonly string[];
}

/* ---------------------------------------------------------------------- CSV */

/** RFC 4180: quote anything containing a comma, quote or newline. */
export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(table: ExportTable): string {
  const lines: string[] = [];

  // Comment lines, as the import templates use, so a spreadsheet shows the
  // provenance and a re-import ignores it.
  lines.push(`# ${table.title}`);
  for (const note of table.notes ?? []) lines.push(`# ${note}`);
  lines.push(table.columns.map((column) => csvCell(column.label)).join(','));

  for (const row of table.rows) lines.push(row.map(csvCell).join(','));

  if (table.totals !== undefined && table.totals.length > 0) {
    // A blank line, so the totals cannot be read as another record.
    lines.push('');
    for (const total of table.totals) lines.push(total.map(csvCell).join(','));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Several tables in one file, separated by a blank line.
 *
 * What makes a holdings export usable: a summary per holding and a row per LOT
 * are two shapes, and a holdings summary alone cannot support the capital-gains
 * conversation the export usually exists for.
 */
export function toMultiCsv(tables: readonly ExportTable[]): string {
  return tables.map(toCsv).join('\n');
}

/* ---------------------------------------------------------------------- PDF */

/** WinAnsi-safe: a character the base font cannot show would corrupt the text. */
function pdfText(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, '?')
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 28;
const LINE = 14;
const ROWS_PER_PAGE = 28;

function drawRow(
  columns: readonly ExportColumn[],
  cells: readonly string[],
  y: number,
  bold: boolean,
): string {
  const font = bold ? '/F2' : '/F1';
  let x = MARGIN;
  const parts: string[] = [];

  columns.forEach((column, index) => {
    const cell = cells[index] ?? '';
    // Truncated rather than wrapped: a register is scanned down its columns, and
    // a wrapped name would misalign every row beneath it.
    const budget = Math.max(1, Math.floor(column.width / 5));
    const text = cell.length > budget ? `${cell.slice(0, budget - 1)}…` : cell;
    parts.push(`BT ${font} 8 Tf ${String(x)} ${String(y)} Td (${pdfText(text)}) Tj ET`);
    x += column.width;
  });

  return parts.join('\n');
}

interface Page {
  readonly table: ExportTable;
  readonly rows: readonly (readonly string[])[];
  readonly index: number;
  readonly of: number;
}

function paginate(tables: readonly ExportTable[]): readonly Page[] {
  const pages: Page[] = [];
  for (const table of tables) {
    const chunks: (readonly string[])[][] = [];
    for (let at = 0; at < table.rows.length; at += ROWS_PER_PAGE) {
      chunks.push([...table.rows.slice(at, at + ROWS_PER_PAGE)]);
    }
    // An empty register still produces a page saying so, rather than a file a
    // reader refuses to open.
    if (chunks.length === 0) chunks.push([]);
    chunks.forEach((rows, index) => {
      pages.push({ table, rows, index, of: chunks.length });
    });
  }
  return pages;
}

function contentFor(page: Page, generatedOn: string): string {
  const parts: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  parts.push(
    `BT /F2 13 Tf ${String(MARGIN)} ${String(y)} Td (${pdfText(page.table.title)}) Tj ET`,
  );
  y -= LINE + 2;

  // Every PDF is a record, so it is stamped with when it was produced — the
  // reader must be able to tell a current extract from one kept in a folder.
  parts.push(
    `BT /F1 8 Tf ${String(MARGIN)} ${String(y)} Td (Generated ${pdfText(generatedOn)}   ·   page ${String(
      page.index + 1,
    )} of ${String(page.of)}) Tj ET`,
  );
  y -= LINE;

  for (const note of page.table.notes ?? []) {
    parts.push(`BT /F1 8 Tf ${String(MARGIN)} ${String(y)} Td (${pdfText(note)}) Tj ET`);
    y -= LINE;
  }
  y -= 4;

  parts.push(drawRow(page.table.columns, page.table.columns.map((column) => column.label), y, true));
  y -= 4;
  parts.push(`${String(MARGIN)} ${String(y)} m ${String(PAGE_WIDTH - MARGIN)} ${String(y)} l S`);
  y -= LINE;

  for (const row of page.rows) {
    parts.push(drawRow(page.table.columns, row, y, false));
    y -= LINE;
  }

  // Totals on the last page of the table only, or they read as a per-page
  // subtotal — which is a different and wrong figure.
  if (page.index === page.of - 1 && page.table.totals !== undefined) {
    y -= 6;
    parts.push(`${String(MARGIN)} ${String(y)} m ${String(PAGE_WIDTH - MARGIN)} ${String(y)} l S`);
    y -= LINE;
    for (const total of page.table.totals) {
      parts.push(drawRow(page.table.columns, total, y, true));
      y -= LINE;
    }
  }

  return parts.join('\n');
}

/**
 * A minimal, valid PDF 1.4: catalog, pages, one page per chunk of rows, two
 * base-14 fonts, and a cross-reference table.
 *
 * Base-14 fonts are referenced rather than embedded, which is what keeps this
 * small enough to hand-write — every conforming reader already has Helvetica.
 */
export function toPdf(
  tables: readonly ExportTable[],
  generatedOn: string,
): Uint8Array {
  const pages = paginate(tables);
  const firstPageObj = 5;
  const pageIds = pages.map((_, index) => firstPageObj + index * 2);

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(
      pages.length,
    )} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  ];

  pages.forEach((page, index) => {
    const content = contentFor(page, generatedOn);
    // Page objects are allocated in pairs from `firstPageObj`, so the content
    // stream for page n is always its page object plus one.
    const contentId = firstPageObj + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(contentId)} 0 R >>`,
    );
    objects.push(
      `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(
    xrefOffset,
  )}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
