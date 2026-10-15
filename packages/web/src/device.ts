/** Touch-first ("GoodNotes") mode: auto-detected, overridable, remembered per device. */

export interface DevicePrefs {
  tablet: boolean;
  /** When false (default) fingers only navigate and the pen draws: palm rejection for free. */
  fingerDraw: boolean;
}

const KEY = "sinapsi:device";

export function detectTablet(): boolean {
  const q = new URLSearchParams(location.search).get("tablet");
  if (q !== null) return q !== "0";
  const coarse = matchMedia("(pointer: coarse)").matches;
  // iPadOS reports a Mac user agent: touch points give it away.
  const iPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return iPad || (coarse && navigator.maxTouchPoints > 1);
}

export function loadDevicePrefs(): DevicePrefs {
  const fallback = { tablet: detectTablet(), fingerDraw: false };
  if (new URLSearchParams(location.search).has("tablet")) return fallback;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<DevicePrefs>) };
  } catch {
    // storage blocked: use detection
  }
  return fallback;
}

export function saveDevicePrefs(p: DevicePrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}
