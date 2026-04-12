import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { ReaderPane } from './components/ReaderPane'
import './app.css'

const SETTINGS_STORAGE_KEY = 'ebook-translator-settings-v1'

const DEFAULT_SETTINGS = {
  openrouter: {
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    useForAll: true,
    openaiModel: 'openai/gpt-5.4',
    claudeModel: 'anthropic/claude-sonnet-4-6',
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
  openai: { apiKey: '', model: 'gpt-5.4' },
  google: { accessToken: '', project: '' },
  claude: { apiKey: '', model: 'claude-sonnet-4-6' },
  glm: { apiKey: '', baseUrl: '', model: 'glm-5.1' },
  // Sazby EUR/1M znaků — reálné tržní ceny (duben 2026)
  // LLM modely: ~2500 tokenů/10k znaků, input+output kombinovaně
  // DeepL / Google: character-based přímé API
  pricing: {
    deepl: 25,    // €25/1M znaků — DeepL API Pro (character-based)
    openai: 4.1,  // GPT-5.4 via OpenRouter: $2.50 in + $15 out /1M tokenů → ~$4.40/1M znaků → €4.05
    google: 18.4, // Google Cloud Translation Advanced: $20/1M znaků → €18.40
    claude: 4.1,  // Claude Sonnet 4.6 via OpenRouter: $3 in + $15 out /1M tokenů → ~$4.50/1M znaků → €4.14
    glm: 0.28,    // GLM 5.1 via OpenRouter/Z.ai: ~$0.30/1M znaků → €0.28
  },
}

const GLM_HOSTED_PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5' },
  { id: 'zai', label: 'Z.ai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.1' },
  { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-4.5' },
]

function loadStoredSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY) || window.sessionStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    // Migrace: vždy přepiš pricing na správné defaulty z backendu
    // (starší verze měly špatné hodnoty openai: 30, claude: 28 atd.)
    const parsed = JSON.parse(raw)
    const migratedGlm = parsed.glm || parsed.llama || {}
    const migratedOpenRouter = parsed.openrouter || {}
    if (!migratedOpenRouter.glmModel && migratedOpenRouter.llamaModel) migratedOpenRouter.glmModel = migratedOpenRouter.llamaModel
    const migratedPricing = { ...(parsed.pricing || {}) }
    if (migratedPricing.glm === undefined && migratedPricing.llama !== undefined) migratedPricing.glm = migratedPricing.llama
    const merged = {
      ...DEFAULT_SETTINGS, ...parsed,
      openrouter: { ...DEFAULT_SETTINGS.openrouter, ...migratedOpenRouter },
      deepl: { ...DEFAULT_SETTINGS.deepl, ...(parsed.deepl || {}) },
      openai: { ...DEFAULT_SETTINGS.openai, ...(parsed.openai || {}) },
      google: { ...DEFAULT_SETTINGS.google, ...(parsed.google || {}) },
      claude: { ...DEFAULT_SETTINGS.claude, ...(parsed.claude || {}) },
      glm: { ...DEFAULT_SETTINGS.glm, ...migratedGlm },
      // Pricing: DEFAULT_SETTINGS hodnoty mají přednost — přebíjí staré uložené hodnoty
      pricing: { ...migratedPricing, ...DEFAULT_SETTINGS.pricing },
    }
    if (!merged.openrouter.apiKey) merged.openrouter.apiKey = DEFAULT_SETTINGS.openrouter.apiKey
    if (!merged.openrouter.baseUrl) merged.openrouter.baseUrl = DEFAULT_SETTINGS.openrouter.baseUrl
    if (merged.openrouter.useForAll === undefined) merged.openrouter.useForAll = DEFAULT_SETTINGS.openrouter.useForAll
    return merged
  } catch { return DEFAULT_SETTINGS }
}

function formatNumber(value) { return Number(value || 0).toLocaleString('cs-CZ') }
function formatPages(value) {
  return Number(value || 0).toLocaleString('cs-CZ', {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })
}
function formatCurrency(value) {
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(Number(value || 0))
}
function formatDateTime(value) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('cs-CZ', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return '—'
  }
}
function providerMoniker(providerId) {
  if (providerId === 'openai') return 'AI'
  if (providerId === 'deepl') return 'DL'
  if (providerId === 'claude') return 'CL'
  if (providerId === 'google') return 'GM'
  if (providerId === 'glm') return 'ZM'
  return 'API'
}
function providerVersion(providerId) {
  if (providerId === 'deepl') return 'v2'
  if (providerId === 'openai') return 'gpt-5.4'
  if (providerId === 'claude') return '4-6'
  if (providerId === 'google') return '2.5-pro'
  if (providerId === 'glm') return '5.1'
  return 'api'
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
  }
}
function apiUrl(path) {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('.vercel.app')) return `/_/backend${path}`
  return path
}
async function parseJsonSafely(response) {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { detail: text } }
}

function sanitizePreviewHtml(html) {
  if (typeof window === 'undefined' || !html) return html || ''
  try {
    const template = window.document.createElement('template')
    template.innerHTML = html
    const blockedTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'])
    const walker = window.document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT)
    const nodes = []
    let current = walker.nextNode()
    while (current) { nodes.push(current); current = walker.nextNode() }
    for (const node of nodes) {
      const tagName = node.tagName?.toLowerCase?.() || ''
      if (blockedTags.has(tagName)) { node.remove(); continue }
      if (!node.attributes) continue
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase()
        const value = attr.value || ''
        if (name.startsWith('on')) { node.removeAttribute(attr.name); continue }
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) node.removeAttribute(attr.name)
      }
    }
    return template.innerHTML
  } catch (error) { console.error('[sanitizePreviewHtml] failed', error); return html }
}

function buildEpubRequestPayload(payload, originalBookData, fallbackFileName = 'book.epub') {
  const formData = new FormData()
  formData.append('payload', JSON.stringify(payload))
  if (originalBookData) {
    formData.append(
      'file',
      new Blob([originalBookData], { type: 'application/epub+zip' }),
      fallbackFileName
    )
  }
  return formData
}

function summarizeSections(sections = []) {
  const translated = sections.filter((s) => s.includeInTranslation)
  const skipped = sections.filter((s) => !s.includeInTranslation)
  const translatedWords = translated.reduce((sum, s) => sum + (s.stats?.wordCount || 0), 0)
  const translatedCharacters = translated.reduce((sum, s) => sum + (s.stats?.characterCount || 0), 0)
  const skippedWords = skipped.reduce((sum, s) => sum + (s.stats?.wordCount || 0), 0)
  const skippedCharacters = skipped.reduce((sum, s) => sum + (s.stats?.characterCount || 0), 0)
  const ballastMap = new Map()
  for (const section of skipped) {
    const label = section.ballastCategory || 'Nezařazené'
    const cur = ballastMap.get(label) || { label, sectionCount: 0, wordCount: 0, characterCount: 0, examples: [] }
    cur.sectionCount += 1; cur.wordCount += section.stats?.wordCount || 0
    cur.characterCount += section.stats?.characterCount || 0
    if (cur.examples.length < 3) cur.examples.push(section.title)
    ballastMap.set(label, cur)
  }
  return {
    translatedSections: translated.length,
    skippedSections: skipped.length,
    translatedWords, translatedCharacters, skippedWords, skippedCharacters,
    estimatedPages: Math.max(1, Math.ceil(translatedWords / 300)),
    ballastBreakdown: [...ballastMap.values()].sort((a, b) => b.wordCount - a.wordCount),
  }
}

/* ──────────────────────────────────────────────────────
   SETTINGS MODAL
────────────────────────────────────────────────────── */
function SettingsModal({ open, settings, savedAt, diagnostics, diagnosticsLoading, saveError, onClose, onChange, onReset, onSave, onTest }) {
  if (!open) return null
  const statusProviders = [['openai', 'GPT'], ['claude', 'Claude'], ['google', 'Gemini'], ['glm', 'GLM'], ['deepl', 'DeepL']]
  return (
    <div className="wb-modal-backdrop" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        {/* Modal topbar */}
        <div className="wb-modal-topbar">
          <span className="wb-modal-title">Nastavení providerů</span>
          <div className="wb-modal-actions">
            <button className="wb-btn" style={{ width: 'auto', padding: '0 12px' }} onClick={onTest}>
              {diagnosticsLoading ? 'Testuju…' : 'Otestovat připojení'}
            </button>
            <button className="wb-btn" style={{ width: 'auto', padding: '0 12px' }} onClick={onClose}>Zavřít</button>
          </div>
        </div>

        {/* Provider status strip */}
        <div className="wb-modal-status-strip">
          {statusProviders.map(([id, label]) => {
            const d = diagnostics?.[id]
            const statusLabel = d?.status === 'ready' ? 'Ready' : d?.label || 'Čeká na test'
            return (
              <div key={id} className="wb-modal-status-cell">
                <span className={`wb-status-indicator wb-status-indicator--${d?.status || 'idle'}`} />
                <span className="wb-modal-status-name">{label}</span>
                <span className="wb-modal-status-label">{statusLabel}</span>
              </div>
            )
          })}
        </div>

        {/* Settings columns */}
        <div className="wb-modal-body">
          <div className="wb-settings-grid">
            {/* OpenRouter */}
            <div className="wb-settings-col">
              <div className="wb-settings-col-title">OpenRouter</div>
              <div className="wb-field">
                <label className="wb-field-label">API Key</label>
                <input type="password" value={settings.openrouter.apiKey} onChange={(e) => onChange('openrouter', 'apiKey', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Base URL</label>
                <input type="text" value={settings.openrouter.baseUrl} onChange={(e) => onChange('openrouter', 'baseUrl', e.target.value)} />
              </div>
              <label className="wb-checkbox-row">
                <input type="checkbox" checked={settings.openrouter.useForAll} onChange={(e) => onChange('openrouter', 'useForAll', e.target.checked)} />
                <div>
                  <div className="wb-checkbox-text">Použít OpenRouter pro GPT / Claude / Gemini / GLM</div>
                  <div className="wb-checkbox-hint">Jeden klíč pro všechny hlavní LLM kromě DeepL.</div>
                </div>
              </label>
              <div className="wb-field">
                <label className="wb-field-label">GPT model</label>
                <input type="text" value={settings.openrouter.openaiModel} onChange={(e) => onChange('openrouter', 'openaiModel', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Claude model</label>
                <input type="text" value={settings.openrouter.claudeModel} onChange={(e) => onChange('openrouter', 'claudeModel', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Gemini model</label>
                <input type="text" value={settings.openrouter.googleModel} onChange={(e) => onChange('openrouter', 'googleModel', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">GLM model</label>
                <input type="text" value={settings.openrouter.glmModel} onChange={(e) => onChange('openrouter', 'glmModel', e.target.value)} />
              </div>
            </div>

            {/* DeepL */}
            <div className="wb-settings-col">
              <div className="wb-settings-col-title">DeepL</div>
              <div className="wb-field">
                <label className="wb-field-label">API Key</label>
                <input type="password" value={settings.deepl.apiKey} onChange={(e) => onChange('deepl', 'apiKey', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Base URL</label>
                <input type="text" value={settings.deepl.baseUrl} onChange={(e) => onChange('deepl', 'baseUrl', e.target.value)} placeholder="https://api-free.deepl.com" />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Formalita</label>
                <select value={settings.deepl.formality} onChange={(e) => onChange('deepl', 'formality', e.target.value)}>
                  <option value="prefer_more">Spíš formální</option>
                  <option value="prefer_less">Spíš přirozené</option>
                  <option value="default">Default</option>
                </select>
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Model type</label>
                <input type="text" value={settings.deepl.modelType} onChange={(e) => onChange('deepl', 'modelType', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Custom instructions</label>
                <textarea value={settings.deepl.customInstructions} onChange={(e) => onChange('deepl', 'customInstructions', e.target.value)} rows={4} />
              </div>
            </div>

            {/* Ostatní + Pricing */}
            <div className="wb-settings-col">
              <div className="wb-settings-col-title">Ostatní</div>
              <div className="wb-field">
                <label className="wb-field-label">OpenAI Key</label>
                <input type="password" value={settings.openai.apiKey} onChange={(e) => onChange('openai', 'apiKey', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Google access token</label>
                <input type="password" value={settings.google.accessToken} onChange={(e) => onChange('google', 'accessToken', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Google project</label>
                <input type="text" value={settings.google.project} onChange={(e) => onChange('google', 'project', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">Claude key</label>
                <input type="password" value={settings.claude.apiKey} onChange={(e) => onChange('claude', 'apiKey', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">GLM endpoint URL</label>
                <input type="text" value={settings.glm.baseUrl} onChange={(e) => onChange('glm', 'baseUrl', e.target.value)} placeholder="https://api.z.ai/api/coding/paas/v4" />
              </div>
              <div className="wb-preset-row">
                {GLM_HOSTED_PRESETS.map((preset) => (
                  <button key={preset.id} className="wb-preset-btn" onClick={() => { onChange('glm', 'baseUrl', preset.baseUrl); onChange('glm', 'model', preset.model) }}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="wb-field">
                <label className="wb-field-label">GLM API key</label>
                <input type="password" value={settings.glm.apiKey} onChange={(e) => onChange('glm', 'apiKey', e.target.value)} />
              </div>
              <div className="wb-field">
                <label className="wb-field-label">GLM model</label>
                <input type="text" value={settings.glm.model} onChange={(e) => onChange('glm', 'model', e.target.value)} />
              </div>

              <div className="wb-settings-col-title" style={{ marginTop: 4 }}>Ceník EUR / 1M znaků</div>
              {Object.keys(settings.pricing).map((pid) => (
                <div key={pid} className="wb-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <label className="wb-field-label" style={{ minWidth: 64, marginBottom: 0 }}>{pid}</label>
                  <input type="number" min="0" step="0.1" value={settings.pricing[pid]}
                    onChange={(e) => onChange('pricing', pid, Number(e.target.value || 0))}
                    style={{ width: 72 }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div className="wb-modal-foot">
          <div className="wb-modal-foot-left">
            {savedAt ? <span className="wb-saved-badge">Uloženo {savedAt}</span> : null}
            {saveError ? <span className="wb-save-error">{saveError}</span> : null}
          </div>
          <div className="wb-modal-foot-right">
            <button className="wb-btn" style={{ width: 'auto', padding: '0 12px' }} onClick={onReset}>Obnovit výchozí</button>
            <button className="wb-btn wb-btn--accent" style={{ width: 'auto', padding: '0 16px' }} onClick={onSave}>Uložit a otestovat</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
   ERROR BOUNDARY
────────────────────────────────────────────────────── */
class UiErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, message: '', componentStack: '' } }
  static getDerivedStateFromError(error) { return { hasError: true, message: error?.message || 'Neočekávaná chyba.' } }
  componentDidCatch(error, info) {
    console.error('[UiErrorBoundary] crash', error)
    if (info?.componentStack) this.setState({ componentStack: info.componentStack })
  }
  handleReset = () => this.setState({ hasError: false, message: '', componentStack: '' })
  render() {
    if (this.state.hasError) {
      return (
        <div className="wb-crash">
          <span className="wb-crash-title">Rozhraní narazilo na chybu. Data zůstala.</span>
          <span className="wb-crash-msg">{this.state.message}</span>
          {this.state.componentStack && (
            <details className="wb-crash-details">
              <summary>Stack trace</summary>
              {this.state.componentStack}
            </details>
          )}
          <div className="wb-crash-btns">
            <button className="wb-btn" style={{ width: 'auto', padding: '0 12px' }} onClick={this.handleReset}>Zkusit znovu</button>
            <button className="wb-btn" style={{ width: 'auto', padding: '0 12px' }} onClick={() => window.location.reload()}>Obnovit stránku</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/* ──────────────────────────────────────────────────────
   ICONS
────────────────────────────────────────────────────── */
function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25">
      <circle cx="8" cy="8" r="2"/>
      <path d="M8 2v1M8 13v1M2 8h1M13 8h1M3.6 3.6l.7.7M11.7 11.7l.7.7M3.6 12.4l.7-.7M11.7 4.3l.7-.7"/>
    </svg>
  )
}

function IconUpload() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 10V3M5 6l3-3 3 3M3 12h10"/>
    </svg>
  )
}

function IconRefresh() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.1-3.3"/>
      <path d="M13.5 3v2.5H11"/>
    </svg>
  )
}

/* ──────────────────────────────────────────────────────
   APP
────────────────────────────────────────────────────── */
export default function App() {
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState('deepl')
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState('')
  const [statusText, setStatusText] = useState('Nahraj EPUB, ověř preview, spusť překlad.')
  const [job, setJob] = useState(null)
  const [jobs, setJobs] = useState([])
  const [backendHealth, setBackendHealth] = useState(null)
  const [exportMeta, setExportMeta] = useState(null)
  const [preview, setPreview] = useState(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewStartedAt, setPreviewStartedAt] = useState(0)
  const [previewTick, setPreviewTick] = useState(0)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [originalBookData, setOriginalBookData] = useState(null)
  const [translatedBookData, setTranslatedBookData] = useState(null)
  const [translatedBlob, setTranslatedBlob] = useState(null)
  const [settings, setSettings] = useState(() => loadStoredSettings())
  const [diagnostics, setDiagnostics] = useState({})
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [settingsSavedAt, setSettingsSavedAt] = useState('')
  const [settingsSaveError, setSettingsSaveError] = useState('')
  const pollingRef = useRef({ jobId: '', startedAt: 0, failures: 0 })
  const previewAbortRef = useRef(null)
  const [filters, setFilters] = useState({ includeMain: true, includeFront: false, includeBack: false, includeUnknown: false })

  useEffect(() => {
    async function loadProviders() {
      const response = await fetch(apiUrl('/api/providers'))
      const payload = await response.json()
      setProviders(payload)
    }
    loadProviders().catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    fetch(apiUrl('/api/health'))
      .then((response) => parseJsonSafely(response))
      .then((payload) => setBackendHealth(payload))
      .catch(() => setBackendHealth(null))
  }, [])

  useEffect(() => {
    if (!providers.length) return
    const timeout = window.setTimeout(() => refreshDiagnostics().catch(() => {}), 250)
    return () => window.clearTimeout(timeout)
  }, [providers, settings])

  useEffect(() => {
    loadJobs().catch(() => {})
    const interval = window.setInterval(() => loadJobs().catch(() => {}), 5000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!analysis?.sections) return
    setAnalysis((current) => {
      if (!current?.sections) return current
      const sections = current.sections.map((section) => {
        const allowedByKind =
          (section.kind === 'main_matter' && filters.includeMain) ||
          (section.kind === 'front_matter' && filters.includeFront) ||
          (section.kind === 'back_matter' && filters.includeBack) ||
          (section.kind === 'unknown' && filters.includeUnknown)
        return { ...section, includeInTranslation: allowedByKind }
      })
      return { ...current, sections, summary: { ...current.summary, ...summarizeSections(sections) } }
    })
  }, [filters])

  useEffect(() => {
    if (!isPreviewLoading) return undefined
    const interval = window.setInterval(() => setPreviewTick(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [isPreviewLoading])

  useEffect(() => {
    if (!job?.id || job.status === 'completed' || job.status === 'failed') {
      pollingRef.current = { jobId: '', startedAt: 0, failures: 0 }
      return undefined
    }
    if (pollingRef.current.jobId !== job.id) pollingRef.current = { jobId: job.id, startedAt: Date.now(), failures: 0 }

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(apiUrl(`/api/jobs/${job.id}`))
        if (!response.ok) { pollingRef.current.failures += 1; return }
        const payload = await parseJsonSafely(response)
        if (!payload) { pollingRef.current.failures += 1; return }
        pollingRef.current.failures = 0
        setJob(payload)
        setJobs((current) => [payload, ...current.filter((item) => item.id !== payload.id)].slice(0, 12))
        if (payload.status === 'completed') {
          setStatusText('Překlad hotový.')
          setExportMeta({ fileName: payload.outputFileName, cacheHits: payload.progress?.cacheHits || 0, cacheMisses: payload.progress?.cacheMisses || 0 })
          const downloadResponse = await fetch(apiUrl(`/api/jobs/${payload.id}/download`))
          if (!downloadResponse.ok) throw new Error('Nepodařilo se stáhnout výsledný EPUB.')
          const blob = await downloadResponse.blob()
          const bookData = await blob.arrayBuffer()
          setTranslatedBlob(blob)
          setTranslatedBookData(bookData)
        }
        if (payload.status === 'failed') {
          setError(payload?.error || 'Překlad selhal.')
          setStatusText('Překlad selhal.')
        }
      } catch (pollError) {
        pollingRef.current.failures += 1
        if (pollingRef.current.failures >= 5) {
          setStatusText('Spojení s jobem se obnovuje… překlad nepovažuju za ukončený.')
        }
      }
    }, 1000)
    return () => window.clearInterval(interval)
  }, [job])

  const includedSections = useMemo(
    () => analysis?.sections?.filter((s) => s.includeInTranslation) || [],
    [analysis]
  )

  const originalReaderTargets = useMemo(() => {
    if (!analysis?.sections?.length) return []
    const allSections = analysis.sections
    const activeSections = includedSections.length ? includedSections : allSections
    const oneThirdIndex = Math.min(activeSections.length - 1, Math.max(0, Math.floor(activeSections.length / 3)))
    const twoThirdsIndex = Math.min(activeSections.length - 1, Math.max(0, Math.floor((activeSections.length * 2) / 3)))
    return [
      allSections[0] ? { label: 'Obálka', href: allSections[0].href, spineIndex: allSections[0].spineIndex } : null,
      activeSections[0] ? { label: 'Začátek překladu', href: activeSections[0].href, spineIndex: activeSections[0].spineIndex } : null,
      activeSections[oneThirdIndex] ? { label: '1/3', href: activeSections[oneThirdIndex].href, spineIndex: activeSections[oneThirdIndex].spineIndex } : null,
      activeSections[twoThirdsIndex] ? { label: '2/3', href: activeSections[twoThirdsIndex].href, spineIndex: activeSections[twoThirdsIndex].spineIndex } : null,
    ].filter(Boolean)
  }, [analysis, includedSections])

  const _initialSection = includedSections[0] || analysis?.sections?.[0]
  const _initialHref = _initialSection?.href ?? ''
  const _initialSpineIndex = _initialSection?.spineIndex ?? null
  const originalReaderInitialLocation = useMemo(
    () => _initialHref || _initialSpineIndex != null ? { href: _initialHref, spineIndex: _initialSpineIndex } : null,
    [_initialHref, _initialSpineIndex]
  )

  const providerCosts = useMemo(() => {
    const translatedCharacters = analysis?.summary?.translatedCharacters || 0
    return Object.fromEntries(providers.map((p) => {
      // Backend ratePerMillionCharsEur je zdroj pravdy.
      // settings.pricing je jen manuální override (pokud user zadal nenulovou hodnotu).
      const backendRate = p.ratePerMillionCharsEur ?? 0
      const userRate = settings.pricing?.[p.id]
      const rate = (userRate != null && userRate !== backendRate) ? userRate : backendRate
      return [p.id, estimateCostEur(translatedCharacters, rate)]
    }))
  }, [analysis, providers, settings])

  const progressRuntimeMinutes = useMemo(() => {
    if (!job?.startedAt) return 0
    return Math.max(0.02, (Date.now() - new Date(job.startedAt).getTime()) / 60000)
  }, [job])

  const progressWordsPerMinute = useMemo(() => {
    if (!job?.progress?.processedWords || !progressRuntimeMinutes) return 0
    return Math.round(job.progress.processedWords / progressRuntimeMinutes)
  }, [job, progressRuntimeMinutes])

  function updateSettings(section, field, value) {
    setSettings((cur) => ({ ...cur, [section]: { ...cur[section], [field]: value } }))
  }

  function persistSettings(nextSettings) {
    const serialized = JSON.stringify(nextSettings)
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, serialized)
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (stored !== serialized) throw new Error('Nastavení se nepodařilo uložit.')
    window.sessionStorage.setItem(SETTINGS_STORAGE_KEY, serialized)
  }

  async function saveSettings(closeAfter = false) {
    try {
      persistSettings(settings)
      setSettingsSavedAt(new Date().toLocaleTimeString('cs-CZ'))
      setSettingsSaveError('')
      await refreshDiagnostics(settings)
      if (closeAfter) setIsSettingsOpen(false)
    } catch (error) { setSettingsSaveError(error.message || 'Uložení selhalo.') }
  }

  async function refreshDiagnostics(nextSettings = settings) {
    setDiagnosticsLoading(true)
    try {
      const response = await fetch(apiUrl('/api/providers/diagnostics'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: sanitizeSettings(nextSettings) }),
      })
      const payload = await parseJsonSafely(response)
      if (response.ok) setDiagnostics(payload)
      else throw new Error(payload?.detail || payload?.error || 'Diagnostika selhala.')
    } finally { setDiagnosticsLoading(false) }
  }

  async function loadJobs() {
    const response = await fetch(apiUrl('/api/jobs'))
    const payload = await parseJsonSafely(response)
    if (!response.ok || !Array.isArray(payload)) return
    setJobs(payload.slice(0, 12))
  }

  async function handleFileUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setOriginalBookData(null); setTranslatedBookData(null); setTranslatedBlob(null)
    setPreview(null); setJob(null); setExportMeta(null); setError('')
    setStatusText('Načítám knihu…')
    const formData = new FormData()
    formData.append('file', file)
    formData.append('languageHint', 'en')
    try {
      const fileBuffer = await file.arrayBuffer()
      const response = await fetch(apiUrl('/api/analyze'), { method: 'POST', body: formData })
      const payload = await parseJsonSafely(response)
      if (!response.ok) throw new Error(payload?.detail || payload?.error || `HTTP ${response.status}`)
      if (!payload) throw new Error('Server vrátil prázdnou odpověď.')
      setOriginalBookData(fileBuffer)
      setAnalysis(payload)
      setSelectedProvider('deepl')
      setStatusText('Kniha připravena. Ověř preview, pak spusť překlad.')
    } catch (uploadError) {
      setError(uploadError.message)
      setStatusText('Analýza selhala.')
    }
  }

  function toggleSection(id) {
    setPreview(null)
    setAnalysis((cur) => {
      if (!cur?.sections) return cur
      const sections = cur.sections.map((s) => s.id === id ? { ...s, includeInTranslation: !s.includeInTranslation } : s)
      return { ...cur, sections, summary: { ...cur.summary, ...summarizeSections(sections) } }
    })
  }

  async function runPreviewTranslation() {
    if (!analysis?.sections?.length || !includedSections.length || !originalBookData) return
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller
    setError(''); setPreview(null); setIsPreviewLoading(true)
    setPreviewStartedAt(Date.now()); setPreviewTick(Date.now())
    setStatusText('Překládám dvoustránkové preview…')
    try {
      const requestPayload = {
        sessionId: analysis.sessionId,
        provider: selectedProvider,
        sourceLanguage: analysis.metadata.language || 'en',
        targetLanguage: 'cs',
        sections: analysis.sections,
        previewPageCount: 2,
        settings: sanitizeSettings(settings),
      }
      const response = await fetch(apiUrl('/api/translate-preview'), {
        method: 'POST',
        body: buildEpubRequestPayload(requestPayload, originalBookData, analysis.fileName),
        signal: controller.signal,
      })
      const payload = await parseJsonSafely(response)
      if (!response.ok) throw new Error(payload?.detail || payload?.error || 'Preview failed')
      setPreview(payload)
      setStatusText('Preview hotové. Porovnej ukázku a spusť překlad.')
    } catch (previewError) {
      if (previewError.name !== 'AbortError') {
        setError(previewError.message)
        setStatusText('Preview selhalo.')
      }
    } finally {
      setIsPreviewLoading(false)
      setPreviewStartedAt(0)
    }
  }

  async function startTranslation() {
    if (!analysis?.sessionId || !includedSections.length || !originalBookData) return
    setError(''); setExportMeta(null)
    setStatusText('Překlad probíhá…')
    try {
      const requestPayload = {
        sessionId: analysis.sessionId,
        fileName: analysis.fileName,
        provider: selectedProvider,
        sourceLanguage: analysis.metadata.language || 'en',
        targetLanguage: 'cs',
        sections: analysis.sections,
        analysisSummary: analysis.summary,
        settings: sanitizeSettings(settings),
      }
      const response = await fetch(apiUrl('/api/jobs'), {
        method: 'POST',
        body: buildEpubRequestPayload(requestPayload, originalBookData, analysis.fileName),
      })
      const payload = await parseJsonSafely(response)
      if (!response.ok) throw new Error(payload?.detail || payload?.error || 'Export failed')
      setJob(payload)
      setJobs((current) => [payload, ...current.filter((item) => item.id !== payload.id)].slice(0, 12))
    } catch (jobError) {
      setError(jobError.message)
      setStatusText('Nepodařilo se spustit překlad.')
    }
  }

  async function resumeTranslation(targetJob) {
    if (!targetJob?.id) return
    setError('')
    setStatusText('Obnovuji překlad z posledního checkpointu…')
    try {
      const requestPayload = {
        settings: sanitizeSettings(settings),
      }
      const response = await fetch(apiUrl(`/api/jobs/${targetJob.id}/resume`), {
        method: 'POST',
        body: buildEpubRequestPayload(
          requestPayload,
          originalBookData,
          analysis?.fileName || targetJob.fileName || 'book.epub'
        ),
      })
      const payload = await parseJsonSafely(response)
      if (!response.ok) throw new Error(payload?.detail || payload?.error || 'Resume failed')
      setJob(payload)
      setJobs((current) => [payload, ...current.filter((item) => item.id !== payload.id)].slice(0, 12))
      setStatusText('Překlad navázal na poslední uloženou sekci.')
    } catch (resumeError) {
      setError(resumeError.message || 'Obnovení selhalo.')
      setStatusText('Obnovení se nepodařilo.')
    }
  }

  function downloadTranslatedBook() {
    if (!translatedBlob) return
    const url = URL.createObjectURL(translatedBlob)
    const link = document.createElement('a')
    link.href = url
    link.download = exportMeta?.fileName || 'translated.clean.epub'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const rightMode = !originalBookData ? 'empty'
    : isPreviewLoading ? 'preview-progress'
    : job && job.status !== 'completed' && job.status !== 'failed' ? 'progress'
    : translatedBookData ? 'translated'
    : preview ? 'preview-result'
    : 'original'

  const previewElapsedSeconds = isPreviewLoading && previewStartedAt
    ? Math.max(1, Math.round((previewTick - previewStartedAt) / 1000)) : 0

  useEffect(() => { console.log('[App] rightMode =', rightMode) }, [rightMode])

  /* ── ACTIVE MODE LABELS ── */
  const modeActive = {
    upload: !analysis,
    analyze: !!analysis && rightMode === 'original',
    preview: rightMode === 'preview-progress' || rightMode === 'preview-result',
    export: rightMode === 'progress' || rightMode === 'translated',
  }

  return (
    <UiErrorBoundary>
      <div className="wb-outer">
      <div className="wb-shell">

        {/* ─── TOPBAR ─────────────────────────────────── */}
        <header className="wb-topbar">
          <div className="wb-topbar-left">
            <a className="wb-brand" href="/">
              <div className="wb-brand-mark">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="white"><rect x="1" y="1" width="4" height="4"/><rect x="7" y="1" width="4" height="4"/><rect x="1" y="7" width="4" height="4"/><rect x="7" y="7" width="4" height="4"/></svg>
              </div>
              <span className="wb-brand-name">EPUB TRANSLATOR</span>
            </a>
            <div className="wb-brand-sep" />
          </div>
          <nav className="wb-topbar-modes">
            <span className={`wb-mode-pip ${modeActive.upload ? 'is-active' : ''}`}>
              {modeActive.upload && <span className="wb-mode-pip-dot" />}
              upload
            </span>
            <span className={`wb-mode-pip ${modeActive.analyze ? 'is-active' : ''}`}>
              {modeActive.analyze && <span className="wb-mode-pip-dot" />}
              analýza
            </span>
            <span className={`wb-mode-pip ${modeActive.preview ? 'is-active' : ''}`}>
              {modeActive.preview && <span className="wb-mode-pip-dot" />}
              preview
            </span>
            <span className={`wb-mode-pip ${modeActive.export ? 'is-active' : ''}`}>
              {modeActive.export && <span className="wb-mode-pip-dot" />}
              export
            </span>
          </nav>
          <div className="wb-topbar-right">
            <span className="wb-topbar-runtime">{selectedProvider} · {rightMode}</span>
            {error && <span className="wb-error-badge" title={error}>{error}</span>}
            <button className="wb-icon-btn" onClick={() => setIsSettingsOpen(true)} title="Nastavení">
              <IconGear />
            </button>
          </div>
        </header>

        {/* ─── WORKSPACE ──────────────────────────────── */}
        <div className="wb-workspace">

          {/* ── LEFT SIDEBAR ── */}
          <aside className="wb-sidebar-l">

            {/* Upload zone */}
            <div className="wb-upload-wrap">
              <label className="wb-upload-zone">
                <IconUpload />
                <span className="wb-upload-label">
                  {analysis ? analysis.fileName : 'Vybrat EPUB'}
                </span>
                <span className="wb-upload-hint">.epub</span>
                <input type="file" accept=".epub,application/epub+zip" onChange={handleFileUpload} />
              </label>
            </div>

            {/* Book meta */}
            {analysis && (
              <div className="wb-book-meta">
                <div className="wb-book-cover-row">
                  <div className="wb-book-cover">
                    {analysis.cover?.dataUrl
                      ? <img src={analysis.cover.dataUrl} alt={analysis.metadata.title || ''} />
                      : <div className="wb-book-cover-fallback">EPUB</div>}
                  </div>
                  <div className="wb-book-info">
                    <span className="wb-book-title">{analysis.metadata.title || analysis.fileName}</span>
                    <span className="wb-book-author">{analysis.metadata.creator || 'Autor neuveden'}</span>
                  </div>
                </div>
                <div className="wb-book-tags">
                  <span className="wb-tag">{analysis.metadata.language || 'en'} → cs</span>
                  <span className="wb-tag">{formatNumber(analysis.summary.translatedWords)} slov</span>
                  <span className="wb-tag">{formatPages(analysis.summary.estimatedPages)} str.</span>
                </div>
              </div>
            )}

            {/* Provider section head */}
            <div className="wb-pane-head">
              <span className="wb-pane-label">Provider</span>
              <button className="wb-pane-btn" onClick={() => refreshDiagnostics()} title="Obnovit diagnostiku" style={{ display: 'flex', alignItems: 'center' }}>
                {diagnosticsLoading ? '…' : <IconRefresh />}
              </button>
            </div>

            {/* Provider rows */}
            <div className="wb-provider-list">
              {providers.map((provider) => {
                const d = diagnostics[provider.id]
                const statusKey = d?.status || 'idle'
                const statusLabel = statusKey === 'ready' ? 'ready' : d?.label || '—'
                const cost = providerCosts[provider.id] || 0
                return (
                  <button
                    key={provider.id}
                    className={`wb-provider-row ${selectedProvider === provider.id ? 'is-active' : ''}`}
                    onClick={() => { setSelectedProvider(provider.id); setPreview(null) }}
                  >
                    <div className="wb-provider-row-top">
                      <span className="wb-provider-icon">{providerMoniker(provider.id)}</span>
                      <span className="wb-provider-name">{provider.label}</span>
                      <span className="wb-provider-ver">{providerVersion(provider.id)}</span>
                      <span className={`wb-status-dot wb-status-dot--${statusKey}`} />
                    </div>
                    <div className="wb-provider-sub">
                      <span className="wb-provider-tier">{provider.tier}</span>
                      <span className="wb-provider-cost">{formatCurrency(cost)}</span>
                    </div>
                    <div className={`wb-provider-status-text ${statusKey === 'ready' ? 'is-ready' : statusKey === 'unavailable' ? 'is-error' : ''}`}>
                      {statusLabel}
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>

          {/* ── CENTER ── */}
          <div className="wb-center">

            {/* Metrics bar */}
            <div className="wb-metrics-bar">
              <div className="wb-metric">
                <span className="wb-metric-val">{formatNumber(analysis?.summary?.translatedWords || 0)}</span>
                <span className="wb-metric-lbl">words</span>
              </div>
              <div className="wb-metric">
                <span className="wb-metric-val">{formatNumber(analysis?.summary?.translatedCharacters || 0)}</span>
                <span className="wb-metric-lbl">chars</span>
              </div>
              <div className="wb-metric">
                <span className="wb-metric-val">{formatPages(analysis?.summary?.estimatedPages || 0)}</span>
                <span className="wb-metric-lbl">pages</span>
              </div>
              <div className="wb-metric">
                <span className="wb-metric-val">{analysis?.metadata?.language || 'en'}</span>
                <span className="wb-metric-lbl">source</span>
              </div>
              <div className="wb-metrics-status" title={statusText}>{statusText}</div>
              <div className="wb-metric">
                <span className="wb-metric-val" style={{ color: 'var(--accent)' }}>{formatCurrency(providerCosts[selectedProvider] || 0)}</span>
                <span className="wb-metric-lbl">est.cost</span>
              </div>
            </div>

            {/* Viewer */}
            <div className="wb-viewer">

              {rightMode === 'empty' && (
                <div className="wb-empty">
                  <span className="wb-empty-title">NO EPUB BUFFER</span>
                  <span className="wb-empty-sub">awaiting input file</span>
                </div>
              )}

              {rightMode === 'original' && (
                <ReaderPane
                  bookData={originalBookData}
                  title={`${analysis?.metadata?.title || 'Originál'} · listovatelný náhled`}
                  emptyLabel="Prázdný prohlížeč"
                  initialLocation={originalReaderInitialLocation}
                  jumpTargets={originalReaderTargets}
                />
              )}

              {rightMode === 'translated' && (
                <ReaderPane
                  bookData={translatedBookData}
                  title={`${analysis?.metadata?.title || 'Výsledek'} · přeložený náhled`}
                  emptyLabel="Přeložený náhled se objeví po dokončení"
                />
              )}

              {rightMode === 'preview-result' && (
                <div className="wb-preview-result">
                  <div className="wb-preview-result-bar">
                    <strong>{providers.find((p) => p.id === selectedProvider)?.label || selectedProvider} · ukázka překladu</strong>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{formatNumber(preview?.wordCount)} slov · {formatPages(preview?.pageCount)} str.</span>
                      <button className="ghost-button" onClick={() => setPreview(null)}>← Originál</button>
                    </div>
                  </div>
                  {preview?.sections?.length ? (
                    <div className="wb-preview-chips">
                      {preview.sections.map((section, idx) => (
                        <span key={section.id || idx} className="wb-preview-chip">{section.title}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="wb-preview-body-wrap">
                    <div
                      className="wb-preview-body"
                      dangerouslySetInnerHTML={{ __html: sanitizePreviewHtml(preview?.translatedHtml || '') }}
                    />
                  </div>
                </div>
              )}

              {rightMode === 'preview-progress' && (
                <div className="wb-preview-progress">
                  <div className="wb-progress-head">
                    <div>
                      <div className="wb-progress-label">Testovací překlad</div>
                      <div className="wb-progress-title">{providers.find((p) => p.id === selectedProvider)?.label || selectedProvider}</div>
                    </div>
                    <div className="wb-progress-pct">{previewElapsedSeconds}s</div>
                  </div>
                  <div className="wb-progress-track">
                    <div className="wb-progress-fill wb-progress-fill--indeterminate" style={{ width: '55%' }} />
                  </div>
                  <div className="wb-progress-grid">
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val is-accent">2 strany</span>
                      <span className="wb-progress-cell-lbl">náhodný vzorek</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{previewElapsedSeconds}s</span>
                      <span className="wb-progress-cell-lbl">čekání</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{includedSections.length}</span>
                      <span className="wb-progress-cell-lbl">sekcí v rozsahu</span>
                    </div>
                  </div>
                </div>
              )}

              {rightMode === 'progress' && (
                <div className="wb-progress">
                  <div className="wb-progress-head">
                    <div>
                      <div className="wb-progress-label">Probíhá překlad</div>
                      <div className="wb-progress-title">{analysis?.metadata?.title || 'Kniha'}</div>
                    </div>
                    <div className="wb-progress-pct">{Number(job?.progress?.percent || 0).toFixed(1)}%</div>
                  </div>
                  <div className="wb-progress-track">
                    <div
                      className={`wb-progress-fill ${job?.status === 'failed' ? 'is-failed' : ''}`}
                      style={{ width: `${Math.min(100, Number(job?.progress?.percent || 0))}%` }}
                    />
                  </div>
                  <div className="wb-progress-grid">
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val is-accent">{job?.progress?.stage || '—'}</span>
                      <span className="wb-progress-cell-lbl">fáze</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{formatNumber(job?.progress?.processedWords)}</span>
                      <span className="wb-progress-cell-lbl">přeložených slov</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{formatNumber(job?.progress?.totalWords)}</span>
                      <span className="wb-progress-cell-lbl">celkem slov</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{formatPages(job?.progress?.processedPages)}</span>
                      <span className="wb-progress-cell-lbl">přeložených stran</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{formatPages(job?.progress?.totalPages)}</span>
                      <span className="wb-progress-cell-lbl">celkem stran</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{job?.progress?.processedBlocks || 0}/{job?.progress?.totalBlocks || 0}</span>
                      <span className="wb-progress-cell-lbl">bloků</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{job?.progress?.cacheHits || 0}</span>
                      <span className="wb-progress-cell-lbl">cache hits</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{formatNumber(progressWordsPerMinute)}</span>
                      <span className="wb-progress-cell-lbl">slov/min</span>
                    </div>
                    <div className="wb-progress-cell">
                      <span className="wb-progress-cell-val">{progressRuntimeMinutes.toFixed(1)}m</span>
                      <span className="wb-progress-cell-lbl">běží</span>
                    </div>
                  </div>
                  <div className="wb-progress-current">
                    {job?.progress?.currentSectionTitle
                      ? `→ ${job.progress.currentSectionTitle}`
                      : 'Čekám na blok…'}
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* ── RIGHT SIDEBAR ── */}
          <aside className="wb-sidebar-r">

            <div className="wb-pane-head">
              <span className="wb-pane-label">Akce</span>
            </div>

            <div className="wb-actions">
              <button
                className="wb-btn"
                disabled={!includedSections.length || isPreviewLoading}
                onClick={runPreviewTranslation}
              >
                {isPreviewLoading ? 'Překládám ukázku…' : 'Preview 2 strany'}
              </button>
              <button
                className="wb-btn wb-btn--accent"
                disabled={!includedSections.length}
                onClick={startTranslation}
              >
                Spustit překlad
              </button>
              <button
                className="wb-btn"
                disabled={!translatedBlob}
                onClick={downloadTranslatedBook}
              >
                Stáhnout EPUB
              </button>
            </div>

            {backendHealth?.durableStorage && backendHealth.durableStorage !== 'vercel-blob' ? (
              <div className="wb-storage-warning wb-storage-warning--standalone">
                Durable storage není aktivní. Produkce potřebuje BLOB_READ_WRITE_TOKEN.
              </div>
            ) : null}

            {jobs.length ? (
              <div className="wb-job-history">
                <div className="wb-job-history-head">
                  <span>Obnovitelné překlady</span>
                  <button type="button" onClick={() => loadJobs().catch(() => {})}>refresh</button>
                </div>
                <div className="wb-job-history-list">
                  {jobs.slice(0, 5).map((item) => {
                    const isCurrent = item.id === job?.id
                    const canResume = item.status !== 'completed' && !(item.status === 'processing' && isCurrent)
                    const checkpointCount = item.checkpoint?.completedSections || 0
                    return (
                      <div key={item.id} className={`wb-job-row ${isCurrent ? 'is-current' : ''}`}>
                        <div className="wb-job-row-main">
                          <span className="wb-job-file" title={item.fileName}>{item.fileName || 'EPUB'}</span>
                          <span className="wb-job-meta">
                            {providerVersion(item.provider)} · {formatDateTime(item.updatedAt || item.createdAt)} · {Math.round(item.progress?.percent || 0)}%
                          </span>
                          <span className="wb-job-meta">
                            {item.status}
                            {checkpointCount ? ` · checkpoint ${checkpointCount} sekcí` : ''}
                          </span>
                        </div>
                        {canResume ? (
                          <button
                            type="button"
                            className="wb-job-resume"
                            onClick={() => resumeTranslation(item)}
                          >
                            Obnovit
                          </button>
                        ) : (
                          <span className="wb-job-state">{item.status === 'completed' ? 'Hotovo' : 'Běží'}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {/* Filters */}
            <div className="wb-pane-head">
              <span className="wb-pane-label">Rozsah překladu</span>
            </div>
            <div className="wb-filters">
              {[
                { key: 'includeMain', label: 'Hlavní kapitoly', hint: 'prolog, kapitoly, epilog' },
                { key: 'includeFront', label: 'Úvodní části', hint: 'věnování, předmluva, titulní list' },
                { key: 'includeBack', label: 'Zadní části', hint: 'rejstřík, prameny, bibliografie' },
                { key: 'includeUnknown', label: 'Nejasné sekce', hint: 'bez jisté klasifikace' },
              ].map(({ key, label, hint }) => (
                <label key={key} className="wb-filter-row">
                  <input
                    type="checkbox"
                    checked={filters[key]}
                    onChange={(e) => setFilters((cur) => ({ ...cur, [key]: e.target.checked }))}
                  />
                  <div className="wb-filter-text">
                    <span className="wb-filter-label">{label}</span>
                    <span className="wb-filter-hint">{hint}</span>
                  </div>
                </label>
              ))}
            </div>

            {/* Stats */}
            <div className="wb-stats-block">
              <div className="wb-stat-row">
                <span className="wb-stat-row-label">Slov k překladu</span>
                <span className="wb-stat-row-val">{formatNumber(analysis?.summary?.translatedWords || 0)}</span>
              </div>
              <div className="wb-stat-row">
                <span className="wb-stat-row-label">Znaků vč. mezer</span>
                <span className="wb-stat-row-val">{formatNumber(analysis?.summary?.translatedCharacters || 0)}</span>
              </div>
              <div className="wb-stat-row">
                <span className="wb-stat-row-label">Sekcí / přeskočeno</span>
                <span className="wb-stat-row-val">{analysis?.summary?.translatedSections || 0} / {analysis?.summary?.skippedSections || 0}</span>
              </div>
              {(() => {
                const activeProvider = providers.find((p) => p.id === selectedProvider)
                const rate = activeProvider?.ratePerMillionCharsEur ?? settings.pricing?.[selectedProvider] ?? 0
                const chars = analysis?.summary?.translatedCharacters || 0
                const cost = providerCosts[selectedProvider] || 0
                return (
                  <>
                    <div className="wb-stat-row">
                      <span className="wb-stat-row-label">Sazba ({activeProvider?.label || '—'})</span>
                      <span className="wb-stat-row-val">{rate} €/M znaků</span>
                    </div>
                    <div className="wb-stat-row">
                      <span className="wb-stat-row-label">Výpočet</span>
                      <span className="wb-stat-row-val" style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>
                        {formatNumber(chars)} ÷ 1M × {rate}
                      </span>
                    </div>
                    <div className="wb-stat-row" style={{ marginTop: 2, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
                      <span className="wb-stat-row-label" style={{ fontWeight: 500, color: 'var(--text-2)' }}>Odhad ceny API</span>
                      <span className="wb-stat-row-val is-accent" style={{ fontSize: 13 }}>{formatCurrency(cost)}</span>
                    </div>
                  </>
                )
              })()}
            </div>

            {/* Ballast */}
            {analysis?.summary?.ballastBreakdown?.length ? (
              <>
                <div className="wb-pane-head">
                  <span className="wb-pane-label">Identifikovaný balast</span>
                </div>
                <div className="wb-ballast">
                  {analysis.summary.ballastBreakdown.map((item) => (
                    <div key={item.label} className="wb-ballast-row">
                      <span className="wb-ballast-name">{item.label}</span>
                      <span className="wb-ballast-val">{item.sectionCount}× · {formatNumber(item.wordCount)} sl.</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {/* Export meta */}
            {exportMeta ? (
              <div className="wb-export-meta">
                <span className="wb-export-meta-title">Export připraven</span>
                <span className="wb-export-meta-detail">cache hits {formatNumber(exportMeta.cacheHits)} · misses {formatNumber(exportMeta.cacheMisses)}</span>
              </div>
            ) : null}

            {/* Error inline */}
            {error ? <div className="wb-error-inline">{error}</div> : null}

            {/* Section list */}
            <div className="wb-pane-head">
              <span className="wb-pane-label">
                Sekce
                <span className="wb-pane-label-count">
                  {analysis?.sections?.length ? `${includedSections.length}/${analysis.sections.length}` : '0'}
                </span>
              </span>
            </div>
            <div className="wb-section-list">
              {analysis?.sections?.map((section) => (
                <label
                  key={section.id}
                  className={`wb-section-row ${section.includeInTranslation ? 'is-active' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={section.includeInTranslation}
                    onChange={() => toggleSection(section.id)}
                  />
                  <span className="wb-section-name" title={section.title}>{section.title}</span>
                  <span className="wb-section-words">{formatNumber(section.stats?.wordCount || 0)}</span>
                </label>
              ))}
            </div>

          </aside>
        </div>

        {/* ─── SETTINGS MODAL ──────────────────────────── */}
        <SettingsModal
          open={isSettingsOpen}
          settings={settings}
          savedAt={settingsSavedAt}
          diagnostics={diagnostics}
          diagnosticsLoading={diagnosticsLoading}
          saveError={settingsSaveError}
          onClose={() => setIsSettingsOpen(false)}
          onChange={updateSettings}
          onReset={() => { setSettings(DEFAULT_SETTINGS); setSettingsSaveError('') }}
          onSave={() => saveSettings(false)}
          onTest={() => refreshDiagnostics(settings)}
        />
      </div>
      </div>
    </UiErrorBoundary>
  )
}
