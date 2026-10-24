import { useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';
import { execute } from '../api.ts';
import { errorText, formatTime } from '../format.ts';
import { useProjects } from '../queries.ts';
import { useCanWrite, useUi } from '../store.ts';
import { Button, ErrorNote, Modal } from './ui.tsx';

/** Creates a project (`project.create`); the board opens on it. */
export function NewProjectForm({ onCreated }: { onCreated: (projectId: string) => void }) {
  const canWrite = useCanWrite();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const { projectId } = await execute<{ projectId: string }>('project.create', { name: name.trim() });
      await client.invalidateQueries({ queryKey: ['projects'] });
      onCreated(projectId);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
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
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <Button type="submit" kind="primary" disabled={!canWrite || busy || name.trim() === ''} title={canWrite ? undefined : '권한을 연결해야 만들 수 있습니다'}>
          프로젝트 만들기
        </Button>
      </div>
    </form>
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
                className="flex w-full items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-left hover:border-agent"
              >
                <span className="font-semibold">{project.name}</span>
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
