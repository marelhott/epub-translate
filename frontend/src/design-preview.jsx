import React from 'react'
import ReactDOM from 'react-dom/client'
import './design-preview.css'

const providers = [
  { name: 'DeepL', version: 'v2', status: 'ready', tier: 'primary engine', cost: '€4.88' },
  { name: 'OpenAI', version: 'gpt-5.4', status: 'ready', tier: 'precision fallback', cost: '€5.52' },
  { name: 'Claude', version: '4-6', status: 'ready', tier: 'style review', cost: '€5.14' },
  { name: 'Gemini', version: '2.5-pro', status: 'idle', tier: 'terminology mode', cost: '€4.96' },
  { name: 'GLM', version: '5.1', status: 'ready', tier: 'budget longform', cost: '€1.72' },
]

const sections = [
  ['Cover', 'skip', '2 w'],
  ['Title Page', 'skip', '3 w'],
  ['Introduction', 'include', '1,482 w'],
  ['Chapter 01', 'include', '4,218 w'],
  ['Chapter 02', 'include', '3,996 w'],
  ['Notes', 'skip', '644 w'],
  ['Sources', 'skip', '318 w'],
]

function MacTraffic() {
  return (
    <div className="dp-traffic">
      <span className="dp-dot dp-dot-red" />
      <span className="dp-dot dp-dot-amber" />
      <span className="dp-dot dp-dot-green" />
    </div>
  )
}

function StatusDot({ status }) {
  return <span className={`dp-status-dot ${status === 'ready' ? 'is-ready' : 'is-idle'}`} />
}

function DesignPreview() {
  return (
    <div className="dp-root">
      <div className="dp-window">
        <header className="dp-topbar">
          <div className="dp-topbar-left">
            <MacTraffic />
            <div className="dp-appmark">ET</div>
            <div className="dp-appname">Překládač ebooků</div>
          </div>
          <div className="dp-topbar-center">
            <div className="dp-mode is-active">epub upload</div>
            <div className="dp-mode">preview</div>
            <div className="dp-mode">export</div>
          </div>
          <div className="dp-topbar-right">
            <div className="dp-runtime">session: preview-ready</div>
            <button className="dp-toolbtn">config</button>
          </div>
        </header>

        <div className="dp-body">
          <aside className="dp-sidebar">
            <div className="dp-panel-head">
              <span>providers</span>
              <span>5</span>
            </div>

            <div className="dp-upload-row">
              <span className="dp-upload-label">Co-Intelligence.epub</span>
              <span className="dp-upload-ext">epub</span>
            </div>

            <div className="dp-book-strip">
              <div className="dp-cover" />
              <div className="dp-book-copy">
                <div className="dp-book-title">Co-Intelligence</div>
                <div className="dp-book-meta">Ethan Mollick</div>
                <div className="dp-book-meta">en-US → cs-CZ</div>
              </div>
            </div>

            <div className="dp-provider-list">
              {providers.map((provider, index) => (
                <button className={`dp-provider-row ${index === 1 ? 'is-active' : ''}`} key={provider.name}>
                  <div className="dp-provider-id">{provider.name.slice(0, 2).toUpperCase()}</div>
                  <div className="dp-provider-copy">
                    <div className="dp-provider-line">
                      <span className="dp-provider-name">{provider.name}</span>
                      <span className="dp-provider-version">{provider.version}</span>
                      <StatusDot status={provider.status} />
                    </div>
                    <div className="dp-provider-line dp-provider-line-sub">
                      <span>{provider.tier}</span>
                      <span>{provider.cost}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <main className="dp-workspace">
            <div className="dp-metrics">
              <div className="dp-metric"><span className="dp-metric-value">48,710</span><span className="dp-metric-label">words</span></div>
              <div className="dp-metric"><span className="dp-metric-value">288,692</span><span className="dp-metric-label">chars</span></div>
              <div className="dp-metric"><span className="dp-metric-value">163</span><span className="dp-metric-label">pages</span></div>
              <div className="dp-metric"><span className="dp-metric-value">€5.52</span><span className="dp-metric-label">est.cost</span></div>
              <div className="dp-metric dp-metric-wide"><span className="dp-metric-note">reader: mounted · sampled preview: 2 random pages · ballast detected: contents / notes / sources</span></div>
            </div>

            <div className="dp-preview-shell">
              <div className="dp-preview-head">
                <div className="dp-preview-title">epub preview</div>
                <div className="dp-preview-tools">
                  <button>cover</button>
                  <button>start</button>
                  <button>1/3</button>
                  <button>2/3</button>
                  <span>page 021 / 163</span>
                </div>
              </div>

              <div className="dp-preview-canvas">
                <div className="dp-page">
                  <div className="dp-page-kicker">chapter 02</div>
                  <h1>How to work with AI when the output looks convincing before it is correct.</h1>
                  <p>
                    AI systems are useful partly because they are confident. That confidence also makes
                    them dangerous. A polished answer arrives before the underlying reasoning is visible,
                    so the human operator has to reinsert skepticism into the loop.
                  </p>
                  <p>
                    In practice, this means testing claims, sampling outputs, and preserving the original
                    structure of the source material while translation is still underway.
                  </p>
                </div>
              </div>
            </div>

            <div className="dp-bottom-strip">
              <div className="dp-mini-chart">
                <div className="dp-strip-head">translation progress</div>
                <div className="dp-progress-line"><span style={{ width: '42%' }} /></div>
                <div className="dp-strip-meta">42.0% · 20,404 / 48,710 words · 11.8 min elapsed</div>
              </div>
              <div className="dp-mini-log">
                <div className="dp-strip-head">current section</div>
                <div className="dp-log-line">Chapter 02 · block 14 / 33 · cache miss</div>
              </div>
            </div>
          </main>

          <aside className="dp-inspector">
            <div className="dp-panel-head">
              <span>inspector</span>
              <span>active</span>
            </div>

            <div className="dp-inspector-section">
              <div className="dp-section-title">actions</div>
              <button className="dp-action">preview 2 random pages</button>
              <button className="dp-action dp-action-primary">spustit překlad</button>
              <button className="dp-action">download epub</button>
            </div>

            <div className="dp-inspector-section">
              <div className="dp-section-title">preserve</div>
              <label className="dp-check"><input type="checkbox" defaultChecked /> <span>main chapters</span></label>
              <label className="dp-check"><input type="checkbox" /> <span>front matter</span></label>
              <label className="dp-check"><input type="checkbox" /> <span>back matter</span></label>
              <label className="dp-check"><input type="checkbox" /> <span>unclassified</span></label>
            </div>

            <div className="dp-inspector-section dp-form-grid">
              <div>
                <label>provider</label>
                <div className="dp-field">OpenAI GPT-5.4</div>
              </div>
              <div>
                <label>preview pages</label>
                <div className="dp-field">2</div>
              </div>
              <div>
                <label>target</label>
                <div className="dp-field">cs-CZ</div>
              </div>
              <div>
                <label>concurrency</label>
                <div className="dp-field">1</div>
              </div>
            </div>

            <div className="dp-inspector-section">
              <div className="dp-section-title">sections</div>
              <div className="dp-section-list">
                {sections.map(([name, mode, words]) => (
                  <div className={`dp-section-row ${mode === 'include' ? 'is-include' : ''}`} key={name}>
                    <input type="checkbox" defaultChecked={mode === 'include'} />
                    <span className="dp-section-name">{name}</span>
                    <span className="dp-section-words">{words}</span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DesignPreview />
  </React.StrictMode>,
)
