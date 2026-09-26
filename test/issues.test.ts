import {describe, expect, it} from 'vitest';
import {isStale, issueKey, reconcileExpanded, type RefIssue} from '../src/client/issues';

const issue = (instancePath: string, schemaPath: string): Pick<RefIssue, 'instancePath' | 'schemaPath'> =>
  ({instancePath, schemaPath});

describe('issueKey', () => {
  it('combines stable instance and schema paths', () => {
    expect(issueKey(issue('#/a', '#/$defs/x/$ref'))).toBe('#/a #/$defs/x/$ref');
  });

  it('distinguishes two instance sites that reuse the same definition', () => {
    const first = issueKey(issue('#/first', '#/$defs/shared/$ref'));
    const second = issueKey(issue('#/second', '#/$defs/shared/$ref'));
    expect(first).not.toBe(second);
  });
});

describe('reconcileExpanded', () => {
  it('keeps expansions whose issue still exists after a refresh', () => {
    const expanded = new Set([
      issueKey(issue('#/a', '#/$defs/x/$ref')),
      issueKey(issue('#/b', '#/$defs/x/$ref')),
    ]);

    const {next, removed} = reconcileExpanded(expanded, [
      issue('#/a', '#/$defs/x/$ref'),
      issue('#/b', '#/$defs/x/$ref'),
      issue('#/c', '#/$defs/x/$ref'),
    ]);

    expect([...next].sort()).toEqual([...expanded].sort());
    expect(removed).toEqual([]);
  });

  it('drops expansions for issues that disappeared, never pointing at another node', () => {
    const expanded = new Set([
      issueKey(issue('#/a', '#/$defs/x/$ref')),
      issueKey(issue('#/gone', '#/$defs/y/$ref')),
    ]);

    const {next, removed} = reconcileExpanded(expanded, [
      issue('#/a', '#/$defs/x/$ref'),
    ]);

    expect(next.has(issueKey(issue('#/a', '#/$defs/x/$ref')))).toBe(true);
    expect(next.size).toBe(1);
    expect(removed).toEqual([issueKey(issue('#/gone', '#/$defs/y/$ref'))]);
  });

  it('does not auto-expand issues that are new in the refresh', () => {
    const expanded = new Set([issueKey(issue('#/a', '#/$defs/x/$ref'))]);

    const {next} = reconcileExpanded(expanded, [
      issue('#/a', '#/$defs/x/$ref'),
      issue('#/new', '#/$defs/x/$ref'),
    ]);

    expect(next.size).toBe(1);
  });

  it('handles a rapid example switch where the new set is unrelated', () => {
    const expanded = new Set([
      issueKey(issue('#/orders/id', '#/$defs/a/$ref')),
      issueKey(issue('#/orders/geo', '#/$defs/b/$ref')),
    ]);

    const {next, removed} = reconcileExpanded(expanded, [
      issue('#/profile/name', '#/$defs/person/$ref'),
    ]);

    expect(next.size).toBe(0);
    expect(removed).toHaveLength(2);
  });
});

describe('isStale', () => {
  it('accepts only the latest request token', () => {
    expect(isStale(1, 3)).toBe(true);
    expect(isStale(3, 3)).toBe(false);
    // Simulate orders (token 1, slow) resolving after profiles (token 2, fast).
    let latest = 1;
    latest = 2;
    expect(isStale(1, latest)).toBe(true);
    expect(isStale(2, latest)).toBe(false);
  });
});
