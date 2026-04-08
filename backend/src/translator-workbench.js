import JSZip from 'jszip'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: true,
})
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  format: true,
})
const CACHE_DIR = process.env.VERCEL
  ? join('/tmp', 'ebook-translator-data')
  : join(process.cwd(), 'backend', 'data')
const CACHE_FILE = join(CACHE_DIR, 'translation-cache.json')
export const JOBS_DIR = join(CACHE_DIR, 'jobs')
export const UPLOADS_DIR = join(CACHE_DIR, 'uploads')
export const OUTPUTS_DIR = join(CACHE_DIR, 'outputs')
const SECTION_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote'
const TAIL_KEYWORDS = [
  'notes',
  'endnotes',
  'references',
  'bibliography',
  'works cited',
  'sources',
  'prameny',
  'poznámky',
  'literature',
  'further reading',
  'recommended reading',
  'citations',
]

mkdirSync(CACHE_DIR, { recursive: true })
mkdirSync(JOBS_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })
mkdirSync(OUTPUTS_DIR, { recursive: true })

function loadCache() {
  if (!existsSync(CACHE_FILE)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8')
}

const FRONT_KEYWORDS = [
  'contents',
  'table of contents',
  'obsah',
  'copyright',
  'title page',
  'dedication',
  'imprint',
  'about the author',
  'předmluva vydavatele',
  'preface',
  'foreword',
  'introduction',
]

const BACK_KEYWORDS = [
  'index',
  'rejstřík',
  'bibliography',
  'references',
  'sources',
  'prameny',
  'poznámky',
  'notes',
  'further reading',
  'acknowledgements',
  'poděkování',
  'glossary',
]

const MAIN_KEYWORDS = [
  'prologue',
  'prolog',
  'chapter',
  'kapitola',
  'part',
  'část',
  'epilogue',
  'epilog',
]

function toArray(value) {
  if (!value) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function containsKeyword(haystack, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu')
  return pattern.test(haystack)
}

function isHeadingTag(tagName) {
  return /^h[1-6]$/i.test(tagName || '')
}

function matchesTailKeyword(text) {
  const haystack = normalizeText(text).toLowerCase()
  return TAIL_KEYWORDS.some((keyword) => containsKeyword(haystack, keyword))
}

function looksLikeReferenceEntry(text) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return false
  }

  const hasYear = /\b(18|19|20)\d{2}[a-z]?\b/.test(normalized)
  const hasUrl = /https?:\/\/|www\.|doi\.org|ISBN\b/i.test(normalized)
  const authorYear = /^[A-ZÀ-Ž][^.!?]{2,80}\(\d{4}[a-z]?\)/.test(normalized)
  const bracketNote = /^(\[\d+\]|\d+\.)\s+\S+/.test(normalized)
  const shortish = normalized.split(/\s+/).length <= 28

  return shortish && ((hasYear && hasUrl) || authorYear || bracketNote)
}

function trimTrailingBackMatter(html) {
  const $ = cheerio.load(html, { xmlMode: true })
  const nodes = $(SECTION_SELECTOR).toArray()
  const trimSignals = []
  let trimStart = -1

  for (let index = 0; index < nodes.length; index += 1) {
    const element = nodes[index]
    const text = normalizeText($(element).text())
    const nearTail = index >= Math.floor(nodes.length * 0.55)

    if (!nearTail) {
      continue
    }

    if (isHeadingTag(element.tagName) && matchesTailKeyword(text)) {
      trimStart = index
      trimSignals.push(`tail-heading:${text.slice(0, 48)}`)
      break
    }
  }

  if (trimStart === -1 && nodes.length >= 3) {
    for (let index = Math.floor(nodes.length * 0.6); index < nodes.length - 2; index += 1) {
      const sample = nodes.slice(index, index + 3).map((element) => normalizeText($(element).text()))
      if (sample.every(looksLikeReferenceEntry)) {
        trimStart = index
        trimSignals.push('tail-pattern:reference-run')
        break
      }
    }
  }

  if (trimStart !== -1) {
    for (const element of nodes.slice(trimStart)) {
      $(element).remove()
    }
  }

  return {
    html: $.xml(),
    trimApplied: trimStart !== -1,
    trimSignals,
    removedNodeCount: trimStart !== -1 ? nodes.length - trimStart : 0,
  }
}

function resolvePath(basePath, href) {
  if (!href) {
    return ''
  }

  const cleanHref = href.split('#')[0]
  if (!basePath.includes('/')) {
    return cleanHref
  }

  const parts = basePath.split('/')
  parts.pop()
  return [...parts, cleanHref].join('/')
}

function guessMimeType(path) {
  const lower = String(path || '').toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (lower.endsWith('.png')) {
    return 'image/png'
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml'
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp'
  }
  return 'application/octet-stream'
}

async function extractCoverData(zip, packagePath, pkg) {
  const manifestItems = toArray(pkg.manifest?.item).map((item) => ({
    ...item,
    href: resolvePath(packagePath, item.href),
  }))
  const metaEntries = toArray(pkg.metadata?.meta)
  const coverMeta = metaEntries.find((entry) => entry.name === 'cover' && entry.content)

  let coverItem =
    manifestItems.find((item) => item.properties && String(item.properties).includes('cover-image')) ||
    manifestItems.find((item) => coverMeta && item.id === coverMeta.content)

  if (!coverItem) {
    coverItem = manifestItems.find((item) =>
      /cover/i.test(`${item.id || ''} ${item.href || ''} ${item['media-type'] || ''}`)
    )
  }

  if (!coverItem?.href) {
    return null
  }

  const base64 = await zip.file(coverItem.href)?.async('base64')
  if (!base64) {
    return null
  }

  const mediaType = coverItem['media-type'] || guessMimeType(coverItem.href)
  return {
    href: coverItem.href,
    mediaType,
    dataUrl: `data:${mediaType};base64,${base64}`,
  }
}

function fileNameWithoutExtension(name) {
  return String(name || 'book')
    .replace(/\.epub$/i, '')
    .trim()
}

function extractBodyText(html) {
  const $ = cheerio.load(html, { xmlMode: true })

  $('script, style, nav').remove()

  const title =
    normalizeText($('h1').first().text()) ||
    normalizeText($('h2').first().text()) ||
    normalizeText($('title').first().text())

  const paragraphs = $('p')
    .map((_index, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean)

  const plainText =
    normalizeText($('body').text()) ||
    normalizeText($.text())

  const links = $('a[href]').length
  const listItems = $('li').length
  const pageNumberish = (plainText.match(/\b\d{1,4}\b/g) || []).length

  return {
    title,
    plainText,
    paragraphs,
    stats: {
      links,
      listItems,
      pageNumberish,
      characterCount: plainText.length,
      wordCount: plainText ? plainText.split(/\s+/).length : 0,
      paragraphCount: paragraphs.length,
    },
  }
}

function detectBallastCategory(section) {
  const haystack = `${section.title} ${section.plainText.slice(0, 600)}`.toLowerCase()

  if (containsKeyword(haystack, 'contents') || containsKeyword(haystack, 'table of contents') || containsKeyword(haystack, 'obsah')) {
    return 'Obsah'
  }
  if (containsKeyword(haystack, 'index') || containsKeyword(haystack, 'rejstřík')) {
    return 'Rejstřík'
  }
  if (
    containsKeyword(haystack, 'notes') ||
    containsKeyword(haystack, 'endnotes') ||
    containsKeyword(haystack, 'poznámky')
  ) {
    return 'Poznámky'
  }
  if (
    containsKeyword(haystack, 'bibliography') ||
    containsKeyword(haystack, 'references') ||
    containsKeyword(haystack, 'sources') ||
    containsKeyword(haystack, 'prameny') ||
    containsKeyword(haystack, 'works cited') ||
    containsKeyword(haystack, 'literature')
  ) {
    return 'Zdroje a literatura'
  }
  if (containsKeyword(haystack, 'acknowledgements') || containsKeyword(haystack, 'poděkování')) {
    return 'Poděkování'
  }
  if (containsKeyword(haystack, 'dedication') || containsKeyword(haystack, 'věnování')) {
    return 'Věnování'
  }
  if (
    containsKeyword(haystack, 'preface') ||
    containsKeyword(haystack, 'foreword') ||
    containsKeyword(haystack, 'introduction') ||
    containsKeyword(haystack, 'předmluva')
  ) {
    return 'Úvodní texty'
  }
  if (
    containsKeyword(haystack, 'copyright') ||
    containsKeyword(haystack, 'title page') ||
    containsKeyword(haystack, 'imprint') ||
    containsKeyword(haystack, 'about the author')
  ) {
    return 'Titulní a vydavatelské strany'
  }
  if (section.kind === 'front_matter') {
    return 'Přední balast'
  }
  if (section.kind === 'back_matter') {
    return 'Zadní balast'
  }
  return 'Nezařazené'
}

function summarizeBallastSections(sections) {
  const grouped = new Map()

  for (const section of sections) {
    const category = section.ballastCategory || detectBallastCategory(section)
    const current = grouped.get(category) || {
      label: category,
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
    grouped.set(category, current)
  }

  return [...grouped.values()].sort((left, right) => right.wordCount - left.wordCount)
}

function classifySection(section) {
  const haystack = `${section.title} ${section.plainText.slice(0, 600)}`.toLowerCase()
  let mainScore = 0
  let frontScore = 0
  let backScore = 0
  const signals = []

  for (const keyword of MAIN_KEYWORDS) {
    if (containsKeyword(haystack, keyword)) {
      mainScore += 4
      signals.push(`main:${keyword}`)
    }
  }

  for (const keyword of FRONT_KEYWORDS) {
    if (containsKeyword(haystack, keyword)) {
      frontScore += 5
      signals.push(`front:${keyword}`)
    }
  }

  for (const keyword of BACK_KEYWORDS) {
    if (containsKeyword(haystack, keyword)) {
      backScore += 6
      signals.push(`back:${keyword}`)
    }
  }

  if (section.stats.wordCount > 220 && section.stats.paragraphCount >= 3) {
    mainScore += 3
    signals.push('main:long-form-body')
  }

  if (
    section.spineIndex <= 2 &&
    section.stats.wordCount < 260 &&
    section.stats.paragraphCount <= 3 &&
    !MAIN_KEYWORDS.some((keyword) => containsKeyword(haystack, keyword))
  ) {
    frontScore += 4
    signals.push('front:title-or-imprint-candidate')
  }

  if (section.stats.links >= 5) {
    backScore += 3
    signals.push('back:link-heavy')
  }

  if (section.stats.listItems >= 8) {
    frontScore += 2
    backScore += 2
    signals.push('aux:list-heavy')
  }

  if (section.stats.pageNumberish > 50 && section.stats.wordCount < 300) {
    backScore += 4
    signals.push('back:index-pattern')
  }

  if (section.spineIndex <= 2 && section.stats.wordCount < 180) {
    frontScore += 2
    signals.push('front:early-short-section')
  }

  let kind = 'unknown'
  let confidence = 0.4
  const best = Math.max(mainScore, frontScore, backScore)

  if (best === mainScore && mainScore >= 4) {
    kind = 'main_matter'
    confidence = Math.min(0.96, 0.55 + mainScore / 12)
  } else if (best === backScore && backScore >= 4) {
    kind = 'back_matter'
    confidence = Math.min(0.96, 0.55 + backScore / 12)
  } else if (best === frontScore && frontScore >= 4) {
    kind = 'front_matter'
    confidence = Math.min(0.96, 0.55 + frontScore / 12)
  }

  return { kind, confidence, signals, scores: { mainScore, frontScore, backScore } }
}

function findBoundary(sections, direction) {
  const ordered = direction === 'start' ? sections : [...sections].reverse()
  const strongCandidate = ordered.find(
    (section) =>
      section.kind === 'main_matter' &&
      section.signals.some((signal) => signal.startsWith('main:') && signal !== 'main:long-form-body')
  )

  if (strongCandidate) {
    return strongCandidate.id
  }

  const candidate = ordered.find(
    (section) =>
      section.kind === 'main_matter' ||
      (section.kind === 'unknown' && section.stats.wordCount > 350 && section.spineIndex > 1)
  )

  return candidate ? candidate.id : null
}

function withBoundaryFlags(sections, startId, endId) {
  const startIndex = sections.findIndex((section) => section.id === startId)
  const endIndex = sections.findIndex((section) => section.id === endId)

  return sections.map((section, index) => {
    const inside =
      startIndex !== -1 &&
      endIndex !== -1 &&
      index >= startIndex &&
      index <= endIndex &&
      section.kind !== 'front_matter' &&
      section.kind !== 'back_matter'

    return {
      ...section,
      includeInTranslation: inside,
    }
  })
}

async function readContainer(zip) {
  const xml = await zip.file('META-INF/container.xml')?.async('string')
  if (!xml) {
    throw new Error('EPUB neobsahuje META-INF/container.xml')
  }

  const parsed = xmlParser.parse(xml)
  const rootfile = parsed?.container?.rootfiles?.rootfile
  const first = toArray(rootfile)[0]
  const fullPath = first?.['full-path']

  if (!fullPath) {
    throw new Error('Nepodařilo se najít OPF balíček.')
  }

  return fullPath
}

async function readPackage(zip, packagePath) {
  const content = await zip.file(packagePath)?.async('string')
  if (!content) {
    throw new Error('Nepodařilo se otevřít OPF balíček.')
  }

  return xmlParser.parse(content)?.package
}

function findManifestByHref(pkg, targetHref) {
  return toArray(pkg.manifest?.item).find((item) => item.href === targetHref || item.href === targetHref.split('/').pop())
}

function buildSectionMap(sections) {
  return new Map(sections.map((section) => [section.id, section]))
}

function countTranslatableNodes(html) {
  const trimmed = trimTrailingBackMatter(html)
  return {
    count: getTranslatableNodePayloads(trimmed.html).length,
    trim: trimmed,
  }
}

function getTranslatableNodePayloads(html) {
  const $ = cheerio.load(html, { xmlMode: true })
  const payloads = []

  $(SECTION_SELECTOR).each((_index, element) => {
    const text = normalizeText($(element).text())
    const markup = String($(element).html() || '').trim()

    if (text) {
      payloads.push({
        format: 'html',
        tagName: element.tagName,
        source: markup || text,
        plainText: text,
      })
    }
  })

  return payloads
}

function tagSignature(fragment) {
  const matches = String(fragment || '')
    .toLowerCase()
    .match(/<\/?([a-z0-9:-]+)\b/g)
  return (matches || [])
    .map((tag) => tag.replace(/[</>\s]/g, ''))
    .filter(Boolean)
    .join('|')
}

function looksLikeValidTranslatedFragment(original, translated) {
  const originalText = normalizeText(cheerio.load(`<body>${original}</body>`, { xmlMode: true })('body').text())
  const translatedText = normalizeText(
    cheerio.load(`<body>${translated}</body>`, { xmlMode: true })('body').text()
  )

  if (!translatedText) {
    return false
  }

  return tagSignature(original) === tagSignature(translated)
}

function normalizeTranslatedFragment(fragment, tagName) {
  let output = String(fragment || '').trim()
  if (!output) {
    return output
  }

  output = output.replace(/^<\?xml[^>]*>/i, '').trim()

  const bodyMatch = output.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  if (bodyMatch?.[1]) {
    output = bodyMatch[1].trim()
  }

  const wrappedMatch = output.match(
    new RegExp(`^<${tagName}[^>]*>([\\s\\S]*)<\\/${tagName}>$`, 'i')
  )
  if (wrappedMatch?.[1]) {
    output = wrappedMatch[1].trim()
  }

  return output
}

function applyTranslationsToHtml(html, translatedPayloads) {
  const $ = cheerio.load(html, { xmlMode: true })
  let index = 0

  $(SECTION_SELECTOR).each((_elementIndex, element) => {
    const next = translatedPayloads[index]
    const original = normalizeText($(element).text())
    if (next && original) {
      $(element).html(normalizeTranslatedFragment(next, element.tagName))
      index += 1
    }
  })

  return $.xml()
}

async function retryHtmlTranslator(translator, basePayload, buildRetryPayload) {
  const initial = await translator(basePayload)
  if (basePayload.format !== 'html' || looksLikeValidTranslatedFragment(basePayload.text, initial)) {
    return initial
  }

  const retry = await translator(buildRetryPayload())
  if (looksLikeValidTranslatedFragment(basePayload.text, retry)) {
    return retry
  }

  return basePayload.text
}

function settingsFingerprint(settings = {}) {
  if (!settings || typeof settings !== 'object') {
    return ''
  }

  const normalized = {
    openrouter: {
      baseUrl: settings.openrouter?.baseUrl || '',
      useForAll: Boolean(settings.openrouter?.useForAll),
      openaiModel: settings.openrouter?.openaiModel || '',
      claudeModel: settings.openrouter?.claudeModel || '',
      googleModel: settings.openrouter?.googleModel || '',
      glmModel: settings.openrouter?.glmModel || settings.openrouter?.llamaModel || '',
    },
    deepl: {
      baseUrl: settings.deepl?.baseUrl || '',
      formality: settings.deepl?.formality || '',
      modelType: settings.deepl?.modelType || '',
      splitSentences: settings.deepl?.splitSentences || '',
      preserveFormatting: Boolean(settings.deepl?.preserveFormatting),
      context: settings.deepl?.context || '',
      customInstructions: settings.deepl?.customInstructions || '',
    },
    openai: {
      model: settings.openai?.model || '',
    },
    google: {
      project: settings.google?.project || '',
    },
    claude: {
      model: settings.claude?.model || '',
    },
    glm: {
      baseUrl: settings.glm?.baseUrl || '',
      model: settings.glm?.model || '',
    },
    libre: {
      baseUrl: settings.libre?.baseUrl || '',
    },
  }

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function resolveOpenRouterConfig(settings = {}) {
  return {
    apiKey: settings?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '',
    baseUrl: settings?.openrouter?.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    useForAll:
      settings?.openrouter?.useForAll !== undefined
        ? Boolean(settings.openrouter.useForAll)
        : String(process.env.OPENROUTER_USE_FOR_ALL || 'true') !== 'false',
    openaiModel: settings?.openrouter?.openaiModel || process.env.OPENROUTER_OPENAI_MODEL || 'openai/gpt-5.4',
    claudeModel:
      settings?.openrouter?.claudeModel || process.env.OPENROUTER_CLAUDE_MODEL || 'anthropic/claude-sonnet-4.6',
    googleModel:
      settings?.openrouter?.googleModel || process.env.OPENROUTER_GOOGLE_MODEL || 'google/gemini-2.5-pro',
    glmModel:
      settings?.openrouter?.glmModel || process.env.OPENROUTER_GLM_MODEL || 'z-ai/glm-5',
  }
}

function getOpenRouterModelForProvider(provider, settings = {}) {
  const openrouter = resolveOpenRouterConfig(settings)
  const map = {
    openai: openrouter.openaiModel,
    claude: openrouter.claudeModel,
    google: openrouter.googleModel,
    glm: openrouter.glmModel,
  }
  return map[provider] || ''
}

function shouldUseOpenRouter(provider, settings = {}) {
  const openrouter = resolveOpenRouterConfig(settings)
  return openrouter.useForAll && Boolean(openrouter.apiKey) && ['openai', 'claude', 'google', 'glm'].includes(provider)
}

function providerTimeoutSignal(timeoutMs = 45000) {
  return AbortSignal.timeout(timeoutMs)
}

async function translateWithOpenRouter({ provider, text, sourceLanguage, targetLanguage, format = 'text', settings }) {
  const openrouter = resolveOpenRouterConfig(settings)
  if (!openrouter.apiKey) {
    throw new Error('Chybí OPENROUTER_API_KEY')
  }

  const model = getOpenRouterModelForProvider(provider, settings)
  if (!model) {
    throw new Error(`Pro provider ${provider} chybí OpenRouter model.`)
  }

  const response = await fetch(`${String(openrouter.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: providerTimeoutSignal(),
    headers: {
      Authorization: `Bearer ${openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            format === 'html'
              ? 'Translate non-fiction book content inside HTML fragments. Preserve the exact HTML tag structure, keep tags unchanged, translate only visible text nodes, and output HTML only.'
              : 'You translate non-fiction book content faithfully. Preserve terminology, named entities, chronology, and explanatory clarity. Output translation only.',
        },
        {
          role: 'user',
          content: `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status}`)
  }

  const payload = await response.json()
  return payload?.choices?.[0]?.message?.content || ''
}

async function translateTexts(provider, texts, options) {
  const filteredTexts = texts
    .map((item) =>
      typeof item === 'string'
        ? { source: item, plainText: normalizeText(item), format: 'text' }
        : {
            source: String(item?.source || ''),
            plainText: normalizeText(item?.plainText || item?.source || ''),
            format: item?.format || 'text',
          }
    )
    .filter((item) => item.plainText)

  if (!filteredTexts.length) {
    return { translations: [], cacheHits: 0, cacheMisses: 0 }
  }

  const cache = loadCache()
  const translations = new Array(filteredTexts.length)
  const misses = []
  let cacheHits = 0

  for (const [index, item] of filteredTexts.entries()) {
    const key = createHash('sha256')
      .update(JSON.stringify({
        provider,
        sourceLanguage: options.sourceLanguage || '',
        targetLanguage: options.targetLanguage || '',
        settings: settingsFingerprint(options.settings),
        format: item.format,
        text: item.source,
      }))
      .digest('hex')

    if (cache[key]?.translation) {
      translations[index] = cache[key].translation
      cacheHits += 1
    } else {
      misses.push({ index, ...item, key })
    }
  }

  if (provider === 'identity') {
    misses.forEach((item) => {
      translations[item.index] = item.source
      cache[item.key] = {
        provider,
        sourceLanguage: options.sourceLanguage || '',
        targetLanguage: options.targetLanguage || '',
        translation: item.source,
        updatedAt: new Date().toISOString(),
      }
    })
    if (misses.length) {
      saveCache(cache)
    }
    return { translations, cacheHits, cacheMisses: misses.length }
  }

  if (provider === 'deepl') {
    const missingTranslations = await translateManyWithDeepL({
      texts: misses.map((item) => item.source),
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      format: misses.every((item) => item.format === 'html') ? 'html' : 'text',
      settings: options.settings,
    })
    misses.forEach((item, missIndex) => {
      const translation = missingTranslations[missIndex] || ''
      translations[item.index] = translation
      cache[item.key] = {
        provider,
        sourceLanguage: options.sourceLanguage || '',
        targetLanguage: options.targetLanguage || '',
        translation,
        updatedAt: new Date().toISOString(),
      }
    })
    if (misses.length) {
      saveCache(cache)
    }
    return { translations, cacheHits, cacheMisses: misses.length }
  }

  if (provider === 'google') {
    const missingTranslations = await translateManyWithGoogle({
      texts: misses.map((item) => item.source),
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      format: misses.every((item) => item.format === 'html') ? 'html' : 'text',
      settings: options.settings,
    })
    misses.forEach((item, missIndex) => {
      const translation = missingTranslations[missIndex] || ''
      translations[item.index] = translation
      cache[item.key] = {
        provider,
        sourceLanguage: options.sourceLanguage || '',
        targetLanguage: options.targetLanguage || '',
        translation,
        updatedAt: new Date().toISOString(),
      }
    })
    if (misses.length) {
      saveCache(cache)
    }
    return { translations, cacheHits, cacheMisses: misses.length }
  }

  if (provider === 'libre') {
    const missingTranslations = await translateManyWithLibre({
      texts: misses.map((item) => item.source),
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      format: misses.every((item) => item.format === 'html') ? 'html' : 'text',
      settings: options.settings,
    })
    misses.forEach((item, missIndex) => {
      const translation = missingTranslations[missIndex] || ''
      translations[item.index] = translation
      cache[item.key] = {
        provider,
        sourceLanguage: options.sourceLanguage || '',
        targetLanguage: options.targetLanguage || '',
        translation,
        updatedAt: new Date().toISOString(),
      }
    })
    if (misses.length) {
      saveCache(cache)
    }
    return { translations, cacheHits, cacheMisses: misses.length }
  }

  for (const item of misses) {
    const output = await translators[provider]({
      text: item.source,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      format: item.format,
      settings: options.settings,
    })
    translations[item.index] = output
    cache[item.key] = {
      provider,
      sourceLanguage: options.sourceLanguage || '',
      targetLanguage: options.targetLanguage || '',
      translation: output,
      updatedAt: new Date().toISOString(),
    }
  }
  if (misses.length) {
    saveCache(cache)
  }

  return { translations, cacheHits, cacheMisses: misses.length }
}

export async function buildExportPlan(payload) {
  const {
    buffer,
    sections = [],
    provider = 'deepl',
    sourceLanguage = '',
    targetLanguage = 'cs',
    fileName = 'book.epub',
  } = payload || {}

  const zip = await JSZip.loadAsync(buffer)
  const includedSections = sections.filter((section) => section.includeInTranslation)
  const sectionPlans = []
  let totalBlocks = 0
  let totalWords = 0

  for (const section of includedSections) {
    const file = zip.file(section.href)
    if (!file) {
      continue
    }

    const html = await file.async('string')
    const measured = countTranslatableNodes(html)
    totalBlocks += measured.count
    totalWords += section.stats?.wordCount || 0
    sectionPlans.push({
      id: section.id,
      href: section.href,
      title: section.title,
      blockCount: measured.count,
      wordCount: section.stats?.wordCount || 0,
      trimApplied: measured.trim.trimApplied,
      trimSignals: measured.trim.trimSignals,
    })
  }

  return {
    provider,
    sourceLanguage,
    targetLanguage,
    fileName,
    translatedSections: sectionPlans.length,
    totalBlocks,
    totalWords,
    estimatedPages: Math.max(1, Math.ceil(totalWords / 300)),
    sections: sectionPlans,
  }
}

function updatePackageForCleanSpine(pkg, includedSectionIds) {
  const included = new Set(includedSectionIds)
  const manifestItems = toArray(pkg.manifest?.item)
  const spineItems = toArray(pkg.spine?.itemref)

  pkg.manifest.item = manifestItems.filter((item) => {
    const mediaType = item['media-type'] || ''
    if (!/html|xhtml/i.test(mediaType)) {
      return true
    }

    if (mediaType.includes('nav')) {
      return true
    }

    return included.has(item.id)
  })

  pkg.spine.itemref = spineItems.filter((itemref) => included.has(itemref.idref))
}

function pruneNavDocument(html, includedHrefs) {
  const $ = cheerio.load(html, { xmlMode: true })

  $('nav li').each((_index, element) => {
    const href = $(element).find('a[href]').first().attr('href')?.split('#')[0]
    if (href && !includedHrefs.has(href) && !includedHrefs.has(href.split('/').pop())) {
      $(element).remove()
    }
  })

  return $.xml()
}

function pruneNcxDocument(xml, includedHrefs) {
  const parsed = xmlParser.parse(xml)
  const navMap = parsed?.ncx?.navMap
  const navPoints = toArray(navMap?.navPoint)
  if (!navMap || !navPoints.length) {
    return xml
  }

  const filtered = navPoints.filter((point) => {
    const src = point?.content?.src?.split('#')[0]
    return src && (includedHrefs.has(src) || includedHrefs.has(src.split('/').pop()))
  })

  parsed.ncx.navMap.navPoint = filtered
  return xmlBuilder.build(parsed)
}

export async function analyzeEpubBuffer(buffer, options = {}) {
  const zip = await JSZip.loadAsync(buffer)
  const packagePath = await readContainer(zip)
  const pkg = await readPackage(zip, packagePath)
  const manifestItems = toArray(pkg.manifest?.item)
  const spineRefs = toArray(pkg.spine?.itemref)
  const metadata = pkg.metadata || {}
  const cover = await extractCoverData(zip, packagePath, pkg)

  const manifestById = new Map(
    manifestItems.map((item) => [
      item.id,
      {
        ...item,
        href: resolvePath(packagePath, item.href),
      },
    ])
  )

  const sections = []

  for (const [index, itemRef] of spineRefs.entries()) {
    const manifestItem = manifestById.get(itemRef.idref)
    if (!manifestItem?.href) {
      continue
    }

    const mediaType = manifestItem['media-type'] || ''
    if (!/html|xhtml/i.test(mediaType)) {
      continue
    }

    const html = await zip.file(manifestItem.href)?.async('string')
    if (!html) {
      continue
    }

    const trimmed = trimTrailingBackMatter(html)
    const extracted = extractBodyText(trimmed.html)
    const baseSection = {
      id: manifestItem.id || `section-${index + 1}`,
      href: manifestItem.href,
      spineIndex: index,
      title: extracted.title || `Sekce ${index + 1}`,
      plainText: extracted.plainText,
      excerpt: extracted.plainText.slice(0, 520),
      paragraphs: extracted.paragraphs.slice(0, 4),
      stats: extracted.stats,
      trim: {
        applied: trimmed.trimApplied,
        removedNodeCount: trimmed.removedNodeCount,
        signals: trimmed.trimSignals,
      },
    }

    const classified = classifySection(baseSection)

    sections.push({
      ...baseSection,
      ...classified,
      ballastCategory: detectBallastCategory({ ...baseSection, ...classified }),
      signals: [...classified.signals, ...trimmed.trimSignals],
    })
  }

  const startId = findBoundary(sections, 'start')
  const endId = findBoundary(sections, 'end')
  const boundedSections = withBoundaryFlags(sections, startId, endId)

  const mainSections = boundedSections.filter((section) => section.includeInTranslation)
  const skipped = boundedSections.filter((section) => !section.includeInTranslation)
  const translatedWords = mainSections.reduce((sum, section) => sum + section.stats.wordCount, 0)
  const translatedCharacters = mainSections.reduce((sum, section) => sum + (section.stats.characterCount || 0), 0)
  const skippedWords = skipped.reduce((sum, section) => sum + section.stats.wordCount, 0)
  const skippedCharacters = skipped.reduce((sum, section) => sum + (section.stats.characterCount || 0), 0)

  return {
    fileName: options.fileName || 'book.epub',
    metadata: {
      title: normalizeText(toArray(metadata.title)[0]?.['#text'] || toArray(metadata.title)[0] || options.fileName || ''),
      creator: normalizeText(toArray(metadata.creator)[0]?.['#text'] || toArray(metadata.creator)[0] || ''),
      language: normalizeText(toArray(metadata.language)[0] || options.languageHint || ''),
    },
    cover,
    providers: buildProviderMatrix(),
    boundaries: {
      startId,
      endId,
      startTitle: boundedSections.find((section) => section.id === startId)?.title || '',
      endTitle: boundedSections.find((section) => section.id === endId)?.title || '',
    },
    summary: {
      totalSections: boundedSections.length,
      translatedSections: mainSections.length,
      skippedSections: skipped.length,
      translatedWords,
      translatedCharacters,
      skippedWords,
      skippedCharacters,
      totalCharacters: translatedCharacters + skippedCharacters,
      tailTrimmedSections: boundedSections.filter((section) => section.trim?.applied).length,
      ballastBreakdown: summarizeBallastSections(skipped),
      estimatedPages: Math.max(1, Math.ceil(translatedWords / 300)),
    },
    sections: boundedSections,
  }
}

export function buildProviderMatrix() {
  return [
    {
      id: 'deepl',
      label: 'DeepL',
      tier: 'Výchozí',
      bestFor: 'Biografie, popularizace, evropské jazyky, rychlý stabilní překlad.',
      setup: 'DEEPL_API_KEY',
      strengths: ['context', 'glossary', 'style rules', 'custom instructions'],
      caution: 'Méně flexibilní při velmi nejednoznačných pasážích.',
      ratePerMillionCharsEur: 20,
    },
    {
      id: 'openai',
      label: 'OpenAI GPT-5.4',
      tier: 'Precision fallback',
      bestFor: 'Složité vysvětlující pasáže, rod, reference, významová nejednoznačnost.',
      setup: 'OPENAI_API_KEY',
      strengths: ['long context', 'reasoning', 'repair pass', 'style alignment'],
      caution: 'Dražší a pomalejší než DeepL.',
      ratePerMillionCharsEur: 8,
    },
    {
      id: 'google',
      label: 'Google Cloud Translation Advanced',
      tier: 'Terminology mode',
      bestFor: 'Glossary, adaptive translation, delší odborné workflow s vlastní terminologií.',
      setup: 'GOOGLE_CLOUD_ACCESS_TOKEN + GOOGLE_CLOUD_PROJECT',
      strengths: ['adaptive translation', 'glossary', 'document workflows'],
      caution: 'Složitější autentizace a provoz.',
      ratePerMillionCharsEur: 20,
    },
    {
      id: 'claude',
      label: 'Claude Sonnet 4.5',
      tier: 'Optional fallback',
      bestFor: 'Druhá kontrola formulace a stylu u komplikovaných pasáží.',
      setup: 'ANTHROPIC_API_KEY',
      strengths: ['clean prose', 'large context'],
      caution: 'V první verzi spíš doplněk než hlavní engine.',
      ratePerMillionCharsEur: 9,
    },
    {
      id: 'glm',
      label: 'GLM 5.1',
      tier: 'Alt LLM translator',
      bestFor: 'Silný alternativní LLM překlad přes Z.ai nebo OpenRouter fallback.',
      setup: 'GLM_API_BASE_URL + volitelně GLM_API_KEY',
      strengths: ['silný multilingual model', 'coding-grade reasoning', 'hostovaný endpoint'],
      caution: 'Přímý GLM 5.1 obvykle vyžaduje Z.ai endpoint nebo vlastní provider nastavení.',
      ratePerMillionCharsEur: 0.8,
    },
    {
      id: 'libre',
      label: 'LibreTranslate',
      tier: 'Open source budget',
      bestFor: 'Levný self-hosted nebo komunitní překlad s rozumnou kvalitou pro první průchod.',
      setup: 'LIBRETRANSLATE_URL a volitelně LIBRETRANSLATE_API_KEY',
      strengths: ['open source', 'low cost', 'self-hostable'],
      caution: 'Slabší stylistika než DeepL, ale vhodné na levný preview nebo hrubý první překlad.',
      ratePerMillionCharsEur: 1.2,
    },
  ]
}

function resolveDeepLConfig(settings = {}) {
  const apiKey = settings.deepl?.apiKey || process.env.DEEPL_API_KEY
  const configuredBaseUrl = settings.deepl?.baseUrl || process.env.DEEPL_BASE_URL || ''
  const baseUrl =
    configuredBaseUrl ||
    (apiKey?.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')

  return {
    apiKey,
    baseUrl,
    formality: settings.deepl?.formality || process.env.DEEPL_FORMALITY || 'prefer_more',
    modelType:
      settings.deepl?.modelType || process.env.DEEPL_MODEL_TYPE || 'prefer_quality_optimized',
    splitSentences:
      settings.deepl?.splitSentences || process.env.DEEPL_SPLIT_SENTENCES || 'nonewlines',
    preserveFormatting:
      settings.deepl?.preserveFormatting !== undefined
        ? Boolean(settings.deepl.preserveFormatting)
        : String(process.env.DEEPL_PRESERVE_FORMATTING || 'true') !== 'false',
    context:
      settings.deepl?.context ||
      process.env.DEEPL_CONTEXT ||
      'Translate non-fiction book content and preserve terminology consistency, chronology, register, and named entities.',
    customInstructions:
      settings.deepl?.customInstructions ||
      process.env.DEEPL_CUSTOM_INSTRUCTIONS ||
      'Prefer natural Czech phrasing for biographies and popular science. Keep facts exact, preserve named entities, and resolve gender or case from context whenever possible.',
  }
}

function normalizeDeepLTargetLanguage(targetLanguage) {
  return String(targetLanguage || 'CS').toUpperCase()
}

function normalizeDeepLSourceLanguage(sourceLanguage) {
  if (!sourceLanguage) {
    return undefined
  }

  const normalized = String(sourceLanguage).trim().replace(/_/g, '-').toUpperCase()
  const base = normalized.split('-')[0]
  const supported = new Set([
    'AR',
    'BG',
    'CS',
    'DA',
    'DE',
    'EL',
    'EN',
    'ES',
    'ET',
    'FI',
    'FR',
    'HU',
    'ID',
    'IT',
    'JA',
    'KO',
    'LT',
    'LV',
    'NB',
    'NL',
    'PL',
    'PT',
    'RO',
    'RU',
    'SK',
    'SL',
    'SV',
    'TR',
    'UK',
    'ZH',
  ])

  if (supported.has(normalized)) {
    return normalized
  }
  if (supported.has(base)) {
    return base
  }
  return undefined
}

function deepLCustomInstructionsForTarget(targetLanguage, deepl) {
  const target = normalizeDeepLTargetLanguage(targetLanguage)
  const supportedPrefixes = ['DE', 'EN', 'ES', 'FR', 'IT', 'JA', 'KO', 'ZH']
  const isSupported = supportedPrefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}-`))
  if (!isSupported || !deepl.customInstructions) {
    return undefined
  }

  const instructions = Array.isArray(deepl.customInstructions)
    ? deepl.customInstructions
    : String(deepl.customInstructions)
        .split(/\n+/)
        .map((item) => item.trim())
        .filter(Boolean)

  return instructions.slice(0, 10)
}

async function translateWithDeepL({ text, sourceLanguage, targetLanguage, format = 'text', settings }) {
  const deepl = resolveDeepLConfig(settings)
  const apiKey = deepl.apiKey
  if (!apiKey) {
    throw new Error('Chybí DEEPL_API_KEY')
  }

  const normalizedTargetLanguage = normalizeDeepLTargetLanguage(targetLanguage)
  const normalizedSourceLanguage = normalizeDeepLSourceLanguage(sourceLanguage)
  const customInstructions = deepLCustomInstructionsForTarget(normalizedTargetLanguage, deepl)

  const response = await fetch(`${deepl.baseUrl}/v2/translate`, {
    method: 'POST',
    signal: providerTimeoutSignal(),
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: [text],
      target_lang: normalizedTargetLanguage,
      source_lang: normalizedSourceLanguage,
      context: deepl.context,
      formality: deepl.formality,
      model_type: deepl.modelType,
      split_sentences: deepl.splitSentences,
      preserve_formatting: deepl.preserveFormatting,
      custom_instructions: customInstructions,
      tag_handling: format === 'html' ? 'html' : undefined,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepL request failed: ${response.status}${detail ? ` ${detail}` : ''}`)
  }

  const payload = await response.json()
  return payload?.translations?.[0]?.text || ''
}

async function translateManyWithDeepL({
  texts,
  sourceLanguage,
  targetLanguage,
  format = 'text',
  settings,
}) {
  const deepl = resolveDeepLConfig(settings)
  const apiKey = deepl.apiKey
  if (!apiKey) {
    throw new Error('Chybí DEEPL_API_KEY')
  }

  const normalizedTargetLanguage = normalizeDeepLTargetLanguage(targetLanguage)
  const normalizedSourceLanguage = normalizeDeepLSourceLanguage(sourceLanguage)
  const customInstructions = deepLCustomInstructionsForTarget(normalizedTargetLanguage, deepl)

  const response = await fetch(`${deepl.baseUrl}/v2/translate`, {
    method: 'POST',
    signal: providerTimeoutSignal(),
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: texts,
      target_lang: normalizedTargetLanguage,
      source_lang: normalizedSourceLanguage,
      context: deepl.context,
      formality: deepl.formality,
      model_type: deepl.modelType,
      split_sentences: deepl.splitSentences,
      preserve_formatting: deepl.preserveFormatting,
      custom_instructions: customInstructions,
      tag_handling: format === 'html' ? 'html' : undefined,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepL request failed: ${response.status}${detail ? ` ${detail}` : ''}`)
  }

  const payload = await response.json()
  return (payload?.translations || []).map((item) => item.text || '')
}

async function translateWithOpenAI({ text, sourceLanguage, targetLanguage, format = 'text', settings }) {
  if (shouldUseOpenRouter('openai', settings)) {
    return translateWithOpenRouter({ provider: 'openai', text, sourceLanguage, targetLanguage, format, settings })
  }
  const apiKey = settings?.openai?.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('Chybí OPENAI_API_KEY')
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: providerTimeoutSignal(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings?.openai?.model || process.env.OPENAI_TRANSLATION_MODEL || 'gpt-5.4',
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                format === 'html'
                  ? 'You translate non-fiction book content inside HTML fragments. Preserve the exact HTML tag structure, keep tags unchanged, translate only visible text nodes, and output HTML only.'
                  : 'You translate non-fiction book content. Preserve factual meaning, named entities, chronology, and terminology. Do not add commentary.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status}`)
  }

  const payload = await response.json()
  return payload.output_text || ''
}

async function translateWithGoogle({ text, sourceLanguage, targetLanguage, format = 'text', settings }) {
  if (shouldUseOpenRouter('google', settings)) {
    return translateWithOpenRouter({ provider: 'google', text, sourceLanguage, targetLanguage, format, settings })
  }
  const accessToken = settings?.google?.accessToken || process.env.GOOGLE_CLOUD_ACCESS_TOKEN
  const project = settings?.google?.project || process.env.GOOGLE_CLOUD_PROJECT

  if (!accessToken || !project) {
    throw new Error('Chybí GOOGLE_CLOUD_ACCESS_TOKEN nebo GOOGLE_CLOUD_PROJECT')
  }

  const response = await fetch(
    `https://translation.googleapis.com/v3/projects/${project}/locations/global:translateText`,
    {
      method: 'POST',
      signal: providerTimeoutSignal(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [text],
        mimeType: format === 'html' ? 'text/html' : 'text/plain',
        targetLanguageCode: targetLanguage || 'cs',
        sourceLanguageCode: sourceLanguage || undefined,
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Google request failed: ${response.status}`)
  }

  const payload = await response.json()
  return payload.translations?.[0]?.translatedText || ''
}

async function translateManyWithGoogle({
  texts,
  sourceLanguage,
  targetLanguage,
  format = 'text',
  settings,
}) {
  const accessToken = settings?.google?.accessToken || process.env.GOOGLE_CLOUD_ACCESS_TOKEN
  const project = settings?.google?.project || process.env.GOOGLE_CLOUD_PROJECT

  if (!accessToken || !project) {
    throw new Error('Chybí GOOGLE_CLOUD_ACCESS_TOKEN nebo GOOGLE_CLOUD_PROJECT')
  }

  const response = await fetch(
    `https://translation.googleapis.com/v3/projects/${project}/locations/global:translateText`,
    {
      method: 'POST',
      signal: providerTimeoutSignal(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: texts,
        mimeType: format === 'html' ? 'text/html' : 'text/plain',
        targetLanguageCode: targetLanguage || 'cs',
        sourceLanguageCode: sourceLanguage || undefined,
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Google request failed: ${response.status}`)
  }

  const payload = await response.json()
  return (payload.translations || []).map((item) => item.translatedText || '')
}

async function translateWithClaude({ text, sourceLanguage, targetLanguage, format = 'text', settings }) {
  if (shouldUseOpenRouter('claude', settings)) {
    return translateWithOpenRouter({ provider: 'claude', text, sourceLanguage, targetLanguage, format, settings })
  }
  const apiKey = settings?.claude?.apiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('Chybí ANTHROPIC_API_KEY')
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: providerTimeoutSignal(),
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:
        settings?.claude?.model || process.env.ANTHROPIC_TRANSLATION_MODEL || 'claude-sonnet-4-5',
      max_tokens: 2000,
      system:
        format === 'html'
          ? 'Translate non-fiction book text inside HTML fragments. Preserve the exact HTML tags and structure, translate only the visible text, and output HTML only.'
          : 'Translate non-fiction book text faithfully. Preserve terminology, names, chronology, and explanatory clarity. Output translation only.',
      messages: [
        {
          role: 'user',
          content: `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status}`)
  }

  const payload = await response.json()
  return payload.content?.[0]?.text || ''
}

async function translateWithGlm({ text, sourceLanguage, targetLanguage, format = 'text', settings }) {
  if (shouldUseOpenRouter('glm', settings)) {
    return translateWithOpenRouter({ provider: 'glm', text, sourceLanguage, targetLanguage, format, settings })
  }
  const baseUrl =
    settings?.glm?.baseUrl || process.env.GLM_API_BASE_URL || 'https://api.z.ai/api/coding/paas/v4'
  const apiKey = settings?.glm?.apiKey || process.env.GLM_API_KEY || ''
  const model =
    settings?.glm?.model ||
    process.env.GLM_TRANSLATION_MODEL ||
    'glm-5.1'

  if (!baseUrl) {
    throw new Error('Chybí GLM_API_BASE_URL')
  }

  const headers = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: providerTimeoutSignal(),
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            format === 'html'
              ? 'Translate non-fiction book content inside HTML fragments. Preserve the exact HTML tag structure, keep tags unchanged, translate only visible text nodes, and output HTML only.'
              : 'You translate non-fiction book content faithfully. Preserve terminology, named entities, chronology, and explanatory clarity. Output translation only.',
        },
        {
          role: 'user',
          content: `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`GLM endpoint request failed: ${response.status}`)
  }

  const payload = await response.json()
  return payload?.choices?.[0]?.message?.content || ''
}

async function translateManyWithLibre({
  texts,
  sourceLanguage,
  targetLanguage,
  format = 'text',
  settings,
}) {
  const baseUrl =
    settings?.libre?.baseUrl || process.env.LIBRETRANSLATE_URL || 'https://translate.argosopentech.com'
  const apiKey = settings?.libre?.apiKey || process.env.LIBRETRANSLATE_API_KEY || ''
  const translations = []

  for (const text of texts) {
    const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/translate`, {
      method: 'POST',
      signal: providerTimeoutSignal(),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: text,
        source: sourceLanguage || 'auto',
        target: targetLanguage || 'cs',
        format,
        api_key: apiKey || undefined,
      }),
    })

    if (!response.ok) {
      throw new Error(`LibreTranslate request failed: ${response.status}`)
    }

    const payload = await response.json()
    translations.push(payload?.translatedText || '')
  }

  return translations
}

const translators = {
  deepl: translateWithDeepL,
  openai: async (payload) =>
    retryHtmlTranslator(
      translateWithOpenAI,
      payload,
      () => ({
        ...payload,
        text: `Return valid HTML with the exact same tags and nesting as the source fragment.\n\n${payload.text}`,
      })
    ),
  google: translateWithGoogle,
  claude: async (payload) =>
    retryHtmlTranslator(
      translateWithClaude,
      payload,
      () => ({
        ...payload,
        text: `Return valid HTML only. Keep the same tags and nesting as the source fragment.\n\n${payload.text}`,
      })
    ),
  glm: async (payload) =>
    retryHtmlTranslator(
      translateWithGlm,
      payload,
      () => ({
        ...payload,
        text: `Return valid HTML only. Keep the same tags and nesting as the source fragment.\n\n${payload.text}`,
      })
    ),
  libre: async ({ text, sourceLanguage, targetLanguage, settings }) =>
    (await translateManyWithLibre({
      texts: [text],
      sourceLanguage,
      targetLanguage,
      settings,
    }))[0] || '',
  identity: async ({ text }) => text,
}

export async function translateSelectedSections(payload) {
  const {
    provider = 'deepl',
    sections = [],
    sourceLanguage = '',
    targetLanguage = 'cs',
    settings = {},
    previewPageCount = 2,
  } = payload || {}
  const translator = translators[provider]

  if (!translator) {
    throw new Error(`Neznámý provider: ${provider}`)
  }

  const selected = sections.filter((section) => section.includeInTranslation)
  const maxWords = Math.max(300, Number(previewPageCount || 2) * 300)
  const previewParts = []
  const previewSections = []
  let collectedWords = 0

  for (const section of selected) {
    const words = normalizeText(section.plainText).split(/\s+/).filter(Boolean)
    if (!words.length) {
      continue
    }

    const remaining = Math.max(0, maxWords - collectedWords)
    if (!remaining) {
      break
    }

    const excerpt = words.slice(0, remaining).join(' ')
    if (!excerpt) {
      continue
    }

    previewParts.push(excerpt)
    previewSections.push({
      id: section.id,
      title: section.title,
      wordCount: excerpt.split(/\s+/).length,
    })
    collectedWords += excerpt.split(/\s+/).length

    if (collectedWords >= maxWords) {
      break
    }
  }

  const joined = previewParts.join('\n\n')

  if (!joined.trim()) {
    return {
      provider,
      translatedText: '',
      sectionCount: 0,
    }
  }

  const translatedText =
    provider === 'identity'
      ? joined.slice(0, 8000)
      : await translator({
          text: joined.slice(0, 8000),
          sourceLanguage,
          targetLanguage,
          settings,
        })

  return {
    provider,
    sourceText: joined.slice(0, 8000),
    translatedText,
    sectionCount: previewSections.length,
    pageCount: Number((collectedWords / 300).toFixed(2)),
    wordCount: collectedWords,
    sections: previewSections,
  }
}

export async function translatePreviewFromEpub(payload) {
  const {
    buffer,
    provider = 'deepl',
    sections = [],
    sourceLanguage = '',
    targetLanguage = 'cs',
    settings = {},
    previewPageCount = 2,
  } = payload || {}

  if (!buffer) {
    throw new Error('Chybí zdrojový EPUB buffer pro preview.')
  }

  const zip = await JSZip.loadAsync(buffer)
  const selected = sections.filter((section) => section.includeInTranslation)
  const maxWords = Math.max(300, Number(previewPageCount || 2) * 300)
  const previewBlocks = []
  let collectedWords = 0

  for (const section of selected) {
    if (collectedWords >= maxWords) {
      break
    }

    const file = zip.file(section.href)
    if (!file) {
      continue
    }

    const html = await file.async('string')
    const trimmed = trimTrailingBackMatter(html)
    const payloads = getTranslatableNodePayloads(trimmed.html)

    for (const block of payloads) {
      if (collectedWords >= maxWords) {
        break
      }

      const blockWords = block.plainText.split(/\s+/).filter(Boolean).length
      previewBlocks.push({
        sectionId: section.id,
        sectionTitle: section.title,
        ...block,
      })
      collectedWords += blockWords
    }
  }

  if (!previewBlocks.length) {
    return {
      provider,
      translatedText: '',
      sourceText: '',
      sourceHtml: '',
      translatedHtml: '',
      sectionCount: 0,
      pageCount: 0,
      wordCount: 0,
      sections: [],
    }
  }

  const translationBatch = await translateTexts(provider, previewBlocks, {
    sourceLanguage,
    targetLanguage,
    settings,
  })

  const sourceHtml = previewBlocks
    .map((block) => `<${block.tagName || 'p'}>${block.source}</${block.tagName || 'p'}>`)
    .join('\n')
  const translatedHtml = translationBatch.translations
    .map(
      (block, index) =>
        `<${previewBlocks[index]?.tagName || 'p'}>${block}</${previewBlocks[index]?.tagName || 'p'}>`
    )
    .join('\n')

  return {
    provider,
    sourceText: previewBlocks.map((block) => block.plainText).join('\n\n'),
    translatedText: translationBatch.translations
      .map((block) => normalizeText(cheerio.load(`<body>${block}</body>`, { xmlMode: true })('body').text()))
      .join('\n\n'),
    sourceHtml,
    translatedHtml,
    sectionCount: new Set(previewBlocks.map((block) => block.sectionId)).size,
    pageCount: Number((collectedWords / 300).toFixed(2)),
    wordCount: collectedWords,
    sections: Array.from(
      new Map(
        previewBlocks.map((block) => [
          block.sectionId,
          {
            id: block.sectionId,
            title: block.sectionTitle,
          },
        ])
      ).values()
    ),
  }
}

export async function exportTranslatedEpub(payload) {
  const {
    buffer,
    fileName,
    provider = 'deepl',
    sourceLanguage = '',
    targetLanguage = 'cs',
    sections = [],
    settings = {},
    onProgress = null,
  } = payload || {}

  if (!buffer) {
    throw new Error('Chybí zdrojový EPUB buffer.')
  }

  const zip = await JSZip.loadAsync(buffer)
  const packagePath = await readContainer(zip)
  const pkg = await readPackage(zip, packagePath)
  const sectionMap = buildSectionMap(sections)
  const includedSections = sections.filter((section) => section.includeInTranslation)
  const includedIds = includedSections.map((section) => section.id)
  const includedHrefs = new Set(includedSections.map((section) => section.href))
  let cacheHits = 0
  let cacheMisses = 0
  let processedBlocks = 0
  let processedWords = 0
  const sectionTasks = []
  let totalBlocks = 0
  const totalWords = includedSections.reduce(
    (sum, section) => sum + (section.wordCount || section.stats?.wordCount || 0),
    0
  )

  for (const section of includedSections) {
    const file = zip.file(section.href)
    if (!file) {
      continue
    }

    const html = await file.async('string')
    const trimmed = trimTrailingBackMatter(html)
    const texts = getTranslatableNodePayloads(trimmed.html)
    sectionTasks.push({
      section,
      html,
      trimmedHtml: trimmed.html,
      texts,
    })
    totalBlocks += texts.length
  }

  for (const task of sectionTasks) {
    const { section, trimmedHtml, texts } = task
    const translationBatch = await translateTexts(provider, texts, {
      sourceLanguage,
      targetLanguage,
      settings,
    })
    cacheHits += translationBatch.cacheHits
    cacheMisses += translationBatch.cacheMisses
    processedBlocks += texts.length
    processedWords += section.wordCount || section.stats?.wordCount || 0
    const nextHtml = applyTranslationsToHtml(trimmedHtml, translationBatch.translations)
    zip.file(section.href, nextHtml)

    if (onProgress) {
      await onProgress({
        stage: 'translating',
        processedBlocks,
        totalBlocks,
        processedWords,
        totalWords,
        processedPages: Number((processedWords / 300).toFixed(2)),
        totalPages: Math.max(1, Math.ceil(totalWords / 300)),
        cacheHits,
        cacheMisses,
        currentSectionId: section.id,
        currentSectionTitle: section.title,
      })
    }
  }

  const manifestItems = toArray(pkg.manifest?.item)
  for (const item of manifestItems) {
    const resolvedHref = resolvePath(packagePath, item.href)
    const section = sectionMap.get(item.id)
    const mediaType = item['media-type'] || ''

    if (mediaType.includes('nav')) {
      const navFile = zip.file(resolvedHref)
      if (navFile) {
        const html = await navFile.async('string')
        zip.file(resolvedHref, pruneNavDocument(html, includedHrefs))
      }
    }

    if (/ncx/i.test(mediaType) || /\.ncx$/i.test(item.href)) {
      const ncxFile = zip.file(resolvedHref)
      if (ncxFile) {
        const xml = await ncxFile.async('string')
        zip.file(resolvedHref, pruneNcxDocument(xml, includedHrefs))
      }
    }

    if (section && !section.includeInTranslation) {
      zip.remove(resolvedHref)
    }
  }

  updatePackageForCleanSpine(pkg, includedIds)
  zip.file(packagePath, xmlBuilder.build({ package: pkg }))

  const rebuilt = await zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  })

  return {
    buffer: rebuilt,
    fileName: `${fileNameWithoutExtension(fileName)}.${provider}.${targetLanguage}.clean.epub`,
    stats: {
      cacheHits,
      cacheMisses,
      translatedSections: includedSections.length,
      processedBlocks,
      totalBlocks,
      processedWords,
      totalWords,
      processedPages: Number((processedWords / 300).toFixed(2)),
      totalPages: Math.max(1, Math.ceil(totalWords / 300)),
    },
  }
}
