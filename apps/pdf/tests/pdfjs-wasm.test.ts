import { describe, expect, it, vi } from 'vitest'
import { isWasmBinary, runPdfjsWasmProbe } from '../src/renderer/pdfjs-wasm'
import { ASSET_BASE, pdfDocOpts, setPdfjsUseWasm } from '../src/renderer/view-config'

/** `\0asm` + version dword — what a real payload from the rawfile bundle starts with. */
const wasmBytes = (): Uint8Array =>
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x2a, 0x9f])

describe('isWasmBinary', () => {
  it('accepts a wasm magic header', () => {
    expect(isWasmBinary(wasmBytes())).toBe(true)
  })

  it('rejects a payload decoded as UTF-8 text (U+FFFD substitution) and short buffers', () => {
    // The failure mode this guards: a host delivering binary as text replaces the magic with
    // U+FFFD, which must not be mistaken for a usable wasm module.
    expect(isWasmBinary(new Uint8Array([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd, 0x01, 0x22]))).toBe(
      false,
    )
    expect(isWasmBinary(new Uint8Array([0x00, 0x61, 0x73]))).toBe(false)
    expect(isWasmBinary(null)).toBe(false)
  })
})

describe('runPdfjsWasmProbe', () => {
  it('keeps the wasm decoder when every payload carries the magic', async () => {
    const fetched: string[] = []
    const probe = await runPdfjsWasmProbe({
      fetchBytes: async (url) => {
        fetched.push(url)
        return wasmBytes()
      },
      importModule: async () => {
        throw new Error('the JS fallback must not be needed while wasm is usable')
      },
    })
    expect(probe.useWasm).toBe(true)
    expect(fetched).toContain(`${ASSET_BASE}wasm/jbig2.wasm`)
    expect(probe.detail).toContain('jbig2.wasm:ok')
  })

  it('falls back to the JS decoders when a payload is mangled, and reports it when unreachable', async () => {
    const probe = await runPdfjsWasmProbe({
      fetchBytes: async (url) => (url.endsWith('jbig2.wasm') ? null : wasmBytes()),
      importModule: async () => {
        throw new Error('blocked by the host')
      },
    })
    expect(probe.useWasm).toBe(false)
    expect(probe.detail).toContain('jbig2.wasm:bad')
    expect(probe.detail).toContain('jsFallback=missing')
  })

  it('reports a reachable JS fallback (scanned pages then still decode)', async () => {
    const imported: string[] = []
    const probe = await runPdfjsWasmProbe({
      fetchBytes: async () => new Uint8Array([0xef, 0xbf, 0xbd, 0x01, 0x02, 0x03, 0x04, 0x05]),
      importModule: async (url) => {
        imported.push(url)
        return {}
      },
    })
    expect(probe.useWasm).toBe(false)
    expect(imported).toContain(`${ASSET_BASE}wasm/jbig2_nowasm_fallback.js`)
    expect(probe.detail).toContain('jsFallback=ok')
  })
})

describe('asset root selection (Harmony shell alias)', () => {
  /**
   * The shell injects `window.__goAssetBase` and serves the very same rawfile tree under that
   * origin with CORS headers — the only way ArkWeb lets this page fetch binary assets without
   * going through the base64 bridge. Both signals (injected origin + rawfile page) are read at
   * module load, so each case loads a fresh copy of the modules.
   */
  const withShellHost = async <T>(
    run: () => Promise<T>,
  ): Promise<T> => {
    vi.resetModules()
    const priorBaseURI = Object.getOwnPropertyDescriptor(document, 'baseURI')
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'resource://rawfile/web/pdf/index.html',
    })
    ;(globalThis as Record<string, unknown>).__goAssetBase = 'https://goasset.local/'
    try {
      return await run()
    } finally {
      delete (globalThis as Record<string, unknown>).__goAssetBase
      if (priorBaseURI) Object.defineProperty(document, 'baseURI', priorBaseURI)
      vi.resetModules()
    }
  }

  it('lists the injected origin first and switches every asset url to it once it answers', async () => {
    await withShellHost(async () => {
      const config = await import('../src/renderer/view-config')
      expect(config.ASSET_BASE_CANDIDATES).toEqual([
        'https://goasset.local/web/pdf/pdfjs/',
        'resource://rawfile/web/pdf/pdfjs/',
      ])
      const { runPdfjsWasmProbe: probe } = await import('../src/renderer/pdfjs-wasm')
      const asked: string[] = []
      const result = await probe({
        fetchBytes: async (url) => {
          asked.push(url)
          return url.startsWith('https://goasset.local/') ? wasmBytes() : null
        },
        importModule: async () => ({}),
      })
      expect(asked[0]).toBe('https://goasset.local/web/pdf/pdfjs/wasm/jbig2.wasm')
      expect(result.useWasm).toBe(true)
      expect(result.detail).toContain('base=goasset.local/web/pdf/pdfjs/')
      expect(config.getAssetBase()).toBe('https://goasset.local/web/pdf/pdfjs/')
      expect(config.pdfDocOpts()).toMatchObject({
        cMapUrl: 'https://goasset.local/web/pdf/pdfjs/cmaps/',
        standardFontDataUrl: 'https://goasset.local/web/pdf/pdfjs/standard_fonts/',
        wasmUrl: 'https://goasset.local/web/pdf/pdfjs/wasm/',
      })
    })
  })

  it('silently stays on the rawfile root when the injected origin never answers', async () => {
    await withShellHost(async () => {
      const config = await import('../src/renderer/view-config')
      const { runPdfjsWasmProbe: probe } = await import('../src/renderer/pdfjs-wasm')
      const result = await probe({
        fetchBytes: async (url) => (url.startsWith('resource://rawfile/') ? wasmBytes() : null),
        importModule: async () => ({}),
      })
      expect(result.useWasm).toBe(true)
      expect(result.detail).toContain('base=rawfile/web/pdf/pdfjs/')
      expect(config.getAssetBase()).toBe('resource://rawfile/web/pdf/pdfjs/')
      // 该模块实例的 ASSET_BASE 就是本例的 rawfile 根（顶层 import 的那份用的是 jsdom baseURI）
      expect(config.pdfDocOpts()).toMatchObject({ wasmUrl: `${config.ASSET_BASE}wasm/` })
    })
  })
})

describe('pdfDocOpts', () => {
  it('always carries the pdf.js asset urls and reflects the probe decision', () => {
    setPdfjsUseWasm(true)
    expect(pdfDocOpts()).toMatchObject({
      cMapUrl: `${ASSET_BASE}cmaps/`,
      standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
      wasmUrl: `${ASSET_BASE}wasm/`,
    })
    expect(pdfDocOpts().useWasm).toBeUndefined()

    setPdfjsUseWasm(false)
    expect(pdfDocOpts().useWasm).toBe(false)

    setPdfjsUseWasm(true)
  })
})