import express, { type Router } from 'express';

/** Builds the Express app without listening, so tests can use it directly. */
export const createApp = (routers: Router[] = []) => {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  for (const router of routers) app.use('/api', router);
  return app;
};
