export { chainHash, GENESIS_HASH, verifyChain } from './iam.audit-chain.js';
export { hashPassword, MFA_ROLES, newTotpSecret, otpauthUri, passwordProblem } from './iam.auth.js';
export { IamRepo } from './iam.repo.js';
export { createRateLimiter, type RateLimitOptions } from './iam.ratelimit.js';
export {
  canSeeEmployee,
  check,
  hasPermission,
  inScope,
  isRestricted,
  PERMISSIONS,
  requirePermission,
} from './iam.rbac.js';
export type { Permission } from './iam.rbac.js';
export { authenticate, iamRoutes, requireNoticeAck } from './iam.routes.js';
export { IamService, NoticeError } from './iam.service.js';
export type {
  AuditEntry,
  AuditFilter,
  AuditLog,
  AuditReader,
  AuditStore,
  Authenticator,
  Authorizer,
  Notice,
  NoticeStore,
  ChainedEntry,
  ChainVerdict,
  Role,
  ScopeResolver,
  UserRecord,
  UserRef,
  UserStore,
} from './iam.service.js';
