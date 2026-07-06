# Stability contract

If you recompile your templates after upgrading TDK, is the YAML identical? Not
guaranteed byte-for-byte across a minor version. It is guaranteed to be announced,
semantically equivalent, and catchable before it can reach Backstage. This page
explains the promise TDK makes, why it stops short of byte-identity, and the four
things that protect you across an upgrade.

## Two separate promises

TDK makes two promises, and it is worth keeping them apart.

API stability is about your source. Your `template.ts` keeps compiling and behaving
the same after you upgrade `@tdk/core`. This is ordinary semver: a patch or minor
release does not break your authoring code, a major release may. It is the promise
every library makes.

Output stability is about the artifact. When you recompile the same template with a
newer TDK, what happens to the YAML it emits? A compiler is free to improve how it
emits code without changing what that code does, so this needs its own contract —
the rest of this page.

## The contract: semantic stability, not byte stability

TDK promises that recompiled output stays semantically equivalent. It does not
promise the output stays byte-identical. What that means depends on the release.

Patch releases are byte-identical. A patch is a pure bugfix, so a recompile produces
the same bytes. If a patch changed the emitted text, it would not be a patch.

Minor releases may change the text, but not the behaviour. A minor release can
improve how TDK emits an expression or lays out the YAML. The recompiled output may
differ textually from the old output, but it must compute the same result. That
equivalence is proven by the differential harness before the change can merge (see
[how equivalence is proven](#how-equivalence-is-proven)). The changelog flags a minor
release that changes emitted output so you know a recompile will produce a diff.

Major releases may change behaviour. A major release is where compiled output is
allowed to compute something different, or where the authoring API breaks. This is
the only release type that can change what your templates do.

There is a fourth category that does not touch compiled YAML at all. A change to the
`execute()` simulator alters your scenario snapshots rather than your artifacts,
because snapshots record simulated runs, not compiled output. The changelog flags
these as snapshot-affecting. For example, a change that makes `execute()` halt at the
first failed step, to match how real Backstage stops a run, would shift many scenario
traces without changing a single byte of emitted YAML. You accept the new snapshots
with `tdk test -u`; nothing you deploy changes.

| Release | Compiled YAML | What you do |
| --- | --- | --- |
| patch | byte-identical | nothing — recompile is a no-op |
| minor | may differ textually, same behaviour | review the reviewable artifact diff |
| major | may change behaviour, or the API breaks | read the changelog, retest |
| simulator change | unchanged | accept new scenario snapshots with `tdk test -u` |

## Why byte-identity is not promised

Promising byte-identical output would freeze every improvement to how TDK emits YAML
and expressions. TDK could never make a compiled expression more readable, or lay out
a block scalar more cleanly, because any such change moves bytes.

This is a deliberate choice, and it predates this page. TDK's own gold-standard tests
never assert on bytes. Each `examples/*/gold-standard.yaml` is hand-written by a
Backstage expert from the behavioural spec, before the template is compiled, and its
hand formatting differs from the pretty-printer on purpose. The tests compare the
compiled entity against the gold by value — structural asserts and the behavioural
differential — never by byte-equality. A byte-identical gold would prove the two were
copies of each other, not that they compute the same thing. The same philosophy is
what lets TDK improve its emission over time.

It is the trust model of any compiler. You do not expect gcc 13 to emit the same
bytes as gcc 12. You expect the same behaviour, plus an artifact you can review
before you ship it.

## The four safety nets

Four mechanisms protect you across an upgrade. Together they mean an output change
cannot reach Backstage without being announced, proven equivalent, and reviewed.

### Pinning

Your lockfile freezes the version of TDK you build against. Nothing changes
underneath you until you choose to bump the version. An upgrade is something you do,
not something that happens to you.

### The compiled YAML is a version-controlled artifact

You commit the compiled YAML, and recompiling is an explicit act that produces a diff
in that artifact repository. That diff is reviewed before anything reaches Backstage.
A minor release that reformats an expression shows up as a reviewable change in a pull
request, the same way any generated artifact does. This is the compiler trust model
in practice: identical behaviour, plus a reviewable artifact.

### Scenario snapshots

After you bump the version, `tdk test --ci` fails loudly on any behavioural drift. A
scenario whose simulated run changed shows as a failing test with an
expected-against-actual diff. You review the diff, and if the change is expected you
accept it with `tdk test -u`. Drift cannot pass silently. See
[Test templates](/guide/testing) for how scenarios and snapshots work.

### TDK's own differential CI

An emission change cannot merge into TDK until it proves it is value-equivalent. This
is the net that protects the promise at the source, before a release exists.

## How equivalence is proven

The differential harness in `packages/core` runs both sides of an expression and
asserts they agree. For a JSONata expression it evaluates the author's TypeScript
function as a JavaScript oracle, evaluates the compiled JSONata through the real
`jsonata` engine, and compares the two values fixture by fixture. Agreement is
throw-aware: two runs agree when they produce deep-equal values, or both throw the
same message. The Nunjucks transpiler has the same harness against the real Nunjucks
engine.

So when a minor release changes how an expression is emitted, the new form has been
run against the real engine and proven to compute what the old form computed, for
every fixture, before the change merged. The full gate that runs this — Biome, the
typecheck, every test, and the scenario snapshots under `--ci` — is `bun run ci`,
the exact command CI runs.

## The direct answer

If you recompile your templates after upgrading, is the YAML identical?

- across a patch release: yes, byte-for-byte
- across a minor release: not guaranteed byte-identical, but guaranteed announced in
  the changelog, proven semantically equivalent by the differential harness, and
  catchable by your scenario snapshots and the artifact diff before it can matter
- across a major release: behaviour may change, so read the changelog and retest

A simulator change is the one case that moves your scenario snapshots rather than your
compiled YAML. It is flagged snapshot-affecting, and you accept it with `tdk test -u`.

## A note on what is policy and what is mechanism

The mechanisms on this page exist today: the differential harness, the value-based
gold-standard tests, `tdk test --ci` and `-u`, and the `bun run ci` gate. The
changelog flags — `output-changing:` for a change that moves compiled YAML, and
`snapshot-affecting:` for a change that moves scenario snapshots — are a convention
going forward, recorded in the contributor guide's changeset section. TDK's packages
are still private, so no releases are published yet; the semver contract described
here is the policy those releases will follow once publishing is switched on.
