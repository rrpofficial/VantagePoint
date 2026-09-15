# Product Requirement Document (PRD)
## Comprehensive Global Portfolio Tracking & Tax Compliance Platform

**Document Status:** Final / Approved  
**Target Market:** Indian Tax Residents (including High Net-Worth Individuals - HNIs)  
**Primary Focus:** Multi-Asset Global Portfolio Management, Historical Snapshot Analytics, Indian Tax Compliance (LTCG/STCG, Advance Tax, Form 16 Integration, Schedule FA & AL Reporting), and Privacy-First AI Architecture.

---

## 1. Executive Summary & Product Vision

### 1.1 Product Vision
To build an enterprise-grade, privacy-centric portfolio tracking and tax intelligence platform tailored specifically for Indian Tax Residents. The system will unify domestic and global investments across diverse asset classes into a single pane of glass, offering real-time valuation, point-in-time snapshot comparisons, automated Indian tax compliance (Advance Tax, Capital Gains, Schedule FA, Schedule AL), and strict client-side PII anonymization for future AI/LLM analytical services.

### 1.2 Core Objectives
- **Global Multi-Asset Aggregation:** Track traditional equities, mutual funds, debt, fixed income, alternative investments, cash, hand loans, custom family savings schemes, and statutory retirement benefits (EPF, VPF, NPS, Gratuity).
- **Point-in-Time Snapshot Engine:** Enable historical freeze-frame snapshots on standard compliance dates (March 31 EOD for domestic assets; December 31 EOD for foreign assets) and custom dates, with delta variance analytics.
- **Automated Indian Tax Engine:** Compute quarterly Advance Tax installments, STCG, LTCG (with grandfathering and indexation rules where applicable), and generate pre-filled reporting structures for Schedule FA (Foreign Assets) and Schedule AL (Assets & Liabilities).
- **Income & Form 16 Integration:** Ingest Form 16 (Part A & B) and annual income projections to dynamically determine tax slabs, surcharge brackets, marginal relief, and HNI status.
- **Strict Privacy & Local PII Masking:** Zero-trust PII masking layer operating on the client side before any data payload is processed by AI/LLM modules.

---

## 2. User Personas & Workflows

### 2.1 Target User Personas
1. **The Global Indian Investor:** Holds Indian equities (Zerodha/Groww), US stocks (Vested/E*TRADE), CAMS Mutual Funds, and foreign employer RSUs/ESPPs. Requires currency conversion matching Indian Tax Authority guidelines (SBI ITBR).
2. **High Net-Worth Individual (HNI):** Income exceeding ₹50 Lakhs / Portfolio > ₹1 Crore. Needs automated compliance for Schedule AL and foreign asset disclosure under Schedule FA to avoid penal consequences under the Black Money Act.
3. **Family Wealth Manager / DIY Investor:** Tracks non-standard assets like hand loans given to friends, custom family chit funds/savings schemes, cash in hand, EPF, VPF, NPS, and Gratuity.

---

## 3. Functional Requirements & Acceptance Criteria

### Module 1: Global Multi-Asset Architecture & Life Cycle Tracking

#### FR-1.1: Multi-Asset Support
The system shall support the full tracking lifecycle (acquisition, dividend/interest yield, partial exit, complete exit, corporate actions) for the following asset classes:
- **Domestic Public Equities & ETFs:** Indian stocks listed on NSE/BSE.
- **Domestic Mutual Funds:** Equity, Debt, Hybrid, Solution-Oriented, Liquid, and Arbitrage funds.
- **Foreign Equities & ETFs:** US/Global equities, RSUs, ESPPs via foreign platforms.
- **Fixed Income & Statutory Schemes:** EPF, VPF, NPS (Tier I & II), PPF, Fixed Deposits, Recurring Deposits, Gratuity.
- **Alternative & Private Assets:** Real Estate, Unlisted Shares, Cryptocurrencies, Physical/Digital Gold, Sovereign Gold Bonds (SGB).
- **Unstructured Liquidity & Personal Finance:** Cash in hand, Cash lent to friends/family (Hand Loans with interest tracking), Custom Family Savings/Chit Schemes.

#### FR-1.2: Lifecycle & Corporate Action Capture
- **Entry & Exit Dates:** Every asset lot must record trade date, settlement date, quantity, unit price, brokerage/fees, and STT (Securities Transaction Tax).
- **Dividends & Interest Ingestion:** Capture dividend pay-outs (domestic and foreign with Tax Withheld at Source / W-8BEN treaty rates) and auto-reinvested interest.

#### Acceptance Criteria (FR-1)
```gherkin
Scenario: Recording a partial exit on foreign RSUs with currency conversion
  Given the user owns 100 shares of US Stock "AAPL" acquired on 2023-05-10
  When the user inputs a sell transaction of 40 shares on 2026-02-15 at $180/share
  Then the system must record the exit date as 2026-02-15
  And compute realized capital gains using the FIFO lot allocation method
  And convert USD proceeds to INR using the official SBI ITBR rate applicable for 2026-02-15
  And update the remaining lot to 60 shares for future snapshot calculations.

Scenario: Tracking Hand Loans with Interest
  Given the user lends ₹5,000,000 as a hand loan on 2025-04-01 at 8% p.a. simple interest
  When the snapshot is generated on 2026-03-31
  Then the asset principal shall be valued at ₹5,000,000
  And accrued interest of ₹400,000 shall be reflected in the total net worth
  And categorized under "Other Sources" income for Advance Tax estimation.
```

---

### Module 2: Foreign Currency & SBI ITBR Rate Engine

#### FR-2.1: SBI ITBR Rate Integration
- **Primary Rate Source:** Official State Bank of India (SBI) Telegraphic Transfer Buying Rate (TTBR) / Income Tax Buying Rate (ITBR).
- **Automated Scraping & Ingestion:** Automated daily scraper/ingestion pipeline targeting official SBI Forex Rate Sheets published by Treasury.
- **Fallback Hierarchy:** If official SBI ITBR sheet is unavailable for a specific date (e.g., weekend/bank holiday), fallback to RBI Reference Rate for the preceding working day, followed by ECB/OANDA daily rates.
- **Rule Compliance:** Foreign stock capital gains and dividends must strictly apply Rule 115 of Indian Income Tax Rules (using TTBR of the last day of the month preceding the month in which the income/sale occurs).

#### Acceptance Criteria (FR-2)
```gherkin
Scenario: Automated SBI ITBR Rate Fetch and Rule 115 Compliance
  Given a US dividend is received on 14th August 2025
  When the currency conversion engine runs
  Then the system shall fetch the SBI TTBR rate published for 31st July 2025 (last day of preceding month)
  And convert the USD dividend to INR for tax taxable income computation.

Scenario: System Fallback when SBI Rate Sheet is delayed
  Given SBI Forex sheet is unreleased for a bank holiday on trade date
  When the asset transaction is logged
  Then the system shall apply the RBI Reference Rate for the nearest prior working day
  And flag the transaction with "Rate Source: RBI Fallback (Pending SBI ITBR Finalization)".
```

---

### Module 3: Historical Snapshot & Comparison System

#### FR-3.1: Point-in-Time Snapshot Rules
- **Domestic Compliance Snapshot:** Automatically generate and freeze an EOD snapshot as of **31st March** for all domestic assets (aligning with Indian Financial Year).
- **Foreign Compliance Snapshot:** Automatically generate and freeze an EOD snapshot as of **31st December** for all foreign assets (aligning with Calendar Year required for Schedule FA in ITR).
- **Custom Snapshots:** Users can create on-demand historical snapshots for any arbitrary date.
- **Comparison Engine:** Support side-by-side variance analysis comparing:
  1. Historical Snapshot A vs. Historical Snapshot B.
  2. Historical Snapshot vs. Live Current Portfolio.
  3. Asset Allocation % shifts, Net Worth Delta (₹ and %), Absolute & Annualized (XIRR/CAGR) Returns.

#### Acceptance Criteria (FR-3)
```gherkin
Scenario: Dual Compliance Snapshot Generation
  Given the current system date reaches 2026-04-01
  When the automated snapshot scheduler runs
  Then an immutable snapshot "DOM_31MAR2026" must be created containing all domestic holdings as of 31-Mar-2026 EOD
  And when calendar date reaches 2027-01-01
  Then an immutable snapshot "FOR_31DEC2026" must be created for all foreign holdings as of 31-Dec-2026 EOD.

Scenario: Live vs Historical Snapshot Variance Analysis
  Given Snapshot "SNAP_31MAR2025" with Total Net Worth = ₹2,50,000,000
  And Live Net Worth on 2026-08-02 = ₹3,10,000,000
  When the user executes "Compare Live with SNAP_31MAR2025"
  Then the system shall display a variance table showing Delta Net Worth (+₹60,000,000 / +24.0%)
  And highlight top gainers, new asset additions, complete liquidations, and asset class rebalancing shifts.
```

---

### Module 4: Ingestion, Parsers & Template Engine

#### FR-4.1: Supported File Formats (Phase 1)
- **CAMS / KFintech CAS:** PDF import with password decryption (PAN + DOB/Custom password).
- **Zerodha Console:** Tax P&L (XLSX) and Tradebook (CSV).
- **Vested Drive:** Foreign investment Account Activity CSV.
- **E*TRADE:** Portfolio & Transaction History CSV / GainsKeeper reports.
- **Standardized CSV Templates:** Pre-defined CSV schema downloadable for manually entering unsupported brokers, Hand Loans, Real Estate, and Cash assets.

#### Acceptance Criteria (FR-4)
```gherkin
Scenario: CAMS CAS PDF Auto-Ingestion
  Given a user uploads a password-protected CAMS Consolidated Account Statement PDF
  When the user provides the correct PDF decryption password
  Then the system shall parse all Folio numbers, ISINs, Scheme names, transaction dates, NAVs, and units
  And populate the domestic mutual fund portfolio without manual entry errors.

Scenario: Custom Asset Import via Predefined Template
  Given the user downloads the "Custom_HandLoans_Template.csv"
  When the user populates borrower details, principal, interest rate, start date, and uploads the CSV
  Then the ingestion engine validates headers, parses rows, and adds entries to the Hand Loan asset ledger.
```

---

### Module 5: Income Tax, Advance Tax & Capital Gains Engine

#### FR-5.1: Tax Alignment & Terminology
- **Calendar & Financial Alignment:** Strictly adhere to Indian Financial Year (FY: 1st April to 31st March) and corresponding Assessment Year (AY: FY + 1 Year).
- **Form 16 & Tax Slab Processing:** Parse Form 16 (Part A & B) or manual salary/income inputs to calculate:
  - Total Taxable Income under Old vs. New Tax Regime.
  - Applicable Marginal Tax Slab (20%, 30%, etc.).
  - Surcharge Rates (10%, 15%, 25%) based on net income thresholds (₹50L, ₹1Cr, ₹2Cr, ₹5Cr).
  - Health & Education Cess (4%).
  - HNI Classification (Flagged if Total Income > ₹50 Lakhs or Total Asset Net Worth > ₹10 Crores).

#### FR-5.2: Capital Gains (LTCG / STCG) Rules Engine
- **Listed Domestic Equities/MFs:** Holding >12 months = LTCG (12.5% above ₹1.25 Lakh exemption limit); Holding ≤12 months = STCG (20%).
- **Foreign Equities / Unlisted Assets:** Holding >24 months = LTCG (12.5% without indexation); Holding ≤24 months = STCG (Taxed at applicable slab rate).
- **Debt Funds / FDs / Hand Loan Interest:** Taxed at applicable slab rates as per latest Indian tax provisions.

#### FR-5.3: Advance Tax Computation
Calculate quarterly Advance Tax liability after deducting TDS/TCS and considering realized capital gains up to the cutoff date:
- **Q1 (by 15th June):** 15% of total estimated annual tax liability.
- **Q2 (by 15th September):** 45% of total estimated annual tax liability.
- **Q3 (by 15th December):** 75% of total estimated annual tax liability.
- **Q4 (by 15th March):** 100% of total estimated annual tax liability.

#### Acceptance Criteria (FR-5)
```gherkin
Scenario: Advance Tax Calculation for Q3 with Capital Gains
  Given a user with estimated regular salary income putting them in the 30% slab + 10% surcharge
  And realized STCG on Indian equities of ₹500,000 on 10th November 2025
  When the Advance Tax calculation runs for 15th December (Q3)
  Then the system computes 75% of total tax liability (Salary Tax + 20% STCG + Surcharge + 4% Cess)
  And deducts TDS already remitted by employer as per Form 16 projection
  And displays the exact net Advance Tax payable amount for the Q3 installment.
```

---

### Module 6: HNI Compliance & Regulatory Filings (Schedule FA & AL)

#### FR-6.1: Schedule FA (Foreign Assets) Generator
Generate pre-filled reporting tables for foreign assets held during the relevant calendar year (1st Jan to 31st Dec):
- **Table A3:** Foreign Equity & Debt holdings (Peak value during the year, Closing value at year end, Gross dividend received, Gross capital gains realized).
- **Table D:** Foreign Bank Accounts / Custodial Accounts.

#### FR-6.2: Schedule AL (Assets & Liabilities at Year-End) Generator
For individuals with total income exceeding ₹50 Lakhs, auto-populate the cost of acquisition as of 31st March for:
- Immovable Property (Land, Building).
- Movable Assets (Financial assets: Shares, Mutual Funds, Securities, Cash in hand, Loans & Advances given, Jewelry, Vehicles).
- Corresponding Liabilities (Home loans, personal loans, mortgages).

#### Acceptance Criteria (FR-6)
```gherkin
Scenario: Generating Schedule FA Output for US Stocks
  Given the foreign snapshot for 31-Dec-2025
  When the user selects "Export Schedule FA Report"
  Then the system calculates the Peak Holding Value in USD & INR during 1-Jan-2025 to 31-Dec-2025
  And computes Closing Value on 31-Dec-2025 using SBI ITBR rate
  And formats the output into Table A3 compliant JSON/CSV structure ready for ITR upload.
```

---

### Module 7: PII Masking Layer for AI Services

#### FR-7.1: Zero-Trust PII Anonymization Engine
Before any internal portfolio data payload, trade summary, or document text is passed to any AI/LLM service for natural language insight or portfolio audit, the system **MUST** pass the text through a client-side masking pipeline.

#### FR-7.2: Target PII Token Masking Map
- **PAN Card:** Regex `[A-Z]{5}[0-9]{4}[A-Z]{1}` $
ightarrow$ `[REDACTED_PAN]`
- **Aadhaar Number:** Regex `[2-9]{1}[0-9]{3}\s?[0-9]{4}\s?[0-9]{4}` $
ightarrow$ `[REDACTED_AADHAAR]`
- **DP ID / Client ID / Folio:** `[REDACTED_DEMAT_ACCOUNT]`
- **Full Names / Individual Names:** Named Entity Recognition (NER) $
ightarrow$ `[REDACTED_NAME]`
- **Email / Phone / Address:** Regex $
ightarrow$ `[REDACTED_CONTACT]`
- **Transaction IDs / Order IDs:** Regex $
ightarrow$ `[REDACTED_TXN_ID]`

#### Acceptance Criteria (FR-7)
```gherkin
Scenario: PII Scrubbing prior to LLM Prompt Submission
  Given a user raw prompt: "Analyze portfolio for Rajesh Sharma, PAN: ABCDE1234F, DPID: 1208160000123456 holding 500 shares of TCS"
  When the prompt passes through the PII Anonymization Proxy
  Then the payload sent to the LLM must strictly read:
  "Analyze portfolio for [REDACTED_NAME], PAN: [REDACTED_PAN], DPID: [REDACTED_DEMAT_ACCOUNT] holding 500 shares of TCS"
  And no PII entity shall leak to external API logs.
```

---

### Module 8: Containerized Deployment & Host-Native Data Persistence

#### FR-8.1: Fully Dockerized Application Stack
The entire application — **both frontend and backend** — shall run inside Docker containers. A single
`docker compose up` on a clean host with no Node.js, no pnpm and no system-level dependency installation
must bring up a fully functional application.

- **Backend container:** Node 22 API service hosting the domain, tax, FX, snapshot, ingestion and
  compliance engines.
- **Frontend container:** the React SPA, served by a production web server, reverse-proxying `/api` to
  the backend service on the internal Docker network.
- **Service isolation:** frontend and backend are separate images and separate containers, independently
  buildable and independently versioned.
- **Reproducibility:** images are built from pinned base image digests; a build on any host produces a
  functionally identical image.

#### FR-8.2: Host-Native Volume Persistence
The encrypted portfolio database **must be stored on the host operating system's native disk volume**,
not inside the container's writable layer and not in an anonymous Docker volume.

- **Bind mount:** the database directory is bind-mounted from a host path (default `./data`, overridable
  via the `VANTAGEPOINT_DATA_DIR` environment variable) to a fixed in-container path.
- **Survivability:** `docker compose down`, image rebuild, container recreation, and Docker Engine
  upgrade must all leave the database intact and readable.
- **Direct host access:** the database file must be visible, backup-able and copyable directly from the
  host filesystem without entering the container.
- **Ownership & permissions:** containers run as a non-root user whose UID/GID is configurable
  (`VANTAGEPOINT_UID`/`VANTAGEPOINT_GID`) so bind-mounted files are owned by the host user, not by root.
- **Cross-platform:** the same compose file works on Linux, macOS (Docker Desktop) and Windows (WSL2).

#### FR-8.3: Container Security Posture
- Containers run as a **non-root** user; no container requires `--privileged`.
- Backend container filesystem is **read-only** except for the bind-mounted data directory and `/tmp`.
- **No secrets in images.** The vault passphrase and any API keys are supplied at runtime via environment
  or Docker secrets, never baked into a layer or committed to the compose file.
- Egress remains **default-deny** (§4.3): the backend container has no outbound network access unless the
  user explicitly enables the egress profile.
- **PII masking remains client-side.** Containerization must not relocate the masking layer to the
  backend — masking executes in the browser before any payload reaches the backend or any AI service.

#### Acceptance Criteria (FR-8)
```gherkin
Scenario: Clean-host bring-up with no local toolchain
  Given a host with only Docker and Docker Compose installed
  And no Node.js, pnpm or build toolchain present
  When the user runs "docker compose up"
  Then the frontend is reachable on the published port
  And the backend health endpoint reports healthy
  And the user can unlock a vault and view the dashboard

Scenario: Database persists on the host disk across container destruction
  Given a running stack with portfolio data and a snapshot "DOM_31MAR2026"
  When the user runs "docker compose down" and then "docker compose up" again
  Then the vault unlocks with the same passphrase
  And snapshot "DOM_31MAR2026" is present with an identical contentHash
  And the database file is visible on the host filesystem at the configured data directory

Scenario: Database survives an image rebuild
  Given a running stack with existing portfolio data
  When the images are rebuilt with "docker compose build --no-cache" and the stack is restarted
  Then all pre-existing data remains intact and readable

Scenario: Containers do not run as root and files are host-user owned
  Given the stack is running
  When the effective user inside the backend container is inspected
  Then it is a non-root user
  And files written to the bind-mounted data directory are owned by the configured host UID/GID

Scenario: No secrets are baked into images
  Given a built backend image
  When its layers are inspected
  Then no vault passphrase, API key or .env file is present in any layer
```

---

### Module 9: Visual Design System

#### FR-9.1: Reference-Derived Theme
The interface shall follow the supplied reference design. Colour values are taken from that
reference by sampling, not approximation:

| Role | Value | Use |
|---|---|---|
| Canvas | `#8891A9` | The field the app shell floats on |
| Shell | `#E8EAEC` | Shell interior — warm light grey, not white |
| Surface | `#FFFFFF` | Cards |
| Sunken | `#D5D9DD` | Chips, inset panels, progress troughs |
| Ink | `#0E1124` | Primary text — navy-tinted, never pure black |
| Muted ink | `#7A8090` | Secondary text |
| Brand accent | `#E4482F` | Brand marks and primary CTAs only |
| Info | `#7796BB` | Informational badges |

- **Geometry:** shell radius 28px, card radius 20px, control radius 12px, chips fully rounded.
- **Elevation:** diffuse low-contrast shadows only; no hard drop shadows.
- **Typography:** Inter (SIL OFL), bundled with the application. Monetary and quantity columns
  render with tabular figures so digits align vertically.

#### FR-9.2: Semantic Colour Beyond the Reference
The reference is a freelancing dashboard; this product is a tax and portfolio tool, where colour
carries meaning it does not carry there. Two additions are therefore mandated:

- **Gain / loss must never reuse the brand accent.** The brand accent is vermilion, and vermilion
  already means "loss" in a portfolio context. Gains use `#0E7C5A`, losses `#B3261E`, and an exactly
  zero change renders in muted ink so it cannot be misread as either.
- **Compliance status must not collide with gain/loss.** Filed, due, overdue and provisional states
  use amber `#B7791F`, which signals "action needed" without implying a financial loss.

#### FR-9.3: Font Delivery Under Zero-Egress
Fonts shall be **self-hosted from within the application bundle**. Loading a webfont from an external
CDN is prohibited: it would either be blocked by the default-deny egress policy (§4.3) or would
require punching a hole in it, and it would leak the fact and timing of application use to a third
party.

#### Acceptance Criteria (FR-9)
```gherkin
Scenario: The theme is driven by tokens, not scattered literals
  When the stylesheet is inspected
  Then every colour, radius, spacing and type value resolves from a design token
  And no component declares a raw hex colour of its own

Scenario: Brand accent is never used to convey financial direction
  Given a portfolio position showing a loss
  When the position is rendered
  Then the loss uses the semantic loss colour, not the brand accent
  And a primary call-to-action on the same screen uses the brand accent

Scenario: A zero change is visually distinct from both a gain and a loss
  Given a position whose value has not changed
  Then its delta renders in muted ink, in neither the gain nor the loss colour

Scenario: No font is fetched from an external origin
  Given the application is loaded with the default egress policy
  When network activity is inspected
  Then no request is made to any font CDN
  And all font faces resolve from bundled assets

Scenario: Monetary columns align on the decimal
  Given a table of monetary values of differing magnitudes
  Then digits render with tabular figures so place values align vertically
```

---

## 4. Non-Functional Requirements (NFRs)

1. **Security & Encryption:**
   - All portfolio data stored at rest using **AES-256 authenticated encryption (AES-256-CBC +
     HMAC-SHA512), applied page-level across the whole database file** so that schema identifiers,
     index structures and row counts are encrypted alongside the values themselves.
     *Amended 2026-08-02 (see ADR-015): the original wording specified AES-256-GCM, which no
     whole-file SQLite encryption provider offers. Value-level GCM was rejected because it would
     forfeit range queries and indexing on dates and amounts for no material security gain over a
     single authenticated layer.*
   - All CAMS PDF passwords decrypted strictly in-memory; passwords are never persisted.
   - Containers run as non-root with a read-only root filesystem; no secrets in image layers.
2. **Performance & Scalability:**
   - Portfolio valuation calculation (across 1,000+ individual lots) must complete within <1.5 seconds.
   - Snapshot generation and side-by-side delta computation must render within <2.0 seconds.
   - Performance budgets are measured **inside the container**, not only on a bare host.
3. **Data Sovereignty & Offline Capabilities:**
   - Local-first storage model. PII masking runs locally in WebAssembly/Node edge runtime, **client-side
     in the browser**, and is not relocated to the backend container.
   - The encrypted database resides on the host OS's native disk volume via bind mount, fully under the
     user's control and independent of the container lifecycle.
4. **Accessibility & Presentation:**
   - Body text meets WCAG AA contrast (≥4.5:1) against its surface; large text ≥3:1.
   - Financial direction is never conveyed by colour alone — a sign or arrow accompanies it, so the
     roughly 1 in 12 men with a red-green deficiency can still read a portfolio.
   - `prefers-reduced-motion` is honoured.
5. **Deployment & Portability:**
   - Full stack (frontend + backend) starts with a single `docker compose up` on a host with no
     application toolchain installed.
   - Data survives `docker compose down`, image rebuilds and Docker Engine upgrades.
   - Identical compose definition works on Linux, macOS and Windows (WSL2).

---

## 5. Technical Data Model Architecture

```json
{
  "UserPortfolio": {
    "userId": "usr_987654321",
    "residencyStatus": "RESIDENT_INDIAN",
    "hniStatus": true,
    "incomeProfile": {
      "assessmentYear": "2026-2027",
      "financialYear": "2025-2026",
      "projectedGrossSalary": 12000000,
      "taxRegime": "NEW_REGIME",
      "estimatedSurchargePct": 15.0
    },
    "assetLedger": [
      {
        "assetId": "ast_us_equity_001",
        "assetClass": "FOREIGN_EQUITY",
        "symbol": "AAPL",
        "currency": "USD",
        "acquisitionLots": [
          {
            "lotId": "lot_01",
            "acquisitionDate": "2023-05-10",
            "quantity": 100,
            "costPerUnitUSD": 172.50,
            "sbiItbrRateOnAcquisition": 82.10
          }
        ]
      },
      {
        "assetId": "ast_handloan_002",
        "assetClass": "HAND_LOAN",
        "borrowerName": "[MASKED_IN_AI_PAYLOAD]",
        "currency": "INR",
        "principalAmount": 5000000,
        "interestRatePct": 8.0,
        "startDate": "2025-04-01"
      }
    ]
  }
}
```

---

## 6. Implementation Roadmap & Milestones

- **Phase 1 (Core & Compliance Foundation):**
  - Multi-asset ledger setup (Equities, MFs, FDs, EPF/NPS, Hand Loans, Cash).
  - CAMS, Zerodha, Vested, E*TRADE parsers + Standardized CSV templates.
  - SBI ITBR rate ingestion engine with automated fallback.
  - Fixed-date snapshots (31-Mar Domestic, 31-Dec Foreign) & Live comparison.
  - Form 16 / Income ingestion engine & Tax Slab calculator.
  - LTCG, STCG, and Quarterly Advance Tax calculation engine.
  - Client-side PII Scrubbing Proxy.

- **Phase 2 (Advanced Reporting & Automation):**
  - Pre-filled Schedule FA and Schedule AL ITR export modules.
  - Real-time automated broker API synchronization (KiteConnect, etc.).
  - Advanced Portfolio Rebalancing insights via PII-anonymized AI engine.
