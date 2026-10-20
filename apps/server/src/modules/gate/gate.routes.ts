import { Router } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { GateService } from './gate.service.js';

export const gateRoutes = (_gate: GateService) =>
  Router()
    .post('/kiosk/scan', notImplemented)
    .post('/kiosk/heartbeat', notImplemented)
    .get('/gates', notImplemented)
    .post('/gates/:gateId/override', notImplemented);
