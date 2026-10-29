/**
 * Shared authentication, RBAC, and client-side feature guard.
 * Strictly prevents players and unauthorized users from pointing to, hovering,
 * or interacting with links and actions they lack permissions for.
 */
import { apiFetch, readApiJson } from './net/api.js';

const TOKEN_KEY = 'countdown_studio_auth_token_v1';
const USER_KEY = 'countdown_studio_auth_user_v1';
const path = location.pathname.toLowerCase();

/** Escapes text for safe interpolation into innerHTML templates. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export const ROUTE_PERMISSIONS = {
  'solo.html': 'solo:practice',
  'versus-host.html': 'host:operations',
  'versus-display.html': 'stage:display',
};

const requiredPermission = path.endsWith('/solo.html')
  ? 'solo:practice'
  : path.endsWith('/versus-host.html')
  ? 'host:operations'
  : path.endsWith('/versus-display.html')
  ? 'stage:display'
  : path.endsWith('/admin.html')
  ? 'user:manage'
  : null;

export const token = () => localStorage.getItem(TOKEN_KEY);
export function authHeaders() {
  return token() ? { Authorization: `Bearer ${token()}` } : {};
}

export function currentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function hasPermission(permission) {
  if (!permission) return true;
  const user = currentUser();
  return Boolean(user && Array.isArray(user.permissions) && user.permissions.includes(permission));
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  location.href = './index.html';
}

function openModal() {
  document.getElementById('auth-modal')?.removeAttribute('hidden');
  document.getElementById('auth-identifier')?.focus();
}

function closeModal() {
  document.getElementById('auth-modal')?.setAttribute('hidden', '');
}

function showMessage(message, isError = false) {
  const el = document.getElementById('auth-message');
  if (el) {
    el.textContent = message;
    el.style.color = isError ? 'var(--status-invalid, #dc2626)' : 'var(--accent-primary, #2563eb)';
  }
}

function saveSession(data) {
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  location.reload();
}

export function getRequiredPermissionForHref(href) {
  if (!href) return null;
  const cleanHref = href.split('?')[0].split('#')[0].toLowerCase();
  if (cleanHref.endsWith('solo.html') || cleanHref.endsWith('/solo')) {
    return 'solo:practice';
  }
  if (cleanHref.endsWith('versus-host.html') || cleanHref.endsWith('/versus-host')) {
    return 'host:operations';
  }
  if (cleanHref.endsWith('versus-display.html') || cleanHref.endsWith('/versus-display')) {
    return 'stage:display';
  }
  if (cleanHref.endsWith('admin.html') || cleanHref.endsWith('/admin')) {
    return 'user:manage';
  }
  return null;
}

export function getPermissionMetadata(permission) {
  switch (permission) {
    case 'solo:practice':
      return {
        roleName: 'Individual Player or Admin',
        featureName: 'Solo Practice',
        badgeText: 'Individual',
      };
    case 'host:operations':
      return {
        roleName: 'Tournament Organiser (Organization) or Admin',
        featureName: 'Live Versus Host Console',
        badgeText: 'Organization',
      };
    case 'stage:display':
      return {
        roleName: 'Tournament Organiser (Organization) or Admin',
        featureName: '16:9 Stage Display',
        badgeText: 'Organization',
      };
    case 'user:manage':
    case 'role:manage':
      return {
        roleName: 'Administrator (user:manage / role:manage)',
        featureName: 'Admin Console',
        badgeText: 'Admin',
      };
    default:
      return {
        roleName: 'Administrator',
        featureName: 'Restricted Feature',
        badgeText: 'Locked',
      };
  }
}

/**
 * Display a polished, accessible toast alert when an unauthorized link is clicked
 * or when redirected from a protected page.
 */
export function showAccessDeniedToast(meta) {
  const existingToast = document.querySelector('.auth-toast-alert');
  if (existingToast) existingToast.remove();

  const user = currentUser();
  const currentRoleName = user?.role === 'individual' ? 'Player (Individual)' : user?.role || 'Guest (not signed in)';

  const toast = document.createElement('div');
  toast.className = 'auth-toast-alert';
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <span class="auth-toast-alert__icon" aria-hidden="true">🔒</span>
    <div style="flex:1">
      <div style="font-weight:700; color:#fecaca; margin-bottom:2px;">Access Restricted</div>
      <div style="font-size:0.8125rem; color:#cbd5e1; line-height:1.45;">
        The feature <strong>${esc(meta.featureName)}</strong> is restricted to <strong>${esc(meta.roleName)}</strong>.
        Your current account (${esc(currentRoleName)}) does not have permission.
      </div>
      ${!user ? `
        <div style="margin-top:0.5rem">
          <a href="./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}" class="btn btn--primary btn--sm" style="min-height:30px; font-size:0.75rem; padding:0.25rem 0.65rem;">
            Sign In / Register Free
          </a>
        </div>
      ` : ''}
    </div>
    <button type="button" class="auth-toast-alert__close" aria-label="Close notification">✕</button>
  `;

  document.body.appendChild(toast);

  const closeToast = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  };

  toast.querySelector('.auth-toast-alert__close')?.addEventListener('click', closeToast);
  setTimeout(closeToast, 5000);
}

/**
 * Decorate or restore the Live Versus Mode Card on index.html based on permissions.
 */
function decorateVersusCard(userPermissions) {
  const isHostAllowed = userPermissions.has('host:operations');
  const isStageAllowed = userPermissions.has('stage:display');
  const hasVersusAccess = isHostAllowed || isStageAllowed;

  const versusCard = document.querySelector('article:has(a[href*="versus-host"], a[data-restricted-href*="versus-host"])');
  if (!versusCard) return;

  let banner = versusCard.querySelector('#versus-card-notice');
  if (!hasVersusAccess) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'versus-card-notice';
      banner.className = 'mode-card-restricted-banner';
      banner.innerHTML = `
        <span class="mode-card-restricted-banner__icon" aria-hidden="true">🔒</span>
        <div>
          <strong style="display:block; margin-bottom:2px;">Tournament Organisers Only</strong>
          <span>Live Versus and Stage Display modes require an Organization or Admin account. Individual players do not have access.</span>
        </div>
      `;
      const cardTitleContainer = versusCard.querySelector('div:first-child');
      if (cardTitleContainer) {
        cardTitleContainer.insertBefore(banner, cardTitleContainer.querySelector('h2'));
      }
    }
  } else if (banner) {
    banner.remove();
  }
}

/**
 * Decorate the Solo Practice Mode Card on index.html based on auth state.
 */
function decorateSoloCard(user) {
  const soloCard = document.querySelector('article:has(a[href*="solo.html"], a[data-restricted-href*="solo.html"])');
  if (!soloCard) return;

  let banner = soloCard.querySelector('#solo-card-guest-notice');
  const enterBtn = soloCard.querySelector('div:last-child a.btn--primary');

  if (!user) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'solo-card-guest-notice';
      banner.className = 'mode-card-info-banner';
      banner.innerHTML = `
        <span class="mode-card-info-banner__icon" aria-hidden="true">👤</span>
        <div>
          <strong style="display:block; margin-bottom:2px;">Individual Player Mode</strong>
          <span>Self-registered account includes full access to Solo Drills, 30s clock, and Dictionary Corner.</span>
        </div>
      `;
      const cardTitleContainer = soloCard.querySelector('div:first-child');
      if (cardTitleContainer) {
        cardTitleContainer.insertBefore(banner, cardTitleContainer.querySelector('h2'));
      }
    }
    if (enterBtn) {
      enterBtn.textContent = 'Sign In to Play Solo →';
      enterBtn.href = './login.html?redirect=./solo.html';
    }
  } else {
    if (banner) banner.remove();
    if (enterBtn) {
      enterBtn.textContent = 'Enter Solo Studio →';
      enterBtn.href = './solo.html';
    }
  }
}

/**
 * Strictly guards all UI elements against unauthorized cursor pointing or interaction,
 * while welcoming unauthenticated guests toward smooth sign-in for Individual features.
 */
export function applyPermissionGuards() {
  const user = currentUser();
  const userPermissions = new Set(user?.permissions || []);

  const elements = document.querySelectorAll(
    'a[href], a[data-restricted-href], a[data-auth-permission], button[data-auth-permission]'
  );

  elements.forEach((el) => {
    // Avoid modifying authentication modal controls or settings modal
    if (
      el.id === 'auth-close' ||
      el.id === 'auth-identifier' ||
      el.classList.contains('auth-toast-alert__close') ||
      el.hasAttribute('data-modal-open') ||
      el.hasAttribute('data-modal-close')
    ) {
      return;
    }

    const declaredPermission = el.getAttribute('data-auth-permission');
    const href = el.getAttribute('href') || el.getAttribute('data-restricted-href');
    const required = declaredPermission || getRequiredPermissionForHref(href);

    if (!required) return;

    const allowed = userPermissions.has(required);
    const meta = getPermissionMetadata(required);

    if (!allowed) {
      // Friendly onboarding for unauthenticated guests accessing Solo Practice
      if (!user && required === 'solo:practice') {
        const rawTarget = el.getAttribute('data-restricted-href') || el.getAttribute('href') || './solo.html';
        const cleanTarget = rawTarget.startsWith('./login.html') ? rawTarget : `./login.html?redirect=${encodeURIComponent(rawTarget)}`;

        el.classList.remove('is-permission-locked');
        el.removeAttribute('aria-disabled');
        if (el.getAttribute('tabindex') === '-1') {
          el.removeAttribute('tabindex');
        }
        el.setAttribute('href', cleanTarget);
        el.removeAttribute('data-restricted-href');
        el.setAttribute('title', 'Sign in or register a free Individual account to play Solo Practice');

        // Un-wrap if previously wrapped
        const wrap = el.closest('.auth-restricted-wrap');
        if (wrap && wrap.parentElement) {
          wrap.parentElement.insertBefore(el, wrap);
          wrap.remove();
        }
        el.querySelector('.auth-lock-badge')?.remove();
        return;
      }

      // 1. Remove active href so browser cursor cannot "point" into it as a link
      if (el.tagName.toLowerCase() === 'a') {
        if (el.hasAttribute('href')) {
          el.setAttribute('data-restricted-href', el.getAttribute('href'));
          el.removeAttribute('href');
        }
        el.removeAttribute('target');
      }

      // 2. Mark with state classes and accessibility attributes
      el.classList.add('is-permission-locked');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('tabindex', '-1');

      const tooltipMsg = user
        ? `🔒 Restricted to ${meta.roleName}. Your account (${user.role === 'individual' ? 'Individual Player' : user.role}) does not have access.`
        : `🔒 Restricted to ${meta.roleName}. Please sign in with an authorized account.`;

      el.setAttribute('title', tooltipMsg);

      // 3. Wrap in container to enforce cursor: not-allowed on hover
      let wrap = el.closest('.auth-restricted-wrap');
      if (!wrap) {
        wrap = document.createElement('span');
        wrap.className = 'auth-restricted-wrap';
        if (el.classList.contains('btn') && (el.style.width === '100%' || el.classList.contains('btn--block'))) {
          wrap.classList.add('auth-restricted-wrap--block');
        }
        el.parentNode.insertBefore(wrap, el);
        wrap.appendChild(el);
      }
      wrap.setAttribute('title', tooltipMsg);
      wrap.setAttribute('data-tooltip', tooltipMsg);

      // 4. Attach subtle lock badge if not already added
      if (!el.querySelector('.auth-lock-badge')) {
        const badge = document.createElement('span');
        badge.className = 'auth-lock-badge';
        badge.setAttribute('aria-hidden', 'true');
        badge.innerHTML = `<span class="auth-lock-badge__icon">🔒</span> ${meta.badgeText}`;
        el.appendChild(badge);
      }

      // 5. Intercept all pointer / keyboard click events
      if (!el._hasPermissionLockHandler) {
        el._hasPermissionLockHandler = true;
        const blockEvent = (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          showAccessDeniedToast(meta);
          return false;
        };
        el.addEventListener('click', blockEvent, true);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            blockEvent(e);
          }
        }, true);
      }
    } else {
      // User HAS permission. Ensure link is unlocked and interactive
      el.classList.remove('is-permission-locked');
      el.removeAttribute('aria-disabled');
      if (el.getAttribute('tabindex') === '-1') {
        el.removeAttribute('tabindex');
      }
      if (el.hasAttribute('data-restricted-href')) {
        el.setAttribute('href', el.getAttribute('data-restricted-href'));
        el.removeAttribute('data-restricted-href');
      }
      el.querySelector('.auth-lock-badge')?.remove();
      el.removeAttribute('title');

      const wrap = el.closest('.auth-restricted-wrap');
      if (wrap && wrap.parentElement) {
        wrap.parentElement.insertBefore(el, wrap);
        wrap.remove();
      }
    }
  });

  decorateVersusCard(userPermissions);
  decorateSoloCard(user);
}

function addAuthUi() {
  const action = document.querySelector('.top-bar__action');
  if (!action) return;

  action.querySelectorAll('.auth-status-btn, .auth-user-container').forEach((el) => el.remove());

  const user = currentUser();
  const isLoginPage = location.pathname.toLowerCase().endsWith('login.html');

  if (isLoginPage && !user) {
    // Don't add redundant "Sign In / Register" on login page
    return;
  }

  if (user) {
    const roleBadge = user.role === 'admin' ? 'Admin' : user.role === 'organization' ? 'Host' : 'Player';
    const container = document.createElement('div');
    container.className = 'auth-user-container';
    container.innerHTML = `
      <div class="auth-user-chip" title="Account: ${esc(user.username)} [${esc(roleBadge)}]">
        <span class="auth-user-chip__role">${esc(roleBadge)}</span>
        <span class="auth-user-chip__name">${esc(user.displayName || user.username)}</span>
      </div>
      <button type="button" class="btn btn--secondary btn--sm auth-signout-btn" title="Sign out of Countdown Studio">
        Sign Out
      </button>
    `;
    container.querySelector('.auth-signout-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
    action.prepend(container);
  } else {
    const button = document.createElement('a');
    button.className = 'btn btn--primary btn--sm auth-status-btn';
    button.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    button.textContent = 'Sign In / Register';
    action.prepend(button);
  }
}

function addModal() {
  if (document.getElementById('auth-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'auth-modal';
  modal.className = 'modal-backdrop';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="modal-card" style="max-width:460px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-3)">
        <h2 style="font-size:1.4rem">Countdown Studio Account</h2>
        <button type="button" class="btn btn--sm btn--secondary" id="auth-close">Close</button>
      </div>
      <p id="auth-message" style="min-height:1.4rem;color:var(--text-secondary);font-size:0.9rem;margin-bottom:var(--space-3)"></p>
      <form id="auth-login-form" style="display:grid;gap:.75rem">
        <input id="auth-identifier" class="input-field" required placeholder="Username or email" autocomplete="username">
        <input id="auth-password" class="input-field" required type="password" minlength="8" placeholder="Password" autocomplete="current-password">
        <button class="btn btn--primary" type="submit">Sign In</button>
      </form>
      <hr class="hairline" style="margin:var(--space-4) 0">
      <p style="font-size:0.875rem;color:var(--text-muted);text-align:center">
        Need an Individual player account? <a href="./login.html?mode=register" style="color:var(--accent-secondary);text-decoration:underline">Register Free</a>
      </p>
    </div>
  `;
  document.body.append(modal);
  document.getElementById('auth-close')?.addEventListener('click', closeModal);
  document.getElementById('auth-login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage('Signing in…');
    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: document.getElementById('auth-identifier').value,
          password: document.getElementById('auth-password').value,
        }),
      });
      const data = await readApiJson(response);
      if (!response.ok) throw new Error(data.message || 'Login failed.');
      saveSession(data);
    } catch (error) {
      showMessage(error.message, true);
    }
  });
}

/**
 * Route protection guard for solo.html, versus-host.html, versus-display.html.
 */
async function guardFeature() {
  if (!requiredPermission) return;

  if (!token()) {
    location.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }

  try {
    const response = await apiFetch('/api/auth/me', { headers: authHeaders() });
    const data = await readApiJson(response);

    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        location.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }
      throw new Error('AUTH_SERVER_ERROR');
    }

    if (!data.user.permissions.includes(requiredPermission)) {
      // User is authenticated, but lacks permission for this feature.
      // Update cached user but DO NOT wipe session! Redirect to home with notification.
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      location.href = `./index.html?unauthorized=1&feature=${encodeURIComponent(requiredPermission)}`;
      return;
    }

    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  } catch {
    // If auth server is unreachable, verify against locally cached user for offline PWA play
    const cachedUser = currentUser();
    if (cachedUser && Array.isArray(cachedUser.permissions) && cachedUser.permissions.includes(requiredPermission)) {
      return;
    }
    location.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
  }
}

/**
 * Handle incoming unauthorized redirect toast parameter on index.html.
 */
function handleUnauthorizedRedirect() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('unauthorized') === '1') {
    const feature = urlParams.get('feature') || '';
    const meta = getPermissionMetadata(feature);
    showAccessDeniedToast(meta);

    urlParams.delete('unauthorized');
    urlParams.delete('feature');
    const newQuery = urlParams.toString();
    const newUrl = window.location.pathname + (newQuery ? `?${newQuery}` : '') + window.location.hash;
    window.history.replaceState({}, document.title, newUrl);
  }
}

// Initialize Authentication and RBAC Guards
addModal();
addAuthUi();
applyPermissionGuards();
guardFeature();
handleUnauthorizedRedirect();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    applyPermissionGuards();
    addAuthUi();
  });
}
