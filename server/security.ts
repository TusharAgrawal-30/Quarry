import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

// Security middleware: headers, CORS, rate limiting, payload caps.
// Everything here is framework-level defense; field-level validation
// lives with the domain rules in store.ts.

export interface SecurityOptions {
  /** Explicit CORS allowlist — never a wildcard. */
  allowedOrigins?: string[];
  /** Sliding-window rate limit for mutating requests. */
  rateLimit?: { max: number; windowMs: number };
  /** Reject request bodies larger than this many bytes. */
  maxBodyBytes?: number;
}

export const DEFAULTS: Required<SecurityOptions> = {
  allowedOrigins: ['http://localhost:5000', 'http://localhost:5173'],
  rateLimit: { max: 120, windowMs: 60_000 },
  maxBodyBytes: 64 * 1024,
};

export function originsFromEnv(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULTS.allowedOrigins;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Standard security headers. The CSP is strict-by-default with two
 * deliberate allowances: Google Fonts (stylesheet + font files) and inline
 * styles (React style props). No remote scripts, no framing, no sniffing.
 */
export function headersMiddleware(): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'no-referrer',
    crossOriginOpenerPolicy: 'same-origin',
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  });
}

export function corsMiddleware(allowedOrigins: string[]): MiddlewareHandler {
  return cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type'],
    maxAge: 600,
  });
}

function clientKey(c: Context): string {
  // Behind a proxy (Render/Railway/Fly) the client is in x-forwarded-for;
  // locally there may be no address at all (in-process tests) — bucket those.
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'direct';
}

/**
 * In-memory sliding-window limiter for mutating routes. Deliberately simple:
 * one process, one map, timestamps pruned per hit. 429 + Retry-After when a
 * client exceeds `max` mutations per window.
 */
export function rateLimitMiddleware(opts: { max: number; windowMs: number }): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  return async (c, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return next();

    const now = Date.now();
    // periodic global sweep so idle keys don't accumulate forever
    if (now - lastSweep > opts.windowMs * 4) {
      for (const [k, arr] of hits) {
        const kept = arr.filter((t) => now - t < opts.windowMs);
        if (kept.length) hits.set(k, kept);
        else hits.delete(k);
      }
      lastSweep = now;
    }

    const key = clientKey(c);
    const windowHits = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (windowHits.length >= opts.max) {
      const retryAfter = Math.ceil((opts.windowMs - (now - windowHits[0])) / 1000);
      c.header('Retry-After', String(Math.max(retryAfter, 1)));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many write requests — limit is ${opts.max} per ${Math.round(opts.windowMs / 1000)}s. Try again shortly.`,
        },
        429,
      );
    }
    windowHits.push(now);
    hits.set(key, windowHits);
    return next();
  };
}

/** Reject oversized request bodies up front with a clear 413. */
export function bodyLimitMiddleware(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > maxBytes) {
      return c.json(
        {
          error: 'payload_too_large',
          message: `Request body is ${len} bytes; the limit is ${maxBytes}. Trim the description or split the change.`,
        },
        413,
      );
    }
    return next();
  };
}
