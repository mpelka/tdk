# Test templates

`compile` emits the artifact; `execute(template, fixture, opts?)` simulates one run
of it. Given concrete inputs and mocked outputs for the steps TDK cannot actually
run (HTTP, provisioning and so on), it renders the compiled <code v-pre>${{ … }}</code>
interpolations and runs the pure steps — the trace from input values, through the
compiled YAML/JSONata/Nunjucks, to output.

## The testing ladder

TDK gives you four tiers of confidence, cheapest first. Each catches something the one
before it cannot, so use them together — most templates want all four.

1. Typecheck. A fixture's `parameters` are typed against the template's declared
   params, so a renamed param or a wrong shape is a compile-time error before anything
   runs. Run `bun run typecheck`.
2. `execute()` snapshots. An offline simulation of one run, snapshot-asserted and
   deterministic — no network. This is the default suite: fast, hermetic, run on every
   change. See [scenarios and snapshots](#scenarios-and-snapshots).
3. Contracts. The gold-standard oracle and the differential harnesses prove the
   compiled template computes the same as a hand-written reference, per scenario. The
   [stability contract](/guide/stability) pins what a version bump may and may not
   change. See [executeAgainstGold and the oracle discipline](#executeagainstgold-and-the-oracle-discipline).
4. Real dry-run. The template runs against a real Backstage, so you check the parts the
   simulator does not cover: how the server validates the values, which steps run, and
   what files the template emits. See [dry-run against Backstage](#dry-run-against-backstage).

The first three run offline in `bun test` and `tdk test`. The fourth needs a Backstage
to talk to, so it is opt-in — from VS Code, from the `tdk dry-run` command, or from the
scriptable client.

## `execute(template, fixture, opts?)`

For a `defineTemplate` template the fixture's `parameters` are typed against the
template's declared params. `ExecuteOptions` is `{ target?, validateParams? }`:
`target` picks the environment (defaults to `{ env: "test" }`), and
`validateParams: true` validates the fixture's `parameters` against the compiled
schema and throws on a violation (a renamed param or an out-of-enum value fails
loudly instead of rendering `undefined`s).

```ts
import { execute } from "@tdk/core";

const { steps, output } = await execute(OrderCake, {
  parameters: { bakeryCode: "CAKE-1", cakeName: "GANACHE" },  // typed against OrderCake
  user: { ref: "user:default/baker-042", entity: { metadata: { name: "" } } },
  secrets: { token: "t" },
  steps: { place: { output: { body: "Created", link: "…" } } },
}, { validateParams: true });
```

Per step, in order: it evaluates `if` (a <code v-pre>${{ }}</code> boolean — a falsy result
skips the step); renders `input` via the `nunjucks` lib (autoescape off; a field
that is a single full <code v-pre>${{ … }}</code> keeps its native type); then sets the step
output:

- `roadiehq:utils:jsonata` is computed for real — `data` is rendered, then
  `jsonata(expression).evaluate(data)` → `{ result }`
- a step the fixture mocks via `fixture.steps[id]` takes that mocked output verbatim
- otherwise, an action with a registered simulator (see [Extend TDK](/guide/extending))
  has its output computed by that simulator from the rendered input and context

Finally `spec.output` is rendered. The return is `{ steps: { [id]: { skipped?,
notReached?, input, output, error? } }, output }`.

### Halt at the first failed step

When a step ends with an `error` — a `roadiehq:utils:jsonata` expression that
threw (for example an `$assert` guard), or an input that fails to render —
`execute()` stops there, mirroring real Backstage: a failed task halts, later
steps never run, and the task produces no output. The failing step keeps its
`error` and rendered input; every step after it is recorded as `{ notReached:
true }` with no rendered input (rendering against a dead context would be
misleading), and the template `output` is `undefined`. A `notReached` step is
distinct from a `skipped` one — a falsy `if:` skip does **not** halt the run, so
steps after a skip still run.

### Mock-wins precedence

When a step's action has a registered simulator and the fixture also supplies a
`fixture.steps[id]` mock, the mock wins — `execute()` uses the mocked output
verbatim and the simulator does not run. A simulator only computes a step's output
when the fixture has no entry for that step. So to test the real behaviour of a
simulated action, leave its mock off; to pin a step's output regardless of any
simulator, supply the mock. This is the one precedence rule to remember when a step
output is not what you expected.

The full order, most specific first, is: `fixture.steps[id]` mock, then a
per-call simulator passed via `execute`'s `{ simulators }` option (see
[Action simulators with `registerActionSimulator`](/guide/extending#action-simulators-with-registeractionsimulator)),
then the process-global `registerActionSimulator` registry, then `undefined`.

## Scenarios and snapshots

A testable template is a directory holding `template.ts` and
`__fixtures__/scenarios.ts` (which exports `scenarios: { name, fixture, branches?
}[]`). `tdk test [path]` discovers them, runs each scenario through `execute()`, and
snapshot-asserts the result.

```ts
// __fixtures__/scenarios.ts
import type { ExecuteFixture } from "@tdk/core";

export interface CakeParams { bakeryCode: string; cakeName: string }
export const scenarios: { name: string; branches?: string[]; fixture: ExecuteFixture<CakeParams> }[] = [
  { name: "orders a ganache cake",
    fixture: { parameters: { bakeryCode: "CAKE-1", cakeName: "GANACHE" }, steps: { place: { output: {} } } } },
];
```

### The siblings rule

Snapshots live at `__snapshots__/scenarios.snap`, a sibling of `__fixtures__/` —
never nested inside it — one file per template:

```
my-template/
├── template.ts
├── __fixtures__/
│   └── scenarios.ts
└── __snapshots__/
    └── scenarios.snap
```

The first run writes snapshots (`+ written`); later runs compare (`✓ passed` /
`✗ failed` + diff). `tdk test -u` accepts changes; `tdk test --ci` fails on a
missing snapshot and never writes. Commit `__snapshots__/` alongside the template —
it is the regression baseline. See the [CLI reference](/reference/cli#tdk-test-path)
for the exact flags and exit codes.

The same engine drives the VS Code Test Explorer (native Testing view): suites are
templates, tests are scenarios. A mismatch renders as a failing test with the native
expected/actual diff, plus an "Update Snapshots" run profile. The per-step resolved
trace shows in the test output.

`tdk execute <template.ts>` runs the same scenarios and prints one JSON result object
— the single-file companion the VS Code scenario playground shells out to.

## Testing a real `load()`

A template whose `load()` does a real HTTP `fetch` (see
[loading real data](/guide/authoring#loading-real-data)) has two testing tiers. They
are complementary — use both, as `examples/api-loaded` does.

The fixture tier keeps snapshots hermetic. Every scenario carries `loaded: {…}`, which
skips `load()` and feeds the form the data directly, so `tdk test` never touches the
network and the snapshots stay deterministic. This is where you pin the compiled shape
against the golds. Use it for the default suite.

```ts
// __fixtures__/scenarios.ts — inject the catalog; load() never runs.
fixture: { loaded: { flavours: ["vanilla", "chocolate"] }, parameters: { /* … */ } }
```

The mock-server tier exercises the real fetch path once. A test spins a local server on
an ephemeral port, points the injectable base URL at it, and runs the real `load()`
through `compileResolved` / `compileAll` for each env — proving the fetch → parse →
bake pipeline end to end, hermetically, with no real network. Use it to prove the
loader itself works, not to snapshot output.

```ts
// template.test.ts — spin a local catalog, run the REAL load() fetch.
const server = Bun.serve({ port: 0, fetch: (req) => Response.json(catalogFor(req)) });
process.env.BAKERY_MENU_API = server.url.origin;   // redirect the fetch
const { object } = await compileResolved(FreshTemplate, prodTarget); // load() fetches
server.stop(true);                                  // tear down
```

`examples/api-loaded` uses `Bun.serve` (zero extra dependencies), but the recipe is the
same with `msw`: inject the base URL, serve per-env catalogs, compile both, assert the
baked options differ, tear down. One caveat — `tdk test` preflight-compiles a template
once before running its scenarios, and that preflight runs the real `load()`. So a
fetching loader also needs its base URL pointed at a loopback mock during `tdk test`;
`examples/api-loaded` does this from its `scenarios.ts` (an `unref`'d server, so the run
still exits).

## Dry-run against Backstage

`execute()` simulates a run offline. A dry-run runs the same template against a real
Backstage, so you can check the parts the simulator does not cover: how the server
validates the form values, which steps run, and what files the template emits. The VS
Code form preview drives it — open a template, fill the form, and on the Review step
select Dry-run in Backstage.

Set up two things first:

- set `tdk.backstage.baseUrl` to your Backstage URL, for example `http://localhost:7007`,
  or run the `TDK: Set Backstage Base URL` command
- run the `TDK: Set Backstage Token` command to store a bearer token (it lives in VS
  Code SecretStorage, never in your settings)

The token is optional — some backends allow an unauthenticated dry-run — but a token
that Backstage rejects surfaces as an auth error with a link back to the command. Leave
the base URL empty to keep the feature off; the button then explains what to set.

The dry-run posts the compiled template and the current form values to Backstage's
`/api/scaffolder/v2/dry-run` endpoint. Backstage validates the values against
`spec.parameters` first, then runs the steps in dry-run mode. The result lands in the
TDK Trace panel under a Backstage dry-run header, so you can tell it apart from a local
execute trace. You get one of these outcomes:

- a run trace: each step with its status and log lines, the template output, and any
  emitted files
- a validation failure: the server-side errors from a rejected payload, listed by field
  — free validation even for custom fields the simulator cannot check
- an auth or connection error: a single message pointing at the token command or the
  base URL setting

Emitted files show in a Files section. Select a path to open its content as a read-only
document; an executable file carries a badge, and a template that writes nothing shows a
quiet note. The [VS Code extension guide](/guide/vscode#dry-run-in-backstage) covers the
trace panel, run history, and the failure outcomes in full.

### Sweep from the command line

`tdk dry-run <paths...>` runs the same dry-run headlessly over a sweep of templates, so
CI can check that a batch still dry-runs green. It takes `.ts` and `.yaml` paths (or
globs, mixed), sources each one's values, posts a dry-run, and prints a per-template
report. It exits 1 if any template did not dry-run `ok`.

```sh
export TDK_BACKSTAGE_URL=http://localhost:7007
export TDK_BACKSTAGE_TOKEN=…          # never a --token flag: it would leak into shell history
tdk dry-run 'examples/*/template.ts' --json
tdk dry-run cake-order.yaml --synthesize-values
```

The command reads its base URL and token from `TDK_BACKSTAGE_URL` and
`TDK_BACKSTAGE_TOKEN`. Values come from a scenario fixture (`.ts`), a colocated
`<basename>.values.json` (`.yaml`), an explicit `--values` file, or `--synthesize-values`
— see the [CLI reference](/reference/cli#tdk-dry-run-paths) for the full priority, the
synthesizer, and the report shape.

### The scriptable client

Both the extension and the CLI are built on one client, exported from the
`@tdk/core/backstage` subpath. Reach for it directly when you want a dry-run from your
own script or test — it takes the same `{ object, yaml }` artifact that `compile()` and
`fromYaml()` produce.

```ts
import { compile } from "@tdk/core";
import { backstageClient } from "@tdk/core/backstage";

// baseUrl and token default to TDK_BACKSTAGE_URL / TDK_BACKSTAGE_TOKEN.
const client = backstageClient({ baseUrl: "http://localhost:7007" });

const artifact = compile(OrderCake, { env: "test", outDir: "" });
const result = await client.dryRun(artifact, { values: { flavor: "vanilla" } });
if (result.kind === "ok") {
  console.log(result.body.steps.map((s) => s.id));   // the executed steps
}
```

`dryRun` never throws for an HTTP outcome. It returns a discriminated result — `ok`,
`validationFailed`, `authFailed`, `serverError`, or `unreachable` — so you branch on
`result.kind`. The token is never logged, even if a proxy echoes it back.

### Creating a real task, behind a consent gate

The client can also create a real scaffolder task with `createTask`. Unlike a dry-run,
this runs the template for real in Backstage, with real side effects. So it sits behind
a consent gate: `createTask` throws synchronously unless you built the client with
`allowTaskCreation: true`.

```ts
// Without the flag, this throws before any network call — a real run cannot happen by accident.
backstageClient({ baseUrl }).createTask(artifact, { values });   // throws: consent required

// With the flag, it POSTs to /api/scaffolder/v2/tasks and returns the new task.
const client = backstageClient({ baseUrl, allowTaskCreation: true });
const task = await client.createTask(artifact, { values: { flavor: "vanilla" } });
if (task.kind === "created") {
  console.log(task.taskId, task.taskUrl);   // the id and a link-able URL
}
```

The task endpoint resolves the template from the catalog by name, so the template must
already be registered there — `createTask` derives its `templateRef` from the artifact's
`metadata.name`. The `tdk dry-run` command never calls `createTask`; only your own code
can, and only after opting in.

## Typed fixtures and `validateParameters`

Because a fixture's `parameters` are typed against the template's declared params
(via `defineTemplate`'s phantom type), a renamed param or a wrong shape is a
compile-time TypeScript error in the fixture file itself. `validateParams: true` on
`execute()` adds a runtime check on top — it validates the fixture's `parameters`
against the compiled form's JSON Schema (the same check `validateParameters` runs
directly) and throws on a violation, so an out-of-enum value or a schema mismatch
fails loudly instead of silently rendering `undefined`.

```ts
import { validateParameters } from "@tdk/core";

await validateParameters(object.spec.parameters, values); // fixture params vs the form's JSON Schema
```

## `executeAgainstGold` and the oracle discipline

`executeAgainstGold(template, goldYaml, fixture)` runs the same engine over both the
TDK template and a gold-standard YAML and reports per-step and output equality — a
behavioural differential proving the two compute identically per scenario,
regardless of expression layout. `assertExecuteAgainstGold` throws on divergence.

The `examples/` package is TDK's own gold-standard suite: six testable templates,
each stressing one hard corner of the DSL. Every template directory holds:

- `template.ts` — the template (bakery-themed)
- `gold-standard.yaml` — a hand-written oracle: what a Backstage expert would author
  for the same behaviour, written before the template was compiled
- `__fixtures__/scenarios.ts` — 3 or more `execute()` scenarios
- `template.test.ts` — the tests
- `__snapshots__/scenarios.snap` — the committed scenario snapshots

Each `gold-standard.yaml` is authored by hand from the behavioural spec, never
regenerated from compiled output. The tests compare compile-vs-gold by
value-equivalence (the JSONata/Nunjucks differential harnesses,
`assertExecuteAgainstGold`, structural asserts) — never byte-equality. The hand
formatting differs from the pretty-printer on purpose: a byte-identical gold would
prove circularity, not correctness. When the two disagree, one side has a real bug.

| Template | What it stresses |
| --- | --- |
| Custom Cake Order Wizard | Conditional forms: a two-level `showWhen` chain, `dep.when` and `rawDependencies` coexisting on distinct controllers, a shared page fragment. |
| Order Ticket Builder | One block-bodied `jsonata`: an `$assert` guard, a nested-lambda map reducing to a scalar, `\|\| 0` value defaulting, a scalar fee fold, a spread-merged `meta`, and `parseInt` via the lenient shim. |
| Delivery Slot Notifier | `nj` fallbacks: the null-aware `??`, a fallback-then-method chain, a template literal + number, a comparison ternary, and a `.split("-")[0]` passthrough. |
| Seasonal Menu Publisher | Compile-time data + env safety: `load()` bakes an env-aware menu, `env.pick` per-env, a `beta` lifecycle, an `extraSpec` passthrough — two golds (nonprod/prod). |
| Storefront Flavour Picker | A REAL network `load()`: `fetch` an env-specific catalog over HTTP, baked into the enum. Tested both ways — the `loaded` fixture tier (hermetic snapshots) and a local `Bun.serve` mock exercising the real fetch — two golds (nonprod/prod). |
| Oven Provisioner | All three extension hooks via an inline plugin: a `defineField` picker, a `defineAction` with a `simulate`, and a `defineResolver` marker used as a step input and in a step `if:`. |

```sh
bun test examples/                       # the tests (structure + differentials)
tdk test examples        # the scenario snapshots
tdk test examples --ci   # snapshots, fail on any drift
```

Each template's `template.test.ts` is the place to read for how a feature is pinned;
each `gold-standard.yaml` is the place to read for what the compiler must produce.
The [cookbook](/guide/cookbook) walks each example as a recipe.
