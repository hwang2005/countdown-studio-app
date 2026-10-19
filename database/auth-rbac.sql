-- Run after countdown_auth_schema.sql. Existing legacy roles are preserved;
-- these application roles are the only roles accepted by the auth API.
INSERT IGNORE INTO roles (code, name, description, is_system) VALUES
  ('individual', 'Individual', 'Solo Practice', 1),
  ('organization', 'Organization', 'Stage Display và Host Operations', 1),
  ('admin', 'Admin', 'Toàn quyền cả ba tính năng', 1);

INSERT IGNORE INTO permissions (code, description) VALUES
  ('solo:practice', 'Sử dụng Solo Practice'),
  ('stage:display', 'Sử dụng Stage Display'),
  ('host:operations', 'Sử dụng Host Operations');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE (r.code = 'individual' AND p.code = 'solo:practice')
   OR (r.code = 'organization' AND p.code IN ('stage:display', 'host:operations'))
   OR (r.code = 'admin' AND p.code IN ('solo:practice', 'stage:display', 'host:operations'));
