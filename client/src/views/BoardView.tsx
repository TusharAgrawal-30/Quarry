import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, EmptyState, ErrorBanner, SeverityGlyph, statusLabel, TableSkeleton, useActorById } from '../components/atoms';
import type { Issue } from '../lib/api';
import { api, ApiFailure } from '../lib/api';
import { useApp } from '../lib/app-state';

// Board: drag between workflow states. Legal targets glow; illegal ones dim
// with the reason inline. Drops are still sent to the server — enforcement
// lives there, the board just makes the state machine visible.

const COLUMNS = ['unconfirmed', 'confirmed', 'in_progress', 'in_review', 'resolved', 'verified', 'closed'];

interface ResolveDraft {
  issue: Issue;
  to: string;
}

export function BoardView() {
  const { meta, actor, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const actorById = useActorById();

  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Issue | null>(null);
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const [resolveDraft, setResolveDraft] = useState<ResolveDraft | null>(null);
  const [resolution, setResolution] = useState('fixed');
  const [dupTarget, setDupTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const product = params.get('product') ?? '';

  const load = useCallback(() => {
    setError(null);
    const q: Record<string, string> = { limit: '400', sort: 'updated' };
    if (product) q.product = product;
    api
      .issues(q)
      .then((d) => setIssues(d.issues))
      .catch((e) => setError(e.message));
  }, [product]);

  useEffect(load, [load]);

  const byCol = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const c of COLUMNS) m.set(c, []);
    for (const i of issues ?? []) m.get(i.status)?.push(i);
    return m;
  }, [issues]);

  const applyTransition = async (issue: Issue, to: string, extra?: { resolution?: string; duplicateOf?: string }) => {
    if (!actor) return;
    setBusy(true);
    try {
      const updated = await api.transition(issue.key, { to, actorId: actor.id, ...extra });
      setIssues((list) => list?.map((i) => (i.key === updated.key ? updated : i)) ?? null);
      toast({ kind: 'success', message: `${issue.key} → ${statusLabel(to)}${extra?.resolution ? ` (${extra.resolution})` : ''}` });
      setResolveDraft(null);
    } catch (e) {
      if (e instanceof ApiFailure) {
        toast({
          kind: 'error',
          title: 'Server rejected the move',
          message: e.message,
        });
      } else {
        toast({ kind: 'error', message: 'Transition failed unexpectedly.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (issue: Issue, to: string) => {
    if (issue.status === to) return;
    if (to === 'resolved') {
      // resolution has a reason — collect it
      setResolution('fixed');
      setDupTarget('');
      setResolveDraft({ issue, to });
      return;
    }
    void applyTransition(issue, to);
  };

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!issues) return <TableSkeleton rows={7} />;

  return (
    <div>
      <div className="page-head rise">
        <h1 className="page-title">Board</h1>
        <span className="page-sub">drag a card — legal moves light up, illegal ones explain themselves</span>
        <span className="spacer" />
        <select
          value={product}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('product', e.target.value);
            else next.delete('product');
            setParams(next, { replace: true });
          }}
          aria-label="Filter board by product"
        >
          <option value="">All products</option>
          {meta?.products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="board rise rise-1">
        {COLUMNS.map((col) => {
          const cards = byCol.get(col) ?? [];
          const legal = dragging ? dragging.legalNextStates.includes(col) || dragging.status === col : true;
          const cls = dragging ? (legal ? 'drop-legal' : 'drop-illegal') : '';
          return (
            <section
              key={col}
              className={`board-col ${hoverCol === col && legal ? 'drop-legal' : cls}`}
              aria-label={`${statusLabel(col)} column, ${cards.length} issues`}
              onDragOver={(e) => {
                e.preventDefault();
                setHoverCol(col);
              }}
              onDragLeave={() => setHoverCol((h) => (h === col ? null : h))}
              onDrop={(e) => {
                e.preventDefault();
                setHoverCol(null);
                if (dragging) onDrop(dragging, col);
              }}
            >
              <div className="board-col-head">
                <span className="status-pill" style={{ color: `var(--st-${col})`, background: `color-mix(in srgb, var(--st-${col}) 12%, transparent)` }}>
                  <span className="dot" />
                  {statusLabel(col)}
                </span>
                <span className="count">{cards.length}</span>
              </div>
              <div className="board-col-hint">
                {dragging && !legal && dragging.status !== col
                  ? `not reachable from ${statusLabel(dragging.status).toLowerCase()}`
                  : dragging && col === 'resolved' && legal
                    ? 'requires a resolution'
                    : ''}
              </div>
              <div className="board-cards">
                {cards.slice(0, 30).map((issue) => (
                  <article
                    key={issue.key}
                    className={`board-card ${dragging?.key === issue.key ? 'dragging' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      setDragging(issue);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setHoverCol(null);
                    }}
                    onClick={() => nav(`/issue/${issue.key}`)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && nav(`/issue/${issue.key}`)}
                    aria-label={`${issue.key}: ${issue.title}`}
                  >
                    <div className="top">
                      <span className="key">{issue.key}</span>
                      <span style={{ marginLeft: 'auto' }}>
                        <SeverityGlyph severity={issue.severity} />
                      </span>
                    </div>
                    <div className="title">{issue.title}</div>
                    <div className="foot">
                      <Avatar actor={actorById(issue.assignee_id)} />
                      {issue.resolution && <span className="chip">{issue.resolution}</span>}
                      {issue.labels.slice(0, 2).map((l) => (
                        <span key={l} className="chip">
                          {l}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
                {cards.length > 30 && <div className="count-note" style={{ padding: '4px 6px' }}>+{cards.length - 30} more — use triage to see all</div>}
                {cards.length === 0 && <div className="count-note" style={{ padding: '10px 6px' }}>empty</div>}
              </div>
            </section>
          );
        })}
      </div>

      {issues.length === 0 && <EmptyState glyph="◇" title="Nothing on the board">This product has no issues yet.</EmptyState>}

      {resolveDraft && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setResolveDraft(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Resolve issue">
            <div className="dialog-head">
              <h2>
                Resolve <span className="key">{resolveDraft.issue.key}</span>
              </h2>
              <button className="btn ghost sm" onClick={() => setResolveDraft(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="dialog-body">
              <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
                A bug never just stops — it stops <em style={{ fontFamily: 'var(--serif)' }}>for a reason</em>. Pick one; it stays queryable forever.
              </p>
              <div className="field">
                <label htmlFor="res-select">Resolution</label>
                <select id="res-select" value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus>
                  {meta?.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              {resolution === 'duplicate' && (
                <div className="field">
                  <label htmlFor="dup-input">Canonical issue key (watchers will merge into it)</label>
                  <input id="dup-input" value={dupTarget} onChange={(e) => setDupTarget(e.target.value)} placeholder="e.g. RELAY-42" style={{ textTransform: 'uppercase', fontFamily: 'var(--mono)' }} />
                </div>
              )}
            </div>
            <div className="dialog-foot">
              <button className="btn" onClick={() => setResolveDraft(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || (resolution === 'duplicate' && !dupTarget.trim())}
                onClick={() =>
                  applyTransition(resolveDraft.issue, 'resolved', {
                    resolution,
                    duplicateOf: resolution === 'duplicate' ? dupTarget.trim().toUpperCase() : undefined,
                  })
                }
              >
                {busy ? 'Resolving…' : `Resolve as ${resolution}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
