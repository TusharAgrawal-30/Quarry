import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, useActorById } from '../components/atoms';
import { api, ApiFailure } from '../lib/api';
import { useApp } from '../lib/app-state';

// Products → components: the hierarchy issues live under. Bugs are filed
// against a component of a product; keys are minted per product.

export function ProductsView() {
  const { meta, actor, reloadMeta, toast } = useApp();
  const actorById = useActorById();
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [compName, setCompName] = useState('');
  const [compDesc, setCompDesc] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [pKey, setPKey] = useState('');
  const [pName, setPName] = useState('');
  const [pDesc, setPDesc] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!meta) return;
    Promise.all(
      meta.products.map((p) => api.issues({ product: p.key, open: 'true', limit: '1' }).then((r) => [p.key, r.total] as const)),
    )
      .then((pairs) => setCounts(new Map(pairs)))
      .catch(() => undefined);
  }, [meta]);

  if (!meta || !actor) return null;

  const addComponent = async (productKey: string) => {
    setBusy(true);
    try {
      await api.createComponent(productKey, { name: compName, description: compDesc });
      toast({ kind: 'success', message: `Component "${compName}" added to ${productKey}.` });
      setAddingTo(null);
      setCompName('');
      setCompDesc('');
      reloadMeta();
    } catch (e) {
      toast({ kind: 'error', message: e instanceof ApiFailure ? e.message : 'Could not add component.' });
    } finally {
      setBusy(false);
    }
  };

  const addProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createProduct({ key: pKey, name: pName, description: pDesc });
      toast({ kind: 'success', message: `Product ${pKey.toUpperCase()} created.` });
      setNewOpen(false);
      setPKey('');
      setPName('');
      setPDesc('');
      reloadMeta();
    } catch (ex) {
      toast({ kind: 'error', message: ex instanceof ApiFailure ? ex.message : 'Could not create product.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head rise">
        <h1 className="page-title">Products &amp; components</h1>
        <span className="page-sub">issues live under a component of a product — keys are minted per product</span>
        <span className="spacer" />
        <button className="btn" onClick={() => setNewOpen(true)}>
          New product
        </button>
      </div>

      <div className="product-grid rise rise-1">
        {meta.products.map((p) => (
          <div key={p.key} className="card product-card">
            <h3>
              <span className="key" style={{ fontSize: 14 }}>
                {p.key}
              </span>{' '}
              {p.name}
            </h3>
            <p className="desc">{p.description}</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <Link className="btn sm" to={`/?product=${p.key}&open=true`}>
                {counts.get(p.key) ?? '…'} open issues
              </Link>
              <Link className="btn sm ghost" to={`/board?product=${p.key}`}>
                Board
              </Link>
            </div>
            {meta.components
              .filter((c) => c.product_id === p.id)
              .map((c) => (
                <div key={c.id} className="component-row">
                  <span className="cname">{c.name}</span>
                  <span className="cdesc">{c.description}</span>
                  <Avatar actor={actorById(c.lead_id)} />
                </div>
              ))}
            {addingTo === p.key ? (
              <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                <input value={compName} onChange={(e) => setCompName(e.target.value)} placeholder="component-name" aria-label="Component name" style={{ flex: 1, minWidth: 120 }} />
                <input value={compDesc} onChange={(e) => setCompDesc(e.target.value)} placeholder="what it covers" aria-label="Component description" style={{ flex: 2, minWidth: 140 }} />
                <button className="btn sm primary" disabled={busy || !compName.trim()} onClick={() => addComponent(p.key)}>
                  Add
                </button>
                <button className="btn sm ghost" onClick={() => setAddingTo(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => { setAddingTo(p.key); setCompName(''); setCompDesc(''); }}>
                + Add component
              </button>
            )}
          </div>
        ))}
      </div>

      {newOpen && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setNewOpen(false)}>
          <form className="dialog" onSubmit={addProduct} role="dialog" aria-modal="true" aria-label="New product">
            <div className="dialog-head">
              <h2>New product</h2>
              <button type="button" className="btn ghost sm" onClick={() => setNewOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="dialog-body">
              <div className="row2">
                <div className="field">
                  <label htmlFor="np-key">Key (mints issue keys like KEY-1)</label>
                  <input id="np-key" value={pKey} onChange={(e) => setPKey(e.target.value.toUpperCase())} placeholder="RELAY" maxLength={10} required style={{ fontFamily: 'var(--mono)' }} autoFocus />
                </div>
                <div className="field">
                  <label htmlFor="np-name">Name</label>
                  <input id="np-name" value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Relay" required />
                </div>
              </div>
              <div className="field">
                <label htmlFor="np-desc">Description</label>
                <input id="np-desc" value={pDesc} onChange={(e) => setPDesc(e.target.value)} placeholder="What this product is" />
              </div>
            </div>
            <div className="dialog-foot">
              <button type="button" className="btn" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy || !pKey.trim() || !pName.trim()}>
                Create product
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
