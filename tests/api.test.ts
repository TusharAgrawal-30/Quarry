import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Hono } from 'hono';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seedDb } from '../server/seed.js';

// Integration suite: requests go through the real HTTP app (routing, JSON
// parsing, error mapping) against real SQLite databases — one seeded like
// production, one empty for lifecycle tests. No mocks anywhere.

type Json = Record<string, any>;

function client(app: Hono) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; data: Json }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Json };
  };
}

// ─── seeded corpus ─────────────────────────────────────────────────────────

describe('seeded corpus', () => {
  let call: ReturnType<typeof client>;

  before(() => {
    const db = openDb(':memory:');
    seedDb(db, { quiet: true });
    call = client(createApp(db));
  });

  it('seeds a realistic dataset (hundreds of issues, three products)', async () => {
    const { status, data } = await call('GET', '/api/issues?limit=1');
    assert.equal(status, 200);
    assert.ok(data.total >= 300, `expected >=300 issues, got ${data.total}`);
    const meta = (await call('GET', '/api/meta')).data;
    assert.equal(meta.products.length, 3);
    assert.ok(meta.components.length >= 12);
    assert.ok(meta.actors.length >= 10);
  });

  it('meta exposes the full workflow vocabulary and transition map', async () => {
    const { data } = await call('GET', '/api/meta');
    assert.deepEqual(data.statuses, ['unconfirmed', 'confirmed', 'in_progress', 'in_review', 'resolved', 'verified', 'closed']);
    assert.deepEqual(data.resolutions, ['fixed', 'wontfix', 'duplicate', 'invalid', 'worksforme']);
    assert.deepEqual(data.transitions.closed, ['confirmed']);
    assert.deepEqual(data.transitions.unconfirmed, ['confirmed', 'resolved']);
  });

  it('every issue summary carries labels, watchers and legal next states', async () => {
    const { data } = await call('GET', '/api/issues?limit=5');
    for (const i of data.issues) {
      assert.ok(Array.isArray(i.labels));
      assert.ok(Array.isArray(i.watchers));
      assert.ok(Array.isArray(i.legalNextStates) && i.legalNextStates.length > 0);
    }
  });

  it('full-text search finds issues by stack-trace fragment', async () => {
    const { data } = await call('GET', '/api/issues?q=tls_resume.ts');
    assert.ok(data.total >= 2, 'expected the handcrafted regression pair to match');
    assert.ok(data.issues.every((i: Json) => `${i.title} ${i.body}`.includes('tls_resume.ts')));
  });

  it('filters compose: product + status + severity', async () => {
    const { data } = await call('GET', '/api/issues?product=RELAY&status=confirmed&severity=critical');
    for (const i of data.issues) {
      assert.equal(i.status, 'confirmed');
      assert.equal(i.severity, 'critical');
      assert.ok(i.key.startsWith('RELAY-'));
    }
  });

  it('open=true excludes the resolved family', async () => {
    const { data } = await call('GET', '/api/issues?open=true&limit=1000');
    for (const i of data.issues) assert.ok(!['resolved', 'verified', 'closed'].includes(i.status));
  });

  it('severity sort puts blockers first', async () => {
    const { data } = await call('GET', '/api/issues?sort=severity&limit=1000');
    const order = ['blocker', 'critical', 'major', 'normal', 'minor', 'trivial'];
    let last = 0;
    for (const i of data.issues) {
      const rank = order.indexOf(i.severity);
      assert.ok(rank >= last, `severity order violated: ${i.severity} after ${order[last]}`);
      last = rank;
    }
  });

  it('issue detail includes comments, full event history and relations', async () => {
    const list = (await call('GET', '/api/issues?status=closed&limit=1')).data;
    const key = list.issues[0].key;
    const { status, data } = await call('GET', `/api/issues/${key}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.comments));
    assert.ok(data.events.length >= 5, 'closed issue must carry its transition history');
    assert.equal(data.events[0].kind, 'created');
    const transitions = data.events.filter((e: Json) => e.kind === 'transitioned').map((e: Json) => e.to_value);
    assert.ok(transitions.includes('closed'));
  });

  it('lineage ranks the true ancestor first with four independent signals', async () => {
    const fresh = (await call('GET', '/api/issues?q=handshake+timeouts+reconnect+storms&limit=1')).data.issues[0];
    assert.ok(fresh, 'seeded fresh regression report should exist');
    const { status, data } = await call('GET', `/api/issues/${fresh.key}/lineage`);
    assert.equal(status, 200);
    assert.ok(data.candidatesConsidered >= 20);
    assert.ok(data.candidates.length >= 1);
    const top = data.candidates[0];
    for (const s of ['lexical', 'structural', 'trace', 'timing']) {
      assert.ok(top.signals[s], `missing signal ${s}`);
      assert.ok(top.signals[s].score >= 0 && top.signals[s].score <= 1);
      assert.ok(typeof top.signals[s].evidence === 'string' && top.signals[s].evidence.length > 0);
    }
    // the handcrafted ancestor shares the exact stack frames — trace must be decisive
    assert.ok(top.signals.trace.score >= 0.6, `trace signal should be decisive, got ${top.signals.trace.score}`);
    assert.equal(top.verdict, 'strong');
    const ancestor = (await call('GET', `/api/issues/${top.key}`)).data;
    assert.equal(ancestor.resolution, 'fixed');
  });

  it('lineage agreement is honest: weak candidates expose disagreeing signals', async () => {
    const fresh = (await call('GET', '/api/issues?q=handshake+timeouts+reconnect+storms&limit=1')).data.issues[0];
    const { data } = await call('GET', `/api/issues/${fresh.key}/lineage`);
    for (const c of data.candidates) {
      assert.ok(c.agreement >= 0 && c.agreement <= 1);
      if (c.verdict === 'strong') assert.ok(c.agreement >= 0.75, 'strong verdicts require signal consensus');
    }
  });

  it('analytics computes real aggregates over the corpus', async () => {
    const { data } = await call('GET', '/api/analytics/summary');
    const total = (await call('GET', '/api/issues?limit=1')).data.total;
    assert.equal(data.totals.total, total);
    assert.equal(
      data.statusDist.reduce((s: number, r: Json) => s + r.n, 0),
      total,
    );
    assert.equal(data.weeks.length, 26);
    assert.ok(data.mttrDays !== null && data.mttrDays > 0);
    assert.ok(data.oldestOpen && data.oldestOpen.ageDays > 0);
    assert.ok(data.reopens > 0, 'seed should include reopen histories');
    assert.ok(data.regressions >= 1, 'seed should include a confirmed regression');
    assert.ok(data.load.length > 0);
  });

  it('analytics scopes by product', async () => {
    const all = (await call('GET', '/api/analytics/summary')).data;
    const relay = (await call('GET', '/api/analytics/summary?product=RELAY')).data;
    assert.ok(relay.totals.total < all.totals.total);
    assert.ok(relay.totals.total >= 140);
  });

  it('graph endpoint returns a consistent node/edge set', async () => {
    const { data } = await call('GET', '/api/graph');
    assert.ok(data.nodes.length > 0 && data.edges.length > 0);
    const keys = new Set(data.nodes.map((n: Json) => n.key));
    for (const e of data.edges) {
      assert.ok(keys.has(e.src) && keys.has(e.dst), 'dangling edge endpoint');
      assert.ok(['blocks', 'regression_of', 'duplicate_of'].includes(e.kind));
    }
  });

  it('unknown issue and unknown route both return structured JSON errors', async () => {
    const a = await call('GET', '/api/issues/NOPE-999');
    assert.equal(a.status, 404);
    assert.equal(a.data.error, 'issue_not_found');
    const b = await call('GET', '/api/definitely/not/a/route');
    assert.equal(b.status, 404);
    assert.equal(b.data.error, 'not_found');
  });
});

// ─── lifecycle on a fresh database ─────────────────────────────────────────

describe('lifecycle on a fresh database', () => {
  let call: ReturnType<typeof client>;
  let actorA: number;
  let actorB: number;
  let compId: number;

  before(async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO actors (name, handle, role, hue, active) VALUES ('Test Person', 'test', 'QA', 30, 1)`).run();
    db.prepare(`INSERT INTO actors (name, handle, role, hue, active) VALUES ('Second Person', 'second', 'Dev', 40, 1)`).run();
    call = client(createApp(db));
    actorA = 1;
    actorB = 2;
    const prod = await call('POST', '/api/products', { key: 'CORE', name: 'Core', description: 'test product' });
    assert.equal(prod.status, 201);
    const comp = await call('POST', '/api/products/CORE/components', { name: 'engine', description: 'the engine' });
    assert.equal(comp.status, 201);
    compId = comp.data.id;
  });

  const file = async (title: string, extra: Json = {}) => {
    const res = await call('POST', '/api/issues', { productKey: 'CORE', componentId: compId, title, actorId: actorA, ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };

  it('rejects malformed product and component definitions', async () => {
    assert.equal((await call('POST', '/api/products', { key: 'x', name: 'Bad' })).status, 400);
    assert.equal((await call('POST', '/api/products', { key: 'CORE', name: 'Dup' })).status, 409);
    assert.equal((await call('POST', '/api/products/CORE/components', { name: 'engine' })).status, 409);
    assert.equal((await call('POST', '/api/products/NOPE/components', { name: 'x2' })).status, 404);
  });

  it('validates issue creation server-side', async () => {
    const noTitle = await call('POST', '/api/issues', { productKey: 'CORE', componentId: compId, title: '  ', actorId: actorA });
    assert.equal(noTitle.status, 400);
    assert.equal(noTitle.data.error, 'title_required');
    const badProduct = await call('POST', '/api/issues', { productKey: 'NOPE', componentId: compId, title: 'x', actorId: actorA });
    assert.equal(badProduct.data.error, 'unknown_product');
    const badComponent = await call('POST', '/api/issues', { productKey: 'CORE', componentId: 999, title: 'x', actorId: actorA });
    assert.equal(badComponent.data.error, 'unknown_component');
    const noActor = await call('POST', '/api/issues', { productKey: 'CORE', componentId: compId, title: 'x' });
    assert.equal(noActor.data.error, 'actor_required');
    const badSeverity = await call('POST', '/api/issues', { productKey: 'CORE', componentId: compId, title: 'x', actorId: actorA, severity: 'apocalyptic' });
    assert.equal(badSeverity.data.error, 'invalid_severity');
  });

  it('mints sequential human-readable keys and starts issues unconfirmed', async () => {
    const a = await file('First bug');
    const b = await file('Second bug');
    assert.match(a.key, /^CORE-\d+$/);
    assert.equal(Number(b.key.split('-')[1]), Number(a.key.split('-')[1]) + 1);
    assert.equal(a.status, 'unconfirmed');
    assert.equal(a.resolution, null);
    assert.ok(a.watchers.includes(actorA), 'reporter auto-watches');
  });

  it('walks the full legal lifecycle and records every step in the audit trail', async () => {
    const issue = await file('Lifecycle bug', { severity: 'major', priority: 'p2' });
    const k = issue.key;

    const t = async (to: string, extra: Json = {}) => call('POST', `/api/issues/${k}/transition`, { to, actorId: actorA, ...extra });

    assert.equal((await t('confirmed')).status, 200);

    // in_progress requires an assignee
    const noAssignee = await t('in_progress');
    assert.equal(noAssignee.status, 409);
    assert.equal(noAssignee.data.error, 'assignee_required');
    await call('PATCH', `/api/issues/${k}`, { assignee_id: actorB, actorId: actorA });
    assert.equal((await t('in_progress')).status, 200);

    assert.equal((await t('in_review')).status, 200);
    const resolved = await t('resolved', { resolution: 'fixed' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.resolution, 'fixed');
    assert.ok(resolved.data.resolved_at, 'resolved_at stamped');
    assert.equal((await t('verified')).status, 200);
    const closed = await t('closed');
    assert.equal(closed.status, 200);

    const detail = (await call('GET', `/api/issues/${k}`)).data;
    const chain = detail.events.filter((e: Json) => e.kind === 'transitioned').map((e: Json) => `${e.from_value}>${e.to_value}`);
    assert.deepEqual(chain, [
      'unconfirmed>confirmed',
      'confirmed>in_progress',
      'in_progress>in_review',
      'in_review>resolved',
      'resolved>verified',
      'verified>closed',
    ]);
    assert.ok(detail.events.some((e: Json) => e.kind === 'assigned'));
  });

  it('rejects illegal transitions with the legal next states named', async () => {
    const issue = await file('Illegal moves');
    const k = issue.key;

    const jump = await call('POST', `/api/issues/${k}/transition`, { to: 'closed', actorId: actorA });
    assert.equal(jump.status, 409);
    assert.equal(jump.data.error, 'illegal_transition');
    assert.deepEqual(jump.data.legalNextStates, ['confirmed', 'resolved']);

    const noop = await call('POST', `/api/issues/${k}/transition`, { to: 'unconfirmed', actorId: actorA });
    assert.equal(noop.status, 409);

    const noReason = await call('POST', `/api/issues/${k}/transition`, { to: 'resolved', actorId: actorA });
    assert.equal(noReason.status, 409);
    assert.equal(noReason.data.error, 'resolution_required');

    const badReason = await call('POST', `/api/issues/${k}/transition`, { to: 'resolved', actorId: actorA, resolution: 'gone' });
    assert.equal(badReason.status, 409);

    const badActor = await call('POST', `/api/issues/${k}/transition`, { to: 'confirmed', actorId: 999 });
    assert.equal(badActor.status, 400);
    assert.equal(badActor.data.error, 'unknown_actor');
  });

  it('reopening clears the resolution and is recorded as its own event kind', async () => {
    const issue = await file('Comes back');
    const k = issue.key;
    await call('POST', `/api/issues/${k}/transition`, { to: 'resolved', actorId: actorA, resolution: 'worksforme' });
    const reopened = await call('POST', `/api/issues/${k}/transition`, { to: 'confirmed', actorId: actorB });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.resolution, null);
    assert.equal(reopened.data.resolved_at, null);
    const detail = (await call('GET', `/api/issues/${k}`)).data;
    assert.ok(detail.events.some((e: Json) => e.kind === 'reopened'));
  });

  it('duplicate resolution requires a canonical target and merges watchers into it', async () => {
    const canonical = await file('Canonical crash');
    const dup = await file('Same crash, second report');

    // second actor watches the duplicate — they must not lose the thread
    await call('PUT', `/api/issues/${dup.key}/watch`, { actorId: actorB, watching: true });

    const missing = await call('POST', `/api/issues/${dup.key}/transition`, { to: 'resolved', actorId: actorA, resolution: 'duplicate' });
    assert.equal(missing.status, 409);
    assert.equal(missing.data.error, 'duplicate_target_required');

    const self = await call('POST', `/api/issues/${dup.key}/transition`, {
      to: 'resolved',
      actorId: actorA,
      resolution: 'duplicate',
      duplicateOf: dup.key,
    });
    assert.equal(self.data.error, 'self_duplicate');

    const ok = await call('POST', `/api/issues/${dup.key}/transition`, {
      to: 'resolved',
      actorId: actorA,
      resolution: 'duplicate',
      duplicateOf: canonical.key,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));

    const canonDetail = (await call('GET', `/api/issues/${canonical.key}`)).data;
    assert.ok(canonDetail.watchers.includes(actorB), 'duplicate watcher merged into canonical');
    assert.ok(canonDetail.events.some((e: Json) => e.kind === 'absorbed_duplicate'));
    assert.ok(canonDetail.relations.some((r: Json) => r.kind === 'duplicate_of' && r.other_key === dup.key));

    // chains onto a duplicate are refused
    const third = await file('Third report of the same crash');
    const chain = await call('POST', `/api/issues/${third.key}/transition`, {
      to: 'resolved',
      actorId: actorA,
      resolution: 'duplicate',
      duplicateOf: dup.key,
    });
    assert.equal(chain.status, 409);
    assert.equal(chain.data.error, 'duplicate_chain');
  });

  it('blocks relations reject self-links, duplicates of themselves, and cycles', async () => {
    const a = await file('Dep A');
    const b = await file('Dep B');
    const c = await file('Dep C');

    assert.equal((await call('POST', `/api/issues/${a.key}/relations`, { kind: 'blocks', target: a.key, actorId: actorA })).data.error, 'self_relation');

    assert.equal((await call('POST', `/api/issues/${a.key}/relations`, { kind: 'blocks', target: b.key, actorId: actorA })).status, 201);
    const again = await call('POST', `/api/issues/${a.key}/relations`, { kind: 'blocks', target: b.key, actorId: actorA });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'relation_exists');

    assert.equal((await call('POST', `/api/issues/${b.key}/relations`, { kind: 'blocks', target: c.key, actorId: actorA })).status, 201);
    const cycle = await call('POST', `/api/issues/${c.key}/relations`, { kind: 'blocks', target: a.key, actorId: actorA });
    assert.equal(cycle.status, 409);
    assert.equal(cycle.data.error, 'dependency_cycle');

    const viaRelations = await call('POST', `/api/issues/${a.key}/relations`, { kind: 'duplicate_of', target: b.key, actorId: actorA });
    assert.equal(viaRelations.status, 400);
    assert.equal(viaRelations.data.error, 'use_transition');

    // removal works and is audited
    const rels = (await call('GET', `/api/issues/${a.key}`)).data.relations;
    const rel = rels.find((r: Json) => r.kind === 'blocks' && r.other_key === b.key);
    const removed = await call('DELETE', `/api/issues/${a.key}/relations/${rel.id}`, { actorId: actorA });
    assert.equal(removed.status, 200);
  });

  it('confirming regression ancestry inherits the ancestor watchers', async () => {
    const ancestor = await file('Original leak');
    await call('PUT', `/api/issues/${ancestor.key}/watch`, { actorId: actorB, watching: true });
    await call('POST', `/api/issues/${ancestor.key}/transition`, { to: 'resolved', actorId: actorA, resolution: 'fixed' });

    const regression = await file('Leak is back');
    const linked = await call('POST', `/api/issues/${regression.key}/relations`, { kind: 'regression_of', target: ancestor.key, actorId: actorA });
    assert.equal(linked.status, 201);

    const detail = (await call('GET', `/api/issues/${regression.key}`)).data;
    assert.ok(detail.watchers.includes(actorB), 'ancestor watcher inherited');
    assert.ok(detail.events.some((e: Json) => e.kind === 'lineage_confirmed'));

    const chain = (await call('GET', `/api/issues/${regression.key}/ancestry`)).data.chain;
    assert.equal(chain.length, 2);
    assert.equal(chain[0].key, regression.key);
    assert.equal(chain[1].key, ancestor.key);
  });

  it('comments are validated, audited, and auto-subscribe the author', async () => {
    const issue = await file('Discussable');
    const empty = await call('POST', `/api/issues/${issue.key}/comments`, { body: '   ', actorId: actorB });
    assert.equal(empty.status, 400);
    const ok = await call('POST', `/api/issues/${issue.key}/comments`, { body: 'I can reproduce this.', actorId: actorB });
    assert.equal(ok.status, 201);
    const detail = (await call('GET', `/api/issues/${issue.key}`)).data;
    assert.equal(detail.comments.length, 1);
    assert.ok(detail.watchers.includes(actorB));
    assert.ok(detail.events.some((e: Json) => e.kind === 'commented'));
  });

  it('field edits are diffed into individual audit events', async () => {
    const issue = await file('Editable', { labels: ['one', 'two'] });
    const patched = await call('PATCH', `/api/issues/${issue.key}`, {
      severity: 'critical',
      priority: 'p1',
      labels: ['two', 'three'],
      actorId: actorA,
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.data.labels.sort(), ['three', 'two']);
    const detail = (await call('GET', `/api/issues/${issue.key}`)).data;
    const kinds = detail.events.map((e: Json) => e.kind);
    assert.ok(kinds.includes('label_added') && kinds.includes('label_removed'));
    const sevEdit = detail.events.find((e: Json) => e.field === 'severity');
    assert.equal(sevEdit.from_value, 'normal');
    assert.equal(sevEdit.to_value, 'critical');

    const bad = await call('PATCH', `/api/issues/${issue.key}`, { status: 'closed', actorId: actorA });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'uneditable_field');
  });

  it('new issues are searchable immediately (FTS index stays in sync)', async () => {
    await file('Zanzibar telemetry exporter drops spans');
    const { data } = await call('GET', '/api/issues?q=zanzibar');
    assert.equal(data.total, 1);
    const edited = data.issues[0];
    await call('PATCH', `/api/issues/${edited.key}`, { title: 'Quagga telemetry exporter drops spans', actorId: actorA });
    assert.equal((await call('GET', '/api/issues?q=zanzibar')).data.total, 0);
    assert.equal((await call('GET', '/api/issues?q=quagga')).data.total, 1);
  });

  it('lineage on an empty history is honest about finding nothing', async () => {
    const lone = await file('Completely novel failure');
    const { data } = await call('GET', `/api/issues/${lone.key}/lineage`);
    assert.equal(data.candidates.filter((c: Json) => c.verdict === 'strong').length, 0);
  });

  it('malformed JSON bodies return a structured 400, not a crash', async () => {
    const res = await (async () => {
      const app = await call('GET', '/api/meta'); // sanity that app still alive
      assert.equal(app.status, 200);
      return call('POST', '/api/issues', undefined);
    })();
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'invalid_json');
  });
});

// ─── security hardening ────────────────────────────────────────────────────

describe('security hardening', () => {
  let call: ReturnType<typeof client>;
  let app: Hono;

  before(() => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO actors (name, handle, role, hue, active) VALUES ('Sec Tester', 'sec', 'QA', 30, 1)`).run();
    app = createApp(db, { allowedOrigins: ['http://allowed.example'], rateLimit: { max: 5, windowMs: 60_000 }, maxBodyBytes: 2048 });
    call = client(app);
  });

  it('sets security headers on every response', async () => {
    const res = await app.request('/api/meta');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'self'"), 'CSP present');
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes('fonts.googleapis.com'), 'CSP allows the font stylesheet host');
  });

  it('CORS reflects only allowlisted origins — never a wildcard', async () => {
    const ok = await app.request('/api/meta', { headers: { origin: 'http://allowed.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://allowed.example');
    const bad = await app.request('/api/meta', { headers: { origin: 'http://evil.example' } });
    const acao = bad.headers.get('access-control-allow-origin');
    assert.ok(acao !== '*' && acao !== 'http://evil.example', `unexpected ACAO: ${acao}`);
  });

  it('rate-limits mutating routes with 429 + Retry-After, while reads stay open', async () => {
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await call('POST', '/api/products', { key: `RL${i}A`, name: `RL ${i}` });
      results.push(res.status);
    }
    assert.ok(results.slice(0, 5).every((s) => s === 201), `first five writes pass: ${results}`);
    assert.ok(results.slice(5).every((s) => s === 429), `then 429: ${results}`);
    const limited = await app.request('/api/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'RLX', name: 'x' }),
    });
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    // reads are not limited
    for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/api/meta')).status, 200);
  });

  it('rejects oversized request bodies with 413', async () => {
    const payload = JSON.stringify({ title: 'x'.repeat(4000), actorId: 1 });
    const res = await app.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      body: payload,
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as Json).error, 'payload_too_large');
  });
});

describe('input validation limits', () => {
  let call: ReturnType<typeof client>;
  let compId: number;

  before(async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO actors (name, handle, role, hue, active) VALUES ('Val Tester', 'val', 'QA', 30, 1)`).run();
    call = client(createApp(db));
    await call('POST', '/api/products', { key: 'VAL', name: 'Validation' });
    compId = (await call('POST', '/api/products/VAL/components', { name: 'core' })).data.id;
  });

  it('rejects oversized descriptions and comments with clear errors, not truncation', async () => {
    const tooLong = await call('POST', '/api/issues', { productKey: 'VAL', componentId: compId, title: 'ok', body: 'x'.repeat(20_001), actorId: 1 });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.data.error, 'body_too_long');

    const issue = (await call('POST', '/api/issues', { productKey: 'VAL', componentId: compId, title: 'ok', actorId: 1 })).data;
    const badComment = await call('POST', `/api/issues/${issue.key}/comments`, { body: 'y'.repeat(10_001), actorId: 1 });
    assert.equal(badComment.status, 400);
    assert.equal(badComment.data.error, 'comment_too_long');
  });

  it('rejects malformed and excessive labels', async () => {
    const badLabel = await call('POST', '/api/issues', { productKey: 'VAL', componentId: compId, title: 'x', labels: ['<script>'], actorId: 1 });
    assert.equal(badLabel.status, 400);
    assert.equal(badLabel.data.error, 'invalid_label');
    const tooMany = await call('POST', '/api/issues', {
      productKey: 'VAL',
      componentId: compId,
      title: 'x',
      labels: Array.from({ length: 13 }, (_, i) => `l${i}`),
      actorId: 1,
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.data.error, 'too_many_labels');
  });
});

// ─── live collaboration ────────────────────────────────────────────────────

describe('live collaboration', () => {
  let call: ReturnType<typeof client>;
  let app: Hono;
  let issueKey: string;

  before(async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO actors (name, handle, role, hue, active) VALUES ('Live One', 'live1', 'QA', 30, 1)`).run();
    db.prepare(`INSERT INTO actors (name, handle, role, hue, active) VALUES ('Live Two', 'live2', 'Dev', 40, 1)`).run();
    app = createApp(db);
    call = client(app);
    await call('POST', '/api/products', { key: 'LIVE', name: 'Live' });
    const comp = (await call('POST', '/api/products/LIVE/components', { name: 'core' })).data;
    issueKey = (await call('POST', '/api/issues', { productKey: 'LIVE', componentId: comp.id, title: 'watched live', actorId: 1 })).data.key;
  });

  it('presence heartbeat registers viewers and leaving clears them', async () => {
    const a = await call('PUT', `/api/issues/${issueKey}/presence`, { actorId: 1 });
    assert.deepEqual(a.data.viewers, [1]);
    const b = await call('PUT', `/api/issues/${issueKey}/presence`, { actorId: 2 });
    assert.deepEqual(b.data.viewers.sort(), [1, 2]);
    const gone = await call('PUT', `/api/issues/${issueKey}/presence`, { actorId: 2, leaving: true });
    assert.deepEqual(gone.data.viewers, [1]);
    const noActor = await call('PUT', `/api/issues/${issueKey}/presence`, {});
    assert.equal(noActor.status, 400);
  });

  it('SSE stream delivers issue_changed events for mutations by other actors', async () => {
    const controller = new AbortController();
    const res = await app.request('/api/stream', { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').includes('text/event-stream'));

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (marker: string, ms: number): Promise<string> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((r) => setTimeout(() => r({ value: undefined, done: false }), 300)),
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(marker)) return buffer;
      }
      return buffer;
    };

    await readUntil('hello', 2000);
    const t = await call('POST', `/api/issues/${issueKey}/transition`, { to: 'confirmed', actorId: 2 });
    assert.equal(t.status, 200);
    const out = await readUntil('issue_changed', 4000);
    assert.ok(out.includes('issue_changed'), 'stream carries the change event');
    assert.ok(out.includes(issueKey), 'event names the changed issue');
    assert.ok(out.includes('"actorId":2'), 'event names the acting user');
    controller.abort();
  });
});
