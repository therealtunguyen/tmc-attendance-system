import type { TurnstileClient } from '../../adapters/tcs/turnstile-client.js';
import type { EdgeHeartbeat } from '../../shared/contracts/edge.js';
import { todo } from '../../shared/errors.js';
import type { ConfigReader } from '../admin/index.js';
import type { AttendanceRecorder } from '../attendance/index.js';
import type { EmployeeDirectory, QrValidation } from '../employee-qr/index.js';
import type { AuditLog } from '../iam/index.js';
import type {
  EdgeSync,
  EdgeSyncStatus,
  GateLookup,
  GateRef,
  Notifier,
} from '../reporting/index.js';
import { HEARTBEAT_TIMEOUT_MS } from '../../shared/contracts/edge.js';
import {
  connectionStatus,
  UnknownEdgeError,
  type EdgeState,
  type OfflineEdge,
} from './gate.heartbeat.js';

export type GateDirection = 'IN' | 'OUT';

export interface Gate {
  id: string;
  name: string;
  factoryId: string;
  edgeId: string;
  location: string;
  direction: GateDirection;
  turnstileId: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GateView extends Gate {
  status: 'ONLINE' | 'OFFLINE';
  lastHeartbeatAt: Date | null;
}

export interface OverrideRequest {
  eventId: string;
  employeeId: string;
  reason: string;
  mode: 'OPEN' | 'BACKFILL';
  occurredAt?: Date;
}

export class OverrideError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GateOptions {
  directory?: EmployeeDirectory;
  now?: () => Date;
  heartbeatTimeoutMs?: number;
}

export type NewGate = Pick<
  Gate,
  'name' | 'factoryId' | 'edgeId' | 'location' | 'direction' | 'turnstileId'
>;

/** Factory/identity are immutable. PATCH can reactivate; DELETE deactivates. */
export type GateChanges = Partial<Omit<NewGate, 'factoryId'>> & { active?: true };

export interface GateFilters {
  factoryId?: string;
  edgeId?: string;
  active?: boolean;
}

export interface GateEdge {
  id: string;
  factoryId: string;
}

export class DuplicateTurnstileError extends Error {
  constructor() {
    super('turnstileId is already registered');
  }
}

/** Also used if the edge changes between validation and the database write. */
export class InvalidGateEdgeError extends Error {
  constructor() {
    super("edgeId must identify an edge in the gate's factory");
  }
}

export class InactiveGateError extends Error {
  constructor() {
    super('Gate is inactive; reactivate it with active: true');
  }
}

/** Owned storage; tests can supply an in-memory implementation. */
export interface GateStore {
  create(data: NewGate): Promise<Gate>;
  /** factoryIds undefined = unrestricted; [] = no factories. Intersect with filters. */
  list(filters: GateFilters, factoryIds?: string[]): Promise<Gate[]>;
  find(id: string): Promise<Gate | null>;
  update(id: string, changes: GateChanges): Promise<Gate | null>;
  /** Conditional active -> inactive write; null if missing or already inactive. */
  deactivate(id: string): Promise<Gate | null>;
  findEdge(id: string): Promise<GateEdge | null>;
  heartbeats(edgeIds: string[]): Promise<EdgeState[]>;
  /**
   * lastHeartbeatAt moves to receivedAt. lastSyncAt moves to syncedAt, the edge clock's send time of
   * a heartbeat with an empty outbox, never later than receipt; null when the outbox was not empty
   * (ADR-9; the monthly export waits for it, FR-4.5). Both columns only move forward.
   */
  recordHeartbeat(edgeId: string, receivedAt: Date, syncedAt: Date | null): Promise<boolean>;
  /** Only edges serving an active gate count; a decommissioned edge does not hold the export back. */
  edgeSyncs(): Promise<EdgeSync[]>;
  offlineEdges(cutoff: Date): Promise<OfflineEdge[]>;
}

/** JSON-safe config snapshots for audit, without database timestamps. */
const state = ({
  id,
  name,
  factoryId,
  edgeId,
  location,
  direction,
  turnstileId,
  active,
}: Gate) => ({
  id,
  name,
  factoryId,
  edgeId,
  location,
  direction,
  turnstileId,
  active,
});

export interface ScanRequest {
  eventId: string;
  gateId: string;
  token: string;
}

export interface Decision {
  result: 'GRANTED' | 'DENIED';
  firstName?: string;
}

/** Gate registry, scan flow, kiosk API, heartbeat, manual override (FR-2.x). */
export class GateService implements EdgeSyncStatus, GateLookup {
  private readonly alerted = new Map<string, number>();
  private readonly now: () => Date;
  private readonly timeout: number;
  private readonly directory?: EmployeeDirectory;

  constructor(
    private repo: GateStore,
    private qr: QrValidation,
    private recorder: AttendanceRecorder,
    private turnstile: TurnstileClient,
    private config: ConfigReader,
    private notifier: Notifier,
    private audit: AuditLog,
    options: GateOptions = {},
  ) {
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.timeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  async createGate(actorId: string, data: NewGate): Promise<Gate> {
    await this.requireEdge(data.edgeId, data.factoryId);
    const gate = await this.repo.create(data);
    // TODO(#45): commit the gate write and audit entry in one transaction.
    await this.record(actorId, 'GATE_CREATE', undefined, gate);
    return gate;
  }

  async listGates(filters: GateFilters = {}, factoryIds?: string[]): Promise<GateView[]> {
    return this.withStatus(await this.repo.list(filters, factoryIds));
  }

  async getGate(id: string): Promise<GateView | null> {
    const gate = await this.repo.find(id);
    return gate ? (await this.withStatus([gate]))[0]! : null;
  }

  private async withStatus(gates: Gate[]): Promise<GateView[]> {
    if (!gates.length) return [];
    const edges = await this.repo.heartbeats([...new Set(gates.map((gate) => gate.edgeId))]);
    const times = new Map(edges.map((edge) => [edge.id, edge.lastHeartbeatAt]));
    const now = this.now();
    return gates.map((gate) => {
      const lastHeartbeatAt = times.get(gate.edgeId) ?? null;
      return {
        ...gate,
        lastHeartbeatAt,
        status: connectionStatus(lastHeartbeatAt, now, this.timeout),
      };
    });
  }

  async updateGate(actorId: string, id: string, changes: GateChanges): Promise<Gate | null> {
    const before = await this.repo.find(id);
    if (!before) return null;
    if (!before.active && changes.active !== true) throw new InactiveGateError();
    if (changes.edgeId !== undefined || changes.active === true) {
      await this.requireEdge(changes.edgeId ?? before.edgeId, before.factoryId);
    }
    if (
      (Object.keys(changes) as (keyof GateChanges)[]).every((key) => changes[key] === before[key])
    ) {
      return before;
    }
    const gate = await this.repo.update(id, changes);
    // TODO(#45): commit the gate write and audit entry in one transaction; retries can look like no-ops.
    if (gate) await this.record(actorId, 'GATE_UPDATE', before, gate);
    return gate;
  }

  async deactivateGate(actorId: string, id: string): Promise<Gate | null> {
    const before = await this.repo.find(id);
    if (!before || !before.active) return before;
    const gate = await this.repo.deactivate(id);
    // A concurrent DELETE won; it is responsible for auditing the transition.
    if (!gate) return this.repo.find(id);
    // TODO(#45): commit deactivation and audit together; repeated DELETE must not lose the audit.
    await this.record(actorId, 'GATE_DEACTIVATE', before, gate);
    return gate;
  }

  private async requireEdge(edgeId: string, factoryId: string): Promise<void> {
    const edge = await this.repo.findEdge(edgeId);
    if (!edge || edge.factoryId !== factoryId) throw new InvalidGateEdgeError();
    // Factory membership comes from provisioned edges; shared org-unit validation is separate integration work.
  }

  private record(actorId: string, action: string, before: Gate | undefined, after: Gate) {
    // Like employee-qr (#45), registry writes and IAM append are separate commits.
    // Propagate audit failures; a shared transaction boundary is future cross-module work.
    return this.audit.append({
      actorId,
      action,
      target: `gate:${after.id}`,
      at: new Date(),
      before: before ? state(before) : null,
      after: state(after),
    });
  }

  /** validate -> record (commit) -> open -> setOutcome. See report, gate scan sequence diagram. */
  async scan(_req: ScanRequest): Promise<Decision> {
    return todo();
  }

  async override(actorId: string, gateId: string, req: OverrideRequest) {
    const gate = await this.repo.find(gateId);
    if (!gate) throw new OverrideError(404, 'Gate not found');
    if (!this.directory) throw new Error('Employee directory is not configured');
    const employee = await this.directory.find(req.employeeId);
    if (!employee) throw new OverrideError(404, 'Employee not found');
    if (req.mode === 'OPEN' && (!gate.active || !employee.active)) {
      throw new OverrideError(409, 'Gate and employee must be active');
    }
    const now = this.now();
    const occurredAt = req.mode === 'BACKFILL' ? req.occurredAt : now;
    if (!occurredAt || !Number.isFinite(occurredAt.getTime()) || occurredAt > now) {
      throw new OverrideError(400, 'A valid past occurredAt is required');
    }
    const event = {
      eventId: req.eventId,
      employeeId: employee.id,
      gateId,
      method: 'MANUAL' as const,
      guardId: actorId,
      reason: req.reason,
      occurredAt,
    };
    if (!(await this.recorder.record(event))) {
      // Never repeat a physical open, including after a crash or a concurrent request.
      throw new OverrideError(409, 'Event already recorded; do not repeat the override');
    }
    // TODO(#45): commit the attendance event and audit together. On failure the event stays
    // PENDING; do not open or retry automatically. It requires operator reconciliation.
    await this.audit.append({
      actorId,
      action: 'GATE_OVERRIDE',
      target: `attendance-event:${req.eventId}`,
      at: now,
      after: { ...event, occurredAt: occurredAt.toISOString(), mode: req.mode },
    });
    const result = req.mode === 'BACKFILL' ? 'OPENED' : await this.turnstile.open(gate.turnstileId);
    const outcome = result === 'OPENED' ? 'GRANTED' : 'DENIED';
    await this.recorder.setOutcome(req.eventId, outcome);
    return { eventId: req.eventId, outcome };
  }

  async heartbeat(_gateId: string): Promise<void> {
    return todo();
  }

  /** Marks the edge online; the edge is offline when these stop (ADR-9, FR-2.6). */
  async edgeHeartbeat(hb: EdgeHeartbeat): Promise<void> {
    const receivedAt = this.now();
    // Scans made after sentAt may still be in the outbox, so the sync is dated by the edge's send
    // time, clamped so an edge clock running ahead cannot push it into the future.
    const syncedAt =
      hb.outboxSize === 0 ? new Date(Math.min(Date.parse(hb.sentAt), receivedAt.getTime())) : null;
    if (!(await this.repo.recordHeartbeat(hb.edgeId, receivedAt, syncedAt))) {
      throw new UnknownEdgeError();
    }
  }

  /** Last confirmed sync per edge, for the monthly export check (FR-4.5). */
  edgeSyncs(): Promise<EdgeSync[]> {
    return this.repo.edgeSyncs();
  }

  /** Gates for the security access log (FR-4.4): inactive ones too, since old events name them. Sorted by id. */
  async gates(factoryIds?: readonly string[]): Promise<GateRef[]> {
    const gates = await this.repo.list({}, factoryIds ? [...factoryIds] : undefined);
    return gates
      .map(({ id, name, factoryId }) => ({ id, name, factoryId }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async checkOffline(): Promise<void> {
    const errors: unknown[] = [];
    for (const edge of await this.repo.offlineEdges(
      new Date(this.now().getTime() - this.timeout),
    )) {
      // #113 B3: dedupe per baseline, so a never-connected edge alerts once, not every check.
      const heartbeat = edge.since.getTime();
      if (this.alerted.get(edge.id) === heartbeat) continue;
      try {
        const gates = edge.gates.map((gate) => `${gate.name} (${gate.id})`).join(', ');
        await this.notifier.alert(
          'GATE_OFFLINE',
          `Edge ${edge.id}, factory ${edge.factoryId}: ${gates} offline` +
            (edge.lastHeartbeatAt ? '' : ' (never connected)'),
        );
        this.alerted.set(edge.id, heartbeat);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Gate offline alert failed');
  }
}
