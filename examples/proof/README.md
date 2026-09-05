# Vellox proof fixture

These deterministic PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`-shaped fixtures demonstrate the `prove` workflow. They are test data, not a production benchmark or a performance claim.

After building the CLI, run:

```bash
node packages/cli/dist/bin.js prove examples/proof/before examples/proof/after
```

Vellox compares the median of the three before and three after samples, exposes the raw runs in JSON output, and keeps the measurement limitations in every report.
