<div align="center">

<img src="./public/logo-signal-512.png" alt="Vellox" width="132" />

# VELLOX

### Your cloud isn't expensive. Your code is.

Local structural analysis for JavaScript, TypeScript, Python, SQL, and CI.
Find supported risks, inspect the evidence, and review the action.

[![npm](https://img.shields.io/npm/v/vellox?style=flat-square&label=npx%20vellox&labelColor=070908&color=c8ff53)](https://www.npmjs.com/package/vellox)
[![CI](https://github.com/Guimenn/Vellox/actions/workflows/vellox-ci.yml/badge.svg)](https://github.com/Guimenn/Vellox/actions/workflows/vellox-ci.yml)
[![tests](https://img.shields.io/badge/tests-196%20passing-070908?style=flat-square&labelColor=070908&color=c8ff53)](#proof-not-promises)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-070908?style=flat-square&labelColor=070908&color=c8ff53)](./package.json)
[![license](https://img.shields.io/badge/license-proprietary-070908?style=flat-square&labelColor=070908&color=c8ff53)](./LICENSE)

[Quick start](#quick-start) · [How it works](#one-scan-full-story) · [CLI](#cli-reference) · [Architecture](#architecture) · [Evidence](#proof-not-promises)

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

No global install, account, container, or setup wizard. Do not add Vellox to the project's dependencies for a one-time scan: `npx` uses npm's execution cache without rewriting your `package.json` or lockfile. From the project root, the complete team path is three commands.

### 1. Scan locally

```bash
npx --yes vellox
```

This reports direct or cross-file N+1 database work, sequential loops, repeated linear searches and sorts, quadratic collection growth, unbounded ORM reads, database-specific async fan-out, event-loop blocking, risky SQL, exposed credentials, and missing database indexes. It also records exactly what was analyzed, skipped, parsed into its SQL syntax tree, or handled by the conservative fallback:

```text
.vellox/report.json
```

For a one-time diagnosis, stop here. `npx vellox report` optionally turns the evidence into readable Markdown.

### 2. Adopt without inheriting noise

```bash
npx --yes vellox baseline
```

Review the current findings first. The baseline records accepted fingerprints so the gate can focus on new risks instead of blocking a mature codebase on day one.

### 3. Protect pull requests

```bash
npx --yes vellox ci
```

This creates a GitHub Actions workflow with SARIF upload and the Vellox quality gate. Existing workflows are preserved.

Need a focused workflow instead? These commands remain available:

```bash
npx vellox fix
npx vellox scan "SELECT * FROM orders WHERE status LIKE '%pending'"
npx vellox optimize queries.sql
npx vellox explain plan.json
npx vellox prove plans/before plans/after
```

`fix` only generates reviewable SQL suggestions backed by eligible findings. It never rewrites application code or executes SQL.

### Prove a measured change

Export PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans before and after an optimization, then compare the recorded evidence locally:

```bash
npx --yes vellox prove plans/before plans/after
npx --yes vellox prove plans/before plans/after --format markdown --output vellox-proof.md
```

Each path can be one JSON file or a directory of JSON samples. Vellox uses medians, labels single-run evidence, reports execution time, buffer reads/hits, node executions, disk spills, and resolved/introduced plan findings, and can return a failing CI exit code with `--fail-on-regression`.

> `vellox prove` only reads exported JSON. PostgreSQL `EXPLAIN ANALYZE` executes the measured statement, so capture plans in a safe representative environment and use at least three comparable runs per side. Vellox cannot verify that the query, data, cache state, hardware, and concurrent load were identical.

> Requires Node.js 20 or newer. The currently published package version is always shown by the npm badge above.

## One scan. Full story.

| 01 — Scan | 02 — Evidence | 03 — Review | 04 — Gate |
| --- | --- | --- | --- |
| Read supported project files locally without executing code. | Attach a rule, severity, location, redacted evidence, and fingerprint. | Provide guidance or eligible SQL suggestions without mutating the project. | Apply explicit budgets and baselines in CI. |

### What Vellox sees

| Surface | Signals |
| --- | --- |
| **JavaScript & TypeScript** | Project-wide call graph across ESM, CommonJS, barrels, aliases, wrapper functions, imported callbacks, workspace packages, nearest/inherited `tsconfig` paths, classes, and constructor injection; direct/transitive N+1 loops, exact static bounds, query-aware fan-out, request-to-raw-SQL flow, O(n²) growth, and async hazards |
| **Python** | Project-wide call graph across relative/absolute and multiline imports, aliases, wrappers, namespaces, imported classes, and typed constructor injection; direct/transitive query loops, exact `range`/slice bounds, request-to-raw-SQL flow, quadratic growth, query-aware `asyncio.gather`, and blocking async work |
| **SQL & ORM** | Auto-detected PostgreSQL/MySQL/SQLite syntax analysis with explicit fallback; Cartesian joins, correlated subqueries, unstable/deep pagination, large `IN`/`OR` predicates, non-sargable filters, unbounded Prisma/Mongoose/Sequelize/SQLAlchemy/Django reads, full-table writes, dynamic SQL, and missing FK indexes |
| **Infrastructure config** | Floating container images, effective final-stage users, complete Kubernetes CPU/memory policies and privileged workloads, Terraform public database/storage/ingress exposure |
| **Execution plans** | PostgreSQL JSON diagnostics plus measured before/after comparison across execution time, buffers, node executions, disk spills, and resolved or introduced plan findings |
| **Security** | Supported API tokens, private keys, credential-bearing database URLs with redacted output, and intraprocedural request-data flow into raw SQL sinks without treating normal ORM predicates as injection |

### Safe by design

- **Advisory by default.** The scanner does not connect to or mutate your production database.
- **Review before apply.** Generated DDL is written to a migration file for human approval.
- **Local by default.** The published CLI needs only Node.js 20+; no Docker, Kubernetes, daemon, database, or account is required.
- **Configuration evidence, not cloud telemetry.** Infrastructure rules inspect repository manifests; Vellox does not call cloud or cluster APIs or claim measured utilization.
- **No code execution.** Project files are read as text and the report stays on disk.
- **Measured comparison stays honest.** `prove` compares exported plan evidence by median and reports measurement limits; it does not connect to PostgreSQL or claim causation from one noisy run.
- **Redacted credentials.** Secret findings never echo the complete matched value.
- **Intentional escape hatch.** Use `// @vellox-ignore` for reviewed loops or batch routines.
- **Confidence is explicit.** Structural certainty and heuristic risk are separate; ambiguous complexity and ORM-volume findings are labeled with medium confidence.
- **Cross-file evidence is traceable.** Findings reached through an import include the resolved call path to the database in terminal, Markdown, JSON, and SARIF.
- **Coverage is explicit.** Reports list discovered, analyzed, skipped, structural, fallback, and SQL syntax-tree statement counts. Parse failures include their parser message. `vellox check` fails closed on incomplete analysis unless `--allow-incomplete` is chosen deliberately.
- **Bounds require evidence.** Syntax, single-assignment dataflow, and dominating guards can prove an iteration ceiling. Caps up to 100 reduce severity; larger proven caps remain visible with their real upper bound.
- **Incremental scans remain local.** `--changed[=ref]` reports only Git-changed source files, while a clean-commit cache keyed by revision, version, configuration, and ignore inputs avoids repeat work. `--no-cache` always forces analysis.

## CLI reference

| Command | What it does |
| --- | --- |
| `npx vellox` | Scans the current project and creates reviewable recommendations |
| `npx vellox <path>` | Scans a specific project directory |
| `npx vellox scan . --max-file-bytes N` | Overrides the per-file analysis ceiling and reports every skipped file |
| `npx vellox scan . --changed[=ref]` | Scopes the report to committed, staged, working-tree, and untracked changes since a Git ref (`HEAD` by default) |
| `npx vellox scan . --no-cache` | Forces a complete re-analysis instead of reading or writing the clean-commit cache |
| `npx vellox scan "<sql>" --dialect auto\|postgresql\|mysql\|sqlite` | Checks one SQL statement with an explicit or auto-detected dialect |
| `npx vellox scan . --large-in-threshold N --or-threshold N` | Tunes the large `IN` list and excessive `OR` predicate thresholds |
| `npx vellox optimize <file.sql\|"SQL">` | Analyzes one query or every statement in a SQL file |
| `npx vellox scan . --format json` | Emits the complete machine-readable evidence report |
| `npx vellox scan . --format sarif` | Produces SARIF for GitHub code scanning |
| `npx vellox explain <file> --format json` | Diagnoses a PostgreSQL JSON `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan with measured metrics |
| `npx vellox prove <before> <after>` | Compares measured PostgreSQL plan files or sample directories without connecting to the database |
| `npx vellox prove <before> <after> --fail-on-regression` | Returns exit code 1 when median execution time regresses beyond the configured threshold |
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
    "maxFileBytes": 2000000,
    "sqlDialect": "auto",
    "largeInListThreshold": 100,
    "excessiveOrThreshold": 5
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
| **Queries** | PostgreSQL, MySQL, SQLite, and generic SQL syntax analysis for plain `.sql` files and direct CLI input; conservative embedded-query inspection |
| **Schemas** | Prisma, Drizzle, and SQL DDL |
| **Infrastructure** | Docker/Containerfile, Docker Compose, Kubernetes manifests, and Terraform |
| **Outputs** | Terminal, JSON, Markdown, SARIF, baselines, and CI exit codes |
| **CLI runtime** | Node.js 20+; no container or background service required |

## Proof, not promises

The repository currently passes **196 automated tests** (193 TypeScript + 3 Python), including a versioned fully labelled SQL/code precision corpus, SQL syntax-tree and fallback cases, cross-file ESM/CommonJS/Python call graphs, multiline imports, imported callbacks, wrapper aliases, request-to-query dataflow, nested monorepo configs, static-bound and guard dataflow, changed-file/cache behavior, coverage failures, query-specific fan-out, execution-plan diagnostics, measured before/after comparison, CLI safety contracts, stable baselines, schemas, and manifests. The focused 22-case labelled corpus currently measures `1.00` aggregate precision and `1.00` recall for its selected rules; it is a regression gate, not a claim of universal detection.

The npm package `vellox` is the static CLI described above. Runtime agents, the collector, and telemetry adapters in this monorepo remain experimental research modules outside the supported CLI path; no production-overhead claim is made for them.

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
│   ├── agent-node/          # experimental Node.js runtime instrumentation
│   ├── agent-python/        # experimental Python runtime instrumentation
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

### Release

The package version is synchronized across the workspace with `pnpm version:set <version>`. After the full test suite passes on `main`, pushing an annotated tag with the exact `v<version>` value starts the protected publish workflow. The workflow validates the tag, rebuilds and tests the repository, publishes the CLI to npm with provenance, verifies the registry artifact, and only then creates the GitHub Release.

## License

Copyright © 2026 Guilherme Men. All rights reserved.

Vellox is source-available under a proprietary limited-use license. You may run the compiled CLI and SDKs for your own systems and inspect the source for evaluation and security review. Redistribution, resale, white-labeling, and derivative competing products require explicit permission. Read the complete [license terms](./LICENSE) before use.

---

<div align="center">

**Built to make invisible waste visible.**

[GitHub](https://github.com/Guimenn/Vellox) · [npm](https://www.npmjs.com/package/vellox) · [Creator](https://github.com/Guimenn)

</div>
