import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Avatar, ErrorBanner, statusLabel, TableSkeleton } from '../components/atoms';
import type { AnalyticsSummary } from '../lib/api';
import { api } from '../lib/api';
import { useApp } from '../lib/app-state';

// Analytics: every number on this page is computed server-side from the
// actual rows — trends, distributions, load, MTTR, oldest open, reopens.

export function AnalyticsView() {
  const { meta } = useApp();
  const [params, setParams] = useSearchParams();
  const product = params.get('product') ?? '';
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .analytics(product || undefined)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [product]);

  if (error) return <ErrorBanner message={error} onRetry={() => setParams(new URLSearchParams(params))} />;

  return (
    <div>
      <div className="page-head rise">
        <h1 className="page-title">Analytics</h1>
        <span className="page-sub">computed live from the tracker — nothing decorative</span>
        <span className="spacer" />
        <select
          value={product}
          onChange={(e) => {
            const next = new URLSearchParams();
            if (e.target.value) next.set('product', e.target.value);
            setParams(next, { replace: true });
          }}
          aria-label="Scope analytics to product"
        >
          <option value="">All products</option>
          {meta?.products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {!data && <TableSkeleton rows={8} />}

      {data && (
        <>
          <div className="stat-grid rise rise-1">
            <div className="stat-card">
              <div className="v">{data.totals.open}</div>
              <div className="l">Open issues</div>
              <div className="d">of {data.totals.total} total</div>
            </div>
            <div className="stat-card">
              <div className="v">
                {data.mttrDays ?? '—'}
                <span className="unit">days</span>
              </div>
              <div className="l">Mean time to resolution</div>
              <div className="d">created → resolved, fixed only</div>
            </div>
            <div className="stat-card">
              <div className="v">{data.reopens}</div>
              <div className="l">Reopens</div>
              <div className="d">fixes that didn't stick</div>
            </div>
            <div className="stat-card">
              <div className="v">{data.regressions}</div>
              <div className="l">Confirmed regressions</div>
              <div className="d">via lineage ancestry links</div>
            </div>
            {data.oldestOpen && (
              <div className="stat-card">
                <div className="v">
                  {data.oldestOpen.ageDays}
                  <span className="unit">days</span>
                </div>
                <div className="l">Oldest open issue</div>
                <div className="d">
                  <Link to={`/issue/${data.oldestOpen.key}`} className="key">
                    {data.oldestOpen.key}
                  </Link>{' '}
                  · {data.oldestOpen.severity}
                </div>
              </div>
            )}
          </div>

          <div className="chart-grid">
            <div className="chart-card wide rise rise-2">
              <h3>Opened vs resolved — last 26 weeks</h3>
              <TrendChart weeks={data.weeks} />
              <div className="legend">
                <span>
                  <span className="sw" style={{ background: 'var(--accent)' }} />
                  opened
                </span>
                <span>
                  <span className="sw" style={{ background: 'var(--ok)' }} />
                  resolved
                </span>
              </div>
            </div>

            <div className="chart-card rise rise-3">
              <h3>Status distribution</h3>
              {data.statusDist
                .slice()
                .sort((a, b) => b.n - a.n)
                .map((row) => (
                  <HBar key={row.status} label={statusLabel(row.status)} n={row.n} max={Math.max(...data.statusDist.map((r) => r.n))} color={`var(--st-${row.status})`} />
                ))}
            </div>

            <div className="chart-card rise rise-3">
              <h3>Open issues by severity</h3>
              {data.severityDist
                .slice()
                .sort((a, b) => b.n - a.n)
                .map((row) => (
                  <HBar key={row.severity} label={row.severity} n={row.n} max={Math.max(...data.severityDist.map((r) => r.n))} color={`var(--sv-${row.severity})`} />
                ))}
            </div>

            <div className="chart-card rise rise-4">
              <h3>Active load per assignee</h3>
              {data.load.length === 0 && <p className="count-note">Nothing assigned.</p>}
              {data.load.map((a) => (
                <div key={a.id} className="hbar-row">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                    <Avatar actor={{ ...a, role: '', handle: a.handle }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  </span>
                  <span className="track">
                    <span className="fill" style={{ width: `${(a.n / Math.max(...data.load.map((x) => x.n))) * 100}%`, background: 'var(--accent)' }} />
                  </span>
                  <span className="n">{a.n}</span>
                </div>
              ))}
            </div>

            <div className="chart-card rise rise-4">
              <h3>How bugs end — resolutions</h3>
              {data.resolutionDist
                .slice()
                .sort((a, b) => b.n - a.n)
                .map((row) => (
                  <HBar
                    key={row.resolution}
                    label={row.resolution}
                    n={row.n}
                    max={Math.max(...data.resolutionDist.map((r) => r.n))}
                    color={row.resolution === 'fixed' ? 'var(--ok)' : row.resolution === 'duplicate' ? 'var(--st-verified)' : 'var(--text-faint)'}
                  />
                ))}
              <p className="count-note" style={{ marginTop: 10 }}>
                resolution is a first-class field — “closed” alone never tells you whether it was actually fixed
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function HBar({ label, n, max, color }: { label: string; n: number; max: number; color: string }) {
  return (
    <div className="hbar-row">
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="track">
        <span className="fill" style={{ width: `${(n / Math.max(max, 1)) * 100}%`, background: color }} />
      </span>
      <span className="n">{n}</span>
    </div>
  );
}

function TrendChart({ weeks }: { weeks: { week: string; opened: number; resolved: number }[] }) {
  const W = 920;
  const H = 190;
  const PAD = { l: 30, r: 8, t: 12, b: 22 };

  const { openedPath, resolvedPath, openedArea, maxY, ticks } = useMemo(() => {
    const max = Math.max(1, ...weeks.map((w) => Math.max(w.opened, w.resolved)));
    const maxY = Math.ceil(max / 5) * 5;
    const x = (i: number) => PAD.l + (i / (weeks.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => H - PAD.b - (v / maxY) * (H - PAD.t - PAD.b);
    const line = (get: (w: { opened: number; resolved: number }) => number) =>
      weeks.map((w, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(get(w)).toFixed(1)}`).join(' ');
    const openedPath = line((w) => w.opened);
    const resolvedPath = line((w) => w.resolved);
    const openedArea = `${openedPath} L${x(weeks.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
    const ticks = [0, maxY / 2, maxY].map((v) => ({ v, y: y(v) }));
    return { openedPath, resolvedPath, openedArea, maxY, ticks };
  }, [weeks]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Opened vs resolved per week, peak ${maxY}`}>
      {ticks.map((t) => (
        <g key={t.v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={t.y} y2={t.y} stroke="rgba(236,220,198,0.07)" />
          <text x={PAD.l - 7} y={t.y + 3.5} textAnchor="end" fontSize="10" fill="var(--text-faint)">
            {t.v}
          </text>
        </g>
      ))}
      <path d={openedArea} fill="rgba(210,155,98,0.08)" />
      <path d={openedPath} fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />
      <path d={resolvedPath} fill="none" stroke="var(--ok)" strokeWidth="1.8" strokeLinejoin="round" strokeDasharray="none" />
      {weeks.map((w, i) =>
        i % 5 === 0 ? (
          <text key={w.week} x={PAD.l + (i / (weeks.length - 1)) * (W - PAD.l - PAD.r)} y={H - 6} textAnchor="middle" fontSize="9.5" fill="var(--text-faint)">
            {w.week.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
