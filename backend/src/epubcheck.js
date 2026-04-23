import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const DEFAULT_EPUBCHECK_HOME = join(process.cwd(), 'backend', 'vendor', 'epubcheck')
const DEFAULT_EPUBCHECK_JAR = join(DEFAULT_EPUBCHECK_HOME, 'epubcheck.jar')
const DEFAULT_EPUBCHECK_LIB = join(DEFAULT_EPUBCHECK_HOME, 'lib', '*')

function getEpubCheckJarPath() {
  return process.env.EPUBCHECK_JAR || DEFAULT_EPUBCHECK_JAR
}

export function hasEpubCheck() {
  return existsSync(getEpubCheckJarPath())
}

function parseEpubCheckOutput(output) {
  const text = String(output || '')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const errors = lines.filter((line) => /\bERROR\b/i.test(line))
  const warnings = lines.filter((line) => /\bWARNING\b/i.test(line))
  const fatals = lines.filter((line) => /\bFATAL\b/i.test(line))

  return {
    raw: text,
    lines,
    errors,
    warnings,
    fatals,
  }
}

export function validateEpubFile(filePath) {
  const jarPath = getEpubCheckJarPath()
  if (!existsSync(jarPath)) {
    return {
      ok: true,
      skipped: true,
      reason: `epubcheck jar nenalezen na ${jarPath}`,
      errors: [],
      warnings: [],
      fatals: [],
      raw: '',
    }
  }

  const classPath = [jarPath, process.env.EPUBCHECK_LIB || DEFAULT_EPUBCHECK_LIB].join(':')
  const result = spawnSync('java', ['-cp', classPath, 'com.adobe.epubcheck.tool.Checker', filePath], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const parsed = parseEpubCheckOutput(`${result.stdout || ''}\n${result.stderr || ''}`)
  const ok = result.status === 0 && parsed.errors.length === 0 && parsed.fatals.length === 0

  return {
    ok,
    skipped: false,
    status: result.status ?? 1,
    ...parsed,
  }
}

export function assertValidEpubFile(filePath, label = 'EPUB') {
  const validation = validateEpubFile(filePath)
  if (validation.skipped) {
    return validation
  }
  if (!validation.ok) {
    const summary = [...validation.fatals, ...validation.errors].slice(0, 8).join('\n')
    throw new Error(`epubcheck validace selhala pro ${label}:\n${summary || validation.raw}`)
  }
  return validation
}

export function validateEpubBuffer(buffer, label = 'book.epub') {
  const tempDir = mkdtempSync(join(tmpdir(), 'epubcheck-'))
  const filePath = join(tempDir, label.replace(/[^a-z0-9._-]+/gi, '_'))
  try {
    writeFileSync(filePath, buffer)
    return assertValidEpubFile(filePath, label)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
