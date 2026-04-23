import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeEpubBuffer,
  buildExportPlan,
  buildProviderMatrix,
  exportEpubToHtml,
  exportTranslatedEpub,
  importTranslatedHtmlToEpub,
  JOBS_DIR,
  normalizeImportedHtmlArtifacts,
  OUTPUTS_DIR,
  reviewTranslatedHtml,
  translatePreviewFromEpub,
  translateSelectedSections,
  UPLOADS_DIR,
} from './translator-workbench.js'

dotenv.config({ path: '.env.local' })
dotenv.config()

const app = express()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const frontendDistCandidates = [
  join(__dirname, '../../frontend/dist'),
  join(__dirname, '../frontend/dist'),
  join(__dirname, '../dist'),
  join(process.cwd(), 'frontend/dist'),
  join(process.cwd(), 'dist'),
]
const frontendDistDir = frontendDistCandidates.find((candidate) => existsSync(join(candidate, 'index.html'))) || frontendDistCandidates[0]
const frontendIndexPath = join(frontendDistDir, 'index.html')
const frontendDistCandidateIndex = frontendDistCandidates.indexOf(frontendDistDir)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 } })
const activeJobs = new Map()
const jobSecrets = new Map()
const JOB_TTL_MS = 1000 * 60 * 60 * 24

function nowIso() {
  return new Date().toISOString()
}

function secondsBetween(startedAt, finishedAt = nowIso()) {
  const start = Date.parse(startedAt || '')
  const end = Date.parse(finishedAt || '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0
  }
  return Number(((end - start) / 1000).toFixed(2))
}

function buildTelemetrySkeleton(kind = 'translation') {
  return {
    kind,
    wallTimeSeconds: 0,
    totalWords: 0,
    totalCharacters: 0,
    processedWords: 0,
    processedCharacters: 0,
    cacheHits: 0,
    cacheMisses: 0,
    findingsCount: 0,
    autoAppliedCount: 0,
    scannedCharacters: 0,
    flaggedCharacters: 0,
    providerCostEur: null,
    reviewCostEur: null,
    translationCostEur: null,
  }
}

function sessionFilePath(sessionId) {
  return join(UPLOADS_DIR, `${sessionId}.epub`)
}

function sessionArtifactPath(sessionId, artifact) {
  return join(UPLOADS_DIR, `${sessionId}.${artifact}.html`)
}

function jobFilePath(jobId) {
  return join(JOBS_DIR, `${jobId}.json`)
}

function checkpointFilePath(jobId) {
  return join(JOBS_DIR, `${jobId}.checkpoint.json`)
}

function outputFilePath(jobId, fileName) {
  return join(OUTPUTS_DIR, `${jobId}__${fileName}`)
}

function asciiHeaderFileName(fileName = 'download.bin') {
  const sanitized = String(fileName || 'download.bin')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '')
    .replace(/[<>:/|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || 'download.bin'
}

function setAttachmentHeaders(res, fileName, contentType) {
  const asciiName = asciiHeaderFileName(fileName)
  const utf8Name = encodeURIComponent(String(fileName || asciiName))
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`)
}

function hasZipSignature(buffer) {
  return Boolean(buffer?.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b)
}

function looksLikeEpubUpload(file) {
  const fileName = String(file?.originalname || '').toLowerCase()
  const mimeType = String(file?.mimetype || '').toLowerCase()
  const allowedMimeTypes = new Set([
    'application/epub+zip',
    'application/zip',
    'application/octet-stream',
  ])

  return fileName.endsWith('.epub') && hasZipSignature(file?.buffer) && allowedMimeTypes.has(mimeType || 'application/octet-stream')
}

function parseBodyPayload(req) {
  const payload = req.body?.payload
  if (typeof payload !== 'string') {
    return req.body || {}
  }

  try {
    return JSON.parse(payload)
  } catch {
    return {}
  }
}

async function resolveSourceBuffer(payload, file) {
  if (file?.buffer?.length) {
    if (!looksLikeEpubUpload(file)) {
      const error = new Error('Neplatný EPUB soubor.')
      error.statusCode = 400
      error.detail = 'Nahraj soubor .epub se ZIP strukturou.'
      throw error
    }
    return file.buffer
  }

  const sessionId = payload?.sessionId
  const sourcePath = sessionId ? sessionFilePath(sessionId) : ''
  if (sessionId && existsSync(sourcePath)) {
    return readFileSync(sourcePath)
  }

  const error = new Error('Upload session nebyla nalezena nebo už expirovala.')
  error.statusCode = 404
  throw error
}

async function readJob(jobId) {
  const path = jobFilePath(jobId)
  if (!existsSync(path)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

async function writeJob(job) {
  writeFileSync(jobFilePath(job.id), JSON.stringify(job, null, 2), 'utf-8')
}

async function readCheckpoint(jobId) {
  const path = checkpointFilePath(jobId)
  if (!existsSync(path)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

async function writeCheckpoint(jobId, checkpoint) {
  writeFileSync(checkpointFilePath(jobId), JSON.stringify(checkpoint, null, 2), 'utf-8')
}

async function deleteCheckpoint(jobId) {
  const path = checkpointFilePath(jobId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

async function listJobs() {
  const byId = new Map()

  for (const name of readdirSync(JOBS_DIR)) {
    if (!name.endsWith('.json') || name.endsWith('.checkpoint.json')) {
      continue
    }
    const job = await readJob(name.replace(/\.json$/, ''))
    if (job?.id) {
      byId.set(job.id, job)
    }
  }

  return [...byId.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

async function findConflictingActiveJob({ sessionId = '', fileName = '', excludeJobId = '' } = {}) {
  const jobs = await listJobs()
  return jobs.find((job) => {
    if (!job?.id || job.id === excludeJobId) {
      return false
    }
    if (!['queued', 'processing'].includes(job.status)) {
      return false
    }
    return (
      (sessionId && job.sessionId === sessionId) ||
      (fileName && job.fileName === fileName)
    )
  }) || null
}

async function publicJob(job) {
  if (!job) {
    return null
  }

  const checkpoint = await readCheckpoint(job.id)

  return {
    id: job.id,
    kind: job.kind || 'translation',
    sessionId: job.sessionId,
    fileName: job.fileName,
    status: job.status,
    provider: job.provider,
    sourceLanguage: job.sourceLanguage,
    targetLanguage: job.targetLanguage,
    progress: job.progress,
    summary: job.summary,
    plan: job.plan,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error || '',
    outputFileName: job.outputFileName || '',
    audit: job.audit || null,
    telemetry: job.telemetry || buildTelemetrySkeleton(job.kind || 'translation'),
    checkpoint: checkpoint
      ? {
          completedSections: Object.keys(checkpoint.sections || {}).length,
          updatedAt: checkpoint.updatedAt || '',
        }
      : null,
  }
}

async function writeSessionSource(sessionId, buffer) {
  writeFileSync(sessionFilePath(sessionId), buffer)
}

async function sourceExists(sessionId) {
  return existsSync(sessionFilePath(sessionId))
}

async function readSessionSource(sessionId) {
  const sourcePath = sessionFilePath(sessionId)
  return existsSync(sourcePath) ? readFileSync(sourcePath) : null
}

async function writeSessionArtifact(sessionId, artifact, html) {
  writeFileSync(sessionArtifactPath(sessionId, artifact), String(html || ''), 'utf-8')
}

async function readSessionArtifact(sessionId, artifact) {
  const target = sessionArtifactPath(sessionId, artifact)
  return existsSync(target) ? readFileSync(target, 'utf-8') : ''
}

async function deleteSessionSource(sessionId) {
  const sourcePath = sessionFilePath(sessionId)
  if (existsSync(sourcePath)) {
    unlinkSync(sourcePath)
  }
}

async function writeOutput(jobId, fileName, buffer) {
  const localPath = outputFilePath(jobId, fileName)
  writeFileSync(localPath, buffer)
  return { localPath }
}

async function readOutput(job) {
  if (job?.outputPath && existsSync(job.outputPath)) {
    return readFileSync(job.outputPath)
  }
  return null
}

function splitJobSettings(settings = {}) {
  const publicSettings = JSON.parse(JSON.stringify(settings || {}))
  const trim = (value) => (typeof value === 'string' ? value.trim() : '')
  const secretSettings = {
    openrouter: { apiKey: trim(settings?.openrouter?.apiKey) },
    deepl: { apiKey: trim(settings?.deepl?.apiKey) },
    openai: { apiKey: trim(settings?.openai?.apiKey) },
    google: { accessToken: trim(settings?.google?.accessToken) },
    claude: { apiKey: trim(settings?.claude?.apiKey) },
    glm: { apiKey: trim(settings?.glm?.apiKey) },
  }

  if (publicSettings.openrouter) {
    delete publicSettings.openrouter.apiKey
  }
  if (publicSettings.deepl) {
    delete publicSettings.deepl.apiKey
  }
  if (publicSettings.openai) {
    delete publicSettings.openai.apiKey
  }
  if (publicSettings.google) {
    delete publicSettings.google.accessToken
  }
  if (publicSettings.claude) {
    delete publicSettings.claude.apiKey
  }
  if (publicSettings.glm) {
    delete publicSettings.glm.apiKey
  }

  return { publicSettings, secretSettings }
}

function mergeRuntimeSettings(job) {
  const runtimeSecrets = {
    ...(job.secretSettings || {}),
    ...(jobSecrets.get(job.id) || {}),
  }
  return {
    ...(job.settings || {}),
    openrouter: { ...(job.settings?.openrouter || {}), ...(runtimeSecrets.openrouter || {}) },
    deepl: { ...(job.settings?.deepl || {}), ...(runtimeSecrets.deepl || {}) },
    openai: { ...(job.settings?.openai || {}), ...(runtimeSecrets.openai || {}) },
    google: { ...(job.settings?.google || {}), ...(runtimeSecrets.google || {}) },
    claude: { ...(job.settings?.claude || {}), ...(runtimeSecrets.claude || {}) },
    glm: { ...(job.settings?.glm || {}), ...(runtimeSecrets.glm || {}) },
  }
}

function buildSettingsBootstrap() {
  const deeplApiKey = process.env.DEEPL_API_KEY || ''
  return {
    app: {
      backendUrl: '',
    },
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      useForAll: String(process.env.OPENROUTER_USE_FOR_ALL || 'true') !== 'false',
      openaiModel: process.env.OPENROUTER_OPENAI_MODEL || 'openai/gpt-5.4',
      claudeModel: process.env.OPENROUTER_CLAUDE_MODEL || 'anthropic/claude-sonnet-4.6',
      googleModel: process.env.OPENROUTER_GOOGLE_MODEL || 'google/gemini-2.5-pro',
      glmModel: process.env.OPENROUTER_GLM_MODEL || 'z-ai/glm-5',
    },
    deepl: {
      apiKey: deeplApiKey,
      baseUrl: process.env.DEEPL_BASE_URL || (deeplApiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : ''),
      formality: process.env.DEEPL_FORMALITY || 'prefer_more',
      modelType: process.env.DEEPL_MODEL_TYPE || 'prefer_quality_optimized',
      splitSentences: process.env.DEEPL_SPLIT_SENTENCES || 'nonewlines',
      preserveFormatting: String(process.env.DEEPL_PRESERVE_FORMATTING || 'true') !== 'false',
      context:
        process.env.DEEPL_CONTEXT ||
        'Translate non-fiction book content and preserve terminology consistency, chronology, register, and named entities.',
      customInstructions:
        process.env.DEEPL_CUSTOM_INSTRUCTIONS ||
        'Prefer natural Czech phrasing for biographies and popular science. Keep facts exact, preserve named entities, and resolve gender or case from context whenever possible.',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_TRANSLATION_MODEL || 'gpt-5.4',
    },
    google: {
      accessToken: process.env.GOOGLE_CLOUD_ACCESS_TOKEN || '',
      project: process.env.GOOGLE_CLOUD_PROJECT || '',
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_TRANSLATION_MODEL || 'claude-sonnet-4-6',
    },
    glm: {
      apiKey: process.env.GLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || '',
      baseUrl: process.env.GLM_API_BASE_URL || process.env.OPENAI_COMPATIBLE_API_BASE_URL || '',
      model: process.env.GLM_TRANSLATION_MODEL || 'glm-5.1',
    },
  }
}

async function pingJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5000),
  })
  return response
}

async function diagnoseProviders(settings = {}) {
  const diagnostics = {}
  const openrouterKey = settings?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || ''
  const openrouterBaseUrl = settings?.openrouter?.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
  let openrouterModels = []

  if (openrouterKey) {
    try {
      const response = await pingJson(`${String(openrouterBaseUrl).replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${openrouterKey}` },
      })
      if (response.ok) {
        const payload = await response.json()
        openrouterModels = (payload?.data || []).map((item) => item.id)
      }
    } catch {
      openrouterModels = []
    }
  }

  function canonicalOpenRouterModelId(modelId) {
    const value = String(modelId || '').trim()
    if (!value) return ''
    const aliasMap = new Map([
      ['anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'],
      ['claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'],
      ['claude-sonnet-4.6', 'anthropic/claude-sonnet-4.6'],
    ])
    return aliasMap.get(value) || value
  }

  function openrouterModelReady(modelId) {
    const canonical = canonicalOpenRouterModelId(modelId)
    if (!canonical) return false
    if (openrouterModels.includes(canonical)) return true
    const legacyDashVariant = canonical.replace(/claude-sonnet-4\.6\b/, 'claude-sonnet-4-6')
    return legacyDashVariant !== canonical && openrouterModels.includes(legacyDashVariant)
  }

  const deeplApiKey = settings?.deepl?.apiKey || process.env.DEEPL_API_KEY || ''
  const deeplBaseUrl =
    settings?.deepl?.baseUrl ||
    process.env.DEEPL_BASE_URL ||
    (deeplApiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')
  if (!deeplApiKey) {
    diagnostics.deepl = { status: 'missing_key', label: 'Chybí klíč', detail: 'Zadej DEEPL API key.' }
  } else {
    try {
      const response = await pingJson(`${deeplBaseUrl}/v2/usage`, {
        headers: { Authorization: `DeepL-Auth-Key ${deeplApiKey}` },
      })
      diagnostics.deepl =
        response.ok
          ? { status: 'ready', label: 'Ready', detail: 'DeepL odpovídá.' }
          : { status: 'unavailable', label: 'Endpoint nedostupný', detail: `HTTP ${response.status}` }
    } catch (error) {
      diagnostics.deepl = { status: 'unavailable', label: 'Endpoint nedostupný', detail: error.message }
    }
  }

  if (settings?.openrouter?.useForAll && openrouterKey) {
    const model = settings?.openrouter?.openaiModel || 'openai/gpt-5.4'
    diagnostics.openai = openrouterModelReady(model)
      ? { status: 'ready', label: 'Ready', detail: `${model} online přes OpenRouter.` }
      : { status: 'unavailable', label: 'Model offline', detail: `${model} není dostupný v OpenRouteru.` }
  } else {
  const openaiKey = settings?.openai?.apiKey || process.env.OPENAI_API_KEY || ''
  if (!openaiKey) {
    diagnostics.openai = { status: 'missing_key', label: 'Chybí klíč', detail: 'Zadej OpenAI API key.' }
  } else {
    try {
      const response = await pingJson('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${openaiKey}` },
      })
      diagnostics.openai =
        response.ok
          ? { status: 'ready', label: 'Ready', detail: 'OpenAI API odpovídá.' }
          : { status: 'unavailable', label: 'Endpoint nedostupný', detail: `HTTP ${response.status}` }
    } catch (error) {
      diagnostics.openai = { status: 'unavailable', label: 'Endpoint nedostupný', detail: error.message }
    }
  }
  }

  if (settings?.openrouter?.useForAll && openrouterKey) {
    const model = settings?.openrouter?.googleModel || 'google/gemini-2.5-pro'
    diagnostics.google = openrouterModelReady(model)
      ? { status: 'ready', label: 'Ready', detail: `${model} online přes OpenRouter.` }
      : { status: 'unavailable', label: 'Model offline', detail: `${model} není dostupný v OpenRouteru.` }
  } else {
  const googleToken = settings?.google?.accessToken || process.env.GOOGLE_CLOUD_ACCESS_TOKEN || ''
  const googleProject = settings?.google?.project || process.env.GOOGLE_CLOUD_PROJECT || ''
  if (!googleToken || !googleProject) {
    diagnostics.google = {
      status: 'missing_key',
      label: 'Chybí klíč',
      detail: 'Zadej Google access token i project.',
    }
  } else {
    try {
      const response = await pingJson(
        `https://translation.googleapis.com/v3/projects/${googleProject}/locations/global/supportedLanguages`,
        {
          headers: { Authorization: `Bearer ${googleToken}` },
        }
      )
      diagnostics.google =
        response.ok
          ? { status: 'ready', label: 'Ready', detail: 'Google Translation API odpovídá.' }
          : { status: 'unavailable', label: 'Endpoint nedostupný', detail: `HTTP ${response.status}` }
    } catch (error) {
      diagnostics.google = { status: 'unavailable', label: 'Endpoint nedostupný', detail: error.message }
    }
  }
  }

  if (settings?.openrouter?.useForAll && openrouterKey) {
    const model = settings?.openrouter?.claudeModel || 'anthropic/claude-sonnet-4.6'
    const canonicalModel = canonicalOpenRouterModelId(model)
    diagnostics.claude = openrouterModelReady(model)
      ? { status: 'ready', label: 'Ready', detail: `${canonicalModel} online přes OpenRouter.` }
      : { status: 'unavailable', label: 'Model offline', detail: `${canonicalModel} není dostupný v OpenRouteru.` }
  } else {
  const claudeKey = settings?.claude?.apiKey || process.env.ANTHROPIC_API_KEY || ''
  if (!claudeKey) {
    diagnostics.claude = { status: 'missing_key', label: 'Chybí klíč', detail: 'Zadej Anthropic API key.' }
  } else {
    try {
      const response = await pingJson('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
      })
      diagnostics.claude =
        response.ok
          ? { status: 'ready', label: 'Ready', detail: 'Anthropic API odpovídá.' }
          : { status: 'unavailable', label: 'Endpoint nedostupný', detail: `HTTP ${response.status}` }
    } catch (error) {
      diagnostics.claude = { status: 'unavailable', label: 'Endpoint nedostupný', detail: error.message }
    }
  }
  }

  if (settings?.openrouter?.useForAll && openrouterKey) {
    const model = settings?.openrouter?.glmModel || 'z-ai/glm-5'
    diagnostics.glm = openrouterModelReady(model)
      ? { status: 'ready', label: 'Ready', detail: `${model} online přes OpenRouter.` }
      : { status: 'unavailable', label: 'Model offline', detail: `${model} není dostupný v OpenRouteru.` }
  } else {
  const glmBaseUrl =
    settings?.glm?.baseUrl ||
    process.env.GLM_API_BASE_URL ||
    process.env.OPENAI_COMPATIBLE_API_BASE_URL ||
    ''
  const glmKey =
    settings?.glm?.apiKey || process.env.GLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || ''
  if (!glmBaseUrl) {
    diagnostics.glm = { status: 'missing_key', label: 'Chybí URL', detail: 'Zadej GLM endpoint URL.' }
  } else {
    try {
      const headers = {}
      if (glmKey) {
        headers.Authorization = `Bearer ${glmKey}`
      }
      const response = await pingJson(`${String(glmBaseUrl).replace(/\/$/, '')}/models`, {
        headers,
      })
      diagnostics.glm =
        response.ok
          ? { status: 'ready', label: 'Ready', detail: 'GLM endpoint odpovídá.' }
          : { status: 'unavailable', label: 'Endpoint nedostupný', detail: `HTTP ${response.status}` }
    } catch (error) {
      diagnostics.glm = { status: 'unavailable', label: 'Endpoint nedostupný', detail: error.message }
    }
  }
  }

  return diagnostics
}

async function processJob(jobId, options = {}) {
  if (activeJobs.has(jobId)) {
    return activeJobs.get(jobId)
  }

  const run = (async () => {
    const job = await readJob(jobId)
    if (!job) {
      return
    }

    if (options.sourceBuffer?.length) {
      await writeSessionSource(job.sessionId, options.sourceBuffer)
    }

    const sourceBuffer = await readSessionSource(job.sessionId)
    if (!sourceBuffer?.length) {
      const failed = {
        ...job,
        status: 'failed',
        updatedAt: nowIso(),
        error: 'Zdrojový EPUB už není dostupný v upload storage.',
      }
      await writeJob(failed)
      return
    }

    const checkpoint = (await readCheckpoint(jobId)) || {
      jobId,
      updatedAt: '',
      sections: {},
    }
    const checkpointCount = Object.keys(checkpoint.sections || {}).length

    const started = {
      ...job,
      status: 'processing',
      startedAt: job.startedAt || nowIso(),
      updatedAt: nowIso(),
      error: '',
      telemetry: {
        ...buildTelemetrySkeleton('translation'),
        ...(job.telemetry || {}),
      },
      progress: {
        ...job.progress,
        stage: checkpointCount ? 'resuming-export' : 'preparing-export',
        currentSectionId: '',
        currentSectionTitle: '',
        percent:
          checkpointCount && job.plan?.translatedSections
            ? Number(((checkpointCount / job.plan.translatedSections) * 100).toFixed(2))
            : job.progress?.percent || 0,
      },
    }
    await writeJob(started)

    try {
      const result = await exportTranslatedEpub({
        buffer: sourceBuffer,
        fileName: job.fileName,
        provider: job.provider,
        sourceLanguage: job.sourceLanguage,
        targetLanguage: job.targetLanguage,
        sections: job.sections,
        settings: mergeRuntimeSettings(job),
        checkpoint,
        onProgress: async (progress) => {
          const current = await readJob(jobId)
          if (!current) {
            return
          }

          const next = {
            ...current,
            status: 'processing',
            updatedAt: nowIso(),
            progress: {
              ...current.progress,
              stage: progress.stage,
              processedBlocks: progress.processedBlocks,
              totalBlocks: progress.totalBlocks,
              processedWords: progress.processedWords,
              totalWords: progress.totalWords,
              processedPages: progress.processedPages,
              totalPages: progress.totalPages,
              cacheHits: progress.cacheHits,
              cacheMisses: progress.cacheMisses,
              currentSectionId: progress.currentSectionId || '',
              currentSectionTitle: progress.currentSectionTitle || '',
              percent:
                typeof progress.percent === 'number'
                  ? progress.percent
                  : progress.totalBlocks > 0
                  ? Number(((progress.processedBlocks / progress.totalBlocks) * 100).toFixed(2))
                  : 100,
            },
          }
          await writeJob(next)
        },
        onCheckpoint: async ({ updatedAt, sectionId, section }) => {
          const currentCheckpoint = (await readCheckpoint(jobId)) || { jobId, updatedAt: '', sections: {} }
          currentCheckpoint.updatedAt = updatedAt
          currentCheckpoint.sections = {
            ...(currentCheckpoint.sections || {}),
            [sectionId]: section,
          }
          await writeCheckpoint(jobId, currentCheckpoint)
        },
      })

      const output = await writeOutput(job.id, result.fileName, result.buffer)
      await deleteCheckpoint(jobId)

      const completed = {
        ...(await readJob(jobId)),
        status: 'completed',
        updatedAt: nowIso(),
        completedAt: nowIso(),
        outputPath: output.localPath,
        outputFileName: result.fileName,
        progress: {
          stage: 'completed',
          processedBlocks: result.stats.processedBlocks,
          totalBlocks: result.stats.totalBlocks,
          processedWords: result.stats.processedWords,
          totalWords: result.stats.totalWords,
          processedPages: result.stats.processedPages,
          totalPages: result.stats.totalPages,
          cacheHits: result.stats.cacheHits,
          cacheMisses: result.stats.cacheMisses,
          currentSectionId: '',
          currentSectionTitle: '',
          percent: 100,
        },
        summary: {
          ...job.summary,
          translatedSections: result.stats.translatedSections,
        },
        telemetry: {
          ...(job.telemetry || buildTelemetrySkeleton('translation')),
          kind: 'translation',
          wallTimeSeconds: secondsBetween(started.startedAt || started.createdAt, nowIso()),
          totalWords: result.stats.totalWords || 0,
          totalCharacters: result.stats.totalCharacters || 0,
          processedWords: result.stats.processedWords || 0,
          processedCharacters: result.stats.processedCharacters || 0,
          cacheHits: result.stats.cacheHits || 0,
          cacheMisses: result.stats.cacheMisses || 0,
          translationCostEur: null,
          providerCostEur: null,
        },
      }
      await writeJob(completed)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[processJob] job ${jobId} failed:`, errorMessage, error?.stack || '')
      try {
        const current = await readJob(jobId)
        const failed = {
          ...(current || { id: jobId }),
          status: 'failed',
          updatedAt: nowIso(),
          error: errorMessage,
          telemetry: {
            ...buildTelemetrySkeleton('translation'),
            ...(current?.telemetry || {}),
            wallTimeSeconds: secondsBetween(current?.startedAt || current?.createdAt, nowIso()),
          },
        }
        await writeJob(failed)
      } catch (writeError) {
        console.error(`[processJob] failed to write error state for job ${jobId}:`, writeError?.message)
      }
    } finally {
      activeJobs.delete(jobId)
      jobSecrets.delete(jobId)
    }
  })()

  activeJobs.set(jobId, run)
  return run
}

async function processReviewJob(jobId) {
  if (activeJobs.has(jobId)) {
    return activeJobs.get(jobId)
  }

  const run = (async () => {
    const job = await readJob(jobId)
    if (!job) return

    try {
      const mergedSettings = mergeRuntimeSettings(job)
      const describeKey = (value) => {
        const v = typeof value === 'string' ? value.trim() : ''
        return { len: v.length, prefix: v.slice(0, 7) }
      }
      console.error(`[processReviewJob] ${jobId} starting`, {
        provider: job.provider,
        openrouter: describeKey(mergedSettings?.openrouter?.apiKey),
        claude: describeKey(mergedSettings?.claude?.apiKey),
        openai: describeKey(mergedSettings?.openai?.apiKey),
        useForAll: Boolean(mergedSettings?.openrouter?.useForAll),
        envOpenRouter: Boolean((process.env.OPENROUTER_API_KEY || '').trim()),
      })

      const originalHtml = await readSessionArtifact(job.sessionId, 'original')
      const translatedHtml = await readSessionArtifact(job.sessionId, 'translated')
      if (!originalHtml.trim()) {
        throw new Error('Chybí původní HTML export. Nejprve vyexportuj HTML z EPUBu.')
      }
      if (!translatedHtml.trim()) {
        throw new Error('Chybí nahraný přeložený HTML soubor.')
      }

      const started = {
        ...job,
        status: 'processing',
        startedAt: job.startedAt || nowIso(),
        updatedAt: nowIso(),
        error: '',
        telemetry: {
          ...buildTelemetrySkeleton('review'),
          ...(job.telemetry || {}),
        },
        progress: {
          ...(job.progress || {}),
          stage: 'reviewing-html',
          processedSections: 0,
          totalSections: job.sections?.filter((section) => section.includeInTranslation).length || 0,
          changedSections: 0,
          findingsCount: 0,
          autoAppliedCount: 0,
          currentSectionId: '',
          currentSectionTitle: '',
          percent: 0,
        },
      }
      await writeJob(started)

      const result = await reviewTranslatedHtml({
        originalHtml,
        translatedHtml,
        provider: job.provider,
        settings: mergeRuntimeSettings(job),
        onProgress: async (progress) => {
          const current = await readJob(jobId)
          if (!current) return
          await writeJob({
            ...current,
            status: 'processing',
            updatedAt: nowIso(),
            progress: {
              ...current.progress,
              ...progress,
            },
          })
        },
      })

      await writeSessionArtifact(job.sessionId, `reviewed-${job.provider}`, result.html)
      await writeSessionArtifact(job.sessionId, 'reviewed-latest', result.html)

      await writeJob({
        ...(await readJob(jobId)),
        status: 'completed',
        updatedAt: nowIso(),
        completedAt: nowIso(),
        progress: {
          stage: 'completed',
          processedSections: result.stats.processedSections,
          totalSections: result.stats.totalSections,
          changedSections: result.stats.changedSections,
          findingsCount: result.stats.findingsCount || 0,
          autoAppliedCount: result.stats.autoAppliedCount || 0,
          currentSectionId: '',
          currentSectionTitle: '',
          percent: 100,
        },
        summary: {
          ...(job.summary || {}),
          changedSections: result.stats.changedSections,
          reviewedSections: result.stats.processedSections,
          findingsCount: result.stats.findingsCount || 0,
          autoAppliedCount: result.stats.autoAppliedCount || 0,
          title: result.stats.title,
          author: result.stats.author,
        },
        audit: result.audit || null,
        telemetry: {
          ...(job.telemetry || buildTelemetrySkeleton('review')),
          kind: 'review',
          wallTimeSeconds: secondsBetween(started.startedAt || started.createdAt, nowIso()),
          findingsCount: result.stats.findingsCount || 0,
          autoAppliedCount: result.stats.autoAppliedCount || 0,
          scannedCharacters: result.stats.scannedCharacters || 0,
          flaggedCharacters: result.stats.flaggedCharacters || 0,
          reviewCostEur: null,
          providerCostEur: null,
        },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[processReviewJob] job ${jobId} failed:`, errorMessage, error?.stack || '')
      await writeJob({
        ...(await readJob(jobId)),
        status: 'failed',
        updatedAt: nowIso(),
        error: errorMessage,
        telemetry: {
          ...buildTelemetrySkeleton('review'),
          ...((await readJob(jobId))?.telemetry || {}),
          wallTimeSeconds: secondsBetween(job?.startedAt || job?.createdAt, nowIso()),
        },
      })
    } finally {
      activeJobs.delete(jobId)
      jobSecrets.delete(jobId)
    }
  })()

  activeJobs.set(jobId, run)
  return run
}

async function recoverJobs() {
  for (const job of await listJobs()) {
    if (!job) {
      continue
    }

    const createdAt = new Date(job.createdAt || 0).getTime()
    if (createdAt && Date.now() - createdAt > JOB_TTL_MS && job.sessionId) {
      await deleteSessionSource(job.sessionId)
    }

    if (job.status === 'queued' || job.status === 'processing') {
      // After server restart we have no API keys in memory.
      // Mark the job as failed so the user can resume manually (which re-sends keys).
      const interrupted = {
        ...job,
        status: 'failed',
        updatedAt: nowIso(),
        error: 'Server byl restartován – klikni „Pokračovat" pro obnovení překladu.',
        progress: {
          ...(job.progress || {}),
          stage: 'interrupted',
        },
      }
      await writeJob(interrupted)
    }
  }
}

app.use(cors())
app.use(express.json({ limit: '10mb' }))
if (existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir))
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'ebook-translator-workbench',
    now: new Date().toISOString(),
    durableStorage: 'local-filesystem',
    storageMode: 'local-runtime',
    commit:
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.GIT_COMMIT ||
      process.env.SOURCE_COMMIT ||
      'unknown',
    hasOpenRouterEnv: Boolean((process.env.OPENROUTER_API_KEY || '').trim()),
    frontendDistFound: existsSync(frontendIndexPath),
    frontendDistCandidateIndex,
  })
})

app.get('/api/providers', (_req, res) => {
  res.json(buildProviderMatrix())
})

app.get('/api/settings/bootstrap', (_req, res) => {
  res.json(buildSettingsBootstrap())
})

app.post('/api/providers/diagnostics', async (req, res) => {
  try {
    const diagnostics = await diagnoseProviders(req.body?.settings || {})
    return res.json(diagnostics)
  } catch (error) {
    return res.status(500).json({
      error: 'Nepodařilo se ověřit providery.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Chybí EPUB soubor.' })
  }

  if (!looksLikeEpubUpload(req.file)) {
    return res.status(400).json({
      error: 'Neplatný EPUB soubor.',
      detail: 'Nahraj soubor .epub se ZIP strukturou.',
    })
  }

  try {
    const analysis = await analyzeEpubBuffer(req.file.buffer, {
      fileName: req.file.originalname,
      languageHint: req.body.languageHint || '',
    })

    const sessionId = randomUUID()
    await writeSessionSource(sessionId, req.file.buffer)

    return res.json({ ...analysis, sessionId })
  } catch (error) {
    return res.status(500).json({
      error: 'Nepodařilo se analyzovat EPUB.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/translate-preview', upload.single('file'), async (req, res) => {
  try {
    const payload = parseBodyPayload(req)
    const result =
      req.file || payload?.sessionId
        ? await translatePreviewFromEpub({
            buffer: await resolveSourceBuffer(payload, req.file),
            ...payload,
          })
        : await translateSelectedSections(payload)
    return res.json(result)
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'Nepodařilo se připravit překladový preview výstup.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

app.post('/api/export-html', upload.single('file'), async (req, res) => {
  try {
    const payload = parseBodyPayload(req)
    const result = await exportEpubToHtml({
      buffer: await resolveSourceBuffer(payload, req.file),
      fileName: payload?.fileName || req.file?.originalname || 'book.epub',
      sourceLanguage: payload?.sourceLanguage || '',
      targetLanguage: payload?.targetLanguage || 'cs',
      sections: payload?.sections || [],
    })
    if (payload?.sessionId) {
      await writeSessionArtifact(payload.sessionId, 'original', result.html)
    }
    setAttachmentHeaders(res, result.fileName, 'text/html; charset=utf-8')
    return res.send(result.html)
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'Nepodařilo se vyexportovat HTML.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

app.post('/api/import-html', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Chybí přeložený HTML soubor.' })
    }
    const payload = parseBodyPayload(req)
    if (!payload?.sessionId) {
      return res.status(400).json({ error: 'Chybí sessionId pro HTML import.' })
    }
    const translatedHtml = normalizeImportedHtmlArtifacts(req.file.buffer.toString('utf-8'))
    await writeSessionArtifact(payload.sessionId, 'translated', translatedHtml)
    return res.json({
      ok: true,
      fileName: req.file.originalname || 'translated.html',
      bytes: Buffer.byteLength(translatedHtml, 'utf8'),
      reviewReady: true,
    })
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'Nepodařilo se uložit přeložený HTML soubor.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

app.post('/api/html-review', async (req, res) => {
  try {
    const payload = req.body || {}
    if (!payload?.sessionId) {
      return res.status(400).json({ error: 'Chybí sessionId pro kontrolu HTML.' })
    }
    if (!['claude', 'openai'].includes(payload?.provider)) {
      return res.status(400).json({ error: 'Kontrola podporuje jen Claude nebo OpenAI.' })
    }
    const conflictingJob = await findConflictingActiveJob({
      sessionId: payload.sessionId,
      fileName: payload.fileName || '',
    })
    if (conflictingJob && conflictingJob.kind === 'translation') {
      return res.status(409).json({
        error: 'Nejprve nech doběhnout aktivní překlad, pak spusť LLM kontrolu.',
        job: await publicJob(conflictingJob),
      })
    }
    const jobId = randomUUID()
    const { publicSettings, secretSettings } = splitJobSettings(payload?.settings || {})
    const reviewJob = {
      id: jobId,
      kind: 'review',
      sessionId: payload.sessionId,
      fileName: payload.fileName || 'book.epub',
      status: 'queued',
      provider: payload.provider,
      sourceLanguage: payload.sourceLanguage || 'en',
      targetLanguage: payload.targetLanguage || 'cs',
      sections: payload.sections || [],
      settings: publicSettings,
      secretSettings,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: '',
      completedAt: '',
      error: '',
      outputFileName: '',
      progress: {
        stage: 'queued',
        processedSections: 0,
        totalSections: payload.sections?.filter((section) => section.includeInTranslation).length || 0,
        changedSections: 0,
        findingsCount: 0,
        autoAppliedCount: 0,
        currentSectionId: '',
        currentSectionTitle: '',
        percent: 0,
      },
      summary: {},
      telemetry: buildTelemetrySkeleton('review'),
    }
    jobSecrets.set(jobId, secretSettings)
    await writeJob(reviewJob)
    processReviewJob(jobId).catch((error) => {
      console.error('[processReviewJob] unhandled error:', error?.message)
    })
    return res.status(202).json(await publicJob(reviewJob))
  } catch (error) {
    return res.status(500).json({
      error: 'Nepodařilo se spustit LLM kontrolu HTML.',
      detail: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

app.post('/api/package-html', upload.single('file'), async (req, res) => {
  try {
    const payload = parseBodyPayload(req)
    if (!payload?.sessionId) {
      return res.status(400).json({ error: 'Chybí sessionId pro zabalení EPUB.' })
    }
    const sourceBuffer = await resolveSourceBuffer(payload, req.file)
    const reviewedHtml =
      String(payload?.translatedHtml || '').trim() ||
      (payload?.reviewProvider && await readSessionArtifact(payload.sessionId, `reviewed-${payload.reviewProvider}`)) ||
      await readSessionArtifact(payload.sessionId, 'reviewed-latest') ||
      await readSessionArtifact(payload.sessionId, 'translated')
    if (!reviewedHtml.trim()) {
      return res.status(400).json({ error: 'Chybí zkontrolované nebo nahrané HTML.' })
    }
    const result = await importTranslatedHtmlToEpub({
      buffer: sourceBuffer,
      translatedHtml: reviewedHtml,
      fileName: payload?.fileName || 'book.epub',
      targetLanguage: payload?.targetLanguage || 'cs',
      sections: payload?.sections || [],
      validate: payload?.validate !== false,
    })
    setAttachmentHeaders(res, result.fileName, 'application/epub+zip')
    return res.send(result.buffer)
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: 'Nepodařilo se zabalit HTML zpět do EPUB.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

app.get('/api/jobs', async (_req, res) => {
  const jobs = await listJobs()
  res.json(await Promise.all(jobs.map(publicJob)))
})

app.get('/api/jobs/:id', async (req, res) => {
  const job = await readJob(req.params.id)
  if (!job) {
    return res.status(404).json({ error: 'Job nebyl nalezen.' })
  }

  return res.json(await publicJob(job))
})

app.get('/api/jobs/:id/checkpoint', async (req, res) => {
  const checkpoint = await readCheckpoint(req.params.id)
  if (!checkpoint) return res.status(404).json({ error: 'Checkpoint nenalezen.' })
  return res.json(checkpoint)
})

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = await readJob(req.params.id)
  const output = job?.status === 'completed' ? await readOutput(job) : null
  if (!job || !output) {
    return res.status(404).json({ error: 'Výstupní EPUB zatím není k dispozici.' })
  }

  setAttachmentHeaders(res, job.outputFileName, 'application/epub+zip')
  return res.send(output)
})

app.post('/api/jobs/:id/resume', upload.single('file'), async (req, res) => {
  try {
    const job = await readJob(req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Job nebyl nalezen.' })
    }
    if (job.status === 'completed') {
      return res.status(409).json({ error: 'Job už je dokončený.' })
    }
    if (job.status === 'processing' && activeJobs.has(job.id)) {
      return res.status(409).json({ error: 'Job už právě běží.', job: await publicJob(job) })
    }
    const conflictingJob = await findConflictingActiveJob({
      sessionId: job.sessionId,
      fileName: job.fileName,
      excludeJobId: job.id,
    })
    if (conflictingJob) {
      return res.status(409).json({
        error: 'Pro tuto knihu už běží jiný překlad.',
        job: await publicJob(conflictingJob),
      })
    }

    const payload = parseBodyPayload(req)
    const sourceBuffer = await resolveSourceBuffer({ sessionId: job.sessionId }, req.file)
    const { publicSettings, secretSettings } = splitJobSettings(payload?.settings || job.settings || {})
    const resumed = {
      ...job,
      status: 'queued',
      updatedAt: nowIso(),
      resumedAt: nowIso(),
      error: '',
      settings: publicSettings,
      secretSettings,
      progress: {
        ...(job.progress || {}),
        stage: (await readCheckpoint(job.id)) ? 'resuming-export' : 'queued',
      },
    }

    // Merge client-side checkpoint (from IndexedDB) with server-side
    const clientCheckpoint = payload?.clientCheckpoint
    if (clientCheckpoint?.sections && Object.keys(clientCheckpoint.sections).length) {
      const existing = (await readCheckpoint(job.id)) || { jobId: job.id, updatedAt: '', sections: {} }
      const merged = {
        ...existing,
        updatedAt: nowIso(),
        sections: { ...clientCheckpoint.sections, ...(existing.sections || {}) },
      }
      await writeCheckpoint(job.id, merged)
      resumed.progress = { ...(resumed.progress || {}), stage: 'resuming-export' }
    }

    await writeJob(resumed)
    jobSecrets.set(job.id, secretSettings)
    processJob(job.id, { sourceBuffer }).catch((err) => console.error(`[processJob] unhandled:`, err?.message))

    return res.status(202).json(await publicJob(resumed))
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error?.statusCode ? (error.message || 'Nepodařilo se obnovit překlad.') : 'Nepodařilo se obnovit překlad.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

app.post('/api/jobs', upload.single('file'), async (req, res) => {
  try {
    const payload = parseBodyPayload(req)
    const sessionId = payload?.sessionId || randomUUID()
    const conflictingJob = await findConflictingActiveJob({
      sessionId,
      fileName: payload?.fileName || req.file?.originalname || 'book.epub',
    })
    if (conflictingJob) {
      return res.status(409).json({
        error: 'Pro tuto knihu už běží jiný překlad.',
        job: await publicJob(conflictingJob),
      })
    }
    const sourceBuffer = await resolveSourceBuffer(payload, req.file)
    const analysisSummary = payload?.analysisSummary || {}
    const { publicSettings, secretSettings } = splitJobSettings(payload?.settings || {})
    const plan = await buildExportPlan({
      buffer: sourceBuffer,
      fileName: payload?.fileName || req.file?.originalname || 'book.epub',
      provider: payload?.provider || 'deepl',
      sourceLanguage: payload?.sourceLanguage || '',
      targetLanguage: payload?.targetLanguage || 'cs',
      sections: payload?.sections || [],
      settings: { ...publicSettings, ...secretSettings },
    })

    const job = {
      id: randomUUID(),
      sessionId,
      fileName: payload?.fileName || req.file?.originalname || 'book.epub',
      provider: payload?.provider || 'deepl',
      sourceLanguage: payload?.sourceLanguage || '',
      targetLanguage: payload?.targetLanguage || 'cs',
      settings: publicSettings,
      secretSettings,
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sections: payload?.sections || [],
      summary: {
        totalSections: analysisSummary.totalSections || 0,
        translatedSections: plan.translatedSections,
        skippedSections: analysisSummary.skippedSections || 0,
        translatedWords: analysisSummary.translatedWords || 0,
        skippedWords: analysisSummary.skippedWords || 0,
        tailTrimmedSections: analysisSummary.tailTrimmedSections || 0,
      },
      plan,
      telemetry: {
        ...buildTelemetrySkeleton('translation'),
        totalWords: plan.totalWords || 0,
        totalCharacters: plan.totalCharacters || 0,
      },
      progress: {
        stage: 'queued',
        processedBlocks: 0,
        totalBlocks: plan.totalBlocks,
        processedWords: 0,
        totalWords: plan.totalWords,
        processedPages: 0,
        totalPages: plan.estimatedPages,
        cacheHits: 0,
        cacheMisses: 0,
        currentSectionId: '',
        currentSectionTitle: '',
        percent: 0,
      },
      error: '',
      outputPath: '',
      outputFileName: '',
    }

    await writeSessionSource(sessionId, sourceBuffer)
    await writeJob(job)

    // Accept client-side checkpoint (from IndexedDB) for cross-deploy resume
    const clientCheckpoint = payload?.clientCheckpoint
    if (clientCheckpoint?.sections && Object.keys(clientCheckpoint.sections).length) {
      await writeCheckpoint(job.id, {
        jobId: job.id,
        updatedAt: clientCheckpoint.updatedAt || nowIso(),
        sections: clientCheckpoint.sections,
      })
    }

    jobSecrets.set(job.id, secretSettings)
    processJob(job.id, { sourceBuffer }).catch((err) => console.error(`[processJob] unhandled:`, err?.message))

    return res.status(202).json(await publicJob(job))
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error?.statusCode ? (error.message || 'Nepodařilo se založit export job.') : 'Nepodařilo se založit export job.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

if (existsSync(frontendIndexPath)) {
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(frontendIndexPath)
  })
}

const port = Number(process.env.PORT || 4317)

recoverJobs().catch((error) => {
  console.error('[recoverJobs] failed', error)
})

app.listen(port, () => {
  console.log(`ebook-translator-backend listening on http://localhost:${port}`)
  console.log(`frontend dist ${existsSync(frontendIndexPath) ? 'found' : 'missing'} at candidate ${frontendDistCandidateIndex}`)
})
