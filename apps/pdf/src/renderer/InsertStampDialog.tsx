import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { fileToCanvas } from './SignatureDialog'
import type { SignatureData } from './SignatureDialog'
import type { TFunc, StringKey } from './i18n/locale'
import { STAMP_PRESETS, renderStampPreset } from './stamp-image'

/** Placement mode: 'free' = click the page to place it (repeatable, Esc cancels);
    'default' = drop it straight into the default spot (bottom right of the page) */
export type StampMode = 'free' | 'default'

export interface StampPlacement {
  pick: Extract<SignatureData, { kind: 'image' }>
  /** Apply to every page (one stamp per page at the same relative position) */
  allPages: boolean
  mode: StampMode
}

/**
 * Insert-stamp dialog: preset text stamps / upload an image, plus placement mode and scope.
 * It only produces a StampPlacement; App (applyInsertStamp) does the actual placement through
 * the image-signature channel.
 */
export function InsertStampDialog({
  t,
  onCancel,
  onApply,
}: {
  t: TFunc
  onCancel: () => void
  onApply: (pl: StampPlacement) => void
}): ReactElement {
  const [pick, setPick] = useState<Extract<SignatureData, { kind: 'image' }> | null>(null)
  const [presetId, setPresetId] = useState<string>('')
  const [mode, setMode] = useState<StampMode>('free')
  const [allPages, setAllPages] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const choosePreset = (id: string, labelKey: StringKey): void => {
    const img = renderStampPreset(t(labelKey))
    if (!img) return
    setPresetId(id)
    setPick(img)
  }

  const onFile = async (file: File): Promise<void> => {
    const canvas = await fileToCanvas(file, 1600)
    const base64 = canvas?.toDataURL('image/png').split(',')[1]
    if (!canvas || !base64) return
    setPresetId('')
    setPick({ kind: 'image', image: base64, width: canvas.width, height: canvas.height })
  }

  return (
    <div className="pdf-modal-mask" onClick={onCancel}>
      <div className="pdf-modal pdf-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-modal-title">{t('insertStampTitle')}</div>

        <label className="pdf-field">
          <span>{t('insertStampPresets')}</span>
          <span className="stamp-preset-row">
            {STAMP_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`stamp-preset-btn${presetId === p.id ? ' active' : ''}`}
                onClick={() => choosePreset(p.id, p.labelKey)}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </span>
        </label>

        <div className="pdf-field">
          <span>{t('insertStampUpload')}</span>
          <span>
            <button
              type="button"
              className="pdf-modal-btn"
              onClick={() => fileRef.current?.click()}
            >
              {t('signAddImage')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void onFile(f)
              }}
            />
          </span>
        </div>

        <div className="stamp-preview">
          {pick ? (
            <img src={`data:image/png;base64,${pick.image}`} alt="" draggable={false} />
          ) : (
            <span className="pdf-sign-hint">{t('insertStampEmpty')}</span>
          )}
        </div>

        <label className="pdf-field">
          <span>{t('insertStampPosition')}</span>
          <span className="stamp-radio-row">
            <label className="stamp-radio">
              <input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} />
              <span>{t('insertStampPosFree')}</span>
            </label>
            <label className="stamp-radio">
              <input
                type="radio"
                checked={mode === 'default'}
                onChange={() => setMode('default')}
              />
              <span>{t('insertStampPosDefault')}</span>
            </label>
          </span>
        </label>

        <label className="pdf-field">
          <input
            type="checkbox"
            checked={allPages}
            onChange={(e) => setAllPages(e.target.checked)}
          />
          <span>{t('insertStampAllPages')}</span>
        </label>
        <div className="pdf-sign-hint">
          {mode === 'free' ? t('insertStampHint') : t('insertStampDefaultHint')}
        </div>

        <div className="pdf-modal-actions">
          <button className="pdf-modal-btn" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="pdf-modal-btn primary"
            disabled={!pick}
            onClick={() => {
              if (pick) onApply({ pick, allPages, mode })
            }}
          >
            {t('ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
