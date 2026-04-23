import JSZip from 'jszip'
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser'
import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { validateEpubBuffer } from './epubcheck.js'

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
/** Retry an async fn with exponential backoff.  Does NOT retry on 4xx client errors. */
async function withRetry(fn, { retries = 3, initialDelayMs = 800, label = 'operation' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const isClientError = error?.status >= 400 && error?.status < 500
      if (attempt === retries || isClientError) throw error
      const delay = initialDelayMs * Math.pow(2, attempt)
      console.warn(`[withRetry] ${label} attempt ${attempt + 1} failed (${error?.message}), retrying in ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

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

function sanitizeFileName(str) {
  return String(str || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function buildOutputFileName(metadata, originalFileName, targetLanguage) {
  const title = sanitizeFileName(
    normalizeText(toArray(metadata?.title)?.[0]?.['#text'] || toArray(metadata?.title)?.[0] || '')
  )
  const author = sanitizeFileName(
    normalizeText(toArray(metadata?.creator)?.[0]?.['#text'] || toArray(metadata?.creator)?.[0] || '')
  )

  if (title && author) {
    return `${author} – ${title} (${targetLanguage}).epub`
  }
  if (title) {
    return `${title} (${targetLanguage}).epub`
  }
  return `${fileNameWithoutExtension(originalFileName)} (${targetLanguage}).epub`
}

function buildHtmlExportFileName(metadata, originalFileName, targetLanguage) {
  const title = sanitizeFileName(
    normalizeText(toArray(metadata?.title)?.[0]?.['#text'] || toArray(metadata?.title)?.[0] || '')
  )
  const author = sanitizeFileName(
    normalizeText(toArray(metadata?.creator)?.[0]?.['#text'] || toArray(metadata?.creator)?.[0] || '')
  )
  const base =
    title && author ? `${author} – ${title}` : title || fileNameWithoutExtension(originalFileName) || 'book'
  return `${base} (${targetLanguage}).html`
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function extractBodyInnerHtml(html) {
  const bodyMatch = String(html || '').match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return bodyMatch?.[1]?.trim() || String(html || '').trim()
}

function injectBodyInnerHtml(originalHtml, bodyInnerHtml) {
  const source = String(originalHtml || '')
  if (/<body[^>]*>/i.test(source)) {
    return source.replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/i, `$1${bodyInnerHtml}$3`)
  }
  return bodyInnerHtml
}

function normalizeXhtmlFragment(fragment, containerTag = 'div') {
  const wrapped = `<${containerTag}>${String(fragment || '').trim()}</${containerTag}>`
  const $ = cheerio.load(wrapped, { decodeEntities: false })
  return $.xml($(containerTag).contents())
}

function normalizeXhtmlDocument(html, targetLanguage = '') {
  const source = String(html || '')
  if (!source.trim()) {
    return source
  }
  const $ = cheerio.load(source, { decodeEntities: false })
  if (targetLanguage) {
    $('html').attr('xml:lang', targetLanguage)
    $('html').attr('lang', targetLanguage)
    $('body').attr('xml:lang', targetLanguage)
    $('body').attr('lang', targetLanguage)
  }
  return $.xml().replace(/&(?!#?[a-z0-9]+;)/gi, '&amp;')
}

function validateXhtmlWellFormed(xml, label = 'document') {
  const validation = XMLValidator.validate(String(xml || ''), {
    allowBooleanAttributes: true,
  })
  if (validation === true) {
    return true
  }

  const error = validation?.err || {}
  const location =
    error.line !== undefined && error.col !== undefined
      ? ` na řádku ${error.line}, sloupec ${error.col}`
      : ''
  throw new Error(`XHTML validace selhala pro ${label}${location}: ${error.msg || 'neplatné XML'}`)
}

function validateXhtmlDocument(html, label = 'document') {
  let tempDir = ''
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'epub-xhtml-'))
    const filePath = join(tempDir, `${label.replace(/[^a-z0-9._-]+/gi, '_')}.xhtml`)
    const wrapped = String(html || '').startsWith('<?xml')
      ? String(html || '')
      : `<?xml version="1.0" encoding="utf-8"?>\n${String(html || '')}`
    writeFileSync(filePath, wrapped, 'utf-8')
    try {
      execFileSync('xmllint', ['--noout', filePath], { stdio: 'pipe' })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
      validateXhtmlWellFormed(wrapped, label)
    }
    return true
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').trim()
    if (/^XHTML validace selhala/.test(detail)) {
      throw new Error(detail)
    }
    throw new Error(`XHTML validace selhala pro ${label}: ${detail}`)
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

export function normalizeImportedHtmlArtifacts(html) {
  return String(html || '')
    .replace(/\b([A-Za-z][\w-]*)_x003a_/g, '$1:')
    .replace(/\s+xmlns_x003a_/g, ' xmlns:')
}

function extractHtmlSectionsDocument(html) {
  const doc = cheerio.load(String(html || ''), { decodeEntities: false })
  const sectionMap = new Map()
  doc('[data-ebook-id]').each((_index, element) => {
    const node = doc(element)
    const id = node.attr('data-ebook-id') || ''
    if (!id) return
    sectionMap.set(id, {
      id,
      title: normalizeText(node.find('.ebook-section-title').first().text()),
      bodyHtml: node.find('.ebook-section-body').first().html() || '',
    })
  })
  return { doc, sectionMap }
}

function extractReviewedHtmlFragment(raw, fallbackHtml) {
  const text = String(raw || '').trim()
  if (!text) return String(fallbackHtml || '')
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || text
  if (!candidate) return String(fallbackHtml || '')
  return candidate
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || text
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {}
    }
  }
  return null
}

async function reviewHtmlFragmentWithLlm({ provider, originalHtml, translatedHtml, title, settings }) {
  const reviewSettings = buildReviewSettings(provider, settings)
  const reviewer =
    provider === 'claude'
      ? translateWithClaude
      : provider === 'openai'
        ? translateWithOpenAI
        : null

  if (!reviewer) {
    throw new Error(`Provider ${provider} nepodporuje LLM kontrolu HTML.`)
  }

  const systemPrompt =
    'You are a conservative Czech copy editor reviewing an existing Czech translation of a non-fiction book HTML fragment against the original English HTML fragment. ' +
    'Your job is NOT to retranslate the fragment from scratch. Keep the Czech translation as-is unless a change is clearly needed. ' +
    'Only make minimal, local edits that improve factual fidelity, gender agreement, terminology consistency, obvious omissions, or clearly unnatural Czech phrasing. ' +
    'Preserve the exact HTML tags, nesting, links, ids, footnotes, and attributes. Preserve paragraph boundaries and inline markup. ' +
    'Do not rewrite for style unless the current Czech is clearly wrong or awkward. Do not add commentary, markdown, wrappers, or explanations. ' +
    'Return ONLY the corrected Czech HTML fragment body.'

  const response = await withRetry(
    () =>
      reviewer({
        text:
          `Section title: ${title || 'Untitled'}\n\n` +
          `<original_html>\n${originalHtml}\n</original_html>\n\n` +
          `<translated_html>\n${translatedHtml}\n</translated_html>`,
        sourceLanguage: 'en',
        targetLanguage: 'cs',
        format: 'text',
        settings: reviewSettings,
        systemPrompt,
      }),
    { retries: 2, initialDelayMs: 900, label: `${provider} html review` }
  )

  return extractReviewedHtmlFragment(response, translatedHtml)
}

async function auditHtmlBlocksWithLlm({ provider, sectionTitle, blocks, settings }) {
  const reviewSettings = buildReviewSettings(provider, settings)
  const reviewer =
    provider === 'claude'
      ? translateWithClaude
      : provider === 'openai'
        ? translateWithOpenAI
        : null

  if (!reviewer) {
    throw new Error(`Provider ${provider} nepodporuje audit překladu HTML.`)
  }

  const systemPrompt =
    'You are a strict translation auditor for Czech non-fiction book content. ' +
    'You compare original English blocks with an existing Czech translation. ' +
    'Default to NO_CHANGE. Only flag a block if there is a clear issue: untranslated English, meaning drift, factual distortion, broken Czech grammar, bad gender agreement, inconsistent terminology, or visibly broken markup. ' +
    'Do NOT rewrite for style. Do NOT optimize tone. Do NOT make optional improvements. ' +
    'When a change is truly necessary, return a minimal corrected Czech HTML fragment for that one block only, preserving inline tags and attributes already present in the Czech fragment. ' +
    'Return JSON only in the shape {"findings":[{"index":number,"issueType":string,"severity":"low|medium|high","confidence":number,"reason":string,"suggestedHtml":string}]}. ' +
    'If nothing needs changing, return {"findings":[]}.'

  const raw = await withRetry(
    () =>
      reviewer({
        text: JSON.stringify({
          sectionTitle,
          blocks: blocks.map((block) => ({
            index: block.index,
            tagName: block.tagName,
            originalText: block.originalPlainText,
            translatedText: block.translatedPlainText,
            translatedHtml: block.translatedSource,
          })),
        }),
        sourceLanguage: 'en',
        targetLanguage: 'cs',
        format: 'text',
        settings: reviewSettings,
        systemPrompt,
      }),
    { retries: 0, initialDelayMs: 900, label: `${provider} html audit` }
  )

  const parsed = extractJsonObject(raw)
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : []
  return findings
    .map((item) => ({
      index: Number(item?.index),
      issueType: normalizeText(item?.issueType || 'quality'),
      severity: ['low', 'medium', 'high'].includes(item?.severity) ? item.severity : 'medium',
      confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0))),
      reason: normalizeText(item?.reason || ''),
      suggestedHtml: String(item?.suggestedHtml || '').trim(),
    }))
    .filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.reason)
}

function shouldAutoApplyAuditFinding(finding, originalBlock) {
  if (!finding?.suggestedHtml?.trim()) return false
  if (!looksLikeValidTranslatedFragment(originalBlock?.translatedSource || '', finding.suggestedHtml)) return false
  if (finding.confidence < 0.92) return false
  return ['high', 'medium'].includes(finding.severity)
}

function summarizeAudit(findings) {
  const byType = {}
  let autoApplicable = 0
  for (const finding of findings) {
    byType[finding.issueType] = (byType[finding.issueType] || 0) + 1
    if (finding.autoApplied) autoApplicable += 1
  }
  return { byType, autoApplicable }
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

const COMMON_ENGLISH_REVIEW_WORDS = new Set([
  'the',
  'and',
  'with',
  'from',
  'that',
  'this',
  'these',
  'those',
  'chapter',
  'introduction',
  'prologue',
  'epilogue',
  'part',
  'notes',
  'copyright',
  'contents',
  'acknowledgments',
  'index',
  'author',
  'publisher',
  'page',
  'book',
  'years',
  'work',
  'people',
  'their',
  'there',
  'about',
  'into',
  'between',
  'through',
  'while',
  'where',
  'when',
  'because',
  'before',
  'after',
  'during',
])

function countWords(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean).length
}

function englishResidueScore(text) {
  const words = normalizeText(text)
    .toLowerCase()
    .match(/[a-z][a-z'-]{2,}/g)
  if (!words?.length) {
    return 0
  }
  let score = 0
  for (const word of words) {
    if (COMMON_ENGLISH_REVIEW_WORDS.has(word)) {
      score += 1
    }
  }
  return score
}

function hasMeaningfulMarkupDifference(originalHtml, translatedHtml) {
  const originalTags = tagSignature(originalHtml)
  const translatedTags = tagSignature(translatedHtml)
  return originalTags !== translatedTags
}

function looksLikeAwkwardCzech(text) {
  const normalized = normalizeText(text)
  if (!normalized) return false
  return (
    /\b(v knize|v textu|v článku)\s+\*\*/i.test(normalized) ||
    /\btokeny\b/i.test(normalized) ||
    /\bznaky\s+místo\s+slov\b/i.test(normalized) ||
    /\bAI\b.{0,20}\bprojekt\b/i.test(normalized)
  )
}

function classifyAuditNeed(block) {
  const sourceWords = countWords(block.originalPlainText)
  const translatedWords = countWords(block.translatedPlainText)
  const ratio = sourceWords > 0 ? translatedWords / sourceWords : 1
  const englishScore = englishResidueScore(block.translatedPlainText)
  const sourceEnglishScore = englishResidueScore(block.originalPlainText)
  const markupRisk = hasMeaningfulMarkupDifference(block.originalPlainText, block.translatedSource)
  const awkwardCzech = looksLikeAwkwardCzech(block.translatedPlainText)
  const veryShort = Math.max(sourceWords, translatedWords) < 6

  const reasons = []
  if (englishScore >= 2) reasons.push('english-residue')
  if (awkwardCzech) reasons.push('awkward-czech')
  if (markupRisk) reasons.push('markup-drift')
  if (ratio > 1.85 || ratio < 0.45) reasons.push('length-drift')
  if (sourceEnglishScore >= 3 && translatedWords < 4) reasons.push('possible-omission')
  if (/["“”„]/.test(block.originalPlainText) !== /["“”„]/.test(block.translatedPlainText)) reasons.push('quote-mismatch')

  const shouldAudit = !veryShort && reasons.length > 0
  return {
    shouldAudit,
    reasons,
    sourceWords,
    translatedWords,
  }
}

function filterAuditBlocks(blocks) {
  const flagged = []
  for (const block of blocks) {
    const audit = classifyAuditNeed(block)
    if (audit.shouldAudit) {
      flagged.push({
        ...block,
        auditReasons: audit.reasons,
        sourceWords: audit.sourceWords,
        translatedWords: audit.translatedWords,
      })
    }
  }
  return flagged
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
  if (!sections.length) {
    return sections
  }

  const startIndex = sections.findIndex((section) => section.id === startId)
  const endIndex = sections.findIndex((section) => section.id === endId)

  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    const fallbackSections = sections.filter(
      (section) => section.kind !== 'front_matter' && section.kind !== 'back_matter'
    )
    const fallbackIds = new Set(
      (fallbackSections.length ? fallbackSections : sections).map((section) => section.id)
    )

    return sections.map((section) => ({
      ...section,
      includeInTranslation: fallbackIds.has(section.id),
    }))
  }

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

async function readPackageXml(zip, packagePath) {
  const content = await zip.file(packagePath)?.async('string')
  if (!content) {
    throw new Error('Nepodařilo se otevřít OPF balíček.')
  }

  return content
}

function buildOpfTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') : date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function decodeBasicXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function stripAttribute(fragment, attributeName) {
  const pattern = new RegExp(`\\s+${attributeName}="[^"]*"`, 'gi')
  return String(fragment || '').replace(pattern, '')
}

function normalizePackageTag(packageXml, targetLanguage) {
  const normalizedTarget = escapeHtml(String(targetLanguage || 'cs').trim())
  return String(packageXml || '').replace(/<package\b([^>]*)>/i, (_match, attrs) => {
    let nextAttrs = String(attrs || '')
    if (!/\bxmlns="/i.test(nextAttrs)) {
      nextAttrs += ' xmlns="http://www.idpf.org/2007/opf"'
    }
    nextAttrs = stripAttribute(nextAttrs, 'lang')
    if (/\bxml:lang="/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\bxml:lang="[^"]*"/i, `xml:lang="${normalizedTarget}"`)
    } else {
      nextAttrs += ` xml:lang="${normalizedTarget}"`
    }
    return `<package${nextAttrs}>`
  })
}

function normalizeMetadataTag(source) {
  return String(source || '').replace(/<metadata\b([^>]*)>/i, (_match, attrs) => {
    let nextAttrs = String(attrs || '')
    if (!/\bxmlns:dc="/i.test(nextAttrs)) {
      nextAttrs += ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
    }
    if (!/\bxmlns:opf="/i.test(nextAttrs)) {
      nextAttrs += ' xmlns:opf="http://www.idpf.org/2007/opf"'
    }
    return `<metadata${nextAttrs}>`
  })
}

function extractMetadataOpeningAttributes(source) {
  const metadataMatch = String(source || '').match(/<metadata\b([^>]*)>/i)
  if (!metadataMatch) {
    return {}
  }
  const attrs = {}
  for (const match of metadataMatch[1].matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function ensureDcMetadataElement(source, fieldName, fallbackValue) {
  const escapedValue = escapeHtml(String(fallbackValue || '').trim())
  if (!escapedValue) {
    return source
  }

  const dcTag = `dc:${fieldName}`
  const plainTag = fieldName
  const existingPattern = new RegExp(`<${dcTag}\\b[^>]*>[\\s\\S]*?<\\/${dcTag}>`, 'i')
  if (existingPattern.test(source)) {
    return source.replace(existingPattern, `<${dcTag}>${escapedValue}</${dcTag}>`)
  }

  const plainPattern = new RegExp(`<${plainTag}\\b([^>]*)>[\\s\\S]*?<\\/${plainTag}>`, 'i')
  if (plainPattern.test(source)) {
    return source.replace(plainPattern, `<${dcTag}$1>${escapedValue}</${dcTag}>`)
  }

  return source.replace(/<metadata\b[^>]*>/i, (match) => `${match}\n    <${dcTag}>${escapedValue}</${dcTag}>`)
}

function ensureDctermsModified(source, modifiedAt) {
  const timestamp = escapeHtml(buildOpfTimestamp(modifiedAt))
  if (/<meta\b[^>]*property="dcterms:modified"[^>]*>[\s\S]*?<\/meta>/i.test(source)) {
    return source.replace(
      /<meta\b([^>]*)property="dcterms:modified"([^>]*)>[\s\S]*?<\/meta>/i,
      `<meta$1property="dcterms:modified"$2>${timestamp}</meta>`
    )
  }
  if (/<meta\b[^>]*property="dcterms:modified"[^>]*\/>/i.test(source)) {
    return source.replace(
      /<meta\b([^>]*)property="dcterms:modified"([^>]*)\/>/i,
      `<meta$1property="dcterms:modified"$2>${timestamp}</meta>`
    )
  }
  return source.replace(/<metadata\b[^>]*>/i, (match) => `${match}\n    <meta property="dcterms:modified">${timestamp}</meta>`)
}

function ensureLegacyCoverMeta(source) {
  if (/<meta\b(?=[^>]*\bname="cover")(?=[^>]*\bcontent="[^"]+")[^>]*\/?>/i.test(source)) {
    return source
  }
  return source.replace(/<metadata\b[^>]*>/i, (match) => `${match}\n    <meta name="cover" content="cover-image"/>`)
}

function stripBrokenMetadataAttributes(source) {
  return String(source || '').replace(/<metadata\b([^>]*)>/i, (_match, attrs) => {
    let nextAttrs = String(attrs || '')
    for (const field of ['title', 'creator', 'source', 'date', 'type', 'format', 'language', 'publisher', 'rights', 'description']) {
      nextAttrs = stripAttribute(nextAttrs, field)
    }
    return `<metadata${nextAttrs}>`
  })
}

export function updateOpfMetadata(packageXml, targetLanguage, options = {}) {
  const source = String(packageXml || '')
  const normalizedTarget = String(targetLanguage || 'cs').trim()
  if (!source.trim() || !normalizedTarget) {
    return source
  }

  let next = normalizePackageTag(source, normalizedTarget)
  next = normalizeMetadataTag(next)

  const metadataAttributes = extractMetadataOpeningAttributes(next)
  const identifierFallback = next.match(/<identifier\b[^>]*>([\s\S]*?)<\/identifier>/i)?.[1] || ''
  next = stripBrokenMetadataAttributes(next)

  const dcFieldMap = [
    ['title', decodeBasicXmlEntities(metadataAttributes.title)],
    ['creator', decodeBasicXmlEntities(metadataAttributes.creator)],
    ['identifier', decodeBasicXmlEntities(metadataAttributes.identifier || identifierFallback)],
    ['source', decodeBasicXmlEntities(metadataAttributes.source)],
    ['date', decodeBasicXmlEntities(metadataAttributes.date)],
    ['type', decodeBasicXmlEntities(metadataAttributes.type)],
    ['format', decodeBasicXmlEntities(metadataAttributes.format)],
    ['publisher', decodeBasicXmlEntities(metadataAttributes.publisher)],
    ['rights', decodeBasicXmlEntities(metadataAttributes.rights)],
    ['language', normalizedTarget],
  ]

  for (const [fieldName, value] of dcFieldMap) {
    next = ensureDcMetadataElement(next, fieldName, value)
  }

  if (metadataAttributes.description && !/<(?:dc:)?description\b[^>]*>/i.test(next)) {
    next = next.replace(
      /<metadata\b[^>]*>/i,
      (match) => `${match}\n    <dc:description>${escapeHtml(decodeBasicXmlEntities(metadataAttributes.description))}</dc:description>`
    )
  }

  next = ensureDctermsModified(next, options.modifiedAt)
  next = ensureLegacyCoverMeta(next)
  return next
}

function findManifestByHref(pkg, targetHref) {
  return toArray(pkg.manifest?.item).find((item) => item.href === targetHref || item.href === targetHref.split('/').pop())
}

function relativeHref(packagePath, fullPath) {
  const prefix = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : ''
  return String(fullPath || '').startsWith(prefix) ? String(fullPath || '').slice(prefix.length) : String(fullPath || '')
}

function relativePathBetween(fromPath, toPath) {
  const from = String(fromPath || '').split('/').filter(Boolean)
  const to = String(toPath || '').split('/').filter(Boolean)
  from.pop()
  while (from.length && to.length && from[0] === to[0]) {
    from.shift()
    to.shift()
  }
  return `${from.map(() => '..').join('/')}${from.length ? '/' : ''}${to.join('/')}` || toPath
}

function ensureManifestNavItem(packageXml, navHref) {
  const source = String(packageXml || '')
  if (!source.trim() || !navHref) {
    return source
  }
  if (/<item\b(?=[^>]*\bproperties="[^"]*\bnav\b[^"]*")/i.test(source)) {
    return source
  }
  if (!/<manifest\b[^>]*>/i.test(source)) {
    return source
  }
  return source.replace(
    /<\/manifest>/i,
    `  <item href="${escapeHtml(navHref)}" id="nav" media-type="application/xhtml+xml" properties="nav"></item>\n</manifest>`
  )
}

function pruneGuideReferences(packageXml, existingRelativeHrefs) {
  const $ = cheerio.load(String(packageXml || ''), { xmlMode: true })
  $('guide reference').each((_index, element) => {
    const href = $(element).attr('href')?.split('#')[0] || ''
    if (!href) return
    if (!existingRelativeHrefs.has(href) && !existingRelativeHrefs.has(href.split('/').pop())) {
      $(element).remove()
    }
  })
  if ($('guide').children().length === 0) {
    $('guide').remove()
  }
  return $.xml()
}

function buildNavDocLabelFromHtml(html, fallbackLabel) {
  const $ = cheerio.load(String(html || ''), { xmlMode: true })
  const label =
    normalizeText($('h1').first().text()) ||
    normalizeText($('h2').first().text()) ||
    normalizeText($('title').first().text()) ||
    normalizeText(fallbackLabel)
  return label || 'Section'
}

async function buildRepairNavigationDocuments({ zip, pkg, packagePath, targetLanguage }) {
  const manifestItems = toArray(pkg.manifest?.item).map((item) => ({
    ...item,
    fullHref: resolvePath(packagePath, item.href),
  }))
  const manifestById = new Map(manifestItems.map((item) => [item.id, item]))
  const spineItems = toArray(pkg.spine?.itemref)
  const navEntries = []
  const navRelativePath = 'xhtml/nav.xhtml'

  for (const itemRef of spineItems) {
    const manifestItem = manifestById.get(itemRef.idref)
    if (!manifestItem?.href || !/html|xhtml/i.test(manifestItem['media-type'] || '')) {
      continue
    }
    const file = zip.file(manifestItem.fullHref)
    if (!file) {
      continue
    }
    const html = await file.async('string')
    navEntries.push({
      href: manifestItem.href,
      navHref: relativePathBetween(navRelativePath, manifestItem.href),
      label: buildNavDocLabelFromHtml(html, manifestItem.id || manifestItem.href),
    })
  }

  const navHtml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeHtml(targetLanguage)}" xml:lang="${escapeHtml(targetLanguage)}">`,
    '<head>',
    '  <title>Navigation</title>',
    '</head>',
    '<body>',
    '  <nav epub:type="toc" id="toc">',
    '    <h1>Contents</h1>',
    '    <ol>',
    navEntries.map((entry) => `      <li><a href="${escapeHtml(entry.navHref)}">${escapeHtml(entry.label)}</a></li>`).join('\n'),
    '    </ol>',
    '  </nav>',
    '</body>',
    '</html>',
  ].join('\n')

  const ncxXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeHtml(normalizeText(toArray(pkg.metadata?.identifier)?.[0]?.['#text'] || toArray(pkg.metadata?.identifier)?.[0] || 'book'))}"/>`,
    '    <meta name="dtb:depth" content="1"/>',
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    '  <docTitle><text>Navigation</text></docTitle>',
    '  <navMap>',
    navEntries
      .map(
        (entry, index) => [
          `    <navPoint id="navPoint${index + 1}" playOrder="${index + 1}">`,
          `      <navLabel><text>${escapeHtml(entry.label)}</text></navLabel>`,
          `      <content src="${escapeHtml(entry.href)}"/>`,
          '    </navPoint>',
        ].join('\n')
      )
      .join('\n'),
    '  </navMap>',
    '</ncx>',
  ].join('\n')

  return { navHtml, ncxXml }
}

function repairBrokenLinksInXhtml(html, currentHref, existingRelativeHrefs) {
  const $ = cheerio.load(String(html || ''), { xmlMode: true })
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href') || ''
    if (!href || href.startsWith('http:') || href.startsWith('https:') || href.startsWith('mailto:')) {
      return
    }
    const resolved = resolvePath(currentHref, href)
    const relative = resolved.replace(/^.*?OEBPS\//, '')
    const fileOnly = relative.split('#')[0]
    if (!existingRelativeHrefs.has(fileOnly) && !existingRelativeHrefs.has(fileOnly.split('/').pop())) {
      $(element).replaceWith($(element).contents())
    }
  })
  return $.xml()
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

// ── Whole-section translation: sends entire HTML section to LLM for full-context translation ──

const WHOLE_SECTION_SYSTEM_PROMPT_CS = `Jsi profesionální překladatel knih do češtiny. Přeložíš celou HTML sekci najednou.

PRAVIDLA:
- Zachovej PŘESNĚ veškerou HTML strukturu: tagy, atributy, třídy, id, inline styly
- Přelož POUZE viditelný text uvnitř tagů
- Zachovej správné české rody po celé sekci (pokud je hlavní postava muž, drž mužský rod konzistentně)
- Používej přirozenou českou syntax a slovesné vazby
- Nepřekládej vlastní jména, názvy firem, technické termíny v originálním jazyce
- Nepřidávej žádné komentáře, vysvětlivky ani poznámky
- Vrať POUZE přeložený HTML, nic jiného`

async function translateWholeSection(provider, html, options) {
  const $ = cheerio.load(html, { xmlMode: true })
  const body = $('body').length ? $('body').html() : html
  const textContent = normalizeText($.text())
  if (!textContent) return html

  const raw = await withRetry(
    () =>
      translators[provider]({
        text: body,
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        format: 'html',
        settings: options.settings,
        systemPrompt: WHOLE_SECTION_SYSTEM_PROMPT_CS,
      }),
    { retries: 2, initialDelayMs: 1500, label: `${provider} whole-section` }
  )

  // Validate: must still contain HTML tags
  if (!raw || !/<[a-z]/i.test(raw)) {
    throw new Error(`Whole-section ${provider} translation returned non-HTML`)
  }

  // Re-inject translated body into original HTML shell (preserves <head>, <?xml?>, etc.)
  if ($('body').length) {
    let translated = raw.trim()
    // Strip wrapping <body> if the model added it
    const bodyMatch = translated.match(/<body[^>]*>([\s\S]*)<\/body>/i)
    if (bodyMatch?.[1]) translated = bodyMatch[1].trim()
    $('body').html(translated)
    return $.xml()
  }
  return raw
}

async function translateSectionWithFallback(provider, task, options) {
  const { section, trimmedHtml, texts } = task
  const isLlmProvider = ['openai', 'claude', 'glm'].includes(provider)

  if (!isLlmProvider) {
    const translationBatch = await withRetry(
      () => translateTexts(provider, texts, options),
      { retries: 3, initialDelayMs: 1000, label: `section "${section.title || section.id}"` }
    )

    return {
      mode: 'chunked',
      translationBatch,
      nextHtml: applyTranslationsToHtml(trimmedHtml, translationBatch.translations),
    }
  }

  try {
    const nextHtml = await translateWholeSection(provider, trimmedHtml, options)
    return {
      mode: 'whole-section',
      translationBatch: { cacheHits: 0, cacheMisses: texts.length },
      nextHtml,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error || 'Unknown error')
    console.warn(
      `[translateSectionWithFallback] ${provider} whole-section failed for "${section.title || section.id}", falling back to chunked mode: ${reason}`
    )

    const translationBatch = await withRetry(
      () => translateTexts(provider, texts, options),
      { retries: 3, initialDelayMs: 1000, label: `fallback section "${section.title || section.id}"` }
    )

    return {
      mode: 'chunk-fallback',
      translationBatch,
      nextHtml: applyTranslationsToHtml(trimmedHtml, translationBatch.translations),
    }
  }
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

function settingsFingerprint(settings = {}, provider = '') {
  if (!settings || typeof settings !== 'object') {
    return ''
  }

  const normalized = {}
  const usesOpenRouter =
    Boolean(settings.openrouter?.useForAll) && ['openai', 'claude', 'google', 'glm'].includes(provider)

  if (usesOpenRouter) {
    normalized.openrouter = {
      baseUrl: settings.openrouter?.baseUrl || '',
      model:
        provider === 'openai'
          ? settings.openrouter?.openaiModel || ''
          : provider === 'claude'
            ? settings.openrouter?.claudeModel || ''
            : provider === 'google'
              ? settings.openrouter?.googleModel || ''
              : settings.openrouter?.glmModel || settings.openrouter?.llamaModel || '',
    }
  } else if (provider === 'deepl') {
    normalized.deepl = {
      baseUrl: settings.deepl?.baseUrl || '',
      formality: settings.deepl?.formality || '',
      modelType: settings.deepl?.modelType || '',
      splitSentences: settings.deepl?.splitSentences || '',
      preserveFormatting: Boolean(settings.deepl?.preserveFormatting),
      context: settings.deepl?.context || '',
      customInstructions: settings.deepl?.customInstructions || '',
    }
  } else if (provider === 'openai') {
    normalized.openai = {
      model: settings.openai?.model || '',
    }
  } else if (provider === 'google') {
    normalized.google = {
      project: settings.google?.project || '',
    }
  } else if (provider === 'claude') {
    normalized.claude = {
      model: settings.claude?.model || '',
    }
  } else if (provider === 'glm') {
    normalized.glm = {
      baseUrl: settings.glm?.baseUrl || '',
      model: settings.glm?.model || '',
    }
  }

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function resolveOpenRouterConfig(settings = {}) {
  const rawApiKey =
    settings?.openrouter?.apiKey ||
    process.env.OPENROUTER_API_KEY ||
    ''
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : ''
  return {
    apiKey,
    baseUrl: settings?.openrouter?.baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    useForAll:
      settings?.openrouter?.useForAll !== undefined
        ? Boolean(settings.openrouter.useForAll)
        : String(process.env.OPENROUTER_USE_FOR_ALL || 'true') !== 'false',
    openaiModel: settings?.openrouter?.openaiModel || process.env.OPENROUTER_OPENAI_MODEL || 'openai/gpt-5.4',
    openaiReviewModel:
      settings?.openrouter?.openaiReviewModel || process.env.OPENROUTER_OPENAI_REVIEW_MODEL || 'openai/gpt-5-mini',
    claudeModel:
      settings?.openrouter?.claudeModel || process.env.OPENROUTER_CLAUDE_MODEL || 'anthropic/claude-sonnet-4.6',
    claudeReviewModel:
      settings?.openrouter?.claudeReviewModel ||
      process.env.OPENROUTER_CLAUDE_REVIEW_MODEL ||
      'anthropic/claude-3.5-haiku',
    googleModel:
      settings?.openrouter?.googleModel || process.env.OPENROUTER_GOOGLE_MODEL || 'google/gemini-2.5-pro',
    glmModel:
      settings?.openrouter?.glmModel || process.env.OPENROUTER_GLM_MODEL || 'z-ai/glm-5',
  }
}

function buildReviewSettings(provider, settings = {}) {
  if (!settings || typeof settings !== 'object') {
    return settings
  }

  if (provider === 'claude') {
    const reviewModel =
      settings?.openrouter?.claudeReviewModel ||
      process.env.OPENROUTER_CLAUDE_REVIEW_MODEL ||
      ''
    if (!reviewModel) return settings
    return {
      ...settings,
      openrouter: {
        ...(settings.openrouter || {}),
        claudeModel: reviewModel,
      },
      claude: {
        ...(settings.claude || {}),
        model: settings?.claude?.reviewModel || process.env.ANTHROPIC_REVIEW_MODEL || settings?.claude?.model,
      },
    }
  }

  if (provider === 'openai') {
    const reviewModel =
      settings?.openrouter?.openaiReviewModel ||
      process.env.OPENROUTER_OPENAI_REVIEW_MODEL ||
      ''
    return {
      ...settings,
      openrouter: reviewModel
        ? {
            ...(settings.openrouter || {}),
            openaiModel: reviewModel,
          }
        : { ...(settings.openrouter || {}) },
      openai: {
        ...(settings.openai || {}),
        model: settings?.openai?.reviewModel || process.env.OPENAI_REVIEW_MODEL || settings?.openai?.model,
      },
    }
  }

  return settings
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

function providerTimeoutSignal(timeoutMs = 120000) {
  return AbortSignal.timeout(timeoutMs)
}

function providerTimeoutMs(provider, baseTimeoutMs = 120000) {
  if (['openai', 'claude', 'glm'].includes(provider)) {
    return 240000
  }
  return baseTimeoutMs
}

function normalizeProviderError(error, provider) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error')
  if (
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    /aborted|timeout/i.test(message)
  ) {
    return new Error(`Provider ${provider} neodpověděl do ${Math.round(providerTimeoutMs(provider) / 1000)} sekund.`)
  }
  return error instanceof Error ? error : new Error(message)
}

async function translateWithOpenRouter({ provider, text, sourceLanguage, targetLanguage, format = 'text', settings, systemPrompt }) {
  const openrouter = resolveOpenRouterConfig(settings)
  if (!openrouter.apiKey) {
    throw new Error('Chybí OPENROUTER_API_KEY')
  }

  const model = getOpenRouterModelForProvider(provider, settings)
  if (!model) {
    throw new Error(`Pro provider ${provider} chybí OpenRouter model.`)
  }

  const defaultSystemPrompt =
    format === 'html'
      ? 'Translate non-fiction book content inside HTML fragments. Preserve the exact HTML tag structure, keep tags unchanged, translate only visible text nodes, and output HTML only.'
      : 'You translate non-fiction book content faithfully. Preserve terminology, named entities, chronology, and explanatory clarity. Output translation only.'

  const response = await fetch(`${String(openrouter.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: providerTimeoutSignal(providerTimeoutMs(provider)),
    headers: {
      Authorization: `Bearer ${openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 16384,
      messages: [
        {
          role: 'system',
          content: systemPrompt || defaultSystemPrompt,
        },
        {
          role: 'user',
          content: systemPrompt
            ? text
            : `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const keyPrefix = openrouter.apiKey ? openrouter.apiKey.slice(0, 7) : ''
    const keyLength = openrouter.apiKey?.length || 0
    console.error('[openrouter]', {
      provider,
      status: response.status,
      hasAuthHeader: Boolean(openrouter.apiKey),
      keyPrefix,
      keyLength,
      model,
      usedBaseUrl: String(openrouter.baseUrl).replace(/\/$/, ''),
    })
    throw new Error(
      `OpenRouter request failed: ${response.status} ${body.slice(0, 200)} [keyPrefix=${keyPrefix || '∅'}, keyLen=${keyLength}, model=${model}]`
    )
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
        settings: settingsFingerprint(options.settings, provider),
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
    try {
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
    } catch (error) {
      throw normalizeProviderError(error, provider)
    }
  }

  if (provider === 'google') {
    try {
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
    } catch (error) {
      throw normalizeProviderError(error, provider)
    }
  }

  if (['openai', 'claude', 'glm'].includes(provider) && misses.length) {
    // Try full-size batches first, then retry with half-size batches on failure.
    // Never fall back to serial (1-by-1) — it's 10-50x more expensive.
    let lastError = null
    for (const batchSize of [24, 10, 4]) {
      try {
        const missingTranslations = await translateManyWithLlm(
          provider,
          misses,
          { ...options, _batchOverride: { maxItems: batchSize, maxChars: batchSize * 750 } }
        )
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
        saveCache(cache)
        return { translations, cacheHits, cacheMisses: misses.length }
      } catch (error) {
        lastError = error
        console.warn(`[translateTexts] ${provider} batch (size=${batchSize}) failed, trying smaller`, error?.message)
      }
    }
    throw normalizeProviderError(lastError, provider)
  }

  // Non-LLM providers: serial as before
  for (const item of misses) {
    let output = ''
    try {
      output = await translators[provider]({
        text: item.source,
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        format: item.format,
        settings: options.settings,
      })
    } catch (error) {
      throw normalizeProviderError(error, provider)
    }
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

function chunkTranslationMisses(misses, { maxItems = 24, maxChars = 18000 } = {}) {
  const chunks = []
  let current = []
  let currentChars = 0

  for (const item of misses) {
    const itemChars = String(item.source || '').length
    if (current.length && (current.length >= maxItems || currentChars + itemChars > maxChars)) {
      chunks.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += itemChars
  }

  if (current.length) {
    chunks.push(current)
  }

  return chunks
}

function extractJsonTranslationArray(raw) {
  const text = String(raw || '').trim()
  const candidates = [
    text,
    text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim(),
  ]

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch?.[0]) {
    candidates.push(arrayMatch[0])
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {
        return parsed.map((item) =>
          typeof item === 'string'
            ? item
            : String(item?.translation || item?.text || item?.value || '')
        )
      }
      if (Array.isArray(parsed?.translations)) {
        return parsed.translations.map((item) =>
          typeof item === 'string'
            ? item
            : String(item?.translation || item?.text || item?.value || '')
        )
      }
    } catch {}
  }

  return null
}

async function translateManyWithLlm(provider, misses, options) {
  const chunks = chunkTranslationMisses(misses, options._batchOverride)
  const LLM_CONCURRENCY = 4
  const outputs = new Array(chunks.length)
  const abortController = new AbortController()

  for (let start = 0; start < chunks.length; start += LLM_CONCURRENCY) {
    const batch = chunks.slice(start, start + LLM_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (chunk) => {
        if (abortController.signal.aborted) throw new Error('Batch aborted due to earlier failure')
        // Send compact payload: just an array of strings — saves ~30% input tokens
        const texts = chunk.map((item) => item.source)
        const hasHtml = chunk.some((item) => item.format === 'html')

        const raw = await withRetry(
          () =>
            translators[provider]({
              text:
                `Translate from ${options.sourceLanguage || 'auto'} to ${options.targetLanguage || 'cs'}. ` +
                `Return ONLY a JSON array of ${texts.length} translated strings, same order.` +
                (hasHtml ? ' Preserve HTML tags, translate only text.' : '') +
                '\n\n' + JSON.stringify(texts),
              sourceLanguage: options.sourceLanguage,
              targetLanguage: options.targetLanguage,
              format: 'text',
              settings: options.settings,
            }),
          { retries: 2, initialDelayMs: 800, label: `${provider} batch translation` }
        )

        const parsed = extractJsonTranslationArray(raw)
        if (!parsed || parsed.length !== chunk.length) {
          abortController.abort()
          throw new Error(`Batched ${provider} translation returned ${parsed?.length ?? 'null'} items, expected ${chunk.length}.`)
        }
        return parsed
      })
    )
    results.forEach((parsed, i) => { outputs[start + i] = parsed })
  }

  return outputs.flat()
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
  let totalCharacters = 0

  for (const section of includedSections) {
    const file = zip.file(section.href)
    if (!file) {
      continue
    }

    const html = await file.async('string')
    const measured = countTranslatableNodes(html)
    totalBlocks += measured.count
    totalWords += section.stats?.wordCount || 0
    totalCharacters += section.stats?.charCount || 0
    sectionPlans.push({
      id: section.id,
      href: section.href,
      title: section.title,
      blockCount: measured.count,
      wordCount: section.stats?.wordCount || 0,
      charCount: section.stats?.charCount || 0,
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
    totalCharacters,
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
  return html
}

function pruneNcxDocument(xml, includedHrefs) {
  return xml
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

export async function exportEpubToHtml(payload) {
  const {
    buffer,
    fileName = 'book.epub',
    sourceLanguage = '',
    targetLanguage = 'cs',
    sections = [],
  } = payload || {}

  if (!buffer) {
    throw new Error('Chybí zdrojový EPUB buffer.')
  }

  const zip = await JSZip.loadAsync(buffer)
  const packagePath = await readContainer(zip)
  const pkg = await readPackage(zip, packagePath)
  const includedSections = sections.filter((section) => section.includeInTranslation)

  const exportedSections = []
  for (const section of includedSections) {
    const file = zip.file(section.href)
    if (!file) {
      continue
    }
    const html = await file.async('string')
    exportedSections.push({
      id: section.id,
      href: section.href,
      title: section.title,
      bodyHtml: extractBodyInnerHtml(html),
    })
  }

  const title = normalizeText(toArray(pkg.metadata?.title)?.[0]?.['#text'] || toArray(pkg.metadata?.title)?.[0] || fileName)
  const author = normalizeText(toArray(pkg.metadata?.creator)?.[0]?.['#text'] || toArray(pkg.metadata?.creator)?.[0] || '')
  const html = [
    '<!doctype html><html lang="', escapeHtml(targetLanguage || 'cs'),
    '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="ebook-source-language" content="', escapeHtml(sourceLanguage || ''), '">',
    '<meta name="ebook-target-language" content="', escapeHtml(targetLanguage || 'cs'), '">',
    '<title>', escapeHtml(title), author ? ` — ${escapeHtml(author)}` : '', '</title>',
    '<style>body{font-family:Georgia,\"Times New Roman\",serif;line-height:1.6;margin:0;color:#1b1b1b;background:#faf8f2}main{max-width:900px;margin:0 auto;padding:28px 18px 72px}.ebook-meta{margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid #d8d1c2}.ebook-title{font-size:34px;margin:0 0 6px}.ebook-author{font-size:20px;margin:0 0 12px;color:#5e5a52}.ebook-note{font-size:13px;color:#6c675d}.ebook-section{margin:0 0 32px;padding-bottom:24px;border-bottom:1px solid #e5dfd1}.ebook-section-title{font-size:22px;margin:0 0 14px}.ebook-section-body{display:block}</style>',
    '</head><body><main><header class="ebook-meta"><h1 class="ebook-title">', escapeHtml(title), '</h1>',
    author ? `<p class="ebook-author">${escapeHtml(author)}</p>` : '',
    '<p class="ebook-note">Zachovej HTML tagy a atributy uvnitř sekcí. Nepřekládej technické identifikátory v atributech.</p></header>',
    exportedSections.map((section) =>
      `<article class="ebook-section" data-ebook-id="${escapeHtml(section.id)}"><h2 class="ebook-section-title">${escapeHtml(section.title)}</h2><div class="ebook-section-body">${section.bodyHtml.trim()}</div></article>`
    ).join(''),
    '</main></body></html>',
  ].join('')

  const htmlBytes = Buffer.byteLength(html, 'utf8')
  if (htmlBytes > 4_200_000) {
    throw new Error('HTML export je pro nasazení příliš velký. Zkus menší rozsah knihy nebo lokální běh.')
  }

  return {
    html,
    fileName: buildHtmlExportFileName(pkg.metadata, fileName, targetLanguage),
    stats: {
      sections: exportedSections.length,
      words: includedSections.reduce((sum, section) => sum + (section.stats?.wordCount || 0), 0),
      characters: includedSections.reduce((sum, section) => sum + (section.stats?.characterCount || 0), 0),
    },
  }
}

export async function importTranslatedHtmlToEpub(payload) {
  const {
    buffer,
    translatedHtml = '',
    fileName = 'book.epub',
    targetLanguage = 'cs',
    sections = [],
  } = payload || {}

  if (!buffer) {
    throw new Error('Chybí zdrojový EPUB buffer.')
  }
  const normalizedTranslatedHtml = normalizeImportedHtmlArtifacts(translatedHtml)
  if (!normalizedTranslatedHtml.trim()) {
    throw new Error('Chybí přeložený HTML obsah.')
  }

  const zip = await JSZip.loadAsync(buffer)
  const packagePath = await readContainer(zip)
  const pkg = await readPackage(zip, packagePath)
  const packageXml = await readPackageXml(zip, packagePath)
  const translatedDoc = cheerio.load(normalizedTranslatedHtml)

  const sectionNodes = translatedDoc('[data-ebook-id]')
  const generatorMeta = translatedDoc('meta[name="generator"]').attr('content') || ''
  if (!sectionNodes.length) {
    if (/pdf2htmlex/i.test(generatorMeta) || /pdf2htmlex/i.test(translatedHtml)) {
      throw new Error('Nahraný HTML soubor vypadá jako export z PDF, ne jako HTML export z EPUB Translatoru.')
    }
    throw new Error('Nahraný HTML soubor není ve formátu EPUB Translator exportu.')
  }

  const translatedSections = new Map()
  sectionNodes.each((_index, element) => {
    const id = translatedDoc(element).attr('data-ebook-id') || ''
    const bodyHtml = translatedDoc(element).find('.ebook-section-body').first().html() || ''
    if (id && bodyHtml.trim()) {
      translatedSections.set(id, bodyHtml.trim())
    }
  })

  if (!translatedSections.size) {
    throw new Error('HTML export neobsahuje žádné přeložitelné sekce s tělem.')
  }

  let importedCount = 0
  for (const section of sections.filter((item) => item.includeInTranslation)) {
    const file = zip.file(section.href)
    const translatedBody = translatedSections.get(section.id)
    if (!file || !translatedBody) {
      continue
    }
    const originalHtml = await file.async('string')
    const normalizedSectionHtml = normalizeXhtmlDocument(
      injectBodyInnerHtml(originalHtml, translatedBody),
      targetLanguage
    )
    validateXhtmlDocument(normalizedSectionHtml, section.href)
    zip.file(section.href, normalizedSectionHtml)
    importedCount += 1
  }

  zip.file(packagePath, updateOpfMetadata(packageXml, targetLanguage))

  const orderedZip = new JSZip()
  orderedZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  for (const [name, zipEntry] of Object.entries(zip.files)) {
    if (name === 'mimetype' || zipEntry.dir) continue
    const content = await zipEntry.async('nodebuffer')
    orderedZip.file(name, content)
  }

  const rebuilt = await orderedZip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  validateEpubBuffer(rebuilt, fileName)

  return {
    buffer: rebuilt,
    fileName: buildOutputFileName(pkg.metadata, fileName, targetLanguage),
    stats: {
      importedSections: importedCount,
      availableSections: translatedSections.size,
    },
  }
}

export async function reviewTranslatedHtml(payload) {
  const {
    originalHtml = '',
    translatedHtml = '',
    provider = 'claude',
    settings = {},
    onProgress,
  } = payload || {}

  const normalizedOriginalHtml = String(originalHtml || '')
  const normalizedTranslatedHtml = normalizeImportedHtmlArtifacts(translatedHtml)
  if (!normalizedOriginalHtml.trim()) {
    throw new Error('Chybí původní HTML export pro kontrolu.')
  }
  if (!normalizedTranslatedHtml.trim()) {
    throw new Error('Chybí přeložené HTML pro kontrolu.')
  }
  if (!['claude', 'openai'].includes(provider)) {
    throw new Error('Kontrola HTML podporuje jen Claude Sonnet 4.6 a OpenAI GPT-5.4.')
  }

  const { doc: originalDoc, sectionMap: originalSections } = extractHtmlSectionsDocument(normalizedOriginalHtml)
  const { doc: reviewedDoc, sectionMap: translatedSections } = extractHtmlSectionsDocument(normalizedTranslatedHtml)
  if (!originalSections.size || !translatedSections.size) {
    throw new Error('Originální nebo přeložené HTML neobsahuje sekce pro kontrolu.')
  }

  const targetIds = [...originalSections.keys()].filter((id) => translatedSections.has(id))
  let processedSections = 0
  let changedSections = 0
  let findingsCount = 0
  let autoAppliedCount = 0
  let scannedCharacters = 0
  let flaggedCharacters = 0
  let currentSectionTitle = ''
  let currentSectionId = ''
  const sectionAudits = []
  const recentFindings = []
  let flaggedBlocksCount = 0
  let skippedBlocksCount = 0

  const reportProgress = async (stage) => {
    if (!onProgress) return
    await onProgress({
      stage,
      processedSections,
      totalSections: targetIds.length,
      currentSectionId,
      currentSectionTitle,
      changedSections,
      findingsCount,
      autoAppliedCount,
      recentFindings: recentFindings.slice(-12).reverse(),
      percent: targetIds.length
        ? Number(((processedSections / targetIds.length) * 100).toFixed(2))
        : 100,
    })
  }

  const CONCURRENCY = Math.max(1, Math.min(8, targetIds.length))
  let cursor = 0

  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= targetIds.length) return
      const sectionId = targetIds[index]
      const sourceSection = originalSections.get(sectionId)
      const translatedSection = translatedSections.get(sectionId)
      if (!sourceSection?.bodyHtml?.trim() || !translatedSection?.bodyHtml?.trim()) {
        processedSections += 1
        currentSectionId = sectionId
        currentSectionTitle = translatedSection?.title || sourceSection?.title || sectionId
        await reportProgress('reviewing-html')
        continue
      }

      currentSectionId = sectionId
      currentSectionTitle = translatedSection.title || sourceSection.title || sectionId
      await reportProgress('reviewing-html-section')

      const originalBlocks = getTranslatableNodePayloads(sourceSection.bodyHtml)
      const translatedBlocks = getTranslatableNodePayloads(translatedSection.bodyHtml)
      const comparableLength = Math.min(originalBlocks.length, translatedBlocks.length)
      const auditBlocks = Array.from({ length: comparableLength }, (_unused, blockIndex) => ({
        index: blockIndex,
        tagName: translatedBlocks[blockIndex]?.tagName || originalBlocks[blockIndex]?.tagName || 'p',
        originalPlainText: originalBlocks[blockIndex]?.plainText || '',
        translatedPlainText: translatedBlocks[blockIndex]?.plainText || '',
        translatedSource: translatedBlocks[blockIndex]?.source || '',
      })).filter((block) => block.originalPlainText && block.translatedPlainText)

      const flaggedBlocks = filterAuditBlocks(auditBlocks)
      flaggedBlocksCount += flaggedBlocks.length
      skippedBlocksCount += Math.max(0, auditBlocks.length - flaggedBlocks.length)
      scannedCharacters += auditBlocks.reduce(
        (sum, block) => sum + String(block.originalPlainText || '').length + String(block.translatedPlainText || '').length,
        0
      )
      flaggedCharacters += flaggedBlocks.reduce(
        (sum, block) => sum + String(block.originalPlainText || '').length + String(block.translatedPlainText || '').length,
        0
      )

      let findings = []
      if (flaggedBlocks.length) {
        try {
          const chunkSize = 6
          for (let start = 0; start < flaggedBlocks.length; start += chunkSize) {
            const batch = flaggedBlocks.slice(start, start + chunkSize)
            const batchFindings = await auditHtmlBlocksWithLlm({
              provider,
              sectionTitle: currentSectionTitle,
              blocks: batch,
              settings,
            })
            findings.push(...batchFindings)
          }
        } catch (error) {
          console.error(
            `[reviewTranslatedHtml] section ${sectionId} audit failed, keeping original translation:`,
            error instanceof Error ? error.message : error
          )
          findings = []
        }
      }

      findings = findings
        .map((finding) => {
          const block = auditBlocks[finding.index]
          const autoApplied = shouldAutoApplyAuditFinding(finding, block)
          return {
            ...finding,
            autoApplied,
            originalText: block?.originalPlainText || '',
            translatedText: block?.translatedPlainText || '',
            suggestedText: normalizeText(
              cheerio.load(`<body>${finding.suggestedHtml || ''}</body>`, { xmlMode: true })('body').text()
            ),
          }
        })
        .filter((finding) => auditBlocks[finding.index])

      findingsCount += findings.length
      autoAppliedCount += findings.filter((finding) => finding.autoApplied).length
      recentFindings.push(
        ...findings
          .filter((finding) => finding.suggestedText)
          .map((finding) => ({
            sectionId,
            title: currentSectionTitle,
            index: finding.index,
            issueType: finding.issueType,
            severity: finding.severity,
            confidence: finding.confidence,
            reason: finding.reason,
            autoApplied: finding.autoApplied,
            beforeText: finding.translatedText,
            afterText: finding.suggestedText,
          }))
      )
      if (recentFindings.length > 30) {
        recentFindings.splice(0, recentFindings.length - 30)
      }

      let nextSectionHtml = translatedSection.bodyHtml
      const appliedPayloads = [...translatedBlocks]
      let sectionChanged = false
      for (const finding of findings) {
        if (!finding.autoApplied) continue
        const current = appliedPayloads[finding.index]
        if (!current) continue
        appliedPayloads[finding.index] = {
          ...current,
          source: finding.suggestedHtml,
          plainText: normalizeText(cheerio.load(`<body>${finding.suggestedHtml}</body>`, { xmlMode: true })('body').text()),
        }
        sectionChanged = true
      }

      if (sectionChanged) {
        nextSectionHtml = applyTranslationsToHtml(translatedSection.bodyHtml, appliedPayloads.map((item) => item.source))
        const sectionNode = reviewedDoc(`[data-ebook-id="${sectionId}"]`).first()
        sectionNode.find('.ebook-section-body').first().html(nextSectionHtml)
        changedSections += 1
      }

      sectionAudits.push({
        sectionId,
        title: currentSectionTitle,
        scannedBlockCount: auditBlocks.length,
        flaggedBlockCount: flaggedBlocks.length,
        scannedCharacters: auditBlocks.reduce(
          (sum, block) => sum + String(block.originalPlainText || '').length + String(block.translatedPlainText || '').length,
          0
        ),
        flaggedCharacters: flaggedBlocks.reduce(
          (sum, block) => sum + String(block.originalPlainText || '').length + String(block.translatedPlainText || '').length,
          0
        ),
        findingCount: findings.length,
        autoAppliedCount: findings.filter((finding) => finding.autoApplied).length,
        findings: findings.slice(0, 20),
      })

      processedSections += 1
      await reportProgress('reviewing-html')
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)

  const title = normalizeText(originalDoc('.ebook-title').first().text())
  const author = normalizeText(originalDoc('.ebook-author').first().text())

  return {
    html: reviewedDoc.html(),
    stats: {
      totalSections: targetIds.length,
      processedSections,
      changedSections,
      findingsCount,
      autoAppliedCount,
      flaggedBlocksCount,
      skippedBlocksCount,
      scannedCharacters,
      flaggedCharacters,
      title,
      author,
    },
    audit: {
      sections: sectionAudits,
      summary: summarizeAudit(sectionAudits.flatMap((section) => section.findings)),
    },
  }
}

export async function repairPackagedEpub(payload) {
  const {
    buffer,
    fileName = 'book.epub',
    targetLanguage = 'cs',
  } = payload || {}

  if (!buffer) {
    throw new Error('Chybí EPUB buffer pro opravu.')
  }

  const zip = await JSZip.loadAsync(buffer)
  const packagePath = await readContainer(zip)
  const pkg = await readPackage(zip, packagePath)
  let packageXml = await readPackageXml(zip, packagePath)
  const manifestItems = toArray(pkg.manifest?.item).map((item) => ({
    ...item,
    href: resolvePath(packagePath, item.href),
  }))
  const existingRelativeHrefs = new Set(
    Object.keys(zip.files)
      .filter((name) => !zip.files[name].dir)
      .map((name) => relativeHref(packagePath, name))
  )

  let repairedFiles = 0
  for (const item of manifestItems) {
    const mediaType = item['media-type'] || ''
    if (!/html|xhtml/i.test(mediaType)) {
      continue
    }
    const file = zip.file(item.href)
    if (!file) {
      continue
    }
    const html = await file.async('string')
    const linked = repairBrokenLinksInXhtml(html, item.href, existingRelativeHrefs)
    const repaired = normalizeXhtmlDocument(linked, targetLanguage)
    validateXhtmlDocument(repaired, item.href)
    zip.file(item.href, repaired)
    repairedFiles += 1
  }

  const navFullPath = resolvePath(packagePath, 'xhtml/nav.xhtml')
  const navRelativePath = relativeHref(packagePath, navFullPath)
  const { navHtml, ncxXml } = await buildRepairNavigationDocuments({
    zip,
    pkg,
    packagePath,
    targetLanguage,
  })
  zip.file(navFullPath, navHtml)
  existingRelativeHrefs.add(navRelativePath)

  const ncxItem = manifestItems.find((item) => /ncx/i.test(item['media-type'] || '') || /\.ncx$/i.test(item.href))
  if (ncxItem?.href) {
    zip.file(ncxItem.href, ncxXml)
    existingRelativeHrefs.add(relativeHref(packagePath, ncxItem.href))
  }

  packageXml = updateOpfMetadata(packageXml, targetLanguage)
  packageXml = ensureManifestNavItem(packageXml, navRelativePath)
  packageXml = pruneGuideReferences(packageXml, existingRelativeHrefs)
  zip.file(packagePath, packageXml)

  const orderedZip = new JSZip()
  orderedZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  for (const [name, zipEntry] of Object.entries(zip.files)) {
    if (name === 'mimetype' || zipEntry.dir) continue
    const content = await zipEntry.async('nodebuffer')
    orderedZip.file(name, content)
  }

  const rebuilt = await orderedZip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  validateEpubBuffer(rebuilt, fileName)

  return {
    buffer: rebuilt,
    fileName: buildOutputFileName(pkg.metadata, fileName, targetLanguage),
    stats: {
      repairedFiles,
    },
  }
}

export function buildProviderMatrix() {
  return [
    {
      id: 'claude',
      label: 'Claude Sonnet 4.6',
      tier: 'Doporučený',
      bestFor: 'Nejlepší čeština — přirozené rody, plynulá syntax, kontextový překlad celých sekcí.',
      setup: 'OpenRouter API key',
      strengths: ['přirozená čeština', 'konzistentní rody', 'celé sekce najednou', 'velký kontext'],
      caution: 'Pomalejší než DeepL, ale výrazně přirozenější výstup.',
      // Claude Sonnet 4.6 via OpenRouter: $3/1M input + $15/1M output tokenů
      // Whole-section: ~4 tokenů/znak (CZ), input+output → ~$4.50/1M znaků → €4.14
      ratePerMillionCharsEur: 4.1,
    },
    {
      id: 'openai',
      label: 'OpenAI GPT-5.4',
      tier: 'Alternativa',
      bestFor: 'Silný překlad s dobrým uvažováním, mírně horší čeština než Claude.',
      setup: 'OpenRouter API key',
      strengths: ['long context', 'reasoning', 'celé sekce najednou'],
      caution: 'Občas nepřirozené české vazby.',
      // GPT-5.4 via OpenRouter: $2.50/1M input + $15/1M output tokenů
      // ~$4.40/1M znaků → €4.05
      ratePerMillionCharsEur: 4.1,
    },
    {
      id: 'deepl',
      label: 'DeepL',
      tier: 'Rychlý',
      bestFor: 'Nejrychlejší překlad, dobrá základní kvalita, problémy s českými rody.',
      setup: 'DEEPL_API_KEY',
      strengths: ['rychlost', 'glossary', 'nízká latence'],
      caution: 'Často chybné rody v češtině, méně přirozená syntax.',
      // DeepL API Pro: €25/1M znaků
      ratePerMillionCharsEur: 25,
    },
    {
      id: 'google',
      label: 'Google Cloud Translation',
      tier: 'Terminologie',
      bestFor: 'Glossary a odborná terminologie.',
      setup: 'GOOGLE_CLOUD_ACCESS_TOKEN + GOOGLE_CLOUD_PROJECT',
      strengths: ['adaptive translation', 'glossary'],
      caution: 'Složitější autentizace.',
      // Google Cloud Translation Advanced: $20/1M znaků → €18.40
      ratePerMillionCharsEur: 18.4,
    },
    {
      id: 'glm',
      label: 'GLM 5.1',
      tier: 'Levný',
      bestFor: 'Nejlevnější LLM překlad, přijatelná kvalita.',
      setup: 'OpenRouter API key',
      strengths: ['nízká cena', 'multilingual'],
      caution: 'Nižší kvalita češtiny.',
      // GLM 5.1 via OpenRouter: ~$0.30/1M znaků → €0.28
      ratePerMillionCharsEur: 0.28,
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

async function translateWithOpenAI({ text, sourceLanguage, targetLanguage, format = 'text', settings, systemPrompt }) {
  if (shouldUseOpenRouter('openai', settings)) {
    return translateWithOpenRouter({ provider: 'openai', text, sourceLanguage, targetLanguage, format, settings, systemPrompt })
  }
  const rawKey = settings?.openai?.apiKey || process.env.OPENAI_API_KEY || ''
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!apiKey) {
    throw new Error('Chybí OPENAI_API_KEY nebo OPENROUTER_API_KEY pro GPT.')
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: providerTimeoutSignal(providerTimeoutMs('openai')),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings?.openai?.model || process.env.OPENAI_TRANSLATION_MODEL || 'gpt-5.4',
      max_output_tokens: 16384,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                systemPrompt ||
                (format === 'html'
                  ? 'You translate non-fiction book content inside HTML fragments. Preserve the exact HTML tag structure, keep tags unchanged, translate only visible text nodes, and output HTML only.'
                  : 'You translate non-fiction book content. Preserve factual meaning, named entities, chronology, and terminology. Do not add commentary.'),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: systemPrompt
                ? text
                : `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
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
  return payload.output_text || payload.output?.[0]?.content?.[0]?.text || ''
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

async function translateWithClaude({ text, sourceLanguage, targetLanguage, format = 'text', settings, systemPrompt }) {
  if (shouldUseOpenRouter('claude', settings)) {
    return translateWithOpenRouter({ provider: 'claude', text, sourceLanguage, targetLanguage, format, settings, systemPrompt })
  }
  const rawKey = settings?.claude?.apiKey || process.env.ANTHROPIC_API_KEY || ''
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!apiKey) {
    throw new Error('Chybí ANTHROPIC_API_KEY nebo OPENROUTER_API_KEY pro Claude Sonnet.')
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: providerTimeoutSignal(providerTimeoutMs('claude')),
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:
        settings?.claude?.model || process.env.ANTHROPIC_TRANSLATION_MODEL || 'claude-sonnet-4-6',
      max_tokens: 16384,
      system:
        systemPrompt ||
        (format === 'html'
          ? 'Translate non-fiction book text inside HTML fragments. Preserve the exact HTML tags and structure, translate only the visible text, and output HTML only.'
          : 'Translate non-fiction book text faithfully. Preserve terminology, names, chronology, and explanatory clarity. Output translation only.'),
      messages: [
        {
          role: 'user',
          content: systemPrompt
            ? text
            : `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
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

async function translateWithGlm({ text, sourceLanguage, targetLanguage, format = 'text', settings, systemPrompt }) {
  if (shouldUseOpenRouter('glm', settings)) {
    return translateWithOpenRouter({ provider: 'glm', text, sourceLanguage, targetLanguage, format, settings, systemPrompt })
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
    signal: providerTimeoutSignal(providerTimeoutMs('glm')),
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 16384,
      messages: [
        {
          role: 'system',
          content:
            systemPrompt ||
            (format === 'html'
              ? 'Translate non-fiction book content inside HTML fragments. Preserve the exact HTML tag structure, keep tags unchanged, translate only visible text nodes, and output HTML only.'
              : 'You translate non-fiction book content faithfully. Preserve terminology, named entities, chronology, and explanatory clarity. Output translation only.'),
        },
        {
          role: 'user',
          content: systemPrompt
            ? text
            : `Source language: ${sourceLanguage || 'auto'}\nTarget language: ${targetLanguage || 'cs'}\n\nText:\n${text}`,
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
  const previewSamples = collectRepresentativeTextPreview(selected, maxWords, Number(previewPageCount || 2))

  for (const sample of previewSamples) {
    if (!sample.text) {
      continue
    }

    previewParts.push(sample.text)
    previewSections.push({
      id: sample.id,
      title: sample.title,
      wordCount: sample.wordCount,
    })
    collectedWords += sample.wordCount
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
  const previewBlocks = await collectRepresentativePreviewBlocks({
    zip,
    sections: selected,
    maxWords,
    sampleCount: Number(previewPageCount || 2),
  })
  const collectedWords = previewBlocks.reduce(
    (sum, block) => sum + block.plainText.split(/\s+/).filter(Boolean).length,
    0
  )

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

  const sourceHtml = previewBlocks
    .map((block) => `<${block.tagName || 'p'}>${block.source}</${block.tagName || 'p'}>`)
    .join('\n')
  const useSinglePreviewRequest = ['openai', 'claude', 'glm'].includes(provider)

  let translatedHtml = ''
  let translatedText = ''

  if (useSinglePreviewRequest) {
    const translator = translators[provider]
    const translatedCombined =
      provider === 'identity'
        ? sourceHtml
        : await translator({
            text: sourceHtml,
            sourceLanguage,
            targetLanguage,
            format: 'html',
            settings,
          })

    translatedHtml = translatedCombined || ''
    translatedText = normalizeText(cheerio.load(`<body>${translatedHtml}</body>`, { xmlMode: true })('body').text())
  } else {
    const translationBatch = await translateTexts(provider, previewBlocks, {
      sourceLanguage,
      targetLanguage,
      settings,
    })

    translatedHtml = translationBatch.translations
      .map(
        (block, index) =>
          `<${previewBlocks[index]?.tagName || 'p'}>${block}</${previewBlocks[index]?.tagName || 'p'}>`
      )
      .join('\n')
    translatedText = translationBatch.translations
      .map((block) => normalizeText(cheerio.load(`<body>${block}</body>`, { xmlMode: true })('body').text()))
      .join('\n\n')
  }

  return {
    provider,
    sourceText: previewBlocks.map((block) => block.plainText).join('\n\n'),
    translatedText,
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

function sectionWordCount(section) {
  return Number(section?.stats?.wordCount || section?.wordCount || 0)
}

function chunkSectionsForPreview(sections, sampleCount) {
  const normalizedCount = Math.max(1, Math.min(sampleCount || 2, sections.length || 1))
  const meaningful = sections.filter((section) => sectionWordCount(section) >= 80)
  const usable = meaningful.length ? meaningful : sections.filter((section) => sectionWordCount(section) > 0)
  const source = usable.length ? usable : sections

  if (!source.length) {
    return []
  }

  const buckets = []
  for (let index = 0; index < normalizedCount; index += 1) {
    const start = Math.floor((index * source.length) / normalizedCount)
    const end = Math.floor(((index + 1) * source.length) / normalizedCount)
    const bucket = source.slice(start, Math.max(start + 1, end))
    if (bucket.length) {
      buckets.push(bucket)
    }
  }

  return buckets
}

function pickSectionFromBucket(bucket) {
  if (!bucket.length) {
    return null
  }

  const ranked = [...bucket].sort((left, right) => sectionWordCount(right) - sectionWordCount(left))
  const topSlice = ranked.slice(0, Math.min(3, ranked.length))
  const picked = topSlice[Math.floor(Math.random() * topSlice.length)]
  return picked || ranked[0] || bucket[0]
}

function collectRepresentativeTextPreview(sections, maxWords, sampleCount) {
  const buckets = chunkSectionsForPreview(sections, sampleCount)
  const samples = []
  const wordsPerSample = Math.max(120, Math.floor(maxWords / Math.max(1, buckets.length)))

  for (const bucket of buckets) {
    const section = pickSectionFromBucket(bucket)
    if (!section) {
      continue
    }

    const words = normalizeText(section.plainText).split(/\s+/).filter(Boolean)
    if (!words.length) {
      continue
    }

    const maxStart = Math.max(0, words.length - wordsPerSample)
    const startIndex =
      words.length <= wordsPerSample ? 0 : Math.floor(Math.random() * (maxStart + 1))
    const excerptWords = words.slice(startIndex, startIndex + wordsPerSample)
    const excerpt = excerptWords.join(' ').trim()

    if (!excerpt) {
      continue
    }

    samples.push({
      id: section.id,
      title: section.title,
      text: excerpt,
      wordCount: excerptWords.length,
    })
  }

  return samples
}

function collectBlockWindow(payloads, targetWords) {
  if (!payloads.length) {
    return []
  }

  const wordsPerBlock = payloads.map((block) => block.plainText.split(/\s+/).filter(Boolean).length)
  const totalWords = wordsPerBlock.reduce((sum, count) => sum + count, 0)
  if (!totalWords) {
    return []
  }

  if (totalWords <= targetWords) {
    return payloads
  }

  const maxStartIndex = Math.max(0, payloads.length - 1)
  let startIndex = Math.floor(Math.random() * (maxStartIndex + 1))
  let collected = 0
  const blocks = []

  for (let index = startIndex; index < payloads.length; index += 1) {
    blocks.push(payloads[index])
    collected += wordsPerBlock[index]
    if (collected >= targetWords) {
      return blocks
    }
  }

  collected = 0
  const prefix = []
  for (let index = 0; index < startIndex; index += 1) {
    prefix.push(payloads[index])
    collected += wordsPerBlock[index]
    if (collected >= targetWords) {
      break
    }
  }

  return prefix.length ? prefix : blocks
}

async function collectRepresentativePreviewBlocks({ zip, sections, maxWords, sampleCount }) {
  const buckets = chunkSectionsForPreview(sections, sampleCount)
  const wordsPerSample = Math.max(120, Math.floor(maxWords / Math.max(1, buckets.length)))
  const blocks = []

  for (const bucket of buckets) {
    const section = pickSectionFromBucket(bucket)
    if (!section) {
      continue
    }

    const file = zip.file(section.href)
    if (!file) {
      continue
    }

    const html = await file.async('string')
    const trimmed = trimTrailingBackMatter(html)
    const payloads = getTranslatableNodePayloads(trimmed.html).map((block) => ({
      sectionId: section.id,
      sectionTitle: section.title,
      ...block,
    }))
    const sampledWindow = collectBlockWindow(payloads, wordsPerSample)

    for (const block of sampledWindow) {
      blocks.push(block)
    }
  }

  return blocks
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
    checkpoint = null,
    onCheckpoint = null,
  } = payload || {}

  if (!buffer) {
    throw new Error('Chybí zdrojový EPUB buffer.')
  }

  const zip = await JSZip.loadAsync(buffer)
  const packagePath = await readContainer(zip)
  const pkg = await readPackage(zip, packagePath)
  const packageXml = await readPackageXml(zip, packagePath)
  const sectionMap = buildSectionMap(sections)
  const includedSections = sections.filter((section) => section.includeInTranslation)
  const includedIds = includedSections.map((section) => section.id)
  const includedHrefs = new Set(includedSections.map((section) => section.href))
  const preparationWeight = 8
  const checkpointSections = checkpoint?.sections || {}
  let cacheHits = 0
  let cacheMisses = 0
  let processedBlocks = 0
  let processedWords = 0
  let processedCharacters = 0
  const sectionTasks = []
  let totalBlocks = 0
  const totalWords = includedSections.reduce(
    (sum, section) => sum + (section.wordCount || section.stats?.wordCount || 0),
    0
  )
  const totalCharacters = includedSections.reduce(
    (sum, section) => sum + (section.charCount || section.stats?.charCount || 0),
    0
  )

  for (let index = 0; index < includedSections.length; index += 1) {
    const section = includedSections[index]
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

    if (onProgress) {
      await onProgress({
        stage: 'preparing-export',
        processedBlocks: 0,
        totalBlocks,
        processedWords: 0,
        totalWords,
        processedPages: 0,
        totalPages: Math.max(1, Math.ceil(totalWords / 300)),
        cacheHits,
        cacheMisses,
        currentSectionId: section.id,
        currentSectionTitle: section.title,
        percent:
          includedSections.length > 0
            ? Number((((index + 1) / includedSections.length) * preparationWeight).toFixed(2))
            : 0,
      })
    }
  }

  const resumableTasks = []
  for (const task of sectionTasks) {
    const savedSection = checkpointSections[task.section.id]
    if (savedSection?.translatedHtml) {
      const restoredHtml = normalizeXhtmlDocument(savedSection.translatedHtml, targetLanguage)
      validateXhtmlDocument(restoredHtml, task.section.href)
      zip.file(task.section.href, restoredHtml)
      processedBlocks += savedSection.processedBlocks || task.texts.length
      processedWords += savedSection.processedWords || task.section.wordCount || task.section.stats?.wordCount || 0
      processedCharacters += savedSection.processedCharacters || task.section.charCount || task.section.stats?.charCount || 0
      cacheHits += savedSection.cacheHits || 0
      cacheMisses += savedSection.cacheMisses || 0
      continue
    }
    resumableTasks.push(task)
  }

  if (onProgress && processedBlocks > 0) {
    await onProgress({
      stage: 'resuming-export',
      processedBlocks,
      totalBlocks,
      processedWords,
      totalWords,
      processedPages: Number((processedWords / 300).toFixed(2)),
      totalPages: Math.max(1, Math.ceil(totalWords / 300)),
      cacheHits,
      cacheMisses,
      currentSectionId: '',
      currentSectionTitle: '',
      percent:
        totalBlocks > 0
          ? Number((preparationWeight + (processedBlocks / totalBlocks) * (100 - preparationWeight)).toFixed(2))
          : preparationWeight,
    })
  }

  const isLlmProvider = ['openai', 'claude', 'glm'].includes(provider)
  // LLM: 2 concurrent (whole sections are large); chunk-based: 3 concurrent
  const SECTION_CONCURRENCY = isLlmProvider ? 2 : 3
  let taskIndex = 0
  const inflightSet = new Set()

  function launchNext() {
    if (taskIndex >= resumableTasks.length) return null
    const task = resumableTasks[taskIndex++]
    const promise = translateSectionWithFallback(provider, task, {
      sourceLanguage,
      targetLanguage,
      settings,
    }).then(({ mode, translationBatch, nextHtml }) => ({
      task,
      mode,
      translationBatch,
      nextHtml,
      promise: null,
    }))

    // Attach self-reference for Promise.race tracking
    const tracked = promise.then((result) => { result.promise = tracked; return result })
    inflightSet.add(tracked)
    return tracked
  }

  // Seed the pool
  for (let i = 0; i < Math.min(SECTION_CONCURRENCY, resumableTasks.length); i++) {
    launchNext()
  }

  while (inflightSet.size > 0) {
    const settled = await Promise.race(inflightSet)
    inflightSet.delete(settled.promise)

    const { task, mode, translationBatch, nextHtml } = settled
    const { section, texts } = task
    cacheHits += translationBatch.cacheHits
    cacheMisses += translationBatch.cacheMisses
    processedBlocks += texts.length
    processedWords += section.wordCount || section.stats?.wordCount || 0
    processedCharacters += section.charCount || section.stats?.charCount || 0
    const normalizedSectionHtml = normalizeXhtmlDocument(nextHtml, targetLanguage)
    validateXhtmlDocument(normalizedSectionHtml, section.href)
    zip.file(section.href, normalizedSectionHtml)

    if (onCheckpoint) {
      await onCheckpoint({
        updatedAt: new Date().toISOString(),
        sectionId: section.id,
        section: {
          id: section.id,
          href: section.href,
          title: section.title,
          translatedHtml: normalizedSectionHtml,
          processedBlocks: texts.length,
          processedWords: section.wordCount || section.stats?.wordCount || 0,
          processedCharacters: section.charCount || section.stats?.charCount || 0,
          cacheHits: translationBatch.cacheHits,
          cacheMisses: translationBatch.cacheMisses,
        },
      })
    }

    if (onProgress) {
      await onProgress({
        stage: 'translating',
        processedBlocks,
        totalBlocks,
      processedWords,
      processedCharacters,
      totalWords,
      totalCharacters,
      processedPages: Number((processedWords / 300).toFixed(2)),
      totalPages: Math.max(1, Math.ceil(totalWords / 300)),
      cacheHits,
        cacheMisses,
        currentSectionId: section.id,
        currentSectionTitle: mode === 'chunk-fallback' ? `${section.title} · fallback` : section.title,
        percent:
          totalBlocks > 0
            ? Number((preparationWeight + (processedBlocks / totalBlocks) * (100 - preparationWeight)).toFixed(2))
            : 100,
      })
    }

    // Replenish the pool
    launchNext()
  }

  // Prune NAV/NCX to only include selected sections; remove non-selected section files
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

    // Keep all sections in the EPUB — don't remove non-translated ones.
    // This preserves cover page, images, and original book architecture.
  }

  // Don't prune the spine — keep original book structure intact
  zip.file(packagePath, updateOpfMetadata(packageXml, targetLanguage))

  // Rebuild ZIP with mimetype as the first, uncompressed entry (EPUB 3 spec requirement)
  const orderedZip = new JSZip()
  orderedZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  for (const [name, zipEntry] of Object.entries(zip.files)) {
    if (name === 'mimetype' || zipEntry.dir) continue
    const content = await zipEntry.async('nodebuffer')
    orderedZip.file(name, content)
  }

  const rebuilt = await orderedZip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  validateEpubBuffer(rebuilt, fileName)

  return {
    buffer: rebuilt,
    fileName: buildOutputFileName(pkg.metadata, fileName, targetLanguage),
    stats: {
      cacheHits,
      cacheMisses,
      translatedSections: includedSections.length,
      processedBlocks,
      totalBlocks,
      processedWords,
      processedCharacters,
      totalWords,
      totalCharacters,
      processedPages: Number((processedWords / 300).toFixed(2)),
      totalPages: Math.max(1, Math.ceil(totalWords / 300)),
    },
  }
}
