/** Wall-clock milliseconds that agree across the page and its workers. */
export const now = (): number => performance.now() + performance.timeOrigin;
