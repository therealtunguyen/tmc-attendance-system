import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { Router } from 'express';
import { authenticateEdge } from './iam.edge-auth.js';
import { authenticate } from './iam.routes.js';
import type { Authenticator } from './iam.service.js';

describe('authenticateEdge (#69)', () => {
  const probe = () =>
    Router().get('/edge/probe', (_req, res) => {
      res.json({ edgeId: res.locals.edgeId });
    });

  const app = (tokens: Record<string, string> = { 'edge-bd': 'sec-bd', 'edge-la': 'sec-la' }) =>
    createApp([probe()], { edge: authenticateEdge(tokens) });

  it('sets res.locals.edgeId from the matched token', async () => {
    const res = await request(app()).get('/api/edge/probe').set('Authorization', 'Bearer sec-la');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ edgeId: 'edge-la' });
  });

  it('rejects missing, malformed, or wrong bearer credentials with 401', async () => {
    for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer wrong']) {
      const req = request(app()).get('/api/edge/probe');
      if (header !== undefined) req.set('Authorization', header);
      const res = await req;
      expect(res.status).toBe(401);
    }
  });

  it('fails closed with 401 when EDGE_TOKENS is empty', async () => {
    const res = await request(app({})).get('/api/edge/probe').set('Authorization', 'Bearer sec-bd');
    expect(res.status).toBe(401);
  });

  it('skips user session lookup in authenticate() for /api/edge/* routes', async () => {
    const authenticateFn = vi.fn(async () => null);
    const authSpy = { authenticate: authenticateFn } as unknown as Authenticator;
    const wired = createApp([probe()], {
      before: [authenticate(authSpy)],
      edge: authenticateEdge({ 'edge-bd': 'sec-bd' }),
    });
    const res = await request(wired).get('/api/edge/probe').set('Authorization', 'Bearer sec-bd');
    expect(res.status).toBe(200);
    expect(authenticateFn).not.toHaveBeenCalled();
  });
});
