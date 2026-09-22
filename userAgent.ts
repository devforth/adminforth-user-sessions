import type { SessionDevice } from "./types.js";

/**
 * Minimal user agent parsing: enough to let the user tell one of their browsers from another
 * in the sessions list. A full UA database is not worth a dependency for that.
 * Order matters in both lists: every browser below pretends to be the ones after it.
 */
const BROWSERS: { name: string, re: RegExp }[] = [
  { name: 'Edge', re: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: 'Opera', re: /(?:OPR|OPiOS|Opera)\/(\d+)/ },
  { name: 'Samsung Internet', re: /SamsungBrowser\/(\d+)/ },
  { name: 'Vivaldi', re: /Vivaldi\/(\d+)/ },
  { name: 'Firefox', re: /(?:Firefox|FxiOS)\/(\d+)/ },
  { name: 'Chrome', re: /(?:Chrome|CriOS)\/(\d+)/ },
  // safari on ios puts a `Mobile/<build>` token between its version and the Safari one
  { name: 'Safari', re: /Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari/ },
];

const OSES: { name: string, re: RegExp }[] = [
  { name: 'Windows', re: /Windows NT [\d.]+/ },
  { name: 'ChromeOS', re: /CrOS/ },
  { name: 'Android', re: /Android (\d+)/ },
  { name: 'iOS', re: /(?:iPhone|iPad|iPod).* OS (\d+)/ },
  { name: 'macOS', re: /Mac OS X/ },
  { name: 'Linux', re: /Linux|X11/ },
];

const TABLET_RE = /iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/;
const MOBILE_RE = /Mobi|iPhone|iPod|Windows Phone|Android/;

/**
 * Appends the major version the regex captured, e.g. `Chrome 131` or `iOS 18`.
 */
function named(name: string, match: RegExpExecArray): string {
  return match[1] ? `${name} ${match[1]}` : name;
}

function firstMatch(userAgent: string, candidates: { name: string, re: RegExp }[]): string | null {
  for (const { name, re } of candidates) {
    const match = re.exec(userAgent);
    if (match) {
      return named(name, match);
    }
  }
  return null;
}

function deviceType(userAgent: string): SessionDevice['type'] {
  if (TABLET_RE.test(userAgent)) {
    return 'tablet';
  }
  return MOBILE_RE.test(userAgent) ? 'mobile' : 'desktop';
}

/**
 * Returns null when there is nothing to parse: sessions created before this plugin started storing
 * the user agent, and clients which send no `User-Agent` header at all.
 */
export function parseUserAgent(userAgent: string | null | undefined): SessionDevice | null {
  if (!userAgent) {
    return null;
  }
  return {
    browser: firstMatch(userAgent, BROWSERS),
    os: firstMatch(userAgent, OSES),
    type: deviceType(userAgent),
  };
}
