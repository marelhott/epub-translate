import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import * as cheerio from 'cheerio'
import { analyzeEpubBuffer, exportTranslatedEpub } from '../src/translator-workbench.js'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: true,
})

function toArray(value) {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readPackage(zip) {
  const container = await zip.file('META-INF/container.xml')?.async('string')
  const parsedContainer = xmlParser.parse(container)
  const packagePath = toArray(parsedContainer?.container?.rootfiles?.rootfile)[0]?.['full-path']
  assert(packagePath, 'Nepodařilo se najít OPF balíček v testovacím EPUB.')
  const pkgXml = await zip.file(packagePath)?.async('string')
  const pkg = xmlParser.parse(pkgXml)?.package
  return { packagePath, pkg }
}

async function main() {
  const samplePath = join(process.cwd(), '..', 'Ebook jinak', 'frontend', 'public', 'samples', 'alice.epub')
  const buffer = readFileSync(samplePath)
  const analysis = await analyzeEpubBuffer(buffer, {
    fileName: 'alice.epub',
    languageHint: 'en',
  })

  const expectedSections = analysis.sections.filter((section) => section.includeInTranslation)
  const expectedHeadings = expectedSections.map((section) => normalizeText(section.title)).filter(Boolean)
  const expectedParagraphs = expectedSections.reduce(
    (sum, section) => sum + Number(section.stats?.paragraphCount || 0),
    0
  )

  const exported = await exportTranslatedEpub({
    buffer,
    fileName: 'alice.epub',
    provider: 'identity',
    sourceLanguage: 'en',
    targetLanguage: 'cs',
    sections: analysis.sections,
  })

  const zip = await JSZip.loadAsync(exported.buffer)
  const { packagePath, pkg } = await readPackage(zip)
  const packageDir = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : ''
  const manifestItems = toArray(pkg.manifest?.item)
  const spineItems = toArray(pkg.spine?.itemref)
  const manifestById = new Map(
    manifestItems.map((item) => [item.id, `${packageDir}${item.href}`])
  )

  const chapterDocs = []
  let paragraphCount = 0

  for (const itemRef of spineItems) {
    const href = manifestById.get(itemRef.idref)
    if (!href) {
      continue
    }

    const xml = await zip.file(href)?.async('string')
    assert(xml, `Chybí spine dokument ${href}`)
    xmlParser.parse(xml)

    const $ = cheerio.load(xml, { xmlMode: true })
    const heading = normalizeText(
      $('h1').first().text() || $('h2').first().text() || $('title').first().text()
    )
    chapterDocs.push({ href, heading })
    paragraphCount += $('p').length
  }

  assert(chapterDocs.length === expectedSections.length, `Počet kapitol nesedí: ${chapterDocs.length} vs ${expectedSections.length}`)
  assert(paragraphCount === expectedParagraphs, `Počet odstavců nesedí: ${paragraphCount} vs ${expectedParagraphs}`)

  for (const expectedHeading of expectedHeadings) {
    assert(
      chapterDocs.some((doc) => doc.heading === expectedHeading),
      `V exportu chybí očekávaný heading: ${expectedHeading}`
    )
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        exportedFile: exported.fileName,
        chapters: chapterDocs.length,
        paragraphs: paragraphCount,
        firstHeading: chapterDocs[0]?.heading || '',
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
