<div align="center">

<img src="./assets/logo-signal.png" alt="Vellox" width="132" />

# VELLOX

### Your cloud isn't expensive. Your code is.

Performance intelligence for code, databases, and cloud infrastructure.
Find the root cause, generate a safe fix, and prove the impact.

[![npm](https://img.shields.io/npm/v/vellox?style=flat-square&label=npx%20vellox&labelColor=070908&color=c8ff53)](https://www.npmjs.com/package/vellox)
[![CI](https://github.com/Guimenn/Vellox/actions/workflows/vellox-ci.yml/badge.svg)](https://github.com/Guimenn/Vellox/actions/workflows/vellox-ci.yml)
[![tests](https://img.shields.io/badge/tests-64%20%2F%2064-070908?style=flat-square&labelColor=070908&color=c8ff53)](#proof-not-promises)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-070908?style=flat-square&labelColor=070908&color=c8ff53)](./package.json)
[![license](https://img.shields.io/badge/license-proprietary-070908?style=flat-square&labelColor=070908&color=c8ff53)](./LICENSE)

[Quick start](#quick-start) · [How it works](#one-scan-full-story) · [CLI](#cli-reference) · [Architecture](#architecture) · [Benchmarks](#proof-not-promises)

</div>

---

## Make invisible waste visible.

Vellox is a performance and infrastructure intelligence engine built for the gap between “something is slow” and “this is the exact line, query, index, and monthly impact.”

It scans application code, ORM schemas, SQL, migrations, and execution plans for expensive patterns—then turns the evidence into fixes you can review instead of mutating production behind your back.

```text
TRACE  ──────>  DIAGNOSE  ──────>  REPAIR  ──────>  PROVE
follow flow     expose cause       review fix       measure impact
```

## Quick start

No global install. Run it from the root of the project you want to inspect:

```bash
npx vellox
```

Vellox scans the current directory and reports code hotspots, risky query patterns, exposed credentials, and missing database indexes. When it finds safe SQL opportunities, it writes a review file instead of executing the migration.

```text
migrations/vellox_optimizations.sql
```

Analyze one query directly:

```bash
npx vellox scan "SELECT * FROM orders WHERE status LIKE '%pending'"
```

Inspect a PostgreSQL JSON execution plan:

```bash
npx vellox explain plan.json
```

> Requires Node.js 20 or newer. The currently published package version is always shown by the npm badge above.

## One scan. Full story.

| 01 — Trace | 02 — Diagnose | 03 — Repair | 04 — Prove |
| --- | --- | --- | --- |
| Follow request, route, query, and dependency signals. | Connect cost and latency to a concrete source-level cause. | Generate advisory code, schema, and SQL changes for human review. | Compare overhead, savings, and failure behavior with reproducible tests. |

### What Vellox sees

| Surface | Signals |
| --- | --- |
| **Application code** | Sequential async loops, N+1 risks, unbounded in-memory stores, hardcoded credentials |
| **SQL & ORM** | `SELECT *`, missing pagination, leading wildcards, deep offsets, missing FK indexes, Prisma and Drizzle schema gaps |
| **Execution plans** | Sequential scans, cache-hit pressure, disk reads, sort spills, cardinality problems |
| **Database telemetry** | PostgreSQL, MySQL, MariaDB, MongoDB, Redis, and Oracle adapters |
| **Distributed systems** | Node.js and Python agents, request/query correlation, OpenTelemetry span ingestion |
| **FinOps** | Deterministic waste findings and estimated infrastructure savings |

### Safe by design

- **Advisory by default.** The scanner does not connect to or mutate your production database.
- **Review before apply.** Generated DDL is written to a migration file for human approval.
- **Bounded telemetry.** Queues, route cardinality, and in-memory buffers have explicit guardrails.
- **Failure independence.** A collector outage must not take down the monitored application.
- **Intentional escape hatch.** Use `// @vellox-ignore` for reviewed loops or batch routines.

## CLI reference

| Command | What it does |
| --- | --- |
| `npx vellox` | Scans the current project and creates reviewable recommendations |
| `npx vellox <path>` | Scans a specific project directory |
| `npx vellox scan "<sql>"` | Checks a single SQL statement for structural anti-patterns |
| `npx vellox explain <file>` | Diagnoses a PostgreSQL JSON `EXPLAIN` plan |
| `npx vellox ai "<sql>"` | Creates a structured optimization prompt for an AI coding assistant |
| `npx vellox fix` | Generates a starter SQL migration for review |
| `npx vellox ddl <file>` | Checks a SQL migration for risky schema patterns |
| `npx vellox discover [path]` | Detects frameworks, ORMs, and database dependencies |
| `npx vellox doctor` | Validates the local Node.js, CPU, and memory environment |
| `npx vellox init` | Creates `vellox.config.json` |
| `npx vellox hook` | Installs a local pre-commit Vellox gate |
| `npx vellox ci` | Generates a GitHub Actions workflow |
| `npx vellox check` | Runs the current CI performance-budget gate |
| `npx vellox report [out]` | Writes the simulated executive cost report in Markdown |
| `npx vellox demo` | Runs a clearly labeled synthetic waste-analysis demo |
| `npx vellox top` | Prints the terminal cost and hotspot overview |
| `npx vellox --help` | Shows commands and shortcuts |

## Support matrix

| Layer | Supported integrations |
| --- | --- |
| **Node.js** | Express, Fastify, NestJS, Prisma, TypeORM |
| **Python** | FastAPI, Starlette, SQLAlchemy |
| **Databases** | PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Oracle |
| **Telemetry** | Native trace context plus OpenTelemetry OTLP spans |
| **Infrastructure** | ClickHouse storage, Prometheus metrics, Grafana dashboard, Kubernetes manifests |

## Proof, not promises

The repository currently passes **64 of 64 automated tests** across its packages, adapters, collector, examples, and resilience checks.

The reference overhead benchmark runs on a 12-core Linux x64 environment with 50 concurrent connections:

| Metric | Without Vellox | With Vellox | Observed delta | Guardrail |
| --- | ---: | ---: | ---: | ---: |
| Requests | 92,550 | 130,975 | +38,425 | no throughput drop |
| P50 latency | 2.00 ms | 1.00 ms | -1.00 ms | ≤ 1.0 ms |
| P95 latency | 0.00 ms | 0.00 ms | +0.00 ms | < 2.0 ms |
| Process RSS | 134.10 MB | 145.28 MB | +11.18 MB | < 30 MB |
| Event-loop lag | 0.00 ms | 0.00 ms | 0.00 ms | 0.00 ms |

Reproduce the checks on your machine:

```bash
corepack enable
pnpm install
pnpm test
pnpm benchmark
```

> Benchmark numbers describe the checked-in reference run, not a universal promise. Hardware, workload, runtime, and database conditions matter.

## Architecture

```text
vellox/
├── packages/
│   ├── cli/                 # npx vellox scanner and workflow commands
│   ├── core/                # bounded telemetry primitives and normalization
│   ├── agent-node/          # Node.js request and query instrumentation
│   ├── agent-python/        # FastAPI, Starlette, and SQLAlchemy instrumentation
│   ├── analyzer/            # evidence-backed root-cause engine
│   ├── cost-engine/         # deterministic FinOps modeling
│   ├── db-*/                # PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Oracle
│   ├── explain-analyzer/    # execution-plan diagnostics
│   ├── schema-advisor/      # migration and DDL analysis
│   └── otel-bridge/         # OTLP trace ingestion
├── apps/collector/          # stateless telemetry collector and SSE stream
├── examples/bad-api/        # intentionally wasteful reference workload
├── benchmarks/              # repeatable agent-overhead benchmark
├── infrastructure/          # ClickHouse, Grafana, Docker, and Kubernetes
├── tests/chaos/             # failure isolation and resilience tests
├── public/                  # production brand assets
└── index.html               # GitHub Pages landing page
```

## Development

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

Run the CLI from source after building:

```bash
pnpm cli --help
```

Preview the landing page locally:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## License

Copyright © 2026 Guilherme Men. All rights reserved.

Vellox is source-available under a proprietary limited-use license. You may run the compiled CLI and SDKs for your own systems and inspect the source for evaluation and security review. Redistribution, resale, white-labeling, and derivative competing products require explicit permission. Read the complete [license terms](./LICENSE) before use.

---

<div align="center">

**Built to make invisible waste visible.**

[GitHub](https://github.com/Guimenn/Vellox) · [npm](https://www.npmjs.com/package/vellox) · [Creator](https://github.com/Guimenn)

</div>
