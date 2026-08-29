import type { Actor } from '../lib/api';
import { useApp } from '../lib/app-state';

// Small shared visual atoms: status pill, severity glyph, avatar,
// empty/loading/error states, toast stack.

const STATUS_LABEL: Record<string, string> = {
  unconfirmed: 'Unconfirmed',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  in_review: 'In review',
  resolved: 'Resolved',
  verified: 'Verified',
  closed: 'Closed',
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

export function StatusPill({ status, resolution }: { status: string; resolution?: string | null }) {
  const color = `var(--st-${status}, var(--text-faint))`;
  return (
    <span className="status-pill" style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>
      <span className="dot" aria-hidden />
      {statusLabel(status)}
      {resolution ? <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>· {resolution}</span> : null}
    </span>
  );
}

const SEV_LEVEL: Record<string, number> = { blocker: 5, critical: 4, major: 3, normal: 2, minor: 1, trivial: 0 };

export function SeverityGlyph({ severity }: { severity: string }) {
  const level = SEV_LEVEL[severity] ?? 2;
  return (
    <span className="sev" style={{ color: `var(--sv-${severity}, var(--text-faint))` }} title={`severity: ${severity}`}>
      <span className="bars" aria-hidden>
        {[0, 1, 2].map((i) => (
          <i key={i} className={level >= (i + 1) * 1.7 ? 'on' : ''} style={{ height: 4 + i * 3.5 }} />
        ))}
      </span>
      {severity}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: string }) {
  return (
    <span className="chip" style={priority === 'p1' ? { color: 'var(--danger)', borderColor: 'rgba(201,111,95,.4)' } : undefined}>
      {priority.toUpperCase()}
    </span>
  );
}

export function Avatar({ actor, size }: { actor: Actor | undefined | null; size?: 'lg' }) {
  if (!actor) {
    return (
      <span className={`avatar ${size ?? ''}`} style={{ background: 'var(--bg3)', color: 'var(--text-faint)' }} title="Unassigned">
        —
      </span>
    );
  }
  const initials = actor.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');
  return (
    <span
      className={`avatar ${size ?? ''} ${actor.active ? '' : 'departed'}`}
      style={{ background: `oklch(0.75 0.09 ${actor.hue * 7})` }}
      title={`${actor.name}${actor.active ? '' : ' (departed)'}`}
    >
      {initials}
    </span>
  );
}

export function useActorById() {
  const { meta } = useApp();
  return (id: number | null | undefined): Actor | undefined => meta?.actors.find((a) => a.id === id);
}

export function EmptyState({ glyph, title, children }: { glyph: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state rise">
      <div className="glyph" aria-hidden>
        {glyph}
      </div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span aria-hidden>⚠</span>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry ? (
        <button className="btn sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 34, opacity: 1 - i * 0.09 }} />
      ))}
    </div>
  );
}

export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div style={{ flex: 1 }}>
            {t.title ? <b>{t.title}</b> : null}
            {t.message}
          </div>
          <button className="btn ghost sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
