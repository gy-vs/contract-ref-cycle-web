/**
 * $ref resolution for contract schemas.
 *
 * Two distinct structures are tracked while resolving:
 *
 *  - `stack`  – the reference chain currently being resolved (the recursion
 *               stack). A key already on the stack is a genuine circular
 *               reference; the complete chain is reported.
 *  - `cache`  – references whose resolution already finished, whether with a
 *               value or with an error. The same schema node can therefore be
 *               referenced from arbitrarily many instance positions and is
 *               only resolved once.
 *
 * Cached entries never carry an instance path: failures are stored as
 * location-independent reference chains and the path of the referencing node
 * is attached at each use site, so a first-visit path can never leak into a
 * later reuse position.
 */

export type RefErrorKind =
  | 'circular-reference'
  | 'unresolved-reference'
  | 'remote-fetch-failed'
  | 'invalid-reference';

export interface RefError {
  kind: RefErrorKind;
  /** Path of the node containing the failing $ref inside the input schema. */
  instancePath: string;
  /** The $ref value as written at the instance node. */
  ref: string;
  /** Stable schema-side identifier of the failing reference. */
  schemaPath: string;
  /** Full reference chain (ref URIs); for cycles it ends where it started. */
  chain: string[];
  message: string;
}

interface RefErrorInfo {
  kind: RefErrorKind;
  chain: string[];
  message: string;
}

export interface ResolveStats {
  /** Distinct references that had to be resolved (cache misses). */
  refResolutions: number;
  /** References served from the resolution cache. */
  refCacheHits: number;
  /** Distinct remote documents fetched. */
  remoteFetches: number;
}

export interface ResolveResult {
  schema: unknown;
  errors: RefError[];
  stats: ResolveStats;
}

export type SchemaFetcher = (uri: string) => Promise<unknown>;

export interface ResolveOptions {
  /** Used to load remote (http/https) references; defaults to global fetch. */
  fetcher?: SchemaFetcher;
  /** Base URI for resolving relative references. */
  baseUri?: string;
}

type CacheEntry = {ok: true; value: unknown} | {ok: false; info: RefErrorInfo};

class RefResolutionFailure extends Error {
  constructor(readonly info: RefErrorInfo) {
    super(info.message);
    this.name = 'RefResolutionFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Read a JSON Pointer (RFC 6901, empty string = root) from a document. */
function pointerGet(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let node: unknown = root;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = unescapeSegment(rawSegment);
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined;
      node = node[index];
    } else if (isRecord(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

function failure(kind: RefErrorKind, chain: string[], message: string): RefResolutionFailure {
  return new RefResolutionFailure({kind, chain, message});
}

/**
 * Rotate a circular-reference chain so it starts (and ends) with `key`.
 *
 * A cycle a -> b -> c -> a may be discovered while resolving any member of
 * the loop; the cached chain is normalized to the perspective of its cache
 * key instead of remembering whichever entry point happened to run first.
 */
function rotateChain(info: RefErrorInfo, key: string): RefErrorInfo {
  if (info.kind !== 'circular-reference') return info;
  const index = info.chain.indexOf(key);
  if (index <= 0) return info;
  const rotated = [...info.chain.slice(index, -1), ...info.chain.slice(0, index), key];
  return {...info, chain: rotated, message: `Circular reference: ${rotated.join(' -> ')}`};
}

class RefResolver {
  private readonly cache = new Map<string, CacheEntry>();
  /** Remote documents are fetched once even if many refs point into them. */
  private readonly remoteDocs = new Map<string, Promise<unknown>>();
  /** References currently being resolved: this is the recursion stack. */
  private readonly stack: string[] = [];
  private readonly errors = new Map<string, RefError>();
  private readonly stats: ResolveStats = {refResolutions: 0, refCacheHits: 0, remoteFetches: 0};
  /** 0 while walking the input document itself; errors are recorded there. */
  private walkDepth = 0;

  constructor(
    private readonly root: unknown,
    private readonly options: ResolveOptions,
  ) {}

  async run(): Promise<ResolveResult> {
    const schema = await this.resolveNode(this.root, '');
    return {schema, errors: [...this.errors.values()], stats: {...this.stats}};
  }

  private async resolveNode(node: unknown, instancePath: string): Promise<unknown> {
    if (Array.isArray(node)) {
      const result: unknown[] = [];
      for (let index = 0; index < node.length; index += 1) {
        result.push(await this.resolveNode(node[index], `${instancePath}/${index}`));
      }
      return result;
    }
    if (!isRecord(node)) return node;

    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      let resolved: unknown;
      try {
        resolved = await this.resolveRef(ref);
      } catch (error) {
        if (!(error instanceof RefResolutionFailure)) throw error;
        // While resolving a referenced target, failures must propagate so
        // the enclosing reference is cached as failed. Only the input
        // document walk itself (depth 0) records the error and substitutes
        // a placeholder so the rest of the document can still be checked.
        if (this.walkDepth > 0) throw error;
        this.record(error.info, instancePath, ref);
        resolved = node;
      }
      // JSON Schema 2019-09+ allows siblings next to $ref; merge them on top.
      const siblings: Record<string, unknown> = {...node};
      delete siblings.$ref;
      if (Object.keys(siblings).length === 0) return resolved;
      const resolvedSiblings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(siblings)) {
        resolvedSiblings[key] = await this.resolveNode(value, `${instancePath}/${escapeSegment(key)}`);
      }
      return isRecord(resolved) ? {...resolved, ...resolvedSiblings} : resolved;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = await this.resolveNode(value, `${instancePath}/${escapeSegment(key)}`);
    }
    return result;
  }

  private async resolveRef(ref: string): Promise<unknown> {
    const key = this.normalize(ref);

    const cached = this.cache.get(key);
    if (cached) {
      this.stats.refCacheHits += 1;
      if (cached.ok) return cached.value;
      throw new RefResolutionFailure(cached.info);
    }

    // Only a reference that is still being resolved (on the recursion stack)
    // is a cycle. A merely cached reference is a shared node and is fine.
    const cycleStart = this.stack.indexOf(key);
    if (cycleStart !== -1) {
      const chain = [...this.stack.slice(cycleStart), key];
      throw failure('circular-reference', chain, `Circular reference: ${chain.join(' -> ')}`);
    }

    this.stack.push(key);
    this.stats.refResolutions += 1;
    try {
      const target = await this.locate(key);
      this.walkDepth += 1;
      try {
        const value = await this.resolveNode(target, '');
        this.cache.set(key, {ok: true, value});
        return value;
      } finally {
        this.walkDepth -= 1;
      }
    } catch (error) {
      if (!(error instanceof RefResolutionFailure)) throw error;
      const info = rotateChain(error.info, key);
      // Location-independent failure: instancePath is attached by use sites.
      this.cache.set(key, {ok: false, info});
      throw new RefResolutionFailure(info);
    } finally {
      this.stack.pop();
    }
  }

  private normalize(ref: string): string {
    if (ref.startsWith('#')) return ref;
    let url: URL;
    try {
      url = this.options.baseUri ? new URL(ref, this.options.baseUri) : new URL(ref);
    } catch {
      throw failure('invalid-reference', [ref], `Invalid reference (no base URI for relative reference): ${ref}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw failure('invalid-reference', [ref], `Invalid reference (only http/https remote references are supported): ${ref}`);
    }
    // Treat "doc.json#" and "doc.json" as the same reference.
    return url.href.endsWith('#') ? url.href.slice(0, -1) : url.href;
  }

  private async locate(key: string): Promise<unknown> {
    if (key.startsWith('#')) {
      const target = pointerGet(this.root, key.slice(1));
      if (target === undefined) {
        throw failure('unresolved-reference', [key], `Unresolved reference: ${key}`);
      }
      return target;
    }

    const hashIndex = key.indexOf('#');
    const documentUri = hashIndex === -1 ? key : key.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : key.slice(hashIndex + 1);

    let documentPromise = this.remoteDocs.get(documentUri);
    if (!documentPromise) {
      const {fetcher} = this.options;
      if (!fetcher) {
        throw failure('invalid-reference', [key], `Cannot resolve remote reference without a fetcher: ${documentUri}`);
      }
      this.stats.remoteFetches += 1;
      documentPromise = Promise.resolve().then(() => fetcher(documentUri));
      this.remoteDocs.set(documentUri, documentPromise);
    }

    let document: unknown;
    try {
      document = await documentPromise;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw failure('remote-fetch-failed', [key], `Failed to fetch remote reference ${documentUri}: ${reason}`);
    }

    if (!fragment) return document;
    let pointer = fragment;
    try {
      pointer = decodeURIComponent(fragment);
    } catch {
      // Keep the raw fragment if it is not percent-encoded.
    }
    const target = pointerGet(document, pointer);
    if (target === undefined) {
      throw failure('unresolved-reference', [key], `Unresolved reference: ${key}`);
    }
    return target;
  }

  private record(info: RefErrorInfo, instancePath: string, ref: string): void {
    const schemaPath = info.chain[info.chain.length - 1] ?? ref;
    const identity = JSON.stringify([instancePath, schemaPath]);
    if (!this.errors.has(identity)) {
      this.errors.set(identity, {kind: info.kind, instancePath, ref, schemaPath, chain: [...info.chain], message: info.message});
    }
  }
}

export async function resolveRefs(schema: unknown, options: ResolveOptions = {}): Promise<ResolveResult> {
  return new RefResolver(schema, options).run();
}
