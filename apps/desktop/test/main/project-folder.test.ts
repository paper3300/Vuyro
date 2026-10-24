import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BridgeResult } from '../../src/shared/bridge.ts';
import { checkSetProjectFolder, type FolderAccess, FolderGrants, pickProjectFolder, setProjectFolder } from '../../src/main/project-folder.ts';

/**
 * The project folder from the app (D-072): main picks and checks it, the page holds a one-time grant, and saving turns
 * the grant into `project.configure` with the path. The page has no way to send a path of its own.
 */

const REPO = resolve('C:\\work\\notepad');
const PLAIN = resolve('C:\\work\\plain');
const FILE = resolve('C:\\work\\notes.txt');

function disk(entries: Record<string, 'directory' | 'file'>) {
  const looked: string[] = [];
  const access: FolderAccess & { failWith?: Error } = {
    kind: (path) => {
      looked.push(path);
      if (access.failWith !== undefined) return Promise.reject(access.failWith);
      return Promise.resolve(entries[path] ?? 'missing');
    },
  };
  return { access, looked, entries };
}

const files = () => disk({ [REPO]: 'directory', [join(REPO, '.git')]: 'directory', [PLAIN]: 'directory', [FILE]: 'file' });
const dialog = (path: string | undefined) => ({ pickFolder: () => Promise.resolve(path) });

function sender() {
  const sent: { method: string; params: unknown }[] = [];
  const send = (method: 'command.execute', params: unknown): Promise<BridgeResult<unknown>> => {
    sent.push({ method, params });
    return Promise.resolve({ ok: true, value: { ok: true, result: {} } });
  };
  return { sent, send };
}

describe('picking a project folder', () => {
  it('a git repository: the page gets a grant token and the path to show', async () => {
    const grants = new FolderGrants();
    const picked = await pickProjectFolder(dialog(REPO), files().access, grants, 1);
    expect(picked).toEqual({ ok: true, value: { token: expect.stringMatching(/^vpf_[0-9a-f]{32}$/) as unknown, path: REPO, name: 'notepad', isGitRepo: true } });
    expect(grants.size).toBe(1);
  });

  it('a plain folder is not a git repository; a linked worktree (`.git` file) is', async () => {
    const plain = await pickProjectFolder(dialog(PLAIN), files().access, new FolderGrants(), 1);
    expect(plain).toMatchObject({ ok: true, value: { isGitRepo: false } });
    const linked = disk({ [PLAIN]: 'directory', [join(PLAIN, '.git')]: 'file' });
    expect(await pickProjectFolder(dialog(PLAIN), linked.access, new FolderGrants(), 1)).toMatchObject({ ok: true, value: { isGitRepo: true } });
  });

  it('cancelled: nothing granted', async () => {
    const grants = new FolderGrants();
    expect(await pickProjectFolder(dialog(undefined), files().access, grants, 1)).toEqual({ ok: true, value: null });
    expect(grants.size).toBe(0);
  });

  it('refuses what is not a folder, a relative path, and a folder it cannot read; grants nothing', async () => {
    const grants = new FolderGrants();
    expect(await pickProjectFolder(dialog(FILE), files().access, grants, 1)).toMatchObject({ ok: false, error: { code: 'folder_unusable', message: '폴더가 아닙니다.' } });
    expect(await pickProjectFolder(dialog(resolve('C:\\gone')), files().access, grants, 1)).toMatchObject({ ok: false, error: { message: '폴더가 없습니다.' } });
    expect(await pickProjectFolder(dialog('relative\\folder'), files().access, grants, 1)).toMatchObject({ ok: false, error: { code: 'folder_unusable' } });
    const broken = files();
    broken.access.failWith = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(await pickProjectFolder(dialog(REPO), broken.access, grants, 1)).toMatchObject({ ok: false, error: { message: expect.stringContaining('EACCES') as unknown } });
    expect(grants.size).toBe(0);
  });
});

describe('folder grants', () => {
  it('a grant is used once, by the window that asked for it', () => {
    const grants = new FolderGrants();
    const token = grants.grant(1, REPO, true);
    expect(grants.take(2, token)).toBeUndefined(); // another window cannot use (or spend) it
    expect(grants.take(1, token)).toEqual({ path: REPO, isGitRepo: true });
    expect(grants.take(1, token)).toBeUndefined();
  });

  it('refuses tokens it never gave, and ones that are not tokens', () => {
    const grants = new FolderGrants();
    grants.grant(1, REPO, true);
    for (const token of [`vpf_${'0'.repeat(32)}`, REPO, 'vpf_', '', 42, null, undefined, { token: 'x' }]) expect(grants.take(1, token)).toBeUndefined();
  });

  it('expires, stays small, and goes with its window', () => {
    let now = 0;
    const grants = new FolderGrants({ now: () => now, ttlMs: 1000, max: 3 });
    const old = grants.grant(1, REPO, true);
    now = 1000;
    expect(grants.take(1, old)).toBeUndefined();
    const tokens = [1, 2, 3, 4].map(() => grants.grant(1, PLAIN, false));
    expect(grants.size).toBe(3);
    expect(grants.take(1, tokens[0])).toBeUndefined(); // the oldest made room
    expect(grants.take(1, tokens[3])).toMatchObject({ path: PLAIN });
    grants.grant(2, REPO, true);
    grants.drop(1);
    expect(grants.size).toBe(1);
  });
});

describe('saving the folder as the project folder', () => {
  async function granted(path = REPO) {
    const grants = new FolderGrants();
    const picked = await pickProjectFolder(dialog(path), files().access, grants, 1);
    if (!picked.ok || picked.value === null) throw new Error('not picked');
    return { grants, token: picked.value.token };
  }

  it('sends project.configure with the granted path and the settings, as the person (the app session)', async () => {
    const { grants, token } = await granted();
    const { sent, send } = sender();
    expect(await setProjectFolder(grants, files().access, 1, { projectId: 'p1', token, settings: { workspaceMode: 'worktree' } }, send)).toMatchObject({ ok: true });
    expect(sent).toEqual([
      { method: 'command.execute', params: { requestId: expect.stringMatching(/^ui-/) as unknown, type: 'project.configure', payload: { projectId: 'p1', root: REPO, settings: { workspaceMode: 'worktree' } } } },
    ]);
    // Once.
    expect(await setProjectFolder(grants, files().access, 1, { projectId: 'p1', token }, send)).toMatchObject({ ok: false, error: { code: 'folder_grant_invalid' } });
    expect(sent).toHaveLength(1);
  });

  it('refuses a token it did not give, from another window, or a malformed request, and sends nothing', async () => {
    const { grants, token } = await granted();
    const { sent, send } = sender();
    const refused = [
      { projectId: 'p1', token: `vpf_${'a'.repeat(32)}` },
      { projectId: 'p1', root: REPO },
      { projectId: 'p1', token: REPO },
      { projectId: '../p1', token },
      { projectId: 'p1', token, settings: 'worktree' },
      { projectId: 'p1', token, settings: [] },
      null,
      [],
    ];
    for (const message of refused) expect((await setProjectFolder(grants, files().access, 1, message, send)).ok, JSON.stringify(message)).toBe(false);
    expect(await setProjectFolder(grants, files().access, 2, { projectId: 'p1', token }, send)).toMatchObject({ ok: false, error: { code: 'folder_grant_invalid' } });
    expect(sent).toEqual([]);
    // The grant was not spent by any of that.
    expect(await setProjectFolder(grants, files().access, 1, { projectId: 'p1', token }, send)).toMatchObject({ ok: true });
  });

  it('checks the folder again: gone since it was picked, or worktree mode on a folder that is not a repository', async () => {
    const { sent, send } = sender();
    const gone = await granted();
    const later = disk({ [PLAIN]: 'directory' });
    expect(await setProjectFolder(gone.grants, later.access, 1, { projectId: 'p1', token: gone.token }, send)).toMatchObject({ ok: false, error: { code: 'folder_unusable', message: '고른 폴더가 없어졌습니다. 폴더를 다시 고르세요.' } });
    const plain = await granted(PLAIN);
    expect(await setProjectFolder(plain.grants, files().access, 1, { projectId: 'p1', token: plain.token, settings: { workspaceMode: 'worktree' } }, send)).toMatchObject({
      ok: false,
      error: { message: 'worktree 모드는 git 저장소 폴더에서만 쓸 수 있습니다.' },
    });
    const broken = await granted();
    const failing = files();
    failing.access.failWith = new Error('EIO');
    expect(await setProjectFolder(broken.grants, failing.access, 1, { projectId: 'p1', token: broken.token }, send)).toMatchObject({ ok: false, error: { code: 'folder_unusable' } });
    expect(sent).toEqual([]);
  });

  it('checks the request shape', () => {
    expect(checkSetProjectFolder({ projectId: '0190aaaa-bbbb-7ccc-8ddd-eeeeee123456', token: `vpf_${'0'.repeat(32)}` })).toMatchObject({ ok: true });
    expect(checkSetProjectFolder({ projectId: 'p1', token: `vpf_${'0'.repeat(32)}`, settings: { workspaceMode: 'shared' } })).toMatchObject({ ok: true, settings: { workspaceMode: 'shared' } });
    expect(checkSetProjectFolder({ projectId: 'p'.repeat(65), token: `vpf_${'0'.repeat(32)}` })).toMatchObject({ ok: false });
  });
});
