import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DayCard } from '../DayCard'
import type { DayData } from '../../types'

describe('DayCard - Edge Cases', () => {
  it('handles malformed date strings gracefully', () => {
    const malformedDayData: DayData = {
      date: 'invalid-date',
      meal_note: null,
      events: [],
    }

    const props = {
      day: malformedDayData,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    // Should not throw an error
    expect(() => render(<DayCard {...props} />)).not.toThrow()
  })

  it('handles missing meal_note gracefully', () => {
    const dayWithoutMealNote: DayData = {
      date: '2024-02-15',
      meal_note: null,
      events: [],
    }

    const props = {
      day: dayWithoutMealNote,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    render(<DayCard {...props} />)
    expect(screen.getByText('Tap to add meals...')).toBeInTheDocument()
  })

  it('handles empty events array', () => {
    const dayWithoutEvents: DayData = {
      date: '2024-02-15',
      meal_note: {
        id: 1,
        date: '2024-02-15',
        notes: 'Some notes',
        items: [],
      },
      events: [],
    }

    const props = {
      day: dayWithoutEvents,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    render(<DayCard {...props} />)
    // Should render without events section
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument()
  })

  it('handles events with missing or malformed times', () => {
    const dayWithBadEvents: DayData = {
      date: '2024-02-15',
      meal_note: null,
      events: [
        {
          title: 'Event with bad time',
          start_time: 'not-a-date',
          all_day: false,
        },
        {
          title: 'Event without title',
          start_time: '2024-02-15T19:00:00Z',
          all_day: false,
        } as any,
      ],
    }

    const props = {
      day: dayWithBadEvents,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    // Should not throw an error
    expect(() => render(<DayCard {...props} />)).not.toThrow()
  })

  it('handles very long meal notes', () => {
    const longNotes = 'A'.repeat(10000) // Very long string
    const dayWithLongNotes: DayData = {
      date: '2024-02-15',
      meal_note: {
        id: 1,
        date: '2024-02-15',
        notes: longNotes,
        items: [],
      },
      events: [],
    }

    const props = {
      day: dayWithLongNotes,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    render(<DayCard {...props} />)
    // Should handle long content without breaking
    expect(screen.getByText(longNotes)).toBeInTheDocument()
  })

  it('handles HTML injection attempts safely', () => {
    const maliciousNotes = '<script>alert("xss")</script><p>Safe content</p>'
    const dayWithMaliciousNotes: DayData = {
      date: '2024-02-15',
      meal_note: {
        id: 1,
        date: '2024-02-15',
        notes: maliciousNotes,
        items: [],
      },
      events: [],
    }

    const props = {
      day: dayWithMaliciousNotes,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    render(<DayCard {...props} />)
    // Script tags should not execute (handled by dangerouslySetInnerHTML safely)
    expect(screen.getByText('Safe content')).toBeInTheDocument()
    // Script should be rendered as text, not executed
    expect(screen.queryByText('alert("xss")')).not.toBeInTheDocument()
  })

  it('handles items with out-of-bounds line indices', () => {
    const dayWithBadItems: DayData = {
      date: '2024-02-15',
      meal_note: {
        id: 1,
        date: '2024-02-15',
        notes: '<p>Line 1</p><p>Line 2</p>',
        items: [
          { line_index: 0, itemized: true },
          { line_index: 1, itemized: false },
          { line_index: 999, itemized: true }, // Out of bounds
          { line_index: -1, itemized: true },  // Negative index
        ],
      },
      events: [],
    }

    const props = {
      day: dayWithBadItems,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    // Should not crash
    expect(() => render(<DayCard {...props} />)).not.toThrow()
  })

  it('handles rapid state changes without breaking', () => {
    const dayData: DayData = {
      date: '2024-02-15',
      meal_note: {
        id: 1,
        date: '2024-02-15',
        notes: '<p>Test content</p>',
        items: [{ line_index: 0, itemized: false }],
      },
      events: [],
    }

    const props = {
      day: dayData,
      isToday: false,
      onNotesChange: vi.fn(),
      onToggleItemized: vi.fn(),
    }

    const { rerender } = render(<DayCard {...props} />)

    // Rapidly change props
    for (let i = 0; i < 10; i++) {
      const updatedDay = {
        ...dayData,
        meal_note: {
          ...dayData.meal_note!,
          notes: `<p>Content ${i}</p>`,
        },
      }
      rerender(<DayCard {...props} day={updatedDay} />)
    }

    // Should still render correctly
    expect(screen.getByText('Content 9')).toBeInTheDocument()
  })
})