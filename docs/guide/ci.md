# Running babystack in CI

> babystack provisions **real** services in Docker and connects to them at `127.0.0.1:<port>`, so your
> CI needs a working Docker daemon **on the same host your tests run on**. Most providers give you one;
> the details differ. This guide covers GitHub Actions and CircleCI, plus what any provider needs.

## Table of contents

- [What CI needs](#what-ci-needs)
- [GitHub Actions](#github-actions)
- [CircleCI](#circleci)
- [Image pulls & caching](#image-pulls--caching)
- [Troubleshooting](#troubleshooting)

## What CI needs

- **A Docker daemon reachable on `localhost`.** babystack publishes each engine to an ephemeral
  `127.0.0.1` port and connects there. A remote or Docker-in-Docker daemon that isn't on the job's own
  `localhost` won't be reachable — this is the one thing that trips up CI setups (see CircleCI below).
- **Room for the image + baseline** — the MySQL 8.4 image is a few hundred MB, pulled once per runner.
- Only the Docker-backed tests need it: `pnpm test:integration` (and a babystack-backed `pnpm test`)
  require Docker; pure unit tests do not.

## GitHub Actions

GitHub-hosted `ubuntu-*` runners are full VMs with Docker preinstalled and running on `localhost` — no
setup step needed. A minimal workflow:

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test # your babystack-backed tests
```

Docker is already up; babystack pulls the engine image on first use.

## CircleCI

Use the **`machine` executor**, not the `docker` executor. The `docker` executor runs your job _inside_
a container; adding `setup_remote_docker` then gives you a **separate** Docker environment whose
published ports are **not** on your job's `127.0.0.1` — so babystack can't reach the engine it started.
The `machine` executor is a full VM with a local Docker daemon, where `127.0.0.1:<port>` just works:

```yaml
version: 2.1
jobs:
  test:
    machine:
      image: ubuntu-2404:current
    steps:
      - checkout
      - run: corepack enable # activates pnpm (Node is preinstalled on the machine image)
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
workflows:
  test:
    jobs: [test]
```

## Image pulls & caching

- The engine image (e.g. `mysql:8.4`) is pulled on first use — usually the slowest part of a cold run.
  babystack pulls it **at runtime**; it is never bundled into the npm package.
- Cache the **pnpm store** to speed installs (`cache: pnpm` above on GitHub Actions).
- Docker layer caching for the image is provider-specific (CircleCI: `docker_layer_caching: true` on the
  machine executor). Optional — the pull is one-time per runner image, and the baseline is built once
  per run and reused across workers.

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:<port>`** — the Docker daemon isn't on the job's `localhost`. On CircleCI,
  switch from the `docker` executor to the `machine` executor; elsewhere, ensure Docker runs on the same
  host as the tests (not a detached/remote daemon).
- **"Cannot connect to the Docker daemon"** — Docker isn't installed or started on the runner. Run
  `baby doctor` (from `babystack`/`@babystack/cli`) to see exactly what's missing.
- **Slow first run** — the engine image pull. Subsequent runs on a warm runner reuse the cached image.
