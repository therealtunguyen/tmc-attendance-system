import { Router } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { EmployeeQrService } from './employee-qr.service.js';

export const employeeQrRoutes = (_eqr: EmployeeQrService) =>
  Router()
    .get('/employees', notImplemented)
    .post('/employees', notImplemented)
    .get('/me/qr', notImplemented)
    .post('/employees/:id/qr/revoke', notImplemented);
