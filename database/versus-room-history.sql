-- Countdown Studio - persistent Versus rooms and match archive
-- Run after countdown-auth-schema.sql.

CREATE TABLE IF NOT EXISTS versus_rooms (
  id BIGSERIAL PRIMARY KEY,
  room_code VARCHAR(32) NOT NULL,
  host_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pin_hash VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  latest_state JSONB,
  stage_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  host_disconnected_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_versus_rooms_host_status ON versus_rooms (host_user_id, status, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_versus_rooms_status_activity ON versus_rooms (status, last_active_at);
CREATE INDEX IF NOT EXISTS idx_versus_rooms_closed_at ON versus_rooms (closed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_versus_rooms_active_code ON versus_rooms (room_code) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS versus_match_archive (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES versus_rooms (id) ON DELETE RESTRICT,
  room_code VARCHAR(32) NOT NULL,
  host_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  match_id VARCHAR(128),
  schema_version SMALLINT NOT NULL DEFAULT 1,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  close_reason VARCHAR(64) NOT NULL,
  final_state JSONB,
  stage_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_scores JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_versus_archive_room_once UNIQUE (room_id)
);
CREATE INDEX IF NOT EXISTS idx_versus_archive_host_closed ON versus_match_archive (host_user_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_versus_archive_room_code ON versus_match_archive (room_code, closed_at DESC);

