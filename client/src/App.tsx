import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { Avatar, ErrorBanner, ToastStack } from './components/atoms';
import { Background } from './components/Background';
import { CommandPalette } from './components/CommandPalette';
import { NewIssueDialog } from './components/NewIssueDialog';
import { useApp } from './lib/app-state';
import { AnalyticsView } from './views/AnalyticsView';
import { BoardView } from './views/BoardView';
import { GraphView } from './views/GraphView';
import { IssueView } from './views/IssueView';
import { ProductsView } from './views/ProductsView';
import { TriageView } from './views/TriageView';

function ActorSwitcher() {
  const { meta, actor, setActorId } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!meta || !actor) return null;
  return (
    <div className="actor-menu" ref={ref}>
      <button className="actor-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Acting as — switch identity">
        <Avatar actor={actor} />
        <span className="nm">{actor.name.split(' ')[0]}</span>
        <svg width="9" height="6" viewBox="0 0 10 6" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="actor-drop" role="menu">
          <div className="hd">Acting as</div>
          {meta.actors
            .filter((a) => a.active)
            .map((a) => (
              <button
                key={a.id}
                role="menuitem"
                className={`actor-item ${a.id === actor.id ? 'current' : ''}`}
                onClick={() => {
                  setActorId(a.id);
                  setOpen(false);
                }}
              >
                <Avatar actor={a} />
                <span className="meta">
                  <span className="n">{a.name}</span>
                  <span className="r">{a.role}</span>
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { metaError, reloadMeta } = useApp();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const nav = useNavigate();
  const gPending = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c') {
        e.preventDefault();
        setNewIssueOpen(true);
        return;
      }
      if (e.key === 'g') {
        gPending.current = true;
        window.setTimeout(() => (gPending.current = false), 900);
        return;
      }
      if (gPending.current) {
        const map: Record<string, string> = { t: '/', b: '/board', a: '/analytics', g: '/graph', p: '/products' };
        const to = map[e.key];
        if (to) {
          e.preventDefault();
          nav(to);
        }
        gPending.current = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);

  return (
    <div className="app-shell">
      <Background />
      <a
        href="#main"
        style={{ position: 'absolute', left: -9999, zIndex: 100 }}
        onFocus={(e) => Object.assign(e.currentTarget.style, { left: '12px', top: '12px', background: 'var(--bg2)', padding: '8px 12px', borderRadius: '6px' })}
        onBlur={(e) => Object.assign(e.currentTarget.style, { left: '-9999px' })}
      >
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Quarry home">
          <svg width="21" height="21" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="7" fill="var(--bg3)" />
            <path d="M9 22 L16 8 L23 22 Z" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" />
            <circle cx="16" cy="18" r="2" fill="var(--accent)" />
          </svg>
          Quarry
        </NavLink>
        <nav className="topnav" aria-label="Primary">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Triage
          </NavLink>
          <NavLink to="/board" className={({ isActive }) => (isActive ? 'active' : '')}>
            Board
          </NavLink>
          <NavLink to="/graph" className={({ isActive }) => (isActive ? 'active' : '')}>
            Graph
          </NavLink>
          <NavLink to="/analytics" className={({ isActive }) => (isActive ? 'active' : '')}>
            Analytics
          </NavLink>
          <NavLink to="/products" className={({ isActive }) => (isActive ? 'active' : '')}>
            Products
          </NavLink>
        </nav>
        <div className="topbar-right">
          <button className="palette-hint" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
            <span className="txt">Search &amp; commands</span>
            <kbd>⌘K</kbd>
          </button>
          <button className="btn primary sm" onClick={() => setNewIssueOpen(true)}>
            New issue
          </button>
          <ActorSwitcher />
        </div>
      </header>
      <main className="main" id="main">
        {metaError ? (
          <ErrorBanner message={metaError} onRetry={reloadMeta} />
        ) : (
          <Routes>
            <Route path="/" element={<TriageView />} />
            <Route path="/board" element={<BoardView />} />
            <Route path="/graph" element={<GraphView />} />
            <Route path="/analytics" element={<AnalyticsView />} />
            <Route path="/products" element={<ProductsView />} />
            <Route path="/issue/:key" element={<IssueView />} />
            <Route
              path="*"
              element={
                <div className="empty-state rise">
                  <div className="glyph">∅</div>
                  <h3>Nothing here</h3>
                  <p>
                    That page doesn't exist. Head back to <a href="/">triage</a>.
                  </p>
                </div>
              }
            />
          </Routes>
        )}
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNewIssue={() => setNewIssueOpen(true)} />
      <NewIssueDialog open={newIssueOpen} onClose={() => setNewIssueOpen(false)} />
      <ToastStack />
    </div>
  );
}
