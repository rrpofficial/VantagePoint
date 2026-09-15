import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * E2E runs against the CONTAINERIZED stack (US-9.7), not a dev server, so the
 * journey exercised is the one users actually get from `docker compose up`.
 *
 * `.env` is read here for the same reason compose reads it: it is where the
 * published port is configured. Without this the suite defaulted to 5173 while
 * the stack was published on whatever `.env` said, so `pnpm test:e2e` failed
 * every test with ERR_CONNECTION_REFUSED — a suite that cannot reach the app it
 * exists to test. A real shell variable still wins, so CI can override.
 */
/*
 * `.env.test` FIRST, and `.env` only as a fallback.
 *
 * This suite records, edits and deletes — and with edit mode the deletions are
 * real. Defaulting to `.env` aimed it at whichever stack that file describes,
 * which is the production instance once there are two of them. A test run must
 * have to be pointed AT production deliberately, never land there by default.
 */
const envFile = ['.env.test', '.env'].find((candidate) => existsSync(candidate));
if (envFile !== undefined) process.loadEnvFile(envFile);

const port = process.env.VANTAGEPOINT_WEB_PORT ?? '5173';

export default defineConfig({
  testDir: './tests/e2e',
  /*
   * Refuses to start against a vault that already has data. The suite is
   * cumulative and asserts that figures CHANGED — false on a second run, which
   * surfaces as half a dozen failures that name everything except the cause.
   */
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.VANTAGEPOINT_BASE_URL ?? `http://localhost:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
