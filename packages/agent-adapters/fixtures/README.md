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
| `hook-*.jsonl` | 파일 수정 직전 훅 시험 |
| `hook-input-*.json` | 훅 프로세스가 stdin으로 받은 내용 |
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

| 파일 | 훅 설정 | 결과 |
|---|---|---|
| `hook-deny-apply-patch.jsonl` | JSON deny, 신뢰 우회 플래그 | 막힘. stdout에는 흔적이 없고 stderr에만 남는다 |
| `hook-exit2-not-blocked.jsonl` | exit 2, 신뢰 우회 플래그 | **막지 못함**, 파일 생성됨 |
| `hook-untrusted-not-run.jsonl` | JSON deny, 신뢰 우회 플래그 없음 | **훅이 실행되지 않음**, 파일 생성됨 |
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
