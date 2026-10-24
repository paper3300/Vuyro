import { basename } from 'node:path';
import { MAX_EXPORT_TEXT } from '@vuyro/contracts';
import type { BridgeError, BridgeResult, OpenedFile, SavedFile } from '../shared/bridge.ts';

/**
 * Files and the clipboard for JSON import and export (M6b). The page cannot touch files: the person picks a path in a
 * system dialog, main reads or writes it, and the page only ever sees the file's name and text. Every argument from
 * the page is checked (size, type); a suggested name is reduced to a bare file name.
 */

/** Largest file read or written (bytes). The engine checks the text again (MAX_EXPORT_TEXT characters). */
export const MAX_FILE_BYTES = MAX_EXPORT_TEXT;

export interface FileDialogs {
  /** The path the person picked, or undefined when cancelled. */
  pickOpen(): Promise<string | undefined>;
  pickSave(suggestedName: string): Promise<string | undefined>;
}

export interface FileAccess {
  /** Size in bytes, and whether it is a regular file. */
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

const failure = (code: string, message: string): { ok: false; error: BridgeError } => ({ ok: false, error: { code, message, retryable: false } });

/** A file name the page suggests, without folders, odd characters or a missing extension. */
export function safeFileName(name: unknown): string {
  const raw = typeof name === 'string' ? (name.split(/[\\/]/).pop() ?? '') : '';
  const cleaned = raw
    .replace(/[^A-Za-z0-9._@-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const base = cleaned === '' || cleaned === '.json' ? 'vuyro-export.json' : cleaned;
  return base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
}

export async function openJsonFile(dialogs: FileDialogs, files: FileAccess): Promise<BridgeResult<OpenedFile | null>> {
  const path = await dialogs.pickOpen();
  if (path === undefined) return { ok: true, value: null };
  try {
    const info = await files.stat(path);
    if (!info.isFile) return failure('file_unreadable', '파일이 아닙니다.');
    if (info.size > MAX_FILE_BYTES) return failure('file_too_large', `파일이 너무 큽니다(${String(Math.ceil(info.size / 1024))} KB, 최대 ${String(MAX_FILE_BYTES / 1024)} KB).`);
    const text = (await files.readText(path)).replace(/^\uFEFF/, '');
    // A UTF-8 file has no more characters than bytes, so the text is within the engine's limit too.
    return { ok: true, value: { name: basename(path), text } };
  } catch (error) {
    return failure('file_unreadable', `파일을 읽을 수 없습니다: ${(error as Error).message}`);
  }
}

/** `{name, text}` from the page. */
export function checkSaveFile(message: unknown): { ok: true; name: string; text: string } | { ok: false; error: BridgeError } {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return failure('bridge_refused', 'malformed request');
  const { name, text } = message as { name?: unknown; text?: unknown };
  if (typeof text !== 'string') return failure('bridge_refused', 'text must be a string');
  if (text.length > MAX_EXPORT_TEXT) return failure('file_too_large', '내보낼 내용이 너무 큽니다.');
  return { ok: true, name: safeFileName(name), text };
}

export async function saveJsonFile(dialogs: FileDialogs, files: FileAccess, message: unknown): Promise<BridgeResult<SavedFile | null>> {
  const checked = checkSaveFile(message);
  if (!checked.ok) return checked;
  const path = await dialogs.pickSave(checked.name);
  if (path === undefined) return { ok: true, value: null };
  try {
    await files.writeText(path, checked.text);
    return { ok: true, value: { name: basename(path) } };
  } catch (error) {
    return failure('file_unwritable', `파일을 쓸 수 없습니다: ${(error as Error).message}`);
  }
}

/** `{text}` from the page, for the clipboard. */
export function checkCopyText(message: unknown): { ok: true; text: string } | { ok: false; error: BridgeError } {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return failure('bridge_refused', 'malformed request');
  const { text } = message as { text?: unknown };
  if (typeof text !== 'string') return failure('bridge_refused', 'text must be a string');
  if (text.length > MAX_EXPORT_TEXT) return failure('file_too_large', '복사할 내용이 너무 큽니다.');
  return { ok: true, text };
}
