-- Countdown Studio - PostgreSQL schema for Supabase
-- Run this file in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS user_statuses (id SMALLINT PRIMARY KEY, code VARCHAR(20) NOT NULL UNIQUE, description VARCHAR(255));
CREATE TABLE IF NOT EXISTS auth_providers (id SMALLSERIAL PRIMARY KEY, code VARCHAR(20) NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS one_time_token_types (id SMALLSERIAL PRIMARY KEY, code VARCHAR(30) NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS auth_event_types (id SMALLSERIAL PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY, public_id UUID NOT NULL UNIQUE, username VARCHAR(32) NOT NULL UNIQUE,
  status_id SMALLINT NOT NULL DEFAULT 1 REFERENCES user_statuses (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_users_username_len CHECK (char_length(username) >= 3)
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status_id);

CREATE TABLE IF NOT EXISTS user_emails (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email VARCHAR(254) NOT NULL UNIQUE, is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_emails_one_primary ON user_emails (user_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE, password_hash VARCHAR(255) NOT NULL,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ, last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE, display_name VARCHAR(64) NOT NULL,
  avatar_url VARCHAR(512), locale VARCHAR(10) NOT NULL DEFAULT 'en', timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_identities (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id SMALLINT NOT NULL REFERENCES auth_providers (id), provider_user_id VARCHAR(191) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (provider_id, provider_user_id), UNIQUE (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id SMALLSERIAL PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, name VARCHAR(64) NOT NULL,
  description VARCHAR(255), is_system BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS permissions (id SMALLSERIAL PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, description VARCHAR(255));
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id SMALLINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE, permission_id SMALLINT NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions (permission_id);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE, role_id SMALLINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  granted_by BIGINT REFERENCES users (id) ON DELETE SET NULL, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles (role_id, user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE, family_id UUID NOT NULL,
  token_hash BYTEA NOT NULL UNIQUE, user_agent VARCHAR(255), ip_address INET, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, replaced_by_id BIGINT REFERENCES refresh_tokens (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user_active ON refresh_tokens (user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens (expires_at);
CREATE TABLE IF NOT EXISTS one_time_tokens (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type_id SMALLINT NOT NULL REFERENCES one_time_token_types (id), user_email_id BIGINT REFERENCES user_emails (id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ott_user_type ON one_time_tokens (user_id, type_id);
CREATE INDEX IF NOT EXISTS idx_ott_expires ON one_time_tokens (expires_at);

CREATE TABLE IF NOT EXISTS auth_events (
  id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_id BIGINT,
  event_type_id SMALLINT NOT NULL REFERENCES auth_event_types (id), ip_address INET, user_agent VARCHAR(255), details JSONB
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_events_type ON auth_events (event_type_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events (ip_address, created_at);

CREATE OR REPLACE VIEW v_user_permissions AS
SELECT DISTINCT ur.user_id, p.code AS permission_code FROM user_roles ur
JOIN users u ON u.id = ur.user_id JOIN user_statuses s ON s.id = u.status_id AND s.code = 'active'
JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
WHERE ur.expires_at IS NULL OR ur.expires_at > NOW();

INSERT INTO user_statuses (id, code, description) VALUES
  (1, 'pending', 'Registered, pending email verification'), (2, 'active', 'Active'),
  (3, 'suspended', 'Suspended'), (4, 'banned', 'Banned'), (5, 'deleted', 'Deleted / Anonymized')
ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;
INSERT INTO auth_providers (code) VALUES ('google'), ('github'), ('facebook') ON CONFLICT (code) DO NOTHING;
INSERT INTO one_time_token_types (code) VALUES ('email_verification'), ('password_reset'), ('email_change') ON CONFLICT (code) DO NOTHING;
INSERT INTO auth_event_types (code) VALUES ('register'), ('login_success'), ('login_failed'), ('logout'), ('password_changed'), ('password_reset_requested'), ('email_verified'), ('account_locked'), ('role_granted'), ('role_revoked'), ('token_reuse_detected') ON CONFLICT (code) DO NOTHING;
INSERT INTO roles (code, name, description, is_system) VALUES
  ('individual', 'Individual User', 'Solo practice mode', TRUE), ('organization', 'Organization', 'Versus match and stage display operations', TRUE), ('admin', 'Administrator', 'Full system access', TRUE)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;
INSERT INTO permissions (code, description) VALUES
  ('solo:practice', 'Solo practice mode'), ('stage:display', 'Stage display'), ('host:operations', 'Host match operations'), ('user:manage', 'User management'), ('role:manage', 'Role management')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'admin' OR (r.code = 'individual' AND p.code = 'solo:practice') OR (r.code = 'organization' AND p.code IN ('stage:display', 'host:operations'))
ON CONFLICT DO NOTHING;
