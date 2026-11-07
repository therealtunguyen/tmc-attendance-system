import type { TurnstileClient } from '../../adapters/tcs/turnstile-client.js';
import type { EdgeHeartbeat } from '../../shared/contracts/edge.js';
import { todo } from '../../shared/errors.js';
import type { ConfigReader } from '../admin/index.js';
import type { AttendanceRecorder } from '../attendance/index.js';
import type { QrValidation } from '../employee-qr/index.js';
import type { AuditLog } from '../iam/index.js';
import type { Notifier } from '../reporting/index.js';

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

export type NewGate = Pick<
  Gate,
  'name' | 'factoryId' | 'edgeId' | 'location' | 'direction' | 'turnstileId'
>;

/** Factory and identity are immutable; deactivation has its own operation. */
export type GateChanges = Partial<Omit<NewGate, 'factoryId'>>;

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
export class GateService {
  constructor(
    private repo: GateStore,
    private qr: QrValidation,
    private recorder: AttendanceRecorder,
    private turnstile: TurnstileClient,
    private config: ConfigReader,
    private notifier: Notifier,
    private audit: AuditLog,
  ) {}

  async createGate(actorId: string, data: NewGate): Promise<Gate> {
    await this.requireEdge(data.edgeId, data.factoryId);
    const gate = await this.repo.create(data);
    await this.record(actorId, 'GATE_CREATE', undefined, gate);
    return gate;
  }

  listGates(filters: GateFilters = {}, factoryIds?: string[]): Promise<Gate[]> {
    return this.repo.list(filters, factoryIds);
  }

  getGate(id: string): Promise<Gate | null> {
    return this.repo.find(id);
  }

  async updateGate(actorId: string, id: string, changes: GateChanges): Promise<Gate | null> {
    const before = await this.repo.find(id);
    if (!before) return null;
    if (changes.edgeId !== undefined) await this.requireEdge(changes.edgeId, before.factoryId);
    if (
      (Object.keys(changes) as (keyof GateChanges)[]).every((key) => changes[key] === before[key])
    ) {
      return before;
    }
    const gate = await this.repo.update(id, changes);
    if (gate) await this.record(actorId, 'GATE_UPDATE', before, gate);
    return gate;
  }

  async deactivateGate(actorId: string, id: string): Promise<Gate | null> {
    const before = await this.repo.find(id);
    if (!before || !before.active) return before;
    const gate = await this.repo.deactivate(id);
    // A concurrent DELETE won; it is responsible for auditing the transition.
    if (!gate) return this.repo.find(id);
    await this.record(actorId, 'GATE_DEACTIVATE', before, gate);
    return gate;
  }

  private async requireEdge(edgeId: string, factoryId: string): Promise<void> {
    const edge = await this.repo.findEdge(edgeId);
    if (!edge || edge.factoryId !== factoryId) throw new InvalidGateEdgeError();
    // AdminService.orgUnits() is still a stub. Until it is implemented, the provisioned
    // edge registry is the source of factory membership; never bypass the composite FK.
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

  async heartbeat(_gateId: string): Promise<void> {
    return todo();
  }

  /** Marks the edge online; the edge is offline when these stop (ADR-9, FR-2.6). */
  async edgeHeartbeat(_hb: EdgeHeartbeat): Promise<void> {
    return todo();
  }
}
