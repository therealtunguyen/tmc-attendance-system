import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';
import { KioskCamera } from './kiosk-camera';
import { RESULT_DISPLAY_MS } from './kiosk-scan';

vi.mock('jsqr', () => ({ default: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup() {
  const callbacks: FrameRequestCallback[] = [];
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    srcObject: null,
    play: vi.fn(async () => {}),
  } as unknown as HTMLVideoElement;
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(),
      width,
      height,
    })),
  };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    callbacks.push(callback),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.mocked(jsQR).mockReturnValue({ data: 'first' } as ReturnType<typeof jsQR>);
  const accept = vi.fn(() => true);
  const changed = vi.fn();
  const camera = new KioskCamera(video, accept, changed);
  return {
    camera,
    video,
    context,
    track,
    getUserMedia,
    accept,
    changed,
    stream,
    tick: (time: number) => callbacks.shift()!(time),
  };
}

describe('main kiosk camera', () => {
  it('starts video without audio and decodes the full frame', async () => {
    const test = setup();
    await test.camera.start();
    expect(test.getUserMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'user' } },
      audio: false,
    });
    expect(test.changed).toHaveBeenLastCalledWith('ready');
    test.tick(200);
    expect(test.context.drawImage).toHaveBeenCalledWith(test.video, 0, 0, 800, 450);
    expect(test.context.getImageData).toHaveBeenCalledWith(0, 0, 800, 450);
    expect(test.accept).toHaveBeenCalledWith('first');
    test.camera.stop();
  });

  it('requests the selected rear camera with a fallback when the device has only one', async () => {
    const test = setup();
    const camera = new KioskCamera(test.video, test.accept, test.changed, 'environment');
    await camera.start();
    expect(test.getUserMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    });
    expect(test.changed).toHaveBeenLastCalledWith('ready');
    camera.stop();
  });

  it('scans once per presentation including a refreshed QR; rearms after removal', async () => {
    const test = setup();
    await test.camera.start();
    test.tick(200);
    vi.mocked(jsQR).mockReturnValue({ data: 'refreshed' } as ReturnType<typeof jsQR>);
    test.tick(400);
    expect(test.accept).toHaveBeenCalledTimes(1);
    vi.mocked(jsQR).mockReturnValue(null);
    test.tick(600);
    test.tick(1600);
    vi.mocked(jsQR).mockReturnValue({ data: 'refreshed' } as ReturnType<typeof jsQR>);
    test.tick(1800);
    expect(test.accept).toHaveBeenCalledTimes(2);
    test.camera.stop();
  });

  it('does not re-submit the same QR after a decode gap during the result window', async () => {
    const test = setup();
    await test.camera.start();
    test.tick(200);
    test.accept.mockReturnValue(false); // Processing/result screen is busy.
    vi.mocked(jsQR).mockReturnValue(null);
    test.tick(400);
    test.tick(1600);
    vi.mocked(jsQR).mockReturnValue({ data: 'first' } as ReturnType<typeof jsQR>);
    test.tick(1800);
    test.accept.mockReturnValue(true); // Idle again after the result screen.
    test.tick(RESULT_DISPLAY_MS + 400);
    expect(test.accept).toHaveBeenCalledTimes(1);
    // Even a longer removal must not replay the same accepted token.
    vi.mocked(jsQR).mockReturnValue(null);
    test.tick(RESULT_DISPLAY_MS + 600);
    test.tick(RESULT_DISPLAY_MS * 3);
    vi.mocked(jsQR).mockReturnValue({ data: 'first' } as ReturnType<typeof jsQR>);
    test.tick(RESULT_DISPLAY_MS * 3 + 200);
    expect(test.accept).toHaveBeenCalledTimes(1);
    vi.mocked(jsQR).mockReturnValue({ data: 'next-person' } as ReturnType<typeof jsQR>);
    test.tick(RESULT_DISPLAY_MS * 3 + 400);
    expect(test.accept).toHaveBeenCalledTimes(2);
    expect(test.accept).toHaveBeenLastCalledWith('next-person');
    test.camera.stop();
  });

  it.each([
    [720, 1280, 450, 800],
    [640, 480, 640, 480],
  ])(
    'limits the longest decode dimension without upscaling: %s x %s',
    async (width, height, decodedWidth, decodedHeight) => {
      const test = setup();
      Object.assign(test.video, { videoWidth: width, videoHeight: height });
      await test.camera.start();
      test.tick(200);
      expect(test.context.drawImage).toHaveBeenCalledWith(
        test.video,
        0,
        0,
        decodedWidth,
        decodedHeight,
      );
      expect(test.context.getImageData).toHaveBeenCalledWith(0, 0, decodedWidth, decodedHeight);
      test.camera.stop();
    },
  );

  it('distinguishes blocked autoplay from denied camera access', async () => {
    const test = setup();
    vi.mocked(test.video.play).mockRejectedValue(
      Object.assign(new Error(), { name: 'NotAllowedError' }),
    );
    await test.camera.start();
    expect(test.changed).toHaveBeenLastCalledWith('playback-blocked');
    expect(test.changed).not.toHaveBeenCalledWith('denied');
    expect(test.track.stop).toHaveBeenCalledOnce();
    expect(test.video.srcObject).toBeNull();
  });

  it('does not consume a QR while the kiosk is busy', async () => {
    const test = setup();
    test.accept.mockReturnValue(false);
    await test.camera.start();
    test.tick(200);
    test.accept.mockReturnValue(true);
    test.tick(400);
    test.tick(600);
    expect(test.accept).toHaveBeenCalledTimes(2);
    test.camera.stop();
  });

  it('releases tracks and cancels scanning when leaving', async () => {
    const test = setup();
    await test.camera.start();
    test.camera.stop();
    test.tick(200);
    expect(test.track.stop).toHaveBeenCalledOnce();
    expect(test.video.srcObject).toBeNull();
    expect(test.accept).not.toHaveBeenCalled();
  });

  it('releases a permission request that resolves after unmount', async () => {
    const test = setup();
    let resolve!: (stream: MediaStream) => void;
    test.getUserMedia.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = test.camera.start();
    test.camera.stop();
    resolve(test.stream);
    await start;
    expect(test.track.stop).toHaveBeenCalledOnce();
    expect(test.video.play).not.toHaveBeenCalled();
    expect(test.changed).not.toHaveBeenCalledWith('ready');
  });

  it('shows denied permission and supports starting a fresh camera on retry', async () => {
    const test = setup();
    test.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error(), { name: 'NotAllowedError' }),
    );
    await test.camera.start();
    expect(test.changed).toHaveBeenLastCalledWith('denied');
    test.camera.stop();
    const retry = new KioskCamera(test.video, test.accept, test.changed);
    await retry.start();
    expect(test.changed).toHaveBeenLastCalledWith('ready');
    retry.stop();
  });

  it('cleans up when video playback fails', async () => {
    const test = setup();
    vi.mocked(test.video.play).mockRejectedValue(new Error('Playback failed'));
    await test.camera.start();
    expect(test.track.stop).toHaveBeenCalledOnce();
    expect(test.changed).toHaveBeenLastCalledWith('unavailable');
  });

  it.each([
    [20, 20],
    [500, 180],
  ])('optically decodes a phone QR away from the center at %s,%s', async (left, top) => {
    const decode = (await vi.importActual<typeof import('jsqr')>('jsqr')).default;
    const token =
      'eyJhbGciOiJFZERTQSIsImtpZCI6ImRlbW8ifQ.' +
      'eyJzdWIiOiJkZW1vLWFjdGl2ZSIsImV4cCI6MTc5NDM5MDQwMCwianRpIjoiZGVtby1zY2FuIn0.' +
      'a'.repeat(86);
    const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value: token, marginSize: 4 }));
    const scale = 3,
      width = 800,
      height = 450;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const black = svg.match(/fill="#000000" d="([^"]+)/)![1];
    for (const [, x, y, length] of black.matchAll(/M([0-9]+)[ ,]+([0-9]+) *h([0-9]+)v1H[0-9]+z/g)) {
      for (let row = top + Number(y) * scale; row < top + (Number(y) + 1) * scale; row++) {
        for (
          let column = left + Number(x) * scale;
          column < left + (Number(x) + Number(length)) * scale;
          column++
        ) {
          const index = (row * width + column) * 4;
          pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
        }
      }
    }
    expect(decode(pixels, width, height)?.data).toBe(token);
  });
});
