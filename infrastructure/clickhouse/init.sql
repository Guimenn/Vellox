-- InfraWaste Analytical Storage Schema (ClickHouse)
-- High-throughput, columnar storage with monthly partitioning and 90-day automated TTL

CREATE DATABASE IF NOT EXISTS infrawaste;

-- 1. HTTP Rollup Aggregates Table
CREATE TABLE IF NOT EXISTS infrawaste.http_telemetry_aggregates (
    timestamp DateTime CODEC(DoubleDelta, LZ4),
    service LowCardinality(String),
    environment LowCardinality(String),
    method LowCardinality(String),
    route String,
    status_code UInt16,
    total_requests UInt32 CODEC(T64, ZSTD),
    error_count UInt32 CODEC(T64, ZSTD),
    total_duration_ms Float64,
    p50_duration_ms Float32,
    p95_duration_ms Float32,
    p99_duration_ms Float32,
    total_response_bytes UInt64 CODEC(T64, ZSTD)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (service, environment, route, method, timestamp)
TTL timestamp + INTERVAL 90 DAY DELETE;

-- 2. Database Normalized Telemetry Table
CREATE TABLE IF NOT EXISTS infrawaste.database_telemetry (
    timestamp DateTime CODEC(DoubleDelta, LZ4),
    database_type LowCardinality(String),
    service LowCardinality(String),
    database String,
    operation LowCardinality(String),
    fingerprint String,
    execution_count UInt32 CODEC(T64, ZSTD),
    total_duration_ms Float64,
    p50_duration_ms Float32,
    p95_duration_ms Float32,
    p99_duration_ms Float32,
    error_count UInt32 CODEC(T64, ZSTD),
    rows_read UInt64,
    rows_returned UInt64,
    bytes_read UInt64
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (database_type, service, fingerprint, timestamp)
TTL timestamp + INTERVAL 90 DAY DELETE;

-- 3. Materialized Waste Findings Table
CREATE TABLE IF NOT EXISTS infrawaste.waste_findings (
    id String,
    timestamp DateTime CODEC(DoubleDelta, LZ4),
    type LowCardinality(String),
    service LowCardinality(String),
    endpoint String,
    database String,
    root_cause String,
    confidence UInt8,
    severity LowCardinality(String),
    database_load_reduction Float32,
    latency_reduction_percent Float32,
    estimated_monthly_savings Float32,
    recommendation_action String,
    recommendation_solution String,
    evidence_json String
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (severity, service, type, id, timestamp)
TTL timestamp + INTERVAL 180 DAY DELETE;
