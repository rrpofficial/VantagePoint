/**
 * US-8.5 — Application shell UI  ·  US-9.7 — E2E against the containerized stack
 *
 * Playwright, against the compose stack (http://localhost:${PORTTRACK_WEB_PORT}),
 * so this exercises the real containers rather than a dev server.
 *
 * **Every navigation assertion checks what the section RENDERS, not that a link
 * exists.** The original version asserted only that seven links were visible,
 * which passed against a nav whose links did nothing at all — the acceptance
 * criterion was satisfied to the letter by seven dead anchors.
 *
 * The suite runs in file order against one shared vault, because the journey is
 * cumulative: nothing can be imported before the vault is unlocked, and no
 * snapshot can be compared before something exists to snapshot.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PASSPHRASE = process.env.PORTTRACK_TEST_PASSPHRASE ?? 'correct horse battery staple';

const SECTIONS = [
  'Dashboard',
  'Ledger',
  'Loans',
  'Import',
  'Snapshots',
  'Tax',
  'Compliance',
  'Settings',
] as const;

async function unlock(page: Page): Promise<void> {
  await page.goto('/');

  const passphrase = page.getByLabel('Vault passphrase');
  const nav = page.getByRole('link', { name: 'Dashboard', exact: true });

  // Wait for React to render EITHER state before deciding what to do. A bare
  // `isVisible()` here does not retry, so it answered "false" while the bundle
  // was still mounting, the unlock step was skipped, and the failure surfaced
  // later as a missing nav — nowhere near its cause.
  await expect(passphrase.or(nav).first()).toBeVisible();

  if (await passphrase.isVisible()) {
    await passphrase.fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(nav).toBeVisible();
}

async function goToSection(page: Page, section: string): Promise<void> {
  await page.getByRole('link', { name: section, exact: true }).click();
}

/**
 * Turns on edit mode, which every edit, status change and delete is gated on.
 *
 * Idempotent, because the suite shares one API process and one vault: the mode
 * stays on once enabled, so this checks for the form before filling it rather
 * than assuming the state it starts in.
 */
async function enableEditMode(page: Page): Promise<void> {
  await goToSection(page, 'Settings');

  const enable = page.getByTestId('enable-edit-mode');
  const disable = page.getByTestId('disable-edit-mode');
  // Waits for React to render EITHER state before deciding, for the same reason
  // `unlock` does: a bare isVisible() does not retry and answers "false" while
  // the card is still mounting.
  await expect(enable.or(disable).first()).toBeVisible();

  if (await enable.isVisible()) {
    await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
    await enable.click();
  }
  await expect(page.getByTestId('edit-mode-flag')).toBeVisible();
}


test.describe('US-8.5 Scenario: Core navigation exists', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page);
  });

  for (const section of SECTIONS) {
    test(`the ${section} link navigates to the ${section} section`, async ({ page }) => {
      await goToSection(page, section);

      // The URL changed...
      await expect(page).toHaveURL(new RegExp(`#/${section.toLowerCase()}$`));
      // ...the link is marked current...
      await expect(page.getByRole('link', { name: section, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      // ...and the section actually rendered something of its own. This is the
      // assertion the original suite lacked.
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    });
  }

  test('a deep link opens its section directly', async ({ page }) => {
    await unlock(page);
    await page.goto('/#/compliance');
    await expect(page.getByRole('heading', { name: /Schedule FA/i })).toBeVisible();
  });

  test('the back button returns to the previous section', async ({ page }) => {
    await goToSection(page, 'Ledger');
    await goToSection(page, 'Settings');
    await page.goBack();
    await expect(page).toHaveURL(/#\/ledger$/);
  });
});

test.describe('US-8.5 Scenario: The dashboard shows net worth with an asset-class breakdown', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page);
  });

  test('shows net worth in INR', async ({ page }) => {
    await expect(page.getByTestId('net-worth')).toContainText('₹');
  });

  test('shows the asset-class allocation', async ({ page }) => {
    await expect(page.getByTestId('allocation-breakdown')).toBeVisible();
  });

  test('offers a snapshot-comparison entry point', async ({ page }) => {
    await page.getByRole('button', { name: /compare/i }).click();
    await expect(page).toHaveURL(/#\/snapshots$/);
  });
});

test.describe('US-9.7 Scenario: End-to-end journey against the containerized stack', () => {
  test('unlock → import → ledger → snapshot → compare → advance tax', async ({ page }) => {
    await unlock(page);

    /* ------------------------------------------------------------- import */
    await goToSection(page, 'Import');
    await page.getByLabel('Statement type').selectOption('ZERODHA_TRADEBOOK');
    await page.getByLabel('Statement file').setInputFiles('tests/fixtures/zerodha/tradebook.csv');
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    const summary = page.getByTestId('import-summary');
    await expect(summary).toBeVisible();
    // 65 rows in the fixture: 40 buys and 25 sells, all of them fresh the first
    // time this vault sees them.
    await expect(summary).toContainText('65');

    /* ------------------------------------------------------------- ledger */
    await goToSection(page, 'Ledger');
    const ledger = page.getByTestId('ledger-table');
    await expect(ledger).toBeVisible();
    await expect(ledger.getByRole('row')).not.toHaveCount(1);
    // The disposals table only renders when sells were actually applied.
    await expect(page.getByTestId('exit-table')).toBeVisible();

    /* ---------------------------------------------------------- dashboard */
    await goToSection(page, 'Dashboard');
    // The import must have moved net worth off zero, or nothing was committed.
    await expect(page.getByTestId('net-worth')).not.toContainText(/^₹0$/);

    /* ----------------------------------------------------------- snapshot */
    await goToSection(page, 'Snapshots');
    await page.getByRole('button', { name: 'Create snapshot' }).click();
    const snapshots = page.getByTestId('snapshot-list');
    await expect(snapshots).toContainText('CUSTOM');

    /* ------------------------------------------------------------ compare */
    await page.getByRole('button', { name: /compare to live/i }).first().click();
    await expect(page.getByTestId('variance-table')).toBeVisible();

    /* ---------------------------------------------------------------- tax */
    await goToSection(page, 'Tax');
    await page.getByRole('button', { name: 'Compute advance tax' }).click();
    await expect(page.getByTestId('advance-tax-payable')).toContainText('₹');
  });
});

test.describe('US-5.x Scenario: A provisional tax figure never looks filable', () => {
  test('shows the provisional banner wherever a tax figure appears', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Tax');
    await expect(page.getByText(/Provisional tax rates/i).first()).toBeVisible();
  });

  test('says so explicitly when no income has been recorded', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Tax');
    await page.getByRole('button', { name: 'Compute advance tax' }).click();
    // ₹0 from a missing Form 16 is not the same answer as ₹0 from a real one.
    await expect(page.getByTestId('no-income-profile')).toBeVisible();
  });
});

test.describe('US-6.x Scenario: Compliance states why a schedule is unavailable', () => {
  test('explains a missing Schedule AL rather than showing an empty table', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Compliance');
    await page.getByRole('button', { name: 'Generate' }).nth(1).click();

    // No 31-March snapshot exists in this run, and saying so is the correct
    // answer. An empty table would read as "you hold nothing".
    await expect(page.getByRole('alert')).toContainText(/snapshot/i);
  });
});

test.describe('US-8.2 Scenario: The unlock screen shows it is working', () => {
  /**
   * The unlock response is delayed deliberately rather than raced against the
   * real one: the busy window is a few hundred milliseconds, and a test that
   * tries to catch it as it happens is a flake generator.
   */
  async function withSlowUnlock(page: Page, ms: number): Promise<void> {
    await page.route('**/api/vault/unlock', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await route.continue();
    });
  }

  test('disables the button and explains the wait while deriving the key', async ({ page }) => {
    await withSlowUnlock(page, 2000);
    await page.goto('/');

    const passphrase = page.getByLabel('Vault passphrase');
    await expect(passphrase).toBeVisible();
    await passphrase.fill(PASSPHRASE);

    const button = page.getByTestId('unlock-button');
    await button.click();

    // Without this the screen did not change at all, so clicking again was the
    // natural response — and each extra click queued another key derivation.
    await expect(button).toBeDisabled();
    await expect(button).toHaveText(/Unlocking/);
    await expect(page.getByTestId('unlock-progress')).toBeVisible();
    await expect(passphrase).toBeDisabled();

    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a second click cannot queue a second unlock', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/vault/unlock', async (route) => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto('/');
    await page.getByLabel('Vault passphrase').fill(PASSPHRASE);

    const button = page.getByTestId('unlock-button');
    await button.click();
    // Disabled, so these are no-ops — the guard is the point.
    await button.click({ force: true }).catch(() => undefined);
    await button.click({ force: true }).catch(() => undefined);

    await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(attempts).toBe(1);
  });

  test('recovers to a usable form after a wrong passphrase', async ({ page }) => {
    await page.goto('/');
    const passphrase = page.getByLabel('Vault passphrase');
    await expect(passphrase).toBeVisible();

    await passphrase.fill('definitely not the passphrase');
    await page.getByTestId('unlock-button').click();

    await expect(page.getByRole('alert')).toBeVisible();
    // Re-enabled, or a mistyped passphrase would strand the user on a dead form
    // with only a reload to escape.
    await expect(page.getByTestId('unlock-button')).toBeEnabled();
    await expect(passphrase).toBeEnabled();
  });
});

test.describe('US-5.1 Scenario: Year pickers offer the current period', () => {
  /** What the server says today is — the same source the pickers use. */
  async function periods(page: Page) {
    const response = await page.request.get('/api/reference/periods');
    return response.json() as Promise<{
      currentFinancialYear: string;
      currentAssessmentYear: string;
      currentCalendarYear: number;
      defaultFinancialYear: string;
      defaultCalendarYear: number;
      financialYears: { financialYear: string; assessmentYear: string }[];
    }>;
  }

  test('the Tax financial-year picker offers the current FY', async ({ page }) => {
    await unlock(page);
    const { currentFinancialYear } = await periods(page);

    await goToSection(page, 'Tax');
    // Offered, whether or not it is the default: a user looking for the year
    // they are in must be able to find it.
    await expect(
      page.getByLabel('Financial year').getByRole('option', { name: new RegExp(`FY ${currentFinancialYear}`) }),
    ).toHaveCount(1);
  });

  test('opens on a year that can actually be computed', async ({ page }) => {
    await unlock(page);
    const { defaultFinancialYear } = await periods(page);

    await goToSection(page, 'Tax');
    await expect(page.getByLabel('Financial year')).toHaveValue(defaultFinancialYear);

    // And the default must work: computing on first open must not error.
    await page.getByRole('button', { name: 'Compute advance tax' }).click();
    await expect(page.getByTestId('advance-tax-payable')).toContainText('₹');
  });

  test('shows the assessment year as FY + 1, never the FY repeated', async ({ page }) => {
    await unlock(page);
    const data = await periods(page);
    const selected = data.financialYears.find(
      (year) => year.financialYear === data.defaultFinancialYear,
    );
    expect(selected?.assessmentYear).not.toBe(selected?.financialYear);

    await goToSection(page, 'Tax');
    await expect(page.getByTestId('selected-period')).toContainText(
      `FY ${String(selected?.financialYear)} is assessed in AY ${String(selected?.assessmentYear)}`,
    );
  });

  test('the Compliance calendar-year picker offers the current year, flagged as running', async ({
    page,
  }) => {
    await unlock(page);
    const { currentCalendarYear, defaultCalendarYear } = await periods(page);

    await goToSection(page, 'Compliance');
    const picker = page.getByLabel('Calendar year');
    await expect(
      picker.getByRole('option', { name: new RegExp(String(currentCalendarYear)) }),
    ).toHaveCount(1);
    // Defaults to the last COMPLETE year — Schedule FA reports a 31-December
    // position that a running year has not reached.
    await expect(picker).toHaveValue(String(defaultCalendarYear));

    await picker.selectOption(String(currentCalendarYear));
    await expect(page.getByTestId('incomplete-calendar-year')).toContainText(
      String(currentCalendarYear),
    );
  });

  test('the Schedule AL picker offers the current financial year', async ({ page }) => {
    await unlock(page);
    const { currentFinancialYear, defaultFinancialYear } = await periods(page);

    await goToSection(page, 'Compliance');
    const picker = page.getByLabel('Financial year');
    await expect(
      picker.getByRole('option', { name: new RegExp(`FY ${currentFinancialYear}`) }),
    ).toHaveCount(1);
    await expect(picker).toHaveValue(defaultFinancialYear);
    await expect(page.getByTestId('al-assessment-year')).toContainText('AY');
  });
});

test.describe('US-4.6 Scenario: CSV templates are obtainable from the app', () => {
  test('lists a downloadable template for every manual asset class', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Import');

    const list = page.getByTestId('template-list');
    await expect(list).toBeVisible();
    for (const name of [
      'Custom_HandLoans',
      'Custom_RealEstate',
      'Custom_Cash',
      'Custom_ChitFunds',
      'Custom_UnlistedShares',
      'Custom_GenericBroker',
    ]) {
      await expect(list).toContainText(name);
    }
  });

  test('downloads a template whose header the importer accepts', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Import');

    const download = page.waitForEvent('download');
    await page.getByTestId('template-list').getByRole('link', { name: 'Download' }).first().click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Custom_HandLoans.csv');

    // The file must be usable as downloaded — guidance comments and all.
    const path = await file.path();
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('borrower_name,notes,loan_date');
    expect(contents).toContain('# Lines beginning with # are ignored on import');
  });

  test('offers a template dropdown once portTrack CSV template is chosen', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Import');

    // Absent for a broker statement — there is no template to choose.
    await expect(page.getByLabel('Template', { exact: true })).toHaveCount(0);

    await page.getByLabel('Statement type').selectOption('TEMPLATE');
    const picker = page.getByLabel('Template', { exact: true });
    await expect(picker).toBeVisible();

    for (const name of [
      'Custom_HandLoans',
      'Custom_RealEstate',
      'Custom_Cash',
      'Custom_ChitFunds',
      'Custom_UnlistedShares',
      'Custom_GenericBroker',
    ]) {
      await expect(picker.getByRole('option', { name: new RegExp(name) })).toHaveCount(1);
    }

    // Choosing one explains what it records and offers that exact file.
    await picker.selectOption('Custom_Cash');
    const hint = page.getByTestId('template-hint');
    await expect(hint).toContainText('bank balance');
    await expect(hint.getByRole('link', { name: 'Download this template' })).toBeVisible();
  });

  test('says which columns are wrong when the chosen template does not match', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Import');

    await page.getByLabel('Statement type').selectOption('TEMPLATE');
    await page.getByLabel('Template', { exact: true }).selectOption('Custom_Cash');
    await page.getByLabel('Statement file').setInputFiles({
      name: 'cash.csv',
      mimeType: 'text/csv',
      // `balance` is missing.
      buffer: Buffer.from('account_label,as_of_date,currency\nSavings,2026-03-31,INR\n'),
    });
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('balance');
    await expect(alert).toContainText('Custom_Cash');
  });

  test('imports a filled-in template as the asset class it declares', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Import');

    await page.getByLabel('Statement type').selectOption('TEMPLATE');
    await page.getByLabel('Statement file').setInputFiles({
      name: 'cash.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'account_label,as_of_date,balance,currency\nSalary account,2026-03-31,412500,INR\n',
      ),
    });
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByTestId('import-summary')).toBeVisible();
    // Nothing may land in "parsed but not applied" — that was the old behaviour.
    await expect(page.getByTestId('import-unapplied')).toHaveCount(0);

    await goToSection(page, 'Ledger');
    await expect(page.getByTestId('ledger-table')).toContainText('bank balance');
  });
});

test.describe('US-1.11 Scenario: The hand-loan register, end to end', () => {
  /*
   * Fixed and distinct per test, so one test's loans cannot satisfy another's
   * assertions. Deliberately NOT seeded from the clock: a test that reads the
   * wall clock is not reproducible.
   */
  const BORROWERS = {
    journey: 'E2E Journey Borrower',
    filter: 'E2E Filter Borrower',
    export: 'E2E Export Borrower',
    dashboard: 'E2E Dashboard Borrower',
    duplicate: 'E2E Duplicate Borrower',
    edited: 'E2E Edited Borrower',
    cancelled: 'E2E Cancelled Borrower',
  } as const;

  /**
   * Records a loan through the form.
   *
   * A re-run against a vault that already holds these loans now meets the
   * duplicate prompt rather than silently upserting — the whole point of the
   * change — so the helper answers it. `confirm: false` cancels, leaving the
   * loan that is already there; that keeps a second run idempotent, which is
   * what the suite needs to stay re-runnable.
   */
  async function lend(
    page: Page,
    name: string,
    amount: string,
    rate = '12',
    date = '2025-04-01',
    onDuplicate: 'cancel' | 'confirm' = 'cancel',
  ): Promise<void> {
    await page.getByRole('button', { name: 'Record a loan' }).click();
    const form = page.getByTestId('new-loan-form');
    await form.getByLabel('Borrower name').fill(name);
    await form.getByLabel('Loan amount').fill(amount);
    await form.getByLabel('Interest rate %').fill(rate);
    await form.getByLabel('Loan date').fill(date);
    await form.getByRole('button', { name: 'Save loan' }).click();

    const warning = page.getByTestId('duplicate-warning');
    const table = page.getByTestId('loan-table');
    await expect(warning.or(table.getByText(name, { exact: true }).first())).toBeVisible();

    if (await warning.isVisible()) {
      if (onDuplicate === 'confirm') {
        await page.getByTestId('confirm-duplicate').click();
      } else {
        await page.getByRole('button', { name: 'Cancel and go back' }).click();
        // `exact` matters: without it this also matches "Cancel and go back".
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
    }
    await expect(table).toContainText(name);
  }

  test('records a loan, takes interest, then takes part of the principal back', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    const name = BORROWERS.journey;
    await lend(page, name, '1200000');

    // Open the loan's detail.
    await page.getByRole('button', { name, exact: true }).click();
    const detail = page.locator('[data-testid^="loan-detail-"]');
    await expect(detail).toBeVisible();

    /* --------------------------------------------------- interest payment */
    const interestForm = page.locator('[data-testid^="interest-form-"]');
    await interestForm.getByLabel('Amount').fill('36000');
    await interestForm.getByLabel('Date').fill('2025-07-01');
    await interestForm.getByRole('button', { name: 'Record interest' }).click();

    // The detail stays open across the reload; clicking the borrower again
    // would toggle it shut.
    await expect(page.locator('[data-testid^="loan-detail-"]')).toContainText('36,000');
    // Interest must NOT have reduced the principal.
    await expect(page.getByTestId('loan-table')).toContainText('12,00,000');

    /* ------------------------------------------------ principal repayment */
    const principalForm = page.locator('[data-testid^="principal-form-"]');
    await principalForm.getByLabel('Amount').fill('600000');
    await principalForm.getByLabel('Date').fill('2025-10-01');
    await principalForm.getByRole('button', { name: 'Record repayment' }).click();

    // Status follows the principal, and outstanding halves.
    await expect(page.getByTestId('loan-table')).toContainText('Partially repaid');
    await expect(page.getByTestId('loan-table')).toContainText('6,00,000');
  });

  test('splits pending interest between live loans and repaid principal', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    // Both tiles exist and are distinguishable — the whole point of the split.
    await expect(page.getByTestId('tile-pending-active')).toBeVisible();
    await expect(page.getByTestId('tile-pending-repaid')).toBeVisible();
    await expect(page.getByTestId('tile-total-lent')).toContainText('₹');
    await expect(page.getByTestId('tile-outstanding')).toContainText('₹');
  });

  test('filters by status and by borrower, and re-totals as it goes', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    const name = BORROWERS.filter;
    await lend(page, name, '750000');

    const table = page.getByTestId('loan-table');
    await expect(table).toContainText(name);

    // A status the loan cannot have empties the table...
    await page.getByRole('checkbox', { name: 'Repaid', exact: true }).check();
    await expect(table).not.toContainText(name);

    // ...and clearing it brings the loan back. "No filter" means all, not none.
    await page.getByRole('checkbox', { name: 'Repaid', exact: true }).uncheck();
    await expect(table).toContainText(name);

    // By id: every borrower CHECKBOX is labelled with a name, and those names
    // contain the word "Borrower", so a by-label lookup is ambiguous here.
    await page.locator('#borrower-search').fill('nobody-by-this-name');
    await expect(page.getByTestId('loan-empty')).toBeVisible();
    await expect(page.getByTestId('tile-total-lent')).toContainText('₹0');
  });

  test('filters by borrower through a dropdown, not a checkbox per person', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    const name = BORROWERS.filter;
    await lend(page, name, '750000');

    // A checkbox per borrower is unusable once there are many; the list is a
    // dropdown and each choice becomes a removable chip.
    await page.getByLabel('Add', { exact: true }).selectOption(name);
    await expect(page.getByTestId('borrower-chips')).toContainText(name);
    await expect(page.getByTestId('loan-table')).toContainText(name);

    // The chosen borrower leaves the dropdown, so they cannot be added twice.
    await expect(
      page.getByLabel('Add', { exact: true }).getByRole('option', { name, exact: true }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: `Remove ${name} from the filter` }).click();
    await expect(page.getByTestId('borrower-chips')).toHaveCount(0);
  });

  test('shows loans in the Ledger as receivables, not as empty holdings', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');
    await lend(page, BORROWERS.journey, '1200000');

    await goToSection(page, 'Ledger');
    const receivables = page.getByTestId('loans-receivable-table');
    await expect(receivables).toBeVisible();

    // The borrower's name, not the raw asset id it used to fall back to.
    await expect(receivables).toContainText(BORROWERS.journey);
    await expect(receivables).not.toContainText('ast_hand_loan_');

    // And a loan must never appear in Holdings, where every column is
    // meaningless for a receivable: 0 lots, 0 held, ₹0 cost.
    const holdings = page.getByTestId('ledger-table');
    if ((await holdings.count()) > 0) {
      await expect(holdings).not.toContainText(BORROWERS.journey);
    }
  });

  test('a loan recorded now shows on the Dashboard without a reload', async ({ page }) => {
    await unlock(page);

    await goToSection(page, 'Dashboard');
    const netWorth = page.getByTestId('net-worth');
    const before = (await netWorth.textContent()) ?? '';

    await goToSection(page, 'Loans');
    await lend(page, BORROWERS.dashboard, '500000');

    await goToSection(page, 'Dashboard');
    /*
     * The exact reported failure: the valuation was fetched once at unlock, so
     * the Dashboard sat at ₹0 while Loans and Ledger showed the money. Opening
     * the tab must re-value.
     */
    await expect(netWorth).not.toHaveText(before);
    await expect(page.getByTestId('allocation-breakdown')).toContainText('hand loan');
  });

  test('asks before recording a second loan to one borrower on one day', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    const name = BORROWERS.duplicate;
    await lend(page, name, '100000', '12', '2025-05-01');

    // The same borrower, the same day, a different purpose — a real second loan.
    await page.getByRole('button', { name: 'Record a loan' }).click();
    const form = page.getByTestId('new-loan-form');
    await form.getByLabel('Borrower name').fill(name);
    await form.getByLabel('Loan amount').fill('250000');
    await form.getByLabel('Interest rate %').fill('18');
    await form.getByLabel('Loan date').fill('2025-05-01');
    await form.getByRole('button', { name: 'Save loan' }).click();

    // The prompt must show WHICH loan matched, not merely that one did.
    const warning = page.getByTestId('duplicate-warning');
    await expect(warning).toBeVisible();
    await expect(page.getByTestId('duplicate-matches')).toContainText('1,00,000');
    await expect(warning).toContainText('2025-05-01');

    await page.getByTestId('confirm-duplicate').click();

    // Both survive. Before this, the second silently overwrote the first.
    const table = page.getByTestId('loan-table');
    await expect(table).toContainText('1,00,000');
    await expect(table).toContainText('2,50,000');
  });

  test('cancelling the duplicate prompt records nothing', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    // Its own borrower: sharing one with the filter tests made the row count
    // depend on what those tests had already recorded.
    const name = BORROWERS.cancelled;
    await lend(page, name, '800000', '12', '2025-06-01');

    const rowsBefore = await page.getByTestId('loan-table').locator('tbody tr').count();

    await page.getByRole('button', { name: 'Record a loan' }).click();
    const form = page.getByTestId('new-loan-form');
    await form.getByLabel('Borrower name').fill(name);
    await form.getByLabel('Loan amount').fill('800000');
    await form.getByLabel('Interest rate %').fill('12');
    await form.getByLabel('Loan date').fill('2025-06-01');
    await form.getByRole('button', { name: 'Save loan' }).click();

    await expect(page.getByTestId('duplicate-warning')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel and go back' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(page.getByTestId('loan-table').locator('tbody tr')).toHaveCount(rowsBefore);
  });

  test('edits a loan and records what changed in its history', async ({ page }) => {
    await unlock(page);
    // The edit control does not exist until edit mode is on — that is the gate,
    // not a styling choice, so the journey has to open it like a user does.
    await enableEditMode(page);
    await goToSection(page, 'Loans');

    const name = BORROWERS.edited;
    await lend(page, name, '300000', '12', '2025-07-01');

    await page.getByRole('button', { name, exact: true }).click();
    const detail = page.locator('[data-testid^="loan-detail-"]');
    await expect(detail).toBeVisible();

    // The history exists from creation, so the original terms are recoverable.
    await expect(detail.locator('[data-testid^="loan-audit-"]')).toContainText('Recorded');

    await detail.locator('[data-testid^="edit-toggle-"]').click();
    const editForm = detail.locator('[data-testid^="edit-loan-form-"]');
    await editForm.getByLabel('Loan amount').fill('450000');
    await editForm.getByLabel('Reason for this change').fill('amount was mistyped at entry');
    await editForm.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByTestId('loan-table')).toContainText('4,50,000');

    /*
     * The panel is still open, and the trail must refresh in place. Clicking the
     * borrower again would COLLAPSE it — and a trail that only updates when the
     * panel is reopened reads, to the user, as an edit that was not recorded.
     */
    const trail = page.locator('[data-testid^="loan-audit-"]');
    await expect(trail).toContainText('Principal');
    await expect(trail).toContainText('300000');
    await expect(trail).toContainText('450000');
    await expect(trail).toContainText('amount was mistyped at entry');
  });

  test('says when it was valued, rather than claiming to be live', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Dashboard');

    // A "Live" badge asserted freshness the screen did not have.
    await expect(page.getByTestId('revalue')).toContainText(/as at|Refresh/);
    await page.getByTestId('revalue').click();
    await expect(page.getByTestId('revalue')).toContainText(/as at/);
  });

  test('sorts by each field the register offers', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');

    for (const option of ['Borrower', 'Status', 'Loan date', 'Amount']) {
      await page.getByLabel('Sort by').selectOption({ label: option });
      await expect(page.getByTestId('loan-table')).toBeVisible();
    }
    // Direction toggles rather than being a second control to forget.
    await page.getByRole('button', { name: 'Descending' }).click();
    await expect(page.getByRole('button', { name: 'Ascending' })).toBeVisible();
  });

  test('exports the register as CSV and as PDF', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Loans');
    await lend(page, BORROWERS.export, '250000');

    const csv = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export CSV' }).click();
    const csvFile = await csv;
    expect(csvFile.suggestedFilename()).toBe('hand-loans.csv');
    const csvText = readFileSync(await csvFile.path(), 'utf8');
    expect(csvText).toContain('Borrower Name');
    expect(csvText).toContain('PENDING INTEREST — PRINCIPAL REPAID');

    const pdf = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export PDF' }).click();
    const pdfFile = await pdf;
    expect(pdfFile.suggestedFilename()).toBe('hand-loans.pdf');
    const pdfBytes = readFileSync(await pdfFile.path());
    // A real PDF, not an error page with a .pdf name.
    expect(pdfBytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdfBytes.toString('latin1')).toContain('Hand Loan Register');
  });
});

test.describe('US-4.6 Scenario: The hand-loan template carries the full register', () => {
  test('imports a spreadsheet with payments and repayment history', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Import');

    const header = await page.evaluate(async () => {
      const response = await fetch('/api/templates');
      const body = (await response.json()) as {
        templates: { name: string; columns: string[] }[];
      };
      return body.templates.find((t) => t.name === 'Custom_HandLoans')?.columns.join(',') ?? '';
    });
    expect(header).toContain('interest_payment_1');
    expect(header).toContain('principal_repayment_1');
    expect(header).toContain('closed_date');

    const name = 'E2E Sheet Import Borrower';
    const row =
      `${name},House deposit,2025-04-01,,1200000,12,INR,Partially Repaid,` +
      `600000,2025-10-01,,,36000,2025-07-01,,,,,,,,,,,`;

    await page.getByLabel('Statement type').selectOption('TEMPLATE');
    await page.getByLabel('Statement file').setInputFiles({
      name: 'loans.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${header}\n${row}\n`),
    });
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByTestId('import-summary')).toBeVisible();
    await expect(page.getByTestId('import-unapplied')).toHaveCount(0);

    // The imported history must reach the register, not just the ledger.
    await goToSection(page, 'Loans');
    const table = page.getByTestId('loan-table');
    await expect(table).toContainText(name);
    await expect(table).toContainText('Partially repaid');
    await expect(table).toContainText('6,00,000');
  });
});

test.describe('US-4.8 Scenario: A trade is typed in rather than imported', () => {
  async function openTradeForm(page: Page) {
    await unlock(page);
    await goToSection(page, 'Ledger');
    await page.getByRole('button', { name: 'Record a trade', exact: true }).click();
    return page.getByTestId('trade-form');
  }

  async function fill(
    form: ReturnType<Page['getByTestId']>,
    values: {
      kind: string;
      side: 'Buy' | 'Sell';
      identifier: string;
      quantity: string;
      price: string;
      date?: string;
    },
  ): Promise<void> {
    await form.getByLabel('What kind of holding').selectOption({ label: values.kind });
    await form.getByLabel('Buy or sell').selectOption({ label: values.side });
    await form.getByLabel('Trade date').fill(values.date ?? '2025-04-10');
    await form.getByLabel('Quantity or units').fill(values.quantity);
    await form.getByLabel('Price per unit').fill(values.price);
  }

  test('records an equity purchase that appears in Holdings', async ({ page }) => {
    const form = await openTradeForm(page);
    await fill(form, {
      kind: 'Indian listed equity',
      side: 'Buy',
      identifier: 'E2ETRADE',
      quantity: '100',
      price: '1500',
    });
    await form.getByLabel('Symbol or ticker').fill('E2ETRADE');
    await form.getByRole('button', { name: 'Record purchase' }).click();

    const holdings = page.getByTestId('ledger-table');
    await expect(holdings).toContainText('E2ETRADE');
    await expect(holdings).toContainText('100');
  });

  test('asks for a folio rather than a ticker when the holding is a fund', async ({ page }) => {
    const form = await openTradeForm(page);
    await form.getByLabel('What kind of holding').selectOption({ label: 'Mutual fund (equity, debt or hybrid)' });

    // The identifier field follows the asset class: a fund has no ticker, and
    // asking for one invites a scheme name typed into a ticker field.
    await expect(form.getByLabel('Folio number')).toBeVisible();
    await expect(form.getByLabel('Symbol or ticker')).toHaveCount(0);
  });

  test('records a fund purchase against its folio', async ({ page }) => {
    const form = await openTradeForm(page);
    await fill(form, {
      kind: 'Mutual fund (equity, debt or hybrid)',
      side: 'Buy',
      identifier: 'E2E-FOLIO-1',
      quantity: '1543.21',
      price: '64.8812',
    });
    await form.getByLabel('Folio number').fill('E2E-FOLIO-1');
    await form.getByRole('button', { name: 'Record purchase' }).click();

    await expect(page.getByTestId('ledger-table')).toContainText('E2E-FOLIO-1');
  });

  test('asks before recording the same trade twice, then keeps both fills', async ({ page }) => {
    for (const attempt of [1, 2]) {
      const form = await openTradeForm(page);
      await fill(form, {
        kind: 'Indian listed equity',
        side: 'Buy',
        identifier: 'E2EFILL',
        quantity: '25',
        price: '900',
        date: '2025-05-20',
      });
      await form.getByLabel('Symbol or ticker').fill('E2EFILL');
      await form.getByRole('button', { name: 'Record purchase' }).click();

      if (attempt === 2) {
        const warning = page.getByTestId('duplicate-trade-warning');
        await expect(warning).toBeVisible();
        await page.getByTestId('confirm-duplicate-trade').click();
      }
      await expect(page.getByTestId('ledger-table')).toContainText('E2EFILL');
    }

    // Two fills of 25 — the holding must read 50, not 25.
    await expect(page.getByTestId('ledger-table')).toContainText('50');
  });

  test('explains a sale with nothing to sell instead of inventing a position', async ({ page }) => {
    const form = await openTradeForm(page);
    await fill(form, {
      kind: 'Indian listed equity',
      side: 'Sell',
      identifier: 'E2ENOTHELD',
      quantity: '10',
      price: '100',
      date: '2026-01-05',
    });
    await form.getByLabel('Symbol or ticker').fill('E2ENOTHELD');
    await form.getByRole('button', { name: 'Record sale' }).click();

    await expect(page.getByTestId('trade-unapplied')).toBeVisible();
  });
});

test.describe('US-1.12 Scenario: The chit-fund register, end to end', () => {
  const CHITS = {
    journey: 'E2E Journey Chit',
    withdrawn: 'E2E Withdrawn Chit',
    scheduled: 'E2E Scheduled Chit',
  } as const;
  const ORG = 'E2E Chit Company';

  async function openChit(
    page: Page,
    label: string,
    values: {
      target?: string;
      start?: string;
      months?: string;
      emiType?: string;
      schedule?: string;
    } = {},
  ): Promise<void> {
    await page.getByRole('button', { name: 'Record a chit' }).click();
    const form = page.getByTestId('new-chit-form');
    await form.getByLabel('Chit fund organisation').fill(ORG);
    await form.getByLabel('Chit label').fill(label);
    await form.getByLabel('Chit amount').fill(values.target ?? '500000');
    await form.getByLabel('Start date').fill(values.start ?? '2025-04-01');
    await form.getByLabel('Duration in months').fill(values.months ?? '25');
    if (values.emiType !== undefined) {
      await form.getByLabel('Instalment').selectOption({ label: values.emiType });
    }
    if (values.schedule !== undefined) {
      await form.getByLabel('Withdrawal schedule').selectOption({ label: values.schedule });
    }
    await form.getByRole('button', { name: 'Save chit' }).click();
    await expect(page.getByTestId('chit-table')).toContainText(label);
  }

  async function payInstalment(page: Page, label: string, amount: string, date: string) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const detail = page.locator('[data-testid^="chit-detail-"]');
    await expect(detail).toBeVisible();
    const form = detail.locator('[data-testid^="chit-emi-form-"]');
    await form.getByLabel('Amount').fill(amount);
    await form.getByLabel('Date').fill(date);
    await form.getByRole('button', { name: 'Record instalment' }).click();
    return detail;
  }

  test('records a chit and carries it at what has been paid in', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Chits');

    await openChit(page, CHITS.journey, { target: '500000' });
    await payInstalment(page, CHITS.journey, '20000', '2025-04-05');

    const table = page.getByTestId('chit-table');
    // ₹20,000 counted, against a ₹5,00,000 chit. The face value must never be
    // the asset figure.
    await expect(table).toContainText('20,000');
    await expect(page.getByTestId('chit-carrying')).toContainText('20,000');
    await expect(page.getByTestId('chit-carrying')).not.toContainText('5,00,000');
  });

  test('adds the chit to net worth on the Dashboard', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Dashboard');
    const netWorth = page.getByTestId('net-worth');
    const before = (await netWorth.textContent()) ?? '';

    await goToSection(page, 'Chits');
    await openChit(page, CHITS.scheduled, { target: '1000000' });
    await payInstalment(page, CHITS.scheduled, '35000', '2025-04-05');

    await goToSection(page, 'Dashboard');
    await expect(netWorth).not.toHaveText(before);
    await expect(page.getByTestId('allocation-breakdown')).toContainText('chit fund');
  });

  /*
   * The tiles are portfolio-wide totals, and the suite is cumulative, so a
   * per-chit assertion has to read the chit's OWN row. Asserting on the tile
   * made this test depend on every chit recorded before it.
   */
  const rowFor = (page: Page, label: string) =>
    page.getByTestId('chit-table').locator('tr', { hasText: label }).first();

  test('drops out of net worth once marked withdrawn, and comes back if reversed', async ({
    page,
  }) => {
    await unlock(page);
    // Marking a chit drawn is a status change, so it is gated with the edits.
    await enableEditMode(page);
    await goToSection(page, 'Chits');

    await openChit(page, CHITS.withdrawn, { target: '500000', start: '2025-05-01' });
    const detail = await payInstalment(page, CHITS.withdrawn, '25000', '2025-05-05');
    await expect(rowFor(page, CHITS.withdrawn)).toContainText('25,000');

    /* ------------------------------------------------------------ withdraw */
    const status = detail.locator('[data-testid^="chit-status-form-"]');
    await status.getByLabel('Amount received').fill('420000');
    await status.getByLabel('Date drawn').fill('2025-08-01');
    await detail.locator('[data-testid^="chit-withdraw-"]').click();

    // The pot is now cash elsewhere; counting the instalments too would count
    // the same money twice. Paid-in still reads ₹25,000 — only the asset
    // column goes to nil.
    const row = rowFor(page, CHITS.withdrawn);
    await expect(row).toContainText('Withdrawn');
    await expect(row.locator('td').last()).toHaveText('₹0');

    /* ------------------------------------------------------------- reverse */
    /*
     * The panel is STILL OPEN — recording a status change reloads the register
     * but does not collapse the row, the same way an edited loan keeps its trail
     * on screen. Clicking the chit name again would toggle it SHUT, and the
     * reactivate button would then never appear.
     */
    await detail.locator('[data-testid^="chit-reactivate-"]').click();
    await expect(rowFor(page, CHITS.withdrawn).locator('td').last()).not.toHaveText('₹0');
  });

  test('keeps recording instalments after the pot is drawn', async ({ page }) => {
    await unlock(page);
    await enableEditMode(page);
    await goToSection(page, 'Chits');

    // Its own chit: reusing another test's left the status form showing the
    // reactivate branch instead of the withdraw one, depending on run order.
    const label = 'E2E Still Paying Chit';
    await openChit(page, label, { target: '500000', start: '2025-06-01' });
    const detail = await payInstalment(page, label, '25000', '2025-06-05');

    const status = detail.locator('[data-testid^="chit-status-form-"]');
    await status.getByLabel('Amount received').fill('420000');
    await status.getByLabel('Date drawn').fill('2025-08-01');
    await detail.locator('[data-testid^="chit-withdraw-"]').click();
    await expect(rowFor(page, label)).toContainText('Withdrawn');

    // Drawing early does not end the obligation, so the form must stay usable.
    // Read from the panel that is already open: re-clicking the name closes it.
    const form = detail.locator('[data-testid^="chit-emi-form-"]');
    await form.getByLabel('Amount').fill('25000');
    await form.getByLabel('Date').fill('2025-09-05');
    await form.getByRole('button', { name: 'Record instalment' }).click();

    await expect(page.locator('[data-testid^="chit-emis-"]')).toContainText('2025-09-05');
    // Still nil as an asset, despite the further instalment.
    await expect(rowFor(page, label).locator('td').last()).toHaveText('₹0');
  });

  test('sets up an agreed payout table and shows what a draw would pay', async ({ page }) => {
    await unlock(page);
    // The first save of a label is an addition and needs nothing. A RE-RUN of
    // this suite against the same vault is a replace, which does — and a test
    // that passes only on a fresh vault is worse than one that always runs.
    await enableEditMode(page);
    await goToSection(page, 'Chits');

    await page.getByRole('button', { name: /set up|Hide/ }).click();
    const scheduleForm = page.getByTestId('chit-schedule-form');
    await scheduleForm.getByLabel('Schedule label').fill('E2E 5L / 25');
    await scheduleForm
      .getByLabel('Month and payout, one per line')
      .fill('1, 350000\n9, 420000\n25, 500000');
    await scheduleForm.getByRole('button', { name: 'Save schedule' }).click();

    await expect(page.getByTestId('chit-schedule-table')).toContainText('E2E 5L / 25');
  });

  test('offers no payout table for a varying-instalment chit', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Chits');

    await page.getByRole('button', { name: 'Record a chit' }).click();
    const form = page.getByTestId('new-chit-form');
    await expect(form.getByLabel('Withdrawal schedule')).toBeVisible();

    await form.getByLabel('Instalment').selectOption({ label: 'Varying' });

    // Showing a payout selector here would imply a figure nobody agreed to.
    await expect(form.getByLabel('Withdrawal schedule')).toHaveCount(0);
  });

  test('filters by status', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Chits');

    await page.getByLabel('Withdrawn').check();
    const table = page.getByTestId('chit-table');
    await expect(table).not.toContainText(CHITS.journey);

    await page.getByLabel('Withdrawn').uncheck();
    await expect(table).toContainText(CHITS.journey);
  });
});

test.describe('US-8.10 Scenario: Egress is visible and empty by default', () => {
  test('reports no outbound calls, and labels that as expected', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Settings');
    await expect(page.getByTestId('egress-log-empty')).toBeVisible();
  });
});

/**
 * Edit mode, end to end.
 *
 * The journey a user actually takes: everything destructive is absent, they go
 * to Settings and re-enter the passphrase, the controls appear on every tab at
 * once, and turning it off puts them away again.
 *
 * Ordered last on purpose. These tests turn the mode off, and the suite shares a
 * single API process — leaving it off part-way through would break whichever
 * gated journey happened to run next.
 */
test.describe('Scenario: Edit mode gates changing and deleting across every tab', () => {
  /*
   * Its own records rather than another block's. A gating test that depended on
   * a loan some earlier scenario happened to leave behind would pass or fail on
   * run order, which is exactly what it must not do.
   */
  const BORROWER = 'E2E Edit Mode Borrower';
  const ORG = 'E2E Chit Company';

  async function lendOnce(page: Page, name: string): Promise<void> {
    await goToSection(page, 'Loans');
    const table = page.getByTestId('loan-table');
    if (await table.getByText(name, { exact: true }).first().isVisible()) return;

    await page.getByRole('button', { name: 'Record a loan' }).click();
    const form = page.getByTestId('new-loan-form');
    await form.getByLabel('Borrower name').fill(name);
    await form.getByLabel('Loan amount').fill('200000');
    await form.getByLabel('Interest rate %').fill('12');
    await form.getByLabel('Loan date').fill('2025-08-01');
    await form.getByRole('button', { name: 'Save loan' }).click();
    await expect(table).toContainText(name);
  }

  /** Idempotent, so the suite stays re-runnable against the same vault. */
  async function openChitOnce(page: Page, label: string): Promise<void> {
    await goToSection(page, 'Chits');
    const table = page.getByTestId('chit-table');
    if (await table.getByText(label, { exact: true }).first().isVisible()) return;

    await page.getByRole('button', { name: 'Record a chit' }).click();
    const form = page.getByTestId('new-chit-form');
    await form.getByLabel('Chit fund organisation').fill(ORG);
    await form.getByLabel('Chit label').fill(label);
    await form.getByLabel('Chit amount').fill('500000');
    await form.getByLabel('Start date').fill('2025-07-01');
    await form.getByLabel('Duration in months').fill('25');
    await form.getByRole('button', { name: 'Save chit' }).click();
    await expect(table).toContainText(label);
  }

  test('hides the edit control on Loans until the mode is on', async ({ page }) => {
    await unlock(page);
    await enableEditMode(page);
    await lendOnce(page, BORROWER);

    await goToSection(page, 'Settings');
    await page.getByTestId('disable-edit-mode').click();
    await expect(page.getByTestId('edit-mode-flag')).toHaveCount(0);

    await goToSection(page, 'Loans');
    await page.getByRole('button', { name: BORROWER, exact: true }).click();
    const detail = page.locator('[data-testid^="loan-detail-"]');

    await expect(detail.locator('[data-testid^="edit-toggle-"]')).toHaveCount(0);
    await expect(detail.locator('[data-testid^="delete-loan-"]')).toHaveCount(0);
    // The absence is explained rather than left looking like a missing feature.
    await expect(detail.getByTestId('edit-mode-hint')).toBeVisible();
  });

  test('refuses the wrong passphrase and stays off', async ({ page }) => {
    await unlock(page);
    await goToSection(page, 'Settings');

    await page.getByLabel('Vault passphrase').fill('not the passphrase');
    await page.getByTestId('enable-edit-mode').click();

    await expect(page.getByTestId('edit-mode-error')).toBeVisible();
    await expect(page.getByTestId('edit-mode-flag')).toHaveCount(0);
  });

  /*
   * One enable, controls on several tabs. A per-screen permission would need
   * turning on again on each, which is the thing the user asked not to have.
   */
  test('reveals edit and delete on Loans, Chits and the Ledger after one enable', async ({
    page,
  }) => {
    await unlock(page);
    await enableEditMode(page);
    await lendOnce(page, BORROWER);
    await openChitOnce(page, 'E2E Edit Mode Chit');

    await goToSection(page, 'Loans');
    await page.getByRole('button', { name: BORROWER, exact: true }).click();
    const loan = page.locator('[data-testid^="loan-detail-"]');
    await expect(loan.locator('[data-testid^="edit-toggle-"]')).toBeVisible();
    await expect(loan.locator('[data-testid^="delete-loan-"]')).toBeVisible();

    await goToSection(page, 'Chits');
    await page.getByRole('button', { name: 'E2E Edit Mode Chit', exact: true }).click();
    const chit = page.locator('[data-testid^="chit-detail-"]');
    await expect(chit.locator('[data-testid^="chit-edit-toggle-"]')).toBeVisible();
    await expect(chit.locator('[data-testid^="delete-chit-"]')).toBeVisible();

    await goToSection(page, 'Ledger');
    await expect(page.locator('[data-testid^="delete-asset-"]').first()).toBeVisible();
  });

  test('shows the mode in the top bar from every tab, not only Settings', async ({ page }) => {
    await unlock(page);
    await enableEditMode(page);

    await goToSection(page, 'Dashboard');
    await expect(page.getByTestId('edit-mode-flag')).toBeVisible();
    await goToSection(page, 'Ledger');
    await expect(page.getByTestId('edit-mode-flag')).toBeVisible();
  });

  /*
   * Arm, then delete. The first click reveals what is about to go; nothing is
   * sent until the second, because a single stray click lands on a row and a row
   * is what is being removed.
   */
  test('asks before deleting, and cancelling removes nothing', async ({ page }) => {
    await unlock(page);
    await enableEditMode(page);
    await goToSection(page, 'Chits');

    const label = 'E2E Chit To Keep';
    await openChitOnce(page, label);

    await page.getByRole('button', { name: label, exact: true }).click();
    const detail = page.locator('[data-testid^="chit-detail-"]');
    await detail.locator('[data-testid^="delete-chit-"]').first().click();

    const confirm = page.locator('[data-testid$="-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('no undo');

    await page.locator('[data-testid$="-no"]').click();
    await expect(page.getByTestId('chit-table')).toContainText(label);
  });

  test('deletes the chit once the deletion is confirmed', async ({ page }) => {
    await unlock(page);
    await enableEditMode(page);
    await goToSection(page, 'Chits');

    const label = 'E2E Chit To Delete';
    await openChitOnce(page, label);
    await expect(page.getByTestId('chit-table')).toContainText(label);

    await page.getByRole('button', { name: label, exact: true }).click();
    await page.locator('[data-testid^="chit-detail-"]').locator('[data-testid^="delete-chit-"]').first().click();
    await page.locator('[data-testid$="-yes"]').click();

    await expect(page.getByTestId('chit-table')).not.toContainText(label);
  });

  test('puts the controls away again when the mode is turned off', async ({ page }) => {
    await unlock(page);
    await enableEditMode(page);

    await goToSection(page, 'Settings');
    await page.getByTestId('disable-edit-mode').click();
    await expect(page.getByTestId('edit-mode-flag')).toHaveCount(0);

    await goToSection(page, 'Ledger');
    await expect(page.locator('[data-testid^="delete-asset-"]')).toHaveCount(0);
  });
});
