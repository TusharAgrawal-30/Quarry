import { Hono } from 'hono';
import type { DB } from './db.js';
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

export function createApp(db: DB): Hono {
  const app = new Hono();

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
    return c.json(updateIssue(db, c.req.param('key'), patch, actorId));
  });

  app.post('/api/issues/:key/transition', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    return c.json(transitionIssue(db, c.req.param('key'), body));
  });

  app.post('/api/issues/:key/comments', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    return c.json(addComment(db, c.req.param('key'), body.body, body.actorId), 201);
  });

  app.post('/api/issues/:key/relations', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    return c.json(addRelation(db, c.req.param('key'), body.kind, body.target, body.actorId), 201);
  });

  app.delete('/api/issues/:key/relations/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    return c.json(removeRelation(db, c.req.param('key'), Number(c.req.param('id')), (body as { actorId: number }).actorId));
  });

  app.put('/api/issues/:key/watch', async (c) => {
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
    });
    return c.json(setWatching(db, c.req.param('key'), body.actorId, Boolean(body.watching)));
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

  // ---- analytics & graph ----

  app.get('/api/analytics/summary', (c) => c.json(analyticsSummary(db, c.req.query('product'))));
  app.get('/api/graph', (c) => c.json(dependencyGraph(db, c.req.query('product'))));

  return app;
}
