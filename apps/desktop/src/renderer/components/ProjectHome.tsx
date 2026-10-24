import { useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import type { PickedFolder } from '../../shared/bridge.ts';
import { execute, pickProjectFolder, setProjectFolder } from '../api.ts';
import { errorText, formatTime } from '../format.ts';
import { useProjects } from '../queries.ts';
import { useCanWrite, useUi } from '../store.ts';
import type { ProjectRow } from '../types.ts';
import { Button, Chip, ErrorNote, Modal } from './ui.tsx';

type Mode = 'shared' | 'worktree';

const MODES: readonly { value: Mode; label: string; detail: string }[] = [
  { value: 'shared', label: '공유 폴더 (shared)', detail: '모든 노드가 프로젝트 폴더에서 일합니다. 같은 파일은 내부 체크아웃으로 차례를 기다립니다.' },
  {
    value: 'worktree',
    label: 'git worktree',
    detail: '병렬 Dev 레인마다 git worktree에서 일하고, 합류가 티켓 브랜치로 머지합니다. 원본 브랜치와 작업 폴더는 건드리지 않습니다. git 저장소 폴더에서만 고를 수 있습니다.',
  },
];

/**
 * The project folder and workspace mode (D-072). The folder comes from a system dialog through main (the page only
 * shows it); worktree mode needs the folder to be a git repository.
 */
function WorkspaceFields({
  folder,
  isGitRepo,
  mode,
  disabled,
  onPicked,
  onMode,
  onError,
}: {
  folder: string | undefined;
  isGitRepo: boolean;
  mode: Mode;
  disabled: boolean;
  onPicked: (picked: PickedFolder) => void;
  onMode: (mode: Mode) => void;
  onError: (error: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      const picked = await pickProjectFolder();
      if (picked !== undefined) onPicked(picked);
    } catch (failure) {
      onError(errorText(failure));
    } finally {
      setPicking(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold">프로젝트 폴더</span>
        <div className="flex items-center gap-2">
          <span aria-label="프로젝트 폴더 경로" className={`min-w-0 flex-1 truncate rounded-lg border border-line bg-chip px-3 py-1.5 font-mono text-[12px] ${folder === undefined ? 'text-muted' : ''}`} title={folder}>
            {folder ?? '없음'}
          </span>
          <Button kind="secondary" disabled={disabled || picking} onClick={() => void pick()}>
            {folder === undefined ? '폴더 고르기…' : '폴더 바꾸기…'}
          </Button>
        </div>
        {folder === undefined ? (
          <span className="text-[12px] text-muted">폴더가 없으면 에이전트는 티켓마다 데이터 폴더 안의 빈 폴더에서 일하고, 내부 체크아웃 장부를 쓰지 않습니다.</span>
        ) : (
          <span>
            <Chip tone={isGitRepo ? 'done' : 'wait'}>{isGitRepo ? 'git 저장소' : 'git 저장소 아님'}</Chip>
          </span>
        )}
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-semibold">작업 공간 모드</legend>
        {MODES.map((each) => {
          const unavailable = each.value === 'worktree' && (folder === undefined || !isGitRepo);
          return (
            <label key={each.value} className={`flex gap-2 rounded-lg border px-3 py-2 ${mode === each.value ? 'border-agent' : 'border-line'} ${unavailable ? 'opacity-50' : ''}`}>
              <input
                type="radio"
                name="workspace-mode"
                value={each.value}
                checked={mode === each.value}
                disabled={disabled || unavailable}
                onChange={() => {
                  onMode(each.value);
                }}
              />
              <span className="flex flex-col">
                <span className="font-semibold">{each.label}</span>
                <span className="text-[12px] text-muted">{each.detail}</span>
              </span>
            </label>
          );
        })}
        <span className="text-[12px] text-muted">새 티켓부터 적용됩니다. 템플릿이 모드를 정하면 템플릿을 따릅니다(기본 템플릿은 정하지 않습니다).</span>
      </fieldset>
    </>
  );
}

/** Creates a project (`project.create`), then saves the picked folder and mode (`project.configure`); the board opens on it. */
export function NewProjectForm({ onCreated }: { onCreated: (projectId: string) => void }) {
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<PickedFolder>();
  const [mode, setMode] = useState<Mode>('shared');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    setError(undefined);
    let created: string | undefined;
    try {
      created = (await execute<{ projectId: string }>('project.create', { name: name.trim() })).projectId;
      if (picked !== undefined) await setProjectFolder(created, picked.token, { workspaceMode: mode });
      await client.invalidateQueries({ queryKey: ['projects'] });
      onCreated(created);
    } catch (failure) {
      await client.invalidateQueries({ queryKey: ['projects'] });
      setError(created === undefined ? errorText(failure) : `프로젝트는 만들었지만 폴더를 저장하지 못했습니다: ${errorText(failure)} 프로젝트 설정에서 다시 고르세요.`);
      // A grant is used once: pick again.
      setPicked(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">프로젝트 이름</span>
        <input
          value={name}
          maxLength={200}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="예: SampleGame"
          className="h-9 rounded-lg border border-[#d5d9e0] px-3 outline-none focus:border-agent"
        />
      </label>
      <WorkspaceFields
        folder={picked?.path}
        isGitRepo={picked?.isGitRepo ?? false}
        mode={mode}
        disabled={!canWrite || busy}
        onPicked={(folder) => {
          setPicked(folder);
          if (!folder.isGitRepo) setMode('shared');
        }}
        onMode={setMode}
        onError={setError}
      />
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <Button type="submit" kind="primary" disabled={!canWrite || busy || name.trim() === ''} title={canWrite ? undefined : '권한을 연결해야 만들 수 있습니다'}>
          프로젝트 만들기
        </Button>
      </div>
    </form>
  );
}

/** The project's folder and workspace mode, changed later (`project.configure`; new tickets use them). */
export function ProjectSettingsDialog({ project, onClose }: { project: ProjectRow; onClose: () => void }) {
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const current: Mode = project.settings?.workspaceMode ?? 'shared';
  const [picked, setPicked] = useState<PickedFolder>();
  const [mode, setMode] = useState<Mode>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isGitRepo = picked === undefined ? project.rootIsGitRepo : picked.isGitRepo;
  const changed = picked !== undefined || mode !== current;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    // The settings layer is replaced as a whole: keep what else the project set (CLI `--settings`).
    const settings = { ...(project.settings ?? {}), workspaceMode: mode };
    try {
      if (picked === undefined) await execute('project.configure', { projectId: project.projectId, settings });
      else await setProjectFolder(project.projectId, picked.token, settings);
      await client.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
      setPicked(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`프로젝트 설정 · ${project.name}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <WorkspaceFields
          folder={picked?.path ?? project.root ?? undefined}
          isGitRepo={isGitRepo}
          mode={mode}
          disabled={!canWrite || busy}
          onPicked={(folder) => {
            setPicked(folder);
            if (!folder.isGitRepo) setMode('shared');
          }}
          onMode={setMode}
          onError={setError}
        />
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            닫기
          </Button>
          <Button kind="primary" disabled={!canWrite || busy || !changed} title={canWrite ? undefined : '권한을 연결해야 바꿀 수 있습니다'} onClick={() => void save()}>
            저장
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The first screen: pick a project or make one. */
export function ProjectHome() {
  const projects = useProjects();
  const selectProject = useUi((state) => state.selectProject);
  const list = projects.data ?? [];
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-12">
      <div>
        <h1 className="text-[22px] font-bold">프로젝트</h1>
        <p className="mt-1 text-muted">티켓은 프로젝트 안에서 만듭니다. 프로젝트를 고르거나 새로 만드세요.</p>
      </div>
      {list.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="프로젝트 목록">
          {list.map((project) => (
            <li key={project.projectId}>
              <button
                type="button"
                onClick={() => {
                  selectProject(project.projectId);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-white px-4 py-3 text-left hover:border-agent"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{project.name}</span>
                  <span className="truncate font-mono text-[11.5px] text-muted">
                    {project.root ?? '폴더 없음'} · {project.settings?.workspaceMode ?? 'shared'}
                  </span>
                </span>
                <span className="font-mono text-[12px] text-muted">{formatTime(project.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-xl border border-line bg-white p-5">
        <h2 className="mb-3 font-bold">새 프로젝트</h2>
        <NewProjectForm onCreated={selectProject} />
      </div>
    </div>
  );
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const selectProject = useUi((state) => state.selectProject);
  return (
    <Modal title="새 프로젝트" onClose={onClose}>
      <NewProjectForm
        onCreated={(projectId) => {
          selectProject(projectId);
          onClose();
        }}
      />
    </Modal>
  );
}
