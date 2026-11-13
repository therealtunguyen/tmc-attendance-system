import { useEffect, useRef, useState } from 'react';
import { KioskCamera, type CameraState } from './kiosk-camera';
import type { CameraFacing } from './kiosk-settings';

const messages = {
  vi: {
    starting: 'Đang mở camera…',
    'playback-blocked': 'Không phát được hình camera. Nhấn thử lại camera.',
    denied: 'Cho phép camera trong trình duyệt để quét QR.',
    unavailable: 'Không mở được camera. Kiểm tra camera và dùng HTTPS hoặc localhost.',
    retry: 'Thử lại camera',
    preview: 'Camera quét mã QR',
    guide: 'Đưa mã QR trước camera',
  },
  en: {
    starting: 'Starting camera…',
    'playback-blocked': 'Camera playback was blocked. Tap Retry camera.',
    denied: 'Allow camera access in your browser to scan QR codes.',
    unavailable: 'Camera unavailable. Check your camera and use HTTPS or localhost.',
    retry: 'Retry camera',
    preview: 'QR scanning camera',
    guide: 'Hold your QR code in front of the camera',
  },
};

export function KioskCameraPreview({
  language,
  accept,
  facing,
}: {
  language: 'vi' | 'en';
  accept: (token: string) => boolean;
  facing: CameraFacing;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraState>('starting');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!video.current) return;
    const camera = new KioskCamera(video.current, accept, setState, facing);
    void camera.start();
    const stop = () => camera.stop();
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      camera.stop();
    };
  }, [accept, attempt, facing]);
  const text = messages[language];
  return (
    <div className="kiosk-camera">
      <div className="kiosk-camera-image">
        <video ref={video} autoPlay muted playsInline aria-label={text.preview} />
        {state === 'ready' && (
          <div className="kiosk-camera-guide">
            <div className="kiosk-camera-corners" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </div>
            <p>{text.guide}</p>
          </div>
        )}
        {state !== 'ready' && (
          <div className="kiosk-camera-notice" role="status">
            <p>{text[state]}</p>
            {state !== 'starting' && (
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                {text.retry}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
