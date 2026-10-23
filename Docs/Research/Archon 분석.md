---
tags: [research, competitor, archon]
분석일: 2026-10-23
대상버전: Archon 0.12.1 (2026-10-17)
커밋: d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae
저장소: https://github.com/coleam00/Archon
라이선스: MIT
---

# Archon 상세 분석 (Vuyro 개발 참고용)

> 이 문서는 Vuyro를 개발할 때 **가져다 쓸 설계**와 **피할 설계**를 찾아보기 위한 것이다.
> 소스 코드(`dev` 브랜치, 위 커밋)를 직접 읽고 정리했다. 코드는 실행하지 않았다.
> 경로는 저장소 루트 기준이다. 링크는 맨 아래 [[#15. 참고 파일 링크]]에 모아 두었다.

## 0. 요약

- **Archon은 "YAML DAG로 코딩 에이전트를 돌리는 자동화 엔진"이다.** 스스로를 *"factory builder"*, *"governed agentic automation engine"* 이라고 부른다.
- **대상 사용자는 개발자와 메인테이너다.** CLI가 먼저이고, 웹 콘솔은 *"레퍼런스 구현"* 이며, 비주얼 빌더는 *"실험"* 이다.
- **엔진의 완성도는 매우 높다.**
  - 사람 승인, 루프, 병렬 실행, 재개, 실패 분류, 비용 상한, 플러그인 배포, 이벤트 소싱이 모두 계약과 테스트로 정리되어 있다.
- **Vuyro와 겹치는 부분:** 그래프 워크플로, 사람 승인 게이트, 반려 루프, Claude/Codex 실행, 플러그인.
- **Vuyro가 들어갈 자리:**
  - 티켓 중심 수명주기
  - 저장소 밖 산출물 추적 (Perforce, Confluence, 문서)
  - 상위 노드 재오픈과 Stale 전파
  - 비개발자용 데스크톱 UX
  - 노드 타입 자체를 확장하는 플러그인

## 1. 앞선 대화에서 정정할 내용

| 이전에 알고 있던 것 | 실제 |
|---|---|
| "0.8에 비주얼 빌더 추가" | 틀렸다. 1세대 빌더(React Flow)는 **0.2.7 (2026-02-26)**. 재작성판 "Archon Studio"는 0.5.0 데이터 모델, 0.6.0 프리뷰, **0.7.0 실제 저장 연결**, 0.12.0 서식 보존 저장 순으로 들어왔다. 0.8.0에는 UI 변경이 없다. |
| "Viewer 같은 앱이 아니다" | 절반만 맞다. 웹 콘솔(`archon serve`)이 있고, 런 목록, 런 상세(Log / Graph / Artifacts), 인라인 승인, 프로젝트 채팅, 설정, 실험 빌더까지 있다. 다만 **데스크톱 앱, 티켓 보드, 기획자용 UX는 없다.** |
| README만 보고 "그래프 화면 없음" | 런 그래프 뷰가 있다. 읽기 전용 모니터링 화면이다. |

## 2. 제품 포지셔닝 (`README.md`, `.archon/direction.md`)

**스스로 정의한 것 (IS)**
- 핵심 문구:
  - *"Take yourself out of the loop and sit on top of it… a run comes to you only when it needs a decision you own."*
  - *"Human on the loop, not in it."*
- 성격: 설치마다 단일 테넌트, self-hosted, 항상 켜진 자동화(트리거, 스케줄), worktree 격리 기본.
- 대표 사례는 SDLC pack이다. issue → intake → build queue → merge queue로 이어지고, 머지 PR 524개 중 363개를 Archon 런이 빌드했다고 밝힌다.

**스스로 하지 않겠다고 한 것 (NOT)**
- 범용 채팅 UI가 아니다.
- 호스팅 서비스가 아니다.
- **정책의 주인이 아니다.** 누가 답하는지, 라우팅, 우선순위, 에스컬레이션을 엔진이 정하지 않는다.
- 프로그래밍 언어가 아니다. YAML은 조율 언어다.

**장기 방향 (direction.md §standalone-core)**
- 엔진은 SDK로 독립시킨다.
- 서버, UI, DB, 프로바이더, 어댑터는 전부 선택적 플러그인으로 만든다.
- 기본 영속성은 append-only JSONL로 둔다.

**UI에 대한 공식 입장**
- *"The current visual builder is an experiment, not a committed product shape… A smaller path may be an agent editing workflow YAML while the UI renders the resulting DAG."*
- 즉 Archon도 "빌더냐, 에이전트가 YAML을 쓰고 UI는 그래프만 그리느냐"를 아직 정하지 못했다.

## 3. 아키텍처 개요

**기술 스택**
- Bun과 strict TypeScript 모노레포다.
- 스키마는 전부 zod로 정의한다.
- 서버는 Hono와 `@hono/zod-openapi`를 쓰고, 웹은 생성된 API 타입만 쓴다.
- DB는 SQLite(`~/.archon/archon.db`)가 기본이고, PostgreSQL이나 파일 스토어(JSONL)를 대신 쓸 수 있다.
- 배포는 Bun compile 단일 바이너리(Windows `.exe` 포함), Homebrew, Docker로 한다.

**패키지 레이어** (CI에서 `scripts/check-package-edges.ts`로 import 방향을 강제)
```
paths, provider-contract                (leaf)
  → chat-contract, plugin-manifest, git, forge
  → providers        (Claude/Codex/Pi SDK는 여기에만 있음)
  → workflows        (엔진. core/server를 import하지 못하고 WorkflowDeps로 주입받음)
  → isolation
  → core             (DB, 대화, 오케스트레이터, credentials)
  → adapters
  → server / cli / web   (host)
```

**프로세스 모델**
- CLI와 서버가 둘 다 host가 될 수 있다.
  - `archon workflow run`은 CLI 프로세스 안에서 엔진을 돌린다(`InProcessWorkflowEngine`).
  - `--detach`를 주면 분리된 자식 프로세스가 run owner가 된다.
  - `archon serve`는 HTTP API, SSE, 웹훅, 채팅 플러그인 host, 트리거, 스케줄러를 겸한다.
  - 같은 머신의 CLI는 `~/.archon/server.json`으로 실행 중인 서버를 찾는다.
- 하나의 run은 이런 단계를 거친다: run owner → provider 플러그인 프로세스 → Claude Agent SDK → Claude Code 네이티브 바이너리.

> **Vuyro 시사점:** "엔진 = 라이브러리, 앱/CLI = host" 구조를 처음부터 잡으면 데스크톱 앱과 헤드리스 CLI(`vuyro`)가 같은 엔진을 공유할 수 있다. 엔진이 UI를 import하지 못하게 lint로 막는 것도 그대로 가져올 만하다.

## 4. 워크플로 언어

정식 레퍼런스는 `packages/docs-web/src/content/docs/reference/workflow-language.md`다(약 3,000줄).

### 4.1 최상위 필드
- **필수:** `name`, `description`, `nodes`.
  - `description`은 채팅 에이전트가 워크플로를 고를 때 읽는다. 그래서 "언제 쓰고 언제 쓰지 말지"까지 적게 되어 있다.
- **기본값:** `provider`, `model`, `effort`, `sandbox` 등.
- **run이 소유하는 설정:** `worktree`, `container`, `budget`(`max_work_units`, `max_spend_usd`), `requires`.
- **시그니처:** `inputs`, `returns`, `outcome_field`.

### 4.2 노드 타입 (노드 하나당 하나씩, 서로 배타)
| 키 | 의미 |
|---|---|
| `prompt` | 인라인 AI 프롬프트 |
| `command` | `.md` 커맨드 파일을 프롬프트로 사용. `with:`로 입력 바인딩 |
| `bash` | 셸 스크립트. stdout이 `$id.output`. `timeout` 지원 |
| `script` | bun(TS/JS) 또는 uv(Python). `runtime`, `deps` |
| `loop` | 단일 프롬프트 반복 (`until` / `until_bash` / `until_field`, `max_iterations` 필수) |
| `loop_group` | 여러 노드로 된 sub-DAG 본문을 반복 |
| `wait` | durable pause: 시간 / 조건 / 이벤트 / **attention**(사람 응답 폼) |
| `cancel` | 사유와 함께 run 종료 |
| `include` | 다른 워크플로를 **로드 시점에** 인라인 |
| `workflow` | 별도 child run으로 실행 (자체 기록, 비용, 감사 추적) |

- 모든 노드에 공통으로 붙는 필드: `id`, `depends_on`, `when`, `trigger_rule`, `context`(fresh / shared / resume), `retry`, `always_run`, `output_type`.
- AI 노드 옵션: `output_format`(JSON Schema), `allowed_tools`/`denied_tools`, `mcp`, `skills`, `systemPrompt`, `maxBudgetUsd` 등.
- `approval:` 노드는 deprecated다. 지금은 `wait: { attention, form: approval }`로 쓴다.

### 4.3 DAG 의미론
- **실행 순서:** Kahn 알고리즘으로 정렬하고, 같은 layer는 병렬로 실행한다. cycle은 로드 에러다.
- **`trigger_rule`:** 기본값은 `all_success`이고, `one_success`, `none_failed_min_one_success`, `all_done`도 쓸 수 있다.
  - skip은 원인(upstream_failed, condition, timeout 등)과 함께 하류로 전파된다.
- **fan-out join은 기본값이 `all_done`이다.** 일반 의존과 다르게 둔 이유가 문서에 있다:
  - *"Upstream dependencies are steps you chose to sequence; fan-out children are N instances of one step."*
  - 실패한 자식의 결과는 `{archon_failed:true}` 형태의 데이터로 슬롯에 들어간다.
- **`when:` 조건식은 일부러 빈약하게 만들었다.**
  - 연산자는 `== != > >= < <=`와 `&&`/`||`뿐이고 괄호가 없다.
  - 복잡한 판단은 script 노드가 계산하고, 그 결과 boolean을 조건으로 쓴다.
  - 스키마 없는 AI 출력 전체를 문자열과 비교하면 로드 에러다. 조용히 skip되는 사고를 막기 위해서다.
- **출력 전달**
  - `$node.output`은 텍스트 치환이고, `$node.output.field`는 스키마로 검증된 필드 접근이다.
  - 스키마에 선언하지 않은 필드를 참조하면 validate 단계에서 실패한다.
  - `with:` 바인딩은 타입을 보존하고, `{ from, if_skipped }`로 skip된 분기의 기본값을 준다.

**실제 예시 (최소 형태)**
```yaml
name: fix-issue
nodes:
  - id: investigate
    command: investigate-issue
  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

### 4.4 재사용
- **`include:`와 `workflow:`는 쓰는 상황이 다르다.**
  - `include:`는 로드 시점에 인라인한다. 노드 id에 `<inc>__<node>` 네임스페이스가 붙고, 깊이는 3까지다.
  - `workflow:`는 별도 run이다. 자식 run이 pause하면 부모는 `blocked_on_child` 상태가 된다.
  - **고르는 기준은 "사람이 독립적으로 승인·검사·포기할 단위인가"다.** Vuyro에서 서브그래프와 하위 티켓을 나누는 기준으로 그대로 쓸 수 있다.
- **탐색 우선순위:** bundled < global(`~/.archon/workflows`) < project(`.archon/workflows`). 이름이 같으면 위쪽이 덮어쓴다.
- **pack 설치:** `archon plugin add owner/repo@tag`로 설치하고 `owner/plugin:entrypoint`로 호출한다.
- **기본 제공 워크플로는 `sdlc` pack이다.** intake, triage, investigate, plan, implement, pr, review, deliver, ship, merge-queue, attention 등이 들어 있다.

### 4.5 검증 도구
- `archon validate workflows`: 정적 검사. 다른 노드 타입의 키를 쓰면 에러이고, 출력 필드 경로와 provider 능력 불일치도 확인한다.
- `archon workflow run --dry-run --stubs f.yaml`: 부작용 없는 시뮬레이션. stub이 노드 출력과 사람 응답을 대신한다.
- `archon workflow test`: `fixtures/*.stubs.yaml`에 적은 `expect`/`reached` 단언으로 경로를 테스트한다.

### 4.6 Constitution (`.archon/workflow-language-constitution.md`)
- 원칙: **"YAML coordinates. Code computes. Agents judge."**
- 기능 요청은 3문항으로 걸러 받는다:
  1. 엔진이 run을 통제하려면 이걸 봐야 하는가?
  2. 선언적 데이터인가, 평가인가?
  3. script 노드로 대체할 수 있는가?
- 경계하는 5가지 냄새: expression creep, composition metastasis, workaround pressure, schema width, implicit magic.
- 기능별로 받아들였는지 거절했는지 기록한 판례 표가 있다. racing, fail-fast 형제 취소 같은 기능이 거절됐다.

> **Vuyro 시사점:** 플러그인 노드 타입을 열어두면 기능 요청이 쏟아진다. 이런 "언어 헌법"을 처음부터 두면 범위를 지키기 쉽다.

## 5. 루프와 사람 개입

### 5.1 Wait와 attention
- 응답 폼은 4종이다: `message`(`{text}`), `approval`(`{decision, text}`), `select`, `multi_select`.
  - 선택지는 상위 출력에서 동적으로 받을 수 있다(`options: "$plan.output.options"`).
- **reject는 하나의 답일 뿐, run을 끝내지 않는다.** 끝내려면 `cancel:` 노드에 `when: "$review.output.decision == 'reject'"`를 명시해야 한다.
- 답변에는 `pauseId`(occurrence)를 붙인다. 이미 지나간 pause에 대한 늦은 답이나 중복 답은 서버가 거부한다.
- **pause 중에 상위 출력이 바뀌면 기존 답을 버리고 한 번 다시 묻는다.**
- 응답 경로는 여러 개지만 모두 같은 operation으로 처리된다: CLI(`approve/reject/respond`), HTTP(`/answer`), 웹 콘솔, Slack.

### 5.2 반려 후 재작업 패턴 (Vuyro QA 루프와 같은 구조)
```yaml
loop_group:
  max_iterations: 3
  until_bash: 'decision=$review.output.decision; [ "$decision" = "approve" ]'
  nodes:
    - id: revise
      prompt: "Improve this plan... Feedback: $LOOP_PREV.review.output.text"
    - id: review
      depends_on: [revise]
      wait: { form: approval, attention: "Review: $revise.output" }
```
- **사이클은 `loop_group` 안에 가둔다.** 바깥 DAG는 항상 acyclic으로 유지된다.
- 본문의 **유일한 terminal sink는 wait**여야 하고, 다음 반복은 `$LOOP_PREV`로 이전 피드백을 읽는다.
- 실제 사례는 `archon-deliver-block.yaml`이다. implement → PR → review → CI 라운드를 최대 5회 반복한다.

### 5.3 Attention queue (`packages/workflows/src/attention-queue.ts`)
- pause된 run을 타입이 붙은 항목으로 모은다. 종류는 `attention`, `awaiting_response`, `usage_limit`, `blocked_on_child`, `stalled_tool_calls` 등이다.
- 각 항목에는 *무엇인지, 왜 중요한지, 추천안, 선택지*가 들어간다.
- `labels`를 붙이면 handler 워크플로가 항목을 골라 대신 답할 수 있다. 사람과 에이전트가 같은 응답 채널을 쓴다.
- SDLC pack의 원칙은 *"새 실패는 pause하고, 반복되는 실패에는 handler 워크플로를 만든다"*다.

## 6. 상태, 실패, 재개

- **run 상태:** `pending / running / paused / completed / failed / cancelled`.
  - 이와 별도로 작성자가 정하는 **`outcome: succeeded | failed`**가 있어서, "정상 완료됐지만 결과는 실패"를 표현할 수 있다.
- **node 상태:** `pending / running / completed / failed / skipped`(+ skip 원인).
  - 노드 전용 테이블은 없다. 이벤트를 fold해서 상태를 계산한다(이벤트 소싱).
- **재시도 정책**
  - AI 노드는 transient 에러를 기본 2회 재시도한다(지수 backoff).
  - **bash/script는 기본으로 재시도하지 않는다.** 부작용이 있을 수 있어서이고, 필요하면 opt-in한다.
- **실패는 typed class로만 분류한다:** `auth | quota_exhausted | budget_exceeded | misconfigured | rate_limited | overloaded | transient | unknown`.
  - 에러 텍스트 매칭은 금지다.
  - quota나 rate limit에 걸리면 `resetAt`까지 run을 durable pause하고 자동으로 재개한다.
- **재개(resume)**
  - 명시적으로 요청할 때만 한다.
  - 완료된 노드는 캐시를 재사용하고, 실패한 노드와 아직 실행하지 않은 노드만 실행한다.
  - **`dag/stale-dependencies.ts`의 `getStaleCachedDependencies`가 Vuyro Stale과 가장 가깝다.** 의존 노드의 출력(텍스트와 구조화 출력)이 이전 스냅샷과 다르면 하류의 캐시된 성공을 무효화한다.
    - 단, **같은 run을 resume할 때만** 동작한다. 완료된 run의 특정 노드를 다시 여는 기능은 없다.
- **source capture:** run을 시작할 때 워크플로, 커맨드, 스크립트 소스를 고정한다. 템플릿을 수정해도 진행 중인 run은 바뀌지 않는다.
- **크래시 후 처리:** *"소유권을 추측하지 않는다."* owner를 host + pid + instance UUID로 식별하고, 판단할 수 없으면 운영자에게 넘긴다.

## 7. 에이전트 실행 방식

### 7.1 Claude (`packages/providers/src/claude/provider.ts`)
- `@anthropic-ai/claude-agent-sdk`의 `query()`를 쓴다. SDK가 Claude Code 네이티브 바이너리를 spawn한다.
- 권한은 `permissionMode: 'bypassPermissions'`로 전부 연다. 대신 노드별 `allowed_tools`/`denied_tools`와 명시한 MCP/skills로 범위를 제한한다.
- `settingSources: ['project','user']`로 사용자의 CLAUDE.md와 skills를 존중한다. 원칙은 *"provider home을 대체하지 않는다"*다.
- 시스템 프롬프트는 `claude_code` preset에 내용을 덧붙이는(append) 방식이 기본이다.

### 7.2 Codex (`packages/providers/src/codex/app-server.ts`)
- `codex app-server`를 spawn하고 stdio JSON-RPC로 통신한다: `thread/start`, `thread/resume`, `thread/fork` → `turn/start`.
- 설정은 `sandbox: 'danger-full-access'`, `approvalPolicy: 'never'`다. 구조화 출력은 `outputSchema`로 받는다.

### 7.3 공통 계약 (`packages/provider-contract/src/agent-provider.ts`)
- 인터페이스: `sendQuery(prompt, cwd, resumeSessionId?, options) → AsyncGenerator<ProviderChunk>`
- 이벤트 이름은 ACP(Agent Client Protocol)를 따른다: `agent_message_chunk`, `tool_call`, `tool_call_update` 등.
- **순서는 항상 이벤트 → `result` → `settled`다. 노드는 `settled`가 와야 완료된다.** `result` 뒤에도 백그라운드 작업이 남을 수 있기 때문이다.
- 비용과 토큰은 `tokens{input,output,cacheRead,cacheWrite,cost}`로 받는다. 정확하지 않으면 `tokensUnknown`이나 `cachePartial`로 정직하게 표시한다.
- 전체 session id는 DB의 노드 레코드에만 두고, 로그에는 앞 8자만 남긴다.

### 7.4 에이전트가 엔진에 보고하는 방식 (`packages/workflows/src/exec-environment.ts`)
- 에이전트 프로세스 환경변수에 `WORKFLOW_ID`, `ARCHON_NODE_EXECUTION`(runId / path / attempt JSON), `ARCHON_CLI_COMMAND`를 주입한다.
- 에이전트는 셸에서 `archon state put/patch --if-revision`(CAS, 작성자 기록)이나 `archon workflow event emit`을 호출한다.
- **Vuyro가 계획한 `vuyro artifact add` / `vuyro node done`과 사실상 같은 설계다.** 검증된 선례로 봐도 된다.
- 에이전트용 MCP 서버는 없다. 보고 경로는 CLI와 in-process native tool(채팅 오케스트레이터용)뿐이다.

### 7.5 자격증명 위생
- CLI가 부팅할 때 `<cwd>/.env`에 있는 키를 process.env에서 **제거**한다(`paths/strip-cwd-env.ts`). 대상 저장소의 API 키가 구독 인증을 덮어써 과금되는 사고를 막기 위해서다.
- 기본은 사용자의 `claude /login`, `codex login`을 그대로 쓴다. 로그는 redaction을 거친다.

## 8. 플러그인 시스템

- **플러그인 종류는 4가지다:** `provider | chat | forge | workflow-pack`.
  - 런타임 계약은 종류별로 따로 두고, 배포·설치 방식 하나만 공유한다.
  - **노드 타입은 고정된 union이라 플러그인으로 늘릴 수 없다.**
- **매니페스트** (`plugins/provider-claude/archon-plugin.json`)
  ```json
  { "schemaVersion": 1, "kind": "provider", "name": "provider-claude",
    "description": "Archon maintained Claude provider.", "executable": "archon-provider-claude" }
  ```
  - 선택 필드로 `compatibility: { archon: ">=0.11.0" }`가 있다.
- **설치**
  - GitHub 자체를 레지스트리로 쓴다(`archon plugin add owner/repo@tag`). 릴리스 에셋으로 OS별 바이너리를 받는다.
  - 설치하면 **receipt**(`~/.archon/plugins/installed/.../receipt.json`)를 남긴다. tag, commit SHA, 파일별 sha256, descriptor 스냅샷이 들어간다.
  - 실행할 때 live descriptor와 receipt를 대조한다.
- **통신 프로토콜**
  - 별도 프로세스로 띄우고 stdin/stdout NDJSON JSON-RPC로 통신한다(ACP v1 위에 `_archon/*` 확장).
  - 버전은 `PROVIDER_PLUGIN_PROTOCOL=2`로 협상하고, 같은 버전 안에서는 추가(additive) 변경만 허용한다.
  - 적합성 검사 키트(`@archon/provider-contract/conformance`)가 있다.
- **Capability matrix와 사전 검사(preflight)**
  - provider가 지원 능력을 선언한다: mcp, hooks, skills, structuredOutput, costReporting, sandbox 등.
  - 노드 요구사항과 맞지 않으면 **토큰을 쓰기 전에** 실패시킨다.
  - 예를 들어 Codex는 hooks, skills, agents, toolRestrictions, costReporting이 false다.

## 9. 격리, 저장, 설정

- **격리는 두 축으로 나눈다:** 어떤 트리를 보는가(worktree 또는 in-place)와 어디서 실행하는가(host 또는 container).
  - *"worktree는 보안 경계가 아니다"*라고 명시한다.
  - worktree는 명시적으로 요청할 때만 만든다. 추론은 금지다.
  - container는 overlayfs + Docker 조합이라 Linux 전제이고, Claude만 지원한다.
- **동시 실행 충돌은 path lock으로 막는다.** running/paused run이 working path를 점유한다. 자원 슬롯과 provider 동시성 상한도 있다.
- **Windows에서는 detached owner가 Job Object로 프로세스 트리 전체를 정리한다**(`core/services/windows-run-job.ts`).
- **산출물 저장 위치:** run별 `~/.archon/workspaces/<project>/artifacts/runs/<run-id>/`를 `$ARTIFACTS_DIR`로 넘긴다.
  - typed 출력은 `nodes/<id>.md`와 `.meta.json`으로 저장한다.
  - 노드 사이에서는 `{type:'archon_artifact', run_id, path}` pointer로 참조한다.
  - 이벤트 쪽 artifact 종류는 `pr | commit | file_created | file_modified | branch`뿐이다.
- **checkout observation:** 노드를 시작할 때 git 커밋과 변경 파일 blob manifest를 "사실"로 기록한다.
- **설정 레이어:** 전역(`~/.archon/config.yaml`) → 저장소(`.archon/config.yaml`, 커밋됨) → run별(`--config`, run 시작 시 고정).
  - 모델은 `small | medium | large` tier와 alias로 간접 지정한다.
- **스키마는 additive-only다.** 이전 바이너리도 같은 DB를 열 수 있어야 한다.

## 10. UI (`packages/web/src/experiments/console/`)

React, react-router, TanStack Query, `@xyflow/react`(React Flow), dagre로 만들었다. 실시간 업데이트는 **SSE**를 쓰고, 30초마다 안전망 refetch를 한다.

| 화면 | 내용 |
|---|---|
| Runs 피드 | 상태 필터, 활성 run 카드(현재 노드와 마지막 tool), **PendingInputBanner**(사람 응답이 필요한 run을 항상 상단에 고정), `N` 키로 새 run |
| Run 상세 | **Log / Graph / Artifacts** 탭. 하단 액션바(Cancel / Abandon / Resume / Re-run) |
| Graph | dagre로 레이아웃한 SVG. 상태별 색, running이면 pulse, 노드를 클릭하면 로그의 해당 위치로 이동. **읽기 전용** |
| 프로젝트 채팅 | 프로젝트당 대화 1개. 오케스트레이터 에이전트가 워크플로를 띄우고, 게이트에 자연어로 답하면 approve/reject로 해석(모호하면 되물음) |
| Builder (beta) | React Flow 캔버스, 노드 팔레트, Inspector, `WhenBuilder`, IssueList(검증 결과), YAML 미리보기. `include`, `loop_group`, `workflow:`는 지원하지 않고, 빌더에서 바로 실행할 수 없음 |
| Settings | 모델 tier, 에이전트 로그인, GitHub, 알림 |

**승인 UX에서 눈여겨볼 점**
- approve는 원클릭이다. reject 같은 비기본 결정은 **사유를 입력해야 확인 버튼이 활성화되는 2단계**다.
- 승인 노드의 메시지가 빈약하면 직전 AI 출력을 미리보기로 붙여 맥락을 보여준다(`ApprovalContext`).
- 알림은 3계층이다: 탭 사운드, 브라우저 알림, 탭을 닫아도 오는 Web Push. 같은 occurrence에 대해서는 한 번만 알린다.
- 프로세스가 응답하지 않으면 live처럼 보이게 두지 않고 *"Running · owner not answering"*으로 정직하게 표시한다.
- 외부 GUI가 Archon을 감싸는 경우를 공식 지원한다. `~/.archon/install.json`에 바이너리 경로와 버전을 남기고, `--json`/`--watch` 출력과 HTTP API를 제공한다.

## 11. Vuyro가 가져다 쓸 것 (우선순위별)

### A. 설계 초기에 반드시 반영
| # | Archon 설계 | Vuyro 적용 |
|---|---|---|
| A1 | 엔진은 라이브러리, CLI/서버/UI는 host. import 방향은 lint로 강제 | 엔진 코어 / 데스크톱 앱 / `vuyro` CLI 분리 |
| A2 | 노드 상태를 **이벤트 소싱**으로 관리(append-only + fold), JSONL + write-ahead intent + lock 파일 스토어 | DB 없이 시작할 수 있는 티켓 저장소. 크래시 후 재개와 감사 기록이 공짜로 따라옴 |
| A3 | 에이전트 env에 실행 맥락 주입 + CLI로 보고(`state patch --if-revision`, `event emit`) | `VUYRO_TICKET`, `VUYRO_NODE`를 주입하고 `vuyro artifact add`, `vuyro node done` 제공. CAS(revision)를 포함 |
| A4 | provider 계약: 이벤트 스트림 → `result` → **`settled`** | 노드 완료 판정 기준. Claude/Codex 차이는 어댑터 안에 가둠 |
| A5 | **status와 outcome 분리** | QA의 "정상 완료 + Reject"를 실패 없이 표현. Rejected 상태 설계의 근거 |
| A6 | **source capture**: run 시작 시 템플릿 고정 | 티켓 생성 시 템플릿 버전 고정. 공유 템플릿을 업데이트해도 진행 중 티켓은 그대로 |
| A7 | typed 출력 계약(`output_format` JSON Schema)과 선언하지 않은 필드 참조 금지 | 노드 간 전달은 스키마가 있는 출력과 산출물 참조로만 |

### B. 구현 단계에서 참고
| # | Archon 설계 | Vuyro 적용 |
|---|---|---|
| B1 | reject 루프를 `loop_group`에 캡슐화, 본문 sink = wait, `$LOOP_PREV` 피드백 | QA 반려 루프의 기본형. 단, Vuyro는 상위 임의 노드로 돌아가야 하므로 확장 필요(§12) |
| B2 | reject는 답일 뿐이고, 종료나 라우팅은 명시적으로 | 반려 시 어느 노드로 갈지 그래프 엣지로 보이게 |
| B3 | 입력이 바뀌면 attention을 다시 묻기 | 변경 요청(CR)이 들어왔을 때 승인 대기 중인 노드 처리 방식 |
| B4 | `getStaleCachedDependencies`(출력 스냅샷 비교) | Stale 판정 알고리즘의 출발점. 이것을 run 바깥, 즉 티켓 수명 전체로 확장 |
| B5 | typed failure class로만 재시도, script는 기본 재시도 없음, quota면 pause 후 자동 재개 | Perforce sync/submit 같은 부작용 노드 보호 |
| B6 | capability 선언과 비용 전 preflight | Claude/Codex 능력 차이를 노드 배치 시점에 경고 |
| B7 | attention queue: 무엇 / 왜 / 추천 / 선택지 + 라벨 + occurrence id | 기획자용 "내 할 일" 인박스. 여러 사람이 동시에 봐도 안전 |
| B8 | 응답 폼 4종(message / approval / select / multi_select), 동적 옵션 | 사람 노드 UI를 폼 스키마로 일반화 |
| B9 | trigger_rule 기본값 분리(일반 = all_success, fan-out = all_done) | 병렬 Dev 중 하나가 실패해도 나머지 결과 보존 |
| B10 | include(인라인)와 workflow(별도 run)의 구분 기준 | 서브그래프와 하위 티켓을 나누는 기준 |
| B11 | owner 식별(host + pid + UUID), Windows Job Object | Windows 데스크톱에서 에이전트 프로세스 트리 정리 |
| B12 | `<cwd>/.env` strip, 세션 id 축약 로그, credential redaction | 대상 프로젝트의 키가 에이전트로 새는 것 방지 |

### C. 나중에 (생태계, 품질)
| # | Archon 설계 | Vuyro 적용 |
|---|---|---|
| C1 | GitHub를 레지스트리로 쓰는 플러그인 배포 + receipt(sha256, descriptor 스냅샷) | 템플릿과 플러그인 공유 기능 |
| C2 | 별도 프로세스 플러그인 + NDJSON JSON-RPC + 프로토콜 버전 + 적합성 키트 | 외부 개발자용 플러그인 API 안정성 |
| C3 | dry-run stub과 fixture 테스트 | 템플릿 작성자가 비용 없이 경로 검증 |
| C4 | 언어 constitution(3문항, 판례 표) | 플러그인/노드 타입 기능 요청 거버넌스 |
| C5 | Builder Copilot 설계(AI 제안을 원자적 Proposal로 묶어 Accept/Reject). 용어만 있고 구현은 없음 | AI 보조 워크플로 편집 |
| C6 | UI 소소한 점: Pending 배너 고정, 2단계 reject, 질문 맥락 자동 첨부, 그래프와 로그 연동, 알림 3계층, "owner not answering" | 데스크톱 UX 체크리스트 |

## 12. Archon의 빈자리 (Vuyro 기회)

1. **티켓이 없다.** 기본 단위가 run이고, 작업 아이템은 GitHub issue와 label에 맡긴다. 칸반이나 티켓 상세 화면이 없다.
2. **상위 노드 재오픈과 Stale 전파가 없다.** 완료된 run의 특정 노드를 다시 열고 하류를 Stale로 표시하는 기능이 없다. stale 감지는 같은 run을 resume할 때만 동작한다.
3. **임의의 상위 노드로 돌아갈 수 없다.** 루프가 `loop_group` 안에 밀봉되어 있어서, "QA → Spec으로 되돌리기"는 구조적으로 어렵다.
4. **저장소 밖 산출물을 추적하지 않는다.** artifact는 run 디렉터리의 파일과 pointer뿐이다. Perforce는 코드 어디에도 언급이 없다. Confluence/Jira를 경로와 버전으로 추적하는 모델도 없다.
5. **노드 타입을 확장할 수 없다.** 플러그인은 provider, chat, forge, pack 네 종류뿐이다.
6. **비개발자 UX가 없다.** YAML이 정본이고, 셸 따옴표 규칙과 `$LOOP_PREV` 같은 문법을 알아야 하며, 레퍼런스가 3,000줄이다. 담당자 지정과 라우팅도 원칙상 하지 않는다("Not the owner of policy").
7. **데스크톱 앱이 없다.** Electron/Tauri 흔적이 0건이다. 그래프 편집 화면과 모니터링 화면도 분리되어 있다.
8. **사람 중심 노드 상태가 없다.** Review, Rejected, Stale이 없다.
9. **실행 중에 끼어들 수 없다.** 미리 선언한 wait 지점에서만 사람이 개입할 수 있다.
10. **결과 화면이 미정이다.** 리뷰 UI 같은 "실행 결과 화면"이 아직 Open question으로 남아 있다.

## 13. 따라 하지 말 것

- **과도한 복잡도.** SQLite/PG 양립, 수천 줄 계약 테스트, pause/resume 모서리 규칙까지 다룬다. Vuyro는 데스크톱 단일 사용자 전제로 범위를 좁힌다.
- **에이전트 권한 전면 개방.** Claude는 bypassPermissions, Codex는 danger-full-access다. 사용자층이 기획자까지 넓은 Vuyro는 노드별 권한 프로필을 기본으로 두는 편이 낫다.
- **턴마다 플러그인 프로세스와 에이전트 프로세스를 새로 띄우는 구조.** 층이 깊어 시작이 느리고, 첫 이벤트 60초 타임아웃 같은 진단 장치가 따로 필요해졌다.
- **Docker + overlayfs 컨테이너 격리.** Windows 데스크톱과 맞지 않는다.
- **조건 언어를 YAML 안에서 키우는 것.** Archon도 괄호조차 넣지 않았다. 복잡한 판단은 script 노드로 보낸다.

## 14. 결정이 필요한 질문

1. **CLI를 직접 실행할 것인가, SDK/app-server를 쓸 것인가.**
   - Archon은 관찰 가능성 때문에 Claude Agent SDK와 `codex app-server`를 쓴다. 이렇게 하면 tool call, 비용, session id를 구조화된 데이터로 받는다.
   - Vuyro는 CLI 방식으로 정했지만, CLI를 직접 띄우더라도 `claude -p --output-format stream-json`이나 Codex의 JSON 출력처럼 **구조화된 이벤트 모드로 실행하고 파싱하는 어댑터**가 필요하다.
   - 어댑터 경계만 지키면 나중에 SDK로 바꿀 수 있다(A4).
2. **Archon을 백엔드로 감쌀 것인가.**
   - Archon은 외부 GUI가 감싸는 경우를 공식 지원한다(install.json, `--json`/`--watch`, HTTP).
   - 장점: 엔진 개발비를 아낀다.
   - 단점: run 중심이고 git 중심이라 §12의 1~5번(티켓, Stale, 임의 노드 복귀, 외부 산출물, 노드 타입 확장)을 구현하기 어렵다.
   - **현재 판단은 "자체 엔진 + Archon 설계 차용"이다.**
3. **워크플로 정본 형식.** YAML 파일(공유와 버전 관리에 유리)로 둘지, 앱 내부 DB로 둘지 정해야 한다. Archon처럼 "정본은 텍스트 파일, 캔버스 좌표는 별도 파일"이 무난하다.

## 15. 참고 파일 링크

기준 커밋 `d3ad72b`. 링크 앞부분은 `https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/`이다.

| 주제 | 파일 |
|---|---|
| 제품 방향 / 비목표 | [.archon/direction.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/.archon/direction.md) |
| 아키텍처 | [.archon/architecture.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/.archon/architecture.md) |
| 언어 constitution | [.archon/workflow-language-constitution.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/.archon/workflow-language-constitution.md) |
| 워크플로 언어 레퍼런스 | [reference/workflow-language.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/docs-web/src/content/docs/reference/workflow-language.md) |
| 승인 노드 가이드 | [guides/approval-nodes.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/docs-web/src/content/docs/guides/approval-nodes.md) |
| 루프 노드 가이드 | [guides/loop-nodes.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/docs-web/src/content/docs/guides/loop-nodes.md) |
| 반려 루프 실사례 | [sdlc/deliver/archon-deliver-block.yaml](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/.archon/workflows/sdlc/deliver/archon-deliver-block.yaml) |
| SDLC pack 원칙 | [sdlc/CONSTITUTION.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/.archon/workflows/sdlc/CONSTITUTION.md) |
| 노드 스키마 | [workflows/src/schemas/dag-node.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/schemas/dag-node.ts) |
| run / node 상태 | [schemas/run-status.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/schemas/run-status.ts), [schemas/node-state.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/schemas/node-state.ts) |
| Stale 캐시 무효화 | [dag/stale-dependencies.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/dag/stale-dependencies.ts) |
| trigger rule | [dag/trigger-rule.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/dag/trigger-rule.ts) |
| attention queue | [workflows/src/attention-queue.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/attention-queue.ts) |
| 에이전트 env 주입 | [workflows/src/exec-environment.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/exec-environment.ts) |
| source capture | [workflows/src/workflow-source.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/workflow-source.ts) |
| 파일 스토어 | [workflows/src/file-store/](https://github.com/coleam00/Archon/tree/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/workflows/src/file-store) |
| provider 계약 | [provider-contract/README.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/provider-contract/README.md), [src/agent-provider.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/provider-contract/src/agent-provider.ts) |
| Claude provider | [providers/src/claude/provider.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/providers/src/claude/provider.ts) |
| Codex provider | [providers/src/codex/app-server.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/providers/src/codex/app-server.ts) |
| 플러그인 매니페스트 | [plugin-manifest/src/index.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/plugin-manifest/src/index.ts) |
| Windows 프로세스 정리 | [core/src/services/windows-run-job.ts](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/core/src/services/windows-run-job.ts) |
| DB 스키마 | [migrations/000_combined.sql](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/migrations/000_combined.sql) |
| 런 그래프 UI | [console/components/RunGraphPanel.tsx](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/web/src/experiments/console/components/RunGraphPanel.tsx) |
| 승인 UI | [console/components/ApprovalPanel.tsx](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/web/src/experiments/console/components/ApprovalPanel.tsx), [AttentionAnswerPanel.tsx](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/web/src/experiments/console/components/AttentionAnswerPanel.tsx) |
| 비주얼 빌더 | [console/builder/README.md](https://github.com/coleam00/Archon/blob/d3ad72bf929c83dd5edd1f1bced57b92a5ad07ae/packages/web/src/experiments/console/builder/README.md) |

## 16. 버전 연혁 요약 (CHANGELOG.md)

| 버전 (날짜) | 주요 변화 |
|---|---|
| 0.1.0 (2025-12-08) | 최초 릴리스 "Remote Agentic Coding Platform" |
| 0.1.2 (2026-01-07) | YAML 워크플로 엔진 |
| 0.2.5 (2026-02-17) | Web UI 첫 출시 |
| 0.2.6 (2026-02-21) | DAG 엔진, 오케스트레이터 에이전트 |
| 0.2.7 (2026-02-26) | 1세대 비주얼 빌더(React Flow, #471) |
| 0.2.12 (2026-03-20) | DAG 그래프 뷰어 |
| 0.5.0 (2026-06-26) | Console이 기본 UI가 됨, Studio 빌더 데이터 모델 |
| 0.6.0 (2026-07-20) | Studio 빌더 프리뷰, 컨테이너 격리 |
| 0.7.0 (2026-08-01) | Studio 실제 저장 연결, `workflow:` 서브런 |
| 0.8.0 (2026-08-06) | `$ARTIFACTS_DIR`/`$STATE_DIR`, fan-out 서브런, 파라미터 include |
| 0.9.0 (2026-08-17) | 워크플로 입출력 선언, 시뮬레이션 |
| 0.10.0 (2026-08-30) | `sdlc` pack, 게이트 자연어 응답, durable wait |
| 0.11.0 (2026-09-25) | GitHub 기반 플러그인/팩 설치, 스케줄·이벤트 트리거 |
| 0.12.0 (2026-10-17) | 단일 attention queue, 폼 4종, 빌더 서식 보존 저장, provider 분리 설치 |

> 약 10개월 만에 0.1에서 0.12로 왔다. 진행 속도가 빠르므로 Vuyro를 개발하는 동안 주기적으로 다시 확인한다. 특히 direction.md의 Open questions(결과 화면, 빌더 방향)를 지켜본다.
