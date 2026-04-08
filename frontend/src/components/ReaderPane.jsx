import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Resolve a navigation target to a href string that epub.js display() accepts.
 * Uses book.spine.get() when a spineIndex is available — this is the most
 * reliable path because it returns the exact href epub.js knows about.
 */
function resolveDisplayTarget(book, target) {
  if (!target) return { candidates: [undefined], description: 'empty → first page' }

  if (typeof target === 'string') {
    const stripped = target.includes('/') ? target.split('/').pop() : ''
    const candidates = [target, stripped, undefined].filter(
      (v, i, a) => v !== '' && a.indexOf(v) === i
    )
    return { candidates, description: `string "${target}"` }
  }

  if (typeof target === 'object') {
    const candidates = []
    if (target.spineIndex != null && book?.spine) {
      const spineItem = book.spine.get(target.spineIndex)
      if (spineItem?.href) candidates.push(spineItem.href)
    }
    if (target.href) {
      candidates.push(target.href)
      if (target.href.includes('/')) candidates.push(target.href.split('/').pop())
    }
    candidates.push(undefined)
    const unique = candidates.filter((v, i, a) => a.indexOf(v) === i)
    return { candidates: unique, description: `spine=${target.spineIndex} href="${target.href}"` }
  }

  return { candidates: [target, undefined], description: `raw ${typeof target}: ${target}` }
}

/** Wrap rendition.display() with a timeout to prevent hanging */
function displayWithTimeout(rendition, target, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`display() timeout after ${timeoutMs}ms`)), timeoutMs)
    rendition.display(target).then(
      (result) => { clearTimeout(timer); resolve(result) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

export function ReaderPane({ bookUrl, bookData, title, emptyLabel, initialLocation = null, jumpTargets = [] }) {
  const containerRef = useRef(null)
  const renditionRef = useRef(null)
  const bookRef = useRef(null)
  const renderedOnceRef = useRef(false)
  const navigationLockRef = useRef(false)
  const [locationLabel, setLocationLabel] = useState('')
  const [readerError, setReaderError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const locationKey = useMemo(
    () => (initialLocation ? `${initialLocation.spineIndex ?? ''}:${initialLocation.href ?? ''}` : ''),
    [initialLocation?.spineIndex, initialLocation?.href]
  )

  const normalizedJumpTargets = useMemo(
    () => {
      const seen = new Set()
      return jumpTargets.filter((target) => {
        if (!target?.label) return false
        if (target.spineIndex == null && !target.href) return false
        const key = `${target.spineIndex ?? ''}:${target.href ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    },
    [jumpTargets]
  )

  // Mount effect — creates epub.js book + rendition.
  // Uses containerRef directly (epub.js requires it).
  // Does NOT depend on locationKey — navigation is handled separately.
  useEffect(() => {
    let cancelled = false

    async function mountReader() {
      if (!containerRef.current || (!bookUrl && !bookData)) return

      const mountStart = performance.now()
      console.log('[ReaderPane] mountReader start')

      try {
        setReaderError('')
        setIsLoading(true)
        renderedOnceRef.current = false
        containerRef.current.innerHTML = ''

        const epubModule = await import('epubjs')
        if (cancelled) return

        const ePub = epubModule.default
        const source = bookData || bookUrl
        const book = ePub(source)

        const rendition = book.renderTo(containerRef.current, {
          width: '100%',
          height: '100%',
          spread: 'none',
          flow: 'paginated',
        })

        bookRef.current = book
        renditionRef.current = rendition

        rendition.on('relocated', (location) => {
          if (cancelled) return
          renderedOnceRef.current = true
          const displayed = location?.start?.displayed
          if (displayed?.page && displayed?.total) {
            setLocationLabel(`Strana ${displayed.page} z ${displayed.total}`)
          } else if (location?.start?.href) {
            setLocationLabel(location.start.href)
          } else {
            setLocationLabel('')
          }
        })

        await book.ready
        if (cancelled) return
        console.log('[ReaderPane] book.ready', {
          spineLength: book.spine?.length,
          elapsed: Math.round(performance.now() - mountStart),
        })

        await rendition.display()
        if (cancelled) return
        console.log('[ReaderPane] mountReader complete', {
          elapsed: Math.round(performance.now() - mountStart),
        })
      } catch (error) {
        if (!cancelled) {
          console.error('[ReaderPane] mountReader failed', error)
          const hasVisibleContent =
            renderedOnceRef.current ||
            Boolean(containerRef.current?.textContent?.trim()) ||
            Boolean(containerRef.current?.children?.length)

          if (hasVisibleContent) {
            setReaderError(error?.message || 'Některé části EPUB se nepodařilo načíst úplně přesně.')
          } else {
            setReaderError(error?.message || 'Náhled EPUB se nepodařilo otevřít.')
          }
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    mountReader()

    return () => {
      cancelled = true
      try { renditionRef.current?.destroy() } catch {}
      try { bookRef.current?.destroy() } catch {}
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
      renderedOnceRef.current = false
      navigationLockRef.current = false
      renditionRef.current = null
      bookRef.current = null
    }
  }, [bookUrl, bookData])

  // Navigation effect — navigates to initialLocation after book is mounted.
  useEffect(() => {
    if (!initialLocation || !renditionRef.current || !bookRef.current) return

    const rendition = renditionRef.current
    const book = bookRef.current
    const { candidates, description } = resolveDisplayTarget(book, initialLocation)
    console.log('[ReaderPane] navigate to initialLocation', { description })

    let cancelled = false
    ;(async () => {
      for (const candidate of candidates) {
        if (cancelled) return
        try {
          await displayWithTimeout(rendition, candidate)
          if (!cancelled) {
            console.log('[ReaderPane] initialLocation success', { candidate: candidate ?? '<first page>' })
          }
          return
        } catch (error) {
          console.warn('[ReaderPane] initialLocation candidate failed', { candidate, error: error?.message })
        }
      }
    })()

    return () => { cancelled = true }
  }, [locationKey])

  function goNext() {
    renditionRef.current?.next()
  }

  function goPrev() {
    renditionRef.current?.prev()
  }

  function goToTarget(target) {
    const book = bookRef.current
    const rendition = renditionRef.current
    if (!rendition || !book) return

    if (navigationLockRef.current) {
      console.warn('[ReaderPane] goToTarget skipped — navigation in progress')
      return
    }

    const { candidates, description } = resolveDisplayTarget(book, target)
    console.log('[ReaderPane] goToTarget', { description })

    navigationLockRef.current = true
    ;(async () => {
      let lastError = null
      for (const candidate of candidates) {
        try {
          setReaderError('')
          await displayWithTimeout(rendition, candidate)
          console.log('[ReaderPane] goToTarget success', { candidate: candidate ?? '<first page>' })
          navigationLockRef.current = false
          return
        } catch (error) {
          console.warn('[ReaderPane] goToTarget candidate failed', { candidate, error: error?.message })
          lastError = error
        }
      }
      navigationLockRef.current = false
      if (lastError) {
        setReaderError(lastError?.message || 'Na zvolenou část knihy se nepodařilo skočit.')
      }
    })()
  }

  if (!bookUrl && !bookData) {
    return (
      <div className="reader-empty">
        <strong>{emptyLabel}</strong>
        <span>Po nahrání se tady objeví listovatelný náhled knihy.</span>
      </div>
    )
  }

  return (
    <div className="reader-shell">
      <div className="reader-toolbar">
        <strong>{title}</strong>
        <div className="reader-toolbar-right">
          <span>{isLoading ? 'Načítám náhled knihy…' : locationLabel || '\u00A0'}</span>
          <div className="reader-controls">
            <button type="button" className="ghost-button" onClick={goPrev} disabled={isLoading}>
              Předchozí
            </button>
            <button type="button" className="ghost-button" onClick={goNext} disabled={isLoading}>
              Další
            </button>
          </div>
        </div>
      </div>

      {normalizedJumpTargets.length ? (
        <div className="reader-jumps">
          {normalizedJumpTargets.map((target) => (
            <button
              key={`${target.spineIndex ?? ''}:${target.href ?? ''}`}
              type="button"
              className="ghost-button ghost-button--jump"
              onClick={() => goToTarget(target)}
              disabled={isLoading}
            >
              {target.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="reader-stage" ref={containerRef} />

      {readerError ? (
        <div className={`reader-warning ${renderedOnceRef.current ? 'is-inline' : 'is-fatal'}`}>
          <strong>{renderedOnceRef.current ? 'Náhled je otevřený s omezeními' : 'Náhled EPUB se nepodařilo otevřít'}</strong>
          <span>{readerError}</span>
        </div>
      ) : null}
    </div>
  )
}
