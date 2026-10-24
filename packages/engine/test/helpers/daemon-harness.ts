import { join } from 'node:path';
import type { AgentAdapter } from '@vuyro/agent-adapters';
import type { AgentProvider, CommandSuccess } from '@vuyro/contracts';
import { EngineClient, type EngineClientOptions } from '../../src/client/engine-client.ts';
import type { HumanApprover, PairingRequest } from '../../src/daemon/approver.ts';
import { type EngineDaemon, type EngineDaemonOptions, startEngineDaemon } from '../../src/daemon/daemon.ts';
import { tempDir } from './engine-harness.ts';

let counter = 0;

/** A unique pipe per test daemon, so parallel test files never meet. */
export function testPipe(): string {
  counter += 1;
  return `\\\\.\\pipe\\vuyro-test-${process.pid}-${Date.now()}-${counter}`;
}

/** Approver whose answers the test decides; records what the dialog would have shown. */
export class ScriptedApprover implements HumanApprover {
  readonly requests: PairingRequest[] = [];
  answer: boolean | 'throw' | 'never' = true;

  confirm(request: PairingRequest): Promise<boolean> {
    this.requests.push(request);
    if (this.answer === 'throw') return Promise.reject(new Error('dialog failed'));
    if (this.answer === 'never') return new Promise(() => undefined);
    return Promise.resolve(this.answer);
  }
}

export interface DaemonHarness {
  readonly dataDir: string;
  readonly pipePath: string;
  readonly approver: ScriptedApprover;
  readonly uiCredential: string;
  daemon: EngineDaemon;
  connect(options?: Partial<EngineClientOptions>): Promise<EngineClient>;
  /** A UI session (launch credential). */
  ui(): Promise<EngineClient>;
  /** Saves a definition as the UI and waits until it is active. */
  saveDefinition(definition: Record<string, unknown>): Promise<void>;
  restart(options?: Partial<EngineDaemonOptions>): Promise<void>;
  close(): Promise<void>;
}

export const UI_CREDENTIAL = 'vuc_test-ui-credential-0123456789abcdefghijklmnop';

export async function openDaemonHarness(
  options: Partial<EngineDaemonOptions> & { adapters?: Partial<Record<AgentProvider, AgentAdapter>>; withoutUiCredential?: boolean } = {},
): Promise<DaemonHarness> {
  const { withoutUiCredential, ...daemonOptions } = options;
  const temp = tempDir('vuyro-daemon-');
  const pipePath = testPipe();
  const approver = new ScriptedApprover();
  const errors: string[] = [];
  const start = (extra: Partial<EngineDaemonOptions> = {}) =>
    startEngineDaemon({
      dataDir: temp.dir,
      pipePath,
      approver,
      ...(withoutUiCredential === true ? {} : { uiCredential: UI_CREDENTIAL }),
      adapters: {},
      pairingTimeoutMs: 2000,
      reportError: (error, context) => {
        errors.push(`${context}: ${error.message}`);
      },
      ...daemonOptions,
      ...extra,
    });
  let daemon = await start();
  const clients: EngineClient[] = [];
  const harness: DaemonHarness = {
    dataDir: temp.dir,
    pipePath,
    approver,
    uiCredential: UI_CREDENTIAL,
    get daemon() {
      return daemon;
    },
    async connect(extra = {}) {
      const client = await EngineClient.connect({ client: 'cli', dataDir: temp.dir, pipePath, ...extra });
      clients.push(client);
      return client;
    },
    ui: () => harness.connect({ client: 'ui', uiCredential: UI_CREDENTIAL }),
    async saveDefinition(definition) {
      const ui = await harness.ui();
      const kind = definition.kind === 'nodeType' ? 'nodeType.save' : 'template.save';
      const saved: CommandSuccess = await ui.execute({ requestId: `save-${String(definition.id).replace(/[^A-Za-z0-9._:-]/g, '-')}-${String(definition.version)}`, type: kind, payload: { definition } });
      if ((saved.result as { status: string }).status === 'active') return;
      for (let attempt = 0; attempt < 200; attempt++) {
        const row = await daemon.store.queryOne<{ status: string }>('SELECT status FROM p_definitions WHERE id = ? AND version = ?', [definition.id as string, definition.version as number]);
        if (row?.status === 'active') return;
        if (row?.status === 'abandoned') throw new Error('definition abandoned');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('definition never became active');
    },
    async restart(extra = {}) {
      for (const client of clients.splice(0)) client.close();
      await daemon.close();
      daemon = await start(extra);
    },
    async close() {
      for (const client of clients.splice(0)) client.close();
      await daemon.close();
      temp.dispose();
      if (errors.length > 0 && process.env.VUYRO_TEST_SHOW_ERRORS === '1') process.stderr.write(`${errors.join('\n')}\n`);
    },
  };
  return harness;
}

export function oneAgentTemplate(id = 'test/one-agent'): Record<string, unknown> {
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'template',
    id,
    version: 1,
    name: 'One agent',
    content: {
      id,
      version: 1,
      name: 'One agent',
      nodes: [
        { id: 'work', type: 'vuyro.agent', version: 1, params: { instructions: 'Write the report.' } },
        { id: 'end', type: 'vuyro.end', version: 1 },
      ],
      edges: [{ from: { node: 'work', port: 'done' }, to: { node: 'end', port: 'in' } }],
    },
  };
}

export const dbPath = (dataDir: string): string => join(dataDir, 'engine', 'engine.db');
