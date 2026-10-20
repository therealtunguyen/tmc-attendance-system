import { Router } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { AdminService } from './admin.service.js';

export const adminRoutes = (_admin: AdminService) =>
  Router().get('/org-units', notImplemented).put('/config/:key', notImplemented);
