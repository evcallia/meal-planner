/**
 * Capitalize the first letter of each word in a string.
 * Preserves existing capitalization (e.g. "BBQ sauce" → "BBQ Sauce").
 */
export function toTitleCase(str: string): string {
  return str.replace(/(^|\s)\S/g, c => c.toUpperCase());
}
