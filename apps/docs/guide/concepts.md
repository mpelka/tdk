# Core concepts

This page gives you the mental model behind TDK: the three verbs, why the compiler
throws instead of guessing, the environment model, and the split between what runs
at compile time and what runs inside Backstage. Read it once and the rest of the
guide falls into place.

## The three verbs

TDK has exactly three verbs. Keep them distinct — they operate at different levels
and the docs use each word precisely.

| Verb | Level | What it does |
| --- | --- | --- |
| transpile | expression | `jsonata()` turns a typed TS arrow into a JSONata string; `nj()` turns one into a Nunjucks string |
| compile | template | `compile(template, target)` turns a whole template into Backstage YAML |
| execute | run | `execute(template, fixture)` simulates one run of a compiled template |

### Transpile — expression level

Backstage templates carry logic in two expression languages, and TDK gives each
one a typed transpiler so you never hand-write either:

- `jsonata()` transpiles a typed arrow to a JSONata string — for a
  `roadiehq:utils:jsonata` step's `expression` key
- `nj()` transpiles a typed arrow to a Nunjucks string — for the <code v-pre>${{ … }}</code>
  interpolations Backstage uses everywhere else

Both parse-validate their output against the real engine at build time, and both
have a differential harness that runs the compiled expression and the TS oracle
side by side. See [Write expressions](/guide/expressions).

### Compile — template level

`compile(template, target)` turns a whole `defineTemplate({...})` value into a
Backstage `Template` entity and its YAML. cdk8s calls this step "synth"; TDK calls
it "compile". (The unrelated word `synthetic` — the bakery theme in fixtures and
examples — is not renamed.)

A `target` names the environment and where the output goes, for example
`{ env: "test", outDir: "dist" }`. One template compiles to one artifact per
target.

### Execute — run level

`execute(template, fixture)` simulates one run of a compiled template. Given
concrete parameters and mocked outputs for the steps TDK cannot run itself
(HTTP, provisioning and so on), it renders the compiled <code v-pre>${{ … }}</code>
interpolations and runs the pure steps. This is what powers scenario testing — see
[Test templates](/guide/testing).

## Silent to loud: why the compiler throws

TDK's core design choice: a whole class of authoring mistakes that used to ship as
wrong YAML now throw a pointed error at compile time instead. The compiler refuses
to emit an artifact it knows is wrong.

This matters because the alternative is worse. A template that compiles to subtly
wrong YAML fails in Backstage, at scaffold time, in front of a user — far from the
line that caused it. TDK moves that failure to the earliest, loudest place: the
compile, with an error that names the mistake.

These all throw at compile:

- a `parameters` property whose value is not a `Param` (you forgot a `p.*` helper)
- a `showWhen` and a `dep.when` both targeting the same controller
- a `showWhen` cycle, or a `showWhen` naming a controller that does not exist
- an `env.pick` marker or a resolver marker surviving unresolved into the artifact
- an `extraSpec` key colliding with a field TDK already models under `spec`
- a non-`"ga"` `lifecycle` with no `restrictedToUsers` (it fails closed)
- a duplicate step id, a duplicate param name, or a `Param` rebound to a new name
- an `enumNames` whose length does not match its `enum`

The expression transpilers follow the same rule. Anything `jsonata()` or `nj()`
cannot map throws a located error naming the construct and pointing at the `raw`
escape hatch, rather than emitting a guess. See the full list in the
[expression support reference](/reference/expression-support).

## The environment model

TDK's set of environments is open. A project runs whatever environments it likes —
`test` and `prod`, or `dev` / `staging` / `prod`, or a single environment. Nothing
is fixed at the type level; the names are plain strings.

### `env.pick` and the default fallback

`env.pick({ … })` is a marker for a value that differs per environment. Its keys
are your environment names, plus an optional reserved `default` fallback:

```ts
oven:    env.pick({ test: "test-oven", prod: "prod-oven" })          // two envs
cluster: env.pick({ dev: "dev-c", staging: "stg-c", prod: "prod-c" }) // three envs
region:  env.pick({ prod: "eu-west", default: "eu-central" })        // default fallback
```

At compile, a pick resolves to `values[env]`, else the `default` fallback, else it
throws — naming the pick's known environments and the miss.

### Targets

A config's `targets` are arbitrary named entries, at least one. The names carry no
special meaning — `nonprod` and `prod` is just a convention, not a rule. Each
target names an environment and an output location.

### The cross-environment leak check

TDK enforces one guarantee: an artifact compiled for one environment cannot
reference another environment's value. Two layers deliver it:

1. `env.pick` resolves to the target environment's value, so a leak cannot happen
   by accident through the marker.
2. A scan of every string in the compiled artifact throws if it finds a value that
   is exclusive to a different environment across all the `env.pick`s. This catches
   another environment's value hardcoded as a plain literal.

A value shared by two environments, or supplied via `default`, is not exclusive and
is fine. The flip side: listing a value under a second environment disarms the
exclusivity check for it, so never declare a genuinely environment-private value as
shared. `compile(...)` runs this check for every environment automatically; opt out
with `{ checkEnvSafety: false }`.

## Compile time vs scaffold time

This split trips up newcomers more than anything else. Two different moments run
two different kinds of code:

Compile time is when you run `tdk compile` or `tdk build`. Your machine runs the
TypeScript: `defineTemplate` builds the model, `load()` fetches external data,
resolver markers resolve, `env.pick` picks a value, and the transpilers turn your
arrows into JSONata and Nunjucks strings. The output is static YAML.

Scaffold time is when a Backstage user runs the template. Backstage runs the YAML:
it renders the form, evaluates the <code v-pre>${{ … }}</code> interpolations against the user's
answers, and runs each step's action. None of your TypeScript runs here — only the
strings it compiled to.

So a value comes from compile time or from scaffold time, never both:

| Comes from compile time | Comes from scaffold time |
| --- | --- |
| `load()` data baked into the form | the user's parameter answers |
| a resolver marker like `headBakerOf("pastry")` | a step's runtime `output` |
| the environment chosen by `env.pick` | a <code v-pre>${{ … }}</code> expression `nj()`/`jsonata()` emitted |

When a template behaves oddly, ask which moment the value belongs to. A resolver
that should have looked up a real id but shows a marker means the async compile path
did not run. A <code v-pre>${{ … }}</code> that renders `undefined` means a scaffold-time value
was read at the wrong path. See [Test templates](/guide/testing) for how `execute()`
lets you watch both moments in one trace.
