# TDK — capabilities and remaining gaps

**Goal:** author a production-shaped Backstage Scaffolder template entirely in
TypeScript and `compile` it back to schema-valid YAML, with no hand-written
JSONata or YAML. When a real reference template round-trips, TDK can express a
production-shaped template and that template doubles as a regression test.

## Where TDK is now (done + verified)

- Single TS source → `compile` to **nonprod + prod** repos, env-targeted,
  **env-safety enforced**, lifecycle → `restrictedToUsers`, real
  Backstage-schema validation. Proven end-to-end in `tdk-playground` (tdk
  consumed as a linked package).
- **JSONata transpiler incl. the statement layer**: block bodies, `const`/`let`
  → `$x :=`, reassignment, `return`, `assert` → `$assert`, `.concat` →
  `$append`, array-literal `.includes` → `in`. A block-bodied order-pricing
  benchmark round-trips exactly (differential-tested against a reference JSONata
  over a dozen fixtures, value- and throw-for-throw) — see
  `src/__fixtures__/cake-order.ts` and its colocated test.

So the **logic layer is done**. What remains is mostly **richer env / step
ergonomics**.

## Gaps (prioritized)

### 1. Rich parameter model — biggest ✅ DONE
**Built.** Multi-page `pages` + `page(...)`, property features (`enumNames`,
`ui:field`/`ui:widget`/`ui:placeholder`/`ui:options`), custom field extensions
(the generic `p.customField` + the `defineField` hook for typed helpers), and
conditional dependencies (`dep.when`/`eq`/`oneOf`/`not`, nestable). A synthetic
4-page form exercising every one of these (including a nested dependency chain)
is authored in `src/__fixtures__/cake-order-template.ts` and asserted
structurally and against the real Backstage schema. The typed builder covers
every branch with no raw escape hatch.

### 2. Custom spec fields ✅ DONE
**Built.** `Template.extraSpec` merges arbitrary top-level keys into `spec`;
`owner` is already a first-class field. Both are asserted in the synthetic
template's test.

### 3. N-env `env.pick` (+ optional envs) ✅ DONE
**Built.** The env set is **open**: `env.pick` keys, a target's `env`, and the
CLI's `-e/--env` are all plain strings, so a project runs any envs (`dev`/`staging`/
`prod`, a single env, whatever). A pick resolves `values[env]`, else a reserved
`default` fallback, else it throws naming its known envs and the miss. Env-safety
generalizes to "a value exclusive to another env can't appear in this env's
artifact." A config's `targets` are arbitrary named entries.

### 4. Nunjucks story ✅ DONE
**Built.** `nj((c) => …)` is the typed TS→Nunjucks transpiler — the Nunjucks analog
of `jsonata()`. It covers the common cases (`||`/`&&` value-preserving, inline-if
ternary, `| upper`/`| lower`/`| trim`, a **null-aware** `?? / njDefault` →
`| default`, preserved bracket step ids), parse-validates its output with the real
`nunjucks` engine at build time, and has a **differential harness** (`differentialNj`)
that renders the compiled output against the TS oracle. `raw`​`` `${{ … }}` `` remains
the escape hatch for anything the subset doesn't cover.

### 5. Step / action ergonomics 🔧 PARTIALLY DONE
**Partly built.** The JSONata payload step is first-class: build the `data` block
with `nj(...)` and wire a TS-authored `jsonata(...)` in as the step's `expression`
(`execute()` computes `roadiehq:utils:jsonata` for real). Step `if:` is supported.
Typed **action** sugar exists via the `defineAction` hook — a plugin publishes a
typed helper compiling to a `Step`, and its optional `simulate` teaches `execute()`
the action's behaviour. What remains: shipping typed helpers for the common built-in
actions (`http:backstage:request`, registration actions with env-keyed maps) and
richer `secrets`-ref ergonomics.

## Suggested order
1. **Rich param model (#1)** ✅ — unlocks the bulk of real templates.
2. **Custom spec fields (#2)** ✅ **+ Nunjucks (#4)** ✅ — done.
3. **N-env env.pick (#3)** ✅ — the env set is open (arbitrary named envs + `default`).
4. **Step/action helpers (#5)** 🔧 — the `defineAction` hook landed; typed helpers
   for the common built-in actions are what's left.

## Definition of done
`compile` a real reference template (authored in TS) and have it match a
schema-valid gold standard (modulo cosmetic formatting). The gold-standard
differential then guards against regressions.
