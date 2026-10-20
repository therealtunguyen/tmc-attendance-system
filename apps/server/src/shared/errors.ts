import type { RequestHandler } from 'express';

export class NotImplementedError extends Error {
  constructor(what = 'Not implemented') {
    super(what);
  }
}

/** Placeholder for stub methods. */
export const todo = (): never => {
  throw new NotImplementedError();
};

/** Placeholder route handler: 501 until the feature is built. */
export const notImplemented: RequestHandler = (_req, res) => {
  res.status(501).json({ error: 'Not implemented' });
};
