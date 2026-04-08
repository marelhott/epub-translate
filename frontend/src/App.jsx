import { useEffect, useMemo, useState } from 'react'
import { AppShell } from './components/AppShell'
import { ReaderPane } from './components/ReaderPane'
import './app.css'

const SETTINGS_STORAGE_KEY = 'ebook-translator-settings-v1'

const DEFAULT_SETTINGS = {
  openrouter: {
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    useForAll: true,
    openaiModel: 'openai/gpt-5.4',
    claudeModel: 'anthropic/claude-sonnet-4.6',
    googleModel: 'google/gemini-2.5-pro',
    glmModel: 'z-ai/glm-5',
  },
  deepl: {
    apiKey: '',
    baseUrl: '',
    formality: 'prefer_more',
    modelType: 'prefer_quality_optimized',
    splitSentences: 'nonewlines',
    preserveFormatting: true,
    context:
      'Translate non-fiction book content and preserve terminology consistency, chronology, register, and named entities.',
    customInstructions:
      'Prefer natural Czech phrasing for biographies and popular science. Keep facts exact, preserve named entities, and resolve gender or case from context whenever possible.',
  },
  openai: {
    apiKey: '',
    model: 'gpt-5.4',
  },
  google: {
    accessToken: '',
    project: '',
  },
  claude: {
    apiKey: '',
    model: 'claude-sonnet-4-5',
  },
  glm: {
    apiKey: '',
    baseUrl: '',
    model: 'glm-5.1',
  },
  libre: {
    baseUrl: 'https://translate.argosopentech.com',
    apiKey: '',
  },
  pricing: {
    deepl: 20,
    openai: 30,
    google: 22,
    claude: 28,
    glm: 6,
    libre: 1.2,
  },
}

const GLM_HOSTED_PRESETS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-5',
    apiKeyLabel: 'OpenRouter API key',
  },
  {
    id: 'zai',
    label: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    model: 'glm-5.1',
    apiKeyLabel: 'Z.ai API key',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'THUDM/GLM-4.5',
    apiKeyLabel: 'SiliconFlow API key',
  },
]

function loadStoredSettings() {
  try {
    const raw =
      window.localStorage.getItem(SETTINGS_STORAGE_KEY) ||
      window.sessionStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) {
      return DEFAULT_SETTINGS
    }

    const parsed = JSON.parse(raw)
    const migratedGlm = parsed.glm || parsed.llama || {}
    const migratedOpenRouter = parsed.openrouter || {}
    if (!migratedOpenRouter.glmModel && migratedOpenRouter.llamaModel) {
      migratedOpenRouter.glmModel = migratedOpenRouter.llamaModel
    }
    const migratedPricing = { ...(parsed.pricing || {}) }
    if (migratedPricing.glm === undefined && migratedPricing.llama !== undefined) {
      migratedPricing.glm = migratedPricing.llama
    }
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      openrouter: { ...DEFAULT_SETTINGS.openrouter, ...migratedOpenRouter },
      deepl: { ...DEFAULT_SETTINGS.deepl, ...(parsed.deepl || {}) },
      openai: { ...DEFAULT_SETTINGS.openai, ...(parsed.openai || {}) },
      google: { ...DEFAULT_SETTINGS.google, ...(parsed.google || {}) },
      claude: { ...DEFAULT_SETTINGS.claude, ...(parsed.claude || {}) },
      glm: { ...DEFAULT_SETTINGS.glm, ...migratedGlm },
      libre: { ...DEFAULT_SETTINGS.libre, ...(parsed.libre || {}) },
      pricing: { ...DEFAULT_SETTINGS.pricing, ...migratedPricing },
    }
    if (!merged.openrouter.apiKey) {
      merged.openrouter.apiKey = DEFAULT_SETTINGS.openrouter.apiKey
    }
    if (!merged.openrouter.baseUrl) {
      merged.openrouter.baseUrl = DEFAULT_SETTINGS.openrouter.baseUrl
    }
    if (merged.openrouter.useForAll === undefined) {
      merged.openrouter.useForAll = DEFAULT_SETTINGS.openrouter.useForAll
    }
    return merged
  } catch {
    return DEFAULT_SETTINGS
  }
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('cs-CZ')
}

function formatPages(value) {
  return Number(value || 0).toLocaleString('cs-CZ', {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })
}

function formatCurrency(value) {
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0))
}

function estimateCostEur(characters, ratePerMillionChars) {
  return (Number(characters || 0) / 1_000_000) * Number(ratePerMillionChars || 0)
}

function sanitizeSettings(settings) {
  return {
    deepl: { ...settings.deepl },
    openrouter: { ...settings.openrouter },
    openai: { ...settings.openai },
    google: { ...settings.google },
    claude: { ...settings.claude },
    glm: { ...settings.glm },
    libre: { ...settings.libre },
  }
}

function apiUrl(path) {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('.vercel.app')) {
    return `/_/backend${path}`
  }
  return path
}

function summarizeSections(sections = []) {
  const translated = sections.filter((section) => section.includeInTranslation)
  const skipped = sections.filter((section) => !section.includeInTranslation)
  const translatedWords = translated.reduce((sum, section) => sum + (section.stats?.wordCount || 0), 0)
  const translatedCharacters = translated.reduce((sum, section) => sum + (section.stats?.characterCount || 0), 0)
  const skippedWords = skipped.reduce((sum, section) => sum + (section.stats?.wordCount || 0), 0)
  const skippedCharacters = skipped.reduce((sum, section) => sum + (section.stats?.characterCount || 0), 0)
  const ballastMap = new Map()

  for (const section of skipped) {
    const label = section.ballastCategory || 'Nezařazené'
    const current = ballastMap.get(label) || {
      label,
      sectionCount: 0,
      wordCount: 0,
      characterCount: 0,
      examples: [],
    }
    current.sectionCount += 1
    current.wordCount += section.stats?.wordCount || 0
    current.characterCount += section.stats?.characterCount || 0
    if (current.examples.length < 3) {
      current.examples.push(section.title)
    }
    ballastMap.set(label, current)
  }

  return {
    translatedSections: translated.length,
    skippedSections: skipped.length,
    translatedWords,
    translatedCharacters,
    skippedWords,
    skippedCharacters,
    estimatedPages: Math.max(1, Math.ceil(translatedWords / 300)),
    ballastBreakdown: [...ballastMap.values()].sort((left, right) => right.wordCount - left.wordCount),
  }
}

function ProviderOption({ provider, active, cost, diagnostic, onSelect }) {
  const diagnosticLabel = diagnostic?.status === 'ready' ? 'Ready' : diagnostic?.label || 'Není nastaveno'
  return (
    <button
      type="button"
      className={`provider-option provider-option--compact ${active ? 'is-active' : ''}`}
      onClick={() => onSelect(provider.id)}
    >
      <div className="provider-option-topline">
        <strong>{provider.label}</strong>
        <span className="provider-price">{formatCurrency(cost)}</span>
      </div>
      <div className="provider-option-tierline">
        <span>{provider.tier}</span>
      </div>
      <div className="provider-option-description">{provider.bestFor}</div>
      {diagnostic ? (
        <div className={`provider-diagnostic provider-diagnostic--${diagnostic.status}`}>
          <span className="provider-diagnostic-dot" />
          <strong>{diagnosticLabel}</strong>
        </div>
      ) : null}
    </button>
  )
}

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <label className="toggle-row toggle-row--compact">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <div>
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
    </label>
  )
}

function SectionToggle({ section, onToggle }) {
  return (
    <label className={`mini-section-toggle ${section.includeInTranslation ? 'is-active' : ''}`}>
      <input
        type="checkbox"
        checked={section.includeInTranslation}
        onChange={() => onToggle(section.id)}
      />
      <div>
        <strong>{section.title}</strong>
        <span>{section.stats.wordCount} slov</span>
      </div>
    </label>
  )
}

function SettingsModal({
  open,
  settings,
  savedAt,
  diagnostics,
  diagnosticsLoading,
  saveError,
  onClose,
  onChange,
  onReset,
  onSave,
  onTest,
}) {
  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-modal-head">
          <div>
            <strong>Nastavení providerů</strong>
            <span>Uložení proběhne v tomhle prohlížeči a hned se otestuje proti backendu.</span>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Zavřít
          </button>
        </div>

        <section className="settings-status-bar">
          <div className="settings-status-grid">
            {[
              ['openai', 'GPT'],
              ['claude', 'Claude'],
              ['google', 'Gemini'],
              ['glm', 'GLM'],
              ['deepl', 'DeepL'],
            ].map(([id, label]) => {
              const diagnostic = diagnostics?.[id]
              const diagnosticLabel = diagnostic?.status === 'ready' ? 'Ready' : diagnostic?.label || 'Čeká na test'
              return (
                <div key={id} className={`settings-status-chip settings-status-chip--${diagnostic?.status || 'idle'}`}>
                  <span className="provider-diagnostic-dot" />
                  <strong>{label}</strong>
                  <span>{diagnosticLabel}</span>
                </div>
              )
            })}
          </div>
          <div className="settings-status-actions">
            {savedAt ? <span className="settings-saved-badge">Uloženo v {savedAt}</span> : <span />}
            {saveError ? <span className="settings-save-error">{saveError}</span> : null}
            <button type="button" className="ghost-button" onClick={onTest}>
              {diagnosticsLoading ? 'Testuju...' : 'Otestovat připojení'}
            </button>
          </div>
        </section>

        <div className="settings-grid">
          <section className="settings-section">
            <strong>OpenRouter</strong>
            <label>
              <span>OpenRouter API key</span>
              <input
                type="password"
                value={settings.openrouter.apiKey}
                onChange={(event) => onChange('openrouter', 'apiKey', event.target.value)}
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                type="text"
                value={settings.openrouter.baseUrl}
                onChange={(event) => onChange('openrouter', 'baseUrl', event.target.value)}
              />
            </label>
            <label className="toggle-row toggle-row--compact">
              <input
                type="checkbox"
                checked={settings.openrouter.useForAll}
                onChange={(event) => onChange('openrouter', 'useForAll', event.target.checked)}
              />
              <div>
                <strong>Použít OpenRouter pro GPT / Claude / Gemini / GLM</strong>
                <span>Jeden klíč pro všechny hlavní LLM kromě DeepL.</span>
              </div>
            </label>
            <label>
              <span>GPT model</span>
              <input
                type="text"
                value={settings.openrouter.openaiModel}
                onChange={(event) => onChange('openrouter', 'openaiModel', event.target.value)}
              />
            </label>
            <label>
              <span>Claude model</span>
              <input
                type="text"
                value={settings.openrouter.claudeModel}
                onChange={(event) => onChange('openrouter', 'claudeModel', event.target.value)}
              />
            </label>
            <label>
              <span>Gemini model</span>
              <input
                type="text"
                value={settings.openrouter.googleModel}
                onChange={(event) => onChange('openrouter', 'googleModel', event.target.value)}
              />
            </label>
            <label>
              <span>GLM model</span>
              <input
                type="text"
                value={settings.openrouter.glmModel}
                onChange={(event) => onChange('openrouter', 'glmModel', event.target.value)}
              />
            </label>
            <span>
              Pro tvoje použití nech zapnuté. OpenRouter pak obslouží GPT, Claude, Gemini i GLM jedním klíčem.
            </span>
          </section>

          <section className="settings-section">
            <strong>DeepL</strong>
            <label>
              <span>API key</span>
              <input
                type="password"
                value={settings.deepl.apiKey}
                onChange={(event) => onChange('deepl', 'apiKey', event.target.value)}
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                type="text"
                value={settings.deepl.baseUrl}
                onChange={(event) => onChange('deepl', 'baseUrl', event.target.value)}
                placeholder="https://api-free.deepl.com"
              />
            </label>
            <label>
              <span>Formalita</span>
              <select
                value={settings.deepl.formality}
                onChange={(event) => onChange('deepl', 'formality', event.target.value)}
              >
                <option value="prefer_more">Spíš formální</option>
                <option value="prefer_less">Spíš přirozené</option>
                <option value="default">Default</option>
              </select>
            </label>
            <label>
              <span>Model type</span>
              <input
                type="text"
                value={settings.deepl.modelType}
                onChange={(event) => onChange('deepl', 'modelType', event.target.value)}
              />
            </label>
            <label>
              <span>Custom instructions</span>
              <textarea
                value={settings.deepl.customInstructions}
                onChange={(event) => onChange('deepl', 'customInstructions', event.target.value)}
                rows={4}
              />
            </label>
          </section>

          <section className="settings-section">
            <strong>Ostatní</strong>
            <label>
              <span>OpenAI key</span>
              <input
                type="password"
                value={settings.openai.apiKey}
                onChange={(event) => onChange('openai', 'apiKey', event.target.value)}
              />
            </label>
            <label>
              <span>Google access token</span>
              <input
                type="password"
                value={settings.google.accessToken}
                onChange={(event) => onChange('google', 'accessToken', event.target.value)}
              />
            </label>
            <label>
              <span>Google project</span>
              <input
                type="text"
                value={settings.google.project}
                onChange={(event) => onChange('google', 'project', event.target.value)}
              />
            </label>
            <label>
              <span>Claude key</span>
              <input
                type="password"
                value={settings.claude.apiKey}
                onChange={(event) => onChange('claude', 'apiKey', event.target.value)}
              />
            </label>
            <label>
              <span>GLM endpoint URL</span>
              <input
                type="text"
                value={settings.glm.baseUrl}
                onChange={(event) => onChange('glm', 'baseUrl', event.target.value)}
                placeholder="https://api.z.ai/api/coding/paas/v4"
              />
            </label>
            <div className="preset-row">
              {GLM_HOSTED_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    onChange('glm', 'baseUrl', preset.baseUrl)
                    onChange('glm', 'model', preset.model)
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label>
              <span>GLM API key</span>
              <input
                type="password"
                value={settings.glm.apiKey}
                onChange={(event) => onChange('glm', 'apiKey', event.target.value)}
              />
            </label>
            <label>
              <span>GLM model</span>
              <input
                type="text"
                value={settings.glm.model}
                onChange={(event) => onChange('glm', 'model', event.target.value)}
              />
            </label>
            <span>
              Doporučení: pro hostovaný provoz použij `OpenRouter` nebo oficiální `Z.ai` endpoint.
              Pokud používáš OpenRouter pro vše, stačí vyplnit OpenRouter sekci nahoře a GLM poběží přes ni.
            </span>
            <label>
              <span>LibreTranslate URL</span>
              <input
                type="text"
                value={settings.libre.baseUrl}
                onChange={(event) => onChange('libre', 'baseUrl', event.target.value)}
              />
            </label>
          </section>

          <section className="settings-section">
            <strong>Interní kalkulačka ceny</strong>
            {Object.keys(settings.pricing).map((providerId) => (
              <label key={providerId}>
                <span>{providerId} EUR / 1M znaků</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={settings.pricing[providerId]}
                  onChange={(event) =>
                    onChange('pricing', providerId, Number(event.target.value || 0))
                  }
                />
              </label>
            ))}
          </section>
        </div>

        <div className="settings-modal-foot">
          <span />
          <button type="button" className="ghost-button" onClick={onReset}>
            Obnovit výchozí hodnoty
          </button>
          <button type="button" className="primary-button" onClick={onSave}>
            Uložit a otestovat
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState('deepl')
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState('')
  const [statusText, setStatusText] = useState(
    'Nahraj EPUB, projdi si originál, ověř dvoustránkové preview a až potom spusť plný překlad.'
  )
  const [job, setJob] = useState(null)
  const [exportMeta, setExportMeta] = useState(null)
  const [preview, setPreview] = useState(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [originalBookUrl, setOriginalBookUrl] = useState('')
  const [translatedBookUrl, setTranslatedBookUrl] = useState('')
  const [translatedBlob, setTranslatedBlob] = useState(null)
  const [settings, setSettings] = useState(() => loadStoredSettings())
  const [diagnostics, setDiagnostics] = useState({})
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [settingsSavedAt, setSettingsSavedAt] = useState('')
  const [settingsSaveError, setSettingsSaveError] = useState('')
  const [filters, setFilters] = useState({
    includeMain: true,
    includeFront: false,
    includeBack: false,
    includeUnknown: false,
  })

  useEffect(() => {
    async function loadProviders() {
      const response = await fetch(apiUrl('/api/providers'))
      const payload = await response.json()
      setProviders(payload)
    }

    loadProviders().catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    if (!providers.length) {
      return
    }

    const timeout = window.setTimeout(() => {
      refreshDiagnostics().catch(() => {})
    }, 250)

    return () => window.clearTimeout(timeout)
  }, [providers, settings])

  useEffect(() => {
    return () => {
      if (originalBookUrl) {
        URL.revokeObjectURL(originalBookUrl)
      }
      if (translatedBookUrl) {
        URL.revokeObjectURL(translatedBookUrl)
      }
    }
  }, [originalBookUrl, translatedBookUrl])

  useEffect(() => {
    if (!analysis?.sections) {
      return
    }

    setAnalysis((current) => {
      if (!current?.sections) {
        return current
      }

      const sections = current.sections.map((section) => {
        const allowedByKind =
          (section.kind === 'main_matter' && filters.includeMain) ||
          (section.kind === 'front_matter' && filters.includeFront) ||
          (section.kind === 'back_matter' && filters.includeBack) ||
          (section.kind === 'unknown' && filters.includeUnknown)

        return { ...section, includeInTranslation: allowedByKind }
      })

      return {
        ...current,
        sections,
        summary: {
          ...current.summary,
          ...summarizeSections(sections),
        },
      }
    })
  }, [filters])

  useEffect(() => {
    if (!job?.id || job.status === 'completed' || job.status === 'failed') {
      return undefined
    }

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(apiUrl(`/api/jobs/${job.id}`))
        
        const payload = await response.json()
        if (!response.ok) {
          return
        }

        setJob(payload)
        if (payload.status === 'completed') {
          setStatusText('Překlad je hotový. Vpravo už vidíš přeložený náhled a můžeš stáhnout čistý EPUB.')
          setExportMeta({
            fileName: payload.outputFileName,
            cacheHits: payload.progress?.cacheHits || 0,
            cacheMisses: payload.progress?.cacheMisses || 0,
          })

          const downloadResponse = await fetch(apiUrl(`/api/jobs/${payload.id}/download`))
          const blob = await downloadResponse.blob()
          const nextUrl = URL.createObjectURL(blob)
          setTranslatedBlob(blob)
          setTranslatedBookUrl((current) => {
            if (current) {
              URL.revokeObjectURL(current)
            }
            return nextUrl
          })
        }

        if (payload.status === 'failed') {
          setError(payload.error || 'Překlad selhal.')
          setStatusText('Překlad selhal. Zkontroluj provider, API klíče nebo zkus nejdřív preview.')
        }
      } catch {
        // Ignore transient polling issues.
      }
    }, 1000)

    return () => window.clearInterval(interval)
  }, [job])

  const includedSections = useMemo(
    () => analysis?.sections?.filter((section) => section.includeInTranslation) || [],
    [analysis]
  )

  const providerCosts = useMemo(() => {
    const translatedCharacters = analysis?.summary?.translatedCharacters || 0
    return Object.fromEntries(
      providers.map((provider) => {
        const configuredRate = settings.pricing?.[provider.id] ?? provider.ratePerMillionCharsEur ?? 0
        return [provider.id, estimateCostEur(translatedCharacters, configuredRate)]
      })
    )
  }, [analysis, providers, settings])

  function updateSettings(section, field, value) {
    setSettings((current) => ({
      ...current,
      [section]: {
        ...current[section],
        [field]: value,
      },
    }))
  }

  function persistSettings(nextSettings) {
    const serialized = JSON.stringify(nextSettings)
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, serialized)
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (stored !== serialized) {
      throw new Error('Nastavení se nepodařilo uložit do prohlížeče.')
    }
    window.sessionStorage.setItem(SETTINGS_STORAGE_KEY, serialized)
  }

  async function saveSettings(closeAfter = false) {
    try {
      persistSettings(settings)
      setSettingsSavedAt(new Date().toLocaleTimeString('cs-CZ'))
      setSettingsSaveError('')
      await refreshDiagnostics(settings)
      if (closeAfter) {
        setIsSettingsOpen(false)
      }
    } catch (error) {
      setSettingsSaveError(error.message || 'Uložení nastavení selhalo.')
    }
  }

  async function refreshDiagnostics(nextSettings = settings) {
    setDiagnosticsLoading(true)
    try {
      const response = await fetch(apiUrl('/api/providers/diagnostics'), {
        
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: sanitizeSettings(nextSettings),
        }),
      })
      const payload = await response.json()
      if (response.ok) {
        setDiagnostics(payload)
      }
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  async function handleFileUpload(event) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const fileUrl = URL.createObjectURL(file)
    setOriginalBookUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current)
      }
      return fileUrl
    })
    setTranslatedBookUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current)
      }
      return ''
    })
    setTranslatedBlob(null)
    setPreview(null)
    setJob(null)
    setExportMeta(null)
    setError('')
    setStatusText('Načítám knihu, obal, počty slov a návrh přeložitelného rozsahu.')

    const formData = new FormData()
    formData.append('file', file)
    formData.append('languageHint', 'en')

    try {
      const response = await fetch(apiUrl('/api/analyze'), {
        method: 'POST',
        body: formData,
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.detail || payload.error || 'Analysis failed')
      }

      setAnalysis(payload)
      setSelectedProvider('deepl')
      setStatusText('Kniha je připravená. Vidíš slova, znaky včetně mezer, strany i identifikovaný balast.')
    } catch (uploadError) {
      setError(uploadError.message)
      setStatusText('Analýza selhala. Zkus jiný EPUB nebo zkontroluj backend.')
    }
  }

  function toggleSection(id) {
    setPreview(null)
    setAnalysis((current) => {
      if (!current?.sections) {
        return current
      }

      const sections = current.sections.map((section) =>
        section.id === id
          ? { ...section, includeInTranslation: !section.includeInTranslation }
          : section
      )
      return {
        ...current,
        sections,
        summary: {
          ...current.summary,
          ...summarizeSections(sections),
        },
      }
    })
  }

  async function runPreviewTranslation() {
    if (!analysis?.sections?.length || !includedSections.length) {
      return
    }

    setError('')
    setIsPreviewLoading(true)
    setStatusText('Připravuju dvoustránkové preview překladu pro vybraný provider.')

    try {
      const response = await fetch(apiUrl('/api/translate-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: analysis.sessionId,
          provider: selectedProvider,
          sourceLanguage: analysis.metadata.language || 'en',
          targetLanguage: 'cs',
          sections: analysis.sections,
          previewPageCount: 2,
          settings: sanitizeSettings(settings),
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.detail || payload.error || 'Preview failed')
      }

      setPreview(payload)
      setStatusText('Preview je hotové. Porovnej si ukázku a potom případně spusť celý překlad.')
    } catch (previewError) {
      setError(previewError.message)
      setStatusText('Preview překladu selhalo. Zkontroluj provider a API klíče v nastavení.')
    } finally {
      setIsPreviewLoading(false)
    }
  }

  async function startTranslation() {
    if (!analysis?.sessionId || !includedSections.length) {
      return
    }

    setError('')
    setExportMeta(null)
    setStatusText('Překlad běží. Vpravo sleduješ přesné procento, slova i reálný odhad stran.')

    try {
      const response = await fetch(apiUrl('/api/jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: analysis.sessionId,
          fileName: analysis.fileName,
          provider: selectedProvider,
          sourceLanguage: analysis.metadata.language || 'en',
          targetLanguage: 'cs',
          sections: analysis.sections,
          analysisSummary: analysis.summary,
          settings: sanitizeSettings(settings),
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.detail || payload.error || 'Export failed')
      }

      setJob(payload)
    } catch (jobError) {
      setError(jobError.message)
      setStatusText('Nepodařilo se spustit překlad.')
    }
  }

  function downloadTranslatedBook() {
    if (!translatedBlob) {
      return
    }

    const url = URL.createObjectURL(translatedBlob)
    const link = document.createElement('a')
    link.href = url
    link.download = exportMeta?.fileName || 'translated.clean.epub'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const rightMode = !originalBookUrl
    ? 'empty'
    : job && job.status !== 'completed' && job.status !== 'failed'
      ? 'progress'
      : translatedBookUrl
        ? 'translated'
        : 'original'

  return (
    <AppShell onOpenSettings={() => setIsSettingsOpen(true)}>
      <main className="app-layout">
        <section className="app-intro app-intro--compact">
          <h1>Překlad EPUB do čistého pracovního výstupu.</h1>
          <p>
            Nahraješ knihu, vybereš provider, rozhodneš co zachovat, ověříš preview a vrátíš nový čistý EPUB.
          </p>
        </section>

        <div className="workspace-shell">
          <aside className="sidebar sidebar--providers">
            <section className="sidebar-card">
              <div className="sidebar-label">Provider a cena</div>
              <div className="provider-stack provider-stack--compact">
                {providers.map((provider) => (
                  <ProviderOption
                    key={provider.id}
                    provider={provider}
                    active={selectedProvider === provider.id}
                    cost={providerCosts[provider.id] || 0}
                    diagnostic={diagnostics[provider.id]}
                    onSelect={(providerId) => {
                      setSelectedProvider(providerId)
                      setPreview(null)
                    }}
                  />
                ))}
              </div>
              <div className="provider-diagnostics-head">
                <strong>Diagnostika providerů</strong>
                <button type="button" className="ghost-button" onClick={refreshDiagnostics}>
                  {diagnosticsLoading ? 'Ověřuju...' : 'Obnovit stav'}
                </button>
              </div>
            </section>
          </aside>

          <section className="main-panel">
            <section className="sidebar-card workbench-toolbar">
              <div className="toolbar-upload">
                <label className="upload-card upload-card--hero upload-card--compact">
                  <span className="upload-card-title">Nahrát EPUB</span>
                  <small>Načte obal, metadata, slova, strany a pracovní rozsah.</small>
                  <div className="upload-card-button">Vybrat soubor</div>
                  <input type="file" accept=".epub,application/epub+zip" onChange={handleFileUpload} />
                </label>
              </div>

              <div className="toolbar-meta">
                {analysis ? (
                  <>
                    <div className="book-mini-card book-mini-card--compact">
                      <div className="book-mini-cover">
                        {analysis.cover?.dataUrl ? (
                          <img src={analysis.cover.dataUrl} alt={analysis.metadata.title || analysis.fileName} />
                        ) : (
                          <div className="book-mini-fallback">EPUB</div>
                        )}
                      </div>
                      <div className="book-mini-copy">
                        <strong>{analysis.metadata.title || analysis.fileName}</strong>
                        <span>{analysis.metadata.creator || 'Autor neuveden'}</span>
                        <span>{analysis.metadata.language || 'Jazyk neznámý'}</span>
                      </div>
                    </div>

                    <div className="metrics-strip metrics-strip--compact">
                      <div className="metric-pill metric-pill--loud">
                        <strong>{formatNumber(analysis.summary.translatedWords)}</strong>
                        <span>slov</span>
                      </div>
                      <div className="metric-pill metric-pill--loud">
                        <strong>{formatNumber(analysis.summary.translatedCharacters)}</strong>
                        <span>znaků vč. mezer</span>
                      </div>
                      <div className="metric-pill metric-pill--loud">
                        <strong>{formatPages(analysis.summary.estimatedPages)}</strong>
                        <span>stran</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="toolbar-placeholder">
                    <strong>Žádná kniha není načtená</strong>
                    <span>Po uploadu se tady objeví obal, autor, jazyk a počty slov i stran.</span>
                  </div>
                )}
              </div>
            </section>

            {rightMode === 'empty' ? (
              <div className="viewer-card">
                <ReaderPane bookUrl="" title="" emptyLabel="Prázdný prohlížeč knihy" />
              </div>
            ) : null}

            {rightMode === 'original' ? (
              <div className="viewer-card">
                <ReaderPane
                  bookUrl={originalBookUrl}
                  title={analysis?.metadata?.title || 'Originál'}
                  emptyLabel="Prázdný prohlížeč knihy"
                />
              </div>
            ) : null}

            {rightMode === 'progress' ? (
              <div className="viewer-card viewer-card--progress">
                <div className="progress-hero">
                  <div>
                    <div className="sidebar-label">Probíhá překlad</div>
                    <h2>{analysis?.metadata?.title || 'Kniha'}</h2>
                    <p>{statusText}</p>
                  </div>
                  <strong>{Number(job?.progress?.percent || 0).toFixed(2)} %</strong>
                </div>

                <div className="progress-track progress-track--hero">
                  <div
                    className={`progress-fill ${job?.status === 'failed' ? 'is-failed' : ''}`}
                    style={{ width: `${Math.min(100, Number(job?.progress?.percent || 0))}%` }}
                  />
                </div>

                <div className="progress-grid">
                  <div className="progress-box">
                    <strong>{formatNumber(job?.progress?.processedWords)}</strong>
                    <span>přeložených slov</span>
                  </div>
                  <div className="progress-box">
                    <strong>{formatNumber(job?.progress?.totalWords)}</strong>
                    <span>celkem slov</span>
                  </div>
                  <div className="progress-box">
                    <strong>{formatPages(job?.progress?.processedPages)}</strong>
                    <span>přeložených stran</span>
                  </div>
                  <div className="progress-box">
                    <strong>{formatPages(job?.progress?.totalPages)}</strong>
                    <span>celkem stran</span>
                  </div>
                  <div className="progress-box">
                    <strong>
                      {job?.progress?.processedBlocks || 0} / {job?.progress?.totalBlocks || 0}
                    </strong>
                    <span>textových bloků</span>
                  </div>
                  <div className="progress-box">
                    <strong>{job?.progress?.cacheHits || 0}</strong>
                    <span>cache hitů</span>
                  </div>
                </div>

                <div className="current-section">
                  {job?.progress?.currentSectionTitle
                    ? `Právě se zpracovává: ${job.progress.currentSectionTitle}`
                    : 'Čekám na další blok k překladu'}
                </div>
              </div>
            ) : null}

            {rightMode === 'translated' ? (
              <div className="viewer-card">
                <ReaderPane
                  bookUrl={translatedBookUrl}
                  title={`${analysis?.metadata?.title || 'Výsledek'} · přeložený náhled`}
                  emptyLabel="Přeložený náhled se objeví po dokončení"
                />
              </div>
            ) : null}

            {exportMeta ? (
              <section className="bottom-note">
                <strong>Export připraven</strong>
                <span>
                  Cache hits: {formatNumber(exportMeta.cacheHits)} · cache misses: {formatNumber(exportMeta.cacheMisses)}
                </span>
              </section>
            ) : null}

            {error ? <div className="inline-error">{error}</div> : null}

            <section className="bottom-note bottom-note--compact">
              <strong>Flow</strong>
              <span>Nahrát knihu, zkontrolovat preview, spustit překlad, stáhnout čistý EPUB.</span>
            </section>
          </section>

          <aside className="sidebar sidebar--actions">
            <section className="sidebar-card sidebar-card--sticky">
              <div className="sidebar-label">Rozsah a akce</div>
              <div className="toggle-stack">
                <ToggleRow
                  label="Hlavní kapitoly"
                  hint="prolog, kapitoly, epilog"
                  checked={filters.includeMain}
                  onChange={(checked) => setFilters((current) => ({ ...current, includeMain: checked }))}
                />
                <ToggleRow
                  label="Úvodní části"
                  hint="věnování, předmluva, titulní list"
                  checked={filters.includeFront}
                  onChange={(checked) => setFilters((current) => ({ ...current, includeFront: checked }))}
                />
                <ToggleRow
                  label="Zadní části"
                  hint="rejstřík, prameny, bibliografie"
                  checked={filters.includeBack}
                  onChange={(checked) => setFilters((current) => ({ ...current, includeBack: checked }))}
                />
                <ToggleRow
                  label="Nejasné sekce"
                  hint="sekce bez jisté klasifikace"
                  checked={filters.includeUnknown}
                  onChange={(checked) => setFilters((current) => ({ ...current, includeUnknown: checked }))}
                />
              </div>

              <div className="action-summary">
                <div className="metric-pill">
                  <strong>{formatNumber(analysis?.summary?.translatedWords || 0)}</strong>
                  <span>slov k překladu</span>
                </div>
                <div className="metric-pill">
                  <strong>{formatNumber(analysis?.summary?.translatedCharacters || 0)}</strong>
                  <span>znaků vč. mezer</span>
                </div>
                <div className="metric-pill">
                  <strong>{formatCurrency(providerCosts[selectedProvider] || 0)}</strong>
                  <span>odhad API pro aktivní provider</span>
                </div>
              </div>

              {analysis?.summary?.ballastBreakdown?.length ? (
                <div className="ballast-box">
                  <strong>Identifikovaný balast</strong>
                  <div className="ballast-list">
                    {analysis.summary.ballastBreakdown.map((item) => (
                      <div key={item.label} className="ballast-item">
                        <strong>{item.label}</strong>
                        <span>
                          {formatNumber(item.sectionCount)} sekcí · {formatNumber(item.wordCount)} slov
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <button
                type="button"
                className="ghost-button ghost-button--wide"
                disabled={!includedSections.length || isPreviewLoading}
                onClick={runPreviewTranslation}
              >
                {isPreviewLoading ? 'Připravuju preview...' : 'Preview 2 stran'}
              </button>
              <button
                type="button"
                className="primary-button primary-button--wide"
                disabled={!includedSections.length}
                onClick={startTranslation}
              >
                Spustit překlad
              </button>
              <button
                type="button"
                className="ghost-button ghost-button--wide"
                disabled={!translatedBlob}
                onClick={downloadTranslatedBook}
              >
                Stáhnout EPUB
              </button>
            </section>
          </aside>

          <aside className="sidebar sidebar--sections">
            {analysis ? (
              <section className="sidebar-card">
                <div className="sidebar-label">Sekce knihy</div>
                <div className="mini-section-list">
                  {analysis.sections.map((section) => (
                    <SectionToggle key={section.id} section={section} onToggle={toggleSection} />
                  ))}
                </div>
              </section>
            ) : null}

            {preview ? (
              <section className="sidebar-card">
                <div className="sidebar-label">Preview sekcí</div>
                <div className="preview-copy preview-copy--compact">
                  <strong>
                    {preview.provider} · {formatNumber(preview.wordCount)} slov · {formatPages(preview.pageCount)} strany
                  </strong>
                  <div
                    className="preview-html preview-html--compact"
                    dangerouslySetInnerHTML={{ __html: preview.translatedHtml || '' }}
                  />
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      </main>

      <SettingsModal
        open={isSettingsOpen}
        settings={settings}
        savedAt={settingsSavedAt}
        diagnostics={diagnostics}
        diagnosticsLoading={diagnosticsLoading}
        saveError={settingsSaveError}
        onClose={() => setIsSettingsOpen(false)}
        onChange={updateSettings}
        onReset={() => {
          setSettings(DEFAULT_SETTINGS)
          setSettingsSaveError('')
        }}
        onSave={() => saveSettings(false)}
        onTest={() => refreshDiagnostics(settings)}
      />
    </AppShell>
  )
}
