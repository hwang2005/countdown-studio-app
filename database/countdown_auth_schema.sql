
-- =====================================================================
--  Countdown Studio — Authentication & RBAC schema
--  Target : MariaDB 10.2.7+ (InnoDB, utf8mb4). Nên dùng 10.11+ nếu BKNS cho chọn.
--           Cũng chạy được trên MySQL 8.0.16+.
--           Yêu cầu tối thiểu: CHECK + generated column (10.2.1), DYNAMIC row
--           format mặc định (10.2.2), kiểu JSON (alias LONGTEXT, 10.2.7).
--  Design : 3NF/BCNF, RBAC (user -> role -> permission), token hashing,
--           audit log partitioned theo tháng.
--  Quy ước:
--    * PK nội bộ  : BIGINT UNSIGNED AUTO_INCREMENT (index gọn, join nhanh)
--    * public_id  : BINARY(16) = UUIDv7 sinh ở app (lộ ra API, tránh đoán ID)
--    * Thời gian  : DATETIME(3), lưu UTC
--    * Mật khẩu   : lưu chuỗi băm Argon2id (PHC string), KHÔNG lưu plaintext
--    * Token      : chỉ lưu SHA-256 (BINARY(32)), token gốc chỉ gửi cho client
-- =====================================================================

SET NAMES utf8mb4;

-- Trên hosting cPanel (BKNS) KHÔNG chạy CREATE DATABASE: hãy tạo database + user
-- trong cPanel > MySQL Databases (tên sẽ có tiền tố, vd: cpuser_countdown), gán
-- ALL PRIVILEGES cho user, rồi chọn database đó trong phpMyAdmin > tab Import/SQL
-- trước khi chạy file này. Nếu tự quản server riêng thì mở comment dưới đây:
--   CREATE DATABASE countdown_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   USE countdown_studio;

-- ---------------------------------------------------------------------
-- 1. LOOKUP TABLES (tách giá trị miền ra khỏi bảng chính -> 3NF)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_statuses (
  id          TINYINT UNSIGNED NOT NULL,
  code        VARCHAR(20)  NOT NULL,
  description VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_statuses_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_providers (
  id   TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL,                       -- google, github, facebook...
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_providers_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS one_time_token_types (
  id   TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL,                       -- email_verification, password_reset...
  PRIMARY KEY (id),
  UNIQUE KEY uq_ott_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_event_types (
  id   SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(40) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_event_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 2. USERS (định danh) + các bảng 1-1 / 1-N tách theo nhóm thuộc tính
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  public_id  BINARY(16)       NOT NULL,                     -- UUIDv7 từ app
  username   VARCHAR(32)      NOT NULL,                     -- unique, không phân biệt hoa/thường (theo collation)
  status_id  TINYINT UNSIGNED NOT NULL DEFAULT 1,           -- 1 = pending
  created_at DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3)      NULL,                         -- soft delete / ẩn danh hoá
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_public_id (public_id),
  UNIQUE KEY uq_users_username  (username),
  KEY idx_users_status (status_id),
  CONSTRAINT chk_users_username_len CHECK (CHAR_LENGTH(username) >= 3),
  CONSTRAINT fk_users_status FOREIGN KEY (status_id) REFERENCES user_statuses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Email tách riêng: 1 user có thể có nhiều email, trạng thái xác thực thuộc về TỪNG email
CREATE TABLE IF NOT EXISTS user_emails (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  email          VARCHAR(254)    NOT NULL,
  is_primary     TINYINT(1)      NOT NULL DEFAULT 0,
  -- Cột sinh tự động: đảm bảo mỗi user chỉ có tối đa 1 email primary
  -- (UNIQUE cho phép nhiều NULL, nên chỉ các dòng is_primary=1 bị ràng buộc)
  primary_marker TINYINT GENERATED ALWAYS AS (IF(is_primary = 1, 1, NULL)) STORED,
  verified_at    DATETIME(3)     NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_emails_email       (email),
  UNIQUE KEY uq_user_emails_one_primary (user_id, primary_marker),
  CONSTRAINT fk_user_emails_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Thông tin nhạy cảm + trạng thái đăng nhập: tách khỏi users để
--  (a) không vô tình SELECT * lộ hash, (b) cột cập nhật thường xuyên không làm "nóng" bảng users
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id             BIGINT UNSIGNED  NOT NULL,
  password_hash       VARCHAR(255)     NOT NULL,            -- Argon2id PHC string
  password_changed_at DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  failed_attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME(3)      NULL,
  last_login_at       DATETIME(3)      NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_credentials_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(64)     NOT NULL,
  avatar_url   VARCHAR(512)    NULL,
  locale       VARCHAR(10)     NOT NULL DEFAULT 'vi',       -- khớp i18n.js (en / vi)
  timezone     VARCHAR(64)     NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Đăng nhập mạng xã hội (OAuth): 1 user có thể liên kết nhiều provider
CREATE TABLE IF NOT EXISTS user_identities (
  id               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED  NOT NULL,
  provider_id      TINYINT UNSIGNED NOT NULL,
  provider_user_id VARCHAR(191)     NOT NULL,               -- "sub" do provider cấp
  created_at       DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_provider_account (provider_id, provider_user_id),
  UNIQUE KEY uq_identity_user_provider    (user_id, provider_id),
  CONSTRAINT fk_identities_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_identities_provider FOREIGN KEY (provider_id) REFERENCES auth_providers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 3. RBAC: roles / permissions / role_permissions / user_roles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(32)  NOT NULL,                        -- player, host, moderator, admin
  name        VARCHAR(64)  NOT NULL,
  description VARCHAR(255) NULL,
  is_system   TINYINT(1)   NOT NULL DEFAULT 0,              -- role hệ thống: không cho xoá
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(64)  NOT NULL,                        -- dạng resource:action
  description VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng nối N-N: khoá chính ghép, không có thuộc tính phụ thuộc 1 phần của khoá (2NF)
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       SMALLINT UNSIGNED NOT NULL,
  permission_id SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_role_permissions_perm (permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id)       REFERENCES roles (id)       ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    BIGINT UNSIGNED   NOT NULL,
  role_id    SMALLINT UNSIGNED NOT NULL,
  granted_by BIGINT UNSIGNED   NULL,                        -- ai cấp quyền (NULL nếu hệ thống)
  granted_at DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3)       NULL,                        -- quyền tạm thời (vd: host 1 sự kiện)
  PRIMARY KEY (user_id, role_id),
  KEY idx_user_roles_role (role_id, user_id),
  CONSTRAINT fk_ur_user       FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role       FOREIGN KEY (role_id)    REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_granted_by FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 4. SESSION / TOKEN
-- ---------------------------------------------------------------------
-- Refresh token có xoay vòng (rotation) + theo dõi "family" để phát hiện bị đánh cắp
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  family_id      BINARY(16)      NOT NULL,                  -- cùng 1 phiên đăng nhập
  token_hash     BINARY(32)      NOT NULL,                  -- SHA-256 của token
  user_agent     VARCHAR(255)    NULL,
  ip_address     VARBINARY(16)   NULL,                      -- INET6_ATON(); hỗ trợ cả IPv4/IPv6
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at     DATETIME(3)     NOT NULL,
  revoked_at     DATETIME(3)     NULL,
  replaced_by_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_token_hash (token_hash),
  KEY idx_refresh_user_active (user_id, revoked_at, expires_at),
  KEY idx_refresh_family (family_id),
  KEY idx_refresh_expires (expires_at),                     -- phục vụ job dọn rác
  CONSTRAINT fk_refresh_user     FOREIGN KEY (user_id)        REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_refresh_replaced FOREIGN KEY (replaced_by_id) REFERENCES refresh_tokens (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Token dùng 1 lần: xác thực email, đặt lại mật khẩu...
CREATE TABLE IF NOT EXISTS one_time_tokens (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED  NOT NULL,
  type_id       TINYINT UNSIGNED NOT NULL,
  user_email_id BIGINT UNSIGNED  NULL,                      -- email cần xác thực (nếu có)
  token_hash    BINARY(32)       NOT NULL,
  created_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3)      NOT NULL,
  used_at       DATETIME(3)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ott_hash (token_hash),
  KEY idx_ott_user_type (user_id, type_id),
  KEY idx_ott_expires (expires_at),
  CONSTRAINT fk_ott_user  FOREIGN KEY (user_id)       REFERENCES users (id)                ON DELETE CASCADE,
  CONSTRAINT fk_ott_type  FOREIGN KEY (type_id)       REFERENCES one_time_token_types (id),
  CONSTRAINT fk_ott_email FOREIGN KEY (user_email_id) REFERENCES user_emails (id)          ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 5. AUDIT LOG (append-only, partition theo tháng)
--    LƯU Ý: bảng partition của MySQL KHÔNG hỗ trợ FOREIGN KEY, nên
--    user_id / event_type_id được kiểm soát ở tầng ứng dụng. Chủ đích:
--    log phải sống lâu hơn user và không được chặn việc xoá user.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_events (
  id            BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  created_at    DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id       BIGINT UNSIGNED   NULL,                     -- NULL nếu đăng nhập sai user không tồn tại
  event_type_id SMALLINT UNSIGNED NOT NULL,
  ip_address    VARBINARY(16)     NULL,
  user_agent    VARCHAR(255)      NULL,
  details       JSON              NULL,                     -- metadata tự do, không dùng làm khoá truy vấn
                                                          -- (MariaDB: JSON = LONGTEXT + CHECK JSON_VALID)
  PRIMARY KEY (id, created_at),                             -- partition key bắt buộc nằm trong PK
  KEY idx_auth_events_user  (user_id, created_at),
  KEY idx_auth_events_type  (event_type_id, created_at),
  KEY idx_auth_events_ip    (ip_address, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
PARTITION BY RANGE COLUMNS (created_at) (
  PARTITION p2026_10 VALUES LESS THAN ('2026-11-01'),
  PARTITION p2026_11 VALUES LESS THAN ('2026-12-01'),
  PARTITION p2026_12 VALUES LESS THAN ('2027-01-01'),
  PARTITION p_max    VALUES LESS THAN (MAXVALUE)
);
-- Thêm partition mới hàng tháng (cron/job):
--   ALTER TABLE auth_events REORGANIZE PARTITION p_max INTO (
--     PARTITION p2027_01 VALUES LESS THAN ('2027-02-01'),
--     PARTITION p_max    VALUES LESS THAN (MAXVALUE));
-- Xoá log cũ rất nhanh:  ALTER TABLE auth_events DROP PARTITION p2026_10;
--
-- NẾU HOSTING TẮT PARTITIONING (lệnh CREATE TABLE báo lỗi về partition; kiểm tra
-- bằng SHOW PLUGINS và tìm dòng "partition"): bỏ khối PARTITION BY ... ở trên,
-- đổi PRIMARY KEY (id, created_at) thành PRIMARY KEY (id), và dọn log bằng cron:
--   DELETE FROM auth_events WHERE created_at < NOW() - INTERVAL 90 DAY LIMIT 10000;

-- ---------------------------------------------------------------------
-- 6. VIEW: quyền hiệu lực của user (chỉ user active, role chưa hết hạn)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_user_permissions AS
SELECT DISTINCT ur.user_id, p.code AS permission_code
FROM user_roles ur
JOIN users u             ON u.id = ur.user_id
JOIN user_statuses s     ON s.id = u.status_id AND s.code = 'active'
JOIN role_permissions rp ON rp.role_id = ur.role_id
JOIN permissions p       ON p.id = rp.permission_id
WHERE ur.expires_at IS NULL OR ur.expires_at > NOW(3);

-- ---------------------------------------------------------------------
-- 7. SEED DATA
-- ---------------------------------------------------------------------
INSERT INTO user_statuses (id, code, description) VALUES
  (1, 'pending',   'Đã đăng ký, chưa xác thực email'),
  (2, 'active',    'Hoạt động bình thường'),
  (3, 'suspended', 'Tạm khoá'),
  (4, 'banned',    'Bị cấm'),
  (5, 'deleted',   'Đã xoá / ẩn danh hoá');

INSERT INTO auth_providers (code) VALUES ('google'), ('github'), ('facebook');

INSERT INTO one_time_token_types (code) VALUES
  ('email_verification'), ('password_reset'), ('email_change');

INSERT INTO auth_event_types (code) VALUES
  ('register'), ('login_success'), ('login_failed'), ('logout'),
  ('password_changed'), ('password_reset_requested'), ('email_verified'),
  ('account_locked'), ('role_granted'), ('role_revoked'), ('token_reuse_detected');

INSERT INTO roles (code, name, description, is_system) VALUES
  ('player',    'Người chơi',       'Chơi Solo và tham gia trận Versus',          1),
  ('host',      'Người dẫn chương trình', 'Tạo và điều khiển trận Versus (Host Console)', 1),
  ('moderator', 'Điều hành viên',   'Quản lý nội dung và xem thông tin người dùng', 1),
  ('admin',     'Quản trị viên',    'Toàn quyền hệ thống',                        1);

INSERT INTO permissions (code, description) VALUES
  ('solo:play',        'Chơi chế độ Solo'),
  ('match:join',       'Tham gia trận Versus'),
  ('match:create',     'Tạo trận Versus'),
  ('match:host',       'Điều khiển trận qua Host Console'),
  ('user:read',        'Xem thông tin người dùng'),
  ('user:manage',      'Khoá / mở khoá / cấm người dùng'),
  ('role:manage',      'Gán / thu hồi vai trò'),
  ('content:moderate', 'Quản lý nội dung (từ điển, bộ đề)'),
  ('audit:read',       'Xem nhật ký bảo mật');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON
     (r.code = 'player'    AND p.code IN ('solo:play','match:join'))
  OR (r.code = 'host'      AND p.code IN ('solo:play','match:join','match:create','match:host'))
  OR (r.code = 'moderator' AND p.code IN ('solo:play','match:join','match:create','match:host',
                                          'user:read','content:moderate'))
  OR (r.code = 'admin');                                    -- admin: tất cả permission

-- ---------------------------------------------------------------------
-- 8. VÍ DỤ TRUY VẤN (tham khảo cho server.ts)
-- ---------------------------------------------------------------------
-- (a) Đăng ký — chạy trong 1 transaction:
--   INSERT INTO users (public_id, username) VALUES (?, ?);                 -- status = pending
--   SET @uid = LAST_INSERT_ID();
--   INSERT INTO user_credentials (user_id, password_hash) VALUES (@uid, ?);
--   INSERT INTO user_emails (user_id, email, is_primary) VALUES (@uid, ?, 1);
--   INSERT INTO user_profiles (user_id, display_name) VALUES (@uid, ?);
--   INSERT INTO user_roles (user_id, role_id)
--     SELECT @uid, id FROM roles WHERE code = 'player';
--
-- (b) Đăng nhập bằng username HOẶC email:
--   SELECT u.id, u.public_id, u.status_id, c.password_hash, c.failed_attempts, c.locked_until
--   FROM users u
--   JOIN user_credentials c ON c.user_id = u.id
--   LEFT JOIN user_emails e ON e.user_id = u.id
--   WHERE u.username = ? OR e.email = ?
--   LIMIT 1;
--
-- (c) Kiểm tra quyền:
--   SELECT 1 FROM v_user_permissions WHERE user_id = ? AND permission_code = 'match:host';

