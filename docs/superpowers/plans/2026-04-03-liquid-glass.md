# Liquid Glass UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the meal planner with subtle iOS liquid glass aesthetics — frosted glass cards, dark gradient background, and a floating pill bottom nav — without changing any functionality.

**Architecture:** Add `.glass` and `.glass-nav` CSS utility classes in `index.css`, then swap solid background/border classes for these utilities across all card, modal, popover, and nav components. Dark mode gets a gradient body background.

**Tech Stack:** Tailwind CSS 3.4, custom CSS utilities with `backdrop-filter`

**Spec:** `docs/superpowers/specs/2026-04-03-liquid-glass-design.md`

---

### Task 1: Add Glass CSS Utilities and Dark Gradient Background

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add glass utility classes to index.css**

Add after the existing `@tailwind utilities;` line and before any existing custom styles:

```css
/* Liquid glass utilities */
.glass {
  background: rgba(255, 255, 255, 0.55);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.03);
}

.dark .glass {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.glass-nav {
  background: rgba(255, 255, 255, 0.7);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.dark .glass-nav {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.glass-subtle {
  background: rgba(255, 255, 255, 0.3);
}

.dark .glass-subtle {
  background: rgba(255, 255, 255, 0.04);
}

.glass-sticky {
  background: rgba(255, 255, 255, 0.4);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}

.dark .glass-sticky {
  background: rgba(255, 255, 255, 0.04);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
```

- [ ] **Step 2: Update dark mode body background to gradient**

In the existing `.dark body` rule in `index.css`, replace `@apply bg-gray-900;` with:

```css
.dark body {
  background: linear-gradient(145deg, #0c1a2e 0%, #0a1f1a 35%, #0f1b2d 60%, #091a1f 100%);
  min-height: 100dvh;
  background-attachment: fixed;
}
```

- [ ] **Step 3: Build and verify no errors**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/index.css
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: add glass CSS utilities and dark gradient background"
```

---

### Task 2: Convert DayCard to Glass Styling

**Files:**
- Modify: `frontend/src/components/DayCard.tsx`

- [ ] **Step 1: Update compact view card wrapper (line ~428)**

Find the compact view outer div with classes including `bg-white dark:bg-gray-800 rounded-md shadow-sm border`. Replace those background/border/shadow classes with `glass rounded-md`. Keep all other classes (padding, margin, data attributes, conditional classes like today highlight and drag target).

Note: The `border` classes for today state (`border-blue-400`) and drag target state (`ring-2 ring-blue-500 border-blue-500`) must be preserved. The `glass` class sets a default border, and the conditional border-color classes will override it when active. Add `border-transparent` as the default non-today/non-drag border so it overrides the glass border cleanly only when needed — or just let the glass border show through as the default.

- [ ] **Step 2: Update regular view card wrapper (line ~634)**

Find the regular view outer div with classes including `bg-white dark:bg-gray-800 rounded-lg shadow-sm border`. Replace those background/border/shadow classes with `glass rounded-lg`. Same border considerations as step 1.

- [ ] **Step 3: Update section headers inside cards**

Find header backgrounds using `bg-gray-50 dark:bg-gray-800` or `bg-blue-50 dark:bg-blue-900/30` (today state). Replace the non-today header bg with `glass-subtle`. Keep today's blue tint as-is since it's a distinct visual state.

- [ ] **Step 4: Update context menu popups (lines ~601, ~802)**

Find context menu divs with `bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 shadow-lg`. Replace with `glass rounded-md`. Keep `fixed z-50 min-w-[180px] py-1 text-sm` and all other classes.

- [ ] **Step 5: Build and verify**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/components/DayCard.tsx
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: convert DayCard to glass styling"
```

---

### Task 3: Convert GroceryListView to Glass Styling

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx`

- [ ] **Step 1: Update sticky action bar (line ~436)**

Find the sticky div with `bg-gray-100 dark:bg-gray-900 -mx-4 px-4`. Replace `bg-gray-100 dark:bg-gray-900` with `glass-sticky`. Keep `-mx-4 px-4 pt-4 pb-2 space-y-4`, `sticky z-[9]`, and the inline `style={{ top: 'var(--header-h, 52px)' }}`.

- [ ] **Step 2: Update quick-add form card (line ~440)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4`. Replace `bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700` with `glass`. Keep `rounded-lg p-4` and `flex-1`.

- [ ] **Step 3: Update section card containers (line ~904)**

Find the section wrapper div with `bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700`. Replace with `glass rounded-lg`. Keep all other classes and attributes.

- [ ] **Step 4: Update section filter dropdown (line ~551)**

Find the dropdown div with `bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg`. Replace with `glass rounded-lg`. Keep `absolute z-20 left-0 right-0 mt-1 max-h-40 overflow-y-auto`.

- [ ] **Step 5: Update sort menu popover (line ~675)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700`. Replace with `glass rounded-lg`. Keep `absolute right-0 top-full mt-1 py-1 z-20 min-w-[220px]`.

- [ ] **Step 6: Build and verify**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/components/GroceryListView.tsx
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: convert GroceryListView to glass styling"
```

---

### Task 4: Convert PantryPanel to Glass Styling

**Files:**
- Modify: `frontend/src/components/PantryPanel.tsx`

- [ ] **Step 1: Update sticky action bar (line ~164)**

Find the sticky div with `bg-gray-100 dark:bg-gray-900 -mx-4 px-4`. Replace `bg-gray-100 dark:bg-gray-900` with `glass-sticky`. Keep `-mx-4 px-4 pt-4 pb-2`, `sticky z-[9]`, and the inline style.

- [ ] **Step 2: Update add-section input container (line ~168)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700`. Replace with `glass rounded-lg`. Keep `flex-1 flex items-center gap-2 px-3 py-2`.

- [ ] **Step 3: Update add-section button (line ~197)**

Find the button with `bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700`. Replace with `glass rounded-lg hover:brightness-110`. Keep `px-3 py-2 text-sm` and other classes.

- [ ] **Step 4: Update section menu popover (line ~217)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700`. Replace with `glass rounded-lg`. Keep `absolute right-0 top-full mt-1 py-1 z-20 min-w-[180px]`.

- [ ] **Step 5: Update empty state card (line ~248)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4`. Replace with `glass rounded-lg p-4`.

- [ ] **Step 6: Update section card containers (line ~385)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden`. Replace with `glass rounded-lg overflow-hidden`.

- [ ] **Step 7: Build and verify**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds.

- [ ] **Step 8: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/components/PantryPanel.tsx
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: convert PantryPanel to glass styling"
```

---

### Task 5: Convert MealIdeasPanel, StoreFilterBar, StoreAutocomplete, and SettingsModal to Glass

**Files:**
- Modify: `frontend/src/components/MealIdeasPanel.tsx`
- Modify: `frontend/src/components/StoreFilterBar.tsx`
- Modify: `frontend/src/components/StoreAutocomplete.tsx`
- Modify: `frontend/src/components/SettingsModal.tsx`

- [ ] **Step 1: Update MealIdeasPanel compact view (line ~119)**

Find the div with `bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm`. Replace with `glass rounded-lg`.

- [ ] **Step 2: Update MealIdeasPanel regular view (line ~202)**

Find the div with `bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm`. Replace with `glass rounded-lg`.

- [ ] **Step 3: Update StoreFilterBar popover (line ~388)**

Find the div with `bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-lg p-3 mx-2`. Replace with `glass rounded-lg p-3 mx-2`.

- [ ] **Step 4: Update StoreAutocomplete dropdown (line ~87)**

Find the div with `bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg`. Replace with `glass rounded`. Keep `absolute z-50 mt-1 w-full max-h-40 overflow-y-auto`.

- [ ] **Step 5: Update SettingsModal container (line ~453)**

Find the div with `bg-white dark:bg-gray-800 rounded-lg shadow-xl`. Replace with `glass rounded-lg`. Keep `max-w-sm w-full max-h-[90vh] overflow-y-auto`.

- [ ] **Step 6: Build and verify**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/components/MealIdeasPanel.tsx frontend/src/components/StoreFilterBar.tsx frontend/src/components/StoreAutocomplete.tsx frontend/src/components/SettingsModal.tsx
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: convert remaining panels, popovers, and modal to glass"
```

---

### Task 6: Convert BottomNav to Floating Island

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Update bottom nav container (line ~122)**

Find the bottom nav div. Current classes include `fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 z-30 safe-area-bottom` and contains a flex container with nav items.

Replace with floating island styling:
- Remove: `left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700`
- Add: `glass-nav left-1/2 -translate-x-1/2 rounded-full px-6`
- Change: `bottom-0` → `bottom-4`
- Keep: `fixed z-30 safe-area-bottom`

The inner flex container should keep its existing `flex items-center justify-around` but may need `gap-6` instead of full-width justify. Adjust the inner container to use `gap-7` or similar so the icons are spaced in the pill.

- [ ] **Step 2: Update main content padding**

Find all instances of `pb-20` in the main content areas (lines ~275, ~340, ~365 in App.tsx). Change to `pb-28` to account for the floating nav being lifted higher with margin.

- [ ] **Step 3: Update MealIdeasPanel sticky bar in App.tsx (line ~278)**

Find the sticky div wrapping MealIdeasPanel with `bg-gray-100 dark:bg-gray-900 -mx-4 px-4`. Replace `bg-gray-100 dark:bg-gray-900` with `glass-sticky`. Keep all positioning classes.

- [ ] **Step 4: Update page background classes**

Find the auth loading screen (line ~783), network error screen (line ~794), and offline wrapper (line ~810) that use `bg-gray-100 dark:bg-gray-900`. Keep `bg-gray-100` for light mode. The dark gradient is applied on `body` via CSS so `dark:bg-gray-900` can be replaced with `dark:bg-transparent` to let the body gradient show through.

- [ ] **Step 5: Update network error card (line ~795)**

Find the card div with `bg-white dark:bg-gray-800 rounded-lg shadow-lg`. Replace with `glass rounded-lg`.

- [ ] **Step 6: Build and verify**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/App.tsx
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: convert BottomNav to floating island and update page backgrounds"
```

---

### Task 7: Visual QA and Final Adjustments

- [ ] **Step 1: Run full test suite**

Run: `bash /Users/evan.callia/Desktop/meal-planner/run-tests.sh`
Expected: All tests pass (styling changes should not affect any tests).

- [ ] **Step 2: Build for production**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Clean build with no warnings.

- [ ] **Step 3: Commit any adjustments**

If any fixes were needed, commit them:
```bash
git -C /Users/evan.callia/Desktop/meal-planner add -A
git -C /Users/evan.callia/Desktop/meal-planner commit -m "style: liquid glass QA fixes"
```
