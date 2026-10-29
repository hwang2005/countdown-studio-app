/**
 * @file js/admin/roles.js
 * @module admin/roles
 * Role & permission matrix module. Renders every role with its permission set
 * from /api/admin/rbac (database-backed, static fallback), allows editing and
 * saving role permissions via PUT /api/admin/rbac/roles/:code/permissions.
 *
 * The 'admin' role is intentionally locked: keeping at least one always-complete
 * administrator prevents an accidental full system lockout.
 */
import { adminRequest, esc, roleBadge } from './api.js';
import { showToast } from '../ui/toast.js';

const state = {
  roles: [],
  permissions: [], // { code, description }
  source: 'database',
  dirty: new Set(), // role codes modified since last save/load
};

const matrixEl = () => document.getElementById('admin-roles-matrix');
const statusEl = () => document.getElementById('admin-roles-status');
const errorEl = () => document.getElementById('admin-roles-error');

const USER_KEY = 'countdown_studio_auth_user_v1';

export function canManageRoles() {
  try {
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return Boolean(user?.permissions?.includes('role:manage'));
  } catch {
    return false;
  }
}

async function loadRoles({ reloadStatus = true } = {}) {
  matrixEl().innerHTML = '<div class="admin-empty">Loading roles & permissions…</div>';
  if (reloadStatus) statusEl().textContent = 'Loading matrix…';
  errorEl().textContent = '';
  try {
    const data = await adminRequest('/api/admin/rbac');
    state.roles = data.roles || [];
    state.permissions = data.permissions || [];
    state.source = data.source || 'database';
    state.dirty.clear();
    renderMatrix();
    statusEl().textContent =
      state.source === 'database'
        ? `${state.roles.length} role(s) loaded from the database. Changes take effect on the next sign-in.`
        : '⚠ Database RBAC tables are not seeded yet — showing the static fallback (run database/auth-rbac.sql to enable editing).';
    document.getElementById('admin-btn-save-roles').hidden = !canManageRoles() || state.source !== 'database';
  } catch (error) {
    matrixEl().innerHTML = `<div class="admin-empty">⚠ ${esc(error.message)}</div>`;
    statusEl().textContent = 'Role matrix failed to load.';
    errorEl().textContent = error.message;
    document.getElementById('admin-btn-save-roles').hidden = true;
  }
}

function renderMatrix() {
  if (!state.roles.length) {
    matrixEl().innerHTML = '<div class="admin-empty">No roles available.</div>';
    return;
  }
  const permissionLabels = new Map(state.permissions.map((p) => [p.code, p.description]));
  matrixEl().innerHTML = state.roles.map((role) => {
    const isAdminRole = role.code === 'admin';
    const assigned = new Set(role.permissions || []);
    return `
      <div class="admin-perm-group ${isAdminRole ? 'is-locked' : ''}" data-role-code="${esc(role.code)}">
        <span class="admin-role-label">${roleBadge(role.code)}<br>
          <small class="admin-cell-muted">${esc(role.name)} · ${esc(role.member_count ?? 0)} member(s)</small>
        </span>
        ${state.permissions.map((permission) => {
          const checked = assigned.has(permission.code);
          return `
            <label class="admin-perm-checkbox ${checked ? 'is-checked' : ''}" title="${esc(permission.description || permission.code)}">
              <input type="checkbox" data-role-permission="${esc(role.code)}" value="${esc(permission.code)}"
                ${checked ? 'checked' : ''} ${isAdminRole || !canManageRoles() ? 'disabled' : ''} />
              <span>${esc(permission.code)}</span>
            </label>`;
        }).join('')}
        ${isAdminRole ? '<span class="admin-lock-note">🔒 Fixed permissions — administrators must never lose the ability to administer.</span>' : ''}
        ${!state.permissions.length && assigned.size ? `
          <div class="admin-lock-note">Assigned: ${esc((role.permissions || []).join(', '))}</div>` : ''}
      </div>`;
  }).join('');
}

async function saveRoles() {
  if (!state.dirty.size) {
    showToast('No permission changes to save.', 'info');
    return;
  }
  errorEl().textContent = '';
  const saveButton = document.getElementById('admin-btn-save-roles');
  if (saveButton) saveButton.disabled = true;
  let failures = 0;
  try {
    for (const roleCode of [...state.dirty].sort()) {
      const group = matrixEl().querySelector(`[data-role-code="${CSS.escape(roleCode)}"]`);
      if (!group) continue;
      const selected = [...group.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
      try {
        const data = await adminRequest(`/api/admin/rbac/roles/${encodeURIComponent(roleCode)}/permissions`, {
          method: 'PUT',
          body: { permissions: selected },
        });
        showToast(`Role '${roleCode}' saved: ${(data.permissions || []).join(', ') || '(no permissions)'}`, 'success');
      } catch (error) {
        failures += 1;
        errorEl().textContent = `${roleCode}: ${error.message}`;
      }
    }
    state.dirty.clear();
    if (!failures) await loadRoles({ reloadStatus: false });
    statusEl().textContent = failures
      ? `${failures} role(s) failed to save — see the error line below.`
      : 'Permission matrix saved successfully.';
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

export function initRoles() {
  matrixEl()?.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-role-permission]');
    if (!input || input.disabled) return;
    const group = input.closest('.admin-perm-checkbox');
    group?.classList.toggle('is-checked', input.checked);
    state.dirty.add(input.dataset.rolePermission);
    statusEl().textContent = `Unsaved changes for role(s): ${[...state.dirty].join(', ')}`;
  });
  document.getElementById('admin-btn-save-roles')?.addEventListener('click', saveRoles);
  document.getElementById('admin-btn-reload-roles')?.addEventListener('click', () => loadRoles());
}

export function refreshRoles() { loadRoles(); }
