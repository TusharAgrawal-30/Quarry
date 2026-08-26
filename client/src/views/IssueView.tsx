import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar, ErrorBanner, PriorityTag, SeverityGlyph, statusLabel, StatusPill, TableSkeleton, useActorById } from '../components/atoms';
import type { AncestryNode, IssueDetail, IssueEvent, LineageReport } from '../lib/api';
import { api, ApiFailure, fmtDate, timeAgo } from '../lib/api';
import { useApp } from '../lib/app-state';
import { Markdown } from '../lib/markdown';

// Issue detail: description, discussion, the full audit rail, relationships,
// and — for open issues — the Lineage panel asking "has this bug happened
// before, and is this a regression of that fix?"

export function IssueView() {
  const { key = '' } = useParams();
  const { meta, actor, toast } = useApp();
  const actorById = useActorById();

  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'discussion' | 'history'>('discussion');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolution, setResolution] = useState('fixed');
  const [dupTarget, setDupTarget] = useState('');
  const [relKind, setRelKind] = useState('blocks');
  const [relTarget, setRelTarget] = useState('');
  const [lineage, setLineage] = useState<LineageReport | null>(null);
  const [lineageState, setLineageState] = useState<'idle' | 'running' | 'done'>('idle');
  const [ancestry, setAncestry] = useState<AncestryNode[]>([]);

  const load = useCallback(() => {
    setError(null);
    api
      .issue(key)
      .then((d) => {
        setIssue(d);
        setBodyDraft(d.body);
        return api.ancestry(key).then((a) => setAncestry(a.chain));
      })
      .catch((e) => setError(e.message));
  }, [key]);

  useEffect(() => {
    setIssue(null);
    setLineage(null);
    setLineageState('idle');
    setTab('discussion');
    load();
  }, [load]);

  const open = issue && !['resolved', 'verified', 'closed'].includes(issue.status);
  const isRegressionConfirmed = ancestry.length > 1;

  const runLineage = async () => {
    setLineageState('running');
    try {
      // small theatrical pause so the reveal reads as computation, capped low
      const [report] = await Promise.all([api.lineage(key), new Promise((r) => setTimeout(r, 550))]);
      setLineage(report);
      setLineageState('done');
    } catch (e) {
      setLineageState('idle');
      toast({ kind: 'error', message: e instanceof ApiFailure ? e.message : 'Lineage scan failed.' });
    }
  };

  const guard = async <T,>(fn: () => Promise<T>, ok?: string) => {
    if (!actor) return;
    setBusy(true);
    try {
      await fn();
      if (ok) toast({ kind: 'success', message: ok });
      load();
    } catch (e) {
      toast({
        kind: 'error',
        title: e instanceof ApiFailure && e.legalNextStates ? 'Illegal transition' : undefined,
        message: e instanceof ApiFailure ? e.message : 'Request failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!issue || !meta || !actor) return <TableSkeleton rows={8} />;

  const product = meta.products.find((p) => p.id === issue.product_id);
  const component = meta.components.find((c) => c.id === issue.component_id);
  const watching = issue.watchers.includes(actor.id);
  const timelineDesc = [...issue.events].reverse();

  return (
    <div>
      <div className="issue-head rise">
        <div className="crumbs">
          <Link to="/">Triage</Link>
          <span aria-hidden>/</span>
          <Link to={`/?product=${product?.key}`}>{product?.name}</Link>
          <span aria-hidden>/</span>
          <span style={{ fontFamily: 'var(--mono)' }}>{component?.name}</span>
          <span aria-hidden>·</span>
          <span className="key">{issue.key}</span>
        </div>
        <h1>{issue.title}</h1>
        <div className="meta-line">
          <StatusPill status={issue.status} resolution={issue.resolution} />
          <SeverityGlyph severity={issue.severity} />
          <PriorityTag priority={issue.priority} />
          {issue.labels.map((l) => (
            <span key={l} className="chip">
              {l}
            </span>
          ))}
          <span className="count-note">
            reported by {actorById(issue.reporter_id)?.name ?? '—'} · {fmtDate(issue.created_at)} · updated {timeAgo(issue.updated_at)}
          </span>
        </div>
      </div>

      {isRegressionConfirmed && (
        <div className="rail-section rise rise-1" style={{ borderColor: 'var(--accent-line)', marginBottom: 18 }}>
          <h4>Ancestry — this bug has happened before</h4>
          <div className="ancestry">
            {ancestry.map((n, i) => (
              <span key={n.key} style={{ display: 'contents' }}>
                {i > 0 && (
                  <span className="ancestry-link" aria-label="is a regression of">
                    <svg width="26" height="14" viewBox="0 0 26 14" aria-hidden>
                      <path d="M2 7h20m0 0l-5-4.5M22 7l-5 4.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
                    </svg>
                  </span>
                )}
                <span className={`ancestry-node ${i === 0 ? 'first' : ''}`}>
                  <Link to={`/issue/${n.key}`} className="key">
                    {n.key}
                  </Link>{' '}
                  <StatusPill status={n.status} resolution={n.resolution} />
                  <span className="an-title">{n.title}</span>
                </span>
              </span>
            ))}
          </div>
          <p className="count-note" style={{ margin: '6px 0 0' }}>
            Left is this report; each arrow points at the earlier fix it regressed. Watchers of the original were subscribed automatically.
          </p>
        </div>
      )}

      <div className="issue-layout">
        <div>
          <div className="card rise rise-1" style={{ position: 'relative' }}>
            {!editingBody ? (
              <>
                <button
                  className="btn ghost sm edit-hover-btn"
                  style={{ position: 'absolute', top: 10, right: 10 }}
                  onClick={() => setEditingBody(true)}
                  aria-label="Edit description"
                >
                  Edit
                </button>
                {issue.body.trim() ? (
                  <Markdown text={issue.body} />
                ) : (
                  <p style={{ color: 'var(--text-faint)', fontStyle: 'italic', margin: 0 }}>No description provided.</p>
                )}
              </>
            ) : (
              <div className="inline-edit">
                <textarea value={bodyDraft} onChange={(e) => setBodyDraft(e.target.value)} aria-label="Edit description" />
                <div className="actions">
                  <button className="btn sm" onClick={() => { setEditingBody(false); setBodyDraft(issue.body); }}>
                    Cancel
                  </button>
                  <button
                    className="btn primary sm"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        await api.updateIssue(issue.key, { body: bodyDraft }, actor.id);
                        setEditingBody(false);
                      }, 'Description updated.')
                    }
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>

          {open && !isRegressionConfirmed && (
            <section className="lineage-panel rise rise-2" aria-label="Lineage regression analysis">
              <div className="lineage-head">
                <span className="eyebrow">Lineage</span>
                <h3>Has this bug happened before?</h3>
              </div>
              <p className="lineage-sub">
                Four independent signals — <em>wording, location, stack trace, fix timing</em> — checked against every fixed bug in {product?.name}.
                They are shown separately: when they disagree, you should know.
              </p>

              {lineageState === 'idle' && (
                <button className="btn primary" onClick={runLineage}>
                  Scan ancestry
                </button>
              )}
              {lineageState === 'running' && (
                <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="skeleton" style={{ height: 64 }} />
                  <div className="skeleton" style={{ height: 64, opacity: 0.7 }} />
                  <span className="count-note">comparing against the fixed-bug corpus…</span>
                </div>
              )}
              {lineageState === 'done' && lineage && (
                <div>
                  {lineage.candidates.length === 0 && (
                    <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                      No plausible ancestor among {lineage.candidatesConsidered} fixed bugs. This one looks genuinely new.
                    </p>
                  )}
                  {lineage.candidates.map((c) => (
                    <article key={c.key} className={`lineage-candidate ${c.verdict}`}>
                      <div className="lc-top">
                        <Link to={`/issue/${c.key}`} className="key">
                          {c.key}
                        </Link>
                        <span className="title">{c.title}</span>
                        <span className={`verdict ${c.verdict}`}>{c.verdict === 'strong' ? 'strong match' : c.verdict === 'mixed' ? 'mixed signals' : 'weak'}</span>
                        <span className={`lc-agreement ${c.agreement < 0.75 ? 'disagree' : ''}`}>
                          {Math.round(c.agreement * 4)} of 4 signals concur · combined {(c.combined * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="signal-grid">
                        {(Object.entries(c.signals) as [string, { score: number; evidence: string }][]).map(([name, s]) => (
                          <div key={name} className="signal">
                            <div className="s-head">
                              <span className="s-name">{name}</span>
                              <span className="s-score">{(s.score * 100).toFixed(0)}%</span>
                            </div>
                            <div className="s-bar">
                              <i style={{ width: `${Math.max(2, s.score * 100)}%` }} />
                            </div>
                            <div className="s-evidence">{s.evidence}</div>
                          </div>
                        ))}
                      </div>
                      <div className="lc-actions">
                        <button
                          className="btn sm primary"
                          disabled={busy}
                          onClick={() =>
                            guard(
                              () => api.addRelation(issue.key, 'regression_of', c.key, actor.id),
                              `Confirmed: ${issue.key} is a regression of ${c.key}. Its watchers now follow this issue.`,
                            )
                          }
                        >
                          Confirm regression of {c.key}
                        </button>
                        <span className="note">confirming inherits the ancestor's watchers and links both histories</span>
                      </div>
                    </article>
                  ))}
                  <p className="count-note" style={{ margin: '4px 0 0' }}>
                    scanned {lineage.candidatesConsidered} fixed bugs · weights: lexical {lineage.weights.lexical}, trace {lineage.weights.trace},
                    structural {lineage.weights.structural}, timing {lineage.weights.timing}
                  </p>
                </div>
              )}
            </section>
          )}

          <div className="tabs rise rise-3" role="tablist">
            <button role="tab" aria-selected={tab === 'discussion'} className={tab === 'discussion' ? 'active' : ''} onClick={() => setTab('discussion')}>
              Discussion<span className="tab-count">{issue.comments.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              History<span className="tab-count">{issue.events.length}</span>
            </button>
          </div>

          {tab === 'discussion' && (
            <div>
              {issue.comments.length === 0 && (
                <p style={{ color: 'var(--text-faint)', fontSize: 13.5 }}>No discussion yet — first observation below sets the tone.</p>
              )}
              {issue.comments.map((cm) => {
                const author = actorById(cm.author_id);
                return (
                  <div key={cm.id} className="comment">
                    <Avatar actor={author} size="lg" />
                    <div className="body">
                      <div className="who">
                        <span className="name">{author?.name ?? 'Unknown'}</span>
                        {author && !author.active && <span className="chip">departed</span>}
                        <span className="when">{timeAgo(cm.created_at)}</span>
                      </div>
                      <Markdown text={cm.body} />
                    </div>
                  </div>
                );
              })}
              <div className="comment-form">
                <Avatar actor={actor} size="lg" />
                <div className="grow">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder={`Comment as ${actor.name}… (markdown supported)`}
                    aria-label="Add a comment"
                  />
                  <div className="actions">
                    <button
                      className="btn primary sm"
                      disabled={busy || !comment.trim()}
                      onClick={() =>
                        guard(async () => {
                          await api.comment(issue.key, comment, actor.id);
                          setComment('');
                        })
                      }
                    >
                      Comment
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div className="timeline" aria-label="Full audit history">
              {timelineDesc.map((ev) => (
                <TimelineItem key={ev.id} ev={ev} actorName={actorById(ev.actor_id)?.name ?? 'Unknown'} />
              ))}
            </div>
          )}
        </div>

        <aside className="side-rail rise rise-2">
          <div className="rail-section">
            <h4>Workflow</h4>
            <div className="rail-row">
              <span className="lbl">current</span>
              <StatusPill status={issue.status} resolution={issue.resolution} />
            </div>
            <div className="transition-row" style={{ marginTop: 8 }}>
              {issue.legalNextStates.map((s) => (
                <button
                  key={s}
                  className="btn sm"
                  disabled={busy}
                  onClick={() => {
                    if (s === 'resolved') {
                      setResolution('fixed');
                      setDupTarget('');
                      setResolveOpen(true);
                    } else {
                      void guard(() => api.transition(issue.key, { to: s, actorId: actor.id }), `${issue.key} → ${statusLabel(s)}`);
                    }
                  }}
                >
                  → {statusLabel(s)}
                </button>
              ))}
            </div>
            <p className="count-note" style={{ margin: '9px 0 0' }}>
              only legal moves are offered — and the server re-checks every one
            </p>
          </div>

          <div className="rail-section">
            <h4>Fields</h4>
            <div className="rail-row">
              <span className="lbl">assignee</span>
            </div>
            <select
              value={issue.assignee_id ?? ''}
              aria-label="Assignee"
              onChange={(e) => guard(() => api.updateIssue(issue.key, { assignee_id: e.target.value ? Number(e.target.value) : null }, actor.id))}
            >
              <option value="">Unassigned</option>
              {meta.actors
                .filter((a) => a.active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <div className="rail-row" style={{ marginTop: 8 }}>
              <span className="lbl">severity</span>
            </div>
            <select value={issue.severity} aria-label="Severity" onChange={(e) => guard(() => api.updateIssue(issue.key, { severity: e.target.value }, actor.id))}>
              {meta.severities.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="rail-row" style={{ marginTop: 8 }}>
              <span className="lbl">priority</span>
            </div>
            <select value={issue.priority} aria-label="Priority" onChange={(e) => guard(() => api.updateIssue(issue.key, { priority: e.target.value }, actor.id))}>
              {meta.priorities.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="rail-section">
            <h4>Watchers ({issue.watchers.length})</h4>
            <div className="watcher-stack">
              {issue.watchers.map((w) => (
                <Avatar key={w} actor={actorById(w)} />
              ))}
            </div>
            <button
              className="btn sm"
              style={{ marginTop: 10, width: '100%' }}
              disabled={busy}
              onClick={() => guard(() => api.watch(issue.key, actor.id, !watching), watching ? 'Unwatched.' : 'You now watch this issue.')}
            >
              {watching ? 'Stop watching' : 'Watch this issue'}
            </button>
          </div>

          <div className="rail-section">
            <h4>Relationships</h4>
            {issue.relations.length === 0 && <p className="count-note" style={{ margin: 0 }}>None yet.</p>}
            <div className="relation-list">
              {issue.relations.map((r) => (
                <div key={`${r.id}-${r.direction}`} className="relation-item">
                  <span className="kind">
                    {r.kind === 'blocks'
                      ? r.direction === 'out'
                        ? 'blocks'
                        : 'depends on'
                      : r.kind === 'duplicate_of'
                        ? r.direction === 'out'
                          ? 'duplicate of'
                          : 'duplicated by'
                        : r.direction === 'out'
                          ? 'regression of'
                          : 'regressed by'}
                  </span>
                  <Link to={`/issue/${r.other_key}`} className="key">
                    {r.other_key}
                  </Link>
                  <span className="title">{r.other_title}</span>
                  {r.kind !== 'duplicate_of' && (
                    <button
                      className="x"
                      aria-label={`Remove ${r.kind} relation to ${r.other_key}`}
                      disabled={busy}
                      onClick={() => guard(() => api.removeRelation(issue.key, r.id, actor.id), 'Relation removed.')}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="relation-form">
              <select value={relKind} onChange={(e) => setRelKind(e.target.value)} aria-label="Relation kind">
                <option value="blocks">blocks</option>
                <option value="regression_of">regression of</option>
              </select>
              <input value={relTarget} onChange={(e) => setRelTarget(e.target.value)} placeholder="KEY-123" aria-label="Target issue key" />
              <button
                className="btn sm"
                disabled={busy || !relTarget.trim()}
                onClick={() =>
                  guard(async () => {
                    await api.addRelation(issue.key, relKind, relTarget.trim().toUpperCase(), actor.id);
                    setRelTarget('');
                  }, 'Relation added.')
                }
              >
                Link
              </button>
            </div>
            <p className="count-note" style={{ margin: '8px 0 0' }}>
              cycles are rejected server-side · duplicates are marked by resolving as duplicate
            </p>
          </div>
        </aside>
      </div>

      {resolveOpen && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setResolveOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Resolve issue">
            <div className="dialog-head">
              <h2>
                Resolve <span className="key">{issue.key}</span>
              </h2>
              <button className="btn ghost sm" onClick={() => setResolveOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="dialog-body">
              <div className="field">
                <label htmlFor="iv-res">Resolution — why does this bug stop here?</label>
                <select id="iv-res" value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus>
                  {meta.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              {resolution === 'duplicate' && (
                <div className="field">
                  <label htmlFor="iv-dup">Canonical issue key</label>
                  <input id="iv-dup" value={dupTarget} onChange={(e) => setDupTarget(e.target.value)} placeholder="e.g. RELAY-42" style={{ textTransform: 'uppercase', fontFamily: 'var(--mono)' }} />
                  <span className="count-note">this issue's watchers merge into the canonical one</span>
                </div>
              )}
            </div>
            <div className="dialog-foot">
              <button className="btn" onClick={() => setResolveOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || (resolution === 'duplicate' && !dupTarget.trim())}
                onClick={() =>
                  guard(async () => {
                    await api.transition(issue.key, {
                      to: 'resolved',
                      actorId: actor.id,
                      resolution,
                      duplicateOf: resolution === 'duplicate' ? dupTarget.trim().toUpperCase() : undefined,
                    });
                    setResolveOpen(false);
                  }, `Resolved as ${resolution}.`)
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

function TimelineItem({ ev, actorName }: { ev: IssueEvent; actorName: string }) {
  const when = <span className="when">{timeAgo(ev.created_at)}</span>;
  const b = <b>{actorName}</b>;
  let line: React.ReactNode;
  switch (ev.kind) {
    case 'created':
      line = <>{b} filed this issue</>;
      break;
    case 'transitioned':
      line = (
        <>
          {b} moved <span style={{ color: `var(--st-${ev.from_value})` }}>{statusLabel(ev.from_value ?? '')}</span>
          <span className="arrow">→</span>
          <span style={{ color: `var(--st-${ev.to_value})` }}>{statusLabel(ev.to_value ?? '')}</span>
          {ev.detail?.startsWith('resolution:') ? <> as <b>{ev.detail.slice(11)}</b></> : null}
        </>
      );
      break;
    case 'reopened':
      line = (
        <>
          {b} <b style={{ color: 'var(--accent-bright)' }}>reopened</b> this issue (resolution cleared)
        </>
      );
      break;
    case 'assigned':
      line = <>{b} changed the assignee</>;
      break;
    case 'commented':
      line = <>{b} commented</>;
      break;
    case 'edited':
      line = (
        <>
          {b} edited <b>{ev.field === 'body' ? 'the description' : ev.field}</b>
          {ev.field !== 'body' && ev.from_value != null && ev.to_value != null ? (
            <>
              : {ev.from_value} <span className="arrow">→</span> {ev.to_value}
            </>
          ) : null}
        </>
      );
      break;
    case 'label_added':
      line = <>{b} added label <span className="chip">{ev.to_value}</span></>;
      break;
    case 'label_removed':
      line = <>{b} removed label <span className="chip">{ev.from_value}</span></>;
      break;
    case 'marked_duplicate':
    case 'absorbed_duplicate':
    case 'lineage_confirmed':
    case 'relation_added':
    case 'relation_removed':
      line = (
        <>
          {b} {ev.detail ?? ev.kind.replaceAll('_', ' ')}
        </>
      );
      break;
    default:
      line = (
        <>
          {b} {ev.kind.replaceAll('_', ' ')}
          {ev.detail ? ` — ${ev.detail}` : ''}
        </>
      );
  }
  return (
    <div className={`tl-item k-${ev.kind}`}>
      {line}
      {when}
    </div>
  );
}
