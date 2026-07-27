# Model Data Query Builder v2 구현 계획

> 상태: 구현 착수용 확정 설계
>
> 대상 실행 모델: Terra High 수준
>
> 작성 기준일: 2026-07-26
>
> 대상 저장소: `/Users/lky/project/django-shell`
>
> 실제 연동 검증 대상: VS Code의 `rtcc-poc-page` 워크스페이스
>
> 문서의 성격: 제품 방향을 다시 판단하는 제안서가 아니라, 순서대로 구현하고 검증하는 실행 명세

---

## 0. 이 문서를 사용하는 방법

이 문서는 현재 Model Data View의 필터, annotation, aggregate, subquery 조립 기능을 하나의 일관된 Query Builder로 고도화하기 위한 전체 구현 명세다. 구현자는 아래 원칙을 변경하지 않는다.

1. Phase 0부터 순서대로 진행한다.
2. 각 Phase의 테스트와 완료 게이트가 통과하기 전에는 다음 Phase로 넘어가지 않는다.
3. 문서에서 타입, 이름, 상한, UX 동작, 오류 처리, 파일 배치를 확정한 항목은 다른 형태로 재설계하지 않는다.
4. 기존 동작과 새 동작이 충돌하면 이 문서의 “비타협 결정”과 “컴파일 의미론”을 우선한다.
5. 새로운 외부 런타임 의존성이나 UI 프레임워크를 추가하지 않는다.
6. 사용자 데이터에 쓰기 작업을 하지 않는다. 실제 프로젝트 검증에서도 Model Data의 `Commit`을 누르지 않는다.
7. 기존 dirty worktree를 보존한다. 특히 문서 작성 시점에 수정 상태인 아래 파일의 사용자 변경을 덮어쓰지 않는다.
   - `media/modelBrowser.css`
   - `src/modelBrowserHtml.ts`
   - `test/webviewLayoutContract.test.mjs`
8. 모든 코드 파일은 1000줄 이하를 유지한다. JavaScript/TypeScript뿐 아니라 Python loader와 `.pyfrag`에도 같은 상한을 적용한다.
9. 모든 코드 파일 첫 줄에 목적 요약 주석을 둔다.
10. `src/`와 `scripts/`의 모든 class/function/method 앞에는 JSDoc 요약을 둔다.
11. 각 Phase에서 관련 소규모 테스트를 먼저 실행하고, 최종적으로 반드시 `npm run check`를 실행한다.
12. 기능 QA와 브라우저 기반 시각 QA를 별개로 수행한다.

### 0.1 비타협 결정

| ID | 확정 결정 |
|---|---|
| D-01 | 새 기능의 단일 진실 원천은 versioned `ModelQueryRecipeV2`다. DOM, 레거시 `filters[]`, `annotations[]`를 상태 원천으로 삼지 않는다. |
| D-02 | 기본 필터, 계산 열 조건, subquery 조건은 모두 같은 재귀형 predicate AST와 같은 lookup/value 규칙을 사용한다. |
| D-03 | 잘못된 노드나 지원하지 않는 조합은 전체 쿼리를 명시적으로 실패시킨다. 해당 노드만 조용히 버리거나 더 넓은 쿼리로 실행하지 않는다. |
| D-04 | UI가 보낸 `fieldType`, `toMany` 같은 힌트를 신뢰하지 않는다. 실제 Django model graph 또는 extension이 가진 schema에서 다시 계산한다. |
| D-05 | Socket/Auto와 ORM cell은 같은 Recipe를 받아 같은 의미를 만들어야 한다. 두 컴파일러가 필요한 구조는 유지하되 parity corpus로 동등성을 강제한다. |
| D-06 | 단순 조건은 한 줄로 빠르게 만들 수 있어야 하고, 그룹·F 비교·OuterRef·계산식 같은 고급 기능은 같은 Builder 안에서 점진적으로 펼친다. 별도 “간단 모드/고급 모드” 상태를 만들지 않는다. |
| D-07 | 필터 편집 상태는 `draft`, 실제 그리드에 적용된 상태는 `applied`로 분리한다. 편집만으로 데이터 쿼리를 실행하지 않는다. |
| D-08 | `Apply query`가 유일한 일반 실행 경계다. `Clear`는 draft를 비우지만 자동 실행하지 않는다. `Reset draft`는 마지막 applied 상태로 복원한다. |
| D-09 | 기존 VS Code-native 시각 언어, semantic color token, Codicon, 고밀도 레이아웃을 유지한다. 새로운 카드형 대시보드나 별도 디자인 시스템을 만들지 않는다. |
| D-10 | 새 Query Builder는 model mode에만 적용한다. 자유 ORM Query mode의 코드 편집 UX는 이 범위에서 변경하지 않는다. |
| D-11 | raw Annotate는 제거하지 않지만 `Code expression`이라는 Advanced escape hatch로 내린다. 일반적인 Case, Cast, Coalesce, 문자열 함수, 산술식은 구조화 UI로 제공한다. |
| D-12 | Window annotation 결과를 predicate로 거르는 기능은 v2 범위에서 지원하지 않는다. 사용자가 선택하면 적용 전에 `WINDOW_FILTER_UNSUPPORTED` 오류를 보여 준다. 조용히 삭제하지 않는다. |
| D-13 | 정규식 lookup, raw SQL, `.extra()`, 임의 QuerySet method, write query는 v2 구조화 Builder에서 지원하지 않는다. |
| D-14 | Python `@property` 필터는 기존 호환 범위만 유지한다. 루트 AND 아래의 독립 comparison만 허용하고, OR/중첩 그룹/summary/aggregate와 결합하면 실행 전 오류를 낸다. |
| D-15 | summary mode는 명시적인 Result mode다. group-by 유무를 per-row/summary 전환 스위치로 암묵 사용하지 않는다. |
| D-16 | 원격 runtime에는 지금처럼 하나의 합성 Python source를 전달한다. 저장소에서는 1000줄 규칙을 지키기 위해 순서가 고정된 `.pyfrag`로 분할하되, Python module import 경계로 동작을 바꾸지 않고 같은 globals에 합성·실행한다. |
| D-17 | 저장된 쿼리 라이브러리, 팀 공유, URL serialization, telemetry, DB `EXPLAIN` 실행은 이번 범위에 넣지 않는다. |

---

## 1. 목표와 완료 정의

### 1.1 제품 목표

사용자는 Django ORM 문법을 직접 쓰지 않고도 다음을 Model Data View에서 조립할 수 있어야 한다.

1. AND/OR와 그룹 negation이 섞인 중첩 필터
2. 관계를 횡단하는 필터
3. 현재 모델의 다른 필드와 비교하는 `F()` 조건
4. 현재 시각/오늘을 기준으로 한 상대 날짜 조건
5. 조건부 Count/Sum/Avg/Min/Max 계산 열
6. 관계 기반 또는 임의 모델 기반 scalar subquery
7. 관계 또는 임의 모델에 대한 `Exists`
8. 계산 열을 다시 거르는 result filter
9. 구조화된 산술식, 문자열 함수, `Case/When`, `Cast`, `Coalesce`
10. group-by summary와 aggregate 후 필터
11. 생성될 쿼리를 사람이 읽는 문장과 Django ORM 형태로 미리 확인
12. 현재 transport에서 실행할 수 없는 조합을 실행 전에 확인

### 1.2 대표 사용자 시나리오

아래 시나리오는 모두 최종 acceptance corpus와 실제 UI QA에 포함한다.

#### 시나리오 A: 중첩 Boolean 필터

```text
is_demo = false
AND (
  _base_name contains "테스트"
  OR _base_name contains "demo"
)
AND NOT deleted_at is null = false
```

#### 시나리오 B: 필드 대 필드 비교

```text
expires_at < F(renewed_until)
```

#### 시나리오 C: 조건부 관계 Count와 result filter

```text
computed active_member_count =
  Count(members, where members.is_active = true, distinct auto)

result filter:
  active_member_count >= 2
```

#### 시나리오 D: 최신 관련 값 scalar subquery

```text
computed latest_payment_amount =
  from relation payments
  where status = "paid"
  select amount
  order by paid_at desc, pk desc
  first row
```

#### 시나리오 E: Exists 계산 열

```text
computed has_overdue_invoice =
  exists Invoice
  where Invoice.company_id = OuterRef(pk)
    and due_at < now
    and paid_at is null
```

#### 시나리오 F: 구조화 annotation

```text
computed display_name =
  Coalesce(Trim(name), "(unnamed)")

computed health =
  Case(
    when deleted_at is not null then "deleted",
    when is_demo = true then "demo",
    else "active"
  )
```

#### 시나리오 G: 그룹 summary

```text
WHERE deleted_at is null
GROUP BY is_demo
MEASURES:
  row_count = Count(all rows)
  named_count = Count(pk, where _base_name is not blank)
RESULT FILTER:
  row_count >= 2
ORDER BY row_count desc
```

### 1.3 Definition of Done

다음 조건을 모두 만족해야 완료다.

- Query Recipe v2 타입, 정규화, 검증, 컴파일 의미론이 코드와 테스트로 고정되어 있다.
- 기본 필터와 계산 열 조건이 동일한 predicate builder를 사용한다.
- nested AND/OR/group NOT가 Socket과 ORM mode에서 같은 결과를 낸다.
- field RHS, relative time RHS, scalar subquery, Exists, formula, Case가 양쪽 transport에서 같은 결과를 낸다.
- 잘못된 path, alias, lookup, RHS, subquery correlation, fan-out 조합이 실행 전에 구체적 오류를 낸다.
- invalid payload를 backend에 직접 보내도 쿼리가 넓어져 실행되지 않는다.
- Count가 annotation/result filter를 포함한 applied Recipe와 같은 row set을 센다.
- draft/applied 상태와 stale response가 정확히 분리된다.
- wide/split/narrow, dark/light/high contrast, 200% zoom에서 Builder가 잘리지 않고 조작 가능하다.
- 키보드만으로 조건 추가, 그룹 추가, 이동, 제거, 적용, 오류 이동이 가능하다.
- 전체 `npm run check`가 통과한다.
- 실제 `rtcc-poc-page` shell에서 `pm 5` 다음 `./zz django shell`로 초기화한 뒤 read-only 검증이 통과한다.
- README와 사용자 도움말이 새 용어와 기능 한계를 정확히 설명한다.

### 1.4 범위 밖

- Model Data grid 편집/Commit 동작 변경
- 자유 ORM Query editor 재설계
- raw SQL 입력
- write/delete/update query builder
- Django Admin 스타일 저장 필터
- 서버에 저장되는 named query
- 팀 공유/동기화
- 자동 쿼리 실행
- 자동 `EXPLAIN`
- window result filtering
- arbitrary Python expression을 구조화 필터 RHS로 사용
- regex/iregex/search lookup

---

## 2. 현재 구현 기준선

### 2.1 현재 파일 책임

| 파일 | 현재 책임 | 줄 수 기준 | 계획상 처리 |
|---|---|---:|---|
| `media/gridFilter.js` | 평면 filter term, relation path, lookup/value UI, applied chip | 473 | v2 predicate builder로 대체 후 compatibility adapter만 남기거나 삭제 |
| `media/gridColumnConditions.js` | aggregate/annotate/subquery용 1단 all/any 조건 | 285 | 공통 predicate builder로 대체 후 삭제 |
| `media/gridAggregate.js` | `+ Column`, group-by, aggregate/subquery/annotate/window/expr UI | 488 | 계산 열별 purpose module로 분해 후 삭제 |
| `media/gridFieldPath.js` | lazy field tree와 path picker | 167 | 유지·확장 |
| `media/gridCombobox.js` | searchable combobox | 현행 | 유지·접근성 보강 |
| `media/modelBrowserSource.js` | grid와 filter/column wiring, state, apply | 932 | Query controller를 외부 모듈로 추출하여 800줄 이하로 축소 |
| `src/modelBrowserHtml.ts` | filter/column bar DOM shell | 현행 | compact summary band + drawer shell로 교체 |
| `src/modelBrowser.ts` | webview message, applied filters/annotations, paging | 439 | Recipe/revision 저장과 preview/apply routing 추가 |
| `src/modelBackend.ts` | legacy query payload 타입 | 757 | v2 타입은 새 파일로 분리하고 여기서는 import/re-export |
| `src/modelOrm.ts` | legacy ORM cell 재구성 | 965 | 직접 확장하지 않고 새 v2 compiler를 별도 파일에 구현 |
| `src/backendClient.ts` | transport와 model endpoint routing | 996 | 줄 수를 늘리지 않도록 import/호출 교체만 수행 |
| `python/django_shell_backend.py` | Socket/PTY backend 전체와 model query 실행 | 5456 | 작은 local loader로 바꾸고 ordered fragments를 한 globals source로 합성 |
| `test/modelBrowserFilters.test.mjs` | lookup/transform/filter UI와 transport | 218 | legacy regression으로 유지 |
| `test/modelColumnConditions.test.mjs` | flat condition group/F/OuterRef/security | 251 | legacy regression으로 유지하고 v2 corpus 별도 추가 |

### 2.2 현재 데이터 흐름

```text
filter DOM / +Column DOM
        │ collect()
        ▼
state.filters[] + state.annotations[] + aggregateGroupBy[]
        │ webview message
        ▼
ModelBrowserPanel
        ├─ Socket/Auto → python/django_shell_backend.py
        └─ ORM        → src/modelOrm.ts → literal ORM cell
        │
        ▼
rows / aggregate result → grid
```

현재는 DOM이 실질적인 draft state이며, filter와 계산 열이 서로 다른 payload 구조를 만든다. Socket compiler와 ORM compiler도 서로 별도 규칙으로 같은 구조를 해석한다.

### 2.3 현재 지원 기능

#### 기본 filter bar

- 모든 term의 암묵적 AND
- term 단위 negate
- concrete field, `pk`, computed `@property`, relation terminal, relation traversal
- annotation/aggregate alias의 post-annotation filter
- type-aware lookup
- choice/boolean select
- range input
- `in` chips
- `isnull`
- text `length`/`trim`
- date/time extract
- applied chip 개별 제거

#### 계산 열

- per-row aggregate: Count/Sum/Avg/Min/Max
- scalar Subquery
  - direct relation mode
  - arbitrary model mode
  - 한 개의 주 correlation
  - 조건에서 `OuterRef`
  - 최대 3 order term을 backend가 수용하지만 UI는 사실상 1개만 제공
- raw Annotate expression
- Window
- binary F arithmetic
- 계산 열별 flat `all`/`any` condition group, 최대 8개
- 조건 RHS literal, `F`, subquery 내부 `OuterRef`
- group-by summary
- aggregate alias에 대한 HAVING

#### 안전 장치

- lookup allowlist
- live model path validation(Socket)
- identifier/문자열 allowlist(ORM reconstruction)
- annotation AST 제한(Socket)
- annotation text 제한(ORM)
- to-many Count의 distinct 강제
- non-Count to-many aggregate drop
- raw annotation 길이 800
- condition 최대 8
- annotation 최대 12
- aggregate 최대 20
- group-by 최대 8
- subquery order 최대 3

### 2.4 현재 기준 테스트

문서 작성 시 아래 테스트를 실제로 실행했고 12개 모두 통과했다.

```bash
node --test test/modelBrowserFilters.test.mjs test/modelColumnConditions.test.mjs
```

이 테스트들은 제거하거나 약화하지 않는다. v2 구현 중 legacy adapter가 존재하는 동안 계속 통과해야 한다.

---

## 3. 현재 한계 분석

### 3.1 기본 필터 한계

| ID | 한계 | 코드 근거 | 사용자 영향 | v2 결정 |
|---|---|---|---|---|
| F-01 | 모든 filter가 평면 AND | `gridFilter.collect()`가 배열만 반환, `_browse_filter_parts()`가 `query &= clause` | OR 또는 `(A AND (B OR C))` 불가 | 재귀 group AST |
| F-02 | term negate만 있고 group NOT가 없음 | 각 term의 `negate` checkbox | De Morgan 변환을 사용자가 직접 풀어야 함 | group과 leaf 모두 `negated` |
| F-03 | incomplete term이 조용히 제외됨 | `gridFilter.collect()`의 `continue` | 화면에는 조건이 있는데 더 넓은 query가 실행될 수 있음 | 하나라도 incomplete이면 Apply 비활성 + inline error |
| F-04 | invalid backend term이 조용히 drop됨 | `_browse_filter_parts()`와 `filterPlan()`의 `continue` | typo/변조 payload가 필터 없는 query로 넓어짐 | whole-recipe validation failure |
| F-05 | 기본 filter RHS는 literal만 가능 | `BackendModelFilter.value` | `expires_at < F(renewed_until)` 불가 | 공통 RHS AST에서 field 지원 |
| F-06 | 같은 related row를 뜻하는 복합 조건을 명시하기 어려움 | relation path term의 평면 AND | 다중 관계 조건의 join 의미를 이해하기 어려움 | relation Exists node로 동일 related-row 범위 제공 |
| F-07 | draft와 applied가 분리되지 않음 | DOM + `state.filters` 혼합 | 현재 grid가 어떤 조건인지 불명확 | immutable draft/applied store |
| F-08 | annotation alias가 첫 실행 후에만 filter option에 나타남 | aggregate response 뒤 `filterBar.refresh()` | 계산 열을 만들고 다시 Apply해야 발견 가능 | draft computed alias를 즉시 result-filter option에 노출 |
| F-09 | Count가 annotation/result filter를 재현하지 못함 | `requestCount()`가 `annotations` 없이 `filters`만 전달 | 화면 row set과 Count가 다를 수 있음 | Count가 전체 applied Recipe 사용 |
| F-10 | window alias filter가 조용히 drop됨 | `_browse_split_having()` | 사용자는 조건이 적용됐다고 오해 | 실행 전 명시 오류 |
| F-11 | Python `@property`는 full scan이며 aggregate와 결합 불가 | `_browse_python_filter_iter()`, aggregate의 property filter error | 느린 query와 기능 차이가 UI에 늦게 나타남 | 사전 cost warning + 조합 제한 |
| F-12 | Socket과 ORM path 검증 강도가 다름 | Socket은 live graph, ORM은 일부 lexical `safeFilterPath()` | transport 변경 시 결과/오류가 달라질 수 있음 | 공통 corpus + strict recipe validation |
| F-13 | 값이 comma string으로 직렬화됨 | range/in `join(",")`, backend split | comma가 포함된 문자열을 정확히 표현할 수 없음 | list/range를 구조화 JSON 값으로 전송 |
| F-14 | ORM condition compiler가 UI의 `fieldType`/`toMany`를 신뢰 | `conditionGroupExpr()` | 변조/오판 metadata가 coercion/distinct에 영향 | compiler가 schema에서 재계산 |
| F-15 | traversal이면 ORM mode에서 무조건 distinct | `path.includes("__")` | 불필요한 DISTINCT와 성능 저하 | relation cardinality 기반 결정 |
| F-16 | query cost/implicit distinct/full scan을 적용 전에 모름 | status는 실행 뒤 표시 | 위험한 query를 미리 판단하기 어려움 | static warnings와 ORM preview |
| F-17 | null과 blank를 함께 찾는 쉬운 연산자가 없음 | exact/isnull을 별도 term으로 만들어야 함 | 일반적인 “비어 있음” 조건이 번거로움 | text 전용 `blank`/`not_blank` semantic lookup |
| F-18 | relative date/time이 없음 | date input은 절대 값만 | “최근 7일”을 매번 계산해야 함 | structured relative time RHS |
| F-19 | 필터 구조 키보드 조작이 없음 | flat inline term만 존재 | 그룹 이동/복제/정렬 불가 | add group, move, duplicate에 button과 shortcut |
| F-20 | inline flex wrap이 복잡한 조건에서 읽히지 않음 | `.filterbar`, `.term` flex-wrap | 좁은 editor group에서 시각적 순서 붕괴 | summary band + bounded drawer |

### 3.2 Annotation/Aggregate 한계

| ID | 한계 | 현재 동작 | v2 결정 |
|---|---|---|---|
| C-01 | 기본 filter와 계산 열 condition이 중복 구현 | `gridFilter.js`와 `gridColumnConditions.js`의 lookup/value 로직 중복 | 같은 predicate component와 schema 사용 |
| C-02 | condition은 한 단계 all/any, 최대 8 | nested group 불가 | 공통 재귀 group, 전체 node 한도 적용 |
| C-03 | invalid condition이면 column spec이 조용히 사라짐 | backend/compiler가 해당 spec `continue` | 적용 전 node-local error, whole recipe 실패 |
| C-04 | 잘못된/중복 alias를 자동 치환 | `_browse_agg_alias()`, `aggregateAlias()` | 사용자가 요청한 이름과 실제 column이 다름 | alias는 수정 요구, 자동 rename 금지 |
| C-05 | raw Annotate가 일반 annotation 기능의 주 escape hatch | 코드 문자열을 직접 입력 | structured Formula/Case 제공, raw는 Advanced |
| C-06 | Expr는 binary `left op right`만 가능 | concrete field 또는 number | 재귀 expression AST |
| C-07 | 계산 열 간 의존성을 표현하지 못함 | alias를 다음 계산식 picker에서 선택 불가 | 앞선 alias reference 지원, 순서로 dependency 고정 |
| C-08 | output type을 제어할 수 없음 | Django 추론에 의존 | Formula/Subquery에 `outputType` |
| C-09 | per-row structured Exists column이 없음 | global aggregate exists 또는 raw code만 가능 | `ExistsColumn` 추가 |
| C-10 | custom Subquery 주 correlation이 정확히 1개 | target field = current field | 1~4 equality correlations |
| C-11 | subquery order가 UI에서 1개뿐이고 fallback이 숨겨짐 | backend는 최대 3, 빈 경우 pk fallback | 최대 3개 UI, fallback pk를 summary에 표시 |
| C-12 | relation correlation 규칙이 UI에 보이지 않음 | relation metadata로 자동 생성 | read-only “correlated by …” row 표시 |
| C-13 | scalar field 선택만 가능 | correlated aggregate subquery 불가 | field 또는 aggregate select |
| C-14 | condition과 mandatory correlation의 논리 경계가 불명확 | backend는 correlation을 OR 밖에 유지하지만 UI 표현 부족 | correlation section을 고정 영역으로 분리 |
| C-15 | to-many Sum/Avg/Min/Max가 UI에서 drop | `droppedToMany` status | Apply 전 `AGGREGATE_FANOUT_UNSAFE` error |
| C-16 | group-by를 넣으면 비-aggregate term을 무시 | `terms.filter(kind === "aggregate")` | explicit summary mode에서 허용 kind 검증 |
| C-17 | max 12 annotation/max 20 aggregate가 UI에 드러나지 않음 | backend에서 잘림 | 한도를 UI와 shared constants에 표시 |
| C-18 | 조건부 raw Annotate는 항상 else `NULL` | 고정 `Case/When(..., default=None)` | structured Case에 명시적 branches/else |
| C-19 | disable/reorder/duplicate가 없음 | DOM 순서와 삭제만 | 계산 열 enable, move up/down, duplicate |
| C-20 | raw expression 안전 규칙이 transport마다 다름 | Socket AST vs ORM regex | 공통 허용 corpus, transport-specific 차이는 validation error |
| C-21 | formula/subquery의 생성 ORM을 실행 전에 볼 수 없음 | Query Log는 실행 뒤 | human summary + extension-host ORM preview |
| C-22 | builder 상태가 DOM 내부 `_read` 함수에 갇힘 | serialize/import/diff 불가 | Recipe store가 state 원천 |
| C-23 | subquery empty result 처리 선택이 없음 | 항상 null | `onEmpty: null | literal` |
| C-24 | summary/global/row semantics가 group-by 유무에 암묵 결합 | group-by가 없으면 per-row | explicit `mode` |

### 3.3 교차 기능 한계

1. `LOOKUPS`, label, field-type matrix가 UI, TypeScript compiler, Python backend에 중복되어 drift 가능성이 있다.
2. 조건 실패가 “오류”와 “조용한 drop”으로 섞여 있어 결과 신뢰성이 떨어진다.
3. query state에 version이 없어 payload migration이나 저장/복원을 안전하게 할 수 없다.
4. query 적용 중 draft가 바뀌었을 때 어떤 snapshot의 결과인지 명시하는 revision이 없다.
5. field tree fetch failure 시 flat fallback이 기능 감소를 조용히 만든다.
6. summary, rows, count, computed-property fetch가 같은 query를 서로 다른 인자로 재구성한다.
7. 현재 `modelBrowserSource.js`, `modelOrm.ts`, `backendClient.ts`가 1000줄에 근접해 직접 확장할 수 없다.

---

## 4. 목표 UX

### 4.1 디자인 방향

Query Builder는 “VS Code 안의 고밀도 ORM workbench”로 보인다.

- 배경, 전경, border, focus, warning, error, selection은 VS Code semantic token만 사용한다.
- 기본 화면에는 적용된 query의 핵심 상태만 한 줄로 유지한다.
- 복잡한 구조는 drawer에서 세로 계층으로 보여 inline wrap 붕괴를 막는다.
- 코드 문법보다 사용자 의도를 먼저 보여 주되, ORM preview를 숨기지 않는다.
- 중요 상태는 색상만으로 전달하지 않고 text/icon/ARIA를 함께 사용한다.
- 필드·연산자·값은 기존 searchable combobox와 type-aware editor를 재사용한다.

### 4.2 정보 구조

```text
┌ Query summary band ─────────────────────────────────────────────────────────┐
│ [Filter 4] [Columns 2] [Summary]  human-readable summary…  Draft  [Apply] │
└─────────────────────────────────────────────────────────────────────────────┘

┌ Query Builder drawer ───────────────────────────────────────────────────────┐
│ WHERE rows                                                                 │
│   All  [condition]                                                         │
│        └ Any [condition] [condition]                                       │
│                                                                            │
│ COMPUTED COLUMNS                                                           │
│   1. active_member_count  Aggregate …                                      │
│   2. latest_payment_amount Scalar subquery …                               │
│                                                                            │
│ RESULT FILTER                                                              │
│   active_member_count >= 2                                                 │
│                                                                            │
│ RESULT                                                                     │
│   Rows | Summary      Group by …      Order by …                           │
│                                                                            │
│ PREVIEW / VALIDATION                                                       │
│   ✓ Valid · auto DISTINCT · correlated subquery                            │
│   Company._base_manager.filter(...).annotate(...)                          │
│                                              [Reset draft] [Clear] [Apply] │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Summary band 계약

항상 표시한다.

| 요소 | 동작 |
|---|---|
| `Filter N` | drawer를 열고 WHERE section으로 focus |
| `Columns N` | drawer를 열고 Computed Columns section으로 focus |
| `Rows` 또는 `Summary` | drawer를 열고 Result section으로 focus |
| human summary | 한 줄 ellipsis, hover/focus tooltip에 전체 문장 |
| `Draft` | draft와 applied가 다를 때만 text + modified icon 표시 |
| validation badge | `Valid`, `N errors`, `N warnings`, `Checking…` |
| `Apply query` | valid하고 metadata loading이 없을 때만 활성 |
| drawer toggle | `aria-expanded`, `aria-controls` 제공 |

Applied query가 비어 있으면 summary는 `All rows · no computed columns · default order`다.

### 4.4 Drawer section 계약

#### WHERE rows

- root group은 삭제할 수 없다.
- root group의 기본 join은 `All (AND)`다.
- 빈 root group은 “All rows”를 뜻한다.
- 각 group header:
  - `All (AND)` / `Any (OR)` select
  - `Not` toggle
  - `+ Condition`
  - `+ Group`
  - nested group만 remove 가능
- 각 comparison row:
  - LHS path
  - lookup
  - RHS kind
  - RHS editor
  - Not
  - duplicate
  - move up/down
  - remove
- relation Exists row:
  - `Exists` 또는 `Does not exist`
  - relation/model source
  - 고정 correlation
  - nested target predicate

#### Computed Columns

- header에 `+ Computed column`.
- 각 item은 한 줄 header와 펼침 body를 가진다.
- header:
  - enabled checkbox
  - alias
  - kind
  - compact description
  - move up/down
  - duplicate
  - remove
  - expand/collapse
- alias는 입력 즉시 검증한다.
- kind 목록과 순서는 고정한다.
  1. Aggregate
  2. Scalar subquery
  3. Exists
  4. Formula
  5. Window
  6. Code expression
- `Code expression` 옆에 `Advanced` tag와 “restricted Django expression” helper를 표시한다.

#### RESULT FILTER

- WHERE와 같은 predicate builder를 사용한다.
- LHS option은 group field와 enabled computed alias만 제공한다.
- window alias는 option에서 disabled 상태로 표시하며 이유를 tooltip/helper에 쓴다.
- 빈 group은 result filter 없음이다.

#### RESULT

- mode segmented control: `Rows`, `Summary`.
- Rows:
  - group-by control 숨김
  - sort field는 concrete field 또는 computed alias
- Summary:
  - group-by 0~8
  - group-by 0이면 global summary
  - enabled computed kind가 허용 범위를 벗어나면 inline error
  - sort field는 group field 또는 summary alias
- 기존 page size는 footer에 계속 두며 Recipe에 넣지 않는다.

#### PREVIEW / VALIDATION

- 기본은 human summary를 항상 표시한다.
- ORM preview는 monospace, read-only, wrapping 가능, 최대 높이 160px 후 내부 scroll.
- 오류는 error summary와 node inline message 양쪽에 표시한다.
- error summary 항목을 누르면 해당 node를 펼치고 첫 invalid control로 focus한다.
- warning은 Apply를 막지 않는다.
- `Copy ORM`은 preview가 valid할 때만 활성화한다.

### 4.5 Draft/Applied 상태 전이

| 이벤트 | draft | applied | query 실행 |
|---|---|---|---|
| drawer control 편집 | 변경 | 유지 | 없음 |
| `Reset draft` | applied deep clone | 유지 | 없음 |
| `Clear` | empty Recipe | 유지 | 없음 |
| `Apply query` 시작 | snapshot 유지 | 유지 | snapshot 실행 |
| Apply 성공, 편집 없음 | snapshot | snapshot | 결과 표시 |
| Apply 성공, 실행 중 추가 편집 | 최신 편집 유지 | 실행 snapshot | 결과 표시 + Draft 유지 |
| Apply 실패 | 유지 | 유지 | 기존 grid 유지, 오류 표시 |
| panel reload/runtime reconnect | applied 재실행, draft 유지 | 유지 | applied만 실행 |

`Apply` 실행마다 `revision`을 증가시킨다. rows/aggregate/count/preview response에는 revision을 포함하고, 현재 요청보다 오래된 response는 무시한다.

### 4.6 Keyboard 계약

| 키 | 동작 |
|---|---|
| `Ctrl/Cmd+Enter` | drawer 안에서 valid draft Apply |
| `Alt+Shift+↑/↓` | 현재 predicate/computed/order item 이동 |
| `Ctrl/Cmd+D` | 현재 predicate/computed item duplicate |
| `Delete` | 전용 remove button에 focus된 경우 제거 |
| `Escape` | 열린 combobox/listbox를 먼저 닫음; drawer 자체는 닫지 않음 |
| `Enter`/`Space` | toggle/button 동작 |
| error summary `Enter` | 오류 node focus |

이동/복제는 shortcut만 제공하지 않고 항상 같은 이름의 button을 제공한다.

### 4.7 Responsive 계약

#### Wide: 960px 이상

- drawer content와 preview를 65/35 2-column으로 배치한다.
- left column에 WHERE/Computed/Result Filter/Result.
- right column의 Preview/Validation은 drawer 안에서 sticky top.

#### Split: 640~959px

- 모든 section을 단일 column으로 쌓는다.
- Preview는 접을 수 있지만 validation status와 error count는 계속 보인다.
- comparison row는 LHS/lookup/RHS를 두 줄까지 wrap한다.

#### Narrow: 639px 이하

- summary band를 2줄로 허용한다.
- 각 comparison row를 1-column grid로 전환한다.
- 구조 action은 row 마지막에 한 줄로 모은다.
- drawer action footer는 viewport 아래가 아니라 drawer 하단에 sticky.
- horizontal nested scroll을 만들지 않는다.

### 4.8 상태별 UI

| 상태 | 표시와 동작 |
|---|---|
| metadata loading | 해당 picker skeleton text `Loading fields…`, Apply disabled |
| metadata error | node inline error + `Retry`, flat fallback으로 조용히 축소하지 않음 |
| empty WHERE | `All rows` 설명 + `Add condition` |
| empty computed | `No computed columns` + add button |
| invalid | error border/token + cause + fix, Apply disabled |
| warning | warning icon/text, Apply enabled |
| validating | summary badge `Checking…`, stale validation 무시 |
| applying | `Applying query…` elapsed status, Apply disabled, edit는 허용 |
| success | applied snapshot 갱신, polite live announcement |
| backend failure | 기존 grid 유지, drawer error summary + Retry |
| transport unsupported | node error에 transport와 가능한 해결책 표시 |
| disabled computed | opacity만 쓰지 않고 `Disabled` text, downstream reference error |
| long path/alias | ellipsis + full accessible name/title |
| limit reached | add button disabled + “Maximum N” helper |

---

## 5. Query Recipe v2 계약

### 5.1 TypeScript 기준 타입

아래 타입을 `src/modelQueryRecipe.ts`에 그대로 구현한다. 이름이나 field 의미를 바꾸지 않는다.

```ts
export const MODEL_QUERY_RECIPE_VERSION = 2 as const;

export type QueryScalar = string | number | boolean | null;
export type QueryJoin = "and" | "or";
export type QueryOutputType =
  | "auto"
  | "boolean"
  | "integer"
  | "float"
  | "decimal"
  | "text"
  | "date"
  | "datetime"
  | "time"
  | "duration"
  | "uuid";

export interface QueryModelRef {
  app: string;
  model: string;
}

export interface QueryFieldRef {
  kind: "field";
  path: string;
}

export interface QueryComputedRef {
  alias: string;
  kind: "computed";
}

export type QueryValueRef = QueryFieldRef | QueryComputedRef;

export interface QueryLiteralRhs {
  kind: "literal";
  value: QueryScalar;
}

export interface QueryListRhs {
  kind: "list";
  values: QueryScalar[];
}

export interface QueryRangeRhs {
  kind: "range";
  lower: QueryScalar;
  upper: QueryScalar;
}

export interface QueryFieldRhs {
  kind: "field";
  path: string;
}

export interface QueryOuterFieldRhs {
  kind: "outerField";
  path: string;
}

export interface QueryRelativeTimeRhs {
  amount: number;
  anchor: "now" | "today";
  direction: "past" | "future";
  kind: "relativeTime";
  unit: "minutes" | "hours" | "days" | "weeks";
}

export type QueryComparisonRhs =
  | QueryLiteralRhs
  | QueryListRhs
  | QueryRangeRhs
  | QueryFieldRhs
  | QueryOuterFieldRhs
  | QueryRelativeTimeRhs;

export interface QueryPredicateGroup {
  children: QueryPredicateNode[];
  join: QueryJoin;
  kind: "group";
  negated: boolean;
  nodeId: string;
}

export interface QueryComparisonNode {
  kind: "comparison";
  lhs: QueryValueRef;
  lookup: string;
  negated: boolean;
  nodeId: string;
  rhs: QueryComparisonRhs;
}

export interface QueryCorrelation {
  nodeId: string;
  outerPath: string;
  targetPath: string;
}

export type QuerySubquerySource =
  | { kind: "relation"; relation: string }
  | { kind: "model"; target: QueryModelRef };

export interface QueryExistsPredicateNode {
  correlations: QueryCorrelation[];
  kind: "existsPredicate";
  negated: boolean;
  nodeId: string;
  source: QuerySubquerySource;
  where: QueryPredicateGroup;
}

export type QueryPredicateNode =
  | QueryPredicateGroup
  | QueryComparisonNode
  | QueryExistsPredicateNode;

export interface QueryComputedBase {
  alias: string;
  enabled: boolean;
  nodeId: string;
}

export interface QueryAggregateColumn extends QueryComputedBase {
  distinct: "auto" | "always";
  field: QueryFieldRef | { kind: "all" };
  filter: QueryPredicateGroup;
  function: "count" | "sum" | "avg" | "min" | "max";
  kind: "aggregate";
}

export interface QuerySubqueryFieldSelect {
  field: QueryFieldRef;
  kind: "field";
}

export interface QuerySubqueryAggregateSelect {
  distinct: "auto" | "always";
  field: QueryFieldRef | { kind: "all" };
  function: "count" | "sum" | "avg" | "min" | "max";
  kind: "aggregate";
}

export type QuerySubquerySelect =
  | QuerySubqueryFieldSelect
  | QuerySubqueryAggregateSelect;

export interface QueryOrderTerm {
  direction: "asc" | "desc";
  nodeId: string;
  ref: QueryValueRef;
}

export interface QueryScalarSubqueryColumn extends QueryComputedBase {
  correlations: QueryCorrelation[];
  kind: "scalarSubquery";
  onEmpty: QueryLiteralRhs;
  orderBy: QueryOrderTerm[];
  outputType: QueryOutputType;
  select: QuerySubquerySelect;
  source: QuerySubquerySource;
  where: QueryPredicateGroup;
}

export interface QueryExistsColumn extends QueryComputedBase {
  correlations: QueryCorrelation[];
  kind: "exists";
  source: QuerySubquerySource;
  where: QueryPredicateGroup;
}

export type QueryFormulaNode =
  | { kind: "field"; path: string }
  | { alias: string; kind: "computed" }
  | { kind: "literal"; value: QueryScalar }
  | {
      kind: "binary";
      left: QueryFormulaNode;
      operator: "+" | "-" | "*" | "/" | "%";
      right: QueryFormulaNode;
    }
  | {
      args: QueryFormulaNode[];
      function:
        | "coalesce"
        | "concat"
        | "greatest"
        | "least"
        | "lower"
        | "upper"
        | "trim"
        | "length";
      kind: "function";
    }
  | {
      branches: Array<{
        then: QueryFormulaNode;
        when: QueryPredicateGroup;
      }>;
      else: QueryFormulaNode;
      kind: "case";
    }
  | {
      expression: QueryFormulaNode;
      kind: "cast";
      outputType: Exclude<QueryOutputType, "auto">;
    };

export interface QueryFormulaColumn extends QueryComputedBase {
  expression: QueryFormulaNode;
  kind: "formula";
  outputType: QueryOutputType;
}

export interface QueryWindowColumn extends QueryComputedBase {
  field?: QueryFieldRef;
  function:
    | "rank"
    | "dense_rank"
    | "row_number"
    | "sum"
    | "avg"
    | "min"
    | "max"
    | "count";
  kind: "window";
  orderBy: QueryOrderTerm[];
  partitionBy: QueryFieldRef[];
}

export interface QueryCodeExpressionColumn extends QueryComputedBase {
  expression: string;
  kind: "codeExpression";
  outputType: QueryOutputType;
  when: QueryPredicateGroup;
}

export type QueryComputedColumn =
  | QueryAggregateColumn
  | QueryScalarSubqueryColumn
  | QueryExistsColumn
  | QueryFormulaColumn
  | QueryWindowColumn
  | QueryCodeExpressionColumn;

export interface ModelQueryRecipeV2 {
  computed: QueryComputedColumn[];
  groupBy: QueryFieldRef[];
  mode: "rows" | "summary";
  orderBy: QueryOrderTerm[];
  postFilter: QueryPredicateGroup;
  source: QueryModelRef;
  version: typeof MODEL_QUERY_RECIPE_VERSION;
  where: QueryPredicateGroup;
}
```

### 5.2 Empty Recipe

`createEmptyModelQueryRecipe(source)`는 항상 아래 shape를 만든다.

```json
{
  "version": 2,
  "source": { "app": "db", "model": "Company" },
  "mode": "rows",
  "where": {
    "kind": "group",
    "nodeId": "where-root",
    "join": "and",
    "negated": false,
    "children": []
  },
  "computed": [],
  "postFilter": {
    "kind": "group",
    "nodeId": "post-root",
    "join": "and",
    "negated": false,
    "children": []
  },
  "groupBy": [],
  "orderBy": []
}
```

root ID는 위 값을 고정한다. 새 child ID는 webview store의 monotonic counter로 `q-1`, `q-2`, …를 생성한다. import/backend payload에서는 ID 순서에 의미를 부여하지 않는다.

### 5.3 Full 예시

```json
{
  "version": 2,
  "source": { "app": "db", "model": "Company" },
  "mode": "rows",
  "where": {
    "kind": "group",
    "nodeId": "where-root",
    "join": "and",
    "negated": false,
    "children": [
      {
        "kind": "comparison",
        "nodeId": "q-1",
        "lhs": { "kind": "field", "path": "deleted_at" },
        "lookup": "isnull",
        "rhs": { "kind": "literal", "value": true },
        "negated": false
      },
      {
        "kind": "group",
        "nodeId": "q-2",
        "join": "or",
        "negated": false,
        "children": [
          {
            "kind": "comparison",
            "nodeId": "q-3",
            "lhs": { "kind": "field", "path": "_base_name" },
            "lookup": "icontains",
            "rhs": { "kind": "literal", "value": "테스트" },
            "negated": false
          },
          {
            "kind": "comparison",
            "nodeId": "q-4",
            "lhs": { "kind": "field", "path": "is_demo" },
            "lookup": "exact",
            "rhs": { "kind": "literal", "value": true },
            "negated": false
          }
        ]
      }
    ]
  },
  "computed": [
    {
      "kind": "scalarSubquery",
      "nodeId": "q-5",
      "alias": "self_name",
      "enabled": true,
      "source": {
        "kind": "model",
        "target": { "app": "db", "model": "Company" }
      },
      "correlations": [
        {
          "nodeId": "q-6",
          "targetPath": "id",
          "outerPath": "id"
        }
      ],
      "where": {
        "kind": "group",
        "nodeId": "q-7",
        "join": "and",
        "negated": false,
        "children": []
      },
      "select": {
        "kind": "field",
        "field": { "kind": "field", "path": "_base_name" }
      },
      "orderBy": [
        {
          "nodeId": "q-8",
          "ref": { "kind": "field", "path": "id" },
          "direction": "asc"
        }
      ],
      "onEmpty": { "kind": "literal", "value": null },
      "outputType": "text"
    }
  ],
  "postFilter": {
    "kind": "group",
    "nodeId": "post-root",
    "join": "and",
    "negated": false,
    "children": [
      {
        "kind": "comparison",
        "nodeId": "q-9",
        "lhs": { "kind": "computed", "alias": "self_name" },
        "lookup": "not_blank",
        "rhs": { "kind": "literal", "value": null },
        "negated": false
      }
    ]
  },
  "groupBy": [],
  "orderBy": [
    {
      "nodeId": "q-10",
      "ref": { "kind": "field", "path": "id" },
      "direction": "asc"
    }
  ]
}
```

---

## 6. Lookup와 값 의미론

### 6.1 Canonical lookup 목록

| 범주 | lookup |
|---|---|
| 공통 equality | `exact`, `in`, `isnull` |
| ordered | `gt`, `gte`, `lt`, `lte`, `range` |
| text | `iexact`, `contains`, `icontains`, `startswith`, `istartswith`, `endswith`, `iendswith`, `blank`, `not_blank` |
| text transform | `trim`, `length`, `length__gt`, `length__gte`, `length__lt`, `length__lte` |
| date/datetime/time | `date`, `year`, `quarter`, `month`, `week_day`, `day`, `hour`, `minute`, `second` |

lookup allowlist는 늘리지 않는다. 특히 `regex`, `iregex`, `search`를 추가하지 않는다.

### 6.2 Type별 lookup

| Django field category | lookup |
|---|---|
| Boolean | `exact`, `isnull` |
| Numeric/Auto/Decimal | `exact`, `gt`, `gte`, `lt`, `lte`, `in`, `range`, `isnull` |
| Char/Text 계열 | equality + text + text transform + `in` + `isnull` |
| UUID/IP/Duration/File generic text-like | equality + text 비교 + `in` + `isnull`, 단 `length`/`trim` 제외 |
| DateTime | ordered + range + date/extract + `isnull` |
| Date | ordered + range + year/quarter/month/week_day/day + `isnull` |
| Time | ordered + range + hour/minute/second + `isnull` |
| relation terminal | `isnull`만 |
| computed alias | compiler가 추론한 output type의 lookup |
| unknown output type | `exact`, `in`, `isnull`만 |

### 6.3 RHS 허용 규칙

| lookup | literal | list | range | field | outerField | relativeTime |
|---|---:|---:|---:|---:|---:|---:|
| `in` | 아니오 | 예 | 아니오 | 아니오 | 아니오 | 아니오 |
| `range` | 아니오 | 아니오 | 예 | 아니오 | 아니오 | 아니오 |
| `isnull` | boolean만 | 아니오 | 아니오 | 아니오 | 아니오 | 아니오 |
| `blank`, `not_blank` | 값 무시 | 아니오 | 아니오 | 아니오 | 아니오 | 아니오 |
| date/time ordered/equality | 예 | 아니오 | 아니오 | type-compatible field | subquery scope만 | 예 |
| 나머지 비교 | 예 | 아니오 | 아니오 | type-compatible field | subquery scope만 | 아니오 |

### 6.4 `blank`/`not_blank`

text field에만 제공한다.

```py
# blank
Q(field__isnull=True) | Q(field__exact="")

# not_blank
~(Q(field__isnull=True) | Q(field__exact=""))
```

field가 `null=False`여도 같은 식을 유지한다. database optimizer가 불가능한 null branch를 제거하도록 둔다.

### 6.5 Relative time

```text
anchor now   → django.db.models.functions.Now()
anchor today → 현재 Django timezone의 오늘 00:00
direction past   → anchor - timedelta(...)
direction future → anchor + timedelta(...)
```

- `today`는 backend에서 `timezone.localdate()`와 현재 timezone을 사용해 aware midnight를 만든다.
- unit은 minutes/hours/days/weeks만 허용한다.
- amount는 1~10000 정수다.
- DateField LHS에서 `now`를 선택하면 validation error를 내고 `today`를 사용하도록 안내한다.
- TimeField에는 relative time을 허용하지 않는다.
- ORM cell은 `timezone.now()`를 호출하지 않고 DB-side `models.functions.Now()`를 사용한다. `today`만 Python literal 날짜/시간으로 생성할 수 있다.

ORM execution cell은 plain REPL single-line을 유지하기 위해 relative time이 있을 때만 아래 trusted wrapper를 사용한다.

```py
(lambda __djs_dt, __djs_tz: QUERY)(
    __import__("datetime"),
    __import__("django.utils.timezone", fromlist=["timezone"]),
)
```

실제 execution cell에서는 위 표현을 한 줄로 emit한다.

- `now ± amount`는 `models.functions.Now() ± models.Value(__djs_dt.timedelta(...))`.
- DateField의 `today ± amount`는 `__djs_tz.localdate() ± __djs_dt.timedelta(...)`.
- DateTimeField의 `today ± amount`는 `__djs_tz.make_aware(__djs_dt.datetime.combine(__djs_tz.localdate(), __djs_dt.time.min), __djs_tz.get_current_timezone()) ± __djs_dt.timedelta(...)`.
- generated wrapper의 `__import__`는 compiler가 고정 문자열로만 만든다. Recipe/raw expression에서 `__import__`를 입력하는 것은 계속 금지한다.

### 6.6 Value coercion

1. UI는 typed control 값을 Recipe scalar/list/range로 만든다.
2. TypeScript validator는 명백한 shape/type 오류를 잡는다.
3. Python backend는 live Django field의 `to_python()`과 lookup 규칙으로 다시 검증한다.
4. string `"1"`을 자동 boolean으로 해석하지 않는다.
5. Boolean control은 실제 JSON boolean을 전송한다.
6. numeric input은 finite JSON number를 전송한다.
7. Decimal은 정밀도 손실을 피하기 위해 string을 유지하고 backend가 `Decimal`로 변환한다.
8. Date/DateTime/Time은 ISO string을 유지한다.
9. UUID는 string을 유지한다.
10. `in`은 최대 200개 scalar, `range`는 정확히 2개 scalar다.

---

## 7. Validation과 안전 계약

### 7.1 고정 상한

`src/modelQueryRecipeLimits.ts`, webview, Python backend에 같은 값을 두고 parity test로 고정한다.

| 제한 | 값 |
|---|---:|
| serialized Recipe UTF-8 | 64 KiB |
| 전체 predicate node | 64 |
| root 포함 group depth | 5 |
| 한 group의 직접 children | 16 |
| computed columns | 12 |
| group-by fields | 8 |
| outer order terms | 8 |
| subquery correlations | 4 |
| subquery order terms | 3 |
| formula nodes | 32 |
| formula depth | 6 |
| Case branches | 8 |
| `in` values | 200 |
| path characters | 240 |
| path segments | 12 |
| alias characters | 64 |
| literal string characters | 4096 |
| raw code expression characters | 800 |
| generated ORM cell characters | 32768 |

### 7.2 Alias 규칙

alias는 다음을 모두 만족해야 한다.

- regex: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`
- Python keyword가 아님
- `djs_`로 시작하지 않음
- `__`로 시작하지 않음
- source concrete field, relation query name, computed property와 충돌하지 않음
- 다른 enabled computed alias와 중복되지 않음

compiler는 alias를 자동 수정하지 않는다. 오류와 수정 방법을 반환한다.

### 7.3 Path 규칙

- 모든 path segment는 실제 live model graph에서 resolve되어야 한다.
- relation terminal은 `isnull` 또는 relation source 선택에만 쓸 수 있다.
- normal comparison/selection/order/group-by는 scalar leaf로 끝나야 한다.
- group-by와 non-Count aggregate는 to-many traversal을 허용하지 않는다.
- Count는 to-many traversal 시 `distinct="auto"`라도 강제로 distinct 처리하고 warning을 낸다.
- TypeScript ORM compiler도 backend가 제공한 field tree metadata로 cardinality를 계산한다.
- metadata가 없으면 path를 lexical fallback으로 실행하지 않고 `FIELD_METADATA_UNAVAILABLE` 오류를 낸다.

### 7.4 Validation issue 타입

```ts
export interface ModelQueryIssue {
  code: ModelQueryIssueCode;
  fix: string;
  message: string;
  nodeId?: string;
  path: string;
  severity: "error" | "warning";
}

export interface ModelQueryValidation {
  humanSummary: string;
  issues: ModelQueryIssue[];
  normalized?: ModelQueryRecipeV2;
  ok: boolean;
  ormPreview?: string;
  warnings: ModelQueryIssue[];
}
```

`path`는 JSON Pointer 형식(`/computed/1/select/field/path`)을 쓴다.
`issues`는 error와 warning 전체를 원래 검증 순서로 담고, `warnings`는 `issues.filter(issue => issue.severity === "warning")`와 동일한 순서의 부분집합이다.
`ok`는 error가 하나도 없을 때만 `true`이며 warning만 있는 Recipe는 Apply할 수 있다.

### 7.5 오류 코드

아래 code를 그대로 사용한다.

#### Recipe 구조

- `RECIPE_VERSION_UNSUPPORTED`
- `RECIPE_SOURCE_MISMATCH`
- `RECIPE_TOO_LARGE`
- `RECIPE_SHAPE_INVALID`
- `NODE_ID_INVALID`
- `NODE_ID_DUPLICATE`
- `PREDICATE_NODE_LIMIT`
- `PREDICATE_GROUP_DEPTH_LIMIT`
- `PREDICATE_GROUP_CHILD_LIMIT`
- `EMPTY_NESTED_GROUP`

#### Field/lookup/value

- `FIELD_METADATA_UNAVAILABLE`
- `FIELD_PATH_INVALID`
- `FIELD_PATH_TOO_LONG`
- `FIELD_PATH_RELATION_TERMINAL`
- `FIELD_PATH_TO_MANY_UNSAFE`
- `LOOKUP_UNSUPPORTED`
- `LOOKUP_TYPE_MISMATCH`
- `RHS_KIND_UNSUPPORTED`
- `RHS_TYPE_MISMATCH`
- `VALUE_REQUIRED`
- `VALUE_INVALID`
- `IN_LIST_LIMIT`
- `RELATIVE_TIME_INVALID`

#### Computed

- `COMPUTED_COLUMN_LIMIT`
- `ALIAS_INVALID`
- `ALIAS_RESERVED`
- `ALIAS_COLLISION`
- `ALIAS_DUPLICATE`
- `COMPUTED_REFERENCE_UNKNOWN`
- `COMPUTED_REFERENCE_FORWARD`
- `COMPUTED_REFERENCE_DISABLED`
- `COMPUTED_KIND_UNSUPPORTED_IN_SUMMARY`
- `AGGREGATE_FIELD_REQUIRED`
- `AGGREGATE_FANOUT_UNSAFE`
- `AGGREGATE_DISTINCT_UNSUPPORTED`
- `WINDOW_ORDER_REQUIRED`
- `WINDOW_FILTER_UNSUPPORTED`
- `FORMULA_NODE_LIMIT`
- `FORMULA_DEPTH_LIMIT`
- `FORMULA_TYPE_MISMATCH`
- `FORMULA_DIVIDE_BY_ZERO`
- `OUTPUT_TYPE_REQUIRED`
- `RAW_EXPRESSION_INVALID`
- `RAW_EXPRESSION_TRANSPORT_UNSUPPORTED`
- `RAW_MODEL_NAME_AMBIGUOUS`

#### Subquery/Exists

- `SUBQUERY_SOURCE_INVALID`
- `SUBQUERY_RELATION_INVALID`
- `SUBQUERY_CORRELATION_REQUIRED`
- `SUBQUERY_CORRELATION_LIMIT`
- `SUBQUERY_CORRELATION_INVALID`
- `SUBQUERY_SELECT_INVALID`
- `SUBQUERY_ORDER_LIMIT`
- `SUBQUERY_IMPLICIT_ORDER`
- `SUBQUERY_AGGREGATE_FANOUT_UNSAFE`
- `OUTER_REF_SCOPE_INVALID`
- `GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED`

#### 실행/성능

- `PYTHON_PROPERTY_FULL_SCAN`
- `PYTHON_PROPERTY_BOOLEAN_UNSUPPORTED`
- `PYTHON_PROPERTY_SUMMARY_UNSUPPORTED`
- `AUTO_DISTINCT_APPLIED`
- `OFFSET_PAGINATION_REQUIRED`
- `TRANSPORT_CAPABILITY_UNSUPPORTED`
- `GENERATED_QUERY_TOO_LARGE`

### 7.6 Warning과 error

다음은 warning이다.

- `PYTHON_PROPERTY_FULL_SCAN`
- `AUTO_DISTINCT_APPLIED`
- `OFFSET_PAGINATION_REQUIRED`
- order가 비어 compiler가 target pk asc를 넣을 때 `SUBQUERY_IMPLICIT_ORDER`

단, scalar subquery field select에서 target model에 pk가 없거나 metadata를 얻지 못해 fallback order를 만들 수 없으면 error다.

나머지는 error이며 Apply를 막는다.

### 7.7 Python `@property` 제한

DB annotation으로 선언되지 않은 `@property` comparison은 아래 조건을 모두 만족할 때만 허용한다.

- mode가 `rows`
- root WHERE의 직접 child
- root join이 `and`
- nested group, group negation, Exists 안에 있지 않음
- RHS가 literal/list/range
- postFilter가 아님
- summary/aggregate/filter condition이 아님

하나라도 어기면 `PYTHON_PROPERTY_BOOLEAN_UNSUPPORTED` 또는 `PYTHON_PROPERTY_SUMMARY_UNSUPPORTED`다. 허용된 경우에도 `PYTHON_PROPERTY_FULL_SCAN` warning을 표시한다.

### 7.8 실패 원자성

- client validation error가 있으면 message를 backend로 보내지 않는다.
- backend는 Recipe 전체를 다시 검증한다.
- backend validation error가 하나라도 있으면 QuerySet을 evaluate하지 않는다.
- backend는 `ok: false`, `issues`, `orm: ""`, `sql: []`, `rows: []`를 반환한다.
- 기존 grid는 webview에서 유지한다.
- invalid computed node를 빼고 실행하거나 invalid predicate를 빼고 실행하지 않는다.

---

## 8. 정규화와 컴파일 의미론

### 8.1 Validation 순서

client와 backend는 아래 순서로 검증한다. 순서까지 고정하여 같은 payload가 같은 첫 오류 위치를 갖게 한다.

1. JSON/object shape와 `version`
2. serialized size
3. source app/model과 열린 panel target 일치
4. 모든 `nodeId` 형식·중복
5. 전체 node 수·group depth·직접 child 수
6. source model metadata 준비
7. WHERE predicate
8. computed columns를 배열 순서대로 검증하고 alias/type symbol table 구성
9. result mode와 group-by
10. postFilter
11. outer order
12. transport capability
13. generated ORM cell 길이

오류가 여러 개면 가능한 범위에서 모두 수집하되, shape가 깨져 안전하게 하위 노드를 순회할 수 없는 branch는 해당 branch의 한 오류만 반환한다.

### 8.2 Normalization 규칙

`normalizeModelQueryRecipe()`는 입력 object를 mutate하지 않고 deep-cloned Recipe를 반환한다.

- 누락된 root `where`/`postFilter`는 empty root로 만든다.
- root ID는 `where-root`, `post-root`로 강제한다.
- `join`은 명시되어야 하며 임의 fallback을 하지 않는다.
- path 앞뒤 공백만 제거한다. 대소문자나 segment를 바꾸지 않는다.
- alias 앞뒤 공백만 제거한다. 자동 rename하지 않는다.
- duplicate group-by/order term은 validation error로 처리하며 자동 dedupe하지 않는다.
- `blank`/`not_blank`의 RHS는 `{kind:"literal", value:null}`로 normalize한다.
- `isnull` RHS는 반드시 boolean이다.
- disabled computed column은 Recipe에 유지하지만 compile하지 않는다.
- disabled alias는 symbol table에 넣지 않는다.
- explicit order가 비어 있으면 Recipe는 빈 배열을 유지하고 compiler만 기본 order를 삽입한다.
- user가 만든 child 순서, computed 순서, Case branch 순서를 유지한다.

### 8.3 Predicate group

각 comparison은 Django `Q`로 컴파일한다.

```py
Q(**{"field__lookup": rhs})
```

- comparison `negated=true`는 `~Q(...)`.
- group `join="and"`는 child를 `&`로 결합한다.
- group `join="or"`는 child를 `|`로 결합한다.
- group `negated=true`는 결합된 전체 Q를 `~(...)`로 감싼다.
- root empty group은 `Q()`다.
- nested empty group은 error다.
- 결합 순서는 Recipe child 순서다.
- log/preview에는 두 개 이상의 child가 있는 group을 항상 괄호로 표시한다.

레거시처럼 positive term을 먼저 모두 `.filter()`하고 negative term을 뒤에 `.exclude()`하는 방식은 v2에서 사용하지 않는다. nested Boolean 의미를 보존하기 위해 하나의 Q tree를 사용한다.

### 8.4 Comparison operand

| Recipe RHS | Django expression |
|---|---|
| `literal` | field-aware Python value |
| `list` | field-aware Python value list |
| `range` | 2-element field-aware list |
| `field` | `F(path)` |
| `outerField` | subquery scope의 `OuterRef(path)` |
| `relativeTime` | `Now() ± timedelta` 또는 timezone-aware today literal |

field-to-field 비교는 양쪽 field category가 호환되어야 한다.

- numeric끼리 허용
- date와 datetime은 직접 비교 금지
- 같은 text-like category 허용
- boolean끼리 허용
- UUID끼리 허용
- unknown output type과 field 비교 금지

v2 ORM cell에서 model class는 bare class name을 직접 쓰지 않고 아래 형태를 사용한다.

```py
apps.get_model("app_label", "ModelName")._base_manager
```

동일한 class name을 쓰는 여러 app이 있어도 target이 바뀌지 않게 하기 위한 고정 규칙이다.

### 8.5 Relation traversal과 DISTINCT

compiler는 predicate와 outer order/group-by path를 순회하며 to-many relation을 기록한다.

- WHERE comparison이 reverse-FK/M2M을 횡단하면 outer QuerySet에 `.distinct()`를 한 번 적용한다.
- FK/O2O만 횡단하면 distinct를 적용하지 않는다.
- Exists 내부 traversal은 inner query의 문제이며 outer distinct를 유발하지 않는다.
- Count source/filter가 to-many이면 Count 자체에 `distinct=True`를 적용한다.
- outer distinct와 Count distinct는 별개로 계산한다.
- 자동 distinct를 적용하면 `AUTO_DISTINCT_APPLIED` warning에 원인 path를 넣는다.

### 8.6 Exists predicate 내부 alias

nested Q 안에서 Exists를 다른 comparison과 조합할 수 있도록 compiler는 Exists predicate마다 내부 annotation을 만든다.

```py
queryset = queryset.annotate(
    __djs_pred_1=models.Exists(inner_queryset)
)
where_q = Q(__djs_pred_1=True)
```

- 내부 alias는 Recipe alias namespace에 노출하지 않는다.
- 순회 순서대로 `__djs_pred_1`, `__djs_pred_2`, …를 생성한다.
- Exists node의 `negated=true`는 `Q(__djs_pred_N=False)`로 컴파일한다.
- internal alias는 user alias collision 검사에서 예약 이름으로 간주한다.
- WHERE용 internal annotations는 base WHERE 전에 준비한다.
- postFilter 안의 Exists internal annotations는 user computed columns 뒤, postFilter 전에 준비한다.

### 8.7 Subquery source와 correlation

#### Relation source

- `relation`은 현재 scope model의 직접 relation query name 하나다. `__` traversal은 v2 relation source에서 허용하지 않는다.
- `correlations`는 반드시 빈 배열이다.
- compiler가 live relation metadata에서 correlation을 만든다.
- UI는 생성된 correlation을 read-only row로 보여 준다.

| relation | correlation |
|---|---|
| forward FK/O2O | target pk = `OuterRef(source_fk_attname)` |
| reverse FK/O2O | target foreign-key attname = `OuterRef(source pk)` |
| M2M | through source id = `OuterRef(source pk)` |

#### Model source

- `target.app`/`target.model`은 installed model이어야 한다.
- correlation은 1~4개다.
- 각 correlation은 `targetPath = OuterRef(outerPath)` exact equality다.
- 양쪽 path는 scalar로 끝나야 하며 to-many를 횡단하지 않는다.
- correlation은 항상 inner WHERE와 별도 AND로 적용한다.
- inner `where.join="or"`여도 correlation을 우회할 수 없다.

```py
inner = Target._base_manager.filter(
    target_a=OuterRef("outer_a"),
    target_b=OuterRef("outer_b"),
)
inner = inner.filter(inner_where_q)
```

### 8.8 Scalar subquery field select

```py
Subquery(
    inner
    .order_by("selected order…")
    .values("selected_path")[:1],
    output_field=resolved_output_field,
)
```

- order는 최대 3개다.
- user order가 없으면 target pk ascending을 넣고 `SUBQUERY_IMPLICIT_ORDER` warning을 낸다.
- 동률을 완전히 결정하려면 마지막 order가 target pk가 아니면 pk ascending을 자동 append한다. 이미 3개면 append하지 않고 warning text에 동률 가능성을 표시한다.
- `onEmpty.value === null`이면 그대로 Subquery다.
- non-null `onEmpty`이면 `Coalesce(Subquery(...), Value(onEmpty), output_field=...)`다.
- non-null onEmpty와 `outputType="auto"`를 함께 쓰면 `OUTPUT_TYPE_REQUIRED`다.

### 8.9 Scalar subquery aggregate select

aggregate select는 correlation으로 제한된 target rows를 한 scalar로 줄인다.

```py
inner = Target._base_manager.filter(correlations).filter(where_q).order_by()
inner = (
    inner
    .values(*target_correlation_paths)
    .annotate(__djs_scalar=Aggregate("field", ...))
    .values("__djs_scalar")[:1]
)
Subquery(inner, output_field=...)
```

- relation source에서는 compiler가 만든 target correlation path를 group key로 쓴다.
- M2M relation에서는 through source FK를 group key로 쓰고 target field에는 through target prefix를 붙인다.
- aggregate select에서는 user `orderBy`가 반드시 빈 배열이어야 한다.
- Count `all`은 target pk를 센다.
- Count to-many path는 distinct를 강제한다.
- Sum/Avg/Min/Max가 to-many path 또는 to-many filter path를 횡단하면 error다.
- empty matching target row에서 scalar Subquery는 null이다. `onEmpty`로 0 등의 명시적 fallback을 줄 수 있다.

### 8.10 Exists computed column

```py
Exists(inner.filter(correlations).filter(where_q))
```

- select/order/onEmpty가 없다.
- output type은 항상 boolean이다.
- relation/model source와 correlation 규칙은 scalar subquery와 같다.
- row mode에서만 허용한다.

### 8.11 Aggregate computed column

#### Rows mode

```py
queryset.annotate(
    alias=Count("relation", filter=condition_q, distinct=True)
)
```

- 현재 row 기준 per-row annotation이다.
- `field.kind="all"`은 Count에만 허용하고 source pk를 센다.
- conditional filter는 source model scope다.
- conditional filter 안에 nested group과 field RHS를 허용한다.
- conditional filter 안의 `outerField`와 `existsPredicate`는 허용하지 않는다.

#### Summary mode

```py
queryset.values(*group_by).annotate(
    alias=Aggregate("field", filter=condition_q)
)
```

- enabled computed kind는 `aggregate`만 허용한다.
- 최소 한 개 aggregate가 필요하다.
- group-by 0이면 global `.aggregate()` 결과 한 행이다.
- group-by가 있으면 QuerySet summary다.
- global summary에서 `postFilter`는 지원하지 않으며 `GLOBAL_SUMMARY_POST_FILTER_UNSUPPORTED` error다.
- grouped summary의 postFilter는 aggregate alias HAVING으로 컴파일한다.

### 8.12 Formula

Formula는 rows mode에서만 허용하고 배열 순서대로 한 번에 하나씩 annotate한다.

```py
qs = qs.annotate(first=...)
qs = qs.annotate(second=F("first") + Value(1))
```

뒤의 Formula는 앞의 enabled alias만 참조할 수 있다.

| node | Django |
|---|---|
| field | `F(path)` |
| computed | `F(alias)` |
| literal | `Value(value)` |
| binary | Django combined expression |
| coalesce | `Coalesce(*args)` |
| concat | `Concat(*args)` |
| greatest | `Greatest(*args)` |
| least | `Least(*args)` |
| lower | `Lower(arg)` |
| upper | `Upper(arg)` |
| trim | `Trim(arg)` |
| length | `Length(arg)` |
| case | `Case(When(q, then=expr), ..., default=expr)` |
| cast | `Cast(expr, output_field=...)` |

arity:

- `coalesce`, `concat`, `greatest`, `least`: 2~8
- `lower`, `upper`, `trim`, `length`: 정확히 1
- Case branch: 1~8

literal zero로 나누거나 modulo하는 expression은 `FORMULA_DIVIDE_BY_ZERO`다. runtime field가 zero일 가능성은 warning을 만들지 않는다.

### 8.13 Output type mapping

| Recipe | Django output field |
|---|---|
| boolean | `models.BooleanField()` |
| integer | `models.IntegerField()` |
| float | `models.FloatField()` |
| decimal | source DecimalField를 clone하거나 `models.DecimalField(max_digits=38, decimal_places=18)` |
| text | `models.TextField()` |
| date | `models.DateField()` |
| datetime | `models.DateTimeField()` |
| time | `models.TimeField()` |
| duration | `models.DurationField()` |
| uuid | `models.UUIDField()` |

`auto`는 field/select/aggregate/function에서 결과 type을 유일하게 추론할 수 있을 때만 허용한다. `Case` branches가 서로 다른 category이거나 binary 결과가 불명확하면 `OUTPUT_TYPE_REQUIRED`다.

### 8.14 Window

- 기존 function 집합을 유지한다.
- rank/dense_rank/row_number는 order 1개 이상이 필요하다.
- aggregate window는 field가 필요하고 concrete scalar field만 허용한다. Count all은 source pk를 쓴다.
- partition/order는 source concrete field만 허용한다.
- window가 하나라도 있으면 offset pagination을 사용하고 warning을 낸다.
- window alias는 outer order에 사용할 수 있다.
- window alias는 postFilter에 사용할 수 없다.

### 8.15 Code expression

- rows mode에서만 허용한다.
- 기존 Socket AST allowlist와 ORM text allowlist의 교집합만 허용한다.
- mutable QuerySet method, private attribute, blocked module/name, semicolon, newline을 금지한다.
- `when`이 비어 있지 않으면 `Case(When(predicate, then=expression), default=Value(None))`.
- model namespace name은 열린 shell과 ORM mode 양쪽에서 resolve 가능한 installed model class만 허용한다.
- 두 app 이상에 같은 bare model class name이 있으면 해당 bare name을 포함한 code expression은 `RAW_MODEL_NAME_AMBIGUOUS`다. structured Subquery를 사용하도록 fix를 표시한다.
- output type auto가 expression metadata로 추론되지 않으면 사용자가 명시해야 한다.

### 8.16 Rows query 실행 순서

정확한 순서는 다음과 같다.

```text
base manager
→ WHERE용 internal Exists annotations
→ base WHERE Q
→ required outer DISTINCT
→ enabled computed columns, Recipe 순서대로 annotate
→ postFilter용 internal Exists annotations
→ postFilter Q
→ explicit/default order
→ keyset 또는 offset pagination
→ bounded values/read
```

기본 order:

- rows mode: source pk asc
- grouped summary: group-by fields asc
- global summary: order 없음

keyset pagination은 order가 정확히 source pk asc이고 window가 없을 때만 쓴다. 나머지는 offset pagination이다.

### 8.17 Summary query 실행 순서

```text
base manager
→ WHERE용 internal Exists annotations
→ base WHERE Q
→ required DISTINCT
→ groupBy가 있으면 values(group fields)
→ aggregate expressions
→ groupBy가 있으면 postFilter/HAVING
→ explicit/default order
→ groupBy가 있으면 limit + 1
→ read-only result grid
```

global summary는 `.aggregate()` dict를 한 행으로 tabulate한다.

### 8.18 Count

footer Count는 별도 `filters[]`가 아니라 전체 applied Recipe를 사용한다.

- rows mode: WHERE → computed → postFilter까지 적용한 final QuerySet의 row count
- grouped summary: final grouped/HAVING QuerySet의 group count, UI label `Count groups`
- global summary: 항상 결과 행 1개이며 button을 disabled하고 `1 summary row`를 표시
- Python property filter: stream full scan, warning과 elapsed progress 표시
- Count response revision이 현재 applied revision과 다르면 무시

---

## 9. Transport 동등성

### 9.1 지원 행렬

| 기능 | Socket | Auto | Terminal | ORM |
|---|---:|---:|---:|---:|
| nested Q | 예 | 예 | 예 | 예 |
| field RHS | 예 | 예 | 예 | 예 |
| relative time | 예 | 예 | 예 | 예 |
| structured Aggregate | 예 | 예 | 예 | 예 |
| scalar Subquery | 예 | 예 | 예 | 예 |
| Exists | 예 | 예 | 예 | 예 |
| Formula/Case | 예 | 예 | 예 | 예 |
| Window | 예 | 예 | 예 | 예 |
| Code expression | 교집합 syntax | 교집합 syntax | 교집합 syntax | 교집합 syntax |
| unannotated property filter | scan | scan | scan | scan |
| property aggregate | 예, full scan | Socket 선택 시 예 | 아니오 | 아니오 |

Auto가 property aggregate를 만나면 Socket이 사용 가능할 때 Socket을 선택한다. Socket을 사용할 수 없으면 실행 전에 `TRANSPORT_CAPABILITY_UNSUPPORTED`를 반환한다. 구조화 Recipe의 다른 기능은 transport를 바꿔도 의미가 달라지면 안 된다.

### 9.2 두 compiler의 역할

#### TypeScript compiler

- ORM/Terminal literal cell 생성
- extension-host ORM preview 생성
- webview에 보낼 validation 결과 생성
- backend metadata를 사용한 strict path/cardinality 검증

#### Python compiler

- Socket/PTY request의 authoritative live-model validation
- 실제 QuerySet/Expression 생성
- readable ORM log 생성
- TypeScript validation을 신뢰하지 않고 전체 재검증

### 9.3 Parity 강제 방식

`test/modelQueryRecipeCorpus.mjs`에 transport-neutral Recipe fixture를 한 번 정의한다. 각 case는 다음을 포함한다.

```js
{
  name: "nested-and-or",
  recipe,
  expectedRows: ["..."],
  expectedIssues: [],
  ormPatterns: [/.../],
  capabilities: ["socket", "orm"]
}
```

같은 fixture로:

1. TypeScript validation
2. TypeScript ORM string compile
3. generated ORM cell 실제 평가
4. Python backend Recipe 실행
5. row/summary 결과 비교
6. issue code 비교

를 수행한다.

whitespace, quote style, ORM log formatting은 의미 비교에서 제외한다. row 값, alias, order, null, issue code, warning code는 같아야 한다.

### 9.4 Metadata 실패

field tree RPC가 실패했을 때:

- 기존 flat columns로 조용히 fallback하지 않는다.
- 해당 picker에 Retry를 표시한다.
- 이미 선택된 path는 text로 보존한다.
- validation은 `FIELD_METADATA_UNAVAILABLE`.
- Apply는 disabled.
- reconnect/schema reload 뒤 metadata를 다시 fetch하여 자동 재검증한다.

---

## 10. 상태와 Protocol

### 10.1 Webview store

`media/gridQueryRecipeStore.js`는 아래 API를 제공한다.

```js
createQueryRecipeStore(initialRecipe)
  .getSnapshot()
  .dispatch(action)
  .subscribe(listener)
  .setApplied(recipe, revision)
  .resetDraft()
  .clearDraft(source)
  .beginApply(revision, recipe)
  .finishApply(revision, normalizedRecipe)
  .failApply(revision, issues)
  .setValidation(validation, validationRevision)
```

snapshot:

```js
{
  applied,
  appliedRevision,
  applyingRevision,
  draft,
  draftRevision,
  dirty,
  validation,
  validationRevision
}
```

모든 dispatch는 새 object를 만들고 이전 snapshot을 mutate하지 않는다.

### 10.2 Store action 목록

- `ADD_COMPARISON`
- `ADD_GROUP`
- `ADD_EXISTS_PREDICATE`
- `UPDATE_NODE`
- `REMOVE_NODE`
- `DUPLICATE_NODE`
- `MOVE_NODE_UP`
- `MOVE_NODE_DOWN`
- `ADD_COMPUTED`
- `UPDATE_COMPUTED`
- `REMOVE_COMPUTED`
- `DUPLICATE_COMPUTED`
- `MOVE_COMPUTED_UP`
- `MOVE_COMPUTED_DOWN`
- `TOGGLE_COMPUTED`
- `SET_MODE`
- `ADD_GROUP_BY`
- `REMOVE_GROUP_BY`
- `ADD_ORDER`
- `UPDATE_ORDER`
- `REMOVE_ORDER`
- `REPLACE_DRAFT`

action payload는 `nodeId`와 변경 값만 포함한다. DOM node를 store에 넣지 않는다.

### 10.3 Webview → extension message

```ts
type ModelQueryWebviewMessage =
  | {
      recipe: ModelQueryRecipeV2;
      revision: number;
      type: "applyQueryRecipe";
    }
  | {
      recipe: ModelQueryRecipeV2;
      requestId: string;
      revision: number;
      type: "previewQueryRecipe";
    }
  | {
      revision: number;
      type: "requestCount";
    };
```

기존 `applyQuery`, `aggregate` message는 migration 기간에만 지원한다.

### 10.4 Extension → webview message

```ts
type ModelQueryHostMessage =
  | {
      requestId: string;
      revision: number;
      type: "queryRecipePreview";
      validation: ModelQueryValidation;
    }
  | {
      issues: ModelQueryIssue[];
      revision: number;
      type: "queryRecipeRejected";
    }
  | {
      recipe: ModelQueryRecipeV2;
      revision: number;
      type: "queryRecipeApplied";
    };
```

기존 rows/aggregate/count message에도 `revision`을 추가한다.

### 10.5 Panel state

`ModelBrowserPanel`은 다음 state를 가진다.

```ts
private appliedRecipe: ModelQueryRecipeV2;
private appliedRecipeRevision = 0;
private recipeMetadata = new ModelQueryMetadataIndex();
private readonly recipeTreeCache = new Map<string, BackendFilterFieldTree>();
private recipeModelCatalog: QueryModelRef[] | undefined;
```

- panel constructor의 `initialPk`는 empty Recipe WHERE에 `pk exact initialPk` comparison으로 변환한다.
- `loadPage`, `loadComputed`, `requestCount`, summary request는 모두 applied Recipe를 전달한다.
- `applyQueryRecipe`는 source target을 검사하고 revision을 저장한 뒤 mode에 따라 rows/summary를 실행한다.
- runtime reload는 applied Recipe를 유지하고 재실행한다.
- schema가 바뀌어 applied Recipe가 invalid가 되면 grid를 넓은 query로 바꾸지 않고 rejection을 표시한다.
- Apply/Preview 전 model catalog를 한 번 cache하고 `loadModelQueryMetadata()`로 Recipe가 참조한 모든 model tree를 준비한다.

### 10.6 Backend query 타입

다음 interface에 `recipe?: ModelQueryRecipeV2`를 추가한다.

- `ModelRowsQuery`
- `ModelComputedQuery`
- `ModelCountQuery`
- `ModelAggregateQuery`
- `BackendRequestPayload`

migration 기간에는 `recipe`가 있으면 v2가 우선하고 legacy `filters`, `annotations`, `groupBy`, `order`는 무시한다.

extension 내부 query interface에는 `recipeMetadata?: ModelQueryMetadataBundle`도 추가한다. 이것은 ORM compiler에만 전달하며 Socket/PTY JSON request를 만들기 전에 제거한다. Python backend는 client metadata를 받거나 신뢰하지 않는다.

### 10.7 Preview scheduling

- draft 변경 즉시 client-side shape validation과 human summary를 계산한다.
- field metadata가 모두 준비되면 250ms debounce 후 extension-host preview를 요청한다.
- 직전 preview가 끝나지 않아도 새 request를 보낼 수 있으나 requestId/revision이 오래되면 결과를 무시한다.
- remote Terminal/PTY active transport에서는 매 keystroke preview를 보내지 않는다. comparison input blur 또는 `Preview ORM` 버튼에서만 요청한다.
- preview는 DB QuerySet을 evaluate하지 않는다.
- preview는 SQL을 생성하거나 `EXPLAIN`하지 않는다.

---

## 11. 파일 배치와 줄 수 예산

### 11.1 새 TypeScript 파일

| 파일 | 책임 | 최대 목표 줄 |
|---|---|---:|
| `src/modelQueryRecipe.ts` | Recipe/issue/validation 타입, empty factory | 500 |
| `src/modelQueryRecipeLimits.ts` | 상한과 lookup/function 상수 | 160 |
| `src/modelQueryRecipeMetadata.ts` | field tree index, path resolve, cardinality/type | 450 |
| `src/modelQueryRecipeValidation.ts` | 순수 validation/normalization orchestration | 850 |
| `src/modelQueryPredicateOrm.ts` | Q/Exists/RHS ORM compile | 700 |
| `src/modelQueryComputedOrm.ts` | aggregate/subquery/formula/window/code compile | 900 |
| `src/modelQueryRecipeOrm.ts` | rows/summary/count facade와 preview | 450 |
| `src/modelQueryLegacyAdapter.ts` | legacy filters/annotations ↔ v2 migration | 450 |
| `src/backendClientResponses.ts` | 기존 `backendClient.ts` 뒤쪽 transport/response helper | 350 |

한 파일이 목표를 넘기기 전에 responsibility를 더 나눈다. 1000줄을 넘긴 뒤 분리하지 않는다.

### 11.2 새 webview 파일

| 파일 | 책임 | 최대 목표 줄 |
|---|---|---:|
| `media/gridQueryRecipeStore.js` | immutable draft/applied/revision store | 350 |
| `media/gridQueryRecipeLimits.js` | webview용 동일 상한/lookup/function 상수 | 180 |
| `media/gridQueryMetadata.js` | lazy field/model tree cache와 request state | 350 |
| `media/gridPredicateBuilder.js` | recursive group/row rendering과 structural actions | 750 |
| `media/gridPredicateValue.js` | lookup matrix, typed RHS editors | 500 |
| `media/gridComputedBuilder.js` | computed list/header/kind routing | 650 |
| `media/gridAggregateBuilder.js` | aggregate controls | 350 |
| `media/gridSubqueryBuilder.js` | source/correlation/where/select/order/onEmpty | 650 |
| `media/gridFormulaBuilder.js` | formula AST/Case/function controls | 750 |
| `media/gridWindowBuilder.js` | window controls | 350 |
| `media/gridCodeExpressionBuilder.js` | Advanced code expression controls | 250 |
| `media/gridQueryResultBuilder.js` | mode/group-by/order/result filter | 450 |
| `media/gridQuerySummary.js` | human summary, collapsed band | 350 |
| `media/gridQueryValidationView.js` | issue summary, inline mapping, focus | 350 |
| `media/gridQueryController.js` | store, builder, apply/preview/count wiring | 700 |
| `media/modelQueryBuilder.css` | drawer/layout/state/responsive style | CSS guideline 적용 |

### 11.3 기존 파일 변경 제한

- `media/modelBrowserSource.js`
  - legacy filter/column import와 wiring을 제거한다.
  - `createQueryController()` 한 개를 연결한다.
  - query 관련 apply/clear/remove/aggregate 함수는 새 controller로 이동한다.
  - 최종 800줄 이하를 목표로 한다.
- `src/modelOrm.ts`
  - legacy compiler로 유지한다.
  - v2 코드를 추가하지 않는다.
- `src/backendClient.ts`
  - Phase 4 시작 시 기존 class 뒤 top-level helper를 `backendClientResponses.ts`로 먼저 이동한다.
  - v2 compiler import와 `query.recipe ? v2 : legacy` branch를 배치한다.
  - 최종 850줄 이하를 목표로 한다.
- `src/modelBrowserHtml.ts`
  - model mode에서 legacy filterbar/aggbar를 summary band/drawer로 교체한다.
  - query mode DOM은 유지한다.
- `media/modelBrowser.css`
  - 기존 grid/table 관련 style만 유지한다.
  - 새 Builder style은 `modelQueryBuilder.css`로 분리한다.
- `python/django_shell_backend.py`
  - 100줄 이하의 local composed-source loader로 바꾼다.
  - 일반 Python import로 backend responsibility를 나누지 않는다.
  - ordered fragment 전체를 같은 module globals에서 compile/exec한다.
- `python/backend_parts/*.pyfrag`
  - 모든 fragment는 1000줄 이하이고 첫 줄에 목적 요약 주석을 둔다.
  - `# --- Model data browser` marker는 `50_model_core.pyfrag`에 한 번만 둔다.
  - v2는 `90_model_query_recipe_predicate.pyfrag`와 `91_model_query_recipe_computed.pyfrag`에 둔다.
- `src/backendBootstrap.ts`
  - env/inline/feature payload를 만들 때 loader text가 아니라 manifest 순서로 합성한 source를 읽는다.
  - remote runtime에 전달되는 최종 source는 기존처럼 하나다.

### 11.4 제거 예정

v2 전환과 legacy regression 기간이 끝난 후:

- `media/gridFilter.js`
- `media/gridColumnConditions.js`
- `media/gridAggregate.js`

를 삭제한다. 단, 동일 기능을 v2 module이 완전히 대체하고 관련 테스트가 새 module을 참조하도록 이동한 뒤에만 삭제한다.

---

## 12. 단계별 구현 계획

## Phase 0. 기준선 고정과 작업 보호

### 목적

현재 동작, 현재 dirty files, transport별 결과를 먼저 고정하여 이후 실패가 새 기능 때문인지 구분한다.

### 작업

- [ ] **P0-01 — 작업 상태 기록**
  - `git status --short`를 실행한다.
  - 사용자 변경 파일을 별도 목록으로 기록한다.
  - `git reset`, `git restore`, `git checkout --`를 실행하지 않는다.
- [ ] **P0-02 — 기준 테스트 실행**
  - 아래 명령을 실행하고 결과를 작업 로그에 남긴다.

```bash
node --test test/modelBrowserFilters.test.mjs test/modelColumnConditions.test.mjs
npm run check
```

- [ ] **P0-03 — 현재 compiler characterization 보강**
  - `test/modelQueryLegacyCharacterization.test.mjs`를 추가한다.
  - 다음 현재 계약만 고정한다.
    - flat filters는 AND
    - term negate
    - annotation alias post-filter
    - window alias filter는 현재 legacy에서 drop
    - Count to-many distinct
    - scalar subquery correlation이 inner OR 밖에 있음
    - invalid legacy node가 drop됨
  - “invalid가 drop된다”는 legacy 전용 테스트로 표시하고 v2 expectation과 섞지 않는다.
- [ ] **P0-04 — corpus fixture 골격**
  - `test/modelQueryRecipeCorpus.mjs`를 추가한다.
  - 아직 production compiler를 연결하지 않고 fixture shape와 helper만 만든다.
  - fixture name은 안정적인 kebab-case를 사용한다.
- [ ] **P0-05 — code size guard 확인**
  - 현재 near-limit 파일 줄 수를 기록한다.

```bash
wc -l src/backendClient.ts src/modelOrm.ts media/modelBrowserSource.js
```

### 완료 게이트

- 기존 전체 check가 통과한다.
- 새 characterization test가 통과한다.
- dirty 사용자 변경이 보존된다.
- Phase 0에서는 production behavior를 변경하지 않는다.

---

## Phase 0B. Python backend source 합성 구조로 무동작 변경 분할

### 목적

현재 5456줄인 Python backend를 기능 변경 없이 1000줄 이하 fragment로 나누고, local test/import와 local/env/remote/inline bootstrap 모두에 동일한 한 개의 합성 source를 제공한다. Query Recipe 코드는 이 구조가 통과한 뒤 새 fragment에 추가한다.

### 새 파일

- `python/django_shell_backend.parts.json`
- `python/backend_parts/00_bootstrap.pyfrag`
- `python/backend_parts/10_inspection.pyfrag`
- `python/backend_parts/20_execution_hot_reload.pyfrag`
- `python/backend_parts/30_debug_progress.pyfrag`
- `python/backend_parts/40_pty_capture.pyfrag`
- `python/backend_parts/50_model_core.pyfrag`
- `python/backend_parts/60_model_aggregate.pyfrag`
- `python/backend_parts/70_model_annotations.pyfrag`
- `python/backend_parts/80_model_edit_query.pyfrag`
- `test/backendComposedSource.test.mjs`

### 고정 분할 경계

현재 source의 함수 선언을 기준으로 다음 책임을 옮긴다. 줄 번호가 아니라 시작/끝 symbol을 기준으로 이동한다.

| Fragment | 첫 symbol | 마지막 symbol | 포함 책임 |
|---|---|---|---|
| `00_bootstrap` | imports/constants | `_check_complete` 직전 | server/start/warmup/autoimport/request routing |
| `10_inspection` | `_check_complete` | `_execute_code` 직전 | completeness/runtime inspection/value summaries |
| `20_execution_hot_reload` | `_execute_code` | `_load_feature` 직전 | execution/debug engine/native debugger/hot reload |
| `30_debug_progress` | `_load_feature` | `_print_marker` 직전 | feature load, debug wrapping/breakpoints, progress/capture |
| `40_pty_capture` | `_print_marker` | model marker 직전 | PTY markers, inspection probes, capture hooks/history scrub |
| `50_model_core` | `# --- Model data browser` | `_browse_aggregate` 직전 | models/schema/rows/related/computed/field tree/legacy conditions/count |
| `60_model_aggregate` | `_browse_aggregate` | `_browse_annotation_specs` 직전 | legacy aggregate/grouping/python aggregate helpers |
| `70_model_annotations` | `_browse_annotation_specs` | `_browse_commit` 직전 | legacy annotations/subquery/raw expression/HAVING/ORM logs |
| `80_model_edit_query` | `_browse_commit` | EOF | commit/lookup/free query/tabulation/legacy filters/coercion |

분할 뒤 각 fragment는 1000줄 이하이어야 한다. comment/blank line 때문에 1000을 넘으면 해당 fragment의 끝에서 완결된 함수 단위로 다음 fragment를 하나 더 만들고 manifest에 바로 뒤 순서로 넣는다. 함수 body를 fragment 경계에서 자르지 않는다.

### Manifest

`python/django_shell_backend.parts.json`:

```json
[
  "backend_parts/00_bootstrap.pyfrag",
  "backend_parts/10_inspection.pyfrag",
  "backend_parts/20_execution_hot_reload.pyfrag",
  "backend_parts/30_debug_progress.pyfrag",
  "backend_parts/40_pty_capture.pyfrag",
  "backend_parts/50_model_core.pyfrag",
  "backend_parts/60_model_aggregate.pyfrag",
  "backend_parts/70_model_annotations.pyfrag",
  "backend_parts/80_model_edit_query.pyfrag"
]
```

### Loader 계약

`python/django_shell_backend.py`는:

1. 자신의 sibling manifest를 읽는다.
2. manifest 상대 경로를 순서대로 읽는다.
3. fragment 사이에 정확히 두 개의 newline을 넣어 합친다.
4. `compile(composed, "<django-shell-backend>", "exec")`.
5. 현재 `globals()`에서 exec한다.
6. manifest/path helper 임시 이름은 exec 뒤 globals에서 제거한다.

loader에는 backend function/class 구현을 두지 않는다.

### TypeScript composition

`src/backendBootstrap.ts`:

- `readBackendSource(runtimePath)`가 sibling manifest가 있으면 fragments를 합성한다.
- manifest가 없을 때만 기존 single-file read로 fallback한다.
- `backendBootstrapPayload`, `buildInlineBackendBootstrapCommand`, `backendFeaturePayload`는 모두 이 합성 source를 사용한다.
- feature split은 합성 source의 기존 `BACKEND_FEATURE_MARKER`를 기준으로 한다.
- fragment 파일 경로 또는 manifest 내용은 remote command에 노출하지 않는다.

### 작업

- [ ] **P0B-01 — characterization**
  - 기존 backend source SHA가 아니라 behavior test 결과를 기준으로 삼는다.
  - ready marker, feature marker, request routing, native/debug/hot reload/model tests를 먼저 실행한다.
- [ ] **P0B-02 — fragments 이동**
  - source text를 위 symbol 경계로 기계적으로 이동한다.
  - function/class body를 수정하지 않는다.
  - import/constants도 수정하지 않는다.
- [ ] **P0B-03 — loader**
  - local `importlib.util.spec_from_file_location()` path가 기존처럼 동작하게 한다.
- [ ] **P0B-04 — bootstrap composition**
  - TypeScript payload가 full composed source를 담게 한다.
- [ ] **P0B-05 — feature composition**
  - core/feature byte split과 lazy load가 기존과 같은 marker에서 동작한다.
- [ ] **P0B-06 — source-inspection tests**
  - backend text를 AST/string 검사하는 test는 loader file이 아니라 test helper의 `readComposedBackendSource()`를 사용하게 바꾼다.
  - 실행 test는 기존 loader path를 계속 사용한다.
- [ ] **P0B-07 — package**
  - `.vscodeignore`가 manifest와 `.pyfrag`를 제외하지 않는지 확인한다.
- [ ] **P0B-08 — line count**

```bash
wc -l python/django_shell_backend.py python/backend_parts/*.pyfrag
```

### 필수 테스트

```bash
npm run compile
node --test test/backendBootstrap.test.mjs test/backendHotReload.test.mjs
node --test test/backendDebugEngine.test.mjs test/backendInspection.test.mjs
node --test test/modelBrowser.test.mjs test/modelColumnConditions.test.mjs
node --test test/backendComposedSource.test.mjs
```

`backendComposedSource.test.mjs`는:

- manifest order
- 모든 file 존재
- 각 fragment 첫 줄 comment
- 각 fragment/loader 1000줄 이하
- model feature marker 정확히 1개
- composed source AST parse
- composed source에 `start`, `_run_request`, `_browse_rows` 존재
- full/core/feature payload round-trip

를 검사한다.

### 완료 게이트

- 기존 backend test output이 동일하다.
- env/disk/inline/feature payload test가 모두 통과한다.
- 모든 Python source/fragment가 1000줄 이하다.
- 이 Phase에서는 query semantics를 바꾸지 않는다.

---

## Phase 1. Recipe core, metadata index, validation

### 목적

UI나 backend 실행을 바꾸기 전에 versioned state와 strict validation을 순수 모듈로 완성한다.

### 새 파일

- `src/modelQueryRecipe.ts`
- `src/modelQueryRecipeLimits.ts`
- `src/modelQueryRecipeMetadata.ts`
- `src/modelQueryRecipeValidation.ts`
- `media/gridQueryRecipeLimits.js`
- `test/modelQueryRecipeValidation.test.mjs`
- `test/modelQueryRecipeLimits.test.mjs`

### 작업

- [ ] **P1-01 — 타입과 empty factory**
  - 5장의 타입을 구현한다.
  - `createEmptyModelQueryRecipe(source)`를 구현한다.
  - `cloneModelQueryRecipe(recipe)`를 JSON-compatible deep clone으로 구현한다.
  - `isModelQueryRecipeV2(value)`는 shape guard만 하고 semantic validation은 하지 않는다.
- [ ] **P1-02 — 상수**
  - 7.1의 모든 상한을 TypeScript에 정의한다.
  - lookup/function/output type 목록을 readonly constant로 정의한다.
  - webview JS에는 같은 이름과 값을 export한다.
  - Python 값 비교는 Phase 3 test에서 추가한다.
- [ ] **P1-03 — metadata index**
  - 다음 public API를 구현한다.

```ts
export interface QueryResolvedPath {
  choices?: Array<[unknown, string]>;
  leafKind: "field" | "property" | "relation";
  nullable: boolean;
  path: string;
  relationTerminal: boolean;
  toMany: boolean;
  type: string;
}

export interface ModelQueryMetadataBundle {
  catalog: QueryModelRef[];
  models: Record<string, {
    columns?: BackendModelColumn[];
    tree: BackendFilterFieldTree;
  }>;
}

export class ModelQueryMetadataIndex {
  static fromBundle(bundle: ModelQueryMetadataBundle): ModelQueryMetadataIndex;
  setCatalog(models: QueryModelRef[]): void;
  addColumns(model: QueryModelRef, columns: BackendModelColumn[]): void;
  addTree(model: QueryModelRef, tree: BackendFilterFieldTree): void;
  getTree(model: QueryModelRef): BackendFilterFieldTree | undefined;
  resolvePath(model: QueryModelRef, path: string): QueryResolvedPath | undefined;
  resolveRelation(model: QueryModelRef, relation: string): BackendFilterRelation | undefined;
  toBundle(): ModelQueryMetadataBundle;
}

export async function loadModelQueryMetadata(
  recipe: ModelQueryRecipeV2,
  loadTree: (model: QueryModelRef) => Promise<BackendFilterFieldTree>,
  modelCatalog: QueryModelRef[],
  rootColumns: BackendModelColumn[]
): Promise<ModelQueryMetadataIndex>;
```

  - path resolve는 최대 segment/path 상한을 먼저 검사한다.
  - `fromBundle()`은 `recipeMetadata`를 받은 host/socket compiler가 같은 resolver를 재사용하기 위한 유일한 복원 진입점이다.
  - `setCatalog()`는 `app.Model`을 key로 dedupe한 immutable snapshot을 저장하며, 후속 호출은 전체 catalog를 교체한다.
  - `pk`를 live pk field로 resolve한다.
  - source root의 computed `@property`는 `addColumns()` metadata로 resolve한다.
  - installed model catalog로 raw code의 bare model name uniqueness와 arbitrary model source를 검증한다.
  - relation traversal마다 target tree가 index에 있어야 한다.
  - tree가 없으면 lexical 추측을 하지 않는다.
  - `loadModelQueryMetadata()`는 Recipe의 모든 field path, relation source, model source, correlation, select, order, Formula/Case path를 순회하여 필요한 target tree를 재귀 fetch한다.
  - 같은 `app.Model`은 한 번만 fetch하고 순환 relation은 visited set으로 끊는다.
- [ ] **P1-04 — validation orchestration**
  - `validateModelQueryRecipe(input, context)`를 구현한다.
  - context는 source, metadata, columns, transport를 받는다.
  - 8.1 순서로 issue를 수집한다.
  - validation 중 compiler code를 실행하지 않는다.
- [ ] **P1-05 — alias/dependency symbol table**
  - enabled computed를 배열 순서대로 검사한다.
  - concrete fields/relations/properties와 충돌 검사한다.
  - Formula의 computed ref는 이전 enabled alias만 허용한다.
  - postFilter/order는 모든 enabled alias를 참조할 수 있다.
- [ ] **P1-06 — mode validation**
  - rows: groupBy는 empty여야 한다.
  - summary: enabled computed는 aggregate만, 최소 1개.
  - global summary: postFilter empty.
  - grouped summary: postFilter LHS는 aggregate alias/group field만.
- [ ] **P1-07 — property restriction**
  - 7.7 규칙을 구현한다.
  - 허용된 property term에는 full-scan warning을 넣는다.
- [ ] **P1-08 — normalization**
  - 8.2 규칙을 구현한다.
  - 입력 mutation 여부를 frozen fixture로 테스트한다.
- [ ] **P1-09 — issue ordering**
  - issue는 validation phase 순서, 같은 phase에서는 Recipe traversal 순서로 반환한다.
  - UI가 first error focus에 사용할 수 있게 고정한다.

### 필수 테스트

`test/modelQueryRecipeValidation.test.mjs`:

- empty Recipe valid
- version/source mismatch
- duplicate/invalid nodeId
- payload/node/depth/child limit
- valid nested AND/OR/NOT
- incomplete nested group
- invalid path/relation terminal/to-many
- type별 lookup/RHS matrix
- list/range/relative time shape
- alias reserved/collision/duplicate
- forward/disabled/unknown computed ref
- rows/summary mode rules
- global summary postFilter error
- window postFilter error
- property filter 허용/불허 문맥
- input object non-mutation
- issue ordering

`test/modelQueryRecipeLimits.test.mjs`:

- TypeScript와 webview 상수가 모두 일치
- lookup 목록 일치
- function/output type 목록 일치

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryRecipeValidation.test.mjs test/modelQueryRecipeLimits.test.mjs
```

- compiler/backend/UI를 아직 전환하지 않는다.
- 모든 error code가 7.5 목록 안에 있다.
- TypeScript 새 파일이 모두 1000줄 이하다.

---

## Phase 2. TypeScript ORM compiler

### 목적

Recipe를 injection-safe literal ORM cell과 readable preview로 바꾸는 compiler를 완성한다.

### 새 파일

- `src/modelQueryPredicateOrm.ts`
- `src/modelQueryComputedOrm.ts`
- `src/modelQueryRecipeOrm.ts`
- `test/modelQueryRecipeOrm.test.mjs`
- `test/modelQueryRecipeOrmExecution.test.mjs`
- `test/modelQueryRecipeSecurity.test.mjs`

### public API

```ts
export interface ModelQueryOrmCompileContext {
  columns: BackendModelColumn[];
  limit: number;
  metadata: ModelQueryMetadataIndex;
  offset?: number;
  relations: BackendModelRelation[];
  source: QueryModelRef;
  transport: BackendTransport;
}

export interface ModelQueryOrmCompileResult {
  cell: string;
  preview: string;
  validation: ModelQueryValidation;
}

export function buildRecipeRowsOrm(
  recipe: ModelQueryRecipeV2,
  context: ModelQueryOrmCompileContext
): ModelQueryOrmCompileResult;

export function buildRecipeSummaryOrm(
  recipe: ModelQueryRecipeV2,
  context: ModelQueryOrmCompileContext
): ModelQueryOrmCompileResult;

export function buildRecipeCountOrm(
  recipe: ModelQueryRecipeV2,
  context: ModelQueryOrmCompileContext
): ModelQueryOrmCompileResult;
```

### 작업

- [ ] **P2-01 — safe literal helpers**
  - JSON/Python scalar encoding을 구현한다.
  - Decimal/date/datetime/time/UUID/list/range를 field-aware하게 emit한다.
  - identifier/path/alias는 validation 결과만 사용하되 compiler에서도 assertion한다.
- [ ] **P2-02 — recursive Q compiler**
  - group/comparison negation과 괄호를 8.3대로 생성한다.
  - `blank` macro, F RHS, relative time을 구현한다.
  - internal Exists annotation registry를 구현한다.
- [ ] **P2-03 — relation/model inner query compiler**
  - direct relation correlation
  - custom model 1~4 correlation
  - M2M through correlation
  - correlation과 inner where를 별도 AND로 유지
- [ ] **P2-04 — scalar subquery**
  - field select
  - aggregate select
  - order/default pk/tie pk
  - output field
  - onEmpty Coalesce
- [ ] **P2-05 — aggregate/Exists**
  - rows aggregate
  - summary aggregate
  - distinct/fan-out 규칙
  - Exists computed
- [ ] **P2-06 — Formula**
  - 모든 node/function/Case/Cast 매핑
  - arity, depth, output type
  - 앞 alias F reference
- [ ] **P2-07 — Window/Code expression**
  - 기존 기능을 v2 spec으로 재현한다.
  - Code expression은 기존 양 transport 허용 규칙의 교집합을 적용한다.
- [ ] **P2-08 — rows/summary/count facade**
  - 8.16~8.18 순서를 구현한다.
  - 실행용 `cell`은 plain REPL 호환 single-line expression으로 만든다.
  - property full-scan helper가 필요한 경우에만 multiline cell을 허용하되 기존 plain-REPL 지원 방식과 동일하게 생성한다.
  - `preview`는 읽기 쉬운 multiline ORM text다.
- [ ] **P2-09 — 길이 제한**
  - generated cell 32768자를 넘으면 cell을 반환하지 않고 error를 추가한다.
- [ ] **P2-10 — legacy 무변경**
  - `src/modelOrm.ts` output snapshot이 바뀌지 않았음을 기존 테스트로 확인한다.

### 필수 보안 테스트

각 위치에 아래 payload를 넣는다.

- path: `name); import os #`
- alias: `x);delete()`
- model: `auth.User);`
- raw expression: semicolon/newline/private attr/blocked method/module
- literal: quotes, backslash, newline, Unicode, very long string
- nodeId: HTML/script-like string
- relation: `groups__name`을 direct relation source로 사용

기대 결과:

- issue error
- generated cell에 공격 문자열이 executable token으로 나타나지 않음
- invalid Recipe에서 fallback broad query cell을 만들지 않음

### 필수 실행 테스트

SQLite Django fixture에서 generated cell을 실제 `eval/exec`하고:

- nested Boolean rows
- F comparison
- relative date
- Exists predicate
- conditional Count
- scalar subquery field/aggregate
- Formula/Case
- grouped summary/HAVING
- count

결과를 확인한다.

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryRecipeOrm.test.mjs
node --test test/modelQueryRecipeOrmExecution.test.mjs
node --test test/modelQueryRecipeSecurity.test.mjs
node --test test/modelBrowser.test.mjs test/modelBrowserFilters.test.mjs test/modelColumnConditions.test.mjs
```

---

## Phase 3. Python backend v2 compiler

### 목적

Socket/PTY backend가 Recipe를 authoritative하게 검증하고 같은 의미의 QuerySet을 실행하게 한다.

### 변경 파일

- `python/django_shell_backend.parts.json`
- `python/backend_parts/90_model_query_recipe_predicate.pyfrag`
- `python/backend_parts/91_model_query_recipe_computed.pyfrag`
- `python/backend_parts/50_model_core.pyfrag`
- `python/backend_parts/60_model_aggregate.pyfrag`
- `test/modelQueryRecipeBackend.test.mjs`
- `test/modelQueryRecipeParity.test.mjs`
- `test/modelQueryRecipeBackendSecurity.test.mjs`
- `test/modelQueryRecipeLimits.test.mjs`

### Python 내부 구조

두 v2 fragment를 manifest의 `80_model_edit_query.pyfrag` 뒤에 추가한다. 두 파일 모두 model browser feature source에 포함되도록 feature marker 뒤에 위치한다. 아래 함수군을 순서대로 둔다.

```text
_browse_recipe_limits
_browse_recipe_issue
_browse_recipe_validate
_browse_recipe_validate_group
_browse_recipe_validate_comparison
_browse_recipe_resolve_path
_browse_recipe_value
_browse_recipe_predicate
_browse_recipe_exists_inner
_browse_recipe_subquery_source
_browse_recipe_correlations
_browse_recipe_computed_specs
_browse_recipe_aggregate
_browse_recipe_scalar_subquery
_browse_recipe_exists
_browse_recipe_formula
_browse_recipe_window
_browse_recipe_code_expression
_browse_recipe_rows
_browse_recipe_summary
_browse_recipe_count
_browse_recipe_orm_log
```

각 함수에는 docstring을 둔다.

### 작업

- [ ] **P3-01 — strict parser**
  - TypeScript와 같은 validation 순서와 issue code를 구현한다.
  - request JSON byte size를 UTF-8 기준으로 계산한다.
  - bool을 int로 오인하지 않게 type check 순서를 둔다.
- [ ] **P3-02 — live metadata**
  - `_browse_resolve_filter_path()`를 재사용하되 v2 wrapper가 path length/segment/type/cardinality를 반환한다.
  - client의 field type/cardinality 정보는 받지 않는다.
- [ ] **P3-03 — recursive Q**
  - `_browse_recipe_predicate()`가 Q와 internal Exists annotation과 to-many flag를 반환한다.
  - invalid child를 drop하지 않고 issue를 만든다.
- [ ] **P3-04 — relative time/value coercion**
  - Decimal, UUID, temporal, choices, Boolean을 live field로 검증한다.
  - list/range를 구조화 value 그대로 처리한다.
- [ ] **P3-05 — computed**
  - aggregate/subquery/Exists/Formula/Window/Code expression을 8장 의미론대로 구현한다.
  - Formula alias dependency는 순차 annotate로 실행한다.
  - raw code만 기존 restricted eval 경로를 사용한다.
  - structured node는 `eval`을 사용하지 않는다.
- [ ] **P3-06 — rows integration**
  - `50_model_core.pyfrag`의 `_browse_rows()` 시작부에서 `request.get("recipe")`가 있으면 `_browse_recipe_rows()`로 위임한다.
  - legacy branch는 그대로 유지한다.
- [ ] **P3-07 — summary integration**
  - `60_model_aggregate.pyfrag`의 `_browse_aggregate()`에서 Recipe가 있으면 `_browse_recipe_summary()`로 위임한다.
- [ ] **P3-08 — count/computed integration**
  - `_browse_count()`와 `_browse_computed()`가 Recipe 전체를 재현한다.
- [ ] **P3-09 — response shape**
  - validation failure에 `issues`.
  - success에 normalized `recipeVersion: 2`.
  - rows/summary/count 모두 `orm`, `sql`, warning issues 포함.
- [ ] **P3-10 — remote feature payload 보존**
  - `50_model_core.pyfrag`의 `# --- Model data browser` marker를 바꾸지 않는다.
  - `backendFeaturePayload()`가 v2 code를 포함하는지 test한다.
- [ ] **P3-11 — limit parity**
  - Python source에서 노출한 limit map을 test helper로 읽어 TS/webview와 비교한다.

### 필수 backend 테스트

- 모든 Phase 2 semantic case
- malformed shape 한 건도 query execute하지 않음
- invalid predicate가 broad query로 변하지 않음
- invalid computed가 나머지만 실행되지 않음
- correlation 밖의 OR
- M2M through predicate prefix
- auto distinct
- non-Count fan-out error
- global summary postFilter error
- window filter error
- raw expression blocked
- SQL capture는 최대 기존 50개
- page limit+1

### Parity gate

`test/modelQueryRecipeParity.test.mjs`는 corpus의 모든 `socket`+`orm` case에서:

- rows and order
- annotation values
- summary values
- null behavior
- issue codes
- warning codes

가 동일함을 확인한다.

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryRecipeBackend.test.mjs
node --test test/modelQueryRecipeBackendSecurity.test.mjs
node --test test/modelQueryRecipeParity.test.mjs
node --test test/backendBootstrap.test.mjs test/modelBrowserLifecycle.test.mjs
```

---

## Phase 4. Extension protocol과 applied Recipe lifecycle

### 목적

새 compiler를 아직 legacy UI 뒤에 연결하되 panel의 authoritative query state를 Recipe로 바꾼다.

### 변경/새 파일

- `src/modelBackend.ts`
- `src/backendClient.ts`
- `src/backendClientResponses.ts`
- `src/modelBrowser.ts`
- `src/modelQueryLegacyAdapter.ts`
- `test/modelQueryRecipeLifecycle.test.mjs`
- `test/modelQueryRecipeProtocol.test.mjs`

### 작업

- [ ] **P4-00 — BackendClient 무동작 분할**
  - 현재 `backendClient.ts` class 뒤의 top-level helper(`connectHost`부터 EOF까지)를 `backendClientResponses.ts`로 이동한다.
  - class가 쓰는 helper는 named export/import로 연결한다.
  - 외부 API인 `parseLoadFeatureResponse`는 `backendClient.ts`에서 re-export하여 기존 import를 깨지 않는다.
  - 이동 전후 `test/backendClient.test.mjs`, `test/backendBootstrap.test.mjs`, `test/modelBrowser.test.mjs` output을 동일하게 유지한다.
- [ ] **P4-01 — payload 타입 연결**
  - 10.6의 query interfaces에 `recipe`를 추가한다.
  - internal query에 `recipeMetadata`를 추가하되 backend wire payload에는 포함하지 않는다.
  - rows/aggregate/count response에 optional `issues`, `recipeVersion`을 추가한다.
- [ ] **P4-02 — legacy adapter**
  - `legacyFiltersToWhere(filters)`
  - `legacyAnnotationsToComputed(annotations)`
  - `legacyQueryToRecipe({filters, annotations, groupBy, order, source})`
  - legacy flat filters는 root AND로 변환한다.
  - 변환 불가능한 malformed legacy item은 무시하지 않고 adapter issue로 기록한다.
- [ ] **P4-03 — initialPk**
  - constructor의 initial filter를 Recipe comparison으로 만든다.
- [ ] **P4-04 — BackendClient branch**
  - ORM reconstruction에서 `query.recipe`가 있으면 v2 compiler를 호출한다.
  - legacy query는 기존 compiler를 호출한다.
  - `backendClient.ts`를 850줄 이하로 유지한다.
- [ ] **P4-05 — panel applied state**
  - `appliedRecipe`, `appliedRecipeRevision`을 추가한다.
  - panel-local tree cache와 `loadModelQueryMetadata()`를 연결한다.
  - Apply/Preview가 metadata 준비 중이면 같은 Promise를 공유하고, newer revision이 오면 결과 저장은 하되 old apply를 실행하지 않는다.
  - loadPage/loadComputed/count/summary가 Recipe를 사용한다.
- [ ] **P4-06 — webview message**
  - apply/preview message를 처리한다.
  - source/revision을 검사한다.
  - preview는 extension-host compiler만 호출하고 backend query는 실행하지 않는다.
- [ ] **P4-07 — stale response**
  - row load generation과 Recipe revision을 함께 검사한다.
  - old revision rows/summary/count/preview를 post하지 않거나 webview에서 무시한다.
- [ ] **P4-08 — reload**
  - runtime/schema reload 때 applied Recipe를 재검증한다.
  - invalid이면 기존 grid 유지 + rejected message.
- [ ] **P4-09 — legacy UI bridge**
  - 현 UI Apply는 DOM collect 결과를 legacy adapter로 Recipe로 바꿔 새 protocol을 호출한다.
  - 이 임시 bridge로 backend v2 path가 실제 panel에서 먼저 검증된다.

### 필수 lifecycle 테스트

- initialPk Recipe
- apply revision 증가
- apply 중 draft 변경
- old rows ignored
- old preview ignored
- reload applied only
- invalid reconnect schema가 all-rows로 fallback하지 않음
- count/computed가 same Recipe
- legacy message bridge

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryRecipeProtocol.test.mjs test/modelQueryRecipeLifecycle.test.mjs
node --test test/modelBrowserLifecycle.test.mjs
```

---

## Phase 5. Query Builder shell과 store

### 목적

기존 inline filter/aggregate bar를 summary band + drawer로 교체하고 draft/applied state를 UI에 드러낸다. 아직 각 고급 editor는 placeholder가 아니라 최소 유효 기능을 연결한다.

### 변경/새 파일

- `src/modelBrowserHtml.ts`
- `src/webviewAssets.ts` 또는 기존 stylesheet helper 호출부
- `media/modelQueryBuilder.css`
- `media/gridQueryRecipeStore.js`
- `media/gridQuerySummary.js`
- `media/gridQueryValidationView.js`
- `media/gridQueryController.js`
- `media/modelBrowserSource.js`
- `test/modelQueryRecipeStore.test.mjs`
- `test/modelQueryBuilderShell.test.mjs`
- `test/webviewLayoutContract.test.mjs`

### HTML ID 계약

아래 ID를 사용한다.

```text
querySummaryBand
queryFilterButton
queryColumnsButton
queryModeButton
queryHumanSummary
queryDirtyState
queryValidationState
queryDrawerToggle
queryApply
queryDrawer
queryWhereSection
queryWhereRoot
queryComputedSection
queryComputedList
queryPostFilterSection
queryPostFilterRoot
queryResultSection
queryGroupBy
queryOrderBy
queryPreviewSection
queryOrmPreview
queryIssueSummary
queryResetDraft
queryClearDraft
queryDrawerApply
```

### 작업

- [ ] **P5-01 — HTML**
  - model mode에 summary band/drawer를 넣는다.
  - legacy `filterbar`, `aggregatebar`는 제거한다.
  - query mode의 `querybar`는 그대로 유지한다.
  - section은 semantic heading/fieldset/legend를 사용한다.
- [ ] **P5-02 — stylesheet 분리**
  - `webviewStylesheetLinks()` 목록에 `modelQueryBuilder.css`를 추가한다.
  - 4.7 breakpoint와 layout을 구현한다.
  - VS Code token 외 hard-coded product color를 쓰지 않는다.
- [ ] **P5-03 — store**
  - 10.1/10.2 API/action을 구현한다.
  - node ID monotonic generator와 duplicate deep clone/new IDs를 구현한다.
- [ ] **P5-04 — summary**
  - empty/nested/computed/summary human text를 생성한다.
  - DOM textContent만 사용하고 HTML injection을 하지 않는다.
- [ ] **P5-05 — validation view**
  - issue summary, node mapping, focus callback을 구현한다.
  - error/warning/live state를 색상 외 text/icon으로 표시한다.
- [ ] **P5-06 — controller wiring**
  - `modelBrowserSource.js`에서 query state/functions를 controller로 이동한다.
  - rows/summary/count/preview/rejected response routing을 controller가 담당한다.
  - grid rendering/editing code는 이동하지 않는다.
- [ ] **P5-07 — actions**
  - Apply/Reset/Clear/drawer toggle/Ctrl+Enter를 연결한다.
  - top Apply와 drawer Apply는 같은 controller action을 호출한다.
- [ ] **P5-08 — progress**
  - applying/validating/rejected/success status와 announcer를 연결한다.
- [ ] **P5-09 — file size**
  - `modelBrowserSource.js`를 800줄 이하로 줄인다.

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryRecipeStore.test.mjs test/modelQueryBuilderShell.test.mjs
node --test test/webviewLayoutContract.test.mjs test/modelBrowserLifecycle.test.mjs
wc -l media/modelBrowserSource.js media/gridQueryController.js
```

- model mode에는 legacy bar가 보이지 않는다.
- query mode에는 regression이 없다.
- empty Recipe Apply가 기존 all-rows grid를 연다.

---

## Phase 6. 공통 Predicate Builder

### 목적

WHERE, result filter, aggregate filter, subquery inner filter, Case condition이 같은 recursive component를 사용하게 한다.

### 새 파일

- `media/gridQueryMetadata.js`
- `media/gridPredicateBuilder.js`
- `media/gridPredicateValue.js`
- `test/modelQueryPredicateBuilder.test.mjs`
- `test/modelQueryPredicateAccessibility.test.mjs`

### component API

```js
createPredicateBuilder({
  context: "where" | "postFilter" | "aggregateFilter" | "subquery" | "case",
  dispatch,
  el,
  getRecipe,
  getScope,
  metadata,
  rootNodeId,
  validation
})
```

### 작업

- [ ] **P6-01 — metadata service**
  - field tree/model list request를 target별 cache한다.
  - requestId namespace를 `query-meta-*`로 한다.
  - pending/stale/error/retry state를 제공한다.
- [ ] **P6-02 — group renderer**
  - recursive group, indentation, join, group Not, add/remove/move/duplicate를 구현한다.
  - depth/child limit에서 add button을 disabled한다.
- [ ] **P6-03 — comparison row**
  - path → lookup → RHS kind → value 순서로 rebuild한다.
  - 이전 선택이 새 field와 호환되지 않으면 값을 조용히 바꾸지 않고 해당 node를 invalid 상태로 둔 뒤 사용자가 수정하게 한다.
- [ ] **P6-04 — typed value editor**
  - choices, boolean, date/datetime/time, numeric, text
  - structured list chips
  - structured range pair
  - relative time controls
  - field/outerField picker
- [ ] **P6-05 — lookup labels**
  - 기존 label을 유지하고 `blank`, `not blank`를 추가한다.
  - `(i)` helper 의미를 accessible description에 포함한다.
- [ ] **P6-06 — Exists predicate**
  - relation/model source
  - relation auto correlation read-only
  - model correlation editor 1~4
  - nested target predicate
- [ ] **P6-07 — context restriction**
  - WHERE: field/field RHS/relative/Exists
  - postFilter: computed/group field, Exists 가능하되 OuterRef to computed는 금지
  - aggregate filter: Exists/outerField 금지
  - subquery: target field/F/OuterRef/relative
  - case: source field/previous computed ref
- [ ] **P6-08 — inline issues**
  - validation의 `nodeId`로 row/group에 cause+fix를 표시한다.
- [ ] **P6-09 — focus**
  - add 후 새 row LHS focus
  - remove 후 다음 sibling, 없으면 이전, 없으면 parent add button focus
  - error summary focus callback
- [ ] **P6-10 — keyboard**
  - 4.6 shortcut과 button 동등 기능

### 필수 UI 테스트

- nested add/remove/move/duplicate
- max depth/children
- type 변경 후 incompatible value invalid
- list에 comma 포함 string 보존
- relative time
- field RHS/OuterRef context
- relation Exists correlation 표시
- metadata loading/error/retry/stale
- focus restoration
- aria-label/fieldset/legend/live issue

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryPredicateBuilder.test.mjs test/modelQueryPredicateAccessibility.test.mjs
node --test test/gridAccessibility.test.mjs
```

---

## Phase 7. Computed Column Builder

### 목적

Aggregate/Subquery/Exists/Formula/Window/Code expression을 Recipe-first UI로 완성한다.

### 새 파일

- `media/gridComputedBuilder.js`
- `media/gridAggregateBuilder.js`
- `media/gridSubqueryBuilder.js`
- `media/gridFormulaBuilder.js`
- `media/gridWindowBuilder.js`
- `media/gridCodeExpressionBuilder.js`
- `test/modelQueryComputedBuilder.test.mjs`
- `test/modelQuerySubqueryBuilder.test.mjs`
- `test/modelQueryFormulaBuilder.test.mjs`

### 작업

- [ ] **P7-01 — computed list**
  - add/enable/disable/move/duplicate/remove/collapse를 구현한다.
  - default alias는 suggestion으로 input에 넣되 validation 통과 가능한 값을 생성한다.
  - user alias를 compiler가 다시 변경하지 않는다.
- [ ] **P7-02 — dependency options**
  - 현재 item보다 앞선 enabled alias만 Formula picker에 제공한다.
  - item 이동으로 forward reference가 생기면 inline error를 표시하고 Apply를 막는다.
- [ ] **P7-03 — Aggregate**
  - function, all/field, distinct, shared predicate filter.
  - Count가 아닌 function에서 all/distinct를 disabled한다.
  - to-many unsafe를 선택 즉시 error로 표시한다.
- [ ] **P7-04 — Scalar subquery**
  - Relation/Model source.
  - correlation section.
  - shared inner predicate.
  - Field/Aggregate select.
  - order 최대 3.
  - onEmpty.
  - outputType.
  - relation 변경 시 target metadata가 바뀌면 incompatible child를 삭제하지 않고 invalid로 유지한 뒤 `Reset incompatible fields` 명시 action을 제공한다.
- [ ] **P7-05 — Exists**
  - Subquery source/correlation/where component를 재사용한다.
  - select/order/onEmpty를 렌더링하지 않는다.
- [ ] **P7-06 — Formula**
  - recursive expression node add/replace.
  - field/computed/literal/binary/function/case/cast.
  - function arity에 맞춘 slot.
  - Case branch shared predicate.
  - output type.
- [ ] **P7-07 — Window**
  - current function 집합과 partition/order를 Recipe에 연결한다.
  - order 없는 rank를 inline error.
- [ ] **P7-08 — Code expression**
  - Advanced label/helper/max length.
  - textarea 또는 single-line input은 기존 800자/no-newline 계약 때문에 single-line input을 유지한다.
  - `Only when` toggle을 둔다. off면 required `when`에 empty predicate root를 저장하고 editor를 숨긴다. on이면 같은 shared predicate editor를 표시한다.
  - output type.
- [ ] **P7-09 — summary mode response**
  - summary로 바꾸면 비-aggregate item을 삭제하지 않는다.
  - item에 `Not available in Summary` error를 표시한다.
  - Rows로 돌아오면 원래 item이 그대로 복구된다.
- [ ] **P7-10 — long content**
  - collapsed header는 compact description ellipsis.
  - expanded body만 wrap한다.

### 필수 테스트

- alias suggestion/validation/no auto rename
- enable/disable/downstream dependency
- reorder forward reference
- Aggregate filter nested group
- to-many Count auto distinct
- non-Count fan-out error
- relation/custom subquery
- 1~4 correlations
- correlation outside OR
- max 3 order
- aggregate select
- onEmpty/output type
- Exists
- every Formula function and Case/Cast
- Formula depth/node/arity
- Window order requirement
- Code expression blocked text
- summary mode item preservation/error

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryComputedBuilder.test.mjs
node --test test/modelQuerySubqueryBuilder.test.mjs
node --test test/modelQueryFormulaBuilder.test.mjs
node --test test/modelQueryRecipeParity.test.mjs
```

---

## Phase 8. Result mode, preview, Count, Query Log

### 목적

Recipe 전체 lifecycle과 사용자가 실행 전/후 신뢰할 수 있는 피드백을 완성한다.

### 새/변경 파일

- `media/gridQueryResultBuilder.js`
- `media/gridQuerySummary.js`
- `media/gridQueryController.js`
- `src/modelBrowser.ts`
- `test/modelQueryResultBuilder.test.mjs`
- `test/modelQueryPreview.test.mjs`
- `test/modelQueryRecipeCount.test.mjs`

### 작업

- [ ] **P8-01 — Rows/Summary**
  - explicit mode control.
  - group-by picker와 summary restrictions.
  - grouped/global result title과 footer label.
- [ ] **P8-02 — outer order**
  - 최대 8개.
  - field/computed/group field context.
  - direction.
  - duplicate ref error.
- [ ] **P8-03 — human summary**
  - Boolean group parentheses와 NOT를 보존한다.
  - implicit default order/correlation/distinct를 문장에 포함한다.
  - 1줄 summary와 full preview가 같은 AST renderer를 쓴다.
- [ ] **P8-04 — ORM preview**
  - 10.7 scheduling.
  - Copy ORM.
  - preview error/stale/loading.
- [ ] **P8-05 — Apply snapshot**
  - validation success snapshot만 전송.
  - execution 중 edit를 허용.
  - success applied와 newer draft를 구분.
- [ ] **P8-06 — backend rejection**
  - grid를 비우지 않는다.
  - error summary에 authoritative backend issues를 merge하되 같은 `code+nodeId+path` 중복은 제거한다.
- [ ] **P8-07 — Count**
  - 8.18 의미론.
  - annotation/result filter/count parity.
  - group count label.
- [ ] **P8-08 — Query Log**
  - action label `rows`, `summary`, `count`.
  - Recipe revision과 compact human summary를 meta에 추가한다.
  - raw Recipe JSON은 log에 출력하지 않는다.
- [ ] **P8-09 — pagination**
  - default pk keyset.
  - computed/window/order offset.
  - load more가 같은 applied revision을 사용.
- [ ] **P8-10 — performance**
  - 64 predicate/12 computed worst-case UI mutation과 summary render를 benchmark test.
  - metadata target별 1회 fetch.
  - debounce가 request storm을 막는지 test.

### 완료 게이트

```bash
npm run compile
node --test test/modelQueryResultBuilder.test.mjs
node --test test/modelQueryPreview.test.mjs
node --test test/modelQueryRecipeCount.test.mjs
node --test test/modelQueryRecipeLifecycle.test.mjs
```

---

## Phase 9. Legacy UI 제거, 문서, migration 정리

### 목적

두 UI가 공존하는 상태를 끝내고 유지보수 책임을 명확히 한다.

### 작업

- [ ] **P9-01 — legacy UI import 제거**
  - `modelBrowserSource.js`에서 `gridFilter`, `gridColumnConditions`, `gridAggregate` 참조가 없는지 확인한다.
- [ ] **P9-02 — 파일 삭제**
  - 새 Builder가 모든 기능을 대체한 뒤 세 legacy media file을 삭제한다.
  - 삭제 전 해당 테스트 import를 v2 module로 옮긴다.
- [ ] **P9-03 — legacy protocol 유지 범위**
  - `src/modelOrm.ts`와 Python legacy request branch는 한 release compatibility를 위해 유지한다.
  - 새 UI는 legacy payload를 보내지 않는다.
  - legacy adapter는 initial migration/characterization test 용도로 유지한다.
- [ ] **P9-04 — README**
  - Filter/`+ Column` 설명을 Query Builder v2로 교체한다.
  - nested groups, F, relative time, Subquery, Exists, Formula, result filter, summary를 설명한다.
  - property full scan, window filter 미지원, transport capability를 명시한다.
- [ ] **P9-05 — DESIGN**
  - summary band/drawer/draft-applied/error behavior를 component rule에 추가한다.
- [ ] **P9-06 — PRODUCT**
  - 제품 원칙은 바꾸지 않는다.
  - 필요한 경우 “advanced query assembly”를 existing progressive disclosure 문단에 한 줄 보강한다.
- [ ] **P9-07 — dead code 확인**

```bash
rg -n "createFilterBar|createColumnConditionBuilder|createColumnBuilder|aggregateTerms|filterterms" media src test
```

- [ ] **P9-08 — code guideline**
  - 모든 새 JS/TS 첫 줄 comment.
  - src function/class JSDoc.
  - 모든 code file 1000줄 이하.

### 완료 게이트

```bash
npm run check
```

---

## Phase 10. 접근성, 시각 QA, 실제 프로젝트 검증

### 목적

기능 테스트와 별개로 실제 VS Code webview에서 사용성을 확인하고, `rtcc-poc-page`의 실제 Django shell에서 read-only end-to-end를 완료한다.

### 10.1 자동 접근성 계약 테스트

- [ ] 모든 icon-only button에 accessible name
- [ ] drawer toggle `aria-expanded`/`aria-controls`
- [ ] fieldset/legend 또는 동등한 group label
- [ ] combobox/listbox/option role와 keyboard
- [ ] issue summary link/button
- [ ] errors와 warnings가 color-only가 아님
- [ ] focus-visible
- [ ] polite/assertive live region
- [ ] disabled reason text
- [ ] move/duplicate/remove button 존재
- [ ] Escape focus behavior

명령:

```bash
node --test test/modelQueryPredicateAccessibility.test.mjs test/gridAccessibility.test.mjs test/webviewLayoutContract.test.mjs
```

### 10.2 시각 QA viewport

실제 렌더된 Model Data webview를 아래 조건에서 각각 확인하고 screenshot을 남긴다.

| 폭/상태 | 확인 |
|---|---|
| 1440×900 wide | 2-column drawer, sticky preview, grid 공간 |
| 800×900 split | single-column sections, wrap 순서 |
| 600×900 narrow | stacked row, sticky action footer, no horizontal nested scroll |
| 390×844 extreme narrow | 모든 action 접근 가능, text clipping만 허용 |
| 200% zoom | focus/issue/action 접근 가능 |
| Dark | semantic token contrast |
| Light | border/input/selection contrast |
| High Contrast | focus/error/group boundary |

각 viewport에서:

1. empty
2. simple one-line filter
3. 3-depth nested group
4. metadata loading
5. metadata error
6. invalid value
7. 3 computed columns
8. expanded scalar subquery
9. expanded Case
10. summary mode
11. applying
12. backend rejection

을 확인한다.

### 10.3 Interaction QA

- [ ] mouse로 simple filter 생성/Apply
- [ ] keyboard only로 nested group 생성/Apply
- [ ] item move/duplicate/remove
- [ ] combobox search/select/Escape
- [ ] error summary → node focus
- [ ] draft edit → Reset
- [ ] Clear → Apply 전 grid 유지
- [ ] Apply 중 추가 edit → result/applied/draft 분리
- [ ] stale preview/rows 무시
- [ ] drawer close/open draft 보존
- [ ] Load more same revision
- [ ] Count same Recipe
- [ ] Query Log ORM copy

### 10.4 실제 `rtcc-poc-page` shell 초기화

아래 명령은 합치지 않고 VS Code integrated terminal에 정확히 한 줄씩 입력한다.

```bash
pm 5
```

`pm 5`는 반드시 `pm`과 `5` 사이에 space가 있어야 한다. 5번 virtual network context로 전환된 prompt가 준비된 뒤 다음을 입력한다.

```bash
./zz django shell
```

금지:

- `./zz shell`
- `./zz django-shell`
- `pm5`
- `pm 5 ./zz django shell`

Django shell과 extension backend가 ready가 된 뒤 Model Data를 연다.

### 10.5 실제 project read-only Recipe

대상 model: `db.Company`

#### RTCC-01 — nested WHERE

```text
deleted_at is null
AND (
  _base_name contains (i) "테스트"
  OR is_demo = true
)
```

확인:

- preview의 괄호가 유지됨
- Apply 성공
- Query Log에 AND/OR Q 구조
- Count가 displayed Recipe와 동일

#### RTCC-02 — Formula

```text
id_plus_one = id + 1
```

확인:

- 새 column 값이 `id + 1`
- alias sort 가능
- result filter `id_plus_one > 1`

#### RTCC-03 — custom scalar subquery

```text
alias: self_name
target: db.Company
correlation: target.id = current.id
select: _base_name
order: id asc
on empty: null
output: text
```

확인:

- `self_name`과 `_base_name`이 같은 row에서 일치
- correlation이 OR 조건 밖에 표시/컴파일

#### RTCC-04 — Exists

```text
alias: self_exists
target: db.Company
correlation: target.id = current.id
where: empty
```

확인:

- 모든 표시 row에서 true
- output type boolean

#### RTCC-05 — grouped summary

```text
mode: Summary
group by: is_demo
row_count = Count(all rows)
result filter: row_count >= 1
order: row_count desc
```

확인:

- read-only summary
- Count button은 group count
- Rows로 돌아오면 이전 per-row computed draft가 보존

### 10.6 Transport 실제 검증

RTCC-01~RTCC-04를 다음 순서로 각각 적용한다.

1. Link: Auto
2. Link: ORM
3. Link: Socket

확인:

- 같은 rows/order/value
- 같은 validation error/warning
- Query Log ORM 의미가 같음
- unsupported transport 조합은 실행 전에 명시 오류

`Commit`과 nested relation edit는 사용하지 않는다.

### 10.7 최종 자동 검증

```bash
npm run check
```

필요한 경우 실제 UI E2E:

```bash
npm run test:e2e
```

E2E는 현재 환경에서 VS Code UI를 실제 열 수 있을 때만 실행하고, 실행하지 않았다면 최종 보고에 명시한다.

---

## 13. 테스트 매트릭스

### 13.1 Predicate semantics

| Case | TS validate | ORM compile/eval | Socket | UI |
|---|---:|---:|---:|---:|
| empty root | ✓ | ✓ | ✓ | ✓ |
| AND | ✓ | ✓ | ✓ | ✓ |
| OR | ✓ | ✓ | ✓ | ✓ |
| nested 5 depth | ✓ | ✓ | ✓ | ✓ |
| group NOT | ✓ | ✓ | ✓ | ✓ |
| leaf NOT | ✓ | ✓ | ✓ | ✓ |
| relation traversal | ✓ | ✓ | ✓ | ✓ |
| relation terminal isnull | ✓ | ✓ | ✓ | ✓ |
| F RHS | ✓ | ✓ | ✓ | ✓ |
| relative now/today | ✓ | ✓ | ✓ | ✓ |
| blank/not_blank | ✓ | ✓ | ✓ | ✓ |
| list/range typed | ✓ | ✓ | ✓ | ✓ |
| Exists relation/model | ✓ | ✓ | ✓ | ✓ |
| invalid/incomplete | ✓ | query 없음 | query 없음 | Apply disabled |

### 13.2 Computed semantics

| Case | Rows | Summary | PostFilter | Sort |
|---|---:|---:|---:|---:|
| Count | ✓ | ✓ | ✓ | ✓ |
| Sum/Avg/Min/Max safe path | ✓ | ✓ | ✓ | ✓ |
| conditional aggregate | ✓ | ✓ | ✓ | ✓ |
| scalar field subquery | ✓ | 아니오 | ✓ | ✓ |
| scalar aggregate subquery | ✓ | 아니오 | ✓ | ✓ |
| Exists column | ✓ | 아니오 | ✓ | ✓ |
| Formula | ✓ | 아니오 | ✓ | ✓ |
| Case/Cast/Coalesce | ✓ | 아니오 | ✓ | ✓ |
| Window | ✓ | 아니오 | error | ✓ |
| Code expression | ✓ | 아니오 | ✓ if non-window | ✓ |

### 13.3 Safety

- malformed JSON-compatible shapes
- unexpected arrays/objects/scalars
- prototype-like keys
- duplicate IDs
- injection in every identifier/path/string location
- blocked raw expression
- excessive depth/count/size
- oversized ORM output
- direct backend bypass
- invalid node never widens query
- property scan restriction
- relation fan-out

### 13.4 Lifecycle

- draft/applied
- validation revisions
- apply revisions
- row generation
- preview debounce/stale
- runtime reconnect
- schema drift
- page/load more
- count
- computed property lazy load
- summary → rows transition
- transport change

### 13.5 Compatibility

- existing model browser filters
- existing aggregate/annotation/subquery legacy backend tests
- grid edit/Commit staging
- pin/resize/virtualization
- relation expansion
- field finder
- Query Log
- free ORM Query mode
- model catalog open with initial pk
- remote feature bootstrap

---

## 14. 성능 예산

| 항목 | 목표 |
|---|---:|
| simple draft action UI update | p95 16ms 이하 |
| 64 predicate validation | p95 25ms 이하 |
| 12 computed summary render | p95 25ms 이하 |
| human summary generation | p95 10ms 이하 |
| metadata cache hit | synchronous |
| 같은 model tree network request | session당 1회 |
| preview debounce | 250ms |
| Apply progress 표시 | action 후 100ms 이내 |
| drawer open | 50ms 이내 |
| query result DOM | 기존 grid cell budget 유지 |

benchmark test는 CI 부하에 민감하므로 절대 wall-clock failure threshold를 위 값의 4배로 두고, local profiling 목표는 표의 값을 사용한다.

Query Builder는 최대 64 node이므로 자체 virtualization을 도입하지 않는다. 대신 collapsed computed item과 section disclosure로 DOM을 제한한다.

---

## 15. 위험과 대응

| 위험 | 징후 | 대응 | rollback 단위 |
|---|---|---|---|
| Socket/ORM 의미 drift | parity fixture 결과 차이 | 해당 feature merge 중단, compiler 둘 다 수정 | Phase 2/3 feature별 commit |
| invalid query가 넓어짐 | invalid payload에서 rows 반환 | whole-recipe failure test를 최우선 수정 | backend v2 branch |
| relation fan-out 오계산 | Count/Sum 값이 transport별 다름 | live cardinality resolver와 distinct warning 검사 | aggregate compiler |
| raw expression capability drift | 한 transport만 성공 | 허용 syntax 교집합 축소 | code expression module |
| remote payload 증가 | inline feature load timeout | payload byte/time test, 불필요 log/helper 축소 | Python v2 feature block |
| builder UI wrap 붕괴 | narrow에서 nested scroll | 1-column row와 drawer scroll ownership 적용 | CSS module |
| near-limit 기존 파일 초과 | guideline failure | 새 module로 이동, 기존 파일에는 facade만 | 해당 wiring change |
| stale result가 최신 draft를 덮음 | edit 후 Draft 표시 사라짐 | revision assertion과 lifecycle test | controller/panel |
| property filter 과부하 | 긴 full scan | warning, elapsed, 조합 제한, explicit Count | property compatibility path |
| dirty 사용자 파일 충돌 | 기존 change와 같은 hunk | 변경 전 diff 확인, 최소 hunk, 사용자 내용 보존 | 해당 file patch |

---

## 16. Requirement 추적표

| 요구 | 구현 위치 | 핵심 테스트 |
|---|---|---|
| 쉬운 simple filter | Predicate row 기본값 | builder UI test |
| nested powerful query | recursive group AST | corpus nested cases |
| F comparison | common RHS | ORM/backend parity |
| relative time | RHS + compiler | temporal fixture |
| annotation 고도화 | Formula/Case | formula tests |
| subquery 고도화 | source/correlation/select/order | subquery tests |
| Exists | predicate + computed | corpus Exists |
| result filter | postFilter | count/parity |
| summary/HAVING | explicit mode | summary fixture |
| 실행 전 이해 | human/ORM preview | preview tests |
| 오류 신뢰성 | whole-recipe validation | security tests |
| transport parity | dual compiler corpus | parity test |
| no-judgment Terra 실행 | Phase checklist/gates | 이 문서 audit |
| 실제 프로젝트 | pm 5 + exact shell command | RTCC checklist |

---

## 17. 최종 완료 체크리스트

### Code

- [ ] 모든 새 JS/TS 파일 첫 줄 목적 주석
- [ ] 모든 `src/` function/class/method JSDoc
- [ ] 모든 code file 1000줄 이하
- [ ] Python loader와 모든 `.pyfrag` 1000줄 이하
- [ ] remote payload는 ordered fragments의 단일 합성 source
- [ ] `modelBrowserSource.js` 800줄 이하
- [ ] `backendClient.ts` 1000줄 이하
- [ ] structured Recipe path에서 `eval` 없음
- [ ] invalid node silent drop 없음
- [ ] UI metadata hint를 backend가 신뢰하지 않음

### Function

- [ ] nested AND/OR/group NOT
- [ ] relation traversal/Exists
- [ ] F RHS
- [ ] relative time
- [ ] typed list/range
- [ ] blank/not_blank
- [ ] Aggregate
- [ ] scalar subquery field/aggregate
- [ ] Exists column
- [ ] Formula/Case/Cast/functions
- [ ] Window restrictions
- [ ] Code expression restrictions
- [ ] result filter
- [ ] rows/summary
- [ ] sort/page/count

### UX

- [ ] summary band
- [ ] draft/applied
- [ ] Reset/Clear/Apply
- [ ] loading/empty/error/warning/applying/success
- [ ] inline + summary errors
- [ ] keyboard structural actions
- [ ] focus restoration
- [ ] wide/split/narrow
- [ ] dark/light/high contrast
- [ ] 200% zoom

### Integration

- [ ] Auto/ORM/Socket parity
- [ ] remote feature payload
- [ ] runtime reconnect
- [ ] schema drift
- [ ] Query mode regression 없음
- [ ] grid edit/Commit regression 없음
- [ ] `npm run check`
- [ ] 가능한 환경에서 `npm run test:e2e`
- [ ] `pm 5`
- [ ] `./zz django shell`
- [ ] RTCC-01~05 read-only 검증

---

## 18. Terra High 실행 규칙

Terra High 구현 agent는 다음을 그대로 따른다.

1. 이 문서의 D-01~D-17을 변경하지 않는다.
2. “더 나은 UX”를 이유로 별도 modal, page, framework, visual language를 만들지 않는다.
3. schema/type/상한/error code를 임의 변경하지 않는다.
4. Phase를 합치지 않는다.
5. silent fallback을 추가하지 않는다.
6. unsupported 기능을 숨겨 실행하지 말고 명시 오류로 만든다.
7. existing dirty files를 먼저 diff로 확인하고 관련 hunk만 수정한다.
8. 새 기능은 purpose module에 넣고 near-limit file을 키우지 않는다.
9. 각 Phase 종료 시:
   - 변경 파일
   - 실행한 명령
   - 통과/실패 test
   - 남은 issue
   - 다음 Phase 진입 가능 여부
   를 기록한다.
10. blocker가 아니면 사용자 판단을 다시 요청하지 않고 이 문서의 결정을 사용한다.
11. 다음 경우에만 중단하고 사용자에게 보고한다.
   - live Django version이 명세의 expression을 지원하지 않아 같은 의미의 안전한 대체가 없음
   - 실제 model metadata가 명세와 근본적으로 충돌
   - 사용자 dirty change와 필수 변경이 같은 의미를 서로 다르게 구현
   - test fixture로 재현되는 transport 의미 불일치를 명세 안에서 해결할 수 없음
12. “일부 구현”을 완료로 보고하지 않는다. 17장의 모든 applicable item과 최종 check가 끝나야 완료다.

---

## 19. 구현 완료 보고 형식

```md
## 결과
- Query Recipe v2:
- Predicate Builder:
- Computed Builder:
- Transport parity:
- Actual RTCC verification:

## 검증
- `npm run check`:
- `npm run test:e2e`:
- Auto / ORM / Socket:
- Wide / Split / Narrow:
- Dark / Light / High Contrast / 200%:

## 보존 사항
- 사용자 기존 변경:
- 데이터 write 수행 여부: 없음

## 남은 제한
- Window result filtering: unsupported by design
- Regex/raw SQL/saved recipes: out of scope
```

완료 보고에서 실행하지 않은 browser, viewport, theme, transport, test를 실행했다고 쓰지 않는다.
