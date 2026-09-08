# 추가 안전성·기능·성능 검토 — 2026-09-08

기준은 HEAD `ab335eb5e2f63325213083f75aa734172cdc740b`에 직전 A1–A6 수정이 반영된 작업 트리다. 후속 수정 요청에 따라 **B1–B8을 모두 수정하고 회귀 검증을 완료했다.** 아래는 소스 수정 단계의 검증 기록이며, 이 변경을 `1.1.1000051` 릴리스에 포함한다.

릴리스 준비에서도 `npm ci` 이후 `npm run check` **966개 통과**와 **전체 `npm run test:e2e` exit code 0**을 확인했다. E2E에서 발견한 비활성 테스트 창과 시간 측정 경계 문제는 테스트가 소유한 VS Code 프로세스의 창만 활성화하고, 웹뷰 배치 안정화를 기다리며, 자동완성의 첫 표시 시점을 렌더러 안에서 기록하도록 보완했다. 기존 500ms 자동완성 기준과 저장 결과 단언은 유지했다. 최종 로그: [전체 검사](/private/tmp/django-shell-release-1000051-check.log), [전체 E2E](/private/tmp/django-shell-release-1000051-e2e.log).

## 수정 결과

| ID | 반영한 동작 | 주요 검증 |
| --- | --- | --- |
| B1 | 명시적 DB를 관계 Open, 다음 관계 이동, 행·property·count·aggregate 조회, Recipe, FK 검색, 저장까지 전달한다. ORM 표시와 SQL 수집도 선택한 DB를 따른다. 명시적 alias가 없으면 기존 router 선택을 유지한다. | 두 메모리 DB의 동일 PK, 실제 Socket 함수/생성 ORM, 실제 Query→Model Browser 호스트의 두 번 관계 이동 |
| B2 | JSONField의 편집 원문과 종류를 전달하고, 최상위 스칼라도 Socket/ORM에서 JSON으로 해석한다. JSON 문자열은 따옴표를 포함해 편집한다. | 숫자·불리언·nullable null·문자열·배열·객체·큰 정수의 저장 값과 Python 타입 일치 |
| B3 | Decimal 입력을 float 리터럴로 바꾸지 않고 문자열로 Django 검증에 전달한다. | `0.10`, `1.23`, 음수, 정상 금액 저장 및 초과 정밀도 거절 |
| B4 | 인증 전 입력에 5초 절대 기한과 4MiB 제한을 두고, 입력 대기 16개·일반 처리 8개·제어 처리 4개로 제한한다. 출력 캡처는 스트림당 1MiB, 응답은 16MiB로 제한하며 완전한 JSON 오류를 반환한다. | 실제 loopback 서버의 잘못된 토큰·과대 입력·유휴 연결·슬롯 회복, 일반 처리 포화 중 progress 응답, 과대 응답 후 실행 재전송 방지, UTF-8/서로게이트 처리 |
| B5 | 생성·metadata·login PATH 출력에 UTF-8 스트림 decoder를 사용하고 바이트 예산을 따로 계산한다. | 한글·이모지의 모든 바이트 분할 경계에서 생성/metadata 원문 보존 |
| B6 | 취소·시간 초과·출력 초과 시 소유한 프로세스 그룹에 종료를 요청하고, 500ms 유예 뒤 강제 종료·파이프 정리를 수행한다. Windows는 `taskkill /T /F` 경로를 사용한다. | macOS의 실제 SIGTERM 무시 자식과, 부모 종료 뒤 출력 파이프를 보유한 하위 프로세스 회수 |
| B7 | 하나의 유휴 만료 타이머, 결과당 32MiB·전체 64MiB의 보유 크기 추정 예산, 명시적 `releaseQuery`를 추가했다. 원래 결과를 소유한 백엔드에 해제를 보내며 진행 중 페이지는 만료에서 보호한다. | 다음 쿼리 없이 객체 해제, 크기 초과/오래된 결과 제거, namespace 소유권, 런타임 교체 뒤 원래 백엔드 해제, 패널 재열기와 늦은 응답 해제, 제너레이터 페이지 재사용 |
| B8 | 셀은 배열 종류·길이 메타데이터를 읽고, 이전 형식은 항목 수만 캐시한다. 편집기는 50행씩 표시하며 객체 키가 12개를 넘으면 항목별 JSON 컨트롤을 사용한다. | 실제 두 웹뷰의 1만 항목 편집·페이지 이동·추가·삭제·저장, 큰 정수 보존, 페이지 변경/삭제 후 키보드 포커스 유지 |

검증 결과:

- `npm run check`: **966개 통과, 실패·건너뜀 0개**. 프로젝트 코드 지침, TypeScript 컴파일, 렌더러 빌드 포함. [전체 로그](/private/tmp/django-shell-additional-check.log)
- `npm run test:e2e:model-browser`: **exit code 0**. 기존 Query Builder·property·ORM Query 시나리오와 새 Model Browser/Query 배열 시나리오를 실제 VS Code 개발용 웹뷰에서 통과했다. 두 배열 시나리오의 웹뷰 크기는 각각 **792×508**이었다. [E2E 로그](/private/tmp/django-shell-additional-e2e.log)
- 모의 DOM 계측에서 1만 정수 배열의 열기 노드 할당은 **60,123 → 427개**, 한 항목 추가는 **60,012 → 12개**였다. 추가 시 새 마지막 페이지로 이동하는 조건이며, 이는 브라우저 프레임·레이아웃 시간 측정이 아니다. 메타데이터가 있는 셀은 전체 JSON 원문에 접근하지 않는 회귀 테스트도 통과했다. [수정 후 계측](/private/tmp/django-shell-additional-fixed-performance.mjs), [결과](/private/tmp/django-shell-additional-fixed-performance.json)
- `git diff --check`: 통과.

회귀 테스트는 [데이터 정확성](test/additionalDataIntegrity.test.mjs), [호스트 소유권](test/additionalHostOwnership.test.mjs), [백엔드 자원 제한](test/backendResourceLimits.test.mjs), [프로세스 회수](test/assistantProcessLifecycle.test.mjs), [캐시 수명](test/queryCacheResources.test.mjs), [배열 표시 비용](test/gridArrayPerformance.test.mjs), [실제 웹뷰](test/e2e/suite/modelIntegrityWebview.js)에 추가했다.

검증 한계: 저장 검증은 격리된 Django/SQLite를 사용하고, 웹뷰의 DB·AI 경계는 제어된 fixture를 사용했다. 운영 DB·실제 AI 제공자·Windows 실행·장시간 부하는 검증하지 않았다. 연결 가능한 별도 브라우저가 없어 화면 크기별 시각 검증은 수행하지 않았다. 캐시 예산은 보유한 일반 컨테이너·모델 값·직렬화 페이지의 **추정치**이며 사용자 namespace나 임의 iterator 내부까지 포함한 프로세스 전체 메모리 상한은 아니다. 배열 편집 시작·저장 시 전체 JSON 파싱·직렬화 비용은 남는다.

## 수정 전 검토 기록

아래는 수정 전에 확인한 재현 결과와 당시 수정 방향이다. 현재 남아 있는 결함 목록과 구분한다.

P1은 잘못된 DB 또는 타입으로 저장될 수 있어 우선 수정할 항목, P2는 조건부 자원 고갈 위험·기능 오류·성능 개선 항목이다. 기존 수정으로 해결된 경로를 다시 결함으로 계산하지 않았다. B1은 기존 DB 전달 수정에서 빠진 별도 Open 경로이고, B2는 기존 구조화 JSON 수정에서 다루지 않은 최상위 스칼라 경로다.

| 우선순위 | ID | 확인한 문제 | 재현·측정 결과 |
| --- | --- | --- | --- |
| P1 | B1 | 관계 Open 시 명시적 DB 선택이 사라짐 | `archive`에서 연 링크가 `default` 행을 조회하고 저장 |
| P1 | B2 | JSON 스칼라 편집이 문자열로 저장됨 | `123`·`false`·`null` 모두 Python `str`로 저장되고 성공 반환 |
| P2 | B3 | ORM/Terminal Decimal 저장이 정상 입력을 거절 | `0.10`·`1.23`은 실패, Socket에서는 정상 저장 |
| P2 | B4 | 인증 전 연결·입력 크기 제한 및 출력 예산 부족 | 토큰 없는 연결 16개가 읽기 제한 시간 없는 스레드 16개 점유 |
| P2 | B5 | AI CLI 출력이 UTF-8 문자 중간에서 나뉘면 손상 | `서울` → `���울`, JSON 자체는 여전히 유효 |
| P2 | B6 | AI CLI 타임아웃·취소 후 프로세스 종료를 보장하지 않음 | SIGTERM을 무시하는 자식이 timeout 반환 뒤에도 살아 있음 |
| P2 | B7 | 결과 캐시가 유휴 상태에서 만료 객체를 계속 보유 | 만료시킨 4MiB 결과가 다음 쿼리 등록 전까지 유지 |
| P2 | B8 | 배열 셀 중복 파싱과 편집기의 전체 DOM 재생성 | 30개 셀 확인 약 198ms, 1만 항목 편집 시 노드 약 6만 개 |

## B1 — 관계 Open 후 다른 DB의 행을 조회·저장

근거: [Open 메시지](media/modelBrowserSource.js#L593), [Query 호스트의 명령 전달](src/modelQueryConsole.ts#L189), [Model Browser 조회 요청](src/modelBrowser.ts#L375), [일반 셀 저장의 DB 선택](src/modelBrowser.ts#L767).

Query 결과의 `current.database`에는 `archive`가 남아 있지만 `openModel` 명령에는 app/model/필터만 전달한다. 새 Model Browser의 target과 조회 요청은 DB를 보존하지 않고, 일반 셀 저장도 명시적 DB를 전달하지 않는다. 관계 펼치기·검색·현재 Query 표에서 직접 저장하는 경로와 구분되는 문제다.

실제 Query 호스트에서 `current.database='archive'`로 설정하고 Company의 `code='001'` 관계 Open 메시지를 전달했다. 명령을 실제 Model Browser 호스트에 연결했으며, 조회·저장은 실제 Python 백엔드와 두 개의 격리된 메모리 SQLite DB에서 실행했다. 두 DB에 동일한 PK와 code를 가진 행을 두었다.

- 새 표의 조회 결과: `default Company`.
- 저장 요청의 `database`: 누락.
- 저장 후: default=`edited through archive link`, archive=`archive Company`.

수정 방향: DB 선택을 관계 Open → 명령 target → Recipe/조회·관련 조회 → 저장까지 연결한다. DB를 확정할 수 없는 상태는 쓰기 전에 처리해야 한다. 단순히 저장 요청에만 alias를 붙이면 이미 잘못 조회한 값을 다른 DB에 저장할 수 있으므로 조회부터 수정해야 한다.

완료 기준: 두 DB의 동일 PK·alternate key, 두 번 이상 관계 이동, 재조회·추가 페이지·편집에서 명시적 DB가 유지되어야 한다. 일반 router의 read replica/write primary 정책은 별도로 보존한다.

## B2 — JSON 최상위 숫자·불리언·null의 타입이 바뀜

근거: [텍스트 편집 컨트롤](media/gridEdit.js#L10), [Socket JSON 변환](python/backend_parts/80_model_edit_query.pyfrag#L91), [생성 ORM의 구조화 JSON 판별](src/modelOrm.ts#L910).

JSONField 편집 문자열 중 `[` 또는 `{`로 시작하는 값만 JSON으로 파싱한다. 최상위 숫자와 불리언은 일반 텍스트 컨트롤을 거쳐 문자열로 전달되고, 양쪽 저장 경로가 이를 그대로 JSON 문자열 값으로 저장한다. 앞선 큰 정수 수정은 컨테이너 내부의 정밀도를 해결했지만 이 타입 구분은 남아 있다.

실제 `JSONField(null=True, blank=True)`의 숫자 값을 편집하는 요청을 양쪽 저장 경로에 전달했다.

| 입력 텍스트 | 저장 후 Python 값 | 타입 | 결과 |
| --- | --- | --- | --- |
| `123` | `'123'` | `str` | 성공 |
| `false` | `'false'` | `str` | 성공 |
| `null` | `'null'` | `str` | 성공 |
| `"hello"` | `'"hello"'` — 따옴표까지 내용에 포함 | `str` | 성공 |

수정 방향: JSON 편집 값의 원문·타입을 명확한 계약으로 전달하고, 스칼라까지 동일하게 파싱한다. 기존 JSON 문자열을 편집하는 동작과 nullable 필드의 빈 값 처리도 함께 정의해야 한다.

완료 기준: 숫자·불리언·null·문자열·배열·객체 모두에서 Socket/ORM 저장 후 값과 타입이 일치해야 한다. 현재 큰 정수 보존도 유지해야 한다.

## B3 — Decimal 값이 float 리터럴을 거쳐 정상 저장에 실패

근거: [숫자 편집값의 Python 리터럴 생성](src/modelOrm.ts#L939), [생성 ORM의 검증](src/modelCommitOrm.ts#L12).

`DecimalField`에도 bare Python 숫자 리터럴을 사용한다. 소수는 먼저 이진 부동소수점이 되며, 이후 Django Decimal 검증에서 불필요한 소수 자릿수가 나타날 수 있다. Socket 경로는 원래 문자열을 `field.to_python()`에 전달하므로 이 차이가 없다.

`DecimalField(max_digits=10, decimal_places=2)`에서 기존 값 `9.99`를 변경했다. Socket은 `0.10`, `1.23`, `2.50`을 모두 저장했다. 생성 ORM은 `0.10`·`1.23`에 `Ensure that there are no more than 2 decimal places.` 오류를 반환했고 기존 `9.99`가 유지됐다. `2.50`은 양쪽 모두 성공했다. 이 재현은 저장 거절이며, Decimal 오저장이 발생했다고 주장하는 결과는 아니다.

수정 방향: Decimal 입력은 문자열 또는 `Decimal('…')`로 전달해 float 변환을 제거한다. 완료 기준은 일반 금액·음수·고정밀 소수·검증 실패의 전송 간 일치다.

## B4 — 인증 전 자원 제한과 출력 크기 예산 부족

근거: [접속마다 생성하는 스레드](python/backend_parts/00_bootstrap.pyfrag#L57), [길이 제한 없는 readline](python/backend_parts/00_bootstrap.pyfrag#L101), [파싱 후 토큰 검사](python/backend_parts/00_bootstrap.pyfrag#L458), [Query 출력 캡처](python/backend_parts/80_model_edit_query.pyfrag#L198), [클라이언트 응답 누적](src/backendClient.ts#L748).

인증은 JSON 한 줄을 모두 읽고 파싱한 뒤 수행된다. 서버에는 연결별 입력 제한 시간·프레임 길이·동시 핸들러 수 제한이 없다. 기본 바인딩은 `127.0.0.1`이므로 기본 구성에서 외부 네트워크 공격이 가능하다는 뜻은 아니다. 별도 설정으로 외부 주소에 바인딩하면 접근 가능한 범위가 넓어진다.

- 실제 handler에 잘못된 토큰을 포함한 2,097,201바이트 요청을 전달했다. `readline()`에 크기 인자가 없었고 전체를 읽은 뒤 토큰을 거절했다.
- 임시 loopback 서버에 데이터·토큰을 보내지 않는 연결을 16개만 열었다. 실제 handler 스레드 16개가 유지됐고 accepted socket timeout은 모두 `None`이었다. 검사 후 모든 연결과 handler를 회수했다.
- 격리된 Query에서 2,000,001자 stdout이 잘리지 않고 응답에 포함됐다. 클라이언트도 줄바꿈을 받을 때까지 문자열을 누적하며 바이트 상한이 없다.

확인한 위험은 메모리·스레드 소진과 대형 응답 처리다. 잘못된 토큰은 정상 거절되었고 인증 우회나 비인증 코드 실행을 재현한 것은 아니다. 실제 서비스 고갈을 일으키는 부하 검사는 수행하지 않았다.

수정 방향: 인증 전 read deadline, 요청/응답 바이트 예산, 동시 연결 제한, bounded stdout/stderr 캡처를 도입한다. 정상적인 장기 쿼리 실행 시간과 인증 전 입력 대기 시간을 구분하고, 취소·디버거 제어 요청이 자원 제한 때문에 막히지 않도록 설계한다. 응답 제한은 JSON 자체를 중간에 잘라 손상시키지 않아야 한다.

## B5 — AI CLI의 UTF-8 출력 경계 처리 오류

근거: [생성 stdout 청크 변환](src/modelQueryAssistantCli.ts#L80), [metadata stdout/stderr 청크 변환](src/modelQueryAssistantCli.ts#L107).

각 Buffer 청크를 별도로 `toString()` 처리한다. UTF-8 한 문자가 두 청크에 걸치면 원래 바이트가 대체 문자로 바뀐다. 이는 JSON 파싱 성공만으로 검출되지 않아 한글 필터 값·설명 등이 손상될 수 있다.

실제 `runQueryAssistantCommand()`에 임시 Node 자식을 연결하고 `{"value":"서울"}`의 `서` 첫 바이트 뒤에서 stdout을 분할했다. 결과는 `{"value":"���울"}`이었다. 실제 AI 서비스는 호출하지 않았다.

수정 방향: `StringDecoder` 또는 스트림의 UTF-8 decoding을 사용하고, 바이트 예산은 별도로 유지한다. 완료 기준은 한글·이모지의 모든 분할 경계에서 원문 보존, 오류 없이 decoder flush, stdout/stderr/metadata 경로의 동일한 처리다.

## B6 — timeout/cancel 완료와 자식 프로세스 종료가 분리됨

근거: [생성 프로세스 listener 해제와 종료 처리](src/modelQueryAssistantCli.ts#L88), [cancel/timeout의 kill](src/modelQueryAssistantCli.ts#L92), [metadata의 동일한 처리](src/modelQueryAssistantCli.ts#L117).

실패·취소 시 `child.kill()`로 SIGTERM을 보내고 바로 Promise를 종료하며 `close` listener도 제거한다. 종료를 기다리거나 유예 시간 뒤 강제 종료하는 단계가 없어서, SIGTERM을 처리하지 않는 CLI는 계속 남을 수 있다. 프로세스가 계속 실행되면 UI는 완료 상태여도 백그라운드 자원이 유지된다.

실제 함수에 SIGTERM을 무시하는 임시 Node 자식을 연결하고 타임아웃 콜백을 실행했다. 호출자는 `timeout`을 받았지만 150ms 뒤 `exitCode=null`, PID 생존 확인은 true였다. 검사 종료 시 재현 코드가 SIGKILL을 보내고 `close`를 기다려 회수했다. 실제 설치된 AI CLI의 동작을 이와 같다고 단정하는 검사는 아니다.

수정 방향: 실패/취소를 사용자에게 전달하는 것과 프로세스 회수를 별도로 관리한다. 종료 확인·짧은 유예·필요 시 강제 종료·listener 정리를 공용 흐름으로 만들고, CLI가 추가 자식을 생성하는 경우도 확인한다.

## B7 — 결과 캐시의 유휴 만료·크기 제한 부족

근거: [8개/30분 캐시와 전체 결과 보존](python/backend_parts/81_query_results.pyfrag#L4), [다음 등록 때의 만료 정리](python/backend_parts/81_query_results.pyfrag#L17), [해당 결과 접근 때의 정리](python/backend_parts/81_query_results.pyfrag#L43), [패널 종료](src/modelQueryConsole.ts#L133), [새 Run의 호스트 핸들 제거](src/modelQueryConsole.ts#L253).

캐시는 항목 수는 제한하지만 전체 value·namespace를 강하게 참조하고 바이트 예산은 없다. TTL은 다음 등록/접근에서만 검사한다. 새 쿼리나 런타임 변경으로 호스트가 이전 resultId를 버려도 백엔드에 해제 요청을 보내는 계약이 없다. 패널 재열기를 위한 결과 보존 자체는 의도된 동작이므로, 무조건 닫힐 때 삭제하는 방식보다 보존 정책을 명확히 해야 한다.

weak reference를 지원하는 결과 안에 4MiB bytearray를 넣어 보존했다. 캐시의 `updated`를 TTL 이전으로 바꿔 30분 경과 조건을 주입하고 외부 참조를 제거한 뒤 GC를 실행해도 객체가 살아 있었다. 다음 `_query_remember_result()` 호출에서 만료 정리가 실행된 후 해제됐다. 실제 30분 동안 기다린 검사나 운영 메모리 누수 측정은 아니다.

수정 방향: 결과 재사용 정책에 맞춘 명시적 release와 유휴 만료 처리, 전체 결과/직렬화 페이지의 크기 예산을 검토한다. 사용자가 유지하는 generator의 소유권과 패널 재열기 동작도 함께 고려해야 한다.

## B8 — 배열 셀의 반복 파싱과 편집기 전체 재생성

근거: [셀 tooltip 판별의 전체 파싱](media/modelBrowserSource.js#L484), [paintCell에서 다시 호출하는 배열 버튼 판별](media/modelBrowserSource.js#L544), [편집기를 열 때의 파싱·복제](media/gridArrayEdit.js#L231), [추가/삭제 후 전체 render](media/gridArrayEdit.js#L327), [모든 항목의 행·컨트롤 생성](media/gridArrayEdit.js#L353).

편집 가능한 JSON 셀 하나를 생성할 때 같은 원문을 배열 판별과 항목 수 표시 용도로 두 번 파싱한다. 배열 편집기는 전체 항목을 동기적으로 렌더링하고 한 행을 추가/삭제해도 모두 다시 만든다. 메인 표의 행 가상화가 이 모달까지 적용되는 것은 아니다.

Node 22.22.2 / macOS arm64에서 실제 `parseEditableArray()`를 30개 셀 × 2회씩 호출했다. 입력은 id/label/active/nested 값이 있는 객체 배열이고, 각 조건에서 7회 측정 후 첫 측정을 제외한 중앙값이다.

| 셀당 항목 | 셀당 JSON bytes | 30개 셀의 60회 파싱 |
| --- | --- | --- |
| 100 | 6,373 | 9.5ms |
| 1,000 | 66,674 | 98.9ms |
| 2,000 | 136,674 | 197.9ms |

실제 `openArrayEditor()`를 모의 DOM의 노드 할당 계측에 연결했다. 1만 개의 정수 항목에서 열기 경로가 약 60,123개를 할당했고, 항목 하나 추가에도 약 60,012개를 다시 할당했다. 이 수치는 실제 브라우저 프레임 시간·레이아웃 시간 측정이 아니다.

수정 방향: 배열 여부/길이는 직렬화 메타데이터나 원문별 캐시로 제공하고, 정확한 전체 파싱은 편집 시점에 공유한다. 모달은 행 가상화 또는 페이지 단위 편집과 부분 갱신을 적용한다. 성능 개선을 위해 기존 큰 정수 보존을 제거해서는 안 된다. 완료 기준에는 실제 웹뷰의 큰 JSON 스크롤·편집·추가/삭제 측정이 필요하다.

## 재현 자료와 확인 범위

- [데이터 재현 스크립트](/private/tmp/django-shell-additional-review-data.mjs), [결과](/private/tmp/django-shell-additional-review-data.json): 실제 Django 5.2.15/Python 3.11.15와 메모리 SQLite. Socket 함수 및 생성 ORM 저장 결과 비교.
- [관계 Open 호스트 재현](/private/tmp/django-shell-additional-review-host.mjs), [결과](/private/tmp/django-shell-additional-review-host.json): 실제 컴파일된 Query/Model Browser 호스트. VS Code 명령·웹뷰 경계는 모의하고 조회·저장은 실제 격리 DB 사용.
- [자원 제한·캐시 재현](/private/tmp/django-shell-additional-review-resources.py), [결과](/private/tmp/django-shell-additional-review-resources.json): 실제 서버의 최대 16개 임시 loopback 연결, handler의 bounded 입력 실험, 객체 참조 검사. 최초 포트 생성이 샌드박스에서 거절되어 승인된 로컬 통신 환경에서 완료했다.
- [파싱·할당 계측](/private/tmp/django-shell-additional-review-performance.mjs), [결과](/private/tmp/django-shell-additional-review-performance.json): 실제 파서와 편집기, 모의 DOM. 브라우저 시각 검증은 아님.
- [CLI 재현](/private/tmp/django-shell-additional-review-cli.mjs), [결과](/private/tmp/django-shell-additional-review-cli.json): 실제 호스트 실행 함수와 일회용 Node 자식. 실제 AI 요청·외부 전송 없음.

위 다섯 스크립트의 수정 전 최종 실행은 모두 exit code 0이며 결함 조건에 대한 단언을 포함한다. 수정 후 통과해야 하는 회귀 테스트가 아니라 당시 문제를 확인하기 위한 임시 재현 코드다. 임시 파일은 장기 보관을 보장하지 않으므로 핵심 조건과 결과는 본문에도 기록했다.

최초 검토는 제품 코드 변경 없이 수행했으므로 당시에는 전체 `npm run check`와 E2E를 다시 실행하지 않았다. 후속 수정의 새 검증 결과와 제한은 문서 위쪽에 기록했다. 직전 A1–A6의 940개 검사 통과를 이번 수정의 결과로 대신하지 않았다.

당시 권장한 수정 순서는 B1·B2의 저장 대상/타입 보존, B3·B5의 전송 일치, B4·B6의 자원 제한/회수, B7·B8의 메모리·화면 성능 개선이었다.
