/**
 * The one place the frontend asks which OS it runs on. Everything platform
 * specific (modifier symbols, which shortcut applies) goes through here, so no
 * other code branches on macOS.
 */
export type Platform = 'mac' | 'other';

interface NavigatorWithUserAgentData {
  userAgentData?: { platform?: string };
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const hint =
    (navigator as Navigator & NavigatorWithUserAgentData).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(hint) ? 'mac' : 'other';
}
