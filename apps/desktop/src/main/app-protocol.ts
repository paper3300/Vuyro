import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The window loads the UI from a private scheme instead of `file://`: file pages can read any local file through
 * the page's own requests, and the response headers (the CSP) can only be set this way.
 */
export const APP_SCHEME = 'vuyro-app';
export const APP_HOST = 'ui';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;

/**
 * Nothing but our own scripts and styles; no network, no plugins, no frames, no inline script. Agent output and
 * logs are text in React (never HTML), and this is the second line if that ever slips.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/**
 * The file a request maps to inside `root`, or undefined (other host, encoded separators, anything outside the root).
 * `/` is the index.
 */
export function resolveAppFile(root: string, requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (path.includes('\0') || path.includes('\\')) return undefined;
  const target = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  const inside = relative(resolve(root), target);
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return undefined;
  return target;
}

export function appResponseHeaders(file: string): Record<string, string> {
  return {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}
