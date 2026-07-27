# Model Data Query Builder UI 사용성 개선 구현 계획

> 상태: 구현 승인용 고정 계획
>
> 작성일: 2026-07-26
>
> 대상 저장소: `/Users/lky/project/django-shell`
>
> 실제 통합 검증 대상: `/Users/lky/project/rtcc-poc-page`
>
> 구현 담당 모델 기준: Terra High
>
> 문서 성격: 추가 설계 없이 그대로 실행하는 구현 명세

---

## 0. 이 문서의 권한과 실행 규칙

이 문서는 현재 Model Data Query Builder의 UI 사용성을 개선하기 위한 최종 구현 계약이다.

구현자는 이 문서에 명시된 정보 구조, 상태 모델, 상호작용, 문구, 반응형 동작, 파일 분리, 단계 순서, 테스트 게이트를 변경하지 않는다.

구현 중 선택지가 생기면 다음 우선순위로 처리한다.

1. 이 문서의 명시적 계약
2. 저장소 루트의 `AGENTS.md`
3. `DESIGN.md`
4. `PRODUCT.md`
5. 기존 Recipe V2, compiler, validator, transport, safety 계약
6. 인접한 Model Data 및 Query Log UI의 기존 관례

위 문서와 구현이 충돌하면 구현을 이 문서에 맞춘다. 다만 Recipe 의미론, 보안 제한, 서버 검증 계약과 충돌하면 UI 계획을 임의로 우회하지 말고 해당 단계 작업을 중지하고 충돌을 기록한다.

이 계획의 구현 과정에서 새로운 제품 설계 회의를 열거나 다음 항목을 재결정하지 않는다.

- 별도의 페이지나 모달로 전환할지
- wizard 형태로 바꿀지
- React 또는 다른 UI 프레임워크를 도입할지
- 새로운 색상 체계나 typography를 만들지
- Query Recipe 스키마를 변경할지
- backend query semantics를 확장할지
- Apply 안전 정책을 완화할지

### 0.1 완료의 정의

다음 조건을 모두 만족해야 계획이 완료된다.

- 입력 중인 텍스트, caret, 선택 범위, 열려 있는 편집 항목, 단계별 scroll 위치가 관련 없는 draft 변경 때문에 사라지지 않는다.
- Query Builder는 네 개의 편집 단계와 하나의 Review 영역으로 재구성된다.
- 일반적인 편집에서는 긴 단일 세로 문서를 반복해서 왕복하지 않는다.
- wide, medium, narrow 레이아웃이 이 문서에 지정된 방식으로 동작한다.
- 사용자가 보는 Apply 진입점은 drawer 상태에 따라 정확히 하나다.
- 오류의 원인, 수정 방법, 영향을 받은 control이 화면에 보이며 keyboard로 이동할 수 있다.
- field/reference 선택은 metadata 기반 검색형 picker로 통일된다.
- 복잡한 scalar subquery가 단계적인 필드 그룹과 설명을 통해 편집된다.
- Undo/Redo가 Recipe 편집 단위로 동작한다.
- local validation, host preview, Apply, row refresh 상태가 서로 구분된다.
- dark, light, high contrast, 200% zoom에서 내용 손실과 조작 불가 상태가 없다.
- 모든 새 source code가 1000줄 이하이고 첫 줄 purpose comment 및 모든 함수·클래스의 summary 문서를 갖는다.
- `npm run check`가 성공한다.
- 실제 `rtcc-poc-page`에서 정확한 네트워크 및 Django shell 절차로 통합 검증을 마친다.

---

## 1. 사용한 스킬과 판단 근거

이 계획은 다음 UI 전문 스킬의 지침을 결합해 작성했다.

### 1.1 `$ui-design-workflow`

적용 범위:

- 구현 전에 제품 및 디자인 시스템을 먼저 확인
- substantial UI 변경에 명시적 design direction과 acceptance check 수립
- 기능 QA와 시각 QA 분리
- 실제 VS Code webview에서 인접 UI와 현재 상태 확인
- loading, empty, error, success, disabled, focus, hover, selected, long text, dense data, overflow 상태 포함

이 계획에 반영된 결정:

- 기존 Live Django Workbench의 시각 언어를 유지한다.
- Query Builder를 독립 제품처럼 재브랜딩하지 않는다.
- 구현 전에 렌더 안정성 P0를 해결한다.
- 각 구현 phase에는 기능 게이트와 시각 게이트를 별도로 둔다.

### 1.2 `$ui-ux-pro-max`

검색한 문제 영역:

- developer tool visual query builder
- dense forms
- progressive disclosure
- keyboard interaction
- inline validation
- nested conditions
- data-heavy admin tool

채택한 원칙:

- 복잡한 작업을 단계로 나누되 임의의 순서를 강제하지 않는 progressive disclosure
- 각 control의 visible label
- keyboard-only 완전 조작
- inline error와 전체 Problems 요약 병행
- 오류를 고친 후 회복 경로와 Undo 제공
- 큰 option 집합은 bounded rendering과 검색 제공
- 동작 결과와 진행 상태를 즉시 표시

채택하지 않은 제안:

- 보라색 중심의 별도 palette
- 큰 marketing-style heading
- block 또는 card-dashboard 스타일
- 강한 animation 및 decorative visual
- 외부 font 도입

거부 이유:

- `DESIGN.md`가 VS Code semantic token, compact workbench, flat surface를 제품 authority로 규정한다.
- Query Builder는 IDE 안의 개발 도구이지 독립 landing page가 아니다.

### 1.3 `$impeccable`

적용한 critique 관점:

- 한 화면에 동시에 노출되는 결정 수
- 반복되는 설명과 중복 action
- 불필요한 sticky 영역이 실제 편집 공간을 잠식하는지
- progressive disclosure가 상태 손실 없이 동작하는지
- secondary action이 primary action처럼 보이는지
- dense tool에서 정보 위계가 일관되는지

이 계획에 반영된 결정:

- 모든 section을 한 scroll container에 세로로 쌓지 않는다.
- Query Builder header의 긴 안내문을 제거한다.
- Apply는 한 곳만 primary로 보인다.
- Clear/Reset은 overflow menu로 이동한다.
- Review 정보는 editor와 분리하되 항상 접근 가능하게 한다.
- 일반 mode와 Focus Builder mode를 분리한다.

`impeccable` context 검사에서 `.impeccable/design.json`이 현재 `DESIGN.md`보다 오래된 sidecar임을 확인했다. 이 구현 계획은 `DESIGN.md`를 authority로 사용한다. sidecar 갱신은 이 계획의 구현 범위가 아니다.

### 1.4 `$web-design-guidelines`

2026-07-26 기준 최신 Web Interface Guidelines를 확인해 다음 항목을 계획에 포함했다.

- semantic HTML과 explicit label
- icon-only button의 accessible name
- visible focus 및 `:focus-visible`
- inline error와 첫 오류 focus
- destructive action의 confirmation 또는 undo
- 긴 text와 flex child의 `min-width: 0`
- 50개가 넘는 option의 bounded rendering
- controlled input 경로의 저비용 처리
- drawer의 `overscroll-behavior`
- native select의 theme 호환
- 문제 메시지에 복구 방법 포함
- `transition: all` 금지
- focus outline 제거 시 동등 이상의 대체 표시 필수

참조:

- <https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md>

### 1.5 스킬 판단의 최종 결론

이 개선의 design direction은 다음 한 문장으로 고정한다.

> 기존 VS Code workbench 안에서 Recipe의 네 편집 단계를 빠르게 오가고, 선택한 단계와 문제를 같은 맥락에서 검토하며, 입력 상태를 절대 잃지 않는 Progressive Query Workbench.

---

## 2. 조사 범위와 현재 기준선

### 2.1 확인한 제품 문서

- `PRODUCT.md`
- `DESIGN.md`
- `AGENTS.md`
- `MODEL_DATA_QUERY_BUILDER_GUIDANCE_IMPLEMENTATION_PLAN.md`

기존 guidance plan은 친절한 설명, validation, Recipe semantics를 다룬다. 이 문서는 그 결과를 폐기하지 않고 실제 UI 조립 흐름과 지속적인 편집 상태를 개선한다.

### 2.2 확인한 핵심 구현 파일

- `src/modelBrowserHtml.ts`
- `src/modelBrowser.ts`
- `media/modelBrowserSource.js`
- `media/gridQueryController.js`
- `media/gridQueryRecipeStore.js`
- `media/gridPredicateBuilder.js`
- `media/gridComputedBuilder.js`
- `media/gridSubqueryBuilder.js`
- `media/gridAggregateBuilder.js`
- `media/gridQueryFieldPicker.js`
- `media/gridCombobox.js`
- `media/gridQueryValidationView.js`
- `media/gridQueryExplanation.js`
- `media/gridQueryGuidanceView.js`
- `media/modelQueryBuilder.css`
- `media/modelQueryGuidance.css`
- 관련 `test/*.test.mjs`

### 2.3 실제 UI 확인 환경

다음 실제 상태를 VS Code의 `rtcc-poc-page` workspace에서 read-only로 확인했다.

- Model Data가 `db.Company`를 열고 있음
- Link가 ORM으로 선택됨
- grid row가 로드된 상태
- Query Builder draft에 하나의 scalar subquery computed item이 있음
- draft는 dirty이며 validation error가 표시됨
- Query Builder drawer가 열려 있음
- VS Code 전체 창은 약 `1296 × 768`
- sidebar와 bottom panel이 함께 열린 실제 편집 폭에서 Model Data webview 편집 영역은 약 700px
- drawer의 실제 편집 가능 높이는 약 220px

확인 결과:

- 모든 section이 하나의 bounded scroll 영역에 수직으로 쌓여 있다.
- header와 footer가 sticky로 같은 scroll 영역의 높이를 계속 차지한다.
- scalar subquery의 source, correlation, returned value, order를 확인하려면 drawer 안에서 여러 화면을 왕복해야 한다.
- 상단 summary의 Apply와 drawer footer Apply가 동시에 보인다.
- Reset, Clear, 긴 safety 안내가 작은 header에 함께 몰린다.
- 문제와 ORM preview를 보려면 편집 section을 벗어나 아래로 이동해야 한다.

검사 후 draft는 수정하지 않았고, 열어 본 computed disclosure와 scroll 위치는 원래 상태로 되돌렸다.

### 2.4 코드 검색 도구 상태

저장소 semantic index는 연결되어 있었지만 search index가 준비되지 않은 상태였다. 따라서 정확한 text search와 선택적 source read로 기준선을 확인했다. 구현자는 index rebuild를 계획의 전제 조건으로 삼지 않는다.

---

## 3. 현재 한계 분석

### 3.1 P0 — 편집 상태와 focus를 잃는 전체 재마운트

현재 `gridQueryController.js`의 `render()`는 매번 `renderSectionStates()`를 호출한다.

`renderSectionStates()`는 다음 작업을 모두 수행한다.

- 두 predicate builder를 destroy
- 두 predicate builder를 새로 mount
- computed builder를 새로 mount
- Result control DOM 전체 교체
- guidance 영역 전체 갱신

영향:

- alias input의 `input` event가 store dispatch를 일으키면 computed item이 새 instance로 바뀐다.
- computed builder 내부 `openItems`가 새 `Set`으로 초기화된다.
- caret 위치와 selection range가 사라질 수 있다.
- 현재 열어 둔 disclosure가 접힌다.
- predicate builder의 queued focus request가 실행되기 전에 builder가 destroy될 수 있다.
- 같은 section 안의 scroll 위치가 튄다.
- assistive technology가 새 DOM을 반복해서 읽을 수 있다.

이 문제는 레이아웃 polish보다 먼저 해결한다.

### 3.2 P0 — 하나의 변경이 중복 render를 유발

현재 `store.subscribe()`는 draft revision 변경 시 `schedulePreview()`를 호출한다.

`schedulePreview()`는 즉시 `checking = true`로 바꾸고 `render()`를 호출한다.

그 뒤 subscriber가 다시 `render(snapshot)`을 호출한다.

영향:

- 한 action이 최소 두 번의 full remount를 일으킨다.
- 두 번째 render는 subscriber에 전달된 이전 snapshot과 별도 mutable controller state를 섞을 수 있다.
- validation live region이 중복 announce될 수 있다.
- DOM 교체 비용과 focus 불안정이 배가된다.

### 3.3 P0 — structural focus 계약이 실제 lifecycle과 맞지 않음

predicate builder는 add/remove/move 뒤 focus를 옮기려는 내부 요청을 갖지만, store publish가 동기적으로 상위 full render를 유발한다.

영향:

- 새 condition 추가 뒤 field로 이동해야 할 focus가 사라진다.
- 삭제 후 다음 적절한 target으로 이동하지 않는다.
- keyboard 사용자에게 조작 결과가 불명확하다.

### 3.4 P1 — 정보 구조가 Recipe 조립 순서와 맞지 않음

현재 section 순서는 Recipe pipeline에 대응하지만 모든 section이 동시에 한 문서에 있다.

사용자는 다음 질문에 빠르게 답하기 어렵다.

- 지금 어느 단계의 값을 편집 중인가?
- 이 단계에 몇 개의 condition 또는 error가 있는가?
- validation 문제는 어느 단계에 속하는가?
- 계산 값을 만든 뒤 어디에서 결과 필터에 사용할 수 있는가?
- Apply 전에 전체 의미와 ORM을 어디서 검토하는가?

### 3.5 P1 — 편집과 검토가 같은 scroll 축을 공유

Meaning, implicit behavior, Problems, ORM preview가 편집 section 아래에 있다.

영향:

- 위에서 field를 수정하고 아래에서 preview를 확인하는 반복 비용이 크다.
- error를 누르면 사용자 맥락이 갑자기 다른 scroll 위치로 이동한다.
- wide 화면에서도 남는 가로 공간을 활용하지 못한다.

### 3.6 P1 — Query Builder header와 Apply action이 중복되고 혼잡함

현재 header에는 다음이 한 줄에 있다.

- 제목
- Reset draft
- Clear
- 긴 “Changes here stay in Draft…” 안내

동시에 상단 summary와 drawer footer에 Apply가 두 개 존재한다.

영향:

- primary action hierarchy가 흐려진다.
- 작은 폭에서 안내문과 action이 서로 밀어낸다.
- Reset과 Clear의 차이가 충분히 설명되지 않는다.
- drawer가 열려도 어느 Apply를 써야 하는지 모호하다.

### 3.7 P1 — Apply 가능 조건이 dirty를 포함하지 않음

현재 `canApply`는 source, validation, checking, applying을 검사하지만 draft가 applied와 같은지는 검사하지 않는다.

영향:

- 변경이 없는 상태에서도 Apply가 활성화될 수 있다.
- 사용자가 서버 요청이 필요한 상태인지 판단하기 어렵다.

### 3.8 P1 — validation lifecycle이 지나치게 단순함

현재 draft가 바뀌는 즉시 `checking = true`가 되고 250ms timer가 시작된다.

영향:

- 사용자가 연속 입력 중일 때 화면이 계속 Checking 상태로 보인다.
- “아직 전송 전”, “host 검증 중”, “검증 완료”, “Apply 중”, “rows 갱신 중”이 구분되지 않는다.
- 이전 ORM preview가 남아도 최신 draft의 preview처럼 보일 수 있다.

### 3.9 P1 — Problems가 수정 설명보다 위치 이동에 치우침

현재 issue button에 fix text는 보이지만 상세 explanation은 `title` 의존성이 있다.

영향:

- touch, keyboard, screen reader, tooltip을 기다리지 않는 사용자에게 원인이 충분히 보이지 않는다.
- issue가 어느 stage와 control에 매핑되는지 구조적으로 드러나지 않는다.

### 3.10 P1 — scalar subquery가 metadata picker를 충분히 사용하지 않음

현재 scalar subquery의 relation/correlation/select/order 일부는 raw text input이다.

영향:

- 허용 가능한 path를 기억해야 한다.
- outer field와 inner field의 방향을 혼동하기 쉽다.
- typo가 host validation 전까지 발견되지 않는다.
- 사용자가 Django ORM의 Subquery/OuterRef 구조를 이미 알아야 한다.

### 3.11 P1 — aggregate source field도 flat native select에 의존

관계 path, field type, label, 현재 target model을 단계적으로 보여 주지 않는다.

영향:

- 긴 path가 잘린다.
- 많은 field에서 탐색 비용이 커진다.
- direct field와 relation traversal을 구분하기 어렵다.

### 3.12 P1 — combobox popup이 overflow container에 갇힘

field picker popup은 drawer 내부 absolute positioning이다.

영향:

- sticky header/footer와 drawer overflow에 의해 잘릴 수 있다.
- 아래 공간이 부족해도 위로 열리지 않는다.
- scroll/resize 때 anchor와 popup 위치가 어긋날 수 있다.

### 3.13 P1 — 큰 option 집합을 전부 렌더

현재 combobox는 모든 option을 DOM에 렌더할 수 있다.

영향:

- model이 크거나 relation path 후보가 많을 때 입력 반응성이 떨어진다.
- screen reader가 지나치게 큰 listbox를 탐색해야 한다.

### 3.14 P1 — predicate row의 control 위계가 약함

현재 nested condition은 cramped flex row이고 대부분 aria label에 의존한다.

영향:

- Field, Comparison, Compare With, Value의 관계가 화면에 명확하지 않다.
- 모든 structural button이 기본 primary 스타일에 가까워 Apply와 경쟁한다.
- Up/Down이 Unicode glyph에 의존한다.
- join selector가 child 수와 관계없이 노출될 수 있다.

### 3.15 P1 — computed item의 type 변경이 잠재적으로 파괴적

computed kind를 바꾸면 기존 kind-specific 설정을 잃을 수 있으나 충분한 inline confirmation과 Undo가 없다.

### 3.16 P2 — 의미 설명의 code 표현과 transport 정보가 부정확

현재 plain meaning에 backtick 문자가 text로 보이며 실제 `<code>` semantics가 아니다.

transport 표현은 `"the active link"`로 고정되어 실제 Link 상태를 구체적으로 보여 주지 않는다.

### 3.17 P2 — ORM copy 실패가 조용히 무시됨

clipboard 권한이 거부되면 selectable preview는 남지만 사용자가 실패 여부를 알 수 없다.

### 3.18 P2 — 자동화가 source string contract에 치우침

현재 test는 많은 경우 source string과 reducer contract를 검증한다.

다음 회귀를 직접 잡지 못한다.

- typing 중 focus/caret 유지
- disclosure open 상태 유지
- stage scroll 유지
- popup clipping
- issue focus 이동
- keyboard tab navigation
- wide/medium/narrow layout
- 200% zoom overflow

---

## 4. 목표, 비목표, 제품 원칙

### 4.1 사용자 목표

주요 사용자는 Django와 ORM에 익숙한 개발자다.

개선 후 사용자는 다음을 할 수 있어야 한다.

1. 원하는 Recipe 단계를 바로 연다.
2. metadata를 검색해 field와 relation을 선택한다.
3. condition과 computed item을 keyboard로 추가·복제·이동·삭제한다.
4. 편집 중 focus와 open state를 잃지 않는다.
5. 현재 단계의 의미와 오류를 인접한 Review에서 확인한다.
6. Undo로 실수를 복구한다.
7. Apply가 가능한지, 불가능하다면 무엇을 고쳐야 하는지 즉시 안다.
8. Apply 전 ORM preview가 최신 검증 결과인지 구분한다.
9. Apply 후 grid가 갱신되는 lifecycle을 이해한다.

### 4.2 제품 원칙

#### 원칙 A — Recipe pipeline을 보여 주되 순서를 강제하지 않는다

단계는 이해를 돕는 navigation이다. wizard가 아니다.

사용자는 어느 단계든 바로 이동할 수 있다.

#### 원칙 B — draft와 applied를 항상 분리한다

editor의 변경은 Apply 성공 전 grid를 바꾸지 않는다.

drawer를 닫아도 draft는 유지한다.

#### 원칙 C — 하나의 화면에 하나의 primary Apply만 보인다

drawer가 닫혔으면 summary Apply, 열렸으면 drawer footer Apply를 사용한다.

#### 원칙 D — 설명은 작업 지점 가까이에 둔다

짧은 도움말은 control 옆에 둔다.

긴 의미, 문제 목록, ORM은 Review에 둔다.

#### 원칙 E — 편집 상태 보존은 기능 요구사항이다

focus, caret, selection, disclosure, scroll 보존은 polish가 아니라 acceptance criterion이다.

#### 원칙 F — VS Code의 언어를 사용한다

기존 semantic token, Codicon, compact density, focus ring, native webview behavior를 유지한다.

### 4.3 명시적 비목표

다음은 구현하지 않는다.

- ModelQueryRecipeV3
- 새로운 query operator 또는 expression kind
- annotation/subquery compiler 의미 변경
- validation limit 완화
- raw SQL editor
- drag-and-drop만 가능한 reorder
- Query Builder 전용 route 또는 webview
- modal 기반 wizard
- grid virtualizer 교체
- Model Data edit/commit 흐름 변경
- Query Log 재설계
- transport protocol 재설계
- 새로운 backend endpoint
- React, Vue, Svelte 등 framework 도입
- 외부 combobox 또는 form dependency
- custom font, gradient, shadow-heavy card
- Recipe literal을 `vscode.setState()`에 저장

---

## 5. 고정 정보 구조

### 5.1 전체 구조

Query Builder는 다음 계층을 갖는다.

```text
Model Data
├─ Model toolbar
├─ Filter summary
├─ Query summary band
├─ Query Builder resize separator       drawer open일 때만
├─ Query Builder
│  ├─ Header                           scroll하지 않음
│  ├─ Stage navigation                 scroll하지 않음
│  ├─ Workspace
│  │  ├─ Active editor stage
│  │  └─ Review inspector              wide에서 나란히
│  └─ Footer                           scroll하지 않음
├─ Data grid
└─ Grid footer
```

기존 전체 Model Data layout 안에 머무른다.

### 5.2 네 개의 편집 단계

stage ID, label, Recipe 영역을 다음으로 고정한다.

| 순서 | stage ID | 표시 label | Recipe 영역 | 설명 |
|---|---|---|---|---|
| 1 | `filterRows` | `Filter Rows` | `where` | 원본 row를 먼저 거른다 |
| 2 | `calculatedValues` | `Calculated Values` | `computed` | annotation, aggregate, subquery 등을 만든다 |
| 3 | `filterResults` | `Filter Results` | `postFilter` | 계산 결과를 포함한 최종 값을 거른다 |
| 4 | `result` | `Result` | `mode`, `groupBy`, `orderBy` | rows/summary와 순서를 정한다 |

“Review Query”는 다섯 번째 Recipe 단계가 아니다.

Review는 editor를 보조하는 inspector다.

### 5.3 Review inspector tab

tab ID와 label을 다음으로 고정한다.

| tab ID | label | badge | 내용 |
|---|---|---|---|
| `meaning` | `Meaning` | 없음 | 전체 pipeline과 선택 node의 자연어 의미 |
| `problems` | `Problems` | issue 수 | error/warning 목록과 fix |
| `orm` | `Django ORM` | 최신성 상태 | host가 검증한 ORM preview |

### 5.4 wide wireframe

적용 조건: Query Builder 자체의 available width가 `960px` 이상.

```text
┌ Query Builder ─ Draft changed ───────── Undo Redo Focus Builder ⋯ Close ┐
├ [1 Filter Rows 2] [2 Calculated Values 1 !] [3 Filter Results 0] [4 Result] ┤
├──────────────────────────────────────────────┬───────────────────────────┤
│ Active stage editor                          │ Meaning | Problems 2 | ORM │
│                                              │                           │
│ stage-local toolbar                          │ selected node context     │
│ condition/computed/result controls           │ visible fixes / preview   │
│                                              │                           │
├──────────────────────────────────────────────┴───────────────────────────┤
│ Draft is not applied to the grid.     validation status   Apply query    │
└───────────────────────────────────────────────────────────────────────────┘
```

workspace column 규칙:

- editor: `minmax(0, 1fr)`
- inspector: `clamp(320px, 34%, 380px)`
- separator: `1px solid var(--vscode-panel-border)`
- inspector width를 사용자가 resize하는 기능은 이번 범위에 넣지 않는다.

### 5.5 medium wireframe

적용 조건: available width `640px` 이상, `960px` 미만.

```text
┌ Query Builder ─ Draft changed ─ Undo Redo Focus ⋯ Close ┐
├ [Filter Rows 2] [Calculated 1 !] [Results 0] [Result] [Review 2] ┤
├──────────────────────────────────────────────────────────┤
│ Editor 또는 Review 중 하나                               │
│ 현재 선택 pane만 표시                                   │
├──────────────────────────────────────────────────────────┤
│ status                                      Apply query  │
└──────────────────────────────────────────────────────────┘
```

규칙:

- Review button은 inspector pane을 연다.
- Review에서 editor로 돌아가면 마지막 active stage로 복귀한다.
- active stage는 바뀌지 않는다.
- editor와 inspector DOM은 모두 유지하되 비활성 pane을 `hidden` 및 `inert` 처리한다.

### 5.6 narrow wireframe

적용 조건: available width `640px` 미만.

```text
┌ Query Builder ─ Draft changed ─ ⋯ Close ┐
├ [ Stage: Filter Rows              ▾ ]   │
├ [ Edit ] [ Review 2 ]                  │
├─────────────────────────────────────────┤
│ one-column controls                     │
│ field                                   │
│ comparison                              │
│ compare with                            │
│ value                                   │
├─────────────────────────────────────────┤
│ status                                  │
│                         Apply query     │
└─────────────────────────────────────────┘
```

규칙:

- stage tab row 대신 visible label `Stage`를 가진 native `<select>`를 사용한다.
- Edit/Review는 두 개의 button segment다.
- footer는 두 줄까지 허용한다.
- action label을 숨길 때 icon-only button에는 accessible name과 tooltip이 반드시 있다.
- horizontal scroll로 전체 form을 조작하게 만들지 않는다.

---

## 6. Query Builder shell 상세 명세

### 6.1 summary band

drawer가 닫힌 상태:

- Filter count button
- Calculated count button
- Result mode button
- human summary
- draft/applied state
- validation state
- `Open Query Builder`
- `Apply query`

drawer가 열린 상태:

- 위 요약 정보는 유지한다.
- `Open Query Builder`는 expanded state를 표시한다.
- summary의 `Apply query`는 `hidden`으로 제거한다.
- 단순 CSS opacity 또는 offscreen 처리로 중복 focus target을 남기지 않는다.

summary에서 제거할 것:

- 긴 apply help 문장
- drawer footer와 중복되는 상세 validation 원인

summary visible status 문구:

| 상태 | 문구 |
|---|---|
| clean | `Applied` |
| dirty, preview timer 전 | `Draft changed` |
| host preview 중 | `Checking draft…` |
| valid | `Ready to apply` |
| warnings only | `Ready · N warnings` |
| errors | `N errors` |
| applying | `Applying…` |
| rows refresh | `Loading results…` |

### 6.2 resize separator

Query Builder가 열리면 summary band와 drawer 사이에 separator를 추가한다.

DOM 계약:

```html
<div
  id="queryDrawerResizeHandle"
  class="query-drawer-resize-handle"
  role="separator"
  aria-label="Resize Query Builder"
  aria-orientation="horizontal"
  aria-valuemin="..."
  aria-valuemax="..."
  aria-valuenow="..."
  tabindex="0">
</div>
```

pointer 동작:

- pointer capture를 사용한다.
- 위로 drag하면 drawer가 커진다.
- 아래로 drag하면 drawer가 작아진다.
- grid가 유지해야 할 최소 높이는 `144px`다.
- Query Builder 최소 높이는 `220px`다.
- Query Builder 최대 높이는 Model Data content height에서 grid minimum과 summary/footer를 뺀 값이다.
- viewport 변화 시 저장된 높이를 현재 min/max 범위로 clamp한다.

keyboard 동작:

- `ArrowUp`: 16px 증가
- `ArrowDown`: 16px 감소
- `Shift+ArrowUp`: 64px 증가
- `Shift+ArrowDown`: 64px 감소
- `Home`: 최소 높이
- `End`: 최대 허용 높이

기존 `media/modelBrowserLogDrawer.js`의 pointer, keyboard, clamp, persistence pattern을 재사용한다.

저장 key:

- `queryDrawerHeight`

### 6.3 header

header DOM 순서:

1. `<h2>Query Builder</h2>`
2. compact draft status
3. spacer
4. Undo
5. Redo
6. Focus Builder / Show Grid
7. More menu
8. Close

표시 문구:

- title: `Query Builder`
- focus mode 진입: `Focus Builder`
- focus mode 종료: `Show Grid`
- close accessible label: `Close Query Builder`

Undo/Redo:

- Codicon을 사용한다.
- disabled 상태에도 tooltip으로 이유를 제공한다.
- Undo disabled tooltip: `No query edit to undo`
- Redo disabled tooltip: `No query edit to redo`

More menu 항목:

1. `Reset to Applied`
2. `Clear Draft`

menu 설명:

- Reset to Applied: `Replace the draft with the query currently shown in the grid.`
- Clear Draft: `Remove all filters, calculated values, grouping, and custom ordering.`

두 action 모두 즉시 수행한다.

modal confirmation은 사용하지 않는다.

수행 직후:

- Undo history에 checkpoint를 남긴다.
- polite live region에 다음을 알린다.
  - `Draft reset to the applied query. Undo is available.`
  - `Draft cleared. Undo is available.`

header에서 제거할 기존 문장:

`Changes here stay in Draft and do not affect the grid until Apply query succeeds.`

이 의미는 footer에 더 짧게 유지한다.

### 6.4 stage navigation

wide/medium에서는 ARIA tabs pattern을 사용한다.

DOM:

```html
<nav aria-label="Query recipe stages">
  <div role="tablist" aria-label="Query recipe stages">
    <button role="tab" ...>Filter Rows <span>2</span></button>
    ...
  </div>
</nav>
```

keyboard:

- `ArrowRight`: 다음 tab, 마지막에서 첫 tab
- `ArrowLeft`: 이전 tab, 첫 tab에서 마지막 tab
- `Home`: 첫 tab
- `End`: 마지막 tab
- `Enter` 또는 `Space`: browser 기본 button activation
- roving `tabindex`: selected tab만 `0`, 나머지는 `-1`
- focus 이동과 stage activation은 함께 수행한다.

각 tab이 보여 줄 값:

- stage label
- item count
- error count가 있으면 `N errors`
- warning만 있으면 `N warnings`

시각 badge만 읽지 않아도 되도록 accessible name 예시:

- `Calculated Values, 1 item, 2 errors`

count 규칙:

- Filter Rows: root 아래 모든 comparison/group/exists predicate 중 사용자가 추가한 top-level 및 nested predicate leaf 수
- Calculated Values: enabled/disabled 포함 computed item 수
- Filter Results: postFilter predicate leaf 수
- Result: custom groupBy와 orderBy 항목 수; 모두 기본이면 badge 없음

stage issue 매핑은 issue path의 첫 Recipe segment로 계산한다.

매핑:

- `where` → `filterRows`
- `computed` → `calculatedValues`
- `postFilter` → `filterResults`
- `mode`, `groupBy`, `orderBy` → `result`
- path가 없거나 global → Problems에만 표시

### 6.5 workspace

workspace는 header, nav, footer와 분리된 유일한 scrollable 영역이다.

wide:

- editor와 inspector 각각 독립 scroll container
- stage를 바꾸면 해당 stage의 이전 scrollTop 복원
- inspector tab별 scrollTop 복원

medium/narrow:

- editor 또는 inspector 하나만 표시
- 각 pane의 scrollTop을 별도로 보존

CSS:

- `min-height: 0`
- child flex/grid에는 `min-width: 0`
- `overscroll-behavior: contain`
- drawer 전체에 `overflow: hidden`
- sticky header/footer를 workspace scroll 안에 넣지 않는다.

### 6.6 footer

footer 내용:

1. draft safety text
2. validation/apply reason
3. Apply button

기본 safety text:

`Draft changes do not affect the grid until Apply succeeds.`

Apply button label:

- idle: `Apply query`
- applying: `Applying…`
- rows refresh: `Loading results…`

Apply button에 spinner를 넣을 수 있지만 label을 spinner로 대체하지 않는다.

Apply disabled 조건:

- source app/model 없음
- draft가 applied와 같음
- local error 있음
- host validation이 현재 draft revision보다 오래됨
- preview request 진행 중
- Apply request 진행 중
- 현재 revision의 validation error 있음

warning만 있으면 Apply 가능하다.

disabled reason은 footer에 visible text로 표시한다.

정확한 reason 우선순위:

1. source 없음: `Choose a model before building a query.`
2. applying: `The query is being applied.`
3. rows refresh: `The grid is loading the applied query.`
4. clean: `The draft already matches the applied query.`
5. local error: `Fix N local errors before applying.`
6. preview timer 대기: `Draft changed. Validation will start when typing pauses.`
7. checking: `Checking the latest draft…`
8. host error: `Fix N errors before applying.`
9. valid with warning: `Ready to apply with N warnings.`
10. valid: `Ready to apply.`

`Ctrl+Enter` 또는 `Cmd+Enter`:

- Query Builder 안에서 text input, textarea, select, contenteditable이 아닌 곳에 focus가 있을 때 Apply
- disabled 상태이면 Apply하지 않고 현재 reason을 polite announce
- input 안에서는 native editing shortcut을 침범하지 않음

### 6.7 Focus Builder mode

Focus Builder는 user opt-in view mode다.

진입 시:

- Query Builder가 Model Data의 summary 아래, grid footer 위 사용 가능 공간 전체를 차지한다.
- data grid와 grid footer는 `hidden` 및 `inert` 처리한다.
- Query summary band는 유지한다.
- 현재 stage, focus, scroll 위치를 유지한다.
- button label은 `Show Grid`로 바뀐다.
- polite announce: `Query Builder focus mode. The data grid is temporarily hidden.`

종료 시:

- grid와 grid footer를 복원한다.
- 진입 전 grid scrollLeft, scrollTop, selected cell을 복원한다.
- focus는 `Show Grid` button을 누른 동일 위치의 `Focus Builder` button으로 유지한다.
- polite announce: `Data grid shown.`

Focus Builder는 다음 경우 자동 종료하지 않는다.

- stage 변경
- Review 열기
- validation 완료
- Apply 시작
- Apply 성공

다음 경우 종료한다.

- 사용자가 `Show Grid` 선택
- `Escape`를 눌렀고 열려 있는 popup/menu가 없음
- Query Builder를 닫음
- source model 변경

webview recreation 뒤에는 Focus Builder를 복원하지 않는다.

---

## 7. UI 상태 모델

### 7.1 Recipe state와 UI state 분리

Recipe store는 query 의미를 소유한다.

UI state store는 표현과 navigation만 소유한다.

UI state에 Recipe literal, raw user value, ORM text를 저장하지 않는다.

### 7.2 UI state shape

새 `media/gridQueryUiState.js`는 다음 shape를 소유한다.

```js
{
  activeStage: "filterRows",
  drawerHeight: 320,
  drawerOpen: false,
  focusMode: false,
  inspectorScrollTops: {
    meaning: 0,
    orm: 0,
    problems: 0
  },
  inspectorTab: "meaning",
  lastEditorStage: "filterRows",
  lastFocusedControlKey: "",
  mobilePane: "editor",
  openComputedNodeIds: [],
  openGroupNodeIds: [],
  openHelpIds: [],
  pendingComputedKinds: [],
  pendingResultMode: "",
  selectedNodeId: "",
  stageScrollTops: {
    calculatedValues: 0,
    filterResults: 0,
    filterRows: 0,
    result: 0
  }
}
```

배열은 외부 snapshot 형식이다.

open ID collection의 내부 구현은 `Set`을 사용하고, public snapshot과 persistence 경계에서만 정렬된 배열로 변환한다.

`pendingComputedKinds` entry shape:

```js
{
  kind: "formula",
  nodeId: "computed-7"
}
```

한 computed item당 entry는 최대 하나다.

### 7.3 `vscode.setState()` persistence

`media/modelBrowserSource.js`가 보유한 `vscode` 객체를 controller option으로 전달한다.

persist할 key:

- `queryDrawerOpen`
- `queryDrawerHeight`
- `queryActiveStage`
- `queryInspectorTab`

persist하지 않을 key:

- `focusMode`
- `mobilePane`
- open node ID
- selected node ID
- scrollTop
- last focused control
- Recipe
- validation
- ORM preview

이유:

- drawer preference는 session 재생성 뒤에도 유용하다.
- focus mode와 transient node state를 복원하면 stale model이나 hidden grid 상태로 시작할 수 있다.
- `retainContextWhenHidden: true`인 동안 transient state는 live memory에서 유지된다.

복원 규칙:

- 잘못된 enum은 기본값
- 높이는 현재 layout min/max로 clamp
- persisted active stage에 현재 source가 없어도 stage 자체는 유효
- drawerOpen은 model source가 존재할 때만 적용
- Focus Builder는 항상 `false`

### 7.4 UI state action

다음 action type만 허용한다.

- `SET_DRAWER_OPEN`
- `SET_DRAWER_HEIGHT`
- `SET_FOCUS_MODE`
- `SET_ACTIVE_STAGE`
- `SET_MOBILE_PANE`
- `SET_INSPECTOR_TAB`
- `SET_SELECTED_NODE`
- `SET_STAGE_SCROLL`
- `SET_INSPECTOR_SCROLL`
- `SET_COMPUTED_OPEN`
- `SET_GROUP_OPEN`
- `SET_HELP_OPEN`
- `SET_PENDING_COMPUTED_KIND`
- `CLEAR_PENDING_COMPUTED_KIND`
- `SET_PENDING_RESULT_MODE`
- `CLEAR_PENDING_RESULT_MODE`
- `SET_LAST_FOCUSED_CONTROL`
- `RESET_TRANSIENT_FOR_SOURCE`

UI action은 Recipe revision을 올리지 않는다.

host validation을 요청하지 않는다.

### 7.5 source 변경 시 초기화

model source가 바뀌면:

- active stage: `filterRows`
- mobile pane: `editor`
- inspector tab: `meaning`
- open computed/group/help: 비움
- pending computed kind/result mode: 비움
- selected node: 비움
- scroll position: 모두 0
- focus mode: false
- drawer open: persisted preference를 따름
- drawer height: persisted height를 clamp

---

## 8. Recipe history와 Undo/Redo

### 8.1 저장 위치

Undo/Redo history는 `gridQueryRecipeStore.js`가 소유한다.

UI state history와 섞지 않는다.

history stack과 text coalescing은 `gridQueryRecipeStore.js`가 직접 소유한다.

Recipe reducer는 §19.5에 따라 `media/gridQueryRecipeReducer.js`로 분리한다.

### 8.2 history 구조

```js
{
  future: [],
  past: [],
  pendingTextGroup: undefined
}
```

최대 checkpoint:

- `past` 50개
- `future` 50개

초과 시 가장 오래된 checkpoint를 제거한다.

checkpoint에는 JSON-only draft Recipe만 저장한다.

validation과 applied Recipe는 저장하지 않는다.

### 8.3 discrete action

다음은 각각 한 checkpoint다.

- add comparison
- add group
- add Exists predicate
- duplicate node
- remove node
- move node
- toggle negation
- change lookup
- change RHS kind
- choose field
- choose computed reference
- choose relation
- add/remove correlation
- change computed kind 확정
- toggle computed enabled
- add/remove/move/duplicate computed item
- add/remove groupBy
- add/remove/update order
- switch rows/summary
- Reset to Applied
- Clear Draft

### 8.4 text edit coalescing

alias, literal, code body 등 text input은 매 keystroke마다 별도 checkpoint를 만들지 않는다.

action metadata:

```js
{
  history: {
    group: "computed-12:alias",
    mode: "text"
  }
}
```

동일 group은 다음 조건을 모두 만족하면 하나로 합친다.

- 직전 action도 같은 group
- 마지막 입력 이후 600ms 이내
- blur가 발생하지 않음
- 다른 Recipe action이 사이에 없음

coalescing 종료:

- 600ms 초과
- blur
- Enter로 commit되는 control
- 다른 control action
- Undo/Redo
- Apply
- source 변경

history에는 text edit 시작 전 Recipe를 한 번 저장한다.

### 8.5 Undo

Undo 실행:

1. pending text group 종료
2. 현재 draft를 `future` 앞에 추가
3. `past` 마지막 Recipe를 draft로 복원
4. draftRevision 증가
5. validationRevision을 stale로 설정
6. validation preview 예약
7. applied Recipe는 유지
8. focus intent를 가장 최근 control key로 설정

Undo 후 새 edit:

- `future` 전부 제거

### 8.6 Redo

Redo 실행:

1. 현재 draft를 `past`에 추가
2. `future` 첫 Recipe를 draft로 복원
3. draftRevision 증가
4. validation stale
5. preview 예약
6. focus intent 복원

### 8.7 Apply와 history

Apply 성공은 history를 지우지 않는다.

이유:

- 사용자가 Apply 직후 이전 draft로 돌아가 새 변형을 만들 수 있다.

Apply 후 Undo:

- applied Recipe는 방금 성공한 Recipe를 유지
- draft만 이전 Recipe가 됨
- 상태는 dirty
- grid는 applied 결과를 계속 표시

source 변경:

- history를 전부 비운다.

hydrate가 같은 source의 초기 applied 상태를 가져오는 경우:

- 사용자 edit 전이면 history를 비움
- 사용자 edit가 이미 있으면 기존 stale response guard를 유지하고 임의로 history를 바꾸지 않음

### 8.8 keyboard shortcut

Query Builder 범위에서:

- `Ctrl/Cmd+Z`: Undo
- `Ctrl/Cmd+Shift+Z`: Redo
- Windows/Linux 대체 `Ctrl+Y`: Redo

단, target이 다음이면 browser/native text undo를 그대로 둔다.

- `<input>` 중 text-like type
- `<textarea>`
- contenteditable

select, button, tab, disclosure에 focus가 있으면 Recipe Undo/Redo를 사용한다.

---

## 9. 렌더링 안정화 아키텍처

### 9.1 절대 규칙

Recipe mutation handler는 `render()`를 직접 호출하지 않는다.

metadata callback, store subscriber, host message handler도 full render를 직접 호출하지 않는다.

모든 render는 하나의 coordinator를 통과한다.

### 9.2 새 render coordinator

새 파일:

- `media/gridQueryRenderCoordinator.js`

public contract:

```js
createQueryRenderCoordinator({
  captureFocus,
  getModel,
  regions,
  restoreFocus,
  schedule
})
```

반환:

```js
{
  destroy(),
  flush(),
  request(reason)
}
```

동작:

1. `request(reason)`은 reason을 `Set`에 추가한다.
2. 같은 task 안의 요청은 microtask 하나로 합친다.
3. flush 시작 때 `getModel()`을 한 번 호출한다.
4. 이 최신 model만 모든 region에 전달한다.
5. focus/caret/scroll을 capture한다.
6. region signature가 바뀐 영역만 update한다.
7. focus intent 또는 capture 결과를 restore한다.
8. pending reason을 비운다.

`render(snapshot)`처럼 외부 snapshot parameter를 받지 않는다.

### 9.3 render model

controller가 coordinator에 제공할 model:

```js
{
  lifecycle,
  metadataGeneration,
  metadataState,
  scope,
  snapshot,
  ui,
  validation
}
```

`snapshot`은 flush 시작 시 store의 최신 값이다.

`ui`도 flush 시작 시 UI store의 최신 값이다.

### 9.4 region

region ID:

- `summary`
- `shell`
- `stageNav`
- `filterRows`
- `calculatedValues`
- `filterResults`
- `result`
- `meaning`
- `problems`
- `orm`
- `footer`

각 region contract:

```js
{
  destroy(),
  signature(model),
  update(model)
}
```

signature는 bounded JSON projection 문자열이다.

DOM 전체나 function reference를 stringify하지 않는다.

### 9.5 signature projection

#### summary

- applied Recipe의 count/mode projection
- dirty
- lifecycle
- validation issue count
- drawer open

#### shell

- drawer open
- drawer height
- focus mode
- available width category
- mobile pane

#### stageNav

- active stage
- stage counts
- stage issue counts
- width category
- mobile pane

#### filterRows

- `draft.where`
- 해당 issue projection
- field metadata generation
- `openGroupNodeIds`
- selected node

#### calculatedValues

- `draft.computed`
- 해당 issue projection
- metadata generation
- `openComputedNodeIds`
- selected node

#### filterResults

- `draft.postFilter`
- enabled computed reference projection
- 해당 issue projection
- metadata generation
- open group
- selected node

#### result

- mode
- groupBy
- orderBy
- enabled computed reference projection
- 해당 issue projection
- metadata generation

#### meaning

- 전체 draft meaning projection
- selected node
- actual transport/link label

#### problems

- sorted issue projection
- lifecycle rejection marker

#### orm

- ORM preview text
- preview revision
- lifecycle

#### footer

- dirty
- lifecycle
- validation freshness
- issue counts
- source availability

### 9.6 builder instance lifetime

stage builder는 Query Builder controller lifetime 동안 유지한다.

stage Recipe가 변경되어도 builder root instance를 매번 새로 만들지 않는다.

builder contract:

```js
{
  destroy(),
  node,
  update(model)
}
```

update는 필요한 list/item subtree만 keyed update한다.

key:

- Recipe `nodeId`
- groupBy는 stable UI key가 스키마에 없으므로 UI adapter가 current entry identity에 stable key를 부여
- orderBy는 Recipe `nodeId`

### 9.7 keyed DOM 규칙

- 동일 `nodeId`의 root DOM element는 Recipe field 변경 때문에 교체하지 않는다.
- input element는 type 자체가 바뀌지 않는 한 재사용한다.
- value를 쓸 때 DOM value가 model value와 다를 때만 대입한다.
- focus된 text input의 value를 render 중 강제로 대입하지 않는다. 해당 edit는 이미 store와 동기화되어 있어야 한다.
- option list 변경으로 current value가 사라지면 validation 표시만 하고 임의로 첫 option을 선택하지 않는다.

### 9.8 focus manager

새 파일:

- `media/gridQueryFocus.js`

모든 interactive query control은 stable key를 가진다.

attribute:

```html
data-query-control-key="<node-or-stage-id>:<role>"
```

예:

- `comparison-12:field`
- `comparison-12:lookup`
- `comparison-12:rhs-kind`
- `comparison-12:value`
- `computed-7:alias`
- `computed-7:kind`
- `order-3:reference`
- `stage:filterRows`
- `inspector:problems`

capture:

- activeElement가 Query Builder 안에 있을 때만
- control key
- input selectionStart
- selectionEnd
- selectionDirection
- active stage scrollTop
- active inspector scrollTop
- element가 details summary이면 open state

restore 우선순위:

1. explicit focus intent
2. capture된 control key
3. 현재 stage의 첫 invalid control
4. 현재 stage heading

일반 render restore:

- `focus({ preventScroll: true })`
- text selection 복원
- stage/inspector scrollTop 복원

explicit navigation restore:

- target stage 활성화
- ancestor disclosure 열기
- `scrollIntoView({ block: "nearest" })`
- focus
- error면 associated message를 `aria-describedby`로 연결

### 9.9 focus intent

shape:

```js
{
  controlKey,
  mode: "preserve" | "reveal",
  reason,
  stage
}
```

Recipe dispatch wrapper는 action 전에 intent를 설정한다.

intent는 한 render flush 뒤 제거한다.

intent target이 없으면 fallback target을 계산하고 error를 throw하지 않는다.

### 9.10 구조 action focus 표

| action | focus target |
|---|---|
| Add condition | 새 comparison의 `field` |
| Add group | 새 group의 `add-condition` |
| Add Exists | 새 Exists의 `relation` |
| Duplicate predicate | 복제 node의 첫 editable control |
| Remove predicate | 다음 sibling 첫 control, 없으면 이전 sibling, 없으면 parent의 Add condition |
| Move predicate | 같은 node의 첫 control |
| Select field | 같은 node의 `lookup` |
| Change RHS kind | 새 RHS의 첫 control |
| Add computed | 새 item의 `alias` |
| Duplicate computed | 복제 item의 `alias` |
| Remove computed | 다음 item header, 이전 item header, 없으면 Add calculated value |
| Move computed | 같은 item header |
| Change computed type 확정 | 같은 item의 kind-specific 첫 control |
| Add group field | 새 group field picker |
| Add order | 새 order reference picker |
| Remove result item | 다음 item, 이전 item, Add action |
| Problems issue 선택 | issue가 가리키는 정확한 control |

### 9.11 live region deduplication

inline issue element마다 `role="alert"`를 사용하지 않는다.

중앙 announcer가 다음 signature를 기억한다.

```text
<validationPhase>:<applyPhase>:<draftRevision>:<errorCount>:<warningCount>:<primaryCode>
```

동일 signature는 다시 announce하지 않는다.

announce 시점:

- host validation response가 현재 revision에 도착
- Apply rejection
- Apply success
- copy success/failure
- Reset/Clear
- Focus mode 진입/종료

announce하지 않는 시점:

- 매 keystroke
- DOM region rerender
- background stale preview 표시
- tab 이동 자체

---

## 10. validation 및 Apply lifecycle

### 10.1 lifecycle state

validation과 Apply는 동시에 진행될 수 있으므로 하나의 enum으로 합치지 않는다.

controller는 다음 두 개의 독립 state machine을 가진다.

```js
{
  apply: {
    phase: "idle" | "applying" | "loadingResults" | "failed",
    requestId,
    revision
  },
  validation: {
    phase: "clean" | "pending" | "checking" | "valid" | "invalid",
    requestId,
    revision
  }
}
```

예:

- revision 4를 Apply하는 동안 사용자가 revision 5를 편집하면 `apply.phase = "applying"`과 `validation.phase = "pending"`이 동시에 참이다.
- summary/footer의 visible status는 Apply state를 우선 표시하고, 보조 text로 newer draft validation state를 함께 표시한다.
- Apply/validation response는 각각 자기 requestId와 revision guard만 사용한다.

### 10.2 local validation

local validation은 순수 함수로 즉시 수행한다.

범위:

- required alias
- empty field path
- missing literal/reference
- invalid local ordering cardinality
- duplicate alias
- unsupported control combination을 UI가 이미 알고 있는 경우
- Recipe limit을 현재 client가 알고 있는 경우

local validation은 host validation을 대체하지 않는다.

local error가 있으면 preview request를 보낼 수 있지만 Apply는 막는다.

정책:

- metadata가 없어 local check가 확정 불가하면 error를 만들지 않고 host/metadata pending 상태를 표시
- UI가 명확히 아는 invalid shape는 즉시 error

### 10.3 preview debounce

text-like edit:

- 마지막 input 후 `400ms`

structural action:

- microtask render 후 즉시 preview

select/change:

- 즉시 preview

text input blur:

- 남은 timer를 즉시 flush

timer 대기 중:

- `validation.phase = "pending"`
- status `Draft changed`
- 아직 `Checking…`으로 표시하지 않음

request 전송 순간:

- `validation.phase = "checking"`
- status `Checking draft…`

새 draft가 생기면:

- 이전 timer cancel
- in-flight response는 revision guard로 무시
- 새 revision에 맞는 timer 생성

### 10.4 preview response

현재 draft revision과 일치:

- validation 저장
- ORM preview와 preview revision 저장
- error가 없으면 `ready`
- error가 있으면 `invalid`

일치하지 않음:

- state, ORM, issue를 변경하지 않고 무시

### 10.5 stale ORM 표시

draft가 ORM preview revision보다 새로우면 이전 preview를 지우지 않는다.

대신 ORM tab 상단에 표시:

`Previous validated preview — checking the latest draft.`

이 상태:

- code는 selectable
- Copy button disabled
- accessible description으로 stale 이유 연결

최신 preview가 없으면:

`Django ORM will appear after the current draft passes validation.`

### 10.6 Apply

Apply 시작:

1. 최신 local/host validity 및 revision 재확인
2. 동일 draft snapshot으로 `beginApply`
3. `apply.phase = "applying"`
4. Apply button disabled, label `Applying…`
5. editor는 계속 보이지만 Recipe mutation control을 disabled 처리하지 않는다.

사용자는 Apply 중에도 새 draft를 편집할 수 있다.

이 경우:

- applying snapshot은 변하지 않음
- 새 draft는 dirty로 남음
- 새 draft preview debounce와 host validation은 Apply request와 독립적으로 계속 진행
- 성공 결과는 matching applying Recipe에 적용
- newer draft를 덮지 않음

Apply 성공 message:

1. applied Recipe 갱신
2. matching draft이면 normalized Recipe로 동기화
3. `apply.phase = "loadingResults"`
4. 이전 grid는 그대로 유지
5. status `Query applied. Loading results…`

matching rows/summary 성공:

- 새 grid data 교체
- `apply.phase = "idle"`
- validation state는 현재 draft에 대해 진행 중이던 `pending`, `checking`, `valid`, `invalid`를 유지
- matching draft가 clean이면 `validation.phase = "clean"`
- announce `Query applied. Results loaded.`

rows/summary 실패:

- 기존 grid 유지
- host error surface 사용
- `apply.phase = "failed"`
- footer에 `The query was applied, but the grid could not load its results. Retry from the grid error.`

Apply rejection:

- `apply.phase = "failed"`
- editor mutation은 유지
- Review Problems를 연다.
- medium/narrow에서는 mobile pane을 Review로 전환한다.
- inspector tab `problems`
- 첫 error item에 focus
- announce `Query was not applied. N errors need attention.`

### 10.7 Problems 자동 열기 정책

자동으로 Problems를 여는 경우:

- 사용자가 Apply를 눌렀고 host가 reject
- 사용자가 disabled Apply reason의 `Review problems` action 선택

자동으로 열지 않는 경우:

- background preview에서 처음 error가 발견됨
- typing 중 local error
- warning 도착
- metadata pending/error

이 정책은 layout/focus theft를 막는다.

---

## 11. Review inspector 상세 명세

### 11.1 Meaning tab

상단 전체 pipeline summary:

```text
1. Filter Rows
2 conditions keep matching Company rows.

2. Calculated Values
Adds `latest_valuation` with a scalar subquery.

3. Filter Results
No result filters.

4. Result
Returns rows ordered by `id` ascending.
```

규칙:

- alias, field path, lookup은 실제 `<code translate="no">`
- backtick 문자를 그대로 text로 출력하지 않음
- 각 stage summary button을 누르면 해당 stage로 이동
- 빈 stage도 명시
- implicit compiler behavior는 `The builder also does` disclosure 아래
- 실제 active Link label을 사용
- `"the active link"` 고정 문자열 제거

선택 node가 있으면 divider 아래에 node detail:

- node type
- plain-language meaning
- input source
- output
- incomplete reason
- affected later stage

선택 node가 없으면:

`Select a condition or calculated value to inspect its meaning.`

### 11.2 Problems tab

issue sort:

1. severity error
2. severity warning
3. stage order
4. Recipe path lexical order
5. original stable order

각 issue DOM:

```text
[Error] Calculated Values
Choose the field returned by this subquery.
The subquery knows which related rows to inspect, but not which value each row returns.
Fix: Choose one target field in Returned Value.
[Go to field]
Technical details ▸
```

필수 visible 정보:

- severity
- stage
- issue title/message
- explanation
- exact fix
- target action

`title` attribute만으로 explanation을 제공하지 않는다.

Technical details disclosure:

- issue code
- Recipe path
- nodeId
- source: local 또는 host

값은 textContent로 안전하게 렌더한다.

empty:

- latest validation current: `No problems in the latest validated draft.`
- preview pending: `Validation will run when typing pauses.`
- previewing: `Checking the latest draft…`

### 11.3 issue focus mapping

새 helper:

- `media/gridQueryIssueTarget.js`

반환 shape:

```js
{
  ancestorNodeIds,
  controlKey,
  stage
}
```

매핑 원칙:

- 가장 구체적인 Recipe path segment를 control role로 변환
- nodeId가 제공되면 stable key 우선
- global issue면 stage tab 또는 footer reason으로 fallback

issue action 순서:

1. active stage 변경
2. medium/narrow이면 editor pane으로 전환
3. ancestor group/computed details 열기
4. render flush
5. target `scrollIntoView`
6. target focus
7. associated error text가 screen reader description에 포함

### 11.4 Django ORM tab

구성:

1. status row
2. Copy button
3. `<pre><code translate="no">`
4. optional implicit behavior

status:

- `Latest validated draft`
- `Previous validated preview`
- `Checking the latest draft…`
- `ORM preview unavailable`

Copy:

- 최신 preview일 때만 enabled
- success: `Django ORM copied.`
- failure: `Could not copy automatically. Select the ORM preview and copy it manually.`
- status를 polite live region에도 전달
- clipboard error를 조용히 삼키지 않음

---

## 12. 공통 field/reference picker

### 12.1 목표

사용자가 raw Django path를 기억하지 않고 allowlisted metadata에서 선택한다.

적용 대상:

- predicate LHS field
- field-to-field RHS
- Exists relation
- correlation outer field
- correlation inner field
- scalar subquery source relation/model
- scalar subquery selected field
- scalar subquery order field
- aggregate relation path
- aggregate source field
- groupBy field
- orderBy direct/computed reference
- window partition/order reference

### 12.2 유지할 현재 방식

`gridQueryFieldPicker.js`의 cascading relation traversal concept은 유지한다.

각 segment에서:

- 현재 model의 field/relation 후보 검색
- relation 선택 시 다음 target model segment 추가
- direct field 선택 시 path 확정

### 12.3 visible 구조

```text
Field
[ Company ▸ ] [ Search field or relation…             ]
Path: `portfolio__company__name`
CharField · Company name
```

필수 요소:

- visible `<label>`
- current relation breadcrumb
- search combobox
- selected full path `<code translate="no">`
- type
- label/help
- validation message

relation segment 선택:

- 새 segment combobox를 만들고 즉시 focus
- previous segment는 breadcrumb button
- breadcrumb 선택 시 그 segment 이후 path를 제거하되 Undo 가능

### 12.4 popup portal

새 파일:

- `media/gridQueryPopover.js`

`src/modelBrowserHtml.ts`의 Model Data root 마지막에 추가:

```html
<div id="queryPopoverLayer" class="query-popover-layer"></div>
```

popup은 field picker container 안이 아니라 이 layer에 mount한다.

position:

- `position: fixed`
- anchor `getBoundingClientRect()`
- viewport 아래 공간이 `min(280px, desiredHeight)` 이상이면 아래
- 아니면 위
- 좌우 viewport padding 8px
- popup width는 `clamp(anchor width, 280px, available viewport width)`
- max-height는 위/아래 available 공간에서 8px margin을 뺀 값

position update:

- open 직후
- workspace scroll
- window resize
- drawer resize
- stage 전환
- `requestAnimationFrame`으로 한 frame에 한 번

close:

- option 선택
- Escape
- anchor와 popup 외부 pointerdown
- Query Builder close
- stage 비활성
- source 변경

close 후:

- Escape이면 anchor focus 복원
- option 선택이면 다음 지정 control로 focus

### 12.5 bounded option rendering

최대 visible option:

- 60개

후보가 60개를 넘으면:

- search 결과 상위 60개만 렌더
- selected option이 결과 밖이면 맨 위에 pinned
- list 아래 status:
  - `60 of N matches shown. Type to narrow the list.`

정렬:

1. exact name match
2. name prefix
3. label prefix
4. name substring
5. label substring
6. relation before field가 아니라 원 metadata order 유지

search 대상:

- field/relation name
- label
- type
- help text

검색은 locale-insensitive lower-case 비교를 사용하고 fuzzy library는 도입하지 않는다.

### 12.6 combobox ARIA

input:

- `role="combobox"`
- `aria-autocomplete="list"`
- `aria-expanded`
- `aria-controls`
- `aria-activedescendant`
- `autocomplete="off"`
- `spellcheck="false"`
- stable `name`

popup:

- `role="listbox"`
- option `role="option"`
- selected `aria-selected`

keyboard:

- ArrowDown: 다음 option, 닫혔으면 열기
- ArrowUp: 이전 option, 닫혔으면 열기
- Home: 첫 option
- End: 마지막 option
- PageDown/PageUp: 8개 이동
- Enter: active option 선택
- Escape: popup 닫고 typed query를 selected label로 복원
- Tab: popup 닫고 browser tab 순서 유지

검색 결과 없음:

- `No fields or relations match “…”`
- `role="status"`로 한 번 announce

metadata loading:

- input disabled
- `Loading fields…`

metadata error:

- input disabled
- visible `Fields could not be loaded.`
- `Retry` secondary button
- host error detail은 expandable technical details

### 12.7 disposal

`gridCombobox.js` public API에 `dispose()`를 추가한다.

dispose가 제거할 것:

- document pointer listener
- window resize listener
- scroll listener
- pending animation frame
- popup DOM
- async request generation

field picker의 `destroy()`는 combobox `dispose()`를 반드시 호출한다.

async metadata response는 generation token이 현재 instance 및 segment와 일치할 때만 적용한다.

### 12.8 공통 scalar editor

새 파일:

- `media/gridQueryScalarEditor.js`

public contract:

```js
createQueryScalarEditor({
  allowNull,
  expectedField,
  label,
  onChange,
  value
})
```

expected field가 있을 때:

- BooleanField → `True`, `False`, allowNull이면 `Null`
- numeric → text input + `inputmode="decimal"`; finite number로 parse, invalid raw string은 보존하고 local error
- DateField → native date input
- DateTimeField → native datetime-local input
- TimeField → native time input
- choices → allowlisted select/combobox
- 나머지 → text input

expected field가 없을 때:

- visible `Value type` select
- Text, Number, Boolean, Null
- type에 대응하는 control

모든 결과는 기존 `QueryScalar`만 반환한다.

적용:

- predicate literal
- predicate list item
- predicate range bound
- Formula literal
- scalar subquery `onEmpty.value`

`relativeTime`은 별도 structured editor를 유지한다.

module은 value parsing만 소유하고 Recipe action을 직접 dispatch하지 않는다.

test:

- text
- finite number
- invalid number 보존/error
- true/false
- null
- date/datetime/time
- choices
- untyped kind change
- focus/caret update

---

## 13. Filter Rows 및 Filter Results predicate UX

### 13.1 stage introduction

Filter Rows:

- heading: `Filter Rows`
- intro: `Keep only source rows that match these conditions before calculated values are created.`

Filter Results:

- heading: `Filter Results`
- intro: `Filter the final values after calculated values are available.`

긴 guidance는 기본적으로 반복하지 않는다.

처음 비어 있을 때 empty state에만 핵심 설명을 보인다.

### 13.2 empty state

Filter Rows:

```text
All source rows are included.
Add a condition to keep only matching rows.
[Add condition] [Add group] [Add related-row check]
```

Filter Results:

```text
No final-value filter is applied.
Use this stage when a condition depends on a calculated value.
[Add condition] [Add group] [Add related-row check]
```

첫 action만 primary-like emphasis를 쓸 수 있으나 실제 product primary button color는 Apply에 예약한다.

모든 add action은 secondary button이다.

### 13.3 group

group visual:

- flat bordered region
- border는 `var(--vscode-panel-border)`
- nested depth는 left border와 8px step indentation으로 표현
- card shadow 없음
- depth 3 이상에서도 indentation이 content를 지나치게 압축하지 않도록 maximum visual indent 24px

group header:

1. disclosure
2. summary
3. join control — child가 2개 이상일 때만
4. negation
5. actions

summary:

- empty: `Empty group`
- one child: child meaning 요약
- multiple: `All N conditions must match` 또는 `Any of N conditions may match`
- negated: `Not (…)`
- error count 표시

join:

- child 0/1이면 control을 렌더하지 않음
- helper: `Add another condition to choose whether all or any conditions must match.`
- child 2개 이상이면 segmented:
  - `All`
  - `Any`
- visible group label과 설명:
  - All: `Every condition in this group must match.`
  - Any: `At least one condition in this group must match.`

actions:

- Add condition
- Add group
- Add related-row check
- Duplicate
- Move up
- Move down
- Delete

root group:

- duplicate/move/delete 없음

nested group:

- icon actions은 secondary/quiet
- destructive Delete는 hover/focus에서만 danger semantic token을 사용

### 13.4 group disclosure

기본 open:

- root group
- 새 group
- error가 있는 group과 ancestor
- 현재 selected node ancestor

기본 closed:

- 완성된 nested group을 사용자가 닫은 상태

open state는 UI state store의 `openGroupNodeIds`.

Recipe change나 validation render가 사용자 선택을 덮지 않는다.

error가 새로 생겼다고 사용자가 명시적으로 닫은 group을 자동으로 열지 않는다.

단, Apply rejection 후 첫 issue로 이동할 때는 해당 ancestor를 연다.

### 13.5 comparison block

각 comparison은 flat bordered block이다.

header:

- concise meaning
- incomplete/error status
- select node button semantics
- move/duplicate/delete actions

body control 순서:

1. Field
2. Comparison
3. Compare With
4. Value 또는 Reference
5. Negate this condition

wide stage editor:

```text
Field                 Comparison
[picker............]  [lookup........]
Compare With          Value
[Value ▾]             [input.........]
```

medium:

- 두 column

narrow 또는 editor width 520px 미만:

- 한 column

모든 control:

- visible label
- stable control key
- associated help/error
- `min-width: 0`

### 13.6 lookup control

label:

- `Comparison`

option label은 Django lookup token만 보여 주지 않는다.

예:

- `Equals (exact)`
- `Does not equal`
- `Contains (case-sensitive)`
- `Contains (case-insensitive)`
- `Is greater than`
- `Is empty / null`

lookup 설명은 선택 아래 한 줄:

- `Matches the complete value.`
- `Matches text that contains this value, ignoring letter case.`

field type에 허용되지 않는 lookup은 option에서 제거한다.

현재 Recipe에 metadata상 허용되지 않는 legacy lookup이 있으면:

- 값은 보존
- `Unsupported for this field` option을 selected 상태로 표시
- local error와 fix 제공
- 임의로 `exact`로 바꾸지 않음

### 13.7 Compare With

visible label:

- `Compare With`

종류:

- `A value`
- `Another field`
- `A calculated value`
- Recipe가 허용하는 기타 기존 kind

field type 또는 context에서 불가능한 kind는 숨긴다.

kind 변경:

- 새 kind의 기본 shape로 Recipe update
- Undo 가능
- 다음 focus는 새 RHS control

### 13.8 literal input

field type에 맞는 input을 사용한다.

| field family | input |
|---|---|
| text | text |
| integer/decimal | text + inputmode decimal |
| boolean | select `True`, `False` |
| date | existing safe date control 또는 text contract 유지 |
| datetime | existing safe datetime control 또는 text contract 유지 |
| null lookup | value control 없음 |
| choice | metadata choice select/combobox |

backend parser contract를 바꾸지 않는다.

UI format conversion이 이미 없는 type에 새 parsing semantics를 만들지 않는다.

placeholder는 label을 대신하지 않는다.

### 13.9 inline validation

control error:

- control border/focus semantic error token
- 아래 `<p id=... class="query-control-error">`
- `aria-invalid="true"`
- `aria-describedby`에 help와 error 모두 연결

문구 형식:

`문제. 해결 방법.`

예:

`Choose a field. Search the model fields and select one result.`

warning:

- error와 다른 icon/text
- Apply를 막지 않음

### 13.10 related-row check

UI label:

- `Related rows`

Recipe kind:

- 기존 `existsPredicate`

필드 그룹:

1. `Relation`
2. `Match related rows where`
3. inner predicate builder
4. `Require`:
   - `At least one related row`
   - `No related rows`

사용자에게 `ExistsPredicate` 용어를 primary label로 노출하지 않는다.

technical details에서 Recipe kind를 볼 수 있다.

---

## 14. Calculated Values stage

### 14.1 stage introduction

heading:

- `Calculated Values`

intro:

`Create values that can be displayed, ordered, grouped, or filtered in later stages.`

### 14.2 toolbar

구성:

1. kind select
2. 현재 kind의 짧은 설명
3. `Add calculated value`

kind visible label:

- `Type`

kind option label은 기존 Recipe kind와 다음 mapping을 사용한다.

| Recipe kind | UI label |
|---|---|
| `formula` | `Formula` |
| `aggregate` | `Aggregate` |
| `scalarSubquery` | `Scalar subquery` |
| `exists` | `Related-row check` |
| `window` | `Window value` |
| `codeExpression` | `Code expression` |

새 Recipe kind를 만들지 않는다.

### 14.3 empty state

```text
No calculated values yet.
Add a value when you need an annotation, aggregate, subquery, or reusable expression.
[Type ...] [Add calculated value]
```

### 14.4 computed item

각 item은 flat bordered `<section>`과 독립 disclosure `<button>`을 사용한다.

interactive checkbox와 action button을 `<summary>` 안에 중첩하지 않는다.

disclosure button:

- item title과 type summary를 포함
- `aria-expanded`
- `aria-controls`
- item body ID를 가리킴
- Codicon chevron은 `aria-hidden=true`

header 순서:

1. disclosure button
2. enabled checkbox
3. incomplete/error badge
4. move up
5. move down
6. duplicate
7. delete

alias가 비면:

- `Untitled calculated value`

status accessible name 예:

- `latest_valuation, Scalar subquery, 2 errors, expanded`

header 클릭:

- interactive child가 아닌 영역은 disclosure toggle
- item 선택 및 Meaning detail 대상 설정

open state:

- `openComputedNodeIds`
- 새 item은 open
- error item은 Apply rejection navigation 때 open
- input render 때문에 닫히지 않음

### 14.5 common fields

item body 첫 field:

- label `Name`
- help `Use this name in Result and Filter Results.`
- alias input

두 번째:

- label `Type`
- kind select

enabled:

- label `Include this calculated value`
- disabled item의 세부 설정은 보이지만 muted
- disabled item은 Result 및 Filter Results reference 후보에서 제외
- 기존 Recipe 값은 보존

### 14.6 kind 변경 확인

computed item이 새 기본 상태가 아닌데 kind를 바꾸면 즉시 Recipe를 변경하지 않는다.

item 안에 inline confirmation bar:

```text
Change Scalar subquery to Formula?
The current subquery settings will be replaced.
[Change Type] [Cancel]
```

동작:

- select는 pending kind를 표시
- `Change Type`에서 한 Recipe action으로 확정
- Undo 한 번으로 이전 item 전체 복원
- `Cancel`은 기존 kind로 select 복원
- confirmation 중 다른 kind를 고르면 pending kind만 갱신
- item 밖 focus 이동만으로 자동 확정하지 않음
- Escape는 Cancel

item이 fresh default이고 user data가 없으면 confirmation 없이 변경한다.

fresh default 판정은 kind별 canonical starter와 alias/enabled를 제외한 deep equality로 정의한다.

### 14.7 Formula

Formula body는 다음 순서다.

1. root `Expression`
2. formula node count/depth status
3. `Output type`

각 expression node는 `Value type` control을 먼저 표시한다.

허용 type과 UI:

| Recipe node kind | UI label | 이어지는 control |
|---|---|---|
| `field` | `Field` | 공통 field picker |
| `computed` | `Earlier calculated value` | 현재 item보다 위에 있는 enabled alias picker |
| `literal` | `Value` | type-aware literal input |
| `binary` | `Calculation` | left expression, operator, right expression |
| `function` | `Function` | function, 고정 arity argument expression |
| `case` | `Case` | 0~8 When predicate/Then expression, Else expression |
| `cast` | `Convert type` | expression, non-auto output type |

binary operator:

- `+`
- `-`
- `×` UI label, Recipe value `*`
- `÷` UI label, Recipe value `/`
- `Remainder` UI label, Recipe value `%`

function:

- `Coalesce`
- `Concat`
- `Greatest`
- `Least`
- `Lower`
- `Upper`
- `Trim`
- `Length`

function arity는 현재 Recipe contract대로 고정한다.

Case:

- branch label `When 1`, `When 2`, …
- 각 branch에 predicate builder와 `Then`
- `Add case branch`
- 최대 8
- 마지막 `Else`
- branch delete action 제공

formula node의 kind 변경은 해당 node subtree만 canonical starter로 바꾸고 Undo 한 번으로 복구한다.

모든 field/reference는 공통 picker를 사용한다.

literal argument는 공통 scalar editor를 사용한다.

Formula처럼 expected Django field type이 없는 곳에서는 `Value type`을 표시한다.

- `Text`
- `Number`
- `Boolean`
- `Null`

type 변경 starter:

- Text → `""`
- Number → `0`
- Boolean → `false`
- Null → `null`

변경은 Recipe action 하나이며 Undo 가능하다.

node/depth limit은 현재 `MODEL_QUERY_RECIPE_LIMITS` 값을 표시하고 Apply를 막는 local error로 연결한다.

Formula meaning은 item header에 한 줄, Meaning inspector에 완전한 문장으로 표시한다.

### 14.8 Aggregate

필드 그룹:

1. `Function`
2. `Value`
3. `Only include rows where`
4. `Distinct values`

`Function`:

- `Count`
- `Sum`
- `Average`
- `Minimum`
- `Maximum`

`Value`:

- relation traversal을 포함하는 공통 field picker
- picker breadcrumb가 related path와 target model을 보여 줌
- `Count`에서는 첫 option `All rows`
- `All rows`는 Recipe `{ kind: "all" }`
- field 선택은 Recipe `{ kind: "field", path }`
- `Sum`, `Average`, `Minimum`, `Maximum`은 field 필수
- Count `All rows` 상태에서 다른 function으로 바꾸면 field를 빈 field ref로 바꾸고 즉시 inline error를 표시

별도의 relation property를 Recipe에 추가하지 않는다.

picker가 선택한 relation breadcrumb와 terminal field를 `__`로 합친 기존 `field.path` 하나만 저장한다.

`Distinct values`:

- Function이 `Count`일 때만 표시
- option `Automatic`, `Always distinct`
- 다른 function에서는 control을 숨기고 Recipe `distinct`를 `auto`로 설정
- 기존 non-count Recipe에 `always`가 있으면 값을 자동 수정하지 않고 control과 error를 표시해 사용자가 `Automatic`으로 바꾸도록 함

aggregate filter:

- compact nested predicate builder
- heading `Only include rows where`
- aggregate `field.path`가 도달하는 target이 아니라 현재 aggregate compiler가 사용하는 source model scope를 그대로 사용
- empty state `All rows are included in this aggregate.`

raw native flat field select를 제거한다.

### 14.9 Scalar subquery

Scalar subquery는 정확히 여섯 개의 numbered fieldset으로 표시한다.

#### 1. Source

legend:

`1. Source`

help:

`Choose the rows this subquery reads.`

source kind segmented control:

- `Related model`, Recipe `source.kind = "relation"`
- `Installed model`, Recipe `source.kind = "model"`

`Related model`:

- relation-only picker

`Installed model`:

- searchable app-qualified model picker
- label format `app_label.ModelName`

relation source:

- source model에서 relation 선택
- target model을 read-only summary로 표시
- 자동으로 알 수 있는 correlation은 read-only:
  - `Connected automatically through Company.venture_set`

#### 2. Connect Rows

legend:

`2. Connect Rows`

help:

`Match each outer row to the target rows that belong to it.`

relation source가 correlation을 완전히 결정:

- manual control 대신 read-only connection summary
- Recipe `correlations`는 빈 배열
- backend가 relation metadata의 `outerField`, `filterField`, through fields를 사용해 exact correlation을 생성하는 기존 계약을 유지
- client가 manual correlation을 relation source에 넣지 않음

installed-model source:

각 row:

- `Outer field`
- connector text `matches`
- `Target field`
- remove

두 picker의 model scope를 visible text로 표시:

- `Company field`
- `ValuationHistory field`

add:

- `Add connection`

empty warning:

`This subquery is not connected to the outer row. It may return the same value for every result.`

host가 이를 error로 규정하면 severity를 그대로 따른다.

#### 3. Filter Target Rows

legend:

`3. Filter Target Rows`

help:

`Optionally narrow the connected target rows.`

target model scope의 nested predicate builder를 사용한다.

empty:

`All connected target rows are considered.`

#### 4. Returned Value

legend:

`4. Returned Value`

help:

`Choose a field from one target row or aggregate all matching target rows.`

`Return` segmented control:

- `One field`, Recipe `select.kind = "field"`
- `Aggregate rows`, Recipe `select.kind = "aggregate"`

`One field`:

- target model field picker
- raw text input 제거
- selected field type과 full path 표시

`Aggregate rows`:

1. Function `Count`, `Sum`, `Average`, `Minimum`, `Maximum`
2. Value picker
3. Count에서만 `All rows`
4. Distinct `Automatic`, `Always distinct`

kind 변경은 canonical select starter로 바꾸며 Undo 가능하다.

#### 5. Row Choice

legend:

`5. Row Choice`

help:

`Choose which target row wins when more than one row matches.`

order term:

- target field picker
- direction segmented `Ascending` / `Descending`
- add/remove/reorder

빈 ordering:

- field select일 때 warning:
  - `No row choice is set. The target primary key ascending will be used.`
- aggregate select일 때:
  - `The aggregate already returns one value, so row ordering is not used.`
- aggregate select에서는 order controls를 숨기고 기존 non-empty order가 있으면 visible stale-state error와 `Remove row ordering` action 제공

limit:

- field select에서는 read-only:
  - `Returns the first row after ordering.`
- aggregate select에서는 read-only:
  - `Returns one aggregate value for the connected target rows.`
- 새로운 arbitrary limit control을 만들지 않음

#### 6. Output

legend:

`6. Output`

표시:

- `Output type`: `Automatic`, `Boolean`, `Integer`, `Float`, `Decimal`, `Text`, `Date`, `Date and time`, `Time`, `Duration`, `UUID`
- `When no row matches`: current `onEmpty.value` scalar input
- alias preview
- final meaning

`Automatic`이고 selected field type을 metadata에서 알면:

- `Inferred from DateTimeField`

output type select는 항상 표시하고 기존 `QueryOutputType` allowlist만 사용한다.

`When no row matches`의 기본값은 `null`이다.

값은 기존 `QueryLiteralRhs` scalar contract 안에서만 편집한다.

#### Scalar subquery focus 순서

Source → Connect Rows → Filter Target Rows → Returned Value → Row Choice → Output.

fieldset는 기본적으로 모두 펼쳐져 있다.

단, editor 높이가 작아도 fieldset 자체를 accordion으로 바꾸지 않는다.

사용자가 computed item 전체를 접을 수 있으므로 내부에 추가 accordion을 만들지 않는다.

### 14.10 Related-row computed / Exists

표시 순서:

1. relation/source
2. connection
3. target predicate
4. output summary `True when at least one row matches`

predicate related-row check와 terminology를 맞춘다.

### 14.11 Window value

표시 순서:

1. `Function`
2. `Value field`
3. `Partition by`
4. `Order within window`

Function:

- `Row number`
- `Rank`
- `Dense rank`
- `Sum`
- `Average`
- `Minimum`
- `Maximum`
- `Count`

`Row number`, `Rank`, `Dense rank`:

- `Value field` 숨김
- 기존 stale field 값이 있으면 Recipe를 자동 삭제하지 않고 read-only stale-state notice와 `Remove unused field` action 제공

나머지 function:

- `Value field` 공통 picker
- `Primary key (default)` option은 Recipe의 omitted `field`에 대응
- compiler가 현재 수행하는 primary-key 기반 Sum/Average/Minimum/Maximum/Count semantics를 그대로 유지
- concrete field를 선택하면 `field: { kind: "field", path }`

`Partition by`:

- zero or more field picker rows
- add/remove/move

`Order within window`:

- one or more order rows
- 공통 reference picker와 Ascending/Descending
- empty는 blocking error `Add at least one window order.`

현재 Recipe V2에는 frame과 outputType property가 없다.

따라서 frame 또는 output type control을 만들지 않는다.

### 14.12 Code expression

기존 안전 정책과 allowlist를 유지한다.

expression input:

- `<input type="text">`
- visible label
- monospace는 VS Code editor font token
- `spellcheck=false`
- newline 입력 불가
- `MODEL_QUERY_RECIPE_LIMITS.rawCodeExpressionCharacters` maxLength
- code value를 webview persisted state에 저장하지 않음

뒤이어:

- `Only when` checkbox
- checked일 때 source-model predicate builder
- `Output type` allowlist select

안전 설명:

- `Advanced: restricted Django expression only; no newlines.`
- 승인된 restricted expression만 실행됨
- validation 전 Apply 불가
- raw Python 실행 권한을 확장하지 않음

---

## 15. Result stage

### 15.1 heading과 intro

heading:

- `Result`

intro:

`Choose whether the grid returns individual rows or summary rows, then set grouping and order.`

### 15.2 mode

fieldset:

- legend `Result shape`

segmented buttons:

- `Rows`
- `Summary`

설명:

- Rows: `Return individual model rows.`
- Summary: `Return one row for each selected group, or one global summary row.`

mode 변경은 Undo 가능.

Rows로 바꿀 때 기존 contract대로 groupBy가 제거된다.

변경 전 groupBy가 있으면 inline confirmation:

```text
Switch to Rows?
2 summary group fields will be removed.
[Switch to Rows] [Cancel]
```

Undo로 복구 가능.

groupBy가 없으면 즉시 전환.

### 15.3 Summary grouping

Summary mode에서만 표시.

empty:

`No group fields. The result is one global summary row.`

각 group field:

- common field picker
- remove
- up/down if Recipe order has meaning

add:

- `Add group field`

최대 8은 현재 Recipe limit를 유지.

limit 도달:

- disabled button
- visible `The query can group by up to 8 fields.`

### 15.4 Result order

empty:

- Rows: `No custom order. Rows use the existing primary-key default.`
- Summary: `No custom order. Summary row order is not guaranteed.`

각 term:

1. `Order by` searchable reference picker
2. direction
3. move up/down
4. remove

reference option group:

- `Model fields`
- `Calculated values`

option label:

- direct: `Company name — name`
- computed: `Calculated — latest_valuation`

native select 대신 common searchable picker 사용.

현재 disabled computed alias를 참조하는 stale Recipe:

- value 보존
- error `This calculated value is disabled. Enable it or choose another order field.`

### 15.5 Result stage focus

- mode change 후 mode segment 유지
- Add group field → 새 picker
- Add order → 새 order picker
- remove → 다음/이전/Add
- validation issue → exact picker/direction

### 15.6 `groupBy` stable UI key

Recipe V2 `groupBy` entry에는 `nodeId`가 없으므로 Recipe schema를 바꾸지 않고 renderer-local key adapter를 사용한다.

새 pure helper:

- `media/gridQueryStableListKeys.js`

algorithm:

1. renderer는 `{ key, signature }[]`의 직전 projection을 보관한다.
2. groupBy signature는 `field:<path>`다.
3. 새 Recipe projection과 이전 projection의 longest common subsequence를 계산한다.
4. 일치 entry는 기존 key를 유지한다.
5. duplicate signature는 왼쪽에서 오른쪽 occurrence 순서로 매칭한다.
6. 새 entry는 monotonic `group-by-ui-N` key를 받는다.
7. 명시적 add/remove/move action은 dispatch 전에 예상 key list도 같이 갱신해 focus intent가 새 key를 즉시 사용할 수 있게 한다.
8. source 변경은 key sequence와 projection을 초기화한다.

이 helper는 Recipe, persisted state, host payload에 key를 쓰지 않는다.

`orderBy`는 기존 `nodeId`를 그대로 사용한다.

test:

- add
- remove
- move
- duplicate field path
- Undo
- Redo
- hydrate
- source reset
- focus key 유지

---

## 16. 반응형 및 container 판단

### 16.1 width source

viewport 전체 width가 아니라 Query Builder root의 실제 available width를 기준으로 한다.

`ResizeObserver`를 Query Builder workspace root에 연결한다.

width category:

- `wide`: `>= 960`
- `medium`: `>= 640 && < 960`
- `narrow`: `< 640`

CSS media query와 JS category가 충돌하지 않도록 CSS는 container query를 우선 사용한다.

현재 build target에서 container query를 지원하지 않는 경우:

- root에 `data-query-width="wide|medium|narrow"`를 설정
- CSS attribute selector를 사용

새 polyfill은 도입하지 않는다.

### 16.2 height behavior

normal mode:

- user drawer height 사용
- min 220px
- grid min 144px

Query Builder workspace usable height가 180px 미만이면:

- footer/header/nav는 유지
- editor scroll 사용
- 자동 Focus mode 전환은 하지 않음
- header에 `Focus Builder`가 계속 보임

### 16.3 200% zoom

acceptance:

- stage navigation은 narrow select로 전환하거나 wrap 없이 안전하게 대체
- footer action 접근 가능
- Problems text가 잘리지 않음
- popup은 viewport 안
- horizontal page scroll 없음
- node action은 overflow menu를 사용할 수 있으나 모든 기능 유지

node action 축소 규칙:

- available item header width `>= 560`: move, duplicate, delete 모두 visible
- `< 560`: `More actions` menu에 move/duplicate/delete 이동
- enabled checkbox와 disclosure는 항상 visible

### 16.4 long text

- alias/path는 `min-width:0`
- header summary는 ellipsis 가능
- full value는 Meaning 또는 visible path line에서 wrap
- Problems message/fix는 wrap
- code는 horizontal scroll 허용
- tooltip만으로 full value 제공하지 않음

---

## 17. keyboard, focus, accessibility 계약

### 17.1 semantic landmark

- Query Builder `<aside aria-labelledby="queryBuilderTitle">`
- title `<h2>`
- stage navigation `<nav>`
- active stage `<section aria-labelledby=...>`
- inspector `<aside aria-label="Query review">`
- footer `<footer>`

한 페이지에 중복 heading ID를 만들지 않는다.

### 17.2 skip links

Query Builder가 열렸을 때 첫 focusable 요소 앞에 세 개의 visually hidden-until-focus link:

- `Skip to query stages`
- `Skip to active editor`
- `Skip to query review`
- `Skip to Apply query`

각 target은 `tabindex="-1"`을 가질 수 있다.

### 17.3 Escape 우선순위

Escape 한 번의 처리 우선순위:

1. 열린 combobox/popover 닫기
2. 열린 More menu 닫기
3. pending kind/mode confirmation 취소
4. Focus Builder 종료
5. Query Builder 닫기

한 key event에서 둘 이상 수행하지 않는다.

handled event만 `preventDefault()`와 `stopPropagation()`한다.

### 17.4 focus style

- `outline: none` 단독 사용 금지
- `:focus-visible`에 VS Code focus border token 사용
- group/item은 child focus 시 `:focus-within` 표시
- high contrast에서 border가 사라지지 않음
- error border와 focus border를 동시에 인지 가능하게 outline/box-shadow layer 분리

### 17.5 button

- 모든 button `type="button"`
- icon-only는 `aria-label`
- disabled action은 가능한 경우 visible reason
- target size 최소 24×24px
- primary visual은 Apply 하나
- structural button은 secondary/quiet

### 17.6 form

- placeholder는 label 대체 금지
- control마다 visible label
- identifiers는 `spellcheck=false`
- browser autofill이 의미 없는 developer tool field는 `autocomplete=off`
- input `name`은 stable control role 기반
- error는 control과 연결
- required는 aria 및 visible cue 둘 다 사용

### 17.7 live announcement

두 채널:

- polite status
- assertive error는 Apply rejection과 unrecoverable metadata failure에 한정

animation:

- stage/pane 전환은 즉시
- 필요한 경우 opacity 100ms 이하
- `prefers-reduced-motion`에서 제거
- `transition: all` 금지

### 17.8 icon

- 기존 Codicon font/class 사용
- Unicode `↑`, `↓`, `×`, 깨질 수 있는 glyph를 action icon으로 사용하지 않음
- icon과 text가 함께 있는 action에서 icon은 `aria-hidden=true`
- state를 icon/색상만으로 전달하지 않음

---

## 18. 시각 시스템 계약

### 18.1 유지할 언어

- VS Code editor background
- panel border
- input background/foreground/border
- focus border
- error/warning foreground 및 border
- badge token
- button semantic token
- editor font 및 monospace token

### 18.2 금지

- hard-coded hex palette
- gradient
- glass effect
- large shadow
- 12px 이상의 decorative radius
- 새 font
- marketing illustration
- card 안의 card 반복
- primary blue structural buttons

### 18.3 spacing

고정 spacing scale:

- 2px: icon/text micro gap
- 4px: related compact controls
- 6px: compact toolbar gap
- 8px: control group vertical gap
- 12px: stage section padding
- 16px: major fieldset separation

control height:

- 기본 24px
- multiline/help에 따라 row height 자동

### 18.4 border

- shell boundary: 1px panel border
- stage/inspector divider: 1px panel border
- group/computed item: 1px panel border
- selected/focus: focus token
- nested depth: left border

shadow는 popup에만 VS Code widget shadow token을 사용한다.

---

## 19. 파일 및 모듈 변경 계약

### 19.1 공통 source 규칙

모든 새/수정 code file:

- 1000줄 이하
- 첫 줄에 짧은 purpose summary comment
- 모든 class/function/method에 JSDoc/docstring-style summary
- 한 파일은 하나의 주책임
- `npm run check` 준수

### 19.2 `src/modelBrowserHtml.ts`

책임:

- semantic shell mount point만 제공

변경:

- 기존 query drawer 내부 section markup을 새 shell mount 구조로 교체
- resize handle mount
- header/nav/workspace/editor/inspector/footer mount
- popover layer
- 필요한 live region
- summary Apply와 drawer Apply ID 분리 유지

금지:

- Recipe-specific dynamic control markup 작성
- inline handler
- inline style

### 19.3 `media/modelBrowserSource.js`

변경:

- `vscode` state API를 query controller option으로 전달
- actual Link label getter 전달
- grid focus/scroll capture 및 restore callback 전달
- drawer focus mode에서 grid hidden/inert를 적용하는 adapter 전달

Recipe logic은 추가하지 않는다.

### 19.4 `media/gridQueryController.js`

목표:

- 422줄짜리 mixed controller를 orchestration 전용으로 축소

최종 책임:

- source lifecycle
- store와 UI store 생성
- host message routing
- preview/apply request scheduling
- render model assembly
- child module wiring
- public API

이 파일에서 제거:

- Result DOM 직접 생성
- Meaning DOM 직접 생성
- builder full mount 로직
- copy UI 구현
- issue DOM 구현
- drawer layout DOM 조작 세부

목표 line budget:

- 350~550줄

### 19.5 `media/gridQueryRecipeStore.js`

변경:

- history
- undo/redo
- text coalescing metadata
- canUndo/canRedo snapshot
- source reset history
- action의 `history` metadata를 해석하는 `dispatch(action)`

유지:

- JSON clone
- immutable snapshot
- Recipe reducer semantics

목표 line budget:

- 220~380줄

현재 파일의 Recipe action reducer, traversal, node clone/move helper를 새 `media/gridQueryRecipeReducer.js`로 반드시 분리한다.

분리 후:

- `gridQueryRecipeReducer.js`: Recipe action, traversal, canonical starter, node clone/move helper만
- `gridQueryRecipeStore.js`: snapshot, history, validation/apply state, subscribe/publish만

`gridQueryRecipeReducer.js` 목표:

- 180~320줄

### 19.6 새 `media/gridQueryUiState.js`

책임:

- UI state
- enum sanitization
- transient reset
- safe preference serialize/restore
- Set/array conversion

목표:

- 180~300줄

### 19.7 새 `media/gridQueryRenderCoordinator.js`

책임:

- coalesced render
- region signature
- region lifecycle
- focus capture/restore orchestration

목표:

- 180~320줄

### 19.8 새 `media/gridQueryFocus.js`

책임:

- stable key helpers
- focus capture
- caret/selection restore
- explicit focus intent
- ancestor reveal sequencing

목표:

- 180~320줄

### 19.8.1 새 `media/gridQueryStageSelectors.js`

책임:

- stage item count
- issue-to-stage count
- stage accessible label projection

DOM을 참조하지 않는 순수 함수.

목표:

- 80~160줄

### 19.9 새 `media/gridQueryWorkspace.js`

책임:

- shell layout state
- width category
- drawer open/close
- Focus Builder
- active editor/review pane visibility
- Escape priority delegate

목표:

- 250~450줄

### 19.10 새 `media/gridQueryStageNav.js`

책임:

- desktop tablist
- narrow select
- counts/issues
- roving tabindex
- stage activation

목표:

- 160~280줄

### 19.11 새 `media/gridQueryDrawerResize.js`

책임:

- pointer separator
- keyboard resize
- clamp
- persisted height callback

기존 log drawer pattern을 복제하지 말고 공통화가 안전하면 generic helper를 추출한다.

단, Query Log behavior를 변경하지 않는 characterization test를 먼저 추가한다.

목표:

- 140~240줄

### 19.12 새 `media/gridQueryInspector.js`

책임:

- Meaning/Problems/ORM tab shell
- medium/narrow Review pane
- tab scroll preservation
- copy feedback

세부 render가 커지면 다음으로 분리:

- `gridQueryMeaningView.js`
- `gridQueryProblemsView.js`
- `gridQueryOrmView.js`

각 파일 목표:

- 120~300줄

### 19.12.1 새 `media/gridQueryLifecycle.js`

책임:

- validation state transition
- Apply/result state transition
- requestId/revision stale guard
- summary/footer derived status selector

DOM, timer, host post를 직접 수행하지 않는 순수 module.

목표:

- 140~260줄

### 19.13 새 `media/gridQueryIssueTarget.js`

책임:

- validation path/nodeId를 stage/control key로 매핑

DOM을 참조하지 않는 순수 함수.

목표:

- 100~220줄

### 19.14 `media/gridPredicateBuilder.js`

변경:

- persistent builder/update contract
- keyed group/node DOM
- visible labels
- group disclosure state 외부화
- comparison grid
- focus keys
- secondary actions/Codicons
- common picker

1000줄에 접근하지 않도록 다음 분리를 고정 승인한다.

- `gridPredicateGroupView.js`
- `gridPredicateComparisonView.js`
- `gridPredicateExistsView.js`

`gridPredicateBuilder.js`는 tree orchestration만 담당한다.

### 19.15 `media/gridComputedBuilder.js`

변경:

- persistent item map
- open state 외부화
- item header/action
- pending kind confirmation
- kind-specific renderer wiring

다음 renderer는 각각 독립:

- 기존/개선 `gridSubqueryBuilder.js`
- 기존/개선 `gridAggregateBuilder.js`
- formula renderer
- window renderer
- code renderer

각 renderer는 `node`, `update`, `destroy`, `focusTargets` contract를 따른다.

### 19.16 `media/gridQueryFieldPicker.js`

변경:

- visible label/path/type/help
- relation segment focus
- portal combobox
- generation guard
- stable dispose

### 19.17 `media/gridCombobox.js`

변경:

- bounded 60 option
- portal API
- complete ARIA
- PageUp/PageDown
- dispose
- result status

generic module로 유지하고 Recipe semantics를 넣지 않는다.

### 19.18 새 `media/gridQueryPopover.js`

책임:

- portal mount
- fixed position
- available space 계산
- rAF reposition
- outside pointer
- close/focus restore

이 module은 Phase 3에서 header More menu를 위해 먼저 추가하고, Phase 5에서 combobox가 같은 instance contract를 사용한다.

### 19.18.1 새 `media/gridQueryScalarEditor.js`

책임:

- typed `QueryScalar` form control
- field-aware parse
- untyped Value type selection
- local parse issue

Recipe action과 metadata fetch를 직접 수행하지 않는다.

목표:

- 160~280줄

### 19.19 새 `media/gridQueryResultControls.js`

책임:

- mode
- groupBy
- orderBy
- mode confirmation
- searchable reference picker
- keyed result item

`gridQueryController.js`에서 Result DOM을 제거한다.

### 19.19.1 새 `media/gridQueryStableListKeys.js`

책임:

- nodeId가 없는 JSON list entry의 renderer-local stable key reconciliation
- longest common subsequence
- duplicate occurrence matching

Recipe나 DOM을 직접 변경하지 않는 순수 helper.

첫 consumer는 `groupBy`다.

목표:

- 100~200줄

### 19.20 CSS

기존 32줄 minified 형태를 계속 확장하지 않는다.

파일:

- `media/modelQueryBuilder.css`
  - summary, shell boundary, shared tokens
- 새 `media/modelQueryWorkspace.css`
  - header/nav/workspace/inspector/footer/resizer/focus mode/responsive
- 새 `media/modelQueryControls.css`
  - field grid, group, computed item, result, validation
- 기존 `media/modelQueryGuidance.css`
  - guidance/meaning/problem text
- 새 `media/modelQueryPopover.css`
  - portal/listbox

각 CSS 파일 첫 줄 purpose comment.

각 파일 1000줄 이하.

CSS load 순서를 `src/modelBrowser.ts` 또는 현재 asset assembly에 명시적으로 추가한다.

### 19.21 controller public API

최종 반환:

```js
{
  apply,
  destroy,
  getSnapshot,
  onMessage,
  openDrawer,
  setSource,
  toggleGridOrder
}
```

`destroy()`가 제거:

- store subscription
- UI store subscription
- window keydown
- ResizeObserver
- preview timer
- render coordinator
- all builder
- popover
- drawer resizer

no-op controller도 동일 method shape를 갖는다.

---

## 20. 구현 단계와 강제 게이트

### 20.1 전체 순서

구현 순서는 다음으로 고정한다.

```text
Phase 0  Characterization
   ↓
Phase 1  Render/focus foundation
   ↓
Phase 2  Recipe history + UI state
   ↓
Phase 3  Query workspace shell
   ↓
Phase 4  Validation lifecycle + Review
   ↓
Phase 5  Shared picker/popover
   ↓
Phase 6  Predicate stages
   ↓
Phase 7  Calculated Values
   ↓
Phase 8  Result stage
   ↓
Phase 9  Responsive/accessibility/theme polish
   ↓
Phase 10 Full automated verification
   ↓
Phase 11 Real rtcc-poc-page integration verification
```

앞 phase의 exit gate가 통과하지 않으면 다음 phase의 broad implementation을 시작하지 않는다.

작은 test helper나 interface stub은 다음 phase 준비를 위해 만들 수 있지만 사용자-visible behavior를 먼저 노출하지 않는다.

### 20.2 작업 중 worktree 규칙

- 시작 시 `git status --short`를 기록한다.
- 기존 dirty file을 사용자 변경으로 취급한다.
- 이 계획과 관계없는 변경을 revert, format, stage하지 않는다.
- 같은 파일에 기존 변경이 있으면 diff를 먼저 읽고 최소 patch를 적용한다.
- destructive git command를 사용하지 않는다.
- 생성한 build artifact가 저장소 관례상 tracked인지 확인한다.
- `media/dist/modelBrowser.js`가 build output이면 source 수정 후 지정 build 과정으로만 갱신한다.
- generated file을 수동 편집하지 않는다.

---

## 21. Phase 0 — Characterization과 안전망

### 21.1 목적

새 UI 작업 전에 현재 Recipe, compiler, transport, grid 적용 동작을 고정한다.

현재의 잘못된 focus/remount behavior를 “유지할 동작”으로 고정하지 않는다.

### 21.2 시작 전 기록

다음을 기록한다.

- `git status --short`
- `npm run check` baseline 결과
- 현재 관련 test 파일 목록
- 현재 code file line count
- 현재 Query Builder 실제 화면:
  - drawer closed
  - drawer open at top
  - scalar subquery expanded
  - Problems/ORM area
- dark theme
- 실제 약 700px Model Data editor width

baseline command 실패가 기존 문제면:

- exact command
- exit code
- 이 계획과 무관한 최초 failure
- 관련 file

를 문서화하고 새 failure와 구분한다.

### 21.3 characterization test 추가

기존 test naming convention을 따라 다음 test를 추가 또는 확장한다.

#### `test/gridQueryRecipeStore.test.mjs`

고정할 항목:

- initial draft/applied clone
- dispatch increments draftRevision
- dirty comparison
- validationRevision invalidation
- setApplied/newer draft 보존
- finishApply matching draft normalization
- finishApply newer draft 보존
- stale validation 무시
- source-specific empty Recipe

#### `test/gridQueryController.test.mjs`

고정할 항목:

- preview revision guard
- Apply revision guard
- rows/count/summary matching revision routing
- source change
- grid order가 draft만 변경
- Ctrl/Cmd+Enter input guard

#### compiler/host 기존 test

다음을 그대로 통과해야 한다.

- Recipe V2 serialize/deserialize
- annotation compile
- aggregate compile
- scalar subquery compile
- Exists compile
- postFilter compile
- groupBy/orderBy
- allowlist/limit/safety
- stale response rejection

### 21.4 DOM test harness

새 파일:

- `test/modelQueryDomHarness.mjs`

목적:

- production dependency 없이 Query Builder module test에 필요한 최소 DOM을 제공

지원 범위:

- element creation
- attributes/dataset
- event listener/dispatch
- focus/activeElement
- value
- selectionStart/End/Direction
- hidden
- inert property
- scrollTop/scrollLeft
- `getBoundingClientRect` fixture
- `scrollIntoView` call 기록
- `ResizeObserver` fixture
- `requestAnimationFrame` queue
- clipboard fixture

지원하지 않는 browser 동작을 임의로 흉내 내지 않는다.

layout, real accessibility tree, actual popup clipping은 E2E/visual QA에서 검증한다.

모든 helper function에 summary comment를 붙인다.

### 21.5 Phase 0 exit gate

- baseline `npm run check` 결과 기록
- Recipe/compiler/transport characterization test 성공
- DOM harness 자체 test 성공
- current screenshots 또는 inspection note 저장
- 기존 semantic behavior가 테스트로 보호됨

---

## 22. Phase 1 — Render coordinator와 focus 안정화

### 22.1 목적

사용자가 입력하는 동안 stage builder가 destroy/recreate되지 않도록 한다.

레이아웃 재설계는 이 phase에서 하지 않는다.

### 22.2 구현 파일

추가:

- `media/gridQueryRenderCoordinator.js`
- `media/gridQueryFocus.js`
- `test/gridQueryRenderCoordinator.test.mjs`
- `test/gridQueryFocus.test.mjs`

수정:

- `media/gridQueryController.js`
- `media/gridPredicateBuilder.js`
- `media/gridComputedBuilder.js`
- `media/gridQueryValidationView.js`

### 22.3 세부 작업

#### 작업 1 — direct render 제거

`gridQueryController.js`에서 다음 경로를 모두 찾아 `requestRender(reason)`으로 바꾼다.

- store subscribe
- metadata `onChange`
- preview timer 상태 변화
- preview response
- Apply begin
- Apply success/reject
- source set
- catalog response
- reset/clear

`render(snapshot)` parameter를 제거한다.

coordinator flush만 최신 store snapshot을 읽는다.

#### 작업 2 — preview scheduling과 render 분리

store subscriber:

1. revision 변화 감지
2. preview scheduler에 revision 알림
3. render request

preview scheduler는 render를 직접 호출하지 않는다.

lifecycle state를 바꾸고 render request만 한다.

#### 작업 3 — persistent builder

controller 생성 시:

- where predicate builder 한 번 생성
- computed builder 한 번 생성
- postFilter predicate builder 한 번 생성
- result renderer 한 번 생성

source change 또는 controller destroy 전에는 builder 자체를 destroy하지 않는다.

각 builder에 `update(model)`을 추가한다.

#### 작업 4 — stable control key

현재 모든 interactive control을 inventory하고 key를 부여한다.

key 없는 control이 test에서 검출되도록 Query Builder root 아래의 interactive element를 순회하는 assertion을 추가한다.

예외:

- popup listbox option은 option ID/active descendant 계약을 사용
- decorative 또는 disabled non-interactive element

#### 작업 5 — caret capture/restore

test fixture:

1. alias input focus
2. value `latest`
3. selectionStart 3, selectionEnd 5
4. unrelated validation state update
5. render flush

assert:

- same DOM input identity
- focus 유지
- selection 3..5 유지
- computed details open
- scrollTop 유지

#### 작업 6 — structural focus

add/remove/move/duplicate action마다 §9.10 target을 test한다.

queued promise에만 의존하지 말고 coordinator flush completion hook에서 intent를 복원한다.

#### 작업 7 — announcement dedupe

validation view에서 반복 `role=alert`를 제거한다.

같은 signature render 3회:

- announce 1회

새 revision:

- announce 1회

typing pending:

- announce 0회

### 22.4 Phase 1 필수 test

#### `gridQueryRenderCoordinator.test.mjs`

- 같은 task의 request 5회 → flush 1회
- latest model만 사용
- signature 동일 region update 0회
- signature 변경 region만 update
- region error가 다른 region cleanup을 누락하지 않음
- destroy 후 request 무시
- pending flush destroy 안전

#### `gridQueryFocus.test.mjs`

- focus outside builder → capture 없음
- text caret/selection direction 복원
- explicit intent가 capture보다 우선
- missing target fallback
- preventScroll 사용
- reveal mode scrollIntoView
- stage scrollTop 복원
- removed control sibling fallback

#### builder test

- alias input 중 node identity 유지
- open computed item 유지
- open group 유지
- field picker metadata update 중 focus 유지
- validation update 중 input value 유지

### 22.5 Phase 1 exit gate

- 한 Recipe action당 coordinator flush 최대 1회
- text input DOM identity 유지 test 성공
- caret/selection/open/scroll 회귀 test 성공
- 모든 structural focus target test 성공
- existing Recipe/compiler test 성공
- 아직 사용자-visible layout은 기존과 기능적으로 동등

---

## 23. Phase 2 — Undo/Redo와 UI state

### 23.1 목적

사용자의 Recipe 실수를 복구하고, layout/navigation state를 Recipe state와 분리한다.

### 23.2 구현 파일

추가:

- `media/gridQueryUiState.js`
- `media/gridQueryRecipeReducer.js`
- `test/gridQueryUiState.test.mjs`
- `test/gridQueryHistory.test.mjs`
- `test/gridQueryRecipeReducer.test.mjs`

수정:

- `media/gridQueryRecipeStore.js`
- `media/modelBrowserSource.js`
- `media/gridQueryController.js`

### 23.3 Recipe history 작업

#### store snapshot 추가

```js
{
  canRedo,
  canUndo,
  ...
}
```

history array 자체는 snapshot으로 노출하지 않는다.

#### public method

```js
{
  endHistoryGroup(),
  redo(),
  undo()
}
```

`dispatch()`는 action history metadata를 해석한다.

#### history equality

- JSON Recipe equality 사용
- reducer 결과가 현재 draft와 같으면 revision/history를 올리지 않음
- no-op move, same select value, same text value는 no-op

#### reset/clear

- current draft와 결과가 다를 때만 checkpoint
- 실행 후 canUndo true

### 23.4 UI state 작업

#### create

```js
createQueryUiState({
  persisted,
  persist
})
```

반환:

```js
{
  destroy(),
  dispatch(action),
  getSnapshot(),
  subscribe(listener)
}
```

#### persistence throttle

- drawer height pointermove마다 `setState()` 호출하지 않음
- drag 중 memory update
- pointerup 또는 150ms trailing throttle에 persist
- stage/tab/drawer open은 즉시 persist

기존 webview state object의 다른 key를 보존해서 merge한다.

```js
vscode.setState({
  ...(vscode.getState() || {}),
  queryDrawerHeight: ...
})
```

### 23.5 shortcut 작업

window keydown handler는 다음 순서:

1. event가 Query Builder 또는 query popup에서 시작했는지 확인
2. native text undo target이면 return
3. Undo/Redo match
4. preventDefault
5. store undo/redo

Query Builder 밖 VS Code 또는 grid shortcut을 침범하지 않는다.

### 23.6 Phase 2 test

#### history

- discrete action 1회 Undo
- 10 keystroke 같은 group → Undo 1회
- 601ms 뒤 입력 → Undo 2회
- blur boundary
- different control boundary
- Undo 뒤 new edit future clear
- Redo
- max 50
- Apply success history 유지
- Apply 후 Undo → dirty
- source change clear
- no-op action no history/revision
- reset/clear Undo
- type conversion confirmation action 1 checkpoint

#### UI state

- invalid persisted enum sanitize
- height clamp
- allowed keys만 restore
- Focus mode restore false
- Recipe literal serialize 안 함
- existing vscode state key preserve
- drawer height persist throttle
- source transient reset

### 23.7 Phase 2 exit gate

- Undo/Redo 모든 case 성공
- text input native undo와 Recipe undo 충돌 없음
- persistence에 Recipe/value가 포함되지 않음
- source change 후 stale node ID 없음
- Phase 1 focus test 계속 성공

---

## 24. Phase 3 — Query workspace shell

### 24.1 목적

긴 단일 drawer를 네 stage와 Review workspace로 바꾸고, resizable/focus mode를 제공한다.

### 24.2 구현 파일

추가:

- `media/gridQueryWorkspace.js`
- `media/gridQueryStageNav.js`
- `media/gridQueryStageSelectors.js`
- `media/gridQueryDrawerResize.js`
- `media/gridQueryPopover.js`
- `media/modelQueryWorkspace.css`
- `test/gridQueryWorkspace.test.mjs`
- `test/gridQueryStageNav.test.mjs`
- `test/gridQueryStageSelectors.test.mjs`
- `test/gridQueryDrawerResize.test.mjs`
- `test/gridQueryPopover.test.mjs`

수정:

- `src/modelBrowserHtml.ts`
- `src/modelBrowser.ts`
- `media/modelBrowserSource.js`
- `media/gridQueryController.js`
- `media/uiOverflowMenu.js`
- `media/modelQueryBuilder.css`

### 24.3 HTML migration

기존 ID를 한 번에 삭제하지 않는다.

순서:

1. 새 mount ID 추가
2. renderer를 새 mount에 연결
3. tests와 runtime 확인
4. 사용되지 않는 old section ID 제거
5. `QUERY_IDS`를 새 element contract로 갱신

새 필수 ID:

- `queryBuilderTitle`
- `queryDrawerResizeHandle`
- `queryDrawerHeader`
- `queryUndo`
- `queryRedo`
- `queryFocusMode`
- `queryMoreActions`
- `queryClose`
- `queryStageNav`
- `queryStageSelect`
- `queryMobilePaneSwitch`
- `queryEditorPane`
- `queryFilterRowsPanel`
- `queryCalculatedValuesPanel`
- `queryFilterResultsPanel`
- `queryResultPanel`
- `queryReviewPane`
- `queryInspectorTabs`
- `queryMeaningPanel`
- `queryProblemsPanel`
- `queryOrmPanel`
- `queryDrawerFooter`
- `queryDrawerStatus`
- `queryDrawerApply`
- `queryPopoverLayer`

ID는 하나만 존재해야 한다.

### 24.4 stage panel lifecycle

모든 stage panel DOM은 drawer lifetime 동안 존재한다.

inactive panel:

- `hidden = true`
- `inert = true`
- `aria-hidden = true`

active panel:

- 위 세 속성을 제거/false
- heading tabindex `-1`

stage activation이 focus에 의해 발생:

- tab keyboard navigation이면 active panel heading으로 focus를 자동 이동하지 않음
- tab focus 유지

summary button으로 stage 열기:

- panel 첫 relevant control focus

Problems에서 이동:

- exact control focus

### 24.5 stage count

순수 selector는 `media/gridQueryStageSelectors.js`에 작성한다.

test:

- nested group leaf count
- Exists inner condition을 outer stage count에 포함
- computed enabled/disabled 모두 count
- Result default zero
- groupBy/order custom count
- errors/warnings stage mapping

### 24.6 More menu

기존 `media/uiOverflowMenu.js`의 action 이동과 menu keyboard semantics를 재사용한다.

이 module을 다음처럼 확장한다.

- `menuHost` option으로 `queryPopoverLayer`를 받음
- `gridQueryPopover.js`를 position adapter로 받음
- button `aria-haspopup="menu"`
- `aria-expanded`
- menu `role=menu`
- items `role=menuitem`
- ArrowUp/Down
- Home/End
- Enter/Space
- Escape
- Tab closes and continues
- outside click closes
- destroy 때 document pointerdown, root focusout, trigger click, menu listeners까지 전부 제거

More menu와 narrow node action menu는 같은 extended helper를 사용한다.

Phase 5에서 다른 menu 구현으로 이관하지 않는다.

### 24.7 one Apply

drawer open:

- `queryApply.hidden = true`
- `queryApply.inert = true`
- `aria-hidden=true`

drawer closed:

- summary Apply 복원
- drawer Apply가 drawer hidden subtree에 있음

test:

- visible/enabled primary Apply count는 0 또는 1
- 가능 상태: 1
- disabled 상태도 사용자-visible Apply는 1

### 24.8 drawer close

Close:

- draft 보존
- history 보존
- validation 보존
- drawer scroll/state 보존
- focus summary toggle로 복원

reopen:

- last active stage
- last inspector tab
- stage scroll
- open nodes

### 24.9 Focus Builder

grid adapter contract:

```js
{
  enterQueryFocusMode(),
  exitQueryFocusMode(),
  getGridViewState()
}
```

`getGridViewState()`:

- scrollLeft
- scrollTop
- selected row/column key
- active grid focus key

실제 grid API에서 가능한 값만 사용하되 scroll과 selected cell은 필수다.

Focus Builder가 Recipe나 grid data를 재요청하지 않는다.

### 24.10 Phase 3 test

- stage tab ARIA association
- roving tabindex
- Arrow/Home/End
- narrow select activation
- medium Review/Edit swap
- inactive pane hidden+inert
- stage state 보존
- drawer close/reopen
- one Apply
- resize pointer/keyboard
- height clamp
- Focus Builder grid state capture/restore
- Escape priority
- source change exits focus mode
- no Recipe mutation from UI navigation

### 24.11 Phase 3 visual gate

test fixture 또는 local webview에서:

- 1100px Query Builder width
- 800px
- 520px
- drawer min height
- drawer max height
- 200% zoom equivalent

확인:

- header action overlap 없음
- stage label truncation 시 accessible name 유지
- footer가 editor를 덮지 않음
- grid minimum 유지
- focus mode에서 grid가 keyboard tree에서 제거

### 24.12 Phase 3 exit gate

- fixed information architecture 구현
- stage 이동에 Recipe/focus state 손실 없음
- resize/focus mode functional test 성공
- wide/medium/narrow shell visual check 완료
- 상단/drawer Apply 중복 제거

---

## 25. Phase 4 — validation lifecycle와 Review inspector

### 25.1 목적

편집과 검토를 분리하고, validation의 시간적 상태를 정확히 표시한다.

### 25.2 구현 파일

추가:

- `media/gridQueryLifecycle.js`
- `media/gridQueryInspector.js`
- `media/gridQueryMeaningView.js`
- `media/gridQueryProblemsView.js`
- `media/gridQueryOrmView.js`
- `media/gridQueryIssueTarget.js`
- `test/gridQueryLifecycle.test.mjs`
- `test/gridQueryInspector.test.mjs`
- `test/gridQueryIssueTarget.test.mjs`

수정:

- `media/gridQueryController.js`
- `media/gridQueryValidationView.js`
- `media/gridQueryExplanation.js`
- `media/gridQueryGuidanceView.js`
- `media/gridQueryGuidanceCopy.js`
- `media/modelQueryGuidance.css`

### 25.3 lifecycle reducer

controller 안에서 ad hoc boolean을 조합하지 않는다.

`media/gridQueryLifecycle.js`에 validation/apply 두 순수 transition helper를 작성한다.

event:

- `DRAFT_CHANGED`
- `PREVIEW_TIMER_FIRED`
- `PREVIEW_ACCEPTED`
- `PREVIEW_REJECTED`
- `APPLY_STARTED`
- `APPLY_ACCEPTED`
- `APPLY_REJECTED`
- `RESULTS_ACCEPTED`
- `RESULTS_FAILED`
- `SOURCE_CHANGED`

각 event는 revision/requestId를 갖는다.

stale event는 state를 변경하지 않는다.

validation reducer가 처리:

- `DRAFT_CHANGED`
- `PREVIEW_TIMER_FIRED`
- `PREVIEW_ACCEPTED`
- `PREVIEW_REJECTED`
- `SOURCE_CHANGED`

apply reducer가 처리:

- `APPLY_STARTED`
- `APPLY_ACCEPTED`
- `APPLY_REJECTED`
- `RESULTS_ACCEPTED`
- `RESULTS_FAILED`
- `SOURCE_CHANGED`

한 event가 두 reducer에 모두 필요한 경우 같은 immutable event를 각각 전달한다.

### 25.4 local vs host issue

normalized issue view model:

```js
{
  code,
  controlKey,
  explanation,
  fix,
  message,
  nodeId,
  path,
  severity,
  source,
  stage
}
```

merge key:

```text
source:code:path:nodeId
```

동일 문제의 local/host variant가 겹치면 host를 authority로 한 개만 표시한다.

host가 더 구체적인 explanation/fix를 주지 않으면 local guidance copy로 보충한다.

### 25.5 Meaning semantic tokens

plain text parser로 backtick을 HTML에 넣지 않는다.

explanation function이 rich token array를 반환하도록 확장:

```js
[
  { kind: "text", value: "Adds " },
  { kind: "code", value: "latest_valuation" },
  { kind: "text", value: " from related rows." }
]
```

view는 token을 text node 또는 `<code>`로 안전하게 렌더한다.

raw HTML은 받지 않는다.

Phase 4 시작에 `formatExplanationText(tokens)` compatibility formatter를 추가해 기존 non-Query-Builder consumer를 유지한다.

Phase 4 안에서 모든 Query Builder consumer를 rich token view로 전환한 뒤 Query Builder의 string adapter 호출은 제거한다.

### 25.6 Problems content

모든 기존 known issue code를 inventory한다.

각 code에:

- friendly title
- explanation
- exact fix
- target role
- stage

fallback:

- title: host message 또는 code
- explanation: `The query could not validate this setting.`
- fix: `Review the highlighted field and choose a supported value.`

fallback도 빈 문구를 만들지 않는다.

### 25.7 ORM copy

copy handler를 inspector instance method/callback으로 이동한다.

test:

- no preview disabled
- stale preview disabled
- clipboard success status
- clipboard reject status
- clipboard API 없음 status
- copied string은 host ORM만
- Meaning/headers가 copy text에 섞이지 않음

### 25.8 Phase 4 test

#### lifecycle

- text edit → pending, 399ms request 없음
- 400ms → previewing/request 1회
- input blur flush
- structural action immediate
- stale preview ignore
- latest preview ready/invalid
- warning allows Apply
- clean blocks Apply
- Apply with newer edit
- Apply success → loading results
- matching results → idle/new draft state
- rejected Apply → Problems focus
- background error → pane steal 없음

#### inspector

- tab semantics
- medium pane switch
- scroll preservation
- rich code token
- actual link label
- empty states
- problem visible explanation/fix
- technical details safe text
- issue sort
- issue navigation
- stale ORM status/copy disable

### 25.9 Phase 4 exit gate

- validation temporal states 정확
- 이전 ORM preview가 최신으로 오인되지 않음
- Problems에 원인과 fix가 visible
- Apply rejection만 자동 Review
- issue target focus 성공
- copy feedback 성공/실패 모두 visible

---

## 26. Phase 5 — 공통 picker, combobox, popup

### 26.1 목적

모든 metadata 선택을 빠르고 keyboard-accessible하며 clipping 없는 control로 통일한다.

### 26.2 구현 파일

추가:

- `media/modelQueryPopover.css`
- `media/gridQueryScalarEditor.js`
- `test/gridCombobox.test.mjs`
- `test/gridQueryFieldPicker.test.mjs`
- `test/gridQueryScalarEditor.test.mjs`

수정:

- `media/gridCombobox.js`
- `media/gridQueryFieldPicker.js`
- `media/gridQueryPopover.js`
- `media/gridPredicateValue.js`
- `src/modelBrowserHtml.ts`
- asset loading file

### 26.3 public API 고정

#### Popover

```js
createQueryPopover({
  anchor,
  layer,
  onClose,
  root
})
```

반환:

```js
{
  close(reason),
  destroy(),
  node,
  open(content),
  reposition()
}
```

#### Combobox

```js
createGridCombobox({
  describedBy,
  disabledReason,
  getOptionId,
  label,
  maxRenderedOptions: 60,
  name,
  onChange,
  options,
  popoverLayer,
  value
})
```

반환:

```js
{
  destroy(),
  focus(),
  node,
  setDisabled(disabled, reason),
  update({ options, value })
}
```

기존 consumer 호환을 위한 temporary adapter는 Phase 5 안에서만 허용하며 phase 끝에 제거한다.

### 26.4 popup geometry test

fixture:

- viewport 800×600
- anchor y 100 → below
- anchor y 540 → above
- anchor x 750 → right clamp
- narrow viewport 320 → 8px margins
- drawer scroll → reposition once per rAF
- resize three events → one rAF

### 26.5 option behavior test

- 0 result
- 1 result
- 60 result
- 61 result + status
- selected pinned
- exact/prefix/substring ordering
- relation breadcrumb
- new segment focus
- Escape query restore
- Tab close without preventDefault
- PageUp/Down
- metadata pending/error/retry
- stale async generation ignored
- destroy listener cleanup

### 26.6 integration migration 순서

1. predicate field
2. predicate RHS field
3. postFilter computed/direct reference
4. Result reference
5. aggregate relation/value
6. subquery source/correlation/select/order
7. window reference

각 consumer 전환 직후 해당 test를 실행한다.

### 26.7 Phase 5 exit gate

- raw path input이 허용된 code-expression 용도 외에 남지 않음
- 모든 picker keyboard 동작
- popup clipping test 성공
- 60 option bounded
- listener leak 없음
- metadata stale response guard 성공

---

## 27. Phase 6 — predicate stage UI

### 27.1 목적

Filter Rows와 Filter Results를 같은 grammar와 친절한 visible label로 조립한다.

### 27.2 구현 파일

추가 또는 분리:

- `media/gridPredicateGroupView.js`
- `media/gridPredicateComparisonView.js`
- `media/gridPredicateExistsView.js`
- `media/modelQueryControls.css`
- `test/gridPredicateGroupView.test.mjs`
- `test/gridPredicateComparisonView.test.mjs`
- `test/gridPredicateExistsView.test.mjs`

수정:

- `media/gridPredicateBuilder.js`
- relevant explanation/guidance

### 27.3 구현 순서

1. empty state
2. group header/disclosure
3. join visibility
4. comparison control grid
5. lookup labels/help
6. RHS kind
7. type-aware literal
8. inline validation
9. node actions/Codicons
10. related-row check
11. selected node Meaning 연결
12. narrow action overflow

### 27.4 reducer gap 처리

UI가 필요로 하는 action이 현재 reducer에 없으면:

- existing Recipe schema 안에서 purpose-specific action을 추가
- 전체 `REPLACE_DRAFT`를 편의상 남발하지 않음

추가 승인 action 예:

- `SET_GROUP_JOIN`
- `SET_GROUP_NEGATED`
- `SET_COMPARISON_FIELD`
- `SET_COMPARISON_LOOKUP`
- `SET_COMPARISON_RHS`
- `REPLACE_GROUP_BY`

각 action:

- reducer unit test
- history unit test
- no-op unit test

### 27.5 predicate functional test matrix

#### group

- empty root
- one child join hidden
- two child join visible
- All/Any meaning
- negated meaning
- nested depth
- duplicate regenerates every nested nodeId
- move bounds
- remove fallback focus
- open state survives validation

#### comparison

- required field
- allowed lookup by type
- legacy invalid lookup preserved
- value/field/computed RHS
- null lookup hides value
- boolean control
- error association
- selected node inspector

#### related rows

- relation picker
- target metadata scope
- empty target predicate
- positive/negative requirement
- nested issue focus

### 27.6 predicate visual gate

wide/medium/narrow:

- labels align
- 4-field comparison scans in expected order
- nested depth does not crush input
- action buttons do not compete with Apply
- long field path visible
- high contrast focus/error simultaneous

### 27.7 Phase 6 exit gate

- 두 predicate stage가 common builder 사용
- 모든 field/reference picker 기반
- join rule 정확
- focus/open state 회귀 없음
- keyboard-only nested tree 조립 가능
- visual gate 완료

---

## 28. Phase 7 — Calculated Values UI

### 28.1 목적

annotation, aggregate, subquery 등 복잡한 computed Recipe를 명시적 단계와 metadata를 통해 조립한다.

### 28.2 구현 파일

수정/분리:

- `media/gridComputedBuilder.js`
- `media/gridAggregateBuilder.js`
- `media/gridSubqueryBuilder.js`
- formula/window/code renderer
- relevant tests
- `media/modelQueryControls.css`

추가 test:

- `test/gridComputedBuilder.test.mjs`
- `test/gridAggregateBuilder.test.mjs`
- `test/gridSubqueryBuilder.test.mjs`
- 각 지원 kind test

### 28.3 구현 순서

1. persistent computed keyed item
2. header/alias/enabled/action
3. open state
4. kind toolbar/add
5. kind change confirmation
6. Formula
7. Aggregate
8. Scalar subquery
9. Exists/related-row computed
10. Window
11. code expression
12. Meaning/Problems mapping
13. narrow action overflow

### 28.4 computed common test

- add/open/focus alias
- typing alias keeps DOM/focus/caret
- duplicate new node IDs
- move keeps open/focus
- disable removes later reference candidates
- re-enable restores candidates
- delete focus
- kind select fresh immediate
- non-empty kind confirmation
- Cancel
- Escape
- Change Type one history checkpoint
- Undo restores whole previous body
- error item issue target

### 28.5 Aggregate test

- relation-only picker
- target field scope
- function labels/help
- distinct relevant only
- aggregate predicate
- source relation changed → stale selected field preserved as invalid until user fixes
- metadata failure
- compiler Recipe snapshot unchanged from valid equivalent

### 28.6 Scalar subquery test

#### layout

- fieldset legends 1~6 정확
- DOM order 정확
- relation source summary
- direct model source if existing schema supports

#### connection

- automatic relation correlation read-only
- manual outer/target pickers correct scope
- add/remove
- missing warning/error

#### target filter

- target metadata predicate
- nested focus

#### returned value

- raw text input 없음
- selected path/type visible
- missing exact issue

#### row choice

- field picker
- asc/desc
- multiple order
- add/remove/move
- no order warning

#### output

- inferred type
- existing override
- final meaning

#### persistence

- alias typing does not close item
- validation does not scroll to top
- selecting relation moves focus to next segment/control
- Problems opens correct numbered fieldset/control

#### semantic equivalence

UI로 생성한 valid Recipe를 기존 compiler test fixture와 deep equality 또는 normalized equality로 비교한다.

새 property를 Recipe에 넣지 않는다.

### 28.7 Phase 7 real-like fixture

다음 metadata fixture를 추가한다.

```text
Company
├─ id: AutoField
├─ _base_name: CharField
└─ valuation_history_set: reverse relation → ValuationHistory

ValuationHistory
├─ id: AutoField
├─ company_id: ForeignKey
├─ value: DecimalField
└─ created_at: DateTimeField
```

이 fixture로:

- `latest_valuation`
- relation `valuation_history_set`
- returned field `value`
- order `created_at desc`

Recipe를 조립한다.

검증:

- scalar subquery valid
- Meaning correct
- ORM preview request payload correct
- Result/PostFilter reference candidate에 alias 노출

fixture는 test 전용이며 project-specific production hardcode가 아니다.

### 28.8 Phase 7 visual gate

- 220px 최소 drawer에서 computed item 사용 가능
- user-resized 480px drawer에서 6 fieldset 자연스럽게 탐색
- Focus Builder에서 editor/Review 균형
- long relation path
- error 3개
- disabled item
- narrow one-column
- 200% zoom

### 28.9 Phase 7 exit gate

- 모든 기존 computed kind 편집 가능
- scalar subquery raw paths 제거
- 6단계 명세 구현
- kind 변경 안전
- semantic compiler regression 없음
- actual input focus/open state 안정

---

## 29. Phase 8 — Result stage

### 29.1 목적

Rows/Summary, grouping, ordering을 metadata 기반 control로 명확히 조립한다.

### 29.2 구현 파일

추가:

- `media/gridQueryResultControls.js`
- `media/gridQueryStableListKeys.js`
- `test/gridQueryResultControls.test.mjs`
- `test/gridQueryStableListKeys.test.mjs`

수정:

- `media/gridQueryController.js`
- `media/gridQueryRecipeStore.js`
- result explanation
- CSS

### 29.3 구현 순서

1. controller의 current Result DOM 추출
2. persistent result renderer
3. mode segment
4. Rows conversion confirmation
5. groupBy picker
6. order picker
7. direct/computed option grouping
8. limit help
9. focus/history
10. Meaning/Problems

### 29.4 test

- Rows default
- Summary global
- Summary group
- 8 group limit
- switch Summary → Rows with no group immediate
- with groups confirmation/cancel/confirm/undo
- order direct field
- order computed
- disabled computed invalid preserved
- default order explanation
- no-op select
- add/remove/move focus
- outer order validation
- compiler semantics unchanged

### 29.5 Phase 8 exit gate

- native large reference select 제거
- mode/group/order 설명 정확
- destructive mode change 보호
- Result issue focus
- controller DOM 책임 제거

---

## 30. Phase 9 — Responsive, accessibility, theme, polish

### 30.1 목적

구현된 기능을 실제 IDE 조건에서 읽기 쉽고 조작 가능하게 마무리한다.

이 phase에서 정보 구조나 Recipe semantics를 바꾸지 않는다.

### 30.2 automated accessibility audit

새 test:

- `test/gridQueryWorkspaceAccessibility.test.mjs`

assert:

- duplicate ID 없음
- interactive control visible label 또는 accessible name
- input label association
- error describedby
- tabs association
- hidden pane inert
- icon-only name
- button type
- one primary Apply
- `aria-live` 수 제한
- `aria-invalid` consistency
- popup controls/active descendant
- no focusable element inside hidden stage

기존 `test/gridAccessibility.test.mjs`를 공통 control 계약으로 확장하고, Query workspace 고유 계약은 새 test에 둔다.

새 large dependency 도입은 하지 않는다.

### 30.3 CSS static audit

새 source-contract test와 `npm run check:guidelines`에 다음 assertion을 모두 포함:

- hard-coded color 없음
- `transition: all` 없음
- outline 제거에 focus 대체 있음
- CSS file first-line purpose comment
- `min-width:0` critical flex/grid
- popup z-index token/기존 layer와 충돌 없음
- reduced motion
- `@media (forced-colors: active)`에서 focus, selected, error, group/item, popup 경계를 system color로 명시

### 30.4 keyboard walkthrough

mouse 없이:

1. summary에서 Query Builder 열기
2. stage tab 이동
3. Filter condition 추가
4. field search/select
5. lookup/value 설정
6. calculated value 추가
7. alias/type/source/select/order 설정
8. Result order 추가
9. Review Problems 이동
10. issue에서 control 이동
11. Undo/Redo
12. Apply
13. drawer 닫기

각 단계:

- focus visible
- focus order 논리적
- trap 없음
- shortcut conflict 없음

### 30.5 theme matrix

검증 theme:

- VS Code Dark+
- VS Code Light+
- VS Code High Contrast

상태:

- default
- hover
- focus
- selected tab
- disabled
- error
- warning
- popup
- Focus Builder

확인:

- text/background contrast
- semantic border
- selected state가 색만이 아님
- icon 깨짐 없음
- native select option readable

### 30.6 viewport/container matrix

Query Builder available width:

| width | 기대 |
|---|---|
| 1200px | editor + inspector |
| 960px | wide 경계, editor + inspector |
| 959px | medium, editor/Review swap |
| 800px | medium tab row |
| 640px | medium 경계 |
| 639px | narrow select |
| 520px | narrow one-column |
| 360px | narrow minimum practical |

drawer height:

- 220px
- 320px
- 480px
- maximum
- Focus Builder

zoom:

- 100%
- 150%
- 200%

### 30.7 state matrix

각 주요 surface에서:

- loading metadata
- metadata error
- empty Recipe
- clean applied
- dirty pending
- previewing
- valid
- warnings
- local errors
- host errors
- applying
- loading results
- Apply failed
- disabled computed
- long alias/path
- max count
- no search results

### 30.8 performance

development instrumentation으로 다음을 측정한다.

측정 후 production logging은 제거한다.

목표:

- one keystroke → coordinator flush 1회 이하
- unrelated region update 0회
- 200 metadata option search에서 rendered option 60 이하
- popup scroll/resize position update frame당 1회 이하
- no lingering listener after drawer/controller destroy
- text input 20자 연속 입력 시 focus loss 0
- validation response 20회에도 computed root DOM identity 유지

VS Code webview E2E에서 `performance.mark()`와 `performance.measure()`로:

- controlled input handler + render median 16ms 미만을 목표
- 50ms 이상 long task가 반복되지 않음을 기록

수치는 test machine 의존이므로 build gate는 render count/DOM count/listener count로 강제하고 시간은 기록용으로 사용한다.

### 30.9 Phase 9 exit gate

- automated accessibility contract 성공
- keyboard walkthrough 성공
- theme 3종 시각 QA
- width/height/zoom matrix 완료
- performance invariant 성공
- P0/P1 발견 사항 전부 해결

---

## 31. Phase 10 — 전체 자동 검증

### 31.1 실행 순서

다음 순서로 실행한다.

1. 새 Query Builder unit test만
2. 전체 JavaScript test
3. TypeScript compile
4. bundle/build
5. project guideline check
6. 최종 `npm run check`

package script가 위 항목을 이미 포함하면 중복 실행은 허용하지만 최종 `npm run check`는 반드시 별도로 수행한다.

### 31.2 필수 최종 command

```sh
npm run check
```

### 31.3 line count check

모든 source code:

- <= 1000 lines

특히:

- `gridQueryController.js`
- `gridPredicateBuilder.js`
- `gridComputedBuilder.js`
- 새 workspace/inspector modules
- DOM test harness

1000줄을 넘으면 책임별로 분리하고 minify로 회피하지 않는다.

### 31.4 documentation/style check

새/수정 function:

- JSDoc summary

새/수정 code file:

- first-line purpose summary

test helper도 code file 규칙을 적용한다.

### 31.5 final diff audit

다음을 검사한다.

- Recipe schema diff 없음
- protocol message shape 불필요 변경 없음
- query safety/limit 완화 없음
- unrelated grid/edit/log change 없음
- hard-coded project model/field 없음
- generated output은 source와 일치
- unused old Query Builder DOM/CSS 제거
- dead compatibility adapter 제거
- console log/debug marker 제거
- user data/Recipe를 webview persistence에 저장하지 않음

### 31.6 Phase 10 exit gate

- `npm run check` 성공
- source guideline 성공
- full diff audit 완료
- automated acceptance matrix 성공

---

## 32. Phase 11 — 실제 `rtcc-poc-page` 통합 검증

### 32.1 절대 명령 규칙

VS Code의 `rtcc-poc-page` workspace integrated terminal을 사용한다.

working directory:

```text
/Users/lky/project/rtcc-poc-page
```

가상 네트워크 접속 명령은 정확히 다음이다.

```sh
pm 5
```

`pm`과 `5` 사이에 공백이 반드시 있다.

다음은 금지한다.

- `pm5`
- `pm-5`
- 다른 network number

network 준비가 완료된 뒤 Django shell은 정확히 다음으로 실행한다.

```sh
./zz django shell
```

다음은 금지한다.

- `./zz shell`
- `./zz django-shell`
- `./zz django_shell`

두 명령을 한 줄로 합치지 않는다.

올바른 순서:

1. 새 integrated terminal 열기
2. terminal cwd가 `/Users/lky/project/rtcc-poc-page`인지 확인
3. `pm 5`
4. network 준비/프롬프트 상태 확인
5. `./zz django shell`
6. Django shell 초기화 완료 확인

### 32.2 extension 준비

실제 검증 전에:

- django-shell repository build 성공
- 필요한 extension artifact 갱신
- 현재 개발 extension을 VS Code Extension Development Host 또는 사용 중인 검증 설치 방식으로 로드
- `rtcc-poc-page` workspace가 열린 창에서 실행

어떤 창을 검증했는지 window title로 확인한다.

### 32.3 Model Data 초기 상태

Django shell에서:

- `db.Company` Model Data open
- Link: ORM
- grid rows loaded
- Query Builder closed

확인:

- summary band가 grid를 가리지 않음
- clean state `Applied`
- drawer closed Apply는 clean이므로 disabled

### 32.4 실제 end-to-end Recipe

다음 Recipe를 UI만 사용해 조립한다.

#### Stage 1 — Filter Rows

조건:

```text
id is greater than or equal to 1
```

절차:

1. `Filter Rows`
2. `Add condition`
3. field picker에서 `id`
4. comparison `Is greater than or equal to`
5. Compare With `A value`
6. value `1`

확인:

- add 뒤 field focus
- field 선택 뒤 comparison focus
- typing 중 focus/caret 유지
- stage badge 1
- draft `Draft changed`

#### Stage 2 — Calculated Values

item:

```text
Name: latest_valuation_id
Type: Scalar subquery
Source relation: valuation_history_set
Returned value: id
Row choice: id descending
```

관계 metadata에서 표시 label이 다르더라도 path `valuation_history_set`을 검색한다.

절차:

1. `Calculated Values`
2. Type `Scalar subquery`
3. `Add calculated value`
4. Name `latest_valuation_id`
5. Source에서 relation `valuation_history_set`
6. 자동 connection summary 확인
7. Target filter는 비워 둠
8. Returned Value `id`
9. Row Choice field `id`
10. direction `Descending`
11. Output inferred type 확인

확인:

- 여섯 fieldset
- relation 선택 뒤 next control focus
- item open 상태 유지
- raw path typing 불필요
- stage badge 1
- Meaning에 actual `<code>` styling

relation source가 실제 metadata에서 다른 canonical reverse name으로 반환되면:

- search result에서 path가 `valuation_history_set`인 option만 선택
- 해당 option이 존재하지 않으면 구현 defect로 단정하지 말고 metadata response와 Django model relation name을 기록
- test fixture 결과와 실제 metadata 불일치를 별도 integration finding으로 남김
- 임의의 다른 relation으로 성공을 꾸미지 않음

#### Stage 3 — Filter Results

조건:

```text
latest_valuation_id is not null
```

절차:

1. `Filter Results`
2. `Add condition`
3. calculated reference `latest_valuation_id`
4. comparison `Is not empty / null`

확인:

- computed reference가 별도 그룹/label로 표시
- value input 없음
- stage badge 1

#### Stage 4 — Result

설정:

```text
Mode: Rows
Order 1: latest_valuation_id descending
Order 2: id ascending
```

확인:

- computed/direct option 구분
- 두 order의 순서 이동
- default/custom meaning

#### Review

Meaning:

- 네 단계 summary
- alias/path code rendering
- active Link가 ORM으로 표시

Problems:

- latest host validation 후 error 없음
- warning이 있으면 설명/fix visible

Django ORM:

- status `Latest validated draft`
- ORM visible
- Copy success feedback

#### Apply

확인:

- drawer open 시 Apply 하나
- latest validation 완료 전 disabled
- valid 후 enabled
- Apply → Applying
- success → Loading results
- matching grid rows
- grid가 새 결과로 바뀌기 전 이전 rows가 사라져 빈 화면이 되지 않음
- applied 후 clean

### 32.5 오류 회복 시나리오

scalar subquery Returned Value의 `id`를 제거한다.

확인:

- local 또는 host error
- Calculated Values tab error badge
- Apply disabled
- footer exact reason
- Problems에 title/explanation/fix
- `Go to field`
- editor pane으로 전환
- item과 ancestor open
- Returned Value picker focus

field를 다시 선택한다.

확인:

- background validation
- Problems가 강제로 다시 열리지 않음
- current editor focus 유지
- valid 후 Apply 가능

### 32.6 Undo/Redo 시나리오

1. alias에 `_copy`를 연속 입력
2. header Undo
3. 전체 연속 typing이 한 번에 취소
4. Redo
5. computed item duplicate
6. Undo
7. Clear Draft
8. Undo

확인:

- draft/applied 분리
- grid는 Apply 전 변하지 않음
- focus target 유지
- Clear 안내 `Undo is available`

### 32.7 drawer/responsive 시나리오

실제 VS Code UI에서:

- resize handle pointer drag
- keyboard resize
- minimum
- larger height
- Focus Builder
- Show Grid
- close/reopen

확인:

- grid scroll/selection 복원
- footer overlap 없음
- stage/scroll/open state 유지

VS Code editor group 폭을 조절해:

- wide
- medium
- narrow

상태를 확인한다.

정확한 category는 webview Query Builder root 실제 width로 확인한다.

### 32.8 keyboard-only 실제 시나리오

mouse를 사용하지 않고:

- drawer 열기
- stage 변경
- condition 추가
- picker 검색
- option 선택
- computed item 추가
- Review
- issue 이동
- Undo/Redo
- Apply
- Focus Builder 종료
- drawer 닫기

focus가 사라지거나 body/grid의 예측 불가 위치로 이동하면 failure다.

### 32.9 theme/zoom 실제 시나리오

한 번에 하나씩:

- Dark+
- Light+
- High Contrast
- 200% zoom

각 상태에서 최소:

- comparison
- expanded scalar subquery
- Problems error
- open popup
- focus ring
- disabled Apply

스크린샷을 남긴다.

### 32.10 실제 검증 중 금지

- 데이터 edit/commit
- destructive queryset action
- production data mutation
- raw Python으로 UI 결과를 보정
- 명령 축약
- 다른 shell/network로 대체
- 실패 상태를 숨기기 위한 hard-coded metadata

### 32.11 Phase 11 exit gate

- exact `pm 5`
- exact `./zz django shell`
- `db.Company` Model Data
- complete four-stage Recipe
- validation/ORM/Apply/grid refresh
- error recovery
- Undo/Redo
- resize/focus mode
- keyboard-only
- theme/zoom
- 실제 스크린샷 및 observation 기록

---

## 33. 테스트 파일 전체 목록

최종적으로 다음 test coverage가 있어야 한다.

### 33.1 store/state

- `test/gridQueryRecipeStore.test.mjs`
- `test/gridQueryRecipeReducer.test.mjs`
- `test/gridQueryHistory.test.mjs`
- `test/gridQueryUiState.test.mjs`

### 33.2 render/focus

- `test/gridQueryRenderCoordinator.test.mjs`
- `test/gridQueryFocus.test.mjs`
- `test/modelQueryDomHarness.test.mjs`

### 33.3 workspace

- `test/gridQueryWorkspace.test.mjs`
- `test/gridQueryStageNav.test.mjs`
- `test/gridQueryStageSelectors.test.mjs`
- `test/gridQueryDrawerResize.test.mjs`
- `test/gridQueryWorkspaceAccessibility.test.mjs`

### 33.4 validation/review

- `test/gridQueryLifecycle.test.mjs`
- `test/gridQueryInspector.test.mjs`
- `test/gridQueryIssueTarget.test.mjs`

### 33.5 controls

- `test/gridQueryPopover.test.mjs`
- `test/gridCombobox.test.mjs`
- `test/gridQueryFieldPicker.test.mjs`
- `test/gridQueryScalarEditor.test.mjs`
- `test/gridPredicateGroupView.test.mjs`
- `test/gridPredicateComparisonView.test.mjs`
- `test/gridPredicateExistsView.test.mjs`
- `test/gridComputedBuilder.test.mjs`
- `test/gridAggregateBuilder.test.mjs`
- `test/gridSubqueryBuilder.test.mjs`
- `test/gridQueryResultControls.test.mjs`
- `test/gridQueryStableListKeys.test.mjs`

이 절의 파일명을 그대로 사용한다.

동일 개념 test가 이미 존재하면 새 파일을 만들지 않는다. 기존 test 파일에 해당 case를 추가하고 §33 체크리스트에 실제 위치를 함께 기록한다.

test coverage 항목과 모듈 책임은 줄이지 않는다.

---

## 34. 기능 acceptance matrix

### 34.1 draft/apply

- [ ] drawer를 닫아도 draft 유지
- [ ] clean이면 Apply disabled
- [ ] warning만 있으면 Apply enabled
- [ ] stale validation이면 Apply disabled
- [ ] Apply 중 newer draft 가능
- [ ] Apply success가 newer draft를 덮지 않음
- [ ] matching result 전 이전 grid 유지
- [ ] visible Apply 정확히 하나

### 34.2 focus/state

- [ ] alias typing 중 DOM identity 유지
- [ ] caret/selection 유지
- [ ] computed disclosure 유지
- [ ] predicate disclosure 유지
- [ ] stage scroll 유지
- [ ] inspector scroll 유지
- [ ] structural focus 표 전부 구현
- [ ] issue exact focus
- [ ] close/reopen state 유지

### 34.3 navigation

- [ ] 네 stage
- [ ] Review는 별도 inspector
- [ ] tabs keyboard
- [ ] narrow stage select
- [ ] medium editor/review swap
- [ ] wide side-by-side
- [ ] skip links
- [ ] Escape 우선순위

### 34.4 picker

- [ ] visible label
- [ ] breadcrumb
- [ ] full path
- [ ] type/help
- [ ] 60개 bounded
- [ ] search status
- [ ] keyboard 완전 조작
- [ ] popup 위/아래 판단
- [ ] clipping 없음
- [ ] metadata retry
- [ ] dispose/listener cleanup

### 34.5 predicate

- [ ] visible Field/Comparison/Compare With/Value
- [ ] type lookup
- [ ] group join 2개 이상일 때만
- [ ] nested group disclosure
- [ ] related-row check
- [ ] Codicon actions
- [ ] no Unicode broken icon
- [ ] inline error/fix

### 34.6 computed

- [ ] persistent item
- [ ] alias/type/enabled
- [ ] kind change confirmation
- [ ] Formula
- [ ] Aggregate metadata picker
- [ ] Scalar subquery 6 fieldsets
- [ ] Returned Value picker
- [ ] Row Choice picker
- [ ] all existing kinds
- [ ] Undo full type conversion

### 34.7 Result

- [ ] Rows/Summary
- [ ] groupBy picker
- [ ] order picker
- [ ] direct/computed groups
- [ ] destructive mode confirmation
- [ ] limit reason

### 34.8 Review

- [ ] stage pipeline meaning
- [ ] actual `<code>`
- [ ] selected node detail
- [ ] visible explanation/fix
- [ ] technical details
- [ ] stale ORM label
- [ ] copy success/failure
- [ ] background error does not steal pane/focus

### 34.9 accessibility/visual

- [ ] labels
- [ ] accessible names
- [ ] visible focus
- [ ] high contrast
- [ ] reduced motion
- [ ] no color-only state
- [ ] 200% zoom
- [ ] long text
- [ ] loading/empty/error/success/disabled
- [ ] dark/light/high contrast

---

## 35. 비기능 acceptance

### 35.1 성능

- [ ] keystroke당 render flush 최대 1
- [ ] signature가 같은 region은 update하지 않음
- [ ] option DOM 최대 61 수준: pinned 포함 시 예외를 test에 명시
- [ ] rAF reposition frame당 1
- [ ] listener leak 없음
- [ ] builder root identity 유지

### 35.2 보안과 데이터

- [ ] metadata allowlist 유지
- [ ] Recipe limit 유지
- [ ] host validator authority 유지
- [ ] user text는 textContent
- [ ] raw HTML injection 없음
- [ ] persistence에 Recipe literal 없음
- [ ] clipboard는 ORM text만
- [ ] Focus mode는 grid를 삭제하지 않음

### 35.3 유지보수성

- [ ] code file 1000줄 이하
- [ ] first-line summary
- [ ] function/class summary
- [ ] controller orchestration 전용
- [ ] generic combobox에 Recipe semantics 없음
- [ ] issue target 순수 함수
- [ ] no dead adapter
- [ ] `npm run check`

---

## 36. 고정 UI 문구 사전

구현자는 아래 문구를 기본값으로 사용한다.

i18n resource가 현재 제품에 있으면 동일 English source를 resource에 등록하고 localization pipeline을 따른다.

### 36.1 shell

| key | text |
|---|---|
| title | `Query Builder` |
| open | `Open Query Builder` |
| close | `Close Query Builder` |
| focus | `Focus Builder` |
| showGrid | `Show Grid` |
| reset | `Reset to Applied` |
| clear | `Clear Draft` |
| undo | `Undo query edit` |
| redo | `Redo query edit` |
| apply | `Apply query` |
| safety | `Draft changes do not affect the grid until Apply succeeds.` |

### 36.2 stage

| ID | label | intro |
|---|---|---|
| filterRows | `Filter Rows` | `Keep only source rows that match these conditions before calculated values are created.` |
| calculatedValues | `Calculated Values` | `Create values that can be displayed, ordered, grouped, or filtered in later stages.` |
| filterResults | `Filter Results` | `Filter the final values after calculated values are available.` |
| result | `Result` | `Choose whether the grid returns individual rows or summary rows, then set grouping and order.` |

### 36.3 review

| key | text |
|---|---|
| review | `Review` |
| meaning | `Meaning` |
| problems | `Problems` |
| orm | `Django ORM` |
| noSelection | `Select a condition or calculated value to inspect its meaning.` |
| noProblems | `No problems in the latest validated draft.` |
| previousOrm | `Previous validated preview — checking the latest draft.` |
| noOrm | `Django ORM will appear after the current draft passes validation.` |
| copy | `Copy Django ORM` |
| copySuccess | `Django ORM copied.` |
| copyFailure | `Could not copy automatically. Select the ORM preview and copy it manually.` |

### 36.4 lifecycle

| state | text |
|---|---|
| applied | `Applied` |
| changed | `Draft changed` |
| pending | `Draft changed. Validation will start when typing pauses.` |
| checking | `Checking the latest draft…` |
| ready | `Ready to apply.` |
| applying | `Applying…` |
| loading | `Loading results…` |
| appliedLoading | `Query applied. Loading results…` |
| loaded | `Query applied. Results loaded.` |
| rejected | `Query was not applied. Fix the reported errors.` |

### 36.5 predicate

| key | text |
|---|---|
| addCondition | `Add condition` |
| addGroup | `Add group` |
| addRelated | `Add related-row check` |
| field | `Field` |
| comparison | `Comparison` |
| compareWith | `Compare With` |
| value | `Value` |
| all | `All` |
| any | `Any` |
| negate | `Negate this condition` |
| duplicate | `Duplicate` |
| moveUp | `Move up` |
| moveDown | `Move down` |
| delete | `Delete` |

### 36.6 computed/subquery

| key | text |
|---|---|
| addComputed | `Add calculated value` |
| name | `Name` |
| type | `Type` |
| enabled | `Include this calculated value` |
| subquerySource | `1. Source` |
| subqueryConnect | `2. Connect Rows` |
| subqueryFilter | `3. Filter Target Rows` |
| subqueryReturn | `4. Returned Value` |
| subqueryOrder | `5. Row Choice` |
| subqueryOutput | `6. Output` |

### 36.7 Result

| key | text |
|---|---|
| shape | `Result shape` |
| rows | `Rows` |
| summary | `Summary` |
| addGroupField | `Add group field` |
| addOrder | `Add order` |
| orderBy | `Order by` |
| ascending | `Ascending` |
| descending | `Descending` |

문구에 issue-specific field/model/alias를 넣을 때 text node로 조립한다.

문자열 interpolation 결과를 `innerHTML`에 넣지 않는다.

---

## 37. control key 사전

구현 시 다음 role 이름을 그대로 사용한다.

### 37.1 shell

- `shell:undo`
- `shell:redo`
- `shell:focus-mode`
- `shell:more`
- `shell:close`
- `shell:apply`

### 37.2 stage

- `stage:filterRows`
- `stage:calculatedValues`
- `stage:filterResults`
- `stage:result`
- `stage:review`

### 37.3 group

- `<groupId>:summary`
- `<groupId>:join-all`
- `<groupId>:join-any`
- `<groupId>:negated`
- `<groupId>:add-condition`
- `<groupId>:add-group`
- `<groupId>:add-related`
- `<groupId>:duplicate`
- `<groupId>:move-up`
- `<groupId>:move-down`
- `<groupId>:delete`

### 37.4 comparison

- `<nodeId>:field`
- `<nodeId>:lookup`
- `<nodeId>:rhs-kind`
- `<nodeId>:value`
- `<nodeId>:rhs-field`
- `<nodeId>:rhs-computed`
- `<nodeId>:negated`
- `<nodeId>:duplicate`
- `<nodeId>:move-up`
- `<nodeId>:move-down`
- `<nodeId>:delete`

### 37.5 computed

- `<nodeId>:summary`
- `<nodeId>:enabled`
- `<nodeId>:alias`
- `<nodeId>:kind`
- `<nodeId>:confirm-kind`
- `<nodeId>:cancel-kind`
- `<nodeId>:duplicate`
- `<nodeId>:move-up`
- `<nodeId>:move-down`
- `<nodeId>:delete`

kind-specific role은 Recipe property path를 kebab-case로 쓴다.

예:

- `<nodeId>:source-relation`
- `<nodeId>:correlation-<correlationId>-outer`
- `<nodeId>:correlation-<correlationId>-inner`
- `<nodeId>:selected-field`
- `<nodeId>:order-<orderId>-field`
- `<nodeId>:order-<orderId>-direction`
- `<nodeId>:output-type`

### 37.6 Result

- `result:mode-rows`
- `result:mode-summary`
- `groupBy:<stableUiId>:field`
- `groupBy:<stableUiId>:remove`
- `<orderNodeId>:reference`
- `<orderNodeId>:direction`
- `<orderNodeId>:move-up`
- `<orderNodeId>:move-down`
- `<orderNodeId>:remove`
- `result:add-group`
- `result:add-order`

control key는 CSS selector escaping이 필요한 문자를 포함하지 않는다.

Recipe path를 key에 직접 넣을 때는 stable safe encoder를 사용한다.

---

## 38. issue-to-control 매핑 사전

구현자는 known issue code inventory를 실제 source에서 추출한 뒤 다음 기본 path mapping을 적용한다.

| Recipe path suffix | control role |
|---|---|
| `.lhs.path` | `field` |
| `.lookup` | `lookup` |
| `.rhs.kind` | `rhs-kind` |
| `.rhs.value` | `value` |
| `.rhs.path` | `rhs-field` |
| `.rhs.alias` | `rhs-computed` |
| `.alias` | `alias` |
| `.kind` | `kind` |
| `.enabled` | `enabled` |
| `.source.relation` | `source-relation` |
| `.source.model` | `source-model` |
| `.correlations[n].outer.path` | `correlation-<id>-outer` |
| `.correlations[n].inner.path` | `correlation-<id>-inner` |
| `.select.path` 또는 실제 selected path | `selected-field` |
| `.orderBy[n].ref` | `order-<id>-field` 또는 `reference` |
| `.orderBy[n].direction` | `direction` |
| `.outputType` | `output-type` |
| `.groupBy[n]` | groupBy picker |
| `.mode` | `result:mode-summary` 또는 rows |

배열 index를 stable key로 직접 쓰지 않는다.

nodeId 또는 UI adapter stable ID로 변환한다.

알 수 없는 suffix:

- 가장 가까운 node summary

node도 알 수 없음:

- stage tab

stage도 알 수 없음:

- Problems heading

---

## 39. Render signature와 mutation 불변식

### 39.1 불변식

다음은 test로 강제한다.

1. UI state action은 Recipe revision을 바꾸지 않는다.
2. validation action은 draft revision을 바꾸지 않는다.
3. Recipe action은 UI disclosure state를 초기화하지 않는다.
4. 동일 Recipe no-op action은 revision/history/render signature를 바꾸지 않는다.
5. current stage 외 Recipe 변경도 해당 stage DOM만 갱신한다. summary/footer/review는 필요한 projection만 갱신한다.
6. validation-only update는 text input element를 교체하지 않는다.
7. metadata-only update는 열린 popup 또는 해당 picker만 갱신한다.
8. stale response는 signature를 바꾸지 않는다.
9. source 변경만 모든 stage builder scope를 reset한다.

### 39.2 render reason

debug/test reason enum:

- `recipe`
- `ui`
- `metadata`
- `validation`
- `lifecycle`
- `source`
- `layout`

production에서 화면에 노출하지 않는다.

test는 coalesced reason set을 검사할 수 있다.

### 39.3 render transaction

flush 중 store/UI update가 발생하면:

- current flush model을 변형하지 않음
- 다음 microtask flush를 예약
- recursive synchronous render 금지

최대 flush loop guard를 둘 수 있다.

guard 초과는 test/dev에서 명확한 error를 내고 production에서는 무한 loop를 만들지 않는다.

---

## 40. 위험과 완화책

### 40.1 위험 — persistent keyed DOM이 stale value를 남김

완화:

- 모든 renderer에 explicit update contract
- input/value/disabled/aria/error update test
- node removal 시 destroy
- source generation guard

### 40.2 위험 — focus restore가 사용자 scroll을 되돌림

완화:

- 일반 update는 `preventScroll`
- explicit navigation만 `scrollIntoView`
- capture한 scroll은 DOM mutation으로 실제 값이 변한 경우에만 복원
- pointer scroll 중 layout-only render는 focus restore하되 scroll write 생략

### 40.3 위험 — history memory

완화:

- 50 snapshot
- JSON Recipe bounded by existing limit
- source change clear
- validation/ORM 제외

### 40.4 위험 — popup portal과 webview z-index 충돌

완화:

- root-level dedicated layer
- existing Model Data popup/log layer inventory
- semantic VS Code widget z-index 관례 재사용
- actual grid/header overlap visual test

### 40.5 위험 — Focus Builder가 grid state를 잃음

완화:

- DOM destroy가 아니라 hidden/inert
- enter 전 state capture
- exit exact restore
- Apply 결과가 도착해도 grid component identity 유지

### 40.6 위험 — medium/narrow hidden pane의 focus

완화:

- `hidden` + `inert`
- pane switch 전에 focus destination 계산
- automated focusable-in-hidden assertion

### 40.7 위험 — local과 host issue 중복

완화:

- normalized merge key
- host authority
- single Problems item
- announcement signature dedupe

### 40.8 위험 — old tests가 markup string에 과결합

완화:

- behavior/semantic contract test로 교체
- 단순 source string assertion은 security/load order처럼 필요한 경우만 유지
- 실제 DOM identity/focus test 추가

### 40.9 위험 — 실제 model metadata 차이

완화:

- production hardcode 금지
- test fixture는 general schema
- actual integration mismatch를 metadata/extension/backend 중 어느 layer인지 기록
- UI에서 allowlisted response만 사용

---

## 41. 구현자가 판단하지 말아야 할 항목

다음 질문의 답은 이미 고정되어 있다.

| 질문 | 답 |
|---|---|
| 새 페이지인가? | 아니다. 기존 Model Data 안의 drawer/workspace다. |
| wizard인가? | 아니다. 네 개의 non-linear stage다. |
| Review는 stage인가? | 아니다. inspector다. |
| wide에서 Review 위치는? | editor 오른쪽 320~380px다. |
| medium/narrow에서 Review는? | editor와 swap한다. |
| inactive stage는 destroy하는가? | 아니다. hidden+inert로 유지한다. |
| Apply는 몇 개인가? | 사용자-visible primary는 정확히 하나다. |
| drawer 높이는? | user resizable, persisted, min 220px, grid min 144px다. |
| grid를 완전히 가릴 수 있는가? | 명시적 Focus Builder mode에서만 가능하다. |
| Focus mode를 reload 후 복원하는가? | 아니다. |
| Recipe를 webview state에 저장하는가? | 아니다. |
| Undo history 크기는? | 50이다. |
| text coalescing은? | 동일 control 600ms, blur/action에서 종료다. |
| preview debounce는? | text 400ms, structural/change/blur 즉시다. |
| stale ORM은 지우는가? | 아니다. 이전 preview로 명시하고 Copy를 막는다. |
| background error가 Problems를 여는가? | 아니다. |
| Apply reject는 Problems를 여는가? | 그렇다. 첫 error에 focus한다. |
| option은 몇 개 렌더하는가? | 최대 60, selected pinned 예외를 명시한다. |
| popup은 어디에 mount하는가? | root `queryPopoverLayer`다. |
| scalar subquery UI는? | 여섯 numbered fieldset이다. |
| raw relation/path input은? | metadata picker로 교체한다. |
| type 변경은? | non-empty item에서 inline confirm 후 한 action이다. |
| drag reorder는? | 이번 범위에 없다. Up/Down keyboard button이다. |
| UI framework를 도입하는가? | 아니다. 현재 vanilla DOM architecture다. |
| 색/폰트를 새로 만드는가? | 아니다. VS Code semantic token을 쓴다. |

---

## 42. Terra High 실행 체크리스트

### 42.1 시작

- [ ] `AGENTS.md`, `DESIGN.md`, `PRODUCT.md` 다시 읽기
- [ ] current worktree 기록
- [ ] relevant source/test inventory
- [ ] baseline `npm run check`
- [ ] Phase 0 characterization

### 42.2 foundation

- [ ] coalesced coordinator
- [ ] persistent builder
- [ ] stable key
- [ ] focus/caret/scroll
- [ ] live dedupe
- [ ] Phase 1 gate

### 42.3 state/history

- [ ] history 50
- [ ] text 600ms
- [ ] Undo/Redo
- [ ] UI store
- [ ] safe persistence
- [ ] Phase 2 gate

### 42.4 shell

- [ ] new semantic HTML
- [ ] resize
- [ ] header
- [ ] stage nav
- [ ] editor/Review workspace
- [ ] footer/one Apply
- [ ] Focus Builder
- [ ] Phase 3 gate

### 42.5 review/lifecycle

- [ ] lifecycle reducer
- [ ] local/host issue normalize
- [ ] Meaning rich token
- [ ] Problems
- [ ] ORM freshness/copy
- [ ] issue focus
- [ ] Phase 4 gate

### 42.6 controls

- [ ] popover layer
- [ ] combobox 60
- [ ] field picker
- [ ] metadata guard
- [ ] disposal
- [ ] Phase 5 gate

### 42.7 stages

- [ ] Filter Rows
- [ ] Filter Results
- [ ] Calculated Values
- [ ] Scalar subquery 6 fieldset
- [ ] Result
- [ ] Phase 6~8 gates

### 42.8 polish

- [ ] responsive matrix
- [ ] keyboard
- [ ] accessibility
- [ ] theme
- [ ] zoom
- [ ] long text/states
- [ ] performance
- [ ] Phase 9 gate

### 42.9 finish

- [ ] all tests
- [ ] code line/JSDoc/first-line audit
- [ ] `npm run check`
- [ ] final diff audit
- [ ] exact `pm 5`
- [ ] exact `./zz django shell`
- [ ] actual `db.Company` scenario
- [ ] screenshots/observations
- [ ] all acceptance items

---

## 43. 최종 산출물

구현 완료 시 남겨야 할 결과:

1. Query Builder source modules
2. Query Builder CSS modules
3. updated semantic HTML mount
4. full unit/DOM tests
5. build output if repository convention requires tracking
6. actual integration QA record
7. screenshots:
   - wide normal
   - medium editor
   - medium Review
   - narrow
   - Focus Builder
   - Problems error
   - scalar subquery
   - high contrast
   - 200% zoom
8. final `npm run check` result
9. known limitation이 남았다면 acceptance item과 직접 연결한 명시적 기록

“구현 완료” 보고는 다음 형식으로 작성한다.

```text
Outcome
- 어떤 사용자 문제를 해결했는지

Implementation
- phase별 핵심 변경

Verification
- automated command와 결과
- actual rtcc-poc-page flow와 결과
- viewports/themes/interactions

Remaining limitations
- 없으면 `None`
- 있으면 미완료 acceptance ID와 이유
```

acceptance가 하나라도 빠졌으면 `완료`라고 보고하지 않는다.

---

## 44. 최종 Definition of Done

이 계획은 다음 최종 문장이 모두 참일 때만 끝난다.

- 사용자는 Query Builder에서 한 글자를 입력할 때 item이 접히거나 focus를 잃지 않는다.
- 사용자는 Filter Rows, Calculated Values, Filter Results, Result를 긴 단일 문서 왕복 없이 이동한다.
- 사용자는 현재 Recipe의 의미, 문제, Django ORM을 같은 workspace에서 검토한다.
- 사용자는 metadata picker로 관계와 field를 선택하고 raw path를 외우지 않는다.
- 사용자는 scalar subquery를 Source, Connect Rows, Filter Target Rows, Returned Value, Row Choice, Output 순서로 이해하고 조립한다.
- 사용자는 실수를 Undo하고 Apply 전까지 grid가 변하지 않음을 신뢰한다.
- 사용자는 Apply가 왜 비활성인지 화면에서 읽을 수 있다.
- 사용자는 오래된 ORM preview를 최신 preview로 오인하지 않는다.
- 사용자는 keyboard만으로 모든 기능을 수행한다.
- 사용자는 dark, light, high contrast, 200% zoom에서 같은 기능을 사용할 수 있다.
- 기존 Recipe/compiler/transport/safety semantics는 변하지 않는다.
- 실제 `rtcc-poc-page`에서 `pm 5` 후 `./zz django shell`로 검증된다.
- `npm run check`가 성공한다.
