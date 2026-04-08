import { useEffect, useRef, useState } from 'react'

export function ReaderPane({ bookUrl, title, emptyLabel }) {
  const containerRef = useRef(null)
  const renditionRef = useRef(null)
  const bookRef = useRef(null)
  const [locationLabel, setLocationLabel] = useState('')

  useEffect(() => {
    let cancelled = false

    async function mountReader() {
      if (!containerRef.current || !bookUrl) {
        return
      }

      const epubModule = await import('epubjs')
      if (cancelled) {
        return
      }

      const ePub = epubModule.default
      const book = ePub(bookUrl)
      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
      })

      bookRef.current = book
      renditionRef.current = rendition

      rendition.on('relocated', (location) => {
        const displayed = location?.start?.displayed
        if (displayed?.page && displayed?.total) {
          setLocationLabel(`Strana ${displayed.page} z ${displayed.total}`)
        } else if (location?.start?.href) {
          setLocationLabel(location.start.href)
        } else {
          setLocationLabel('')
        }
      })

      await rendition.display()
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
      renditionRef.current = null
      bookRef.current = null
      setLocationLabel('')
    }
  }, [bookUrl])

  function goNext() {
    renditionRef.current?.next()
  }

  function goPrev() {
    renditionRef.current?.prev()
  }

  if (!bookUrl) {
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

      <div className="reader-stage" ref={containerRef} />
    </div>
  )
}
