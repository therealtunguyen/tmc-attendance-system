export type OpenResult = 'OPENED' | 'ERROR' | 'TIMEOUT';

/**
 * Contract: never throws, resolves within the timeout. Anything but OPENED means deny (FR-2.3).
 */
export interface TurnstileClient {
  open(turnstileId: string): Promise<OpenResult>;
}
