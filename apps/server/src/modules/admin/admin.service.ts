import type { Scope } from '../../shared/types.js';
import type { AuditLog, ScopeResolver, UserRef } from '../iam/index.js';
import {
  CONFIG,
  isConfigKey,
  parseConfig,
  type ConfigKey,
  type ConfigValues,
} from './admin.config.js';
import {
  descendants,
  factoryOf,
  ORG_KINDS,
  parentProblem,
  SLUG,
  supervisedTeams,
  type OrgKind,
  type OrgUnit,
} from './admin.org.js';

export type { OrgKind, OrgUnit } from './admin.org.js';

export interface ConfigReader {
  get(key: string): Promise<string | undefined>;
  orgUnits(): Promise<OrgUnit[]>;
}

export class InvalidOrgUnitError extends Error {}
export class OrgUnitNotFoundError extends Error {
  constructor(id: string) {
    super(`Org unit ${id} not found`);
  }
}
export class DuplicateOrgUnitError extends Error {
  constructor(id: string) {
    super(`Org unit ${id} already exists`);
  }
}
export class UnknownConfigKeyError extends Error {
  constructor(key: string) {
    super(`Unknown config key ${key}`);
  }
}
export class InvalidConfigError extends Error {}

/** Storage the service needs. The Prisma repo implements it; tests use an in-memory one. */
export interface AdminStore {
  listOrgUnits(): Promise<OrgUnit[]>;
  /** Throws DuplicateOrgUnitError. */
  createOrgUnit(unit: OrgUnit): Promise<OrgUnit>;
  /** Null when the unit does not exist. */
  updateOrgUnit(
    id: string,
    changes: Partial<Pick<OrgUnit, 'name' | 'supervisorIds'>>,
  ): Promise<OrgUnit | null>;
  /** Stored values only; keys never set are absent. */
  listConfig(): Promise<{ key: string; value: string }[]>;
  getConfig(key: string): Promise<string | undefined>;
  setConfig(key: string, value: string, updatedBy: string): Promise<void>;
}

export interface ConfigEntry {
  key: ConfigKey;
  value: string;
  default: string;
  description: string;
  /** true = an admin has set it; false = the default applies. */
  set: boolean;
}

/** Organisation structure and configuration values (FR-5.3, FR-5.4, FR-5.5). */
export class AdminService implements ConfigReader, ScopeResolver {
  // The org table is small and the server is a single process, so the tree is cached in memory
  // and dropped on every write. The version stops a read that started before a write from
  // repopulating the cache with stale rows.
  private cache: OrgUnit[] | null = null;
  private version = 0;

  constructor(
    private store: AdminStore,
    private audit: AuditLog,
  ) {}

  async get(key: string): Promise<string | undefined> {
    if (!isConfigKey(key)) return undefined;
    return (await this.store.getConfig(key)) ?? CONFIG[key].default;
  }

  /** The parsed value of a known key: the stored one, or the default. */
  async config<K extends ConfigKey>(key: K): Promise<ConfigValues[K]> {
    return parseConfig(key, await this.store.getConfig(key));
  }

  async allConfig(): Promise<ConfigEntry[]> {
    const stored = new Map((await this.store.listConfig()).map((r) => [r.key, r.value]));
    return (Object.keys(CONFIG) as ConfigKey[]).map((key) => ({
      key,
      value: stored.get(key) ?? CONFIG[key].default,
      default: CONFIG[key].default,
      description: CONFIG[key].description,
      set: stored.has(key),
    }));
  }

  /** The factory a team belongs to; null for an unknown ID or one that is not a TEAM. */
  async factoryOf(teamId: string): Promise<string | null> {
    const units = await this.orgUnits();
    if (units.find((u) => u.id === teamId)?.kind !== 'TEAM') return null;
    return factoryOf(units, teamId)?.id ?? null;
  }

  async orgUnits(): Promise<OrgUnit[]> {
    if (!this.cache) {
      const version = this.version;
      const units = await this.store.listOrgUnits();
      if (version === this.version) this.cache = units;
      return units.map((u) => ({ ...u, supervisorIds: [...u.supervisorIds] }));
    }
    return this.cache.map((u) => ({ ...u, supervisorIds: [...u.supervisorIds] }));
  }

  async createOrgUnit(
    actorId: string,
    input: { id: string; kind: string; name: string; parentId: string | null },
  ): Promise<OrgUnit> {
    if (!SLUG.test(input.id)) {
      throw new InvalidOrgUnitError('id must be 2 to 63 characters of a-z, 0-9 and -');
    }
    if (!ORG_KINDS.includes(input.kind as OrgKind)) {
      throw new InvalidOrgUnitError(`kind must be one of ${ORG_KINDS.join(', ')}`);
    }
    const name = input.name.trim();
    if (name === '') throw new InvalidOrgUnitError('name must not be empty');
    const units = await this.orgUnits();
    if (units.some((u) => u.id === input.id)) throw new DuplicateOrgUnitError(input.id);
    const problem = parentProblem(units, input.kind as OrgKind, input.parentId);
    if (problem) throw new InvalidOrgUnitError(problem);
    const unit = await this.write(() =>
      this.store.createOrgUnit({
        id: input.id,
        kind: input.kind as OrgKind,
        name,
        parentId: input.parentId,
        supervisorIds: [],
      }),
    );
    // TODO(#45): write the change and its audit entry in one transaction
    await this.record(actorId, 'ORG_UNIT_CREATE', `org:${unit.id}`, undefined, unit);
    return unit;
  }

  /** Only the name can change: moving a unit to another parent is not supported. */
  async renameOrgUnit(actorId: string, id: string, name: string): Promise<OrgUnit> {
    const trimmed = name.trim();
    if (trimmed === '') throw new InvalidOrgUnitError('name must not be empty');
    const before = await this.find(id);
    const unit = await this.write(() => this.store.updateOrgUnit(id, { name: trimmed }));
    if (!unit) throw new OrgUnitNotFoundError(id);
    // TODO(#45): write the change and its audit entry in one transaction
    await this.record(
      actorId,
      'ORG_UNIT_RENAME',
      `org:${id}`,
      { name: before.name },
      { name: unit.name },
    );
    return unit;
  }

  /** Replaces the supervisors of a team (BR-15). User IDs are not checked against IAM. */
  async setSupervisors(actorId: string, teamId: string, userIds: string[]): Promise<OrgUnit> {
    const before = await this.find(teamId);
    if (before.kind !== 'TEAM') {
      throw new InvalidOrgUnitError('Supervisors can only be set on a TEAM');
    }
    const supervisorIds = [...new Set(userIds)];
    const unit = await this.write(() => this.store.updateOrgUnit(teamId, { supervisorIds }));
    if (!unit) throw new OrgUnitNotFoundError(teamId);
    // TODO(#45): write the change and its audit entry in one transaction
    await this.record(
      actorId,
      'TEAM_SUPERVISORS_SET',
      `org:${teamId}`,
      { supervisorIds: before.supervisorIds },
      { supervisorIds: unit.supervisorIds },
    );
    return unit;
  }

  async setConfig(actorId: string, key: string, raw: string): Promise<ConfigEntry> {
    if (!isConfigKey(key)) throw new UnknownConfigKeyError(key);
    const value = raw.trim();
    if (CONFIG[key].parse(value) === undefined) {
      throw new InvalidConfigError(`${key}: ${CONFIG[key].description}`);
    }
    const before = (await this.get(key)) as string;
    await this.store.setConfig(key, value, actorId);
    // TODO(#45): write the change and its audit entry in one transaction
    await this.record(actorId, 'CONFIG_CHANGE', `config:${key}`, { value: before }, { value });
    return {
      key,
      value,
      default: CONFIG[key].default,
      description: CONFIG[key].description,
      set: true,
    };
  }

  /** Widens scopes down the tree (BR-15): a factory scope covers its departments and teams, a SUP also gets the teams they supervise. */
  async expandScopes(user: UserRef): Promise<UserRef> {
    if (user.role !== 'SUP' && user.scopes === undefined) return user;
    const units = await this.orgUnits();
    const own: Scope[] = [...(user.scopes ?? [])];
    if (user.role === 'SUP') own.push(...supervisedTeams(units, user.id));
    return { ...user, scopes: descendants(units, own) };
  }

  private async find(id: string): Promise<OrgUnit> {
    const unit = (await this.orgUnits()).find((u) => u.id === id);
    if (!unit) throw new OrgUnitNotFoundError(id);
    return unit;
  }

  /** Runs a store write and drops the cache whether or not it succeeds. */
  private async write<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } finally {
      this.version += 1;
      this.cache = null;
    }
  }

  private record(
    actorId: string,
    action: string,
    target: string,
    before?: unknown,
    after?: unknown,
  ) {
    return this.audit.append({ actorId, action, target, at: new Date(), before, after });
  }
}
