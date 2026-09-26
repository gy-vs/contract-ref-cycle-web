import {useCallback, useEffect, useRef, useState} from 'react';
import {AlertTriangle, Braces, ChevronDown, ChevronRight, RefreshCw, Save, ShieldCheck} from 'lucide-react';
import {ISSUE_META, isStale, issueKey, reconcileExpanded, type RefIssue} from './issues';

type Summary = {id: string; name: string; revision: number};
type Contract = Summary & {schema: Record<string, unknown>};

type PreviewState = {
  valid: boolean;
  issues: RefIssue[];
  schema: unknown;
  stats: {targetsResolved: number; refHits: number};
};

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('orders');
  const [contract, setContract] = useState<Contract | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [status, setStatus] = useState<{tone: 'idle' | 'loading' | 'ok' | 'warning' | 'error'; text: string}>(
    {tone: 'idle', text: 'Ready'},
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Monotonic token: only the latest selected/validate request may render.
  const requestSeq = useRef(0);

  useEffect(() => {
    fetch('/api/contracts').then(r => r.json()).then(setItems);
  }, []);

  const applyPreview = useCallback((next: PreviewState) => {
    setExpanded(previous => reconcileExpanded(previous, next.issues).next);
    setPreview(next);
  }, []);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setStatus({tone: 'loading', text: '正在加载契约'});
    // Drop the previous example's preview immediately so a stale, expanded
    // error from the old example can never point at nodes of the new one.
    setPreview(null);
    fetch('/api/contracts/' + selected)
      .then(r => r.json())
      .then((data: Contract) => {
        if (isStale(seq, requestSeq.current)) return;
        setContract(data);
        setText(JSON.stringify(data.schema, null, 2));
        setStatus({tone: 'loading', text: '正在解析引用'});
        return fetch('/api/contracts/' + selected + '/preview', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({schema: data.schema}),
        }).then(r => r.json() as Promise<PreviewState>);
      })
      .then(result => {
        if (!result || isStale(seq, requestSeq.current)) return;
        applyPreview(result);
        setStatus({
          tone: statusTone(result),
          text: statusText(result),
        });
      })
      .catch(error => {
        if (isStale(seq, requestSeq.current)) return;
        setStatus({tone: 'error', text: String(error)});
      });
  }, [selected, applyPreview]);

  async function validate(initial?: Record<string, unknown>) {
    let schema: Record<string, unknown>;
    try {
      schema = initial ?? JSON.parse(text);
    } catch (error) {
      setStatus({tone: 'error', text: `JSON 解析失败：${String(error)}`});
      return;
    }
    const seq = ++requestSeq.current;
    setStatus({tone: 'loading', text: '正在解析引用'});
    try {
      const response = await fetch('/api/contracts/' + selected + '/preview', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({schema}),
      });
      const result = (await response.json()) as PreviewState;
      if (isStale(seq, requestSeq.current)) return;
      applyPreview(result);
      setStatus({tone: statusTone(result), text: statusText(result)});
    } catch (error) {
      if (isStale(seq, requestSeq.current)) return;
      setStatus({tone: 'error', text: String(error)});
    }
  }

  async function save() {
    if (!contract) return;
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(text);
    } catch (error) {
      setStatus({tone: 'error', text: `JSON 解析失败：${String(error)}`});
      return;
    }
    const seq = ++requestSeq.current;
    setStatus({tone: 'loading', text: '正在保存'});
    const response = await fetch('/api/contracts/' + contract.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({schema, revision: contract.revision}),
    });
    const updated = (await response.json()) as Contract;
    if (isStale(seq, requestSeq.current)) return;
    setContract(updated);
    setText(JSON.stringify(updated.schema, null, 2));
    await validate(updated.schema);
  }

  function toggle(key: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return <main className="shell">
    <header className="topbar"><Braces size={20}/><span className="brand">Contract Studio</span><small>契约引用工作台</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>契约示例</h2>
        <div className="list">{items.map(item =>
          <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/> 保存</button>
          <button onClick={() => validate()}><RefreshCw size={15}/> 重新解析</button>
          <span className={`status status-${status.tone}`}>{status.text}</span>
        </div>
        <textarea aria-label="Contract schema" value={text} onChange={event => setText(event.target.value)}/>
      </section>
      <section className="pane preview-pane">
        <h2>引用解析</h2>
        <span className="pill">{selected}</span>
        {preview && <div className="stats">
          <ShieldCheck size={14}/>
          <span>{preview.stats.refHits} 处引用 / {preview.stats.targetsResolved} 个节点实际展开</span>
        </div>}
        <IssueList issues={preview?.issues ?? []} expanded={expanded} onToggle={toggle}/>
        <h3>解析结果</h3>
        <pre>{JSON.stringify(preview?.schema ?? null, null, 2)}</pre>
      </section>
    </section>
  </main>;
}

function statusTone(result: PreviewState): 'ok' | 'warning' | 'error' {
  if (result.issues.some(issue => issue.code === 'cycle' || issue.code === 'invalid_pointer')) {
    return 'error';
  }
  if (result.issues.length > 0) return 'warning';
  return 'ok';
}

function statusText(result: PreviewState): string {
  const base = `${result.stats.refHits} 处引用，${result.stats.targetsResolved} 个节点实际展开`;
  return result.issues.length === 0
    ? `解析完成：${base}`
    : `${result.valid ? '解析完成' : '解析失败'}：${result.issues.length} 个问题（${base}）`;
}

function IssueList({issues, expanded, onToggle}: {
  issues: RefIssue[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (issues.length === 0) {
    return <div className="issues issues-empty">未发现引用问题。</div>;
  }
  return <div className="issues">
    {issues.map(issue => {
      const key = issueKey(issue);
      const isOpen = expanded.has(key);
      const meta = ISSUE_META[issue.code];
      return <div className={`issue issue-${meta.tone}`} key={key}>
        <button className="issue-head" onClick={() => onToggle(key)} aria-expanded={isOpen}>
          {isOpen ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
          <AlertTriangle size={14}/>
          <span className="issue-code">{meta.label}</span>
          <code className="issue-instance">{issue.instancePath}</code>
        </button>
        {isOpen && <div className="issue-body">
          <p>{issue.message}</p>
          <dl>
            <dt>实例路径</dt><dd><code>{issue.instancePath}</code></dd>
            <dt>Schema 路径</dt><dd><code>{issue.schemaPath}</code></dd>
            <dt>$ref</dt><dd><code>{issue.ref}</code></dd>
            <dt>引用链</dt>
            <dd><Chain chain={issue.chain}/></dd>
          </dl>
        </div>}
      </div>;
    })}
  </div>;
}

function Chain({chain}: {chain: string[]}) {
  return <div className="chain">
    {chain.map((hop, index) => (
      <span className="chain-hop" key={`${hop}-${index}`}>
        {index > 0 && <span className="chain-arrow" aria-hidden="true">→</span>}
        <code className={index === chain.length - 1 && chain.length > 1 ? 'chain-cycle' : ''}>{hop}</code>
      </span>
    ))}
  </div>;
}
