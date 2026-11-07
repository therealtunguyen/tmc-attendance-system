import express, { type RequestHandler, type Router } from 'express';

/** Builds the Express app without listening, so tests can use it directly. */
export const createApp = (routers: Router[] = [], options: { before?: RequestHandler[] } = {}) => {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  for (const handler of options.before ?? []) app.use('/api', handler);
  for (const router of routers) app.use('/api', router);
  return app;
};
