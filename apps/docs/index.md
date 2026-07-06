---
layout: home
hero:
  name: TDK
  text: cdk8s for Backstage templates
  tagline: Author Scaffolder templates as typed, testable TypeScript. Compile to scaffolder.backstage.io/v1beta3 YAML for every environment from one source.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Core concepts
      link: /guide/concepts
features:
  - title: Typed authoring
    details: A template is a plain defineTemplate({...}) value — no class, no new. Params carry TS types, f.<name> is a typed ref to each one, and the whole thing is testable without a Backstage runtime.
  - title: Value-verified expressions
    details: jsonata() and nj() transpile typed TS arrows to JSONata and Nunjucks. Every emission is parse-validated at build time, and a differential harness checks the compiled expression against the TS oracle on your fixtures.
  - title: Testable scenarios
    details: execute(template, fixture) simulates one run end to end. tdk test snapshot-asserts scenarios per template — the same engine that drives the VS Code Test Explorer.
---

## What TDK is

TDK is a TypeScript DSL that compiles to Backstage Scaffolder template YAML. You
author a template once as a typed `defineTemplate({...})` value and compile it to
`scaffolder.backstage.io/v1beta3` YAML for every environment from that one source.

Think of it as cdk8s for Backstage templates. You write typed, testable code
instead of hand-editing YAML, and the compiler catches whole classes of mistakes
before they ship.

## Who it is for

TDK is for people who maintain Backstage Scaffolder templates and want to stop
editing YAML by hand. You get:

- type checking on every parameter, step input and output
- one source that compiles to a separate artifact per environment, with a leak
  check that stops one environment's values reaching another
- a scenario test runner that simulates a template run and snapshot-asserts the
  result, without a Backstage instance

## Where to start

- New to TDK? Follow [Get started](/guide/getting-started) top to bottom — install,
  scaffold, compile and test in a few minutes.
- Want the mental model first? Read [Core concepts](/guide/concepts) for the
  three-verb vocabulary, the compile-time errors and the environment model.
- Porting an existing YAML template? Go to [Port a YAML template](/guide/porting).

## Quickstart

```sh
tdk init            # scaffold a testable bakery template + config + first snapshot
tdk test            # run its scenarios, snapshot-assert the result
tdk compile template.ts   # compile ONE template to YAML, validated against the Backstage schema
```

See [Get started](/guide/getting-started) for the full walkthrough, including how
to link `@tdk/core` and `@tdk/cli` into your own template repo before they are
published.
