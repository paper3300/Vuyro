import { relative } from 'node:path';

/**
 * File system watching narrows change detection to candidate files ([[기술 스택 결정]] §10). It is only a hint:
 * the verdict is always the file's SHA-256, and when watching stops (or never started) the read-only git status
 * and the ledger's own paths still find the changes.
 */
export interface FileWatcher {
  /** Calls `onPaths` with workspace-relative paths (`/` separators) that changed under `root`. */
  watch(root: string, ignore: readonly string[], onPaths: (paths: string[]) => void, onError: (error: Error) => void): Promise<WatchHandle>;
}

export interface WatchHandle {
  close(): Promise<void>;
}

/** @parcel/watcher (ReadDirectoryChangesW on Windows). Loaded on first use so engines without watching never load it. */
export function parcelWatcher(): FileWatcher {
  return {
    async watch(root, ignore, onPaths, onError) {
      const watcher = await import('@parcel/watcher');
      const subscription = await watcher.subscribe(
        root,
        (error, events) => {
          if (error !== null) {
            onError(error);
            return;
          }
          const paths = events.map((event) => relative(root, event.path).replace(/\\/g, '/')).filter((path) => path !== '' && !path.startsWith('..'));
          if (paths.length > 0) onPaths(paths);
        },
        { ignore: [...ignore] },
      );
      return { close: () => subscription.unsubscribe() };
    },
  };
}
