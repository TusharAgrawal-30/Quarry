import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { originsFromEnv } from './security.js';
import { isSeeded, seedDb } from './seed.js';

const db = openDb();
if (!isSeeded(db)) {
  console.log('[quarry] empty database — seeding the demo corpus (a few seconds)…');
  seedDb(db);
}

const app = createApp(db, { allowedOrigins: originsFromEnv() });

// In production the API server also serves the built SPA.
const dist = path.join(process.cwd(), 'client', 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use('/assets/*', serveStatic({ root: './client/dist' }));
  app.get('*', serveStatic({ root: './client/dist', rewriteRequestPath: () => '/index.html' }));
}

const port = Number(process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 5000 : 5050));
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[quarry] api listening on http://localhost:${info.port}`);
});
