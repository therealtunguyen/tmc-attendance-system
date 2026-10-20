import { Router } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { IamService } from './iam.service.js';

export const iamRoutes = (_iam: IamService) =>
  Router().post('/auth/login', notImplemented).get('/audit', notImplemented);
