import type { SignatureData } from './SignatureDialog'
import type { StringKey } from './i18n/locale'

/** Built-in text-stamp presets; the visible labels come from i18n (stampPreset* keys) */
export const STAMP_PRESETS: { id: string; labelKey: StringKey }[] = [
  { id: 'approved', labelKey: 'stampPresetApproved' },
  { id: 'draft', labelKey: 'stampPresetDraft' },
  { id: 'confidential', labelKey: 'stampPresetConfidential' },
  { id: 'void', labelKey: 'stampPresetVoid' },
]

/** Base stamp bitmap size (utile); the landing size is derived by signPlaceK (page-width based) */
const STAMP_W = 150
const STAMP_H = 150
/** Super-sampling factor: draw at 4x and scale down, so the frame stays crisp on paper */
const SS = 4
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'

/** Rounded-rectangle path (ctx.roundRect is missing on some ArkWeb builds) */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Rasterize a text stamp: a double rounded frame with centered text, in the usual stamp red.
 * The result travels the existing image-signature channel (DrawingInput kind:'image'), which
 * saving already writes as a PDF stamp annotation (addImageStamp) — the same pipeline used by
 * inserted images and visual signatures.
 */
export function renderStampPreset(
  text: string,
  color = '#c62828',
): Extract<SignatureData, { kind: 'image' }> | null {
  const label = text.trim()
  if (!label) return null
  const canvas = document.createElement('canvas')
  canvas.width = STAMP_W * SS
  canvas.height = STAMP_H * SS
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(SS, SS)
  ctx.strokeStyle = color
  // Thick outer frame + thin inner frame: the common double-line office stamp look
  ctx.lineWidth = 4
  roundRectPath(ctx, 5, 5, STAMP_W - 10, STAMP_H - 10, 10)
  ctx.stroke()
  ctx.lineWidth = 1.6
  roundRectPath(ctx, 14, 14, STAMP_W - 28, STAMP_H - 28, 6)
  ctx.stroke()
  // Size the label so it stays inside the frame: short CJK labels get large type,
  // longer (English / multi-word) labels step down
  const fontSize = label.length > 6 ? 20 : label.length > 4 ? 24 : 30
  ctx.fillStyle = color
  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, STAMP_W / 2, STAMP_H / 2)
  const image = canvas.toDataURL('image/png').split(',')[1] ?? ''
  if (!image) return null
  return { kind: 'image', image, width: STAMP_W, height: STAMP_H }
}
