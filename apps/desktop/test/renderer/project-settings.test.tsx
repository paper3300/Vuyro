import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { NewProjectForm, ProjectSettingsDialog } from '../../src/renderer/components/ProjectHome.tsx';
import type { PickedFolder } from '../../src/shared/bridge.ts';
import type { ProjectRow } from '../../src/renderer/types.ts';
import { installBridge, renderWithClient, setConnection } from './fixtures.tsx';

/**
 * The project folder and workspace mode from the app (D-072, D-073): the folder comes from main's dialog as a grant,
 * worktree mode only for a git repository, and saving goes through `project.configure`.
 */

beforeEach(() => {
  setConnection();
});

const REPO: PickedFolder = { token: `vpf_${'1'.repeat(32)}`, path: 'C:\\work\\notepad', name: 'notepad', isGitRepo: true };
const PLAIN: PickedFolder = { token: `vpf_${'2'.repeat(32)}`, path: 'C:\\work\\plain', name: 'plain', isGitRepo: false };

const worktree = () => screen.getByRole('radio', { name: /git worktree/ });
const shared = () => screen.getByRole('radio', { name: /공유 폴더/ });

describe('new project with a folder', () => {
  it('creates the project, then saves the picked folder and mode by its grant (never a path)', async () => {
    const created: string[] = [];
    const bridge = installBridge({ 'command.execute': () => ({ projectId: 'p-new' }) });
    bridge.pickProjectFolder.mockResolvedValueOnce({ ok: true, value: REPO });
    renderWithClient(<NewProjectForm onCreated={(id) => created.push(id)} />);
    await userEvent.type(screen.getByLabelText('프로젝트 이름'), 'notepad');
    // No folder yet: worktree mode cannot be chosen.
    expect(worktree()).toBeDisabled();
    expect(screen.getByLabelText('프로젝트 폴더 경로')).toHaveTextContent('없음');
    await userEvent.click(screen.getByRole('button', { name: '폴더 고르기…' }));
    expect(await screen.findByText('git 저장소')).toBeInTheDocument();
    expect(screen.getByLabelText('프로젝트 폴더 경로')).toHaveTextContent('C:\\work\\notepad');
    await userEvent.click(worktree());
    await userEvent.click(screen.getByRole('button', { name: '프로젝트 만들기' }));
    await waitFor(() => {
      expect(created).toEqual(['p-new']);
    });
    expect(bridge.commands).toEqual([{ type: 'project.create', payload: { name: 'notepad' } }]);
    expect(bridge.setProjectFolder).toHaveBeenCalledWith('p-new', REPO.token, { workspaceMode: 'worktree' });
  });

  it('a folder that is not a git repository keeps shared mode; no folder means no project.configure at all', async () => {
    const bridge = installBridge({ 'command.execute': () => ({ projectId: 'p-new' }) });
    bridge.pickProjectFolder.mockResolvedValueOnce({ ok: true, value: PLAIN });
    renderWithClient(<NewProjectForm onCreated={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: '폴더 고르기…' }));
    expect(await screen.findByText('git 저장소 아님')).toBeInTheDocument();
    expect(worktree()).toBeDisabled();
    expect(shared()).toBeChecked();

    const without = installBridge({ 'command.execute': () => ({ projectId: 'p-2' }) });
    renderWithClient(<NewProjectForm onCreated={() => undefined} />);
    const [, second] = screen.getAllByLabelText('프로젝트 이름');
    if (second === undefined) throw new Error('second form missing');
    await userEvent.type(second, 'bare');
    const [, create] = screen.getAllByRole('button', { name: '프로젝트 만들기' });
    if (create === undefined) throw new Error('second button missing');
    await userEvent.click(create);
    await waitFor(() => {
      expect(without.commands).toEqual([{ type: 'project.create', payload: { name: 'bare' } }]);
    });
    expect(without.setProjectFolder).not.toHaveBeenCalled();
  });

  it('says so when the folder could not be saved after the project was made', async () => {
    const bridge = installBridge({ 'command.execute': () => ({ projectId: 'p-new' }) });
    bridge.pickProjectFolder.mockResolvedValueOnce({ ok: true, value: REPO });
    bridge.setProjectFolder.mockResolvedValueOnce({ ok: false, error: { code: 'folder_unusable', message: '고른 폴더가 없어졌습니다. 폴더를 다시 고르세요.', retryable: false } });
    const created: string[] = [];
    renderWithClient(<NewProjectForm onCreated={(id) => created.push(id)} />);
    await userEvent.type(screen.getByLabelText('프로젝트 이름'), 'notepad');
    await userEvent.click(screen.getByRole('button', { name: '폴더 고르기…' }));
    await screen.findByText('git 저장소');
    await userEvent.click(screen.getByRole('button', { name: '프로젝트 만들기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('프로젝트는 만들었지만 폴더를 저장하지 못했습니다');
    expect(created).toEqual([]);
    // The grant is spent: the folder must be picked again.
    expect(screen.getByLabelText('프로젝트 폴더 경로')).toHaveTextContent('없음');
  });

  it('a dialog error is shown, nothing is sent', async () => {
    const bridge = installBridge();
    bridge.pickProjectFolder.mockResolvedValueOnce({ ok: false, error: { code: 'folder_unusable', message: '폴더가 아닙니다.', retryable: false } });
    renderWithClient(<NewProjectForm onCreated={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: '폴더 고르기…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('폴더가 아닙니다.');
    expect(bridge.commands).toEqual([]);
  });
});

describe('project settings', () => {
  const project: ProjectRow = { projectId: 'p1', name: 'notepad', createdAt: 0, root: 'C:\\work\\notepad', settings: { onConflict: 'warn' }, rootIsGitRepo: true };

  it('changes the mode alone through project.configure, keeping the other settings', async () => {
    const bridge = installBridge();
    let closed = false;
    renderWithClient(<ProjectSettingsDialog project={project} onClose={() => (closed = true)} />);
    expect(screen.getByLabelText('프로젝트 폴더 경로')).toHaveTextContent('C:\\work\\notepad');
    expect(shared()).toBeChecked();
    const save = screen.getByRole('button', { name: '저장' });
    expect(save).toBeDisabled();
    await userEvent.click(worktree());
    await userEvent.click(save);
    await waitFor(() => {
      expect(closed).toBe(true);
    });
    expect(bridge.commands).toEqual([{ type: 'project.configure', payload: { projectId: 'p1', settings: { onConflict: 'warn', workspaceMode: 'worktree' } } }]);
    expect(bridge.setProjectFolder).not.toHaveBeenCalled();
  });

  it('a new folder goes by its grant; one that is not a repository turns worktree mode back to shared', async () => {
    const bridge = installBridge();
    bridge.pickProjectFolder.mockResolvedValueOnce({ ok: true, value: PLAIN });
    renderWithClient(<ProjectSettingsDialog project={{ ...project, settings: { workspaceMode: 'worktree' } }} onClose={() => undefined} />);
    expect(worktree()).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '폴더 바꾸기…' }));
    expect(await screen.findByText('git 저장소 아님')).toBeInTheDocument();
    expect(shared()).toBeChecked();
    expect(worktree()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => {
      expect(bridge.setProjectFolder).toHaveBeenCalledWith('p1', PLAIN.token, { workspaceMode: 'shared' });
    });
    expect(bridge.commands).toEqual([]);
  });

  it('a project without a folder cannot choose worktree mode; a read-only connection cannot change anything', async () => {
    installBridge();
    renderWithClient(<ProjectSettingsDialog project={{ ...project, root: null, settings: null, rootIsGitRepo: false }} onClose={() => undefined} />);
    expect(screen.getByLabelText('프로젝트 폴더 경로')).toHaveTextContent('없음');
    expect(worktree()).toBeDisabled();
    setConnection({ phase: 'connected', access: 'read-only' });
    expect(await screen.findByRole('button', { name: '폴더 고르기…' })).toBeDisabled();
  });
});
