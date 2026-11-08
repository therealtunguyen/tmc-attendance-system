import type { Request, RequestHandler, Response } from 'express';

export interface RateLimitOptions {
  max?: number;
  windowMs?: number;
  clock?: () => number;
  /** What one budget belongs to. Default req.ip; a route behind requirePermission can key by user. */
  key?: (req: Request, res: Response) => string;
}

/**
 * Fixed-window limiter keyed by req.ip unless `key` says otherwise. Per process: behind a proxy set
 * Express `trust proxy`, otherwise every client shares the proxy's IP; with several instances a shared
 * store is needed.
 */
export const createRateLimiter = ({
  max = 10,
  windowMs = 60_000,
  clock = Date.now,
  key: keyOf = (req) => req.ip ?? 'unknown',
}: RateLimitOptions = {}): RequestHandler => {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = clock();
    // Prune on access. Windows are inserted in resetAt order, so stop at the first live one.
    for (const [key, w] of windows) {
      if (w.resetAt > now) break;
      windows.delete(key);
    }
    const key = keyOf(req, res);
    const w = windows.get(key) ?? { count: 0, resetAt: now + windowMs };
    w.count += 1;
    windows.set(key, w);
    if (w.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((w.resetAt - now) / 1000))));
      return void res.status(429).json({ error: 'Too many attempts, try again later' });
    }
    next();
  };
};
