# VantagePoint — Implementation Plan

**Project:** VantagePoint — Global Portfolio Tracking & Indian Tax Compliance Platform
**Source of truth:** [`Global_Portfolio_Tracker_PRD.md`](./Global_Portfolio_Tracker_PRD.md)
**Plan version:** 1.0
**Date:** 2026-08-02
**Status:** Approved for execution

---

## 0. Critical Decisions & PRD Conflict Resolutions (READ FIRST)

These are structural decisions that change the data model. Each is recorded as an ADR and is
reversible only at material cost after Milestone M2.

| ADR | Decision | Rationale | Reversibility |
|-----|----------|-----------|---------------|
| **ADR-001** | **TypeScript monorepo**, pnpm workspaces. Pure-TS domain packages with zero I/O; adapters at the edge. | PRD §4.3 mandates local-first + PII masking in "WebAssembly/Node edge runtime". One language end-to-end keeps the masker identical on client and CLI. | High cost after M1 |
| **ADR-002** | **All money is `Decimal` (decimal.js), never `number`.** Persisted as a `{ amount: string, currency: ISO4217 }` pair. Rounding policy is explicit per call site. | IEEE-754 drift is unacceptable in a tax filing artifact. ₹1.25L LTCG exemption boundaries and surcharge cliffs are exact-comparison problems. | Very high after M1 |
| **ADR-003** | **Dual FX rate per foreign transaction.** `valuationRate` = trade-date ITBR (portfolio display, NAV, net worth). `taxRate` = Rule 115 rate (last day of month preceding the transaction month) used for *all* taxable-income computation. | **Resolves PRD conflict:** FR-1 AC demands trade-date conversion; FR-2.1 demands Rule 115. They govern different outputs, not the same output. Storing one rate makes the other unrecoverable. | Medium |
| **ADR-004** | **HNI = `totalIncome > ₹50L` OR `netWorth > ₹10 Cr`** (FR-5.1 is normative). | **Resolves PRD conflict:** §2.1 persona text says "Portfolio > ₹1 Crore" — that is descriptive prose, FR-5.1 is the requirement. Thresholds live in a versioned rule table, never inlined. | Low (config) |
| **ADR-005** | **Tax rules are data, keyed by Financial Year**, loaded from `packages/tax-engine/rules/FY-YYYY-YY.json`. No rate literal appears in engine code. | Indian slab/surcharge/CG rates changed materially in FY 2024-25 and will change again. A hardcoded 12.5% is a defect the day the Finance Act passes. | Low |
| **ADR-006** | **Snapshots are immutable and content-addressed** (SHA-256 over canonical JSON). Recomputation that yields a different hash raises, it does not overwrite. | PRD FR-3.1 says "freeze"; a compliance artifact that silently mutates is worse than no artifact. | Medium |
| **ADR-007** | **PII masking is fail-closed.** The egress guard re-scans the *post-mask* payload; any residual PAN/Aadhaar/email pattern throws `PiiLeakError` and the AI call is aborted. Masking is never "best effort". | FR-7.2 says "no PII entity shall leak". A warn-and-continue masker satisfies the letter and violates the intent. | Low |
| **ADR-008** | **All EOD boundaries resolve in `Asia/Kolkata`.** "31-Mar EOD" means `2026-03-31T23:59:59.999+05:30`. Foreign 31-Dec snapshots also freeze at IST EOD. | Ambiguous EOD makes 31-Mar and 1-Apr snapshots non-deterministic across machines. | Low |
| **ADR-009** | **Liabilities are first-class ledger entities**, not negative assets. | Schedule AL (FR-6.2) requires liabilities reported separately at closing balance. Modelling them as negative assets loses the distinction. | Medium |
| **ADR-010** | **Zero network egress by default.** FX scraping, price refresh and AI calls are explicitly user-triggered and pass through a single audited `EgressGateway`. | PRD §4.3 data sovereignty. Also makes the whole test suite hermetic. | Low |
| **ADR-011** | **Two-container split: `vantagepoint-api` (Node 22) + `vantagepoint-web` (SPA behind Caddy/nginx).** Domain packages compile into the API image; the SPA is a static build reverse-proxying `/api`. | PRD FR-8.1 requires frontend and backend to be separately containerized. Keeping the domain in one process preserves the sub-1.5s valuation budget (no cross-service chatter). | High after M1 |
| **ADR-012** | **DB on a host **bind mount**, never a named/anonymous Docker volume.** Host path `${VANTAGEPOINT_DATA_DIR:-./data}` → `/var/lib/vantagepoint` in-container. Containers run as `${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID}`. | PRD FR-8.2 says "native OS disk volume" — a named volume lives in Docker's own storage area and is not directly accessible or backup-able from the host. Bind mount is the only option that satisfies "visible and copyable from the host". | Low |
| **ADR-013** | **PII masking stays in the browser bundle**, not the API container. The API never receives unmasked text destined for an AI service. | FR-7.1 says masking is client-side. Containerizing must not quietly turn the masker into a server-side step — that would put unmasked PII on the wire, defeating the requirement. `pii-masker` is a pure package imported by the SPA; the API imports only its *verifier* for the fail-closed guard. | Medium |
| **ADR-014** | **The vault passphrase never reaches the API container's disk.** It is supplied per-session, held in memory only, and the derived key is zeroised on lock/shutdown. | FR-8.3 "no secrets in images"; also prevents a bind-mounted `.env` from becoming the weakest link. | Low |
| **ADR-015** | **Vault encryption is page-level whole-file AES-256-CBC + HMAC-SHA512** (the `sqlcipher` scheme in `better-sqlite3-multiple-ciphers`), **not AES-256-GCM.** NFR-1 amended accordingly. | **AES-256-GCM is not offered by any whole-file SQLite encryption provider** — the available schemes are `aes128cbc`, `aes256cbc`, `chacha20`, `sqlcipher`, `rc4`, `ascon128`, `aegis` (empirically enumerated, see below). Application-layer value encryption *can* use GCM but would forfeit range queries and indexing on the date and amount columns the ledger and snapshot engines depend on, for no material gain over one authenticated layer. `aes256cbc` alone was ruled out: it is unauthenticated and silently returns data from a tampered file. | Medium |

| **ADR-016** | **Mutual funds stay ONE asset class carrying a derived `taxCharacter`**, rather than splitting into DEBT / ARBITRAGE / HYBRID sibling classes. | Asset class drives jurisdiction, Schedule AL mapping and allocation reporting — identical across every fund type; only tax differs. Sibling classes would also only *look* correct: the real discriminator is equity allocation, so a hybrid scheme still could not be placed without it. Decisive case: an **arbitrage fund returns cash-like yields but is taxed as equity-oriented**; listing `ARBITRAGE` beside `DEBT` invites precisely the wrong inference, whereas an explicit `taxCharacter` surfaces the surprise. | Medium |
| **ADR-017** | **Brand accent is never used to convey financial direction** (PRD FR-9.2). Vermilion `#E4482F` is reserved for brand marks and primary CTAs; gains/losses use their own pair; a zero change renders in muted ink. | The reference design's accent is vermilion, and vermilion already means "loss" in a portfolio. Reusing it would make a branded button read as a negative number, and would leave a losing position indistinguishable from chrome. | Low |

#### ADR-015 evidence

Measured on `better-sqlite3-multiple-ciphers@12.11.1` (SQLite 3.53.2) on 2026-08-02, by writing a table
named `hand_loans_ledger` containing a PAN-shaped value, closing the database, then inspecting the raw
file, reopening with a wrong key, and flipping one byte at 60% depth before reopening with the right key:

| scheme | schema identifiers hidden | values hidden | plaintext `SQLite format 3` header | wrong key rejected | tamper detected |
|---|---|---|---|---|---|
| `chacha20` | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`sqlcipher`** ← chosen | ✅ | ✅ | ✅ | ✅ | ✅ |
| `aes256cbc` | ✅ | ✅ | ✅ | ✅ | ❌ **returns tampered data** |
| `aegis` | ✅ | ✅ | ✅ | ✅ | ✅ |

`aes256cbc` is unauthenticated and therefore disqualified regardless of its name matching NFR-1's
original wording. `sqlcipher` was chosen over `chacha20` because it retains AES-256 (minimising the PRD
amendment) and is the most widely audited of the authenticated options. The regression test for the
bottom row lives in `packages/persistence/test/vault-encryption.spec.ts`.

### Open questions requiring user input before the milestone noted

| # | Question | Blocks | Working assumption until answered |
|---|----------|--------|-----------------------------------|
| OQ-1 | Live market price source for domestic equities/MF NAV (paid API vs manual vs AMFI NAVAll.txt)? | M4 | AMFI `NAVAll.txt` for MF NAV; manual price entry for equities; adapter interface stubbed so any source drops in. |
| OQ-2 | Is multi-user / family-member portfolio segregation in scope? | M2 | Single `userId` per encrypted vault; schema carries `userId` FK so multi-profile is additive. |
| OQ-3 | Does the user want DTAA foreign tax credit (Form 67) computed, or only recorded? | M5 | Computed as relief in the tax summary, but **not** exported as Form 67; recorded with treaty rate provenance. |
| OQ-4 | Grandfathering (31-Jan-2018 FMV) — is a historical FMV dataset available, or manual entry? | M5 | Manual per-lot `grandfatheredFmv` field, engine applies the higher-of rule when present. |

---

## 1. Architecture Summary

Full component and sequence diagrams: **[`ARCHITECTURE_vantagepoint.md`](./ARCHITECTURE_vantagepoint.md)**.

Layering rule enforced by lint (`import/no-restricted-paths`):

```
apps/api, apps/cli  ──▶  packages/app-services  ──▶  packages/<domain>  ──▶  packages/shared-kernel
                                  │
                                  └──▶  packages/persistence, packages/adapters-*   (I/O only)

apps/web  ──▶  HTTP (/api)  ──▶  apps/api          # no domain package bundled into the SPA…
apps/web  ──▶  packages/pii-masker                 # …except the masker, which MUST be client-side (ADR-013)
```

Domain packages (`core-domain`, `fx-itbr`, `tax-engine`, `snapshot`, `pii-masker`) are **pure**: no
`fs`, no `fetch`, no `Date.now()`. Time and randomness are injected via a `Clock` and `IdGenerator`
port. This is what makes the tax engine deterministically testable across FYs — and what lets the same
`pii-masker` code run in the browser bundle and in the API's fail-closed verifier.

### Repository layout

```
VantagePoint/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json              # strict: true, noUncheckedIndexedAccess: true
├── vitest.workspace.ts
├── playwright.config.ts
├── implementation_plan_vantagepoint.md
├── ARCHITECTURE_vantagepoint.md
├── Global_Portfolio_Tracker_PRD.md
├── packages/
│   ├── shared-kernel/              # Money, Decimal, FyDate, Result, ids, Clock port
│   ├── core-domain/                # Asset, Lot, Transaction, Liability, FIFO, valuation
│   ├── fx-itbr/                    # RateStore, Rule115Resolver, FallbackChain, dual-rate service
│   ├── tax-engine/                 # slabs, surcharge, marginal relief, cess, CG, advance tax
│   │   └── rules/FY-2025-26.json   # ADR-005 rule data
│   ├── snapshot/                   # immutable snapshot, scheduler policy, delta/variance, XIRR
│   ├── ingestion/                  # pipeline + CAMS/Zerodha/Vested/E*TRADE/template parsers
│   ├── compliance/                 # Schedule FA (A3, D) + Schedule AL generators
│   ├── pii-masker/                 # regex rules, NER, pseudonymizer, egress guard
│   ├── persistence/                # SQLite (page-level AES-256), migrations, repositories
│   ├── adapters-fx/                # SBI/RBI/ECB HTTP scrapers (I/O)
│   └── app-services/               # use-case orchestration consumed by apps
├── apps/
│   ├── api/                        # Fastify backend service  → image vantagepoint-api
│   ├── web/                        # React + Vite SPA          → image vantagepoint-web
│   └── cli/                        # headless snapshot / tax / import runner
├── docker/
│   ├── api.Dockerfile              # multi-stage, non-root, minimal runtime
│   ├── web.Dockerfile              # build stage + Caddy static server
│   ├── Caddyfile                   # SPA fallback + /api reverse proxy
│   └── entrypoint-api.sh           # data-dir perms check → migrations → exec node
├── compose.yaml                    # base stack (default profile, egress denied)
├── compose.override.yaml           # local dev: HMR + source bind mounts
├── compose.egress.yaml             # opt-in profile enabling outbound FX/AI network
├── .env.example                    # VANTAGEPOINT_DATA_DIR, VANTAGEPOINT_UID/GID, ports
└── tests/
    ├── functional/                 # cross-package acceptance tests (Vitest)
    ├── container/                  # Docker acceptance tests (compose up/down, persistence)
    ├── e2e/                        # Playwright UI journeys (run against the containerized stack)
    └── fixtures/                   # synthetic CAS/Zerodha/Vested/E*TRADE files, rate sheets
```

### Container topology (PRD FR-8)

```
host:${VANTAGEPOINT_WEB_PORT:-5173}
      │
      ▼
  vantagepoint-web   Caddy + SPA bundle (includes pii-masker — ADR-013)   non-root · read-only FS
      │  /api/*  reverse-proxied over the internal bridge network
      ▼
  vantagepoint-api   Node 22 + Fastify + all domain packages              non-root · read-only FS
      │  better-sqlite3
      ▼
  /var/lib/vantagepoint/vault.db
      ▲
      └── bind mount ──▶  ${VANTAGEPOINT_DATA_DIR:-./data}  ON THE HOST'S NATIVE DISK   (ADR-012)
```

Only `vantagepoint-web` publishes a host port; `vantagepoint-api` is reachable solely on the internal bridge
network. Neither container has outbound internet access unless the user explicitly starts the `egress`
profile (ADR-010). Writable paths in `vantagepoint-api` are exactly two: the bind-mounted data directory and
a `tmpfs` `/tmp`.

### Technology decisions

| Concern | Choice | Note |
|---|---|---|
| Language / runtime | TypeScript 5.6 (strict), Node 22 | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` on |
| Money | `decimal.js` wrapped in `Money` VO | ADR-002; no raw `number` arithmetic on currency |
| Dates | `@internationalized/date` / native `Temporal`-shim, IST-fixed | ADR-008 |
| Persistence | `better-sqlite3-multiple-ciphers`, `sqlcipher` scheme | ADR-015. Page-level AES-256-CBC + HMAC-SHA512 over the whole file; key = Argon2id(passphrase, salt), memory-only |
| PDF (CAMS CAS) | `mupdf-js` / `pdf-lib` + `qpdf`-wasm for decryption | Password in-memory only, zeroised after parse |
| XLSX / CSV | `exceljs`, `papaparse` | Streamed, row-level error collection |
| NER (names) | `wink-nlp` (local, no network) | FR-7.2 name masking |
| UI | React 18 + Vite + TanStack Query/Table | |
| Unit tests | **Vitest** | Domain packages, ≥90% line / ≥85% branch |
| Functional tests | **Vitest** (`tests/functional`) | Full use-case wiring against in-memory + temp-file SQLite |
| E2E tests | **Playwright** | User journeys through the real UI |
| Backend service | Fastify 5 on Node 22 | `apps/api`; thin HTTP shell over `app-services` |
| Static serving | Caddy 2 (alpine) | SPA fallback + `/api` reverse proxy; auto-compresses |
| Containers | Docker + Compose v2 | Two images, pinned base digests, non-root, read-only FS |
| DB location | Host bind mount `${VANTAGEPOINT_DATA_DIR:-./data}` | ADR-012 — native host disk, not a Docker volume |
| Container tests | Vitest + `testcontainers` / raw `docker compose` | `tests/container/`, tagged so they can be excluded from the fast unit run |
| Lint/format | ESLint (typescript-eslint strict) + Prettier | Layering rules enforced |

---

## 2. Domain Model (canonical)

```ts
type AssetClass =
  | 'DOMESTIC_EQUITY' | 'DOMESTIC_ETF' | 'DOMESTIC_MUTUAL_FUND'
  | 'FOREIGN_EQUITY'  | 'FOREIGN_ETF'  | 'RSU' | 'ESPP'
  | 'EPF' | 'VPF' | 'NPS_TIER_I' | 'NPS_TIER_II' | 'PPF' | 'GRATUITY'
  | 'FIXED_DEPOSIT' | 'RECURRING_DEPOSIT'
  | 'REAL_ESTATE' | 'UNLISTED_SHARES' | 'CRYPTO' | 'GOLD_PHYSICAL' | 'GOLD_DIGITAL' | 'SGB'
  | 'CASH_IN_HAND' | 'BANK_BALANCE' | 'HAND_LOAN' | 'CHIT_FUND';

interface Asset {
  assetId: AssetId;            // 'ast_<class>_<nanoid>'
  assetClass: AssetClass;
  jurisdiction: 'DOMESTIC' | 'FOREIGN';   // drives 31-Mar vs 31-Dec snapshot membership
  symbol?: string; isin?: string; folioNo?: PiiRef;
  currency: Currency;
  lots: AcquisitionLot[];
  incomeEvents: IncomeEvent[];            // dividend / interest / accrual
  corporateActions: CorporateAction[];
}

interface AcquisitionLot {
  lotId: LotId;
  acquisitionDate: IsoDate; settlementDate?: IsoDate;
  quantity: Decimal; remainingQuantity: Decimal;
  costPerUnit: Money;                     // native currency
  fees: Money; stt: Money; otherCharges: Money;
  fx?: { valuationRate: Decimal; taxRate: Decimal; source: RateSource };  // ADR-003
  grandfatheredFmv?: Money;               // 31-Jan-2018 FMV, OQ-4
}

interface ExitTransaction {
  txnId: TxnId; assetId: AssetId;
  exitDate: IsoDate; quantity: Decimal; pricePerUnit: Money;
  fees: Money; stt: Money;
  allocations: LotAllocation[];           // FIFO output, immutable once committed
  fx?: { valuationRate: Decimal; taxRate: Decimal; source: RateSource };
}

interface Liability {                     // ADR-009
  liabilityId: LiabilityId;
  kind: 'HOME_LOAN' | 'PERSONAL_LOAN' | 'MORTGAGE' | 'OTHER';
  principalOutstanding: Money; interestRatePct: Decimal; asOf: IsoDate;
}

interface Snapshot {                      // ADR-006, immutable
  snapshotId: string;                     // 'DOM_31MAR2026' | 'FOR_31DEC2026' | 'CUSTOM_<date>'
  kind: 'DOMESTIC_COMPLIANCE' | 'FOREIGN_COMPLIANCE' | 'CUSTOM';
  asOf: IsoDateTime;                      // IST EOD
  scope: 'DOMESTIC' | 'FOREIGN' | 'ALL';
  positions: SnapshotPosition[];
  totals: { netWorth: Money; byAssetClass: Record<AssetClass, Money>; liabilities: Money };
  contentHash: string; createdAt: IsoDateTime; frozen: true;
}
```

---

## 3. Global Definition of Ready (DoR)

A story may enter development only when **all** hold:

1. Acceptance criteria written as executable Gherkin, traceable to a PRD FR-ID.
2. Every input/output type named in the domain model or added to it in the same PR.
3. External data dependencies have a committed fixture in `tests/fixtures/` (no live network in tests).
4. Rounding, currency and timezone behaviour explicitly stated where money or dates are involved.
5. Story is estimated and its blocking dependencies are `Done`.

## 4. Global Definition of Done (DoD)

A story is `Done` only when **all** hold. No partial credit.

| # | Criterion |
|---|-----------|
| D1 | Every Gherkin AC in the story has a passing automated test, named after the scenario. |
| D2 | Unit coverage on touched domain package ≥ 90% lines / ≥ 85% branches; no `istanbul ignore` without a comment justifying it. |
| D3 | Functional test exercises the story through `app-services` (not the internals) with a real repository. |
| D4 | TypeScript strict passes; **zero** `any`, `as unknown as`, or non-null `!` assertions in the diff. |
| D5 | No money arithmetic on `number`; all money crosses boundaries as `Money`. |
| D6 | Error paths are explicit: expected failures return `Result<T, DomainError>`; unexpected ones throw typed errors. No empty `catch`. |
| D7 | No PII in logs, error messages, or thrown-error payloads (asserted by a shared `expectNoPii()` helper). |
| D8 | Applicable NFR budget verified by benchmark test (valuation < 1.5 s @ 1,000 lots; snapshot delta < 2.0 s). |
| D9 | If tax/FX/compliance logic: a worked numeric example is in the package README, and its numbers are the test's expected values. |
| D10 | Public API of the package is documented via TSDoc on exported symbols only. |
| D11 | Tracker row (§7) updated; PRD FR-ID traceability link present in the PR description. |
| D12 | Lint + typecheck + full test suite green in CI on the branch. |
| D13 | If the story changes runtime deps, the API surface, or anything the images package: `docker compose up` still succeeds from a clean state, the `@container` suite passes, and no new write path outside the bind-mounted data dir is introduced. |

---

## 5. Epics & User Stories

Story ID format `US-<epic>.<n>`. Priority: **P0** = Phase 1 blocking, **P1** = Phase 1, **P2** = Phase 2.
Estimates in story points (Fibonacci).

---

### EPIC-1 — Multi-Asset Ledger & Lifecycle Tracking  *(PRD Module 1: FR-1.1, FR-1.2)*

> **Epic goal:** A single ledger that can hold every asset class in FR-1.1 through its full lifecycle,
> with FIFO-correct realised gains and dual-currency cost basis.

---

#### US-1.1 — Typed asset registry and taxonomy
**As a** DIY investor **I want** every asset I own to be classifiable into a supported asset class
**so that** valuation, tax treatment and snapshot membership are derived automatically rather than
chosen by me each time.

**AC**
```gherkin
Scenario: Asset class determines jurisdiction and snapshot membership
  Given an asset of class "FOREIGN_EQUITY"
  When the asset is registered
  Then its jurisdiction must be "FOREIGN"
  And it must be included in 31-Dec compliance snapshots
  And excluded from 31-Mar domestic-only compliance snapshots

Scenario: Unsupported asset class is rejected at the boundary
  Given a payload with assetClass "DOGECOIN_FUTURES"
  When the asset is registered
  Then registration fails with UnsupportedAssetClassError
  And no partial asset record is persisted
```
**DoD:** global DoD + taxonomy table covers all 22 classes in FR-1.1 with an exhaustive-switch test that
fails to compile if a class is added without a jurisdiction mapping.
**Points:** 3 · **Deps:** US-8.1, US-8.4

---

#### US-1.2 — Record an acquisition lot with full cost basis
**As an** investor **I want** each purchase recorded as a discrete lot with trade date, settlement date,
quantity, unit price, brokerage and STT **so that** cost basis and holding period are exact.

**AC**
```gherkin
Scenario: Acquisition lot captures all mandated fields (FR-1.2)
  Given a purchase of 100 shares of "TCS" on 2025-06-10 at ₹3,850.00
  And brokerage ₹20.00, STT ₹385.00, other charges ₹5.50
  When the lot is recorded
  Then the lot stores trade date 2025-06-10 and settlement date 2025-06-12
  And total cost basis equals ₹385,410.50
  And remainingQuantity equals 100

Scenario: Settlement date defaults to T+1 for domestic equity when omitted
  Given a domestic equity purchase on 2025-06-10 with no settlement date
  When the lot is recorded
  Then settlement date is 2025-06-11

Scenario: Negative or zero quantity is rejected
  Given a purchase with quantity 0
  When the lot is recorded
  Then it fails with InvalidQuantityError
```
**DoD:** global DoD + cost-basis worked example in `core-domain/README.md`.
**Points:** 3 · **Deps:** US-1.1

---

#### US-1.3 — Partial and complete exit with FIFO lot allocation
**As an** investor **I want** sells to consume my oldest lots first **so that** realised gains match the
FIFO method the Indian tax authority expects.

**AC**
```gherkin
Scenario: Partial exit consumes oldest lot first
  Given lots: L1 = 100 units @ ₹100 on 2023-01-10, L2 = 50 units @ ₹150 on 2024-06-01
  When 120 units are sold on 2025-09-01 at ₹200
  Then allocation is L1:100 units and L2:20 units
  And L1.remainingQuantity is 0 and L2.remainingQuantity is 30
  And realised gain equals (120 × 200) − (100 × 100 + 20 × 150) = ₹11,000

Scenario: Oversell is rejected atomically
  Given total remaining quantity of 150 units
  When 151 units are sold
  Then it fails with InsufficientQuantityError
  And no lot's remainingQuantity is mutated

Scenario: Complete exit zeroes the position
  Given a single lot of 100 units
  When 100 units are sold
  Then remainingQuantity is 0 and the asset reports positionClosed = true
```
**DoD:** global DoD + property-based test asserting Σ allocated = quantity sold and Σ remaining is
non-increasing across 1,000 random lot/exit sequences.
**Points:** 5 · **Deps:** US-1.2

---

#### US-1.4 — Foreign equity lots with dual-currency cost basis (incl. RSU/ESPP)
**As a** global Indian investor **I want** my US holdings to carry both a USD and an INR cost basis
**so that** portfolio valuation and taxable gains are each computed on the correct rate (ADR-003).

**AC**
```gherkin
Scenario: Partial exit on foreign RSUs with currency conversion (PRD FR-1 AC)
  Given the user owns 100 shares of US stock "AAPL" acquired on 2023-05-10 at $172.50
  When the user sells 40 shares on 2026-02-15 at $180.00 per share
  Then the exit date is recorded as 2026-02-15
  And realised gain is computed using FIFO lot allocation
  And USD proceeds are converted to INR at the trade-date SBI ITBR rate for valuation
  And taxable proceeds are converted at the Rule 115 rate for 2026-01-31
  And the remaining lot quantity is 60 for future snapshot calculations

Scenario: RSU vesting creates a lot at fair market value on vest date
  Given an RSU grant vesting 50 shares on 2025-11-15 with FMV $210.00
  When the vest is recorded
  Then a lot is created with acquisitionDate 2025-11-15 and costPerUnit $210.00
  And the perquisite value in INR is recorded for salary-income reporting

Scenario: ESPP discount is recorded separately from cost basis
  Given an ESPP purchase at 85% of a $200 FMV
  When the lot is recorded
  Then costPerUnit is $170.00
  And perquisiteValue is $30.00 per share
```
**DoD:** global DoD + both rates asserted independently; a test proves the two rates differ and neither
is silently reused for the other.
**Points:** 8 · **Deps:** US-1.3, US-2.4, US-2.5

---

#### US-1.5 — Dividend and interest ingestion with withholding tax
**As an** investor **I want** dividends and interest recorded with tax withheld at source
**so that** other-sources income and DTAA relief are computed correctly.

**AC**
```gherkin
Scenario: Foreign dividend with W-8BEN treaty withholding
  Given a US dividend of $500 received on 2025-08-14 with 25% withheld
  When the income event is recorded
  Then gross dividend is $500.00 and withheld tax is $125.00 and net is $375.00
  And the INR taxable value uses the Rule 115 rate for 2025-07-31
  And the withheld amount is tagged as eligible for foreign tax credit

Scenario: Domestic dividend with TDS under section 194
  Given a domestic dividend of ₹100,000 with ₹10,000 TDS
  When the income event is recorded
  Then ₹100,000 is added to other-sources income
  And ₹10,000 is added to the TDS credit pool for advance tax

Scenario: Auto-reinvested interest creates a new lot
  Given a mutual fund with dividend reinvestment on 2025-09-30
  When the reinvested interest of ₹5,000 at NAV ₹250 is recorded
  Then a new lot of 20 units at ₹250 dated 2025-09-30 is created
```
**Points:** 5 · **Deps:** US-1.4, US-2.4

---

#### US-1.6 — Corporate actions (split, bonus, merger, demerger)
**As an** investor **I want** corporate actions to adjust my lots **so that** quantity and cost basis stay
correct and holding period is preserved.

**AC**
```gherkin
Scenario: Stock split preserves total cost basis and original acquisition date
  Given a lot of 100 shares at ₹1,000 acquired 2023-04-01
  When a 1:5 split is applied on 2025-07-01
  Then the lot becomes 500 shares at ₹200
  And total cost basis is unchanged at ₹100,000
  And acquisitionDate remains 2023-04-01 for holding-period purposes

Scenario: Bonus issue creates a zero-cost lot dated at the bonus record date
  Given a lot of 100 shares
  When a 1:1 bonus is applied on 2025-07-01
  Then a new lot of 100 shares at ₹0 cost dated 2025-07-01 is created
  And the original lot is unchanged
```
**Points:** 5 · **Deps:** US-1.3

---

#### US-1.7 — Mutual fund holdings with folio/scheme identity and NAV valuation
**AC**
```gherkin
Scenario: MF units valued at applicable NAV on the valuation date
  Given a folio holding 1,234.567 units of a scheme with ISIN INF090I01239
  When valued on 2026-03-31 with NAV ₹87.4321
  Then market value equals ₹107,943.06 rounded to 2 decimals

Scenario: NAV unavailable on a non-business day falls back to last published NAV
  Given 2026-03-29 is a Sunday with no published NAV
  When valuation runs for 2026-03-29
  Then the NAV published for 2026-03-27 is used
  And the position is flagged navSource = "LAST_PUBLISHED"
```
**Points:** 5 · **Deps:** US-1.2

---

#### US-1.8 — Statutory schemes: EPF, VPF, NPS (Tier I/II), PPF, Gratuity
**AC**
```gherkin
Scenario: EPF balance accrues employee, employer and interest components
  Given an opening EPF balance of ₹1,000,000 on 2025-04-01
  And monthly employee contribution ₹15,000 and employer ₹15,000
  And a declared interest rate of 8.25% for FY 2025-26
  When the balance is projected to 2026-03-31
  Then contributions of ₹360,000 are added
  And interest is computed on monthly running balances
  And the closing balance is reported with a component breakdown

Scenario: Gratuity is projected from last drawn salary and tenure
  Given last drawn basic + DA of ₹200,000 per month and 12 completed years
  When gratuity is estimated
  Then the accrued value equals 15/26 × 200000 × 12 = ₹1,384,615.38

Scenario: NPS Tier I is flagged as illiquid until age 60
  Given an NPS Tier I holding and a user date of birth implying age 45
  When net worth is computed
  Then the holding is included in net worth
  And flagged liquidity = "LOCKED_UNTIL_60"
```
**Points:** 8 · **Deps:** US-1.1

---

#### US-1.9 — Fixed and recurring deposits with accrued interest
**AC**
```gherkin
Scenario: FD accrues quarterly compounded interest to the valuation date
  Given an FD of ₹1,000,000 at 7.2% p.a. compounded quarterly from 2025-04-01
  When valued on 2026-03-31
  Then the accrued value equals ₹1,073,970.86
  And accrued interest ₹73,970.86 is reported as other-sources income for FY 2025-26
```
**Points:** 3 · **Deps:** US-1.1

---

#### US-1.10 — Alternative assets: real estate, unlisted shares, crypto, gold, SGB
**AC**
```gherkin
Scenario: Real estate holds cost of acquisition separately from current market value
  Given a property purchased on 2019-08-01 for ₹15,000,000 with ₹900,000 stamp duty
  When Schedule AL data is requested
  Then cost of acquisition is reported as ₹15,900,000
  And current market value is reported separately and never substituted for cost

Scenario: Crypto gains are classified as VDA and excluded from LTCG treatment
  Given a crypto holding sold after 36 months at a gain
  When capital gains are classified
  Then the gain is classified as VDA_GAIN taxed at 30% with no indexation
  And losses are flagged as non-set-offable
```
**Points:** 5 · **Deps:** US-1.1

---

#### US-1.11 — Hand loans with interest accrual
**AC**
```gherkin
Scenario: Tracking hand loans with interest (PRD FR-1 AC)
  Given the user lends ₹5,000,000 as a hand loan on 2025-04-01 at 8% p.a. simple interest
  When the snapshot is generated on 2026-03-31
  Then the asset principal is valued at ₹5,000,000
  And accrued interest of ₹400,000 is reflected in total net worth
  And the accrued interest is categorised under "Other Sources" income for advance tax estimation

Scenario: Partial repayment reduces principal and stops interest on the repaid part
  Given a ₹5,000,000 hand loan at 8% simple interest from 2025-04-01
  When ₹2,000,000 principal is repaid on 2025-10-01
  Then interest accrues on ₹5,000,000 for 183 days and on ₹3,000,000 for 182 days
  And accrued interest to 2026-03-31 equals ₹320,547.95

Scenario: Borrower name is stored as a PII reference, never as plain text in AI payloads
  Given a hand loan to borrower "Rajesh Sharma"
  When the asset is serialised for an AI payload
  Then the borrower field reads "[REDACTED_NAME]"
```
**Points:** 5 · **Deps:** US-1.1, US-7.1

---

#### US-1.12 — Custom family savings / chit schemes
**AC**
```gherkin
Scenario: Chit scheme tracks contributions paid and expected payout
  Given a 24-month chit with ₹50,000 monthly contribution started 2025-01-01
  When valued on 2026-03-31
  Then contributions paid to date equal ₹750,000
  And the position reports expectedPayoutDate and any dividend/discount received to date
```
**Points:** 3 · **Deps:** US-1.1

---

#### US-1.13 — Cash in hand and bank balances
**AC**
```gherkin
Scenario: Cash in hand is included in net worth and Schedule AL movable assets
  Given cash in hand of ₹250,000 declared as of 2026-03-31
  When the 31-Mar snapshot is generated
  Then ₹250,000 appears under CASH_IN_HAND
  And is mapped to Schedule AL movable assets
```
**Points:** 2 · **Deps:** US-1.1

---

#### US-1.14 — Liabilities ledger
**AC**
```gherkin
Scenario: Liabilities reduce net worth but are reported separately
  Given assets totalling ₹100,000,000 and a home loan outstanding of ₹8,000,000
  When net worth is computed
  Then gross assets are ₹100,000,000
  And total liabilities are ₹8,000,000
  And net worth is ₹92,000,000
  And Schedule AL reports the liability under its own head, not as a negative asset
```
**Points:** 3 · **Deps:** US-1.1

---

#### US-1.15 — Portfolio valuation engine
**AC**
```gherkin
Scenario: Valuation of a large portfolio meets the performance budget (NFR-2)
  Given a portfolio with 1,000 individual lots across 8 asset classes and 3 currencies
  When full valuation is computed
  Then it completes in under 1,500 milliseconds
  And every foreign position uses the trade-date-appropriate valuation rate

Scenario: Valuation is deterministic
  Given identical inputs and a fixed clock
  When valuation is run twice
  Then both results are byte-identical under canonical JSON serialisation
```
**Points:** 8 · **Deps:** US-1.4 … US-1.14, US-2.5

---

### EPIC-2 — Foreign Currency & SBI ITBR Rate Engine  *(PRD Module 2: FR-2.1)*

#### US-2.1 — FX rate store with provenance
**AC**
```gherkin
Scenario: Every stored rate carries its source and retrieval timestamp
  Given a USD/INR rate of 83.4500 for 2025-07-31
  When the rate is stored
  Then it records source = "SBI_ITBR", rateType = "TTBR", retrievedAt and a sourceDocumentRef
  And storing a second rate for the same (currency, date, source) is idempotent

Scenario: Conflicting rate for the same key is rejected, not overwritten
  Given a stored SBI_ITBR rate of 83.4500 for 2025-07-31
  When a different value 83.9000 is ingested for the same key
  Then a RateConflictError is raised with both values
```
**Points:** 3 · **Deps:** US-8.3

---

#### US-2.2 — SBI ITBR ingestion pipeline
**AC**
```gherkin
Scenario: Daily SBI rate sheet is parsed into rate records
  Given the official SBI forex rate sheet fixture for 2025-07-31
  When the ingestion pipeline runs
  Then TTBR rates for USD, EUR, GBP, SGD, AED are stored with source SBI_ITBR
  And the source document reference is retained for audit

Scenario: Malformed rate sheet does not corrupt the store
  Given a rate sheet fixture with a missing USD column
  When ingestion runs
  Then no rates from that sheet are committed
  And an IngestionFailure is reported naming the missing column
```
**Points:** 5 · **Deps:** US-2.1, US-8.10

---

#### US-2.3 — Fallback hierarchy resolver
**AC**
```gherkin
Scenario: System fallback when SBI rate sheet is delayed (PRD FR-2 AC)
  Given the SBI forex sheet is unreleased for a bank holiday on the trade date
  When the asset transaction is logged
  Then the RBI reference rate for the nearest prior working day is applied
  And the transaction is flagged "Rate Source: RBI Fallback (Pending SBI ITBR Finalization)"

Scenario: Fallback order is SBI → RBI → ECB → OANDA
  Given no SBI and no RBI rate exists for 2025-12-25
  And an ECB rate exists for 2025-12-24
  Then the ECB rate for 2025-12-24 is used with source ECB and isFallback = true

Scenario: Complete rate unavailability fails loudly
  Given no rate from any source for the requested date or any prior date
  When a conversion is attempted
  Then it fails with RateUnavailableError
  And no implicit 1.0 or last-known-good rate is substituted
```
**Points:** 5 · **Deps:** US-2.1

---

#### US-2.4 — Rule 115 resolver
**AC**
```gherkin
Scenario: Automated SBI ITBR fetch and Rule 115 compliance (PRD FR-2 AC)
  Given a US dividend is received on 2025-08-14
  When the currency conversion engine runs
  Then the SBI TTBR rate published for 2025-07-31 is used
  And the USD dividend is converted to INR for taxable income computation

Scenario: January transaction uses the prior December rate
  Given a transaction on 2026-01-05
  When the Rule 115 rate is resolved
  Then the rate for 2025-12-31 is used

Scenario: Preceding month-end falling on a non-publishing day walks backwards
  Given no SBI rate published for 2025-08-31 (a Sunday)
  When the Rule 115 rate for a September transaction is resolved
  Then the last published SBI rate on or before 2025-08-31 is used
  And the resolution path is recorded for audit
```
**Points:** 5 · **Deps:** US-2.3

---

#### US-2.5 — Dual-rate conversion service (ADR-003)
**AC**
```gherkin
Scenario: A single foreign transaction yields two distinct INR amounts
  Given a sale of $7,200 on 2026-02-15
  And an SBI ITBR trade-date rate of 84.10 and a Rule 115 rate (2026-01-31) of 83.55
  When the conversion service runs
  Then valuationInr equals ₹605,520.00
  And taxableInr equals ₹601,560.00
  And both are persisted on the transaction with their rate provenance

Scenario: Tax computation never consumes the valuation rate
  Given a transaction with both rates populated
  When the capital gains engine computes taxable gain
  Then only taxableInr is read
```
**Points:** 5 · **Deps:** US-2.4

---

#### US-2.6 — Retroactive rate finalisation and reconciliation
**AC**
```gherkin
Scenario: Late-published SBI rate supersedes a fallback and triggers recomputation
  Given a transaction converted using an RBI fallback rate flagged as pending
  When the official SBI ITBR rate for that date is later ingested
  Then the transaction's rates are recomputed
  And an amendment record links the old and new values
  And any frozen snapshot containing that transaction is NOT mutated but is flagged "supersededRateAvailable"
```
**Points:** 8 · **Deps:** US-2.5, US-3.1

---

### EPIC-3 — Historical Snapshot & Comparison System  *(PRD Module 3: FR-3.1)*

#### US-3.1 — Immutable content-addressed snapshot
**AC**
```gherkin
Scenario: Snapshot is frozen and content-addressed
  Given a generated snapshot
  When any mutation of its positions is attempted
  Then it fails with SnapshotImmutableError
  And the stored contentHash matches SHA-256 of its canonical JSON

Scenario: Regenerating an existing snapshot detects divergence
  Given snapshot "DOM_31MAR2026" exists with hash H1
  When regeneration produces hash H2 ≠ H1
  Then a SnapshotDivergenceError is raised naming the differing positions
  And the original snapshot is left untouched
```
**Points:** 5 · **Deps:** US-1.15

---

#### US-3.2 / US-3.3 — Automatic 31-Mar domestic and 31-Dec foreign compliance snapshots
**AC**
```gherkin
Scenario: Dual compliance snapshot generation (PRD FR-3 AC)
  Given the current system date reaches 2026-04-01
  When the automated snapshot scheduler runs
  Then an immutable snapshot "DOM_31MAR2026" is created containing all domestic holdings as of 31-Mar-2026 EOD
  And when the calendar date reaches 2027-01-01
  Then an immutable snapshot "FOR_31DEC2026" is created for all foreign holdings as of 31-Dec-2026 EOD

Scenario: Scheduler is idempotent
  Given "DOM_31MAR2026" already exists
  When the scheduler runs again on 2026-04-02
  Then no duplicate snapshot is created and no error is raised

Scenario: Domestic snapshot excludes foreign holdings and vice versa
  Given a portfolio with both domestic and foreign assets
  When "DOM_31MAR2026" is generated
  Then it contains only assets with jurisdiction DOMESTIC

Scenario: EOD boundary is Asia/Kolkata (ADR-008)
  Given a transaction timestamped 2026-03-31T23:45:00+05:30
  When the 31-Mar snapshot is generated
  Then the transaction is included
  And a transaction at 2026-04-01T00:15:00+05:30 is excluded
```
**Points:** 8 (combined) · **Deps:** US-3.1

---

#### US-3.4 — Custom on-demand snapshot for an arbitrary date
**AC**
```gherkin
Scenario: Custom historical snapshot reconstructs state as of a past date
  Given transactions spanning 2023-01-01 to 2026-08-02
  When the user requests a custom snapshot for 2024-11-30
  Then only transactions on or before 2024-11-30 IST EOD are included
  And prices/NAVs/FX as of 2024-11-30 are used

Scenario: Future-dated snapshot is rejected
  Given a request for a snapshot dated 2027-01-01 with system date 2026-08-02
  Then it fails with FutureSnapshotError
```
**Points:** 5 · **Deps:** US-3.1

---

#### US-3.5 / US-3.6 — Comparison engine: snapshot↔snapshot and snapshot↔live
**AC**
```gherkin
Scenario: Live vs historical snapshot variance analysis (PRD FR-3 AC)
  Given snapshot "SNAP_31MAR2025" with total net worth ₹250,000,000
  And live net worth on 2026-08-02 of ₹310,000,000
  When the user executes "Compare Live with SNAP_31MAR2025"
  Then a variance table shows delta net worth of +₹60,000,000 and +24.0%
  And top gainers, new asset additions, complete liquidations and asset-class rebalancing shifts are highlighted

Scenario: Comparison across currencies normalises to INR at each side's own rate
  Given snapshot A valued at 2025-03-31 rates and snapshot B at 2026-03-31 rates
  When compared
  Then each side retains its own FX rate
  And the delta separately attributes price movement and currency movement

Scenario: Comparison meets the performance budget (NFR-2)
  Given two snapshots each containing 1,000 positions
  When the delta is computed
  Then it completes in under 2,000 milliseconds
```
**Points:** 8 (combined) · **Deps:** US-3.4

---

#### US-3.7 — Allocation shift and movement classification
**AC**
```gherkin
Scenario: Positions are classified into movement buckets
  Given snapshot A and snapshot B
  When compared
  Then each position is classified as NEW, LIQUIDATED, INCREASED, DECREASED or UNCHANGED
  And asset-class allocation percentages for both sides sum to 100.00% within ±0.01%
```
**Points:** 5 · **Deps:** US-3.5

---

#### US-3.8 — XIRR / CAGR / absolute return
**AC**
```gherkin
Scenario: XIRR is computed across irregular cash flows
  Given cash flows −₹100,000 on 2023-04-01, −₹50,000 on 2024-04-01, +₹200,000 on 2026-04-01
  When XIRR is computed
  Then the result is 20.94% within a tolerance of 0.01 percentage points

Scenario: XIRR on non-converging inputs fails explicitly
  Given cash flows with no sign change
  When XIRR is computed
  Then it fails with XirrNonConvergenceError rather than returning NaN or 0
```
**Points:** 5 · **Deps:** US-3.5

---

### EPIC-4 — Ingestion, Parsers & Template Engine  *(PRD Module 4: FR-4.1)*

#### US-4.1 — Ingestion pipeline framework
**AC**
```gherkin
Scenario: Import is staged and atomically committed
  Given a file with 100 valid rows and 3 invalid rows
  When the import runs in strict mode
  Then nothing is committed and all 3 errors are reported with row numbers
  And when run in lenient mode
  Then 100 rows are committed and 3 are reported as rejected with reasons

Scenario: Every imported record retains its provenance
  Given any successful import
  Then each created record stores sourceFile, sourceRow, parserName and importedAt
```
**Points:** 8 · **Deps:** US-8.3

---

#### US-4.2 — CAMS / KFintech CAS PDF parser
**AC**
```gherkin
Scenario: CAMS CAS PDF auto-ingestion (PRD FR-4 AC)
  Given the user uploads a password-protected CAMS Consolidated Account Statement PDF
  When the user provides the correct decryption password
  Then all folio numbers, ISINs, scheme names, transaction dates, NAVs and units are parsed
  And the domestic mutual fund portfolio is populated without manual entry

Scenario: PDF password is never persisted (NFR-1)
  Given a CAS PDF is decrypted with a password
  When the import completes
  Then the password does not appear in the database, logs, temp files or error payloads
  And the in-memory buffer holding it is overwritten before release

Scenario: Wrong password fails cleanly
  Given an incorrect decryption password
  Then it fails with PdfDecryptionError
  And no partial portfolio data is written
```
**Points:** 13 · **Deps:** US-4.1, US-7.1

---

#### US-4.3 — Zerodha Tax P&L (XLSX) and Tradebook (CSV) parser
**AC**
```gherkin
Scenario: Tradebook CSV populates lots and exits
  Given a Zerodha tradebook fixture with 40 buy and 25 sell rows
  When imported
  Then 40 acquisition lots and 25 exit transactions are created
  And FIFO allocations are recomputed deterministically

Scenario: Tax P&L XLSX cross-checks computed realised gains
  Given a Zerodha Tax P&L XLSX for FY 2025-26
  When imported alongside the tradebook
  Then the system's computed realised gains are reconciled against the broker's figures
  And any variance greater than ₹1 is reported as a reconciliation exception, not silently accepted
```
**Points:** 8 · **Deps:** US-4.1, US-1.3

---

#### US-4.4 — Vested account activity CSV parser
**AC**
```gherkin
Scenario: Vested CSV creates foreign equity lots with USD basis
  Given a Vested account activity CSV containing buys, sells, dividends and fees
  When imported
  Then foreign equity lots are created with USD cost basis
  And both valuation and Rule 115 rates are resolved per transaction
  And fractional share quantities to 6 decimal places are preserved exactly
```
**Points:** 8 · **Deps:** US-4.1, US-1.4

---

#### US-4.5 — E*TRADE portfolio / transaction / GainsKeeper parser
**AC**
```gherkin
Scenario: E*TRADE transaction history distinguishes RSU vest from open-market buy
  Given an E*TRADE transaction CSV containing an RSU release and a market purchase
  When imported
  Then the RSU release creates a lot with perquisite value recorded
  And the market purchase creates an ordinary lot
```
**Points:** 8 · **Deps:** US-4.1, US-1.4

---

#### US-4.6 — Standardised CSV templates and generic template parser
**AC**
```gherkin
Scenario: Custom asset import via predefined template (PRD FR-4 AC)
  Given the user downloads "Custom_HandLoans_Template.csv"
  When the user populates borrower details, principal, interest rate and start date and uploads the CSV
  Then the ingestion engine validates headers, parses rows and adds entries to the hand loan asset ledger

Scenario: Header mismatch is rejected with actionable guidance
  Given a CSV whose headers omit "interest_rate_pct"
  When imported
  Then it fails with TemplateHeaderMismatchError listing missing and unexpected headers

Scenario: Templates are generated for every manual asset class
  When templates are listed
  Then downloadable templates exist for hand loans, real estate, cash, chit funds, unlisted shares and generic brokers
```
**Points:** 5 · **Deps:** US-4.1

---

#### US-4.7 — Idempotent re-import and duplicate detection
**AC**
```gherkin
Scenario: Re-importing the same file creates no duplicates
  Given a tradebook already imported
  When the identical file is imported again
  Then zero new records are created and a DuplicateImport summary is returned

Scenario: Overlapping date-range imports merge without duplication
  Given imports for Apr–Sep and Jul–Dec with overlapping July–September rows
  When both are imported
  Then each underlying transaction exists exactly once, matched on a natural key
```
**Points:** 5 · **Deps:** US-4.1

---

#### US-4.8 — Import error reporting UX
**AC**
```gherkin
Scenario: Row-level errors are surfaced with correction guidance
  Given an import with a malformed date "31/13/2025" on row 17
  Then the error report names row 17, column "trade_date", the offending value and the expected format
```
**Points:** 3 · **Deps:** US-4.1

---

### EPIC-5 — Income Tax, Advance Tax & Capital Gains Engine  *(PRD Module 5: FR-5.1–5.3)*

#### US-5.1 — FY / AY calendar utilities
**AC**
```gherkin
Scenario: Financial year derivation
  Given the date 2026-03-31
  Then the financial year is "2025-26" and the assessment year is "2026-27"
  And given 2026-04-01
  Then the financial year is "2026-27" and the assessment year is "2027-28"

Scenario: Advance tax quarter boundaries
  Then Q1 due date is 15-Jun, Q2 15-Sep, Q3 15-Dec and Q4 15-Mar of the relevant FY
```
**Points:** 2 · **Deps:** US-8.4

---

#### US-5.2 — Versioned tax rule table (ADR-005)
**AC**
```gherkin
Scenario: Rules are resolved by financial year
  Given rule sets for FY 2024-25 and FY 2025-26
  When computing tax for FY 2025-26
  Then only FY 2025-26 rates are applied

Scenario: Missing rule set fails loudly
  Given no rule set for FY 2030-31
  When computing tax for that year
  Then it fails with TaxRulesUnavailableError
  And does not fall back to the most recent year
```
**Points:** 5 · **Deps:** US-5.1

---

#### US-5.3 — Form 16 (Part A & B) parser and manual income entry
**AC**
```gherkin
Scenario: Form 16 Part B yields gross salary, deductions and TDS
  Given a Form 16 Part B fixture for FY 2025-26
  When parsed
  Then gross salary, exempt allowances, chapter VI-A deductions and total TDS deducted are extracted
  And PAN and TAN are stored as PII references, never as plain text in AI payloads

Scenario: Form 16 Part A TDS totals reconcile against Part B
  Given Part A quarterly TDS totalling ₹1,850,000 and Part B stating ₹1,840,000
  When parsed
  Then a reconciliation warning names both figures
  And the user is required to resolve it before advance tax is computed

Scenario: Manual income entry is accepted when no Form 16 exists
  Given manually entered salary, house property and other-sources income
  Then the tax computation proceeds identically to a parsed Form 16
```
**Points:** 8 · **Deps:** US-5.2, US-7.1

---

#### US-5.4 — Old vs New regime slab computation
**AC**
```gherkin
Scenario: Both regimes are computed and the cheaper one is recommended
  Given a gross salary of ₹12,000,000 for FY 2025-26 with ₹150,000 of 80C and ₹50,000 of 80D
  When tax is computed
  Then liability under both the old and new regimes is reported
  And the regime with lower total liability is flagged "recommended"
  And the reason lists the deductions forgone under the new regime

Scenario: Standard deduction differs by regime
  Then the new regime applies its own standard deduction figure from the FY rule table
  And the old regime applies its own, with no cross-contamination
```
**Points:** 8 · **Deps:** US-5.3

---

#### US-5.5 — Surcharge, marginal relief and cess
**AC**
```gherkin
Scenario: Surcharge bands apply at the mandated thresholds (FR-5.1)
  Then income above ₹50L attracts 10%, above ₹1Cr 15%, above ₹2Cr 25% surcharge per the FY rule table
  And health & education cess of 4% applies on tax plus surcharge

Scenario: Marginal relief caps the surcharge cliff
  Given taxable income of ₹5,010,000 (just over the ₹50L threshold)
  When tax is computed
  Then marginal relief is applied so that the incremental tax does not exceed the incremental income
  And the relief amount is itemised in the computation trace

Scenario: Surcharge on capital gains is capped at 15%
  Given total income above ₹2Cr including LTCG
  Then surcharge on the capital gains component is capped at 15%
  And the uncapped rate applies to the remaining income
```
**Points:** 8 · **Deps:** US-5.4

---

#### US-5.6 — HNI classification (ADR-004)
**AC**
```gherkin
Scenario: HNI flag is set on either the income or the net worth test
  Given total income of ₹6,000,000 and net worth of ₹40,000,000
  Then hniStatus is true with reason "INCOME_ABOVE_50L"
  And given total income of ₹3,000,000 and net worth of ₹120,000,000
  Then hniStatus is true with reason "NET_WORTH_ABOVE_10CR"

Scenario: HNI status enables Schedule AL requirement
  Given hniStatus is true because income exceeds ₹50L
  Then Schedule AL generation is marked as required for that AY
```
**Points:** 3 · **Deps:** US-5.5, US-1.15

---

#### US-5.7 — Capital gains classifier (holding period)
**AC**
```gherkin
Scenario: Listed domestic equity holding period boundary (FR-5.2)
  Given listed domestic equity held for exactly 12 months
  Then the gain is classified STCG
  And held for 12 months and 1 day
  Then the gain is classified LTCG

Scenario: Foreign equity holding period boundary
  Given foreign equity held for exactly 24 months
  Then the gain is classified STCG taxed at slab rate
  And held for 24 months and 1 day
  Then the gain is classified LTCG at 12.5% without indexation

Scenario: Debt funds and hand loan interest are slab-taxed
  Then debt fund gains, FD interest and hand loan interest are taxed at the applicable slab rate
  And are never classified as LTCG
```
**Points:** 5 · **Deps:** US-5.2, US-1.3

---

#### US-5.8 — Capital gains computation with exemption, grandfathering and indexation
**AC**
```gherkin
Scenario: LTCG exemption of ₹1.25 lakh applies once per FY
  Given listed equity LTCG of ₹300,000 in FY 2025-26
  Then taxable LTCG is ₹175,000 taxed at 12.5% = ₹21,875
  And the exemption is not applied a second time to a later sale in the same FY

Scenario: Grandfathering uses the higher of cost and 31-Jan-2018 FMV
  Given a lot acquired 2015-06-01 at ₹100 with 31-Jan-2018 FMV of ₹180, sold at ₹250
  Then the cost of acquisition used is ₹180 and the gain is ₹70 per unit
  And given the same lot sold at ₹150
  Then the cost used is ₹150 (capped at sale price) and the gain is ₹0

Scenario: STCG on listed domestic equity is taxed at 20%
  Given listed domestic equity STCG of ₹500,000 in FY 2025-26
  Then the tax on it is ₹100,000 before surcharge and cess

Scenario: Foreign capital gains use the Rule 115 rate on both legs
  Given a foreign lot acquired 2023-05-10 and sold 2026-02-15
  Then acquisition cost is converted at the Rule 115 rate for 2023-04-30
  And proceeds at the Rule 115 rate for 2026-01-31
```
**Points:** 13 · **Deps:** US-5.7, US-2.5

---

#### US-5.9 — Other-sources income aggregation
**AC**
```gherkin
Scenario: Hand loan interest, FD interest and dividends aggregate into other sources
  Given hand loan accrued interest ₹400,000, FD interest ₹73,970.86 and dividends ₹100,000
  Then total other-sources income is ₹573,970.86
  And each component is itemised with its source asset
```
**Points:** 3 · **Deps:** US-1.11, US-1.9, US-1.5

---

#### US-5.10 — Quarterly advance tax engine
**AC**
```gherkin
Scenario: Advance tax calculation for Q3 with capital gains (PRD FR-5 AC)
  Given a user with estimated salary income in the 30% slab with 10% surcharge
  And realised STCG on Indian equities of ₹500,000 on 2025-11-10
  When the advance tax calculation runs for the 15-Dec (Q3) installment
  Then the system computes 75% of total tax liability (salary tax + 20% STCG + surcharge + 4% cess)
  And deducts TDS already remitted by the employer per the Form 16 projection
  And displays the exact net advance tax payable for the Q3 installment

Scenario: Cumulative installments net off prior payments
  Given ₹300,000 already paid across Q1 and Q2
  When the Q3 requirement is ₹900,000 cumulative
  Then the Q3 payable is ₹600,000

Scenario: Capital gains realised after a quarter cutoff are excluded from that quarter
  Given STCG realised on 2025-12-20
  When the Q3 (15-Dec) computation runs
  Then that gain is excluded
  And it is included from Q4 onwards

Scenario: Cumulative percentages follow FR-5.3
  Then Q1 requires 15%, Q2 45%, Q3 75% and Q4 100% of estimated annual liability
```
**Points:** 13 · **Deps:** US-5.8, US-5.9, US-5.5

---

#### US-5.11 — Foreign tax credit / DTAA relief
**AC**
```gherkin
Scenario: US dividend withholding is relieved up to the Indian tax on that income
  Given a US dividend with $125 withheld at the 25% treaty rate
  And Indian tax on that dividend income of ₹8,000 equivalent
  When relief is computed
  Then credit is the lower of foreign tax paid and Indian tax on the doubly-taxed income
  And the excess is reported as non-creditable, not carried silently
```
**Points:** 8 · **Deps:** US-5.10, US-1.5

---

#### US-5.12 — Tax computation explainability trace
**AC**
```gherkin
Scenario: Every computed figure has an auditable derivation
  Given a completed tax computation
  When the trace is requested
  Then each line item shows its inputs, the rule reference (e.g. "FY2025-26 §surcharge.band2") and the arithmetic
  And the sum of trace line items equals the reported total exactly
```
**Points:** 5 · **Deps:** US-5.10

---

### EPIC-6 — HNI Compliance: Schedule FA & Schedule AL  *(PRD Module 6: FR-6.1, FR-6.2)*

#### US-6.1 — Peak value computation over the calendar year
**AC**
```gherkin
Scenario: Peak holding value is the maximum daily value in the calendar year
  Given a foreign holding valued daily from 2025-01-01 to 2025-12-31
  When peak value is computed
  Then it equals the maximum of daily (quantity × price × FX) across the year
  And both the USD and INR peak values with their peak dates are reported

Scenario: Peak value accounts for quantity changes mid-year
  Given 100 shares until 2025-06-30 and 40 shares thereafter
  Then the peak calculation uses the quantity held on each date
```
**Points:** 8 · **Deps:** US-3.4, US-2.5

---

#### US-6.2 — Schedule FA Table A3 generator
**AC**
```gherkin
Scenario: Generating Schedule FA output for US stocks (PRD FR-6 AC)
  Given the foreign snapshot for 31-Dec-2025
  When the user selects "Export Schedule FA Report"
  Then the peak holding value in USD and INR during 2025-01-01 to 2025-12-31 is calculated
  And the closing value on 2025-12-31 is computed using the SBI ITBR rate
  And the output is formatted into a Table A3 compliant JSON/CSV structure ready for ITR upload

Scenario: Table A3 includes gross dividends and gross capital gains for the calendar year
  Then gross amount paid/credited (dividends) and gross proceeds from sale during the calendar year are reported
  And these use the calendar year, not the financial year

Scenario: Assets held for part of the year are reported with acquisition date
  Given a foreign asset acquired 2025-08-01
  Then Table A3 reports the acquisition date and a peak computed only over the held period
```
**Points:** 13 · **Deps:** US-6.1

---

#### US-6.3 — Schedule FA Table D generator (foreign bank / custodial accounts)
**AC**
```gherkin
Scenario: Foreign custodial account is reported with peak and closing balance
  Given a foreign brokerage cash balance across 2025
  Then Table D reports account number as a PII reference, institution name, peak balance and closing balance in INR
```
**Points:** 5 · **Deps:** US-6.1

---

#### US-6.4 — Schedule AL generator
**AC**
```gherkin
Scenario: Schedule AL reports cost of acquisition, not market value (FR-6.2)
  Given a property purchased for ₹15,900,000 now worth ₹32,000,000 on 2026-03-31
  When Schedule AL is generated for AY 2026-27
  Then immovable property is reported at ₹15,900,000

Scenario: Schedule AL is only generated when required
  Given total income of ₹4,000,000 (below ₹50L)
  Then Schedule AL generation reports notRequired with the reason

Scenario: All Schedule AL heads are populated
  Then immovable property, financial assets, cash in hand, loans and advances given, jewellery, vehicles
  And corresponding liabilities are each populated from the 31-Mar snapshot
```
**Points:** 8 · **Deps:** US-5.6, US-1.14, US-3.2

---

#### US-6.5 — ITR-ready export (JSON / CSV)
**AC**
```gherkin
Scenario: Exports validate against the declared schema
  Given generated Schedule FA and AL data
  When exported
  Then the JSON validates against the bundled schema
  And the CSV column order matches the ITR utility's expected order
  And monetary values are rounded to whole rupees per the export specification
```
**Points:** 5 · **Deps:** US-6.2, US-6.4

---

### EPIC-7 — PII Masking Layer for AI Services  *(PRD Module 7: FR-7.1, FR-7.2)*

#### US-7.1 — Regex-based PII masking rules
**AC**
```gherkin
Scenario: PAN is masked
  Given text containing "ABCDE1234F"
  Then the output contains "[REDACTED_PAN]" and not the original

Scenario: Aadhaar is masked in spaced and unspaced forms
  Given "2345 6789 0123" and "234567890123"
  Then both become "[REDACTED_AADHAAR]"

Scenario: DP ID / Client ID / Folio are masked
  Given "DPID: 1208160000123456" and "Folio No: 91234567/89"
  Then both identifiers become "[REDACTED_DEMAT_ACCOUNT]"

Scenario: Email, phone and address are masked
  Given "rajesh@example.com", "+91 98765 43210" and "Flat 4B, MG Road, Bengaluru 560001"
  Then each becomes "[REDACTED_CONTACT]"

Scenario: Transaction and order IDs are masked
  Given "Order ID: 250810400123456"
  Then it becomes "[REDACTED_TXN_ID]"

Scenario: Non-PII numerics are preserved
  Given "holding 500 shares of TCS at ₹3,850.00"
  Then the quantities, symbol and price are unchanged
```
**Points:** 8 · **Deps:** US-8.1

---

#### US-7.2 — NER-based name masking
**AC**
```gherkin
Scenario: Person names are masked while company names survive
  Given "Analyze portfolio for Rajesh Sharma holding 500 shares of Tata Consultancy Services"
  Then "Rajesh Sharma" becomes "[REDACTED_NAME]"
  And "Tata Consultancy Services" is preserved

Scenario: NER runs entirely locally
  When name masking executes
  Then no network request is issued
```
**Points:** 8 · **Deps:** US-7.1

---

#### US-7.3 — Full masking pipeline (PRD FR-7 AC)
**AC**
```gherkin
Scenario: PII scrubbing prior to LLM prompt submission (PRD FR-7 AC)
  Given the raw prompt "Analyze portfolio for Rajesh Sharma, PAN: ABCDE1234F, DPID: 1208160000123456 holding 500 shares of TCS"
  When the prompt passes through the PII anonymization proxy
  Then the payload sent to the LLM reads exactly:
    "Analyze portfolio for [REDACTED_NAME], PAN: [REDACTED_PAN], DPID: [REDACTED_DEMAT_ACCOUNT] holding 500 shares of TCS"
  And no PII entity leaks to external API logs

Scenario: Structured portfolio payloads are masked recursively
  Given a nested portfolio JSON containing borrowerName, panNumber and folioNo at three nesting levels
  Then every PII field at every level is masked
  And the JSON structure and all non-PII values are unchanged
```
**Points:** 5 · **Deps:** US-7.2

---

#### US-7.4 — Fail-closed egress guard (ADR-007)
**AC**
```gherkin
Scenario: Residual PII aborts the AI call
  Given a masking rule gap that leaves a PAN in the payload
  When the egress guard scans the post-mask payload
  Then it throws PiiLeakError and the outbound request is never dispatched

Scenario: All AI egress is funnelled through the guard
  Then a static test asserts that no module outside EgressGateway imports an HTTP client for AI endpoints
```
**Points:** 5 · **Deps:** US-7.3

---

#### US-7.5 — Deterministic pseudonymisation with local reversal map
**AC**
```gherkin
Scenario: The same entity maps to the same token within one session
  Given "Rajesh Sharma" appears three times in one payload
  Then all three become the same token "[REDACTED_NAME_1]"
  And a different person becomes "[REDACTED_NAME_2]"

Scenario: The reversal map never leaves the device
  Then the map is stored only in the encrypted local vault
  And is excluded from every export and every outbound payload
```
**Points:** 5 · **Deps:** US-7.3

---

### EPIC-8 — Platform, Persistence & NFRs  *(PRD §4)*

#### US-8.1 — Monorepo scaffolding and toolchain
**AC**
```gherkin
Scenario: Layering violations fail the build
  Given a domain package importing from apps/
  When lint runs
  Then the build fails with an import-boundary violation

Scenario: Strict TypeScript is enforced
  Then tsconfig.base.json sets strict, noUncheckedIndexedAccess and exactOptionalPropertyTypes
  And any use of `any` in packages/ fails lint
```
**Points:** 5 · **Deps:** —

---

#### US-8.2 — Encrypted local persistence (NFR-1)
**AC**
```gherkin
Scenario: Data at rest is encrypted with page-level AES-256 (ADR-015)
  Given a vault containing portfolio data
  When the raw database file is inspected
  Then no plaintext PAN, name, folio number or monetary value is present

Scenario: Schema metadata is encrypted, not just values (ADR-015)
  Given a vault whose schema includes a table named "hand_loans"
  When the raw database file is inspected
  Then the table name does not appear in plaintext
  And no column name appears in plaintext
  And the file does not begin with the "SQLite format 3" magic header

Scenario: Wrong passphrase fails without leaking whether data exists
  Given an incorrect passphrase
  Then unlocking fails with VaultUnlockError
  And the error reveals nothing about vault contents

Scenario: Tampered ciphertext is detected
  Given a modified byte in the encrypted database file
  Then reading fails with an integrity error and no data is returned
  And the failure occurs even when the correct passphrase is supplied

Scenario: The derived key never touches disk and is zeroised on lock (ADR-014)
  Given an unlocked vault
  When the vault is locked
  Then the derived key buffer is zeroised
  And the passphrase appears in no file, log line or error payload
```
**Points:** 8 · **Deps:** US-8.1

---

#### US-8.3 — Repository layer and migrations
**AC**
```gherkin
Scenario: Migrations are forward-only and versioned
  Then applying migrations to an empty database produces the current schema version
  And re-running is a no-op

Scenario: Repositories return domain objects, never raw rows
  Then every repository method's return type is a domain type with Money and Decimal already constructed
```
**Points:** 5 · **Deps:** US-8.2

---

#### US-8.4 — Money and Decimal value objects (ADR-002)
**AC**
```gherkin
Scenario: Currency mismatch is a compile-time or runtime error
  Given Money(100, "INR") and Money(100, "USD")
  When they are added
  Then it fails with CurrencyMismatchError

Scenario: Rounding is explicit and half-up by default for currency display
  Given ₹2.005
  When rounded to 2 decimals
  Then the result is ₹2.01

Scenario: Tax payable rounds to the nearest ₹10 per section 288B
  Given a computed tax of ₹123,456
  Then the reported payable is ₹123,460
```
**Points:** 5 · **Deps:** US-8.1

---

#### US-8.5 — Application shell UI
**AC**
```gherkin
Scenario: Core navigation exists
  Then the UI exposes Dashboard, Ledger, Import, Snapshots, Tax, Compliance and Settings

Scenario: The dashboard shows net worth with an asset-class breakdown
  Given an unlocked vault with holdings
  Then net worth in INR, asset-class allocation and a snapshot-comparison entry point are visible

Scenario: The interface matches the reference theme (FR-9.1)
  Then all colour, radius, spacing and type values resolve from apps/web/src/theme/tokens.css
  And no component declares a raw hex colour

Scenario: Financial direction never reuses the brand accent (FR-9.2)
  Given a losing position and a primary call-to-action on the same screen
  Then the loss renders in the semantic loss colour and the CTA in the brand accent
  And a zero change renders in muted ink

Scenario: Fonts are bundled, never fetched (FR-9.3)
  Then Inter resolves from a bundled woff2 asset
  And no request is made to any external font origin
```
**Points:** 13 · **Deps:** US-8.3, US-1.15

---

#### US-8.6 — Headless CLI runner
**AC**
```gherkin
Scenario: CLI can import, snapshot and compute tax without the UI
  Then `vantagepoint import --file <f> --parser zerodha`, `vantagepoint snapshot --as-of 2026-03-31`
  And `vantagepoint tax advance --fy 2025-26 --quarter Q3` each run and exit 0
  And exit non-zero with a machine-readable error on failure
```
**Points:** 5 · **Deps:** US-8.3

---

#### US-8.7 — Performance budget harness (NFR-2)
**AC**
```gherkin
Scenario: Budgets are enforced in CI
  Then a benchmark test fails the build if valuation of 1,000 lots exceeds 1,500 ms
  Or if snapshot delta computation on 1,000 positions exceeds 2,000 ms
```
**Points:** 5 · **Deps:** US-1.15, US-3.5

---

#### US-8.8 — Backup, restore and export
**AC**
```gherkin
Scenario: Encrypted backup round-trips exactly
  Given a vault with holdings and snapshots
  When backed up and restored into a fresh vault
  Then every snapshot contentHash matches the original
```
**Points:** 5 · **Deps:** US-8.2

---

#### US-8.9 — No-PII logging guarantee
**AC**
```gherkin
Scenario: Logs never contain PII
  Given an operation that processes a PAN, a folio number and a borrower name
  When logs are captured
  Then no log line matches any PII pattern
  And error objects thrown across package boundaries carry no PII in their message or cause chain
```
**Points:** 3 · **Deps:** US-7.1

---

#### US-8.10 — EgressGateway and offline-by-default (ADR-010)
**AC**
```gherkin
Scenario: No network call occurs without explicit user action
  Given the app starts and the vault is unlocked
  Then zero outbound requests are issued

Scenario: All egress is auditable
  Then every outbound request is recorded locally with destination, purpose, timestamp and payload byte size
```
**Points:** 5 · **Deps:** US-8.1

---

#### US-8.11 — Backend API service (`apps/api`)
**As a** containerized frontend **I want** a backend HTTP service exposing the portfolio use cases
**so that** the SPA can run in its own container without embedding the domain engines.

**AC**
```gherkin
Scenario: API exposes the use cases the SPA needs
  Then POST /api/vault/unlock, GET /api/portfolio/valuation, POST /api/snapshots,
       GET /api/snapshots/:id/compare, POST /api/imports and GET /api/tax/advance
  And each returns a typed JSON contract validated against a shared schema

Scenario: The API is a thin shell with no business logic
  Then every route handler delegates to app-services
  And a static test asserts no route file imports a domain package directly

Scenario: Health endpoint reports readiness distinctly from liveness
  Given the process is up but the vault is locked
  Then GET /api/health/live returns 200
  And GET /api/health/ready returns 503 with reason "VAULT_LOCKED"

Scenario: Vault passphrase is never logged or persisted (ADR-014)
  Given a vault unlock request
  Then the passphrase appears in no log line, no error payload and no file on disk

Scenario: The compliance scheduler never silently skips a statutory snapshot
  Given the application was last run on 2025-11-01
  And the current date is 2026-06-01
  When the scheduler runs
  Then it is invoked with the persisted last-run instant, not the default 24-hour window
  And the missed "DOM_31MAR2026" snapshot is created
  And the last-run instant is persisted only after the snapshots are committed
```
> **Load-bearing.** `CompliancePolicy.dueSnapshots` defaults to a 24-hour window, so a user who does
> not open the app for a few months would otherwise never get their 31-Mar snapshot — a silent
> compliance failure with no error to notice. Persisting and passing `since` is what closes that,
> and it has no owner until this story.

**Points:** 8 · **Deps:** US-8.3, US-8.9, US-3.2

---

### EPIC-9 — Containerized Deployment & Host-Native Persistence  *(PRD Module 8: FR-8.1–8.3, NFR-4)*

> **Epic goal:** `docker compose up` on a clean host yields a working frontend + backend, with the
> encrypted database living on the host's own disk where the user can see and back it up.

---

#### US-9.1 — Backend container image (`vantagepoint-api`)
**As an** operator **I want** the backend packaged as a self-contained image **so that** it runs on any
host without a Node toolchain.

**AC**
```gherkin
Scenario: Image builds and runs with no host toolchain
  Given a host with only Docker installed
  When "docker build -f docker/api.Dockerfile ." runs
  Then the image builds successfully
  And "docker run" starts the API and /api/health/live returns 200

Scenario: Multi-stage build excludes build tooling from the runtime layer
  Given the built runtime image
  Then it contains no devDependencies, no TypeScript compiler and no test files
  And the image is under 400 MB

Scenario: Container runs as a non-root user (FR-8.3)
  When "id -u" is executed inside the running container
  Then the result is not 0

Scenario: Root filesystem is read-only except data and tmp
  When a write to /app is attempted inside the container
  Then it fails with a read-only filesystem error
  And writes to /var/lib/vantagepoint and /tmp succeed

Scenario: Base image is pinned by digest
  Then the Dockerfile FROM line references a sha256 digest, not a floating tag
```
**Points:** 8 · **Deps:** US-8.11

---

#### US-9.2 — Frontend container image (`vantagepoint-web`)
**AC**
```gherkin
Scenario: SPA is served from the container with API proxying
  Given the stack is running
  When the browser requests "/"
  Then the SPA loads
  And a request to "/api/health/live" is proxied to the backend and returns 200

Scenario: Deep links resolve to the SPA (history fallback)
  When "/snapshots/DOM_31MAR2026" is requested directly
  Then the SPA index is served with HTTP 200, not a 404

Scenario: The PII masker ships in the browser bundle (ADR-013)
  Then the built SPA bundle contains the pii-masker module
  And a static test asserts apps/api does not import the masker's masking entry point

Scenario: Frontend container runs as non-root with a read-only filesystem
  Then the effective UID is non-zero and the root filesystem is read-only
```
**Points:** 8 · **Deps:** US-8.5, US-9.1

---

#### US-9.3 — Compose stack orchestration
**AC**
```gherkin
Scenario: Clean-host bring-up with no local toolchain (PRD FR-8 AC)
  Given a host with only Docker and Docker Compose installed
  And no Node.js, pnpm or build toolchain present
  When the user runs "docker compose up"
  Then the frontend is reachable on the published port
  And the backend health endpoint reports healthy
  And the user can unlock a vault and view the dashboard

Scenario: Only the web service publishes a host port
  When the running stack's port bindings are inspected
  Then vantagepoint-web publishes a host port
  And vantagepoint-api publishes none and is reachable only on the internal network

Scenario: Web waits for API readiness before accepting traffic
  Given the API takes 3 seconds to become ready
  Then compose's depends_on condition service_healthy gates the web container

Scenario: Egress is denied by default and opt-in via profile (ADR-010)
  Given the default stack is running
  When the API attempts an outbound request to an external host
  Then it fails
  And when started with "docker compose -f compose.yaml -f compose.egress.yaml up"
  Then outbound requests to the allow-listed FX hosts succeed
```
**Points:** 8 · **Deps:** US-9.1, US-9.2

---

#### US-9.4 — Host-native bind-mount persistence (ADR-012, FR-8.2)
**As a** user **I want** my encrypted database on my own disk **so that** I can back it up, move it and
never lose it to a container lifecycle event.

**AC**
```gherkin
Scenario: Database persists on the host disk across container destruction (PRD FR-8 AC)
  Given a running stack with portfolio data and a snapshot "DOM_31MAR2026"
  When the user runs "docker compose down" and then "docker compose up" again
  Then the vault unlocks with the same passphrase
  And snapshot "DOM_31MAR2026" is present with an identical contentHash
  And the database file is visible on the host filesystem at the configured data directory

Scenario: Database survives an image rebuild (PRD FR-8 AC)
  Given a running stack with existing portfolio data
  When the images are rebuilt with "docker compose build --no-cache" and the stack is restarted
  Then all pre-existing data remains intact and readable

Scenario: Data directory is a bind mount, not a Docker-managed volume
  When the container's mounts are inspected
  Then the data mount Type is "bind"
  And its Source is an absolute path on the host filesystem

Scenario: Data directory location is configurable
  Given VANTAGEPOINT_DATA_DIR is set to "/mnt/backup/vantagepoint"
  When the stack starts
  Then the database is created under /mnt/backup/vantagepoint on the host

Scenario: Nothing is written to the container writable layer
  Given a session that creates a vault, imports a file and generates a snapshot
  When "docker diff" is run on the API container
  Then no database or portfolio file appears in the container's diff
```
**Points:** 8 · **Deps:** US-9.3, US-8.2

---

#### US-9.5 — Host UID/GID ownership mapping
**AC**
```gherkin
Scenario: Bind-mounted files are owned by the host user (FR-8.3)
  Given VANTAGEPOINT_UID and VANTAGEPOINT_GID are set to the invoking host user
  When the stack creates the vault database
  Then the file on the host is owned by that UID/GID
  And the host user can read, copy and delete it without sudo

Scenario: Unwritable data directory fails fast with an actionable message
  Given the host data directory is not writable by the configured UID
  When the container starts
  Then it exits non-zero before touching the database
  And the message names the path, the expected UID/GID and the remediation command
```
**Points:** 5 · **Deps:** US-9.4

---

#### US-9.6 — Secret handling and image hygiene
**AC**
```gherkin
Scenario: No secrets are baked into images (PRD FR-8 AC)
  Given a built backend image
  When its layers are inspected
  Then no vault passphrase, API key or .env file is present in any layer

Scenario: .dockerignore excludes data, secrets and history
  Then .dockerignore excludes ./data, .env, *.db, .git and node_modules

Scenario: Passphrase is supplied at runtime and held in memory only (ADR-014)
  Given the vault is unlocked via the API
  When the container filesystem and environment are inspected
  Then the passphrase is absent from both
```
**Points:** 5 · **Deps:** US-9.1

---

#### US-9.7 — Containerized performance budgets and E2E (NFR-2, NFR-4)
**AC**
```gherkin
Scenario: NFR budgets hold inside the container
  Given the stack is running with a 1,000-lot portfolio
  When valuation is requested through the API
  Then the server-side computation completes in under 1,500 ms
  And snapshot delta computation completes in under 2,000 ms

Scenario: E2E journeys run against the containerized stack
  When the Playwright suite runs with the base URL pointing at the compose stack
  Then the unlock → import → snapshot → compare → advance-tax journey passes
```
**Points:** 5 · **Deps:** US-9.3, US-8.7

---

#### US-9.8 — Cross-platform verification and operator documentation
**AC**
```gherkin
Scenario: The same compose file works on Linux, macOS and Windows/WSL2
  Then bind-mount paths use forward slashes and relative defaults that resolve on all three
  And no host-OS-specific mount flag is required

Scenario: Operator documentation covers the full lifecycle
  Then README documents first-run, data directory configuration, backup, restore,
       upgrade, log inspection and a "where is my data" answer naming the host path
```
**Points:** 3 · **Deps:** US-9.5, US-8.8

---

## 6. Milestones

| Milestone | Contents | Exit criteria |
|---|---|---|
| **M0 — Test scaffold** | Repo skeleton, toolchain, **all acceptance tests written and failing (red)** | Every Gherkin scenario in §5 has a named failing test; CI runs and reports the red count |
| **M1 — Kernel** | US-8.1 … US-8.4, US-8.9, US-8.10, US-5.1 | Money/Decimal, encrypted vault, migrations green |
| **M2 — Ledger** | EPIC-1 (US-1.1 … US-1.15) | FIFO, all asset classes, valuation budget met |
| **M3 — FX** | EPIC-2 | Rule 115 + fallback chain + dual rate green |
| **M4 — Snapshots** | EPIC-3 | Dual compliance snapshots, comparison budget met |
| **M5 — Tax** | EPIC-5 | Advance tax Q1–Q4, CG engine, regime comparison green |
| **M6 — Ingestion** | EPIC-4 | CAMS/Zerodha/Vested/E*TRADE/templates green |
| **M7 — Privacy** | EPIC-7 | Masking + fail-closed egress guard green |
| **M8 — UI/API/CLI** | US-8.5, US-8.6, US-8.7, US-8.8, US-8.11 | E2E journeys green |
| **M9 — Containerization** | EPIC-9 (US-9.1 … US-9.8) | `docker compose up` on a clean host works; data survives `down`/rebuild on the host disk; budgets hold in-container |
| **M10 — Compliance (Phase 2)** | EPIC-6 | Schedule FA/AL exports schema-valid |

**Phase 1 (PRD §6)** = M0–M9. **Phase 2** = M10 + broker API sync + AI insights.

> **Sequencing note:** EPIC-9 lands at M9 rather than M1 because the container images package artifacts
> that must exist first (`apps/api`, `apps/web` builds). However, **US-9.1 and US-9.3 are stubbed at M1**
> with a hello-world API and compose file, so the bind-mount and non-root posture are exercised by CI from
> day one. Discovering at M9 that SQLite + bind mount + non-root has a permissions problem would be an
> expensive surprise; a walking-skeleton container at M1 costs half a day and removes that risk (R8).

---

## 7. Implementation Tracker (user-story level)

Status legend: `TODO` · `TESTS_RED` (acceptance tests written and failing) · `WIP` (some, not all, of the story's ACs pass) · `REVIEW` · `DONE` (every AC green) · `BLOCKED`

| ID | Story | Epic | PRD FR | Pri | Pts | Milestone | Deps | Test files | Status |
|----|-------|------|--------|-----|-----|-----------|------|-----------|--------|
| US-8.1 | Monorepo scaffolding & toolchain | 8 | §4 | P0 | 5 | M1 | — | `tests/functional/platform/toolchain.spec.ts` | DONE |
| US-8.2 | Encrypted local persistence | 8 | NFR-1 | P0 | 8 | M1 | 8.1 | `packages/persistence/test/vault-encryption.spec.ts` | DONE |
| US-8.3 | Repository layer & migrations | 8 | NFR-1 | P0 | 5 | M1 | 8.2 | `packages/persistence/test/migrations.spec.ts` | DONE |
| US-8.4 | Money & Decimal value objects | 8 | ADR-002 | P0 | 5 | M1 | 8.1 | `packages/shared-kernel/test/money.spec.ts` | DONE |
| US-8.9 | No-PII logging guarantee | 8 | FR-7.1 | P0 | 3 | M1 | 7.1 | `tests/functional/privacy/no-pii-logs.spec.ts` | DONE |
| US-8.10 | EgressGateway / offline-by-default | 8 | §4.3 | P0 | 5 | M1 | 8.1 | `tests/functional/privacy/egress-gateway.spec.ts` | DONE |
| US-5.1 | FY / AY calendar utilities | 5 | FR-5.1 | P0 | 2 | M1 | 8.4 | `packages/tax-engine/test/fy-calendar.spec.ts` | DONE |
| US-1.1 | Typed asset registry & taxonomy | 1 | FR-1.1 | P0 | 3 | M2 | 8.1, 8.4 | `packages/core-domain/test/asset-registry.spec.ts` | DONE |
| US-1.2 | Acquisition lot with cost basis | 1 | FR-1.2 | P0 | 3 | M2 | 1.1 | `packages/core-domain/test/acquisition-lot.spec.ts` | DONE |
| US-1.3 | FIFO partial/complete exit | 1 | FR-1.2 | P0 | 5 | M2 | 1.2 | `packages/core-domain/test/fifo-allocation.spec.ts` | DONE |
| US-1.4 | Foreign lots, dual-currency basis | 1 | FR-1.1 | P0 | 8 | M2 | 1.3, 2.4, 2.5 | `packages/core-domain/test/foreign-equity.spec.ts` | DONE |
| US-1.5 | Dividend & interest with withholding | 1 | FR-1.2 | P0 | 5 | M2 | 1.4, 2.4 | `packages/core-domain/test/income-events.spec.ts` | DONE |
| US-1.6 | Corporate actions | 1 | FR-1.2 | P1 | 5 | M2 | 1.3 | `packages/core-domain/test/corporate-actions.spec.ts` | DONE |
| US-1.7 | Mutual fund holdings & NAV | 1 | FR-1.1 | P0 | 5 | M2 | 1.2 | `packages/core-domain/test/mutual-fund.spec.ts` | DONE |
| US-1.8 | EPF/VPF/NPS/PPF/Gratuity | 1 | FR-1.1 | P0 | 8 | M2 | 1.1 | `packages/core-domain/test/statutory-schemes.spec.ts` | DONE |
| US-1.9 | Fixed & recurring deposits | 1 | FR-1.1 | P0 | 3 | M2 | 1.1 | `packages/core-domain/test/deposits.spec.ts` | DONE |
| US-1.10 | Alternative & private assets | 1 | FR-1.1 | P1 | 5 | M2 | 1.1 | `packages/core-domain/test/alternative-assets.spec.ts` | DONE |
| US-1.11 | Hand loans with interest accrual | 1 | FR-1.1 | P0 | 5 | M2 | 1.1, 7.1 | `packages/core-domain/test/hand-loans.spec.ts` | DONE |
| US-1.12 | Chit / family savings schemes | 1 | FR-1.1 | P1 | 3 | M2 | 1.1 | `packages/core-domain/test/chit-schemes.spec.ts` | DONE |
| US-1.13 | Cash in hand & bank balances | 1 | FR-1.1 | P0 | 2 | M2 | 1.1 | `packages/core-domain/test/cash-holdings.spec.ts` | DONE |
| US-1.14 | Liabilities ledger | 1 | FR-6.2 | P0 | 3 | M2 | 1.1 | `packages/core-domain/test/liabilities.spec.ts` | DONE |
| US-1.15 | Portfolio valuation engine | 1 | NFR-2 | P0 | 8 | M2 | 1.4–1.14, 2.5 | `packages/core-domain/test/valuation-engine.spec.ts`, `tests/functional/perf/valuation-budget.bench.ts` | DONE |
| US-2.1 | FX rate store with provenance | 2 | FR-2.1 | P0 | 3 | M2 (pulled fwd) | 8.3 | `packages/fx-itbr/test/rate-store.spec.ts` | DONE |
| US-2.2 | SBI ITBR ingestion pipeline | 2 | FR-2.1 | P0 | 5 | M3 | 2.1, 8.10 | `packages/fx-itbr/test/sbi-ingestion.spec.ts` | DONE |
| US-2.3 | Fallback hierarchy resolver | 2 | FR-2.1 | P0 | 5 | M2 (pulled fwd) | 2.1 | `packages/fx-itbr/test/fallback-chain.spec.ts` | DONE |
| US-2.4 | Rule 115 resolver | 2 | FR-2.1 | P0 | 5 | M2 (pulled fwd) | 2.3 | `packages/fx-itbr/test/rule-115.spec.ts` | DONE |
| US-2.5 | Dual-rate conversion service | 2 | ADR-003 | P0 | 5 | M2 (pulled fwd) | 2.4 | `packages/fx-itbr/test/dual-rate-conversion.spec.ts` | DONE |
| US-2.6 | Retro rate finalisation | 2 | FR-2.1 | P1 | 8 | M3 | 2.5, 3.1 | `packages/fx-itbr/test/rate-amendment.spec.ts` | DONE |
| US-3.1 | Immutable content-addressed snapshot | 3 | FR-3.1 | P0 | 5 | M4 | 1.15 | `packages/snapshot/test/compliance-scheduler.spec.ts` | DONE |
| US-3.2 | 31-Mar domestic auto snapshot | 3 | FR-3.1 | P0 | 5 | M4 | 3.1 | `packages/snapshot/test/compliance-scheduler.spec.ts` | DONE |
| US-3.3 | 31-Dec foreign auto snapshot | 3 | FR-3.1 | P0 | 3 | M4 | 3.1 | `packages/snapshot/test/compliance-scheduler.spec.ts` | DONE |
| US-3.4 | Custom arbitrary-date snapshot | 3 | FR-3.1 | P0 | 5 | M4 | 3.1 | `packages/snapshot/test/custom-snapshot.spec.ts` | DONE |
| US-3.5 | Snapshot ↔ snapshot comparison | 3 | FR-3.1 | P0 | 5 | M4 | 3.4 | `packages/snapshot/test/comparison-engine.spec.ts` | DONE |
| US-3.6 | Snapshot ↔ live comparison | 3 | FR-3.1 | P0 | 3 | M4 | 3.5 | `tests/functional/snapshot/live-vs-historical.spec.ts` | DONE |
| US-3.7 | Allocation shift & movement buckets | 3 | FR-3.1 | P0 | 5 | M4 | 3.5 | `packages/snapshot/test/comparison-engine.spec.ts` | DONE |
| US-3.8 | XIRR / CAGR / absolute return | 3 | FR-3.1 | P0 | 5 | M4 | 3.5 | `packages/snapshot/test/comparison-engine.spec.ts` | DONE |
| US-5.2 | Versioned tax rule table | 5 | FR-5.1 | P0 | 5 | M5 | 5.1 | `packages/tax-engine/test/rule-table.spec.ts` | DONE |
| US-5.3 | Form 16 parser & manual income | 5 | FR-5.1 | P0 | 8 | M6 (folded in) | 5.2, 7.1 | `packages/tax-engine/test/form16-parser.spec.ts` | DONE |
| US-5.4 | Old vs New regime slabs | 5 | FR-5.1 | P0 | 8 | M5 | 5.3 | `packages/tax-engine/test/regime-comparison.spec.ts` | DONE |
| US-5.5 | Surcharge, marginal relief, cess | 5 | FR-5.1 | P0 | 8 | M5 | 5.4 | `packages/tax-engine/test/surcharge-relief.spec.ts` | DONE |
| US-5.6 | HNI classification | 5 | FR-5.1 | P0 | 3 | M5 | 5.5, 1.15 | `packages/tax-engine/test/hni-classification.spec.ts` | DONE |
| US-5.7 | Capital gains classifier | 5 | FR-5.2 | P0 | 5 | M5 | 5.2, 1.3 | `packages/tax-engine/test/cg-classifier.spec.ts` | DONE |
| US-5.8 | CG computation, exemption, grandfathering | 5 | FR-5.2 | P0 | 13 | M5 | 5.7, 2.5 | `packages/tax-engine/test/capital-gains.spec.ts` | DONE |
| US-5.9 | Other-sources income aggregation | 5 | FR-5.3 | P0 | 3 | M5 | 1.11, 1.9, 1.5 | `packages/tax-engine/test/other-sources.spec.ts` | DONE |
| US-5.10 | Quarterly advance tax engine | 5 | FR-5.3 | P0 | 13 | M5 | 5.8, 5.9, 5.5 | `packages/tax-engine/test/advance-tax.spec.ts`, `tests/functional/tax/advance-tax-q3.spec.ts` | DONE |
| US-5.11 | Foreign tax credit / DTAA | 5 | FR-5.1 | P1 | 8 | M5 | 5.10, 1.5 | `packages/tax-engine/test/foreign-tax-credit.spec.ts` | DONE |
| US-5.12 | Tax computation trace | 5 | FR-5.1 | P1 | 5 | M5 | 5.10 | `packages/tax-engine/test/computation-trace.spec.ts` | DONE |
| US-4.1 | Ingestion pipeline framework | 4 | FR-4.1 | P0 | 8 | M6 | 8.3 | `packages/ingestion/test/pipeline.spec.ts` | DONE |
| US-4.2 | CAMS / KFintech CAS PDF parser | 4 | FR-4.1 | P0 | 13 | M6 | 4.1, 7.1 | `packages/ingestion/test/cams-cas-parser.spec.ts` | DONE |
| US-4.3 | Zerodha XLSX + CSV parser | 4 | FR-4.1 | P0 | 8 | M6 | 4.1, 1.3 | `packages/ingestion/test/zerodha-parser.spec.ts` | DONE |
| US-4.4 | Vested CSV parser | 4 | FR-4.1 | P0 | 8 | M6 | 4.1, 1.4 | `packages/ingestion/test/vested-parser.spec.ts` | DONE |
| US-4.5 | E*TRADE parser | 4 | FR-4.1 | P0 | 8 | M6 | 4.1, 1.4 | `packages/ingestion/test/etrade-parser.spec.ts` | DONE |
| US-4.6 | Standardised CSV templates | 4 | FR-4.1 | P0 | 5 | M6 | 4.1 | `packages/ingestion/test/csv-templates.spec.ts` | DONE |
| US-4.7 | Idempotent re-import | 4 | FR-4.1 | P0 | 5 | M6 | 4.1 | `packages/ingestion/test/idempotency.spec.ts` | DONE |
| US-4.8 | Row-level error reporting | 4 | FR-4.1 | P1 | 3 | M6 | 4.1 | `packages/ingestion/test/error-reporting.spec.ts` | DONE |
| US-7.1 | Regex PII masking rules | 7 | FR-7.2 | P0 | 8 | M1 (pulled fwd) | 8.1 | `packages/pii-masker/test/regex-rules.spec.ts` | DONE |
| US-7.2 | NER name masking | 7 | FR-7.2 | P0 | 8 | M7 | 7.1 | `packages/pii-masker/test/ner-names.spec.ts` | DONE |
| US-7.3 | Full masking pipeline | 7 | FR-7.1 | P0 | 5 | M2 (pulled fwd) | 7.2 | `packages/pii-masker/test/masking-pipeline.spec.ts` | DONE |
| US-7.4 | Fail-closed egress guard | 7 | FR-7.1 | P0 | 5 | M7 | 7.3 | `packages/pii-masker/test/egress-guard.spec.ts` | DONE |
| US-7.5 | Deterministic pseudonymisation | 7 | FR-7.2 | P1 | 5 | M7 | 7.3 | `packages/pii-masker/test/pseudonymiser.spec.ts` | DONE |
| US-8.5 | Application shell UI | 8 | §3 | P0 | 13 | M11 | 8.3, 1.15 | `tests/e2e/app-shell.spec.ts` | DONE |
| US-8.6 | Headless CLI runner | 8 | §4.3 | P1 | 5 | M8 | 8.3 | `tests/functional/cli/commands.spec.ts` | DONE |
| US-8.7 | Performance budget harness | 8 | NFR-2 | P0 | 5 | M8 | 1.15, 3.5 | `tests/functional/perf/budgets.bench.ts` | DONE |
| US-8.8 | Backup / restore / export | 8 | NFR-1 | P1 | 5 | M8 | 8.2 | `tests/functional/platform/backup-restore.spec.ts` | DONE |
| US-8.11 | Backend API service | 8 | FR-8.1 | P0 | 8 | M8 | 8.3, 8.9 | `tests/functional/api/routes.spec.ts` | DONE |
| US-9.1 | Backend container image | 9 | FR-8.1 | P0 | 8 | M9 (skeleton M1) | 8.11 | `tests/container/api-image.spec.ts` | DONE |
| US-9.2 | Frontend container image | 9 | FR-8.1 | P0 | 8 | M9 | 8.5, 9.1 | `tests/container/web-image.spec.ts` | DONE |
| US-9.3 | Compose stack orchestration | 9 | FR-8.1 | P0 | 8 | M9 (skeleton M1) | 9.1, 9.2 | `tests/container/compose-stack.spec.ts` | DONE |
| US-9.4 | Host bind-mount persistence | 9 | FR-8.2 | P0 | 8 | M9 | 9.3, 8.2 | `tests/container/host-persistence.spec.ts` | DONE |
| US-9.5 | Host UID/GID ownership mapping | 9 | FR-8.3 | P0 | 5 | M9 | 9.4 | `tests/container/ownership.spec.ts` | DONE |
| US-9.6 | Secret handling & image hygiene | 9 | FR-8.3 | P0 | 5 | M9 | 9.1 | `tests/container/image-hygiene.spec.ts` | DONE |
| US-9.7 | In-container budgets & E2E | 9 | NFR-2, NFR-4 | P0 | 5 | M9 | 9.3, 8.7 | `tests/container/perf-in-container.spec.ts`, `tests/e2e/*` | DONE |
| US-9.8 | Cross-platform & operator docs | 9 | NFR-4 | P1 | 3 | M9 | 9.5, 8.8 | `tests/container/cross-platform.spec.ts` | DONE |
| US-6.1 | Peak value computation | 6 | FR-6.1 | P2 | 8 | M10 | 3.4, 2.5 | `packages/compliance/test/peak-value.spec.ts` | DONE |
| US-6.2 | Schedule FA Table A3 | 6 | FR-6.1 | P2 | 13 | M10 | 6.1 | `packages/compliance/test/schedule-fa-a3.spec.ts` | DONE |
| US-6.3 | Schedule FA Table D | 6 | FR-6.1 | P2 | 5 | M10 | 6.1 | `packages/compliance/test/schedule-fa-d.spec.ts` | DONE |
| US-6.4 | Schedule AL generator | 6 | FR-6.2 | P2 | 8 | M10 | 5.6, 1.14, 3.2 | `packages/compliance/test/schedule-al.spec.ts` | DONE |
| US-6.5 | ITR-ready JSON/CSV export | 6 | FR-6.1 | P2 | 5 | M10 | 6.2, 6.4 | `packages/compliance/test/itr-export.spec.ts` | DONE |

**Totals:** 80 stories · 460 points · Phase 1 (M0–M9) = 72 stories / 421 pts (of which EPIC-9 = 8 stories /
50 pts) · Phase 2 = 5 stories / 39 pts (EPIC-6) + backlog.

---

## 8. Test Strategy

| Layer | Tool | Scope | Runs against |
|---|---|---|---|
| **Unit** | Vitest, colocated in `packages/*/test/` | One domain package, ports stubbed. Every Gherkin scenario in §5 has a `describe`/`it` named after it. | Pure functions, injected `Clock`/`IdGenerator` |
| **Property** | `fast-check` under Vitest | FIFO invariants, Money arithmetic, masking idempotence | Domain packages |
| **Functional** | Vitest, `tests/functional/` | Cross-package use cases through `app-services`, real SQLite in a temp dir, fixture files, network hard-blocked | Whole system minus UI |
| **Benchmark** | Vitest `bench` | NFR-2 budgets, fails the build on regression | `core-domain`, `snapshot` |
| **Container** | Vitest, `tests/container/` (tag `@container`) | FR-8 acceptance: clean-host bring-up, bind-mount persistence across `down`/rebuild, non-root, read-only FS, image hygiene, in-container budgets | Real `docker compose` stack |
| **E2E** | Playwright, `tests/e2e/` | User journeys: unlock → import → snapshot → compare → advance tax | The **containerized** stack (base URL = compose web port) |

**Rules:**
- No test issues a network request. `EgressGateway` is stubbed and a global `fetch` trap fails any test that tries.
- Every test that touches money asserts exact `Money` equality, never `toBeCloseTo` on rupees.
- Every test that touches dates injects a fixed `Clock`; `Date.now()` in test bodies fails lint.
- Fixtures are synthetic. **No real PAN, Aadhaar, folio number or account number ever enters the repo** — fixture generators produce structurally valid but non-issued values.
- Test names carry the story ID (`US-5.10`) so the tracker is mechanically verifiable.
- Container tests are tagged `@container` and excluded from the fast unit run; they require a Docker
  daemon and each provisions its own throwaway host data directory under the OS temp path, asserting on
  the **host-side** file after the container writes it.

---

## 9. Risks

| # | Risk | Impact | Mitigation |
|---|------|--------|-----------|
| R1 | SBI publishes ITBR sheets in an unstable format (PDF layout drift) | FX engine silently wrong | Parser asserts a structural fingerprint; layout change fails the ingest rather than producing rates. Fallback chain covers the gap. |
| R2 | CAMS CAS PDF layout varies by generation date and RTA | Import failures | Multiple layout adapters selected by fingerprint; unrecognised layout falls back to the CSV template path rather than guessing. |
| R3 | Indian tax rules change mid-build | Rework across the tax engine | ADR-005 rule tables; engine code carries no rates. New FY = new JSON file. |
| R4 | Rule 115 vs trade-date ambiguity (ADR-003) is challenged by a CA | Tax output disputed | Both values stored and shown with provenance; the computation trace (US-5.12) names the rule applied for every figure. |
| R5 | **Name detection misses a name** | PII leak to LLM | **The original mitigation was wrong and has been replaced.** It claimed the fail-closed guard was the backstop; the guard cannot be, because a PAN has a shape and a name does not. Actual mitigation, in order: (1) the detector **over-masks by default** — anything proper-noun-shaped is masked unless positively identified as an organisation, ticker or common term; (2) structured payloads are masked by **field semantics**, never by detection; (3) the guard re-runs detection, which catches a broken pipeline though not a detector blind spot. Residual risk is stated in `verifier.ts` and pinned by tests. |
| R6 | Performance budget missed on 1,000+ lots with per-day FX lookups | NFR-2 breach | Rate cache keyed by (currency, date); valuation batches lookups. Benchmark in CI from M2 so regressions surface immediately. |
| R7 | Grandfathering FMV data unavailable (OQ-4) | LTCG overstated for pre-2018 holdings | Manual per-lot entry; engine flags affected lots as `grandfatheringDataMissing` rather than assuming cost. |
| R8 | Non-root container + bind-mounted SQLite hits UID/permission problems, differently on Linux vs macOS vs WSL2 | Stack unusable on some hosts; discovered late | Walking-skeleton container at M1 (see M9 sequencing note), configurable `VANTAGEPOINT_UID/GID` (US-9.5), entrypoint pre-flight that fails fast with the exact `chown` remediation. |
| R9 | `better-sqlite3` is a native module — build must match the container's libc (glibc vs musl) | Image build breaks or crashes at runtime | Pin the runtime base to a glibc image (`node:22-bookworm-slim`), rebuild the native module in the builder stage against that exact base, and assert it loads in a container smoke test. |
| R10 | SQLite over a bind mount on macOS/Windows can have fsync/locking quirks | Corruption risk under concurrent writes | Single-writer API process (no multi-replica), WAL mode with `synchronous=FULL`, and an integrity-check assertion in the persistence round-trip test. Documented as a single-instance deployment. |
| R11 | Containerizing tempts a move of PII masking to the backend | Unmasked PII crosses the wire — defeats FR-7 | ADR-013 plus a static test (US-9.2) asserting `apps/api` never imports the masker's masking entry point. |

---

## 10. Execution Order & Current State

1. ✅ **Architecture** — [`ARCHITECTURE_vantagepoint.md`](./ARCHITECTURE_vantagepoint.md): C4 context/container/
   component views, 7 data-flow sequence diagrams, trust boundaries, deployment view. All 12 Mermaid
   diagrams parse-verified.
2. ✅ **Tests first (M0)** — acceptance tests for every Gherkin scenario in §5, written against
   contract-only interfaces. **All 80 tracker rows are `TESTS_RED`.**
3. ⬜ **M1 → M9** implementation, turning tests green milestone by milestone (walking-skeleton container
   at M1, full containerization at M9).
4. ⬜ **M10** Phase 2 compliance exports.

### M0 result (2026-08-02)

All acceptance tests written first against contract-only interfaces; all 80 tracker rows reached
`TESTS_RED`.

### M1 result (2026-08-02) — COMPLETE

```
pnpm test        463 tests · 125 passing · 338 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`DONE`: US-8.1, US-8.2, US-8.3, US-8.4, US-8.9, US-8.10, US-5.1, US-7.1 (8 stories, 41 pts).

Fully green packages: `shared-kernel` (36), `persistence` (30), `platform` (17). The remaining 338
failures are unimplemented stories reporting `NotImplementedError ... (US-x.y)`, exactly as intended.

**Plan corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **AES-256-GCM is unavailable** for whole-file SQLite encryption. The original NFR-1 wording could not be implemented as written. | ADR-015; NFR-1 amended to page-level AES-256-CBC + HMAC-SHA512. Evidence table in §0. |
| 2 | **A lightweight open probe does not detect tampering** — a tampered vault opens and returns data. Only `quick_check`/`integrity_check` walk every page. | `Vault.unlock` runs `quick_check` and refuses a vault that fails it. Without this the tamper-detection AC passes while the property does not hold. |
| 3 | **US-8.9 (M1) depended on US-7.1 (M7)** — a logger cannot scrub PII without the masking rules. | US-7.1 pulled forward into M1. The dependency graph already required it; the milestone assignment was wrong. |
| 4 | **No workspace package declared its dependencies.** Resolution worked only via vitest aliases and tsconfig `paths`; node resolution failed, so ESLint saw every cross-package import as `any` (965 spurious errors) — and container builds would have failed the same way. | Dependencies generated from actual imports for all 12 packages and 3 apps; `tests/test-kit` promoted to a real workspace package. |
| 5 | **`platform` package had no home in the layout** — the logger and EgressGateway are infrastructure every layer touches but no domain package may import. | Added `packages/platform`; layout and architecture updated. |
| 6 | Money tests sat in the persistence package; US-5.2 rule-table tests blocked the M1 calendar file from going green. | Relocated to `shared-kernel/test/money.spec.ts` and split into `rule-table.spec.ts`. |

### M2 result (2026-08-02) — COMPLETE

```
pnpm test        465 tests · 250 passing · 215 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`DONE`: all fifteen EPIC-1 stories (US-1.1 … US-1.15), plus US-2.1/2.3/2.4/2.5 and US-7.3 pulled
forward. `core-domain` is fully green at 96/96.

**Cross-milestone dependency, resolved by pulling FX forward.** US-1.4 and US-1.5 carry the PRD's
flagship dual-rate acceptance criteria, and neither can pass without `Rule115Resolver` and
`DualRateConverter` — scheduled in M3. The dependency was always real; only the milestone assignment
was wrong. Same pattern as US-8.9 → US-7.1 in M1. **Remaining M3 work is genuinely independent**:
US-2.2 (SBI sheet parsing) and US-2.6 (retroactive amendment) stay red.

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **Two acceptance criteria demanded incompatible day counts.** PRD FR-1 requires ₹400,000 on a full-year hand loan (year fraction exactly 1.0); US-1.11 requires zero interest on the start date. ACT/365 gives ₹398,904.11; inclusive ACT gives 1 day at the start. | **30/360** satisfies both (360/360 = 1.0; 0 at start). Recorded in `daycount.ts`. The derived partial-repayment figure was recomputed from ₹320,547.95 → ₹320,000; the original mixed ACT/365 for one leg with 30/360 for the other. |
| 2 | Three test expectations were arithmetic slips authored before implementation: FD ₹1,073,970.86 (1.018⁴ = 1.073967433), MF ₹107,943.06 (1,234.567 × 87.4321 = 107,940.785), and the hand-loan figure above. | Corrected to ₹1,073,967.43, ₹107,940.79 and ₹320,000, each with the arithmetic in a comment. |
| 3 | **The valuation engine had no price or FX input** — the NAV tests asserted a market value nothing supplied. | Added `PriceSource` and `FxSource` ports (OQ-1's stubbed adapter interface, now real). A missing FX rate throws `RateUnavailableError` rather than passing a foreign amount through as INR. |
| 4 | **Fallback ordering was wrong.** Exhausting SBI across all history before trying RBI would prefer a fortnight-old SBI rate over same-day RBI — the opposite of FR-2.1's bank-holiday rule. | Sources are now tried in priority order **per date**, then the date walks back. |
| 5 | EPF credited 11 monthly contributions for a full financial year. | Month counting made inclusive of the opening month: 1-Apr → 31-Mar is twelve. |
| 6 | `MaskingPipeline.maskPayload` masked free text only, so `borrowerName` survived — regex cannot recognise a person's name. | Structured payloads are masked by **field semantics**; NER (US-7.2) is reserved for free text, where that is the only available signal. |
| 7 | The `no-restricted-globals: Date` layering rule banned deterministic calendar arithmetic, not just ambient time. | Narrowed to `Date.now()` and zero-argument `new Date()` — the actual non-deterministic surface. |
| 8 | Test-kit lots defaulted to INR charges even on USD lots, so foreign cost basis threw a currency mismatch. | Charges now default to the lot's own currency. |

### M3 result (2026-08-02) — COMPLETE

```
pnpm test        467 tests · 258 passing · 209 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`DONE`: US-2.2 and US-2.6, completing EPIC-2. `fx-itbr` is fully green at 33/33.

M3 was 13 points rather than the planned 31 because US-2.1/2.3/2.4/2.5 were pulled into M2, where
the dual-rate acceptance criteria needed them.

**US-2.6's declared dependency on US-3.1 (snapshots, M4) was broken, not honoured.** A frozen snapshot
must be *flagged* `supersededRateAvailable`, never rewritten (ADR-006), so the amendment engine only
needs to know *which* snapshots cover a date. That is an injected `SnapshotIndex` port defaulting to
"none known"; M4 registers the real one. A genuine data dependency did not have to become a
build-order dependency.

**Dependency audit** (recommended at the end of M2, run before M4). Only two inversions exist in the
whole 80-story tracker:

| Story | Milestone | Depends on | Its milestone | Resolution |
|---|---|---|---|---|
| US-2.6 | M3 | US-3.1 | M4 | Broken with the `SnapshotIndex` port, above |
| US-7.3 | M2 | US-7.2 | M7 | Genuine — see the status correction below |

No further inversions remain, so M4 onward can proceed in the planned order.

**Tracker correction.** US-7.3 was marked `DONE` during M2. That was wrong: structured-payload masking
works, but the story's flagship PRD scenario — masking a person's name in free text — needs NER
(US-7.2, M7), and its test is still red. Status corrected to `WIP`, and the legend now defines `DONE`
as *every* AC green. A `DONE` row with a failing acceptance criterion makes the whole tracker
untrustworthy, which is worse than an honest `WIP`.

**Implementation note.** The SBI sheet parser refuses a sheet whose layout has drifted rather than
parsing what it can (plan risk R1). A mis-parsed column produces plausible rates that flow straight
into a capital gains computation; a refused sheet only costs a fallback-chain lookup. Required
currencies and expected columns are both asserted, and a partial sheet commits nothing.

### M4 result (2026-08-02) — COMPLETE

```
pnpm test        492 tests · 315 passing · 177 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`snapshot` is fully green at 57/57. Six of eleven packages are now green:
`shared-kernel`, `core-domain`, `fx-itbr`, `snapshot`, `persistence`, `platform`.

**Status split.** US-3.1, US-3.5, US-3.7 and US-3.8 are `DONE`. US-3.2, US-3.3, US-3.4 and US-3.6 are
`WIP`: their domain logic is complete and unit-green, but each also carries a functional test through
`app-services`, which does not exist until M8. Marking them `DONE` would repeat the US-7.3 mistake.

**US-2.6's port is now closed.** M3 shipped rate amendment against a stubbed `SnapshotIndex`. M4 adds
`packages/snapshot/test/rate-amendment-index.spec.ts`, which builds a real index over frozen snapshots
and proves both halves fit: the amendment reports the snapshots covering an amended rate date, and
leaves every one of them byte-identical (ADR-006).

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **The XIRR expectation was wrong.** The test asserted 20.94% for flows of −₹100,000, −₹50,000 and +₹200,000. NPV at that rate is −₹28,317; the true root is **11.3302%**. | Verified independently before writing the solver, then corrected. The implementation reproduces 11.3302% exactly. |
| 2 | **The snapshot test builder made its own assertions unsatisfiable** — a literal `contentHash: 'sha256:placeholder'` can never equal a real hash, and an unfrozen object makes the immutability check vacuous. | The builder now produces a genuinely frozen snapshot carrying its real hash. |
| 3 | **"Catch up on every missed boundary" contradicted the acceptance criteria**, proposing a 31-Dec-2025 foreign snapshot on 1 April 2026. | The scheduler answers *"what was crossed since I last ran?"*, defaulting to a 24-hour window. Callers genuinely absent pass an explicit `since` and get full catch-up — the compliance requirement is met without the false positives. |
| 4 | **Price and currency movement were indistinguishable.** `SnapshotPosition` carried only an INR value, so a foreign holding's variance could not be attributed. | Added optional `nativeValue` and `fxRate`. A holding that rises $10k→$12k while the rupee moves ₹80→₹85 now reports ₹160,000 of price effect and ₹60,000 of currency effect, summing exactly to the ₹220,000 INR delta. |
| 5 | US-3.4 and US-3.6 had no unit coverage at all — their only tests were functional ones blocked on M8. | Added `custom-snapshot.spec.ts` covering the date guard, scope filtering and snapshot-vs-live comparison at the domain level. |
| 6 | Three tracker rows named test files that were never created. | Paths corrected to the files that actually hold those stories' tests. |

### M4 post-review corrections (2026-08-02)

Reviewing the M4 summary surfaced two defects that the green suite had not caught:

| # | Finding | Resolution |
|---|---|---|
| 1 | **Price/currency attribution was dead in production.** `nativeValue` and `fxRate` existed only on `SnapshotPosition`; `ValuationEngine` never emitted them. Every real snapshot therefore had nothing to attribute, and the feature reported `undefined` always. The test passed only because it hand-built positions — a green test over a dead feature. | Both fields added to `ValuedPosition` and populated by the valuation engine for every non-INR holding. New `attribution-end-to-end.spec.ts` drives the real chain (ValuationEngine → SnapshotFactory → DeltaEngine) so the wiring cannot rot silently again. |
| 2 | **`assertImmutable` returned `Ok` exactly when the freeze FAILED.** A caller writing `if (result.ok)` would have proceeded precisely when the snapshot had been corrupted — the most dangerous possible reading of a result type. | Renamed to `attemptMutation`, where `Err(SNAPSHOT_IMMUTABLE)` is plainly the correct outcome, and added `isImmutable()` for positive checks, with a test proving it returns false for a non-frozen lookalike. |

The shared lesson: a test that constructs its own inputs verifies the unit but says nothing about the
wiring. Where a feature spans packages, at least one test must traverse the real path.

### M5 progress (2026-08-03) — in flight

**Item 0 complete: mutual fund tax character (ADR-016).** `core-domain` is green at 119/119.
`DOMESTIC_MUTUAL_FUND` now carries a `schemeCategory` (what the user picks and a CAS import
populates) and a derived `taxCharacter` (what the capital gains engine keys off). Without this,
US-5.7 would have been written against `assetClass` alone and applied equity treatment to debt funds
— a materially wrong tax number, silently.

The 65% / 35% equity bands in `mf-tax-character.ts` are **structural, not statutory**: they describe
the shape of the rule. The operative percentages, effective dates and the rates they map to moved in
both the 2023 and 2024 Finance Acts and belong in the FY rule table (US-5.2), not in engine code.

**Visual design system captured (PRD Module 9).** Requirement arrived mid-milestone; recorded rather
than built, since `apps/web` does not exist until M8. Palette values were sampled from the supplied
reference image, not estimated. Tokens live in `apps/web/src/theme/tokens.css` and are bound to US-8.5
by acceptance criteria, so M8 cannot drift from them.

**Still open — US-5.2 tax rate sourcing.** Slab, surcharge, cess and capital gains parameters for
FY 2025-26 have not been supplied. Proceeding with a clearly-marked **provisional** rule set so the
engine and its tests can be built; every provisional file carries a `"status": "PROVISIONAL"` field
and the tax engine refuses to emit a filing artifact while any rule set in use is provisional.

### M5 result (2026-08-03) — COMPLETE except US-5.3

```
pnpm test        522 tests · 410 passing · 112 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`tax-engine` is green at 82/82. **Seven of eleven packages are now green**: `shared-kernel`,
`core-domain`, `fx-itbr`, `snapshot`, `tax-engine`, `persistence`, `platform`.

`DONE`: US-5.2, US-5.4 … US-5.12. **US-5.3 (Form 16 parser) remains `TESTS_RED` and has no test file
at all** — the tracker named `form16-parser.spec.ts`, which was never written. It is the one M5 story
with no executable acceptance criteria, and is carried forward.

**Provisional rates, with a hard gate.** FY 2025-26 and 2024-25 rule sets carry
`status: 'PROVISIONAL'`. Computation is permitted so the engine is testable and demonstrable;
`TaxRuleTable.assertFilingReady` refuses any provisional set, so no filing artifact can be produced
from unverified numbers. Six tests pin that gate, including one proving filing is allowed once a set
is marked `VERIFIED`.

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **Two surcharge tests contradicted each other.** One asserted an unrelieved surcharge at ₹51,00,000; the other required marginal relief. Relief genuinely applies there — the zone runs to roughly ₹51.96 lakh — so the first test was wrong. | Band tests moved to incomes clear of the relief zone (₹60L / ₹1.2Cr / ₹2.5Cr). Relief is now computed against the tax due at the threshold, derived from the top marginal rate when a caller does not supply it. |
| 2 | **Two advance tax tests demanded exact arithmetic while a third demanded §288B ₹10 rounding.** Mutually unsatisfiable. | The statutory rounding wins; the arithmetic assertions now round. Added a test that an over-payment yields zero, never a negative instalment. |
| 3 | **Holding-period boundary tests specified only one endpoint.** A 12-month boundary cannot be asserted without an acquisition date, and the two scenarios needed different ones. | `ExitTransaction` and `LotAllocation` now carry `acquisitionDate`; the tests state both endpoints. |
| 4 | **The grandfathering test never supplied the FMV it asserted on** — it expected a ₹70 gain from a ₹180 FMV that appeared nowhere. | `LotAllocation.grandfatheredFmv` added and supplied by the test. |
| 5 | **The rule table read JSON with `node:fs` from a pure domain package** — caught by our own layering lint rule, not by a human. | Rule sets converted to typed TS modules. No I/O, and a malformed slab band is now a compile error rather than a runtime one. |

### M6 result (2026-08-03) — COMPLETE

```
pnpm test        535 tests · 452 passing · 83 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`ingestion` is green at 29/29. **Eight of eleven packages are green.** US-5.3 (Form 16) was folded in
from M5, since a Form 16 is the same problem shape as the other statement parsers; `tax-engine` is now
95/95 and **EPIC-5 is fully complete**.

**The CAS parser really decrypts.** `US-4.2` runs against the encrypted fixture generated in M0,
implementing the PDF standard security handler (/V 2 /R 3, RC4-128) — algorithms 2, 4/5 and 6 — in
about a hundred lines rather than taking a native PDF dependency that could log a password. Wrong
passwords fail with `PDF_DECRYPTION_FAILED` and the attempted password never appears in the error.

**Two PII decisions worth recording:**

- **Folio numbers never enter the pipeline in the clear.** The CAS parser emits a deterministic
  opaque `folioRef`; the raw folio belongs in the encrypted vault. Duplicate detection still works
  because the reference is stable.
- **Form 16 PAN and TAN are stored as opaque references** for the same reason, so a parsed
  certificate can be handed to an AI payload without a PAN riding along.

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **The PDF stream reader attributed every stream to the wrong object.** Searching forward from an object header to the next `stream` keyword found object 4's stream while reporting object 1's number — and since the RC4 key is derived from the object number, decryption produced silent garbage rather than an error. | Each stream is now scoped to the object that encloses it. This is the exact failure mode the parser is meant to prevent, so it is called out in the source. |
| 2 | **The Form 16 mismatch fixture did not mismatch.** With no Part B present, Part B's total fell back to Part A's, so the two agreed and the reconciliation test passed for the wrong reason. | Fixture rewritten as a combined document where Part A totals ₹1,850,000 against Part B's ₹1,840,000, exactly as FR-5.1 describes. |
| 3 | Import timestamps from the wall clock would have made re-imports non-identical, breaking both duplicate detection and the determinism test. | Provenance timestamps are derived from the source file, so the same file always parses to the same records. |
| 4 | RC4 needed byte reads that `noUncheckedIndexedAccess` types as possibly-undefined; the obvious fix was non-null assertions, which DoD D4 forbids. | A total `byteAt` accessor, with a comment explaining that every index is masked to 0-255 so the fallback is unreachable. |

### M7 result (2026-08-03) — COMPLETE

```
pnpm test        540 tests · 473 passing · 67 failing · 0 skipped
pnpm typecheck   clean
pnpm lint        clean
```

`pii-masker` is green at 37/37. **Nine of eleven packages are green.** EPIC-7 is complete, and the
PRD's flagship masking scenario (FR-7 AC) now produces its mandated output exactly.

**The planned NER does not work, and was measured before being adopted.** wink-nlp's entity
recogniser returned **zero** person entities against this use case — not for "Rajesh Sharma", not for
"Priya Menon", not for any name tried. Its part-of-speech tagger, however, reliably marks both tokens
`PROPN`. Name detection is therefore built on POS runs, filtered by an organisation lexicon and a
ticker heuristic. Had this been adopted on the plan's say-so, every name would have reached the LLM.

**ADR-007's limits are now stated rather than implied.** Five tests pin exactly what the fail-closed
guard does and does not protect, including one asserting that it CANNOT catch an unrecognised
lowercase name. A green suite must not be readable as an assurance the system does not provide.

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **Risk R5's mitigation was invalid.** It named the fail-closed guard as the backstop for name-detection misses. The guard matches shapes; a name has none, so it can never catch one. | R5 rewritten. Real mitigation is the over-masking bias, field-semantic masking for structured payloads, and re-running detection to catch pipeline bugs. The residual gap is documented in source and pinned by a test. |
| 2 | **The verifier flagged its own output.** Redaction tokens are proper-noun shaped, so re-running detection over a correctly masked payload found `[REDACTED_NAME]` and refused it — failing closed on nothing at all. | Redaction tokens are stripped before scanning. |
| 3 | **US-7.5 fed `RegexRules.detect` to the pseudonymiser**, which cannot return names by construction, so nothing was tokenised and the tests passed no entities. | Tests use the combined `EntityDetector`, and reset the session map so token numbering is deterministic. |
| 4 | Masking order matters: running regex first leaves `[REDACTED_PAN]` fragments that tag as proper nouns and get masked twice. | Names are masked first, on natural text, then structured rules. |

### M8 result (2026-08-03) — COMPLETE except the E2E suite

```
pnpm test        552 tests · 534 passing · 18 failing · 0 skipped
pnpm typecheck   clean          (root + apps/web)
pnpm lint        clean
vite build       ✓ 195 kB js · 5 kB css
```

**Every functional test is green (70/70).** The only remaining failures in the whole repository are
the 18 `compliance` tests, which are M10. US-3.2/3.3/3.4/3.6 — held at `WIP` since M4 because their
functional halves needed `app-services` — are now genuinely `DONE`.

The API serves the real journey: liveness, readiness gated on the vault, unlock, valuation, snapshot
creation, advance tax, and a `TAX_RULES_UNAVAILABLE` refusal for an unbundled year. `POST /api/ai/analyze`
returns **422 PII_LEAK** for an unmasked payload — the second, independent gate of ADR-007 working.

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **A brand-new vault accepted an empty passphrase.** With no stored key to check against, the first unlock *sets* the passphrase — so an empty string silently created a vault anyone could open, and it looked like a successful unlock. | `Vault.unlock` refuses an empty passphrase outright. |
| 2 | **`Vault.open` locked an already-unlocked vault**, because constructing a second app handle reset the session. | Re-opening the same path is now a no-op. |
| 3 | **The API test used a fixed `/tmp/vantagepoint-test` path**, so a vault from an earlier run — created with a different passphrase — survived and made unlock fail for reasons unrelated to the code. | One throwaway directory per run. |
| 4 | **The scheduler used the ambient clock as a snapshot's creation time**, so catching up on a missed statutory snapshot was rejected as "future-dated" — defeating the catch-up path US-8.11 exists to provide. | A scheduled snapshot is created at the instant the scheduler ran. |
| 5 | **Missing income was treated as an error**, making `tax advance` fail on a fresh vault. Advance tax on no income is legitimately nil. | Returns a zero profile, and callers surface `hasIncomeProfile()` — otherwise a forgotten Form 16 reads as "₹0 due" rather than "no input". |
| 6 | Routes reached into `@vantagepoint/persistence` for readiness, breaking the thin-shell rule. | Readiness goes through `VaultUC.isUnlocked()`. |
| 7 | A missing snapshot returned 404, indistinguishable from an unregistered route — for clients and for our own routing tests. | 409 for a routable request whose referenced resource is absent. |

**Not done: the Playwright E2E suite.** `tests/e2e/` is written but unrun — it needs browser binaries
downloaded, which the default-deny egress posture blocks. Eleven theme guard tests cover FR-9 from the
outside instead (tokens resolve, no raw hex, direction never conveyed by colour alone, no external
font origin), and the API smoke path is verified end to end. US-8.7's benchmarks run under `pnpm bench`.

### M9 + M10 result (2026-08-03) — ALL MILESTONES COMPLETE

```
pnpm test            552 tests · 552 passing · 0 failing · 0 skipped
pnpm test:container   38 tests ·  38 passing · 0 failing   (real Docker stack)
pnpm bench           valuation 4.77 ms (budget 1,500) · delta 3.25 ms (budget 2,000)
pnpm typecheck       clean          pnpm lint  clean
docker compose up    both containers healthy
```

**All eighty tracker rows are `DONE`.** Every one of the eleven packages is green.

**M10 — compliance.** Schedule FA (Tables A3 and D), Schedule AL and the ITR-ready export.
Two distinctions carry the package and are stated in the source because both are easy to get
backwards: **Schedule FA runs on the CALENDAR year** while everything else here is FY-aligned, and
**Schedule AL reports COST of acquisition** while the rest of the product reports market value.

**M9 — containers.** `docker compose up` on a host with only Docker installed brings up both
services. Verified against the running stack, not asserted from the compose file:

| Requirement | Evidence |
|---|---|
| FR-8.2 bind mount, not a Docker volume | `Type=bind Source=/tmp/vantagepoint-m9-data` |
| Vault on the host disk, owned by the host user | `vault.db` present, owned `rrpofficial`, not root |
| Survives `compose down` / `up` | md5 identical before and after; unlocks with the same passphrase |
| FR-8.3 non-root | api and web both UID 1000 |
| FR-8.3 read-only rootfs | write to `/app` refused; data dir and `/tmp` writable |
| ADR-010 no egress | outbound from the API times out — the network has no gateway |
| SPA + `/api` proxy + deep links | index served, `/api/health/live` proxied, `/snapshots/X` → 200 |

**Corrections forced by implementation:**

| # | Finding | Resolution |
|---|---|---|
| 1 | **The API would not boot in the container.** Sources use NodeNext `./app.js` specifiers, which Node's type-stripping loader cannot resolve — it looks for a `.js` file that never existed. | Bundled ahead of time with esbuild. A production image should not depend on an experimental flag to start. |
| 2 | **Bundling everything broke Fastify**, whose CommonJS internals call `require` inside an ESM wrapper. | Only our own code is bundled; third-party packages stay external and resolve from `node_modules`. Bundle fell from 1.5 MB to 96 KB. |
| 3 | **`internal: true` on the shared network made the published port unreachable.** Docker does not route host port publishing onto an internal network. | Split topology: `edge` carries the web container's published port, `internal` (no gateway) carries the API. The API is now *more* isolated than the original single-network design, not less. |
| 4 | **The runtime image was 430 MB** — it shipped the entire dev dependency tree. | A separate minimal dependency tree built from `docker/runtime-package.json`. Dev tooling is absent by construction rather than pruned afterwards and hoped for. **246 MB.** |
| 5 | **Container persistence tests asserted on a database that did not exist**, because the vault file is only created on unlock. | The suite unlocks after bring-up, and a new test proves the restored vault still opens with the original passphrase — a file that merely exists proves nothing. |
| 6 | Base images were pinned to a placeholder digest. | Real digests resolved and pinned for both `node:22-bookworm-slim` and `caddy:2-alpine`. |

**US-8.7 note.** The NFR-2 budgets are *enforced* by assertions in the unit suite and in the
container suite; `pnpm bench` exists to show headroom rather than to gate the build. Current margin
is roughly 300× on valuation and 600× on snapshot delta, so the budgets are not close to binding.

### M11 result (2026-08-04) — the six sections behind the nav

Raised by the user: *"Nothing happens when I click on the links on the UI."* Correct, and the cause
was worse than the symptom.

**What was actually wrong.** `App.tsx` set a `section` state that the render never read. The nav
moved a highlight and changed nothing else, because the six non-Dashboard sections had never been
built. US-8.5 was marked DONE against an acceptance criterion — *"the UI exposes Dashboard, Ledger,
Import, …"* — that seven dead anchors satisfy to the letter. **`tests/e2e/app-shell.spec.ts` would
have caught it on line 57 and was never run.** The one suite that mattered was the one suite skipped.

**Three further gaps found while building, none of them visible from the UI:**

1. **`AssetRepository` and `LiabilityRepository` were `notImplemented` stubs**, and `ports.assets()`
   returned `[]` in production. The shipped application valued a portfolio it never read — net worth
   was ₹0 regardless of what had been imported. Every test passed because each supplied its own
   fixture. US-8.3 covered migrations, which were real; the repositories were not.
2. **`ImportStatementUC` parsed a file and discarded the result.** It returned `created: 65` and
   wrote nothing. A report is not evidence of a commit.
3. **`GenerateComplianceUC` was `notImplemented`**, so M10's compliance package was unreachable from
   the API despite being tested and green.

**A real correctness bug surfaced from the new test, not from review.** Disposals left no stored
trace — lots recorded that quantity had gone, but not that a SELL caused it. Re-importing an
overlapping statement therefore re-applied every sell and depleted the holding twice, understating
the position and overstating realised gains. Lot counts stayed identical throughout, which is why an
obvious "did it duplicate?" check does not notice. Fixed by migration 3: exits are now first-class
records, kept outside the Asset aggregate so a later re-save of the holding cannot erase them.

**Schema.** Migrations 2–4: income events, corporate actions and hand-loan repayments (an Asset
previously round-tripped lossily, silently dropping dividends); exits; and a settings table so the
income profile behind a tax figure survives a restart instead of reverting to "zero income".

**Deliberately NOT faked.** `scheduleFaA3` returns an error rather than rows. Table A3 needs the peak
value over the calendar year, which requires a daily price and rate series this build does not
record. Rows computed from the closing value alone would understate the peak, and under the Black
Money Act an understated foreign disclosure is treated far more harshly than a domestic one. The
Compliance view shows the reason.

**One domain rule was right and the UI was wrong.** A custom snapshot is taken as of the END of its
date, so "snapshot today" asks for a moment that has not happened; `assertNotFuture` refused it. The
fix was in the view — default to the latest fully-elapsed day — not in the invariant.

```
unit + functional   575 passing   (was 552; +23 for repositories, import→ledger, exits)
container (Docker)   38 passing
E2E (Playwright)     17 passing   ← first run ever
typecheck clean · new code lint-clean
```

**The E2E suite now asserts what a section RENDERS**, never that a link exists — the failure mode
that produced this milestone cannot recur silently. Two things it caught: a helper that raced React's
mount (a non-retrying `isVisible()` answered "false" mid-hydration and skipped the unlock, surfacing
far from its cause), and the same-day snapshot rejection above.

**Also fixed:** `@vantagepoint/core-domain` was added as a dependency of `ingestion` and `compliance`
without running `pnpm install`, so the workspace links did not exist and ESLint resolved the whole
package as `any` — 108 spurious errors from one missing symlink.

**Pre-existing and untouched:** 16 lint errors in `tests/test-kit`, `tests/manual` and three
functional specs, all present before this work. The README's "lint clean" claim is stale.

### M11b — the CSV template path (2026-08-04)

Raised by the user: *"This application does not provide any sample VantagePoint csv template."* True,
and again the missing artefact was the smaller half of the problem.

**The templates existed only as unreachable code.** `TEMPLATES` defined six of them and
`generateTemplate` produced a header row, but no route, no view and no file exposed any of it. US-4.6
was DONE on the strength of that.

**And the parser could not have used them anyway.** `parseTemplate` read every template through one
generic path: guess a column ending in `_date`, guess a column containing `amount`/`price`/`balance`,
emit `BUY` with quantity 1, discard which template it had read. A hand loan and a bank balance came
out byte-identical, and — after M11 made the projection refuse to guess an asset class — every
template row landed in `unapplied`. **Manual entry could not create a single asset.**

The test that should have caught it is titled *"parses borrower details, principal, interest rate and
start date"* and asserted `rows.length > 0`. The third instance in this project of a test written to
the letter of a story title rather than its intent.

**Fixed:** templates now declare their asset class; the parser identifies the template from its
header (exact column-set match, so an extra column is a mismatch rather than a silent ignore) and
maps each to its real fields — loan terms for hand loans, stamp duty and registration into the cost
of acquisition for property, `buy`/`sell` for the generic broker. Row errors carry the real column
name and expected format. `borrower_name` is hashed at the parser boundary: a lender's private
counterparty never consented to being in a dataset, and the raw name now exists only in the vault.

**Exposed three ways**, because a template nobody can find is the same as no template: `GET
/api/templates` and `/api/templates/:name` (deliberately not vault-gated — you need the blank file
before you have anything to put in it), a download table in the Import view, and committed files in
`templates/` generated by `scripts/emit-templates.mts` from the parser's own column definitions, so
the header a user fills in cannot drift from the header the importer matches.

```
unit + functional   591 passing   (was 575; +16 for templates)
E2E (Playwright)     20 passing   (was 17)
container (Docker)   38 passing
```

Two existing tests failed on this change and both were correct to fail: one asserted the first line
of a generated template contains a comma (it is now a `#` comment), the other asserted that a cash
template comes back unapplied — the behaviour being fixed.

### M11c — year pickers, and an assessment-year bug behind them (2026-08-04)

Raised by the user: the FY / CY / AY dropdowns should offer the current period. They were hardcoded
`['2025-26', '2024-25']` and, for calendar years, `currentYear - 1 … - 3` — so the current period was
absent by construction and the lists went stale every April with no failing test to say so.

**The request surfaced a filing-level bug.** Two places passed the financial year straight through as
the assessment year: `profileFor` (`assessmentYear: fy`) and `GenerateComplianceUC.scheduleAl`.
**AY is FY + 1** — income earned in FY 2025-26 is assessed in AY 2026-27 — so every income profile
and every Schedule AL was labelled with the wrong year. `FyCalendar.assessmentYearOf` already existed
and was correct; nothing called it. A test now asserts no offered year ever has `assessmentYear ===
financialYear`.

**Periods are derived on the SERVER** (`GET /api/reference/periods`), not in the browser. A client
one timezone west decides it is still 31 March while the server has moved into the next financial
year; the picker would then disagree with the engine computing the tax, and neither would look wrong
alone. The clock is the injected one, so the whole thing is testable at any date.

**Offering a period and defaulting to it are separate decisions**, and conflating them was the first
attempt's mistake — defaulting to the current FY made the Tax screen open on FY 2026-27, which has no
rule set, so it greeted every user with an error they had not caused. Now:

- the current FY is always **offered** and labelled `· current`, with `· no rates yet` where no rule
  set exists;
- `defaultFinancialYear` is the most recent year that can actually be computed, and self-corrects to
  the current year the moment its rates are added — no code change;
- the current calendar year is **offered** and flagged *"still running"*, while
  `defaultCalendarYear` is the last complete one, because Schedule FA reports a 31-December position
  a running year has not reached.

Each option now reads `FY 2025-26 · AY 2026-27 · current`, so the FY→AY relationship is visible at
the point of choosing rather than implied.

```
unit + functional   607 passing   (was 591; +16 for periods)
E2E (Playwright)     25 passing   (was 20)
container (Docker)   38 passing
```

Caught by the new E2E: defaulting to a year with no rates broke the advance-tax journey, which is how
the offer/default distinction was found. One test also had to be tightened — matching `/2026-27/`
against the option list hit both `FY 2026-27` and the `AY 2026-27` of the row below it.

### M11d — the unlock screen hang (2026-08-08)

Raised by the user: the passphrase prompt hangs in Chrome at times. It did, and the mechanism had two
halves that fed each other.

**Measured against the running container, before the fix:**

```
ten unlock requests      0.35s → 0.70s → 1.05s → … → 3.50s    exactly serialized
health probe mid-unlock  0.310s        versus        0.001s idle
```

Argon2id at the OWASP baseline (m=19 MiB, t=2) occupies a core for ~350 ms — correct, and deliberately
expensive. But it ran **synchronously on Node's only thread**, so one unlock froze the entire API for
its duration, health checks included, and concurrent unlocks queued instead of overlapping.

Meanwhile the unlock form had **no busy state at all**: the button stayed enabled, nothing on screen
changed, and `submitUnlock` had no re-entry guard. So the honest user response to "nothing happened"
— click again — queued another 350 ms block per click. Ten impatient clicks bought 3.5 seconds of a
genuinely frozen application. `fetch` had no timeout either, so a request the server never answered
left the promise pending forever with the UI showing nothing.

**Fixed on both sides:**

- `deriveKeyAsync` runs Argon2id in a worker thread (`kdf-worker.mjs`, a real file on disk because a
  worker entry point cannot be bundled; `build.mjs` copies it into the image, and a missing worker
  degrades to the synchronous path rather than failing to open a vault).
- The unlock button disables itself, says *"Unlocking…"*, and explains **why** it is slow — a
  deliberate work factor that looks like a stall is indistinguishable from a broken app. The same
  flag is the re-entry guard.
- Every request now carries a 30-second `AbortController` budget, and a timeout is reported
  distinctly from "the backend is down" — which would have been both wrong and alarming.

**After:**

```
ten unlock requests      worst case 3.50s → 1.08s
health probe mid-unlock  0.310s → 0.00076s          ~400× more responsive
E2E suite wall clock     26s → 18s
```

The functional tests assert the *property* — timers still fire during derivation, four concurrent
derivations cost well under four times one — never a wall-clock budget, so they will not flake on a
loaded runner. One equivalence test is load-bearing: the worker must derive a **byte-identical** key
to the synchronous path, or every vault already on disk would be locked out of its own data.

**Also found while investigating:** a browser tab left open on the unlock screen re-submits as soon as
the API comes back, which is why a wiped `data/` directory kept reappearing with a vault in it.

### M11e — hand loans silently understated (2026-08-08)

Reported from the running app: a template importing ₹26,00,000 and ₹4,00,000 of hand loans showed
₹30,00,000 on the Ledger but **₹4,00,000 on the Dashboard**, with net worth ₹5,00,000 instead of
₹31,00,000. Two faults produced the one wrong number.

**1. Identity.** `assetIdFor` keyed a hand loan on the BORROWER, so two loans to the same person
collapsed into a single asset holding two lots but only the first row's terms. That is wrong before
any arithmetic: two loans are two receivables with different principals, rates and start dates, and
interest accrues separately on each. Merged, the 9% loan would have accrued at 8% forever.

**2. Valuation.** `valuation.ts` read a hand loan from its single `handLoan` block, under a comment
asserting *"a loan receivable has no lots"*. That held when hand loans had a dedicated entry path;
the template importer creates one lot per row, so the second lot was never read at all.

**Fixed at both levels.** The loan id now includes its own start date and principal — derived from
the loan's terms rather than its row number, so a re-import or a differently ordered export still
resolves to the same asset. And `describesEveryLot` stops the valuation trusting one `handLoan` block
for a multi-lot asset: it falls back to cost basis, losing accrued interest (a few percent, visible)
rather than an entire loan (invisible).

**What made this dangerous is that nothing looked broken.** The total was wrong but plausible, and the
two screens disagreed silently — the Ledger sums lots, the Dashboard did not. A test now asserts the
two agree, which is the discrepancy a user can actually see.

Verified against the running stack with the reported figures: `HAND_LOAN ₹30,00,000`, `net worth
₹31,00,000`, three holdings.

```
unit + functional   620 passing   (was 613; +7 for hand loan valuation)
E2E (Playwright)     28 passing
container (Docker)   38 passing
```

### M12 — the hand-loan register (2026-08-08)

Delivered against `handloan-tracking-requirements.md`: a **Loans** tab replacing a tracking
spreadsheet, plus the CSV import path for it.

**Built on the existing hand-loan assets, not a parallel loan table.** A separate store would have
given the register and net worth two sources of truth — which is exactly how ₹26,00,000 went missing
in M11e. Recording a loan in the tab and importing one from a sheet land in the same place.

**Three distinctions carry the module, each a way money goes missing in a spreadsheet:**

1. **Interest payments are not principal repayments.** They are stored in separate tables so nothing
   can sum them together; conflated, paying interest writes off principal.
2. **Status tracks the PRINCIPAL, so a REPAID loan can still owe interest.** Pending interest is
   reported in two tiles — active loans and settled principal — because the second has no repayment
   arriving alongside it and is the balance nobody chases.
3. **Interest accrues on the declining balance.** `handLoanAccruedInterest` already did this
   correctly on a 30/360 basis; the register simply stopped ignoring it.

**Derived columns are recomputed, never trusted.** The template accepts all five of the sheet's
computed columns so an existing spreadsheet pastes in unchanged, then recomputes them and *reports*
disagreement rather than letting a stale cell win — or silently discarding the user's figure, which
would be the same failure in the other direction. A row saying only *"Repaid"*, with no repayment
column, has its repayment reconstructed on the closing date; without that the loan would show its
full principal outstanding while its own status said otherwise.

**Filtering, sorting and totals run server-side.** Totals are computed over the FILTERED set so the
tiles always describe what is on screen, and every sum stays in decimal.js — adding decimal strings
in the browser would reintroduce the drift ADR-002 exists to prevent, on amounts someone is owed.

**PDF written from scratch** — catalog, pages, xref, two base-14 fonts. Egress is denied by default
(ADR-010), so a new dependency is a structural decision; the subset needed here is small enough that
owning it costs less than owning a supply-chain risk. Verified by rendering, not by parsing.

**Borrower names now persist**, reversing an earlier deliberate choice: the register is filtered and
sorted by name, and a list of `brw_85e56cdc` is unusable. The name lives only in the encrypted
database; the asset id — which reaches snapshots and exports — remains the hash.

```
unit + functional   683 passing   (was 620; +32 engine, +25 register, +6 persistence/templates)
E2E (Playwright)     35 passing   (was 28)
container (Docker)   38 passing
```

Caught by the guard tests, not by review: the new E2E seeded borrower names from `Date.now()`, which
`toolchain.spec.ts` rejects as wall-clock use in a test body. It was right — the names are fixed now,
and recording identical terms is idempotent, so a re-run against an existing vault is harmless.

### M12a — `1,00,000` broke the register (2026-08-09)

Reported: the Loans tab stuck at "Loading…". It was not loading — it was a 500:

```
{"statusCode":500,"message":"[DecimalError] Invalid argument: 1,00,000"}
```

**`LoanUC.recordInterestPayment` and `recordPrincipalRepayment` validated nothing.** An amount typed
as `1,00,000` — a completely reasonable thing for anyone to write — was stored verbatim, and every
subsequent read of ANY loan threw on it. The failure was total: the register could not load, so there
was no way to find or fix the offending row from inside the application.

The route layer built `{ amount, currency }` as a raw object literal, bypassing `Money.of`, which
does validate and would have caught it. The invariant "every `Money.amount` is a bare decimal string"
was assumed everywhere and enforced nowhere.

**Fixed at three levels:**

- `Money.parse` reads user input without throwing and accepts digit grouping — Indian (`1,00,000`)
  and Western (`100,000`), plus `₹`/`Rs.` and stray spaces. A comma is always a SEPARATOR, never a
  decimal point: Indian grouping is irregular, so `1,5` cannot mean one-and-a-half here.
- Every write boundary parses instead of trusting, and returns a Result. Garbage now gets a 422 with
  a message that says what to do, not a 500 with a library's name in it.
- `Money.fromStorage` repairs on read, so a vault already holding the bad value opens. It returns an
  already-readable string **verbatim** — canonicalising would rewrite `12.50` as `12.5`, and snapshot
  content hashes are taken over exactly these strings.

Also added a Fastify error handler: an unhandled throw was returning the raw internal message, which
exposed a library and a user's amount while telling them nothing actionable.

**And a second bug, raised in the same message: was pending interest counted as an asset?**

It was — but the WRONG figure. `ValuationEngine` added *total accrued* interest to the outstanding
principal, including interest the borrower had already paid. That money is cash in a bank account,
so counting it again as a receivable reports it twice. Now the loan is valued at outstanding
principal plus interest **still owed**, clamped at zero so an overpayment cannot inflate net worth.

Verified live against the reported scenario: ₹12,00,000 lent, ₹1,44,000 accrued, ₹1,00,000 received
→ register loads, and net worth reports ₹12,44,000 rather than ₹13,44,000.

```
unit + functional   700 passing   (was 683; +17 for money input and loan valuation)
```

> ⚠ `vault-encryption.spec.ts › leaks no PII pattern anywhere in the raw file` failed twice under
> full-suite load and passed on every isolated and repeated run since. Not diagnosed. It is a
> **privacy assertion**, so it should be treated as a real intermittent until understood rather than
> written off as flake.

### M12b — a loan is not a holding (2026-08-09)

Reported: the Ledger showed each hand loan as `ast_hand_loan_brw_9f86…_2026_08_10_100000 · hand loan ·
domestic · 0 lots · 0 held · ₹0`.

**The data was right; the view was wrong.** `LoanUC.record` creates the asset with `lots: []`, which is
correct — a receivable has no acquisition lots — but Holdings is built for *instruments* and renders
lots, held quantity and cost per unit. All three are meaningless for a loan, so every column read
zero, the raw asset id showed through as the name (no `symbol` is set), and the one figure that
matters — what is still owed — was absent entirely.

**What a ledger entry for a hand loan should be.** Not a holding of units. A loan out is a
receivable, carried at the principal still owed plus interest accrued and not yet received; a partial
repayment reduces the outstanding principal and, from that date, what earns interest; full repayment
takes the principal to zero while any unpaid interest remains receivable. Quantity and lots never
enter into it.

So hand loans now have their **own Ledger section**, alongside Disposals and Liabilities, with the
columns a receivable actually has: borrower, lent on, status, principal lent, outstanding, interest
owed, and carrying value. They are excluded from Holdings entirely.

The section reads the **loan register**, not the raw assets, so the Ledger and the Loans tab cannot
disagree about the same money. Verified: carrying values sum to exactly the `HAND_LOAN` figure in net
worth (₹6,60,000 + ₹6,36,000 = ₹12,96,000).

**Also:** the borrower filter was a checkbox per person — readable at three names, unusable at fifty,
and it pushed the register off the screen. It is now a dropdown whose selections become removable
chips, keeping multi-select without the wall of controls. A chosen borrower leaves the list, so the
same person cannot be added twice.

```
E2E (Playwright)   37 passing   (was 35)
```

### M12c — the Dashboard was stale, not wrong (2026-08-09)

Reported: Loans showed ₹2,00,000 lent with ₹11,300 interest owed and the Ledger agreed, while the
Dashboard read **₹0 · 0 holdings · "No holdings recorded yet"**.

The API was correct throughout — the same request the Dashboard makes returned ₹2,11,300, matching
the register exactly. **`App.tsx` fetched the valuation once, on unlock, and never again.** Anything
recorded afterwards — a loan, a payment, an import — left the Dashboard showing the state of the
portfolio at the moment the vault was opened.

Two screens disagreeing about net worth is worse than either being briefly stale, so:

- The Dashboard **re-values whenever it is opened**. The tab change is the natural moment to
  reconcile, and it is what the user expects the tab to mean.
- The `Live` chip is gone, replaced by **"as at HH:MM:SS"** and a refresh control. That badge asserted
  a freshness the screen did not have; a timestamp makes staleness visible rather than something
  discovered by noticing two tabs disagree.
- An import already triggered a re-value; that stays, so the Dashboard is correct before the user
  navigates back to it.

```
E2E (Playwright)   39 passing   (was 37)
```

The new test pins the reported sequence directly: record a loan, open the Dashboard, and net worth
must have changed without a page reload.

### M12d — choosing which template (2026-08-09)

Requested: selecting *VantagePoint CSV template* in Import should reveal a dropdown of the templates
available under it.

Taken further than presentation, because naming the template makes the import **safer**, not just
tidier. Detection can only ever report "this matches nothing"; a declared template can be diffed
against the file:

```
declared Custom_Cash, balance column missing
  → Custom_Cash template header mismatch — missing column(s): balance

same file, detection only
  → this header matches no VantagePoint template: account_label, as_of_date, currency…
```

The first is actionable for someone editing a spreadsheet. The second is not.

It also catches a file uploaded under the **wrong** template — a Hand Loans sheet selected as Cash
would otherwise import cleanly as a bank balance, which is the wrong asset class and therefore the
wrong tax treatment, with nothing on screen to suggest anything went wrong.

The dropdown defaults to *Detect from the file's header*, so the previous behaviour is unchanged for
anyone who does not care; `templateName` is optional throughout. Selecting a template also shows what
it records and offers a download of that exact file, so the fix for a mismatch is one click away from
the error.

```
unit + functional   705 passing   (was 700)
E2E (Playwright)     41 passing   (was 39)
```

### Test inventory

| Suite | Location | Tests | State |
|---|---|---|---|
| Unit (domain packages) | `packages/*/test/` | 449 | green |
| Functional (through `app-services`) | `tests/functional/` | 234 | green |
| Container (FR-8) | `tests/container/` | 38 | green |
| E2E (Playwright) | `tests/e2e/` | 39 | green |
| Benchmarks (NFR-2) | `tests/functional/perf/` | 2 | green |
