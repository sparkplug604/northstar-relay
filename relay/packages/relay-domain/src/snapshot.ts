/** Copy plain domain data before freezing so callers retain ownership of their inputs. */
export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}
