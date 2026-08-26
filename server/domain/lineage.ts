import type { DB } from '../db.js';
import type { Issue } from './types.js';

// ─── Lineage: regression-ancestry detection ────────────────────────────────
//
// Question answered: "is this newly filed bug actually an old, already-fixed
// bug that has come back?" Trackers treat every new report as ground zero;
// in reality a large share of incoming bugs are regressions of past fixes,
// and the context from the original investigation (root cause, the fix, who
// understood it) is exactly what the new assignee needs on day one.
//
// Four INDEPENDENT signals are computed per candidate ancestor. They are
// deliberately not blended into one falsely-confident number first — each is
// shown to the user, and cross-signal agreement is measured explicitly. Two
// strong signals that disagree with two weak ones is information, not noise.
//
//   lexical    — TF-IDF cosine similarity of title+body against the corpus
//   structural — same component + label overlap (where in the product it bit)
//   trace      — overlap of file paths / stack frames extracted from bodies
//   timing     — how recently the candidate's fix was verified/closed
//                (regressions cluster shortly after a fix ships or is touched)

export interface SignalScore {
  score: number; // 0..1
  evidence: string;
}

export interface LineageCandidate {
  key: string;
  title: string;
  status: string;
  resolution: string | null;
  resolvedAt: string | null;
  componentId: number;
  combined: number;
  agreement: number; // 0..1 cross-signal consensus
  verdict: 'strong' | 'mixed' | 'weak';
  signals: Record<'lexical' | 'structural' | 'trace' | 'timing', SignalScore>;
}

const STOP = new Set(
  'a an the and or but if then else when while for of on in to from with without is are was were be been being do does did not no yes it its this that these those i we you they he she as at by so than too very can could should would will just into over under again there here what which who whom whose how why all any both each few more most other some such only own same s t don now'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_./-]{2,}/g) ?? []).filter((t) => !STOP.has(t));
}

/** Extract stack-frame-ish evidence: file paths, `pkg/mod.fn` frames, error class names. */
export function extractTraceMarkers(text: string): Set<string> {
  const markers = new Set<string>();
  for (const m of text.matchAll(/[\w@/-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java|c|cpp|sql)(?::\d+)?/gi)) {
    markers.add(m[0].toLowerCase().replace(/:\d+$/, ''));
  }
  for (const m of text.matchAll(/\b(?:at\s+)?([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)\s*\(/g)) {
    markers.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z]*(?:Error|Exception|Panic|Fault))\b/g)) {
    markers.add(m[1].toLowerCase());
  }
  return markers;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, wa] of small) {
    const wb = large.get(term);
    if (wb) dot += wa * wb;
  }
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  const na = norm(a);
  const nb = norm(b);
  return na && nb ? dot / (na * nb) : 0;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function topShared(a: Map<string, number>, b: Map<string, number>, n: number): string[] {
  const shared: [string, number][] = [];
  for (const [term, wa] of a) {
    const wb = b.get(term);
    if (wb) shared.push([term, wa * wb]);
  }
  return shared.sort((x, y) => y[1] - x[1]).slice(0, n).map(([t]) => t);
}

export interface LineageReport {
  issueKey: string;
  candidatesConsidered: number;
  candidates: LineageCandidate[];
  weights: Record<string, number>;
}

const WEIGHTS = { lexical: 0.35, structural: 0.2, trace: 0.3, timing: 0.15 } as const;

export function computeLineage(db: DB, issue: Issue, labels: string[]): LineageReport {
  // Candidate ancestors: fixed bugs in the same product that predate this one.
  const candidates = db
    .prepare(
      `SELECT * FROM issues
       WHERE product_id = ? AND id != ? AND resolution = 'fixed'
         AND status IN ('resolved','verified','closed')
         AND created_at < ?`,
    )
    .all(issue.product_id, issue.id, issue.created_at) as unknown as Issue[];

  // TF-IDF over the candidate corpus + the subject issue.
  const docs = [issue, ...candidates].map((i) => tokenize(`${i.title} ${i.title} ${i.body}`)); // title counted twice
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const vectors = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [t, f] of tf) vec.set(t, (1 + Math.log(f)) * Math.log(1 + N / (df.get(t) ?? 1)));
    return vec;
  });
  const subjectVec = vectors[0];
  const subjectTrace = extractTraceMarkers(`${issue.title}\n${issue.body}`);
  const subjectLabels = new Set(labels);

  const labelRows = db
    .prepare(`SELECT issue_id, label FROM issue_labels WHERE issue_id IN (${candidates.map(() => '?').join(',') || 'NULL'})`)
    .all(...candidates.map((c) => c.id)) as { issue_id: number; label: string }[];
  const labelMap = new Map<number, Set<string>>();
  for (const r of labelRows) {
    if (!labelMap.has(r.issue_id)) labelMap.set(r.issue_id, new Set());
    labelMap.get(r.issue_id)!.add(r.label);
  }

  const issueTime = new Date(issue.created_at).getTime();
  const scored: LineageCandidate[] = candidates.map((c, idx) => {
    const vec = vectors[idx + 1];

    // 1. lexical
    const lex = cosine(subjectVec, vec);
    const sharedTerms = topShared(subjectVec, vec, 4);
    const lexical: SignalScore = {
      score: Math.min(1, lex * 1.6),
      evidence: sharedTerms.length ? `shared terms: ${sharedTerms.join(', ')}` : 'no meaningful term overlap',
    };

    // 2. structural
    const sameComponent = c.component_id === issue.component_id;
    const labelSim = jaccard(subjectLabels, labelMap.get(c.id) ?? new Set());
    const structural: SignalScore = {
      score: (sameComponent ? 0.7 : 0) + 0.3 * labelSim,
      evidence: sameComponent
        ? labelSim > 0
          ? `same component, ${Math.round(labelSim * 100)}% label overlap`
          : 'same component'
        : labelSim > 0
          ? `different component, ${Math.round(labelSim * 100)}% label overlap`
          : 'different component, no shared labels',
    };

    // 3. trace
    const candTrace = extractTraceMarkers(`${c.title}\n${c.body}`);
    const traceSim = jaccard(subjectTrace, candTrace);
    const sharedMarkers = [...subjectTrace].filter((m) => candTrace.has(m)).slice(0, 3);
    const trace: SignalScore = {
      score: subjectTrace.size && candTrace.size ? Math.min(1, traceSim * 2.2) : 0,
      evidence: sharedMarkers.length
        ? `shared frames: ${sharedMarkers.join(', ')}`
        : subjectTrace.size
          ? 'no overlapping frames or files'
          : 'no trace markers in this report',
    };

    // 4. timing — regressions surface soon after the ancestor's fix landed.
    let timing: SignalScore = { score: 0, evidence: 'ancestor has no resolution date' };
    if (c.resolved_at) {
      const gapDays = (issueTime - new Date(c.resolved_at).getTime()) / 86_400_000;
      if (gapDays < 0) timing = { score: 0, evidence: 'ancestor was fixed after this report' };
      else {
        const score = Math.exp(-gapDays / 45); // half-life ≈ 31 days
        timing = { score, evidence: `fix shipped ${Math.round(gapDays)} day${Math.round(gapDays) === 1 ? '' : 's'} before this report` };
      }
    }

    const combined =
      WEIGHTS.lexical * lexical.score + WEIGHTS.structural * structural.score + WEIGHTS.trace * trace.score + WEIGHTS.timing * timing.score;

    // Agreement: how many of the four independent signals "vote yes"
    // (score ≥ 0.4). One loud signal against three silent ones is a
    // different situation from four quiet agreements — show which it is.
    const values = [lexical.score, structural.score, trace.score, timing.score];
    const votes = values.filter((v) => v >= 0.4).length;
    const agreement = votes / values.length;

    const verdict: LineageCandidate['verdict'] =
      combined >= 0.45 && votes >= 3 ? 'strong' : combined >= 0.28 ? 'mixed' : 'weak';

    return {
      key: c.key,
      title: c.title,
      status: c.status,
      resolution: c.resolution,
      resolvedAt: c.resolved_at,
      componentId: c.component_id,
      combined: Math.round(combined * 1000) / 1000,
      agreement: Math.round(agreement * 1000) / 1000,
      verdict,
      signals: {
        lexical: { ...lexical, score: Math.round(lexical.score * 1000) / 1000 },
        structural: { ...structural, score: Math.round(structural.score * 1000) / 1000 },
        trace: { ...trace, score: Math.round(trace.score * 1000) / 1000 },
        timing: { ...timing, score: Math.round(timing.score * 1000) / 1000 },
      },
    };
  });

  scored.sort((a, b) => b.combined - a.combined);
  return {
    issueKey: issue.key,
    candidatesConsidered: candidates.length,
    candidates: scored.filter((c) => c.combined > 0.08).slice(0, 5),
    weights: { ...WEIGHTS },
  };
}

/** Walk confirmed regression_of edges to build the full ancestry chain. */
export function ancestryChain(db: DB, issueId: number): { key: string; title: string; status: string; resolution: string | null; resolved_at: string | null; created_at: string }[] {
  const chain: number[] = [];
  let cur: number | undefined = issueId;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    const next = db.prepare(`SELECT dst_id FROM relations WHERE src_id = ? AND kind = 'regression_of' LIMIT 1`).get(cur) as
      | { dst_id: number }
      | undefined;
    cur = next?.dst_id;
  }
  return chain.map(
    (id) =>
      db.prepare('SELECT key, title, status, resolution, resolved_at, created_at FROM issues WHERE id = ?').get(id) as {
        key: string;
        title: string;
        status: string;
        resolution: string | null;
        resolved_at: string | null;
        created_at: string;
      },
  );
}
