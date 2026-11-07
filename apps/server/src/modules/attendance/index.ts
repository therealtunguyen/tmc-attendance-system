export { buildDailyRecords } from './attendance.daily.js';
export { AttendanceRepo } from './attendance.repo.js';
export { attendanceRoutes } from './attendance.routes.js';
export {
  AttendanceService,
  OutcomeConflictError,
  UnknownEventError,
} from './attendance.service.js';
export type {
  AttendanceQuery,
  AttendanceRecorder,
  AttendanceStore,
  DailyRecord,
  EdgeIngest,
  ScanEvent,
  ScanOutcome,
  StoredEvent,
} from './attendance.service.js';
