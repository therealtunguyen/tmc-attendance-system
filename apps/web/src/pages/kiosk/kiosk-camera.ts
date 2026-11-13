import jsQR from 'jsqr';
import type { CameraFacing } from './kiosk-settings';

export type CameraState = 'starting' | 'ready' | 'denied' | 'unavailable' | 'playback-blocked';

/** Decode the entire image, without requiring alignment inside a small target. */
export class KioskCamera {
  private stopped = false;
  private stream?: MediaStream;
  private animation = 0;
  private lastFrame = 0;
  private presented = false;
  private lastAccepted?: string;
  private missingSince?: number;

  constructor(
    private video: HTMLVideoElement,
    private accept: (token: string) => boolean,
    private changed: (state: CameraState) => void,
    private facing: CameraFacing = 'user',
  ) {}

  async start() {
    this.changed('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: { ideal: this.facing },
        },
        audio: false,
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      // Playback policy failures are not camera permission failures.
      try {
        await this.video.play();
      } catch (error) {
        this.release();
        if (!this.stopped)
          this.changed(
            error instanceof Error && error.name === 'NotAllowedError'
              ? 'playback-blocked'
              : 'unavailable',
          );
        return;
      }
      if (this.stopped) return;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Camera unavailable');
      this.changed('ready');
      const read = (time: number) => {
        if (this.stopped) return;
        if (this.video.readyState >= 2 && this.video.videoWidth && time - this.lastFrame >= 200) {
          this.lastFrame = time;
          const scale = Math.min(1, 800 / Math.max(this.video.videoWidth, this.video.videoHeight));
          canvas.width = Math.round(this.video.videoWidth * scale);
          canvas.height = Math.round(this.video.videoHeight * scale);
          context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const qr = jsQR(pixels.data, pixels.width, pixels.height, {
            inversionAttempts: 'attemptBoth',
          });
          if (qr?.data) {
            this.missingSince = undefined;
            // A decode gap (glare/movement) must not submit the same accepted payload again.
            // Only a different successfully accepted QR replaces this identity.
            if (!this.presented && qr.data !== this.lastAccepted && this.accept(qr.data)) {
              this.presented = true;
              this.lastAccepted = qr.data;
            }
          } else {
            this.missingSince ??= time;
            if (time - this.missingSince >= 1000) this.presented = false;
          }
        }
        this.animation = requestAnimationFrame(read);
      };
      this.animation = requestAnimationFrame(read);
    } catch (error) {
      this.release();
      if (!this.stopped)
        this.changed(
          error instanceof Error && error.name === 'NotAllowedError' ? 'denied' : 'unavailable',
        );
    }
  }

  private release() {
    cancelAnimationFrame(this.animation);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.srcObject = null;
  }

  stop() {
    this.stopped = true;
    this.release();
  }
}
