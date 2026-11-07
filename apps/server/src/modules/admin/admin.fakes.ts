import type { OrgUnit } from './admin.org.js';
import { DuplicateOrgUnitError, type AdminStore } from './admin.service.js';

/** In-memory AdminStore for tests, same semantics as AdminRepo. */
export class InMemoryAdminStore implements AdminStore {
  units = new Map<string, OrgUnit>();
  config = new Map<string, { value: string; updatedBy: string }>();
  /** How many times the org table was read, to observe the service cache. */
  listCalls = 0;

  async listOrgUnits() {
    this.listCalls += 1;
    return [...this.units.values()].map((u) => ({ ...u, supervisorIds: [...u.supervisorIds] }));
  }

  async createOrgUnit(unit: OrgUnit) {
    if (this.units.has(unit.id)) throw new DuplicateOrgUnitError(unit.id);
    this.units.set(unit.id, { ...unit });
    return { ...unit };
  }

  async updateOrgUnit(id: string, changes: Partial<Pick<OrgUnit, 'name' | 'supervisorIds'>>) {
    const unit = this.units.get(id);
    if (!unit) return null;
    Object.assign(unit, changes);
    return { ...unit, supervisorIds: [...unit.supervisorIds] };
  }

  async listConfig() {
    return [...this.config].map(([key, { value }]) => ({ key, value }));
  }

  async getConfig(key: string) {
    return this.config.get(key)?.value;
  }

  async setConfig(key: string, value: string, updatedBy: string) {
    this.config.set(key, { value, updatedBy });
  }
}
