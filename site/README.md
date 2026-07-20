# site

Static, self-contained pages for babystack — the source for the eventual `babystack.dev` landing site.

| File                           | What                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [index.html](./index.html)     | The **landing page** — the thesis, an animated agent-loop terminal, before/after DX, packages, install. The site's front door.                  |
| [why.html](./why.html)         | **Why babystack** — the honest comparison (vs Testcontainers, Docker Compose, `BEGIN`/`ROLLBACK`).                                              |
| [usage.html](./usage.html)     | How you **use** babystack — the product pipeline (set up once → test → dev → CI → agents), with the real commands.                              |
| [design.html](./design.html)   | A visual walkthrough of the **internals** (layers · lifecycle · process boundary · baseline sources · cache/speed model).                       |
| [docs.html](./docs.html)       | The **docs hub** — jumping-off point into getting-started, the API reference, and the guides.                                                   |
| [roadmap.html](./roadmap.html) | The **roadmap** — what's shipped and what's next (the visual companion to `../docs/ROADMAP.md`).                                                |
| [release.html](./release.html) | The **release page** — the current version: what shipped, safety, what's next. Same design language; linked from the homepage badge/nav/footer. |

**View it:** `open site/design.html` (macOS) — no build step, no server. Each page is fully self-contained
(inline CSS, no external assets/fonts) and theme-aware (follows your OS light/dark).

These pages are plain HTML on purpose — not part of the pnpm/turbo workspace, so `pnpm run check` ignores
them. The written design lives in [`../docs/`](../docs/); this folder is the _visual_ companion.
