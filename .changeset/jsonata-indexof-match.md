---
"@tdk/core": minor
---

`jsonata()` now maps `.indexOf` and `.match` — the last two method gaps.

`.indexOf(sub)` compiles to `($contains(s, sub) ? $length($substringBefore(s, sub)) : -1)` (JSONata has no `$indexOf`), exact for the JS edges: not-found → `-1`, found-at-0, empty search (`"abc".indexOf("")` → 0, `"".indexOf("")` → 0), and a search longer than the receiver. Simple pure operands inline; a call receiver/argument hoists into a temp so it evaluates once. The `fromIndex` second argument is rejected. One documented runtime divergence: JS counts UTF-16 code units while the shim counts code points, so they differ only when an astral character precedes the match.

`.match(/re/)` projects JSONata's `{match, index, groups}` onto the JS `RegExpMatchArray` shape — `($m := $match(s, /re/)[0]; $exists($m) ? $append([$m.match], $m.groups) : null)` — value-equivalent for the full match plus capture groups (participating and non-participating slots both `null`) with a literal `null` on no match. It requires a regex-literal argument so its flags can be checked: `i`/`m` pass through, `/g` is rejected (JS then returns bare full-match strings, a different shape), and other flags (`s`/`u`/`y`) are rejected. A string or computed pattern is rejected → use `raw.jsonata`.

Both are add-only and carry engine-verified differential cases. Templates that don't use these methods compile byte-identically.
