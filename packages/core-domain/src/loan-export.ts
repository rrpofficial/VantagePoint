/**
 * Exporting the hand-loan register (requirement 5: CSV and PDF).
 *
 * Both formats carry the same columns as the spreadsheet this replaces, so a
 * lender can hand the file to an accountant or a borrower and it reads the way
 * their existing record did.
 *
 * **Exports carry the borrower's NAME.** That is the point of the file — a
 * register full of `brw_85e56cdc` is useless to the person reading it. It is
 * also why the export is a deliberate, user-initiated act rather than something
 * the app does on its own, and why nothing here is ever sent anywhere: the
 * bytes are handed to the browser, and where they go next is the user's choice.
 * The opaque reference is exported alongside so a row can still be tied back to
 * a masked payload.
 *
 * The PDF is written by hand rather than pulled from a library: egress is denied
 * by default (ADR-010), so a new dependency is a structural decision, and the
 * subset needed here — one font, a table, page breaks — is small enough that
 * owning it is cheaper than owning a supply-chain risk.
 */
import type { LoanTotals, LoanView } from './loan-book.js';

const COLUMNS = [
  'Borrower Name',
  'Borrower Ref',
  'Notes & Comments',
  'Loan Date',
  'Closed Date',
  'Loan Amount',
  'Status',
  'Interest Rate',
  'Principal Repaid',
  'Outstanding Principal',
  'Total Interest Months',
  'Interest Balance Months',
  'Interest / Month',
  'Total Overall Interest',
  'Interest Paid',
  'Interest Balance',
  'Interest Payments',
] as const;

const STATUS_LABEL: Readonly<Record<LoanView['status'], string>> = {
  ACTIVE: 'Active',
  PARTIALLY_REPAID: 'Partially Repaid',
  REPAID: 'Repaid',
};

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Every payment in one cell, as `date:amount(mode)`.
 *
 * The spreadsheet had four fixed payment columns and silently lost the fifth. A
 * single cell holds as many as there are, and stays readable in a spreadsheet.
 */
function paymentsCell(view: LoanView): string {
  return view.interestPayments
    .map((payment) => `${payment.date}:${payment.amount.amount}(${payment.mode})`)
    .join('; ');
}

function rowOf(view: LoanView): readonly string[] {
  return [
    view.borrowerName,
    view.borrowerRef,
    view.notes,
    view.loanDate,
    view.closedDate ?? '',
    view.principal.amount,
    STATUS_LABEL[view.status],
    view.interestRatePct,
    view.principalRepaid.amount,
    view.outstandingPrincipal.amount,
    String(view.totalInterestMonths),
    view.interestBalanceMonths,
    view.interestPerMonth.amount,
    view.totalInterestAccrued.amount,
    view.interestPaid.amount,
    view.interestBalance.amount,
    paymentsCell(view),
  ];
}

export function toCsv(input: {
  readonly loans: readonly LoanView[];
  readonly totals: LoanTotals;
}): string {
  const lines = [
    COLUMNS.join(','),
    ...input.loans.map((view) => rowOf(view).map(csvCell).join(',')),
  ];

  // A totals row, labelled, so a reader cannot mistake it for another loan.
  lines.push('');
  lines.push(
    [
      'TOTAL',
      '',
      `${String(input.totals.loanCount)} loan(s)`,
      '',
      '',
      input.totals.totalPrincipal.amount,
      '',
      '',
      '',
      input.totals.totalOutstanding.amount,
      '',
      '',
      '',
      input.totals.totalInterestAccrued.amount,
      input.totals.totalInterestPaid.amount,
      input.totals.pendingInterestTotal.amount,
      '',
    ]
      .map(csvCell)
      .join(','),
  );
  lines.push(
    ['PENDING INTEREST — ACTIVE', '', input.totals.pendingInterestActive.amount].map(csvCell).join(','),
  );
  lines.push(
    ['PENDING INTEREST — PRINCIPAL REPAID', '', input.totals.pendingInterestRepaid.amount]
      .map(csvCell)
      .join(','),
  );

  return `${lines.join('\n')}\n`;
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
const ROWS_PER_PAGE = 30;

/** Column widths, in points, summing to the printable width. */
const PDF_COLUMNS: readonly { readonly label: string; readonly width: number }[] = [
  { label: 'Borrower', width: 120 },
  { label: 'Loan Date', width: 62 },
  { label: 'Status', width: 82 },
  { label: 'Amount', width: 78 },
  { label: 'Outstanding', width: 78 },
  { label: 'Rate', width: 34 },
  { label: 'Interest', width: 74 },
  { label: 'Paid', width: 74 },
  { label: 'Balance', width: 74 },
  { label: 'Months', width: 44 },
];

function pdfRow(view: LoanView): readonly string[] {
  return [
    view.borrowerName,
    view.loanDate,
    STATUS_LABEL[view.status],
    view.principal.amount,
    view.outstandingPrincipal.amount,
    `${view.interestRatePct}%`,
    view.totalInterestAccrued.amount,
    view.interestPaid.amount,
    view.interestBalance.amount,
    String(view.totalInterestMonths),
  ];
}

function drawRow(cells: readonly string[], y: number, bold: boolean): string {
  const font = bold ? '/F2' : '/F1';
  let x = MARGIN;
  const parts: string[] = [];

  cells.forEach((cell, index) => {
    const column = PDF_COLUMNS[index];
    if (column === undefined) return;
    // Truncated rather than wrapped: a register is scanned down its columns, and
    // a wrapped name would misalign every row beneath it.
    const width = Math.max(1, Math.floor(column.width / 5));
    const text = cell.length > width ? `${cell.slice(0, width - 1)}…` : cell;
    parts.push(`BT ${font} 8 Tf ${String(x)} ${String(y)} Td (${pdfText(text)}) Tj ET`);
    x += column.width;
  });

  return parts.join('\n');
}

function contentStreamFor(
  loans: readonly LoanView[],
  totals: LoanTotals,
  pageIndex: number,
  pageCount: number,
  generatedOn: string,
): string {
  const parts: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  parts.push(
    `BT /F2 13 Tf ${String(MARGIN)} ${String(y)} Td (VantagePoint — Hand Loan Register) Tj ET`,
  );
  y -= LINE + 2;
  parts.push(
    `BT /F1 8 Tf ${String(MARGIN)} ${String(y)} Td (As at ${pdfText(generatedOn)}   ·   page ${String(
      pageIndex + 1,
    )} of ${String(pageCount)}) Tj ET`,
  );
  y -= LINE + 6;

  parts.push(drawRow(PDF_COLUMNS.map((column) => column.label), y, true));
  y -= 4;
  parts.push(`${String(MARGIN)} ${String(y)} m ${String(PAGE_WIDTH - MARGIN)} ${String(y)} l S`);
  y -= LINE;

  for (const view of loans) {
    parts.push(drawRow(pdfRow(view), y, false));
    y -= LINE;
  }

  // Totals on the last page only, or they would read as a per-page subtotal.
  if (pageIndex === pageCount - 1) {
    y -= 6;
    parts.push(`${String(MARGIN)} ${String(y)} m ${String(PAGE_WIDTH - MARGIN)} ${String(y)} l S`);
    y -= LINE;
    parts.push(
      drawRow(
        [
          `${String(totals.loanCount)} loan(s)`,
          '',
          'TOTAL',
          totals.totalPrincipal.amount,
          totals.totalOutstanding.amount,
          '',
          totals.totalInterestAccrued.amount,
          totals.totalInterestPaid.amount,
          totals.pendingInterestTotal.amount,
          '',
        ],
        y,
        true,
      ),
    );
    y -= LINE + 4;
    parts.push(
      `BT /F1 8 Tf ${String(MARGIN)} ${String(y)} Td (Pending interest — active loans: ${pdfText(
        totals.pendingInterestActive.amount,
      )}     Pending interest — principal already repaid: ${pdfText(
        totals.pendingInterestRepaid.amount,
      )}) Tj ET`,
    );
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
export function toPdf(input: {
  readonly loans: readonly LoanView[];
  readonly totals: LoanTotals;
  readonly generatedOn: string;
}): Uint8Array {
  const pages: (readonly LoanView[])[] = [];
  for (let index = 0; index < input.loans.length; index += ROWS_PER_PAGE) {
    pages.push(input.loans.slice(index, index + ROWS_PER_PAGE));
  }
  // An empty register still produces a page saying so, rather than a file a
  // reader refuses to open.
  if (pages.length === 0) pages.push([]);

  const pageCount = pages.length;
  const firstPageObj = 5;
  const pageIds = pages.map((_, index) => firstPageObj + index * 2);

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(
      pageCount,
    )} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  ];

  pages.forEach((rows, index) => {
    const content = contentStreamFor(rows, input.totals, index, pageCount, input.generatedOn);
    // Page objects are allocated in pairs from `firstPageObj`, so the content
    // stream for page n is always its page object plus one.
    const contentId = firstPageObj + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(contentId)} 0 R >>`,
    );
    objects.push(`<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`);
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
