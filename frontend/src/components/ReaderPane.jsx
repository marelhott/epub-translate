import { useEffect, useRef, useState } from 'react'

export function ReaderPane({ bookUrl, bookData, title, emptyLabel }) {
  const containerRef = useRef(null)
  const renditionRef = useRef(null)
  const bookRef = useRef(null)
  const [locationLabel, setLocationLabel] = useState('')
  const [readerError, setReaderError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function mountReader() {
      if (!containerRef.current || (!bookUrl && !bookData)) {
        return
      }

      try {
        setReaderError('')
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
        await rendition.display()
      } catch (error) {
        if (!cancelled) {
          setReaderError(error?.message || 'Náhled EPUB se nepodařilo otevřít.')
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
      renditionRef.current = null
      bookRef.current = null
    }
  }, [bookUrl, bookData])

  function goNext() {
    renditionRef.current?.next()
  }

  function goPrev() {
    renditionRef.current?.prev()
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

      {readerError ? (
        <div className="reader-empty">
          <strong>Náhled EPUB se nepodařilo otevřít</strong>
          <span>{readerError}</span>
        </div>
      ) : (
        <div className="reader-stage" ref={containerRef} />
      )}
    </div>
  )
}
