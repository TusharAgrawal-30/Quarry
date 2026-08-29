import type { DB } from './db.js';
import { nowIso, reindexIssue, withTransaction } from './db.js';
import type { Issue, Priority, RelationKind, Resolution, Severity, Status } from './domain/types.js';
import { PRIORITIES, SEVERITIES } from './domain/types.js';
import { isReopen, TRANSITIONS, validateTransition } from './domain/workflow.js';

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------- helpers ----------

export function getIssueByKey(db: DB, key: string): Issue {
  const issue = db.prepare('SELECT * FROM issues WHERE key = ?').get(key.toUpperCase()) as unknown as Issue | undefined;
  if (!issue) throw new ApiError(404, 'issue_not_found', `No issue with key ${key.toUpperCase()}.`);
  return issue;
}

function requireActor(db: DB, actorId: unknown): number {
  const id = Number(actorId);
  if (!Number.isInteger(id)) throw new ApiError(400, 'actor_required', 'actorId is required — every action is attributed to a person.');
  const actor = db.prepare('SELECT id FROM actors WHERE id = ?').get(id);
  if (!actor) throw new ApiError(400, 'unknown_actor', `No actor with id ${id}.`);
  return id;
}

function logEvent(
  db: DB,
  issueId: number,
  actorId: number,
  kind: string,
  fields: { field?: string; from?: string | null; to?: string | null; detail?: string; at?: string } = {},
): void {
  db.prepare(
    `INSERT INTO events (issue_id, actor_id, kind, field, from_value, to_value, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(issueId, actorId, kind, fields.field ?? null, fields.from ?? null, fields.to ?? null, fields.detail ?? null, fields.at ?? nowIso());
}

function touch(db: DB, issueId: number, at?: string): void {
  db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(at ?? nowIso(), issueId);
}

const labelsFor = (db: DB, issueId: number): string[] =>
  (db.prepare('SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label').all(issueId) as { label: string }[]).map((r) => r.label);

const watchersFor = (db: DB, issueId: number): number[] =>
  (db.prepare('SELECT actor_id FROM watchers WHERE issue_id = ?').all(issueId) as { actor_id: number }[]).map((r) => r.actor_id);

export function issueSummary(db: DB, issue: Issue) {
  return {
    ...issue,
    labels: labelsFor(db, issue.id),
    watchers: watchersFor(db, issue.id),
    legalNextStates: TRANSITIONS[issue.status],
  };
}

// ---------- issues ----------

export interface IssueFilters {
  product?: string;
  component?: string;
  status?: string;
  severity?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  q?: string;
  open?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export function listIssues(db: DB, f: IssueFilters) {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (f.q && f.q.trim()) {
    // FTS5 match over key/title/body/labels; quote each term to stay safe.
    const ftsQuery = f.q
      .trim()
      .split(/\s+/)
      .map((t) => `"${t.replaceAll('"', '')}"*`)
      .join(' ');
    where.push('i.id IN (SELECT rowid FROM issue_fts WHERE issue_fts MATCH ?)');
    params.push(ftsQuery);
  }
  if (f.product) {
    where.push('i.product_id = (SELECT id FROM products WHERE key = ?)');
    params.push(f.product.toUpperCase());
  }
  if (f.component) {
    where.push('i.component_id = ?');
    params.push(Number(f.component));
  }
  if (f.status) {
    const statuses = f.status.split(',');
    where.push(`i.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (f.open === 'true') where.push(`i.status NOT IN ('resolved','verified','closed')`);
  if (f.severity) {
    where.push('i.severity = ?');
    params.push(f.severity);
  }
  if (f.priority) {
    where.push('i.priority = ?');
    params.push(f.priority);
  }
  if (f.assignee) {
    where.push('i.assignee_id = ?');
    params.push(Number(f.assignee));
  }
  if (f.label) {
    where.push('i.id IN (SELECT issue_id FROM issue_labels WHERE label = ?)');
    params.push(f.label);
  }

  const sortMap: Record<string, string> = {
    updated: 'i.updated_at DESC',
    created: 'i.created_at DESC',
    severity: `CASE i.severity WHEN 'blocker' THEN 0 WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'normal' THEN 3 WHEN 'minor' THEN 4 ELSE 5 END, i.updated_at DESC`,
    priority: `i.priority ASC, i.updated_at DESC`,
    key: 'i.product_id ASC, i.seq DESC',
  };
  const orderBy = sortMap[f.sort ?? 'updated'] ?? sortMap.updated;
  const limit = Math.min(Math.max(Number(f.limit) || 500, 1), 1000);
  const offset = Math.max(Number(f.offset) || 0, 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM issues i ${whereSql}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT i.* FROM issues i ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as Issue[];

  return { total, issues: rows.map((i) => issueSummary(db, i)) };
}

export interface CreateIssueInput {
  productKey: string;
  componentId: number;
  title: string;
  body?: string;
  severity?: Severity;
  priority?: Priority;
  labels?: string[];
  assigneeId?: number | null;
  actorId: number;
  createdAt?: string; // seed only
}

const MAX_BODY_CHARS = 20_000;
const MAX_COMMENT_CHARS = 10_000;
const MAX_LABELS = 12;
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function validateLabels(raw: unknown[]): string[] {
  const labels = [...new Set(raw.map((l) => String(l).trim().toLowerCase()).filter(Boolean))];
  if (labels.length > MAX_LABELS) throw new ApiError(400, 'too_many_labels', `At most ${MAX_LABELS} labels per issue.`);
  for (const l of labels) {
    if (!LABEL_RE.test(l))
      throw new ApiError(400, 'invalid_label', `Label "${l}" is invalid — lowercase letters, digits, dots, dashes, underscores, max 40 chars.`);
  }
  return labels;
}

export function createIssue(db: DB, input: CreateIssueInput) {
  const actorId = requireActor(db, input.actorId);
  const title = (input.title ?? '').trim();
  if (!title) throw new ApiError(400, 'title_required', 'Issue title is required.');
  if (title.length > 200) throw new ApiError(400, 'title_too_long', 'Issue title must be 200 characters or fewer.');
  if (typeof input.body === 'string' && input.body.length > MAX_BODY_CHARS)
    throw new ApiError(400, 'body_too_long', `Description must be ${MAX_BODY_CHARS.toLocaleString('en-US')} characters or fewer.`);
  if (input.severity && !SEVERITIES.includes(input.severity))
    throw new ApiError(400, 'invalid_severity', `Severity must be one of: ${SEVERITIES.join(', ')}.`);
  if (input.priority && !PRIORITIES.includes(input.priority))
    throw new ApiError(400, 'invalid_priority', `Priority must be one of: ${PRIORITIES.join(', ')}.`);

  const product = db.prepare('SELECT * FROM products WHERE key = ?').get((input.productKey ?? '').toUpperCase()) as
    | { id: number; key: string; next_seq: number }
    | undefined;
  if (!product) throw new ApiError(400, 'unknown_product', `No product with key ${input.productKey}.`);
  const component = db.prepare('SELECT * FROM components WHERE id = ? AND product_id = ?').get(Number(input.componentId), product.id) as
    | { id: number }
    | undefined;
  if (!component) throw new ApiError(400, 'unknown_component', `Component ${input.componentId} does not exist under product ${product.key}.`);
  if (input.assigneeId != null) requireActor(db, input.assigneeId);

  const at = input.createdAt ?? nowIso();
  const seq = product.next_seq;
  const key = `${product.key}-${seq}`;
  const info = db
    .prepare(
      `INSERT INTO issues (key, product_id, component_id, seq, title, body, status, severity, priority, reporter_id, assignee_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?)`,
    )
    .run(key, product.id, component.id, seq, title, input.body ?? '', input.severity ?? 'normal', input.priority ?? 'p3', actorId, input.assigneeId ?? null, at, at);
  db.prepare('UPDATE products SET next_seq = next_seq + 1 WHERE id = ?').run(product.id);
  const issueId = Number(info.lastInsertRowid);

  for (const label of validateLabels(input.labels ?? [])) {
    db.prepare('INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)').run(issueId, label);
  }
  db.prepare('INSERT OR IGNORE INTO watchers (issue_id, actor_id) VALUES (?, ?)').run(issueId, actorId);
  logEvent(db, issueId, actorId, 'created', { at });
  reindexIssue(db, issueId);

  return issueSummary(db, db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) as unknown as Issue);
}

const EDITABLE: Record<string, (v: unknown, db: DB) => string | null> = {
  title: (v) => {
    const s = String(v ?? '').trim();
    if (!s) throw new ApiError(400, 'title_required', 'Issue title cannot be empty.');
    if (s.length > 200) throw new ApiError(400, 'title_too_long', 'Issue title must be 200 characters or fewer.');
    return s;
  },
  body: (v) => {
    const s = String(v ?? '');
    if (s.length > MAX_BODY_CHARS)
      throw new ApiError(400, 'body_too_long', `Description must be ${MAX_BODY_CHARS.toLocaleString('en-US')} characters or fewer.`);
    return s;
  },
  severity: (v) => {
    if (!SEVERITIES.includes(v as Severity)) throw new ApiError(400, 'invalid_severity', `Severity must be one of: ${SEVERITIES.join(', ')}.`);
    return v as string;
  },
  priority: (v) => {
    if (!PRIORITIES.includes(v as Priority)) throw new ApiError(400, 'invalid_priority', `Priority must be one of: ${PRIORITIES.join(', ')}.`);
    return v as string;
  },
  assignee_id: (v, db) => {
    if (v === null) return null;
    requireActor(db, v);
    return String(Number(v));
  },
};

export function updateIssue(db: DB, key: string, patch: Record<string, unknown>, actorId: number) {
  const actor = requireActor(db, actorId);
  const issue = getIssueByKey(db, key);

  const fields = Object.keys(patch).filter((k) => k !== 'labels');
  for (const f of fields) {
    if (!(f in EDITABLE)) throw new ApiError(400, 'uneditable_field', `Field "${f}" cannot be edited via this endpoint. Editable: ${Object.keys(EDITABLE).join(', ')}, labels. Status changes go through /transition.`);
  }

  withTransaction(db, () => {
    for (const f of fields) {
      const next = EDITABLE[f](patch[f], db);
      const prev = (issue as unknown as Record<string, unknown>)[f];
      const prevStr = prev == null ? null : String(prev);
      if (prevStr === next) continue;
      db.prepare(`UPDATE issues SET ${f} = ? WHERE id = ?`).run(next, issue.id);
      logEvent(db, issue.id, actor, f === 'assignee_id' ? 'assigned' : 'edited', { field: f, from: prevStr, to: next });
    }
    if (Array.isArray(patch.labels)) {
      const next = new Set(validateLabels(patch.labels as unknown[]));
      const prev = new Set(labelsFor(db, issue.id));
      for (const l of prev) if (!next.has(l)) {
        db.prepare('DELETE FROM issue_labels WHERE issue_id = ? AND label = ?').run(issue.id, l);
        logEvent(db, issue.id, actor, 'label_removed', { field: 'labels', from: l });
      }
      for (const l of next) if (!prev.has(l)) {
        db.prepare('INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)').run(issue.id, l);
        logEvent(db, issue.id, actor, 'label_added', { field: 'labels', to: l });
      }
    }
    touch(db, issue.id);
    reindexIssue(db, issue.id);
  });

  return issueSummary(db, getIssueByKey(db, key));
}

// ---------- transitions ----------

export interface TransitionRequest {
  to: Status;
  actorId: number;
  resolution?: Resolution | null;
  duplicateOf?: string | null;
  comment?: string;
}

export function transitionIssue(db: DB, key: string, req: TransitionRequest) {
  const actor = requireActor(db, req.actorId);
  const issue = getIssueByKey(db, key);

  const err = validateTransition({
    from: issue.status,
    to: req.to,
    resolution: req.resolution ?? null,
    assigneeId: issue.assignee_id,
    duplicateOfKey: req.duplicateOf ?? null,
  });
  if (err) throw new ApiError(409, err.code, err.message, { legalNextStates: err.legalNextStates, currentStatus: issue.status });

  let canonical: Issue | null = null;
  if (req.to === 'resolved' && req.resolution === 'duplicate') {
    canonical = getIssueByKey(db, req.duplicateOf!);
    if (canonical.id === issue.id) throw new ApiError(409, 'self_duplicate', 'An issue cannot be a duplicate of itself.');
    if (canonical.resolution === 'duplicate')
      throw new ApiError(409, 'duplicate_chain', `${canonical.key} is itself a duplicate — mark against the canonical issue instead.`);
  }

  const at = nowIso();
  withTransaction(db, () => {
    const reopen = isReopen(issue.status, req.to);
    const resolution = req.to === 'resolved' ? req.resolution! : reopen ? null : issue.resolution;
    const resolvedAt = req.to === 'resolved' ? at : reopen ? null : issue.resolved_at;

    db.prepare('UPDATE issues SET status = ?, resolution = ?, resolved_at = ?, updated_at = ? WHERE id = ?').run(
      req.to,
      resolution,
      resolvedAt,
      at,
      issue.id,
    );
    logEvent(db, issue.id, actor, reopen ? 'reopened' : 'transitioned', {
      field: 'status',
      from: issue.status,
      to: req.to,
      detail: req.to === 'resolved' ? `resolution:${req.resolution}` : reopen ? 'resolution cleared' : undefined,
      at,
    });

    if (canonical) {
      // Duplicate merge: relation + watcher union into the canonical issue,
      // so nobody following the duplicate loses the thread.
      db.prepare('INSERT OR IGNORE INTO relations (src_id, dst_id, kind, created_at) VALUES (?, ?, ?, ?)').run(
        issue.id,
        canonical.id,
        'duplicate_of',
        at,
      );
      const merged: number[] = [];
      for (const w of new Set([...watchersFor(db, issue.id), issue.reporter_id])) {
        const r = db.prepare('INSERT OR IGNORE INTO watchers (issue_id, actor_id) VALUES (?, ?)').run(canonical.id, w);
        if (r.changes > 0) merged.push(w);
      }
      logEvent(db, issue.id, actor, 'marked_duplicate', { detail: `duplicate of ${canonical.key}`, at });
      logEvent(db, canonical.id, actor, 'absorbed_duplicate', {
        detail: `${issue.key} marked as duplicate; ${merged.length} watcher${merged.length === 1 ? '' : 's'} merged`,
        at,
      });
      touch(db, canonical.id, at);
    }
    if (req.comment && req.comment.trim()) {
      db.prepare('INSERT INTO comments (issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?)').run(issue.id, actor, req.comment.trim(), at);
      logEvent(db, issue.id, actor, 'commented', { at });
    }
  });

  return issueSummary(db, getIssueByKey(db, key));
}

// ---------- relations ----------

/** DFS: would adding src -> dst (blocks) close a cycle? */
function wouldCycle(db: DB, srcId: number, dstId: number): boolean {
  const stack = [dstId];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === srcId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const next = db.prepare(`SELECT dst_id FROM relations WHERE src_id = ? AND kind = 'blocks'`).all(cur) as { dst_id: number }[];
    for (const n of next) stack.push(n.dst_id);
  }
  return false;
}

export function addRelation(db: DB, key: string, kind: RelationKind, targetKey: string, actorId: number) {
  const actor = requireActor(db, actorId);
  const src = getIssueByKey(db, key);
  const dst = getIssueByKey(db, targetKey);
  if (src.id === dst.id) throw new ApiError(409, 'self_relation', 'An issue cannot relate to itself.');

  if (kind === 'duplicate_of')
    throw new ApiError(400, 'use_transition', 'Duplicates are marked by resolving the issue with resolution "duplicate" — use the /transition endpoint so watcher history merges correctly.');
  if (kind !== 'blocks' && kind !== 'regression_of')
    throw new ApiError(400, 'invalid_relation_kind', 'Relation kind must be "blocks" or "regression_of".');

  if (kind === 'blocks' && wouldCycle(db, src.id, dst.id))
    throw new ApiError(409, 'dependency_cycle', `Adding "${src.key} blocks ${dst.key}" would create a dependency cycle.`);

  const exists = db.prepare('SELECT id FROM relations WHERE src_id = ? AND dst_id = ? AND kind = ?').get(src.id, dst.id, kind);
  if (exists) throw new ApiError(409, 'relation_exists', `${src.key} already ${kind === 'blocks' ? 'blocks' : 'is marked a regression of'} ${dst.key}.`);

  const at = nowIso();
  withTransaction(db, () => {
    db.prepare('INSERT INTO relations (src_id, dst_id, kind, created_at) VALUES (?, ?, ?, ?)').run(src.id, dst.id, kind, at);
    if (kind === 'blocks') {
      logEvent(db, src.id, actor, 'relation_added', { detail: `blocks ${dst.key}`, at });
      logEvent(db, dst.id, actor, 'relation_added', { detail: `depends on ${src.key}`, at });
    } else {
      // Confirming regression ancestry inherits the ancestor's watchers:
      // the people who cared about the original fix should hear it broke.
      let inherited = 0;
      for (const w of watchersFor(db, dst.id)) {
        const r = db.prepare('INSERT OR IGNORE INTO watchers (issue_id, actor_id) VALUES (?, ?)').run(src.id, w);
        if (r.changes > 0) inherited++;
      }
      logEvent(db, src.id, actor, 'lineage_confirmed', {
        detail: `confirmed as regression of ${dst.key}; inherited ${inherited} watcher${inherited === 1 ? '' : 's'}`,
        at,
      });
      logEvent(db, dst.id, actor, 'lineage_confirmed', { detail: `${src.key} confirmed as a regression of this fix`, at });
    }
    touch(db, src.id, at);
    touch(db, dst.id, at);
  });
  return relationsFor(db, src.id);
}

export function removeRelation(db: DB, key: string, relationId: number, actorId: number) {
  const actor = requireActor(db, actorId);
  const issue = getIssueByKey(db, key);
  const rel = db.prepare('SELECT * FROM relations WHERE id = ? AND (src_id = ? OR dst_id = ?)').get(relationId, issue.id, issue.id) as
    | { id: number; src_id: number; dst_id: number; kind: string }
    | undefined;
  if (!rel) throw new ApiError(404, 'relation_not_found', 'No such relation on this issue.');
  if (rel.kind === 'duplicate_of') throw new ApiError(409, 'immutable_relation', 'Duplicate links are cleared by reopening the duplicate issue, not by deleting the link.');
  db.prepare('DELETE FROM relations WHERE id = ?').run(rel.id);
  logEvent(db, issue.id, actor, 'relation_removed', { detail: rel.kind });
  touch(db, issue.id);
  return relationsFor(db, issue.id);
}

export function relationsFor(db: DB, issueId: number) {
  const out = db
    .prepare(
      `SELECT r.id, r.kind, r.created_at, i.key AS other_key, i.title AS other_title, i.status AS other_status, i.resolution AS other_resolution, 'out' AS direction
       FROM relations r JOIN issues i ON i.id = r.dst_id WHERE r.src_id = ?`,
    )
    .all(issueId);
  const inc = db
    .prepare(
      `SELECT r.id, r.kind, r.created_at, i.key AS other_key, i.title AS other_title, i.status AS other_status, i.resolution AS other_resolution, 'in' AS direction
       FROM relations r JOIN issues i ON i.id = r.src_id WHERE r.dst_id = ?`,
    )
    .all(issueId);
  return [...out, ...inc];
}

// ---------- comments & watchers ----------

export function addComment(db: DB, key: string, body: string, actorId: number) {
  const actor = requireActor(db, actorId);
  const issue = getIssueByKey(db, key);
  const text = (body ?? '').trim();
  if (!text) throw new ApiError(400, 'empty_comment', 'Comment body cannot be empty.');
  if (text.length > MAX_COMMENT_CHARS)
    throw new ApiError(400, 'comment_too_long', `Comments must be ${MAX_COMMENT_CHARS.toLocaleString('en-US')} characters or fewer.`);
  const at = nowIso();
  const info = db.prepare('INSERT INTO comments (issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?)').run(issue.id, actor, text, at);
  logEvent(db, issue.id, actor, 'commented', { at });
  db.prepare('INSERT OR IGNORE INTO watchers (issue_id, actor_id) VALUES (?, ?)').run(issue.id, actor);
  touch(db, issue.id, at);
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function setWatching(db: DB, key: string, actorId: number, watching: boolean) {
  const actor = requireActor(db, actorId);
  const issue = getIssueByKey(db, key);
  if (watching) db.prepare('INSERT OR IGNORE INTO watchers (issue_id, actor_id) VALUES (?, ?)').run(issue.id, actor);
  else db.prepare('DELETE FROM watchers WHERE issue_id = ? AND actor_id = ?').run(issue.id, actor);
  return { watchers: watchersFor(db, issue.id) };
}

// ---------- detail ----------

export function issueDetail(db: DB, key: string) {
  const issue = getIssueByKey(db, key);
  const comments = db.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC').all(issue.id);
  const events = db.prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY created_at ASC, id ASC').all(issue.id);
  return { ...issueSummary(db, issue), comments, events, relations: relationsFor(db, issue.id) };
}

// ---------- products & components ----------

export function createProduct(db: DB, input: { key?: string; name?: string; description?: string }) {
  const key = String(input.key ?? '').trim().toUpperCase();
  const name = String(input.name ?? '').trim();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key))
    throw new ApiError(400, 'invalid_product_key', 'Product key must be 2-10 characters, letters/digits, starting with a letter (e.g. RELAY).');
  if (!name) throw new ApiError(400, 'name_required', 'Product name is required.');
  const exists = db.prepare('SELECT id FROM products WHERE key = ?').get(key);
  if (exists) throw new ApiError(409, 'product_exists', `A product with key ${key} already exists.`);
  const info = db.prepare('INSERT INTO products (key, name, description) VALUES (?, ?, ?)').run(key, name, String(input.description ?? ''));
  return db.prepare('SELECT id, key, name, description FROM products WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function createComponent(db: DB, productKey: string, input: { name?: string; description?: string; leadId?: number | null }) {
  const product = db.prepare('SELECT id, key FROM products WHERE key = ?').get(productKey.toUpperCase()) as { id: number; key: string } | undefined;
  if (!product) throw new ApiError(404, 'product_not_found', `No product with key ${productKey.toUpperCase()}.`);
  const name = String(input.name ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,29}$/.test(name))
    throw new ApiError(400, 'invalid_component_name', 'Component name must be 2-30 lowercase characters (letters, digits, hyphens).');
  const exists = db.prepare('SELECT id FROM components WHERE product_id = ? AND name = ?').get(product.id, name);
  if (exists) throw new ApiError(409, 'component_exists', `Component "${name}" already exists under ${product.key}.`);
  if (input.leadId != null) {
    const lead = db.prepare('SELECT id FROM actors WHERE id = ?').get(Number(input.leadId));
    if (!lead) throw new ApiError(400, 'unknown_actor', `No actor with id ${input.leadId}.`);
  }
  const info = db
    .prepare('INSERT INTO components (product_id, name, description, lead_id) VALUES (?, ?, ?, ?)')
    .run(product.id, name, String(input.description ?? ''), input.leadId ?? null);
  return db.prepare('SELECT id, product_id, name, description, lead_id FROM components WHERE id = ?').get(Number(info.lastInsertRowid));
}
