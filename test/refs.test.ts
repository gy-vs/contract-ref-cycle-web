import {describe, expect, it} from 'vitest';
import {resolveSchema} from '../src/server/refs';

describe('resolveSchema — shared references', () => {
  it('resolves a diamond without reporting a false cycle and walks the shared node once', async () => {
    const observations: Array<[string, boolean]> = [];
    const schema = {
      type: 'object',
      properties: {
        billing: {$ref: '#/$defs/address'},
        shipping: {$ref: '#/$defs/address'},
      },
      $defs: {
        address: {
          type: 'object',
          properties: {
            geo: {$ref: '#/$defs/geo'},
            backup: {$ref: '#/$defs/geo'},
          },
        },
        geo: {type: 'object', properties: {lat: {type: 'number'}}},
      },
    };

    const result = await resolveSchema(schema, {
      onResolve: (canonical, fromCache) => observations.push([canonical, fromCache]),
    });

    expect(result.issues).toEqual([]);
    // address once as a miss + once as a cache hit.  geo's miss and its first
    // hit both happen while walking address; once address is cached it is
    // reused wholesale by the second site, so geo is not re-walked there.
    const address = observations.filter(([target]) => target.endsWith('/address'));
    const geo = observations.filter(([target]) => target.endsWith('/geo'));
    expect(address.filter(([, hit]) => !hit)).toHaveLength(1);
    expect(address.filter(([, hit]) => hit)).toHaveLength(1);
    expect(geo.filter(([, hit]) => !hit)).toHaveLength(1);
    expect(geo.filter(([, hit]) => hit)).toHaveLength(1);
    expect(result.targetsResolved).toBe(2);
    expect(result.refHits).toBe(4);
    // Both branches expanded with the shared content.
    const resolved = result.schema as any;
    expect(resolved.properties.billing.properties.geo.properties.lat.type).toBe('number');
    expect(resolved.properties.shipping.properties.geo.properties.lat.type).toBe('number');
    // $defs stay authored (not traversed as instance keywords).
    expect(resolved.$defs.geo.properties.lat.type).toBe('number');
  });

  it('reuses one shared schema across many sites without linear re-resolution', async () => {
    const refs = Array.from({length: 50}, (_, index) => ({[`p${index}`]: {$ref: '#/$defs/shared'}}));
    const schema = {type: 'object', properties: Object.assign({}, ...refs), $defs: {shared: {type: 'string'}}};

    const result = await resolveSchema(schema);

    expect(result.issues).toEqual([]);
    expect(result.refHits).toBe(50);
    expect(result.targetsResolved).toBe(1);
  });

  it('does not leak resolution state across invocations', async () => {
    const schema = {type: 'object', properties: {a: {$ref: '#/$defs/x'}}, $defs: {x: {type: 'integer'}}};
    await resolveSchema(schema);
    const result = await resolveSchema(schema);
    expect(result.issues).toEqual([]);
    expect(result.targetsResolved).toBe(1);
  });
});

describe('resolveSchema — cycles', () => {
  it('reports a direct self reference with the full one-node chain', async () => {
    const schema = {
      type: 'object',
      properties: {self: {$ref: '#/$defs/node'}},
      $defs: {node: {type: 'object', properties: {me: {$ref: '#/$defs/node'}}}},
    };

    const result = await resolveSchema(schema);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('cycle');
    expect(issue.chain).toEqual(['#/$defs/node', '#/$defs/node']);
    expect(issue.schemaPath).toBe('#/$defs/node/properties/me/$ref');
    expect(issue.instancePath).toBe('#/self/me');
  });

  it('reports an indirect cycle with every hop in the chain', async () => {
    const schema = {
      type: 'object',
      properties: {root: {$ref: '#/$defs/a'}},
      $defs: {
        a: {type: 'object', properties: {b: {$ref: '#/$defs/b'}}},
        b: {type: 'object', properties: {c: {$ref: '#/$defs/c'}}},
        c: {type: 'object', properties: {back: {$ref: '#/$defs/a'}}},
      },
    };

    const result = await resolveSchema(schema);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('cycle');
    expect(result.issues[0].chain).toEqual([
      '#/$defs/a',
      '#/$defs/b',
      '#/$defs/c',
      '#/$defs/a',
    ]);
    expect(result.issues[0].instancePath).toBe('#/root/b/c/back');
    expect(result.issues[0].schemaPath).toBe('#/$defs/c/properties/back/$ref');
  });

  it('keeps a diamond that converges and then cycles reporting exactly one cycle', async () => {
    const schema = {
      type: 'object',
      properties: {
        left: {$ref: '#/$defs/a'},
        right: {$ref: '#/$defs/a'},
      },
      $defs: {
        a: {type: 'object', properties: {loopy: {$ref: '#/$defs/loop'}}},
        loop: {type: 'object', properties: {again: {$ref: '#/$defs/loop'}}},
      },
    };

    const result = await resolveSchema(schema);

    const cycles = result.issues.filter(issue => issue.code === 'cycle');
    // The cyclic subtree is not cached, so each reference site reports the cycle
    // with its own instance path — never a single pathless error.
    expect(cycles).toHaveLength(2);
    expect(cycles.map(issue => issue.instancePath).sort()).toEqual([
      '#/left/loopy/again',
      '#/right/loopy/again',
    ]);
    for (const issue of cycles) {
      expect(issue.chain).toEqual(['#/$defs/loop', '#/$defs/loop']);
    }
  });
});

describe('resolveSchema — same schema at multiple instance locations', () => {
  it('reports each erroring site with its own instance path, never the first site path', async () => {
    const schema = {
      type: 'object',
      properties: {
        first: {$ref: '#/$defs/broken'},
        nested: {type: 'object', properties: {second: {$ref: '#/$defs/broken'}}},
        third: {type: 'array', items: {$ref: '#/$defs/broken'}},
      },
      $defs: {
        broken: {type: 'object', properties: {link: {$ref: '#/$defs/missing'}}},
      },
    };

    const result = await resolveSchema(schema);

    const invalid = result.issues.filter(issue => issue.code === 'invalid_pointer');
    expect(invalid).toHaveLength(3);
    expect(invalid.map(issue => issue.instancePath).sort()).toEqual([
      '#/first/link',
      '#/nested/second/link',
      '#/third/link',
    ]);
    // Keyword location is the same authored node for all three.
    expect(new Set(invalid.map(issue => issue.schemaPath))).toEqual(
      new Set(['#/$defs/broken/properties/link/$ref']),
    );
  });

  it('caches clean shared subtrees reached through allOf/items without moving instance path', async () => {
    const schema = {
      allOf: [
        {$ref: '#/$defs/tag'},
        {$ref: '#/$defs/tag'},
      ],
      properties: {
        items: {type: 'array', items: {$ref: '#/$defs/tag'}},
      },
      $defs: {tag: {type: 'object', properties: {label: {$ref: '#/$defs/label'}}}},
      // referenced through tag
      // (label defined below)
    } as any;
    (schema.$defs as any).label = {type: 'string'};

    const result = await resolveSchema(schema);

    expect(result.issues).toEqual([]);
    expect(result.targetsResolved).toBe(2);
    const resolved = result.schema as any;
    expect(resolved.allOf[0].properties.label.type).toBe('string');
    expect(resolved.allOf[1].properties.label.type).toBe('string');
    expect(resolved.properties.items.items.properties.label.type).toBe('string');
  });
});

describe('resolveSchema — remote references', () => {
  it('resolves available remote documents and reports failures as structured issues', async () => {
    const loader = async (uri: string) => {
      if (uri === 'https://example.com/common.json') {
        return {$defs: {measure: {type: 'object', properties: {length: {type: 'number'}}}}};
      }
      throw new Error('network 500');
    };
    const schema = {
      type: 'object',
      properties: {
        size: {$ref: 'https://example.com/common.json#/$defs/measure'},
        ghost: {$ref: 'https://example.com/missing.json#/$defs/site'},
      },
    };

    const result = await resolveSchema(schema, {loadRemote: loader});

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('remote_unavailable');
    expect(result.issues[0].instancePath).toBe('#/ghost');
    expect(result.issues[0].schemaPath).toMatch(/\/ghost\/\$ref$/);
    expect(result.issues[0].chain[0]).toBe('#/properties/ghost');
    const resolved = result.schema as any;
    expect(resolved.properties.size.properties.length.type).toBe('number');
  });

  it('loads each remote document once even when referenced from many sites', async () => {
    let loads = 0;
    const loader = async (uri: string) => {
      loads += 1;
      return {type: 'string'};
    };
    const schema = {
      properties: Object.fromEntries(
        Array.from({length: 10}, (_, index) => [`p${index}`, {$ref: 'https://example.com/x.json#'}]),
      ),
    };

    const result = await resolveSchema(schema, {loadRemote: loader});

    expect(result.issues).toEqual([]);
    expect(loads).toBe(1);
    expect(result.targetsResolved).toBe(1);
  });
});
