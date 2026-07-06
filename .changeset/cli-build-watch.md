---
"@tdk/cli": minor
---

Add `tdk build --watch`: runs a full build immediately, then watches the config's directory recursively for `.ts` changes and triggers a debounced rebuild on each surviving change. A failing build prints the usual `file:line:col:` error and keeps watching; the next save retries. SIGINT exits cleanly. `--watch` conflicts with `--stdout`.

Purely additive — existing `tdk build` invocations without `--watch` are unaffected.
