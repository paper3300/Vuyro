import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExportBundle, ImportChoice, ImportPreview, NodeTypeDefinition, TemplateDefinition } from '@vuyro/contracts';
import { definitionHash, definitionPath } from '../src/workflow/definitions.ts';
import { bundleHash, ExchangeError, exportDefinition, previewImport, redactNodeType } from '../src/workflow/exchange.ts';
import { nextRequestId } from './helpers/engine-harness.ts';
import { HUMAN, openWorkflowHarness, type WorkflowHarness } from './helpers/workflow-harness.ts';

/**
 * Sharing definitions as JSON (M6b): export leaves secrets out and says so; import reads untrusted text, shows what it
 * would run and where it would go, and only lists the save commands (the person confirms, the app sends them).
 */

let h: WorkflowHarness;

afterEach(async () => {
  await h.close();
});

/** A script node type with an environment secret, a secret-looking param default and a write claim. */
function buildType(version = 1, program = 'tools/build.cmd'): NodeTypeDefinition {
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'nodeType',
    id: 'myteam.build',
    version,
    name: 'Build',
    content: {
      type: 'myteam.build',
      version,
      label: 'Build',
      completion: 'script',
      inputs: [{ name: 'in', label: 'Input' }],
      outputs: [
        { name: 'done', label: 'Built' },
        { name: 'error', label: 'Failed' },
      ],
      params: [
        { name: 'target', label: 'Target', schema: { type: 'string', default: 'Editor' } },
        { name: 'apiToken', label: 'Token', schema: { type: 'string', default: 'tok-123' } },
      ],
      claims: [{ path: 'Build/**', mode: 'exclusive' }],
      script: { program, args: ['--target', '{{ params.target }}'], cwd: 'Build', env: { BUILD_TOKEN: 'tok-456', MODE: 'ci' } },
    },
  };
}

function buildTemplate(typeVersion = 1): TemplateDefinition {
  return {
    vuyro: 'export',
    formatVersion: 1,
    kind: 'template',
    id: 'myteam/build',
    version: 1,
    name: 'Build flow',
    content: {
      id: 'myteam/build',
      version: 1,
      name: 'Build flow',
      nodes: [
        { id: 'build', type: 'myteam.build', version: typeVersion, label: 'Build it', params: { target: 'Game', apiToken: 'secret-in-template' } },
        { id: 'end', type: 'vuyro.end', version: 1 },
      ],
      edges: [{ from: { node: 'build', port: 'done' }, to: { node: 'end', port: 'in' } }],
      settings: { workspaceMode: 'shared' },
    },
  };
}

async function save(definition: NodeTypeDefinition | TemplateDefinition): Promise<void> {
  const response = await h.writer.save(definition, HUMAN, nextRequestId());
  if (!response.ok) throw new Error(JSON.stringify(response.error));
}

const preview = (text: string, choices?: Record<string, ImportChoice>): Promise<ImportPreview> => previewImport(h.registry, text, choices);
const json = (value: unknown) => JSON.stringify(value);

describe('export', () => {
  it('leaves script environment values and secret-looking param values out, says where, and checksums the result', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    await save(buildType());
    await save(buildTemplate());
    const type = await exportDefinition(h.registry, { kind: 'nodeType', id: 'myteam.build' });
    const document = type.document as NodeTypeDefinition;
    expect(document.content.script?.env).toBeUndefined();
    expect(document.content.params.find((param) => param.name === 'apiToken')?.schema).toEqual({ type: 'string' });
    expect(document.content.params.find((param) => param.name === 'target')?.schema.default).toBe('Editor');
    expect(document.requires?.credentials).toEqual(['env:BUILD_TOKEN', 'env:MODE', 'param:apiToken']);
    expect(type.redacted.map((field) => field.path)).toEqual(['/content/script/env/BUILD_TOKEN', '/content/script/env/MODE', '/content/params/1/schema/default']);
    expect(document.checksum).toBe(definitionHash(document));
    expect(json(document)).not.toMatch(/tok-123|tok-456/);
    expect(type.fileName).toBe('myteam.build@1.json');

    const bundle = (await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build' })).document as ExportBundle;
    expect(bundle.kind).toBe('bundle');
    expect(bundle.embedded.map((each) => `${each.id}@${each.version}`)).toEqual(['myteam.build@1', 'vuyro.end@1']);
    expect(bundle.requires?.nodeTypes).toEqual({ 'myteam.build': 1, 'vuyro.end': 1 });
    expect(bundle.requires?.credentials).toEqual(['param:build.apiToken', 'env:BUILD_TOKEN', 'env:MODE', 'param:apiToken']);
    expect(bundle.checksum).toBe(bundleHash(bundle));
    expect(bundle.content.checksum).toBe(definitionHash(bundle.content));
    expect(bundle.content.requires?.credentials).toEqual(['param:build.apiToken']);
    expect(json(bundle)).not.toMatch(/tok-123|tok-456|secret-in-template/);
    for (const embedded of bundle.embedded) expect(embedded.checksum).toBe(definitionHash(embedded));

    const plain = (await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build', embedNodeTypes: false })).document as TemplateDefinition;
    expect(plain.kind).toBe('template');
    expect(plain.checksum).toBe(definitionHash(plain));
  });

  it('exports the default template unchanged apart from its requirements', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const { document, redacted } = await exportDefinition(h.registry, { kind: 'template', id: 'vuyro/ai-sdlc' });
    expect(redacted).toEqual([]);
    expect((document as ExportBundle).embedded).toHaveLength(6);
    // The template inside is the definition file's content, so it is the same version here.
    const installed = await h.registry.activeDefinition('template', 'vuyro/ai-sdlc');
    expect(definitionHash((document as ExportBundle).content)).toBe(installed?.row.hash);
  });

  it('refuses what is not active, and a definition whose file changed', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    await expect(exportDefinition(h.registry, { kind: 'template', id: 'myteam/none' })).rejects.toMatchObject({ code: 'not_found' });
    await save(buildType());
    writeFileSync(definitionPath(h.registry.root, 'nodeType', 'myteam.build', 1), json({ ...buildType(), name: 'Edited on disk' }));
    const failure = exportDefinition(h.registry, { kind: 'nodeType', id: 'myteam.build' });
    await expect(failure).rejects.toBeInstanceOf(ExchangeError);
    await expect(failure).rejects.toMatchObject({ code: 'invariant_violated' });
  });

  it('a node type without secrets comes out the same', () => {
    const plain: NodeTypeDefinition = { ...buildType(), content: { ...buildType().content, params: [], script: { program: 'x' } } };
    expect(redactNodeType(plain)).toEqual({ definition: plain, redacted: [] });
  });
});

describe('import preview', () => {
  it('refuses text that is not a Vuyro export, other format versions, permission presets and unknown kinds', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    expect(await preview('{not json')).toMatchObject({ readable: false, canSave: false, saves: [] });
    expect((await preview('{not json')).problems[0]).toMatch(/^JSON으로 읽을 수 없습니다/);
    expect((await preview(json({ kind: 'template' }))).problems).toEqual(['Vuyro 내보내기 파일이 아닙니다("vuyro": "export"가 없습니다).']);
    expect((await preview(json([1, 2]))).readable).toBe(false);
    expect((await preview(json({ ...buildType(), formatVersion: 2 }))).problems[0]).toMatch(/formatVersion 2/);
    const permissions = await preview(json({ vuyro: 'export', formatVersion: 1, kind: 'permissionPreset', id: 'myteam/ai', version: 1, name: 'AI may do anything', content: { rules: [{ command: 'permission.edit', decision: 'allow' }] } }));
    expect(permissions).toMatchObject({ readable: false, canSave: false, saves: [] });
    expect(permissions.problems[0]).toMatch(/권한 규칙은 파일로 가져올 수 없습니다/);
    expect((await preview(json({ ...buildType(), kind: 'blackboardSpec' }))).problems[0]).toMatch(/'blackboardSpec' 종류는 가져올 수 없습니다/);
  });

  it('refuses a definition with fields the engine does not know (a permission rule cannot ride along)', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const smuggled = { ...buildType(), content: { ...buildType().content, permissions: [{ command: 'permission.edit', decision: 'allow' }] } };
    const result = await preview(json(smuggled));
    expect(result.readable).toBe(false);
    expect(result.problems[0]).toBe('파일의 형식이 맞지 않습니다.');
    expect(result.problems.join('\n')).toMatch(/content/);
  });

  it('a wrong checksum blocks the import', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const type = { ...buildType(), checksum: definitionHash(buildType()) };
    expect((await preview(json(type))).canSave).toBe(true);
    const tampered = { ...type, content: { ...type.content, script: { program: 'evil.exe' } } };
    const result = await preview(json(tampered));
    expect(result.canSave).toBe(false);
    expect(result.problems).toEqual(['노드 타입의 체크섬이 내용과 맞지 않습니다. 파일이 바뀌었거나 손상되었습니다.']);
    // In a bundle, each embedded definition and the bundle itself are checked.
    await save(buildType());
    await save(buildTemplate());
    const bundle = (await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build' })).document as ExportBundle;
    const swapped = { ...bundle, embedded: bundle.embedded.map((each) => (each.id === 'myteam.build' ? { ...each, content: { ...each.content, script: { program: 'evil.exe' } } } : each)) };
    const problems = (await preview(json(swapped))).problems;
    expect(problems).toContain('묶음의 체크섬이 내용과 맞지 않습니다. 파일이 바뀌었거나 손상되었습니다.');
    expect(problems).toContain('노드 타입 myteam.build@1의 체크섬이 내용과 맞지 않습니다. 파일이 바뀌었거나 손상되었습니다.');
  });

  it('shows what each node runs: script program, arguments, folder, environment names, claims, prompts and params', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const bundle: ExportBundle = {
      vuyro: 'export',
      formatVersion: 1,
      kind: 'bundle',
      id: 'myteam/build',
      version: 1,
      name: 'Build flow',
      content: { ...buildTemplate(), content: { ...buildTemplate().content, nodes: [...buildTemplate().content.nodes, { id: 'review', type: 'vuyro.agent', version: 1, params: { instructions: 'Check the build log' } }] } },
      embedded: [buildType()],
    };
    const result = await preview(json(bundle));
    const template = result.items.find((item) => item.kind === 'template');
    const build = template?.execution.find((node) => node.nodeId === 'build');
    expect(build).toMatchObject({
      label: 'Build it',
      completion: 'script',
      script: { program: 'tools/build.cmd', args: ['--target', '{{ params.target }}'], cwd: 'Build', env: ['BUILD_TOKEN', 'MODE'] },
      claims: [{ path: 'Build/**', mode: 'exclusive' }],
      params: [
        { name: 'target', value: { text: 'Game', length: 4 } },
        { name: 'apiToken', value: { text: 'secret-in-template', length: 18 } },
      ],
    });
    const review = template?.execution.find((node) => node.nodeId === 'review');
    expect(review?.completion).toBe('agent');
    expect(review?.prompt?.text).toMatch(/^\{\{ params\.instructions \}\}/);
    expect(review?.params).toEqual([{ name: 'instructions', value: { text: 'Check the build log', length: 19 } }]);
    expect(template?.settings).toEqual({ workspaceMode: 'shared' });
    // The template's graph as the canvas draws it, with the node types it would run with.
    expect(template?.workflow?.nodes.map((node) => [node.id, node.completion])).toEqual([
      ['build', 'script'],
      ['end', 'join'],
      ['review', 'agent'],
    ]);
    expect(result.items.find((item) => item.kind === 'nodeType')?.execution[0]?.script?.program).toBe('tools/build.cmd');
    expect(result.dependencies).toEqual([
      { type: 'myteam.build', version: 1, status: 'file' },
      { type: 'vuyro.end', version: 1, status: 'installed' },
      { type: 'vuyro.agent', version: 1, status: 'installed' },
    ]);
    expect(result.saves.map((each) => each.type)).toEqual(['nodeType.save', 'template.save']);
    expect(result.canSave).toBe(true);
  });

  it('the exported default template comes back as already there; a new id saves a copy that tickets can use', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const exported = await exportDefinition(h.registry, { kind: 'template', id: 'vuyro/ai-sdlc' });
    const text = json(exported.document);
    const same = await preview(text);
    expect(same.items.map((item) => [item.key, item.state, item.action])).toContainEqual(['template:vuyro/ai-sdlc@1', 'same', 'skip']);
    expect(same.items.every((item) => item.state === 'same' && item.action === 'skip')).toBe(true);
    expect(same).toMatchObject({ saves: [], canSave: false, problems: [] });

    const copy = await preview(text, { 'template:vuyro/ai-sdlc@1': { action: 'newId', id: 'myteam/ai-sdlc', name: 'AI-Native SDLC (우리 팀)' } });
    expect(copy.canSave).toBe(true);
    expect(copy.items.find((item) => item.kind === 'template')?.target).toEqual({ id: 'myteam/ai-sdlc', version: 1, name: 'AI-Native SDLC (우리 팀)' });
    expect(copy.saves).toHaveLength(1);
    const definition = copy.saves[0]?.definition as TemplateDefinition;
    expect(definition).toMatchObject({ kind: 'template', id: 'myteam/ai-sdlc', version: 1, name: 'AI-Native SDLC (우리 팀)', content: { id: 'myteam/ai-sdlc', version: 1, name: 'AI-Native SDLC (우리 팀)' } });
    expect(definition.checksum).toBeUndefined();
    await save(definition);
    const { result: project } = await h.ok('project.create', { name: 'sample' });
    const ticket = await h.ok('ticket.create', { projectId: (project as { projectId: string }).projectId, title: 'Copy', template: { id: 'myteam/ai-sdlc' } });
    expect(ticket.ok).toBe(true);
    // Imported again, the copy is already there too.
    expect((await preview(text, { 'template:vuyro/ai-sdlc@1': { action: 'newId', id: 'myteam/ai-sdlc' } })).items.find((item) => item.kind === 'template')?.problems).toEqual([
      'myteam/ai-sdlc은(는) 이미 있는 id입니다. 다른 id를 적거나 덮어쓰기(새 버전)를 고르세요.',
    ]);
  });

  it('a version that exists with other content must be decided: new version (overwrite), new id or skip', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    await save(buildType(1, 'tools/old.cmd'));
    const bundle: ExportBundle = { vuyro: 'export', formatVersion: 1, kind: 'bundle', id: 'myteam/build', version: 1, name: 'Build flow', content: buildTemplate(), embedded: [buildType(1, 'tools/new.cmd')] };
    const text = json(bundle);

    const undecided = await preview(text);
    const type = undecided.items.find((item) => item.kind === 'nodeType');
    expect(type).toMatchObject({ state: 'conflict', action: 'skip', actions: ['newVersion', 'newId', 'skip'], existingVersions: [1] });
    expect(type?.problems[0]).toMatch(/다른 내용으로 이미 있습니다/);
    expect(undecided.canSave).toBe(false);

    // Skipped on purpose: the template runs the installed, different build; the preview shows that one's program.
    const skipped = await preview(text, { 'nodeType:myteam.build@1': { action: 'skip' } });
    expect(skipped.dependencies).toContainEqual({ type: 'myteam.build', version: 1, status: 'installedDifferent' });
    expect(skipped.items.find((item) => item.kind === 'template')?.execution.find((node) => node.nodeId === 'build')?.script?.program).toBe('tools/old.cmd');
    expect(skipped.saves.map((each) => each.type)).toEqual(['template.save']);
    expect(skipped.canSave).toBe(true);

    // Overwrite = the next free version; the template in the file follows it.
    const overwritten = await preview(text, { 'nodeType:myteam.build@1': { action: 'newVersion' } });
    expect(overwritten.items.find((item) => item.kind === 'nodeType')?.target).toEqual({ id: 'myteam.build', version: 2, name: 'Build' });
    expect(overwritten.dependencies).toContainEqual({ type: 'myteam.build', version: 1, status: 'file', savedAs: { type: 'myteam.build', version: 2 } });
    const [typeSave, templateSave] = overwritten.saves;
    expect(typeSave?.definition).toMatchObject({ id: 'myteam.build', version: 2, content: { type: 'myteam.build', version: 2 } });
    expect((templateSave?.definition as TemplateDefinition).content.nodes[0]).toMatchObject({ type: 'myteam.build', version: 2 });
    expect(overwritten.canSave).toBe(true);
    for (const each of overwritten.saves) await save(each.definition as NodeTypeDefinition | TemplateDefinition);
    expect((await h.registry.activeDefinition('nodeType', 'myteam.build'))?.row.version).toBe(2);

    // A new id renames the type and the template follows.
    const renamed = await preview(text, { 'nodeType:myteam.build@1': { action: 'newId', id: 'myteam.build-new' }, 'template:myteam/build@1': { action: 'newVersion' } });
    expect(renamed.saves[0]?.definition).toMatchObject({ id: 'myteam.build-new', content: { type: 'myteam.build-new', version: 1 } });
    expect((renamed.saves[1]?.definition as TemplateDefinition).content.nodes[0]?.type).toBe('myteam.build-new');
  });

  it('reports missing node types, bad ids, actions an item does not offer and a mismatched envelope', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const missing = await preview(json(buildTemplate()));
    expect(missing.dependencies).toContainEqual({ type: 'myteam.build', version: 1, status: 'missing' });
    expect(missing.items[0]?.problems).toContain('노드 타입 myteam.build@1이(가) 파일에도 이 엔진에도 없습니다.');
    expect(missing.items[0]?.execution[0]?.completion).toBeUndefined();
    expect(missing.canSave).toBe(false);

    const badId = await preview(json(buildType()), { 'nodeType:myteam.build@1': { action: 'newId', id: 'Not A Type' } });
    expect(badId.items[0]?.problems).toEqual(['새 id를 적으세요(예: myteam.build).']);
    expect(badId.canSave).toBe(false);
    const notOffered = await preview(json(buildType()), { 'nodeType:myteam.build@1': { action: 'newVersion' } });
    expect(notOffered.items[0]?.problems).toEqual(["이 항목은 'newVersion'로 처리할 수 없습니다."]);
    expect(notOffered.canSave).toBe(false);

    const mismatched = await preview(json({ ...buildType(), version: 3 }));
    expect(mismatched.items[0]?.problems[0]).toMatch(/봉투의 id·버전\(myteam\.build@3\)과 내용의 id·버전\(myteam\.build@1\)이 다릅니다/);
    expect(mismatched.canSave).toBe(false);
  });

  it('checks a template against the node types it would run with before anything is saved', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const broken = buildTemplate();
    const edges = [{ from: { node: 'build', port: 'nope' }, to: { node: 'end', port: 'in' } }];
    const result = await preview(json({ vuyro: 'export', formatVersion: 1, kind: 'bundle', id: broken.id, version: 1, name: broken.name, content: { ...broken, content: { ...broken.content, edges } }, embedded: [buildType()] }));
    expect(result.items.find((item) => item.kind === 'template')?.problems.join('\n')).toMatch(/nope/);
    expect(result.canSave).toBe(false);
  });
});
