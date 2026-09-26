import express from 'express';
import {fileURLToPath} from 'node:url';
import {resolveRefs, type SchemaFetcher} from './ref-resolver';

type Contract = {id: string; name: string; revision: number; schema: Record<string, unknown>};
const contracts: Contract[] = [
  {id: 'orders', name: 'Order event', revision: 4, schema: {type: 'object', properties: {id: {type: 'string'}, total: {type: 'number'}}}},
  {id: 'profiles', name: 'Profile event', revision: 7, schema: {type: 'object', properties: {name: {type: 'string'}, locale: {type: 'string'}}}},
];

async function defaultRemoteFetcher(uri: string): Promise<unknown> {
  const response = await fetch(uri, {
    signal: AbortSignal.timeout(5000),
    headers: {accept: 'application/json, application/schema+json'},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export interface CreateAppOptions {
  fetcher?: SchemaFetcher;
}

export function createApp(options: CreateAppOptions = {}) {
  const fetcher = options.fetcher ?? defaultRemoteFetcher;
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.get('/api/bootstrap', (_req, res) => res.json({kind: 'contract', count: contracts.length}));
  app.get('/api/contracts', (_req, res) => res.json(contracts.map(({id, name, revision}) => ({id, name, revision}))));
  app.get('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(contract.revision)).json(contract);
  });
  app.post('/api/contracts/:id/preview', async (req, res) => {
    const delay = req.params.id === 'orders' ? 240 : 30;
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const result = await resolveRefs(req.body?.schema ?? {}, {fetcher});
      const payload = {contractId: req.params.id, valid: result.errors.length === 0, schema: result.schema, errors: result.errors, stats: result.stats};
      if (payload.valid) return res.json(payload);
      return res.status(422).json(payload);
    } catch (error) {
      return res.status(500).json({contractId: req.params.id, error: 'resolution_failed', message: String(error)});
    }
  });
  app.put('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    contract.schema = req.body.schema;
    contract.revision += 1;
    res.json(contract);
  });
  app.post('/api/contracts/:id/validate-all', (_req, res) => res.json({results: [{id: 'sample-1', valid: true}]}));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
