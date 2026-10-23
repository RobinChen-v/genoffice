// OpenHarmony host shim: dlopen of `.node` modules from user-writable dirs is
// blocked by platform policy, so rollup's native binding cannot load here.
// Idempotently repoint rollup at the official WASM build (@rollup/wasm-node).
// No-op on every other platform. Run via `npm run patch:wasm`; re-run after a
// clean `npm i` that re-creates node_modules (rollup's native.js is not our
// source).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

if (process.platform !== 'openharmony') process.exit(0)

const rollupNative = `${root}node_modules/rollup/dist/native.js`
if (!existsSync(rollupNative)) process.exit(0) // rollup not installed yet

const pkgVersion = (name) => JSON.parse(readFileSync(`${root}node_modules/${name}/package.json`, 'utf8')).version
const rollupVersion = pkgVersion('rollup')

// Names rollup's ESM entry points (`dist/es/shared/*`) import from dist/native.js.
const WASM_EXPORTS = ['parse', 'parseAsync', 'xxhashBase64Url', 'xxhashBase36', 'xxhashBase16']

const shim = `// [genoffice patch] openharmony blocks dlopen of .node modules from user dirs,
// so rollup's per-platform binding cannot be required here; forward the same
// surface to the official WASM build (@rollup/wasm-node) instead.
const wasm = require('@rollup/wasm-node/dist/native.js');
${WASM_EXPORTS.map((name) => `module.exports.${name} = wasm.${name};`).join('\n')}
`

if (readFileSync(rollupNative, 'utf8') === shim) {
  console.log('[patch-rollup-wasm] rollup already points at the WASM build')
  process.exit(0)
}

const wasmNative = `${root}node_modules/@rollup/wasm-node/dist/native.js`
const wasmVersion = existsSync(wasmNative) ? pkgVersion('@rollup/wasm-node') : null
if (wasmVersion !== rollupVersion) {
  // The WASM build ships per rollup release; keep the pair in lockstep.
  console.log(`[patch-rollup-wasm] installing @rollup/wasm-node@${rollupVersion} (no package.json change)…`)
  const r = spawnSync('npm', ['install', '--no-save', `@rollup/wasm-node@${rollupVersion}`], {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (r.status !== 0 || !existsSync(wasmNative)) {
    console.warn('[patch-rollup-wasm] could not obtain the matching @rollup/wasm-node; run `npm i --no-save @rollup/wasm-node` manually')
    process.exit(0)
  }
}

writeFileSync(rollupNative, shim, 'utf8')
console.log('[patch-rollup-wasm] rollup repointed to @rollup/wasm-node (node_modules-local; re-run after npm i)')