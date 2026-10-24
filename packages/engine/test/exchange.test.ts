import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExportBundle, ImportChoice, ImportPreview, NodeTypeDefinition, TemplateDefinition } from '@vuyro/contracts';
import { MemoryFileSystem } from '../src/runtime/fs.ts';
import { definitionHash, definitionPath } from '../src/workflow/definitions.ts';
import { bundleHash, ExchangeError, exportDefinition, previewImport, redactNodeType } from '../src/workflow/exchange.ts';
import { nextRequestId } from './helpers/engine-harness.ts';
import { HUMAN, openWorkflowHarness, SYSTEM, type WorkflowHarness } from './helpers/workflow-harness.ts';

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
  it('replaces script environment values and secret-looking param values with placeholders, says where, and checksums the result', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    await save(buildType());
    await save(buildTemplate());
    const type = await exportDefinition(h.registry, { kind: 'nodeType', id: 'myteam.build' });
    const document = type.document as NodeTypeDefinition;
    expect(document.content.script?.env).toEqual({ BUILD_TOKEN: '${secret:myteam.build.env.BUILD_TOKEN}', MODE: '${secret:myteam.build.env.MODE}' });
    expect(document.content.params.find((param) => param.name === 'apiToken')?.schema).toEqual({ type: 'string', default: '${secret:myteam.build.apiToken}' });
    expect(document.content.params.find((param) => param.name === 'target')?.schema.default).toBe('Editor');
    expect(document.requires?.credentials).toEqual(['myteam.build.apiToken', 'myteam.build.env.BUILD_TOKEN', 'myteam.build.env.MODE']);
    expect(type.redacted.map((field) => [field.path, field.reason])).toEqual([
      ['/content/params/1/schema/default', 'name'],
      ['/content/script/env/BUILD_TOKEN', 'env'],
      ['/content/script/env/MODE', 'env'],
    ]);
    expect(document.checksum).toBe(definitionHash(document));
    expect(json(document)).not.toMatch(/tok-123|tok-456/);
    expect(type.fileName).toBe('myteam.build@1.json');

    const bundle = (await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build' })).document as ExportBundle;
    expect(bundle.kind).toBe('bundle');
    expect(bundle.embedded.map((each) => `${each.id}@${each.version}`)).toEqual(['myteam.build@1', 'vuyro.end@1']);
    expect(bundle.requires?.nodeTypes).toEqual({ 'myteam.build': 1, 'vuyro.end': 1 });
    expect(bundle.requires?.credentials).toEqual(['build.apiToken', 'myteam.build.apiToken', 'myteam.build.env.BUILD_TOKEN', 'myteam.build.env.MODE']);
    expect(bundle.checksum).toBe(bundleHash(bundle));
    expect(bundle.content.checksum).toBe(definitionHash(bundle.content));
    expect(bundle.content.requires?.credentials).toEqual(['build.apiToken']);
    expect(bundle.content.content.nodes[0]?.params).toEqual({ target: 'Game', apiToken: '${secret:build.apiToken}' });
    expect(json(bundle)).not.toMatch(/tok-123|tok-456|secret-in-template/);
    for (const embedded of bundle.embedded) expect(embedded.checksum).toBe(definitionHash(embedded));

    const plain = (await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build', embedNodeTypes: false })).document as TemplateDefinition;
    expect(plain.kind).toBe('template');
    expect(plain.checksum).toBe(definitionHash(plain));
  });

  it('a param the node type declares secret always leaves, whatever its name; expression-only environment values stay', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const declared: NodeTypeDefinition = {
      ...buildType(),
      content: {
        ...buildType().content,
        params: [{ name: 'login', label: 'Login', secret: true, schema: { type: 'string', default: 'admin:hunter2' } }],
        script: { program: 'tools/deploy.cmd', env: { LOGIN: '{{ params.login }}' } },
      },
    };
    await save(declared);
    await save({ ...buildTemplate(), content: { ...buildTemplate().content, nodes: [{ id: 'build', type: 'myteam.build', version: 1, params: { login: 'ci:pass-word' } }, { id: 'end', type: 'vuyro.end', version: 1 }] } });
    const result = await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build' });
    const text = json(result.document);
    expect(text).not.toMatch(/hunter2|pass-word/);
    expect(result.redacted.map((field) => [field.label, field.reason])).toEqual([
      ['myteam/build@1 · 노드 build의 파라미터 login', 'declared'],
      ['myteam.build@1 · 파라미터 login의 기본값', 'declared'],
    ]);
    const embedded = (result.document as ExportBundle).embedded[0];
    expect(embedded?.content.script?.env).toEqual({ LOGIN: '{{ params.login }}' });
  });

  it('finds tokens and keys by their look in arguments, descriptions and nested values, and replaces them', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const github = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    const random = 'Zx9QvT3pL0mR7sYk2WnB8cJh5DfG1aUe';
    const looks: NodeTypeDefinition = {
      ...buildType(),
      content: {
        ...buildType().content,
        params: [{ name: 'target', label: 'Target', description: `Call the API with Authorization: Bearer abcdefghijklmnop123456 and sk-${'q'.repeat(24)}.`, schema: { type: 'string', default: 'Editor' } }],
        script: { program: 'tools/build.cmd', args: ['--token', github, `--aws=AKIAABCDEFGHIJKLMNOP`, `--slack=xoxb-123456789012-abc`] },
        extensions: { myteam: { deep: [{ key }], note: random, commit: '0123456789abcdef0123456789abcdef' } },
      },
    };
    await save(looks);
    const result = await exportDefinition(h.registry, { kind: 'nodeType', id: 'myteam.build' });
    const text = json(result.document);
    for (const secret of [github, 'MIIEow', random, 'abcdefghijklmnop123456', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-123456789012', `sk-${'q'.repeat(24)}`]) expect(text).not.toContain(secret);
    // A plain hex commit id is not taken for a secret; ordinary words and expressions stay.
    expect(text).toContain('0123456789abcdef0123456789abcdef');
    expect(text).toContain('Authorization: Bearer ${secret:');
    expect(result.redacted.every((field) => field.reason === 'pattern')).toBe(true);
    expect(result.redacted.map((field) => field.looksLike).sort()).toEqual(['API 키 (sk-)', 'AWS 액세스 키', 'Bearer 토큰', 'GitHub 토큰', 'Slack 토큰', '개인 키', '긴 무작위 문자열'].sort());
    expect(result.redacted.find((field) => field.looksLike === 'GitHub 토큰')).toMatchObject({ path: '/content/script/args/1', placeholder: '${secret:myteam.build.script.args.1}' });
    // The importer is told what to fill in, also from the text when the list was edited away.
    const imported = await preview(json({ ...(result.document as NodeTypeDefinition), requires: {}, checksum: undefined }));
    expect(imported.credentials).toContain('myteam.build.script.args.1');
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
    const plain: NodeTypeDefinition = { ...buildType(), content: { ...buildType().content, params: [], claims: [], script: { program: 'x', args: ['--target', '{{ params.target }}'] } } };
    expect(redactNodeType(plain)).toEqual({ definition: plain, redacted: [] });
  });
});

describe('import preview', () => {
  it('refuses text that is not a Vuyro export, other format versions, permission presets and unknown kinds', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    expect(await preview('{not json')).toMatchObject({ readable: false, canSave: false, saves: [] });
    expect((await preview('{not json')).problems[0]).toMatch(/^JSON으로 읽을 수 없습니다/);
    // M7b: a file saved by a Windows tool starts with a byte order mark; the same JSON still reads.
    expect(await preview(`\uFEFF${json(buildType())}`)).toMatchObject({ readable: true, problems: [] });
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
    expect(same.items.map((item) => [item.key, item.state, item.action])).toContainEqual(['template:vuyro/ai-sdlc@2', 'same', 'skip']);
    expect(same.items.every((item) => item.state === 'same' && item.action === 'skip')).toBe(true);
    expect(same).toMatchObject({ saves: [], canSave: false, problems: [] });

    const copy = await preview(text, { 'template:vuyro/ai-sdlc@2': { action: 'newId', id: 'myteam/ai-sdlc', name: 'AI-Native SDLC (우리 팀)' } });
    expect(copy.canSave).toBe(true);
    expect(copy.items.find((item) => item.kind === 'template')?.target).toEqual({ id: 'myteam/ai-sdlc', version: 2, name: 'AI-Native SDLC (우리 팀)' });
    expect(copy.saves).toHaveLength(1);
    const definition = copy.saves[0]?.definition as TemplateDefinition;
    expect(definition).toMatchObject({ kind: 'template', id: 'myteam/ai-sdlc', version: 2, name: 'AI-Native SDLC (우리 팀)', content: { id: 'myteam/ai-sdlc', version: 2, name: 'AI-Native SDLC (우리 팀)' } });
    expect(definition.checksum).toBeUndefined();
    await save(definition);
    const { result: project } = await h.ok('project.create', { name: 'sample' });
    const ticket = await h.ok('ticket.create', { projectId: (project as { projectId: string }).projectId, title: 'Copy', template: { id: 'myteam/ai-sdlc' } });
    expect(ticket.ok).toBe(true);
    // Imported again, the copy is already there too.
    expect((await preview(text, { 'template:vuyro/ai-sdlc@2': { action: 'newId', id: 'myteam/ai-sdlc' } })).items.find((item) => item.kind === 'template')?.problems).toEqual([
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

  it('checks a node type before anything is saved', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const twice = { ...buildType(), content: { ...buildType().content, outputs: [{ name: 'done', label: 'A' }, { name: 'done', label: 'B' }] } };
    const result = await preview(json(twice));
    expect(result.items[0]?.problems.join('\n')).toMatch(/duplicate name 'done'/);
    expect(result.canSave).toBe(false);
  });

  it('refuses a bundle that holds a definition twice or whose template is not the one it names', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const twice: ExportBundle = { vuyro: 'export', formatVersion: 1, kind: 'bundle', id: 'myteam/build', version: 1, name: 'Build flow', content: buildTemplate(), embedded: [buildType(), buildType()] };
    const doubled = await preview(json(twice));
    expect(doubled.problems).toEqual(['nodeType:myteam.build@1가 파일에 두 번 들어 있습니다.']);
    expect(doubled.canSave).toBe(false);
    const other = await preview(json({ ...twice, id: 'myteam/other', embedded: [buildType()] }));
    expect(other.problems).toEqual(['묶음의 id·버전과 안에 든 템플릿의 id·버전이 다릅니다.']);
    expect(other.canSave).toBe(false);
  });

  it('two items of the file cannot take the same new id', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const second = { ...buildType(), id: 'myteam.pack', name: 'Pack', content: { ...buildType().content, type: 'myteam.pack' } };
    const bundle: ExportBundle = { vuyro: 'export', formatVersion: 1, kind: 'bundle', id: 'myteam/build', version: 1, name: 'Build flow', content: buildTemplate(), embedded: [buildType(), second] };
    const result = await preview(json(bundle), {
      'nodeType:myteam.build@1': { action: 'newId', id: 'myteam.same' },
      'nodeType:myteam.pack@1': { action: 'newId', id: 'myteam.same' },
    });
    expect(result.items.find((item) => item.id === 'myteam.pack')?.problems).toEqual(['myteam.same을(를) 이 파일의 다른 항목도 쓰려고 합니다.']);
    expect(result.canSave).toBe(false);
  });
});

describe('saving an import (definition.import)', () => {
  async function settled(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const staged = await h.store.query("SELECT id FROM p_definitions WHERE status = 'staged'");
      if (staged.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('definitions never settled');
  }
  const status = async (id: string) => (await h.store.query<{ version: number; status: string }>('SELECT version, status FROM p_definitions WHERE id = ? ORDER BY version', [id])).map((row) => `${String(row.version)}:${row.status}`);
  const bundleOf = (types: NodeTypeDefinition[], template = buildTemplate()): ExportBundle => ({ vuyro: 'export', formatVersion: 1, kind: 'bundle', id: template.id, version: template.version, name: template.name, content: template, embedded: types });
  const items = (plan: ImportPreview) => plan.saves.map((each) => ({ definition: each.definition, ...(each.expect === undefined ? {} : { expect: each.expect }) }));

  it('saves a bundle in one command: the template is checked against node types of the same import', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const plan = await preview(json(bundleOf([buildType()])));
    expect(plan.canSave).toBe(true);
    expect(plan.saves.map((each) => each.expect)).toEqual(['newId', 'newId']);
    const saved = await h.ok('definition.import', { items: items(plan) }, HUMAN);
    expect((saved.result as { saved: { id: string; status: string }[] }).saved.map((each) => `${each.id}:${each.status}`)).toEqual(['myteam.build:staged', 'myteam/build:staged']);
    await settled();
    expect(await status('myteam.build')).toEqual(['1:active']);
    expect(await status('myteam/build')).toEqual(['1:active']);
  });

  it('all or nothing: one item the engine refuses leaves every other item unsaved', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const broken = { ...buildTemplate(), content: { ...buildTemplate().content, edges: [{ from: { node: 'build', port: 'nope' }, to: { node: 'end', port: 'in' } }] } };
    const response = await h.exec('definition.import', { items: [{ definition: buildType() }, { definition: broken }] }, HUMAN);
    expect(response).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await status('myteam.build')).toEqual([]);
    const twice = await h.exec('definition.import', { items: [{ definition: buildType() }, { definition: buildType() }] }, HUMAN);
    expect(twice).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await status('myteam.build')).toEqual([]);
    const tampered = await h.exec('definition.import', { items: [{ definition: { ...buildType(), checksum: definitionHash(buildTemplate()) } }] }, HUMAN);
    expect(tampered).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await status('myteam.build')).toEqual([]);
  });

  it('a change after the preview refuses the whole import (other content, a taken new id, a newer version)', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    // Preview: a brand-new node type and template; meanwhile someone saves the node type with other content.
    const fresh = await preview(json(bundleOf([buildType()])));
    await save(buildType(1, 'tools/other.cmd'));
    expect(await h.exec('definition.import', { items: items(fresh) }, HUMAN)).toMatchObject({ ok: false, error: { code: 'invariant_violated' } });
    expect(await status('myteam/build')).toEqual([]);

    // Preview: overwrite as a new version (v2); meanwhile a v3 appears, so v2 would not be the newest any more.
    const overwrite = await preview(json(bundleOf([buildType(1, 'tools/new.cmd')])), { 'nodeType:myteam.build@1': { action: 'newVersion' } });
    expect(overwrite.saves[0]).toMatchObject({ expect: 'newVersion', definition: { version: 2 } });
    await save(buildType(3, 'tools/someone-else.cmd'));
    expect(await h.exec('definition.import', { items: items(overwrite) }, HUMAN)).toMatchObject({ ok: false, error: { code: 'invariant_violated' } });
    expect(await status('myteam/build')).toEqual([]);

    // Preview: a new id; meanwhile that id is created.
    const renamed = await preview(json(bundleOf([buildType(1, 'tools/new.cmd')])), { 'nodeType:myteam.build@1': { action: 'newId', id: 'myteam.renamed' } });
    expect(renamed.saves[0]).toMatchObject({ expect: 'newId' });
    await save({ ...buildType(3), id: 'myteam.renamed', content: { ...buildType(3).content, type: 'myteam.renamed' } });
    expect(await h.exec('definition.import', { items: items(renamed) }, HUMAN)).toMatchObject({ ok: false, error: { code: 'invariant_violated' } });
    expect(await status('myteam/build')).toEqual([]);

    // Preview: a version the id does not have yet (v4, added as it is); meanwhile v4 appears with other content.
    const added = await preview(json(bundleOf([buildType(4, 'tools/four.cmd')], { ...buildTemplate(4), version: 1, content: { ...buildTemplate(4).content, version: 1 } })));
    expect(added.saves[0]).toMatchObject({ definition: { version: 4 } });
    expect(added.saves[0]?.expect).toBeUndefined();
    await save(buildType(4, 'tools/someone-else-four.cmd'));
    expect(await h.exec('definition.import', { items: items(added) }, HUMAN)).toMatchObject({ ok: false, error: { code: 'invariant_violated' } });
    expect(await status('myteam/build')).toEqual([]);
  });

  it("a new id that is another item's id in the file cannot be saved, and new versions skip the file's own versions", async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const pack = { ...buildType(), id: 'myteam.pack', name: 'Pack', content: { ...buildType().content, type: 'myteam.pack' } };
    const clash = await preview(json(bundleOf([buildType(), pack])), { 'nodeType:myteam.build@1': { action: 'newId', id: 'myteam.pack' } });
    expect(clash.items.find((item) => item.id === 'myteam.build')?.problems).toEqual(['myteam.pack을(를) 이 파일의 다른 항목도 쓰려고 합니다.']);
    expect(clash.canSave).toBe(false);
    await save(buildType(1, 'tools/old.cmd'));
    const versions = await preview(json(bundleOf([buildType(1, 'tools/new.cmd'), buildType(2, 'tools/two.cmd')])), { 'nodeType:myteam.build@1': { action: 'newVersion' } });
    expect(versions.items.filter((item) => item.kind === 'nodeType').map((item) => item.target?.version)).toEqual([3, 2]);
    expect(versions.items.every((item) => item.problems.length === 0)).toBe(true);
  });

  it('a node type whose file cannot be written takes the template of its import with it', async () => {
    const fs = new MemoryFileSystem();
    h = await openWorkflowHarness({ noEngine: true, fs });
    fs.failNext('rename', `${definitionPath(h.registry.root, 'nodeType', 'myteam.build', 1)}.tmp`);
    const plan = await preview(json(bundleOf([buildType()])));
    expect((await h.exec('definition.import', { items: items(plan) }, HUMAN)).ok).toBe(true);
    await settled();
    expect(await status('myteam.build')).toEqual(['1:abandoned']);
    expect(await status('myteam/build')).toEqual(['1:abandoned']);
    expect(await h.store.queryOne("SELECT reason FROM p_definitions WHERE id = 'myteam/build'")).toMatchObject({ reason: expect.stringMatching(/write failed for nodeType myteam\.build@1/) as string });
  });
});

describe('secrets in envelopes (M6b re-review)', () => {
  const github = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const slack = 'xoxb-123456789012-abcdef';

  it('scans the whole exported document: envelope name, description, author and requires, also of embedded node types', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    await save({ ...buildType(), description: `Uses ${github} to pull`, author: `ops ${slack}`, requires: { plugins: { p4: `token ${github}` } } });
    await save({ ...buildTemplate(), name: `Build flow ${slack}`, description: `Deploy key: ${github}` });
    const result = await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build' });
    const text = json(result.document);
    expect(text).not.toContain(github);
    expect(text).not.toContain(slack);
    const bundle = result.document as ExportBundle;
    // The bundle repeats the scrubbed name and description, not the originals.
    expect(bundle.name).toBe(bundle.content.name);
    expect(bundle.description).toBe(bundle.content.description);
    expect(bundle.name).toMatch(/^Build flow \$\{secret:/);
    expect(result.redacted.filter((field) => field.reason === 'pattern').map((field) => field.path).sort()).toEqual(
      ['/content/name', '/content/description', '/embedded/0/description', '/embedded/0/author', '/embedded/0/requires/plugins/p4'].sort(),
    );
    expect(bundle.checksum).toBe(bundleHash(bundle));
    for (const embedded of bundle.embedded) expect(embedded.checksum).toBe(definitionHash(embedded));

    const alone = await exportDefinition(h.registry, { kind: 'nodeType', id: 'myteam.build' });
    expect(json(alone.document)).not.toContain(github);
    expect(alone.redacted.filter((field) => field.reason === 'pattern').map((field) => field.path).sort()).toEqual(['/author', '/description', '/requires/plugins/p4']);
    const plain = await exportDefinition(h.registry, { kind: 'template', id: 'myteam/build', embedNodeTypes: false });
    expect(plain.redacted.filter((field) => field.reason === 'pattern').map((field) => field.path).sort()).toEqual(['/description', '/name']);
  });

  it('refuses to export when a secret-looking value sits where it cannot be replaced (an id)', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    const id = 'myteam/Zx9QvT3pL0mR7sYk2WnB8cJh5DfG1aUe';
    await save(buildType());
    await save({ ...buildTemplate(), id, content: { ...buildTemplate().content, id } });
    const failure = exportDefinition(h.registry, { kind: 'template', id, embedNodeTypes: false });
    await expect(failure).rejects.toMatchObject({ code: 'invariant_violated' });
    await expect(failure).rejects.toThrow(/\/id: 긴 무작위 문자열/);
  });
});

describe('writing an import: every file first, then one activation (M6b re-review)', () => {
  const typeNamed = (id: string): NodeTypeDefinition => ({ ...buildType(), id, name: id, content: { ...buildType().content, type: id } });
  const three = (): ExportBundle => {
    const template: TemplateDefinition = {
      ...buildTemplate(),
      content: {
        ...buildTemplate().content,
        nodes: [
          { id: 'a', type: 'myteam.one', version: 1 },
          { id: 'b', type: 'myteam.two', version: 1 },
          { id: 'c', type: 'myteam.three', version: 1 },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        edges: [
          { from: { node: 'a', port: 'done' }, to: { node: 'b', port: 'in' } },
          { from: { node: 'b', port: 'done' }, to: { node: 'c', port: 'in' } },
          { from: { node: 'c', port: 'done' }, to: { node: 'end', port: 'in' } },
        ],
      },
    };
    return { vuyro: 'export', formatVersion: 1, kind: 'bundle', id: template.id, version: 1, name: template.name, content: template, embedded: [typeNamed('myteam.one'), typeNamed('myteam.two'), typeNamed('myteam.three')] };
  };
  const ids = ['myteam.one', 'myteam.two', 'myteam.three', 'myteam/build'];
  const statuses = async () => {
    const rows = await h.store.query<{ id: string; status: string }>("SELECT id, status FROM p_definitions WHERE id LIKE 'myteam%' ORDER BY id");
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
  };
  async function settled(): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await h.store.query("SELECT id FROM p_definitions WHERE status = 'staged'")).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('definitions never settled');
  }
  const importAll = async () => {
    const plan = await preview(json(three()));
    expect(plan.canSave).toBe(true);
    const response = await h.exec('definition.import', { items: plan.saves.map((each) => ({ definition: each.definition, ...(each.expect === undefined ? {} : { expect: each.expect }) })) }, HUMAN);
    expect(response.ok).toBe(true);
  };
  const path = (kind: 'nodeType' | 'template', id: string) => definitionPath(h.registry.root, kind, id, 1);

  for (const [what, kind, id] of [
    ['the second node type', 'nodeType', 'myteam.two'],
    ['the last item (the template)', 'template', 'myteam/build'],
  ] as const) {
    it(`a file that cannot be written (${what}) leaves nothing active and removes the files already written`, async () => {
      const fs = new MemoryFileSystem();
      h = await openWorkflowHarness({ noEngine: true, fs });
      fs.failNext('rename', `${path(kind, id)}.tmp`);
      await importAll();
      await settled();
      expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'abandoned'])));
      for (const each of ['myteam.one', 'myteam.two', 'myteam.three']) expect(await fs.exists(path('nodeType', each))).toBe(false);
      expect(await fs.exists(path('template', 'myteam/build'))).toBe(false);
      // Nothing of it can be used, and the same import can be tried again.
      const { result: project } = await h.ok('project.create', { name: 'sample' });
      expect((await h.exec('ticket.create', { projectId: (project as { projectId: string }).projectId, title: 'x', template: { id: 'myteam/build' } }, HUMAN)).ok).toBe(false);
      await importAll();
      await settled();
      expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'active'])));
    });
  }

  it('activation is one commit: a file that does not match refuses all of them', async () => {
    const fs = new MemoryFileSystem();
    h = await openWorkflowHarness({ noEngine: true, fs });
    h.writer.stop();
    await importAll();
    const bundle = three();
    const keys = [...bundle.embedded, bundle.content].map((definition) => ({ kind: definition.kind, id: definition.id, version: 1, hash: definitionHash(definition) }));
    for (const definition of bundle.embedded) {
      await fs.mkdir(dirname(path('nodeType', definition.id)), { recursive: true });
      await fs.writeFile(path('nodeType', definition.id), JSON.stringify(definition.id === 'myteam.three' ? { ...definition, name: 'changed' } : definition));
    }
    await fs.mkdir(dirname(path('template', 'myteam/build')), { recursive: true });
    await fs.writeFile(path('template', 'myteam/build'), JSON.stringify(bundle.content));
    const refused = await h.exec('definition.activateMany', { items: keys }, SYSTEM);
    expect(refused).toMatchObject({ ok: false, error: { code: 'invariant_violated' } });
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'staged'])));
    // With every file right, all become active together; people and agents may not activate.
    await fs.writeFile(path('nodeType', 'myteam.three'), JSON.stringify(bundle.embedded[2]));
    expect((await h.exec('definition.activateMany', { items: keys }, HUMAN)).ok).toBe(false);
    expect((await h.exec('definition.activateMany', { items: keys }, SYSTEM)).ok).toBe(true);
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'active'])));
  });

  it('an import staged before a crash is finished together on the next start', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    h.writer.stop();
    await importAll();
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'staged'])));
    await h.restart({ noEngine: true });
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'active'])));
  });

  it('a failed group is dropped in one commit', async () => {
    const fs = new MemoryFileSystem();
    h = await openWorkflowHarness({ noEngine: true, fs });
    fs.failNext('rename', `${path('nodeType', 'myteam.three')}.tmp`);
    await importAll();
    await settled();
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'abandoned'])));
    const drops = await h.store.query<{ request_id: string; type: string }>("SELECT DISTINCT request_id, type FROM events WHERE type = 'definition.abandoned' AND aggregate_id LIKE 'def:%myteam%'");
    expect(drops).toHaveLength(1);
    expect(drops[0]?.request_id).toMatch(/^def-abandon-many-/);
  });

  it('stopping while a group is being dropped: the next start drops the rest instead of activating it', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    h.writer.stop();
    await importAll();
    // An engine that dropped the members one at a time stopped after the first one (the template, which nothing else
    // needs: the node types alone would pass every activation check).
    const template = three().content;
    expect((await h.exec('definition.abandon', { kind: 'template', id: template.id, version: 1, hash: definitionHash(template), reason: 'write failed' }, SYSTEM)).ok).toBe(true);
    expect(await statuses()).toEqual({ 'myteam.one': 'staged', 'myteam.two': 'staged', 'myteam.three': 'staged', 'myteam/build': 'abandoned' });
    await h.restart({ noEngine: true });
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'abandoned'])));
    expect(await h.registry.fileHash('nodeType', 'myteam.one', 1)).toBeUndefined();
    expect(await h.registry.fileHash('template', 'myteam/build', 1)).toBeUndefined();
  });

  it('dropping a group: only staged versions, only by the engine, unknown versions refused', async () => {
    h = await openWorkflowHarness({ noEngine: true });
    h.writer.stop();
    await importAll();
    const bundle = three();
    const keys = [...bundle.embedded, bundle.content].map((definition) => ({ kind: definition.kind, id: definition.id, version: 1, hash: definitionHash(definition) }));
    expect((await h.exec('definition.abandonMany', { items: keys, reason: 'x' }, HUMAN)).ok).toBe(false);
    expect(await h.exec('definition.abandonMany', { items: [{ ...keys[0], hash: definitionHash(buildTemplate()) }], reason: 'x' }, SYSTEM)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'staged'])));
    expect((await h.exec('definition.abandonMany', { items: keys, reason: 'x' }, SYSTEM)).ok).toBe(true);
    expect(await statuses()).toEqual(Object.fromEntries(ids.map((each) => [each, 'abandoned'])));
    // Again: nothing left to drop, nothing recorded.
    const before = await h.store.lastSequence();
    expect((await h.exec('definition.abandonMany', { items: keys, reason: 'x' }, SYSTEM)).ok).toBe(true);
    expect(await h.store.lastSequence()).toBe(before);
  });
});
