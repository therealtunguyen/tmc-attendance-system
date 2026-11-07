export { chainHash, GENESIS_HASH, verifyChain } from './iam.audit-chain.js';
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
export { iamRoutes } from './iam.routes.js';
export { IamService } from './iam.service.js';
export type {
  AuditEntry,
  AuditFilter,
  AuditLog,
  AuditReader,
  AuditStore,
  Authorizer,
  ChainedEntry,
  ChainVerdict,
  Role,
  UserRef,
} from './iam.service.js';
