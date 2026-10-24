// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Package layers. Imports may only point down this list:
 * contracts → agent-adapters → engine → hosts (cli, desktop).
 * The engine and everything below it never import Electron.
 */
const pkg = {
  contracts: '@vuyro/contracts',
  agentAdapters: '@vuyro/agent-adapters',
  engine: '@vuyro/engine',
  cli: '@vuyro/cli',
  desktop: '@vuyro/desktop',
};

const electron = {
  group: ['electron', 'electron/*', '@electron/*'],
  message: 'Only apps/desktop may import Electron. The engine must run on plain Node.',
};
const deepImport = {
  group: ['@vuyro/*/*'],
  message: 'Import a workspace package through its public entry point only.',
};
const nodeBuiltins = {
  group: ['node:*', ...builtinModules],
  message: 'contracts must stay runtime-neutral (it is shared with the renderer).',
};

/**
 * @param {string[]} files
 * @param {string[]} forbiddenPackages
 * @param {Array<{ group: string[], message: string }>} extraPatterns
 */
function layer(files, forbiddenPackages, extraPatterns = []) {
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenPackages.map((name) => ({
            name,
            message: 'Import direction is contracts → agent-adapters → engine → hosts (cli, desktop).',
          })),
          patterns: [electron, deepImport, ...extraPatterns],
        },
      ],
    },
  };
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'Docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
    },
    rules: {
      'import-x/no-relative-packages': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // CommonJS by necessity (e.g. sandboxed Electron preload).
    files: ['**/*.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  layer(['packages/contracts/**'], [pkg.agentAdapters, pkg.engine, pkg.cli, pkg.desktop], [nodeBuiltins]),
  layer(['packages/agent-adapters/**'], [pkg.engine, pkg.cli, pkg.desktop]),
  layer(['packages/engine/**'], [pkg.cli, pkg.desktop]),
  layer(['packages/cli/**'], [pkg.desktop]),
  {
    files: ['apps/desktop/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: pkg.cli, message: 'Hosts do not import each other.' }],
          patterns: [deepImport],
        },
      ],
    },
  },
  {
    // The window's page: no Node, no Electron, no engine. It reaches the engine only through the preload bridge.
    files: ['apps/desktop/src/renderer/**', 'apps/desktop/test/renderer/**'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: pkg.cli, message: 'Hosts do not import each other.' },
            { name: pkg.engine, message: 'The renderer talks to the engine only through window.vuyro (preload).' },
            { name: pkg.agentAdapters, message: 'The renderer talks to the engine only through window.vuyro (preload).' },
          ],
          patterns: [electron, deepImport, { ...nodeBuiltins, message: 'The renderer has no Node access (contextIsolation, sandbox).' }],
        },
      ],
      // Agent output and logs are text, never HTML (기술 스택 결정 §1).
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Show agent and user text as text; never inject HTML.' },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: 'Show agent and user text as text; never inject HTML.' },
      ],
    },
  },
);
