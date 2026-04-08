import { useEffect, useMemo, useRef, useState } from 'react'

function normalizeLocator(target) {
  if (target && typeof target === 'object') {
    if (target.locator !== undefined && target.locator !== null && target.locator !== '') {
      return target.locator
    }
    if (target.spineIndex !== undefined && target.spineIndex !== null) {
      return target.spineIndex
    }
    if (target.href) {
      return target.href
    }
  }
  return target
}

export function ReaderPane({ bookUrl, bookData, title, emptyLabel, initialLocation = '', jumpTargets = [] }) {
  const containerRef = useRef(null)
  const renditionRef = useRef(null)
  const bookRef = useRef(null)
  const renderedOnceRef = useRef(false)
  const [locationLabel, setLocationLabel] = useState('')
  const [readerError, setReaderError] = useState('')
  const normalizedJumpTargets = useMemo(
    () =>
      jumpTargets.filter((target, index, array) => {
        if (normalizeLocator(target) === undefined || normalizeLocator(target) === null || !target?.label) {
          return false
        }
        return (
          array.findIndex((item) => JSON.stringify(normalizeLocator(item)) === JSON.stringify(normalizeLocator(target))) ===
          index
        )
      }),
    [jumpTargets]
  )

  useEffect(() => {
    let cancelled = false

    async function displayWithFallback(rendition, target) {
      const locator = normalizeLocator(target)
      const hrefFallback =
        typeof locator === 'string' && locator ? locator.split('/').pop() : ''
      const candidates = [locator, hrefFallback, undefined].filter((candidate, index, array) => {
        return array.findIndex((item) => item === candidate) === index
      })

      let lastError = null
      for (const candidate of candidates) {
        try {
          await rendition.display(candidate)
          return true
        } catch (error) {
          lastError = error
        }
      }

      if (lastError) {
        throw lastError
      }
      return false
    }

    async function mountReader() {
      if (!containerRef.current || (!bookUrl && !bookData)) {
        return
      }

      try {
        setReaderError('')
        renderedOnceRef.current = false
        containerRef.current.innerHTML = ''
        const epubModule = await import('epubjs')
        if (cancelled) {
          return
        }

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
        await displayWithFallback(rendition, initialLocation || '')
      } catch (error) {
        if (!cancelled) {
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
      }
    }

    mountReader()

    return () => {
      cancelled = true
      try {
        renditionRef.current?.destroy()
      } catch {}
      try {
        bookRef.current?.destroy()
      } catch {}
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
      renderedOnceRef.current = false
      renditionRef.current = null
      bookRef.current = null
    }
  }, [bookUrl, bookData, initialLocation])

  function goNext() {
    renditionRef.current?.next()
  }

  function goPrev() {
    renditionRef.current?.prev()
  }

  function goToTarget(target) {
    const locator = normalizeLocator(target)
    if (locator === undefined || locator === null || locator === '') {
      return
    }
    const rendition = renditionRef.current
    if (!rendition) {
      return
    }

    ;(async () => {
      try {
        setReaderError('')
        await rendition.display(locator)
      } catch {
        try {
          if (typeof locator === 'string') {
            await rendition.display(locator.split('/').pop())
          } else {
            throw new Error('fallback-unavailable')
          }
        } catch (error) {
          setReaderError(error?.message || 'Na zvolenou část knihy se nepodařilo skočit.')
        }
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
          <span>{locationLabel || 'Načítám náhled knihy'}</span>
          <div className="reader-controls">
            <button type="button" className="ghost-button" onClick={goPrev}>
              Předchozí
            </button>
            <button type="button" className="ghost-button" onClick={goNext}>
              Další
            </button>
          </div>
        </div>
      </div>

      {normalizedJumpTargets.length ? (
        <div className="reader-jumps">
          {normalizedJumpTargets.map((target) => (
            <button
              key={target.href || `${target.spineIndex}`}
              type="button"
              className="ghost-button ghost-button--jump"
              onClick={() => goToTarget(target)}
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
