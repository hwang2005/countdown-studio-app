/**
 * @file js/ui/scoreboard.js
 * Scoreboard count-up animations, inline SVG performance chart for Solo stats,
 * canvas confetti particle celebration, and PNG match summary exporter.
 */

/**
 * Smoothly animates a numeric score change inside an element.
 * @param {HTMLElement} el
 * @param {number} toScore
 */
export function animateScoreTo(el, toScore) {
  if (!el) return;
  const fromScore = parseInt(el.textContent || '0', 10) || 0;
  if (fromScore === toScore) {
    el.textContent = String(toScore);
    return;
  }

  const reduced =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.getAttribute('data-reduced-motion') === 'true';

  if (reduced) {
    el.textContent = String(toScore);
    return;
  }

  const duration = 380;
  const start = performance.now();
  el.classList.remove('anim-pop');
  void el.offsetWidth;
  el.classList.add('anim-pop');

  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const current = Math.round(fromScore + (toScore - fromScore) * progress);
    el.textContent = String(current);
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

/**
 * Renders a dependency-free inline SVG trend chart of the player's recent Solo match scores.
 * @param {HTMLElement} container
 * @param {Array<{ score: number, mode: string, date: string }>} history
 */
export function renderStatsChartSVG(container, history = []) {
  if (!container) return;
  container.innerHTML = '';

  const recent = [...history].slice(0, 15).reverse();
  if (recent.length === 0) {
    const empty = document.createElement('p');
    empty.style.color = 'var(--text-muted)';
    empty.style.fontSize = '0.875rem';
    empty.textContent = 'Complete your first Solo session to see your score progression chart.';
    container.appendChild(empty);
    return;
  }

  const width = 560;
  const height = 160;
  const padX = 36;
  const padY = 24;
  const maxScore = Math.max(60, ...recent.map((h) => h.score || 0));

  const points = recent.map((item, idx) => {
    const x =
      recent.length === 1
        ? width / 2
        : padX + (idx / (recent.length - 1)) * (width - padX * 2);
    const y = height - padY - ((item.score || 0) / maxScore) * (height - padY * 2);
    return { x, y, score: item.score || 0 };
  });

  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const circlesHtml = points
    .map(
      (p, idx) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#F59E0B" stroke="#081229" stroke-width="2">
          <title>Game ${idx + 1}: ${p.score} pts</title>
        </circle>
        <text x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" text-anchor="middle" fill="#CBD5E1" font-size="10" font-family="monospace">${p.score}</text>`
    )
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;overflow:visible;" role="img" aria-label="Recent solo match scores trend chart">
      <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="rgba(148,163,184,0.25)" stroke-width="1"/>
      <line x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}" stroke="rgba(148,163,184,0.12)" stroke-dasharray="4 4" stroke-width="1"/>
      ${
        points.length > 1
          ? `<polyline fill="none" stroke="#38BDF8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${polylinePoints}"/>`
          : ''
      }
      ${circlesHtml}
    </svg>
  `;
}

/**
 * Fires a lightweight 2D canvas confetti celebration (respects prefers-reduced-motion).
 * @param {number} [durationMs=2800]
 */
export function launchConfetti(durationMs = 2800) {
  if (typeof document === 'undefined') return;
  const reduced =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.getAttribute('data-reduced-motion') === 'true';
  if (reduced) return;

  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '90';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const colors = ['#F59E0B', '#38BDF8', '#10B981', '#FDE68A', '#60A5FA', '#F43F5E'];
  const particles = Array.from({ length: 75 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 140,
    vx: (Math.random() - 0.5) * 4,
    vy: 2.5 + Math.random() * 4.5,
    size: 6 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI * 2,
    vRot: (Math.random() - 0.5) * 0.14
  }));

  const start = performance.now();
  const loop = (now) => {
    if (now - start > durationMs || !ctx) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vRot;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/**
 * Generates and downloads a PNG scoreboard summary card using HTML5 <canvas>.
 * @param {object} matchState
 */
export function exportMatchSummaryPNG(matchState) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Studio background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, 675);
  grad.addColorStop(0, '#132860');
  grad.addColorStop(1, '#060D20');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 675);

  ctx.strokeStyle = '#F59E0B';
  ctx.lineWidth = 4;
  ctx.strokeRect(28, 28, 1144, 619);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = 'bold 44px Georgia, serif';
  ctx.fillText('COUNTDOWN STUDIO — OFFICIAL MATCH RESULT', 64, 100);

  const p1 = matchState.players[0];
  const p2 = matchState.players[1];

  ctx.fillStyle = '#38BDF8';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(`${p1.name}: ${p1.score} pts`, 64, 180);

  ctx.fillStyle = '#F59E0B';
  ctx.fillText(`${p2.name}: ${p2.score} pts`, 620, 180);

  ctx.fillStyle = '#CBD5E1';
  ctx.font = '20px monospace';
  const history = matchState.roundHistory || [];
  history.slice(0, 15).forEach((r, idx) => {
    const y = 240 + idx * 26;
    ctx.fillText(
      `R${String(idx + 1).padStart(2, '0')} [${r.type}]  ${p1.name}: ${r.p1Sub || '—'} (+${
        r.p1Pts
      })   |   ${p2.name}: ${r.p2Sub || '—'} (+${r.p2Pts})`,
      64,
      y
    );
  });

  const link = document.createElement('a');
  link.download = `countdown-match-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
