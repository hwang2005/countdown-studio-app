/**
 * @file js/app-admin.js
 * @module app-admin
 * Admin Console orchestrator. Guards access (requires the `user:manage`
 * permission — enforced again on every server call), wires the module tabs,
 * and lazy-loads each admin module the first time it is opened.
 *
 * Modules:
 *   - Dashboard  (js/admin/dashboard.js) — aggregate platform statistics
 *   - Users      (js/admin/users.js)     — provisioning & account lifecycle
 *   - Archives   (js/admin/archives.js)  — archived match inspection
 *   - Roles      (js/admin/roles.js)     — permission matrix editor
 */
import { token, currentUser, logout } from './auth.js';
import { apiFetch, readApiJson } from './net/api.js';
import { initModalHandlers, openModal } from './ui/modal.js';
import { showToast } from './ui/toast.js';
import { initDashboard, refreshDashboard } from './admin/dashboard.js';
import { initUsers, refreshUsers } from './admin/users.js';
import { initArchives, refreshArchives } from './admin/archives.js';
import { initRoles, refreshRoles } from './admin/roles.js';

const requiredPermission = 'user:manage';

/* ── Access guard: same contract as the feature pages ───────────────────── */

async function guardAccess() {
  if (!token()) {
    location.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    return false;
  }
  try {
    const response = await apiFetch('/api/auth/me', { headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
    const data = await readApiJson(response);
    if (!response.ok) {
      localStorage.removeItem('countdown_studio_auth_token_v1');
      localStorage.removeItem('countdown_studio_auth_user_v1');
      location.href = './login.html?redirect=' + encodeURIComponent(location.pathname + location.search);
      return false;
    }
    localStorage.setItem('countdown_studio_auth_user_v1', JSON.stringify(data.user));
    if (!data.user.permissions.includes(requiredPermission)) {
      location.href = `./index.html?unauthorized=1&feature=${encodeURIComponent(requiredPermission)}`;
      return false;
    }
    return true;
  } catch {
    const cached = currentUser();
    if (cached?.permissions?.includes(requiredPermission)) return true;
    location.href = './login.html?redirect=' + encodeURIComponent(location.pathname + location.search);
    return false;
  }
}

/* ── Tab navigation with lazy module loading ─────────────────────────────── */

const loaders = {
  dashboard: refreshDashboard,
  users: refreshUsers,
  archives: refreshArchives,
  roles: refreshRoles,
};
const loaded = new Set();

function activateTab(tab) {
  const target = document.querySelector(`[data-admin-panel="${tab}"]`);
  if (!target) return;
  document.querySelectorAll('[data-admin-panel]').forEach((panel) => { panel.hidden = panel !== target; });
  document.querySelectorAll('.admin-nav-link').forEach((link) => {
    const isCurrent = link.dataset.adminTab === tab;
    link.classList.toggle('is-active', isCurrent);
    if (isCurrent) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!loaded.has(tab)) {
    loaded.add(tab);
    loaders[tab]?.();
  }
}

function wireTabs() {
  document.querySelectorAll('.admin-nav-link').forEach((link) => {
    link.addEventListener('click', () => activateTab(link.dataset.adminTab));
  });
  document.getElementById('admin-btn-refresh-all')?.addEventListener('click', () => {
    for (const tab of loaded) loaders[tab]?.();
    showToast('Admin modules refreshed.', 'info');
  });
}

/* ── Welcome + sign out quick action ─────────────────────────────────────── */

function showWelcome() {
  const user = currentUser();
  if (!user) return;
  showToast(`Admin Console ready — welcome, ${user.displayName || user.username}. Remember: every action here is audited against the live database.`, 'info', 5000);
}

function addSignOutShortcut() {
  const title = document.querySelector('.top-bar__nav');
  if (!title || title.querySelector('.admin-signout-link')) return;
  const link = document.createElement('a');
  link.href = '#';
  link.className = 'top-bar__link admin-signout-link';
  link.textContent = 'Sign Out';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    logout();
  });
  title.appendChild(link);
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

(async function boot() {
  initModalHandlers();
  wireTabs();
  initDashboard();
  initUsers();
  initArchives();
  initRoles();
  addSignOutShortcut();
  const allowed = await guardAccess();
  if (!allowed) return;
  // Default tab. Support deep links like admin.html?tab=users#users.
  const initial = new URLSearchParams(location.search).get('tab');
  activateTab(loaders[initial] ? initial : 'dashboard');
  if (new URLSearchParams(location.search).get('provision') === '1') {
    openModal('modal-provision-user');
  }
  showWelcome();
})();
