import { describe, expect, it } from 'vitest';
import { checkCopyText, checkSaveFile, type FileAccess, type FileDialogs, MAX_FILE_BYTES, openJsonFile, safeFileName, saveJsonFile } from '../../src/main/file-exchange.ts';

/**
 * JSON files and the clipboard for import and export (M6b): the page never names a path; main reads only what the
 * person picked, within the size limit, and hands back the name and text.
 */

function fakes(options: { open?: string; save?: string; size?: number; isFile?: boolean; text?: string; fail?: 'stat' | 'read' | 'write' } = {}) {
  const written: { path: string; text: string }[] = [];
  const suggested: string[] = [];
  let reads = 0;
  const dialogs: FileDialogs = {
    pickOpen: () => Promise.resolve(options.open),
    pickSave: (name) => {
      suggested.push(name);
      return Promise.resolve(options.save);
    },
  };
  const files: FileAccess = {
    stat: () => (options.fail === 'stat' ? Promise.reject(new Error('gone')) : Promise.resolve({ size: options.size ?? 10, isFile: options.isFile ?? true })),
    readText: () => {
      reads += 1;
      return options.fail === 'read' ? Promise.reject(new Error('locked')) : Promise.resolve(options.text ?? '{"vuyro":"export"}');
    },
    writeText: (path, text) => {
      if (options.fail === 'write') return Promise.reject(new Error('read-only'));
      written.push({ path, text });
      return Promise.resolve();
    },
  };
  return { dialogs, files, written, suggested, reads: () => reads };
}

describe('opening a JSON file', () => {
  it('returns the name and text of the file the person picked, without its folder', async () => {
    const { dialogs, files } = fakes({ open: 'C:\\Users\\me\\Downloads\\flow.json', text: '\uFEFF{"a":1}' });
    expect(await openJsonFile(dialogs, files)).toEqual({ ok: true, value: { name: 'flow.json', text: '{"a":1}' } });
  });

  it('nothing when the person cancels', async () => {
    const { dialogs, files, reads } = fakes();
    expect(await openJsonFile(dialogs, files)).toEqual({ ok: true, value: null });
    expect(reads()).toBe(0);
  });

  it('refuses folders and files over the limit without reading them, and reports unreadable files', async () => {
    const big = fakes({ open: 'C:\\big.json', size: MAX_FILE_BYTES + 1 });
    expect(await openJsonFile(big.dialogs, big.files)).toMatchObject({ ok: false, error: { code: 'file_too_large' } });
    expect(big.reads()).toBe(0);
    const folder = fakes({ open: 'C:\\dir', isFile: false });
    expect(await openJsonFile(folder.dialogs, folder.files)).toMatchObject({ ok: false, error: { code: 'file_unreadable' } });
    expect(folder.reads()).toBe(0);
    const gone = fakes({ open: 'C:\\x.json', fail: 'stat' });
    expect(await openJsonFile(gone.dialogs, gone.files)).toMatchObject({ ok: false, error: { code: 'file_unreadable' } });
    const locked = fakes({ open: 'C:\\x.json', fail: 'read' });
    expect(await openJsonFile(locked.dialogs, locked.files)).toMatchObject({ ok: false, error: { code: 'file_unreadable', message: '파일을 읽을 수 없습니다: locked' } });
  });
});

describe('saving a JSON file', () => {
  it('suggests a bare file name and writes where the person picked', async () => {
    const { dialogs, files, written, suggested } = fakes({ save: 'D:\\out\\mine.json' });
    expect(await saveJsonFile(dialogs, files, { name: 'vuyro.ai-sdlc@1.json', text: '{}' })).toEqual({ ok: true, value: { name: 'mine.json' } });
    expect(suggested).toEqual(['vuyro.ai-sdlc@1.json']);
    expect(written).toEqual([{ path: 'D:\\out\\mine.json', text: '{}' }]);
  });

  it('never lets the page choose a folder or an odd name', () => {
    expect(safeFileName('..\\..\\Windows\\System32\\evil.json')).toBe('evil.json');
    expect(safeFileName('../../etc/passwd')).toBe('passwd.json');
    expect(safeFileName('C:\\x\\a b<c>.json')).toBe('a_b_c_.json');
    expect(safeFileName('...hidden')).toBe('hidden.json');
    expect(safeFileName('')).toBe('vuyro-export.json');
    expect(safeFileName(42)).toBe('vuyro-export.json');
    expect(safeFileName('x'.repeat(300))).toHaveLength(125);
  });

  it('refuses malformed and oversized requests before any dialog, and reports write failures', async () => {
    const { dialogs, files, suggested } = fakes({ save: 'D:\\out.json' });
    for (const message of [null, [], 'x', { name: 'a.json' }, { name: 'a.json', text: 7 }]) {
      expect(await saveJsonFile(dialogs, files, message)).toMatchObject({ ok: false, error: { code: 'bridge_refused' } });
    }
    expect(await saveJsonFile(dialogs, files, { name: 'a.json', text: 'x'.repeat(MAX_FILE_BYTES + 1) })).toMatchObject({ ok: false, error: { code: 'file_too_large' } });
    expect(suggested).toEqual([]);
    const cancelled = fakes();
    expect(await saveJsonFile(cancelled.dialogs, cancelled.files, { name: 'a.json', text: '{}' })).toEqual({ ok: true, value: null });
    expect(cancelled.written).toEqual([]);
    const readOnly = fakes({ save: 'D:\\out.json', fail: 'write' });
    expect(await saveJsonFile(readOnly.dialogs, readOnly.files, { name: 'a.json', text: '{}' })).toMatchObject({ ok: false, error: { code: 'file_unwritable' } });
    expect(checkSaveFile({ name: '../a', text: '' })).toEqual({ ok: true, name: 'a.json', text: '' });
    // The limit is in UTF-8 bytes: Korean text under the character count can be over it.
    const korean = '가'.repeat(Math.floor(MAX_FILE_BYTES / 3) + 1);
    expect(korean.length).toBeLessThan(MAX_FILE_BYTES);
    expect(checkSaveFile({ name: 'a.json', text: korean })).toMatchObject({ ok: false, error: { code: 'file_too_large' } });
    expect(checkSaveFile({ name: 'a.json', text: '가'.repeat(Math.floor(MAX_FILE_BYTES / 3)) })).toMatchObject({ ok: true });
  });
});

describe('copying', () => {
  it('takes text only, within the limit', () => {
    expect(checkCopyText({ text: '{}' })).toEqual({ ok: true, text: '{}' });
    for (const message of [null, [], { text: 1 }, {}]) expect(checkCopyText(message)).toMatchObject({ ok: false, error: { code: 'bridge_refused' } });
    expect(checkCopyText({ text: 'x'.repeat(MAX_FILE_BYTES + 1) })).toMatchObject({ ok: false, error: { code: 'file_too_large' } });
    expect(checkCopyText({ text: '가'.repeat(Math.floor(MAX_FILE_BYTES / 3) + 1) })).toMatchObject({ ok: false, error: { code: 'file_too_large' } });
  });
});
