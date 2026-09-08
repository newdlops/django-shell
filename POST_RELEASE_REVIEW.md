# 1.1.1000050 추가 검토 — 2026-09-08

릴리스 커밋 `ab335eb5e2f63325213083f75aa734172cdc740b`에서 **P1 3건, P2 3건을 재현했으며, 현재 작업 트리에 6건의 수정과 회귀 테스트를 반영했다.**

이전 [안정성 검토](STABILITY_REVIEW.md)와 [치명적 결함 검토](CRITICAL_REVIEW.md)의 수정 이후 남아 있는 다른 입력과 응답 경계를 확인했다. P1은 의도와 다른 저장 값 또는 저장 대상이 재현된 우선 수정 항목이고, P2는 검증 누락·잘못된 조회 표시·기능 누락이다.

**수정 결과**

| ID | 반영한 동작 | 회귀 검증 |
| --- | --- | --- |
| A1 | 관계 메타데이터·펼치기·검색·선택·Open 필터에 실제 target field를 사용한다. 후보의 표시 PK와 저장 값을 분리하고, 명시적 DB 및 문자열 키의 앞자리 0을 유지한다. | [실제 FK/O2O·정수·문자열·큰 정수·DB 저장](test/postReleaseData.test.mjs), [Open 필터와 두 호스트의 선택](test/postReleaseHost.test.mjs) |
| A2 | 생성 ORM은 JSON 원문을 Python에서 파싱한다. 배열 편집기는 큰 정수를 내부 BigInt로 보존한 뒤 원래 JSON 숫자 토큰으로 직렬화한다. 잘못된 구조화 JSON과 이미 부정확한 JS 정수도 거절한다. | [실제 저장·잘못된 JSON rollback](test/postReleaseData.test.mjs), [정확한 파싱·배열 편집](test/gridJsonExact.test.mjs) |
| A3 | Query 관계·검색 응답은 요청 당시 패널·실행 결과 세대·런타임을 확인한다. 이전 응답은 새 창으로 전달하지 않으며, 현재 관계 조회의 예외는 실패 응답으로 종료한다. | [패널·Run·런타임 교체 후 실제 편집기 저장 대상](test/postReleaseHost.test.mjs) |
| A4 | 변경 필드가 참여하는 date/month/year 유일성 규칙을 모든 행의 저장 전에 검사한다. 같은 배치의 충돌과 선택한 쓰기 DB를 함께 확인한다. 두 전송은 같은 Django 검증 소스를 사용한다. | [제목·날짜·두 필드·배치 충돌·정상 교환·archive 검증](test/postReleaseData.test.mjs) |
| A5 | 실제 선택 순서에 맞춰 tuple 열을 구성하고 named/flat 결과를 처리한다. 모델 QuerySet의 annotation은 읽기 전용 열로 보존한다. | [필드 순서·named·flat·빈 결과·annotation](test/postReleaseData.test.mjs) |
| A6 | 두 호스트가 공통 FK 검색 처리기를 사용한다. 편집기는 요청을 식별하고 로딩·빈 결과·실패·재시도·키보드 선택 상태를 제공한다. 초기화한 편집기에 늦은 응답·blur가 적용되지 않게 한다. | [호스트·실제 편집기](test/postReleaseHost.test.mjs), [두 실제 웹뷰](test/e2e/suite/modelIntegrityWebview.js) |

**수정 후 검증과 범위**

- `npm run check`: **940개 통과, 실패·취소·건너뜀 0**. 기존 909개에 회귀 검사 31개를 추가했다. 코드 규칙·TypeScript·웹뷰 번들 빌드를 포함한다.
- `npm run test:e2e:model-browser`: VS Code 1.134.0/macOS arm64에서 **exit code 0**. 기존 Query Builder·두 웹뷰의 저장 안정성 검사에 새 FK 검색·선택·저장 및 JSON 배열 편집·저장을 추가했다.
- 새 E2E는 Model Browser와 ORM Query 각각 **792 × 508**의 실제 웹뷰에서 수행했다. 검색 로딩·빈 결과·실패 후 재시도·키보드 선택, `001` 관계 값 저장, `9007199254740993`을 유지한 배열 변경·저장을 확인했다.
- 웹뷰 E2E의 데이터 소스는 모의했고, 실제 저장·검증·rollback은 별도의 Django 5.2.15/격리 SQLite 검사에서 확인했다. 운영 DB나 설치된 확장본을 대상으로 실행한 검사는 아니다.
- 앱 브라우저 연결을 확인했으나 사용 가능한 브라우저가 없었다. 스크린샷을 통한 외관 검토와 390/768/1440 크기별 시각 검증은 수행하지 않았다. 위 웹뷰 검증은 기능 검증이다.
- 최초 전체 검사의 소켓 테스트는 샌드박스 포트 제한으로 실패했다. 로컬 통신 권한을 받은 환경에서 전체 검사를 다시 실행했다. 기존 생성 코드 형태를 고정하던 단언도 실제 새 계약에 맞게 갱신했다.
- 최종 로그: `/private/tmp/django-shell-post-release-check.log`, `/private/tmp/django-shell-post-release-e2e.log`.
- 위 결과는 A1–A6 소스 수정 당시의 검증 기록이다. 후속 B1–B8 수정과 함께 `1.1.1000051` 릴리스에 포함한다.

**수정 전 재현 기록**

아래 원인·관측값·줄 번호는 최초 검토 시점의 기록이다. 현재 동작과 검증 결과는 위 수정 결과를 기준으로 한다.

| 우선순위 | ID | 재현한 문제 | 관측 결과 |
| --- | --- | --- | --- |
| P1 | A1 | `ForeignKey(to_field=...)`가 대상 기본키와 혼동됨 | Beta 후보를 선택해 저장했지만 실제 관계는 Alpha로 변경. Socket 관계 펼치기도 Alpha를 반환 |
| P1 | A2 | JSON 편집에서 큰 정수 정밀도가 손실됨 | 다른 속성만 바꿨는데 ORM 저장 후 `9007199254740993 → 9007199254740992` |
| P1 | A3 | 닫은 Query 패널의 관계 조회 응답이 새 패널로 전달됨 | 새 부모 행의 자식 PK=22 대신 이전 자식 PK=11이 표시되고, 편집·저장 요청도 PK=11로 전달 |
| P2 | A4 | 변경하지 않은 필드를 제외하면서 날짜 유일성 검증도 생략됨 | `full_clean()`이 거절하는 중복 제목을 Socket·생성 ORM 모두 저장 |
| P2 | A5 | `values_list()`의 실제 필드 순서·결과 타입을 잘못 해석함 | `marker='tag', id=1`이 `id='tag', marker=1`로 표시. `named=True`는 예외 |
| P2 | A6 | ORM Query 호스트에 FK 검색 메시지 처리가 없음 | 실제 편집기가 보낸 `lookupRelated`에 백엔드 호출·검색 응답 모두 0회 |

**A1 — 비기본키 외래키를 조회·선택할 때 다른 행을 가리킨다**

근거: [Socket 관계 조회](python/backend_parts/50_model_core.pyfrag#L141), [검색 후보의 PK 반환](python/backend_parts/80_model_edit_query.pyfrag#L171), [선택 값 처리](media/gridFkPicker.js#L69), [ORM 검색](src/modelOrm.ts#L857).

관계 펼치기는 저장된 FK 값을 무조건 대상 모델의 `pk`와 비교한다. 검색 후보도 대상 기본키만 반환하며, 편집기는 이 값을 원본 FK의 attname에 저장한다. `to_field`가 지정되면 저장 값의 의미는 대상 기본키가 아니라 해당 unique 필드다.

재현 데이터는 Alpha=`pk=1, code=2`, Beta=`pk=2, code=1`이며, 원본 행의 `company`는 `ForeignKey(Company, to_field='code')`, 저장 값은 `company_id=1`이다.

- Django의 실제 관계와 생성 ORM의 관계 조회는 **Beta**를 반환한다. Socket 관계 조회는 **Alpha**를 반환한다.
- 검색 응답 `#2 · Beta`, `pk=2`를 선택 값으로 저장하면 `company_id=2`가 된다. Socket은 성공을 반환하지만 실제 관계는 **Alpha**다. 같은 선택 값으로 생성 ORM을 실행해도 Alpha가 저장된다.

수정 방향: 원본 관계의 `target_field`를 조회·검색·선택·저장에 연결한다. 후보의 표시용 PK와 FK에 저장할 값을 분리하며, 두 전송 방식의 의미를 일치시킨다.

완료 기준: PK와 다른 unique 정수·문자열 필드를 참조하는 FK/O2O에서 펼치기와 선택 저장이 같은 실제 대상을 가리켜야 한다. 일반 PK 참조와 nullable 관계도 유지해야 한다.

**A2 — JSON의 변경하지 않은 큰 정수가 저장 과정에서 바뀐다**

근거: [생성 ORM의 JSON 파싱](src/modelOrm.ts#L921), [배열 편집기의 JSON 파싱](media/gridArrayEdit.js#L22), [배열 적용 시 직렬화](media/gridArrayEdit.js#L407).

`structuredEditValue()`는 JSON 문자열을 JavaScript `JSON.parse()`로 숫자화한 뒤 Python 리터럴로 만든다. 이 과정에서 안전 정수 범위를 넘는 값이 반올림된다. 이전 C2의 PK·커서·choice 직렬화 수정과 다른 경계이며, JSON 편집 원문에는 아직 정확한 숫자가 들어 있다.

실제 `JSONField`에 `{"ref":9007199254740993,"label":"old"}`를 저장한 후 `label`만 `edited`로 바꾸는 요청을 실행했다. Socket 저장은 ref=`9007199254740993`을 유지했지만 생성 ORM 저장은 ref=`9007199254740992`를 남겼다. 두 경로 모두 저장 자체는 성공했다.

추가로 실제 `parseEditableArray()`에 `[9007199254740993,1]`을 전달하자 첫 항목이 이미 `9007199254740992`로 변했다. 이 검사는 배열 파싱 경계까지이며 배열 모달의 실제 렌더링·저장은 이번 재현에 포함하지 않았다.

수정 방향: JSON 숫자를 JavaScript Number로 왕복시키지 않는 표현을 사용한다. 생성 ORM에서는 원문을 보존해 Python에서 파싱하는 방법을 검토하고, 배열 편집기는 변경하지 않은 항목의 값과 타입을 보존해야 한다. 모든 숫자를 JSON 문자열로 바꾸는 방법은 원래 타입을 바꾸므로 대안이 되지 않는다.

완료 기준: 큰 양수·음수 정수, 중첩 객체·배열의 한 항목만 바꿀 때 다른 항목이 정확히 유지되고 Socket·ORM 저장 결과가 같아야 한다.

**A3 — 이전 Query 창의 관계 조회가 새 창의 편집 대상을 바꾼다**

근거: [await 후 현재 패널로 전송하는 관계 응답](src/modelQueryConsole.ts#L466), [웹뷰별로 초기화되는 요청 번호](media/modelBrowserSource.js#L72), [응답을 수락하고 요청을 제거하는 위치](media/modelBrowserSource.js#L772).

`expandRelated()`는 호출 시점의 패널·실행 결과를 보존해 응답 대상을 검사하지 않는다. 닫힌 창의 요청이 늦게 끝나면 `this.post()`가 새 패널에 응답을 보낸다. 새 웹뷰의 관계 요청 번호는 다시 1부터 시작하므로 이전 응답과 충돌할 수 있다. 이전 C6에서 추가한 저장 응답 보호는 이 조회 경로에 적용되지 않는다.

실제 Query 호스트와 실제 `onRelated()`·관련 행 편집기 코드를 실행하되, VS Code 경계·DOM·데이터 소스는 격리 fixture를 사용했다.

1. 이전 패널이 부모 PK=1의 자식을 요청하고 응답을 대기한다.
2. 패널을 닫고 새 패널에서 부모 PK=2의 자식을 요청한다. 두 웹뷰의 요청 ID는 각각 1이다.
3. 이전 응답의 자식 PK=11이 먼저 도착하면 새 패널에 표시되고 pending 요청이 제거된다.
4. 올바른 새 응답의 자식 PK=22가 뒤이어 도착해도 무시된다.
5. 표시된 행을 실제 관련 편집기로 수정·Commit하자 `modelCommit`에 PK=11이 전달됐다. 이 호스트 재현에서는 DB 쓰기 자체는 모의했다.

수정 방향: 관련 조회 응답도 요청 당시 패널과 결과·런타임에 묶고, 유효하지 않은 응답은 적용하지 않는다. 요청 ID 재사용과 응답 순서가 저장 대상 식별에 영향을 주지 않게 한다.

완료 기준: 패널 재생성·새 Run·런타임 교체 중 도착하는 이전 관계 응답이 새 화면에 들어오지 않고, 이전 편집 대상도 새 저장 경로에 전달되지 않아야 한다. 현재 패널의 정상 응답은 계속 처리해야 한다.

**A4 — 교차 필드 검증에 필요한 날짜가 exclude에 들어간다**

근거: [Socket 저장의 full_clean 제외 목록](python/backend_parts/80_model_edit_query.pyfrag#L59), [생성 ORM의 같은 제외 정책](src/modelCommitOrm.ts#L28).

변경 필드 이외의 모든 필드를 `full_clean(exclude=...)`에서 제외한다. `title`이 `unique_for_date='published'`를 선언한 경우 제목만 변경하면 `published`도 제외되므로 해당 유일성 검증이 생략된다.

같은 날짜의 두 Article 제목을 각각 `duplicate`, `other`로 만든 후 두 번째 제목을 `duplicate`로 변경했다. 일반 `full_clean()`은 `Title must be unique for Published date.`를 반환했다. 그러나 실제 Socket 저장과 생성 ORM 저장은 모두 완료되어 해당 날짜의 중복 제목 행이 2개가 됐다.

확인한 범위는 DB unique constraint가 없는 `unique_for_date`다. 모든 `Model.clean()`이나 DB 제약이 생략된다는 뜻은 아니다.

수정 방향: 개별 필드 검증과 교차 필드 검증의 제외 정책을 구분한다. 변경 필드가 참여하는 유일성·제약 검증에 필요한 원본 값은 제외하지 않도록 한다.

완료 기준: 제목만 변경, 날짜만 변경, 두 필드 변경, 여러 행의 일괄 변경에서 날짜 유일성이 유지되어야 한다. 실패한 저장은 두 전송 방식에서 같은 결과와 rollback을 제공해야 한다.

**A5 — values_list 결과의 열 이름과 값이 어긋난다**

근거: [필드·annotation 순서를 별도로 합치는 코드](python/backend_parts/80_model_edit_query.pyfrag#L290), [지원 iterable 이름 목록](python/backend_parts/80_model_edit_query.pyfrag#L292).

`values_select + annotation_select` 순서를 tuple 값의 순서로 가정한다. 실제 선택 순서가 annotation 먼저이면 열 이름과 값이 뒤바뀐다. 또한 `NamedValuesListIterable`을 tuple 결과로 처리하지 않아 dict처럼 `.items()`를 호출한다.

- `Company.objects.annotate(marker=Value('tag')).values_list('marker', 'id')`: 실제 첫 행은 `marker='tag', id=1`인데 표에는 `id='tag', marker=1`이 전달됐다. 응답은 `ok=true`다.
- `Company.objects.values_list('name', 'id', named=True)`: `AttributeError: 'Row' object has no attribute 'items'`로 쿼리 전체가 실패했다.
- 별도로 `Company.objects.annotate(marker=Value('tag'))`도 실행했다. 결과 컬럼은 `id, code, name`뿐이며 marker가 누락됐다. [모델 QuerySet의 concrete 필드 전용 values 변환](python/backend_parts/80_model_edit_query.pyfrag#L280)에서 발생한다.

수정 방향: Django가 반환한 실제 선택 순서와 iterable 형태를 기준으로 표를 구성한다. named tuple을 명시적으로 처리하고, 모델 QuerySet의 annotation은 읽기 전용 열로 보존한다.

완료 기준: field·annotation 순서를 바꾼 `values_list()`, `flat=True`, `named=True`, `.values()`, annotation이 있는 모델 QuerySet의 표시가 원래 쿼리 결과와 일치해야 한다.

**A6 — ORM Query의 외래키 검색 요청이 처리되지 않는다**

근거: [FK 편집기의 메시지](media/gridFkPicker.js#L50), [Query 호스트의 메시지 분기](src/modelQueryConsole.ts#L139), [Model Browser에만 있는 처리기](src/modelBrowser.ts#L780).

공용 FK 편집기는 `lookupRelated`를 보내지만 `ModelQueryConsole.handleMessage()`에는 해당 분기가 없다. 실제 `createEditor()`로 FK 셀을 열어 생성된 메시지를 실제 Query 호스트에 전달하자 `modelLookup` 호출과 `lookup` 응답이 모두 0회였다. 검색 후보가 나타나지 않으며, 현재 입력기의 직접 ID 입력 경로는 별개로 남아 있다.

수정 방향: 공용 편집기를 사용하는 두 호스트가 동일한 lookup 메시지 계약을 처리하도록 한다. A1의 관계 키 식별과 함께 source 관계·명시적 DB 정보가 필요한지도 반영한다.

완료 기준: 두 호스트에서 FK 검색·선택·빈 결과·실패·늦은 응답을 검증하고, 선택 결과가 실제 원본 FK가 요구하는 값과 DB를 유지해야 한다.

**재현 실행과 범위**

- 실제 Python 백엔드·생성 ORM: Django 5.2.15, Python 3.11.15, 프로세스 안에 등록한 fixture 모델과 메모리 SQLite를 사용했다. A1·A2·A4는 실제 저장 후 DB 값을 확인했고 A5는 실제 쿼리 결과와 비교했다.
- Query 호스트·편집기: 현재 `out/modelQueryConsole.js`, `media/gridEdit.js`, `media/gridRelated.js`와 소스에서 읽은 `onRelated()`를 사용했다. VS Code 메시징·DOM·데이터 소스 경계만 모의했으며 실제 웹뷰 시각 검증은 아니다.
- 백엔드 스크립트: `/private/tmp/django-shell-post-release-backend-review.mjs`, 결과: `/private/tmp/django-shell-post-release-backend-review.json`.
- 호스트 스크립트: `/private/tmp/django-shell-post-release-host-review.mjs`, 결과: `/private/tmp/django-shell-post-release-host-review.json`.
- 실행은 저장소 루트에서 각각 `node /private/tmp/django-shell-post-release-backend-review.mjs`, `node /private/tmp/django-shell-post-release-host-review.mjs`로 수행했다. 두 프로세스 모두 exit code 0이며, 이는 위 결함의 재현 확인이지 수정 후 정상 동작 검사의 통과가 아니다.
- 이번에는 제품 코드를 수정하지 않아 전체 `npm run check`·E2E를 다시 실행하지 않았다. 이전 릴리스의 909개 검사 통과를 이번 검토의 검증 결과로 계산하지 않는다. 설치된 확장·운영 DB·실제 SSH/kubectl 장애·장시간 부하는 이번 확인 범위 밖이다.
