# @babystack/docker

The generic Docker **muscle** for babystack — shells out to the `docker` CLI to provision, probe, exec,
dispose, and GC real containers. Engine-agnostic: MySQL/Redis/… specifics live in their own adapters, which
_drive_ this. Part of [babystack](../../README.md); full picture in [docs/](../../docs/).

## What's here

- **`DockerBackend`** — `provision` (detached container, ephemeral `127.0.0.1` port, owner/run labels) ·
  `waitReady` (retry an **authenticated** exec probe via the injected `Clock` — not a port ping) · `exec` ·
  `dispose` (container **and** volume, idempotent) · `gc` (reap label-scoped orphans; never touches
  non-babystack containers) · `isAvailable` · `logs`.
- **`NodeCommandRunner` / `SystemClock`** — the runtime implementations of core's `CommandRunner` / `Clock`
  ports. `NodeCommandRunner` spawns argv directly (no shell, so a stray `;` is inert) and passes **only** the
  given env — empty by default, the credential boundary.
- **`dockerEnvAllowlist`** — the minimal env `docker` needs (`PATH`/`HOME`/`DOCKER_*` context vars) so the
  CLI works without any app/DB secret crossing the boundary.

## Design notes

- **All I/O flows through the injected `CommandRunner`** → unit-tested against a fake with **zero Docker**
  (asserting exact argv), while real behavior is covered by integration tests.
- **Never emulate.** This orchestrates the real `docker` CLI; it never reimplements Docker or any engine.

## Tests

- `pnpm test` — Docker-free unit tests (fake `CommandRunner` + `FakeClock`).
- `pnpm test:integration` — real-Docker tests; needs a reachable engine. Set `BABYSTACK_DOCKER_IT=1` locally
  (auto-on in CI via `CI=true`).
