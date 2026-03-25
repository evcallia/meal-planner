import { describe, it, expect } from 'vitest';
import { parseGroceryText } from '../groceryParser';

describe('parseGroceryText', () => {
  it('returns empty array for empty input', () => {
    expect(parseGroceryText('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseGroceryText('   \n  \n  ')).toEqual([]);
  });

  it('parses a single section with items', () => {
    const text = '[Produce]\nBananas\nApples';
    const result = parseGroceryText(text);
    expect(result).toEqual([
      {
        name: 'Produce',
        items: [
          { name: 'Bananas', quantity: null },
          { name: 'Apples', quantity: null },
        ],
      },
    ]);
  });

  it('parses items with quantities', () => {
    const text = '[Dairy]\n(2) Milk\n(1) Butter';
    const result = parseGroceryText(text);
    expect(result).toEqual([
      {
        name: 'Dairy',
        items: [
          { name: 'Milk', quantity: '2' },
          { name: 'Butter', quantity: '1' },
        ],
      },
    ]);
  });

  it('parses mixed items with and without quantities', () => {
    const text = '[Snacks]\n(3) Granola Bars\nChips';
    const result = parseGroceryText(text);
    expect(result).toEqual([
      {
        name: 'Snacks',
        items: [
          { name: 'Granola Bars', quantity: '3' },
          { name: 'Chips', quantity: null },
        ],
      },
    ]);
  });

  it('parses multiple sections', () => {
    const text = '[Produce]\nBananas\n\n[Dairy]\nMilk';
    const result = parseGroceryText(text);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Produce');
    expect(result[0].items).toHaveLength(1);
    expect(result[1].name).toBe('Dairy');
    expect(result[1].items).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const text = '[Produce]\n\nBananas\n\n\nApples\n';
    const result = parseGroceryText(text);
    expect(result[0].items).toHaveLength(2);
  });

  it('skips title lines before first section header', () => {
    const text = 'Groceries\n[Produce]\nBananas';
    const result = parseGroceryText(text);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Produce');
  });

  it('creates Uncategorized section for items with quantity before any header', () => {
    const text = '(2) Bananas\n(1) Milk';
    const result = parseGroceryText(text);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Uncategorized');
    expect(result[0].items).toEqual([
      { name: 'Bananas', quantity: '2' },
      { name: 'Milk', quantity: '1' },
    ]);
  });

  it('trims whitespace from section names', () => {
    const text = '[  Produce  ]\nBananas';
    const result = parseGroceryText(text);
    expect(result[0].name).toBe('Produce');
  });

  it('trims whitespace from item names', () => {
    const text = '[Produce]\n  Bananas  ';
    const result = parseGroceryText(text);
    expect(result[0].items[0].name).toBe('Bananas');
  });

  it('handles items without quantity after an Uncategorized section is created', () => {
    const text = '(2) Bananas\nApples';
    const result = parseGroceryText(text);
    expect(result[0].name).toBe('Uncategorized');
    expect(result[0].items).toHaveLength(2);
    expect(result[0].items[1]).toEqual({ name: 'Apples', quantity: null });
  });

  it('handles complex real-world grocery list', () => {
    const text = `My Groceries

[Produce]
(2) Bananas
Arugula
(1) Avocado

[Dairy]
Milk
Yogurt

[Bakery]
(1) Sourdough Bread`;

    const result = parseGroceryText(text);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Produce');
    expect(result[0].items).toHaveLength(3);
    expect(result[1].name).toBe('Dairy');
    expect(result[1].items).toHaveLength(2);
    expect(result[2].name).toBe('Bakery');
    expect(result[2].items).toHaveLength(1);
  });
});
