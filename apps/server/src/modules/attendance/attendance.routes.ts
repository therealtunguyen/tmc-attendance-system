import { Router } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { AttendanceService } from './attendance.service.js';

export const attendanceRoutes = (_attendance: AttendanceService) =>
  Router()
    .get('/me/attendance', notImplemented)
    .post('/attendance/:recordId/corrections', notImplemented);
