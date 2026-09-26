import {afterEach, describe, expect, it, vi} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {SchemaFetcher} from '../src/server/ref-resolver';

const diamondSchema = {
  definitions: {address: {type: 'object', properties: {street: {type: 'string'}}}},
  properties: {
    home: {$ref: '#/definitions/address'},
    work: {$ref: '#/definitions/address'},
  },
};

const indirectCycleSchema = {
  definitions: {
    a: {$ref: '#/definitions/b'},
    b: {$ref: '#/definitions/a'},
  },
  properties: {value: {$ref: '#/definitions/a'}},
};

describe('preview API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves a diamond schema with inline refs and cache stats', async () => {
    const response = await request(createApp())
      .post('/api/contracts/profiles/preview')
      .send({schema: diamondSchema});
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.errors).toEqual([]);
    expect(response.body.schema.properties.home).toEqual(diamondSchema.definitions.address);
    expect(response.body.schema.properties.work).toEqual(diamondSchema.definitions.address);
    expect(response.body.stats.refResolutions).toBe(1);
    expect(response.body.stats.refCacheHits).toBe(1);
  });

  it('keeps resolving shared references across separate requests (no global visited state)', async () => {
    const app = createApp();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app)
        .post('/api/contracts/profiles/preview')
        .send({schema: diamondSchema});
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
    }
  });

  it('returns 422 with a complete reference chain for an indirect cycle', async () => {
    const response = await request(createApp())
      .post('/api/contracts/profiles/preview')
      .send({schema: indirectCycleSchema});
    expect(response.status).toBe(422);
    expect(response.body.valid).toBe(false);
    const chains = response.body.errors.map((error: {chain: string[]}) => error.chain.join(' -> '));
    expect(chains).toContain('#/definitions/a -> #/definitions/b -> #/definitions/a');
    for (const error of response.body.errors as {instancePath: string; schemaPath: string}[]) {
      expect(error.instancePath).toBeTruthy();
      expect(error.schemaPath).toBeTruthy();
    }
  });

  it('reports remote fetch failures with an injected fetcher', async () => {
    const fetcher = vi.fn<SchemaFetcher>(async () => {
      throw new Error('ECONNREFUSED 0.0.0.0:4174');
    });
    const schema = {
      properties: {remote: {$ref: 'https://schemas.example.com/missing.json#/definitions/x'}},
    };
    const response = await request(createApp({fetcher}))
      .post('/api/contracts/profiles/preview')
      .send({schema});
    expect(response.status).toBe(422);
    expect(response.body.valid).toBe(false);
    expect(response.body.errors).toHaveLength(1);
    expect(response.body.errors[0].kind).toBe('remote-fetch-failed');
    expect(response.body.errors[0].instancePath).toBe('/properties/remote');
    expect(response.body.errors[0].message).toContain('ECONNREFUSED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('resolves remote references successfully with an injected fetcher', async () => {
    const fetcher = vi.fn<SchemaFetcher>(async () => ({
      definitions: {id: {type: 'string'}},
    }));
    const schema = {
      properties: {id: {$ref: 'https://schemas.example.com/common.json#/definitions/id'}},
    };
    const response = await request(createApp({fetcher}))
      .post('/api/contracts/profiles/preview')
      .send({schema});
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.schema.properties.id).toEqual({type: 'string'});
    expect(response.body.stats.remoteFetches).toBe(1);
  });
});
