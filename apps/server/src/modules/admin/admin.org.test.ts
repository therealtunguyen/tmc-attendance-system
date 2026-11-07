import { describe, expect, it } from 'vitest';
import {
  descendants,
  factoryOf,
  parentProblem,
  supervisedTeams,
  type OrgUnit,
} from './admin.org.js';

const unit = (id: string, kind: OrgUnit['kind'], parentId: string | null, sup: string[] = []) => ({
  id,
  kind,
  name: id,
  parentId,
  supervisorIds: sup,
});

const units: OrgUnit[] = [
  unit('bd', 'FACTORY', null),
  unit('bd-sew', 'DEPARTMENT', 'bd'),
  unit('bd-line-1', 'TEAM', 'bd-sew', ['u1']),
  unit('bd-line-2', 'TEAM', 'bd-sew', ['u1', 'u2']),
  unit('la', 'FACTORY', null),
  unit('la-cut', 'DEPARTMENT', 'la'),
  unit('la-line-1', 'TEAM', 'la-cut', ['u3']),
];

describe('parentProblem', () => {
  it('accepts FACTORY > DEPARTMENT > TEAM', () => {
    expect(parentProblem(units, 'FACTORY', null)).toBeNull();
    expect(parentProblem(units, 'DEPARTMENT', 'bd')).toBeNull();
    expect(parentProblem(units, 'TEAM', 'bd-sew')).toBeNull();
  });

  it.each([
    ['a factory with a parent', 'FACTORY', 'bd'],
    ['a department without a parent', 'DEPARTMENT', null],
    ['a department under a department', 'DEPARTMENT', 'bd-sew'],
    ['a team under a factory', 'TEAM', 'bd'],
    ['a team without a parent', 'TEAM', null],
    ['an unknown parent', 'TEAM', 'nope'],
  ] as const)('rejects %s', (_name, kind, parentId) => {
    expect(parentProblem(units, kind, parentId)).toEqual(expect.any(String));
  });
});

describe('tree helpers', () => {
  it('descendants returns the given IDs plus everything below', () => {
    expect(descendants(units, ['bd']).sort()).toEqual(['bd', 'bd-line-1', 'bd-line-2', 'bd-sew']);
    expect(descendants(units, ['bd-line-1'])).toEqual(['bd-line-1']);
    expect(descendants(units, ['x'])).toEqual(['x']);
    expect(descendants(units, [])).toEqual([]);
  });

  it('factoryOf walks up to the factory', () => {
    expect(factoryOf(units, 'bd-line-2')?.id).toBe('bd');
    expect(factoryOf(units, 'la')?.id).toBe('la');
    expect(factoryOf(units, 'nope')).toBeNull();
  });

  it('supervisedTeams lists the teams of a user', () => {
    expect(supervisedTeams(units, 'u1')).toEqual(['bd-line-1', 'bd-line-2']);
    expect(supervisedTeams(units, 'u3')).toEqual(['la-line-1']);
    expect(supervisedTeams(units, 'nobody')).toEqual([]);
  });
});
