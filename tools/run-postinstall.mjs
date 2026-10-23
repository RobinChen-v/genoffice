// Root postinstall entry: keeps the original `install-electron` behaviour on
// desktop hosts, and on OpenHarmony (where Electron ships no build and native
// `.node` modules cannot be dlopened from user dirs) applies the rollup WASM
// fallback instead so vitest/vite can start.
import { spawnSync } from 'node:child_process'

if (process.platform === 'openharmony') {
  await import('./patch-rollup-wasm.mjs')
  process.exit(0)
}

const r = spawnSync('install-electron', { shell: true, stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)