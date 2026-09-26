import {describe, expect, it} from 'vitest';
import {resolveRefs, type SchemaFetcher} from '../src/server/ref-resolver';

const addressSchema = {
  type: 'object',
  properties: {street: {type: 'string'}, zip: {type: 'string'}},
};

describe('resolveRefs – shared references (diamond)', () => {
  it('resolves the same definitions node from multiple instance positions', async () => {
    const schema = {
      definitions: {address: addressSchema},
      type: 'object',
      properties: {
        home: {$ref: '#/definitions/address'},
        work: {$ref: '#/definitions/address'},
      },
    };
    const result = await resolveRefs(schema);
    expect(result.errors).toEqual([]);
    const properties = result.schema as {properties: Record<string, unknown>};
    expect(properties.properties.home).toEqual(addressSchema);
    expect(properties.properties.work).toEqual(addressSchema);
  });

  it('does not re-resolve a shared reference once per use site', async () => {
    const count = 25;
    const schema = {
      definitions: {address: addressSchema},
      properties: Object.fromEntries(
        Array.from({length: count}, (_, index) => [`p${index}`, {$ref: '#/definitions/address'}]),
      ),
    };
    const result = await resolveRefs(schema);
    expect(result.errors).toEqual([]);
    expect(result.stats.refResolutions).toBe(1);
    expect(result.stats.refCacheHits).toBe(count - 1);
  });

  it('resolves nested shared schemas once across all reuse positions', async () => {
    const schema = {
      definitions: {
        currency: {type: 'string', enum: ['USD', 'EUR']},
        money: {type: 'object', properties: {amount: {type: 'number'}, currency: {$ref: '#/definitions/currency'}}},
      },
      properties: {
        price: {$ref: '#/definitions/money'},
        discount: {$ref: '#/definitions/money'},
        tax: {$ref: '#/definitions/money'},
      },
    };
    const result = await resolveRefs(schema);
    expect(result.errors).toEqual([]);
    expect(result.stats.refResolutions).toBe(2); // money and currency only
    const expectedMoney = {
      type: 'object',
      properties: {amount: {type: 'number'}, currency: {type: 'string', enum: ['USD', 'EUR']}},
    };
    const properties = (result.schema as {properties: Record<string, unknown>}).properties;
    for (const position of ['price', 'discount', 'tax']) {
      expect(properties[position]).toEqual(expectedMoney);
    }
  });
});

describe('resolveRefs – circular references', () => {
  it('reports a direct cycle with the full reference chain and instance path', async () => {
    const schema = {definitions: {node: {$ref: '#/definitions/node'}}};
    const result = await resolveRefs(schema);
    expect(result.errors).toHaveLength(1);
    const error = result.errors[0];
    expect(error.kind).toBe('circular-reference');
    expect(error.instancePath).toBe('/definitions/node');
    expect(error.schemaPath).toBe('#/definitions/node');
    expect(error.chain).toEqual(['#/definitions/node', '#/definitions/node']);
    expect(error.message).toBe('Circular reference: #/definitions/node -> #/definitions/node');
  });

  it('reports an indirect cycle a -> b -> a with the complete chain', async () => {
    const schema = {
      definitions: {
        a: {$ref: '#/definitions/b'},
        b: {$ref: '#/definitions/a'},
      },
    };
    const result = await resolveRefs(schema);
    expect(result.errors).toHaveLength(2);
    // The chain starts with the $ref actually written at each instance node.
    expect(result.errors[0].instancePath).toBe('/definitions/a');
    expect(result.errors[0].ref).toBe('#/definitions/b');
    expect(result.errors[0].chain).toEqual(['#/definitions/b', '#/definitions/a', '#/definitions/b']);
    expect(result.errors[1].instancePath).toBe('/definitions/b');
    expect(result.errors[1].ref).toBe('#/definitions/a');
    expect(result.errors[1].chain).toEqual(['#/definitions/a', '#/definitions/b', '#/definitions/a']);
  });

  it('does not let cached failures carry the first-visit path to later positions', async () => {
    const schema = {
      definitions: {loop: {$ref: '#/definitions/loop'}},
      properties: {
        first: {$ref: '#/definitions/loop'},
        second: {$ref: '#/definitions/loop'},
      },
    };
    const result = await resolveRefs(schema);
    const byInstancePath = new Map(result.errors.map(error => [error.instancePath, error]));
    expect([...byInstancePath.keys()].sort()).toEqual([
      '/definitions/loop',
      '/properties/first',
      '/properties/second',
    ]);
    // Every reuse site gets its own instance path even though the failure was
    // cached at the first visit; the chain itself is location independent.
    for (const path of ['/definitions/loop', '/properties/first', '/properties/second']) {
      expect(byInstancePath.get(path)?.chain).toEqual(['#/definitions/loop', '#/definitions/loop']);
    }
    expect(result.stats.refResolutions).toBe(1);
    expect(result.stats.refCacheHits).toBe(2);
  });

  it('still accepts a shared node that merely appeared earlier in a finished chain', async () => {
    const schema = {
      definitions: {
        leaf: {type: 'string'},
        branch: {type: 'object', properties: {a: {$ref: '#/definitions/leaf'}, b: {$ref: '#/definitions/leaf'}}},
      },
      properties: {
        x: {$ref: '#/definitions/branch'},
        y: {$ref: '#/definitions/branch'},
      },
    };
    const result = await resolveRefs(schema);
    expect(result.errors).toEqual([]);
    expect(result.stats.refResolutions).toBe(2); // branch + leaf
  });
});

describe('resolveRefs – remote references', () => {
  const documentUri = 'https://schemas.example.com/common.json';

  function recordingFetcher(docs: Record<string, unknown>): {fetcher: SchemaFetcher; calls: string[]} {
    const calls: string[] = [];
    return {
      calls,
      fetcher: async (uri: string) => {
        calls.push(uri);
        if (!(uri in docs)) throw new Error('ECONNREFUSED');
        return docs[uri];
      },
    };
  }

  it('fetches a remote document once for many references into it', async () => {
    const {fetcher, calls} = recordingFetcher({
      [documentUri]: {definitions: {id: {type: 'string'}, ts: {type: 'number'}}},
    });
    const schema = {
      properties: {
        a: {$ref: `${documentUri}#/definitions/id`},
        b: {$ref: `${documentUri}#/definitions/ts`},
        c: {$ref: documentUri},
      },
    };
    const result = await resolveRefs(schema, {fetcher});
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([documentUri]);
    expect(result.stats.remoteFetches).toBe(1);
    const properties = (result.schema as {properties: Record<string, unknown>}).properties;
    expect(properties.a).toEqual({type: 'string'});
    expect(properties.b).toEqual({type: 'number'});
  });

  it('reports a remote fetch failure with the use-site path and reuses the failed lookup', async () => {
    const {fetcher, calls} = recordingFetcher({});
    const schema = {
      properties: {
        first: {$ref: `${documentUri}#/definitions/id`},
        second: {$ref: `${documentUri}#/definitions/id`},
      },
    };
    const result = await resolveRefs(schema, {fetcher});
    expect(result.errors).toHaveLength(2);
    expect(calls).toHaveLength(1); // failure is cached, not retried per reference
    expect(result.errors[0].kind).toBe('remote-fetch-failed');
    expect(result.errors[0].message).toContain(documentUri);
    expect(result.errors[0].message).toContain('ECONNREFUSED');
    expect(result.errors.map(error => error.instancePath)).toEqual([
      '/properties/first',
      '/properties/second',
    ]);
  });

  it('follows a cycle spanning remote documents and reports the full URI chain', async () => {
    const uriA = 'https://a.example.com/root.json';
    const uriB = 'https://b.example.com/other.json';
    const {fetcher} = recordingFetcher({
      [uriA]: {$ref: uriB},
      [uriB]: {$ref: uriA},
    });
    const schema = {properties: {x: {$ref: uriA}}};
    const result = await resolveRefs(schema, {fetcher});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('circular-reference');
    expect(result.errors[0].instancePath).toBe('/properties/x');
    expect(result.errors[0].chain).toEqual([uriA, uriB, uriA]);
  });
});

describe('resolveRefs – other failures', () => {
  it('reports a missing local target as an unresolved reference', async () => {
    const schema = {properties: {x: {$ref: '#/definitions/missing'}}};
    const result = await resolveRefs(schema);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('unresolved-reference');
    expect(result.errors[0].instancePath).toBe('/properties/x');
    expect(result.errors[0].schemaPath).toBe('#/definitions/missing');
  });

  it('merges $ref siblings over the resolved target', async () => {
    const schema = {
      definitions: {base: {type: 'object'}},
      properties: {x: {$ref: '#/definitions/base', description: 'an x'}},
    };
    const result = await resolveRefs(schema);
    expect(result.errors).toEqual([]);
    expect((result.schema as {properties: Record<string, unknown>}).properties.x).toEqual({
      type: 'object',
      description: 'an x',
    });
  });
});
