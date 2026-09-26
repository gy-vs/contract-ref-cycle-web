/**
 * Stable identity for a reference issue and reconciliation of expanded rows.
 *
 * An issue is identified by WHERE it applies (instance path) together with
 * WHERE the offending keyword lives in the schema (schema path).  Two sites
 * referencing the same definition are therefore distinct issues, and a refresh
 * only reuses an expansion when the same identity still exists.
 */

export type IssueCode = 'cycle' | 'remote_unavailable' | 'invalid_pointer';

export type RefIssue = {
  code: IssueCode;
  instancePath: string;
  schemaPath: string;
  ref: string;
  chain: string[];
  message: string;
};

export function issueKey(issue: Pick<RefIssue, 'instancePath' | 'schemaPath'>): string {
  return `${issue.instancePath} ${issue.schemaPath}`;
}

export type ReconcileResult = {
  /** Expanded identities that still exist in the latest issue set. */
  next: Set<string>;
  /** Identities removed because their issue disappeared. */
  removed: string[];
};

/**
 * Keep expansions whose issue still exists after a data refresh and drop every
 * stale identity, so an old path can never point at a different node.
 */
export function reconcileExpanded(
  expanded: Set<string>,
  issues: ReadonlyArray<Pick<RefIssue, 'instancePath' | 'schemaPath'>>,
): ReconcileResult {
  const live = new Set(issues.map(issueKey));
  const next = new Set<string>();
  const removed: string[] = [];
  for (const key of expanded) {
    if (live.has(key)) next.add(key);
    else removed.push(key);
  }
  return {next, removed};
}

export const ISSUE_META: Record<IssueCode, {label: string; tone: string}> = {
  cycle: {label: '循环引用', tone: 'danger'},
  remote_unavailable: {label: '远程引用失败', tone: 'warning'},
  invalid_pointer: {label: '无效引用', tone: 'danger'},
};

/**
 * Guard for rapid example switches: a response is applied only when its token
 * is still the latest one issued.
 */
export function isStale(token: number, latest: number): boolean {
  return token !== latest;
}
