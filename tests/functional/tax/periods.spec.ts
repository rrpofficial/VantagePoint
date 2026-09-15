/**
 * FUNCTIONAL US-5.1 — the financial, assessment and calendar years the UI offers.
 *
 * These are derived on the server from the injected clock, never in the browser.
 * A client one timezone west decides it is still 31 March while the server has
 * moved into the next financial year; the year picker would then disagree with
 * the engine computing the tax, and neither would look wrong on its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { FyCalendar } from '@porttrack/shared-kernel';
import { ReferenceUC, configure, resetPorts } from '@porttrack/app-services';

/** Freezes the clock so "current year" assertions are not calendar-dependent. */
function on(today: string): void {
  configure({ clock: { today: () => today, now: () => `${today}T12:00:00.000+05:30` } });
}

afterEach(() => {
  resetPorts();
});

describe('Scenario: The current financial year is offered and marked', () => {
  it('offers the current FY first', () => {
    on('2026-08-04');
    const periods = ReferenceUC.periods();

    expect(periods.currentFinancialYear).toBe('2026-27');
    expect(periods.financialYears[0]?.financialYear).toBe('2026-27');
    expect(periods.financialYears[0]?.isCurrent).toBe(true);
  });

  it('rolls into the new FY on 1 April, not 1 January', () => {
    on('2026-03-31');
    expect(ReferenceUC.periods().currentFinancialYear).toBe('2025-26');

    on('2026-04-01');
    expect(ReferenceUC.periods().currentFinancialYear).toBe('2026-27');
  });

  it('marks exactly one year as current', () => {
    on('2026-08-04');
    const current = ReferenceUC.periods().financialYears.filter((year) => year.isCurrent);
    expect(current).toHaveLength(1);
  });

  it('offers preceding years too, in descending order', () => {
    on('2026-08-04');
    const years = ReferenceUC.periods().financialYears.map((year) => year.financialYear);
    expect(years).toEqual(['2026-27', '2025-26', '2024-25', '2023-24', '2022-23']);
  });
});

describe('Scenario: The assessment year is the year AFTER the financial year', () => {
  it('reports AY 2027-28 for FY 2026-27', () => {
    on('2026-08-04');
    const periods = ReferenceUC.periods();
    expect(periods.currentAssessmentYear).toBe('2027-28');
  });

  it('never repeats the financial year as the assessment year', () => {
    on('2026-08-04');
    // The bug this pins: income earned in FY 2025-26 is assessed in AY 2026-27,
    // and labelling a return with the wrong year is a filing error, not a
    // cosmetic one.
    for (const year of ReferenceUC.periods().financialYears) {
      expect(year.assessmentYear).not.toBe(year.financialYear);
      expect(year.assessmentYear).toBe(FyCalendar.assessmentYearOf(year.financialYear));
    }
  });
});

describe('Scenario: Years without a rule set are offered but flagged', () => {
  /*
   * Asserted against a year that genuinely ships no rule set, rather than
   * against "the current year". It used to name 2026-27, which stopped being an
   * example the moment that year was added — and a test that only passes while a
   * gap exists is a test that expires.
   */
  it('marks a year with no rates as unavailable rather than hiding it', () => {
    on('2026-08-04');
    const periods = ReferenceUC.periods();

    const unsupported = periods.financialYears.find((year) => year.financialYear === '2023-24');
    // Hiding it would leave a user hunting for the year they want; flagging it
    // explains why nothing computes.
    expect(unsupported?.rulesAvailable).toBe(false);
    expect(unsupported?.rulesStatus).toBeUndefined();
  });

  /*
   * FY 2026-27 is the first year under the Income-tax Act 2025, and its rates
   * are transcribed from Bills rather than from enacted text — so it is offered,
   * computes, and still carries PROVISIONAL.
   */
  it('offers the first Income-tax Act 2025 year, flagged provisional', () => {
    on('2026-08-04');

    const current = ReferenceUC.periods().financialYears.find(
      (year) => year.financialYear === '2026-27',
    );

    expect(current?.rulesAvailable).toBe(true);
    expect(current?.rulesStatus).toBe('PROVISIONAL');
  });

  it('reports the status of a year that does have rates', () => {
    on('2026-08-04');
    const available = ReferenceUC.periods().financialYears.find(
      (year) => year.financialYear === '2025-26',
    );
    expect(available?.rulesAvailable).toBe(true);
    expect(available?.rulesStatus).toBe('PROVISIONAL');
  });
});

describe('Scenario: The current calendar year is offered for Schedule FA', () => {
  it('includes the current year and marks it incomplete', () => {
    on('2026-08-04');
    const periods = ReferenceUC.periods();

    expect(periods.currentCalendarYear).toBe(2026);
    const current = periods.calendarYears[0];
    expect(current?.calendarYear).toBe(2026);
    expect(current?.isCurrent).toBe(true);
    // Schedule FA reports the 31-December position, which a running year has not
    // reached — offered so it can be found, flagged so it is not filed blind.
    expect(current?.isComplete).toBe(false);
  });

  it('marks every preceding year complete', () => {
    on('2026-08-04');
    const past = ReferenceUC.periods().calendarYears.filter((year) => !year.isCurrent);
    expect(past.every((year) => year.isComplete)).toBe(true);
    expect(past.map((year) => year.calendarYear)).toEqual([2025, 2024, 2023, 2022]);
  });
});

describe('Scenario: Offering a period and defaulting to it are separate decisions', () => {
  /*
   * Now that FY 2026-27 ships a rule set, the current year IS computable and the
   * default follows it. The rule being asserted is unchanged — default to the
   * most recent year that can actually be computed — but the answer moved when
   * the rates arrived, which is the behaviour working rather than breaking.
   */
  it('defaults to the most recent year that can actually be computed', () => {
    on('2026-08-04');
    const periods = ReferenceUC.periods();

    expect(periods.currentFinancialYear).toBe('2026-27');
    expect(periods.defaultFinancialYear).toBe('2026-27');
  });

  it('still offers the current year even when it is not the default', () => {
    on('2026-08-04');
    const offered = ReferenceUC.periods().financialYears.map((year) => year.financialYear);
    expect(offered).toContain('2026-27');
  });

  it('defaults to the current FY once that year has rates', () => {
    // Self-correcting: adding an FY 2025-26 rule set makes it the default the
    // moment it exists, with no code change.
    on('2025-06-01');
    const periods = ReferenceUC.periods();
    expect(periods.currentFinancialYear).toBe('2025-26');
    expect(periods.defaultFinancialYear).toBe('2025-26');
  });

  it('defaults the calendar year to the last COMPLETE one', () => {
    on('2026-08-04');
    const periods = ReferenceUC.periods();
    expect(periods.currentCalendarYear).toBe(2026);
    expect(periods.defaultCalendarYear).toBe(2025);
  });

  it('never defaults to a period absent from its own list', () => {
    for (const today of ['2026-08-04', '2025-06-01', '2030-01-15', '2020-04-01']) {
      on(today);
      const periods = ReferenceUC.periods();
      expect(periods.financialYears.map((year) => year.financialYear)).toContain(
        periods.defaultFinancialYear,
      );
      expect(periods.calendarYears.map((year) => year.calendarYear)).toContain(
        periods.defaultCalendarYear,
      );
    }
  });
});

describe('Scenario: Periods follow the injected clock, not the host', () => {
  it('reports a different current year for a different today', () => {
    on('2024-06-01');
    expect(ReferenceUC.periods().currentFinancialYear).toBe('2024-25');
    expect(ReferenceUC.periods().currentCalendarYear).toBe(2024);

    on('2030-01-15');
    expect(ReferenceUC.periods().currentFinancialYear).toBe('2029-30');
    expect(ReferenceUC.periods().currentCalendarYear).toBe(2030);
  });
});
