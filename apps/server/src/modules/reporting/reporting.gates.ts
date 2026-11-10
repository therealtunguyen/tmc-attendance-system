// Gates the access log is limited to (FR-4.4, BR-15). Gate owns the registry and provides it.

export interface GateRef {
  id: string;
  name: string;
  factoryId: string;
}

/** Implemented by Gate. Inactive gates are included: old events still name them. */
export interface GateLookup {
  /** Every gate, or only those of these factories; sorted by id. */
  gates(factoryIds?: readonly string[]): Promise<GateRef[]>;
}
