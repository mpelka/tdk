# Architecture decision records have moved

TDK's architecture decision records now live inside the documentation site, at
`apps/docs/guide/decisions/`, with an index at `apps/docs/guide/decisions.md`
(published as `/guide/decisions`).

This directory held the earlier, unpublished ADR set (0001–0007, Nygard shape). Those
records were consolidated into the single in-site collection on 2026-07-18:

- the decisions also captured on the design-decisions page were re-recorded there in the
  page's order (0001–0020)
- the four decisions that lived only here — no-JSX authoring, functional `defineTemplate`
  over class, `SKILL.md` over an MCP server, and the `load()` shape — moved in as
  ADRs 0021–0024

Add new records under `apps/docs/guide/decisions/`, and list them in the index.
