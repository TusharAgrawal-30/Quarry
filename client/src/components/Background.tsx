import { useEffect, useRef } from 'react';

// Ambient background: a slow field of ember-toned drift lines that bend
// around the cursor. Canvas 2D, capped particle count, additive but very
// dim — presence, not spectacle. Honors prefers-reduced-motion by drawing
// a single static frame.

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hueShift: number;
}

export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const mouse = { x: -9999, y: -9999, active: false };

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const N = Math.min(90, Math.floor((w * h) / 16000));
    const parts: P[] = [];
    const spawn = (p?: P): P => {
      const np: P = p ?? ({} as P);
      np.x = Math.random() * w;
      np.y = Math.random() * h;
      np.vx = 0;
      np.vy = 0;
      np.maxLife = 240 + Math.random() * 400;
      np.life = Math.random() * np.maxLife;
      np.hueShift = Math.random();
      return np;
    };
    for (let i = 0; i < N; i++) parts.push(spawn());

    // Flow field: layered sines — cheap, organic, deterministic.
    const field = (x: number, y: number, t: number) => {
      const s = 0.0016;
      const a =
        Math.sin(x * s * 1.3 + t * 0.00021) +
        Math.cos(y * s * 1.7 - t * 0.00017) +
        Math.sin((x + y) * s * 0.7 + t * 0.00013);
      return a * Math.PI * 0.7;
    };

    const step = (t: number) => {
      // trail fade
      ctx.fillStyle = 'rgba(19, 17, 16, 0.055)';
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 1;

      for (const p of parts) {
        const ang = field(p.x, p.y, t);
        let ax = Math.cos(ang) * 0.055;
        let ay = Math.sin(ang) * 0.055;

        // cursor vortex: swirl around the pointer within a radius
        if (mouse.active) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const d2 = dx * dx + dy * dy;
          const R = 190;
          if (d2 < R * R && d2 > 1) {
            const d = Math.sqrt(d2);
            const f = (1 - d / R) * 0.65;
            ax += (-dy / d) * f + (dx / d) * f * 0.22;
            ay += (dx / d) * f + (dy / d) * f * 0.22;
          }
        }

        p.vx = (p.vx + ax) * 0.94;
        p.vy = (p.vy + ay) * 0.94;
        const nx = p.x + p.vx;
        const ny = p.y + p.vy;

        const fade = Math.sin((p.life / p.maxLife) * Math.PI);
        const warm = 28 + p.hueShift * 16; // ember range
        ctx.strokeStyle = `hsla(${warm}, 42%, ${52 + p.hueShift * 8}%, ${0.05 + fade * 0.055})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();

        p.x = nx;
        p.y = ny;
        p.life++;
        if (p.life > p.maxLife || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) spawn(p);
      }
      raf = requestAnimationFrame(step);
    };

    // base wash
    const wash = () => {
      const g = ctx.createRadialGradient(w * 0.3, -h * 0.2, 0, w * 0.3, -h * 0.2, h * 1.4);
      g.addColorStop(0, 'rgba(210, 155, 98, 0.05)');
      g.addColorStop(1, 'rgba(19, 17, 16, 0)');
      ctx.fillStyle = '#131110';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    };
    wash();

    if (reduced) {
      // static: one long-exposure pass, no animation loop
      for (let s = 0; s < 220; s++) {
        for (const p of parts) {
          const ang = field(p.x, p.y, s * 16);
          p.x += Math.cos(ang) * 1.1;
          p.y += Math.sin(ang) * 1.1;
          ctx.strokeStyle = 'hsla(32, 40%, 55%, 0.012)';
          ctx.strokeRect(p.x, p.y, 0.5, 0.5);
        }
      }
    } else {
      raf = requestAnimationFrame(step);
    }

    const onMove = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
    };
    const onLeave = () => {
      mouse.active = false;
    };
    const onResize = () => {
      resize();
      wash();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', opacity: 0.85 }}
    />
  );
}
