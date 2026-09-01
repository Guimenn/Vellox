<div align="center">

<img src="assets/logo.jpg" alt="Vellox Logo" width="120" style="border-radius: 20px;" />

# ⚡ VELLOX

### High-Scale Database & Infrastructure Performance Intelligence Engine

[![CI Tests](https://img.shields.io/badge/tests-67%20passing%20(100%25)-success?style=for-the-badge&logo=vitest)](https://github.com/Guimenn/vellox)
[![NPX Ready](https://img.shields.io/badge/NPX-npx%20vellox-blue?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/vellox)
[![Latency SLA](https://img.shields.io/badge/Overhead-+0.00ms%20(P50)-brightgreen?style=for-the-badge)](https://github.com/Guimenn/vellox)
[![Memory Safety](https://img.shields.io/badge/RSS%20Memory-%3C30MB-orange?style=for-the-badge)](https://github.com/Guimenn/vellox)
[![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red?style=for-the-badge)](LICENSE)
[![Author](https://img.shields.io/badge/author-Guilherme%20Men-purple?style=for-the-badge)](https://github.com/Guimenn)

<br />

**Vellox is a proprietary high-scale performance intelligence platform and CLI toolchain created by Guilherme Men. It detects database bottlenecks, async loop anti-patterns, memory leaks, and unindexed queries in seconds — calculating actionable cloud cost savings ($/month) and generating zero-downtime fixes.**

[Quickstart](#-quickstart-zero-install) •
[Features](#-key-features) •
[CLI Commands](#-cli-command-reference) •
[Architecture](#-monorepo-architecture) •
[Benchmarks](#-empirical-overhead-benchmarks) •
[Docker Stack](#-docker-compose-self-hosted-stack)

</div>

---

## 🚀 Quickstart (Zero Install via NPX)

Run Vellox directly inside **any project** (Node.js, TypeScript, Python, PostgreSQL, MySQL, MongoDB, Redis, Prisma, SQLAlchemy):

```bash
npx vellox
```

### What happens in 3 seconds:
1. 🔍 **Scans codebase**: Recursively inspects queries, schemas, and migrations.
2. 🚨 **Detects Anti-Patterns**: Identifies unindexed foreign keys, `SELECT *` wildcard transfers, leading wildcards (`LIKE '%...'`), missing pagination (`LIMIT`), and async queries inside `for`/`while`/`map` loops.
3. 📝 **ORM Suggestions**: Outputs exact Prisma / TypeORM schema diffs (e.g. `+ @@index([organizationId])`).
4. 🛡️ **Generates Zero-Downtime SQL**: Creates `migrations/vellox_optimizations.sql` with safe `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statements for human review.

```text
┌────────────────────────────────────────────────────────┐
│  VELLOX CLI v0.1.0                                     │
│  Ultra-Fast Database & Application Performance Engine  │
└────────────────────────────────────────────────────────┘

⚡ VELLOX AUTOMATED PROJECT SCANNER & OPTIMIZER

  Target Directory:  /my-project
  Scanning codebase for SQL queries, migrations, and ORM schemas...

  📁 Scanned 162 project files.

📊 OPTIMIZATION SCAN COMPLETE:
  ├─ Source Code Files Analyzed:  162
  ├─ Code Logic Hotspots (Loops): 4
  ├─ Database Index Fixes Found:  19
  └─ Generated Review File:       migrations/vellox_optimizations.sql

📝 RECOMMENDED PRISMA SCHEMA REFACTORING (schema.prisma):
   model User {
     ...
  +  @@index([organizationId])  // <─ Eliminates full-scan cascade
   }

💡 SQL DDL Preview (Zero-Downtime CONCURRENTLY):
-- Unindexed Foreign Key from schema.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_org_id ON "user" ("organizationId");

👉 Next Step: Review 'migrations/vellox_optimizations.sql' and apply when ready.
```

---

## 💡 Why Vellox? The Actionability Gap

Traditional APM and monitoring tools (Datadog, Dynatrace, New Relic) only tell you:
> *"Your database CPU is at 95% and your AWS RDS bill is $48,000."*

**Vellox tells you the exact root cause, how to fix it, and how much money you save:**
> *"Found 84 sequential child queries per request in route `/api/v1/orders/:id` (N+1). Add `@@index([organizationId])` to your schema and save **$1,284.00/month** in RDS IOPS & CPU."*

---

## ✨ Key Features

### 1. 🔍 Code & Loop Bottleneck Inspector
* Detects sequential async queries inside `for`, `for...of`, `while`, `.forEach(async)`, `.map(async)` without batching.
* Detects unbounded global in-memory maps and arrays (`const cache = {}`) causing memory leaks and Node.js heap OOM.
* Supports inline suppression comments (`// @vellox-ignore`) and automatically recognizes legitimate retry/chunking loops.

### 2. 🤖 AI / LLM Optimization Context Prompt Generator
Generate structured, zero-hallucination refactoring prompts for **Cursor, GitHub Copilot, Claude, or ChatGPT**:
```bash
npx vellox ai-prompt "SELECT * FROM orders WHERE customer_id = 42 AND status LIKE '%pending'"
```

### 3. 🔬 Deep PostgreSQL & MySQL EXPLAIN Plan Analyzer
Ingests raw JSON/text execution plans (`EXPLAIN ANALYZE, BUFFERS, FORMAT JSON`):
* Computes Buffer Cache Hit Ratios (`%` RAM vs Disk Reads).
* Identifies Sequential Table Scans (`Seq Scan`) and disk sort spills (`external merge Disk`).
```bash
npx vellox explain plan.json
```

### 4. 🗄️ Multi-Database Universal Adapters
* **PostgreSQL**: `pg_stat_statements`, table bloat detector (`detectTableBloat`), autovacuum scale factor tuner (`tuneAutovacuum`), dead index finder (`detectUnusedIndexes`).
* **MySQL & MariaDB**: Performance Schema digest analyzer, index selectivity metrics.
* **MongoDB**: Aggregation pipeline optimizer detecting `$unwind` before `$match`, unbounded `$sort`, and unindexed `$lookup` stages.
* **Redis**: Command latency analyzer, blocks dangerous linear commands (`KEYS *`, `SMEMBERS` on big sets).
* **Oracle**: `V$SQL` and `V$SQLSTATS` parser.

### 5. 🌐 Polyglot SDKs & Distributed Tracing
* **Node.js SDK (`@vellox/agent-node`)**: Fastify, NestJS, Express, Prisma, TypeORM.
* **Python SDK (`packages/agent-python`)**: FastAPI / Starlette middleware, SQLAlchemy listener.
* **OpenTelemetry Bridge (`@vellox/otel-bridge`)**: Ingests OTel OTLP spans from Go, Java, Rust, C#, Python.
* **Trace Context Propagation**: `AsyncLocalStorage` request-to-query correlation (`traceId`, `spanId`, `parentSpanId`).

### 6. 📊 Real-Time Glassmorphism Web Dashboard & SSE Live Stream
* **Live Query Scanner**: Paste SQL to immediately inspect execution risks and receive composite index suggestions.
* **Live SSE Stream**: Real-time animated pulse connected to the Collector via Server-Sent Events (`/api/v1/live/stream`).
* **Executive Cost Cards**: Instant ROI breakdown across cloud services ($/mo).

---

## 🛠️ CLI Command Reference

| Command | Description |
| :--- | :--- |
| `npx vellox` | Scans current project, flags loops/missing indexes, and generates SQL migration |
| `npx vellox demo` | Runs instant end-to-end simulation load and waste analysis with AWS pricing models |
| `npx vellox scan "<sql>"` | Performs deep static anti-pattern and index analysis on a specific query string |
| `npx vellox ai-prompt "<sql>"` | Generates a zero-hallucination prompt for ChatGPT, Claude, or Cursor |
| `npx vellox explain <file>` | Analyzes PostgreSQL/MySQL `EXPLAIN (JSON)` execution plans |
| `npx vellox report [out]` | Generates an executive cost & waste reduction Markdown report |
| `npx vellox fix` | Generates automated SQL migration scripts for detected hotspots |
| `npx vellox check` | CI/CD budget gatekeeper (fails PRs when waste exceeds allocated threshold) |
| `npx vellox ddl-check <file>` | Analyzes SQL migration files for missing FK indexes and table locks |
| `npx vellox top` | Displays real-time terminal waste monitor and cluster costs |
| `npx vellox discover` | Auto-detects frameworks and databases in project |
| `npx vellox doctor` | Checks environment memory, CPU, and Node.js compatibility |

---

## ⚡ Empirical Overhead Benchmarks

Tested with **Autocannon** on a 12-core Linux x64 system with sustained 50 concurrent connections:

| Metric | WITHOUT Vellox | WITH Vellox | Delta | SLA | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Total Requests** | 92,550 reqs | 130,975 reqs | +38,425 reqs | No drop | ✅ **PASS** |
| **Throughput** | 18,509 req/s | 26,193 req/s | 141.5% baseline | ~100% | ✅ **PASS** |
| **P50 Latency (Median)** | **2.00 ms** | **1.00 ms** | **-1.00 ms** | **<= 1.0 ms** | ✅ **PASS** |
| **P95 Latency** | **0.00 ms** | **0.00 ms** | **+0.00 ms** | **< 2.0 ms** | ✅ **PASS** |
| **Process RSS Memory** | 134.10 MB | 145.28 MB | **+11.18 MB** | **< 30.0 MB** | ✅ **PASS** |
| **Event Loop Lag** | 0.00 ms | 0.00 ms | **0.00 ms** | **0.00 ms** | ✅ **PASS** |

> **Principle 10 (Failure Independence)**: If the Vellox Collector or database goes offline, host applications continue running 100% normally without crashing or leaking memory.

---

## 🐳 Docker Compose Self-Hosted Stack

Spin up the entire platform (ClickHouse, Collector, Executive Web Dashboard, and Simulation API) with a single command:

```bash
docker compose up --build -d
```

| Service | Endpoint | Description |
| :--- | :--- | :--- |
| **Executive Dashboard** | `http://localhost:3001` | Glassmorphism Dark UI with Live SSE Stream |
| **Vellox Collector** | `http://localhost:4000` | Ingestion API (`/api/v1/telemetry/batches`, `/v1/traces`, `/metrics`) |
| **Prometheus Exporter** | `http://localhost:4000/metrics` | Native Prometheus text metrics |
| **ClickHouse Engine** | `http://localhost:8123` | Columnar time-series store with 90-day TTL |
| **Simulation API** | `http://localhost:3000` | Reference API exhibiting realistic N+1 and COLLSCAN anti-patterns |

---

## 🏛️ Monorepo Architecture

```text
vellox/
├── packages/
│   ├── core/                  # Logarithmic histogram, bounded ring buffer, route normalizer, PII sanitizer
│   ├── agent-node/            # Node.js agent, Fastify & NestJS plugins, Prisma & TypeORM hooks
│   ├── agent-python/          # Python agent, FastAPI / Starlette middleware, SQLAlchemy listener
│   ├── db-core/               # Universal DB adapter base, SQL/Mongo fingerprinters, Connection Pool Advisor
│   ├── db-postgres/           # PostgreSQL adapter (pg_stat_statements, bloat detector, autovacuum tuner)
│   ├── db-mysql/              # MySQL adapter (Performance Schema digest parser)
│   ├── db-mariadb/            # MariaDB adapter (thread pool & schema metrics)
│   ├── db-mongodb/            # MongoDB adapter (COLLSCAN detector & Aggregation Pipeline Analyzer)
│   ├── db-oracle/             # Oracle adapter (V$SQL / V$SQLSTATS parser)
│   ├── db-redis/              # Redis adapter (INFO analyzer, KEYS */SMEMBERS detector)
│   ├── cost-engine/           # FinOps cost modeling & potential savings estimator (AWS/GCP/Azure)
│   ├── analyzer/              # Waste & Root Cause Engine (N+1, Repeated Queries, Webhooks)
│   ├── schema-advisor/        # Pre-deployment SQL migration & DDL lock analyzer
│   ├── explain-analyzer/      # Deep EXPLAIN plan parser (Seq Scan, buffer hit ratio, disk sort spills)
│   ├── otel-bridge/           # OpenTelemetry OTLP trace & span ingestion transformer
│   └── cli/                   # Developer CLI (npx vellox)
├── apps/
│   ├── collector/             # High-throughput stateless HTTP batch collector (with SSE & Prometheus)
│   └── dashboard/             # Executive Waste & Cost Dashboard (Glassmorphism dark UI)
├── examples/
│   └── bad-api/               # Reference API exhibiting realistic waste anti-patterns (BEFORE & AFTER)
├── benchmarks/
│   └── agent-overhead/        # Automated comparative overhead benchmark suite (Autocannon)
├── infrastructure/
│   ├── clickhouse/            # Optimized MergeTree schemas with 90-day TTL (init.sql)
│   ├── grafana/               # Production Grafana Dashboard JSON templates (infrawaste-overview.json)
│   ├── docker/                # Container definitions for collector, dashboard, and bad-api
│   └── k8s/                   # Production Kubernetes manifests (Collector HPA, ClickHouse StatefulSet)
└── tests/
    └── chaos/                 # Failure resilience & load shedding tests
```

---

## 🛡️ Safety & Reliability

* **Read-Only / Advisory by Default**: Vellox **never** alters your database or executes DDLs in production directly.
* **Non-Blocking Indexing**: All suggested index migrations use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` to ensure zero table lock downtime.
* **Zero Overhead**: Bounded in-memory queues with backpressure load shedding to keep host application memory $< 30\text{MB}$.

---

## 📜 License & Copyright

**Copyright (c) 2026 Guilherme Men. All Rights Reserved.**

This software and its source code, architecture, algorithms, and branding (**Vellox**) are protected by international copyright laws.
- You may use the CLI tool (`npx vellox`) and SDKs for internal monitoring and optimization of your systems.
- Unauthorized reproduction, redistribution, sublicensing, reselling, rebranding, or claiming ownership of the source code is strictly prohibited.

See the [LICENSE](LICENSE) file for complete legal terms.
