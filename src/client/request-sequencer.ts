/**
 * Tracks the latest in-flight load so that stale responses cannot overwrite
 * newer data (e.g. switching examples quickly while a slow preview is still
 * in flight). Each call to `next()` invalidates every previously issued
 * token.
 */
export class RequestSequencer {
  private current = 0;

  next(): {isCurrent: () => boolean} {
    const token = (this.current += 1);
    return {isCurrent: () => this.current === token};
  }
}
