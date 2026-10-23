import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints virtual files at real paths with only the boundary rules enabled.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const BOUNDARY_RULES = new Set(['no-restricted-imports', 'import-x/no-relative-packages']);

const eslint = new ESLint({
  cwd: root,
  ruleFilter: ({ ruleId }) => BOUNDARY_RULES.has(ruleId),
  overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: null } } },
});

async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

const cases: Array<[file: string, code: string, allowed: boolean]> = [
  ['packages/engine/src/x.ts', "import { app } from 'electron';", false],
  ['packages/engine/src/x.ts', "import type { App } from 'electron';", false],
  ['packages/engine/src/x.ts', "import '@electron/remote';", false],
  ['packages/engine/src/x.ts', "import { runCli } from '@vuyro/cli';", false],
  ['packages/engine/src/x.ts', "import { PROTOCOL_VERSION } from '@vuyro/contracts';", true],
  ['packages/engine/src/x.ts', "import { describeAdapter } from '@vuyro/agent-adapters';", true],
  ['packages/engine/src/x.ts', "import { PROTOCOL_VERSION } from '../../contracts/src/index.ts';", false],
  ['packages/agent-adapters/src/x.ts', "import { SqliteWorker } from '@vuyro/engine';", false],
  ['packages/contracts/src/x.ts', "import { SqliteWorker } from '@vuyro/engine';", false],
  ['packages/contracts/src/x.ts', "import { readFileSync } from 'node:fs';", false],
  ['packages/contracts/src/x.ts', "import path from 'path';", false],
  ['packages/cli/src/x.ts', "import { SqliteWorker } from '@vuyro/engine';", true],
  ['packages/cli/src/x.ts', "import { x } from '@vuyro/engine/src/index.ts';", false],
  ['packages/cli/src/x.ts', "import { app } from 'electron';", false],
  ['apps/desktop/src/x.ts', "import { app } from 'electron';", true],
  ['apps/desktop/src/x.ts', "import { SqliteWorker } from '@vuyro/engine';", true],
  ['apps/desktop/src/x.ts', "import { runCli } from '@vuyro/cli';", false],
];

describe('import boundaries (eslint.config.js)', () => {
  it.each(cases)('%s: %s → allowed=%s', async (file, code, allowed) => {
    const found = await violations(file, `${code}\nexport {};\n`);
    if (allowed) expect(found).toEqual([]);
    else expect(found.length).toBeGreaterThan(0);
  });
});
