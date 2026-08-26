import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Issue } from '../lib/api';
import { api } from '../lib/api';
import { useApp } from '../lib/app-state';
import { SeverityGlyph, StatusPill } from './atoms';

// ⌘K / Ctrl+K palette: navigation, actions, and live full-text issue search.

interface PaletteAction {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onNewIssue,
}: {
  open: boolean;
  onClose: () => void;
  onNewIssue: () => void;
}) {
  const nav = useNavigate();
  const { meta } = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [results, setResults] = useState<Issue[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<number>(0);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults([]);
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    if (!q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = window.setTimeout(() => {
      api
        .issues({ q: q.trim(), limit: '8' })
        .then((r) => setResults(r.issues))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 160);
  }, [q]);

  const actions = useMemo<PaletteAction[]>(() => {
    const nav2 = (path: string) => () => {
      nav(path);
      onClose();
    };
    const base: PaletteAction[] = [
      { id: 'new', group: 'Actions', label: 'File a new issue…', hint: 'C', run: () => { onClose(); onNewIssue(); } },
      { id: 'triage', group: 'Go to', label: 'Triage', hint: 'G T', run: nav2('/') },
      { id: 'board', group: 'Go to', label: 'Board', hint: 'G B', run: nav2('/board') },
      { id: 'graph', group: 'Go to', label: 'Dependency graph', hint: 'G G', run: nav2('/graph') },
      { id: 'analytics', group: 'Go to', label: 'Analytics', hint: 'G A', run: nav2('/analytics') },
      { id: 'products', group: 'Go to', label: 'Products & components', hint: 'G P', run: nav2('/products') },
      ...(meta?.products ?? []).map((p) => ({
        id: `prod-${p.key}`,
        group: 'Filter',
        label: `Open issues in ${p.name} (${p.key})`,
        run: nav2(`/?product=${p.key}&open=true`),
      })),
    ];
    if (!q.trim()) return base;
    const ql = q.toLowerCase();
    return base.filter((a) => a.label.toLowerCase().includes(ql));
  }, [q, meta, nav, onClose, onNewIssue]);

  const items = useMemo(() => {
    const issueItems = results.map((r) => ({
      id: `issue-${r.key}`,
      issue: r,
    }));
    return { actions, issueItems, count: actions.length + issueItems.length };
  }, [actions, results]);

  const activate = useCallback(
    (idx: number) => {
      if (idx < items.actions.length) items.actions[idx].run();
      else {
        const issue = items.issueItems[idx - items.actions.length]?.issue;
        if (issue) {
          nav(`/issue/${issue.key}`);
          onClose();
        }
      }
    },
    [items, nav, onClose],
  );

  useEffect(() => setSel(0), [items.count]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search issues, or jump anywhere…"
            aria-label="Search"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.count - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                activate(sel);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-results">
          {items.actions.length > 0 && <div className="palette-group">{q.trim() ? 'Commands' : 'Quick actions'}</div>}
          {items.actions.map((a, i) => (
            <button key={a.id} className={`palette-item ${sel === i ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => activate(i)}>
              <span className="p-title">{a.label}</span>
              {a.hint && <span className="hint">{a.hint}</span>}
            </button>
          ))}
          {q.trim() && (
            <>
              <div className="palette-group">Issues</div>
              {searching && results.length === 0 && <div className="palette-empty">Searching…</div>}
              {!searching && results.length === 0 && <div className="palette-empty">No issues match “{q}”.</div>}
              {items.issueItems.map((it, j) => {
                const i = items.actions.length + j;
                return (
                  <button
                    key={it.id}
                    className={`palette-item ${sel === i ? 'sel' : ''}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => activate(i)}
                  >
                    <span className="key">{it.issue.key}</span>
                    <span className="p-title">{it.issue.title}</span>
                    <SeverityGlyph severity={it.issue.severity} />
                    <StatusPill status={it.issue.status} />
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
