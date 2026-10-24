import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaimSpec, CommandResponse, DefinitionEnvelope, NodeTypeDefinition, TemplateDefinition, TemplateEdge, TemplateNode, WorkspaceSettings } from '@vuyro/contracts';
import { nextRequestId } from './engine-harness.ts';
import { HUMAN, type WorkflowHarness } from './workflow-harness.ts';

/** Shared pieces of the M4 workspace tests: definitions, git repositories, projects with a folder. */

export function expectOk(response: CommandResponse): void {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.details ?? {})}`);
}

export const edge = (from: string, fromPort: string, to: string, toPort = 'in'): TemplateEdge => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

export function template(id: string, nodes: TemplateNode[], edges: TemplateEdge[], settings?: WorkspaceSettings): TemplateDefinition {
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'template',
    id,
    version: 1,
    name: id,
    content: { id, version: 1, name: id, nodes, edges, ...(settings === undefined ? {} : { settings }) },
  };
}

/** An agent node type that declares claims (taken together when it starts). */
export function editorType(type: string, claims: ClaimSpec[]): NodeTypeDefinition {
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'nodeType',
    id: type,
    version: 1,
    name: type,
    content: {
      type,
      version: 1,
      label: type,
      completion: 'agent',
      inputs: [{ name: 'in', label: 'In' }],
      outputs: [
        { name: 'done', label: 'Done' },
        { name: 'error', label: 'Error' },
      ],
      params: [],
      prompt: 'Edit the files of {{ node.id }}.',
      claims,
    },
  };
}

export async function save(h: WorkflowHarness, definition: DefinitionEnvelope): Promise<void> {
  expectOk(await h.writer.save(definition, HUMAN, nextRequestId()));
}

/** A project whose workspace is `root`, with its settings layer. */
export async function projectAt(h: WorkflowHarness, root: string, settings?: WorkspaceSettings, extra: Record<string, unknown> = {}): Promise<string> {
  const { projectId } = (await h.ok('project.create', { name: 'sample' })).result as { projectId: string };
  await h.ok('project.configure', { projectId, root, ...(settings === undefined ? {} : { settings }), ...extra });
  return projectId;
}

export async function ticketIn(h: WorkflowHarness, projectId: string, templateId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const ticket = await h.ok('ticket.create', { projectId, title: 'Ticket', template: { id: templateId }, ...extra });
  return (ticket.result as { ticketId: string }).ticketId;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** A git repository with one commit (README.md and src/app.txt), its own identity and LF line ends. */
export function gitRepo(dir: string): string {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.name', 'Sample');
  git(dir, 'config', 'user.email', 'sample@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), '# sample\n');
  writeFileSync(join(dir, 'src', 'app.txt'), 'line 1\nline 2\nline 3\n');
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '-m', 'initial');
  return dir;
}

export const MINUTE = 60_000;
