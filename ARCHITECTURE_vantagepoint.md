# VantagePoint — Architecture

**Companion to:** [`implementation_plan_vantagepoint.md`](./implementation_plan_vantagepoint.md) · [`Global_Portfolio_Tracker_PRD.md`](./Global_Portfolio_Tracker_PRD.md)
**Version:** 1.1 (containerized) · **Date:** 2026-08-02

---

## 1. Architectural Style and Why

**Hexagonal (ports & adapters) domain core, deployed as a two-container stack.**

| Force (from the PRD) | Architectural response |
|---|---|
| Tax/FX correctness is the product; a wrong number is a filing defect | Domain packages are **pure functions over immutable data** — no I/O, no ambient clock. Every tax rule is unit-testable in isolation with a fixed `Clock`. |
| PII must never leave the device unmasked (FR-7) | Masking lives in the **browser bundle** (ADR-013). The API holds only a *verifier* that fails closed. There is exactly one egress choke point. |
| Data sovereignty, local-first (§4.3) | Single-tenant encrypted SQLite on the **host's own disk** via bind mount (ADR-012), page-level AES-256 (ADR-015). No cloud dependency, no telemetry. |
| Must run anywhere, no toolchain (FR-8.1) | Two Docker images + one compose file. The domain never knows it is containerized. |
| Compliance artifacts must be reproducible | Snapshots are **immutable and content-addressed** (ADR-006). Rules are **versioned data** keyed by FY (ADR-005). |
| <1.5 s valuation over 1,000+ lots (NFR-2) | The whole domain runs **in one process** — valuation is in-memory function composition, not a service mesh. The container split is UI/API only; the domain is never distributed. |

**What this deliberately is not:** microservices. Splitting the tax engine from the ledger would put a
network hop inside a calculation that must finish in 1.5 s, and would make a tax computation non-atomic
with respect to the ledger it read. One process, many pure modules.

---

## 2. C4 Level 1 — System Context

```mermaid
graph TB
    User["Indian Tax Resident<br/>(HNI / Global Investor / DIY)"]
    CA["Chartered Accountant<br/>(consumes exports)"]

    PT["<b>VantagePoint</b><br/>Containerized portfolio tracking<br/>and Indian tax compliance"]

    SBI["SBI Treasury<br/>ITBR / TTBR rate sheets"]
    RBI["RBI Reference Rates"]
    ECB["ECB / OANDA<br/>(tertiary fallback)"]
    AMFI["AMFI NAVAll.txt<br/>MF NAV feed"]
    LLM["AI / LLM Service<br/>(optional, opt-in)"]
    Broker["Broker statement files<br/>CAMS · Zerodha · Vested · E*TRADE"]
    ITR["Income Tax Portal<br/>(manual upload of exports)"]
    Disk["Host OS disk volume<br/>encrypted vault.db"]

    User -->|"unlock vault, record trades,<br/>compare snapshots, compute tax"| PT
    User -->|"uploads statement files"| Broker
    Broker -->|"PDF / CSV / XLSX"| PT

    PT -->|"reads/writes AES-256 encrypted vault<br/>via bind mount"| Disk
    PT -.->|"opt-in egress profile only"| SBI
    PT -.->|"fallback"| RBI
    PT -.->|"fallback"| ECB
    PT -.->|"NAV refresh"| AMFI
    PT -.->|"<b>PII-masked payloads only</b><br/>fail-closed guard"| LLM

    PT -->|"Schedule FA / AL, advance tax<br/>JSON + CSV exports"| CA
    CA -->|"files"| ITR

    classDef sys fill:#1f4e79,stroke:#0d2b45,color:#fff
    classDef ext fill:#e8eef5,stroke:#5b7fa6,color:#1a1a1a
    classDef store fill:#2d6a4f,stroke:#1b4332,color:#fff
    class PT sys
    class SBI,RBI,ECB,AMFI,LLM,Broker,ITR,CA,User ext
    class Disk store
```

**Dotted edges are default-deny.** Every dotted line requires the user to start the `egress` compose
profile *and* trigger the action explicitly (ADR-010). A default `docker compose up` makes zero
outbound connections.

---

## 3. C4 Level 2 — Container View (deployment reality)

```mermaid
graph TB
    subgraph Host["🖥️  Host OS"]
        Browser["Browser"]

        subgraph DockerNet["Docker bridge network: vantagepoint_internal"]
            Web["<b>vantagepoint-web</b><br/>Caddy 2 + React SPA bundle<br/>─────────────<br/>• SPA history fallback<br/>• reverse-proxy /api → api:8080<br/>• <b>pii-masker (WASM/JS)</b><br/>non-root · read-only FS<br/>published: :5173"]
            API["<b>vantagepoint-api</b><br/>Node 22 + Fastify<br/>─────────────<br/>• app-services orchestration<br/>• all domain packages in-process<br/>• persistence + adapters<br/>• PII egress verifier (fail-closed)<br/>non-root · read-only FS · no published port"]
        end

        subgraph HostFS["Host filesystem — NATIVE DISK"]
            Vault[("<b>${VANTAGEPOINT_DATA_DIR:-./data}</b><br/>vault.db · vault.db-wal · vault.db-shm<br/>AES-256-CBC+HMAC page-level<br/>owned by VANTAGEPOINT_UID:GID")]
        end

        Tmp["tmpfs /tmp<br/>(only other writable path)"]
    end

    Ext["External hosts<br/>SBI · RBI · AMFI · LLM"]

    Browser -->|"HTTP :5173"| Web
    Web -->|"/api/* → :8080<br/>internal only"| API
    API -->|"better-sqlite3-multiple-ciphers<br/>WAL, single writer"| Vault
    API -.-> Tmp
    API -.->|"ONLY with compose.egress.yaml<br/>+ explicit user action"| Ext

    Vault -.->|"user can back up / copy / move<br/>directly from the host, no docker exec"| Host

    classDef container fill:#1f4e79,stroke:#0d2b45,color:#fff
    classDef store fill:#2d6a4f,stroke:#1b4332,color:#fff
    classDef ext fill:#e8eef5,stroke:#5b7fa6,color:#1a1a1a
    class Web,API container
    class Vault,Tmp store
    class Ext,Browser ext
```

### Why bind mount, not a Docker volume

PRD FR-8.2 requires the DB on the "native OS disk volume". A **named volume** lives under
`/var/lib/docker/volumes/…`, is owned by root, is opaque to the user's backup tooling, and disappears on
`docker volume prune`. A **bind mount** puts `vault.db` at a path the user chose, owned by the user's own
UID, backed up by whatever already backs up their home directory. That is the requirement. (ADR-012)

| Property | Bind mount ✅ | Named volume ❌ |
|---|---|---|
| Visible on host at a user-chosen path | Yes | No (docker-internal path) |
| Survives `docker volume prune` | Yes | No |
| Backup with normal host tools | Yes | Requires a helper container |
| Owned by the host user | Yes (via UID/GID mapping) | Root by default |

---

## 4. C4 Level 3 — Component View

```mermaid
graph TB
    subgraph WEBC["vantagepoint-web container"]
        UI["<b>apps/web</b> — React SPA<br/>Dashboard · Ledger · Import · Snapshots · Tax · Compliance"]
        MASK["<b>pii-masker</b> (client-side, ADR-013)<br/>RegexRules → NER → Pseudonymiser → EgressGuard"]
        UI --> MASK
    end

    subgraph APIC["vantagepoint-api container"]
        ROUTES["<b>apps/api</b> — Fastify routes<br/>thin shell, zero business logic"]

        subgraph AS["packages/app-services — use-case orchestration"]
            UC1["RecordTransactionUC"]
            UC2["ValuePortfolioUC"]
            UC3["GenerateSnapshotUC"]
            UC4["CompareSnapshotsUC"]
            UC5["ComputeAdvanceTaxUC"]
            UC6["ImportStatementUC"]
            UC7["GenerateComplianceUC"]
        end

        subgraph DOM["Domain packages — PURE, no I/O"]
            CD["<b>core-domain</b><br/>Asset · Lot · FifoAllocator<br/>CorporateActions · Liability<br/>ValuationEngine"]
            FX["<b>fx-itbr</b><br/>RateStore · FallbackChain<br/>Rule115Resolver<br/>DualRateConverter"]
            TAX["<b>tax-engine</b><br/>SlabCalculator · Surcharge+MarginalRelief<br/>CapitalGains · AdvanceTax<br/>HniClassifier · ComputationTrace<br/>rules/FY-*.json"]
            SNAP["<b>snapshot</b><br/>SnapshotFactory · ContentHasher<br/>CompliancePolicy · DeltaEngine<br/>AllocationShift · XIRR"]
            COMP["<b>compliance</b><br/>PeakValueCalculator<br/>ScheduleFA_A3 · ScheduleFA_D<br/>ScheduleAL · ItrExporter"]
            ING["<b>ingestion</b><br/>Pipeline · CamsCasParser<br/>ZerodhaParser · VestedParser<br/>EtradeParser · TemplateParser<br/>DuplicateDetector"]
            SK["<b>shared-kernel</b><br/>Money · Decimal · FyDate<br/>Result · Clock · IdGenerator · Errors"]
        end

        subgraph INFRA["Infrastructure adapters — I/O"]
            PERS["<b>persistence</b><br/>SqliteRepositories · Migrations<br/>PageCipher (AES-256-CBC+HMAC)<br/>Argon2id KDF"]
            AFX["<b>adapters-fx</b><br/>SbiScraper · RbiClient<br/>EcbClient · AmfiNavClient"]
            EG["<b>EgressGateway</b><br/>single choke point · allow-list<br/>audit log · default-deny"]
            VERIF["<b>pii verifier</b><br/>same rules, assert-only"]
        end
    end

    DISK[("Host bind mount<br/>vault.db")]
    NET["External hosts"]

    UI -->|"HTTPS /api"| ROUTES
    MASK -.->|"masked payload only"| ROUTES
    ROUTES --> AS

    UC1 --> CD
    UC2 --> CD
    UC2 --> FX
    UC3 --> SNAP
    UC3 --> CD
    UC4 --> SNAP
    UC5 --> TAX
    UC5 --> CD
    UC5 --> FX
    UC6 --> ING
    UC7 --> COMP

    CD --> SK
    FX --> SK
    TAX --> SK
    SNAP --> SK
    COMP --> SK
    ING --> SK

    CD -.->|"needs INR conversion"| FX
    TAX -.->|"Rule 115 taxable amounts"| FX
    SNAP -.->|"positions to value"| CD
    COMP -.->|"peak/closing values"| SNAP
    ING -.->|"emits domain events"| CD

    AS --> PERS
    AS --> VERIF
    PERS --> DISK
    AFX --> EG
    EG -.->|"opt-in only"| NET
    AS --> AFX

    classDef pure fill:#2d6a4f,stroke:#1b4332,color:#fff
    classDef svc fill:#1f4e79,stroke:#0d2b45,color:#fff
    classDef io fill:#8b5a00,stroke:#5c3c00,color:#fff
    classDef client fill:#6a1b9a,stroke:#4a148c,color:#fff
    class CD,FX,TAX,SNAP,COMP,ING,SK pure
    class UC1,UC2,UC3,UC4,UC5,UC6,UC7,ROUTES svc
    class PERS,AFX,EG,VERIF io
    class UI,MASK client
```

**Colour legend:** 🟩 green = pure domain (no I/O, deterministic) · 🟦 blue = orchestration · 🟧 amber =
I/O adapters · 🟪 purple = browser-side. **Arrows only ever point right/down this list.** A green node
importing an amber node is a lint failure.

### Component responsibilities

| Component | Owns | Explicitly does NOT own |
|---|---|---|
| `shared-kernel` | `Money`, `Decimal`, `FyDate`, `Result<T,E>`, `Clock`/`IdGenerator` ports, error taxonomy | Any business rule |
| `core-domain` | Asset/lot lifecycle, FIFO allocation, corporate actions, liabilities, valuation | FX rate selection, tax classification |
| `fx-itbr` | Rate storage + provenance, fallback chain, Rule 115, dual-rate conversion | Fetching rates (that's `adapters-fx`) |
| `tax-engine` | Slabs, surcharge, marginal relief, cess, CG classification & computation, advance tax, HNI flag, trace | Where income came from |
| `snapshot` | Immutability, content hashing, compliance date policy, delta/variance, XIRR | Valuing positions (delegates to `core-domain`) |
| `ingestion` | Parse → validate → stage → reconcile → commit, per-broker parsers, dedup | Persisting (returns commands to `app-services`) |
| `compliance` | Peak value, Schedule FA A3/D, Schedule AL, ITR export shapes | Deciding HNI status (asks `tax-engine`) |
| `pii-masker` | Regex + NER masking, pseudonymisation, fail-closed guard | Talking to any AI service |
| `persistence` | SQLite repositories, migrations, page-level AES-256 cipher, Argon2id KDF | Domain rules |
| `EgressGateway` | The *only* outbound socket in the process; allow-list + audit | Deciding what to send |

---

## 5. Data Flow Sequences

### 5.1 Foreign equity partial exit — the dual-rate flow (US-1.4, US-2.5 · PRD FR-1/FR-2)

The single most consequential flow in the system: it is where ADR-003 resolves the PRD's rate conflict.

```mermaid
sequenceDiagram
    autonumber
    actor U as User (Browser)
    participant W as vantagepoint-web
    participant R as apps/api routes
    participant UC as RecordTransactionUC
    participant CD as core-domain
    participant FIFO as FifoAllocator
    participant FX as fx-itbr
    participant RS as RateStore
    participant EG as EgressGateway
    participant SBI as SBI Treasury
    participant P as persistence
    participant DB as Host vault.db

    U->>W: Sell 40 AAPL @ $180 on 2026-02-15
    W->>R: POST /api/transactions/exit
    R->>UC: execute(ExitCommand)

    UC->>CD: loadAsset(ast_us_equity_001)
    CD->>P: findAsset()
    P->>DB: SELECT (page-level decrypt)
    DB-->>P: ciphertext
    P-->>CD: Asset{lots:[L1: 100 @ $172.50, 2023-05-10]}

    Note over UC,FX: ── Rate resolution: TWO rates, one transaction (ADR-003) ──

    UC->>FX: resolveValuationRate(USD→INR, 2026-02-15)
    FX->>RS: get(USD, 2026-02-15, SBI_ITBR)
    alt rate present
        RS-->>FX: 84.10 (SBI_ITBR)
    else rate absent
        FX->>EG: request SBI sheet (only if egress profile on)
        EG->>SBI: GET rate sheet
        SBI-->>EG: sheet
        EG-->>FX: parsed
        opt still unavailable
            FX->>FX: FallbackChain → RBI → ECB → OANDA
            FX-->>FX: flag "RBI Fallback (Pending SBI ITBR Finalization)"
        end
    end
    FX-->>UC: valuationRate = 84.10 {source: SBI_ITBR}

    UC->>FX: resolveRule115Rate(USD→INR, 2026-02-15)
    FX->>FX: precedingMonthEnd(2026-02-15) → 2026-01-31
    FX->>RS: get(USD, 2026-01-31, SBI_ITBR)
    RS-->>FX: 83.55
    FX-->>UC: taxRate = 83.55 {rule: "Rule 115", basisDate: 2026-01-31}

    Note over UC,FIFO: ── FIFO allocation ──
    UC->>FIFO: allocate(lots, qty=40)
    FIFO->>FIFO: consume L1 oldest-first
    FIFO-->>UC: [{lot:L1, qty:40, cost:$172.50}]
    UC->>CD: L1.remainingQuantity = 60

    UC->>CD: computeRealisedGain()
    CD-->>UC: gainUSD = 40 × (180.00 − 172.50) = $300.00
    UC->>FX: convert(proceeds $7,200, both rates)
    FX-->>UC: valuationInr ₹605,520.00 · taxableInr ₹601,560.00

    UC->>P: persist(ExitTransaction + allocations + both rates + provenance)
    P->>DB: INSERT (encrypted) → bind-mounted host disk
    DB-->>P: ok
    P-->>UC: committed
    UC-->>R: ExitResult
    R-->>W: 201 {gain, valuationInr, taxableInr, remainingQty: 60}
    W-->>U: Confirmation with both INR figures and their rate provenance
```

> **The invariant this diagram exists to protect:** `valuationInr` (₹605,520) is what the dashboard shows;
> `taxableInr` (₹601,560) is what the capital gains engine reads. They differ by ₹3,960. Collapsing them
> into one number satisfies one PRD clause and violates the other.

---

### 5.2 Dual compliance snapshot generation (US-3.2/3.3 · PRD FR-3)

```mermaid
sequenceDiagram
    autonumber
    participant SCH as SnapshotScheduler
    participant CLK as Clock (Asia/Kolkata)
    participant UC as GenerateSnapshotUC
    participant POL as CompliancePolicy
    participant CD as core-domain
    participant VAL as ValuationEngine
    participant FX as fx-itbr
    participant SF as SnapshotFactory
    participant CH as ContentHasher
    participant P as persistence
    participant DB as Host vault.db

    SCH->>CLK: now()
    CLK-->>SCH: 2026-04-01T00:05:00+05:30

    SCH->>POL: dueSnapshots(now)
    POL->>POL: crossed 31-Mar IST EOD → DOMESTIC due
    POL->>POL: crossed 31-Dec IST EOD → FOREIGN not due
    POL-->>SCH: [{id:"DOM_31MAR2026", scope:DOMESTIC, asOf:2026-03-31T23:59:59.999+05:30}]

    SCH->>UC: generate(spec)
    UC->>P: exists("DOM_31MAR2026")?
    P-->>UC: false
    Note over UC: idempotent — true would return existing, no error

    UC->>CD: positionsAsOf(asOf, scope=DOMESTIC)
    CD->>P: transactions where tradeDate <= asOf
    P->>DB: SELECT (decrypt)
    DB-->>P: rows
    P-->>CD: transactions
    CD->>CD: replay lots, apply corporate actions, exclude jurisdiction=FOREIGN
    CD-->>UC: 847 domestic positions

    loop each position
        UC->>VAL: value(position, asOf)
        VAL->>FX: rateFor(currency, asOf) [INR positions skip]
        FX-->>VAL: rate + provenance
        VAL-->>UC: Money(INR)
    end

    UC->>CD: liabilitiesAsOf(asOf)
    CD-->>UC: Money(INR) 8,000,000

    UC->>SF: build(positions, totals, liabilities)
    SF->>CH: sha256(canonicalJson)
    CH-->>SF: 0x9f3c…
    SF-->>UC: Snapshot{frozen:true, contentHash:0x9f3c…}

    UC->>P: persistImmutable(snapshot)
    P->>DB: INSERT (encrypted, write-once)
    DB-->>P: ok
    P-->>UC: ok
    UC-->>SCH: "DOM_31MAR2026" created

    Note over SCH,DB: On 2027-01-01 the identical flow runs<br/>with scope=FOREIGN → "FOR_31DEC2026"
```

---

### 5.3 Advance tax Q3 with realised capital gains (US-5.10 · PRD FR-5)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant W as vantagepoint-web
    participant R as apps/api
    participant UC as ComputeAdvanceTaxUC
    participant FY as FyCalendar
    participant RT as TaxRuleTable
    participant F16 as Form16Profile
    participant CD as core-domain
    participant CG as CapitalGainsEngine
    participant OS as OtherSourcesAggregator
    participant SL as SlabCalculator
    participant SC as Surcharge+MarginalRelief
    participant AT as AdvanceTaxEngine
    participant TR as ComputationTrace

    U->>W: "Compute Q3 advance tax, FY 2025-26"
    W->>R: GET /api/tax/advance?fy=2025-26&quarter=Q3
    R->>UC: execute()

    UC->>FY: quarterCutoff(FY2025-26, Q3)
    FY-->>UC: 2025-12-15 · cumulative 75%

    UC->>RT: rulesFor("2025-26")
    RT-->>UC: slabs · surcharge bands · cess 4% · STCG 20% · LTCG 12.5%/₹1.25L
    Note over RT: missing FY ⇒ TaxRulesUnavailableError,<br/>never silent fallback to a prior year

    UC->>F16: projectedIncome()
    F16-->>UC: grossSalary ₹12,000,000 · TDS remitted ₹1,850,000

    UC->>CD: realisedExits(FY2025-26, upto 2025-12-15)
    CD-->>UC: STCG ₹500,000 (2025-11-10)
    Note over CD,UC: a gain dated 2025-12-20 is EXCLUDED from Q3,<br/>included from Q4

    UC->>CG: classifyAndCompute(exits)
    CG->>CG: listed domestic, held ≤12m → STCG @ 20%
    CG-->>UC: stcgTax ₹100,000

    UC->>OS: aggregate(FY)
    OS-->>UC: handLoanInterest ₹400,000 + fdInterest ₹73,970.86 + dividends ₹100,000

    UC->>SL: computeSlabTax(salary + otherSources, regime)
    SL-->>UC: baseTax

    UC->>SC: apply(baseTax + stcgTax, totalIncome)
    SC->>SC: band → 10% surcharge (>₹50L)
    SC->>SC: marginal relief check at threshold
    SC->>SC: cess 4% on (tax + surcharge)
    SC-->>UC: totalLiability

    UC->>AT: installment(totalLiability, Q3)
    AT->>AT: required = 75% × totalLiability
    AT->>AT: less TDS remitted, less Q1+Q2 already paid
    AT->>AT: round to nearest ₹10 (s.288B)
    AT-->>UC: netPayable

    UC->>TR: emit(every line item + rule reference)
    TR-->>UC: trace[] where Σ line items == totalLiability exactly

    UC-->>R: {netPayable, dueDate: 2025-12-15, trace}
    R-->>W: 200
    W-->>U: Q3 payable + full auditable derivation
```

---

### 5.4 PII masking before AI egress — fail-closed (US-7.3/7.4 · PRD FR-7)

The masker runs **in the browser**, before the payload ever reaches the API container (ADR-013).

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as apps/web
    participant RX as RegexRules
    participant NER as NER (wink-nlp, local)
    participant PS as Pseudonymiser
    participant GD as EgressGuard
    participant V as Local reversal map<br/>(encrypted vault)
    participant R as apps/api
    participant VER as PII verifier (API-side)
    participant EG as EgressGateway
    participant LLM as AI Service

    U->>UI: "Analyze portfolio for Rajesh Sharma, PAN: ABCDE1234F,<br/>DPID: 1208160000123456 holding 500 shares of TCS"

    UI->>RX: mask(raw)
    RX->>RX: PAN [A-Z]{5}[0-9]{4}[A-Z] → [REDACTED_PAN]
    RX->>RX: Aadhaar → [REDACTED_AADHAAR]
    RX->>RX: DP/Client/Folio → [REDACTED_DEMAT_ACCOUNT]
    RX->>RX: email · phone · address → [REDACTED_CONTACT]
    RX->>RX: order/txn IDs → [REDACTED_TXN_ID]
    RX-->>UI: partially masked

    UI->>NER: detectPersonEntities(text)
    NER->>NER: runs fully offline — no network
    NER-->>UI: [{"Rajesh Sharma", PERSON}]
    Note over NER: "Tata Consultancy Services" classified ORG → preserved

    UI->>PS: tokenise(entities)
    PS->>PS: stable per-session mapping<br/>same person → same token
    PS->>V: store reversal map (never leaves device)
    PS-->>UI: "[REDACTED_NAME]"

    UI->>GD: verify(maskedPayload)
    GD->>GD: rescan for ANY residual PII pattern

    alt residual PII found
        GD--xUI: throw PiiLeakError
        Note over GD,LLM: request NEVER dispatched (ADR-007)
        UI-->>U: "Blocked: potential PII detected. AI call aborted."
    else clean
        GD-->>UI: pass
        UI->>R: POST /api/ai/analyze {maskedPayload}
        R->>VER: assertClean(payload)
        Note over VER: second, independent check —<br/>the API refuses to relay anything unmasked
        alt verifier rejects
            VER--xR: PiiLeakError
            R-->>UI: 422 — nothing sent onward
        else verifier passes
            R->>EG: dispatch(allow-listed AI host)
            EG->>EG: audit log {destination, purpose, bytes, timestamp}
            EG->>LLM: "Analyze portfolio for [REDACTED_NAME], PAN: [REDACTED_PAN],<br/>DPID: [REDACTED_DEMAT_ACCOUNT] holding 500 shares of TCS"
            LLM-->>EG: insight
            EG-->>R: insight
            R-->>UI: insight
            UI->>V: rehydrate tokens locally for display
            UI-->>U: insight with real names restored client-side
        end
    end
```

> **Two independent guards, both fail-closed.** The browser guard is the requirement; the API verifier
> exists because a bug in the SPA must not be sufficient to leak PII. Neither guard warns-and-continues.

---

### 5.5 CAMS CAS PDF ingestion — password never persisted (US-4.2 · PRD FR-4/NFR-1)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as apps/web
    participant R as apps/api
    participant PIPE as ingestion.Pipeline
    participant DEC as PdfDecryptor (in-memory)
    participant CASP as CamsCasParser
    participant VAL as SchemaValidator
    participant DUP as DuplicateDetector
    participant STG as StagingArea
    participant CD as core-domain
    participant P as persistence
    participant DB as Host vault.db

    U->>UI: upload CAS PDF + password
    UI->>R: POST /api/imports (multipart, password in body)
    R->>PIPE: ingest(bytes, password, parser=CAMS)

    PIPE->>DEC: decrypt(bytes, password)
    Note over DEC: password held in a Buffer only —<br/>never logged, never written to disk (NFR-1)
    alt wrong password
        DEC--xPIPE: PdfDecryptionError
        DEC->>DEC: zeroise buffer
        PIPE-->>R: 400 — no partial write
        R-->>UI: "Incorrect password"
    else decrypted
        DEC-->>PIPE: plaintext PDF (in memory)
        DEC->>DEC: zeroise password buffer immediately
    end

    PIPE->>CASP: parse(pdf)
    CASP->>CASP: fingerprint layout → select adapter
    alt unrecognised layout
        CASP--xPIPE: UnknownCasLayoutError → suggest CSV template path
    else recognised
        CASP-->>PIPE: folios · ISINs · schemes · txn dates · NAVs · units
    end

    PIPE->>VAL: validate(rows)
    VAL-->>PIPE: {valid: 312, invalid: 2 with row+column+reason}

    alt strict mode and invalid > 0
        PIPE-->>R: reject all, report both errors
    else lenient
        PIPE->>DUP: naturalKey match against existing
        DUP-->>PIPE: 40 duplicates skipped, 272 new
        PIPE->>STG: stage(272)
        STG->>CD: build lots + income events
        CD-->>STG: domain commands
        STG->>P: commit atomically (single transaction)
        P->>DB: INSERT encrypted → host disk
        DB-->>P: ok
        P-->>PIPE: committed
    end

    PIPE-->>R: ImportReport{created:272, duplicates:40, rejected:2, provenance}
    R-->>UI: 200
    UI-->>U: import summary with row-level rejections
    Note over DEC,DB: assertion in tests: password appears in<br/>NO log line, NO error payload, NO byte on disk
```

---

### 5.6 Snapshot comparison — live vs historical (US-3.5/3.6 · PRD FR-3)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as apps/web
    participant R as apps/api
    participant UC as CompareSnapshotsUC
    participant P as persistence
    participant CD as core-domain
    participant DE as DeltaEngine
    participant AS as AllocationShift
    participant XI as XirrCalculator

    U->>UI: "Compare Live with SNAP_31MAR2025"
    UI->>R: GET /api/snapshots/SNAP_31MAR2025/compare?target=live
    R->>UC: execute()

    UC->>P: loadSnapshot("SNAP_31MAR2025")
    P-->>UC: frozen snapshot · netWorth ₹250,000,000 · hash verified

    UC->>CD: liveValuation(now)
    CD-->>UC: netWorth ₹310,000,000 · 1,024 positions

    UC->>DE: delta(snapshotA, liveB)
    Note over DE: each side keeps ITS OWN FX rate —<br/>price movement and currency movement<br/>are attributed separately
    DE->>DE: match positions on assetId
    DE->>DE: classify NEW · LIQUIDATED · INCREASED · DECREASED · UNCHANGED
    DE-->>UC: +₹60,000,000 · +24.0% · movement buckets

    UC->>AS: allocationShift(A, B)
    AS-->>UC: per-asset-class % before/after (each side sums to 100.00% ±0.01%)

    UC->>XI: xirr(cashFlows between A and B)
    alt converges
        XI-->>UC: annualised %
    else no sign change
        XI--xUC: XirrNonConvergenceError
        Note over XI: never returns NaN or 0
    end

    UC-->>R: VarianceReport
    R-->>UI: 200 (< 2,000 ms for 1,000 positions — NFR-2)
    UI-->>U: variance table · top gainers · additions · liquidations · rebalancing
```

---

### 5.7 Container startup and host-disk binding (US-9.3/9.4/9.5 · PRD FR-8)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant DC as docker compose
    participant HOST as Host filesystem
    participant EP as entrypoint-api.sh
    participant API as vantagepoint-api
    participant MIG as Migrations
    participant WEB as vantagepoint-web
    participant B as Browser

    U->>DC: docker compose up
    DC->>HOST: resolve ${VANTAGEPOINT_DATA_DIR:-./data} to an absolute host path
    DC->>DC: create bind mount hostPath → /var/lib/vantagepoint
    DC->>DC: create internal bridge network (no external gateway by default)

    DC->>API: start as ${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID}, read-only rootfs, tmpfs /tmp
    API->>EP: exec entrypoint

    EP->>EP: assert /var/lib/vantagepoint is a BIND mount, not a docker volume
    EP->>EP: assert writable by current UID
    alt not writable
        EP--xAPI: exit 1 — names path, expected UID:GID, exact chown remediation
        Note over EP: fails BEFORE touching the database (US-9.5)
    else writable
        EP->>MIG: run forward-only migrations
        MIG->>HOST: create/upgrade vault.db on the host disk
        HOST-->>MIG: ok
        MIG-->>EP: schemaVersion = N
        EP->>API: exec node server.js (vault still LOCKED)
    end

    API-->>DC: /api/health/live → 200
    API-->>DC: /api/health/ready → 503 {reason: VAULT_LOCKED}
    Note over DC: liveness gates restart —<br/>readiness gates the web container

    DC->>WEB: start (depends_on: api service_healthy)
    WEB-->>DC: Caddy listening, only published port on the host

    U->>B: open http://localhost:5173
    B->>WEB: GET /
    WEB-->>B: SPA bundle (includes pii-masker)
    B->>WEB: POST /api/vault/unlock {passphrase}
    WEB->>API: proxied over internal network
    API->>API: Argon2id KDF → DEK, held in memory ONLY (ADR-014)
    API->>HOST: decrypt vault.db from the bind-mounted host disk
    HOST-->>API: portfolio
    API-->>B: unlocked

    Note over U,HOST: docker compose down → containers destroyed.<br/>vault.db remains on the host disk, owned by the host user,<br/>backup-able with ordinary tools. Next `up` finds it intact<br/>with identical snapshot contentHashes. (US-9.4)
```

---

## 6. Cross-Cutting Concerns

### 6.1 Trust and data-classification boundaries

```mermaid
graph LR
    subgraph T0["🔴 TRUSTED — never leaves the host"]
        RAW["Raw PII<br/>PAN · Aadhaar · names<br/>folios · account numbers"]
        KEY["Vault DEK<br/>memory only, zeroised on lock"]
        MAP["Pseudonym reversal map"]
        DBF["vault.db on host disk<br/>AES-256-CBC+HMAC"]
    end
    subgraph T1["🟡 SEMI-TRUSTED — inside the container network"]
        DOM["Domain objects<br/>decrypted in API memory"]
    end
    subgraph T2["🟢 EGRESS-ELIGIBLE"]
        MSK["Masked payloads<br/>guard-verified, twice"]
        EXP["Schedule FA / AL exports<br/>user-initiated, user-owned"]
    end
    subgraph T3["⚫ UNTRUSTED"]
        EXT["LLM · SBI · RBI · AMFI"]
    end

    RAW -->|"mask + verify (fail-closed)"| MSK
    DBF -->|"unlock with DEK"| DOM
    DOM -->|"user-initiated export"| EXP
    MSK -->|"EgressGateway, allow-list, audited"| EXT
    KEY -.->|"NEVER crosses"| T2
    MAP -.->|"NEVER crosses"| T2

    classDef t0 fill:#7f1d1d,stroke:#450a0a,color:#fff
    classDef t1 fill:#78350f,stroke:#451a03,color:#fff
    classDef t2 fill:#14532d,stroke:#052e16,color:#fff
    classDef t3 fill:#1c1917,stroke:#000,color:#fff
    class RAW,KEY,MAP,DBF t0
    class DOM t1
    class MSK,EXP t2
    class EXT t3
```

### 6.2 Error taxonomy

| Kind | Mechanism | Examples |
|---|---|---|
| **Expected domain failure** | `Result<T, DomainError>` — caller must handle | `InsufficientQuantityError`, `RateUnavailableError`, `TemplateHeaderMismatchError` |
| **Programmer error** | `throw` typed error, crash the request | `CurrencyMismatchError`, `SnapshotImmutableError` |
| **Security stop** | `throw`, abort, audit | `PiiLeakError`, `VaultUnlockError` |
| **Infrastructure** | `throw`, retry at the adapter only | `PdfDecryptionError`, bind-mount permission failure |

Absolute rules: no empty `catch`; **no error message or `cause` chain ever carries PII** (asserted by
`expectNoPii()` in the shared test kit); `RateUnavailableError` never degrades to a substituted `1.0`.

### 6.3 Determinism

Every non-deterministic input is a port: `Clock` (fixed in tests), `IdGenerator` (seeded), `Rng`.
Consequences — snapshot `contentHash` is reproducible; tax computations for a past FY yield identical
output forever; the entire test suite is hermetic and needs no network.

### 6.4 Performance strategy vs NFR-2

| Budget | Strategy | Guard |
|---|---|---|
| Valuation < 1.5 s @ 1,000 lots | Whole domain in one process; FX rates batch-loaded into a `Map` keyed `(currency, date)` before the valuation loop — never a lookup per lot | `tests/functional/perf/valuation-budget.bench.ts`, plus in-container run (US-9.7) |
| Snapshot delta < 2.0 s @ 1,000 positions | Position matching via hash join on `assetId`, not nested scan; totals precomputed at freeze time | `budgets.bench.ts` |
| Container overhead | API is a thin HTTP shell; no serialization of domain objects between components | `perf-in-container.spec.ts` |

Budgets are CI-enforced from M2 onward so a regression is attributed to the commit that caused it.

---

## 7. Deployment View

```mermaid
graph TB
    subgraph DEV["Development"]
        D1["pnpm dev — bare host, HMR<br/>vitest watch"]
        D2["compose.override.yaml<br/>source bind mounts + HMR in-container"]
    end
    subgraph CI["CI"]
        C1["lint · typecheck"]
        C2["unit + property (Vitest)"]
        C3["functional (temp SQLite, network trapped)"]
        C4["benchmarks vs NFR budgets"]
        C5["docker build both images"]
        C6["@container suite — compose up/down,<br/>bind-mount persistence, non-root, image hygiene"]
        C7["Playwright E2E vs the compose stack"]
        C1-->C2-->C3-->C4-->C5-->C6-->C7
    end
    subgraph PROD["User's machine"]
        P1["docker compose up"]
        P2["vantagepoint-web :5173"]
        P3["vantagepoint-api (internal only)"]
        P4[("${VANTAGEPOINT_DATA_DIR}/vault.db<br/>HOST NATIVE DISK")]
        P1-->P2-->P3-->P4
    end
    DEV-->CI-->PROD
    classDef x fill:#1f4e79,stroke:#0d2b45,color:#fff
    class D1,D2,C1,C2,C3,C4,C5,C6,C7,P1,P2,P3 x
```

**Runtime configuration** (all via `.env`, none baked into images — FR-8.3):

| Variable | Default | Purpose |
|---|---|---|
| `VANTAGEPOINT_DATA_DIR` | `./data` | **Host** path for the encrypted vault (ADR-012) |
| `VANTAGEPOINT_UID` / `VANTAGEPOINT_GID` | invoking user | Ownership of bind-mounted files (US-9.5) |
| `VANTAGEPOINT_WEB_PORT` | `5173` | Only published host port |
| `VANTAGEPOINT_EGRESS` | `deny` | `allow` requires `compose.egress.yaml` |

The vault passphrase is **not** in this table by design — it is supplied per session through the UI and
never touches the environment, an image layer, or disk (ADR-014).

---

## 8. Architecture Decision Index

Full text and reversibility assessment in [`implementation_plan_vantagepoint.md` §0](./implementation_plan_vantagepoint.md#0-critical-decisions--prd-conflict-resolutions-read-first).

| ADR | Decision | Realised in |
|---|---|---|
| 001 | TypeScript monorepo, pure domain core | §4 component view |
| 002 | All money is `Decimal`/`Money` | `shared-kernel` |
| 003 | **Dual FX rate** — resolves the PRD's FR-1 vs FR-2 conflict | §5.1 |
| 004 | HNI = income > ₹50L **or** net worth > ₹10 Cr | `tax-engine.HniClassifier` |
| 005 | Tax rules are FY-keyed data, never code literals | §5.3 |
| 006 | Snapshots immutable + content-addressed | §5.2 |
| 007 | PII masking fails closed | §5.4 |
| 008 | All EOD boundaries in Asia/Kolkata | §5.2 |
| 009 | Liabilities are first-class | `core-domain.Liability` |
| 010 | Zero egress by default, one gateway | §3, §6.1 |
| 011 | Two containers: `vantagepoint-web` + `vantagepoint-api` | §3 |
| 012 | DB on a **host bind mount**, not a Docker volume | §3, §5.7 |
| 013 | PII masking stays in the browser bundle | §5.4 |
| 014 | Passphrase in memory only, never on disk | §5.7 |
| 015 | Vault cipher is page-level AES-256-CBC+HMAC, **not** GCM (NFR-1 amended) | §3, §6.1 |
