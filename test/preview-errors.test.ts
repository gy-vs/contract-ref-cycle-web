import {describe, expect, it} from 'vitest';
import {errorKey, reconcileExpanded, type PreviewError} from '../src/client/preview-errors';

function error(instancePath: string, schemaPath: string, message = 'boom'): PreviewError {
  return {kind: 'circular-reference', instancePath, ref: schemaPath, schemaPath, chain: [schemaPath, schemaPath], message};
}

describe('errorKey', () => {
  it('is stable for the same instance/schema path pair', () => {
    expect(errorKey(error('/properties/a', '#/definitions/x')))
      .toBe(errorKey(error('/properties/a', '#/definitions/x')));
  });

  it('distinguishes the same schema error at different instance positions', () => {
    expect(errorKey(error('/properties/a', '#/definitions/loop')))
      .not.toBe(errorKey(error('/properties/b', '#/definitions/loop')));
  });

  it('distinguishes different schema errors at the same instance position', () => {
    expect(errorKey(error('/properties/a', '#/definitions/x')))
      .not.toBe(errorKey(error('/properties/a', '#/definitions/y')));
  });
});

describe('reconcileExpanded', () => {
  const errorsAfter = [error('/properties/a', '#/definitions/x'), error('/properties/b', '#/definitions/y')];

  it('keeps expanded items whose error still exists after refresh', () => {
    const expanded = new Set([errorKey(errorsAfter[0]), errorKey(errorsAfter[1])]);
    const result = reconcileExpanded(expanded, errorsAfter);
    expect([...result].sort()).toEqual([...expanded].sort());
  });

  it('returns the same Set reference when nothing is stale', () => {
    const expanded = new Set([errorKey(errorsAfter[0])]);
    expect(reconcileExpanded(expanded, errorsAfter)).toBe(expanded);
  });

  it('removes expanded items that no longer exist after switching examples', () => {
    const staleFromOtherExample = new Set([
      errorKey(error('/properties/old', '#/definitions/gone')),
      errorKey(errorsAfter[0]),
    ]);
    const result = reconcileExpanded(staleFromOtherExample, errorsAfter);
    expect(result.has(errorKey(errorsAfter[0]))).toBe(true);
    expect(result.has(errorKey(error('/properties/old', '#/definitions/gone')))).toBe(false);
  });

  it('clears all expansions when the new data has none of the old errors', () => {
    const expanded = new Set([errorKey(error('/properties/old', '#/definitions/gone'))]);
    const result = reconcileExpanded(expanded, errorsAfter);
    expect(result.size).toBe(0);
  });
});
