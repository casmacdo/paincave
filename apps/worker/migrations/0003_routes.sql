-- PainCave D1 SQLite Migration 0003: Virtual & GPX Routes Library
-- Strictly UI-owned (never exposed to MCP tools).

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gpx', 'fit_extract', 'preset')),
  distance_m REAL NOT NULL CHECK (distance_m > 0),
  total_ascent_m REAL NOT NULL DEFAULT 0,
  max_grade_pct REAL NOT NULL DEFAULT 0,
  point_count INTEGER NOT NULL CHECK (point_count >= 2),
  r2_route_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_routes_created_at
  ON routes (created_at DESC);
