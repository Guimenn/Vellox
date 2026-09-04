<div align="center">

<img src="./public/logo-signal-512.png" alt="Vellox" width="132" />

# VELLOX

### Your cloud isn't expensive. Your code is.

Local structural analysis for JavaScript, TypeScript, Python, SQL, and CI.
Find supported risks, inspect the evidence, and review the action.

[![npm](https://img.shields.io/npm/v/vellox?style=flat-square&label=npx%20vellox&labelColor=070908&color=c8ff53)](https://www.npmjs.com/package/vellox)
[![CI](https://github.com/Guimenn/Vellox/actions/workflows/vellox-ci.yml/badge.svg)](https://github.com/Guimenn/Vellox/actions/workflows/vellox-ci.yml)
[![tests](https://img.shields.io/badge/tests-170%20passing-070908?style=flat-square&labelColor=070908&color=c8ff53)](#proof-not-promises)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-070908?style=flat-square&labelColor=070908&color=c8ff53)](./package.json)
[![license](https://img.shields.io/badge/license-proprietary-070908?style=flat-square&labelColor=070908&color=c8ff53)](./LICENSE)

[Quick start](#quick-start) · [How it works](#one-scan-full-story) · [CLI](#cli-reference) · [Architecture](#architecture) · [Benchmarks](#proof-not-promises)

</div>

---

## Make invisible waste visible.

Vellox is a local performance and SQL scanner built for the gap between “something looks wrong” and “this is the supported rule, exact location, evidence, and reviewable next step.”

It parses JavaScript/TypeScript and Python structurally, inspects SQL and ORM schemas, and reports expensive patterns before they become production bottlenecks—without executing the project or mutating a database.

```text
SCAN  ──────>  EVIDENCE  ──────>  REVIEW  ──────>  GATE
read locally    explain claim      human decides    enforce policy
```

## Quick start

No global install. Run it from the root of the project you want to inspect:

```bash
npx vellox
```

Vellox scans the current directory and reports direct or cross-file N+1 database work, sequential loops, repeated linear searches and sorts, quadratic collection growth, unbounded ORM reads, database-specific async fan-out, event-loop blocking, risky SQL, exposed credentials, and missing database indexes. It also records exactly what was analyzed, skipped, or parsed through the conservative fallback. Every command consumes the same evidence artifact:

```text
.vellox/report.json
```

Generate SQL only from eligible findings:

```bash
npx vellox fix
```

Analyze one query directly:

```bash
npx vellox scan "SELECT * FROM orders WHERE status LIKE '%pending'"
```

Analyze an SQL file with one or more statements:

```bash
npx vellox optimize queries.sql
```

Inspect a PostgreSQL JSON execution plan:

```bash
npx vellox explain plan.json
```

> Requires Node.js 20 or newer. The currently published package version is always shown by the npm badge above.

## One scan. Full story.

| 01 — Scan | 02 — Evidence | 03 — Review | 04 — Gate |
| --- | --- | --- | --- |
| Read supported project files locally without executing code. | Attach a rule, severity, location, redacted evidence, and fingerprint. | Provide guidance or eligible SQL suggestions without mutating the project. | Apply explicit budgets and baselines in CI. |

### What Vellox sees

| Surface | Signals |
| --- | --- |
| **JavaScript & TypeScript** | Project-wide call graph across ESM, CommonJS, barrels, aliases, workspace packages, nearest/inherited `tsconfig` paths, classes, and constructor injection; direct/transitive N+1 loops, O(n²) growth, query-aware fan-out, and async hazards |
| **Python** | Project-wide call graph across relative/absolute imports, aliases, namespaces, imported classes, and typed constructor injection; direct/transitive query loops, quadratic growth, query-aware `asyncio.gather`, and blocking async work |
| **SQL & ORM** | Unbounded Prisma/Mongoose/Sequelize/SQLAlchemy/Django reads, plain and embedded SQL, unique-lookup-aware bounds, full-table writes, large join graphs, avoidable deduplication, dynamic SQL, missing FK indexes |
| **Infrastructure config** | Floating container images, effective final-stage users, complete Kubernetes CPU/memory policies and privileged workloads, Terraform public database/storage/ingress exposure |
| **Execution plans** | Actionable PostgreSQL JSON diagnostics for expensive sequential scans, disk spills, cardinality misestimation, nested-loop amplification, and low buffer hit ratios |
| **Security** | Supported API tokens, private keys, and credential-bearing database URLs with redacted output |

### Safe by design

- **Advisory by default.** The scanner does not connect to or mutate your production database.
- **Review before apply.** Generated DDL is written to a migration file for human approval.
- **Local by default.** The published CLI needs only Node.js 20+; no Docker, Kubernetes, daemon, database, or account is required.
- **Configuration evidence, not cloud telemetry.** Infrastructure rules inspect repository manifests; Vellox does not call cloud or cluster APIs or claim measured utilization.
- **No code execution.** Project files are read as text and the report stays on disk.
- **Redacted credentials.** Secret findings never echo the complete matched value.
- **Intentional escape hatch.** Use `// @vellox-ignore` for reviewed loops or batch routines.
- **Confidence is explicit.** Structural certainty and heuristic risk are separate; ambiguous complexity and ORM-volume findings are labeled with medium confidence.
- **Cross-file evidence is traceable.** Findings reached through an import include the resolved call path to the database in terminal, Markdown, JSON, and SARIF.
- **Coverage is explicit.** Reports list discovered, analyzed, skipped, structural, and fallback files. `vellox check` fails closed on incomplete analysis unless `--allow-incomplete` is chosen deliberately.
- **Bounds require evidence.** Syntax, single-assignment dataflow, and dominating guards can prove an iteration ceiling. Caps up to 100 reduce severity; larger proven caps remain visible with their real upper bound.

## CLI reference

| Command | What it does |
| --- | --- |
| `npx vellox` | Scans the current project and creates reviewable recommendations |
| `npx vellox <path>` | Scans a specific project directory |
| `npx vellox scan . --max-file-bytes N` | Overrides the per-file analysis ceiling and reports every skipped file |
| `npx vellox scan "<sql>"` | Checks a single SQL statement for structural anti-patterns |
| `npx vellox optimize <file.sql\|"SQL">` | Analyzes one query or every statement in a SQL file |
| `npx vellox scan . --format json` | Emits the complete machine-readable evidence report |
| `npx vellox scan . --format sarif` | Produces SARIF for GitHub code scanning |
| `npx vellox explain <file> --format json` | Diagnoses a PostgreSQL JSON `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan with measured metrics |
| `npx vellox rules [filter]` | Lists the complete rule catalog with default severity and confidence |
| `npx vellox ai "<sql>"` | Creates a structured optimization prompt for an AI coding assistant |
| `npx vellox fix` | Generates SQL only from fixes attached to the current report |
| `npx vellox ddl <file>` | Checks a SQL migration for risky schema patterns |
| `npx vellox discover [path]` | Detects frameworks, ORMs, and database dependencies |
| `npx vellox doctor` | Validates the local Node.js, CPU, and memory environment |
| `npx vellox init` | Creates `vellox.config.json` |
| `npx vellox hook` | Installs a local pre-commit Vellox gate |
| `npx vellox ci` | Generates a GitHub Actions workflow |
| `npx vellox check` | Applies critical/high/secret and complete-analysis budgets to the current scan |
| `npx vellox check --allow-incomplete` | Explicitly permits reported skips/fallbacks for that gate run |
| `npx vellox baseline` | Saves accepted fingerprints so CI can fail only on new findings |
| `npx vellox report` | Writes a Markdown report from `.vellox/report.json` |
| `npx vellox demo` | Runs the real scanner against a temporary sample project |
| `npx vellox top` | Summarizes the current report without pretending it is live telemetry |
| `npx vellox --help` | Shows commands and shortcuts |

### Project configuration

`vellox init` creates a local configuration. The scanner automatically honors root `.gitignore` and `.velloxignore` files; `ignore` adds project-specific patterns. Exact rules, categories such as `query/*`, or every rule through `*` can be disabled or assigned a different severity.

```json
{
  "reportPath": ".vellox/report.json",
  "baselinePath": ".vellox/baseline.json",
  "ignore": ["generated/", "legacy/**"],
  "rules": {
    "code/repeated-sort-in-loop": false,
    "query/unbounded-orm-read": "HIGH",
    "infra/*": { "enabled": false }
  },
  "analysis": {
    "maxFileBytes": 2000000
  },
  "budgets": {
    "maxCritical": 0,
    "maxHigh": 0,
    "maxTotal": null,
    "failOnSecrets": true,
    "failOnIncompleteAnalysis": true
  }
}
```

`vellox hook` appends an idempotent marked block to an existing shell hook. `vellox ci` updates only workflows it generated and chooses a new filename when `vellox.yml` already belongs to the project.

## Support matrix

| Layer | Supported integrations |
| --- | --- |
| **Core source analysis** | Parser-backed TypeScript, JavaScript, JSX, TSX, and Python; monorepo-aware project call graph; constructor injection; conservative fallback with explicit coverage |
| **Queries** | Plain `.sql` files, embedded SQL strings/templates, and direct CLI input |
| **Schemas** | Prisma, Drizzle, and SQL DDL |
| **Infrastructure** | Docker/Containerfile, Docker Compose, Kubernetes manifests, and Terraform |
| **Outputs** | Terminal, JSON, Markdown, SARIF, baselines, and CI exit codes |
| **Local runtime** | Node.js 20+; no container or background service required |

## Proof, not promises

The repository currently passes **170 automated tests** (167 TypeScript + 3 Python), including a positive/negative precision corpus, cross-file ESM/CommonJS/Python call graphs, nested monorepo configs, workspace packages, constructor injection, aliases, barrels, classes, import cycles, static-bound and guard dataflow, coverage failures, query-specific fan-out, execution-plan diagnostics, CLI safety contracts, stable baselines, schemas, and manifests.

Reproduce the checks on your machine:

```bash
corepack enable
pnpm install
pnpm test
```

> Hardware, runtime, workload, and database conditions matter. Treat any performance number without a reproducible run as marketing, not evidence.

## Architecture

```text
vellox/
├── packages/
│   ├── cli/                 # npx vellox scanner, project call graph, and workflow commands
│   ├── core/                # bounded telemetry primitives and normalization
│   ├── agent-node/          # Node.js request and query instrumentation
│   ├── agent-python/        # FastAPI, Starlette, and SQLAlchemy instrumentation
│   ├── analyzer/            # evidence-backed root-cause engine
│   ├── cost-engine/         # deterministic FinOps modeling
│   ├── db-*/                # PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Oracle
│   ├── explain-analyzer/    # execution-plan diagnostics
│   ├── schema-advisor/      # migration and DDL analysis
│   └── otel-bridge/         # OTLP trace ingestion
├── apps/collector/          # internal telemetry research module; not used by the published CLI
├── examples/bad-api/        # intentionally wasteful reference workload
├── benchmarks/              # repeatable agent-overhead benchmark
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
