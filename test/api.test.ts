import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('preview API', () => {
  it('accepts a diamond schema as valid with a single target resolution', async () => {
    const response = await request(createApp())
      .post('/api/contracts/orders/preview')
      .send({
        schema: {
          type: 'object',
          properties: {
            a: {$ref: '#/$defs/shared'},
            b: {$ref: '#/$defs/shared'},
          },
          $defs: {
            shared: {type: 'object', properties: {x: {$ref: '#/$defs/x'}}},
            x: {type: 'string'},
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.issues).toEqual([]);
    expect(response.body.stats.targetsResolved).toBe(2);
    expect(response.body.schema.properties.a.properties.x.type).toBe('string');
    expect(response.body.schema.properties.b.properties.x.type).toBe('string');
  });

  it('returns a complete cycle chain and per-site paths', async () => {
    const response = await request(createApp())
      .post('/api/contracts/orders/preview')
      .send({
        schema: {
          type: 'object',
          properties: {
            p1: {$ref: '#/$defs/node'},
            p2: {$ref: '#/$defs/node'},
          },
          $defs: {
            node: {type: 'object', properties: {next: {$ref: '#/$defs/node'}}},
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.issues).toHaveLength(2);
    for (const issue of response.body.issues) {
      expect(issue.code).toBe('cycle');
      expect(issue.chain).toEqual(['#/$defs/node', '#/$defs/node']);
      expect(issue.schemaPath).toBe('#/$defs/node/properties/next/$ref');
    }
    expect(response.body.issues.map((i: any) => i.instancePath).sort()).toEqual([
      '#/p1/next',
      '#/p2/next',
    ]);
  });

  it('marks remote fetch failures without dropping the rest of the document', async () => {
    const response = await request(createApp())
      .post('/api/contracts/inventory/preview')
      .send({
        schema: {
          type: 'object',
          properties: {
            size: {$ref: 'https://contract.local/remotes/common.json#/$defs/measure'},
            missing: {$ref: 'https://contract.local/remotes/missing.json#/$defs/site'},
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.issues).toHaveLength(1);
    expect(response.body.issues[0].code).toBe('remote_unavailable');
    expect(response.body.issues[0].instancePath).toBe('#/missing');
    expect(response.body.schema.properties.size.properties.length.type).toBe('number');
  });

  it('rejects missing schema payload and unknown contracts', async () => {
    const app = createApp();
    const badPayload = await request(app).post('/api/contracts/orders/preview').send({});
    expect(badPayload.status).toBe(400);
    const missing = await request(app).post('/api/contracts/nope/preview').send({schema: {}});
    expect(missing.status).toBe(404);
  });

  it('analyses the seeded profile schema: direct and indirect cycles with chains', async () => {
    const contract = await request(createApp()).get('/api/contracts/profiles');
    const response = await request(createApp())
      .post('/api/contracts/profiles/preview')
      .send({schema: contract.body.schema});

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    const chains = response.body.issues.map((issue: any) => issue.chain);
    // Direct self recursion.
    expect(chains).toContainEqual(['#/$defs/person', '#/$defs/person']);
    // Indirect recursion person -> role -> person.
    expect(chains).toContainEqual(['#/$defs/person', '#/$defs/role', '#/$defs/person']);
    // Every issue carries both paths.
    for (const issue of response.body.issues) {
      expect(issue.instancePath).toMatch(/^#\//);
      expect(issue.schemaPath).toMatch(/\/\$ref$/);
    }
  });

  it('keeps concurrent previews isolated despite shared resolver internals', async () => {
    const app = createApp();
    const diamond = {
      type: 'object',
      properties: {a: {$ref: '#/$defs/s'}, b: {$ref: '#/$defs/s'}},
      $defs: {s: {type: 'string'}},
    };
    const cyclic = {
      type: 'object',
      properties: {x: {$ref: '#/$defs/n'}},
      $defs: {n: {$ref: '#/$defs/n'}},
    };
    const [first, second] = await Promise.all([
      request(app).post('/api/contracts/profiles/preview').send({schema: diamond}),
      request(app).post('/api/contracts/orders/preview').send({schema: cyclic}),
    ]);
    expect(first.body.issues).toEqual([]);
    expect(second.body.issues).toHaveLength(1);
    expect(second.body.issues[0].chain).toEqual(['#/$defs/n', '#/$defs/n']);
  });
});
