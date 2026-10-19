/** Shared login, registration and client-side feature guard. */
const TOKEN_KEY = 'countdown_studio_auth_token_v1';
const USER_KEY = 'countdown_studio_auth_user_v1';
const path = location.pathname.toLowerCase();
const requiredPermission = path.endsWith('/solo.html') ? 'solo:practice' : path.endsWith('/versus-host.html') ? 'host:operations' : path.endsWith('/versus-display.html') ? 'stage:display' : null;

const token = () => localStorage.getItem(TOKEN_KEY);
export function authHeaders() { return token() ? { Authorization: `Bearer ${token()}` } : {}; }
export function currentUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
export function logout() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); location.href = './index.html'; }

function openModal() { document.getElementById('auth-modal')?.removeAttribute('hidden'); document.getElementById('auth-identifier')?.focus(); }
function closeModal() { document.getElementById('auth-modal')?.setAttribute('hidden', ''); }
function showMessage(message, isError = false) { const el = document.getElementById('auth-message'); if (el) { el.textContent = message; el.style.color = isError ? 'var(--status-invalid, #dc2626)' : 'var(--accent-primary, #2563eb)'; } }
function saveSession(data) { localStorage.setItem(TOKEN_KEY, data.token); localStorage.setItem(USER_KEY, JSON.stringify(data.user)); location.reload(); }

function addAuthUi() {
  const action = document.querySelector('.top-bar__action');
  if (!action) return;
  const user = currentUser();
  const button = document.createElement('a');
  button.className = 'btn btn--primary btn--sm';
  if (user) {
    button.href = '#';
    button.textContent = `${user.displayName || user.username} · Sign Out`;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  } else {
    button.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    button.textContent = 'Sign In / Register';
  }
  action.prepend(button);
  if (!user) {
    document.querySelectorAll('a[href="./solo.html"], a[href="./versus-host.html"], a[href="./versus-display.html"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        location.href = `./login.html?redirect=${encodeURIComponent(link.getAttribute('href'))}`;
      });
    });
  }
}

function addModal() {
  if (document.getElementById('auth-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'auth-modal';
  modal.className = 'modal-backdrop';
  modal.hidden = true;
  modal.innerHTML = `<div class="modal-card" style="max-width:460px"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Countdown Studio Account</h2><button type="button" class="btn btn--sm btn--secondary" id="auth-close">Close</button></div><p id="auth-message" style="min-height:1.4rem;color:var(--text-secondary)"></p><form id="auth-login-form" style="display:grid;gap:.75rem"><input id="auth-identifier" class="input-field" required placeholder="Username or email" autocomplete="username"><input id="auth-password" class="input-field" required type="password" minlength="8" placeholder="Password" autocomplete="current-password"><button class="btn btn--primary" type="submit">Sign In</button></form><hr class="hairline"><p style="font-size:0.875rem;color:var(--text-muted);text-align:center">Need an Individual account? <a href="./login.html?mode=register" style="color:var(--accent-secondary);text-decoration:underline">Open Full Registration Page</a></p></div>`;
  document.body.append(modal);
  document.getElementById('auth-close')?.addEventListener('click', closeModal);
  document.getElementById('auth-login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage('Signing in…');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: document.getElementById('auth-identifier').value,
          password: document.getElementById('auth-password').value,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Login failed.');
      saveSession(data);
    } catch (error) {
      showMessage(error.message, true);
    }
  });
}

async function guardFeature() {
  if (!requiredPermission) return;
  if (!token()) {
    location.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }
  try {
    const response = await fetch('/api/auth/me', { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok || !data.user.permissions.includes(requiredPermission)) throw new Error();
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    location.href = `./login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
  }
}

addModal();
addAuthUi();
guardFeature();

