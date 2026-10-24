import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Workspace paths in the ledger are relative to the workspace folder, with `/` separators and no `.`/`..`
 * segments. On Windows paths compare without regard to letter case (the file system does not either), so
 * keys for comparison are lower-cased there while the recorded path keeps its spelling.
 */

export const CASE_INSENSITIVE = process.platform === 'win32';

/** Normalizes a relative path or pattern. Undefined when it is absolute or climbs out with `..`. */
export function normalizeRelative(path: string): string | undefined {
  const slashed = path.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return undefined;
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join('/');
}

/**
 * The path of `target` (absolute, or relative to `root`) inside `root`, normalized. Undefined when it is outside
 * the folder (or is the folder itself).
 */
export function insideRoot(root: string, target: string, caseInsensitive = CASE_INSENSITIVE): string | undefined {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const base = resolve(root);
  const rel = caseInsensitive ? relativeIgnoringCase(base, absolute) : relative(base, absolute);
  if (rel === undefined || rel === '' || isAbsolute(rel)) return undefined;
  return normalizeRelative(rel);
}

function relativeIgnoringCase(base: string, absolute: string): string | undefined {
  const prefix = base.endsWith('\\') || base.endsWith('/') ? base : `${base}${absolute.includes('\\') ? '\\' : '/'}`;
  if (absolute.length <= prefix.length || absolute.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined;
  return absolute.slice(prefix.length);
}

/** Comparison key of a normalized path. */
export function pathKey(path: string, caseInsensitive = CASE_INSENSITIVE): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

const WILDCARD = /[*?]/;

export function isPattern(path: string): boolean {
  return WILDCARD.test(path);
}

const cache = new Map<string, RegExp>();

/** `**` matches any number of folders (including none), `*` and `?` stay within one folder. */
export function globRegExp(pattern: string, caseInsensitive = CASE_INSENSITIVE): RegExp {
  const key = `${caseInsensitive ? 'i' : 's'}:${pattern}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` = any folders (or none); a trailing `**` = anything below.
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]*/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regexp = new RegExp(`^${source}$`, caseInsensitive ? 'i' : '');
  if (cache.size > 1000) cache.clear();
  cache.set(key, regexp);
  return regexp;
}

export function matches(pattern: string, path: string, caseInsensitive = CASE_INSENSITIVE): boolean {
  return isPattern(pattern) ? globRegExp(pattern, caseInsensitive).test(path) : pathKey(pattern, caseInsensitive) === pathKey(path, caseInsensitive);
}

export function matchesAny(patterns: readonly string[], path: string, caseInsensitive = CASE_INSENSITIVE): boolean {
  return patterns.some((pattern) => matches(pattern, path, caseInsensitive) || (!isPattern(pattern) && isInside(pattern, path, caseInsensitive)));
}

/** `path` is `folder` or below it. */
function isInside(folder: string, path: string, caseInsensitive: boolean): boolean {
  const f = pathKey(folder, caseInsensitive);
  const p = pathKey(path, caseInsensitive);
  return p === f || p.startsWith(`${f}/`);
}

/** The literal part of a pattern before its first wildcard. */
function literalPrefix(pattern: string): string {
  const index = pattern.search(WILDCARD);
  return index < 0 ? pattern : pattern.slice(0, index);
}

/**
 * Whether two paths or patterns can name the same file. Exact for a path against a path or a pattern; for two
 * patterns it is conservative (true when their literal prefixes overlap), so it may report an overlap that no
 * real file has, never miss one.
 */
export function overlaps(a: string, b: string, caseInsensitive = CASE_INSENSITIVE): boolean {
  const aPattern = isPattern(a);
  const bPattern = isPattern(b);
  if (!aPattern && !bPattern) return pathKey(a, caseInsensitive) === pathKey(b, caseInsensitive);
  if (!aPattern) return globRegExp(b, caseInsensitive).test(a);
  if (!bPattern) return globRegExp(a, caseInsensitive).test(b);
  const pa = pathKey(literalPrefix(a), caseInsensitive);
  const pb = pathKey(literalPrefix(b), caseInsensitive);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
