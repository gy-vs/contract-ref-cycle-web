/**
 * Stable identity for preview errors.
 *
 * An error is identified by BOTH its instance path (where the failing $ref
 * node sits in the input document) and its schema path (the schema-side
 * reference). The pair is stable across data refreshes, so an expanded item
 * can be kept when the same error still exists and dropped when it does not.
 */

export type PreviewError = {
  kind: string;
  instancePath: string;
  ref: string;
  schemaPath: string;
  chain: string[];
  message: string;
};

export type PreviewResponse = {
  contractId: string;
  valid: boolean;
  schema?: unknown;
  errors?: PreviewError[];
  stats?: {refResolutions: number; refCacheHits: number; remoteFetches: number};
};

export function errorKey(error: Pick<PreviewError, 'instancePath' | 'schemaPath'>): string {
  return JSON.stringify([error.instancePath, error.schemaPath]);
}

/**
 * Reconcile expanded error keys after a data refresh:
 * keep expansions whose error still exists, remove stale ones.
 * Returns the same Set instance when nothing changed to avoid re-renders.
 */
export function reconcileExpanded(expanded: ReadonlySet<string>, errors: readonly PreviewError[]): Set<string> {
  const live = new Set(errors.map(errorKey));
  let changed = false;
  for (const key of expanded) {
    if (!live.has(key)) {
      changed = true;
      break;
    }
  }
  if (!changed) return expanded as Set<string>;
  return new Set([...expanded].filter(key => live.has(key)));
}
