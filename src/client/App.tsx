import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, Braces, CheckCircle2, ChevronDown, ChevronRight, RefreshCw, Save} from 'lucide-react';
import {errorKey, reconcileExpanded, type PreviewError, type PreviewResponse} from './preview-errors';
import {RequestSequencer} from './request-sequencer';

type Summary = {id: string; name: string; revision: number};
type Contract = Summary & {schema: Record<string, unknown>};

async function readJson(response: Response): Promise<unknown> {
  const body = (await response.json()) as unknown;
  if (!response.ok && !(body && typeof body === 'object' && 'valid' in body)) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return body;
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('orders');
  const [contract, setContract] = useState<Contract | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState('Ready');
  const sequencer = useRef(new RequestSequencer());

  useEffect(() => {
    fetch('/api/contracts').then(r => r.json()).then(setItems);
  }, []);

  async function postPreview(contractId: string, schema: unknown, isCurrent: () => boolean): Promise<PreviewResponse | null> {
    setStatus('Resolving references');
    const response = await fetch('/api/contracts/' + contractId + '/preview', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({schema}),
    });
    const body = await readJson(response);
    if (!isCurrent()) return null;
    return body as PreviewResponse;
  }

  async function loadWorkspace(contractId: string) {
    const {isCurrent} = sequencer.current.next();
    try {
      setStatus('Loading contract');
      const response = await fetch('/api/contracts/' + contractId);
      const data = (await readJson(response)) as Contract;
      if (!isCurrent()) return;
      setContract(data);
      setText(JSON.stringify(data.schema, null, 2));
      const result = await postPreview(contractId, data.schema, isCurrent);
      if (!result) return;
      setPreview(result);
      setStatus(result.valid ? 'Resolved' : `${result.errors?.length ?? 0} reference error(s)`);
    } catch (error) {
      if (isCurrent()) setStatus(String(error));
    }
  }

  useEffect(() => {
    void loadWorkspace(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const errors = preview && !preview.valid ? (preview.errors ?? []) : [];

  // After any data refresh, keep expansions whose error still exists and
  // remove ones pointing at nodes that are gone (e.g. after switching
  // examples).
  useEffect(() => {
    setExpanded(previous => reconcileExpanded(previous, errors));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  function toggleExpanded(key: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    if (!contract) return;
    const {isCurrent} = sequencer.current.next();
    try {
      setStatus('Saving');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const response = await fetch('/api/contracts/' + contract.id, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({schema: parsed, revision: contract.revision}),
      });
      const saved = (await readJson(response)) as Contract;
      if (!isCurrent()) return;
      setContract(saved);
      const result = await postPreview(saved.id, saved.schema, isCurrent);
      if (!result) return;
      setPreview(result);
      setStatus(result.valid ? 'Saved and resolved' : `Saved with ${result.errors?.length ?? 0} reference error(s)`);
    } catch (error) {
      if (isCurrent()) setStatus(String(error));
    }
  }

  return <main className="shell">
    <header className="topbar"><Braces size={20}/><span className="brand">Contract Studio</span><small>Schema workspace</small></header>
    <section className="workspace">
      <aside className="pane"><h2>Contracts</h2><div className="list">{items.map(item => <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside>
      <section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/> Save</button><span className="status">{status}</span></div><textarea aria-label="Contract schema" value={text} onChange={event => setText(event.target.value)}/></section>
      <section className="pane">
        <h2><RefreshCw size={16}/> Preview</h2>
        <div className="toolbar">
          <span className="pill">{selected}</span>
          {preview?.stats && <span className="pill">resolved {preview.stats.refResolutions} · cached {preview.stats.refCacheHits} · remote {preview.stats.remoteFetches}</span>}
        </div>
        {preview?.valid
          ? <pre>{JSON.stringify(preview.schema, null, 2)}</pre>
          : errors.length > 0
            ? <ul className="errors" aria-label="Reference errors">
                {errors.map(error => {
                  const key = errorKey(error);
                  const isOpen = expanded.has(key);
                  return <li key={key} className="error-item">
                    <button className="error-head" aria-expanded={isOpen} onClick={() => toggleExpanded(key)}>
                      {isOpen ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
                      <AlertTriangle size={15} className="error-icon"/>
                      <span>{error.message}</span>
                    </button>
                    <div className="error-location"><code>{error.instancePath || '#'}</code><span> → </span><code>{error.schemaPath}</code></div>
                    {isOpen && <ol className="error-chain">
                      {error.chain.map((step, index) => <li key={`${index}:${step}`}><code>{step}</code>{index < error.chain.length - 1 && <span className="chain-arrow"> →</span>}</li>)}
                    </ol>}
                  </li>;
                })}
              </ul>
            : <pre>{JSON.stringify(preview?.schema ?? null, null, 2)}</pre>}
        {preview?.valid && <p className="valid-note"><CheckCircle2 size={14}/> All references resolved</p>}
      </section>
    </section>
  </main>;
}
