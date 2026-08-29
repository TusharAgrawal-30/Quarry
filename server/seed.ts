import type { DB } from './db.js';
import { reindexIssue, withTransaction } from './db.js';
import type { Priority, Severity, Status } from './domain/types.js';

// Deterministic seeded corpus: three products, ~320 issues over ~18 months,
// full event histories consistent with each issue's final state, comments,
// watcher lists, dependency chains, duplicates, and a pre-wired regression
// scenario so the Lineage engine has honest material to compute over.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260826);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + rand() * (b - a);

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();

// ---------- people ----------

const ACTORS: [string, string, string, number, number][] = [
  // name, handle, role, hue, active
  ['Mara Okafor', 'mara', 'Backend', 24, 1],
  ['Dev Chandra', 'dev', 'Backend', 36, 1],
  ['Lena Vogel', 'lena', 'Frontend', 16, 1],
  ['Tomás Reyes', 'tomas', 'Frontend', 42, 1],
  ['Priya Nair', 'priya', 'Infra', 30, 1],
  ['Jonas Lindqvist', 'jonas', 'Infra', 20, 1],
  ['Aiko Tanaka', 'aiko', 'QA', 48, 1],
  ['Sam Whitfield', 'sam', 'QA', 12, 1],
  ['Noor Haddad', 'noor', 'Product', 33, 1],
  ['Felix Braun', 'felix', 'Backend', 27, 0],
  ['Ines Moreau', 'ines', 'Frontend', 39, 0],
  ['Rui Costa', 'rui', 'Support', 21, 1],
];

// ---------- products & vocabulary ----------

interface ComponentSpec {
  name: string;
  description: string;
  areas: string[]; // subsystem nouns
  files: string[];
}

interface ProductSpec {
  key: string;
  name: string;
  description: string;
  components: ComponentSpec[];
  count: number;
}

const PRODUCTS: ProductSpec[] = [
  {
    key: 'RELAY',
    name: 'Relay',
    description: 'Realtime messaging backend: websocket gateway, presence, delivery, and webhooks.',
    count: 140,
    components: [
      { name: 'gateway', description: 'Websocket ingress, TLS, handshakes, connection lifecycle', areas: ['websocket handshake', 'TLS session resume', 'connection pool', 'heartbeat loop', 'frame parser'], files: ['gateway/socket.ts', 'gateway/tls_resume.ts', 'gateway/heartbeat.ts', 'gateway/frames.ts'] },
      { name: 'presence', description: 'Online/offline state, typing indicators, fan-out', areas: ['presence fan-out', 'typing indicator', 'status cache', 'subscription registry'], files: ['presence/fanout.ts', 'presence/cache.ts', 'presence/registry.ts'] },
      { name: 'delivery', description: 'Message persistence, ordering, retries, dedupe', areas: ['message ordering', 'retry queue', 'dedupe window', 'ack tracking', 'cursor pagination'], files: ['delivery/queue.ts', 'delivery/dedupe.ts', 'delivery/cursor.ts', 'delivery/acks.ts'] },
      { name: 'webhooks', description: 'Outbound webhook dispatch and signing', areas: ['webhook signing', 'dispatch batching', 'retry backoff', 'payload schema'], files: ['webhooks/sign.ts', 'webhooks/dispatch.ts', 'webhooks/backoff.ts'] },
    ],
  },
  {
    key: 'ATLAS',
    name: 'Atlas',
    description: 'Customer-facing web console: auth, data tables, editor, and settings.',
    count: 110,
    components: [
      { name: 'auth', description: 'Login, sessions, SSO, permissions', areas: ['session refresh', 'SSO redirect', 'permission check', 'magic link', 'CSRF token'], files: ['auth/session.ts', 'auth/sso.ts', 'auth/permissions.ts'] },
      { name: 'tables', description: 'Data grid: virtual scroll, filters, exports', areas: ['virtual scroll', 'column filter', 'CSV export', 'row selection', 'sort state'], files: ['tables/VirtualGrid.tsx', 'tables/filters.ts', 'tables/export.ts'] },
      { name: 'editor', description: 'Rich text and config editors', areas: ['undo stack', 'paste sanitizer', 'autosave', 'syntax highlight', 'cursor position'], files: ['editor/undo.ts', 'editor/paste.ts', 'editor/autosave.ts'] },
      { name: 'settings', description: 'Org settings, billing surface, notifications', areas: ['notification prefs', 'billing form', 'timezone picker', 'API key rotation'], files: ['settings/notify.tsx', 'settings/billing.tsx', 'settings/keys.ts'] },
    ],
  },
  {
    key: 'FORGE',
    name: 'Forge',
    description: 'Internal build & CI pipeline: scheduling, caching, runners, artifacts.',
    count: 70,
    components: [
      { name: 'scheduler', description: 'Job queueing, priorities, fairness', areas: ['job priority', 'queue starvation', 'cron trigger', 'concurrency cap'], files: ['scheduler/queue.go', 'scheduler/cron.go', 'scheduler/fairness.go'] },
      { name: 'cache', description: 'Layer + dependency caches', areas: ['cache key', 'eviction policy', 'layer restore', 'cache poisoning guard'], files: ['cache/keys.go', 'cache/evict.go', 'cache/restore.go'] },
      { name: 'runners', description: 'Worker fleet lifecycle and isolation', areas: ['runner isolation', 'container teardown', 'disk pressure', 'zombie process reap'], files: ['runners/lifecycle.go', 'runners/teardown.go', 'runners/disk.go'] },
      { name: 'artifacts', description: 'Artifact upload/download and retention', areas: ['artifact upload', 'retention sweep', 'checksum verify', 'signed URL'], files: ['artifacts/upload.go', 'artifacts/retention.go', 'artifacts/sign.go'] },
    ],
  },
];

const SYMPTOMS = [
  '{area} fails intermittently under load',
  '{area} returns stale data after reconnect',
  '{area} leaks memory over long sessions',
  'race condition in {area} when two clients act simultaneously',
  '{area} silently drops updates during failover',
  'off-by-one in {area} pagination boundary',
  '{area} times out when payload exceeds 1MB',
  'crash in {area} on malformed input',
  '{area} double-fires after retry',
  '{area} ignores configured limits',
  'regression: {area} slow after last refactor',
  '{area} shows wrong state after undo',
  'unicode input breaks {area}',
  '{area} deadlocks during shutdown',
  'incorrect error surfaced by {area} on permission denial',
  '{area} misses events when clock skews',
  'duplicate entries produced by {area} after network blip',
  '{area} renders blank on first paint',
];

const LABEL_POOL = ['crash', 'performance', 'data-loss', 'flaky', 'papercut', 'security', 'a11y', 'customer-report', 'needs-repro', 'tech-debt'];

const COMMENTS = [
  'Reproduced on staging with the steps above. Happens roughly 1 in 5 attempts.',
  'I suspect this is related to the retry path — the timing lines up with the backoff window.',
  'Downgrading priority after triage; workaround exists (retry succeeds).',
  'Customer {n} hit this twice this week. Bumping.',
  'Bisected to the change that touched {file}. Confidence medium.',
  'Cannot reproduce on my machine — need exact browser + OS from the reporter.',
  'Fix is up for review. Went with a guard clause rather than restructuring the whole path.',
  'Verified on the release candidate. Holding to confirm no recurrence over the weekend.',
  'Adding a metric here so we can see if this is actually rare or just rarely reported.',
  'This smells like the same class of bug we fixed in the ordering path last quarter.',
  'The failing case only triggers when the cache is cold AND the payload spans two frames.',
  'Wrote a soak test that reproduces it in ~3 minutes. Attaching output.',
];

const BODY_INTRO = [
  'Seen repeatedly since the last deploy.',
  'Reported by two customers independently.',
  'Caught by the nightly soak run.',
  'Found while investigating an unrelated support ticket.',
  'Surfaced during load testing at 4x normal traffic.',
  'Happens on both staging and production.',
];

function makeBody(p: ProductSpec, c: ComponentSpec, area: string, withTrace: boolean): string {
  const file = pick(c.files);
  const lines = [
    pick(BODY_INTRO),
    '',
    '## Steps to reproduce',
    `1. Exercise the ${area} path under ${pick(['normal', 'elevated', 'bursty'])} traffic`,
    `2. ${pick(['Interrupt the connection mid-operation', 'Trigger a failover', 'Send a payload near the size limit', 'Repeat rapidly from two sessions'])}`,
    `3. Observe behaviour in ${c.name}`,
    '',
    '## Expected',
    `${area} handles this cleanly and recovers.`,
    '',
    '## Actual',
    `${pick(['Operation fails and does not recover', 'State diverges between clients', 'Latency spikes and requests queue', 'Process exits with a non-zero code'])}.`,
  ];
  if (withTrace) {
    const fn = area.replace(/[^a-z]+/gi, '_').toLowerCase();
    lines.push(
      '',
      '```',
      `${pick(['TimeoutError', 'StateConflictError', 'IntegrityError', 'ConnectionResetError'])}: ${area} did not settle`,
      `    at ${c.name}.${fn} (${file}:${Math.floor(between(20, 400))})`,
      `    at process${p.name}Event (${c.files[0]}:${Math.floor(between(20, 400))})`,
      '```',
    );
  }
  return lines.join('\n');
}

// ---------- event machinery ----------

type StageChain = Status[];
const CHAINS: Record<Status, StageChain> = {
  unconfirmed: [],
  confirmed: ['confirmed'],
  in_progress: ['confirmed', 'in_progress'],
  in_review: ['confirmed', 'in_progress', 'in_review'],
  resolved: ['confirmed', 'in_progress', 'resolved'],
  verified: ['confirmed', 'in_progress', 'resolved', 'verified'],
  closed: ['confirmed', 'in_progress', 'resolved', 'verified', 'closed'],
};

export interface SeedOptions {
  quiet?: boolean;
}

export function seedDb(db: DB, opts: SeedOptions = {}): void {
  const log = (msg: string) => {
    if (!opts.quiet) console.log(`[seed] ${msg}`);
  };
  const t0 = Date.now();
  // One transaction for the whole corpus: thousands of inserts become a
  // single fsync instead of one per statement.
  withTransaction(db, () => seedInner(db, log));
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function seedInner(db: DB, log: (m: string) => void): void {

  const insertActor = db.prepare('INSERT INTO actors (name, handle, role, hue, active) VALUES (?, ?, ?, ?, ?)');
  for (const a of ACTORS) insertActor.run(...a);
  const actorIds = (db.prepare('SELECT id, active, role FROM actors').all() as { id: number; active: number; role: string }[]);
  const activeIds = actorIds.filter((a) => a.active).map((a) => a.id);
  const devIds = actorIds.filter((a) => a.active && ['Backend', 'Frontend', 'Infra'].includes(a.role)).map((a) => a.id);

  const insertProduct = db.prepare('INSERT INTO products (key, name, description) VALUES (?, ?, ?)');
  const insertComponent = db.prepare('INSERT INTO components (product_id, name, description, lead_id) VALUES (?, ?, ?, ?)');
  const insertIssue = db.prepare(
    `INSERT INTO issues (key, product_id, component_id, seq, title, body, status, resolution, severity, priority, reporter_id, assignee_id, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLabel = db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)');
  const insertWatcher = db.prepare('INSERT OR IGNORE INTO watchers (issue_id, actor_id) VALUES (?, ?)');
  const insertComment = db.prepare('INSERT INTO comments (issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?)');
  const insertEvent = db.prepare(
    'INSERT INTO events (issue_id, actor_id, kind, field, from_value, to_value, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertRelation = db.prepare('INSERT OR IGNORE INTO relations (src_id, dst_id, kind, created_at) VALUES (?, ?, ?, ?)');

  interface SeededIssue {
    id: number;
    key: string;
    productId: number;
    componentId: number;
    status: Status;
    resolution: string | null;
    createdAt: number;
    resolvedAt: number | null;
    assignee: number | null;
    reporter: number;
  }
  const all: SeededIssue[] = [];

  const seedIssue = (
    productId: number,
    productKey: string,
    seq: number,
    componentId: number,
    title: string,
    body: string,
    status: Status,
    resolution: string | null,
    severity: Severity,
    priority: Priority,
    createdAt: number,
    labels: string[],
  ): SeededIssue => {
    const reporter = pick(activeIds);
    const chain = CHAINS[status];
    const needsAssignee = chain.includes('in_progress');
    const assignee = needsAssignee || chance(0.3) ? pick(devIds) : null;

    // Timeline: spread the chain between createdAt and an endpoint.
    const lifespanDays = status === 'closed' || status === 'verified' ? between(2, 40) : between(1, 25);
    const end = Math.min(createdAt + lifespanDays * DAY, NOW - between(0, 3) * DAY);
    const stamps: number[] = chain.map((_, i) => createdAt + ((i + 1) / (chain.length + 1)) * (end - createdAt));
    const resolvedIdx = chain.indexOf('resolved');
    const resolvedAt = resolvedIdx >= 0 ? stamps[resolvedIdx] : null;
    const updatedAt = stamps.length ? stamps[stamps.length - 1] : createdAt + between(0, 2) * DAY;

    const key = `${productKey}-${seq}`;
    const info = insertIssue.run(
      key, productId, componentId, seq, title, body, status, resolution, severity, priority,
      reporter, assignee, iso(createdAt), iso(Math.min(updatedAt, NOW)), resolvedAt ? iso(resolvedAt) : null,
    );
    const id = Number(info.lastInsertRowid);

    for (const l of labels) insertLabel.run(id, l);
    insertWatcher.run(id, reporter);
    if (assignee) insertWatcher.run(id, assignee);
    for (const w of activeIds) if (chance(0.12)) insertWatcher.run(id, w);

    insertEvent.run(id, reporter, 'created', null, null, null, null, iso(createdAt));
    let prev: Status = 'unconfirmed';
    chain.forEach((st, i) => {
      const actor = st === 'verified' ? pick(activeIds) : (assignee ?? pick(devIds));
      if (st === 'in_progress' && assignee) {
        insertEvent.run(id, actor, 'assigned', 'assignee_id', null, String(assignee), null, iso(stamps[i] - 3600_000));
      }
      insertEvent.run(
        id, actor, 'transitioned', 'status', prev, st,
        st === 'resolved' ? `resolution:${resolution}` : null, iso(stamps[i]),
      );
      prev = st;
    });

    const nComments = Math.floor(between(0, 4.4));
    for (let ci = 0; ci < nComments; ci++) {
      const at = createdAt + between(0.1, Math.max(0.2, (updatedAt - createdAt) / DAY)) * DAY;
      const text = pick(COMMENTS).replace('{n}', String(Math.floor(between(1000, 9000)))).replace('{file}', 'the recent change');
      const author = pick(activeIds);
      insertComment.run(id, author, text, iso(Math.min(at, NOW)));
      insertEvent.run(id, author, 'commented', null, null, null, null, iso(Math.min(at, NOW)));
    }

    const rec = { id, key, productId, componentId, status, resolution, createdAt, resolvedAt, assignee, reporter };
    all.push(rec);
    return rec;
  };

  // ---------- generate ----------

  for (const p of PRODUCTS) {
    log(`seeding ${p.name} (${p.count} issues)…`);
    const pInfo = insertProduct.run(p.key, p.name, p.description);
    const productId = Number(pInfo.lastInsertRowid);
    const componentIds: number[] = [];
    for (const c of p.components) {
      const lead = pick(devIds);
      const cInfo = insertComponent.run(productId, c.name, c.description, lead);
      componentIds.push(Number(cInfo.lastInsertRowid));
    }

    let seq = 1;
    for (let i = 0; i < p.count; i++) {
      const ci = Math.floor(rand() * p.components.length);
      const comp = p.components[ci];
      const area = pick(comp.areas);
      const title = pick(SYMPTOMS).replace('{area}', area);
      const severity = pick<Severity>(['blocker', 'critical', 'critical', 'major', 'major', 'major', 'normal', 'normal', 'normal', 'normal', 'minor', 'minor', 'trivial']);
      const priority = pick<Priority>(['p1', 'p2', 'p2', 'p3', 'p3', 'p3', 'p4']);
      // Weight creation toward the recent half of the window.
      const ageDays = Math.pow(rand(), 1.6) * 540;
      const createdAt = NOW - ageDays * DAY - between(0, 1) * DAY;
      const roll = rand();
      const status: Status =
        roll < 0.15 ? 'unconfirmed' : roll < 0.34 ? 'confirmed' : roll < 0.44 ? 'in_progress' : roll < 0.5 ? 'in_review' : roll < 0.63 ? 'resolved' : roll < 0.75 ? 'verified' : 'closed';
      const resolution =
        status === 'resolved' || status === 'verified' || status === 'closed'
          ? pick(['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'wontfix', 'invalid', 'worksforme'])
          : null;
      const labels = LABEL_POOL.filter(() => chance(0.14)).slice(0, 3);
      const body = makeBody(p, comp, area, chance(0.35));
      seedIssue(productId, p.key, seq++, componentIds[ci], title, body, status, resolution, severity, priority, createdAt, labels);
    }

    // Reserve seq for handcrafted issues below.
    db.prepare('UPDATE products SET next_seq = ? WHERE id = ?').run(seq + 20, productId);
  }

  // ---------- handcrafted lineage scenario (RELAY / gateway) ----------

  const relay = db.prepare(`SELECT id FROM products WHERE key = 'RELAY'`).get() as { id: number };
  const gateway = db.prepare(`SELECT id FROM components WHERE product_id = ? AND name = 'gateway'`).get(relay.id) as { id: number };
  const relaySeq = () => {
    const row = db.prepare('SELECT next_seq FROM products WHERE id = ?').get(relay.id) as { next_seq: number };
    db.prepare('UPDATE products SET next_seq = next_seq + 1 WHERE id = ?').run(relay.id);
    return row.next_seq;
  };

  // Ancestor: fixed & verified 24 days ago.
  const ancestorBody = [
    'Under sustained load the websocket handshake occasionally never completes when the client attempts TLS session resumption with an expired ticket.',
    '',
    '## Steps to reproduce',
    '1. Open ~2k concurrent connections with session tickets older than the rotation window',
    '2. Force a reconnect storm (kill the LB target)',
    '3. Watch handshake completion rate in the gateway dashboard',
    '',
    '## Expected',
    'Expired tickets fall back to a full handshake.',
    '',
    '## Actual',
    'The resume path waits on a cache entry that was already evicted and the handshake times out.',
    '',
    '```',
    'TimeoutError: tls session resume did not settle',
    '    at gateway.tls_session_resume (gateway/tls_resume.ts:142)',
    '    at SessionCache.restore (gateway/tls_resume.ts:88)',
    '    at processRelayEvent (gateway/socket.ts:57)',
    '```',
    '',
    'Fix: treat evicted-ticket lookups as a miss and fall through to the full handshake instead of awaiting the cache promise.',
  ].join('\n');
  const ancestorCreated = NOW - 41 * DAY;
  const ancestor = seedIssue(
    relay.id, 'RELAY', relaySeq(), gateway.id,
    'Websocket handshake stalls when TLS session resume hits an evicted ticket',
    ancestorBody, 'verified', 'fixed', 'critical', 'p1', ancestorCreated, ['crash', 'customer-report'],
  );
  // Pin its resolution date precisely: fixed 24 days ago.
  db.prepare('UPDATE issues SET resolved_at = ? WHERE id = ?').run(iso(NOW - 24 * DAY), ancestor.id);

  // The fresh report: filed 2 days ago, unconfirmed — the Lineage demo subject.
  const freshBody = [
    'Since the last gateway deploy we are seeing intermittent websocket disconnects during reconnect storms. Clients report the connection dies during the handshake phase and only recovers after several retries.',
    '',
    '## Steps to reproduce',
    '1. Run the reconnect soak (scripts/soak-reconnect) against staging',
    '2. Observe handshake timeouts after ~90 seconds',
    '',
    '## Expected',
    'Reconnects complete within the handshake budget.',
    '',
    '## Actual',
    'A subset of clients time out during the handshake and churn.',
    '',
    '```',
    'TimeoutError: tls session resume did not settle',
    '    at gateway.tls_session_resume (gateway/tls_resume.ts:151)',
    '    at SessionCache.restore (gateway/tls_resume.ts:90)',
    '```',
  ].join('\n');
  seedIssue(
    relay.id, 'RELAY', relaySeq(), gateway.id,
    'Intermittent websocket disconnects after deploy — handshake timeouts during reconnect storms',
    freshBody, 'unconfirmed', null, 'critical', 'p2', NOW - 2 * DAY, ['customer-report'],
  );

  // A confirmed historical regression pair elsewhere (delivery), so the graph
  // and ancestry chain have depth without any manual demo setup.
  const delivery = db.prepare(`SELECT id FROM components WHERE product_id = ? AND name = 'delivery'`).get(relay.id) as { id: number };
  const gen0 = seedIssue(
    relay.id, 'RELAY', relaySeq(), delivery.id,
    'Messages re-delivered after ack when dedupe window rolls over at midnight UTC',
    makeBody(PRODUCTS[0], PRODUCTS[0].components[2], 'dedupe window', true),
    'closed', 'fixed', 'major', 'p2', NOW - 200 * DAY, ['data-loss'],
  );
  const gen1 = seedIssue(
    relay.id, 'RELAY', relaySeq(), delivery.id,
    'Duplicate message delivery returned after dedupe refactor',
    makeBody(PRODUCTS[0], PRODUCTS[0].components[2], 'dedupe window', true),
    'verified', 'fixed', 'major', 'p2', NOW - 90 * DAY, ['data-loss'],
  );
  insertRelation.run(gen1.id, gen0.id, 'regression_of', iso(NOW - 88 * DAY));
  insertEvent.run(gen1.id, activeIds[0], 'lineage_confirmed', null, null, null, `confirmed as regression of ${gen0.key}; inherited 2 watchers`, iso(NOW - 88 * DAY));
  insertEvent.run(gen0.id, activeIds[0], 'lineage_confirmed', null, null, null, `${gen1.key} confirmed as a regression of this fix`, iso(NOW - 88 * DAY));

  // ---------- blocks / depends chains ----------

  const openIssues = all.filter((i) => !['resolved', 'verified', 'closed'].includes(i.status));
  const byProduct = new Map<number, SeededIssue[]>();
  for (const i of openIssues) {
    if (!byProduct.has(i.productId)) byProduct.set(i.productId, []);
    byProduct.get(i.productId)!.push(i);
  }
  let blockCount = 0;
  for (const [, issues] of byProduct) {
    const shuffled = [...issues].sort(() => rand() - 0.5);
    for (let i = 0; i + 1 < shuffled.length && blockCount < 24; i += 2) {
      if (!chance(0.5)) continue;
      const [a, b] = [shuffled[i], shuffled[i + 1]];
      insertRelation.run(a.id, b.id, 'blocks', iso(Math.max(a.createdAt, b.createdAt) + DAY));
      insertEvent.run(a.id, pick(activeIds), 'relation_added', null, null, null, `blocks ${b.key}`, iso(Math.max(a.createdAt, b.createdAt) + DAY));
      insertEvent.run(b.id, pick(activeIds), 'relation_added', null, null, null, `depends on ${a.key}`, iso(Math.max(a.createdAt, b.createdAt) + DAY));
      blockCount++;
    }
  }
  // One deliberate 3-deep chain in FORGE for the graph view.
  const forgeOpen = openIssues.filter((i) => i.key.startsWith('FORGE')).slice(0, 3);
  if (forgeOpen.length === 3) {
    insertRelation.run(forgeOpen[0].id, forgeOpen[1].id, 'blocks', iso(NOW - 10 * DAY));
    insertRelation.run(forgeOpen[1].id, forgeOpen[2].id, 'blocks', iso(NOW - 9 * DAY));
  }

  // ---------- duplicates ----------

  let dupCount = 0;
  const resolvedFixed = all.filter((i) => i.resolution === 'fixed');
  for (const dupSrc of all) {
    if (dupCount >= 10) break;
    if (dupSrc.status !== 'resolved' || dupSrc.resolution !== 'fixed' || !chance(0.18)) continue;
    const canonical = pick(resolvedFixed.filter((c) => c.productId === dupSrc.productId && c.id !== dupSrc.id));
    if (!canonical) continue;
    const at = iso(Math.min(dupSrc.createdAt + 2 * DAY, NOW));
    db.prepare(`UPDATE issues SET resolution = 'duplicate' WHERE id = ?`).run(dupSrc.id);
    insertRelation.run(dupSrc.id, canonical.id, 'duplicate_of', at);
    insertEvent.run(dupSrc.id, pick(activeIds), 'marked_duplicate', null, null, null, `duplicate of ${canonical.key}`, at);
    insertEvent.run(canonical.id, pick(activeIds), 'absorbed_duplicate', null, null, null, `${dupSrc.key} marked as duplicate; 1 watcher merged`, at);
    insertWatcher.run(canonical.id, dupSrc.reporter);
    dupCount++;
  }

  // ---------- reopen histories (so reopen metrics are non-zero) ----------

  let reopenCount = 0;
  for (const i of all) {
    if (reopenCount >= 8) break;
    if (i.status !== 'confirmed' || !chance(0.15)) continue;
    const at1 = iso(Math.min(i.createdAt + 4 * DAY, NOW - 2 * DAY));
    const at2 = iso(Math.min(i.createdAt + 9 * DAY, NOW - DAY));
    insertEvent.run(i.id, pick(devIds), 'transitioned', 'status', 'confirmed', 'resolved', 'resolution:fixed', at1);
    insertEvent.run(i.id, pick(activeIds), 'reopened', 'status', 'resolved', 'confirmed', 'resolution cleared', at2);
    reopenCount++;
  }

  // ---------- index everything ----------

  log('building full-text index…');
  const ids = db.prepare('SELECT id FROM issues').all() as { id: number }[];
  for (const { id } of ids) reindexIssue(db, id);

  log(`${ids.length} issues, ${blockCount + 2} dependency links, ${dupCount} duplicates, ${reopenCount + 1} reopen histories`);
}

export function isSeeded(db: DB): boolean {
  return ((db.prepare('SELECT COUNT(*) n FROM issues').get() as { n: number }).n ?? 0) > 0;
}
