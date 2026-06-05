# Django Model Browser — 구현 계획

Django Shell 익스텐션에 **모델을 테이블처럼 조회·필터·편집하는 데이터 브라우저**를 추가한다.
SQL 클라이언트(DBeaver/TablePlus)와 유사한 경험을 라이브 Django ORM 위에서 제공한다.

> **상태 (2026-06-04):** 확정 결정 — manager 기본값 `_base_manager`, 편집은 ORM `save()` 레벨. **P1(읽기 전용 뷰어)·P2(필터/정렬/count) 구현 완료**(실제 Django 검증: 단일 SELECT·FK=id·keyset·관계 lazy·필터 injection 불가·boolean 문자열 변환·count 일관성). **P3a(인라인 편집) 완료**(§5 참조). **편집 UX 개선 완료** — 셀 편집기를 필드 타입별 입력 컨트롤로 교체(§6.1) + FK 검색 피커(신규 `lookup` kind). **커스텀 ORM 쿼리 콘솔 완료**(§6.2) — 별도 패널에서 사용자 ORM 코드 결과를 그리드로 렌더(신규 `query` kind, 가능 시 편집). **다음: P3b(행 생성/삭제)·P3c(M2M).**
>
> **부트스트랩 정정:** 백엔드는 단일 `.py` 소스를 인라인 압축·임베드해 실행하므로(`backendBootstrap.inlineBackendBootstrap`) 별도 파이썬 모듈은 셸에서 import되지 않는다. 따라서 모델 브라우저 백엔드 로직은 `python/django_shell_backend.py`에 새 함수 + 새 `kind` 분기로 추가했다(기존 함수/분기 불변 → 여전히 additive).

## 0. 핵심 원칙

1. **추가만 한다 (additive-only).** 기존 동작은 바꾸지 않는다. 기존 파일은 *append-only*(새 분기/메서드/항목 추가)만 허용하고, 기존 코드 경로의 동작·시그니처·반환값은 손대지 않는다. 가능한 로직은 전부 신규 파일로 분리한다.
2. **N+1 원천 차단.** 그리드 렌더링은 항상 단일 SELECT(`.values()`, JOIN 없음). 관계 데이터는 사용자가 명시적으로 펼칠 때만 bounded 쿼리 1회로 가져온다. 기존 백엔드의 "explicit child inspection" 철학을 ORM 행에 그대로 적용한다.
3. **안전 우선.** 임의 `eval` 금지(구조화 입력으로 ORM 구성), 모든 쿼리 bounded, 직렬화는 화이트리스트 인코더, 편집은 트랜잭션 + 검증 + 명시적 커밋.
4. **단계적 제공.** P1 읽기 전용 → P2 필터/정렬 → P3 편집(목표). 각 단계가 독립적으로 동작·릴리스 가능.

## 1. Additive-only 영향 범위 (파일 단위)

### 신규 파일 (NEW) — P1에서 모두 생성됨
| 파일 | 역할 |
|---|---|
| `src/modelBackend.ts` | 모델 브라우저 wire 타입 + 응답 parser + PTY fallback 헬퍼. (`backendClient.ts` 500줄 한도 보호용 분리.) |
| `src/modelBrowser.ts` | Webview 패널 컨트롤러 + `ModelDataSource` 인터페이스. `customConsole.ts` 패턴 차용. |
| `src/modelBrowserHtml.ts` | 패널 HTML 생성 (`customConsoleHtml.ts` nonce/CSP 패턴). |
| `src/modelCatalog.ts` | 액티비티바 트리(앱→모델 카탈로그) `TreeDataProvider`. |
| `media/modelBrowserSource.js` | 그리드 프론트엔드 (esbuild로 `dist/modelBrowser.js` 번들. `*Source.js`는 `.vscodeignore` 대상). |
| `test/modelBrowser.test.mjs` | 신규 단위 테스트(직렬화·헬퍼·graceful + Django ORM 흐름). |

> 백엔드 로직은 (부트스트랩 정정에 따라) 신규 파일이 아니라 `python/django_shell_backend.py`에 함수로 추가됨.

### Append-only 수정 (기존 파일, 기존 동작 불변)
| 파일 | 추가 내용 (기존 분기/메서드는 그대로) |
|---|---|
| `python/django_shell_backend.py` | `_run_request`에 새 `kind` 분기 4개(`models`/`schema`/`rows`/`related`) + `_browse_*` 함수들. 기존 kind 처리·inspection·직렬화 헬퍼 무수정. |
| `src/backendClient.ts` | 새 메서드(`models()`/`modelSchema()`/`modelRows()`/`modelRelated()`) + `BackendRequestPayload`에 선택 필드 + `unsupportedPtyFallbackResponse`에 모델 kind 위임. 기존 메서드 무수정. (442줄, 한도 내) |
| `src/customConsole.ts` | `activeBackend` 게터 1개(한 줄 관용구). 기존 메서드 무수정. |
| `src/extension.ts` | `LazyRuntimeSource`에 모델 메서드 4개(idle fallback) + E2E early-return 전에 `ModelBrowser`/`ModelCatalog` 등록. 기존 등록 무수정. |
| `package.json` | `commands`/`views.djangoShell`/`activationEvents`/`menus` 항목 추가 + `build:model-browser` esbuild 스크립트 + `build:renderer` 체이닝. 기존 항목 무수정. |
| `.vscodeignore` | `MODEL_BROWSER_PLAN.md` 추가(문서 비패키징). |
| `test/packageManifest.test.mjs` | 신규 command/view 존재 검증 assertion 추가(기존 검증 유지). |

> **회귀 확인 결과:** 신규 파일 5개 전부 가이드라인 통과(≤500줄·JSDoc). 단위 테스트 33개 그린. `check:guidelines`와 e2e의 `assertOverlayRendererGuards`는 **내 변경 전 main(HEAD)에서도 동일하게 실패** — git worktree로 클린 main을 직접 돌려 입증함(내 추가와 무관한 기존 실패). 오버레이 파일은 하나도 건드리지 않음.

> 회귀 안전망: 위 append-only 수정은 모두 신규 식별자/항목만 더한다. 기존 `kind`, 기존 command, 기존 webview, deprecated 노트북 경로는 코드·동작 모두 불변. `npm run check`(가이드라인+단위)와 `npm run test:e2e`로 회귀 없음을 확인한다.

## 2. 아키텍처 / 데이터 흐름

```
Webview 그리드 (media/modelBrowserSource.js)
   ⇅ postMessage
src/modelBrowser.ts  (패널)  ─┐
src/modelCatalog.ts  (트리)  ─┤→ BackendClient (신규 메서드)
                              │      ⇅ JSON-line 소켓 (TCP, PTY는 비활성 응답)
                              └→ django_shell_backend.py  _run_request (새 kind 분기)
                                       → django_shell_model_browser.py  (live ORM)
```

라이브 `manage.py shell` 프로세스 안이라 `django.apps.apps`, ORM, `_meta` 즉시 접근 가능. 모든 새 kind는 기존과 동일하게 토큰 검증 + `_EXECUTION_LOCK` 하에 실행.

## 3. 백엔드 프로토콜 (신규 kind)

전부 `django_shell_model_browser.py`에 구현, `_run_request`는 위임만. `inspect`처럼 구조가 커서 **TCP 전용**(PTY fallback 시 "disabled" 응답).

| kind | 요청 | 응답 | 비고 |
|---|---|---|---|
| `models` | — | `[{app, model, objectName, table, verbose, pk}]` | `apps.get_models()`, 쿼리 0회 |
| `schema` | `{app, model}` | 컬럼(타입/null/editable/choices) + 관계(FK/O2O/M2M/reverse) | `_meta`만, 쿼리 0회 |
| `rows` | `{app, model, limit, cursor?/offset?, order?, filters?}` | `{columns, rows, nextCursor, count?}` | `.values()` JOIN 없음 |
| `related` | `{app, model, pk, relation, limit, cursor?}` | 관련 행 페이지 | 펼침 시 1회, bounded |
| `lookup` | `{app, model, q, limit?, exclude?}` | `{ok, rows:[{pk, label}], hasMore}` | FK 검색 피커. 단일 SELECT, `__str__`/JOIN 없음 |
| `query` | `{code, limit?, offset?}` | `{ok, columns, rows, hasMore, editable, model?, app?, pk?, orm, sql, error?}` | 커스텀 ORM 콘솔. 셸 네임스페이스에서 멀티라인 eval → 마지막 표현식 테이블화 |
| `mutate` | `{op, app, model, pk?, changes, expected?}` | `{ok, row?, error?, validation?}` | P3. 트랜잭션 |

### 3.1 N+1 차단 — 행 조회 핵심

```python
model = apps.get_model(app, model_name)
concrete = model._meta.concrete_fields                 # 실제 DB 컬럼만
cols = [f.attname for f in concrete]                   # 'id','title','author_id'
qs = model._base_manager.order_by("pk").values(*cols)  # FK는 id로만 → JOIN/추가쿼리 없음
page = list(qs[offset:offset + limit])                 # 단일 SELECT
```
- 컬럼은 `concrete_fields`만 → property/`GeneratedField`/`@cached_property`/annotation은 계산 유발하므로 **기본 제외**(opt-in).
- FK/O2O 셀: `author_id`만 표시. 셀 펼침 → `related` kind로 단건 `_base_manager.filter(pk=id).values(...)` 1회.
- 역참조 FK·M2M: "N건 →" 어포던스. 펼침 → `rel.filter(<fk>=row_pk).values(...)[:N]` 1회. 절대 자동 로드 안 함.
- 관계 분류는 `_meta.get_fields()`의 `many_to_one/one_to_one/many_to_many/one_to_many`로 DB 안 건드리고 판별.

### 3.2 페이지네이션
- 기본 **keyset(pk 커서)**: `filter(pk__gt=cursor).order_by("pk")[:limit]` — 대형 테이블에서 OFFSET보다 안정.
- 정수/정렬가능 pk가 아니거나 사용자 정렬 지정 시 OFFSET fallback.
- `count()`는 비싸므로 **요청 시 별도 계산**(버튼). 기본은 "has more"만 표시.
- 최대 page size 상한(예: 200)으로 REPL 블로킹 방지.

### 3.3 직렬화 (화이트리스트 인코더)
`Decimal→str`, `datetime/date/time→iso`, `UUID→str`, `bytes/memoryview→base64+len(truncate)`, `set→list`, lazy/Promise→repr, model 인스턴스→`{pk, label?}`. 기존 `_truncate` 재사용, 대형 텍스트는 truncate + "전체 보기" lazy. **그리드에서 임의 `__str__`/`repr` 호출 금지**(쿼리·부작용 유발 가능).

### 3.4 결정
- **manager**: ✅ **확정 `_base_manager`** — 메인 행 조회/단건 FK는 `_base_manager`(DB 충실). (P1 구현됨. "다건" 관계 펼침은 P1에서 관련 매니저의 default manager 사용 — P2에서 `_base_manager` 통일 검토.)
- **다중 DB**: `.using(db)` 셀렉터(`router`/`settings.DATABASES`) — 후순위.
- **statement timeout**(Postgres `SET LOCAL`)로 폭주 쿼리 방어 — 후순위.

## 4. 익스텐션(TS) / UI

- **카탈로그 트리** (`modelCatalog.ts`): 기존 `djangoShell` 액티비티바 컨테이너에 두 번째 view 추가. 앱 → 모델. 행 수는 lazy(요청 시).
- **데이터 패널** (`modelBrowser.ts`): 모델 클릭 시 `createWebviewPanel`로 그리드 열기. `customConsole.ts`의 패널/메시지 패턴 그대로.
- **그리드 프론트** (`media/modelBrowserSource.js`): 행×열, 페이지네이션, 정렬, FK 셀 펼침(인라인 nested), 역참조/M2M "N건 →" 펼침. P2 필터바, P3 편집 셀.
- 백엔드 미연결 시: 콘솔처럼 "Open console & enter shell" 안내. PTY 전용 환경: "원격 조회 비활성" 안내(기존 문구 패턴).

## 5. 단계별 작업 (Phased)

### P1 — 읽기 전용 뷰어 (기반)
- 백엔드 `models`/`schema`/`rows`/`related` + 직렬화/keyset/관계 분류.
- `backendClient` 메서드+parse, PTY 비활성 등록.
- 카탈로그 트리 + 데이터 패널 + 그리드(조회/페이지/정렬/FK·역참조 lazy 펼침).
- command/view/activationEvent/esbuild 스크립트 등록.
- **완료 기준**: 모델 선택→행 표시, FK는 id로 표시 후 펼침 시 1쿼리, 페이지 이동 동작, 단일 SELECT 확인(쿼리 로깅).

### P2 — 필터 / 정렬 ✅ 완료
- 구조화 필터 UI(필드+lookup+값+negate 칩) → `_browse_build_filters`가 **필드·lookup 화이트리스트 + ORM 파라미터**로 `Q` 구성(injection 불가). `BooleanField`는 문자열 자동 변환.
- 정렬 가능한 헤더(asc/desc/none 순환, 비-pk 정렬 시 offset 페이지네이션), `count` kind(요청 시 계산, 필터셋 일치).
- 신규 백엔드 kind `count` + `rows`에 `filters` 지원. 클라이언트 `modelCount` + 페이로드 `filters`. UI 필터바·정렬·Count 버튼(`media/modelBrowserSource.js`).
- ✅ 검증: 필터/negate/in/isnull/정렬/count 정확, 악성 필드·lookup은 무시(거부), 단위 테스트 추가.
- **UX 보정**: 펼친 관계 패널이 데이터 셀의 `nowrap`/`overflow:hidden`을 상속하지 않도록 `.detail>td` 오버라이드. 패널은 `position:sticky;left:0`로 뷰포트 좌측 고정. 각 패널에 `✕ close` 헤더 + 트리거 재클릭 토글(닫기 직관화).
- **높이 보정**: 역참조 칩은 줄바꿈 대신 **1줄 + 가로 스크롤**(`.chiprow` nowrap/overflow-x) — 역참조 많아도 세로로 안 커짐. 펼친 관련 테이블은 `max-height:40vh`.
- **전송 방식 스위치(원격 지원)**: 모델 브라우저 요청(models/schema/rows/related/count/commit)을 **PTY 폴백 허용**으로 전환 → 소켓이 안 닿는 원격(로컬 VS Code + ssh 터미널)에서도 콘솔이 되면 테이블도 동작. 상단바 **Link: Auto / Socket / Terminal** 셀렉트 + 활성 표시(● socket/● terminal/○). Auto=소켓 우선·실패 시 터미널, Socket=소켓 강제, Terminal=터미널 강제(`BackendClient.setTransportMode`). PTY일 때 페이지 25로 축소(속도/안정). 부트스트랩이 이미 대형 단일 라인을 보내므로 commit 포함 전송 가능, 응답 버퍼 1.25MB.
- **스크롤바**: 웹뷰가 네이티브 오버레이 스크롤바를 써서 호버 시 콘텐츠를 가리는 문제 → relation 영역(`.chiprow`/`.nestedscroll`)은 스크롤바를 **숨김**(`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`), 트랙패드/Shift+휠로 스크롤. 메인 그리드(`.gridwrap`)만 얇은 스크롤바 유지. (`color-mix` 등 커스텀이 웹뷰에서 불안정해 제거.)
- **모델 검색 + 트리(인뷰)**: Models 뷰를 TreeView → **WebviewView**(`type:"webview"`)로 전환. 상단 검색 입력 + 그 아래 **접힘/펼침 계층 트리**(app 그룹 → 모델 nested). 그룹 클릭으로 접기/펼치기, 검색 시 매칭 그룹 자동 펼침. 입력 **150ms 디바운스**, 메모리 필터, **렌더 500개 상한**(접힌 app의 모델은 렌더 안 함)으로 수천 개여도 랙 없음. (`modelCatalog.ts`=WebviewViewProvider, `modelCatalogHtml.ts`, `media/modelCatalogSource.js`.) 기존 QuickPick `searchModels` 제거.
- **관계를 칼럼으로**: 역참조/M2M를 별도 `▶` 행이 아니라 **테이블 칼럼**으로(`relcol`/`relcell`), 각 셀에 칩. 칩 클릭 → 해당 행 아래로 관련 테이블 펼침(닫기/토글 유지). 칼럼이 많아지면 메인 그리드 가로 스크롤로 처리.
- **SQL 로그**: 백엔드가 `CaptureQueriesContext`로 실제 실행 SQL을 잡아(`DEBUG` 무관) `rows`/`related`/`count` 응답에 `sql` 동봉. 하단 "SQL Log (Django ORM)" 패널(기본 표시, 토글로 숨김)에 `시각 · 액션` + 실행된 SQL + 소요시간 표시(최신순, 최대 200, Clear). TablePlus의 쿼리 로그와 유사. (패널이 안 뜨던 원인: 빈 `.relbar`가 `:empty{display:none}`로 그리드 트랙을 어긋나게 함 → relbar 제거 + 그리드 5트랙 정리 + 패널 확정 높이로 수정.)
  - **정렬+구문강조**: `media/sqlHighlight.js`(번들)가 절 단위 줄바꿈 + SELECT 컬럼 줄바꿈으로 포맷하고, 키워드/식별자/문자열/숫자/파라미터를 안전 DOM(textContent)으로 토큰 강조. (modelBrowserSource.js 500줄 한도 보호용 분리.)
  - **SQL ↔ Django ORM 토글**: 백엔드가 각 조회의 ORM 표현식을 재구성해(`_browse_orm_*`: `_base_manager.order_by().filter()/.exclude().values()[slice]`, related는 `.get(pk).accessor.all()`, count는 `.count()`) 응답 `orm`에 동봉. 로그 헤더 "View: SQL/Django ORM" 버튼으로 표시 모드 전환(엔트리는 둘 다 담고 CSS로 표시). 서버에 보낸 Django 명령을 SQL과 별개로 확인 가능.
- **컬럼 고정(pin)**: concrete 칼럼 헤더의 `⇤` 버튼으로 핀 토글 → `position:sticky;left`로 좌측 고정(가로 스크롤 시 유지). `repaintPins`가 헤더 폭을 측정해 누적 left 계산, 헤더·바디 셀에 적용. z-index로 헤더>바디·핀>비핀 레이어링, 불투명 배경.
- **트리 검색 하이라이트 + VS Code급 스타일**: 카탈로그 검색 시 매칭 substring을 `--vscode-list-highlightForeground` 색으로 강조(`.match`). 트리는 22px 행 + 배지 카운트 + 들여쓰기 가이드선 + hover/active 네이티브 색.
  - **codicon 아이콘**: 웹뷰는 codicon 기본 미제공 → `media/codicon.css`(폰트 data-URI 임베드, MIT) vendoring + `<link>` + CSP `font-src data:`. twistie=`chevron-right`(펼침 시 90° 회전), app=`package`, model=`table`, 검색=`search`. 네이티브 트리 탐색기 룩.
- **핀 셀 불투명**: `tr:hover td`가 반투명 `--vscode-list-hoverBackground`로 핀 셀을 덮어 비쳐 보이던 문제 → 핀 셀은 불투명 `editor-background` 기본 + hover 시 틴트를 `background-image` 레이어로 올려 항상 불투명.

### P3 — 편집 (목표)
세부는 §6. 인라인 편집 → "변경 사항" 스테이징 → 트랜잭션 커밋.
- **P3a ✅ 완료**: concrete 필드 + FK(id) 인라인 편집. **커밋 전까지 서버에 아무 요청/쿼리도 안 보냄**(웹뷰 메모리 스테이징 `pending` Map + dirty 셀). 여러 셀/행 bulk 편집 → **Commit (N)** 한 번에 `commit` kind로 전송 → 백엔드가 전부 `full_clean()` 검증(all-or-nothing) 후 `transaction.atomic()`로 `save(update_fields=...)`. 실패 시 전체 롤백 + 필드별 에러 반환. boolean 문자열 변환, 비편집/PK/auto 필드 거부. 커밋 SQL/ORM은 쿼리 로그에 표시. (프론트: dblclick 인라인 입력, `media/gridEdit.js`; 핀은 `media/gridPin.js`로 분리.) 실제 Django 단위 테스트 추가.

#### 6.1 편집 UX — 필드 타입별 입력 컨트롤 (✅ 완료)
모든 셀이 textinput이던 것을 필드 타입에 맞는 입력기로 교체. 백엔드 스키마가 이미 `type`/`choices`/`null`을 보내므로 **대부분 프론트 변경**(`media/gridEdit.js`):
- **choices(이넘)** → `<select>` 드롭다운(`[value,label]` + nullable이면 `(null)`), 선택 즉시 스테이징. 스테이징된 choice 셀은 값(key) 대신 **라벨**로 표시(`stagedDisplay`).
- **BooleanField** → `true`/`false` 드롭다운(nullable이면 `(null)`).
- **Date/DateTime/Time** → 네이티브 `<input type=date|datetime-local|time>`. `normalizeTemporal`이 저장된 ISO 값(타임존/마이크로초 제거, 공백→`T`)을 입력기가 받는 형태로 정규화.
- 그 외 → 기존 텍스트 입력 유지. Enter/blur 커밋, Esc 취소, 드롭다운은 change 시 커밋.
- **FK 검색 피커** (`media/gridFkPicker.js` + 신규 `lookup` kind): FK 셀 더블클릭 시 raw-id 입력 대신 **검색 입력 + 라이브 후보 드롭다운**. 입력 디바운스(200ms) → `lookupRelated` → 패널이 `lookup` 호출 → 후보 `[{pk,label}]` 반환. ↑/↓ + Enter 또는 클릭으로 선택 → pk를 `<field>_id` attname에 스테이징(기존 커밋 경로 그대로). raw id 직접 입력도 가능. 백엔드 `_browse_lookup`은 텍스트 필드 `icontains` OR + 숫자면 pk exact, **단일 `.values()` SELECT**(JOIN/`__str__` 없음), 라벨 `#<pk> · <텍스트필드>`. FK lookup은 키 입력마다 발생하므로 **SQL 로그에는 안 남김**(노이즈 방지).
  - **민감 필드**: 기본은 **모든 텍스트 필드 노출**(하드코딩 제외 없음). 유저 설정 `djangoShell.modelBrowser.lookupExcludeFields`(string[], 기본 `[]`)의 부분문자열(대소문자 무시)에 매칭되는 필드만 검색/라벨에서 제외 → 패널이 설정을 읽어 `lookup` 요청의 `exclude`로 전달.

#### 6.2 커스텀 ORM 쿼리 콘솔 (✅ 완료)
사용자가 작성한 Django ORM 코드의 결과를 **기존 그리드 UI로** 렌더링하는 **별도 webview 패널**. 명령 `djangoShell.runModelQuery`("Run ORM Query")로 진입 — **Models 뷰 타이틀의 ▶ 버튼**(`view/title` 메뉴)으로도 진입(발견성). 컨트롤러 `src/modelQueryConsole.ts`(신규)는 `modelBrowserHtml`을 재사용해 동일 번들 로드 → `{type:"queryMode"}`로 그리드를 쿼리 모드로 전환(쿼리바 표시, 필터/Count 숨김; `media/gridQuery.js`).
- **실행**: 신규 백엔드 kind `query` → `_browse_query(namespace, request)`. `_browse_eval_last`가 `_split_last_expression`+exec/eval(=`_execute_code` 패턴)으로 **라이브 셸 네임스페이스**에서 멀티라인 평가 → 마지막 표현식 값. `_browse_tabulate`가 결과 타입 분석: 인스턴스 QuerySet(단일 모델·pk → `editable`, `.values()` 단일 SELECT, FK=`_id`), `.values()`/`.values_list(flat)`(읽기전용), 단일 인스턴스(편집 가능), list/제너레이터(`itertools.islice` bound, 읽기전용), 스칼라(단일 `value` 컬럼). 전부 `limit+1` bound, `_browse_cell` 직렬화(암묵적 `__str__` 없음), `orm`=코드 원문, `sql`=`_browse_capture`.
- **렌더**: 패널이 결과를 `schema`(relations:[]) + `rows` 메시지로 합성 전송 → 기존 `onSchema`/`onRows`/`buildCell`/`createEditor`가 **무수정** 렌더. offset 페이지네이션(`loadMore`), Reload=lastCode 재실행.
- **편집**: 결과가 `editable`(+`app`/`model`)이면 기존 인라인 편집/Commit 그대로 → 패널이 `commitEdits`에 쿼리 결과의 app/model 부착해 `commit` kind 재사용(모델 비종속). 그 외 읽기전용.
- **안전/주의**: 이건 *명시적 사용자 eval*(셸 도구 특성) — 그리드의 "암묵적 eval/`__str__` 금지" 원칙과 별개. 멀티라인 할당/임포트는 셸 네임스페이스에 반영(=콘솔과 동일, 의도적). `namespace["_"]`는 미설정. PTY 폴백 등록(터미널에서도 동작).

#### 6.4 페이지 크기 선택 + 쿼리 결과 관계 (✅ 완료)
- **페이지네이션 설정**: 하단바에 rows-per-page `<select>`(50/100/500/1000/5000/10000/all). 웹뷰가 선택값을 모든 로드 메시지(reload/loadMore/applyQuery/runQuery)에 `pageSize`로 첨부 → 패널이 `limit`으로 사용. 백엔드 `_browse_limit(..., maximum=None)`으로 rows/query는 캡 해제(related/lookup은 캡 유지). "all"=거대 sentinel(1e9) → 슬라이스로 전체 로드, PTY에선 25로 자동 축소.
- **쿼리 결과 FK 역참조**: 인스턴스 QuerySet/단일 인스턴스 tabulation에 `_browse_relations(model)` 포함 → 쿼리 콘솔도 모델 브라우저처럼 역참조 FK/M2M를 펼침 칼럼으로 표시. 쿼리 패널이 `expandRelated`(결과의 app/model 사용) + `openModel`(→ `openModelData` 명령) 처리.

#### 6.3 멀티탭 (✅ 완료)
모델 그리드·쿼리 콘솔 모두 **매 open마다 독립 패널(탭)** 생성으로 전환. 기존 단일-재사용 패널을 **매니저 + per-tab 패널** 구조로 리팩터: `ModelBrowser`(명령 등록·패널 집합) + `ModelBrowserPanel`(패널 1개의 filters/order/cursor/offset/편집 상태), `ModelQueryConsole` + `ModelQueryPanel`(lastCode/offset/editTarget). 각 패널은 `disposed` 가드 + `onDidDispose`로 매니저 집합에서 자가 제거, FK "open ↗"은 **새 탭**으로 열림(`openAnother`). 런타임 변경 시 열린 모든 탭을 reload/재실행. 여러 모델·여러 커스텀 조인을 동시에 비교 가능.
- P3b: 행 생성, 행 삭제(cascade 미리보기 + 강한 확인).
- P3c: M2M `set/add/remove`.
- **완료 기준**: 검증 통과 시에만 저장, 실패 시 필드별 에러 표시, 트랜잭션 원자성, 신호(signals) 발화.

## 6. 편집 안전 설계 (P3 상세)

- **편집 대상 필드**: `f.editable and not f.primary_key and not f.auto_created`, `auto_now/auto_now_add` 제외.
- **검증·저장**: 인스턴스 로드 → 속성 세팅 → `instance.full_clean(exclude=...)` → `instance.save(update_fields=[...])`를 `transaction.atomic()`으로 감싼다. `save()`는 signals 발화(앱 무결성 유지). 필드별 `ValidationError`를 구조화해 반환.
- **FK 편집**: `<field>_id = new_pk` + 존재 검증(`rel.filter(pk=new_pk).exists()`), full_clean으로 추가 검증.
- **M2M 편집**(P3c): `update_fields` 불가 → `instance.<m2m>.set([...])` 등 별도 op.
- **생성**: `model(**kwargs)` → full_clean → save.
- **삭제**: `Collector`로 cascade 영향 미리 계산·표시 → 강한 확인 → `instance.delete()`.
- **동시성**: 낙관적 — 편집 시작 시점의 값(`expected`)과 현재 DB 값 비교, 불일치 시 충돌 보고(덮어쓰기 강제는 명시 동작).
- **권한 경고**: 이 도구는 shell 사용자 권한으로 직접 DB를 수정하며 Django auth/permission을 강제하지 않음을 UI에 명시.
- **커밋 모델**: 그리드에서 편집은 스테이징 → 사용자가 "Commit" → 변경 목록 확인 모달 → 백엔드 `mutate`. 함부로 즉시 반영하지 않음.
- **결정**: ✅ **확정 ORM 레벨**(`save()`, signals 발화, `full_clean()` 검증). raw `QuerySet.update()`(신호·검증 우회)는 채택하지 않음(후순위 위험 옵션으로만 검토).

## 7. 테스트

- **단위**(`test/modelBrowser.test.mjs`, `node:test`): 직렬화 인코더, 컬럼/관계 추출(`_meta` 목 또는 경량 모델), keyset/offset 분기, 필터 kwargs 빌더, 편집 검증 매핑. 기존 `backendInspection.test.mjs` 스타일.
- **매니페스트**(`packageManifest.test.mjs`에 assertion 추가): 신규 command/view/activationEvent 존재.
- **E2E**(`test/e2e`): 실제 shell에서 모델 조회/펼침/(P3)편집 시나리오 — 기존 하네스 확장.
- **회귀**: `npm run check` + `npm run test:e2e` 그린 유지 = 기존 기능 불변 확인.

## 8. 리스크 / 미해결 결정

1. ✅ ~~`_base_manager` vs `_default_manager`~~ → **확정 `_base_manager`**.
2. ✅ ~~편집 ORM 레벨~~ → **확정 ORM `save()`/signals/`full_clean()`**.
3. 대형 테이블 `count()`/timeout 정책 — P2.
4. 다중 DB 노출 범위 — 후순위.
5. 그리드 프론트엔드는 vanilla로 채택(P1 `media/modelBrowserSource.js`). 경량 그리드 라이브러리는 미도입.
6. "다건" 관계 펼침이 관련 모델의 default manager를 사용(P1) — 소프트삭제 등 숨김 가능. P2에서 `_base_manager` 통일 검토.
7. 편집(P3) 전까지 그리드는 읽기 전용 — 사용자에게 직접 DB 수정 권한/사이드이펙트 경고 UI는 P3에서.
