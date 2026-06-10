// Verifies the model data-browser filter/sort transforms: annotation-alias sorting, the text Length/Trim
// transforms, and built-in date/time extracts — across the ORM-cell reconstruction and the socket backend.

import assert from "node:assert/strict";
import test from "node:test";

import { createFilterBar } from "../media/gridFilter.js";
import { HAS_DJANGO, buildComputedOrm, buildRowsOrm, runBackend } from "./modelBrowserHelpers.mjs";

/** Minimal DOM-node stub for exercising the filter bar's chip rendering without a real document. */
function stubEl(tag, attrs = {}, ...kids) {
  return {
    tag, attrs, kids: [...kids], onClick: null,
    appendChild(child) { this.kids.push(child); return child; },
    addEventListener(event, handler) { if (event === "click") { this.onClick = handler; } },
    querySelectorAll() { return []; },
    set innerHTML(_value) { this.kids = []; },
    get innerHTML() { return ""; }
  };
}

test("each applied-filter chip carries an ✕ that removes only that filter", () => {
  let removed;
  const activeEl = stubEl("span");
  const bar = createFilterBar({ el: stubEl, termsEl: stubEl("span"), activeEl, getState: () => ({ columns: [], relations: [] }), postRaw: () => {}, lookups: new Set(), onRemove: (next) => { removed = next; } });
  const filters = [{ field: "a", lookup: "exact", value: "1" }, { field: "b", lookup: "icontains", value: "x" }, { field: "c", lookup: "gt", value: "3" }];
  bar.renderSummary(filters);
  const chips = activeEl.kids.filter((kid) => kid && kid.attrs && kid.attrs.className === "filterchip");
  assert.equal(chips.length, 3, "one chip per applied filter");
  const middleX = chips[1].kids[chips[1].kids.length - 1];
  middleX.onClick();
  assert.deepEqual(removed, [filters[0], filters[2]], "removing the middle chip drops only that filter, keeping the rest");
});

/** Fuller DOM-node stub (append/querySelector/classList) for driving the cascading filter term builder. */
function richEl(tag, attrs = {}, ...kids) {
  const node = {
    tag, dataset: {}, kids: [...kids], listeners: {}, hidden: false, style: {}, value: "", textContent: "",
    className: attrs.className || "",
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, toggle(c, f) { const on = f === undefined ? !this.s.has(c) : f; on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } },
    appendChild(c) { this.kids.push(c); return c; }, append(...cs) { for (const c of cs) this.kids.push(c); },
    addEventListener(ev, fn) { this.listeners[ev] = fn; }, removeEventListener() {}, dispatchEvent() { return true; },
    remove() {}, focus() {}, select() {},
    get innerHTML() { return ""; }, set innerHTML(_v) { this.kids = []; }, get children() { return this.kids; },
    querySelector(sel) { return findOne(this, sel); }, querySelectorAll(sel) { const out = []; findAll(this, sel, out); return out; }
  };
  if (attrs.dataset) { Object.assign(node.dataset, attrs.dataset); }
  for (const cls of String(attrs.className || "").split(/\s+/).filter(Boolean)) { node.classList.add(cls); }
  for (const key of ["title", "type", "placeholder", "checked", "spellcheck"]) { if (key in attrs) { node[key] = attrs[key]; } }
  return node;
}
function selMatch(node, sel) { const m = /^\[data-role=(.+)\]$/.exec(sel); if (m) { return node.dataset && node.dataset.role === m[1]; } return sel.startsWith(".") && node.classList && node.classList.contains(sel.slice(1)); }
function findOne(root, sel) { for (const child of root.kids || []) { if (selMatch(child, sel)) { return child; } const hit = findOne(child, sel); if (hit) { return hit; } } return null; }
function findAll(root, sel, out) { for (const child of root.kids || []) { if (selMatch(child, sel)) { out.push(child); } findAll(child, sel, out); } }
/** Reads the option objects offered by a term's first (root) cascading combobox. */
function rootSegOptions(termsEl) { const path = findOne(termsEl, "[data-role=path]"); return (path && path.kids[0] && path.kids[0]._options) || []; }

test("a filter term refreshes its options to include a newly-added annotation alias", async () => {
  const state = { pk: "id", model: "auth.User", columns: [{ attname: "id", pk: true, type: "AutoField" }, { attname: "username", type: "CharField" }], relations: [], aggregateColumns: [] };
  const termsEl = richEl("div");
  let bar;
  bar = createFilterBar({ el: richEl, termsEl, activeEl: richEl("div"), getState: () => state, postRaw: (message) => { if (message.type === "filterFields") { bar.onTreeResponse({ requestId: message.requestId, result: { ok: false } }); } }, lookups: new Set(["exact", "gt", "gte", "lt", "lte", "in", "range", "isnull"]) });
  bar.addTerm();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rootSegOptions(termsEl).some((option) => option.value === "f:total"), false, "the alias is absent before a + Column creates it");
  // A + Column adds an annotation column to the live grid state, then the panel calls refresh().
  state.columns.push({ annotation: true, attname: "total", name: "total", type: "annotation" });
  bar.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = rootSegOptions(termsEl);
  assert.equal(after.some((option) => option.value === "f:total" && option.type === "annotation"), true, "refresh() surfaces the new annotation alias in the already-open term");
  assert.equal(after.filter((option) => option.value === "f:total").length, 1, "the alias appears exactly once (no flat-fallback duplicate)");
});

test("reconstructs annotation-sort and text-length filters as injection-proof ORM cells", () => {
  const cols = [{ attname: "id", name: "id", pk: true, type: "AutoField" }, { attname: "username", name: "username", type: "CharField" }, { annotation: true, attname: "gc", name: "gc", type: "annotation" }];
  const rels = [{ kind: "m2m", name: "groups", queryName: "groups", single: false, target: "auth.Group" }];
  // Sorting by an annotation alias annotates first, then order_by the alias (so Django can resolve it).
  const sort = buildRowsOrm({ annotations: [{ alias: "gc", distinct: true, field: "groups", func: "count", kind: "aggregate" }], app: "auth", columns: cols, limit: 50, model: "User", order: [{ desc: true, field: "gc" }], relations: rels });
  assert.match(sort, /\.annotate\(gc=models\.Count\("groups", distinct=True\)\)\.order_by\('-gc'\)/);
  // The lazy @property page re-applies the same annotation so its order_by('-gc') resolves identically.
  const computed = buildComputedOrm("auth", "User", "uname_len", undefined, [{ desc: true, field: "gc" }], 50, cols, rels, [{ alias: "gc", distinct: true, field: "groups", func: "count", kind: "aggregate" }]);
  assert.match(computed, /\.annotate\(gc=models\.Count\("groups", distinct=True\)\)/);
  assert.ok(computed.indexOf(".annotate(") < computed.indexOf(".order_by("), "the @property page annotates before ordering by the alias");
  // A text length filter compiles to field__length__<cmp> with a NUMERIC operand (not a quoted string).
  const len = buildRowsOrm({ app: "auth", columns: cols, filters: [{ field: "username", lookup: "length__gt", value: "5" }], limit: 50, model: "User" });
  assert.match(len, /\.filter\(\*\*\{"username__length__gt": 5\}\)/);
  const lenExact = buildRowsOrm({ app: "auth", columns: cols, filters: [{ field: "username", lookup: "length", value: "3" }], limit: 50, model: "User" });
  assert.match(lenExact, /\.filter\(\*\*\{"username__length": 3\}\)/);
  // A non-numeric length operand never becomes an unsafe literal — it falls back to 0.
  const lenBad = buildRowsOrm({ app: "auth", columns: cols, filters: [{ field: "username", lookup: "length__gt", value: "x); import os #" }], limit: 50, model: "User" });
  assert.match(lenBad, /\.filter\(\*\*\{"username__length__gt": 0\}\)/);
  // Date/time extracts compile to NUMERIC kwargs; the Trim transform stays a quoted-string match.
  const dateCols = [{ attname: "date_joined", name: "date_joined", type: "DateTimeField" }];
  const hour = buildRowsOrm({ app: "auth", columns: dateCols, filters: [{ field: "date_joined", lookup: "hour", value: "15" }], limit: 50, model: "User" });
  assert.match(hour, /\.filter\(\*\*\{"date_joined__hour": 15\}\)/);
  const quarter = buildRowsOrm({ app: "auth", columns: dateCols, filters: [{ field: "date_joined", lookup: "quarter", value: "3" }], limit: 50, model: "User" });
  assert.match(quarter, /\.filter\(\*\*\{"date_joined__quarter": 3\}\)/);
  const trim = buildRowsOrm({ app: "auth", columns: cols, filters: [{ field: "username", lookup: "trim", value: "spaced" }], limit: 50, model: "User" });
  assert.match(trim, /\.filter\(\*\*\{"username__trim": "spaced"\}\)/);
});

test("sorts rows by an annotation alias across the socket path and keeps the @property page aligned", { skip: !HAS_DJANGO }, () => {
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User, Group",
    "from django.db import connection, reset_queries",
    "User.uname_len = property(lambda self: len(self.username))",
    "g1 = Group.objects.create(name='g1'); g2 = Group.objects.create(name='g2')",
    "u = {i: User.objects.create(username=f'user{i}', password='x') for i in range(4)}",
    "u[1].groups.add(g1, g2); u[2].groups.add(g1)",
    "ann = [{'kind': 'aggregate', 'func': 'count', 'field': 'groups', 'alias': 'gc', 'distinct': True}]",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, 'app': 'auth', 'model': 'User', **kw}, set())",
    "reset_queries()",
    "desc = call('rows', annotations=ann, order=[{'field': 'gc', 'desc': True}], limit=2)",
    "desc_queries = len(connection.queries)",
    "asc = call('rows', annotations=ann, order=[{'field': 'gc', 'desc': False}])",
    "comp = call('computed', annotations=ann, order=[{'field': 'gc', 'desc': True}], field='uname_len', limit=2)",
    "print(json.dumps({",
    "  'desc_users': [r['username'] for r in desc['rows']], 'desc_gc': [r['gc'] for r in desc['rows']],",
    "  'desc_queries': desc_queries, 'desc_offset': desc['nextOffset'], 'desc_cursor': desc['nextCursor'],",
    "  'asc_first_gc': asc['rows'][0]['gc'],",
    "  'orm_annotate_before_order': desc['orm'].index('.annotate(') < desc['orm'].index(\".order_by('-gc')\"),",
    "  'comp_ok': comp['ok'], 'comp_keys': sorted(int(k) for k in comp['values'].keys()), 'page_pks': sorted(r['id'] for r in desc['rows']),",
    "}))"
  ]);
  assert.deepEqual(payload.desc_users, ["user1", "user2"], "rows sort by the annotation alias (most groups first)");
  assert.deepEqual(payload.desc_gc, [2, 1]);
  assert.equal(payload.desc_queries, 1, "an annotation sort stays a single query");
  assert.equal(payload.desc_cursor, null, "a non-pk annotation sort uses offset, not a keyset cursor");
  assert.equal(payload.desc_offset, 2, "annotation sort paginates by offset");
  assert.equal(payload.asc_first_gc, 0, "ascending annotation sort puts the smallest count first");
  assert.equal(payload.orm_annotate_before_order, true, "the logged ORM annotates before ordering by the alias (runnable)");
  assert.equal(payload.comp_ok, true);
  assert.deepEqual(payload.comp_keys, payload.page_pks, "the lazy @property page covers exactly the annotation-sorted rows page");
});

test("filters a char/text field by string length (Length transform), dropping it on non-text fields", { skip: !HAS_DJANGO }, () => {
  const lenCell = buildRowsOrm({ app: "auth", columns: [{ attname: "username", name: "username", type: "CharField" }], filters: [{ field: "username", lookup: "length__gt", value: "2" }], limit: 50, model: "User" });
  const payload = runBackend([
    "import json",
    "from django.conf import settings",
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True)",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User",
    "mod._register_transform_lookups()",  // start() registers Length/Trim in the real flow; _run_request alone does not
    "for name in ['a', 'bb', 'ccc', 'dddd']: User.objects.create(username=name, password='x')",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, 'app': 'auth', 'model': 'User', **kw}, set())",
    "gt2 = call('rows', filters=[{'field': 'username', 'lookup': 'length__gt', 'value': '2'}])",
    "eq3 = call('rows', filters=[{'field': 'username', 'lookup': 'length', 'value': '3'}])",
    "lte2 = call('count', filters=[{'field': 'username', 'lookup': 'length__lte', 'value': '2'}])",
    "nontext = call('rows', filters=[{'field': 'id', 'lookup': 'length__gt', 'value': '0'}])",
    `cell = ${JSON.stringify(lenCell)}`,
    "def ev(expr):",
    "    try: return sorted(o.username for o in eval(expr))",
    "    except Exception as e: return type(e).__name__",
    "print(json.dumps({",
    "  'gt2': sorted(r['username'] for r in gt2['rows']), 'gt2_orm': 'username__length__gt=2' in gt2['orm'],",
    "  'eq3': sorted(r['username'] for r in eq3['rows']), 'lte2': lte2['count'],",
    "  'nontext_rows': len(nontext['rows']), 'nontext_ok': nontext['ok'], 'cell_eval': ev(cell),",
    "}))"
  ]);
  assert.deepEqual(payload.gt2, ["ccc", "dddd"], "length > 2 keeps usernames longer than 2 chars");
  assert.equal(payload.gt2_orm, true, "the executed SQL/ORM log shows field__length__gt with a numeric operand");
  assert.deepEqual(payload.eq3, ["ccc"], "exact length matches");
  assert.equal(payload.lte2, 2, "count honors the length filter (a, bb)");
  assert.equal(payload.nontext_ok, true);
  assert.equal(payload.nontext_rows, 4, "a length filter on a non-text field is dropped, never raised");
  assert.deepEqual(payload.cell_eval, ["ccc", "dddd"], "the reconstructed ORM-mode cell runs the same length filter");
});

test("filters via the Trim transform and built-in date/time extracts (hour/quarter/minute)", { skip: !HAS_DJANGO }, () => {
  const trimCell = buildRowsOrm({ app: "auth", columns: [{ attname: "username", name: "username", type: "CharField" }], filters: [{ field: "username", lookup: "trim", value: "spaced" }], limit: 50, model: "User" });
  const payload = runBackend([
    "import json, datetime",
    "from django.conf import settings",
    // TIME_ZONE='UTC' so the date/time extracts read the stored UTC datetimes directly (no tz shift on the hour).
    "settings.configure(DEBUG=True, DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'], USE_TZ=True, TIME_ZONE='UTC')",
    "import django; django.setup()",
    "from django.core.management import call_command; call_command('migrate', '--run-syncdb', verbosity=0)",
    "from django.contrib.auth.models import User",
    "mod._register_transform_lookups()",
    "spaced = User.objects.create(username='  spaced  ', password='x', date_joined=datetime.datetime(2019, 3, 20, 3, 7, tzinfo=datetime.timezone.utc))",
    "afternoon = User.objects.create(username='afternoon', password='x', date_joined=datetime.datetime(2020, 1, 6, 15, 30, tzinfo=datetime.timezone.utc))",
    "morning = User.objects.create(username='morning', password='x', date_joined=datetime.datetime(2020, 7, 15, 9, 5, tzinfo=datetime.timezone.utc))",
    "def call(kind, **kw): return mod._run_request({}, 't', {'token': 't', 'kind': kind, 'app': 'auth', 'model': 'User', **kw}, set())",
    "trimmed = call('rows', filters=[{'field': 'username', 'lookup': 'trim', 'value': 'spaced'}])",
    "trim_nontext = call('rows', filters=[{'field': 'id', 'lookup': 'trim', 'value': '1'}])",
    "hour15 = call('rows', filters=[{'field': 'date_joined', 'lookup': 'hour', 'value': '15'}])",
    "q3 = call('rows', filters=[{'field': 'date_joined', 'lookup': 'quarter', 'value': '3'}])",
    "min5 = call('rows', filters=[{'field': 'date_joined', 'lookup': 'minute', 'value': '5'}])",
    `cell = ${JSON.stringify(trimCell)}`,
    "def ev(expr):",
    "    try: return sorted(o.username for o in eval(expr))",
    "    except Exception as e: return type(e).__name__",
    "print(json.dumps({",
    "  'trimmed': [r['username'] for r in trimmed['rows']], 'trim_orm': \"username__trim='spaced'\" in trimmed['orm'],",
    "  'trim_nontext_rows': len(trim_nontext['rows']), 'trim_nontext_ok': trim_nontext['ok'],",
    "  'hour15': sorted(r['username'] for r in hour15['rows']), 'hour_orm': 'date_joined__hour=15' in hour15['orm'],",
    "  'q3': sorted(r['username'] for r in q3['rows']), 'min5': sorted(r['username'] for r in min5['rows']),",
    "  'cell_eval': ev(cell),",
    "}))"
  ]);
  assert.deepEqual(payload.trimmed, ["  spaced  "], "Trim() matches the whitespace-stripped value");
  assert.equal(payload.trim_orm, true, "the ORM log shows the field__trim lookup");
  assert.equal(payload.trim_nontext_ok, true);
  assert.equal(payload.trim_nontext_rows, 3, "Trim on a non-text field is dropped, never raised");
  assert.deepEqual(payload.hour15, ["afternoon"], "the hour extract matches the 15:xx row");
  assert.equal(payload.hour_orm, true, "the hour extract is logged with a numeric operand");
  assert.deepEqual(payload.q3, ["morning"], "the quarter extract matches the Q3 row");
  assert.deepEqual(payload.min5, ["morning"], "the minute extract matches the :05 row");
  assert.deepEqual(payload.cell_eval, ["  spaced  "], "the reconstructed ORM-mode Trim cell runs identically");
});
