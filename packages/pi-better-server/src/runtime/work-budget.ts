// Source hints coalesce by entity. Receipt/application remains owned by each
// domain; both domains take the same bounded foreground allowance before repair.
export const ENTITY_BUDGET = 32;
export function workPage<T>(items: Iterable<T>, limit = ENTITY_BUDGET): T[] {
  const page: T[] = [];
  for (const item of items) { if (page.length === limit) break; page.push(item); }
  return page;
}
