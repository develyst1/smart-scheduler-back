// Pure badge rules. A booking may carry at most ONE value per badge type.

export interface ValueTypeRef {
  id: string;
  typeId: string;
}

/**
 * Return the first badge type that appears more than once among the given values
 * (i.e. two values from the same type), or null when every type is unique.
 */
export function findTypeConflict(values: ValueTypeRef[]): string | null {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v.typeId)) return v.typeId;
    seen.add(v.typeId);
  }
  return null;
}
