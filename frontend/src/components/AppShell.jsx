export function MarkIcon() {
  return (
    <div className="mark-icon" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  )
}

export function WorkspaceIcon({ type }) {
  const icons = {
    calendar: (
      <>
        <rect x="8" y="10" width="32" height="28" rx="8" />
        <path d="M15 8v8" />
        <path d="M33 8v8" />
        <path d="M8 19h32" />
      </>
    ),
    search: (
      <>
        <circle cx="21" cy="21" r="8" />
        <path d="M27 27l8 8" />
      </>
    ),
  }

  return (
    <svg className="workspace-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      {icons[type]}
    </svg>
  )
}

export function GearIcon() {
  return (
    <svg className="gear-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.75 13.2 6l2.53.4.79 2.43 2.1 1.5-1.1 2.33 1.1 2.34-2.1 1.49-.8 2.43-2.52.4L12 20.25l-1.2-2.26-2.53-.4-.79-2.42-2.1-1.5 1.1-2.34-1.1-2.33 2.1-1.5.8-2.43 2.52-.4L12 3.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function AppShell({ children, onOpenSettings }) {
  return (
    <div className="page-shell">
      <div className="site-frame">
        <header className="topbar">
          <a className="brand" href="/" aria-label="Překladač ebooků">
            <MarkIcon />
            <span>Překladač ebooků</span>
          </a>

          <div className="topbar-actions">
            <span className="topbar-note">EPUB upload, preview, přesný odhad ceny, čistý export</span>
            <button type="button" className="icon-button" onClick={onOpenSettings} aria-label="Nastavení API klíčů">
              <GearIcon />
            </button>
          </div>
        </header>

        <main className="app-main">{children}</main>
      </div>
    </div>
  )
}
