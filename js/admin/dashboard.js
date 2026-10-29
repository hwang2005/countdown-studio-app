/**
 * @file js/admin/dashboard.js
 * @module admin/dashboard
 * Aggregate platform statistics panel: accounts, roles, statuses, live rooms,
 * and archived match counts. Degrades independently per source (missing tables
 * or permission gaps never blank the whole panel).
 */
import { adminRequest, esc, fmtRelative, statusBadge, roleBadge } from './api.js';
import { showToast } from '../ui/toast.js';

const PANEL_STATUS_ID = 'admin-dashboard-status';
const GRID_ID = 'admin-stats-grid';
const DETAIL_ID = 'admin-stats-detail';

function statCard({ label, value, extra = '', accent = false }) {
  return `
    <div class="admin-stat-card ${accent ? 'admin-stat-card--accent' : ''}">
      <span class="admin-stat-value">${esc(value)}</span>
      <span class="admin-stat-label">${esc(label)}</span>
      ${extra ? `<span class="admin-stat-extra">${extra}</span>` : ''}
    </div>`;
}

function renderDetailColumns(stats) {
  const byRole = stats.users?.byRole || {};
  const byStatus = stats.users?.byStatus || {};
  const roleEntries = Object.entries(byRole);
  const statusEntries = Object.entries(byStatus);

  return `
    <div>
      <div class="admin-nav-title">Accounts by Role</div>
      <div class="admin-archive-list">
        ${roleEntries.length
          ? roleEntries.map(([role, count]) => `<div>${roleBadge(role)} <strong class="font-mono" style="float:right">${count}</strong></div>`).join('')
          : '<span class="admin-cell-muted">No role aggregates available.</span>'}
      </div>
    </div>
    <div>
      <div class="admin-nav-title">Accounts by Status</div>
      <div class="admin-archive-list">
        ${statusEntries.length
          ? statusEntries.map(([status, count]) => `<div>${statusBadge(status)} <strong class="font-mono" style="float:right">${count}</strong></div>`).join('')
          : '<span class="admin-cell-muted">No status aggregates available.</span>'}
        ${stats.users?.deleted ? `<div class="admin-cell-muted">${stats.users.deleted} deleted account(s) are preserved for audit history.</div>` : ''}
      </div>
    </div>`;
}

export async function refreshDashboard() {
  const status = document.getElementById(PANEL_STATUS_ID);
  const grid = document.getElementById(GRID_ID);
  const detail = document.getElementById(DETAIL_ID);
  if (!status || !grid || !detail) return;

  status.textContent = 'Loading platform statistics…';
  grid.innerHTML = '<div class="admin-empty">Collecting statistics…</div>';
  detail.innerHTML = '<div class="admin-empty">Waiting for aggregates…</div>';

  try {
    const { stats } = await adminRequest('/api/admin/stats');
    const users = stats.users || {};
    const byRole = users.byRole || {};
    const activeTotal = Object.values(byRole).reduce((sum, count) => sum + Number(count || 0), 0);

    grid.innerHTML = [
      statCard({ label: 'Active Accounts', value: activeTotal, extra: `+${users.newLast7d ?? 0} in 7 days · +${users.newLast30d ?? 0} in 30 days`, accent: true }),
      statCard({ label: 'Live Rooms', value: stats.liveRooms?.active ?? 0, extra: `${stats.liveRooms?.hosts ?? 0} host(s) · ${stats.liveRooms?.displays ?? 0} display(s) connected` }),
      statCard({ label: 'Archived Matches', value: stats.matches?.archivedTotal ?? 0, extra: `${stats.matches?.archivedLast7d ?? 0} closed in the last 7 days` }),
      statCard({ label: 'Archive Rooms', value: stats.matches?.distinctRooms ?? 0, extra: `${stats.matches?.distinctHosts ?? 0} distinct host account(s)` }),
    ].join('');
    detail.innerHTML = renderDetailColumns(stats);
    status.textContent = `Updated ${fmtRelative(stats.generatedAt)} · generated at ${new Date(stats.generatedAt).toLocaleTimeString()}`;
  } catch (error) {
    grid.innerHTML = `<div class="admin-empty">⚠ ${esc(error.message || 'Statistics are unavailable right now.')}</div>`;
    status.textContent = 'Statistics failed to load.';
    if (error.status !== 401 && error.status !== 403) showToast(error.message, 'error');
  }
}

export function initDashboard() {
  document.getElementById('admin-btn-reload-stats')?.addEventListener('click', refreshDashboard);
}
