import type { Scope } from '../../shared/types.js';

export type OrgKind = 'FACTORY' | 'DEPARTMENT' | 'TEAM';

export interface OrgUnit {
  id: string;
  kind: OrgKind;
  name: string;
  parentId: string | null;
  /** IAM user IDs supervising the unit; only used on TEAM (BR-15). */
  supervisorIds: string[];
}

export const ORG_KINDS: readonly OrgKind[] = ['FACTORY', 'DEPARTMENT', 'TEAM'];

/** IDs are chosen by the client: Employee.factoryId and User.scopes already hold slugs like 'binh-duong'. */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** The kind a unit's parent must have; null = no parent (FR-5.5). */
export const PARENT_KIND: Record<OrgKind, OrgKind | null> = {
  FACTORY: null,
  DEPARTMENT: 'FACTORY',
  TEAM: 'DEPARTMENT',
};

/** An error message when the parent does not fit the kind, else null. */
export const parentProblem = (
  units: readonly OrgUnit[],
  kind: OrgKind,
  parentId: string | null,
): string | null => {
  const expected = PARENT_KIND[kind];
  if (expected === null) return parentId === null ? null : `A ${kind} has no parent`;
  if (parentId === null) return `A ${kind} needs a ${expected} as parent`;
  const parent = units.find((u) => u.id === parentId);
  if (!parent) return `Parent ${parentId} does not exist`;
  return parent.kind === expected ? null : `The parent of a ${kind} must be a ${expected}`;
};

/** The given IDs plus every unit below them. */
export const descendants = (units: readonly OrgUnit[], ids: readonly Scope[]): Scope[] => {
  const result = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const unit of units) {
      if (unit.parentId !== null && result.has(unit.parentId) && !result.has(unit.id)) {
        result.add(unit.id);
        grew = true;
      }
    }
  }
  return [...result];
};

/** The factory at the top of a unit's chain; null for an unknown ID. */
export const factoryOf = (units: readonly OrgUnit[], id: Scope): OrgUnit | null => {
  const byId = new Map(units.map((u) => [u.id, u]));
  let unit = byId.get(id);
  for (let hops = 0; unit && hops <= units.length; hops++) {
    if (unit.parentId === null) return unit.kind === 'FACTORY' ? unit : null;
    unit = byId.get(unit.parentId);
  }
  return null;
};

/** IDs of the teams the user supervises. */
export const supervisedTeams = (units: readonly OrgUnit[], userId: string): Scope[] =>
  units.filter((u) => u.kind === 'TEAM' && u.supervisorIds.includes(userId)).map((u) => u.id);
