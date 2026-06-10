import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { DayCard } from '../DayCard'
import type { DayData } from '../../types'

// Mock the RichTextEditor since we test it separately
vi.mock('../RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange, onBlur, autoFocus, placeholder }: any) => (
    <textarea
      data-testid="rich-text-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      data-autofocus={autoFocus}
    />
  ),
}))

describe('DayCard auto-save', () => {
  const mockDayData: DayData = {
    date: '2024-02-15',
    meal_note: {
      id: 'note-1',
      date: '2024-02-15',
      notes: '<p>Breakfast: Oatmeal</p><p>Lunch: Sandwich</p>',
      items: [
        { line_index: 0, itemized: true },
        { line_index: 1, itemized: false },
      ],
    },
    events: [],
  }

  const defaultProps = {
    day: mockDayData,
    isToday: false,
    onNotesChange: vi.fn(),
    onToggleItemized: vi.fn(),
    eventsLoading: false,
    showItemizedColumn: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Render the card and enter edit mode the same way DayCard.test.tsx does:
  // click the meal text to open the editor.
  function renderAndEdit() {
    render(<DayCard {...defaultProps} />)
    const textElement = screen.getByText('Breakfast: Oatmeal')
    fireEvent.click(textElement)
    return screen.getByTestId('rich-text-editor')
  }

  it('auto-saves 1.5s after typing stops', () => {
    const editor = renderAndEdit()

    fireEvent.change(editor, { target: { value: 'New meal content' } })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(defaultProps.onNotesChange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(defaultProps.onNotesChange).toHaveBeenCalledTimes(1)
    expect(defaultProps.onNotesChange).toHaveBeenCalledWith('New meal content')
  })

  it('debounce resets while typing continues', () => {
    const editor = renderAndEdit()

    fireEvent.change(editor, { target: { value: 'First draft' } })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(defaultProps.onNotesChange).not.toHaveBeenCalled()

    fireEvent.change(editor, { target: { value: 'Final content' } })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // Only 1000ms since the last change — debounce should have reset
    expect(defaultProps.onNotesChange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(defaultProps.onNotesChange).toHaveBeenCalledTimes(1)
    expect(defaultProps.onNotesChange).toHaveBeenCalledWith('Final content')
  })

  it('flushes immediately when the page is hidden', () => {
    const editor = renderAndEdit()

    fireEvent.change(editor, { target: { value: 'Backgrounded content' } })
    expect(defaultProps.onNotesChange).not.toHaveBeenCalled()

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState'
    )
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    try {
      act(() => {
        fireEvent(document, new Event('visibilitychange'))
      })
      expect(defaultProps.onNotesChange).toHaveBeenCalledTimes(1)
      expect(defaultProps.onNotesChange).toHaveBeenCalledWith('Backgrounded content')

      // The debounce timer should have been cancelled — no second save later
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(defaultProps.onNotesChange).toHaveBeenCalledTimes(1)
    } finally {
      // Restore visibilityState
      delete (document as any).visibilityState
      if (originalDescriptor) {
        Object.defineProperty(Document.prototype, 'visibilityState', originalDescriptor)
      }
    }
  })

  it('flushes on pagehide', () => {
    const editor = renderAndEdit()

    fireEvent.change(editor, { target: { value: 'Unloading content' } })
    expect(defaultProps.onNotesChange).not.toHaveBeenCalled()

    act(() => {
      fireEvent(window, new Event('pagehide'))
    })
    expect(defaultProps.onNotesChange).toHaveBeenCalledTimes(1)
    expect(defaultProps.onNotesChange).toHaveBeenCalledWith('Unloading content')

    // The debounce timer should have been cancelled — no second save later
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(defaultProps.onNotesChange).toHaveBeenCalledTimes(1)
  })

  it('does not save when nothing changed', () => {
    renderAndEdit()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    act(() => {
      fireEvent(window, new Event('pagehide'))
    })

    expect(defaultProps.onNotesChange).not.toHaveBeenCalled()
  })
})
