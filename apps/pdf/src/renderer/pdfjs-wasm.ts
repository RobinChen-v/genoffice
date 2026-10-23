import {
  ASSET_BASE_CANDIDATES,
  setAssetBase,
  setPdfjsUseWasm,
} from './view-config'

/**
 * pdf.js v6 hands JBIG2 / CCITT G4 fax (and JPEG2000 / qcms) decoding to wasm modules that sit
 * beside the worker. When the bytes never arrive — or arrive mangled, e.g. a host that delivers
 * binary payloads as UTF-8 text — `WebAssembly.instantiate` throws, pdf.js only warns and then
 * drops the affected tiles: a scanned page (white background image + CCITT text tiles) renders
 * almost blank, while native readers such as WPS show it fine.
 *
 * Probe the payload once at boot. If wasm is unusable, fall back to the pure-JS decoders that
 * ship next to it (`*_nowasm_fallback.js`) via `useWasm: false` — same output, slower.
 */
const WASM_FILES = ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm', 'quickjs-eval.wasm']
/** Only these two have a pure-JS decoder shipped alongside; the others are optional extras. */
const REQUIRED_FALLBACKS = ['jbig2_nowasm_fallback.js']
/** "\0asm" — the wasm binary magic number. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]

export interface PdfjsWasmProbe {
  /** false → document loads must pass `useWasm: false` (pure-JS decoders). */
  useWasm: boolean
  /** One-line per-file status, logged to the device log for field diagnosis. */
  detail: string
}

export interface PdfjsWasmProbeDeps {
  fetchBytes?: (url: string) => Promise<Uint8Array | null>
  importModule?: (url: string) => Promise<unknown>
}

/** A real wasm payload starts with `\0asm` and carries the version dword after it. */
export function isWasmBinary(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < 8) return false
  return WASM_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * Upper bound for one asset request. The first candidate may be a shell-provided origin that
 * silently does not answer (no interception registered), and DNS for it never resolves — without
 * this the boot probe would stall the first document load.
 */
const PROBE_TIMEOUT_MS = 2500

async function fetchWasmBytes(url: string): Promise<Uint8Array | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer =
    controller && typeof setTimeout === 'function'
      ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      : null
  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined)
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function importRawfileJs(url: string): Promise<unknown> {
  // Runtime URL (rawfile / dev server) — must stay a native dynamic import, never bundled
  return import(/* @vite-ignore */ url)
}

/**
 * Pick the first asset root that really delivers bytes (the payload doubles as the jbig2 check
 * below). Falls back to the last candidate — the plain rawfile root — when none answers.
 */
async function pickAssetBase(
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
): Promise<{ base: string; bytes: Uint8Array | null }> {
  const fallback = ASSET_BASE_CANDIDATES[ASSET_BASE_CANDIDATES.length - 1]
  for (const candidate of ASSET_BASE_CANDIDATES) {
    const bytes = await fetchBytes(`${candidate}wasm/jbig2.wasm`)
    if (isWasmBinary(bytes)) return { base: candidate, bytes }
  }
  return { base: fallback, bytes: null }
}

/** `https://goasset.local/web/pdf/pdfjs/` → `goasset.local/web/pdf/pdfjs/` (log-friendly). */
const shortBase = (base: string): string => base.replace(/^[a-z]+:\/\//, '')

/** Probe the pdf.js wasm payloads; `deps` is injectable so the unit tests stay offline. */
export async function runPdfjsWasmProbe(deps: PdfjsWasmProbeDeps = {}): Promise<PdfjsWasmProbe> {
  const fetchBytes = deps.fetchBytes ?? fetchWasmBytes
  const importModule = deps.importModule ?? importRawfileJs
  const picked = await pickAssetBase(fetchBytes)
  setAssetBase(picked.base)
  const parts: string[] = [`base=${shortBase(picked.base)}`]
  let usable = true
  for (const file of WASM_FILES) {
    const bytes =
      file === 'jbig2.wasm' && picked.bytes ? picked.bytes : await fetchBytes(`${picked.base}wasm/${file}`)
    const ok = isWasmBinary(bytes)
    if (!ok) usable = false
    parts.push(`${file}:${ok ? 'ok' : 'bad'}${bytes ? `/${bytes.length}B` : ''}`)
  }
  if (usable) return { useWasm: true, detail: parts.join(' ') }
  // wasm is out: the JS decoders are the only remaining path for scanned pages — report whether
  // they are actually reachable, because a silent failure here is exactly the blank-page symptom.
  let fallbackOk = true
  for (const file of REQUIRED_FALLBACKS) {
    try {
      await importModule(`${picked.base}wasm/${file}`)
      parts.push(`${file}:ok`)
    } catch (error) {
      fallbackOk = false
      parts.push(`${file}:${error instanceof Error ? error.message : 'failed'}`)
    }
  }
  return { useWasm: false, detail: `${parts.join(' ')} jsFallback=${fallbackOk ? 'ok' : 'missing'}` }
}

let probePromise: Promise<PdfjsWasmProbe> | null = null

/**
 * Boot-time probe, run at most once per page: it stores the decision for `pdfDocOpts()` and logs
 * the outcome so a device run shows which decoder path is in use.
 */
export function ensurePdfjsWasm(): Promise<PdfjsWasmProbe> {
  if (!probePromise) {
    probePromise = runPdfjsWasmProbe().then((probe) => {
      setPdfjsUseWasm(probe.useWasm)
      console.info(`[GenOffice][pdf] pdfjs wasm probe: ${probe.detail} → useWasm=${probe.useWasm}`)
      return probe
    })
  }
  return probePromise
}