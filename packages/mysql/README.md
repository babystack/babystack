# @babystack/mysql

The **real-MySQL engine adapter** for [babystack](https://github.com/babystack/babystack).

It orchestrates an actual `mysql:8.4` container via Docker — never an emulator — and owns the MySQL
lifecycle: provision → authenticated wait-ready → build a seeded `mysqldump` baseline (in a scrubbed env) →
hand out fresh per-worker leased databases loaded from that baseline → dispose. The baseline is
checksum-verified before every load, so a corrupt or stale cache fails loud rather than serving wrong seed.

You normally don't use this directly — `@babystack/vitest` and the `baby` CLI drive it for you. Install it
alongside the wedge:

```bash
npm i -D @babystack/vitest   # one package — @babystack/mysql comes transitively
```

For setup and the full lifecycle, see the [babystack repository](https://github.com/babystack/babystack).
Licensed **Apache-2.0**.
