#!/usr/bin/env node
import { run } from '../dist/index.js'

run(process.argv.slice(2)).then((result) => {
  process.stdout.write(result.output)
  process.exit(result.code)
})
