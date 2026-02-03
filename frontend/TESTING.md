# Testing Documentation

This project uses **Vitest** as the testing framework with **React Testing Library** for component testing.

## Running Tests

```bash
# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run tests with UI
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

## Test Structure

### Unit Tests
- **Utilities**: `src/utils/__tests__/`
  - `autolink.test.ts` - Tests URL auto-linking functionality
- **Hooks**: `src/hooks/__tests__/`
  - `useSettings.test.ts` - Settings management hook
  - `useDarkMode.test.ts` - Dark mode toggle hook
  - `useOnlineStatus.test.ts` - Online/offline detection hook

### Component Tests
- **Components**: `src/components/__tests__/`
  - `SettingsModal.test.tsx` - Settings modal functionality
  - `MealItem.test.tsx` - Individual meal item component
  - `RichTextEditor.test.tsx` - Rich text editing functionality
  - `StatusBar.test.tsx` - Connection status display
  - `DayCard.test.tsx` - Main day card component (integration tests)
  - `DayCard.edge-cases.test.tsx` - Error handling and edge cases

## Test Categories

### 1. Utility Function Tests
- **Auto-linking**: Converts URLs to clickable links while preserving existing HTML
- **Edge cases**: Empty strings, malformed URLs, HTML injection attempts

### 2. Hook Tests
- **Settings Management**: localStorage persistence, default values, partial updates
- **Dark Mode**: System preference detection, manual toggle, localStorage sync
- **Online Status**: Network connectivity detection, event listener management

### 3. Component Tests
- **User Interactions**: Click handlers, keyboard navigation, form inputs
- **State Management**: Component state changes, prop updates
- **Accessibility**: ARIA attributes, keyboard navigation, screen reader support
- **Visual States**: Loading states, error states, empty states

### 4. Integration Tests
- **DayCard Component**: Tests the complete meal planning workflow
- **Edit Mode**: Switching between read and edit modes
- **Auto-save**: Debounced saving functionality
- **Itemized Toggle**: Checkbox state management

### 5. Error Handling Tests
- **Malformed Data**: Invalid dates, missing properties
- **XSS Prevention**: Script injection attempts
- **Network Errors**: Offline scenarios, failed requests
- **Performance**: Large data sets, rapid state changes

## Testing Patterns

### Component Testing
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

it('handles user interaction', async () => {
  const user = userEvent.setup()
  const mockFn = vi.fn()
  
  render(<Component onAction={mockFn} />)
  
  await user.click(screen.getByRole('button'))
  expect(mockFn).toHaveBeenCalled()
})
```

### Hook Testing
```tsx
import { renderHook, act } from '@testing-library/react'

it('updates state correctly', () => {
  const { result } = renderHook(() => useMyHook())
  
  act(() => {
    result.current.updateValue('new value')
  })
  
  expect(result.current.value).toBe('new value')
})
```

### Async Testing
```tsx
import { waitFor } from '@testing-library/react'

it('handles async operations', async () => {
  render(<AsyncComponent />)
  
  await waitFor(() => {
    expect(screen.getByText('Loaded')).toBeInTheDocument()
  })
})
```

## Mock Strategy

### Global Mocks
- **localStorage**: Mocked in setup.ts for consistent behavior
- **IntersectionObserver**: Required for scroll-related components
- **document.execCommand**: For rich text editor functionality
- **window.getSelection**: For cursor position management

### Component Mocks
- **RichTextEditor**: Simplified textarea for integration tests
- **API Calls**: Mocked where necessary for isolated testing

## Coverage Requirements

The test suite aims for:
- **Statements**: >90%
- **Branches**: >85%
- **Functions**: >90%
- **Lines**: >90%

Critical paths (user interactions, data persistence, error handling) should have 100% coverage.

## Best Practices

1. **Test Behavior, Not Implementation**: Focus on what users can do, not internal details
2. **Accessibility First**: Use semantic queries (`getByRole`, `getByLabelText`)
3. **Realistic Scenarios**: Test with real-world data and edge cases
4. **Isolation**: Each test should be independent and repeatable
5. **Clear Descriptions**: Test names should explain the expected behavior
6. **Error Cases**: Always test error scenarios and edge cases

## Debugging Tests

### Viewing Test Output
```bash
# Run with verbose output
npm test -- --reporter=verbose

# Debug a specific test file
npm test -- DayCard.test.tsx
```

### Test Debugging
```tsx
// Add debug output
import { screen } from '@testing-library/react'

// Print current DOM structure
screen.debug()

// Print specific element
screen.debug(screen.getByRole('button'))
```

### Coverage Reports
After running `npm run test:coverage`, open `coverage/index.html` to see detailed coverage reports with line-by-line analysis.

## Continuous Integration

Tests are designed to run in CI environments with:
- Headless browser simulation via happy-dom
- No external dependencies
- Deterministic results
- Fast execution times

All tests should pass before merging code changes.