---
'babystack': patch
'@babystack/cli': patch
'@babystack/docker': patch
'@babystack/mysql': patch
'@babystack/runtime': patch
'@babystack/vitest': patch
---

Publish intra-family dependencies as caret ranges rather than exact pins.

These packages declared their siblings as `workspace:*`, which pnpm rewrites to an **exact** version at
publish time. `changeset publish` uploads the family concurrently rather than in dependency order, so a
transient failure on one package leaves the others on the registry immutably, pinned to a version that does
not exist — and an exact pin admits no recovery. `workspace:^` publishes a caret range, so a straggler can
be brought up with a patch bump.

No API or behaviour change; this is the dependency metadata consumers resolve against.
