// Mirrors quantityOf() in backend/internal/recipekeeper/store.go exactly,
// because ConsumeUnits and this frontend both need to agree on how many
// units an item represents. The backend uses strconv.Atoi, which rejects
// anything that isn't the whole string as an integer — "2 lbs" is NOT 2,
// it's an unparseable quantity that means "1 unit" — unlike parseInt, which
// would silently read "2 lbs" as 2 and disagree with the server.
export function parseQuantity(quantity: string | null): number {
  if (!quantity) return 1;
  if (!/^[+-]?\d+$/.test(quantity)) return 1;
  const n = Number(quantity);
  return n < 1 ? 1 : n;
}
