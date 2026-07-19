# Security policy

## Supported versions

babystack is pre-1.0 (`0.x`). Security fixes land on the **latest** released version; there are no
long-term support branches yet.

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security problem.**

Use GitHub's **private vulnerability reporting**: on this repository, go to the **Security** tab →
**Report a vulnerability**. This opens a private advisory visible only to the maintainers.

In your report, please include:

- what the issue is and the impact you foresee,
- steps to reproduce (a minimal case is ideal),
- affected version(s), and
- any suggested fix or mitigation.

We'll acknowledge as soon as we reasonably can (this is a small, volunteer-maintained project), work with
you on a fix, and credit you in the advisory unless you'd prefer to stay anonymous. Please give us a
reasonable window to release a fix before any public disclosure.

## Scope notes

babystack orchestrates **real** Docker containers and mints throwaway credentials for them. A few areas are
especially in scope:

- **The credential boundary.** babystack mints disposable, loopback-only credentials for the containers it
  provisions and hands out only disposable connection URLs. Anything that causes a **real dev/prod
  credential**, or the minted password, to leak into a test, an agent, a cached artifact, or a log is in
  scope. (Adapter errors are already redacted; a redaction bypass is a valid report.)
- **The baseline cache.** The seeded baseline is content-addressed and checksum-verified before every load.
  A path that lets a corrupt, stale, or attacker-substituted baseline load without detection — serving
  wrong seed state to a test — is in scope (the "trust cliff").
- **Container/command handling.** babystack shells out to the `docker` CLI and runs _your_ migrate/seed
  commands in a scrubbed environment. A command- or argument-injection path that escapes that boundary is
  in scope.

Out of scope: issues that require deliberately hostile local configuration (e.g. pointing
`invalidateWhenChanged` at files outside your project, or a malicious `babystack.config.ts` — which already
executes as code), and the behavior of the real engines babystack orchestrates (that's upstream, e.g. a
MySQL CVE, not a babystack vulnerability). Reports for those are still welcome, but they're upstream.
