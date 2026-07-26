# Django Shell UI 재설계 구현 계획

## 0. 문서의 지위와 실행 계약

이 문서는 `/Users/lky/project/django-shell`의 사용자 노출 UI를 재설계하기 위한 구현 사양이다. 대상 실행자는 Terra Medium이다. 구현 중 별도의 미적 방향, 정보 구조, 반응형 기준, 상태 문구, 성능 기준, 접근성 패턴, 파일 분리 방식, 실환경 실행 명령을 다시 판단하지 않는다.

다음 우선순위를 그대로 따른다.

1. 데이터 안전과 실제 Django shell 실행 의미 보존
2. 장시간 작업의 중단·시간초과·복구
3. 넓은 Django 모델의 DOM 및 접근성 트리 상한 보장
4. 키보드·스크린 리더·고대비·200% 확대 지원
5. 좁은 편집기 그룹과 사이드바 대응
6. VS Code 시각 언어 보존
7. 세부 시각 polish

실행 규칙:

- 이 문서에 정해진 값을 다른 값으로 바꾸지 않는다.
- 대안을 병렬로 구현하거나 A/B 버전을 만들지 않는다.
- 백엔드 ORM 생성, 디버거 엔진, 터미널 전송, 편집 커밋 의미를 UI 개선을 이유로 다시 설계하지 않는다.
- 기존 사용자 변경을 보존한다. 시작 시 `git status --short`를 기록하고 이 작업이 만든 파일만 수정한다.
- 사용자가 명시적으로 요청하지 않는 한 커밋, 푸시, 릴리스, 버전 증가, 설치된 확장 덮어쓰기를 하지 않는다.
- 각 코드 파일은 1000줄 이하를 유지한다.
- 새 코드 파일 첫 줄에 짧은 목적 요약 주석을 둔다.
- 모든 새 클래스·함수·메서드에 JSDoc/docstring 형식 요약을 둔다.
- 900줄을 넘는 기존 파일에는 기능을 추가하지 않는다. 먼저 새 책임별 모듈로 추출한다.
- 코드 변경이 있는 각 단계가 끝날 때 `npm run check`를 실행한다.
- 기능 검증과 렌더링된 UI의 시각 검증을 별도 완료 조건으로 취급한다.

이 문서에서 “완료”는 마지막의 모든 완료 게이트가 통과한 상태만 뜻한다.

## 1. 고정된 제품 방향

### 1.1 Creative North Star

**The Live Django Workbench**

Django Shell은 별도 웹앱처럼 보이면 안 된다. 현재 VS Code 테마 안에 내장된 정밀한 개발 도구처럼 보여야 한다. 사용자에게 가장 중요한 것은 장식이 아니라 다음 상태를 즉시 읽는 것이다.

- 어떤 실제 Django shell에 연결되어 있는가
- 현재 어떤 모델 또는 ORM 쿼리를 다루는가
- 어떤 transport가 선택되었고 실제로 무엇이 사용 중인가
- 작업이 대기·실행·취소·실패·완료 중 어느 상태인가
- 데이터 변경이 로컬에만 staged 되었는가, 실제 저장되었는가
- 실패 또는 지연 후 다음 복구 행동은 무엇인가

### 1.2 시각 다이얼

- 밀도: 9/10
- 모션: 2/10
- 시각적 변주: 2/10
- 장식: 최소
- 깊이: persistent surface는 평면, transient overlay만 shadow
- 글꼴: VS Code UI font와 editor font만 사용
- 색상: semantic `--vscode-*` 변수만 사용
- 아이콘: Codicon만 사용. 텍스트 glyph와 emoji를 아이콘으로 사용하지 않는다.

### 1.3 고정 디자인 문서

구현자는 다음 파일을 규범으로 읽고 따른다.

- `PRODUCT.md`
- `DESIGN.md`
- `.impeccable/design.json`
- 이 문서
- `AGENTS.md`

충돌 시 `AGENTS.md`의 저장소 규칙, `PRODUCT.md`의 제품 보존 규칙, 이 문서의 구현 결정, `DESIGN.md`의 시각 규칙 순으로 적용한다.

## 2. 범위

### 2.1 포함

- Custom Console webview
- Workbench overlay와 Custom Console 사이의 사용자 노출 상태
- Models catalog webview
- Model Data browser webview
- ORM Query webview
- Runtime Inspector native tree
- Debug Analysis native tree
- 관련 command/menu/context 상태
- 모든 loading, empty, error, success, disabled, focus, hover, selected, long-text, dense-data, overflow 상태
- dark, light, high-contrast theme
- 200% zoom
- editor split과 좁은 Activity Bar sidebar
- 실제 `rtcc-poc-page`의 live Django shell 검증

### 2.2 제외

- deprecated notebook console의 재설계
- Django backend ORM 빌더의 기능 확장
- 디버거 엔진 교체
- extension branding, 로고, marketplace banner 변경
- 새 고정 색상 팔레트나 새 글꼴
- 모바일 앱 또는 브라우저 독립형 페이지
- RTCC 데이터의 실제 수정·커밋
- 실환경의 `.env`, 인증 코드, OAuth URL, 토큰 출력 또는 저장

deprecated notebook 관련 command와 serializer는 호환성을 위해 유지한다. 새 UI로 노출을 확대하지 않는다.

## 3. 확인된 기준선

### 3.1 코드 기준선

| Surface | 주요 파일 | 확인된 구조적 위험 |
|---|---|---|
| Console | `src/customConsoleHtml.ts`, `media/customConsoleSource.js` | 좁은 폭에서 toolbar 밀집, setup focus 버튼 glyph, idle debug controls 과다 노출 |
| Models | `src/modelCatalogHtml.ts`, `media/modelCatalogSource.js` | clickable `div`, keyboard tree semantics 없음, 검색 입력 label 없음 |
| Model Data / ORM Query | `src/modelBrowserHtml.ts`, `media/modelBrowserSource.js`, `media/grid*.js` | 한 파일에 큰 inline CSS, 넓은 schema의 셀 폭증, pointer-only resize, query log 공간 고정 |
| ORM Query host | `src/modelQueryConsole.ts`, `src/backendClient.ts`, `src/extension.ts` | request timeout·cancel 없음, duplicate submit 가능, late result만 request id로 무시 |
| Runtime | `src/runtimeInspector.ts` | loading·unavailable·empty 상태 구분이 약함 |
| Debug Analysis | `src/debugAnalysisPanel.ts`, `src/debugAnalysisStore.ts` | idle 상태가 수동 지시문이며 직접 실행 action 없음 |

900줄을 넘는 파일:

- `src/backendClient.ts`: 999줄
- `src/customConsole.ts`: 998줄
- `src/workbenchOverlay.ts`: 999줄
- `src/modelOrm.ts`: 965줄
- `media/modelBrowserSource.js`: 929줄
- `src/workbenchOverlaySyncRenderer.ts`: 904줄

이 파일들에는 직접 기능을 누적하지 않는다. 이 계획의 UI 변경은 작은 모듈에서 구현하고, 기존 파일은 import와 wiring만 담당하게 한다.

### 3.2 실제 제품 기준선

정확한 실환경에서 확인한 내용:

- Port Manager의 다섯 번째 network는 `rtcc`이며 UI에서 `pm5`로 식별된다.
- `/Users/lky/project/rtcc-poc-page`에서 실행해야 한다.
- 정확한 명령은 `./zz django shell`이다.
- `./zz shell`은 잘못된 명령이며 실행하지 않는다.
- 준비 완료 시 `Python 3 / Django ready`가 표시된다.
- 초기 live namespace는 약 5,970개 항목이었다.
- model catalog는 1,310개 모델을 표시했다.
- Python 입력 `1 + 1`은 `Out[1]: 2`로 정상 렌더링되었다.
- `company` 검색은 103개 모델을 반환했다.
- `db.Company`는 첫 페이지 50행이지만 field 수가 매우 많아 접근성 트리가 약 20,000개 이상의 grid/control node로 증가했다.
- 현재 row virtualization은 행 수가 80 이하이면 전부 렌더링한다. 따라서 50행 × 수백 열에서 실질적인 보호가 없다.
- 약 545px split editor에서 제목, status, filter, secondary action이 잘리거나 사라졌다.
- ORM Query 초기 화면은 `Model Data`라는 일반 제목, 큰 빈 공간, 항상 열린 빈 Query Log, 시각적으로 primary처럼 보이는 disabled Commit을 노출했다.
- `Company.objects.all()[:5]` 실행은 3분 54초 이상 `Running query`에 머물렀고, Run disable·Cancel·timeout·recovery가 없었다.

이 기준선은 구현 후 회귀 비교에 사용한다.

## 4. 정확한 실환경 연결 절차

기능 구현의 최종 QA는 다음 절차만 사용한다.

1. Extension Development Host 또는 검증할 VS Code window에서 Command Palette를 연다.
2. `Port Manager: Attach VS Code Window Terminals to Network`를 실행한다.
3. Quick Pick의 다섯 번째 항목 `rtcc`를 선택한다. 이것이 `pm5`다.
4. 다음 확인 알림을 기다린다: `VS Code window terminals now use "rtcc".`
5. Django Shell setup terminal의 working directory를 `/Users/lky/project/rtcc-poc-page`로 둔다.
6. 정확히 다음 명령을 실행한다.

   ```sh
   ./zz django shell
   ```

7. `Python 3 / Django ready`를 확인한다.
8. Models가 로드되고 catalog가 1,310개 모델 수준으로 표시되는지 확인한다.

금지:

- `./zz shell` 실행 금지
- `./manage.py shell`로 대체 금지
- 다른 Port Manager network 선택 금지
- 인증 URL, 브라우저 코드, 환경 변수, token을 로그나 계획 결과에 복사 금지
- `/Users/lky/project/rtcc-poc-page`의 파일 수정 금지
- 실제 RTCC row에 Commit 실행 금지

## 5. 목표 정보 구조

### 5.1 공통 webview band

모든 editor webview는 다음 순서를 사용한다.

1. **Identity band**
   - surface 이름
   - 현재 model/query/runtime context
   - compact 상태
2. **Task band**
   - 현재 작업의 primary action
   - 필요한 context control
   - secondary action overflow
3. **Work area**
   - editor, terminal, model grid, query result
4. **Footer**
   - count, pagination, staged-change actions
5. **Optional drawer**
   - Query Log 또는 secondary details

상태 변화 때문에 band의 위치나 높이가 불필요하게 점프하지 않게 한다.

### 5.2 primary action 규칙

한 context에 시각적 primary button은 하나만 둔다.

- ORM Query: `Run query`
- staged model edits 존재: `Commit N changes`
- staged edits 없음: Commit은 secondary/disabled이며 primary 색을 쓰지 않는다.
- filter builder: `Apply filters`
- aggregate builder: `Run aggregate`
- idle console debug: `Debug`

`Reload`, `Clear`, `Discard`, `Query Log`, `Columns`, `Transport`는 primary가 아니다.

### 5.3 responsive 구간

webview viewport width를 기준으로 한다.

- **Wide:** `>= 960px`
- **Medium:** `640px–959px`
- **Narrow:** `< 640px`

Activity Bar sidebar는 별도 범위로 `200px–360px`를 지원한다.

Wide:

- identity와 action을 가능한 한 한 줄에 표시
- secondary action을 inline 표시
- model context와 transport detail을 full label로 표시

Medium:

- identity band는 한 줄 유지
- task band는 필요하면 정확히 두 줄까지 wrap
- secondary action은 overflow menu로 이동
- title과 subtitle은 ellipsis

Narrow:

- identity와 task band를 두 줄로 분리
- model/query 이름, primary action, runtime state, dirty count는 유지
- filter, columns, aggregate, log, transport selector는 labeled overflow 또는 drawer에 둔다.
- icon-only가 되는 control은 반드시 `aria-label`과 tooltip을 갖는다.
- horizontal clipping으로 control을 잃지 않는다.

## 6. 상태 언어와 state machine

UI 문구는 기존 영어 UI와 일관되게 영어로 유지한다. 아래 문구를 그대로 사용한다.

### 6.1 shell 상태

| 상태 | visible text |
|---|---|
| starting | `Starting Django shell…` |
| setup required | `Start Django in the setup terminal.` |
| ready | `Django ready` |
| executing | `Running Python · Ns` |
| interrupting | `Interrupting Python…` |
| disconnected | `Django shell disconnected` |
| failed | `Django shell failed to start` |

실제 사용자 명령은 프로젝트별로 다를 수 있으므로 일반 제품 코드에 `./zz django shell`을 hard-code하지 않는다. `./zz django shell`은 4장과 20장의 RTCC 실환경 QA 절차에서만 사용한다.

### 6.2 ORM Query 상태

상태 enum:

```text
idle
running
slow
cancelling
succeeded
failed
timedOut
cancelled
```

전이:

```text
idle -> running
running -> slow          after 8,000ms
running|slow -> cancelling  user Interrupt
running|slow -> timedOut    configured timeout
running|slow -> succeeded   valid result
running|slow -> failed      backend error
cancelling -> cancelled     interrupt confirmed
cancelling -> failed        interrupt not confirmed
succeeded|failed|timedOut|cancelled -> running  explicit retry/run
```

visible text:

| 상태 | visible text | action |
|---|---|---|
| idle | `Ready to run a Django ORM query.` | `Run query` |
| running | `Running query · Ns` | `Interrupt` |
| slow | `Still running in the live Django shell · Ns` | `Interrupt` |
| cancelling | `Interrupting query…` | none |
| succeeded | `Loaded N rows in Ts.` | `Run query` |
| failed | `Query failed: {message}` | `Retry` |
| timedOut | `Query interrupted after {timeout}s.` | `Retry` |
| cancelled | `Query interrupted.` | `Run query` |

규칙:

- `Run query`는 running, slow, cancelling 동안 disabled다.
- `Ctrl/Cmd+Enter`도 같은 guard를 사용한다.
- duplicate submit은 backend에 두 번째 request를 보내지 않는다.
- 8초는 안내 전이이며 자동 interrupt하지 않는다.
- 기본 hard timeout은 30,000ms다.
- timeout 시 backend interrupt를 시도하고 request generation을 폐기한다.
- timeout 후 도착한 late result는 화면, pagination, overlay result를 변경하지 않는다.
- panel dispose 중 active query가 있으면 reason `modelQuery.dispose`로 interrupt를 시도한다.
- transport 변경, reload, load more는 active run 중 disabled다.
- interrupt 실패 시 다음 문구를 표시한다: `Interrupt could not be confirmed. Open Django Shell and use Restart Kernel.`
- 이 실패 상태에는 `Open Django Shell` action을 제공한다.

### 6.3 model browser 상태

```text
idle
loadingSchema
loadingRows
ready
filtering
aggregating
loadingMore
editing
committing
busy
failed
```

필수 visible 상태:

- `Loading model schema…`
- `Loading model rows…`
- `Applying filters…`
- `Running aggregate…`
- `Loading more rows…`
- `N uncommitted changes`
- `Committing N changes…`
- `Saved N changes.`
- `Django shell is busy. Retry when the current execution finishes.`
- `{operation} failed: {message}`

loading 또는 error 때문에 이미 로드된 grid를 즉시 지우지 않는다. 새 request가 기존 데이터의 refresh라면 stale grid를 유지하고 status overlay 또는 strip에서 진행 상태를 표시한다. 최초 load 실패에만 work area의 empty/error state를 사용한다.

## 7. 목표 파일 구조

### 7.1 새 파일

다음 파일을 정확히 추가한다.

| 파일 | 책임 | 목표 상한 |
|---|---|---|
| `src/webviewAssets.ts` | script/style webview URI 생성 | 120줄 |
| `src/modelQueryRunController.ts` | query run, slow, timeout, cancel, stale result state machine | 300줄 |
| `media/uiFoundation.css` | reset, shared control, focus, live-region, reduced-motion 규칙 | 220줄 |
| `media/customConsole.css` | console layout와 responsive 규칙 | 350줄 |
| `media/modelCatalog.css` | catalog tree와 states | 220줄 |
| `media/modelBrowser.css` | browser/query/grid/drawer/responsive 규칙 | 600줄 |
| `media/uiAnnouncer.js` | polite/assertive live-region API | 100줄 |
| `media/uiOverflowMenu.js` | secondary action menu keyboard/focus 관리 | 180줄 |
| `media/modelCatalogTree.js` | ARIA tree와 roving tabindex | 260줄 |
| `media/gridViewport.js` | row/column window 계산과 scroll scheduling | 300줄 |
| `media/gridRenderer.js` | virtualized table DOM 생성 | 500줄 |
| `media/gridKeyboard.js` | grid focus와 editing keyboard model | 260줄 |
| `media/modelBrowserChrome.js` | header, drawer, responsive action 배치 | 260줄 |
| `media/queryRunUi.js` | query 상태 표시, elapsed timer, button state | 180줄 |

새 테스트 파일:

| 파일 | 책임 |
|---|---|
| `test/modelQueryRunController.test.mjs` | query state machine |
| `test/gridViewport.test.mjs` | row/column window math와 DOM budget |
| `test/modelGridAccessibility.test.mjs` | ARIA metadata, roving tabindex, sort/edit keys |
| `test/modelCatalogAccessibility.test.mjs` | tree semantics와 keyboard |
| `test/webviewLayoutContract.test.mjs` | CSS links, landmarks, labels, live regions, breakpoints |

### 7.2 수정 파일

- `src/customConsoleHtml.ts`
- `src/modelCatalogHtml.ts`
- `src/modelBrowserHtml.ts`
- `src/modelCatalog.ts`
- `src/modelBrowser.ts`
- `src/modelQueryConsole.ts`
- `src/extension.ts`
- `src/runtimeInspector.ts`
- `src/debugAnalysisPanel.ts`
- `media/customConsoleSource.js`
- `media/modelCatalogSource.js`
- `media/modelBrowserSource.js`
- `media/gridCombobox.js`
- `media/gridFilter.js`
- `media/gridResize.js`
- `media/gridPin.js`
- `media/gridQuery.js`
- `package.json`
- 필요한 기존 test 파일

### 7.3 변경 금지 또는 wiring만 허용

- `src/backendClient.ts`: `interrupt()`가 이미 존재한다. 새 로직을 추가하지 않는다.
- `src/customConsole.ts`: 998줄이므로 새 UI state logic을 넣지 않는다.
- `src/workbenchOverlay.ts`: query run state를 넣지 않는다.
- `src/modelOrm.ts`: UI redesign 때문에 변경하지 않는다.
- `python/django_shell_backend.py`: UI redesign 때문에 변경하지 않는다.

## 8. 공통 기반 구현

### 8.1 `src/webviewAssets.ts`

다음 API만 제공한다.

```ts
export function webviewAssetUri(
  webview: vscode.Webview,
  extensionPath: string,
  ...segments: string[]
): vscode.Uri;

export function webviewStylesheetLinks(
  webview: vscode.Webview,
  extensionPath: string,
  names: string[]
): string;
```

요구:

- HTML escaping이 필요한 문자열을 직접 조합하지 않는다.
- 반환 link는 `rel="stylesheet"`를 사용한다.
- 모든 HTML builder는 `uiFoundation.css`와 자신의 surface CSS를 link한다.
- 기존 CSP의 `style-src ${webview.cspSource}`를 유지한다.
- inline style block은 제거한다.
- inline 동적 style attribute는 grid width와 virtualization offset처럼 런타임 값이 필요한 경우에만 허용한다.

### 8.2 `media/uiFoundation.css`

정확히 포함할 항목:

- `box-sizing`
- body margin, platform font, foreground, editor background
- `.sr-only`
- button, select, input, textarea의 platform token 기반 기본값
- primary/secondary/icon button
- `:focus-visible`
- `[disabled]`, `[aria-disabled="true"]`
- `.status-region`
- `.empty-state`, `.error-state`
- `.codicon` alignment
- `font-variant-numeric: tabular-nums` utility
- `text-overflow: ellipsis` utility
- `@media (prefers-reduced-motion: reduce)`에서 transition, animation, smooth scroll 제거

금지:

- body 또는 control에 fixed hex palette
- global `outline: none`
- 모든 button에 primary background 적용
- focus를 hover와 동일하게 처리

### 8.3 live announcer

각 HTML에 다음 두 region을 body 끝에 둔다.

```html
<div id="politeAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="assertiveAnnouncements" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>
```

`createAnnouncer()`는 다음 메서드를 반환한다.

```js
announceStatus(message)
announceError(message)
clear()
```

같은 메시지 재공지 시 text를 비운 뒤 다음 animation frame에 다시 설정한다. error는 assertive, 나머지 async 상태는 polite를 사용한다.

## 9. ORM Query reliability 구현

이 단계는 P0이며 시각 polish보다 먼저 완료한다.

### 9.1 configuration

`package.json`에 다음 setting을 추가한다.

```json
"djangoShell.modelBrowser.queryTimeoutMs": {
  "type": "number",
  "default": 30000,
  "minimum": 0,
  "maximum": 600000,
  "markdownDescription": "Maximum time in milliseconds for a custom ORM Query run before Django Shell attempts to interrupt it. Set to 0 to disable the automatic timeout. A manual Interrupt action remains available."
}
```

### 9.2 data source interrupt

`ModelDataSource`에 다음 메서드를 추가한다.

```ts
interruptModelQuery(reason: string): Promise<BackendInterruptResult>;
```

`BackendInterruptResult`는 `src/backendClient.ts`에서 type import한다.

`src/extension.ts`의 runtime source 구현은:

- active backend가 있으면 `backend.interrupt(reason)`을 호출한다.
- active backend가 없으면 `{ ok: false, interrupted: false, reason, error: MODEL_IDLE_MESSAGE }`를 반환한다.
- `backendClient.ts`를 수정하지 않는다.

### 9.3 `ModelQueryRunController`

constructor dependency:

```ts
interface ModelQueryRunControllerOptions {
  interrupt(reason: string): Promise<BackendInterruptResult>;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  slowAfterMs?: number;
  timeoutMs: () => number;
  onChange(snapshot: ModelQueryRunSnapshot): void;
}
```

snapshot:

```ts
interface ModelQueryRunSnapshot {
  requestId: number;
  state: "idle" | "running" | "slow" | "cancelling" | "succeeded" | "failed" | "timedOut" | "cancelled";
  startedAt?: number;
  elapsedMs: number;
  error?: string;
  interruptConfirmed?: boolean;
}
```

public API:

```ts
get active(): boolean;
get snapshot(): ModelQueryRunSnapshot;
run<T>(execute: () => Promise<T>): Promise<ModelQueryRunOutcome<T>>;
cancel(reason: "modelQuery.cancel" | "modelQuery.dispose"): Promise<void>;
dispose(): void;
```

구현 결정:

- `slowAfterMs` 기본 8,000.
- `timeoutMs()`는 run 시작 때 `djangoShell.modelBrowser.queryTimeoutMs`의 현재 값을 반환한다.
- `timeoutMs === 0`이면 hard timeout timer를 만들지 않는다.
- `run()` 호출 중 active이면 새 execute를 호출하지 않고 `{ kind: "busy" }`를 반환한다.
- original promise에는 항상 rejection handler를 붙여 late rejection이 unhandled가 되지 않게 한다.
- timeout 시 request generation을 먼저 무효화하고 `interrupt("modelQuery.timeout")`을 호출한다.
- timeout 결과는 original query promise를 기다리지 않고 `timedOut`으로 settle한다.
- cancel도 generation을 먼저 무효화한다.
- dispose는 active timer를 모두 clear하고 best-effort cancel을 시작한다.
- success/failed/cancel/timeout마다 slow와 timeout timer를 clear한다.
- elapsed 화면 갱신은 webview가 수행하며 controller는 초 단위 timer message를 보내지 않는다.

### 9.4 `ModelQueryConsole` wiring

- `queryRequestId`로만 관리하던 실행 lifecycle을 controller로 이동한다.
- overlay draft/result ownership은 그대로 유지한다.
- `runQuery()`는 controller의 `run()`으로 `source.modelQuery()`를 감싼다.
- `busy` outcome이면 추가 post를 하지 않는다.
- success일 때만 `nextOffset`, `current`, `columns`, `lastQueryResult`를 변경한다.
- cancelled/timedOut/late result는 schema, rows, overlay result를 변경하지 않는다.
- query가 running일 때 `queryRunState` message를 post한다.
- webview의 `interruptQuery` message는 controller `cancel("modelQuery.cancel")`에 연결한다.
- panel close는 `cancel("modelQuery.dispose")`를 호출한 뒤 overlay를 release한다.
- `ready`에서 last query를 자동 rerun하는 현재 동작은 유지하되, active run이 없을 때만 수행한다.
- runtime change 시 active query를 cancel하고 stale pagination을 폐기한다.

### 9.5 query client

`queryRunUi.js`가 담당:

- `Run query` label
- `Interrupt`
- elapsed text
- button disable
- `aria-busy`
- live announcement
- Retry
- `Open Django Shell`

`setInterval`은 active 상태에서만 250ms로 동작하고, 표시 문자열은 whole seconds가 바뀔 때만 DOM을 갱신한다. state가 active가 아니면 interval을 해제한다.

### 9.6 query tests

반드시 포함:

1. 즉시 success
2. backend failure
3. 8초 후 slow
4. 30초 timeout 후 interrupt reason 확인
5. timeout 후 late success 무시
6. manual cancel 성공
7. manual cancel 실패
8. running 중 두 번째 Run이 execute를 호출하지 않음
9. running 중 Ctrl/Cmd+Enter가 execute를 호출하지 않음
10. panel dispose가 interrupt를 시도함
11. `timeoutMs=0`은 auto timeout 없음
12. timer가 모든 terminal state에서 해제됨

## 10. Model grid virtualization 구현

이 단계는 P0이다.

### 10.1 기존 문제 제거

`media/gridVirtual.js`의 `RENDER_ALL_MAX = 80`만으로 판단하는 방식을 제거한다. 새 판단은 logical cell count와 viewport를 사용한다.

고정 상수:

```js
const DEFAULT_ROW_HEIGHT = 24;
const ROW_OVERSCAN = 8;
const COLUMN_OVERSCAN = 2;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 480;
const DOM_CELL_BUDGET = 1200;
```

windowing 조건:

- logical rows × logical columns가 900을 초과하면 row와 column을 모두 window한다.
- logical columns가 viewport에 들어오는 column 수 + 4보다 많으면 column windowing을 적용한다.
- logical rows가 80보다 많으면 row windowing을 적용한다.
- 위 조건이 하나라도 참이면 `paintAll()`을 사용하지 않는다.

### 10.2 logical column order

logical order는 다음과 같다.

1. row number
2. pinned fields, 사용자가 pin한 순서
3. 나머지 concrete/annotation columns, schema 순서
4. relations, schema 순서

pin은 logical reorder로 취급한다. `aria-colindex`도 이 순서를 따른다.

### 10.3 column window

`calculateColumnWindow()` 입력:

```js
{
  columns,
  pinnedKeys,
  scrollLeft,
  viewportWidth,
  widths
}
```

출력:

```js
{
  logicalColumns,
  pinned,
  visible,
  leftSpacerWidth,
  rightSpacerWidth,
  totalWidth
}
```

결정:

- row number는 항상 46px.
- 저장된 width가 없으면 160px.
- width는 72–480px로 clamp.
- visible unpinned column range는 현재 horizontal viewport에 교차하는 열 + 양쪽 2개 overscan이다.
- left/right spacer cell은 `role="presentation"`과 `aria-hidden="true"`를 갖는다.
- table 전체 width는 `max(totalWidth, viewportWidth)`다.
- field finder가 offscreen field를 선택하면 해당 offset으로 `scrollLeft`를 설정하고 다음 render 후 header button에 focus한다.
- pinned 영역 합계가 viewport의 50%를 넘게 되는 pin 요청은 거부한다.
- 거부 문구: `Unpin a field before pinning another; pinned fields can use at most half of the grid width.`

### 10.4 row window

`calculateRowWindow()` 입력:

```js
{
  rowCount,
  rowHeight,
  scrollTop,
  viewportHeight
}
```

출력:

```js
{
  first,
  end,
  topSpacerHeight,
  bottomSpacerHeight
}
```

결정:

- visible band + 위아래 8행 overscan
- scroll과 resize render는 `requestAnimationFrame` 하나로 coalesce
- active cell editor가 있으면 해당 row와 column을 window에 강제로 포함한다.
- edit 중 scroll했다고 전체 rerender를 무기한 막지 않는다.
- focus된 logical cell key를 state로 유지하고 rerender 후 동일 cell이 보이면 focus를 복원한다.
- relation detail은 virtual row 높이를 깨지 않도록 grid 아래의 bounded detail drawer에 표시한다.
- 기존 expand/open model 기능은 유지한다.
- detail drawer는 Escape로 닫고 trigger로 focus를 돌려준다.

### 10.5 semantic grid

root table:

```html
<table role="grid" aria-label="{app}.{model} data">
```

ARIA:

- known total count가 있으면 `aria-rowcount = total + 1`
- total이 unknown이면 `aria-rowcount="-1"`
- `aria-colcount = logical columns including row number`
- header row `aria-rowindex="1"`
- data row `aria-rowindex = absolute index + 2`
- row number cell `role="rowheader"`
- data cell `role="gridcell"`
- header action은 실제 `<button>`
- sort header는 `aria-sort="none|ascending|descending"`
- dirty cell accessible description은 `modified, not committed`
- `aria-readonly`는 grid와 cell 편집 가능성에 맞게 설정한다.

roving tabindex:

- grid 전체에 정확히 하나의 `tabindex="0"` cell 또는 header button
- 나머지는 `-1`
- Arrow: 인접 logical cell
- Home/End: 현재 row의 첫/마지막 logical cell
- Ctrl/Cmd+Home: 첫 header 또는 첫 data cell
- Ctrl/Cmd+End: 마지막 loaded row의 마지막 logical cell
- PageUp/PageDown: viewport row 수만큼 이동
- Enter 또는 F2: editable cell 편집 시작
- Escape: edit 취소 또는 열린 detail 닫기
- Enter on relation: detail drawer 열기
- Space on pin/sort button: native button 동작

### 10.6 grid feature 보존

다음 기능을 제거하지 않는다.

- sorting
- filters
- field path filters
- annotations and computed columns
- aggregate mode
- FK lookup and open related model
- related rows
- array editor
- column resize
- column pin
- field finder
- staged edit, discard, commit
- load more
- page size
- count
- transport selector
- SQL/ORM query log

기존 text glyph를 Codicon으로 교체:

- pin `⇤`
- primary-key marker `◆`
- computed load `▷`
- disclosure `▼`
- copy `⎘`
- open `↗`
- close `✕`

PK 자체는 icon만 두지 않고 tooltip과 accessible label `Primary key`를 제공한다.

### 10.7 performance instrumentation

diagnostic logging이 켜진 경우 다음 event를 남긴다.

```text
model.grid.render
```

payload:

```json
{
  "logicalRows": 50,
  "logicalColumns": 300,
  "renderedRows": 40,
  "renderedColumns": 12,
  "renderedCells": 480,
  "ms": 24
}
```

민감한 field value, query text, row data는 기록하지 않는다.

### 10.8 grid tests

synthetic fixtures:

- 5행 × 6열: windowing 없이 전체 render 가능
- 50행 × 300열: rendered cell <= 1,200
- 1,000행 × 20열: rendered cell <= 1,200
- 500행 × 400열: rendered cell <= 1,200
- 3 pinned + offscreen target field
- variable column width 72, 160, 480
- active editor가 viewport 밖으로 이동
- scrollToField 후 target header render와 focus
- sort `aria-sort`
- row/col indices
- dirty accessible label
- unknown total `aria-rowcount=-1`
- detail drawer focus return

## 11. Model Data / ORM Query layout 구현

### 11.1 HTML mode 분리

`modelBrowserHtml()` signature를 다음으로 바꾼다.

```ts
export function modelBrowserHtml(
  webview: vscode.Webview,
  extensionPath: string,
  options: { mode: "model" | "query" }
): string;
```

call sites:

- `ModelBrowser`: `{ mode: "model" }`
- `ModelQueryConsole`: `{ mode: "query" }`

body 또는 root에 `data-surface="model"` / `data-surface="query"`를 둔다.

초기 title:

- model: `Model Data`
- query: `ORM Query`

query mode에서 schema가 오기 전에도 title이 `Model Data`로 보이면 실패다.

### 11.2 model identity band

구성:

- title
- `app.Model`
- database table 또는 result expression은 secondary text
- status region
- primary action
- overflow trigger

긴 model/table/result expression:

- 한 줄 ellipsis
- `title` tooltip
- accessible name에는 full text

### 11.3 task band

model mode:

- Filters
- Columns
- Aggregate
- Transport
- Query Log
- Reload

query mode:

- query editor
- `Run query`
- running일 때 `Interrupt`
- Transport
- Query Log

query editor:

- visible label `Django ORM query`
- help text `Runs in the attached live Django shell. Ctrl/Cmd+Enter to run.`
- initial height 132px
- min 80px
- max 40vh
- fallback textarea와 overlay editor 모두 같은 label/description relationship을 갖는다.
- blank 초기 상태에서 grid 영역은 `Run a query to inspect its rows.` empty state를 표시한다.

### 11.4 footer

왼쪽:

- operation status
- row count
- loaded range

오른쪽:

- page size
- Count
- Load more
- `Discard N`
- `Commit N changes`

staged edits 없음:

- Discard hidden
- Commit disabled secondary style

staged edits 있음:

- footer에 warning state와 `N uncommitted changes`
- Discard visible secondary
- Commit이 현재 context의 primary

committing:

- Commit disabled
- `Committing N changes…`
- 다른 edit와 pagination action disabled

success:

- `Saved N changes.`
- dirty state 제거
- polite announcement

failure:

- dirty state 유지
- `Commit failed: {message}`
- Retry 가능한 Commit 유지
- assertive announcement

### 11.5 Query Log drawer

- 새 panel에서 collapsed
- 사용자 explicit toggle 상태를 `vscode.setState()`에 보존
- 하단 drawer
- 빈 상태: `No commands yet.`
- toggle에 `aria-expanded`, `aria-controls`
- resize handle은 `role="separator"`, `aria-orientation="horizontal"`, `tabindex="0"`
- ArrowUp/ArrowDown: 16px
- Shift+ArrowUp/ArrowDown: 64px
- Home: 최소 120px
- End: viewport의 최대 60%
- pointer drag 유지
- `prefers-reduced-motion`에서 drawer animation 없음

### 11.6 error recovery

최초 load error:

- error title
- message
- `Retry`
- `Open Django Shell` if disconnected

refresh error:

- existing grid 유지
- status strip에 error
- Retry

busy:

- existing grid 유지
- `Django shell is busy. Retry when the current execution finishes.`
- Retry disabled until runtime change 또는 explicit user action

raw stack trace를 기본 UI에 그대로 출력하지 않는다. diagnostics에 상세를 남기고 UI에는 한 문단 message를 쓴다.

## 12. Models catalog 구현

### 12.1 markup

필수 구조:

```html
<section aria-labelledby="modelsHeading">
  <h2 id="modelsHeading">Models</h2>
  <label for="modelSearch" class="sr-only">Search models</label>
  <input id="modelSearch" type="search" ...>
  <div id="catalogStatus" role="status" aria-live="polite"></div>
  <ul id="modelTree" role="tree" aria-label="Django models"></ul>
</section>
```

group:

- `<li role="none">`
- child `<button role="treeitem" aria-expanded="true|false">`
- nested `<ul role="group">`

model:

- `<li role="none">`
- `<button role="treeitem">`
- visible `app.Model`
- secondary table name

clickable `div`는 남기지 않는다.

### 12.2 keyboard

- ArrowDown/ArrowUp: 다음/이전 visible treeitem
- ArrowRight: group expand, 이미 expand면 첫 child
- ArrowLeft: group collapse, 이미 collapse 또는 model이면 parent group
- Home/End: 첫/마지막 visible item
- Enter/Space: group toggle 또는 model open
- type/search input에서 Escape: query clear
- tree에서 `/` 또는 Cmd/Ctrl+F를 가로채지 않는다.

roving tabindex는 정확히 하나만 0이다. refresh와 search 후 가능한 경우 이전 model key를 유지한다.

### 12.3 states

- loading: last catalog가 없으면 skeleton이 아니라 `Loading Django models…`
- stale refresh: 기존 tree 유지 + `Refreshing models…`
- loaded: `N models`
- filtered: `N of M models`
- no result: `No models match “query”.` + `Clear search`
- disconnected: `Open Django Shell to load models.` + `Open Console`
- error: concise message + `Retry`
- 500 render cap 도달: `Showing first 500 matches. Refine your search.`

### 12.4 catalog performance

- 1,310 model data를 group 계산할 때 기존 cache를 유지한다.
- search debounce 100ms.
- query 변경 후 100ms 이내에 status를 갱신한다.
- rendered treeitem은 500 이하.
- DOM node는 2,000 이하.
- highlight markup은 accessible name의 원문을 분절하지 않는다.

## 13. Custom Console 구현

### 13.1 toolbar hierarchy

Identity band:

- `Django Shell`
- runtime status text + Codicon
- `Restart Kernel` secondary action

Python task band:

- Python icon and current overlay tabs
- New tab
- idle이면 `Debug`
- attaching/attached/paused일 때 debug control group
- active transport summary
- transport selector
- Clear

debug controls:

- idle state에서 disabled control 7개를 모두 표시하지 않는다.
- idle: `Debug` 하나
- attaching: `Starting debugger…` + Stop
- running: Pause, Stop, overflow에 step controls는 두지 않는다.
- paused: Continue, Step Over, Step Into, Step Out, Restart, Stop
- keyboard F5/F10/F11/Shift+F11/Shift+F5 기존 command는 그대로 유지한다.

### 13.2 setup cell

- `>` glyph button을 Codicon terminal action으로 교체한다.
- visible tooltip과 `aria-label="Focus setup terminal"`
- setup terminal resize separator의 기존 keyboard semantics 유지 및 focus style 보강
- setup complete 후 minimized state에서도 setup context를 알 수 있게 `Setup terminal · ready`를 유지한다.

### 13.3 status

- dot만으로 state를 표현하지 않는다.
- text는 항상 존재
- significant transition live announce
- elapsed execution time tabular numerals
- reconnect/disconnect/error에 recovery action 제공

### 13.4 responsive

Wide:

- full labels
- active debug controls inline
- transport selector inline

Medium:

- `Debug` label 유지
- transport detail 축약
- Clear와 Restart는 overflow 가능

Narrow:

- status와 active tab 유지
- primary debug/run state 유지
- secondary actions overflow
- control을 단순히 `display:none`으로 없애지 않는다.
- toolbar가 두 줄을 초과하지 않는다.

### 13.5 output

- running, success, error 상태 label 유지
- output code와 result는 editor font
- long output는 horizontal/vertical scrolling을 명확히 제공
- error는 color와 text label을 함께 사용
- empty output region은 숨기되 접근성 트리에 빈 landmark를 남기지 않는다.

## 14. combobox, filter, modal, resize 접근성

### 14.1 combobox

`media/gridCombobox.js`:

- input `role="combobox"`
- `aria-autocomplete="list"`
- `aria-expanded`
- `aria-controls`
- active option에 `aria-activedescendant`
- popup `role="listbox"`
- option `role="option"` + `aria-selected`
- group label `role="group"` 또는 `role="presentation"`와 명시 label
- Escape close + input focus
- Enter select
- Arrow keys
- Home/End
- Tab은 현재 option을 강제 선택하지 않고 정상 이동

### 14.2 filter builder

- 각 term에 visible 또는 screen-reader label
- Negate checkbox label에 field context 포함
- remove button accessible name에 filter description 포함
- invalid condition은 `aria-invalid="true"`와 연결된 inline error
- Apply 중 controls disabled
- active filter chip remove가 keyboard button

### 14.3 array editor

- `role="dialog"`
- `aria-modal="true"`
- title와 description 연결
- open 시 첫 editable control focus
- Tab focus trap
- Escape cancel
- close/save 후 trigger cell focus 복귀
- empty array, invalid JSON, row-level validation, disabled save 상태 구현

### 14.4 resize

column resize:

- focusable separator
- `aria-orientation="vertical"`
- ArrowLeft/Right 8px
- Shift+ArrowLeft/Right 32px
- Home 72px
- End 480px
- `aria-valuemin`, `aria-valuemax`, `aria-valuenow`

Query Log와 console cell resize는 같은 semantics를 쓴다.

## 15. Runtime Inspector 구현

native VS Code `TreeItem`을 유지한다.

### 15.1 root states

- loading: `Loading runtime variables…`, `ThemeIcon("loading~spin")`
- no shell: `Open Django Shell to inspect runtime variables.`, command `djangoShell.openConsole`
- terminal transport unsupported: `Runtime variables unavailable`, description `terminal transport`
- error: concise label, tooltip full message, `ThemeIcon("warning")`
- success with zero user variables: `No user variables yet.`

### 15.2 groups

- Variables
- Loaded Modules
- group label에 count
- long values는 description ellipsis와 tooltip full value
- expandable value는 existing lazy child request 유지
- child request loading과 error를 해당 node 아래에 표시

### 15.3 actions

- Refresh
- Open Console
- Show Environment

기존 view title commands를 유지한다. redundant action이 동시에 같은 아이콘으로 여러 번 보이지 않게 `group` ordering을 정리한다.

## 16. Debug Analysis 구현

native tree를 유지한다.

### 16.1 idle

현재 passive 문구를 command item으로 바꾼다.

- label: `Start Django Shell debugging`
- description: `Inspect paused frames and variables`
- icon: `debug-start`
- command: `djangoShell.debugShell`

### 16.2 states

- starting: spinner + `Debugger attaching`
- attached/running: existing detail
- paused: Paused Frame, Trace, Stack, Variables
- stopped: idle action으로 복귀
- error: concise label, tooltip detail, start/retry action

### 16.3 paused content

- 기존 stable id와 expansion 보존
- variable value에 editor-like representation 유지
- empty scope: `(no visible members)`
- source line은 tooltip full text
- frame location은 filename:line
- color에만 의존하지 않는다.

## 17. responsive secondary action menu

`uiOverflowMenu.js`는 다음 API를 제공한다.

```js
createOverflowMenu({
  trigger,
  menu,
  wideContainer,
  compactContainer,
  actions,
  wideAt: 960,
  narrowAt: 640
})
```

action metadata:

```js
{
  element,
  priority: "primary" | "context" | "secondary",
  compactLabel
}
```

결정:

- `ResizeObserver`로 webview root width를 관찰한다.
- DOM element 하나를 container 사이에서 이동한다. 같은 action을 복제하지 않는다.
- primary는 overflow로 이동하지 않는다.
- secondary는 960 미만에서 menu로 이동한다.
- context는 640 미만에서 menu로 이동할 수 있지만 active model/query/transport state는 별도 읽기 전용 summary로 유지한다.
- trigger는 `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`.
- menu는 `role="menu"`.
- menu item은 native button + `role="menuitem"`.
- open 시 첫 item focus.
- Up/Down, Home/End, Escape.
- 외부 click과 focusout에서 close.
- action 후 close하고 trigger 또는 작업 결과의 합리적 target으로 focus.

## 18. 정확한 시각 상태 매트릭스

| Surface | Loading | Empty | Error | Success | Disabled | Focus | Selected | Long/Dense | Overflow |
|---|---|---|---|---|---|---|---|---|---|
| Console | starting/setup text | output region hidden | inline status + recovery | output item | Python editor lock | all toolbar/editor controls | active tab | long code/output scroll | responsive menu |
| Models | loading status | no matches + clear | retry/open console | count | refresh during active refresh | roving tree | active model/group | truncation + tooltip | 500 cap message |
| Model Data | stable grid progress | no rows | stale grid + retry | row/count status | commit/load/filter guards | grid roving focus | active cell/filter | two-axis virtualization | drawer/menu |
| ORM Query | running + elapsed | run instruction | retry/open console | result count | run duplicate guard | editor/buttons | active result cell | virtual grid | log drawer |
| Runtime | spinner node | no variables | warning node | groups | N/A | native tree focus | native selection | ellipsis + tooltip | native tree |
| Debug | attaching | start action | retry/start | paused groups | invalid controls hidden | native tree focus | native selection | ellipsis + tooltip | native tree |

각 행의 모든 상태를 구현 및 검증하기 전 완료 처리하지 않는다.

## 19. 테스트 전략

### 19.1 phase별 자동 검증

각 코드 phase 종료:

```sh
npm run check
```

최종:

```sh
npm run check
npm run test:e2e
git diff --check
```

실패를 기존 실패라고 추정하지 않는다. 작업 시작 기준선에서도 동일 command를 실행해 baseline을 기록한다. 새 실패와 기존 실패를 구분해 보고한다.

### 19.2 unit/source tests

필수:

- CSS asset가 CSP-compatible link로 포함
- inline giant style block 제거
- icon-only button accessible name
- decorative icon `aria-hidden`
- live regions 존재
- `prefers-reduced-motion`
- 640/960 breakpoints
- query state machine 모든 terminal path
- grid window math
- DOM cell budget
- catalog keyboard
- combobox ARIA
- separator keyboard
- dirty/saved distinction
- no duplicate IDs after responsive action move

### 19.3 functional E2E

기존 behavior:

- console setup
- Python execution
- overlay input and keyboard
- model catalog caching/refresh
- model open
- filter/sort
- field finder
- FK lookup/open
- aggregate
- stage/discard
- test fixture commit
- query overlay run
- load more
- runtime tree
- debug analysis

실제 데이터 write가 필요한 Commit test는 repository의 isolated Django/SQLite fixture에서만 한다.

### 19.4 accessibility audit

실제 렌더링에서 확인:

- keyboard-only full critical path
- focus indicator
- focus order
- focus return
- accessible name
- roles/states/properties
- live announcement
- error association
- tree navigation
- grid navigation
- dialog trap/escape
- high contrast
- 200% zoom
- reduced motion

자동 검사만으로 접근성 완료를 선언하지 않는다.

## 20. 실제 RTCC visual/interaction QA

### 20.1 개발 코드 실행

1. `/Users/lky/project/django-shell`에서 `npm run check`.
2. `.vscode/launch.json`의 `Run Extension`으로 F5를 눌러 Extension Development Host 실행.
3. Development Host에서 `/Users/lky/project/rtcc-poc-page` folder를 연다.
4. 4장의 exact 절차로 pm5/rtcc terminal network를 연결한다.
5. Django Shell을 열고 setup terminal에서 `./zz django shell`.
6. `Python 3 / Django ready` 확인.

설치된 marketplace extension이 아니라 `--extensionDevelopmentPath=/Users/lky/project/django-shell`의 개발 코드가 활성화되었는지 Extension Host와 diagnostics에서 확인한다.

### 20.2 viewport

각 surface를 다음 width에서 확인한다.

- 1200px
- 900px
- 640px
- 545px
- sidebar 320px
- sidebar 240px
- sidebar 200px

테마:

- Dark Modern
- Light Modern
- Dark High Contrast 또는 현재 VS Code high-contrast dark
- Light High Contrast가 설치/지원되면 함께

zoom:

- 100%
- 200%

각 조합 전체를 곱해 모두 검사할 필요는 없다. 다음 최소 조합은 고정한다.

| Theme | Width | Zoom |
|---|---:|---:|
| Dark Modern | 1200 | 100% |
| Dark Modern | 545 | 100% |
| Light Modern | 900 | 100% |
| Dark High Contrast | 640 | 100% |
| Dark Modern | 640 | 200% |
| Light Modern | sidebar 240 | 100% |

### 20.3 안전한 실제 flow

1. Console에서 `1 + 1`; `Out[1]: 2`.
2. Models에서 `company` 검색.
3. keyboard만으로 `db.Company` 열기.
4. Company 50행 load.
5. filter UI 열고 닫기; 실제 data write 없음.
6. column finder로 offscreen field 이동.
7. horizontal/vertical scroll.
8. 한 editable cell을 변경해 dirty UI 확인한 뒤 **Commit하지 않고 Discard**.
9. Query Log open/resize/close.
10. ORM Query에서 빠른 read-only query 실행.
11. controlled slow query를 실행하고 2초 후 Interrupt.
12. Runtime Inspector 열기.
13. Debug Analysis idle action 확인.

빠른 query는 실제 import namespace에서 유효한 가장 단순한 Company queryset을 사용한다. 기존에 검증된 이름을 우선한다.

controlled slow query:

```python
(__import__("time").sleep(60), Company.objects.none())[1]
```

이 query는 DB write를 하지 않는다. 2초 후 UI의 `Interrupt`를 누른다. interrupt 후 Django shell이 다시 Python 실행을 받을 수 있는지 `1 + 1`로 확인한다.

hard timeout 30초는 unit test로 검증한다. 실환경에서 30초를 기다리기 위해 사용자 setting을 변경하지 않는다.

### 20.4 실제 performance 확인

Company grid에서:

- backend response 후 UI가 1초 이내 interaction 가능
- rendered data cell <= 1,200
- 전체 panel accessibility node는 5,000 이하
- scroll 중 100ms 이상 main-thread long task가 반복되지 않음
- field finder가 offscreen field로 정확히 이동
- screen reader/AX tree에 logical row/column count와 visible cell index 존재

Models:

- `company` 입력 후 100ms debounce 다음 frame에 결과 status 갱신
- treeitem <= 500
- keyboard navigation 지연 없음

### 20.5 visual defect 체크

- clipped control 없음
- 겹친 toolbar 없음
- 빈 primary blue disabled button 없음
- title 중복 또는 잘못된 `Model Data` query title 없음
- Query Log가 새 panel의 work area를 선점하지 않음
- dark/light/high contrast에서 border와 focus 구분
- 200% zoom에서 horizontal page-level overflow 때문에 action을 잃지 않음
- tooltip으로만 필수 state를 전달하지 않음
- long model/table/field/query text가 layout을 늘리지 않음
- staged edit와 saved state가 명확히 다름

발견한 defect는 screenshot과 surface/width/theme/steps로 기록하고 수정 후 같은 조건에서 재검증한다. screenshot은 요청이 없으면 commit하지 않는다.

## 21. 단계별 실행 순서

### Phase 0 — 기준선과 보호장치

1. `git status --short` 기록.
2. `npm run check` 실행.
3. 현재 line count 기록.
4. `PRODUCT.md`, `DESIGN.md`, 이 문서 확인.
5. 현재 UI wide/split/sidebar screenshot 로컬 보관.

완료 조건:

- baseline failure 목록 존재
- 사용자 변경과 작업 범위 구분
- 실제 runtime 절차가 준비됨

### Phase 1 — CSS와 semantic foundation

1. `webviewAssets.ts`.
2. shared/surface CSS.
3. HTML inline CSS 제거.
4. live regions.
5. focus/reduced-motion.
6. asset/CSP tests.
7. `npm run check`.

완료 조건:

- 기존 기능 변화 없음
- 세 webview CSS externalized
- dark/light에서 기본 rendering 동일 또는 개선

### Phase 2 — ORM Query lifecycle P0

1. setting.
2. data source interrupt.
3. controller.
4. console wiring.
5. query client UI.
6. unit tests.
7. actual manual Interrupt.
8. `npm run check`.

완료 조건:

- duplicate request 0
- cancel/timeout/late result test
- actual shell recovers after Interrupt

### Phase 3 — Grid virtualization P0

1. viewport math.
2. renderer.
3. keyboard.
4. current features adapter.
5. relation detail drawer.
6. performance log.
7. synthetic tests.
8. Company actual verification.
9. `npm run check`.

완료 조건:

- 50 × 300 fixture cell <= 1,200
- Company panel AX node <= 5,000
- grid feature regression 없음

### Phase 4 — Model Data / ORM Query information architecture

1. mode-specific HTML.
2. identity/task/footer bands.
3. staged edit states.
4. Query Log drawer.
5. responsive overflow.
6. error recovery.
7. viewport/theme QA.
8. `npm run check`.

완료 조건:

- 545px에서 clipped action 없음
- query title 정확
- log default collapsed
- dirty/commit state 명확

### Phase 5 — Models catalog

1. ARIA tree.
2. keyboard.
3. states.
4. performance cap.
5. actual 1,310 model search.
6. `npm run check`.

완료 조건:

- pointer 없이 search→open
- tree roles/expanded/tabindex 정확
- 240px sidebar long text 안정

### Phase 6 — Console

1. CSS/layout.
2. debug control disclosure.
3. glyph to Codicon.
4. status/live announcements.
5. responsive action menu.
6. actual `1 + 1`.
7. debug smoke test.
8. `npm run check`.

완료 조건:

- idle toolbar noise 감소
- debug state별 action 정확
- 545px/200%에서 action 손실 없음

### Phase 7 — Native trees

1. Runtime states/actions.
2. Debug idle command.
3. paused content regression.
4. native theme/keyboard QA.
5. `npm run check`.

완료 조건:

- idle/loading/empty/error 구분
- Debug idle에서 직접 실행 가능

### Phase 8 — 전체 audit와 handoff

1. 전 surface state matrix.
2. accessibility audit.
3. dark/light/high contrast.
4. target viewport.
5. `npm run check`.
6. `npm run test:e2e`.
7. `git diff --check`.
8. line count.
9. final diff review.

완료 조건:

- 22장의 모든 gate 통과
- 남은 limitation이 있으면 재현 단계와 영향 명시

## 22. 완료 게이트

### 22.1 기능

- [ ] pm5/rtcc에서 `./zz django shell`로 ready
- [ ] console Python 실행
- [ ] model catalog load/search/open
- [ ] model rows/filter/sort/count/load more
- [ ] aggregate/computed/related/FK
- [ ] stage/discard
- [ ] isolated fixture commit
- [ ] ORM query run/load more/retry
- [ ] manual interrupt
- [ ] timeout
- [ ] runtime inspector
- [ ] debug analysis

### 22.2 성능

- [ ] 50 × 300 grid rendered cell <= 1,200
- [ ] actual Company panel AX node <= 5,000
- [ ] actual Company backend response 후 interaction <= 1s
- [ ] catalog rendered treeitem <= 500
- [ ] catalog filtered feedback <= 100ms debounce 후 next frame
- [ ] repeated 100ms+ scroll long task 없음

### 22.3 접근성

- [ ] icon-only accessible name
- [ ] decorative icon hidden
- [ ] persistent input label
- [ ] visible focus
- [ ] keyboard tree
- [ ] keyboard grid
- [ ] semantic combobox/listbox
- [ ] semantic dialog/focus trap
- [ ] semantic separators
- [ ] live running/success/error
- [ ] non-color state
- [ ] reduced motion
- [ ] high contrast
- [ ] 200% zoom

### 22.4 responsive/visual

- [ ] 1200px
- [ ] 900px
- [ ] 640px
- [ ] 545px
- [ ] sidebar 320/240/200px
- [ ] Dark Modern
- [ ] Light Modern
- [ ] High Contrast
- [ ] no clipped controls
- [ ] no unintended page overflow
- [ ] no title/state loss
- [ ] Query Log collapsed default
- [ ] staged vs saved distinction

### 22.5 repository

- [ ] every code file <=1000 lines
- [ ] first-line purpose comments
- [ ] JSDoc/docstrings
- [ ] `npm run check`
- [ ] `npm run test:e2e`
- [ ] `git diff --check`
- [ ] no generated output omitted
- [ ] no unrelated user changes modified
- [ ] no RTCC project changes
- [ ] no secrets captured

## 23. Terra Medium 최종 작업 체크리스트

Terra Medium은 다음 순서대로만 작업한다.

1. 저장소와 dirty state 확인.
2. 문서 4개 읽기.
3. baseline `npm run check`.
4. Phase 1 구현·검증.
5. Phase 2 구현·검증.
6. Phase 3 구현·검증.
7. Phase 4 구현·검증.
8. Phase 5 구현·검증.
9. Phase 6 구현·검증.
10. Phase 7 구현·검증.
11. Phase 8 전체 검증.
12. pm5/rtcc 연결.
13. `/Users/lky/project/rtcc-poc-page`.
14. `./zz django shell`.
15. 안전한 actual flow.
16. completion gates 확인.
17. 변경 파일, 테스트 결과, 실제 visual QA, 남은 limitation 보고.

판단을 요구하는 미정 항목은 없다. 구현 중 기술적 장애가 생기면 이 문서의 제품 결정을 바꾸지 말고, 같은 사용자 결과를 보존하는 가장 작은 내부 구현 수정만 허용한다. 사용자 결과를 바꿔야만 해결 가능한 장애라면 추측하지 말고 그 지점에서 blocker와 재현 증거를 보고한다.
