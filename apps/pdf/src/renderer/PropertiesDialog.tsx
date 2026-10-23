import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { MetadataInput } from '../shared/ipc'
import type { TFunc } from './i18n/locale'

interface RawInfo {
  Title?: string
  Author?: string
  Subject?: string
  Keywords?: string
  Creator?: string
  Producer?: string
  CreationDate?: string
  ModDate?: string
  PDFFormatVersion?: string
}

/** PDF date string D:YYYYMMDDHHmmSS… → locally readable */
function fmtPdfDate(raw?: string): string {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(raw ?? '')
  if (!m) return raw ?? '—'
  const [, y, mo, d, h = '00', mi = '00'] = m
  return `${y}-${mo}-${d} ${h}:${mi}`
}

const fmtSize = (bytes: number): string =>
  bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Document properties: first four fields are editable and become unsaved changes; the rest are read-only */
export function PropertiesDialog({
  doc,
  fileName,
  fileSize,
  pageCount,
  pending,
  fallback,
  readOnly,
  t,
  onCancel,
  onApply,
}: {
  doc: PDFDocumentProxy
  fileName: string
  fileSize: number
  pageCount: number
  /** Properties edited but not yet saved */
  pending: MetadataInput | null
  /**
   * Values already read from the file while opening it. pdf.js's own metadata pass
   * can come back empty (no Info dict fields, XMP-only files, or a metadata parse
   * that throws) — falling back to the load-time values keeps the form populated
   * with what the file actually contains instead of showing blank inputs.
   */
  fallback?: MetadataInput | null
  readOnly: boolean
  t: TFunc
  onCancel: () => void
  onApply: (meta: MetadataInput) => void
}): ReactElement {
  const [info, setInfo] = useState<RawInfo | null>(null)
  const [form, setForm] = useState<MetadataInput>({})
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Escape closes the dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Focus the first field on mount; return focus to the opener on unmount
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const root = dialogRef.current
    if (root && !root.contains(document.activeElement)) {
      root.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
    }
    return () => {
      previouslyFocused.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void doc
      .getMetadata()
      .then(({ info: raw }) => {
        if (cancelled) return
        const i = (raw ?? {}) as RawInfo
        setInfo(i)
        setForm({
          title: pending?.title ?? i.Title ?? fallback?.title ?? '',
          author: pending?.author ?? i.Author ?? fallback?.author ?? '',
          subject: pending?.subject ?? i.Subject ?? fallback?.subject ?? '',
          keywords: pending?.keywords ?? i.Keywords ?? fallback?.keywords ?? '',
        })
      })
      .catch((err: unknown) => {
        // 元数据不可读时降级为空表格，而不是让整个弹窗（乃至页面）挂掉
        console.error('[GenOffice] pdf props metadata failed', err)
        if (cancelled) return
        setInfo({})
        // 打开文件时已读到过一份元数据 —— 这里仍要把表单填上，否则真机上
        // 会表现为「属性里四个输入框全空」，看不出是文件本身没有还是读取失败。
        setForm({
          title: pending?.title ?? fallback?.title ?? '',
          author: pending?.author ?? fallback?.author ?? '',
          subject: pending?.subject ?? fallback?.subject ?? '',
          keywords: pending?.keywords ?? fallback?.keywords ?? '',
        })
      })
    return () => {
      cancelled = true
    }
  }, [doc, pending, fallback])

  const edit = (key: keyof MetadataInput, label: string): ReactElement => (
    <label className="pdf-field">
      <span>{label}</span>
      <input
        className="pdf-modal-input"
        value={form[key] ?? ''}
        placeholder={t('propEmptyPlaceholder')}
        disabled={readOnly}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  )

  const row = (label: string, value: string): ReactElement => (
    <div className="pdf-prop-row">
      <span>{label}</span>
      <em data-tip={value}>{value || '—'}</em>
    </div>
  )

  return (
    <div className="pdf-modal-mask" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="pdf-modal pdf-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('propsTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pdf-modal-title">{t('propsTitle')}</div>
        {edit('title', t('propTitle'))}
        {edit('author', t('propAuthor'))}
        {edit('subject', t('propSubject'))}
        {edit('keywords', t('propKeywords'))}
        <div className="pdf-prop-table">
          {row(t('propFileName'), fileName)}
          {row(t('propPages'), String(pageCount))}
          {row(t('propSize'), fmtSize(fileSize))}
          {row(t('propVersion'), info?.PDFFormatVersion ?? '—')}
          {row(t('propProducer'), info?.Producer ?? '')}
          {row(t('propCreated'), fmtPdfDate(info?.CreationDate))}
          {row(t('propModified'), fmtPdfDate(info?.ModDate))}
        </div>
        <div className="pdf-modal-actions">
          <button className="pdf-modal-btn" onClick={onCancel}>
            {readOnly ? t('ok') : t('cancel')}
          </button>
          {!readOnly && (
            <button className="pdf-modal-btn primary" onClick={() => onApply(form)}>
              {t('ok')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
