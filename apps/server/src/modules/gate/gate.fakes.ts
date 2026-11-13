import { randomUUID } from 'node:crypto';
import type { AuditEntry, AuditLog } from '../iam/index.js';
import type { Notifier } from '../reporting/index.js';
import {
  DuplicateTurnstileError,
  GateService,
  InvalidGateEdgeError,
  type Gate,
  type GateChanges,
  type GateFilters,
  type GateOptions,
  type GateStore,
  type NewGate,
} from './gate.service.js';

export class InMemoryGates implements GateStore {
  rows = new Map<string, Gate>();
  edges = new Map([
    [
      'edge-bd',
      {
        id: 'edge-bd',
        factoryId: 'binh-duong',
        lastHeartbeatAt: null as Date | null,
        lastSyncAt: null as Date | null,
      },
    ],
    [
      'edge-la',
      {
        id: 'edge-la',
        factoryId: 'long-an',
        lastHeartbeatAt: null as Date | null,
        lastSyncAt: null as Date | null,
      },
    ],
  ]);

  async create(data: NewGate) {
    this.check(data);
    const gate: Gate = {
      ...data,
      id: randomUUID(),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(gate.id, gate);
    return { ...gate };
  }

  async list(filters: GateFilters, factoryIds?: string[]) {
    return [...this.rows.values()]
      .filter(
        (gate) =>
          (factoryIds === undefined || factoryIds.includes(gate.factoryId)) &&
          (filters.factoryId === undefined || gate.factoryId === filters.factoryId) &&
          (filters.edgeId === undefined || gate.edgeId === filters.edgeId) &&
          (filters.active === undefined || gate.active === filters.active),
      )
      .map((gate) => ({ ...gate }));
  }

  async find(id: string) {
    const gate = this.rows.get(id);
    return gate ? { ...gate } : null;
  }

  async update(id: string, changes: GateChanges) {
    const before = this.rows.get(id);
    if (!before) return null;
    const gate = { ...before, ...changes, updatedAt: new Date() };
    this.check(gate, id);
    this.rows.set(id, gate);
    return { ...gate };
  }

  async deactivate(id: string) {
    const gate = this.rows.get(id);
    if (!gate || !gate.active) return null;
    gate.active = false;
    gate.updatedAt = new Date();
    return { ...gate };
  }

  async findEdge(id: string) {
    return this.edges.get(id) ?? null;
  }

  async heartbeats(edgeIds: string[]) {
    return [...this.edges.values()].filter((edge) => edgeIds.includes(edge.id));
  }

  async recordHeartbeat(id: string, at: Date, syncedAt: Date | null) {
    const edge = this.edges.get(id);
    if (!edge) return false;
    if (!edge.lastHeartbeatAt || edge.lastHeartbeatAt < at) edge.lastHeartbeatAt = at;
    if (syncedAt && (!edge.lastSyncAt || edge.lastSyncAt < syncedAt)) edge.lastSyncAt = syncedAt;
    return true;
  }

  async edgeSyncs() {
    const active = new Set([...this.rows.values()].filter((g) => g.active).map((g) => g.edgeId));
    return [...this.edges.values()]
      .filter((edge) => active.has(edge.id))
      .map(({ id, factoryId, lastSyncAt }) => ({ edgeId: id, factoryId, lastSyncAt }));
  }

  async offlineEdges(cutoff: Date) {
    return [...this.edges.values()].flatMap((edge) => {
      const gates = [...this.rows.values()].filter(
        (gate) => gate.edgeId === edge.id && gate.active,
      );
      // #113 B3: never-connected edges use the oldest active gate's createdAt as baseline.
      const since =
        edge.lastHeartbeatAt ??
        new Date(Math.min(...gates.map((gate) => gate.createdAt.getTime())));
      return gates.length && since < cutoff ? [{ ...edge, since, gates }] : [];
    });
  }

  private check(data: NewGate, exceptId?: string) {
    if (this.edges.get(data.edgeId)?.factoryId !== data.factoryId) throw new InvalidGateEdgeError();
    if (
      [...this.rows.values()].some(
        (gate) => gate.id !== exceptId && gate.turnstileId === data.turnstileId,
      )
    ) {
      throw new DuplicateTurnstileError();
    }
  }
}

export class RecordingGateAudit implements AuditLog {
  entries: AuditEntry[] = [];

  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }

  async search() {
    return this.entries;
  }
}

/** CRUD must not call QR validation, TCS, admin stubs, attendance or alerts. */
const outsideCrud = async (): Promise<never> => {
  throw new Error('Unexpected dependency call outside Gate CRUD');
};

export const registryService = (
  store: GateStore,
  audit: AuditLog,
  options: GateOptions = {},
  notifier: Notifier = { alert: outsideCrud },
) =>
  new GateService(
    store,
    { validate: outsideCrud },
    { record: outsideCrud, setOutcome: outsideCrud },
    { open: outsideCrud },
    { get: outsideCrud, orgUnits: outsideCrud },
    notifier,
    audit,
    options,
  );

export const entrance: NewGate = {
  name: 'Main entrance',
  factoryId: 'binh-duong',
  edgeId: 'edge-bd',
  location: 'Guard house',
  direction: 'IN',
  turnstileId: 'turnstile-bd-01',
};

export const otherFactory: NewGate = {
  ...entrance,
  name: 'Long An entrance',
  factoryId: 'long-an',
  edgeId: 'edge-la',
  turnstileId: 'turnstile-la-01',
};
