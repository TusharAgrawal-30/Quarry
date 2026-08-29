import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DB } from './db.js';
import { Realtime } from './realtime.js';
import type { SecurityOptions } from './security.js';
import { bodyLimitMiddleware, corsMiddleware, DEFAULTS, headersMiddleware, rateLimitMiddleware } from './security.js';
import { analyticsSummary, dependencyGraph } from './domain/analytics.js';
import { ancestryChain, computeLineage } from './domain/lineage.js';
import { PRIORITIES, RESOLUTIONS, SEVERITIES, STATUSES } from './domain/types.js';
import { TRANSITIONS } from './domain/workflow.js';
import {
  addComment,
  addRelation,
  ApiError,
  createComponent,
  createIssue,
  createProduct,
  getIssueByKey,
  issueDetail,
  listIssues,
  removeRelation,
  setWatching,
  transitionIssue,
  updateIssue,
} from './store.js';

export function createApp(db: DB, security: SecurityOptions = {}): Hono {
  const app = new Hono();
  const rt = new Realtime();
  const sec = {
    allowedOrigins: security.allowedOrigins ?? DEFAULTS.allowedOrigins,
    rateLimit: security.rateLimit ?? DEFAULTS.rateLimit,
    maxBodyBytes: security.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
  };

  app.use('*', headersMiddleware());
  app.use('/api/*', corsMiddleware(sec.allowedOrigins));
  app.use('/api/*', bodyLimitMiddleware(sec.maxBodyBytes));
  app.use('/api/*', rateLimitMiddleware(sec.rateLimit));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.code, message: err.message, ...err.extra }, err.status as 400);
    }
    console.error('[api] unhandled:', err);
    return c.json({ error: 'internal', message: 'Something went wrong on the server. The details were logged.' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: `No route: ${c.req.method} ${c.req.path}` }, 404));

  // ---- meta ----

  app.get('/api/meta', (c) => {
    const products = db.prepare('SELECT id, key, name, description FROM products ORDER BY key').all() as { id: number }[];
    const components = db.prepare('SELECT id, product_id, name, description, lead_id FROM components ORDER BY name').all();
    const actors = db.prepare('SELECT id, name, handle, role, hue, active FROM actors ORDER BY name').all();
    const labels = (db.prepare('SELECT DISTINCT label FROM issue_labels ORDER BY label').all() as { label: string }[]).map((r) => r.label);
    return c.json({
      products,
      components,
      actors,
      labels,
      statuses: STATUSES,
      resolutions: RESOLUTIONS,
      severities: SEVERITIES,
      priorities: PRIORITIES,
      transitions: TRANSITIONS,
    });
  });

  // ---- issues ----

  app.get('/api/issues', (c) => {
    const q = c.req.query();
    return c.json(listIssues(db, q));
  });

  app.post('/api/issues', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    const issue = createIssue(db, body);
    return c.json(issue, 201);
  });

  app.get('/api/issues/:key', (c) => c.json(issueDetail(db, c.req.param('key'))));

  app.patch('/api/issues/:key', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    const { actorId, ...patch } = body;
    const updated = updateIssue(db, c.req.param('key'), patch, actorId);
    rt.publishChange(updated.key, Number(actorId), 'edit');
    return c.json(updated);
  });

  app.post('/api/issues/:key/transition', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    const updated = transitionIssue(db, c.req.param('key'), body);
    rt.publishChange(updated.key, Number(body.actorId), 'transition');
    return c.json(updated);
  });

  app.post('/api/issues/:key/comments', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    const comment = addComment(db, c.req.param('key'), body.body, body.actorId);
    rt.publishChange(c.req.param('key').toUpperCase(), Number(body.actorId), 'comment');
    return c.json(comment, 201);
  });

  app.post('/api/issues/:key/relations', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    const relations = addRelation(db, c.req.param('key'), body.kind, body.target, body.actorId);
    rt.publishChange(c.req.param('key').toUpperCase(), Number(body.actorId), 'relation');
    rt.publishChange(String(body.target).toUpperCase(), Number(body.actorId), 'relation');
    return c.json(relations, 201);
  });

  app.delete('/api/issues/:key/relations/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const relations = removeRelation(db, c.req.param('key'), Number(c.req.param('id')), (body as { actorId: number }).actorId);
    rt.publishChange(c.req.param('key').toUpperCase(), Number((body as { actorId: number }).actorId), 'relation');
    return c.json(relations);
  });

  app.put('/api/issues/:key/watch', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    const watchers = setWatching(db, c.req.param('key'), body.actorId, Boolean(body.watching));
    rt.publishChange(c.req.param('key').toUpperCase(), Number(body.actorId), 'watch');
    return c.json(watchers);
  });

  // ---- lineage ----

  app.get('/api/issues/:key/lineage', (c) => {
    const issue = getIssueByKey(db, c.req.param('key'));
    const labels = (db.prepare('SELECT label FROM issue_labels WHERE issue_id = ?').all(issue.id) as { label: string }[]).map((r) => r.label);
    return c.json(computeLineage(db, issue, labels));
  });

  app.get('/api/issues/:key/ancestry', (c) => {
    const issue = getIssueByKey(db, c.req.param('key'));
    return c.json({ chain: ancestryChain(db, issue.id) });
  });

  // ---- products ----

  app.post('/api/products', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    return c.json(createProduct(db, body), 201);
  });

  app.post('/api/products/:key/components', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    return c.json(createComponent(db, c.req.param('key'), body), 201);
  });

  // ---- live collaboration ----

  app.put('/api/issues/:key/presence', async (c) => {
    const issue = getIssueByKey(db, c.req.param('key'));
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const actorId = Number((body as { actorId?: unknown }).actorId);
    if (!Number.isInteger(actorId)) throw new ApiError(400, 'actor_required', 'actorId is required for presence.');
    const leaving = Boolean((body as { leaving?: unknown }).leaving);
    const viewers = leaving ? (rt.leave(issue.key, actorId), rt.currentViewers(issue.key)) : rt.touchPresence(issue.key, actorId);
    return c.json({ viewers });
  });

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      const unsubscribe = rt.subscribe((ev) => {
        if (!alive) return;
        void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      });
      stream.onAbort(() => {
        alive = false;
        unsubscribe();
      });
      await stream.writeSSE({ event: 'hello', data: '{}' });
      // keepalive comments so proxies don't reap the connection
      while (alive) {
        await new Promise((r) => setTimeout(r, 25_000));
        if (alive) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    }),
  );

  // ---- analytics & graph ----

  app.get('/api/analytics/summary', (c) => c.json(analyticsSummary(db, c.req.query('product'))));
  app.get('/api/graph', (c) => c.json(dependencyGraph(db, c.req.query('product'))));

  return app;
}
