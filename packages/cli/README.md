# @babystack/cli

The `baby` command — babystack's **operator & AI-agent surface**. It hands you (or a coding agent) a real,
seeded, disposable MySQL that persists across separate shell commands, plus a one-word `reset` back to the
pristine baseline. Every command supports `--json`. Part of [babystack](../../README.md); full picture in
[docs/](../../docs/).

## Commands

| Command               | Does                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `baby doctor`         | Preflight: Docker reachable, Node ≥ 22, a valid `babystack.config.ts`, and an import-time `DATABASE_URL` scan of `src/`. |
| `baby wake` (`up`)    | Provision + seed a real MySQL and **leave it running** (detached — it outlives this command). Idempotent.                |
| `baby home` (`env`)   | Print an eval-able `DATABASE_URL` for the running stack: `eval "$(baby home)"`.                                          |
| `baby reset`          | Reload a **pristine** DB from the baseline — the agent's undo. Same URL, no container re-provision.                      |
| `baby sleep` (`down`) | Dispose this project's running stack.                                                                                    |

The container is discovered across invocations by a stable per-project label (a hash of the config path), so
`home`/`reset`/`sleep` find the exact container `wake` started — no daemon, no state file. The minted
password is recovered from `docker inspect`, never written to disk. (babystack's only on-disk footprint is
`.babystack/` — the baseline cache + a non-secret metadata sidecar.)

> Run `baby` from your **project root** (where `babystack.config.ts` lives), or point `$BABYSTACK_CONFIG` at
> it: the project label and the cache dir are both derived from the config path, so a different cwd looks
> like a different project.

## The agent loop

The reason the CLI exists: an AI coding agent can experiment against a **real** backend and undo its mess
between attempts, without re-seeding from scratch.

```sh
baby wake                     # once per session: a real, seeded MySQL, left running
eval "$(baby home)"           # export DATABASE_URL for this shell

# ── the agent's attempt loop ──────────────────────────────────
#   run the app / migration / query against $DATABASE_URL
#   inspect the result
baby reset                    # wipe back to the pristine baseline, same URL — try again
#   … repeat until it gets it right …
# ──────────────────────────────────────────────────────────────

baby sleep                    # done: dispose the container
```

Concretely, seed one row, let the agent scribble, then `reset`:

```sh
$ baby wake
baby: awake — real MySQL on 127.0.0.1:54903. Run `baby home` for a connection URL.

$ eval "$(baby home)"
$ mysql "$DATABASE_URL" -e "INSERT INTO widgets (id, name) VALUES (99, 'oops')"

$ baby reset
baby: reset — the database is back to the pristine baseline.

$ mysql "$DATABASE_URL" -e "SELECT id FROM widgets"   # → only the seeded rows; id 99 is gone
```

Scripted / CI form (machine-readable):

```sh
baby wake --json                                  # {"ok":true,"alreadyRunning":false,"container":"…","host":"127.0.0.1","port":…}
export DATABASE_URL=$(baby home --json | jq -r '.env.DATABASE_URL')
# … agent attempt …
baby reset --json                                 # {"ok":true,"reset":true}
baby sleep --json                                 # {"ok":true,"disposed":1}
```

`home`/`reset`/`sleep` exit non-zero with `nothing is awake — run \`baby wake\` first` when no container is
up, so a script can branch on it.

## Design notes

- **Docker _is_ the state.** No lifecycle daemon and no PID/lock file: `wake` starts a detached container,
  later commands rediscover it by label. Nothing to leak, nothing to clean up but the container itself.
- **`reset` == re-lease.** It drops + recreates the single project database and reloads the baseline — the
  same fast path a Vitest worker takes per file. The DB name is stable, so your `DATABASE_URL` survives the
  reset; call `home` once and `reset` as often as you like.
- **The credential boundary holds.** The password is minted per container and read back from `docker
inspect` on demand; it never touches a file. No app/DB secret from your ambient env crosses into a seed
  command.

## Tests

- `pnpm test` — Docker-free unit tests (help/aliases, unknown-command, the `readsEnvTooEarly` heuristic).
- `pnpm test:integration` — the real cross-invocation flow (`wake → home → reset → sleep`) against a live
  MySQL; needs a reachable Docker engine. Set `BABYSTACK_DOCKER_IT=1` locally (auto-on in CI via `CI=true`).
