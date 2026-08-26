import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiFailure } from '../lib/api';
import { useApp } from '../lib/app-state';

export function NewIssueDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { meta, actor, toast } = useApp();
  const nav = useNavigate();
  const [productKey, setProductKey] = useState('');
  const [componentId, setComponentId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState('normal');
  const [priority, setPriority] = useState('p3');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const product = productKey || meta?.products[0]?.key || '';
  const components = useMemo(() => {
    const p = meta?.products.find((x) => x.key === product);
    return meta?.components.filter((c) => c.product_id === p?.id) ?? [];
  }, [meta, product]);
  const compId = componentId && components.some((c) => String(c.id) === componentId) ? componentId : String(components[0]?.id ?? '');

  if (!open || !meta || !actor) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const issue = await api.createIssue({
        productKey: product,
        componentId: Number(compId),
        title,
        body,
        severity,
        priority,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
        actorId: actor.id,
      });
      toast({ kind: 'success', message: `${issue.key} filed.` });
      onClose();
      setTitle('');
      setBody('');
      setLabels('');
      nav(`/issue/${issue.key}`);
    } catch (ex) {
      setErr(ex instanceof ApiFailure ? ex.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-label="File a new issue">
        <div className="dialog-head">
          <h2>File a new issue</h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        <div className="dialog-body">
          <div className="row2">
            <div className="field">
              <label htmlFor="ni-product">Product</label>
              <select id="ni-product" value={product} onChange={(e) => { setProductKey(e.target.value); setComponentId(''); }}>
                {meta.products.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ni-component">Component</label>
              <select id="ni-component" value={compId} onChange={(e) => setComponentId(e.target.value)}>
                {components.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ni-title">Title</label>
            <input id="ni-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="One line: what breaks, where, under what conditions" autoFocus />
          </div>
          <div className="field">
            <label htmlFor="ni-body">Description — markdown, paste stack traces in ``` fences</label>
            <textarea id="ni-body" value={body} onChange={(e) => setBody(e.target.value)} rows={7} placeholder={'## Steps to reproduce\n1. …\n\n## Expected\n\n## Actual'} />
          </div>
          <div className="row2">
            <div className="field">
              <label htmlFor="ni-sev">Severity — how bad is the impact</label>
              <select id="ni-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {meta.severities.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ni-pri">Priority — when the team works it</label>
              <select id="ni-pri" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {meta.priorities.map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ni-labels">Labels (comma-separated)</label>
            <input id="ni-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="crash, customer-report" />
          </div>
          {err && <div className="error-banner" role="alert">{err}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
            {busy ? 'Filing…' : 'File issue'}
          </button>
        </div>
      </form>
    </div>
  );
}
