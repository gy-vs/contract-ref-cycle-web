import express from 'express';
import {fileURLToPath} from 'node:url';
import {resolveSchema, type RefIssue} from './refs.js';

type Contract = {id: string; name: string; revision: number; schema: Record<string, unknown>};

const contracts: Contract[] = [
  {
    id: 'orders',
    name: 'Order event',
    revision: 4,
    schema: {
      type: 'object',
      properties: {
        id: {type: 'string'},
        total: {type: 'number'},
        // Diamond: both billing/shipping reuse #/$defs/address, which in turn
        // reuses #/$defs/geo in two branches.
        billing: {$ref: '#/$defs/address'},
        shipping: {$ref: '#/$defs/address'},
      },
      $defs: {
        address: {
          type: 'object',
          properties: {
            street: {type: 'string'},
            city: {type: 'string'},
            geo: {$ref: '#/$defs/geo'},
            backupGeo: {$ref: '#/$defs/geo'},
          },
        },
        geo: {type: 'object', properties: {lat: {type: 'number'}, lng: {type: 'number'}}},
      },
    },
  },
  {
    id: 'profiles',
    name: 'Profile event',
    revision: 7,
    schema: {
      type: 'object',
      properties: {
        name: {type: 'string'},
        locale: {type: 'string'},
        // The same definition reused at two distinct instance locations.
        primaryFriend: {$ref: '#/$defs/person'},
        friends: {type: 'array', items: {$ref: '#/$defs/person'}},
      },
      $defs: {
        // Direct self recursion.
        person: {
          type: 'object',
          properties: {
            name: {type: 'string'},
            bestFriend: {$ref: '#/$defs/person'},
            // Indirect recursion through a second definition.
            manager: {$ref: '#/$defs/role'},
          },
        },
        role: {
          type: 'object',
          properties: {
            title: {type: 'string'},
            holder: {$ref: '#/$defs/person'},
          },
        },
      },
    },
  },
  {
    id: 'inventory',
    name: 'Inventory event',
    revision: 2,
    schema: {
      type: 'object',
      properties: {
        sku: {type: 'string'},
        // Remote reference; the loader below only knows a couple of URIs.
        dimensions: {$ref: 'https://contract.local/remotes/common.json#/$defs/measure'},
        warehouse: {$ref: 'https://contract.local/remotes/missing.json#/$defs/site'},
      },
    },
  },
];

// Stand-in for a remote schema registry. Failures must surface as structured
// issues rather than crashing the request.
const remoteDocuments = new Map<string, unknown>([
  [
    'https://contract.local/remotes/common.json',
    {
      $defs: {
        measure: {
          type: 'object',
          properties: {
            length: {type: 'number'},
            width: {type: 'number'},
            height: {type: 'number'},
          },
        },
      },
    },
  ],
]);

async function loadRemote(uri: string) {
  const doc = remoteDocuments.get(uri);
  if (doc === undefined) throw new Error(`document not found in registry`);
  // Simulate network latency so callers can observe loading behaviour.
  await new Promise(resolve => setTimeout(resolve, 5));
  return doc;
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.get('/api/bootstrap', (_req, res) => res.json({kind: 'contract', count: contracts.length}));
  app.get('/api/contracts', (_req, res) =>
    res.json(contracts.map(({id, name, revision}) => ({id, name, revision}))),
  );
  app.get('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(contract.revision)).json(contract);
  });
  app.post('/api/contracts/:id/preview', async (req, res) => {
    const contractId = req.params.id;
    if (!contracts.some(item => item.id === contractId)) {
      return res.status(404).json({error: 'not_found'});
    }
    const inputSchema = (req.body as {schema?: unknown}).schema;
    if (inputSchema === undefined) {
      return res.status(400).json({contractId, valid: false, error: 'missing schema'});
    }
    // Example requests are deliberately uneven so rapid switching can race;
    // the client must keep only the newest response.
    const latency = contractId === 'orders' ? 120 : 15;
    await new Promise(resolve => setTimeout(resolve, latency));
    const result = await resolveSchema(inputSchema, {loadRemote});
    const fatalIssues = result.issues.filter(issue => issue.code !== 'remote_unavailable');
    res.json({
      contractId,
      valid: fatalIssues.length === 0,
      issues: result.issues,
      stats: {
        targetsResolved: result.targetsResolved,
        refHits: result.refHits,
      },
      schema: result.schema,
    } satisfies PreviewResponse);
  });
  app.put('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    contract.schema = (req.body as {schema: Record<string, unknown>}).schema;
    contract.revision += 1;
    res.json(contract);
  });
  app.post('/api/contracts/:id/validate-all', (_req, res) =>
    res.json({results: [{id: 'sample-1', valid: true}]}),
  );
  return app;
}

type PreviewResponse = {
  contractId: string;
  valid: boolean;
  issues: RefIssue[];
  stats: {targetsResolved: number; refHits: number};
  schema: unknown;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
