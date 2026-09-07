# Django Shell 안정성 검토 — 2026-09-07

검토에서 **11개 결함·위험을 12개 격리 시나리오로 재현**했다. 우선순위는 데이터 유실, 잘못된 저장, 실행·응답 혼선을 일으키는 P1 7건과 오류 복구·조회 가용성에 영향을 주는 P2 4건이다. **2026-09-08 작업 트리에 11건의 수정과 회귀 테스트를 반영했다.**

같은 날 [추가 심화 검토와 수정](CRITICAL_REVIEW.md)에서 P1 5건과 P2 회귀 1건을 확인해 수정했다. R4·R6에서 누락됐던 ORM Query 창에도 공통 저장 응답 처리를 적용했다. 최신 전체 검사는 909개 통과이며, Model Browser와 ORM Query 두 실제 웹뷰의 저장·실패 복구 검사도 통과했다. 아래 879개 통과 기록은 첫 수정 시점의 검사 범위다.

`1.1.1000050` 릴리스 준비에서는 격리된 VS Code의 전체 E2E도 통과했다. AI Assist, property 갱신, 두 저장 웹뷰, Console 실행, Python 자동완성·테마·hover·입력 지연 검사를 포함한다. 릴리스 검증 기록과 범위는 [추가 검토 문서](CRITICAL_REVIEW.md)의 수정 후 검증 항목에 기록했다.

최초 검토 기준은 HEAD `60d1c70`에 직전 property 표시 수정이 포함된 작업 트리다. Node 22.22.2, Python 3.11.15, Django 5.2.15에서 `out/`의 호스트 코드와 `media/` 소스, 실제 Python 백엔드를 사용했다. 설치된 VS Code 확장본이나 운영 DB에서 장애를 재현한 결과는 아니다.

**수정 결과와 회귀 검증**

| ID | 반영한 동작 | 회귀 테스트 |
| --- | --- | --- |
| R1 | 송신 후 연결 실패는 결과 불명으로 반환하고 자동 재실행하지 않음. 연결 전 실패의 PTY 대체와 재연결 대기 정책은 유지 | [backendTransportStability](test/backendTransportStability.test.mjs) |
| R2 | 시간 초과한 PTY 스트림은 해당 늦은 응답과 새 프롬프트를 확인하거나 재시작할 때까지 재사용하지 않음. 중복·다른 ID 응답은 다음 literal 셀에 전달하지 않음 | [notebookPtyStability](test/notebookPtyStability.test.mjs) |
| R3 | 재시작·dispose·종료 시 대기 큐와 활성 요청을 취소하고, enqueue 당시 세대 및 오래된 client의 PTY 접근을 검사 | [asyncQueue](test/asyncQueue.test.mjs), [notebookPtyStability](test/notebookPtyStability.test.mjs) |
| R4 | editorId·commitId·필드별 편집 버전으로 저장 응답을 연결. 저장 후 추가 편집과 부모·관련 테이블의 편집을 각각 보존 | [gridCommitStability](test/gridCommitStability.test.mjs), [실제 웹뷰](test/e2e/suite/modelStabilityWebview.js) |
| R5 | 기존 ISO 값의 고정 UTC offset을 입력 기준으로 명시하고 소수초와 함께 복원. 기존 값이 시간대 없는 값이면 Django local time으로 표시 | [gridCommitStability](test/gridCommitStability.test.mjs), [modelCommitStability](test/modelCommitStability.test.mjs), [실제 웹뷰](test/e2e/suite/modelStabilityWebview.js) |
| R6 | main·related 저장 Promise가 reject해도 요청에 연결된 결과 불명 응답을 반환. 편집 내용은 유지하고 저장 UI 잠금 해제 | [modelCommitHostStability](test/modelCommitHostStability.test.mjs), [실제 웹뷰](test/e2e/suite/modelStabilityWebview.js) |
| R7 | 병렬 조회 정책을 AsyncLocalStorage의 요청별 컨텍스트로 분리. 종료 순서와 중첩 요청이 다른 요청의 상태를 덮어쓰지 않음 | [backendTransportStability](test/backendTransportStability.test.mjs) |
| R8 | interrupt Socket 응답은 4초, 컨트롤러의 중단 확인 대기는 6초로 제한. 확인하지 못한 중단은 성공으로 표시하지 않음 | [backendTransportStability](test/backendTransportStability.test.mjs), [modelQueryCancellationStability](test/modelQueryCancellationStability.test.mjs) |
| R9 | PTY 정상·비정상 종료 모두 closed·ready=false로 전파하고 client, 큐, 타이머, 포워딩 자원을 정리 | [notebookPtyStability](test/notebookPtyStability.test.mjs) |
| R10 | 쓰기 alias를 명시한 행 조회·잠금·atomic·save를 사용. instance별 쓰기 alias가 다른 조합은 저장 전 거절 | [modelCommitStability](test/modelCommitStability.test.mjs) |
| R11 | Socket과 ORM/Terminal 생성 코드 모두 실제 모델의 편집 가능 필드만 적용하고, 모든 행의 full_clean 이후 update_fields를 지정해 저장 | [modelCommitStability](test/modelCommitStability.test.mjs) |

- `npm run check`: 가이드라인 검사·TypeScript 컴파일·웹뷰 번들 빌드·**879개 테스트 통과**, 실패·skip 0. 직전 841개에서 안정성 회귀 테스트 38개를 추가했다.
- 실제 VS Code 1.134.0의 임시 프로필·빈 확장 디렉터리에서 저장 안정성 웹뷰 E2E가 exit code 0으로 완료됐다. 저장 중 추가 편집, 실패·재시도, datetime 입력, 관련 테이블 실패·재시도 및 부모 편집 보존을 실제 DOM 조작으로 확인했다. DB 응답은 이 웹뷰 테스트에서 모의 처리했다.
- 별도의 실제 Django/SQLite 테스트는 Socket 백엔드 함수와 ORM/Terminal이 공유하는 생성 코드를 실행해 validator·Model.clean·편집 불가 필드·변경 필드 제한·default/비기본 DB rollback·read replica 분리·다중 alias 거절·시간대 저장 결과를 검증했다.
- 전체 기존 Model Browser E2E 실행은 AI Assist 설정 단계에서 30초 시간 초과했다. 따라서 이번에 전체 E2E가 통과했다고 주장하지 않는다. 변경한 저장 흐름은 독립 suite로 실행해 통과했다.
- 연결된 앱 브라우저가 없어 화면 크기별 시각 검증은 수행하지 못했다. 설치된 확장본·운영 DB·실제 SSH/kubectl 단절·장시간 부하·debugger/hot reload 전체 생명주기도 이번 검증 범위 밖이다. 날짜 편집은 저장된 고정 offset을 유지하며 IANA 지역의 DST 규칙에 따라 자동 변환하지 않는다.
- 최종 전체 검사 로그: `/private/tmp/django-shell-stability-check.log`. 저장 웹뷰 검사 로그: `/private/tmp/django-shell-stability-isolated-e2e.log`.

**수정 전 재현 기록**

아래 표와 상세 분석은 최초 검토 당시의 동작을 보존한 기록이다. 상세 근거의 줄 번호와 “수정 방향”·“완료 조건”은 수정 전 코드와 당시 제안을 가리킨다. 현재 구현과 검증 상태는 위 표를 기준으로 한다.

| ID | 우선순위 | 재현 조건 | 확인된 결과 |
| --- | --- | --- | --- |
| R4 | P1 | 저장 중 추가 편집 / 관련 테이블 저장 | 아직 저장하지 않은 메인 테이블 수정이 사라짐 |
| R11 | P1 | Django validator를 위반하는 값을 ORM/Terminal로 저장 | Socket에서 거절한 값을 그대로 저장 |
| R5 | P1 | 시간대가 있는 날짜·시간을 편집 | 입력 의도와 9시간 다른 시각이 저장됨 |
| R10 | P1 | 쓰기 DB가 `default`가 아니고 두 번째 저장이 실패 | 실패 응답인데 첫 번째 행의 변경은 남음 |
| R1 | P1 | Socket 요청 송신 후 응답 전 연결 종료 | 동일 실행을 PTY로 자동 재전송 |
| R2 | P1 | ORM 셀이 시간 초과한 뒤 늦게 응답 | 다음 요청이 이전 요청의 결과로 성공 처리됨 |
| R3 | P1 | PTY 작업이 대기 중일 때 세션 재시작 | 이전 세션의 대기 작업이 새 셸로 전송됨 |
| R6 | P2 | 저장 요청 Promise가 reject | 웹뷰에 완료·실패 응답이 없어 저장 상태가 풀리지 않음 |
| R7 | P2 | 병렬 조회 두 개가 시작 순서대로 종료 | 조회 상태 플래그가 뒤집히고 이후 정상 조회도 차단 |
| R8 | P2 | Cancel의 interrupt 요청이 응답하지 않음 | 원래 쿼리가 끝나도 계속 cancelling, 다음 실행은 busy |
| R9 | P2 | 백엔드가 연결된 PTY 프로세스 종료 | 종료 후에도 ready=true 유지 |

**R4 — 저장 응답이 저장 대상과 편집 버전에 연결되어 있지 않음**

근거: [gridEdit.js:248](media/gridEdit.js#L248), [gridEdit.js:268](media/gridEdit.js#L268), [modelBrowser.ts:758](src/modelBrowser.ts#L758), [modelBrowserSource.js:159](media/modelBrowserSource.js#L159), [gridRelated.js:40](media/gridRelated.js#L40).

메인 편집기는 성공 응답을 받으면 `pending.clear()`로 모든 수정을 지운다. 저장 중에도 셀 편집은 가능하다. `name`만 전송한 뒤 `notes`를 수정하고 첫 저장의 성공 응답을 전달하면, 전송하지 않은 `notes`까지 사라지는 것을 재현했다.

관련 테이블 저장도 같은 `{type: "commit", result}` 응답을 보낸다. 웹뷰는 모든 commit 응답을 메인 편집기에 전달한다. 부모 행에 미저장 수정이 있는 상태에서 자식 행 저장이 성공하면 부모 수정이 0건이 된다. 관련 편집기에는 자신의 결과를 전달할 경로도 없다.

수정 방향: `editorId`, `commitId`, 전송 시점의 편집 버전을 응답과 연결한다. 성공한 스냅샷에 포함되고 그 뒤 바뀌지 않은 필드만 제거한다. 저장 중 추가 편집을 막는 정책을 선택해도 관련 테이블의 응답 분리는 필요하다.

완료 조건: 같은 필드 재편집, 다른 필드 추가 편집, 부모·자식 동시 수정, 관련 저장 실패에서 미전송 수정이 보존되고 해당 편집기만 갱신되어야 한다.

**R11 — 연결 방식에 따라 저장 검증 정책이 달라짐**

근거: [modelOrm.ts:945](src/modelOrm.ts#L945), [backendClient.ts:666](src/backendClient.ts#L666), [80_model_edit_query.pyfrag:28](python/backend_parts/80_model_edit_query.pyfrag#L28).

Socket 백엔드는 편집 가능 필드를 제한하고 `full_clean()` 후 변경 필드만 저장한다. ORM/Terminal용 코드는 식별자 형식만 확인해 값을 대입하고 `save()`를 호출한다. 같은 UI 작업인데 validator와 모델 검증 실행 여부가 달라진다.

실제 Django 모델에 `IntegerField(validators=[MinValueValidator(0)])`를 두고 `5 → -1`을 요청했다. Socket은 `ok=false`와 기존 값 `5`를 유지했지만, 생성된 ORM 코드는 실행 후 `-1`을 저장했다. DB 제약이 따로 없는 업무 규칙이 영향을 받는다.

수정 방향: 전송 방식과 관계없이 편집 가능 필드, 형 변환, 검증, 저장 대상 필드 정책을 통일한다. 읽기 쉬운 ORM 셀을 유지하면서도 동일한 검증 절차를 생성해야 한다.

완료 조건: field validator, `Model.clean()`, 편집 불가 필드, 검증 실패 시 rollback 결과가 Socket·ORM·Terminal에서 같아야 한다.

**R5 — 날짜·시간 편집이 시간대 정보를 제거함**

근거: [gridEdit.js:90](media/gridEdit.js#L90), [gridEdit.js:99](media/gridEdit.js#L99), [80_model_edit_query.pyfrag:60](python/backend_parts/80_model_edit_query.pyfrag#L60).

`datetime-local` 입력을 만들면서 offset과 소수초를 제거하고, 저장할 때 시간대를 복원하지 않는다. `USE_TZ=True`, `TIME_ZONE=Asia/Seoul`인 실제 Django/SQLite fixture에서 `2026-09-07T12:00:00+00:00`의 분을 01로 바꾸자 `2026-09-07T03:01:00+00:00`이 저장됐다. 편집 전 표시된 시각에서 1분을 바꿨는데 저장 시각은 9시간 어긋난다.

수정 방향: 표시·입력·저장의 기준 시간대를 명시하고 offset을 포함하는 값으로 왕복한다. 사용자가 변경하지 않은 정밀도도 보존한다.

완료 조건: UTC, +09:00, DST 전환 및 소수초가 있는 값에서 무수정 왕복과 1분 변경이 의도한 instant를 보존해야 한다.

**R10 — 다중 DB에서 atomic 저장이 실제 쓰기 DB를 보호하지 못함**

근거: [80_model_edit_query.pyfrag:46](python/backend_parts/80_model_edit_query.pyfrag#L46), [modelOrm.ts:948](src/modelOrm.ts#L948).

조회·저장은 Django router가 선택한 DB를 사용할 수 있지만, `transaction.atomic()`은 alias를 지정하지 않아 `default`에 열린다. read/write를 모두 `other`로 라우팅한 실제 SQLite fixture에서 두 행을 변경하고 두 번째 `save()`에 예외를 주입했다. 응답은 `ok=false`였지만 행 값은 `['new', 'old']`여서 첫 저장이 rollback되지 않았다. ORM 생성 코드도 alias 없는 atomic을 사용한다. 일반적인 단일 default DB에서 재현되는 문제라는 뜻은 아니다.

수정 방향: 쓰기 DB alias를 결정한 뒤 조회·검증·트랜잭션·저장을 같은 연결에 묶는다. 여러 DB를 한 번에 저장할 경우 단일 atomic 보장 여부를 명시하고, 보장할 수 없는 조합은 실행 전에 처리한다.

완료 조건: default와 routed DB 각각에서 두 번째 저장 실패 시 모든 변경이 rollback되어야 한다. read replica router도 별도 확인이 필요하다.

**R1 — 실행 여부가 불확실한 요청을 자동 재실행함**

근거: [backendClient.ts:699](src/backendClient.ts#L699), [backendClient.ts:743](src/backendClient.ts#L743), [backendClientResponses.ts:12](src/backendClientResponses.ts#L12), [00_bootstrap.pyfrag:458](python/backend_parts/00_bootstrap.pyfrag#L458).

Socket 오류 처리에서 연결 전 실패와 송신 후 실패를 구별하지 않고 PTY fallback을 실행한다. `execute`, `query`, `commit`도 대상이다. 서버가 실행을 마쳤으나 응답이 유실된 경우 같은 변경이 재실행될 수 있다. 백엔드에는 이 재시도를 식별해 중복 실행을 막는 요청 키가 없다.

모의 Socket이 `counter += 1` 요청을 받은 뒤 응답 없이 닫히도록 했다. 같은 코드가 PTY에도 전달되고 호출자는 성공을 받았다. 이 실험은 두 전송을 확인했으며, 실제 운영 DB의 중복 쓰기를 발생시킨 실험은 아니다.

수정 방향: 송신 전 실패와 실행 결과 불명 상태를 구분한다. 변경 가능 요청은 실행되지 않았음이 확인된 경우에만 자동 대체하거나, 두 전송에 공통인 요청 ID로 백엔드 중복 실행을 막는다.

완료 조건: 실행 후 응답 유실 시 실제 실행 횟수는 1회여야 한다. 연결 전에 거절된 요청의 정상 fallback도 유지해야 한다.

**R2 — 시간 초과한 ORM 응답이 다음 요청을 완료시킴**

근거: [notebookPtySession.ts:555](src/notebookPtySession.ts#L555), [notebookPtySession.ts:730](src/notebookPtySession.ts#L730).

literal ORM 셀은 35초 후 `pendingCell`을 제거하고 큐를 진행시킨다. 응답 수신은 ID가 매칭되지 않아도 현재 `pendingCell`을 완료한다. 첫 셀의 timeout을 발생시킨 뒤 두 번째 셀을 대기시키고 첫 셀의 늦은 marker를 전달하자, 두 번째 Promise가 첫 쿼리 데이터로 성공했다.

수정 방향: literal 셀에도 요청·세션 세대와 응답의 대응 관계를 보장한다. 응답을 구별할 수 없는 상태라면 timeout만으로 스트림을 재사용하지 말고 이전 실행 종료와 스트림 동기화를 확인해야 한다.

완료 조건: A timeout → B 시작 → A 늦은 응답 순서에서도 B가 A 데이터로 완료되면 안 된다. 중복 marker와 분할 응답도 같은 기준으로 검증한다.

**R3 — 재시작이 큐에 남은 이전 작업을 취소하지 않음**

근거: [notebookPtySession.ts:178](src/notebookPtySession.ts#L178), [notebookPtySession.ts:536](src/notebookPtySession.ts#L536), [notebookPtySession.ts:740](src/notebookPtySession.ts#L740), [asyncQueue.ts:17](src/asyncQueue.ts#L17).

재시작은 실행 중인 PTY 요청을 reject하지만 `SerializedAsyncQueue`의 대기 작업은 남긴다. 대기 작업이 시작할 때 이전 세대를 확인하지 않고 현재 `this.process`를 사용한다. 실행 중 A와 대기 중 B를 만든 뒤 재시작하자, A는 취소됐지만 B는 새 모의 PTY에 1회 전송됐다. 실제 새 셸에서는 초기 입력이 손상되거나 이전 작업이 실행될 수 있다.

수정 방향: enqueue 시 세대를 캡처하고 시작 전에 검사한다. 재시작·dispose 시 실행 중 및 대기 중 요청을 모두 정리할 수 있는 큐 취소 절차가 필요하다.

완료 조건: 재시작과 dispose 이후 이전 세대 작업의 추가 write가 0회이고, 대기 Promise도 모두 종료되어야 한다.

**R6 — 저장 예외가 웹뷰에 전달되지 않아 잠금이 유지됨**

근거: [modelBrowser.ts:255](src/modelBrowser.ts#L255), [modelBrowser.ts:748](src/modelBrowser.ts#L748), [modelBrowserSource.js:80](media/modelBrowserSource.js#L80).

저장 handler는 `modelCommit()`이 reject하면 완료 메시지를 보내지 않는다. 웹뷰 이벤트 등록도 반환 Promise를 `void`로 버려 예외를 처리하지 않는다. PTY 종료 예외를 주입했을 때 handler가 reject하고 commit 응답은 0개였다. 따라서 웹뷰의 `onCommitEnd`가 호출되지 않고 Reload 등 비활성 상태가 유지된다.

수정 방향: 모든 저장 경로에서 요청과 연결된 실패 또는 결과 불명 응답을 보내고 UI 상태를 정리한다. 전송 후 예외라면 미저장이라고 단정하거나 자동 재실행하지 않도록 R1과 함께 처리한다.

완료 조건: 연결 종료, timeout, 파싱 오류에서 편집 내용이 보존되고 UI 조작 가능 상태와 정확한 결과 상태가 복구되어야 한다.

**R7 — 병렬 조회 플래그가 비동기 중첩에 안전하지 않음**

근거: [backendClient.ts:288](src/backendClient.ts#L288), [extension.ts:135](src/extension.ts#L135).

공유 boolean을 임시로 바꿨다가 `finally`에서 이전 값으로 돌리는 방식이다. A(true), B(true)를 시작하고 A부터 종료하면 B 실행 중 flag=false가 되고, B까지 종료하면 flag=true가 남는다. 이 순서를 재현한 뒤 Socket이 없는 idle 상태에서 schema 조회를 요청하자, Python 실행 중에만 보여야 할 병렬 연결 필요 오류가 반환됐다.

수정 방향: 요청별 컨텍스트로 전달하거나 활성 범위를 정확히 집계한다. 서로 다른 요청의 `finally`가 상대 상태를 덮어쓰지 않아야 한다.

완료 조건: A→B 및 B→A 종료 순서, enabled=false 호출과의 중첩 모두에서 busy/idle 전송 정책이 유지되어야 한다.

**R8 — Cancel의 interrupt 응답 대기에 상한이 없음**

근거: [modelQueryRunController.ts:120](src/modelQueryRunController.ts#L120), [modelQueryRunController.ts:181](src/modelQueryRunController.ts#L181), [backendClient.ts:451](src/backendClient.ts#L451).

Cancel은 기존 timeout을 모두 없앤 뒤 interrupt 응답을 기다린다. interrupt의 Socket 연결이 성공한 후에는 응답 timeout이 없다. 응답하지 않는 interrupt를 주입하자 원래 쿼리를 정상 완료시켜도 cancelling이 유지되고 다음 실행은 busy가 됐다. 인터럽트 호출이 단순 reject하는 경우는 catch되므로, 연결됐지만 응답하지 않는 조건이 핵심이다.

수정 방향: interrupt 응답 대기에 별도 상한을 두고, 중단 확인 여부와 UI 요청 종료를 분리한다. 중단을 확인하지 못한 상태를 성공적인 중단으로 표시하면 안 된다.

완료 조건: interrupt 무응답·실패·늦은 응답에서 Cancel이 유한 시간 내 정리되고, 종료된 요청의 늦은 응답이 새 실행에 영향을 주지 않아야 한다.

**R9 — 프로세스 종료 후 연결 상태가 ready로 남음**

근거: [notebookPtySession.ts:137](src/notebookPtySession.ts#L137), [notebookPtySession.ts:215](src/notebookPtySession.ts#L215), [customConsole.ts:435](src/customConsole.ts#L435).

PTY exit handler가 client 객체를 지우지 않고 그 객체가 있으면 state를 ready로 설정한다. 연결된 모의 세션에 exitCode=1을 전달한 뒤 snapshot은 `ready=true`, `state=ready`, `mode=django`였다. PTY 안의 Python도 종료된 일반적인 상황에서 Console의 runtime reset 조건이 성립하지 않아 종료된 세션을 계속 사용하게 된다.

수정 방향: 프로세스 종료 시 실제 사용 가능한 backend/PTY 상태를 재평가하고 종료된 세션의 client, 실행·대기 요청, 포워딩 자원을 정리한다. Console까지 런타임 종료를 전파한다.

완료 조건: 정상 종료와 비정상 종료 모두에서 종료 상태가 전달되고 오래된 backend로 추가 요청이 나가지 않아야 한다.

**최초 검토의 권장 처리 순서**

1. 저장의 데이터 무결성: R4, R11, R5, R10. 저장 실패·성공 및 미저장 변경의 의미를 전송 방식 전체에서 일치시킨다.
2. 요청 실행과 응답의 대응: R1, R2, R3. 재전송 정책, 요청 ID, 세션 세대, 큐 취소를 함께 정리한다.
3. 장애 후 복구: R6, R7, R8, R9. 모든 비동기 종료 경로에서 편집 상태·실행 상태·연결 상태가 회복되도록 한다.

각 항목은 먼저 이 문서의 재현 조건을 회귀 테스트로 옮긴 뒤 수정하는 것이 적절하다. 큰 구조 개편과 묶기보다 각각의 실패 조건과 완료 조건을 닫는 변경으로 나눈다.

**수정 전 검토의 검증 기록과 한계**

- 재현 코드: `/private/tmp/django-shell-stability-audit-20260907.mjs`
- 구조화 결과: `/private/tmp/django-shell-stability-audit-20260907.json`
- 실행: 저장소 루트에서 `node /private/tmp/django-shell-stability-audit-20260907.mjs`
- 결과: 12개 시나리오 모두 기대한 결함을 재현, exit code 0. 이는 수정 후 정상 동작을 검증한 테스트 통과가 아니다.
- R5·R10·R11은 실제 Django와 메모리 SQLite DB를 사용했다. 나머지는 모의 VS Code/DOM/Socket/PTY, 제어 가능한 타이머·Promise를 사용한 호스트·상태 로직 검증이다. R4b의 웹뷰 응답 전달은 실제 host 응답, 소스 라우팅 확인, 편집기 상태 실험을 결합했다.
- 최초 검토 직전 코드 수정의 `npm run check` 기록은 841개 통과였다. 제품 소스를 수정하기 전에는 전체 검사를 반복하지 않고 위 장애 시나리오를 별도로 실행했다.
- 최초 검토는 실제 브라우저 렌더링, 설치된 확장본, 운영 DB, 실제 SSH/kubectl 단절, 장시간 메모리·CPU 부하 및 debugger/hot reload의 전체 생명주기를 검증하지 않았다. 위 11건이 앱의 모든 위험을 포괄한다는 뜻도 아니다.
