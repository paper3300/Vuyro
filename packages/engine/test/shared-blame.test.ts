import { describe, expect, it } from 'vitest';
import type { CheckoutEntry, Holder } from '@vuyro/contracts';
import { blameMembers, reportedFiles, scanErrors } from '../src/shared/blame.ts';
import { EMPTY_LEDGER, evolveLedger, type LedgerState } from '../src/workspace/ledger.ts';

/** `blame` (M5, [[공유·권한·BlackBoard 설계]] §4.5): which files a failed batch's errors name, and whose they are. */

const ROOT = process.platform === 'win32' ? 'C:\\work\\game' : '/work/game';
const abs = (path: string): string => (process.platform === 'win32' ? `${ROOT}\\${path.replace(/\//g, '\\')}` : `${ROOT}/${path}`);

const T1 = '019b0000-0000-7000-8000-000000000001';
const T2 = '019b0000-0000-7000-8000-000000000002';
const T3 = '019b0000-0000-7000-8000-000000000003';
const holder = (ticketId: string, nodeId = 'dev'): Holder => ({ ticketId, nodeId, lane: 'main', run: 1 });
const member = (ticketId: string): Holder => holder(ticketId, 'build');

let next = 0;
function entry(ticketId: string, path: string, kind: 'checkout' | 'claim', mode: 'exclusive' | 'shared' = 'exclusive'): CheckoutEntry {
  next += 1;
  return {
    id: `019b0000-0000-7000-8000-${String(next).padStart(12, '0')}`,
    space: 'root',
    path,
    kind,
    mode,
    holder: holder(ticketId),
    release: 'nodeDone',
    onConflict: 'firstWins',
    pauseMode: 'boundary',
    priority: 0,
  };
}

function ledgerOf(...entries: CheckoutEntry[]): LedgerState {
  let ledger = EMPTY_LEDGER;
  for (const item of entries) ledger = evolveLedger(ledger, { type: 'checkout.acquired', data: { projectId: T1, entries: [item], source: 'hook' } });
  // Released entries leave the ledger but not the edit history.
  return evolveLedger(ledger, { type: 'checkout.released', data: { projectId: T1, ids: entries.map((item) => item.id), reason: 'nodeDone' } });
}

describe('error lines', () => {
  it('finds the files compilers name, inside the project folder only', () => {
    const output = [
      'Building...',
      `${abs('Source/Game/Hero.cpp')}(42): error C2065: 'speed': undeclared identifier`,
      `${abs('Source/Game/Hero.cpp')}(57,3): error C2143: syntax error`,
      'src/app/main.ts(12,5): error TS2322: Type string is not assignable to type number.',
      'lib/util.c:7:1: error: unknown type name',
      'lib/util.c:9:3: fatal error: missing.h: No such file or directory',
      `${process.platform === 'win32' ? 'D:\\other\\x.cpp' : '/other/x.cpp'}(3): error C1083: outside the project`,
      'warning: unused variable in lib/warn.c:3:1',
      'Build failed: 0 error(s), 2 warning(s).',
      'Done: 4 errors.',
    ].join('\n');
    const scan = scanErrors(output, ROOT, true);
    expect(scan.files.map((file) => file.path)).toEqual(['Source/Game/Hero.cpp', 'src/app/main.ts', 'lib/util.c']);
    expect(scan.files[0]?.lines).toHaveLength(2);
    // Summaries ('0 error(s)', '4 errors') and warnings are not error lines.
    expect(scan.lines).toHaveLength(6);
    expect(scan.lines.some((line) => line.includes('0 error(s)'))).toBe(false);
    expect(scan.lines.some((line) => line.startsWith('warning'))).toBe(false);
  });

  it('takes the files a script reported itself, as workspace paths', () => {
    expect(reportedFiles(['src/a.c', abs('src/b.c'), '../escape.c', 'src/a.c', 'src\\c.c'], ROOT, true)).toEqual(['src/a.c', 'src/b.c', 'src/c.c']);
  });

  it('stays quick on long lines that name no file', () => {
    const line = `error ${'a.'.repeat(20_000)}`;
    const started = Date.now();
    expect(scanErrors(line, ROOT, true).files).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('blame', () => {
  it('blames the members whose tickets checked out a file the errors name, never tickets outside the batch', () => {
    const ledger = ledgerOf(entry(T1, 'src/a.c', 'checkout'), entry(T2, 'src/b.c', 'checkout'), entry(T3, 'src/c.c', 'checkout'));
    const blame = blameMembers(ledger, 'root', ['src/b.c', 'src/c.c'], [member(T1), member(T2)]);
    expect(blame.blamed).toEqual([member(T2)]);
    expect(blame.evidence).toBe('edit');
    expect([...blame.filesByTicket]).toEqual([[T2, ['src/b.c']]]);
  });

  it('every member that edited a broken file is blamed', () => {
    const ledger = ledgerOf(entry(T1, 'src/b.c', 'checkout'), entry(T2, 'src/b.c', 'checkout'));
    expect(blameMembers(ledger, 'root', ['src/b.c'], [member(T1), member(T2)]).blamed).toEqual([member(T1), member(T2)]);
  });

  it('falls back on exclusive claims only when no edit points at a member, and ignores shared ones', () => {
    const ledger = ledgerOf(entry(T1, 'Source/UI/**', 'claim'), entry(T2, 'Source/**', 'claim', 'shared'), entry(T3, 'Source/UI/Menu.cpp', 'checkout', 'shared'));
    const blame = blameMembers(ledger, 'root', ['Source/UI/Menu.cpp'], [member(T1), member(T2), member(T3)]);
    expect(blame.blamed).toEqual([member(T1)]);
    expect(blame.evidence).toBe('claim');
  });

  it('remembers edits found afterwards (changes attributed to a checkout) and finds nobody for untouched files', () => {
    let ledger = EMPTY_LEDGER;
    ledger = evolveLedger(ledger, {
      type: 'workspace.changesDetected',
      data: { projectId: T1, space: 'root', scan: 'finish', changes: [{ path: 'src/x.c', hash: null, attribution: 'checkout', holder: holder(T3) }] },
    });
    expect(blameMembers(ledger, 'root', ['src/x.c'], [member(T3)]).blamed).toEqual([member(T3)]);
    expect(blameMembers(ledger, 'root', ['src/y.c'], [member(T3)]).blamed).toEqual([]);
  });
});
