import { createHash } from 'node:crypto'

/**
 * Baseline-format version — fed into every invalidation hash as {@link InvalidationInputs.toolVersion}.
 * Bump this whenever the way babystack builds or serializes a baseline changes (dump flags, DEFINER
 * normalization, load procedure, …) so every cached baseline is invalidated and rebuilt. It is deliberately
 * NOT the package version: a patch release that doesn't change the dump format shouldn't force a rebuild.
 */
export const BASELINE_FORMAT_VERSION = '1'

/**
 * Inputs to the baseline invalidation hash. Reading files is the CALLER's job (I/O lives in an adapter);
 * this function only hashes already-read content, so it stays pure and deterministic.
 */
export interface InvalidationInputs {
  readonly configText: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>
  readonly engineImage: string
  readonly toolVersion: string
  readonly buildCommands: readonly string[]
}

/**
 * Content hash over {config, migration/seed files, engine image/version, tool version, build commands}.
 * Deterministic and order-independent across files. Unchanged hash → reuse baseline; changed → rebuild.
 */
export function computeInvalidationHash(inputs: InvalidationInputs): string {
  const hash = createHash('sha256')
  const encoder = new TextEncoder()
  // LENGTH-PREFIXED framing: each field is hashed as `<field>:<byteLength>:<value>`. Any value here can be
  // arbitrary text — build commands and SQL file contents may embed the field labels or a delimiter — so a
  // plain separator is ambiguous: two different input sets (e.g. two files vs. one file whose contents embed
  // the second file's framed bytes) could re-partition into the SAME byte stream and collide to one hash.
  // The cache would then reuse a baseline built from DIFFERENT inputs — the "serve stale seed" trust cliff.
  // Prefixing every value with its exact byte length delimits it unambiguously, so the encoding is injective
  // regardless of content. (This also keeps the source pure ASCII — no in-band control byte as a delimiter.)
  const put = (field: string, value: string): void => {
    const bytes = encoder.encode(value)
    hash.update(field)
    hash.update(':')
    hash.update(String(bytes.length))
    hash.update(':')
    hash.update(bytes)
  }

  put('config', inputs.configText)
  put('image', inputs.engineImage)
  put('tool', inputs.toolVersion)
  for (const command of inputs.buildCommands) put('cmd', command)

  const sorted = [...inputs.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of sorted) {
    put('path', file.path)
    put('contents', file.contents)
  }

  return hash.digest('hex')
}
