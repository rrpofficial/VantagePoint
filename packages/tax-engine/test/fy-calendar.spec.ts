/**
 * US-5.1 — FY / AY calendar utilities (PRD FR-5.1)
 *
 * US-5.2 rule-table tests live in rule-table.spec.ts: they belong to milestone M5
 * and would otherwise stop this M1 file from going cleanly green.
 */
import { describe, it, expect } from 'vitest';
import { FyCalendar } from '@vantagepoint/shared-kernel';

describe('US-5.1 FY / AY calendar', () => {
  describe('Scenario: Financial year derivation', () => {
    it('maps 2026-03-31 to FY 2025-26', () => {
      expect(FyCalendar.financialYearOf('2026-03-31')).toBe('2025-26');
    });

    it('maps 2026-03-31 to AY 2026-27', () => {
      expect(FyCalendar.assessmentYearOf(FyCalendar.financialYearOf('2026-03-31'))).toBe('2026-27');
    });

    it('maps 2026-04-01 to FY 2026-27', () => {
      expect(FyCalendar.financialYearOf('2026-04-01')).toBe('2026-27');
    });

    it('maps 2026-04-01 to AY 2027-28', () => {
      expect(FyCalendar.assessmentYearOf(FyCalendar.financialYearOf('2026-04-01'))).toBe('2027-28');
    });

    it('starts FY 2025-26 on 2025-04-01 and ends it on 2026-03-31', () => {
      expect(FyCalendar.fyStart('2025-26')).toBe('2025-04-01');
      expect(FyCalendar.fyEnd('2025-26')).toBe('2026-03-31');
    });
  });

  describe('Scenario: Advance tax quarter boundaries', () => {
    it.each([
      ['Q1', '2025-06-15', '15'],
      ['Q2', '2025-09-15', '45'],
      ['Q3', '2025-12-15', '75'],
      ['Q4', '2026-03-15', '100'],
    ] as const)('%s is due %s at %s%% cumulative', (quarter, dueDate, pct) => {
      expect(FyCalendar.advanceTaxDueDate('2025-26', quarter)).toBe(dueDate);
      expect(Number(FyCalendar.cumulativePercentage(quarter))).toBe(Number(pct));
    });
  });

  describe('ADR-008: IST end-of-day boundaries', () => {
    it('resolves 31-Mar-2026 EOD to 2026-03-31T23:59:59.999+05:30', () => {
      expect(FyCalendar.endOfDayIst('2026-03-31')).toBe('2026-03-31T23:59:59.999+05:30');
    });
  });
});
