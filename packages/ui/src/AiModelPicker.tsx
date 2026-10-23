import { useCallback, useEffect, useState } from 'react'

/**
 * AUTO sentinel shared with the shell bridge (harmony Index.ets: AI_MODEL_AUTO).
 * The two literals must stay identical — 'auto' alone would collide with a real
 * model id, so it is deliberately un-typeable in the picker's option list.
 */
export const AI_MODEL_AUTO = '__auto__'

export interface AiChatModelChoices {
  /** AUTO routing is on (no model pinned) */
  auto: boolean
  /** the pinned model id, or the AUTO sentinel while `auto` */
  current: string
  /** model ids saved in the settings' "add model" list, in the user's order */
  models: string[]
}

/**
 * The two calls the picker needs. Each app passes its own bridge namespace
 * (docs=desktop, sheets=desktopApi, slides=slidesApi, markdown=markdownApi,
 * pdf=pdfApi) instead of this component guessing one.
 */
export interface AiModelPickerBridge {
  getAiChatModels?: () => Promise<AiChatModelChoices> | AiChatModelChoices
  setAiChatModel?: (model: string) => Promise<AiChatModelChoices> | unknown
}

/**
 * Compact model chooser for the AI panel header. The list is whatever the user
 * saved in Settings → AI 模型, plus AUTO; picking a concrete id also switches
 * AUTO off, so a selection is never silently overridden by the router.
 */
export function AiModelPicker({ bridge }: { bridge: AiModelPickerBridge }) {
  const [choices, setChoices] = useState<AiChatModelChoices | null>(null)

  const reload = useCallback(() => {
    const get = bridge.getAiChatModels
    if (!get) return
    void Promise.resolve(get())
      .then((c) => {
        if (c) setChoices(c)
      })
      .catch(() => undefined)
  }, [bridge])

  useEffect(() => {
    reload()
  }, [reload])

  const pick = (value: string) => {
    const set = bridge.setAiChatModel
    if (!set) return
    void Promise.resolve(set(value))
      .then((c) => {
        if (c && typeof c === 'object' && 'models' in c) setChoices(c as AiChatModelChoices)
        else reload()
      })
      .catch(() => undefined)
  }

  // A bridge without the pair (an unmigrated build) renders nothing rather than
  // an empty dropdown.
  if (!choices) return null
  const value = choices.auto ? AI_MODEL_AUTO : choices.current
  const options = [
    { value: AI_MODEL_AUTO, label: 'AUTO' },
    ...choices.models.map((m) => ({ value: m, label: m })),
  ]
  // A model pinned outside the saved list still has to appear, or the select
  // would show a value that is not among its options.
  if (value && !options.some((o) => o.value === value)) {
    options.splice(1, 0, { value, label: value })
  }

  return (
    <select
      className="ai-model-picker"
      aria-label="Model"
      title={value === AI_MODEL_AUTO ? 'AUTO model' : value}
      value={value}
      onChange={(e) => pick(e.target.value)}
      style={{
        maxWidth: 150,
        height: 24,
        padding: '0 4px',
        fontSize: 12,
        color: 'inherit',
        background: 'transparent',
        border: '1px solid currentColor',
        borderRadius: 6,
        opacity: 0.85,
        cursor: 'pointer',
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}