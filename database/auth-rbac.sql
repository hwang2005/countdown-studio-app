-- Run after countdown_auth_schema.sql. Existing legacy roles are preserved;
-- these application roles are the only roles accepted by the auth API.
INSERT INTO roles (code, name, description, is_system) VALUES
  ('individual', 'Individual', 'Solo Practice', TRUE),
  ('organization', 'Organization', 'Stage Display and Host Operations', TRUE),
  ('admin', 'Admin', 'Full access to all three features', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, description) VALUES
  ('solo:practice', 'Use Solo Practice'),
  ('stage:display', 'Use Stage Display'),
  ('host:operations', 'Use Host Operations')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE (r.code = 'individual' AND p.code = 'solo:practice')
   OR (r.code = 'organization' AND p.code IN ('stage:display', 'host:operations'))
   OR (r.code = 'admin' AND p.code IN ('solo:practice', 'stage:display', 'host:operations'))
ON CONFLICT (role_id, permission_id) DO NOTHING;
