import { todo } from '../../shared/errors.js';
import type { AdminRepo } from './admin.repo.js';

export interface OrgUnit {
  id: string;
  kind: 'FACTORY' | 'DEPARTMENT' | 'TEAM';
  name: string;
  parentId: string | null;
}

export interface ConfigReader {
  get(key: string): Promise<string | undefined>;
  orgUnits(): Promise<OrgUnit[]>;
}

/** Organisation structure and configuration values (FR-5.3, FR-5.4). */
export class AdminService implements ConfigReader {
  constructor(private repo: AdminRepo) {}

  async get(): Promise<string | undefined> {
    return todo();
  }

  async orgUnits(): Promise<OrgUnit[]> {
    return todo();
  }
}
