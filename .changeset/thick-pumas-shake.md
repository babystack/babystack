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
publish time. With an exact pin, a patch to one package reaches nobody who installed it through a sibling
until every package that depends on it is republished too — and two siblings installed at different patch
levels cannot share a copy. `workspace:^` publishes a caret range instead, so a fix to `@babystack/core`
reaches the whole family without republishing it.

No API or behaviour change; this is the dependency metadata consumers resolve against.
