import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, EmptyState, ErrorBanner, PriorityTag, SeverityGlyph, StatusPill, TableSkeleton, useActorById } from '../components/atoms';
import type { Issue } from '../lib/api';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/app-state';

// Triage: the workhorse list. Full-text search (FTS5 server-side), layered
// filters, sortable, fast on hundreds of rows. URL-driven so views are
// shareable and the palette can deep-link into filters.

export function TriageView() {
  const { meta } = useApp();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const actorById = useActorById();

  const [data, setData] = useState<{ total: number; issues: Issue[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState(params.get('q') ?? '');
  const debounce = useRef<number>(0);

  const get = (k: string) => params.get(k) ?? '';

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // debounce search box → URL
  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      if ((params.get('q') ?? '') !== qInput) setFilter('q', qInput);
    }, 220);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const query: Record<string, string> = { limit: '400' };
    for (const k of ['q', 'product', 'status', 'severity', 'priority', 'assignee', 'label', 'sort', 'open']) {
      const v = params.get(k);
      if (v) query[k] = v;
    }
    api
      .issues(query)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [params]);

  const componentName = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of meta?.components ?? []) m.set(c.id, c.name);
    return m;
  }, [meta]);

  const hasFilters = ['q', 'product', 'status', 'severity', 'priority', 'assignee', 'label', 'open'].some((k) => params.get(k));

  return (
    <div>
      <div className="page-head rise">
        <h1 className="page-title">Triage</h1>
        <span className="page-sub">
          {data ? `${data.total} issue${data.total === 1 ? '' : 's'}${hasFilters ? ' matching' : ''}` : '…'}
        </span>
        <span className="spacer" />
        {hasFilters && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setQInput('');
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="filter-bar rise rise-1">
        <div className="search">
          <svg width="14" height="14" viewBox="0 0 15 15" fill="none" aria-hidden>
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Full-text search: title, body, key, labels…" aria-label="Search issues" />
        </div>
        <select value={get('product')} onChange={(e) => setFilter('product', e.target.value)} aria-label="Filter by product">
          <option value="">All products</option>
          {meta?.products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key}
            </option>
          ))}
        </select>
        <select value={get('open') === 'true' ? 'open' : get('status')} onChange={(e) => {
          const v = e.target.value;
          const next = new URLSearchParams(params);
          next.delete('open');
          next.delete('status');
          if (v === 'open') next.set('open', 'true');
          else if (v) next.set('status', v);
          setParams(next, { replace: true });
        }} aria-label="Filter by status">
          <option value="">All states</option>
          <option value="open">Open (active)</option>
          {meta?.statuses.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select value={get('severity')} onChange={(e) => setFilter('severity', e.target.value)} aria-label="Filter by severity">
          <option value="">All severities</option>
          {meta?.severities.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={get('assignee')} onChange={(e) => setFilter('assignee', e.target.value)} aria-label="Filter by assignee">
          <option value="">Anyone</option>
          {meta?.actors
            .filter((a) => a.active)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select value={get('label')} onChange={(e) => setFilter('label', e.target.value)} aria-label="Filter by label">
          <option value="">Any label</option>
          {meta?.labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select value={get('sort') || 'updated'} onChange={(e) => setFilter('sort', e.target.value)} aria-label="Sort order">
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="severity">By severity</option>
          <option value="priority">By priority</option>
          <option value="key">By key</option>
        </select>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setParams(new URLSearchParams(params))} />}
      {loading && !data && <TableSkeleton rows={10} />}

      {data && data.issues.length === 0 && !loading && (
        <EmptyState glyph="◇" title="No issues match">
          {hasFilters ? 'Loosen a filter or clear them all — the bugs are still out there.' : 'A pristine tracker. File the first issue with C.'}
        </EmptyState>
      )}

      {data && data.issues.length > 0 && (
        <div className="rise rise-2" style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          <table className="issue-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Title</th>
                <th>Status</th>
                <th>Severity</th>
                <th>Priority</th>
                <th>Component</th>
                <th>Assignee</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.issues.map((issue) => (
                <tr
                  key={issue.key}
                  className="issue-row"
                  tabIndex={0}
                  onClick={() => nav(`/issue/${issue.key}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') nav(`/issue/${issue.key}`);
                  }}
                >
                  <td>
                    <span className="key">{issue.key}</span>
                  </td>
                  <td className="title-cell">
                    <span className="title-text">
                      {issue.title}
                      {issue.labels.length > 0 && (
                        <span className="labels">
                          {issue.labels.slice(0, 3).map((l) => (
                            <span key={l} className="chip">
                              {l}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </td>
                  <td>
                    <StatusPill status={issue.status} resolution={issue.resolution} />
                  </td>
                  <td>
                    <SeverityGlyph severity={issue.severity} />
                  </td>
                  <td>
                    <PriorityTag priority={issue.priority} />
                  </td>
                  <td>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-faint)' }}>
                      {componentName.get(issue.component_id) ?? '—'}
                    </span>
                  </td>
                  <td>
                    <Avatar actor={actorById(issue.assignee_id)} />
                  </td>
                  <td>
                    <span className="count-note">{timeAgo(issue.updated_at)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
