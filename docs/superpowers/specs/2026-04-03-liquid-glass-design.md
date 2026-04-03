# Liquid Glass UI Redesign

Styling-only changes to give the meal planner app an iOS liquid glass aesthetic. No functionality changes.

## Decisions

- **Glass intensity**: Subtle accents (not full transformation)
- **Light mode background**: Solid gray-100 (unchanged)
- **Dark mode background**: Deep navy-to-teal gradient (`linear-gradient(145deg, #0c1a2e, #0a1f1a, #0f1b2d, #091a1f)`)
- **Page header**: Stays solid/opaque
- **Bottom nav**: Floating pill-shaped island (Dynamic Island style — compact, centered, generous bottom margin)
- **StatusBar**: Stays solid (colored backgrounds for visibility)

## CSS Utility Classes (index.css)

### `.glass`

General-purpose frosted glass panel for cards, modals, popovers, dropdowns.

**Light mode:**
- `background: rgba(255, 255, 255, 0.55)`
- `backdrop-filter: blur(16px)` + `-webkit-backdrop-filter: blur(16px)`
- `border: 1px solid rgba(255, 255, 255, 0.4)`
- `box-shadow: 0 1px 4px rgba(0, 0, 0, 0.03)`

**Dark mode:**
- `background: rgba(255, 255, 255, 0.06)`
- `backdrop-filter: blur(16px)` + `-webkit-backdrop-filter: blur(16px)`
- `border: 1px solid rgba(255, 255, 255, 0.06)`
- `box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2)`

### `.glass-nav`

Stronger variant for the floating bottom nav island.

**Light mode:**
- `background: rgba(255, 255, 255, 0.7)`
- `backdrop-filter: blur(20px)` + `-webkit-backdrop-filter: blur(20px)`
- `border: 1px solid rgba(255, 255, 255, 0.4)`
- `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08)`

**Dark mode:**
- `background: rgba(255, 255, 255, 0.1)`
- `backdrop-filter: blur(20px)` + `-webkit-backdrop-filter: blur(20px)`
- `border: 1px solid rgba(255, 255, 255, 0.08)`
- `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4)`

### Body background

- Light: `bg-gray-100` (unchanged)
- Dark: `background: linear-gradient(145deg, #0c1a2e 0%, #0a1f1a 35%, #0f1b2d 60%, #091a1f 100%)`
- Dark gradient needs `min-height: 100dvh` and `background-attachment: fixed` so it doesn't tile on scroll

## Component Changes

### Cards (DayCard, Grocery sections, Pantry sections)

**Replace:**
- `bg-white dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700`

**With:**
- `glass` class
- Keep existing `rounded-lg`

**Section headers inside cards:**
- Replace `bg-gray-50 dark:bg-gray-700/50` with `bg-white/30 dark:bg-white/[0.04]`

### Bottom Nav → Floating Island

**Layout changes:**
- Remove: full-width positioning, `border-t border-gray-200 dark:border-gray-700`
- Add: `max-w-fit mx-auto`, `rounded-full`, `bottom-4` (lifted from edge)
- Apply `glass-nav` class

**Sizing:**
- Compact pill — just enough internal padding for icons+labels
- Centered horizontally with generous bottom margin (~16px from bottom)

**Preserved:**
- Icons, labels, active/inactive color states
- Grocery count badge
- Safe area bottom padding (applied as margin below the pill)

**Content padding:**
- Increase `pb` on main content area to account for floating nav height + gap

### Modals / Popovers / Dropdowns

- SettingsModal: apply `glass` class, remove solid `bg-white dark:bg-gray-800`
- Store popovers: apply `glass` class
- Combobox dropdowns (grocery quick-add section picker): apply `glass` class

### Sticky Sub-bars

Grocery action bar, pantry action bar, MealIdeasPanel sticky headers:
- Replace solid `bg-gray-100 dark:bg-gray-900` with `bg-white/40 dark:bg-white/[0.04] backdrop-blur-md`
- Keep existing `-mx-4 px-4` full-width extension and `z-[9]` stacking

## Unchanged

- **PageHeader**: solid background (no glass)
- **StatusBar**: solid colored backgrounds (orange/yellow)
- **All functionality**: no behavior, state, or API changes
- **Event colors**: `EVENT_COLORS` system in DayCard
- **Dark mode toggle**: class-based, same mechanism
- **Drag & drop**: ghost elements and visual feedback
- **Typography, spacing, layout**: same max-w-lg centered layout
- **Tailwind config**: no custom theme extensions needed
