const workflow = [
  {
    id: "01",
    title: "Inspect the file first",
    body: "Before any expensive run begins, the workspace reads structure, language, cover, section count, and ballast."
  },
  {
    id: "02",
    title: "Choose the translation path",
    body: "Move through a direct model workflow, an HTML roundtrip for DeepL, or a repair-first pass when the EPUB is already damaged."
  },
  {
    id: "03",
    title: "Review with restraint",
    body: "The audit stays selective. Quiet passages remain untouched. Risky ones get isolated, compared, and corrected."
  },
  {
    id: "04",
    title: "Export only after proof",
    body: "Metadata, navigation, XHTML, cover declarations, and internal links are checked before the book leaves the workspace."
  }
]

const notes = [
  {
    label: "Structure",
    text: "Reader-safe packaging matters more than marketing copy. The final file has to survive real EPUB parsers."
  },
  {
    label: "Review",
    text: "A review pass should feel surgical, not theatrical. Better to flag a narrow set of risky passages than rewrite a whole book for sport."
  },
  {
    label: "Roundtrip",
    text: "The workflow should hold direct AI translation, DeepL export, and human editorial intervention without losing the shape of the file."
  }
]

const proof = [
  "Validation-first EPUB packaging",
  "HTML roundtrip for DeepL and external editors",
  "Selective review instead of blanket rewriting",
  "Section-aware translation scope",
  "Repair path for broken source files"
]

const plans = [
  {
    name: "Guest",
    price: "Per book",
    note: "For one clean export when all you need is the file back in one piece."
  },
  {
    name: "Creator",
    price: "Monthly credits",
    note: "For repeat work with review, roundtrip, and project history."
  },
  {
    name: "Studio",
    price: "Shared workflow",
    note: "For editors, publishers, and reviewer passes with higher trust requirements."
  }
]

export default function Page() {
  return (
    <main className="page-shell">
      <div className="grain-layer" aria-hidden="true" />

      <header className="site-header">
        <a className="brand" href="#top">
          <span className="brand-dot" />
          <span className="brand-copy">EPUB TRANSLATOR</span>
        </a>
        <nav className="site-nav" aria-label="Primary">
          <a href="#method">Method</a>
          <a href="#proof">Proof</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <a className="nav-cta" href="#pricing">
          <span>Enter</span>
          <span className="nav-cta-icon">→</span>
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy reveal">
          <p className="eyebrow">Publishing-safe translation workspace</p>
          <h1>Translate EPUBs with control, not luck.</h1>
          <p className="hero-lede">
            Preserve structure, review only what deserves intervention, and return
            a reader-safe file with metadata, cover, and navigation intact.
          </p>
          <div className="hero-actions">
            <a className="action-primary" href="#pricing">
              <span>Open the workflow</span>
              <span className="action-icon">→</span>
            </a>
            <a className="action-secondary" href="#method">
              <span>Read the method</span>
            </a>
          </div>
        </div>

        <div className="hero-rail reveal" style={{ "--delay": "120ms" }}>
          <div className="bezel-shell hero-media-shell">
            <div className="bezel-core hero-media-core">
              <img
                alt="Editorial desk with a book, marked pages, and soft daylight"
                className="hero-image"
                src="https://picsum.photos/seed/epub-editorial-1/1440/1080"
              />
            </div>
          </div>

          <div className="hero-caption">
            Built for books that still need to read like books when they come back.
          </div>
        </div>
      </section>

      <section className="statement-band reveal" id="method" style={{ "--delay": "180ms" }}>
        <div className="statement-copy">
          <p className="section-kicker">Method</p>
          <h2>The trust comes from the workflow, not the headline.</h2>
        </div>
      </section>

      <section className="workflow-grid">
        {workflow.map((item, index) => (
          <article
            className="workflow-row reveal"
            key={item.id}
            style={{ "--delay": `${220 + index * 60}ms` }}
          >
            <p className="workflow-id">{item.id}</p>
            <div className="workflow-text">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          </article>
        ))}
      </section>

      <section className="notes-band">
        {notes.map((item, index) => (
          <article
            className="note-card reveal"
            key={item.label}
            style={{ "--delay": `${180 + index * 80}ms` }}
          >
            <div className="bezel-shell note-shell">
              <div className="bezel-core note-core">
                <p className="note-label">{item.label}</p>
                <p className="note-text">{item.text}</p>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="proof-band" id="proof">
        <div className="proof-copy reveal">
          <p className="section-kicker">Proof layer</p>
          <h2>Most tools promise translation. This one has to prove the file survived.</h2>
          <p>
            The useful questions are concrete: what changed, what stayed untouched,
            what passed validation, and what still deserves a human eye.
          </p>
        </div>

        <div className="proof-list bezel-shell reveal" style={{ "--delay": "140ms" }}>
          <div className="bezel-core proof-core">
            {proof.map((item) => (
              <div className="proof-item" key={item}>
                <span className="proof-mark" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pricing-band" id="pricing">
        <div className="pricing-copy reveal">
          <p className="section-kicker">Pricing logic</p>
          <h2>Simple at the door. Deeper when the workflow grows.</h2>
          <p>
            One-off translations should not require a subscription. Repeated editorial
            work should not feel like starting from zero every time.
          </p>
        </div>

        <div className="pricing-table reveal" style={{ "--delay": "120ms" }} role="list">
          {plans.map((plan) => (
            <article className="pricing-row" key={plan.name} role="listitem">
              <p className="pricing-name">{plan.name}</p>
              <div className="pricing-main">
                <p className="pricing-price">{plan.price}</p>
                <p className="pricing-note">{plan.note}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
