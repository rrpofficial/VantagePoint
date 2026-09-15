/**
 * Form 16 parser (US-5.3, PRD FR-5.1).
 *
 * Part A carries the quarterly TDS the employer actually deposited; Part B
 * carries the salary computation. They are produced from different systems and
 * genuinely disagree — a mid-year correction statement is the usual cause. That
 * disagreement is surfaced as a reconciliation failure the user must resolve,
 * never silently averaged or preferred, because the advance tax figure depends on
 * which number is right and only the taxpayer can find out.
 *
 * PAN and TAN are PII (FR-7.2): they are stored as opaque references, so a parsed
 * Form 16 can be handed to an AI payload without a PAN riding along.
 */
import {
  Err,
  Money,
  Ok,
  TemplateHeaderMismatchError,
  type FinancialYear,
  type Money as MoneyValue,
  type Quarter,
  type Result,
} from '@vantagepoint/shared-kernel';
import { createHash } from 'node:crypto';
import type { Form16, IncomeProfile } from './types.js';

const INR = 'INR' as const;

/** Opaque, deterministic — enough to match documents, useless to a leak. */
const piiRef = (prefix: string, raw: string): string =>
  `${prefix}_${createHash('sha256').update(raw.trim().toUpperCase()).digest('hex').slice(0, 12)}`;

function amountAfter(text: string, pattern: RegExp): MoneyValue | undefined {
  const match = pattern.exec(text);
  if (match === null) return undefined;
  const raw = match[1];
  if (raw === undefined || !Number.isFinite(Number(raw))) return undefined;
  return Money.of(raw, INR);
}

export function parse(buffer: Uint8Array): Result<Form16> {
  const text = Buffer.from(buffer).toString('utf8');

  const pan = /PAN of the Employee:\s*([A-Z]{5}[0-9]{4}[A-Z])/i.exec(text);
  const tan = /TAN of the Deductor:\s*([A-Z]{4}[0-9]{5}[A-Z])/i.exec(text);
  if (pan === null || tan === null) {
    return Err(
      new TemplateHeaderMismatchError(
        'Form 16 is missing the employee PAN or deductor TAN — the document may not be a Form 16',
      ),
    );
  }

  const grossSalary = amountAfter(text, /Salary as per section 17\(1\)\s+([\d.]+)/i);
  const exemptAllowances = amountAfter(text, /exempt under section 10\s+([\d.]+)/i);
  const chapterVia = amountAfter(text, /Total Chapter VI-A\s+([\d.]+)/i);
  const partBTds = amountAfter(text, /Total Tax Deducted at Source\s+([\d.]+)/i);

  const quarterlyTds: { quarter: Quarter; amount: MoneyValue }[] = [];
  const quarterPattern = /Quarter\s+(Q[1-4])\s+Amount\s+([\d.]+)/gi;
  let quarter: RegExpExecArray | null;
  while ((quarter = quarterPattern.exec(text)) !== null) {
    quarterlyTds.push({
      quarter: (quarter[1] ?? 'Q1').toUpperCase() as Quarter,
      amount: Money.of(quarter[2] ?? '0', INR),
    });
  }
  const partATotal = amountAfter(text, /Total TDS\s+([\d.]+)/i);

  return Ok({
    partA: {
      quarterlyTds,
      totalTds: partATotal ?? Money.zero(INR),
      panRef: piiRef('pan', pan[1] ?? ''),
      tanRef: piiRef('tan', tan[1] ?? ''),
    },
    partB: {
      grossSalary: grossSalary ?? Money.zero(INR),
      exemptAllowances: exemptAllowances ?? Money.zero(INR),
      chapterViaDeductions: chapterVia ?? Money.zero(INR),
      totalTds: partBTds ?? partATotal ?? Money.zero(INR),
    },
  });
}

/**
 * Part A's quarterly TDS must reconcile against Part B's total. A discrepancy
 * blocks the advance tax computation rather than resolving itself: crediting the
 * wrong TDS figure either underpays an instalment (interest under 234B/234C) or
 * overpays it.
 */
export function reconcile(form16: Form16): Result<void> {
  const quarterSum = Money.sum(
    form16.partA.quarterlyTds.map((entry) => entry.amount),
    INR,
  );

  if (!Money.equals(quarterSum, form16.partA.totalTds)) {
    return Err(
      new TemplateHeaderMismatchError(
        `Form 16 Part A quarterly TDS sums to ₹${quarterSum.amount} but its stated total is ` +
          `₹${form16.partA.totalTds.amount}`,
      ),
    );
  }

  if (!Money.equals(form16.partA.totalTds, form16.partB.totalTds)) {
    return Err(
      new TemplateHeaderMismatchError(
        `Form 16 Part A reports ₹${form16.partA.totalTds.amount} of TDS but Part B reports ` +
          `₹${form16.partB.totalTds.amount}. Resolve before computing advance tax.`,
      ),
    );
  }

  return Ok(undefined);
}

export function toIncomeProfile(form16: Form16, fy: FinancialYear): IncomeProfile {
  const startYear = Number(fy.slice(0, 4)) + 1;
  const assessmentYear = `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;

  return {
    financialYear: fy,
    assessmentYear: assessmentYear,
    grossSalary: form16.partB.grossSalary,
    exemptAllowances: form16.partB.exemptAllowances,
    chapterViaDeductions: form16.partB.chapterViaDeductions,
    housePropertyIncome: Money.zero(INR),
    otherSourcesIncome: Money.zero(INR),
    tdsRemitted: form16.partB.totalTds,
    tcsCollected: Money.zero(INR),
  };
}
