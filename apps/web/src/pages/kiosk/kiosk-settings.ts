export type DisplayMode = 'guided' | 'scan-only';
export type Language = 'vi' | 'en';
export type CameraFacing = 'user' | 'environment';
const DISPLAY_KEY = 'tmc.kiosk.displayMode';

export function readDisplayMode(): DisplayMode {
  try {
    return localStorage.getItem(DISPLAY_KEY) === 'scan-only' ? 'scan-only' : 'guided';
  } catch {
    return 'guided';
  }
}

export function saveDisplayMode(mode: DisplayMode): void {
  try {
    localStorage.setItem(DISPLAY_KEY, mode);
  } catch {
    // The page keeps the choice in React state when storage is unavailable.
  }
}

export function readLanguage(): Language {
  try {
    return localStorage.getItem('tmc.kiosk.language') === 'en' ? 'en' : 'vi';
  } catch {
    return 'vi';
  }
}

export function readCameraFacing(): CameraFacing {
  try {
    return localStorage.getItem('tmc.kiosk.cameraFacing') === 'environment'
      ? 'environment'
      : 'user';
  } catch {
    return 'user';
  }
}

export function saveDeviceSettings(language: Language, cameraFacing: CameraFacing): void {
  for (const [key, value] of [
    ['tmc.kiosk.language', language],
    ['tmc.kiosk.cameraFacing', cameraFacing],
  ]) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Apply in React state even when the browser cannot persist preferences.
    }
  }
}
