import type { PrismaClient } from '../../shared/prisma.js';
import {
  DuplicateTurnstileError,
  InvalidGateEdgeError,
  type Gate,
  type GateChanges,
  type GateFilters,
  type GateStore,
  type NewGate,
} from './gate.service.js';

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

const constraintMatches = (error: unknown, fields: string[], name: string): boolean => {
  const meta = (
    error as {
      meta?: {
        target?: unknown;
        field_name?: unknown;
        driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } };
      };
    } | null
  )?.meta;
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  const target = meta?.target ?? constraint?.index ?? constraint?.fields ?? meta?.field_name;
  return (
    target === name ||
    target === `${name} (index)` ||
    (Array.isArray(target) &&
      target.length === fields.length &&
      fields.every((field) => target.includes(field)))
  );
};

const writeError = (error: unknown): never => {
  if (
    errorCode(error) === 'P2002' &&
    constraintMatches(error, ['turnstileId'], 'Gate_turnstileId_key')
  ) {
    throw new DuplicateTurnstileError();
  }
  if (
    errorCode(error) === 'P2003' &&
    constraintMatches(error, ['edgeId', 'factoryId'], 'Gate_edgeId_factoryId_fkey')
  ) {
    throw new InvalidGateEdgeError();
  }
  throw error;
};

/** Owns Gate and Edge. No reads of other modules' tables. */
export class GateRepo implements GateStore {
  constructor(private db: PrismaClient) {}

  async create(data: NewGate): Promise<Gate> {
    try {
      return await this.db.gate.create({ data });
    } catch (error) {
      return writeError(error);
    }
  }

  list(filters: GateFilters, factoryIds?: string[]): Promise<Gate[]> {
    return this.db.gate.findMany({
      where: {
        ...filters,
        ...(factoryIds !== undefined ? { AND: [{ factoryId: { in: factoryIds } }] } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  find(id: string): Promise<Gate | null> {
    return this.db.gate.findUnique({ where: { id } });
  }

  async update(id: string, changes: GateChanges): Promise<Gate | null> {
    try {
      return await this.db.gate.update({ where: { id }, data: changes });
    } catch (error) {
      if (errorCode(error) === 'P2025') return null;
      return writeError(error);
    }
  }

  async deactivate(id: string): Promise<Gate | null> {
    // RETURNING captures the actual changed row. Only one of two concurrent callers wins.
    const [gate] = await this.db.gate.updateManyAndReturn({
      where: { id, active: true },
      data: { active: false },
    });
    return gate ?? null;
  }

  findEdge(id: string) {
    return this.db.edge.findUnique({ where: { id }, select: { id: true, factoryId: true } });
  }
}
