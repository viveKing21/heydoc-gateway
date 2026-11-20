-- 002_lab_calls.sql — append-only audit of lab API attempts.
-- Business metrics are derived from the database at scrape time, so every API
-- replica reports the same numbers even though the worker is a separate process.

CREATE TABLE lab_calls (
  id          bigserial PRIMARY KEY,
  op          text NOT NULL,
  outcome     text NOT NULL,
  attempt     integer NOT NULL DEFAULT 1,
  latency_ms  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_calls_by_day ON lab_calls (created_at);
