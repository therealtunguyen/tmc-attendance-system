import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { EdgePublicKey } from '../../shared/contracts/edge.js';
import type { QrPublicKeys } from '../../shared/contracts/qr-token.js';
import type { QrKeyConfig } from './employee-qr.service.js';

const der = (base64: string) => Buffer.from(base64, 'base64');

/**
 * The QR signing keys (ADR-10). Signs with the current key; trusts the current and the previous public key,
 * so tokens issued just before a rotation still verify until they expire.
 */
export class QrKeyring {
  readonly kid: string;
  readonly signingKey: KeyObject;
  private trusted: { kid: string; key: KeyObject }[];

  constructor(config: QrKeyConfig) {
    if (!config.kid || !config.privateKey) {
      throw new Error('QR signing key not configured: set QR_SIGNING_KID and QR_SIGNING_KEY');
    }
    if (config.previousKid === config.kid) {
      throw new Error('QR_PREVIOUS_KID must differ from QR_SIGNING_KID');
    }
    this.kid = config.kid;
    this.signingKey = createPrivateKey({
      key: der(config.privateKey),
      format: 'der',
      type: 'pkcs8',
    });
    if (this.signingKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('QR_SIGNING_KEY must be an Ed25519 key');
    }
    this.trusted = [{ kid: this.kid, key: createPublicKey(this.signingKey) }];
    if (config.previousKid && config.previousPublicKey) {
      const key = createPublicKey({
        key: der(config.previousPublicKey),
        format: 'der',
        type: 'spki',
      });
      this.trusted.push({ kid: config.previousKid, key });
    }
  }

  /** For verifyQrToken. */
  publicKeys(): QrPublicKeys {
    return Object.fromEntries(this.trusted.map(({ kid, key }) => [kid, key]));
  }

  /** For the edge snapshot (ADR-9). */
  edgePublicKeys(): EdgePublicKey[] {
    return this.trusted.map(({ kid, key }) => ({
      kid,
      spki: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    }));
  }
}
