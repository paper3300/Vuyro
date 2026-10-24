import { randomBytes, randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import type { BridgeError, BridgeResult, PickedFolder } from '../shared/bridge.ts';

/**
 * The project folder from the app (D-072). The page never sends a path: the person picks a folder in a system dialog,
 * main checks it (exists, is a folder, whether it is a git repository) and hands the page a one-time grant token with
 * the path to show. Saving sends the token back; main turns it into the path and sends `project.configure` as the
 * person (the same command the CLI sends). A grant belongs to the window that asked for it, is used once and expires.
 */

export const FOLDER_GRANT_PATTERN = /^vpf_[0-9a-f]{32}$/;
const PROJECT_ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

export interface FolderDialog {
  /** The folder the person picked, or undefined when cancelled. */
  pickFolder(): Promise<string | undefined>;
}

export interface FolderAccess {
  kind(path: string): Promise<'directory' | 'file' | 'missing'>;
  /** Whether git itself says the folder is a repository's own folder (the engine's `isRepositoryTop`: read-only, no shell). */
  isGitRepo(path: string): Promise<boolean>;
}

interface Grant {
  readonly owner: number;
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly expiresAt: number;
}

export class FolderGrants {
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly newToken: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; max?: number; newToken?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.max = options.max ?? 16;
    this.newToken = options.newToken ?? (() => `vpf_${randomBytes(16).toString('hex')}`);
  }

  grant(owner: number, path: string, isGitRepo: boolean): string {
    this.prune();
    // Only the newest few stay: a page that keeps asking cannot grow this.
    while (this.grants.size >= this.max) this.grants.delete(this.grants.keys().next().value ?? '');
    const token = this.newToken();
    this.grants.set(token, { owner, path, isGitRepo, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** The grant behind `token` for this window, once. Another window's token is refused and stays with its owner. */
  take(owner: number, token: unknown): { path: string; isGitRepo: boolean } | undefined {
    this.prune();
    if (typeof token !== 'string' || !FOLDER_GRANT_PATTERN.test(token)) return undefined;
    const grant = this.grants.get(token);
    if (grant?.owner !== owner) return undefined;
    this.grants.delete(token);
    return { path: grant.path, isGitRepo: grant.isGitRepo };
  }

  /** A window that goes away takes its grants with it. */
  drop(owner: number): void {
    for (const [token, grant] of this.grants) if (grant.owner === owner) this.grants.delete(token);
  }

  get size(): number {
    return this.grants.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
  }
}

const failure = (code: string, message: string): { ok: false; error: BridgeError } => ({ ok: false, error: { code, message, retryable: false } });


export async function pickProjectFolder(dialog: FolderDialog, access: FolderAccess, grants: FolderGrants, owner: number): Promise<BridgeResult<PickedFolder | null>> {
  const path = await dialog.pickFolder();
  if (path === undefined) return { ok: true, value: null };
  if (!isAbsolute(path)) return failure('folder_unusable', '폴더 경로를 알 수 없습니다.');
  try {
    const kind = await access.kind(path);
    if (kind !== 'directory') return failure('folder_unusable', kind === 'missing' ? '폴더가 없습니다.' : '폴더가 아닙니다.');
    const git = await access.isGitRepo(path);
    return { ok: true, value: { token: grants.grant(owner, path, git), path, name: basename(path) || path, isGitRepo: git } };
  } catch (error) {
    return failure('folder_unusable', `폴더를 읽을 수 없습니다: ${(error as Error).message}`);
  }
}

/** `{projectId, token, settings?}` from the page. The engine checks `settings` against its schema. */
export function checkSetProjectFolder(message: unknown): { ok: true; projectId: string; token: string; settings?: Record<string, unknown> } | { ok: false; error: BridgeError } {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return failure('bridge_refused', 'malformed request');
  const { projectId, token, settings } = message as { projectId?: unknown; token?: unknown; settings?: unknown };
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) return failure('bridge_refused', 'projectId must be a project id');
  if (typeof token !== 'string' || !FOLDER_GRANT_PATTERN.test(token)) return failure('bridge_refused', 'token must be a folder grant');
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) return failure('bridge_refused', 'settings must be an object');
  return { ok: true, projectId, token, ...(settings === undefined ? {} : { settings: settings as Record<string, unknown> }) };
}

/**
 * Saves the picked folder as the project's folder: `project.configure {projectId, root, settings?}` through the
 * engine connection (the app's UI session, i.e. the person). The folder is checked again: it may be gone by now.
 */
export async function setProjectFolder(
  grants: FolderGrants,
  access: FolderAccess,
  owner: number,
  message: unknown,
  send: (method: 'command.execute', params: unknown) => Promise<BridgeResult<unknown>>,
): Promise<BridgeResult<unknown>> {
  const checked = checkSetProjectFolder(message);
  if (!checked.ok) return checked;
  const grant = grants.take(owner, checked.token);
  if (grant === undefined) return failure('folder_grant_invalid', '고른 폴더를 확인할 수 없습니다. 폴더를 다시 고르세요.');
  try {
    if ((await access.kind(grant.path)) !== 'directory') return failure('folder_unusable', '고른 폴더가 없어졌습니다. 폴더를 다시 고르세요.');
    const git = await access.isGitRepo(grant.path);
    if (checked.settings?.workspaceMode === 'worktree' && !git) return failure('folder_unusable', 'worktree 모드는 git 저장소 폴더에서만 쓸 수 있습니다.');
  } catch (error) {
    return failure('folder_unusable', `폴더를 읽을 수 없습니다: ${(error as Error).message}`);
  }
  const payload = { projectId: checked.projectId, root: grant.path, ...(checked.settings === undefined ? {} : { settings: checked.settings }) };
  return send('command.execute', { requestId: `ui-${randomUUID()}`, type: 'project.configure', payload });
}

/**
 * A mode-only change from the page (`project.configure {projectId, settings}` through `request`, no folder): worktree
 * mode needs the project's folder to be a git repository. `projectRoot` answers null for a project without a folder and
 * undefined when it cannot tell (the engine then decides alone: it checks again when it saves).
 */
export async function checkWorktreeMode(params: unknown, projectRoot: (projectId: string) => Promise<string | null | undefined>, access: FolderAccess): Promise<BridgeError | undefined> {
  if (typeof params !== 'object' || params === null) return undefined;
  const { type, payload } = params as { type?: unknown; payload?: unknown };
  if (type !== 'project.configure' || typeof payload !== 'object' || payload === null) return undefined;
  const { projectId, settings } = payload as { projectId?: unknown; settings?: unknown };
  if (typeof projectId !== 'string' || typeof settings !== 'object' || settings === null) return undefined;
  if ((settings as { workspaceMode?: unknown }).workspaceMode !== 'worktree') return undefined;
  const root = await projectRoot(projectId);
  if (root === undefined) return undefined;
  const refused = (message: string): BridgeError => ({ code: 'folder_unusable', message, retryable: false });
  if (root === null) return refused('worktree 모드는 프로젝트 폴더를 먼저 골라야 쓸 수 있습니다.');
  return (await access.isGitRepo(root)) ? undefined : refused('worktree 모드는 git 저장소 폴더에서만 쓸 수 있습니다.');
}
