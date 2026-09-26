/**
 * Reference resolution for contract schemas.
 *
 * Two pieces of state must stay separate:
 *
 *  - `stack`    the $ref chain currently being walked on this branch.
 *               A canonical target already on the stack is a real cycle.
 *  - `resolved` targets that were fully walked on an earlier branch.  The same
 *               definition can be referenced from many places (diamond / shared
 *               definitions); reusing its result keeps a shared node from being
 *               resolved once per reference site.
 *
 * A target whose subtree produced an issue is deliberately NOT cached: each
 * reference site must report its own instance path, so erroring subtrees are
 * re-walked while clean shared nodes are reused.  Cache keys are canonical
 * `docUri#pointer` strings and therefore never carry the first visitor's path.
 */

export type IssueCode = 'cycle' | 'remote_unavailable' | 'invalid_pointer';

export type RefIssue = {
  code: IssueCode;
  /** Instance location the keyword applies to ('' is the document root). */
  instancePath: string;
  /** Absolute location of the offending keyword, '#'-style when local. */
  schemaPath: string;
  /** Raw $ref value as authored. */
  ref: string;
  /** Full canonical reference chain; for cycles the first entry repeats last. */
  chain: string[];
  message: string;
};

export type RemoteLoader = (uri: string) => Promise<unknown> | unknown;

export type ResolveOptions = {
  baseUri?: string;
  loadRemote?: RemoteLoader;
  /** Observation hook, mainly for tests: (canonical target, cache hit). */
  onResolve?: (canonical: string, fromCache: boolean) => void;
};

export type ResolveResult = {
  schema: unknown;
  issues: RefIssue[];
  /** Number of distinct ref targets actually walked (cache misses). */
  targetsResolved: number;
  /** Total number of $ref keywords encountered. */
  refHits: number;
};

const DEFAULT_BASE_URI = 'https://contract.local/schema';

/** Keywords whose value is a schema applied to the same instance. */
const SINGLE_SCHEMA_KEYWORDS = new Set([
  'items', 'additionalItems', 'contains', 'additionalProperties',
  'propertyNames', 'not', 'if', 'then', 'else',
  'unevaluatedItems', 'unevaluatedProperties', 'contentSchema',
]);
/** Keywords whose value is an array of schemas applied to the same instance. */
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Property-name maps: each child schema applies to that property instance. */
const PROPERTY_MAP_KEYWORDS = new Set(['properties', 'patternProperties']);
/** Definition maps are only entered through $ref, never walked from the root. */
const DEFINITION_KEYWORDS = new Set(['$defs', 'definitions']);
/** Property-name maps whose child schemas apply to the root instance. */
const ROOT_SCHEMA_MAP_KEYWORDS = new Set(['dependentSchemas']);

type RefTarget = {
  docUri: string;
  /** JSON pointer inside the document, or null for unsupported fragments. */
  pointer: string | null;
  canonical: string;
};

export async function resolveSchema(
  root: unknown,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const baseUri = options.baseUri ?? DEFAULT_BASE_URI;
  const rootCanonical = `${baseUri}#`;

  // Fresh state per resolution: nothing leaks across requests or positions.
  const documents = new Map<string, unknown>([[baseUri, root]]);
  const resolved = new Map<string, unknown>();
  const issues: RefIssue[] = [];
  const stack: string[] = [rootCanonical];
  let targetsResolved = 0;
  let refHits = 0;

  const displayPath = (canonical: string): string => {
    if (canonical === rootCanonical) return '#';
    if (canonical.startsWith(`${baseUri}#`)) return canonical.slice(baseUri.length);
    return canonical;
  };

  async function loadDocument(uri: string): Promise<unknown> {
    const cached = documents.get(uri);
    if (cached !== undefined) return cached;
    if (!options.loadRemote) throw new Error('remote references are not enabled');
    const doc = await options.loadRemote(uri);
    documents.set(uri, doc);
    return doc;
  }

  /**
   * @param role schema       - node is a JSON Schema (check $ref, recurse keywords)
   *             propertyMap  - node maps property names to child-instance schemas
   *             schemaMap    - node maps names to same-instance schemas
   *             schemaArray  - node is an array of same-instance schemas
   *             plain        - non-schema container (unknown keywords, data)
   */
  async function walk(
    node: unknown,
    instancePath: string,
    schemaPath: string,
    docUri: string,
    role: 'schema' | 'propertyMap' | 'schemaMap' | 'schemaArray' | 'plain',
  ): Promise<unknown> {
    if (node === null || typeof node !== 'object') return node;

    if (role === 'plain' && !(node as Record<string, unknown>).$ref) {
      if (Array.isArray(node)) {
        // Serial on purpose: sibling branches must not interleave with the
        // shared resolution stack.
        const arrayOut: unknown[] = [];
        for (let index = 0; index < node.length; index += 1) {
          arrayOut.push(await walk(
            node[index], instancePath, joinPointer(schemaPath, String(index)), docUri, 'plain',
          ));
        }
        return arrayOut;
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = await walk(child, instancePath, joinPointer(schemaPath, key), docUri, 'plain');
      }
      return out;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      refHits += 1;
      const authoredRef = record.$ref;
      const target = parseRef(authoredRef, docUri);
      const keywordPath = joinPointer(schemaPath, '$ref');
      // Canonical location of the node that owns this $ref keyword.
      const siteCanonical = keywordPath.endsWith('/$ref')
        ? keywordPath.slice(0, -'/$ref'.length)
        : schemaPath;
      const issueBase = {
        instancePath: instancePath === '' ? '#' : `#${instancePath}`,
        schemaPath: displayPath(keywordPath),
        ref: authoredRef,
      };

      if (stack.includes(target.canonical)) {
        const cycleStart = stack.indexOf(target.canonical);
        const chain = [...stack.slice(cycleStart), target.canonical].map(displayPath);
        issues.push({
          ...issueBase,
          code: 'cycle',
          chain,
          message: `Circular reference detected: ${chain.join(' -> ')}`,
        });
        return {$refError: 'cycle' as const, $ref: authoredRef};
      }

      if (resolved.has(target.canonical)) {
        options.onResolve?.(target.canonical, true);
        return resolved.get(target.canonical);
      }

      let doc: unknown;
      if (target.docUri === docUri || documents.has(target.docUri)) {
        doc = documents.get(target.docUri);
      } else {
        try {
          doc = await loadDocument(target.docUri);
        } catch (error) {
          issues.push({
            ...issueBase,
            code: 'remote_unavailable',
            chain: [displayPath(siteCanonical), target.canonical],
            message: `Unable to load remote reference "${authoredRef}": ${errorMessage(error)}`,
          });
          return {$refError: 'remote_unavailable' as const, $ref: authoredRef};
        }
      }

      if (target.pointer === null) {
        issues.push({
          ...issueBase,
          code: 'invalid_pointer',
          chain: [displayPath(siteCanonical), target.canonical],
          message: `Unsupported reference fragment in "${authoredRef}"`,
        });
        return {$refError: 'invalid_pointer' as const, $ref: authoredRef};
      }

      let targetNode: unknown;
      try {
        targetNode = pointerGet(doc, target.pointer);
      } catch (error) {
        issues.push({
          ...issueBase,
          code: 'invalid_pointer',
          chain: [displayPath(siteCanonical), displayPath(target.canonical)],
          message: `Cannot resolve reference "${authoredRef}": ${errorMessage(error)}`,
        });
        return {$refError: 'invalid_pointer' as const, $ref: authoredRef};
      }

      stack.push(target.canonical);
      const issuesBefore = issues.length;
      let value: unknown;
      try {
        // Refs do not add instance or keyword-path segments; the target's
        // canonical location becomes the schema path for nested keywords.
        value = await walk(targetNode, instancePath, target.canonical, target.docUri, 'schema');
      } finally {
        stack.pop();
      }
      // Only clean subtrees are cached: erroring ones re-walk per site so each
      // site keeps its own instance path.
      if (issues.length === issuesBefore) resolved.set(target.canonical, value);
      targetsResolved += 1;
      options.onResolve?.(target.canonical, false);
      return value;
    }

    if (Array.isArray(record)) {
      // Serial on purpose: parallel branches would interleave with the shared
      // recursion stack and mark shared nodes as cycles.
      const arrayOut: unknown[] = [];
      const arrayRole = role === 'schemaArray' ? 'schema' : 'plain';
      for (let index = 0; index < record.length; index += 1) {
        arrayOut.push(await walk(
          record[index], instancePath, joinPointer(schemaPath, String(index)), docUri, arrayRole,
        ));
      }
      return arrayOut;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (DEFINITION_KEYWORDS.has(key)) {
        // Preserve as authored; definitions are entered only through references.
        out[key] = deepCopy(child);
        continue;
      }
      const childSchemaPath = joinPointer(schemaPath, key);
      if (role === 'propertyMap') {
        out[key] = await walk(
          child, appendSegment(instancePath, key), childSchemaPath, docUri, 'schema',
        );
      } else if (role === 'schemaMap') {
        out[key] = await walk(child, instancePath, childSchemaPath, docUri, 'schema');
      } else if (PROPERTY_MAP_KEYWORDS.has(key)) {
        out[key] = await walk(child, instancePath, childSchemaPath, docUri, 'propertyMap');
      } else if (ROOT_SCHEMA_MAP_KEYWORDS.has(key)) {
        out[key] = await walk(child, instancePath, childSchemaPath, docUri, 'schemaMap');
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
        out[key] = await walk(child, instancePath, childSchemaPath, docUri, 'schemaArray');
      } else if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
        // Draft 4 allowed `items` to be an array of item schemas.
        const childRole = key === 'items' && Array.isArray(child) ? 'schemaArray' : 'schema';
        out[key] = await walk(child, instancePath, childSchemaPath, docUri, childRole);
      } else {
        // Unknown keyword: keep structure, follow any nested $ref but do not
        // move the instance location.
        out[key] = await walk(child, instancePath, childSchemaPath, docUri, 'plain');
      }
    }
    return out;
  }

  const schema = await walk(root, '', rootCanonical, baseUri, 'schema');
  return {schema, issues, targetsResolved, refHits};
}

function deepCopy(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(deepCopy);
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, deepCopy(value)]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinPointer(base: string, segment: string): string {
  const escaped = segment.replace(/~/g, '~0').replace(/\//g, '~1');
  return base === '' || base === '#' ? `#/${escaped}` : `${base}/${escaped}`;
}

/** Append a segment to a fragment pointer that does not carry a leading '#'. */
function appendSegment(pointer: string, segment: string): string {
  const escaped = segment.replace(/~/g, '~0').replace(/\//g, '~1');
  return pointer === '' ? `/${escaped}` : `${pointer}/${escaped}`;
}

function parseRef(ref: string, baseDocUri: string): RefTarget {
  const hashIndex = ref.indexOf('#');
  const rawUri = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex + 1);

  let docUri: string;
  if (rawUri === '') {
    docUri = baseDocUri;
  } else {
    const url = new URL(rawUri, baseDocUri);
    url.hash = '';
    docUri = url.href;
  }

  const pointer = fragment === '' || fragment.startsWith('/') ? fragment : null;
  return {docUri, pointer, canonical: `${docUri}#${pointer ?? fragment}`};
}

function pointerGet(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let current: unknown = doc;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object') {
      throw new Error(`segment "${segment}" not found`);
    }
    const container = current as Record<string, unknown>;
    if (!(segment in container)) throw new Error(`segment "${segment}" not found`);
    current = container[segment];
  }
  return current;
}
