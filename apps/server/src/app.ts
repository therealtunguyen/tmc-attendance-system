import express, { type RequestHandler, type Router } from 'express';
import { config } from './shared/config.js';

/** Builds the Express app without listening, so tests can use it directly. */
export const createApp = (
  routers: Router[] = [],
  options: { before?: RequestHandler[]; edge?: RequestHandler } = {},
) => {
  const app = express();
  // Needed for req.ip (rate limits) behind a reverse proxy (#113 D4).
  app.set('trust proxy', config.trustProxy);
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  for (const handler of options.before ?? []) app.use('/api', handler);
  if (options.edge) app.use('/api/edge', options.edge);
  for (const router of routers) app.use('/api', router);
  return app;
};
