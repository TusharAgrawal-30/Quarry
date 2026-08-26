import type { DB } from '../db.js';

// Real metrics computed from real rows — no decorative numbers.

export function analyticsSummary(db: DB, productKey?: string) {
  const productFilter = productKey ? `AND product_id = (SELECT id FROM products WHERE key = '${productKey.toUpperCase().replaceAll("'", '')}')` : '';

  // Opened vs resolved per ISO week, last 26 weeks.
  const weeks: { week: string; opened: number; resolved: number }[] = [];
  const now = new Date();
  for (let w = 25; w >= 0; w--) {
    const end = new Date(now.getTime() - w * 7 * 86_400_000);
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const opened = (
      db.prepare(`SELECT COUNT(*) n FROM issues WHERE created_at >= ? AND created_at < ? ${productFilter}`).get(start.toISOString(), end.toISOString()) as { n: number }
    ).n;
    const resolved = (
      db
        .prepare(`SELECT COUNT(*) n FROM issues WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at < ? ${productFilter}`)
        .get(start.toISOString(), end.toISOString()) as { n: number }
    ).n;
    weeks.push({ week: end.toISOString().slice(0, 10), opened, resolved });
  }

  const statusDist = db.prepare(`SELECT status, COUNT(*) n FROM issues WHERE 1=1 ${productFilter} GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  const severityDist = db
    .prepare(`SELECT severity, COUNT(*) n FROM issues WHERE status NOT IN ('resolved','verified','closed') ${productFilter} GROUP BY severity`)
    .all() as { severity: string; n: number }[];
  const resolutionDist = db
    .prepare(`SELECT resolution, COUNT(*) n FROM issues WHERE resolution IS NOT NULL ${productFilter} GROUP BY resolution`)
    .all() as { resolution: string; n: number }[];

  const load = db
    .prepare(
      `SELECT a.id, a.name, a.handle, a.hue, a.active, COUNT(i.id) n
       FROM actors a JOIN issues i ON i.assignee_id = a.id
       WHERE i.status NOT IN ('resolved','verified','closed') ${productFilter}
       GROUP BY a.id ORDER BY n DESC`,
    )
    .all() as { id: number; name: string; handle: string; hue: number; active: number; n: number }[];

  // Mean time to resolution (created -> first resolution), fixed bugs only.
  const mttrRow = db
    .prepare(
      `SELECT AVG(julianday(resolved_at) - julianday(created_at)) days
       FROM issues WHERE resolution = 'fixed' AND resolved_at IS NOT NULL ${productFilter}`,
    )
    .get() as { days: number | null };

  const oldest = db
    .prepare(
      `SELECT key, title, created_at, severity FROM issues
       WHERE status NOT IN ('resolved','verified','closed') ${productFilter}
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as { key: string; title: string; created_at: string; severity: string } | undefined;

  const totals = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status NOT IN ('resolved','verified','closed') THEN 1 ELSE 0 END) open,
              SUM(CASE WHEN resolution = 'fixed' THEN 1 ELSE 0 END) fixed
       FROM issues WHERE 1=1 ${productFilter}`,
    )
    .get() as { total: number; open: number; fixed: number };

  const reopens = (db.prepare(`SELECT COUNT(*) n FROM events e JOIN issues i ON i.id = e.issue_id WHERE e.kind = 'reopened' ${productFilter.replaceAll('product_id', 'i.product_id')}`).get() as { n: number }).n;
  const regressions = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM relations r JOIN issues i ON i.id = r.src_id WHERE r.kind = 'regression_of' ${productFilter.replaceAll('product_id', 'i.product_id')}`,
      )
      .get() as { n: number }
  ).n;

  return {
    weeks,
    statusDist,
    severityDist,
    resolutionDist,
    load,
    mttrDays: mttrRow.days != null ? Math.round(mttrRow.days * 10) / 10 : null,
    oldestOpen: oldest
      ? { ...oldest, ageDays: Math.floor((Date.now() - new Date(oldest.created_at).getTime()) / 86_400_000) }
      : null,
    totals,
    reopens,
    regressions,
  };
}

/** Nodes + edges for the dependency graph view. */
export function dependencyGraph(db: DB, productKey?: string) {
  const productFilter = productKey ? `AND i.product_id = (SELECT id FROM products WHERE key = '${productKey.toUpperCase().replaceAll("'", '')}')` : '';
  const edges = db
    .prepare(
      `SELECT r.kind, s.key AS src, d.key AS dst
       FROM relations r JOIN issues s ON s.id = r.src_id JOIN issues d ON d.id = r.dst_id
       WHERE r.kind IN ('blocks','regression_of','duplicate_of')`,
    )
    .all() as { kind: string; src: string; dst: string }[];
  const keys = new Set<string>();
  for (const e of edges) {
    keys.add(e.src);
    keys.add(e.dst);
  }
  const nodes = keys.size
    ? (db
        .prepare(
          `SELECT i.key, i.title, i.status, i.severity, p.key AS product FROM issues i JOIN products p ON p.id = i.product_id
           WHERE i.key IN (${[...keys].map(() => '?').join(',')}) ${productFilter}`,
        )
        .all(...keys) as { key: string; title: string; status: string; severity: string; product: string }[])
    : [];
  const nodeKeys = new Set(nodes.map((n) => n.key));
  return { nodes, edges: edges.filter((e) => nodeKeys.has(e.src) && nodeKeys.has(e.dst)) };
}
