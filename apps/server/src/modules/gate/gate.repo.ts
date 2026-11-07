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

const writeError = (error: unknown): never => {
  if (errorCode(error) === 'P2002') throw new DuplicateTurnstileError();
  if (errorCode(error) === 'P2003') throw new InvalidGateEdgeError();
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
