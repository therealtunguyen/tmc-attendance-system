import { Router } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { ReportingService } from './reporting.service.js';

export const reportingRoutes = (_reporting: ReportingService) =>
  Router()
    .get('/reports/monthly', notImplemented)
    .get('/reports/monthly.csv', notImplemented)
    .get('/access-log', notImplemented)
    .post('/exports/:month/rerun', notImplemented);
