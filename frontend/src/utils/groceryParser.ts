export interface ParsedGroceryItem {
  name: string;
  quantity: string | null;
}

export interface ParsedGrocerySection {
  name: string;
  items: ParsedGroceryItem[];
}

/**
 * Parse a grocery list text blob into sections and items.
 *
 * Format:
 *   [Section Name]
 *   (N) Item Name     → item with quantity "N"
 *   Item Name         → item with no quantity
 *
 * Lines that don't match any pattern and aren't blank are treated as items
 * under the current section. Items before any section header go into an
 * "Uncategorized" section.
 */
export function parseGroceryText(text: string): ParsedGrocerySection[] {
  const lines = text.split('\n');
  const sections: ParsedGrocerySection[] = [];
  let currentSection: ParsedGrocerySection | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Check for section header: [Section Name]
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = { name: sectionMatch[1].trim(), items: [] };
      sections.push(currentSection);
      continue;
    }

    // Skip title-like lines (no section yet, single word/phrase before first bracket)
    if (!currentSection) {
      // Check if this could be a title line (e.g. "Groceries")
      // If there are no sections yet and this isn't an item with quantity, treat as title
      const qtyMatch = line.match(/^\((\d+)\)\s+(.+)$/);
      if (!qtyMatch) {
        // Could be a title — skip it if we haven't seen any sections yet
        // But if we see items without a section, create "Uncategorized"
        continue;
      }
      currentSection = { name: 'Uncategorized', items: [] };
      sections.push(currentSection);
    }

    // Check for item with quantity: (N) Item Name
    const qtyMatch = line.match(/^\((\d+)\)\s+(.+)$/);
    if (qtyMatch) {
      currentSection.items.push({
        name: qtyMatch[2].trim(),
        quantity: qtyMatch[1],
      });
    } else {
      currentSection.items.push({
        name: line,
        quantity: null,
      });
    }
  }

  return sections;
}
