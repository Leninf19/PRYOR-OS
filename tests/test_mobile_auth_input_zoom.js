// PART 21-23 -- iOS Safari auto-zooms a focused <input> whose computed
// font-size is below 16px. Root cause: every auth-flow <input> used
// Tailwind's default text-sm utility (14px), while every surrounding
// <p>/<button> intentionally stays at text-sm (buttons/paragraphs never
// trigger the browser zoom, only focusable form controls do). Fix is a
// narrowly-scoped text-sm -> text-base swap on <input> elements ONLY,
// across every auth-flow screen that shares the AuthShell pattern
// (PART 23: apply consistently, don't patch one field locally).
//
// Explicitly verifies the PART 21 safety constraint too: the viewport meta
// tag must never gain user-scalable=no or maximum-scale=1 -- the fix must
// be pure CSS, never a zoom/accessibility rollback.
//
// Plain source-text regex assertions, matching this project's established
// convention for files with no React render-test harness (see
// test_login_ui_redesign.js/test_restaurant_contacts_ui.js).
//
// Run directly: node tests/test_mobile_auth_input_zoom.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')
const INDEX_HTML = path.resolve(__dirname, '..', 'dashboard', 'index.html')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

function read(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8').replace(/\r\n/g, '\n')
}

// Extracts every <input ... className="..."> className value from a JSX
// source file -- deliberately tolerant of attribute order/whitespace and
// multi-line attributes, since these are real component files, not a fixed
// template. A naive [^>]*-bounded regex breaks here: several of these
// inputs have an onChange={e => setX(...)} attribute, and the arrow "=>"
// itself contains a literal ">" that would prematurely end a [^>]*-style
// match. Instead this slices from each "<input" up to its own
// self-closing "/>" (all of these are self-closed, never wrapped
// children), which is immune to a stray ">" inside an attribute value.
function tagBlocks(content, tagName) {
  const blocks = []
  const startRe = new RegExp(`<${tagName}\\b`, 'g')
  let m
  while ((m = startRe.exec(content))) {
    const closeIdx = content.indexOf('/>', m.index)
    if (closeIdx === -1) continue
    blocks.push(content.slice(m.index, closeIdx + 2))
  }
  return blocks
}

function inputClassNames(content) {
  return tagBlocks(content, 'input')
    .map(block => block.match(/className="([^"]*)"/))
    .filter(Boolean)
    .map(m => m[1])
}

const AUTH_SCREENS = [
  'components/Login.jsx',
  'components/Register.jsx',
  'components/CompleteGoogleSignup.jsx',
  'components/AccessCodeEntry.jsx',
  'components/ForgotPassword.jsx',
  'components/ResetPassword.jsx',
]

function testEveryAuthScreenHasAtLeastOneInput() {
  for (const screen of AUTH_SCREENS) {
    const names = inputClassNames(read(screen))
    assert(names.length > 0, `${screen}: expected at least one <input>, found none -- the extraction regex or file path may be stale`)
  }
}

function testNoAuthInputUsesTextSm() {
  for (const screen of AUTH_SCREENS) {
    const content = read(screen)
    for (const className of inputClassNames(content)) {
      assert(!/\btext-sm\b/.test(className),
        `${screen}: an <input> still uses text-sm (14px, below iOS Safari's 16px auto-zoom threshold): "${className}"`)
    }
  }
}

function testEveryAuthInputUsesTextBaseOrLarger() {
  for (const screen of AUTH_SCREENS) {
    const content = read(screen)
    for (const className of inputClassNames(content)) {
      assert(/\btext-base\b/.test(className),
        `${screen}: an <input> must explicitly set text-base (16px) so it never falls back to a sub-16px default: "${className}"`)
    }
  }
}

// Buttons and body copy are explicitly NOT part of this fix -- they never
// receive focus as a text-entry control, so iOS never auto-zooms for them.
// This guards against an overzealous future find-and-replace accidentally
// bumping every text-sm in these files to text-base.
function testButtonAndParagraphTextSmIsUntouched() {
  for (const screen of AUTH_SCREENS) {
    const content = read(screen)
    const buttonTagRe = /<button\b[^>]*?className="([^"]*)"[^>]*>/gs
    const pTagRe = /<p\b[^>]*?className="([^"]*)"[^>]*>/gs
    let sawAtLeastOneTextSmOutsideInput = false
    let m
    while ((m = buttonTagRe.exec(content))) if (/\btext-sm\b/.test(m[1])) sawAtLeastOneTextSmOutsideInput = true
    while ((m = pTagRe.exec(content))) if (/\btext-sm\b/.test(m[1])) sawAtLeastOneTextSmOutsideInput = true
    assert(sawAtLeastOneTextSmOutsideInput, `${screen}: expected at least one <button>/<p> to still use text-sm -- the fix must be scoped to <input> only, not a global font-size bump`)
  }
}

// PART 21's explicit constraint: never solve this by disabling zoom/
// accessibility. The viewport meta tag must keep exactly its original,
// accessible content.
function testViewportMetaTagNeverDisablesZoom() {
  const html = readFileSync(INDEX_HTML, 'utf-8')
  const viewportMatch = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)
  assert(viewportMatch, 'index.html must still have a viewport meta tag')
  const content = viewportMatch[1]
  assert(!/user-scalable\s*=\s*no/i.test(content), 'the viewport meta tag must never set user-scalable=no')
  assert(!/maximum-scale\s*=\s*1(\.0*)?\b/i.test(content), 'the viewport meta tag must never set maximum-scale=1')
  assert(/width=device-width/.test(content) && /initial-scale=1/.test(content),
    'the viewport meta tag must keep its normal, accessible width=device-width, initial-scale=1 content')
}

const tests = [
  ['every auth screen has at least one <input> (extraction sanity check)', testEveryAuthScreenHasAtLeastOneInput],
  ['no auth <input> uses text-sm (the iOS Safari auto-zoom root cause)', testNoAuthInputUsesTextSm],
  ['every auth <input> explicitly sets text-base (16px) or larger', testEveryAuthInputUsesTextBaseOrLarger],
  ['<button>/<p> text-sm usage is untouched -- the fix is scoped to <input> only', testButtonAndParagraphTextSmIsUntouched],
  ['the viewport meta tag never disables user zoom/accessibility (PART 21)', testViewportMetaTagNeverDisablesZoom],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
