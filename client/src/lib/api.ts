// Thin typed client over the Quarry API. Every mutation carries the current
// actor id; every error is surfaced as a structured ApiFailure.

export interface Actor {
  id: number;
  name: string;
  handle: string;
  role: string;
  hue: number;
  active: number;
}

export interface Product {
  id: number;
  key: string;
  name: string;
  description: string;
}

export interface Component {
  id: number;
  product_id: number;
  name: string;
  description: string;
  lead_id: number | null;
}

export interface Meta {
  products: Product[];
  components: Component[];
  actors: Actor[];
  labels: string[];
  statuses: string[];
  resolutions: string[];
  severities: string[];
  priorities: string[];
  transitions: Record<string, string[]>;
}

export interface Issue {
  id: number;
  key: string;
  product_id: number;
  component_id: number;
  title: string;
  body: string;
  status: string;
  resolution: string | null;
  severity: string;
  priority: string;
  reporter_id: number;
  assignee_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  labels: string[];
  watchers: number[];
  legalNextStates: string[];
}

export interface Comment {
  id: number;
  issue_id: number;
  author_id: number;
  body: string;
  created_at: string;
}

export interface IssueEvent {
  id: number;
  issue_id: number;
  actor_id: number;
  kind: string;
  field: string | null;
  from_value: string | null;
  to_value: string | null;
  detail: string | null;
  created_at: string;
}

export interface Relation {
  id: number;
  kind: string;
  created_at: string;
  other_key: string;
  other_title: string;
  other_status: string;
  other_resolution: string | null;
  direction: 'in' | 'out';
}

export interface IssueDetail extends Issue {
  comments: Comment[];
  events: IssueEvent[];
  relations: Relation[];
}

export interface SignalScore {
  score: number;
  evidence: string;
}

export interface LineageCandidate {
  key: string;
  title: string;
  status: string;
  resolution: string | null;
  resolvedAt: string | null;
  combined: number;
  agreement: number;
  verdict: 'strong' | 'mixed' | 'weak';
  signals: Record<'lexical' | 'structural' | 'trace' | 'timing', SignalScore>;
}

export interface LineageReport {
  issueKey: string;
  candidatesConsidered: number;
  candidates: LineageCandidate[];
  weights: Record<string, number>;
}

export interface AncestryNode {
  key: string;
  title: string;
  status: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface AnalyticsSummary {
  weeks: { week: string; opened: number; resolved: number }[];
  statusDist: { status: string; n: number }[];
  severityDist: { severity: string; n: number }[];
  resolutionDist: { resolution: string; n: number }[];
  load: { id: number; name: string; handle: string; hue: number; active: number; n: number }[];
  mttrDays: number | null;
  oldestOpen: { key: string; title: string; created_at: string; severity: string; ageDays: number } | null;
  totals: { total: number; open: number; fixed: number };
  reopens: number;
  regressions: number;
}

export interface GraphData {
  nodes: { key: string; title: string; status: string; severity: string; product: string }[];
  edges: { kind: string; src: string; dst: string }[];
}

export class ApiFailure extends Error {
  code: string;
  status: number;
  legalNextStates?: string[];
  constructor(status: number, code: string, message: string, legalNextStates?: string[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.legalNextStates = legalNextStates;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiFailure(0, 'network', 'Could not reach the Quarry server. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiFailure(res.status, data.error ?? 'unknown', data.message ?? `Request failed (${res.status}).`, data.legalNextStates);
  }
  return data as T;
}

export const api = {
  meta: () => req<Meta>('/api/meta'),
  issues: (params: Record<string, string>) => req<{ total: number; issues: Issue[] }>(`/api/issues?${new URLSearchParams(params)}`),
  issue: (key: string) => req<IssueDetail>(`/api/issues/${key}`),
  createIssue: (body: unknown) => req<Issue>('/api/issues', { method: 'POST', body: JSON.stringify(body) }),
  updateIssue: (key: string, patch: Record<string, unknown>, actorId: number) =>
    req<Issue>(`/api/issues/${key}`, { method: 'PATCH', body: JSON.stringify({ ...patch, actorId }) }),
  transition: (key: string, body: { to: string; actorId: number; resolution?: string; duplicateOf?: string; comment?: string }) =>
    req<Issue>(`/api/issues/${key}/transition`, { method: 'POST', body: JSON.stringify(body) }),
  comment: (key: string, body: string, actorId: number) =>
    req<Comment>(`/api/issues/${key}/comments`, { method: 'POST', body: JSON.stringify({ body, actorId }) }),
  addRelation: (key: string, kind: string, target: string, actorId: number) =>
    req<Relation[]>(`/api/issues/${key}/relations`, { method: 'POST', body: JSON.stringify({ kind, target, actorId }) }),
  removeRelation: (key: string, id: number, actorId: number) =>
    req<Relation[]>(`/api/issues/${key}/relations/${id}`, { method: 'DELETE', body: JSON.stringify({ actorId }) }),
  watch: (key: string, actorId: number, watching: boolean) =>
    req<{ watchers: number[] }>(`/api/issues/${key}/watch`, { method: 'PUT', body: JSON.stringify({ actorId, watching }) }),
  lineage: (key: string) => req<LineageReport>(`/api/issues/${key}/lineage`),
  ancestry: (key: string) => req<{ chain: AncestryNode[] }>(`/api/issues/${key}/ancestry`),
  analytics: (product?: string) => req<AnalyticsSummary>(`/api/analytics/summary${product ? `?product=${product}` : ''}`),
  graph: () => req<GraphData>('/api/graph'),
  createProduct: (body: unknown) => req<Product>('/api/products', { method: 'POST', body: JSON.stringify(body) }),
  createComponent: (productKey: string, body: unknown) =>
    req<Component>(`/api/products/${productKey}/components`, { method: 'POST', body: JSON.stringify(body) }),
};

export function timeAgo(isoDate: string): string {
  const s = (Date.now() - new Date(isoDate).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

export function fmtDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
