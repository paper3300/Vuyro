# 에이전트 CLI 녹화 픽스처

실제 CLI 출력을 녹화한 파일이다. 어댑터의 계약 테스트와 가짜 어댑터 재생에 쓴다.
해석과 결론은 `Docs/Design/초기 검증 결과.md`의 M0b 절에 있다.

- 경로: `<provider>/<cli-version>/<시나리오>.jsonl`
- 녹화일: 2026-10-23, Windows 11, Git 저장소로 만든 임시 폴더에서 실행했다.
- 기계마다 다른 값은 `scripts/sanitize-fixture.ts`로 치환했다.
  - 녹화한 임시 폴더 → `C:\Users\sample\AppData\Local\Temp\vuyro-fixture`
  - 사용자 이름(경로, 폴더 이름 포함) → `sample`
  - id, 토큰 수, 비용, 시각은 그대로 둔다.

## 시나리오

| 파일 | 내용 |
|---|---|
| `simple.jsonl` | (a) 단순 답변: "Reply with exactly the word: pong" |
| `tools-read-write.jsonl` | (b) `input.txt`를 읽고 대문자로 바꿔 `output.txt`에 쓰기 |
| `resume.jsonl` | (c) (a) 세션을 이어서 "이전 답이 뭐였나" |
| `error-unknown-model.jsonl` | 없는 모델 이름으로 실행(토큰 소모 없음) |
| `tool-failure.jsonl` | 없는 파일을 읽게 해서 도구 하나를 실패시킴 |
| `synthetic-truncated-*.jsonl` | **합성 픽스처**: `simple.jsonl`에서 마지막 줄(정착 줄)을 지운 것. 종료 줄 없이 프로세스가 끝난 경우를 흉내 낸다 |
| `hook-*.jsonl` | 파일 수정 직전 훅 시험 |
| `hook-input-*.json` | 훅 프로세스가 stdin으로 받은 내용 |
| `*.hook-log.jsonl` | 같은 이름 실행의 **훅 호출 로그**. 훅이 호출될 때마다 stdin을 한 줄 추가한다. 실행 전에 빈 파일로 만들었으므로, 비어 있으면 훅이 호출되지 않은 것이다 |
| `*.stderr.txt` | 같은 실행의 stderr(정보가 stdout에 없을 때만 보관) |

### Claude Code 2.1.309 (`claude/2.1.309/`)

모델은 `haiku`(`claude-haiku-5-5`). 사용자 설정·MCP·스킬을 빼고 도구를 셋으로 줄였다.

```sh
claude -p "<prompt>" --output-format stream-json --verbose --model haiku \
  --setting-sources "" --strict-mcp-config --disable-slash-commands \
  --tools "Read,Write,Edit" --permission-mode acceptEdits < /dev/null
# (c) 이어하기: 위에 --resume <session_id>
# 훅: 위에 --include-hook-events --settings '<JSON>'
```

| 파일 | 훅 설정 |
|---|---|
| `hook-deny-json.jsonl` | `Write\|Edit`, 훅이 stdout으로 `permissionDecision: "deny"` JSON |
| `hook-deny-exit2.jsonl` | `Write\|Edit`, 훅이 stderr에 사유를 쓰고 exit 2 |
| `hook-deny-edit.jsonl` | `Write\|Edit`, JSON deny, Edit 도구 |

### Codex CLI 0.163.0 (`codex/0.163.0/`)

모델은 이 PC에서 쓸 수 있는 가장 작은 모델 `gpt-6-luna`, `model_reasoning_effort="low"`. 사용자 설정을 무시하고 Windows 샌드박스만 다시 지정했다.

```sh
codex exec --json --ignore-user-config -m gpt-6-luna \
  -c 'model_reasoning_effort="low"' -c 'windows.sandbox="unelevated"' \
  -s workspace-write -C <dir> "<prompt>" < /dev/null
# (c) 이어하기: codex exec --json ... resume <thread_id> "<prompt>"
# 훅: -c 'hooks.PreToolUse=[{matcher="apply_patch", hooks=[{type="command",
#        command="/nonexistent/unix-only-hook", commandWindows="node <hook> ...", timeout=30}]}]'
#      --dangerously-bypass-hook-trust
```

(a)와 (c)는 `windows.sandbox` 없이 녹화했다. 도구를 쓰지 않으므로 출력에는 차이가 없다.
`*.hook-log.jsonl`이 있는 실행과 `tool-failure.jsonl`은 2차 녹화분이다(훅 로그를 함께 보관하려고 다시 녹화했다).

| 파일 | 훅 설정 | 결과 |
|---|---|---|
| `hook-deny-apply-patch.jsonl` | JSON deny, 신뢰 우회 플래그 | 막힘. stdout에는 흔적이 없고 stderr에만 남는다 |
| `hook-exit2-not-blocked.jsonl` (+ `.hook-log.jsonl`) | exit 2, 신뢰 우회 플래그 | 훅은 호출됨(로그 1줄), **막지 못함**, 파일 생성됨 |
| `hook-untrusted-not-run.jsonl` (+ `.hook-log.jsonl`) | JSON deny, 신뢰 우회 플래그 없음 | **훅이 호출되지 않음**(빈 로그), 파일 생성됨 |
| `hook-allowed-apply-patch.jsonl` (+ `.hook-log.jsonl`) | 로그만 남기는 훅(`log`), 신뢰 우회 플래그 | 허용된 같은 호출의 훅 `tool_use_id`와 stream `item.id` 한 쌍 |
| `hook-input-pretooluse-bash.json` | `.*` 로그만 남기는 훅, PowerShell로 쓰기 | 셸 명령은 `tool_name: "Bash"`로 들어온다 |

## 훅 스크립트

녹화에 쓴 훅이다. `<log>`에 stdin을 덧붙이고, `json`이면 JSON으로 거부, `exit2`면 exit 2로 거부, `log`면 통과한다.

```js
import { appendFileSync, readFileSync } from 'node:fs';
const [, , logFile, mode] = process.argv;
const input = readFileSync(0, 'utf8');
appendFileSync(logFile, input.trim() + '\n');
if (mode === 'log') process.exit(0);
if (mode === 'exit2') {
  process.stderr.write('Vuyro: internal checkout required (exit 2)');
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Vuyro: internal checkout required',
  },
}));
```

## 다시 녹화하기

1. 저장소 밖에 임시 폴더를 만들고 `git init`, `input.txt`(`hello vuyro`)를 둔다.
2. 위 명령으로 녹화한다. herdr 같은 터미널 통합의 환경 변수는 빼고 실행한다(사용자 훅이 반응하지 않게).
3. `node packages/agent-adapters/scripts/sanitize-fixture.ts --root <임시 폴더> <원본> <픽스처>`
4. 새 CLI 버전이면 새 `<cli-version>` 폴더에 넣고, 이전 버전 폴더는 지우지 않는다.

### M7a 실제 `vuyro` 훅 (2026-10-24)

`vuyro hook pretooluse`(실제 CLI) 앞에 기록용 훅을 하나 더 두고, 실행 변수는 엔진이 없는 곳을 가리키게 해서 돌렸다. Vuyro 훅은 엔진에 닿지 못하면 언제나 deny다. 기록용 훅 로그(`*.hook-log.jsonl`)는 stdin이 아니라 그 프로세스가 본 것(`VUYRO_*` 이름, 실행 토큰 모양, 부모 프로세스 이름)을 한 줄씩 적는다.

| 파일 | 내용 |
|---|---|
| `claude/2.1.310/hook-deny-vuyro.jsonl` | Claude Code 2.1.310, `claude-haiku-5-5`, `--include-hook-events`. 훅은 Git Bash로 돌고 Write 두 번이 모두 막힌다 |
| `codex/0.163.0/hook-deny-vuyro.jsonl` | `gpt-6-luna`, `low`. `commandWindows`를 `& '<node>' …` 형식으로 줬다. 훅은 PowerShell로 돌고 패치가 막힌다(흔적은 stderr에만) |
| `codex/0.163.0/hook-quoted-not-run.jsonl` | 같은 조건에서 `commandWindows`가 `"C:/Program Files/nodejs/node.exe" …`처럼 따옴표 경로로 시작했다. PowerShell 문법 오류로 훅이 돌지 않았고(로그 0줄) 파일이 만들어졌다 |

치환은 같은 스크립트로 했다. Claude의 `hook_response.output`은 JSON 안의 JSON이라 백슬래시가 두 겹이다. 스크립트가 그 모양도 바꾸도록 고쳤다.
