import { useEffect, useState } from 'react';
import { useConnectionState, useLiveEvents } from '../live.ts';
import { useProjects } from '../queries.ts';
import { useUi } from '../store.ts';
import { Board } from './Board.tsx';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { NewProjectDialog, ProjectHome } from './ProjectHome.tsx';
import { TicketDrawer } from './TicketDetail.tsx';

const NEW_PROJECT = '__new__';

export function App() {
  useConnectionState();
  useLiveEvents();
  const projects = useProjects();
  const projectId = useUi((state) => state.projectId);
  const selectProject = useUi((state) => state.selectProject);
  const [creatingProject, setCreatingProject] = useState(false);
  const list = projects.data ?? [];
  const project = list.find((each) => each.projectId === projectId);

  // A remembered project that no longer exists (another data directory): back to the project list.
  useEffect(() => {
    if (projects.data !== undefined && projectId !== undefined && project === undefined) selectProject(undefined);
  }, [projects.data, projectId, project, selectProject]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none flex-wrap items-center gap-5 border-b border-line bg-white px-7 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink font-bold text-white">V</div>
          {project === undefined ? (
            <span className="text-[17px] font-bold">Vuyro</span>
          ) : (
            <select
              aria-label="프로젝트"
              value={project.projectId}
              onChange={(event) => {
                if (event.target.value === NEW_PROJECT) setCreatingProject(true);
                else selectProject(event.target.value);
              }}
              className="rounded-md border-none bg-transparent text-[17px] font-bold outline-none hover:bg-chip"
            >
              {list.map((each) => (
                <option key={each.projectId} value={each.projectId}>
                  {each.name}
                </option>
              ))}
              <option value={NEW_PROJECT}>+ 새 프로젝트…</option>
            </select>
          )}
          {project !== undefined && <span className="text-muted">/ 티켓 보드</span>}
        </div>
        {project !== undefined && (
          <nav aria-label="보기 전환" className="flex gap-1 rounded-[10px] bg-chip p-1">
            <button type="button" aria-current="page" className="h-[30px] rounded-[7px] bg-white px-3.5 font-semibold shadow-sm">
              보드
            </button>
            <button type="button" disabled title="그래프 캔버스는 다음 단계(M6b)에서 추가됩니다" className="h-[30px] rounded-[7px] px-3.5 text-muted opacity-60">
              그래프
            </button>
          </nav>
        )}
      </header>
      <ConnectionBanner />
      <main className="min-h-0 flex-1 overflow-auto">{project === undefined ? <ProjectHome /> : <Board projectId={project.projectId} />}</main>
      <TicketDrawer />
      <StatusLine />
      {creatingProject && (
        <NewProjectDialog
          onClose={() => {
            setCreatingProject(false);
          }}
        />
      )}
    </div>
  );
}

function StatusLine() {
  const connection = useUi((state) => state.connection);
  const lastSequence = useUi((state) => state.lastSequence);
  const state =
    connection.phase === 'connected' ? (connection.access === 'write' ? '엔진 연결됨' : '엔진 연결됨 (읽기 전용)') : connection.phase === 'launching' ? '엔진 시작 중' : connection.phase === 'connecting' ? '연결 중' : '연결 끊김';
  return (
    <footer className="flex flex-none items-center gap-4 border-t border-line bg-white px-7 py-1 font-mono text-[11px] text-muted">
      <span>{state}</span>
      {connection.engine !== undefined && <span>엔진 {connection.engine.version} · pid {connection.engine.pid}</span>}
      {connection.running !== undefined && <span>실행 중 {connection.running}</span>}
      <span className="flex-1" />
      <span>이벤트 #{lastSequence}</span>
    </footer>
  );
}
