# Model Data Query Builder 친절한 설명·가이드 구현 계획

> 상태: 구현 대기
>
> 대상 저장소: `/Users/lky/project/django-shell`
>
> 기준 기능: `ModelQueryRecipeV2` Query Builder
>
> 구현 모델 권장 수준: Terra High
>
> 문서 목적: 구현자가 추가 UX 설계나 제품 판단을 하지 않고, 이 문서의 순서와 계약만으로 작업을 완료하게 한다.

---

## 0. 이 문서를 사용하는 방법

이 문서는 기존 Query Builder를 다시 설계하는 문서가 아니다. 이미 구현된 Recipe V2, draft/applied 상태, validation, ORM preview, backend transport 계약을 그대로 유지하면서 다음 문제만 해결한다.

1. 사용자가 각 영역이 무엇을 하는지 바로 이해하기 어렵다.
2. 필드, lookup, RHS 종류, computed kind, correlation 같은 기술 용어가 설명 없이 노출된다.
3. 불완전한 node가 “다음에 무엇을 선택해야 하는지” 알려 주지 않는다.
4. validation issue가 기계적인 문구로 보이고, 문제의 이유와 해결 순서가 충분히 드러나지 않는다.
5. 고급 기능은 가능하지만 사용자가 적절한 기능을 선택하기 어렵다.
6. 관계 경로, subquery field, correlation 일부가 검색형 picker 대신 기술적인 직접 입력에 의존한다.
7. Result mode, group by, order by의 의미가 사용자의 결과 형태와 연결되어 설명되지 않는다.

구현자는 아래 규칙을 지킨다.

- Phase 순서를 바꾸지 않는다.
- 이 문서에서 지정한 파일명, DOM ID, CSS class, UI 문구, 상태 전이를 임의로 바꾸지 않는다.
- 새로운 Recipe version을 만들지 않는다.
- query 실행 의미론, compiler 순서, validation 상한, transport 지원 행렬을 바꾸지 않는다.
- 새 외부 dependency를 추가하지 않는다.
- 새 디자인 시스템을 만들지 않는다.
- 기존 VS Code semantic token과 `DESIGN.md`의 밀도·형태 규칙을 사용한다.
- 기존 사용자 변경을 보존한다.
- 소스 코드 파일은 1000줄 이하를 유지한다.
- 모든 코드 파일 첫 줄에 목적 요약 주석을 둔다.
- 모든 class/function/method에 JSDoc 또는 docstring 요약을 둔다.
- 구현 후 `npm run check`를 실행한다.

### 0.1 구현 전 필수 읽기

다음 파일을 먼저 읽고 이 문서와 충돌하는 것처럼 보이는 부분이 있으면 아래 우선순위를 적용한다.

1. 사용자 요청
2. 저장소 `AGENTS.md`
3. 이 문서의 “비타협 결정”
4. `DESIGN.md`
5. `PRODUCT.md`
6. 기존 `MODEL_DATA_QUERY_BUILDER_IMPLEMENTATION_PLAN.md`
7. 현재 코드

필수 기준 파일:

- `AGENTS.md`
- `DESIGN.md`
- `PRODUCT.md`
- `MODEL_DATA_QUERY_BUILDER_IMPLEMENTATION_PLAN.md`
- `src/modelBrowserHtml.ts`
- `src/modelQueryRecipe.ts`
- `src/modelQueryRecipeValidation.ts`
- `src/modelQueryRecipeLimits.ts`
- `src/modelBackend.ts`
- `media/gridQueryController.js`
- `media/gridQuerySummary.js`
- `media/gridQueryValidationView.js`
- `media/gridQueryMetadata.js`
- `media/gridPredicateBuilder.js`
- `media/gridPredicateValue.js`
- `media/gridComputedBuilder.js`
- `media/gridAggregateBuilder.js`
- `media/gridSubqueryBuilder.js`
- `media/gridFormulaBuilder.js`
- `media/gridWindowBuilder.js`
- `media/gridCodeExpressionBuilder.js`
- `media/gridQueryResultBuilder.js`
- `media/gridCombobox.js`
- `media/modelQueryBuilder.css`

### 0.2 비타협 결정

| ID | 결정 |
|---|---|
| G-01 | Recipe schema는 `ModelQueryRecipeV2`를 그대로 사용한다. |
| G-02 | 설명은 query를 실행하거나 Recipe를 자동 수정하지 않는다. |
| G-03 | 설명을 위해 사용자의 입력을 조용히 정규화하거나 삭제하지 않는다. |
| G-04 | 기본 경로는 짧은 설명을 항상 표시하고, 긴 개념 설명은 native `<details>`로 접는다. |
| G-05 | 전역 튜토리얼, coach mark, modal onboarding, 단계 강제 wizard는 만들지 않는다. |
| G-06 | 사용자는 기존처럼 어느 section부터든 편집할 수 있다. |
| G-07 | 도움말은 hover에만 두지 않는다. 필수 의미는 화면과 `aria-describedby`에 존재한다. |
| G-08 | 전문 용어를 없애지 않는다. 평문을 먼저 쓰고 기술 용어를 괄호 안에 병기한다. |
| G-09 | UI 문구는 현재 제품 언어에 맞춰 영어로 작성한다. 이 문서는 한국어로 작성한다. |
| G-10 | 이번 범위에서 다국어 시스템을 새로 만들지 않는다. |
| G-11 | 사용자 모델의 `verbose_name`과 `help_text`는 선택적 보조 정보로만 사용한다. 없다고 기능이 감소하지 않는다. |
| G-12 | `help_text`는 HTML로 렌더링하지 않고 bounded plain text로만 전달한다. |
| G-13 | 복잡한 필드 선택은 기존 `gridCombobox.js`를 확장·재사용한 검색형 picker를 사용한다. |
| G-14 | relation traversal은 segment picker로 조립하며 사용자가 `author__profile__name`을 직접 입력하게 하지 않는다. |
| G-15 | 기존 invalid path는 자동 삭제하지 않고 “Unavailable field” 상태로 보존한다. |
| G-16 | error는 cause와 fix를 함께 표시하고, warning은 영향과 선택 가능한 대응을 표시한다. |
| G-17 | helper text의 변화는 live region으로 계속 읽지 않는다. error, apply, backend 상태만 기존 live region을 사용한다. |
| G-18 | 설명 때문에 summary band 또는 grid의 세로 공간을 과도하게 늘리지 않는다. 자세한 설명은 drawer 내부에만 둔다. |
| G-19 | summary band의 `Apply query`는 계속 유일한 상위 primary action이다. |
| G-20 | drawer footer의 `Apply query`는 같은 controller action을 호출한다. |
| G-21 | preview는 “Plain meaning → implicit behavior → Django ORM” 순서로 보여 준다. |
| G-22 | validation issue protocol의 `code`, `message`, `fix`, `path`, `nodeId`, `severity` shape는 바꾸지 않는다. |
| G-23 | UI가 알지 못하는 새 issue code도 안전한 fallback 문구로 표시한다. |
| G-24 | Result builder의 누락된 group-by/order UI 연결은 기존 Recipe 계약대로 완성한다. 새 의미론을 만들지 않는다. |
| G-25 | 기존 Query Builder의 구조적 move/duplicate/remove button과 keyboard shortcut을 유지한다. |
| G-26 | 설명 문구에 “easy”, “simple”, “obvious”, “just” 같은 사용자를 평가하는 표현을 쓰지 않는다. |
| G-27 | DB write, Commit, related-row edit는 이 계획의 범위가 아니다. |
| G-28 | Query Log와 ORM preview에 새 민감 데이터를 추가하지 않는다. |

---

## 1. 목표와 완료 정의

### 1.1 제품 목표

사용자가 Django ORM의 모든 세부 문법을 외우지 않아도 다음 질문에 UI 안에서 답을 얻어야 한다.

1. 이 section은 query의 어느 단계에 영향을 주는가?
2. 지금 선택하는 값은 무엇을 의미하는가?
3. 현재 조립한 node는 평문으로 어떤 뜻인가?
4. 아직 완성되지 않았다면 다음에 무엇을 선택해야 하는가?
5. 이 warning 또는 error가 결과에 어떤 영향을 주는가?
6. 어떻게 수정하면 Apply할 수 있는가?
7. Apply 전과 후의 grid가 각각 어떤 Recipe를 반영하는가?
8. Rows와 Summary 중 어떤 mode가 목적에 맞는가?
9. Aggregate, Formula, Subquery, Exists, Window 중 무엇을 선택해야 하는가?
10. relation correlation이 현재 row와 target row를 어떻게 연결하는가?

### 1.2 대표 사용자 시나리오

#### 시나리오 A: 첫 필터

사용자는 빈 WHERE 영역을 연다.

- 화면은 “No source-row filter. Applying now would load every row.”를 표시한다.
- `Add condition`을 누르면 새 row가 생성되고 field picker가 focus된다.
- field를 고르면 lookup 설명이 바뀐다.
- lookup을 고르면 value editor와 다음 단계 문구가 나타난다.
- 완성되면 다음 문장을 표시한다.

```text
Keeps rows where Company name contains “Acme” (case-insensitive).
```

#### 시나리오 B: AND/OR 그룹

사용자는 nested group을 만든다.

- `Match all (AND)`는 “Every condition in this group must match.”를 표시한다.
- `Match any (OR)`는 “At least one condition in this group must match.”를 표시한다.
- group negate는 “Exclude rows that match this whole group (NOT).”로 설명한다.
- group 하단 meaning은 괄호와 NOT을 보존한 평문을 표시한다.

#### 시나리오 C: computed kind 선택

사용자는 computed column을 추가하려 하지만 kind 차이를 모른다.

- kind selector 아래에 현재 kind의 “when to use” 문구가 표시된다.
- `Which computed type should I use?` disclosure에서 여섯 kind를 비교한다.
- 각 item을 완성하면 source row 기준의 결과 문장을 표시한다.

#### 시나리오 D: custom scalar subquery

사용자는 다른 model의 최신 값을 가져온다.

- Source를 고르면 “Queries another model for each current row.”가 표시된다.
- correlation 두 picker 사이에 평문 연결 문장이 나타난다.
- select와 order를 구성하면 다음과 같은 문장을 표시한다.

```text
For each Company row, match Payment.company_id to the current Company.id,
then return the first Payment.amount ordered by created_at descending.
```

#### 시나리오 E: Summary

사용자는 Rows와 Summary 차이를 이해한다.

- Rows: “Keeps one result row per matching model row.”
- Summary: “Returns grouped or global totals. Summary results are read-only.”
- group-by가 비어 있으면 global summary라는 사실을 명시한다.
- group-by가 있으면 “Returns one summary row per … value.”를 표시한다.

#### 시나리오 F: 오류 회복

사용자는 invalid query를 본다.

- summary에는 section 이름, 친절한 title, 해결 방법이 표시된다.
- inline에는 같은 issue의 cause와 fix가 표시된다.
- `Show technical details`에서 code/path를 볼 수 있다.
- issue button을 누르면 해당 section과 node를 열고 첫 invalid control로 이동한다.

### 1.3 Definition of Done

다음 조건을 모두 만족해야 완료다.

- 모든 Query Builder section에 한 줄 목적 설명이 있다.
- 모든 복잡한 control에 visible helper 또는 동적으로 연결된 설명이 있다.
- 모든 helper는 `aria-describedby`로 관련 control과 연결된다.
- 모든 predicate row는 incomplete/complete/invalid 상태에 맞는 next-step 또는 meaning 문장을 가진다.
- 모든 group은 AND/OR/NOT 의미를 평문으로 보여 준다.
- 모든 computed kind는 목적, 사용 시점, 결과 의미를 설명한다.
- relation/model subquery correlation이 평문으로 설명된다.
- Rows/Summary/group-by/order 의미가 결과 형태와 연결된다.
- preview가 plain meaning, implicit behavior, ORM을 구분한다.
- Apply disabled 이유가 top과 footer action 주변에서 보인다.
- 모든 `MODEL_QUERY_ISSUE_CODES`에 친절한 UI title과 explanation이 매핑된다.
- unknown issue code fallback이 존재한다.
- field/relation picker는 검색, keyboard, relation drill-in, loading, error, retry를 지원한다.
- model `verbose_name`/`help_text`가 있으면 plain-text 보조 설명으로 사용된다.
- metadata 설명이 없어도 raw field name/type으로 정상 동작한다.
- 기존 Recipe/compiler/backend execution semantics가 바뀌지 않는다.
- 기존 draft/applied/revision/stale-response 계약이 유지된다.
- dark/light/high-contrast/200% zoom에서 정보가 사라지지 않는다.
- 390px 폭에서 helper text 때문에 nested horizontal scroll이 생기지 않는다.
- 자동 테스트와 실제 VS Code visual QA가 완료된다.
- `npm run check`가 통과한다.

### 1.4 범위 밖

- Query Recipe v3
- 새로운 lookup, aggregate, formula, window function 추가
- AI query generation
- natural-language-to-ORM
- query template 저장·공유
- query history redesign
- DB write 또는 Commit 흐름 변경
- interactive tutorial modal
- usage analytics
- 외부 문서 링크 시스템
- 새 icon family
- 새 색상 palette
- fixed light/dark theme
- Query Builder 외의 ORM Query console redesign

---

## 2. 현재 구현 기준선

### 2.1 현재 파일 책임

| 파일 | 현재 책임 | 이번 계획의 판단 |
|---|---|---|
| `src/modelBrowserHtml.ts` | summary band, drawer, section shell | stable DOM anchor를 추가한다. |
| `media/gridQueryController.js` | store/render/apply/preview/message routing | guidance 상태와 Result builder를 연결한다. |
| `media/gridQuerySummary.js` | human summary와 ORM preview 합성 | plain-language explanation 계층으로 확장한다. |
| `media/gridQueryValidationView.js` | badge, issue button, focus | issue guidance registry와 technical details를 연결한다. |
| `media/gridQueryMetadata.js` | model tree cache/loading/error | optional label/help metadata를 보존한다. |
| `media/gridPredicateBuilder.js` | recursive group/comparison/Exists | guided state, path picker, meaning line을 추가한다. |
| `media/gridPredicateValue.js` | lookup/RHS/value editor | 설명 registry, persistent labels, typed hints를 추가한다. |
| `media/gridComputedBuilder.js` | computed list/kind routing | kind 선택 안내와 item meaning을 추가한다. |
| `media/gridAggregateBuilder.js` | aggregate controls | field picker와 aggregate 의미를 추가한다. |
| `media/gridSubqueryBuilder.js` | source/correlation/select/order | raw path input을 picker로 바꾸고 correlation을 설명한다. |
| `media/gridFormulaBuilder.js` | recursive formula tree | 표현식 kind 설명과 평문 meaning을 추가한다. |
| `media/gridWindowBuilder.js` | window controls | partition/order 의미를 추가한다. |
| `media/gridCodeExpressionBuilder.js` | restricted expression | 안전 범위와 transport 영향을 명시한다. |
| `media/gridQueryResultBuilder.js` | result helpers | 실제 group-by/order editor와 설명을 구현한다. |
| `media/gridCombobox.js` | 검색형 allowlisted combobox | description/search keywords/disabled reason을 opt-in 확장한다. |
| `media/modelQueryBuilder.css` | Query Builder layout/state | guidance 전용 stylesheet를 분리한다. |
| `src/modelBackend.ts` | metadata response types | optional label/help fields를 추가한다. |
| `python/backend_parts/50_model_core.pyfrag` | model/schema/filter tree metadata | bounded plain-text label/help를 보낸다. |

### 2.2 현재 사용자 흐름

현재 사용자는 다음 순서로 작업한다.

1. summary band에서 `Filter`, `Columns`, `Rows/Summary`를 누른다.
2. drawer에서 section별 controls를 편집한다.
3. 250ms debounce preview validation을 기다린다.
4. validation badge와 issue button을 확인한다.
5. `Apply query`로 snapshot을 실행한다.
6. 성공한 applied Recipe의 grid를 본다.

이 흐름은 유지한다. 새로운 wizard나 별도 page를 추가하지 않는다.

### 2.3 현재 한계

| ID | 현재 한계 | 사용자 영향 | 해결 방향 |
|---|---|---|---|
| F-01 | `WHERE`, `Computed columns`, `Result filter`, `Result`가 목적 설명 없이 표시된다. | query pipeline을 알아야 한다. | section intro를 항상 표시한다. |
| F-02 | `AND`, `OR`, `Not`가 논리 결과와 연결되지 않는다. | group 조합을 잘못 이해할 수 있다. | `Match all/any` + 평문 설명을 병기한다. |
| F-03 | incomplete comparison이 다음 단계를 알려 주지 않는다. | 빈 control을 탐색해야 한다. | node 단계별 next-step을 표시한다. |
| F-04 | complete comparison의 전체 의미가 한 문장으로 보이지 않는다. | field/lookup/value를 다시 해석해야 한다. | deterministic meaning line을 표시한다. |
| F-05 | field select가 direct field 위주이고 relation traversal 설명이 없다. | 강력한 relation filter가 발견되기 어렵다. | cascading query field picker를 구현한다. |
| F-06 | field type, nullable, choices, help text가 선택 맥락에서 약하다. | lookup/value 선택 근거가 부족하다. | option description과 field helper를 표시한다. |
| F-07 | `(i)`가 `aria-description`에만 가깝게 존재한다. | case-insensitive 의미를 놓친다. | visible lookup helper를 표시한다. |
| F-08 | RHS kind가 `literal`, `field`, `outerField` 같은 내부 개념에 가깝다. | F/OuterRef 의미를 알아야 한다. | 사용자 문구와 기술 용어를 함께 표시한다. |
| F-09 | relative time controls의 anchor/direction 조합을 해석해야 한다. | 실제 기준 시점을 혼동한다. | 동적 예시 문장을 표시한다. |
| F-10 | computed kind selector는 이름만 제공한다. | 어떤 kind를 선택할지 판단하기 어렵다. | kind 목적/사용 시점/제약을 고정 문구로 제공한다. |
| F-11 | aggregate field가 기술적 입력에 가깝다. | relation fan-out과 distinct 영향을 이해하기 어렵다. | picker와 영향 설명을 추가한다. |
| F-12 | subquery source/correlation/select/order가 ORM 지식에 의존한다. | 가장 강력한 기능의 진입 비용이 높다. | 단계 번호와 완성 문장을 제공한다. |
| F-13 | correlation path가 raw input이다. | 오타와 scope 실수가 발생한다. | target/outer picker로 교체한다. |
| F-14 | Formula tree의 각 `Expression`이 같은 label을 반복한다. | 중첩 구조를 읽기 어렵다. | 역할 label과 subtree meaning을 추가한다. |
| F-15 | Window의 `Partition`, `Order`가 결과 예시 없이 노출된다. | ranking 범위를 혼동한다. | partition/order 설명을 제공한다. |
| F-16 | Code expression의 제한은 한 줄 helper뿐이다. | 지원 범위와 실패 이유가 불명확하다. | Advanced 설명과 지원 범위를 펼침 영역에 둔다. |
| F-17 | Result mode UI가 결과 shape를 충분히 설명하지 않는다. | Rows/Summary 선택 오류가 발생한다. | mode별 결과 문장을 표시한다. |
| F-18 | Result group-by/order UI 연결이 현재 controller에서 충분히 드러나지 않는다. | Recipe power가 UI에서 완성되지 않는다. | 기존 P8 계약대로 editor를 연결한다. |
| F-19 | preview가 Recipe 문장과 ORM text를 한 `<pre>`에 합친다. | 평문과 실행 코드를 구분하기 어렵다. | 세 영역으로 분리한다. |
| F-20 | validation message가 issue code를 소문자로 바꾼 수준이다. | 원인 이해가 어렵다. | 모든 code에 친절한 presenter copy를 둔다. |
| F-21 | issue summary는 fix를 직접 보여 주지 않는다. | 해결을 위해 node까지 이동해야 한다. | summary에도 concise fix를 포함한다. |
| F-22 | Apply disabled 이유가 button 상태로만 드러난다. | 무엇을 기다리거나 고칠지 모른다. | visible reason + `aria-describedby`를 둔다. |
| F-23 | Draft와 applied grid의 차이는 `Draft` badge에 의존한다. | 현재 grid가 어느 query인지 혼동할 수 있다. | drawer intro와 status 설명을 추가한다. |
| F-24 | disabled option의 이유가 title에 의존한다. | keyboard/touch/screen reader 사용자가 이유를 놓친다. | disabled reason을 option/adjacent helper에 표시한다. |
| F-25 | 긴 설명을 둘 UI 계층이 없다. | 모든 설명을 항상 노출하면 expert density가 무너진다. | short persistent copy + `<details>` deep help로 분리한다. |

### 2.4 반드시 보존할 계약

- root WHERE empty는 all rows다.
- root postFilter empty는 no result filter다.
- nested empty group은 invalid다.
- warning은 Apply를 막지 않는다.
- error와 stale validation은 Apply를 막는다.
- Apply 중 draft 편집은 허용한다.
- Apply 성공 시 실행 snapshot과 최신 draft를 구분한다.
- Apply 실패 시 기존 grid를 유지한다.
- Reset draft는 applied clone으로 돌아간다.
- Clear는 empty draft를 만들고 실행하지 않는다.
- preview response와 rows response는 revision으로 stale 여부를 판단한다.
- Query Log는 raw Recipe JSON을 출력하지 않는다.
- relation/source metadata failure는 silent flat fallback을 만들지 않는다.
- unsupported transport는 실행 전에 issue로 표시한다.

---

## 3. 목표 UX 원칙

### 3.1 Creative North Star

**“Explain the query at the point of decision.”**

Query Builder는 문서 page가 아니라 VS Code 안의 실행 도구다. 설명은 사용자가 결정을 내리는 control 바로 옆에서 다음 네 가지 중 하나를 해결해야 한다.

1. Context: 이 control이 query의 어느 단계인지
2. Choice: 각 option이 언제 필요한지
3. Meaning: 현재 조립 결과가 무엇을 뜻하는지
4. Recovery: 문제가 있다면 무엇을 바꿔야 하는지

설명 목적이 없는 장식적 문구는 추가하지 않는다.

### 3.2 설명 계층

| Level | 이름 | 기본 상태 | 위치 | 최대 길이 |
|---|---|---|---|---:|
| L1 | Section intro | 항상 보임 | heading 아래 | 140자 |
| L2 | Next step / Meaning | 항상 보임 | node controls 아래 | 220자 |
| L3 | Choice helper | 관련 option 선택 시 보임 | control 바로 아래 | 180자 |
| L4 | Concept help | 접힘 | native `<details>` | 3~8문장 |
| L5 | Technical details | 접힘 | issue/preview 아래 | code/path/ORM |

L1~L3는 tooltip로 대체할 수 없다. L4~L5는 사용자가 열었을 때만 공간을 사용한다.

### 3.3 정보 우선순위

drawer 안의 읽기 순서는 고정한다.

1. Draft safety message
2. Filter source rows (`WHERE`)
3. Add calculated values (`Computed columns`)
4. Filter calculated results (`Result filter`)
5. Shape and order (`Result`)
6. Understand and validate (`Preview`)
7. Apply action과 현재 disabled reason

### 3.4 시각 방향

- 기존 flat workbench geometry를 유지한다.
- helper text는 `var(--vscode-descriptionForeground)`를 사용한다.
- error/warning/success는 기존 semantic token을 사용한다.
- persistent guidance를 card로 감싸지 않는다.
- section intro는 plain paragraph다.
- concept help는 border 없는 `<details>`다.
- issue는 기존 구조 border 안에서 text hierarchy로 구분한다.
- icon은 필수가 아니다. 추가하면 Codicon만 사용하고 text를 대체하지 않는다.
- body text는 11px 미만으로 내리지 않는다.
- query meaning은 editor font가 아니라 UI font를 사용한다.
- field path, alias, ORM, literal은 editor font를 사용한다.

### 3.5 문체 계약

UI copy는 다음 규칙을 지킨다.

- 먼저 결과를 말한다.
- 한 문장에 한 개념만 담는다.
- 사용자를 주어로 반복하지 않는다.
- 내부 AST/serializer/compiler 용어를 기본 설명에 노출하지 않는다.
- Django 용어는 평문 뒤 괄호에 둔다.
- error는 “무엇이 문제인지”와 “무엇을 바꿀지”를 분리한다.
- warning은 “query는 실행 가능함”과 “결과 또는 비용 영향”을 구분한다.
- 예시는 실제 model name에 의존하지 않는다.
- raw value는 80자에서 줄이고 전체 값은 기존 control에 남긴다.
- 문장 끝에 마침표를 사용한다.

좋은 예:

```text
Keeps rows where Name contains “Acme” (case-insensitive).
Choose a scalar field. A relation cannot be compared with this lookup.
This query can run, but it will use offset pagination because it sorts by a computed value.
```

금지 예:

```text
Invalid.
Bad lookup.
Just choose a field.
This is easy.
RHS_KIND_UNSUPPORTED.
```

### 3.6 사용자 용어 사전

| 내부/기술 용어 | 기본 UI 문구 | 보조 기술 표기 |
|---|---|---|
| WHERE | Filter source rows | `WHERE` |
| postFilter/HAVING | Filter calculated results | `Result filter` |
| computed | Calculated value | `Computed column` |
| literal RHS | A value | `Literal`은 technical details에만 |
| F expression | Another field in this row | `F()` |
| OuterRef | Field from the current outer row | `OuterRef()` |
| correlation | Connect target rows to the current row | `Correlation` |
| aggregate | Count or summarize values | `Aggregate` |
| scalar subquery | Bring back one value from matched rows | `Scalar subquery` |
| Exists | Check whether a matching row exists | `Exists` |
| Formula | Combine fields and values | `Formula` |
| Window | Rank or calculate across result rows | `Window` |
| code expression | Restricted Django expression | `Advanced` |
| group by | One summary row per selected value | `Group by` |
| order by | Result order | `Order by` |
| distinct | Remove duplicate source rows | `DISTINCT` |
| draft | Edited query not applied to the grid | `Draft` |
| applied | Query currently represented by the grid | `Applied` |

---

## 4. 목표 정보 구조

### 4.1 Wide wireframe

```text
┌ Query summary band ─────────────────────────────────────────────────────────┐
│ [Filter 2] [Columns 1] [Rows]  active=true AND name~"acme"  Draft  Valid │
│                                                            [Apply query]   │
└─────────────────────────────────────────────────────────────────────────────┘

┌ Query Builder ──────────────────────────────────────────────────────────────┐
│ Query Builder                                         [Reset draft] [Clear]│
│ Changes here do not affect the grid until Apply query.                    │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ FILTER SOURCE ROWS · WHERE           │ UNDERSTAND AND VALIDATE              │
│ Choose which model rows enter...     │ Plain meaning                        │
│                                      │ Keeps rows where...                  │
│ Match all (AND)                      │                                      │
│ Every condition must match.          │ The builder will also                │
│ [Field] [operator] [value]           │ • order by primary key ascending     │
│ Keeps rows where...                  │                                      │
│                                      │ Django ORM             [Copy ORM]   │
│ CALCULATED VALUES                    │ Company._base_manager.filter(...)    │
│ Add values without changing DB...    │                                      │
│ ...                                  │ Validation                           │
│                                      │ Valid. No changes are applied yet.   │
│ FILTER CALCULATED RESULTS            │                                      │
│ ...                                  │                                      │
│                                      │                                      │
│ RESULT SHAPE AND ORDER               │                                      │
│ ...                                  │                                      │
├──────────────────────────────────────┴──────────────────────────────────────┤
│                         Ready to apply.                  [Apply query]       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Split/narrow 구조

640~959px에서는 기존 single-column section 순서를 유지한다. Preview는 마지막 section으로 이동하고 sticky를 사용하지 않는다.

639px 이하:

- section intro와 meaning line은 줄바꿈한다.
- helper text는 숨기지 않는다.
- control row는 one-column flow가 된다.
- action group은 마지막 줄에서 wrap한다.
- combobox popup은 viewport 폭을 넘지 않는다.
- drawer footer에는 disabled reason이 button 위 한 줄로 온다.
- horizontal nested scroll을 만들지 않는다.

### 4.3 새 stable DOM ID

`src/modelBrowserHtml.ts` model mode에 다음 ID를 추가한다.

```text
queryDrawerIntro
queryWhereGuide
queryComputedGuide
queryPostFilterGuide
queryResultGuide
queryPreviewGuide
queryPlainMeaning
queryImplicitBehavior
queryOrmDetails
queryApplyHelp
queryDrawerApplyHelp
```

기존 ID는 삭제하거나 이름을 바꾸지 않는다.

### 4.4 section heading과 고정 intro copy

| ID | Heading | 항상 보이는 intro |
|---|---|---|
| `queryWhereGuide` | `Filter source rows` + code label `WHERE` | `Choose which model rows enter the query. An empty section includes every row.` |
| `queryComputedGuide` | `Add calculated values` + secondary `Computed columns` | `Create values for filtering, sorting, or display without changing the database.` |
| `queryPostFilterGuide` | `Filter calculated results` + secondary `Result filter` | `Filter after calculated values are available. Use this for computed aliases and summary totals.` |
| `queryResultGuide` | `Shape and order the result` + secondary `Result` | `Choose row-level data or a summary, then control grouping and order.` |
| `queryPreviewGuide` | `Understand and validate` + secondary `Preview` | `Review the plain meaning, implicit behavior, and Django ORM before applying the draft.` |

drawer intro exact copy:

```text
Changes here stay in Draft and do not affect the grid until Apply query succeeds.
```

---

## 5. 설명 데이터 모델

### 5.1 새 pure data module

새 파일 `media/gridQueryGuidanceCopy.js`를 만든다.

책임:

- section copy
- lookup label/description
- RHS kind label/description
- computed kind label/description
- formula kind label/description
- result mode label/description
- status copy
- concept help copy

이 파일은 DOM을 만들지 않고 frozen plain object와 pure accessor만 export한다.

권장 export:

```js
export const QUERY_SECTION_GUIDANCE = Object.freeze({...});
export const QUERY_LOOKUP_GUIDANCE = Object.freeze({...});
export const QUERY_RHS_GUIDANCE = Object.freeze({...});
export const QUERY_COMPUTED_KIND_GUIDANCE = Object.freeze({...});
export const QUERY_FORMULA_KIND_GUIDANCE = Object.freeze({...});
export const QUERY_RESULT_MODE_GUIDANCE = Object.freeze({...});
export const QUERY_STATUS_GUIDANCE = Object.freeze({...});
export function guidanceForLookup(name) {...}
export function guidanceForComputedKind(kind) {...}
```

unknown key fallback:

```text
Label: stable key converted to sentence case
Description: “This option is supported by the current query contract.”
```

### 5.2 새 explanation module

새 파일 `media/gridQueryExplanation.js`를 만든다.

책임:

- incomplete predicate next-step
- complete predicate meaning
- group meaning
- Exists meaning
- computed item meaning
- correlation meaning
- result mode meaning
- implicit behavior 목록
- Apply disabled reason

권장 export:

```js
export function explainComparison(node, context) {...}
export function explainPredicateGroup(group, context) {...}
export function explainExistsPredicate(node, context) {...}
export function explainComputedColumn(item, context) {...}
export function explainCorrelation(item, context) {...}
export function explainResult(recipe, context) {...}
export function explainImplicitBehavior(recipe, validation) {...}
export function applyAvailability(snapshot, state) {...}
```

모든 함수는 다음 shape 중 하나를 반환한다.

```js
{
  state: "empty" | "incomplete" | "complete" | "warning" | "error",
  text: "Visible plain-language sentence.",
  technical: "Optional technical sentence."
}
```

규칙:

- DOM을 참조하지 않는다.
- Recipe를 변경하지 않는다.
- ORM string을 생성하지 않는다.
- raw object에 `JSON.stringify`를 사용해 사용자에게 노출하지 않는다.
- literal은 `gridQuerySummary.js`의 bounded formatter를 재사용한다.
- 설명 생성 실패 시 빈 문자열이 아니라 안전한 fallback을 반환한다.

### 5.3 새 DOM guidance module

새 파일 `media/gridQueryGuidanceView.js`를 만든다.

책임:

- helper ID 생성
- `aria-describedby` token 병합
- section intro 렌더
- concept `<details>` 렌더
- next-step/meaning paragraph 렌더
- disabled reason 렌더
- technical detail 렌더

권장 export:

```js
export function appendDescribedBy(control, id) {...}
export function createControlHelp({ el, id, text, technical }) {...}
export function createMeaningLine({ el, explanation, id }) {...}
export function createConceptHelp({ el, summary, paragraphs, examples }) {...}
export function renderSectionGuidance(elements) {...}
export function renderApplyHelp(element, availability) {...}
```

접근성 규칙:

- helper의 `id`는 stable node ID를 기반으로 한다.
- 기존 `aria-describedby`를 덮어쓰지 않고 space-separated token으로 합친다.
- 같은 token을 중복 추가하지 않는다.
- meaning line은 `aria-live`를 사용하지 않는다.
- error는 기존 issue view의 `role="alert"`를 사용한다.
- `<details>`는 native keyboard semantics를 유지한다.

### 5.4 새 issue guidance module

새 파일 `media/gridQueryIssueGuidance.js`를 만든다.

export:

```js
export const QUERY_ISSUE_GUIDANCE = Object.freeze({...});
export function presentQueryIssue(issue) {...}
```

`presentQueryIssue()` 반환:

```js
{
  title: "Choose a field",
  explanation: "This condition does not yet identify a field to compare.",
  fix: issue.fix || "Review this query setting.",
  severity: "error",
  technical: {
    code: issue.code,
    path: issue.path
  }
}
```

UI는 backend `message`보다 registry `title`을 먼저 사용한다. backend `fix`는 authoritative recovery text로 사용한다. registry에 code가 없으면 다음 fallback을 사용한다.

```text
title = sentenceCase(issue.code || "Query issue")
explanation = issue.message || "The query needs attention before it can be applied."
fix = issue.fix || "Review the highlighted query setting."
```

---

## 6. Predicate Builder 상세 계약

### 6.1 group toolbar 문구

현재 value는 `and`/`or`를 유지하되 option label을 바꾼다.

| Value | Option label | Visible helper |
|---|---|---|
| `and` | `Match all (AND)` | `Every condition in this group must match.` |
| `or` | `Match any (OR)` | `At least one condition in this group must match.` |

group negation:

- checkbox visible label: `Exclude this group (NOT)`
- unchecked helper: 표시하지 않는다.
- checked helper: `Rows that match this whole group will be excluded.`

root empty meaning:

```text
No source-row filter. Applying this draft would include every row.
```

postFilter root empty meaning:

```text
No calculated-result filter. All calculated rows or groups will remain.
```

nested empty meaning:

```text
This nested group has no conditions. Add a condition or remove the group.
```

### 6.2 structural action 문구

| 현재 | 목표 visible label | Accessible name | helper/tooltip |
|---|---|---|---|
| `+ condition` | `Add condition` | `Add condition to this group` | `Compare a field or calculated value.` |
| `+ group` | `Add group` | `Add nested condition group` | `Combine conditions with their own all/any rule.` |
| `+ exists` | `Add existence check` | `Add related-row existence check` | `Keep rows based on whether a matching related row exists.` |
| `↑` | `Up` 또는 Codicon + text alternative | `Move condition up` | 기존 |
| `↓` | `Down` 또는 Codicon + text alternative | `Move condition down` | 기존 |
| `Duplicate` | 유지 | node 종류 포함 | `Create an independent copy.` |
| `Remove` | 유지 | node 종류 포함 | `Remove only this draft item.` |

limit 도달 시 button은 disabled되고 바로 뒤에 다음 문구를 표시한다.

```text
This group reached the limit of 16 items.
```

depth 도달:

```text
Nested groups can be up to 5 levels deep.
```

두 limit이 동시에 해당하면 child count 문구를 먼저 표시한다.

### 6.3 comparison 단계 상태

`explainComparison()`은 다음 우선순위로 상태를 결정한다.

1. node validation error
2. field 없음
3. field metadata pending/error
4. lookup 없음 또는 incompatible
5. RHS kind 없음 또는 incompatible
6. required value 없음
7. complete

정확한 next-step:

| 상태 | 문구 |
|---|---|
| field 없음 | `Choose the field or calculated value you want to filter.` |
| metadata pending | `Loading fields for this model…` |
| metadata error | `Field details could not be loaded. Retry before choosing a field.` |
| lookup 없음 | `Choose how {fieldLabel} should be compared.` |
| RHS kind 없음 | `Choose whether to compare with a value, another field, or a relative time.` |
| value 없음 | `Enter the value to compare with {fieldLabel}.` |
| incompatible RHS | `The previous value does not fit this field or comparison. Choose a new value.` |
| invalid | issue presenter의 title + fix |
| complete | 아래 meaning grammar 사용 |

### 6.4 comparison meaning grammar

positive:

```text
Keeps rows where {lhs} {connector} {rhs}{qualifier}.
```

negated:

```text
Excludes rows where {lhs} {connector} {rhs}{qualifier}.
```

postFilter positive:

```text
Keeps calculated results where {lhs} {connector} {rhs}{qualifier}.
```

`{lhs}`:

- field: label이 있으면 label 뒤에 path를 code style로 병기한다.
- computed: `calculated value {alias}`
- related path: 마지막 field label + full path

예:

```text
Keeps rows where Company name (`_base_name`) contains “Acme” (case-insensitive).
Keeps rows where Created at is within the past 7 days from now.
Keeps calculated results where `member_count` is at least 3.
Excludes rows where Deleted at is null.
```

### 6.5 field picker

새 파일 `media/gridQueryFieldPicker.js`를 만든다.

API:

```js
createQueryFieldPicker({
  ariaLabel,
  computed = [],
  current,
  el,
  metadata,
  onChange,
  source,
  context,
  allowRelationTerminal = false
})
```

반환:

```js
{
  node,
  focus(),
  getPath(),
  getTerminal(),
  setCurrent(path),
  dispose()
}
```

동작:

1. root metadata를 요청한다.
2. option group 순서는 `Fields`, `Calculated values`, `Relations`다.
3. field option label:

```text
{verbose label} — {field name}
```

label과 field name이 같으면 한 번만 표시한다.

4. option description:

```text
{Django field type} · {Required|Nullable} · {helpText if present}
```

5. relation option:

```text
{relation name} → {target model}
```

description:

```text
{One-to-one|Many-to-one|One-to-many|Many-to-many}. Choose to continue into the related model.
```

6. relation을 고르면 다음 segment combobox를 lazy-load한다.
7. leaf field를 고를 때만 complete path를 emit한다.
8. `allowRelationTerminal=true`이고 lookup이 `isnull`이면 relation terminal도 emit할 수 있다.
9. existing path hydrate는 `__` segment를 순서대로 resolve한다.
10. resolve되지 않는 segment는 자동 삭제하지 않는다.
11. unresolved option:

```text
Unavailable field: {segment}
```

description:

```text
This field is not present in the current model metadata. Choose a replacement.
```

12. metadata error 시 picker 자리에 error + `Retry`를 표시한다.
13. Retry 성공 후 기존 selection hydrate를 다시 시도한다.
14. popup Escape는 popup만 닫고 drawer를 닫지 않는다.
15. relation load 중 stale response는 무시한다.

### 6.6 combobox opt-in 확장

`media/gridCombobox.js` option shape를 backward-compatible하게 확장한다.

```js
{
  value,
  label,
  title,
  group,
  description,
  keywords,
  disabled,
  disabledReason
}
```

변경 규칙:

- 기존 caller는 시각/동작 변화가 없어야 한다.
- search는 `label + keywords + description`을 case-insensitive 검색한다.
- description이 있을 때 option 안에 secondary line을 렌더한다.
- disabled option은 `aria-disabled="true"`를 가진다.
- keyboard active index는 disabled option을 건너뛴다.
- disabled option click은 selection을 바꾸지 않는다.
- disabledReason을 secondary line에 표시한다.
- selected value가 disabled로 바뀌면 조용히 clear하지 않는다.
- input은 current label을 유지하고 adjacent helper에서 invalid 상태를 알린다.
- popup은 query drawer 안에서 viewport를 넘지 않는다.

### 6.7 lookup copy

`gridPredicateValue.js`의 value와 backend lookup은 바꾸지 않는다.

| Lookup | Visible label | Meaning connector / helper |
|---|---|---|
| `exact` | `equals` | `equals` |
| `iexact` | `equals, ignoring case` | `equals` + `(case-insensitive)` |
| `contains` | `contains` | `contains` |
| `icontains` | `contains, ignoring case` | `contains` + `(case-insensitive)` |
| `startswith` | `starts with` | `starts with` |
| `istartswith` | `starts with, ignoring case` | `starts with` + `(case-insensitive)` |
| `endswith` | `ends with` | `ends with` |
| `iendswith` | `ends with, ignoring case` | `ends with` + `(case-insensitive)` |
| `gt` | `is greater than` | numeric/date strict comparison |
| `gte` | `is at least` | inclusive lower bound |
| `lt` | `is less than` | numeric/date strict comparison |
| `lte` | `is at most` | inclusive upper bound |
| `in` | `is in this list` | any listed value may match |
| `range` | `is between` | includes both boundaries |
| `isnull` | `has or lacks a value` | null database value, not empty text |
| `blank` | `is blank` | null or empty string according to existing compiler semantics |
| `not_blank` | `is not blank` | neither null nor empty string |
| `trim` | `equals after trimming spaces` | trims surrounding spaces before comparison |
| `length` | `has length equal to` | text length |
| `length__gt` | `has length greater than` | text length |
| `length__gte` | `has length at least` | text length |
| `length__lt` | `has length less than` | text length |
| `length__lte` | `has length at most` | text length |
| `date` | `has date equal to` | compares date part of datetime |
| `year` | `is in year` | extracts year |
| `quarter` | `is in quarter` | 1 through 4 |
| `month` | `is in month` | 1 through 12 |
| `week_day` | `is on weekday` | Django numbering: Sunday 1 through Saturday 7 |
| `day` | `is on day of month` | 1 through 31 |
| `hour` | `is in hour` | 0 through 23 |
| `minute` | `is in minute` | 0 through 59 |
| `second` | `is in second` | 0 through 59 |

lookup helper는 현재 선택된 lookup 한 개만 표시한다.

### 6.8 RHS kind copy

| Internal kind | Visible option | Helper |
|---|---|---|
| `literal` | `A value` | `Compare with a fixed value you enter.` |
| `field` | `Another field in this row` | `Compare with a field from the same model row (Django F expression).` |
| `outerField` | `Field from the current outer row` | `Use a field from the row that opened this subquery (Django OuterRef).` |
| `relativeTime` | `Relative date or time` | `Build a value relative to now or today when the query runs.` |

lookup이 RHS kind를 고정하는 경우 kind select를 숨기고 다음 visible note를 사용한다.

| Lookup | Note |
|---|---|
| `in` | `Add one or more allowed values.` |
| `range` | `Enter an inclusive start and end value.` |
| `isnull` | `Choose whether the field has a database value.` |
| `blank` | `No value is needed. Blank matches the existing blank semantics.` |
| `not_blank` | `No value is needed. Only non-blank values remain.` |

### 6.9 typed value helper

| Editor | Persistent label/helper |
|---|---|
| text | `Comparison value` |
| number | `Number to compare` |
| date | `Date to compare` |
| datetime | `Date and time to compare` |
| time | `Time to compare` |
| choice | `{field label} value` |
| boolean | `Choose true or false.` |
| list | `Add values one at a time. Commas remain part of a text value.` |
| range | `Both boundaries are included.` |
| relative time | dynamic sentence below controls |
| field RHS | `Choose a compatible field from this row.` |
| outerField | `Choose a field from the current outer row.` |

relative time meaning examples:

```text
Uses the time 7 days before now when the query runs.
Uses the start of the day 2 weeks in the future.
```

실제 compiler anchor semantics와 문구가 일치하도록 기존 `anchor`, `direction`, `unit` 값을 그대로 사용한다.

### 6.10 Exists predicate

heading:

```text
Related row existence
```

intro:

```text
Keep or exclude the current row based on whether at least one target row matches.
```

source options:

| Source | Label | Helper |
|---|---|---|
| relation | `Follow a relation` | `The relation supplies the target model and row connection automatically.` |
| model | `Choose another model` | `Select a target model and define how it connects to the current row.` |

positive meaning:

```text
Keeps rows when at least one {target} row matches {inner predicate}.
```

negated meaning:

```text
Keeps rows only when no {target} row matches {inner predicate}.
```

relation auto-correlation:

```text
The `{relation}` relation connects each current row to `{target}` automatically.
```

custom correlation:

```text
Connect target `{targetPath}` to current-row `{outerPath}`.
```

incomplete correlation:

```text
Choose both target and current-row fields to complete this connection.
```

correlation path는 raw text input이 아니라 두 `createQueryFieldPicker()`를 사용한다.

---

## 7. Computed Column 상세 계약

### 7.1 section concept help

summary:

```text
Which calculated value should I use?
```

내용:

1. `Aggregate` — count or summarize related values.
2. `Scalar subquery` — bring back one value from matched rows.
3. `Exists` — produce true or false for a matching row.
4. `Formula` — combine fields, earlier calculated values, and literals.
5. `Window` — rank or calculate across result rows.
6. `Code expression` — use the restricted advanced expression syntax only when structured builders cannot represent the expression.

### 7.2 kind registry

| Kind | Visible label | One-line helper | Use when | Important limit |
|---|---|---|---|---|
| `aggregate` | `Count or summarize values` | `Create Count, Sum, Average, Minimum, or Maximum.` | 관계 또는 field 집계 | fan-out safety와 distinct |
| `scalarSubquery` | `Bring back one matched value` | `Run a bounded subquery for each current row and return one value.` | 최신 related 값 | correlation과 order 필요 |
| `exists` | `Check whether a match exists` | `Create a true/false value from a related or custom-model match.` | 존재 여부 | scalar select 없음 |
| `formula` | `Combine values` | `Build arithmetic, text, function, Case, or Cast expressions.` | 여러 값 계산 | earlier alias만 참조 |
| `window` | `Rank or calculate across rows` | `Create rank, row number, or running aggregate values.` | 결과 row 간 계산 | order 필수 |
| `codeExpression` | `Restricted Django expression` | `Advanced: enter the allowlisted single-line expression form.` | structured UI로 표현 불가 | transport와 800자 제한 |

selector option label은 짧은 기술 이름을 유지할 수 있다. selector 아래 helper는 위의 one-line helper를 반드시 표시한다.

### 7.3 common item header

collapsed header 순서:

1. enabled checkbox
2. alias
3. compact technical description
4. state text: `Ready`, `Incomplete`, `Disabled`, `Not available in Summary`

expanded body 순서:

1. alias와 type
2. 현재 kind helper
3. kind-specific controls
4. meaning line
5. issue
6. structural actions

`Disabled`는 opacity만 사용하지 않고 text로 표시한다.

alias helper:

```text
Use a Python-style name. Later result filters, formulas, and ordering can refer to it.
```

forward reference helper:

```text
Formulas can use only enabled calculated values listed above this item.
```

### 7.4 Aggregate

intro:

```text
Summarize one field or count matching rows for each source row.
```

control labels:

- `Function`
- `Value to summarize`
- `Remove duplicate matches`
- `Only include matching values`

field는 `createQueryFieldPicker()`를 사용한다.

distinct helper:

- `auto`: `The builder adds DISTINCT only when the relation path can duplicate source rows.`
- `always`: `Always remove duplicate values before aggregating.`
- `never`: `Do not remove duplicates. This may change counts across to-many relations.`

meaning:

```text
Creates `{alias}` by counting matching `{path}` values for each source row.
Creates `{alias}` as the average of `{path}` for each source row.
```

filter가 있으면:

```text
Only values matching {predicate meaning} are included.
```

fan-out error:

```text
This to-many path can duplicate values for {function}. Choose Count, use a safer path, or restructure the query.
```

### 7.5 Scalar subquery

expanded body는 다음 numbered steps를 고정한다.

1. `1. Choose the target rows`
2. `2. Connect them to the current row`
3. `3. Filter target rows`
4. `4. Choose the value to return`
5. `5. Decide which match comes first`
6. `6. Choose the empty value and output type`

각 step은 `<fieldset>`과 `<legend>`를 사용한다.

source helper:

- relation: `Follow one relation from each current row. The connection is automatic.`
- model: `Query another model and define one to four field connections.`

select:

- field: `Return one field from the first matched target row.`
- aggregate: `Summarize all matched target rows and return the aggregate.`

order empty warning:

```text
No explicit order is set. The builder will use the target primary key ascending.
```

on empty:

```text
Use this value when no target row matches.
```

complete meaning grammar:

```text
For each {sourceModel} row, {correlation sentence}, then return
{select sentence} from the first {targetModel} row ordered by {order sentence}.
```

aggregate select:

```text
For each {sourceModel} row, {correlation sentence}, then return
the {aggregate function} of {field} across all matched {targetModel} rows.
```

`Reset incompatible fields` 위 helper:

```text
Changing the target can leave old field paths in the draft. Reset only the incompatible target fields; alias and source remain unchanged.
```

### 7.6 Exists computed column

intro:

```text
Create a true/false value that reports whether at least one target row matches.
```

scalar select/order/onEmpty controls는 렌더링하지 않는다.

meaning:

```text
Creates `{alias}` as true when at least one {target} row matches {predicate}; otherwise false.
```

### 7.7 Formula

concept help summary:

```text
How formula expressions are built
```

내용:

- A formula is a tree of values and operations.
- Field uses a model field.
- Earlier calculated value uses an enabled alias above this item.
- Fixed value uses a literal.
- Math operation combines two expressions.
- Function transforms one or more expressions.
- Conditional value chooses a result with Case/When.
- Convert type emits a Cast.

expression kind copy:

| Internal | Visible |
|---|---|
| `field` | `Use a model field` |
| `computed` | `Use an earlier calculated value` |
| `literal` | `Use a fixed value` |
| `binary` | `Math operation` |
| `function` | `Function` |
| `case` | `Conditional value` |
| `cast` | `Convert type` |

각 nested expression legend는 모두 `Expression`로 반복하지 않는다.

역할 기반 legend:

- binary left: `Left value`
- binary right: `Right value`
- function arg: `Argument {N}`
- Case branch condition: `When {N}`
- Case branch result: `Then {N}`
- Case else: `Otherwise`
- Cast inner: `Value to convert`

meaning 예:

```text
Creates `total_with_tax` as `subtotal` multiplied by 1.1.
Creates `display_name` as the first non-empty value from `nickname` and `name`.
Creates `size_label` as “large” when `total` is greater than 100; otherwise “standard”.
```

formula가 incomplete이면 전체 meaning 대신 deepest first incomplete next-step을 표시한다.

### 7.8 Window

intro:

```text
Calculate a rank, row number, or running value across the query result.
```

control helper:

- Function: `Choose the calculation performed across result rows.`
- Field: `Required only for aggregate-style window functions.`
- Order: `Defines the sequence used by rank, row number, and running calculations.`
- Partition: `Restart the calculation for each distinct partition value. Leave empty to use all result rows.`

meaning:

```text
Creates `{alias}` as {function} ordered by {order}.
The calculation restarts for each {partition} value.
```

partition 없음:

```text
The calculation uses all matching result rows as one partition.
```

order 없음:

```text
Choose an order field. Window results are undefined without a stable order.
```

### 7.9 Code expression

항상 보이는 intro:

```text
Advanced: use the restricted single-line Django expression syntax only when the structured builders cannot represent the calculation.
```

concept help:

```text
What is allowed?
```

내용:

- The existing backend allowlist and validation remain authoritative.
- Newlines are not allowed.
- The maximum is 800 characters.
- The expression is not arbitrary Python.
- Unsupported transports fail validation before execution.
- Output type must match the expression result.

`Only when` helper:

```text
When enabled, calculate this value only for rows matching the condition.
```

meaning:

```text
Creates `{alias}` from a restricted Django expression with output type {type}.
```

expression 본문은 meaning line이나 Query Log에 복제하지 않는다. 사용자가 입력 control과 ORM preview에서만 본다.

### 7.10 Function과 output type copy

Aggregate function:

| Internal | Visible label | Helper |
|---|---|---|
| `count` | `Count` | `Count matching rows or non-null field values.` |
| `sum` | `Sum` | `Add matching numeric values.` |
| `avg` | `Average` | `Calculate the arithmetic mean of matching numeric values.` |
| `min` | `Minimum` | `Return the smallest matching value.` |
| `max` | `Maximum` | `Return the largest matching value.` |

Formula function:

| Internal | Visible label | Helper |
|---|---|---|
| `coalesce` | `First value that is not null` | `Return the first non-null argument.` |
| `concat` | `Join as text` | `Convert and join two text-compatible values.` |
| `greatest` | `Greatest value` | `Return the larger compatible value.` |
| `least` | `Least value` | `Return the smaller compatible value.` |
| `lower` | `Lowercase text` | `Convert text to lowercase.` |
| `upper` | `Uppercase text` | `Convert text to uppercase.` |
| `trim` | `Trim surrounding spaces` | `Remove spaces from the beginning and end of text.` |
| `length` | `Text length` | `Return the number of characters.` |

Window function:

| Internal | Visible label | Helper |
|---|---|---|
| `rank` | `Rank with gaps` | `Equal values share a rank; the next rank may skip numbers.` |
| `dense_rank` | `Rank without gaps` | `Equal values share a rank; the next rank stays consecutive.` |
| `row_number` | `Row number` | `Assign a unique sequential number in the selected order.` |
| `sum` | `Running sum` | `Calculate Sum within the current partition and window order.` |
| `avg` | `Running average` | `Calculate Average within the current partition and window order.` |
| `min` | `Window minimum` | `Calculate Minimum within the current partition.` |
| `max` | `Window maximum` | `Calculate Maximum within the current partition.` |
| `count` | `Window count` | `Calculate Count within the current partition.` |

Output type:

| Internal | Visible label | Helper |
|---|---|---|
| `auto` | `Infer from the expression` | `Use metadata and expression rules to determine the result type.` |
| `boolean` | `True / false` | `The result is a BooleanField-compatible value.` |
| `integer` | `Integer` | `The result is a whole number.` |
| `float` | `Floating-point number` | `The result uses floating-point numeric semantics.` |
| `decimal` | `Decimal number` | `The result uses decimal numeric semantics.` |
| `text` | `Text` | `The result is string-compatible.` |
| `date` | `Date` | `The result contains a calendar date without a time.` |
| `datetime` | `Date and time` | `The result contains a timezone-aware or database-compatible datetime.` |
| `time` | `Time` | `The result contains a time without a date.` |
| `duration` | `Duration` | `The result contains a time interval.` |
| `uuid` | `UUID` | `The result contains a UUID-compatible value.` |

helper는 현재 선택된 function/output type 한 개에 대해서만 표시한다.

---

## 8. Result와 Preview 상세 계약

### 8.1 Result mode

`media/gridQueryResultBuilder.js`에 실제 editor renderer를 추가한다.

API:

```js
createQueryResultBuilder({
  dispatch,
  el,
  getRecipe,
  getScope,
  metadata,
  validation
})
```

반환:

```js
{
  node,
  render(),
  dispose()
}
```

mode copy:

| Mode | Label | Helper |
|---|---|---|
| rows | `Rows` | `Keep one result row per matching model row. Calculated values appear as extra columns.` |
| summary | `Summary` | `Return grouped or global totals. Summary results are read-only.` |

### 8.2 Group by

Summary mode에서만 표시한다.

heading:

```text
One summary row per value
```

empty:

```text
No group field is selected. The query returns one global summary row.
```

one or more:

```text
The query returns one summary row for each unique combination of the selected fields.
```

field picker는 concrete field만 제공한다. 허용되지 않는 computed kind는 option에서 disabled 상태로 보여 주고 이유를 표시한다.

limit:

```text
Summary results can group by up to 8 fields.
```

### 8.3 Outer order

heading:

```text
Result order
```

empty Rows:

```text
No order is selected. Rows use the primary key ascending.
```

empty Summary:

```text
No order is selected. The database’s summary order is not guaranteed.
```

각 order term:

- reference picker
- direction `Ascending` / `Descending`
- move
- remove

meaning:

```text
Orders results by `{field}` descending, then `{second}` ascending.
```

computed/window order가 offset pagination을 유발하면 helper:

```text
This order uses offset pagination because it depends on a calculated result.
```

### 8.4 Plain meaning

`queryPlainMeaning`은 `<div>`이며 code block이 아니다.

순서:

1. source-row filter
2. calculated values
3. calculated-result filter
4. result shape
5. order

예:

```text
Start with Company rows whose name contains “Acme”.
Add `member_count` by counting related members.
Keep results where `member_count` is at least 3.
Return one row per Company, ordered by `member_count` descending.
```

각 문장은 별도 `<p>`로 렌더한다.

### 8.5 Implicit behavior

`queryImplicitBehavior` heading:

```text
The builder will also
```

해당 항목이 있을 때만 list를 보인다.

가능한 항목:

- `Remove duplicate source rows caused by a to-many relation (DISTINCT).`
- `Order rows by the primary key ascending because no result order is set.`
- `Order the subquery by its primary key ascending because no inner order is set.`
- `Use offset pagination because the result depends on a calculated value or custom order.`
- `Scan Python properties in memory. This may be slow and cannot use normal database pagination.`
- `Keep the previous grid visible until this draft applies successfully.`
- `Run through {transport}.`

validation warning이 같은 의미를 이미 나타내면 중복 문장을 제거한다.

### 8.6 ORM details

`queryOrmDetails`는 native `<details>`로 만든다.

summary:

```text
Show Django ORM
```

내부:

- 기존 `queryOrmPreview` `<pre>`
- `Copy ORM`
- preview loading/error

valid preview가 없으면:

```text
The ORM preview will appear after field metadata and validation are ready.
```

`Copy ORM` 성공:

```text
Copied Django ORM.
```

clipboard 실패:

```text
Could not access the clipboard. Select and copy the ORM text manually.
```

이 상태는 polite live region으로 한 번 알린다.

### 8.7 Apply availability

`applyAvailability()` 우선순위:

1. source 없음
2. applying
3. metadata loading
4. checking
5. stale validation
6. validation errors
7. local result errors
8. ready

정확한 문구:

| 상태 | `queryApplyHelp` / `queryDrawerApplyHelp` |
|---|---|
| source 없음 | `Open a model before applying a query.` |
| applying | `Applying Recipe revision {N}. You can continue editing a newer draft.` |
| metadata loading | `Loading field details before the query can be validated.` |
| checking | `Checking this draft against the current model and transport.` |
| stale validation | `Waiting for validation of the latest draft.` |
| errors | `Fix {N} error(s) before applying this draft.` |
| ready + dirty | `Ready to apply. The grid will update only after the query succeeds.` |
| ready + not dirty | `This draft matches the applied query.` |

기존 Apply 활성 조건을 유지한다. “not dirty이면 반드시 disabled” 같은 새 규칙을 추가하지 않는다. helper만 실제 button 상태와 일치하게 렌더한다.

### 8.8 lifecycle status copy

| 상태 | Visible copy |
|---|---|
| draft | `Draft changed. The grid still shows Recipe revision {appliedRevision}.` |
| checking | `Checking the latest draft…` |
| valid | `Ready to apply.` |
| warning | `Ready to apply with {N} warning(s).` |
| applying | `Applying Recipe revision {N}…` |
| success no newer draft | `Applied. The grid now shows Recipe revision {N}.` |
| success with newer draft | `Recipe revision {N} is applied. A newer draft is still being edited.` |
| rejected | `The draft was not applied. The previous grid remains visible.` |
| metadata error | `Field details are unavailable. Retry to continue.` |
| transport unsupported | `This draft cannot run through {transport}. Change the query or select a supported link.` |

---

## 9. Validation issue 설명 계약

### 9.1 issue UI 구조

inline:

```text
{Title}. {Fix}
[Why this happens]
```

summary button:

```text
{Section}: {Title} — {Fix}
```

technical details:

```text
Code: FIELD_PATH_INVALID
Path: /where/children/0/lhs/path
```

technical details는 `<details>` 안에 있고 기본 접힘이다.

### 9.2 issue section mapping

`path` prefix 우선:

| Prefix | Section |
|---|---|
| `/where` | `Source filter` |
| `/computed` | `Calculated values` |
| `/postFilter` | `Calculated-result filter` |
| `/groupBy` | `Summary grouping` |
| `/orderBy` | `Result order` |
| `/source` | `Query source` |
| empty | `Query` |

nodeId로 실제 DOM section을 찾을 수 있으면 DOM section이 path prefix보다 우선한다.

### 9.3 모든 issue code의 title/explanation

아래 mapping을 빠짐없이 구현한다. `fix`는 backend issue 값을 사용한다.

| Code | Title | Explanation |
|---|---|---|
| `RECIPE_VERSION_UNSUPPORTED` | `This query format is not supported` | `The draft was created with a Recipe version this builder cannot apply.` |
| `RECIPE_SOURCE_MISMATCH` | `This query belongs to another model` | `The draft source does not match the model currently open in the grid.` |
| `RECIPE_TOO_LARGE` | `This query is too large` | `The complete draft exceeds the bounded Recipe payload size.` |
| `RECIPE_SHAPE_INVALID` | `Part of the query is incomplete` | `A required group, item, or value has an unsupported shape.` |
| `NODE_ID_INVALID` | `A query item has an invalid identifier` | `Stable internal identifiers must use the bounded generated format.` |
| `NODE_ID_DUPLICATE` | `Two query items share an identifier` | `Every query item needs a unique stable identifier.` |
| `PREDICATE_NODE_LIMIT` | `There are too many conditions` | `The query exceeds the maximum number of predicate nodes.` |
| `PREDICATE_GROUP_DEPTH_LIMIT` | `Conditions are nested too deeply` | `The query exceeds the maximum nested group depth.` |
| `PREDICATE_GROUP_CHILD_LIMIT` | `This group has too many items` | `A single group can contain only the bounded number of children.` |
| `EMPTY_NESTED_GROUP` | `This nested group is empty` | `Only the root group may be empty; an empty nested group has no useful meaning.` |
| `FIELD_METADATA_UNAVAILABLE` | `Field details are unavailable` | `The builder cannot safely validate paths and types without current model metadata.` |
| `FIELD_PATH_INVALID` | `Choose an available field` | `The selected path is not present in the current model metadata.` |
| `FIELD_PATH_TOO_LONG` | `This field path is too long` | `The relation traversal exceeds the bounded path length or segment count.` |
| `FIELD_PATH_RELATION_TERMINAL` | `Choose a field inside this relation` | `This comparison needs a scalar field unless it is checking whether a relation is null.` |
| `FIELD_PATH_TO_MANY_UNSAFE` | `This to-many path is unsafe here` | `Following this relation can duplicate source rows in a context that cannot preserve the intended result.` |
| `LOOKUP_UNSUPPORTED` | `Choose a supported comparison` | `The selected lookup is not in the Recipe allowlist.` |
| `LOOKUP_TYPE_MISMATCH` | `This comparison does not fit the field type` | `The selected lookup cannot be used with this field’s Django type.` |
| `RHS_KIND_UNSUPPORTED` | `Choose a supported value source` | `This context cannot compare against the selected value, field, OuterRef, or relative time kind.` |
| `RHS_TYPE_MISMATCH` | `The comparison values have different types` | `The right-hand value cannot be safely compared with the selected field.` |
| `VALUE_REQUIRED` | `Enter a comparison value` | `This comparison cannot be evaluated without a value.` |
| `VALUE_INVALID` | `Enter a valid value` | `The value cannot be converted to the selected field and lookup type.` |
| `IN_LIST_LIMIT` | `The value list is too long` | `The `in` comparison exceeds the bounded list size.` |
| `RELATIVE_TIME_INVALID` | `Complete the relative time` | `Amount, unit, anchor, or direction is outside the supported range.` |
| `COMPUTED_COLUMN_LIMIT` | `There are too many calculated values` | `The draft exceeds the maximum number of computed columns.` |
| `ALIAS_INVALID` | `Use a valid calculated-value name` | `Aliases use a bounded Python-style identifier format.` |
| `ALIAS_RESERVED` | `Choose a different calculated-value name` | `This alias is reserved by the query or model runtime.` |
| `ALIAS_COLLISION` | `This name conflicts with a model field` | `A calculated value cannot hide an existing model field.` |
| `ALIAS_DUPLICATE` | `This calculated-value name is already used` | `Every enabled computed column needs a unique alias.` |
| `COMPUTED_REFERENCE_UNKNOWN` | `Choose an available calculated value` | `The referenced alias does not exist in this draft.` |
| `COMPUTED_REFERENCE_FORWARD` | `Move the dependency above this formula` | `A formula can use only enabled calculated values declared earlier in the list.` |
| `COMPUTED_REFERENCE_DISABLED` | `Enable the referenced calculated value` | `This expression depends on a computed column that is currently disabled.` |
| `COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY` | `This calculated value is not available in Summary` | `Summary mode supports only the existing aggregate-compatible computed kinds.` |
| `AGGREGATE_FIELD_REQUIRED` | `Choose a value to summarize` | `This aggregate function needs a field or the supported all-rows form.` |
| `AGGREGATE_FANOUT_UNSAFE` | `This aggregate can duplicate values` | `The selected to-many path can multiply rows and change the aggregate result.` |
| `AGGREGATE_DISTINCT_UNSUPPORTED` | `DISTINCT is not supported for this aggregate` | `The selected function and distinct mode are not a supported combination.` |
| `WINDOW_ORDER_REQUIRED` | `Choose an order for the window calculation` | `Window results require a stable row sequence.` |
| `WINDOW_FILTER_UNSUPPORTED` | `Window values cannot be filtered here` | `The current query pipeline cannot apply this result filter to a window alias.` |
| `FORMULA_NODE_LIMIT` | `This formula has too many parts` | `The expression tree exceeds the bounded node count.` |
| `FORMULA_DEPTH_LIMIT` | `This formula is nested too deeply` | `The expression tree exceeds the bounded depth.` |
| `FORMULA_TYPE_MISMATCH` | `Formula values have incompatible types` | `The selected operation or function cannot combine these input types safely.` |
| `FORMULA_DIVIDE_BY_ZERO` | `The formula divides by zero` | `A fixed divisor of zero cannot produce a valid result.` |
| `OUTPUT_TYPE_REQUIRED` | `Choose the result type` | `The builder needs an output type to validate and compile this expression.` |
| `RAW_EXPRESSION_INVALID` | `The restricted expression is not valid` | `The expression contains unsupported syntax, names, or structure.` |
| `RAW_EXPRESSION_TRANSPORT_UNSUPPORTED` | `This link cannot run the restricted expression` | `The active transport does not support this advanced expression form.` |
| `RAW_MODEL_NAME_AMBIGUOUS` | `Use an unambiguous model reference` | `The restricted expression refers to a model name that cannot be resolved safely.` |
| `SUBQUERY_SOURCE_INVALID` | `Choose a subquery source` | `The subquery needs a valid relation or app-qualified model.` |
| `SUBQUERY_RELATION_INVALID` | `Choose an available relation` | `The selected relation is not present on the current source model.` |
| `SUBQUERY_CORRELATION_REQUIRED` | `Connect the target to the current row` | `A custom-model subquery needs at least one complete correlation.` |
| `SUBQUERY_CORRELATION_LIMIT` | `There are too many subquery connections` | `The subquery exceeds the bounded correlation count.` |
| `SUBQUERY_CORRELATION_INVALID` | `Complete this subquery connection` | `The target and current-row paths are missing or incompatible.` |
| `SUBQUERY_SELECT_INVALID` | `Choose the value returned by the subquery` | `The subquery select field or aggregate is incomplete or unsupported.` |
| `SUBQUERY_ORDER_LIMIT` | `There are too many subquery order terms` | `The subquery exceeds the bounded inner order count.` |
| `SUBQUERY_IMPLICIT_ORDER` | `The subquery uses its default order` | `No explicit inner order is set, so the target primary key ascending is used.` |
| `SUBQUERY_AGGREGATE_FANOUT_UNSAFE` | `This subquery aggregate can duplicate values` | `The selected target path can multiply rows before aggregation.` |
| `OUTER_REF_SCOPE_INVALID` | `Choose a field from the current outer row` | `This OuterRef points outside the scope available to the subquery.` |
| `GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED` | `This global summary filter is not supported` | `The current result filter needs grouping or a supported summary alias context.` |
| `PYTHON_PROPERTY_FULL_SCAN` | `This filter scans Python values in memory` | `The property is not a database field, so normal indexed filtering and pagination are unavailable.` |
| `PYTHON_PROPERTY_BOOLEAN_UNSUPPORTED` | `This Python property cannot use this boolean filter` | `The property value cannot be translated to the requested database boolean operation.` |
| `PYTHON_PROPERTY_SUMMARY_UNSUPPORTED` | `Python properties are not available in Summary` | `Summary mode must run in the database and cannot group or aggregate arbitrary Python properties.` |
| `AUTO_DISTINCT_APPLIED` | `Duplicate source rows will be removed` | `The builder adds DISTINCT because a to-many relation could otherwise duplicate the current model rows.` |
| `OFFSET_PAGINATION_REQUIRED` | `This query uses offset pagination` | `Calculated values, windows, or custom ordering prevent primary-key keyset pagination.` |
| `TRANSPORT_CAPABILITY_UNSUPPORTED` | `The active link cannot run this query` | `The draft uses a feature not supported by the selected transport.` |
| `GENERATED_QUERY_TOO_LARGE` | `The generated Django query is too large` | `The validated Recipe expands beyond the bounded executable ORM cell size.` |

### 9.4 severity presentation

Error:

- title + fix
- Apply disabled
- `role="alert"` only when newly introduced or apply rejected

Warning:

- title + impact + fix
- Apply remains enabled
- `role="status"`

같은 issue가 render마다 반복 announce되지 않도록 `code + nodeId + path + draftRevision` key를 사용한다.

---

## 10. Metadata 설명 확장

### 10.1 backend additive fields

`BackendModelColumn`과 `BackendFilterField`에 다음 optional field를 추가한다.

```ts
label?: string;
helpText?: string;
```

`BackendFilterRelation`에 다음 optional field를 추가한다.

```ts
label?: string;
```

기존 client와 payload는 optional field를 무시할 수 있어야 한다. protocol version은 바꾸지 않는다.

### 10.2 Python 생성 규칙

`python/backend_parts/50_model_core.pyfrag`에 bounded plain-text helper를 추가한다.

```python
def _browse_plain_metadata_text(value, limit):
    """Returns collapsed, tag-free, bounded model metadata text."""
```

구현 규칙:

1. `str(value or "")`
2. `django.utils.html.strip_tags`
3. 모든 whitespace run을 한 칸으로 collapse
4. trim
5. label 120자, help text 240자
6. limit을 넘으면 마지막 한 글자를 `…`로 사용
7. exception이면 빈 문자열

field:

- `label = field.verbose_name`
- `helpText = field.help_text`

relation:

- forward field는 `verbose_name`
- reverse relation은 accessor/query name을 underscore-to-space로 바꾼 fallback

빈 label/helpText는 payload에서 생략한다.

### 10.3 보안

- `help_text`를 `innerHTML`에 넣지 않는다.
- link, script, HTML attribute를 해석하지 않는다.
- ORM preview나 Query Log에 help text를 기록하지 않는다.
- field default, DB value, callable 결과를 metadata 설명으로 평가하지 않는다.
- lazy translation object는 `str()`까지만 수행한다.

### 10.4 transport fallback

metadata가 없는 transport에서는:

- field name
- Django field type
- null/required
- choices

만으로 picker와 helper가 동작한다.

optional help metadata가 없다는 이유로 Apply를 막지 않는다.

---

## 11. HTML/CSS 계약

### 11.1 `src/modelBrowserHtml.ts`

변경:

- drawer header 내부에 `queryDrawerIntro`
- 각 section에 guide mount ID
- Preview section에 plain meaning, implicit behavior, ORM details container
- top/footer Apply 옆에 help mount
- `aria-describedby` 연결

삭제 금지:

- 기존 summary button IDs
- drawer section IDs
- existing live regions
- query mode DOM

### 11.2 새 stylesheet

새 파일:

```text
media/modelQueryGuidance.css
```

`webviewStylesheetLinks()` 순서:

1. `uiFoundation.css`
2. `modelBrowser.css`
3. `modelQueryBuilder.css`
4. `modelQueryGuidance.css`

### 11.3 CSS class 계약

```text
query-section-heading
query-section-technical-name
query-section-intro
query-control-help
query-next-step
query-meaning
query-meaning[data-state="incomplete"]
query-meaning[data-state="complete"]
query-meaning[data-state="warning"]
query-concept-help
query-concept-help-body
query-example-list
query-field-picker
query-field-picker-segments
query-option-description
query-disabled-reason
query-apply-help
query-plain-meaning
query-implicit-behavior
query-technical-details
query-issue-title
query-issue-fix
query-issue-technical
query-subquery-step
query-correlation-meaning
```

### 11.4 CSS rules

- helper max width는 `72ch`이고 narrow에서는 `100%`.
- helper는 wrap하고 ellipsis로 숨기지 않는다.
- code token만 `font-family: var(--vscode-editor-font-family)`.
- `.query-meaning`은 최소 한 줄 높이를 확보해 control 편집 시 layout jump를 줄인다.
- meaning state는 color만으로 구분하지 않고 prefix text를 포함한다.
- `<details>` summary는 최소 24px hit target과 visible focus를 가진다.
- field picker segment는 wide에서 inline wrap, narrow에서 vertical stack.
- combobox popup 최대 폭은 `min(440px, calc(100vw - 16px))`.
- option description은 2줄까지 wrap하며 title에 의존하지 않는다.
- high contrast에서 border는 `--vscode-contrastBorder` fallback을 포함한다.
- `prefers-reduced-motion`에서 새 animation을 사용하지 않는다.
- 새 transition이 필요하지 않다.
- `outline: none`을 새로 추가하지 않는다.
- `transition: all`을 사용하지 않는다.

---

## 12. 접근성 계약

### 12.1 labels와 descriptions

- 모든 input/select/combobox는 visible label 또는 `aria-label`을 가진다.
- complex control은 visible helper와 `aria-describedby`로 연결된다.
- placeholder는 label이 아니다.
- helper ID는 render마다 안정적이다.
- duplicate node는 새 node ID와 새 helper ID를 사용한다.

### 12.2 keyboard

기존 계약 유지:

- `Ctrl/Cmd+Enter`: valid draft Apply
- `Alt+Shift+↑/↓`: move
- `Ctrl/Cmd+D`: duplicate
- `Enter/Space`: button/toggle
- `Escape`: 현재 popup 닫기

추가 picker 계약:

- Arrow Up/Down: enabled option 이동
- Home/End: 첫/마지막 enabled option
- Enter: 선택
- Escape: popup 닫고 current selection 복구
- Tab: 현재 selection을 유지하고 다음 control로 이동
- relation option 선택: 다음 segment를 만들고 focus 이동
- Retry: 성공하면 해당 picker로 focus 복귀

### 12.3 announcements

announce:

- metadata load failure
- validation error count가 0에서 양수로 변경
- apply start/success/rejection
- clipboard success/failure

announce하지 않음:

- 매 keystroke의 meaning 문장
- field option description
- concept help body
- formula metric

### 12.4 issue focus

issue summary click/Enter:

1. drawer open
2. target section open
3. ancestor `<details>` 모두 open
4. target scroll
5. first invalid control focus
6. control이 없으면 node container `tabindex="-1"` focus

### 12.5 zoom과 long text

- 200% zoom에서 helper가 action을 가리지 않는다.
- 400% zoom에서는 single-column flow를 허용한다.
- long verbose name/help text는 wrap한다.
- full field path는 accessible name에서 유지한다.
- code/path technical details는 `overflow-wrap:anywhere`.

---

## 13. 파일 배치와 줄 수 예산

### 13.1 새 파일

| 파일 | 책임 | 목표 최대 줄 |
|---|---|---:|
| `media/gridQueryGuidanceCopy.js` | 고정 UI copy registry | 500 |
| `media/gridQueryExplanation.js` | pure meaning/next-step/implicit/apply 설명 | 650 |
| `media/gridQueryGuidanceView.js` | helper DOM과 aria 연결 | 350 |
| `media/gridQueryIssueGuidance.js` | issue presenter registry | 500 |
| `media/gridQueryFieldPicker.js` | metadata-backed cascading query field picker | 600 |
| `media/modelQueryGuidance.css` | guidance layout/state/responsive | 300 |
| `test/modelQueryGuidanceCopy.test.mjs` | registry completeness와 exact copy | 350 |
| `test/modelQueryExplanation.test.mjs` | pure meaning grammar | 500 |
| `test/modelQueryIssueGuidance.test.mjs` | issue code coverage/fallback | 300 |
| `test/modelQueryFieldPicker.test.mjs` | picker async/path/keyboard state | 500 |
| `test/modelQueryGuidanceAccessibility.test.mjs` | descriptions/focus/details/live-region | 450 |

### 13.2 변경 파일

| 파일 | 변경 |
|---|---|
| `src/modelBrowserHtml.ts` | stable mounts와 accessible relationships |
| `src/modelBackend.ts` | optional label/help metadata type |
| `media/gridCombobox.js` | opt-in description/keywords/disabled reason |
| `media/gridQueryMetadata.js` | optional metadata 보존과 helper access |
| `media/gridQueryController.js` | guidance/result/preview/apply help wiring |
| `media/gridQuerySummary.js` | explanation module 기반 summary |
| `media/gridQueryValidationView.js` | issue presenter와 technical details |
| `media/gridPredicateBuilder.js` | picker/meaning/group help |
| `media/gridPredicateValue.js` | lookup/RHS helper와 labels |
| `media/gridComputedBuilder.js` | kind help/item meaning |
| `media/gridAggregateBuilder.js` | picker와 meaning |
| `media/gridSubqueryBuilder.js` | numbered steps/pickers/correlation meaning |
| `media/gridFormulaBuilder.js` | role legends/subtree meaning |
| `media/gridWindowBuilder.js` | helper와 meaning |
| `media/gridCodeExpressionBuilder.js` | advanced concept help |
| `media/gridQueryResultBuilder.js` | mode/group/order editor |
| `media/modelQueryBuilder.css` | 기존 builder geometry만 유지 |
| `python/backend_parts/50_model_core.pyfrag` | bounded label/help metadata |
| `README.md` | 설명형 Query Builder 사용법 |
| `DESIGN.md` | point-of-decision guidance component rule |

### 13.3 분리 기준

- `gridPredicateBuilder.js`가 700줄을 넘기기 전에 field picker와 explanation을 새 파일에 유지한다.
- `gridComputedBuilder.js`에는 kind-specific copy object를 넣지 않는다.
- `gridQueryController.js`에는 copy 문자열을 직접 쓰지 않는다.
- `modelQueryBuilder.css`에 guidance style을 넣지 않는다.
- `src/modelBackend.ts`가 900줄에 도달하면 이번 작업 범위의 metadata interfaces를 `src/modelBackendMetadata.ts`로 분리하고 re-export한다.
- Python fragment는 1000줄을 넘기지 않는다.

---

## 14. 단계별 구현 계획

## Phase 0. 기준선과 보호

### 작업

- [ ] `git status --short`로 기존 변경을 기록한다.
- [ ] 사용자 변경을 reset/restore하지 않는다.
- [ ] 현재 줄 수를 기록한다.

```bash
wc -l \
  src/modelBackend.ts \
  media/gridCombobox.js \
  media/gridQueryController.js \
  media/gridPredicateBuilder.js \
  media/gridComputedBuilder.js \
  python/backend_parts/50_model_core.pyfrag
```

- [ ] 현재 Query Builder focused test를 실행한다.

```bash
node --test \
  test/modelQueryBuilderShell.test.mjs \
  test/modelQueryPredicateBuilder.test.mjs \
  test/modelQueryPredicateAccessibility.test.mjs \
  test/modelQueryComputedBuilder.test.mjs \
  test/modelQuerySubqueryBuilder.test.mjs \
  test/modelQueryFormulaBuilder.test.mjs \
  test/modelQueryResultBuilder.test.mjs \
  test/modelQueryPreview.test.mjs
```

- [ ] current UI copy characterization test를 `test/modelQueryGuidanceBaseline.test.mjs`로 추가한다.
- [ ] baseline test는 현재 기술 문구를 장기 계약으로 고정하지 않는다. 변경 대상 위치와 DOM anchor만 기록한다.

### 완료 게이트

- 기존 focused test 통과
- dirty changes 보존
- production code 변경 없음

---

## Phase 1. Copy registry와 pure explanation

### 새 파일

- `media/gridQueryGuidanceCopy.js`
- `media/gridQueryExplanation.js`
- `media/gridQueryIssueGuidance.js`
- `test/modelQueryGuidanceCopy.test.mjs`
- `test/modelQueryExplanation.test.mjs`
- `test/modelQueryIssueGuidance.test.mjs`

### 작업

- [ ] section/lookup/RHS/computed/formula/result/status registry를 구현한다.
- [ ] 이 문서의 exact copy를 사용한다.
- [ ] unknown key fallback을 구현한다.
- [ ] predicate incomplete state 우선순위를 구현한다.
- [ ] group/comparison/Exists meaning grammar를 구현한다.
- [ ] computed kind별 meaning을 구현한다.
- [ ] result와 implicit behavior 설명을 구현한다.
- [ ] Apply availability priority를 구현한다.
- [ ] 모든 issue code mapping을 구현한다.
- [ ] unknown issue fallback을 구현한다.
- [ ] raw expression 본문을 summary에 복제하지 않는 test를 추가한다.
- [ ] literal 80자 truncation과 quote escaping test를 추가한다.
- [ ] boolean parentheses/NOT preservation test를 유지한다.

### 필수 test cases

- empty WHERE
- incomplete field/lookup/value
- direct field literal
- case-insensitive lookup
- list/range/null/blank
- field RHS
- relative time
- AND/OR/NOT
- nested group
- Exists relation/custom model
- every computed kind
- subquery implicit order
- Rows/Summary/global/grouped
- auto distinct
- offset pagination
- property full scan
- Apply state priority
- every issue code covered
- unknown issue fallback

### 완료 게이트

```bash
node --test \
  test/modelQueryGuidanceCopy.test.mjs \
  test/modelQueryExplanation.test.mjs \
  test/modelQueryIssueGuidance.test.mjs
```

---

## Phase 2. Metadata label/help 확장

### 변경 파일

- `src/modelBackend.ts`
- `python/backend_parts/50_model_core.pyfrag`
- `test/modelBrowser.test.mjs`
- `test/backendComposedSource.test.mjs`
- `test/modelQueryPredicateBuilder.test.mjs`

### 작업

- [ ] optional `label`/`helpText` type을 추가한다.
- [ ] Python bounded plain text helper를 구현한다.
- [ ] concrete field metadata에 label/helpText를 추가한다.
- [ ] filter field tree에 같은 metadata를 전달한다.
- [ ] relation label을 추가한다.
- [ ] HTML tag stripping, whitespace collapse, truncation test를 추가한다.
- [ ] empty/exception fallback test를 추가한다.
- [ ] composed backend source parity를 확인한다.
- [ ] 기존 payload parser가 optional field를 보존하는지 확인한다.
- [ ] metadata가 없는 fixture도 계속 통과하게 한다.

### 완료 게이트

```bash
npm run compile
node --test \
  test/modelBrowser.test.mjs \
  test/backendComposedSource.test.mjs \
  test/modelQueryPredicateBuilder.test.mjs
```

---

## Phase 3. Combobox와 query field picker

### 변경/새 파일

- `media/gridCombobox.js`
- `media/gridQueryFieldPicker.js`
- `media/modelBrowser.css`
- `media/modelQueryGuidance.css`
- `test/gridAccessibility.test.mjs`
- `test/modelQueryFieldPicker.test.mjs`

### 작업

- [ ] combobox option shape를 opt-in 확장한다.
- [ ] description/keywords 검색을 구현한다.
- [ ] disabled option keyboard skip을 구현한다.
- [ ] disabled reason visible/ARIA를 구현한다.
- [ ] 기존 combobox caller regression test를 유지한다.
- [ ] query field picker root groups를 구현한다.
- [ ] relation lazy drill-in을 구현한다.
- [ ] existing path hydration을 구현한다.
- [ ] unresolved path preservation을 구현한다.
- [ ] metadata pending/error/retry/stale를 구현한다.
- [ ] computed root option을 구현한다.
- [ ] relation terminal restriction을 구현한다.
- [ ] picker dispose가 pending render를 무시하게 한다.

### 필수 test cases

- description 없는 기존 option
- description 검색
- keyword 검색
- disabled pointer/keyboard 차단
- Home/End disabled skip
- direct field
- one/deep relation
- to-many metadata
- computed alias
- current path hydrate
- missing segment preservation
- stale relation response
- metadata error/retry
- Escape/focus

### 완료 게이트

```bash
node --test \
  test/gridAccessibility.test.mjs \
  test/modelQueryFieldPicker.test.mjs
```

---

## Phase 4. Drawer shell과 guidance view

### 변경/새 파일

- `src/modelBrowserHtml.ts`
- `media/gridQueryGuidanceView.js`
- `media/gridQueryController.js`
- `media/modelQueryGuidance.css`
- `test/modelQueryBuilderShell.test.mjs`
- `test/modelQueryGuidanceAccessibility.test.mjs`
- `test/webviewLayoutContract.test.mjs`

### 작업

- [ ] 새 stable IDs를 추가한다.
- [ ] drawer intro를 렌더한다.
- [ ] section heading/intro를 exact copy로 렌더한다.
- [ ] guide mounts와 headings를 연결한다.
- [ ] Apply help mounts를 추가한다.
- [ ] `aria-describedby` merge helper를 구현한다.
- [ ] concept help native `<details>`를 구현한다.
- [ ] guidance stylesheet를 asset list에 추가한다.
- [ ] query mode DOM이 바뀌지 않았는지 확인한다.
- [ ] summary band 높이는 기존 범위를 유지한다.
- [ ] drawer close/open이 `<details>` state나 draft를 지우지 않게 한다.

### 완료 게이트

```bash
npm run compile
node --test \
  test/modelQueryBuilderShell.test.mjs \
  test/modelQueryGuidanceAccessibility.test.mjs \
  test/webviewLayoutContract.test.mjs
```

---

## Phase 5. Guided Predicate Builder

### 변경 파일

- `media/gridPredicateBuilder.js`
- `media/gridPredicateValue.js`
- `media/gridQueryFieldPicker.js`
- `media/gridQueryExplanation.js`
- `media/modelQueryGuidance.css`
- `test/modelQueryPredicateBuilder.test.mjs`
- `test/modelQueryPredicateAccessibility.test.mjs`
- `test/modelQueryExplanation.test.mjs`

### 작업

- [ ] group labels를 `Match all/any`로 바꾼다.
- [ ] group helper와 meaning을 렌더한다.
- [ ] group Not label/helper를 바꾼다.
- [ ] structural action labels를 바꾼다.
- [ ] depth/child disabled reason을 visible하게 표시한다.
- [ ] comparison field native select를 query field picker로 교체한다.
- [ ] lookup current helper를 렌더한다.
- [ ] RHS kind label/helper를 적용한다.
- [ ] typed editor persistent label/helper를 적용한다.
- [ ] comparison incomplete/complete meaning을 렌더한다.
- [ ] postFilter wording을 분리한다.
- [ ] Exists source/helper/correlation picker/meaning을 구현한다.
- [ ] metadata error Retry focus를 구현한다.
- [ ] remove/duplicate/move 후 helper ID와 focus를 확인한다.
- [ ] validation inline issue보다 meaning error가 중복되지 않게 한다.

중복 규칙:

- validation error가 있으면 meaning line은 generic invalid 문구를 따로 추가하지 않는다.
- issue view가 cause+fix를 담당한다.
- meaning line은 마지막으로 valid했던 의미를 보여 주지 않고 current invalid state의 next-step을 보여 준다.

### 완료 게이트

```bash
npm run compile
node --test \
  test/modelQueryPredicateBuilder.test.mjs \
  test/modelQueryPredicateAccessibility.test.mjs \
  test/modelQueryExplanation.test.mjs \
  test/gridAccessibility.test.mjs
```

---

## Phase 6. Guided Computed Builder

### 변경 파일

- `media/gridComputedBuilder.js`
- `media/gridAggregateBuilder.js`
- `media/gridSubqueryBuilder.js`
- `media/gridFormulaBuilder.js`
- `media/gridWindowBuilder.js`
- `media/gridCodeExpressionBuilder.js`
- `media/gridComputedShared.js`
- `media/gridQueryFieldPicker.js`
- `media/gridQueryExplanation.js`
- `test/modelQueryComputedBuilder.test.mjs`
- `test/modelQuerySubqueryBuilder.test.mjs`
- `test/modelQueryFormulaBuilder.test.mjs`
- `test/modelQueryExplanation.test.mjs`

### 작업

- [ ] computed kind selector helper를 구현한다.
- [ ] `Which calculated value should I use?` disclosure를 구현한다.
- [ ] common alias/dependency helper를 구현한다.
- [ ] collapsed item state text를 구현한다.
- [ ] Aggregate field를 picker로 교체한다.
- [ ] Aggregate distinct/filter meaning을 구현한다.
- [ ] Subquery body를 6개 fixed step fieldset으로 나눈다.
- [ ] Subquery target/current/select/order field를 picker로 교체한다.
- [ ] correlation sentence를 구현한다.
- [ ] scalar/aggregate select meaning을 구현한다.
- [ ] implicit primary-key order warning과 Preview implicit behavior를 de-duplicate한다.
- [ ] Exists computed meaning을 구현한다.
- [ ] Formula role-based legends를 구현한다.
- [ ] Formula subtree/whole meaning을 구현한다.
- [ ] Window helper/meaning을 구현한다.
- [ ] Code expression concept help를 구현한다.
- [ ] Summary unavailable 설명을 유지한다.
- [ ] disabled computed downstream dependency 설명을 유지한다.
- [ ] target 변경 시 incompatible child를 자동 삭제하지 않는다.

### 완료 게이트

```bash
npm run compile
node --test \
  test/modelQueryComputedBuilder.test.mjs \
  test/modelQuerySubqueryBuilder.test.mjs \
  test/modelQueryFormulaBuilder.test.mjs \
  test/modelQueryExplanation.test.mjs \
  test/modelQueryRecipeParity.test.mjs
```

---

## Phase 7. Result, Preview, Validation, Apply 설명

### 변경 파일

- `media/gridQueryResultBuilder.js`
- `media/gridQueryController.js`
- `media/gridQuerySummary.js`
- `media/gridQueryValidationView.js`
- `media/gridQueryIssueGuidance.js`
- `media/gridQueryGuidanceView.js`
- `test/modelQueryResultBuilder.test.mjs`
- `test/modelQueryPreview.test.mjs`
- `test/modelQueryIssueGuidance.test.mjs`
- `test/modelQueryRecipeLifecycle.test.mjs`

### 작업

- [ ] Result mode renderer를 controller에 연결한다.
- [ ] Summary group-by picker를 구현한다.
- [ ] outer order editor를 구현한다.
- [ ] mode/group/order meaning을 구현한다.
- [ ] existing max/duplicate validation을 유지한다.
- [ ] preview를 Plain meaning/Implicit behavior/ORM details로 분리한다.
- [ ] current AST renderer와 explanation renderer의 Boolean semantics parity test를 추가한다.
- [ ] issue presenter를 inline/summary에 적용한다.
- [ ] issue summary에 fix를 포함한다.
- [ ] technical details를 접힌 상태로 추가한다.
- [ ] focus가 ancestor details를 모두 열게 한다.
- [ ] Apply availability helper를 top/footer에 연결한다.
- [ ] lifecycle status copy를 revision 상태와 연결한다.
- [ ] clipboard success/failure feedback을 구현한다.
- [ ] stale validation/preview/rows behavior를 바꾸지 않는다.
- [ ] rejected apply가 기존 grid를 유지하는 test를 유지한다.

### 완료 게이트

```bash
npm run compile
node --test \
  test/modelQueryResultBuilder.test.mjs \
  test/modelQueryPreview.test.mjs \
  test/modelQueryIssueGuidance.test.mjs \
  test/modelQueryRecipeLifecycle.test.mjs \
  test/modelQueryRecipeCount.test.mjs
```

---

## Phase 8. 문서와 정리

### 작업

- [ ] `README.md` Query Builder section에 설명 계층과 예시를 추가한다.
- [ ] `DESIGN.md`에 “Point-of-decision guidance” component rule을 추가한다.
- [ ] `PRODUCT.md`의 expert density 원칙은 바꾸지 않는다.
- [ ] old technical helper copy가 중복으로 남았는지 검색한다.

```bash
rg -n \
  "Loading predicate group|No value needed|Field metadata failed|Formula expression kind|Subquery select type" \
  media src test
```

- [ ] 새 source 파일 첫 줄 목적 주석을 확인한다.
- [ ] 모든 function/class docstring을 확인한다.
- [ ] 모든 code file 1000줄 이하를 확인한다.

```bash
rg --files -0 src media python \
  -g '*.ts' -g '*.js' -g '*.py' -g '*.pyfrag' |
  xargs -0 wc -l
```

### 완료 게이트

```bash
npm run check:guidelines
git diff --check
```

---

## Phase 9. 접근성·responsive·visual QA

### 9.1 자동 접근성

- [ ] 모든 helper가 관련 control과 `aria-describedby`로 연결된다.
- [ ] description token 중복이 없다.
- [ ] option description이 `role=option` accessible name을 망치지 않는다.
- [ ] disabled option에 `aria-disabled`.
- [ ] disabled reason이 visible.
- [ ] details summary keyboard 가능.
- [ ] issue technical details는 focus order를 방해하지 않는다.
- [ ] dynamic meaning은 live announce되지 않는다.
- [ ] error/apply status는 announce된다.
- [ ] error summary가 node를 연다.
- [ ] Retry 후 picker focus가 복구된다.

명령:

```bash
node --test \
  test/gridAccessibility.test.mjs \
  test/modelQueryPredicateAccessibility.test.mjs \
  test/modelQueryGuidanceAccessibility.test.mjs \
  test/webviewLayoutContract.test.mjs
```

### 9.2 viewport

실제 Model Data webview에서 확인한다.

| 상태 | 폭/배율 |
|---|---|
| Wide | 1440×900 |
| Split | 800×900 |
| Narrow | 600×900 |
| Extreme narrow | 390×844 |
| Zoom | 200% |
| Theme | Dark, Light, High Contrast |

각 조건에서:

1. empty WHERE
2. incomplete comparison
3. complete comparison meaning
4. 3-depth nested group
5. relation picker open
6. long verbose label/help text
7. metadata loading
8. metadata error + Retry
9. invalid value + issue
10. 3 computed columns collapsed
11. expanded scalar subquery
12. expanded Formula Case
13. Summary global
14. Summary grouped
15. applying with newer draft
16. backend rejection
17. ORM details open

검사:

- unexpected horizontal scroll 없음
- helper가 action을 밀어 접근 불가하게 하지 않음
- popup clipping 없음
- sticky footer가 helper/issue를 가리지 않음
- technical details long path wrap
- focus ring visible
- high contrast border visible
- summary band 높이와 grid 공간 유지

### 9.3 interaction

- [ ] empty → condition → complete → Apply
- [ ] keyboard-only nested group
- [ ] relation path 3 segment
- [ ] field search by verbose label
- [ ] field search by raw name
- [ ] field search by type keyword
- [ ] disabled option reason
- [ ] metadata Retry
- [ ] Aggregate choice help
- [ ] Subquery 6 steps
- [ ] correlation meaning update
- [ ] Formula nested meaning
- [ ] Rows ↔ Summary explanation
- [ ] issue summary → control
- [ ] Show technical details
- [ ] Copy ORM success/failure
- [ ] Apply 중 draft edit
- [ ] Reset/Clear safety message

---

## Phase 10. 실제 `rtcc-poc-page` 검증

### 10.1 shell 초기화

VS Code integrated terminal에서 다음을 한 줄씩 정확히 실행한다.

```bash
pm 5
```

5번 virtual network가 준비된 다음:

```bash
./zz django shell
```

금지:

- `pm5`
- `./zz shell`
- `./zz django-shell`
- 두 명령을 한 줄로 합치기

### 10.2 실제 시나리오

대상 model은 `db.Company`를 우선 사용한다. 실제 schema가 달라졌으면 같은 type 특성을 가진 read-only field를 고르되 query 의미를 바꾸지 않는다.

#### RTCC-G01 — simple condition

```text
_base_name contains, ignoring case "테스트"
```

확인:

- field label/type/helper
- lookup helper
- complete meaning
- plain preview
- ORM details
- Apply/Count

#### RTCC-G02 — nested group

```text
deleted_at is null
AND (
  _base_name contains, ignoring case "테스트"
  OR is_demo equals true
)
```

확인:

- Match all/any helper
- parentheses meaning
- group NOT toggle 설명
- keyboard focus

#### RTCC-G03 — relative time

DateTimeField 또는 DateField에 지원되는 relative 조건을 만든다.

확인:

- typed editor
- relative meaning
- preview anchor semantics

#### RTCC-G04 — Aggregate

안전한 Count path를 사용한다.

확인:

- kind decision help
- field picker relation path
- distinct explanation
- computed meaning
- result filter meaning

#### RTCC-G05 — scalar subquery

```text
alias: self_name
target: db.Company
correlation: target.id = current.id
select: _base_name
order: id ascending
on empty: null
output: text
```

확인:

- 6 steps
- target/current picker
- correlation sentence
- full computed meaning
- ORM preview correlation scope

#### RTCC-G06 — Summary

```text
mode: Summary
group by: is_demo
row_count = Count(all rows)
result filter: row_count >= 1
order: row_count descending
```

확인:

- Rows/Summary helper
- grouped result meaning
- read-only explanation
- group count
- Rows 복귀 시 draft 보존

#### RTCC-G07 — invalid recovery

field를 선택한 뒤 incompatible lookup/value 상태를 의도적으로 만든다.

확인:

- old value 보존
- title + explanation + fix
- summary → node focus
- technical code/path details
- 수정 후 issue 제거

### 10.3 transport

다음에서 RTCC-G01과 RTCC-G05를 확인한다.

1. Link: Auto
2. Link: ORM
3. Link: Socket

지원되지 않는 조합은 실행하지 않고 friendly issue로 설명해야 한다.

### 10.4 최종 검증

```bash
npm run check
```

가능하면:

```bash
npm run test:e2e
```

실행하지 못한 viewport/theme/transport는 최종 보고에 정확히 남긴다.

---

## 15. 테스트 매트릭스

### 15.1 Explanation purity

| Case | Recipe 변경 없음 | 안정적 문구 | bounded | 기술 detail 분리 |
|---|---:|---:|---:|---:|
| empty | ✓ | ✓ | ✓ | ✓ |
| incomplete | ✓ | ✓ | ✓ | ✓ |
| valid comparison | ✓ | ✓ | ✓ | ✓ |
| nested boolean | ✓ | ✓ | ✓ | ✓ |
| Exists | ✓ | ✓ | ✓ | ✓ |
| Aggregate | ✓ | ✓ | ✓ | ✓ |
| Subquery | ✓ | ✓ | ✓ | ✓ |
| Formula | ✓ | ✓ | ✓ | ✓ |
| Window | ✓ | ✓ | ✓ | ✓ |
| Code expression | ✓ | ✓ | expression 숨김 | ✓ |
| Summary | ✓ | ✓ | ✓ | ✓ |

### 15.2 Picker

| Case | Search | Keyboard | Async | Invalid 보존 | 설명 |
|---|---:|---:|---:|---:|---:|
| field | ✓ | ✓ | - | ✓ | ✓ |
| choice field | ✓ | ✓ | - | ✓ | ✓ |
| relation | ✓ | ✓ | ✓ | ✓ | ✓ |
| deep relation | ✓ | ✓ | ✓ | ✓ | ✓ |
| computed alias | ✓ | ✓ | - | ✓ | ✓ |
| disabled alias | ✓ | ✓ | - | ✓ | reason |
| metadata error | - | ✓ | Retry | ✓ | ✓ |

### 15.3 Validation

| Case | Inline | Summary | Fix | Focus | Technical |
|---|---:|---:|---:|---:|---:|
| known error | ✓ | ✓ | ✓ | ✓ | ✓ |
| known warning | ✓ | ✓ | ✓ | ✓ | ✓ |
| unknown code | ✓ | ✓ | fallback | 가능한 경우 | ✓ |
| no nodeId | section | ✓ | ✓ | section | ✓ |
| backend rejection | ✓ | ✓ | ✓ | ✓ | ✓ |

### 15.4 Lifecycle

- draft explanation does not imply applied
- Clear does not imply execution
- Reset does not imply execution
- Apply pending identifies snapshot revision
- newer draft remains explicit
- success identifies applied revision
- rejection states previous grid remains
- stale preview does not overwrite current guidance
- stale rows do not change applied explanation

---

## 16. 성능·안전·회귀 기준

### 16.1 성능

- explanation pure functions는 DOM query를 하지 않는다.
- 64 predicate/12 computed worst case에서 한 render에 각 node를 한 번만 순회한다.
- field option formatting은 metadata target별 cache한다.
- helper rendering은 추가 backend request를 만들지 않는다.
- `verbose_name`/`help_text`는 기존 `filterfields` response에 포함한다.
- input keystroke가 host preview debounce 외 새 async request를 만들지 않는다.
- combobox search는 current option array의 in-memory filter다.
- issue announcement de-duplication set은 panel dispose 시 비운다.

### 16.2 안전

- explanation text는 `textContent`/text node만 사용한다.
- model help text를 HTML로 렌더링하지 않는다.
- issue message/fix/path를 HTML로 렌더링하지 않는다.
- Recipe JSON을 help에 출력하지 않는다.
- code expression을 help/summary/log에 복제하지 않는다.
- unknown metadata object key를 DOM attribute로 전달하지 않는다.
- picker는 allowlisted option value만 emit한다.

### 16.3 회귀 금지

- query mode standalone ORM editor 변경 금지
- grid virtualization 변경 금지
- sticky row/column geometry 변경 금지
- Commit/staged edit 변경 금지
- Query Log execution semantics 변경 금지
- backend compiler 변경 금지
- Recipe limit 변경 금지
- transport fallback 변경 금지

---

## 17. 최종 완료 체크리스트

### 기능

- [ ] section intro 5개
- [ ] drawer draft safety intro
- [ ] predicate next-step/meaning
- [ ] AND/OR/NOT explanation
- [ ] searchable relation field picker
- [ ] lookup helper 전체
- [ ] RHS helper 전체
- [ ] typed value helper
- [ ] Exists explanation
- [ ] computed kind guide
- [ ] Aggregate explanation
- [ ] Subquery 6-step guide
- [ ] correlation sentence
- [ ] Formula role labels/meaning
- [ ] Window explanation
- [ ] Code expression advanced help
- [ ] Rows/Summary/group/order explanation
- [ ] plain meaning preview
- [ ] implicit behavior list
- [ ] ORM details
- [ ] Apply disabled reason
- [ ] lifecycle revision copy
- [ ] all issue code presenter
- [ ] unknown issue fallback
- [ ] optional field label/help metadata

### 접근성

- [ ] labels
- [ ] described-by
- [ ] keyboard picker
- [ ] disabled reason
- [ ] visible focus
- [ ] native details
- [ ] live-region restraint
- [ ] error focus
- [ ] long text
- [ ] zoom
- [ ] high contrast

### 품질

- [ ] 모든 code file ≤1000 lines
- [ ] 모든 code file first-line summary
- [ ] 모든 function/class/method summary
- [ ] no new dependency
- [ ] no hard-coded product color
- [ ] no silent state deletion
- [ ] no Recipe/compiler semantic change
- [ ] `git diff --check`
- [ ] `npm run check`
- [ ] real `pm 5`
- [ ] real `./zz django shell`
- [ ] actual Model Data interaction QA
- [ ] final screenshots/viewports 기록

---

## 18. Terra High 구현 handoff

Terra High는 다음 순서로만 작업한다.

1. Phase 0 baseline을 실행한다.
2. pure copy/explanation/issue registry를 먼저 완성한다.
3. metadata optional fields를 추가한다.
4. combobox opt-in 확장과 query field picker를 완성한다.
5. drawer shell에 guidance mount를 연결한다.
6. Predicate Builder를 전환한다.
7. Computed Builder를 전환한다.
8. Result/Preview/Validation/Apply 설명을 연결한다.
9. 문서와 code-size 정리를 한다.
10. 자동 접근성과 actual visual QA를 한다.
11. `rtcc-poc-page`에서 정확한 shell 초기화 후 read-only 시나리오를 검증한다.
12. 전체 `npm run check`가 통과한 뒤에만 완료로 보고한다.

구현 중 선택지가 생겼을 때:

- copy 선택지는 이 문서의 exact copy를 사용한다.
- layout 선택지는 기존 `DESIGN.md` geometry를 사용한다.
- control 선택지는 native control 또는 기존 `gridCombobox.js`를 사용한다.
- backend 의미 선택지는 기존 Recipe V2 validator/compiler 결과를 사용한다.
- 자동 수정과 invalid 보존 사이에서는 invalid 보존을 선택한다.
- tooltip과 visible helper 사이에서는 visible helper를 선택한다.
- 새 dependency와 작은 local module 사이에서는 local module을 선택한다.
- 기능 확장과 설명 개선이 충돌하면 설명 개선 범위만 구현한다.

이 문서에 없는 query 기능을 새로 설계하지 않는다.
