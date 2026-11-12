import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Authenticates an edge agent on `/api/edge/*` using a shared secret from `EDGE_TOKENS` (#69).
 * Sets `res.locals.edgeId` from the matched token so route handlers never trust `edgeId` from the body.
 * Fails closed with 401 when `edgeTokens` is empty or the Bearer token is missing/unknown.
 */
export const authenticateEdge = (edgeTokens: Record<string, string>): RequestHandler => {
  const entries = Object.entries(edgeTokens).map(([edgeId, token]) => ({
    edgeId,
    digest: sha256(token),
  }));

  return (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match?.[1]) {
      return void res.status(401).json({ error: 'Edge authentication required' });
    }
    const presented = sha256(match[1]);
    let matchedEdgeId: string | undefined;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.digest)) {
        matchedEdgeId = entry.edgeId;
      }
    }
    if (!matchedEdgeId) {
      return void res.status(401).json({ error: 'Invalid edge credential' });
    }
    res.locals.edgeId = matchedEdgeId;
    next();
  };
};
