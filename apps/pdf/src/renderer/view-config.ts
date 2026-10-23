// cmaps/standard fonts/wasm are statically copied by the build into pdfjs/ of the renderer output (same path on the dev server)
const RAWFILE_PREFIX = 'resource://rawfile/'

/** The rawfile root this page is served from, e.g. `resource://rawfile/web/pdf/pdfjs/`. */
const rawfileBase = new URL('pdfjs/', document.baseURI).href

/**
 * Harmony shell alias for `resource://rawfile/`, injected by the host as `window.__goAssetBase`.
 * ArkWeb refuses `resource://` for fetch/XHR/dynamic import in this page (origin `null`), so
 * those bytes can only travel the `readRawFileJson` bridge — base64 through the main thread,
 * which is why CJK cmaps and the wasm decoders load slowly. The same files are additionally
 * served by the shell's `onInterceptRequest` under this https origin (http(s) *is* allowed, and
 * the permission is already declared), with no real network request involved.
 */
const injectedOrigin = (globalThis as { __goAssetBase?: string }).__goAssetBase

/** Translate a rawfile url into the shell alias, or `null` when this host has no alias. */
const aliasOf = (base: string): string | null =>
  injectedOrigin && base.startsWith(RAWFILE_PREFIX)
    ? injectedOrigin + base.slice(RAWFILE_PREFIX.length)
    : null

const aliasedBase = aliasOf(rawfileBase)

/**
 * Asset roots in priority order: the shell's self-built response first (native bytes, no bridge),
 * then the plain rawfile channel. `pdfjs-wasm.ts` fetches from the first candidate that actually
 * answers, so a shell whose interception does not fire silently keeps today's behaviour.
 */
export const ASSET_BASE_CANDIDATES: readonly string[] = aliasedBase
  ? [aliasedBase, rawfileBase]
  : [rawfileBase]

/** The plain rawfile root — the fallback candidate and the reference used by the tests. */
export const ASSET_BASE = rawfileBase

/** Root actually in use; owned by the boot probe (`pdfjs-wasm.ts`). */
let assetBase = ASSET_BASE_CANDIDATES[0]

export const setAssetBase = (base: string): void => {
  assetBase = base
}

export const getAssetBase = (): string => assetBase

export const ZOOM_STEPS = [
  0.1, 0.25, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8,
]
export const MIN_SCALE = ZOOM_STEPS[0]
export const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1]
export const PAGE_GAP = 16
export const SCROLL_PAD = 24
// ── Sidebar (thumbnails / outline) width: drag the divider to resize; persisted ──
export const SIDEBAR_W_KEY = 'genoffice-pdf-sidebar-width'
export const SIDEBAR_W_DEFAULT = 150
export const SIDEBAR_W_MIN = 120
/** pane padding (10px × 2) + thumb box borders (2px × 2) */
export const SIDEBAR_CHROME = 24

export const clampSidebarW = (w: number): number =>
  Math.min(Math.max(w, SIDEBAR_W_MIN), Math.min(320, Math.round(window.innerWidth * 0.4)))

export const loadSidebarW = (): number => {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY))
  return Number.isFinite(saved) && saved > 0 ? clampSidebarW(saved) : SIDEBAR_W_DEFAULT
}

export interface PageSize {
  width: number
  height: number
}

export type FitMode = 'width' | 'page' | null

/** Asset urls for the root currently selected by the boot probe. */
export const docOpts = (): Record<string, string | boolean> => ({
  cMapUrl: `${assetBase}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetBase}standard_fonts/`,
  wasmUrl: `${assetBase}wasm/`,
})

/**
 * Set once at boot by the wasm probe (pdfjs-wasm.ts). pdf.js v6 decodes JBIG2 / CCITT G4 fax
 * through jbig2.wasm; when that payload is unusable the pure-JS decoder is the only remaining
 * path, so the flag below switches document loads to it.
 */
let pdfjsUseWasm = true

export const setPdfjsUseWasm = (useWasm: boolean): void => {
  pdfjsUseWasm = useWasm
}

/** docOpts() plus the boot-time wasm decision — every `getDocument()` call must spread this. */
export const pdfDocOpts = (): Record<string, unknown> =>
  pdfjsUseWasm ? { ...docOpts() } : { ...docOpts(), useWasm: false }

/** Target paper sizes for "page size" (points, portrait) */
export const PAPER_SIZES = [
  { label: 'A3', w: 842, h: 1191 },
  { label: 'A4', w: 595, h: 842 },
  { label: 'A5', w: 420, h: 595 },
  { label: 'Letter', w: 612, h: 792 },
  { label: 'Legal', w: 612, h: 1008 },
] as const

/** Drawing stroke width (PDF pt); thin lines stay crisp under zoom */
export const STROKE_WIDTH = 2

/** Width of the WPS-style comments margin beside the pages */
export const NOTE_MARGIN_W = 300

/** Page ranges like "1-3,5" → list of 1-based page numbers; null if invalid */
export function parsePageRanges(input: string, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of input.split(/[,，]/)) {
    const s = part.trim()
    if (!s) continue
    const m = /^(\d+)\s*[-–]\s*(\d+)$|^(\d+)$/.exec(s)
    if (!m) return null
    const a = Number(m[1] ?? m[3])
    const b = Number(m[2] ?? m[3])
    if (a < 1 || b > max || a > b) return null
    for (let i = a; i <= b; i++) out.add(i)
  }
  return out.size > 0 ? [...out].sort((x, y) => x - y) : null
}
/** Page bitmap budget: at 800% a hi-dpi Letter page would otherwise be ~125M px */
export const MAX_PAGE_RENDER_PIXELS = 48_000_000
