// Guards against regressions of the /data/ -> /api/data/ migration: fails
// if any dashboard/src file (other than dataClient.js's own explanatory
// comment) contains a literal '/data/' fetch/string reference, which would
// mean new code is once again reaching for the no-longer-existing public
// static path instead of the authenticated endpoint.
//
// Run directly: node tests/test_no_direct_data_fetches.js

import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')

// dataClient.js documents the migration in a comment that necessarily
// mentions the old path -- everything else must be clean.
const ALLOWED_FILE = path.join(SRC_DIR, 'lib', 'dataClient.js')

const PATTERN = /['"`]\/data\//

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(jsx?|tsx?)$/.test(entry)) out.push(full)
  }
  return out
}

function main() {
  const offenders = []
  for (const file of walk(SRC_DIR)) {
    if (file === ALLOWED_FILE) continue
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) offenders.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`)
    })
  }

  if (offenders.length > 0) {
    console.log('FAIL: found direct /data/ references outside the authenticated endpoint:')
    offenders.forEach(o => console.log(`  ${o}`))
    process.exit(1)
  }

  console.log('PASS: no direct /data/ references found outside dataClient.js')
  process.exit(0)
}

main()
