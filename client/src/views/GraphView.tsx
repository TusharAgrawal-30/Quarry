import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState, ErrorBanner, TableSkeleton } from '../components/atoms';
import type { GraphData } from '../lib/api';
import { api } from '../lib/api';

// Dependency graph: every blocks / regression / duplicate edge in one map.
// Small force simulation run client-side; nodes settle into clusters.

interface Node {
  key: string;
  title: string;
  status: string;
  severity: string;
  product: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const W = 1180;
const H = 620;

const EDGE_COLORS: Record<string, string> = {
  blocks: 'rgba(210, 155, 98, 0.55)',
  regression_of: 'rgba(169, 146, 196, 0.7)',
  duplicate_of: 'rgba(127, 168, 155, 0.5)',
};

export function GraphView() {
  const nav = useNavigate();
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    api.graph().then(setData).catch((e) => setError(e.message));
  }, []);

  const layout = useMemo(() => {
    if (!data) return null;
    // deterministic pseudo-random start positions
    let s = 42;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const nodes: Node[] = data.nodes.map((n) => ({ ...n, x: 80 + rnd() * (W - 160), y: 60 + rnd() * (H - 120), vx: 0, vy: 0 }));
    const idx = new Map(nodes.map((n) => [n.key, n]));
    const edges = data.edges.filter((e) => idx.has(e.src) && idx.has(e.dst));

    // force iterations: repulsion + spring + center gravity
    for (let it = 0; it < 260; it++) {
      const t = 1 - it / 260;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, 40);
          const f = 2600 / d2;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          a.vx += dx * f * t;
          a.vy += dy * f * t;
          b.vx -= dx * f * t;
          b.vy -= dy * f * t;
        }
        a.vx += (W / 2 - a.x) * 0.0012;
        a.vy += (H / 2 - a.y) * 0.0022;
      }
      for (const e of edges) {
        const a = idx.get(e.src)!;
        const b = idx.get(e.dst)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const want = 110;
        const f = ((d - want) / d) * 0.014;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const n of nodes) {
        n.x = Math.min(W - 60, Math.max(60, n.x + n.vx));
        n.y = Math.min(H - 40, Math.max(36, n.y + n.vy));
        n.vx *= 0.72;
        n.vy *= 0.72;
      }
    }
    return { nodes, edges, idx };
  }, [data]);

  if (error) return <ErrorBanner message={error} onRetry={() => window.location.reload()} />;
  if (!data || !layout) return <TableSkeleton rows={7} />;

  const neighbors = new Set<string>();
  if (hover) {
    neighbors.add(hover);
    for (const e of layout.edges) {
      if (e.src === hover) neighbors.add(e.dst);
      if (e.dst === hover) neighbors.add(e.src);
    }
  }

  return (
    <div>
      <div className="page-head rise">
        <h1 className="page-title">Dependency graph</h1>
        <span className="page-sub">
          every relationship in the tracker — blockers, regressions, duplicates. {layout.nodes.length} issues, {layout.edges.length} links.
        </span>
      </div>

      {layout.nodes.length === 0 ? (
        <EmptyState glyph="◉" title="No relationships yet">
          Link two issues from an issue page (blocks / regression of) and the graph draws itself.
        </EmptyState>
      ) : (
        <div className="graph-wrap rise rise-1">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Issue dependency graph">
            <defs>
              <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0.5 L7,4 L0,7.5" fill="none" stroke="rgba(210,155,98,0.8)" strokeWidth="1.1" />
              </marker>
            </defs>
            {layout.edges.map((e, i) => {
              const a = layout.idx.get(e.src)!;
              const b = layout.idx.get(e.dst)!;
              const dim = hover && !(neighbors.has(e.src) && neighbors.has(e.dst));
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={EDGE_COLORS[e.kind] ?? 'rgba(236,220,198,0.3)'}
                  strokeWidth={e.kind === 'regression_of' ? 1.8 : 1.2}
                  strokeDasharray={e.kind === 'duplicate_of' ? '3 4' : undefined}
                  opacity={dim ? 0.12 : 1}
                  markerEnd={e.kind === 'blocks' ? 'url(#arr)' : undefined}
                />
              );
            })}
            {layout.nodes.map((n) => {
              const dim = hover ? !neighbors.has(n.key) : false;
              const r = n.severity === 'blocker' || n.severity === 'critical' ? 7.5 : 5.5;
              return (
                <g
                  key={n.key}
                  className="graph-node"
                  transform={`translate(${n.x},${n.y})`}
                  opacity={dim ? 0.2 : 1}
                  onMouseEnter={() => setHover(n.key)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => nav(`/issue/${n.key}`)}
                  tabIndex={0}
                  role="link"
                  aria-label={`${n.key}: ${n.title}`}
                  onKeyDown={(e) => e.key === 'Enter' && nav(`/issue/${n.key}`)}
                >
                  <circle r={r + 5} fill="transparent" />
                  <circle r={r} fill={`var(--st-${n.status})`} opacity={0.9} />
                  <circle r={r} fill="none" stroke="rgba(0,0,0,0.4)" />
                  <text y={-r - 5} textAnchor="middle">
                    {n.key}
                  </text>
                  {hover === n.key && (
                    <text y={r + 14} textAnchor="middle" style={{ fill: 'var(--text)', fontSize: 11 }}>
                      {n.title.length > 60 ? `${n.title.slice(0, 57)}…` : n.title}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="graph-legend">
            <span>
              <span className="sw" style={{ background: EDGE_COLORS.blocks, width: 14, height: 2, borderRadius: 1 }} /> blocks →
            </span>
            <span>
              <span className="sw" style={{ background: EDGE_COLORS.regression_of, width: 14, height: 2, borderRadius: 1 }} /> regression lineage
            </span>
            <span>
              <span className="sw" style={{ background: EDGE_COLORS.duplicate_of, width: 14, height: 2, borderRadius: 1 }} /> duplicate
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
