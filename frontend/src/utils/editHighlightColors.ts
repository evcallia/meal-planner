// Highlight applied to whichever card/row is currently being edited.
// Class strings must stay full literals so Tailwind's scanner picks them up.
export const EDIT_HIGHLIGHT_COLORS: Record<string, { form: string; cardRing: string; cardBorderColor: string }> = {
  emerald: {
    form: 'bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-inset ring-emerald-300 dark:ring-emerald-700',
    cardRing: 'ring-2 ring-emerald-300 dark:ring-emerald-700',
    cardBorderColor: 'rgb(52, 211, 153)',
  },
  amber: {
    form: 'bg-amber-50 dark:bg-amber-900/20 ring-1 ring-inset ring-amber-300 dark:ring-amber-700',
    cardRing: 'ring-2 ring-amber-300 dark:ring-amber-700',
    cardBorderColor: 'rgb(251, 191, 36)',
  },
  purple: {
    form: 'bg-purple-50 dark:bg-purple-900/20 ring-1 ring-inset ring-purple-300 dark:ring-purple-700',
    cardRing: 'ring-2 ring-purple-300 dark:ring-purple-700',
    cardBorderColor: 'rgb(192, 132, 252)',
  },
  pink: {
    form: 'bg-pink-50 dark:bg-pink-900/20 ring-1 ring-inset ring-pink-300 dark:ring-pink-700',
    cardRing: 'ring-2 ring-pink-300 dark:ring-pink-700',
    cardBorderColor: 'rgb(244, 114, 182)',
  },
  red: {
    form: 'bg-red-50 dark:bg-red-900/20 ring-1 ring-inset ring-red-300 dark:ring-red-700',
    cardRing: 'ring-2 ring-red-300 dark:ring-red-700',
    cardBorderColor: 'rgb(248, 113, 113)',
  },
  blue: {
    form: 'bg-blue-50 dark:bg-blue-900/20 ring-1 ring-inset ring-blue-300 dark:ring-blue-700',
    cardRing: 'ring-2 ring-blue-300 dark:ring-blue-700',
    cardBorderColor: 'rgb(96, 165, 250)',
  },
};

export function getEditHighlight(color: string | undefined) {
  return EDIT_HIGHLIGHT_COLORS[color ?? 'emerald'] ?? EDIT_HIGHLIGHT_COLORS.emerald;
}
