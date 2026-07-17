# 13. Push-safety through a synthetic theme

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

This repo is pushable, so it must carry no real-source tokens. Development still needs to
run against real template shapes to stay honest.

## Decision

Carry only the synthetic bakery theme in this repo. Real-world templates live in an
un-pushed sibling playground repo, never here.

## Alternatives considered

- Developing against anonymised real templates in this repo — rejected. Anonymisation
  does not fully remove the leak risk, so a scrubbed token could still reach a pushable
  tree.

## Consequences

- The bakery theme lets development run at full fidelity against real template shapes,
  with zero risk that a real source token reaches a pushable tree.
- The rule is stated in the contributor guide's push-safety section.
