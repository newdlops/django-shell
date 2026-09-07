# 치명적 결함 추가 검토 — 2026-09-08

직전 안정성 수정이 포함된 작업 트리에서 **P1 5건과 P2 회귀 1건을 7개 격리 시나리오로 재현**했다. **2026-09-08 작업 트리에 6건의 수정과 회귀 테스트를 반영했다.** 기존 879개 검사에서 누락됐던 실제 Django 및 ORM Query 웹뷰 조건을 추가했다.

최초 검토는 HEAD `60d1c70`과 당시 미커밋 변경을 기준으로 했다. 기존 11건 검토에 이어 저장 대상의 식별, 사용자 코드의 자동 재실행, 취소 대상의 식별, 공용 웹뷰 프로토콜의 다른 소비자를 확인했다. P1은 잘못된 DB 변경이나 다른 실행 중단이 재현된 우선 수정 대상이고, P2는 저장 결과를 처리하지 못하는 기능 회귀다.

**수정 결과**

| ID | 현재 동작 | 회귀 검증 |
| --- | --- | --- |
| C5 | 명시적 Run만 입력 코드를 실행한다. 더 보기·Reload는 보존한 결과 ID를 사용하고, Link 변경·일반 런타임 갱신·재열기는 코드를 재실행하지 않는다. 실제 런타임 교체는 결과와 편집 대상을 무효화한다. | [실제 Python 결과 핸들](test/criticalQueryBackend.test.mjs), [Query 호스트](test/criticalQueryHost.test.mjs) |
| C4 | 실행 ID와 원래 BackendClient로 취소를 전달한다. 실행 전·기능 로드 중·Python lock 대기·PTY 대기에서 취소한 요청은 실행하지 않는다. 실행 중 쿼리는 자신의 체크포인트에서 중단한다. | [Python 스레드](test/criticalQueryBackend.test.mjs), [런타임 교체](test/criticalQueryHost.test.mjs), [PTY](test/notebookPtyStability.test.mjs), [전송](test/backendTransportStability.test.mjs) |
| C2 | JavaScript 안전 범위를 넘는 정수는 Python에서 문자열로 직렬화한다. 기본키·커서·FK 선택·choice 값의 정확성을 유지하고, 부정확한 정수 PK 저장은 거절한다. | [실제 Django와 JS 파서의 왕복](test/criticalModelIdentity.test.mjs) |
| C1 | 생성 ORM의 루트 모델과 구조화된 Subquery·M2M 참조는 app label을 보존해 registry에서 모델을 선택한다. 사용자가 직접 쓴 raw annotation 표현은 그대로 유지한다. | [동명 모델 실제 조회·저장](test/criticalModelIdentity.test.mjs), [ORM 생성](test/modelBrowser.test.mjs) |
| C3 | 명시적 `using()` DB를 Query 결과→관련 행→저장까지 보존한다. 명시하지 않은 QuerySet은 기존 read replica→write primary 라우터 정책을 유지한다. 혼합 DB 목록과 저장 대상을 확정할 수 없는 iterator 결과는 읽기 전용이다. | [DB별 실제 저장·관련 행·라우터](test/criticalModelIdentity.test.mjs), [혼합 DB 목록](test/criticalQueryBackend.test.mjs) |
| C6 | 두 호스트가 공통 저장 응답 처리기를 사용한다. main·related 저장의 성공·실패 모두 editorId·commitId를 반환하고, 닫힌 Query 패널의 늦은 응답은 새 패널로 보내지 않는다. | [Query 호스트와 실제 편집기](test/criticalQueryHost.test.mjs), [두 실제 웹뷰](test/e2e/suite/modelStabilityWebview.js) |

실제 ORM Query 웹뷰 검사에서 반복 실행 상태 알림이 Reload의 활성 상태를 덮어쓰는 문제도 발견해 수정했다. `running → running → slow → cancelling`을 거쳐도 원래 상태를 복원하며, 확인되지 않은 타임아웃을 중단 완료로 표시하지 않는다. [상태 회귀 테스트](test/queryRunUiStability.test.mjs)

**수정 후 검증과 제한**

- `npm run check`: **909개 통과, 실패·취소·건너뜀 0**. 코드 규칙 검사와 TypeScript·웹뷰 빌드를 포함한다. 기존 879개에 회귀 시나리오 30개를 추가했다.
- 임시 프로필의 VS Code에서 Model Browser와 ORM Query 웹뷰 모두 저장 성공, 저장 중 새 편집, 실패 후 재시도, 날짜 정밀도, 관련 행 저장, 부모 draft 유지 검사를 통과했다. 모의 데이터 소스를 사용했으며 실제 Django 저장 검증은 위 Python 테스트에서 별도로 수행했다.
- `1.1.1000050` 릴리스 준비에서 VS Code 1.134.0/macOS arm64의 전체 `npm run test:e2e`도 통과했다. AI Assist·property 재조회·두 저장 웹뷰·Console 실행과 출력·Python 자동완성·테마·hover·입력 지연 검사를 포함한다. 사용자 확장을 분리하고 로컬 포트 후크를 제외한 환경에서 실행했다. 테스트의 설정 복원, 키보드 이벤트, 분석 파일 작성, 화면 스크롤과 포커스 전제를 보완했으며 기존 성공 조건과 응답 시간 기준은 유지했다.
- 최초 수정 검사 로그: `/private/tmp/django-shell-critical-check.log`. 두 웹뷰 검사 로그: `/private/tmp/django-shell-stability-isolated-e2e.log`. 릴리스 전체 검사 로그: `/private/tmp/django-shell-release-check.log`, `/private/tmp/django-shell-release-e2e.log`.
- 연결된 브라우저가 없어 화면 크기별 시각 검증은 수행하지 못했다. E2E는 격리된 개발 확장을 대상으로 했다. 설치된 확장본의 실제 프로젝트 동작, 운영 DB, 실제 SSH/kubectl 장애, 장시간 부하는 이번 소스 수정 검증 범위에 포함하지 않는다.
- 취소는 진행 중 DB 드라이버 호출의 즉시 중단이나 이미 수행한 변경의 롤백을 보장하지 않는다. 아직 중단되지 않았으면 확인되지 않은 상태와 복구 안내를 반환한다.
- 결과 핸들은 최대 8개·마지막 접근 후 30분, iterator 페이지는 최대 8개를 보존한다. 만료·해제된 결과는 사용자가 Run을 다시 눌러야 하며 자동 재실행하지 않는다.

**수정 전 재현 기록**

아래 표와 분석은 최초 검토 시점의 재현 기록이다. 줄 번호·수정 방향·완료 조건은 당시 코드를 가리키며, 현재 구현과 검증 결과는 위 내용을 기준으로 한다.

| 우선순위 | ID | 재현한 결함 | 관측 결과 |
| --- | --- | --- | --- |
| P1 | C5 | ORM Query 코드가 Run 외 동작에서도 재실행됨 | Run 1회 후 런타임 갱신·더 보기·Link 변경·패널 재열기로 DB INSERT 총 5회 |
| P1 | C4 | Cancel이 취소할 요청을 식별하지 못함 | 실행 중 쿼리를 놓쳐 취소 후 저장. 다른 Console 셀이 실행 중이면 그 셀을 중단하고 취소한 쿼리는 실행 |
| P1 | C2 | 큰 정수 PK가 JavaScript 숫자로 반올림됨 | PK `9007199254740993` 행을 편집했는데 `9007199254740992` 행이 변경되고 성공 반환 |
| P1 | C1 | ORM/Terminal의 모델 참조가 app label을 버림 | `critical_beta.Record` 작업으로 `critical_alpha.Record` 조회·저장 |
| P1 | C3 | 명시적으로 선택한 QuerySet DB가 저장 요청에서 사라짐 | `using('archive')` 결과를 편집했는데 `default` DB의 같은 PK 행이 변경 |
| P2 | C6 | ORM Query 창이 새 commit 식별자를 응답하지 않음 | 저장 성공 응답이 무시되어 `isCommitting=true`, pending=1 유지 |

**C5 — 결과 화면 갱신이 사용자 코드 전체를 다시 실행한다**

근거: [ModelQueryConsole의 runtime refresh](src/modelQueryConsole.ts#L458), [ready·loadMore·setTransport 처리](src/modelQueryConsole.ts#L142), [leading statements 실행](python/backend_parts/80_model_edit_query.pyfrag#L201), [일반 Console 실행 뒤 runtime 이벤트](src/customConsole.ts#L808).

ORM Query는 마지막 표현식 앞의 코드도 실행한다. 예를 들어 `Action.objects.create(...)` 뒤에 `Action.objects.order_by('pk')`를 둔 입력은 정상 지원되는 코드다. 그런데 `lastCode`를 실행 결과의 식별자처럼 사용해 런타임 갱신, 페이지 추가, Link 변경, 패널 재열기마다 입력 전체를 다시 실행한다. 런타임 갱신은 일반 Console에서 다른 셀을 실행한 뒤에도 발생하므로 커널을 바꾸지 않아도 영향을 받는다.

실제 `ModelQueryConsole`에 VS Code 메시징 경계만 모의하고, 각 `modelQuery` 호출은 실제 Django와 임시 파일 SQLite로 전달했다. Run은 한 번만 호출했다. 이어 위 네 이벤트를 전달하자 DB 행 수가 `1 → 2 → 3 → 4 → 5`가 됐다. 전송 실패나 재시도 없이 발생한 중복 실행이다.

수정 방향: 명시적인 Run과 결과 갱신을 분리한다. 페이지 추가는 같은 실행 결과의 핸들 또는 명시적으로 보존한 조회를 대상으로 수행하고, 일반 Python 입력을 자동 재실행하지 않는다. 임의 코드가 읽기 전용인지 단순 문자열 검사로 판단해서는 안 된다.

완료 조건: Run 1회 이후 런타임 이벤트·패널 재열기·Link 변경·페이지 추가로 leading statement의 실행 횟수가 증가하지 않아야 한다. 새 Run만 새 실행을 만들어야 한다.

**C4 — 취소가 쿼리를 놓치거나 다른 Console 셀을 중단한다**

근거: [실행 스레드를 등록하지 않는 `_browse_query`](python/backend_parts/80_model_edit_query.pyfrag#L186), [하나의 전역 thread ID를 중단하는 `_interrupt_execution`](python/backend_parts/30_debug_progress.pyfrag#L74), [요청 ID 없이 reason만 보내는 interrupt](src/backendClient.ts#L451), [활성 backend에 query를 보내는 경로](src/extension.ts#L106).

일반 execute는 `_execution_mark_active()`를 호출하지만 query 경로는 호출하지 않는다. interrupt는 요청 ID 없이 `_STATE['execution_thread_id']` 하나만 조회한다. 기존에 추가한 중단 응답 대기 상한은 이 대상 선택 문제를 해결하지 않는다.

두 조건을 실제 Python 스레드와 Django/파일 SQLite로 재현했다.

- 쿼리 실행 중 Cancel: 응답은 `ok=true`, `interrupted=false`, `No Python execution is running.`이었다. 쿼리는 실행 잠금을 계속 보유했고, 테스트용 대기를 해제하자 `saved after cancel` 행을 INSERT하고 성공했다.
- Console 셀이 실행 중이고 Query가 실행 잠금을 기다리는 상태에서 Query Cancel: interrupt는 `interrupted=true`를 반환했지만 **Console 셀이 중단**됐다. Console의 첫 INSERT만 남고 두 번째 단계는 수행되지 않았다. 취소하려던 Query는 이어 실행되어 `cancelled query still wrote` 행을 INSERT했다.

수정 방향: 전송 방식과 화면에 걸쳐 요청별 실행 소유권을 관리한다. 실행 중 요청뿐 아니라 큐에서 대기 중인 요청도 ID로 취소해야 한다. 취소 대상이 바뀌었으면 다른 작업을 중단하지 않아야 하며, 중단 요청 접수와 실제 종료 확인을 구분해야 한다.

완료 조건: Query A의 취소가 Console B에 영향을 주지 않고, 취소된 대기 요청 A가 나중에 실행되지 않아야 한다. 늦은 interrupt와 런타임 변경에서도 같은 보장이 필요하다.

**C2 — 정수 PK 정밀도 손실로 다른 행을 저장한다**

근거: [정수를 JSON 숫자로 반환하는 `_browse_cell`](python/backend_parts/50_model_core.pyfrag#L527), [rows JSON 파서](src/modelBackend.ts#L499), [row의 PK를 보존하는 위치](media/modelBrowserSource.js#L418), [staged edit의 PK 수집](media/gridEdit.js#L122).

Python의 큰 정수를 JSON 숫자로 보내고 JavaScript `JSON.parse()`로 읽는다. JavaScript가 정확히 표현하지 못하는 정수는 이 경계에서 이미 바뀐다. 기본키뿐 아니라 cursor와 FK 선택 값에도 같은 숫자 표현을 사용한다.

실제 Django/SQLite에 PK `9007199254740992`와 `9007199254740993` 두 행을 만들었다. 실제 백엔드 rows JSON을 현재 호스트 파서로 읽자 두 PK가 모두 `9007199254740992`가 됐다. 이름이 `second`인 두 번째 행의 PK로 저장을 요청했는데 첫 번째 행만 `edited second`로 변경됐고 백엔드는 성공을 반환했다.

수정 방향: PK·FK·cursor를 왕복 가능한 표현으로 전달한다. 안전 범위를 넘는 정수는 문자열 또는 타입 태그를 사용하고, Python에서 원래 필드 타입으로 복원한다. 이미 반올림된 값을 문자열로 바꾸는 프런트엔드 수정만으로는 해결되지 않는다.

완료 조건: 인접한 큰 PK, 음수 큰 정수, FK 선택·필터·페이지 cursor에서 값이 정확히 왕복하고 선택한 행만 저장되어야 한다.

**C1 — 같은 모델 이름을 가진 다른 앱을 조회·저장한다**

근거: [app 인자를 사용하지 않는 `modelRef`](src/modelOrm.ts#L44), [이미 존재하는 bare name을 유지하는 auto-import](python/backend_parts/00_bootstrap.pyfrag#L339), [생성된 저장 코드](src/modelCommitOrm.ts#L10).

ORM/Terminal의 생성 코드는 `(app, model)` 중 모델의 bare class name만 사용한다. auto-import는 이름이 이미 바인딩돼 있으면 덮어쓰지 않는다. 서로 다른 앱에 같은 이름의 모델이 있거나 사용자가 셸의 모델 변수를 재바인딩하면 요청의 app label과 실제 클래스가 달라질 수 있다. 패널은 요청한 모델 이름으로 표시된다.

같은 `Record` 이름의 모델을 `critical_alpha`, `critical_beta` 두 앱에 등록하고 각각 PK=1 행을 만들었다. 현재 auto-import가 `Record=critical_alpha.Record`를 바인딩한 상태에서 beta용 rows와 commit 코드를 생성·실행했다. 조회 모델과 저장 대상은 모두 alpha였고, beta 원본은 그대로 남았다.

수정 방향: 실제 모델의 `_meta.label_lower`를 요청한 app/model과 대조하거나 정확한 registry 모델에 연결한 안전한 별칭을 사용한다. 일치하지 않으면 실행 전에 거절한다. 셸 히스토리의 읽기 쉬운 표현과 대상 식별 보장을 함께 유지해야 한다.

완료 조건: 같은 이름의 모델 두 개와 사용자 namespace 재바인딩에서 조회·저장이 정확한 앱 모델을 대상으로 수행되거나 실행 전에 명확히 실패해야 한다.

**C3 — `using()`으로 조회한 DB와 저장 DB가 다르다**

근거: [DB alias를 포함하지 않는 editable query 결과](python/backend_parts/80_model_edit_query.pyfrag#L271), [app/model만 기억하는 Query Console](src/modelQueryConsole.ts#L215), [DB 정보 없는 저장 요청](src/modelQueryConsole.ts#L432), [router로 alias를 새로 선택하는 저장](python/backend_parts/80_model_edit_query.pyfrag#L13).

`Record.objects.using('archive').all()`의 결과는 editable로 반환되지만 원본 QuerySet의 DB는 저장 경로로 전달되지 않는다. commit은 router의 쓰기 DB를 새로 선택하므로 기본 router에서는 `default`가 된다. 최근 추가한 atomic과 row lock은 선택된 쓰기 DB 안에서 작동하지만, 잘못된 DB를 선택하는 문제까지 막지는 못한다.

`default`와 `archive`에 동일 PK=1, 서로 다른 이름을 가진 행을 만들었다. 실제 Query 결과는 `archive original`, editable=true였다. 결과가 제공한 app/model/PK로 commit을 실행하자 `default` 행만 `edited archive`로 변경됐고 archive 행은 그대로였다.

수정 방향: 명시적인 원본 DB 선택을 읽기 결과와 저장 요청에 연결하거나, 저장 대상 DB를 확정할 수 없는 결과는 편집 불가로 반환한다. 일반적인 read replica → write primary 정책과 사용자가 명시한 별도 데이터베이스 선택을 구분해야 한다.

완료 조건: 다른 DB에 같은 PK가 존재해도 사용자가 조회·편집한 데이터의 저장 대상이 바뀌지 않아야 한다. 명시적 `using()`, router, 관련 행, 여러 DB의 결과가 섞인 경우를 확인해야 한다.

**C6 — 직전 저장 프로토콜 변경이 ORM Query 창에는 적용되지 않았다**

근거: [editorId·commitId를 요구하는 공용 편집기](media/gridEdit.js#L261), [ID를 반환하지 않는 Query main commit](src/modelQueryConsole.ts#L428), [Query related commit](src/modelQueryConsole.ts#L438).

직전 수정에서 `ModelBrowserPanel`은 새 식별자를 반환하도록 바꿨지만, 동일한 웹뷰·편집기를 쓰는 `ModelQueryConsole`은 기존 `{type:'commit', result}` 응답을 유지한다. 이 소비자를 함께 확인하지 못한 회귀다. Promise reject 처리 누락도 이 경로에는 남아 있다.

실제 공용 편집기로 수정·저장 요청을 만들고 현재 Query 호스트에 전달했다. 모의 저장 백엔드는 한 번 호출되고 성공을 반환했다. 그러나 실제 host 응답에는 두 ID가 없었고, 편집기는 응답을 거절해 `isCommitting=true`, pending=1을 유지했다. 기존의 main Model Browser 웹뷰 저장 E2E는 이 별도 Query 창을 포함하지 않았다.

수정 방향: 두 호스트가 공통 저장 응답 계약과 예외 처리를 사용하도록 한다. Query 창의 main·related 저장, 실패·재시도, 패널 교체 중 늦은 응답을 별도로 검증한다.

완료 조건: 모든 저장 소비자가 같은 식별자를 왕복하며 성공·실패 모두 해당 편집기의 pending 상태를 정상 종료해야 한다.

**최초 재현 검증 기록과 범위**

- 재현 스크립트: `/private/tmp/django-shell-critical-audit-20260908.mjs`
- 결과: `/private/tmp/django-shell-critical-audit-20260908.json`
- 로그: `/private/tmp/django-shell-critical-audit-20260908.log`
- 실행: 저장소 루트에서 `node /private/tmp/django-shell-critical-audit-20260908.mjs`
- 결과는 7개 결함 시나리오의 재현 확인, exit code 0이다. 수정 후 정상 동작 테스트의 통과를 뜻하지 않는다.
- C1~C4는 현재 Python 백엔드와 생성 ORM을 실제 Django/격리 SQLite에서 실행했다. C2는 현재 JavaScript 응답 파서까지 통과했다. C4의 두 시나리오는 실제 Python 스레드와 비동기 interrupt를 사용했다.
- C5는 현재 Query 호스트와 실제 Django/임시 파일 SQLite를 결합했으며 VS Code 메시징 경계만 모의했다. C6는 현재 호스트와 실제 편집기 코드를 DOM fixture 및 모의 저장 응답으로 실행했다.
- 제품 코드는 변경하지 않았다. 기존 879개 검사를 반복하는 대신 누락된 실패 조건을 별도 재현했다. 이번 검토는 설치된 확장본·실제 웹뷰 렌더링·운영 DB·실제 SSH/kubectl 세션을 대상으로 한 검증이 아니다.

위 재현 조건을 회귀 테스트로 옮겼으며, 수정 후 검증 결과는 문서 상단에 기록했다.
