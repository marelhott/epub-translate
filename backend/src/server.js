import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { del as blobDel, get as blobGet, list as blobList, put as blobPut } from '@vercel/blob'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyzeEpubBuffer,
  buildExportPlan,
  buildProviderMatrix,
  exportTranslatedEpub,
  JOBS_DIR,
  OUTPUTS_DIR,
  translatePreviewFromEpub,
  translateSelectedSections,
  UPLOADS_DIR,
} from './translator-workbench.js'

dotenv.config({ path: '.env.local' })
dotenv.config()

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } })
const activeJobs = new Map()
const jobSecrets = new Map()
const JOB_TTL_MS = 1000 * 60 * 60 * 24
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || ''
const USE_DURABLE_BLOB = Boolean(BLOB_TOKEN)
const BLOB_PREFIX = 'ebook-translator'

function nowIso() {
  return new Date().toISOString()
}

function sessionFilePath(sessionId) {
  return join(UPLOADS_DIR, `${sessionId}.epub`)
}

function sessionStorageKey(sessionId) {
  return `${BLOB_PREFIX}/uploads/${sessionId}.epub`
}

function jobFilePath(jobId) {
  return join(JOBS_DIR, `${jobId}.json`)
}

function jobStorageKey(jobId) {
  return `${BLOB_PREFIX}/jobs/${jobId}.json`
}

function checkpointFilePath(jobId) {
  return join(JOBS_DIR, `${jobId}.checkpoint.json`)
}

function checkpointStorageKey(jobId) {
  return `${BLOB_PREFIX}/jobs/${jobId}.checkpoint.json`
}

function outputFilePath(jobId, fileName) {
  return join(OUTPUTS_DIR, `${jobId}__${fileName}`)
}

function outputStorageKey(jobId, fileName) {
  return `${BLOB_PREFIX}/outputs/${jobId}__${fileName}`
}

async function findBlob(pathname) {
  if (!USE_DURABLE_BLOB) {
    return null
  }
  const result = await blobList({ prefix: pathname, limit: 1, token: BLOB_TOKEN })
  return result.blobs.find((item) => item.pathname === pathname) || null
}

async function readBlobBuffer(pathname) {
  if (!USE_DURABLE_BLOB) {
    return null
  }

  const result = await blobGet(pathname, {
    access: 'public',
    useCache: false,
    token: BLOB_TOKEN,
  })
  if (!result?.stream || result.statusCode !== 200) {
    return null
  }

  const response = new Response(result.stream)
  return Buffer.from(await response.arrayBuffer())
}

async function writeBlob(pathname, body, contentType) {
  if (!USE_DURABLE_BLOB) {
    return
  }
  await blobPut(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType,
    token: BLOB_TOKEN,
  })
}

async function deleteBlob(pathname) {
  const blob = await findBlob(pathname)
  if (blob?.url) {
    await blobDel(blob.url, { token: BLOB_TOKEN })
  }
}

async function readJsonFromBlob(pathname) {
  const buffer = await readBlobBuffer(pathname)
  if (!buffer) {
    return null
  }
  try {
    return JSON.parse(buffer.toString('utf-8'))
  } catch {
    return null
  }
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
  const durableBuffer = sessionId ? await readBlobBuffer(sessionStorageKey(sessionId)) : null
  if (durableBuffer?.length) {
    return durableBuffer
  }
  if (sessionId && existsSync(sourcePath)) {
    return readFileSync(sourcePath)
  }

  const error = new Error('Upload session nebyla nalezena nebo už expirovala.')
  error.statusCode = 404
  throw error
}

async function readJob(jobId) {
  const durableJob = await readJsonFromBlob(jobStorageKey(jobId))
  if (durableJob) {
    return durableJob
  }

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
  await writeBlob(jobStorageKey(job.id), JSON.stringify(job, null, 2), 'application/json')
}

async function readCheckpoint(jobId) {
  const durableCheckpoint = await readJsonFromBlob(checkpointStorageKey(jobId))
  if (durableCheckpoint) {
    return durableCheckpoint
  }

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
  await writeBlob(checkpointStorageKey(jobId), JSON.stringify(checkpoint, null, 2), 'application/json')
}

async function deleteCheckpoint(jobId) {
  const path = checkpointFilePath(jobId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
  await deleteBlob(checkpointStorageKey(jobId))
}

async function listJobs() {
  const byId = new Map()

  if (USE_DURABLE_BLOB) {
    const result = await blobList({ prefix: `${BLOB_PREFIX}/jobs/`, limit: 1000, token: BLOB_TOKEN })
    for (const item of result.blobs) {
      const name = item.pathname.split('/').pop() || ''
      if (!name.endsWith('.json') || name.endsWith('.checkpoint.json')) {
        continue
      }
      const id = name.replace(/\.json$/, '')
      const job = await readJob(id)
      if (job?.id) {
        byId.set(job.id, job)
      }
    }
  }

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

async function publicJob(job) {
  if (!job) {
    return null
  }

  const checkpoint = await readCheckpoint(job.id)

  return {
    id: job.id,
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
  await writeBlob(sessionStorageKey(sessionId), buffer, 'application/epub+zip')
}

async function sourceExists(sessionId) {
  return Boolean(
    (USE_DURABLE_BLOB && (await findBlob(sessionStorageKey(sessionId)))) ||
      existsSync(sessionFilePath(sessionId))
  )
}

async function readSessionSource(sessionId) {
  const durableBuffer = await readBlobBuffer(sessionStorageKey(sessionId))
  if (durableBuffer?.length) {
    return durableBuffer
  }
  const sourcePath = sessionFilePath(sessionId)
  return existsSync(sourcePath) ? readFileSync(sourcePath) : null
}

async function deleteSessionSource(sessionId) {
  const sourcePath = sessionFilePath(sessionId)
  if (existsSync(sourcePath)) {
    unlinkSync(sourcePath)
  }
  await deleteBlob(sessionStorageKey(sessionId))
}

async function writeOutput(jobId, fileName, buffer) {
  const localPath = outputFilePath(jobId, fileName)
  writeFileSync(localPath, buffer)
  await writeBlob(outputStorageKey(jobId, fileName), buffer, 'application/epub+zip')
  return { localPath, storageKey: outputStorageKey(jobId, fileName) }
}

async function readOutput(job) {
  if (job?.outputStorageKey) {
    const durableBuffer = await readBlobBuffer(job.outputStorageKey)
    if (durableBuffer?.length) {
      return durableBuffer
    }
  }
  if (job?.outputPath && existsSync(job.outputPath)) {
    return readFileSync(job.outputPath)
  }
  if (job?.outputFileName) {
    return readBlobBuffer(outputStorageKey(job.id, job.outputFileName))
  }
  return null
}

function splitJobSettings(settings = {}) {
  const publicSettings = JSON.parse(JSON.stringify(settings || {}))
  const secretSettings = {
    openrouter: { apiKey: settings?.openrouter?.apiKey || '' },
    deepl: { apiKey: settings?.deepl?.apiKey || '' },
    openai: { apiKey: settings?.openai?.apiKey || '' },
    google: { accessToken: settings?.google?.accessToken || '' },
    claude: { apiKey: settings?.claude?.apiKey || '' },
    glm: { apiKey: settings?.glm?.apiKey || '' },
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
  const runtimeSecrets = jobSecrets.get(job.id) || {}
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

  function openrouterModelReady(modelId) {
    return Boolean(modelId) && openrouterModels.includes(modelId)
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
    const model = settings?.openrouter?.claudeModel || 'anthropic/claude-sonnet-4-6'
    diagnostics.claude = openrouterModelReady(model)
      ? { status: 'ready', label: 'Ready', detail: `${model} online přes OpenRouter.` }
      : { status: 'unavailable', label: 'Model offline', detail: `${model} není dostupný v OpenRouteru.` }
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
        outputStorageKey: output.storageKey,
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
      }
      await writeJob(completed)
    } catch (error) {
      const failed = {
        ...(await readJob(jobId)),
        status: 'failed',
        updatedAt: nowIso(),
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      await writeJob(failed)
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
      const requeued = {
        ...job,
        status: 'queued',
        updatedAt: nowIso(),
        progress: {
          ...(job.progress || {}),
          stage: 'queued',
        },
      }
      await writeJob(requeued)
      processJob(job.id)
    }
  }
}

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'ebook-translator-workbench',
    now: new Date().toISOString(),
    durableStorage: USE_DURABLE_BLOB ? 'vercel-blob' : 'local-filesystem',
  })
})

app.get('/api/providers', (_req, res) => {
  res.json(buildProviderMatrix())
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

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = await readJob(req.params.id)
  const output = job?.status === 'completed' ? await readOutput(job) : null
  if (!job || !output) {
    return res.status(404).json({ error: 'Výstupní EPUB zatím není k dispozici.' })
  }

  res.setHeader('Content-Type', 'application/epub+zip')
  res.setHeader('Content-Disposition', `attachment; filename="${job.outputFileName}"`)
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
      progress: {
        ...(job.progress || {}),
        stage: (await readCheckpoint(job.id)) ? 'resuming-export' : 'queued',
      },
    }

    await writeJob(resumed)
    jobSecrets.set(job.id, secretSettings)
    processJob(job.id, { sourceBuffer })

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
    jobSecrets.set(job.id, secretSettings)
    processJob(job.id, { sourceBuffer })

    return res.status(202).json(await publicJob(job))
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error?.statusCode ? (error.message || 'Nepodařilo se založit export job.') : 'Nepodařilo se založit export job.',
      detail: error?.detail || (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
})

const port = Number(process.env.PORT || 4317)

recoverJobs().catch((error) => {
  console.error('[recoverJobs] failed', error)
})

app.listen(port, () => {
  console.log(`ebook-translator-backend listening on http://localhost:${port}`)
})
