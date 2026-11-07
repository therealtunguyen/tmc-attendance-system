export { chainHash, GENESIS_HASH, verifyChain } from './iam.audit-chain.js';
export { hashPassword, MFA_ROLES, newTotpSecret, otpauthUri, passwordProblem } from './iam.auth.js';
export { IamRepo } from './iam.repo.js';
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
export { authenticate, iamRoutes } from './iam.routes.js';
export { IamService } from './iam.service.js';
export type {
  AuditEntry,
  AuditFilter,
  AuditLog,
  AuditReader,
  AuditStore,
  Authenticator,
  Authorizer,
  ChainedEntry,
  ChainVerdict,
  Role,
  ScopeResolver,
  UserRecord,
  UserRef,
  UserStore,
} from './iam.service.js';
