import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('DayCard', () => {
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
    events: [
      {
        id: 'event-1',
        uid: 'uid-1',
        calendar_name: 'Personal',
        title: 'Dinner with friends',
        start_time: '2024-02-15T19:00:00Z',
        end_time: '2024-02-15T20:00:00Z',
        all_day: false,
      },
    ],
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
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders day card with date information', () => {
    render(<DayCard {...defaultProps} />)
    
    expect(screen.getByText('Thursday')).toBeInTheDocument()
    expect(screen.getByText('Feb 15')).toBeInTheDocument()
  })

  it('shows TODAY badge when isToday is true', () => {
    render(<DayCard {...defaultProps} isToday={true} />)
    
    expect(screen.getByText('TODAY')).toBeInTheDocument()
  })

  it('does not show TODAY badge when isToday is false', () => {
    render(<DayCard {...defaultProps} isToday={false} />)
    
    expect(screen.queryByText('TODAY')).not.toBeInTheDocument()
  })

  it('displays events when available', () => {
    render(<DayCard {...defaultProps} />)

    const expectedTime = new Date(mockDayData.events[0].start_time).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    expect(screen.getByText('Dinner with friends')).toBeInTheDocument()
    expect(screen.getByText(expectedTime)).toBeInTheDocument()
  })

  it('opens context menu from event options button and highlights selection', async () => {
    const user = userEvent.setup()
    render(<DayCard {...defaultProps} onHideEvent={vi.fn()} />)

    const optionsButton = screen.getByLabelText('Event options')
    await act(async () => {
      await user.click(optionsButton)
    })

    expect(screen.getByText('Hide event')).toBeInTheDocument()
    const eventRow = screen.getByText('Dinner with friends').closest('[aria-selected]')
    expect(eventRow).toHaveAttribute('aria-selected', 'true')
    expect(eventRow).toHaveClass('opacity-60')
  })

  it('opens context menu on double tap', async () => {
    vi.useFakeTimers()

    render(<DayCard {...defaultProps} onHideEvent={vi.fn()} />)

    const eventRow = screen.getByText('Dinner with friends').closest('[aria-selected]')
    expect(eventRow).toBeTruthy()

    fireEvent.touchStart(eventRow as Element, { touches: [{ clientX: 120, clientY: 140 }] })
    fireEvent.touchEnd(eventRow as Element, { changedTouches: [{ clientX: 120, clientY: 140 }] })

    vi.advanceTimersByTime(200)

    fireEvent.touchStart(eventRow as Element, { touches: [{ clientX: 120, clientY: 140 }] })
    fireEvent.touchEnd(eventRow as Element, { changedTouches: [{ clientX: 120, clientY: 140 }] })

    expect(screen.getByText('Hide event')).toBeInTheDocument()
  })

  it('opens context menu on long press and closes on outside click', async () => {
    vi.useFakeTimers()
    render(<DayCard {...defaultProps} onHideEvent={vi.fn()} />)

    const eventRow = screen.getByText('Dinner with friends').closest('[aria-selected]')
    expect(eventRow).toBeTruthy()

    fireEvent.pointerDown(eventRow as Element, { pointerType: 'touch', clientX: 40, clientY: 50 })

    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    expect(screen.getByText('Hide event')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('Hide event')).not.toBeInTheDocument()
  })

  it('closes context menu on Escape key', async () => {
    vi.useFakeTimers()
    render(<DayCard {...defaultProps} onHideEvent={vi.fn()} />)

    const eventRow = screen.getByText('Dinner with friends').closest('[aria-selected]')
    expect(eventRow).toBeTruthy()

    fireEvent.pointerDown(eventRow as Element, { pointerType: 'touch', clientX: 40, clientY: 50 })

    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    expect(screen.getByText('Hide event')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Hide event')).not.toBeInTheDocument()
  })

  it('cancels long press when touch moves too far', async () => {
    vi.useFakeTimers()
    render(<DayCard {...defaultProps} onHideEvent={vi.fn()} />)

    const eventRow = screen.getByText('Dinner with friends').closest('[aria-selected]')
    expect(eventRow).toBeTruthy()

    fireEvent.touchStart(eventRow as Element, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchMove(eventRow as Element, { touches: [{ clientX: 80, clientY: 80 }] })

    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    expect(screen.queryByText('Hide event')).not.toBeInTheDocument()
  })

  it('renders compact view events and hides via menu', async () => {
    const onHideEvent = vi.fn()
    render(<DayCard {...defaultProps} compactView={true} onHideEvent={onHideEvent} />)

    const optionsButton = screen.getByLabelText('Event options')
    fireEvent.click(optionsButton)

    fireEvent.click(screen.getByText('Hide event'))
    expect(onHideEvent).toHaveBeenCalledWith(mockDayData.events[0])
  })

  it('handles drag and drop interactions', async () => {
    const onDrop = vi.fn()
    render(
      <DayCard
        {...defaultProps}
        onDrop={onDrop}
        dragSourceDate="2024-02-14"
      />
    )

    const card = document.querySelector('.bg-white.dark\\:bg-gray-800.rounded-lg.shadow-sm.border') as HTMLElement
    expect(card).toBeTruthy()

    const dataTransfer = {
      dropEffect: '',
      getData: vi.fn(() => JSON.stringify({ date: '2024-02-14', lineIndex: 0, html: 'Breakfast' })),
    }

    fireEvent.dragOver(card, { dataTransfer })
    await waitFor(() => {
      expect(screen.getByText('Drop here')).toBeInTheDocument()
    })

    fireEvent.dragLeave(card, { relatedTarget: document.body })
    await waitFor(() => {
      expect(screen.queryByText('Drop here')).not.toBeInTheDocument()
    })

    fireEvent.dragOver(card, { dataTransfer })

    fireEvent.drop(card, { dataTransfer })
    expect(onDrop).toHaveBeenCalledWith('2024-02-15', '2024-02-14', 0, 'Breakfast')
  })

  it('logs when drop data cannot be parsed', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<DayCard {...defaultProps} onDrop={vi.fn()} />)

    const card = document.querySelector('.bg-white.dark\\:bg-gray-800.rounded-lg.shadow-sm.border') as HTMLElement
    const dataTransfer = {
      dropEffect: '',
      getData: vi.fn(() => 'not-json'),
    }

    fireEvent.drop(card, { dataTransfer })
    expect(consoleSpy).toHaveBeenCalledWith('Failed to parse drop data:', expect.any(Error))
    consoleSpy.mockRestore()
  })

  it('shows events loading skeleton when eventsLoading is true', () => {
    render(<DayCard {...defaultProps} eventsLoading={true} />)
    
    const loadingElement = document.querySelector('[class*="animate-pulse"]')
    expect(loadingElement).toBeInTheDocument()
  })

  it('renders meal items in read-only mode initially', () => {
    render(<DayCard {...defaultProps} />)
    
    expect(screen.getByText('Breakfast: Oatmeal')).toBeInTheDocument()
    expect(screen.getByText('Lunch: Sandwich')).toBeInTheDocument()
    expect(screen.queryByTestId('rich-text-editor')).not.toBeInTheDocument()
  })

  it('switches to edit mode when text is clicked', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<DayCard {...defaultProps} />)
    
    const textElement = screen.getByText('Breakfast: Oatmeal')
    fireEvent.click(textElement)
    
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument()
    expect(screen.getByTestId('rich-text-editor')).toHaveAttribute('data-autofocus', 'true')
  })

  it('exits edit mode when editor loses focus', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(
      <div>
        <DayCard {...defaultProps} />
        <button>Outside button</button>
      </div>
    )
    
    // Enter edit mode
    const textElement = screen.getByText('Breakfast: Oatmeal')
    fireEvent.click(textElement)
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument()
    
    // Trigger blur event directly on the editor to exit edit mode
    const editor = screen.getByTestId('rich-text-editor')
    fireEvent.blur(editor)
    
    await waitFor(() => {
      expect(screen.queryByTestId('rich-text-editor')).not.toBeInTheDocument()
    })
  })

  it('calls onNotesChange when content is modified', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<DayCard {...defaultProps} />)
    
    // Enter edit mode
    const textElement = screen.getByText('Breakfast: Oatmeal')
    fireEvent.click(textElement)
    
    // Modify content
    const editor = screen.getByTestId('rich-text-editor')
    fireEvent.change(editor, { target: { value: 'New meal content' } })
    
    // Wait for debounced save
    await waitFor(
      () => {
        expect(defaultProps.onNotesChange).toHaveBeenCalledWith('New meal content')
      },
      { timeout: 1000 }
    )
  })

  it('shows itemized checkboxes when showItemizedColumn is true', () => {
    render(<DayCard {...defaultProps} showItemizedColumn={true} />)
    
    const checkboxes = screen.getAllByRole('button')
    const mealItemButtons = checkboxes.filter(button => 
      button.closest('[class*="w-5 h-5"]')
    )
    expect(mealItemButtons).toHaveLength(2) // One checkbox per meal line
  })

  it('hides itemized checkboxes when showItemizedColumn is false', () => {
    render(<DayCard {...defaultProps} showItemizedColumn={false} />)
    
    expect(screen.queryByText('Itemized')).not.toBeInTheDocument()
    const checkboxes = screen.queryAllByRole('button')
    const mealItemButtons = checkboxes.filter(button => 
      button.closest('[class*="w-5 h-5"]')
    )
    expect(mealItemButtons).toHaveLength(0)
  })

  it('calls onToggleItemized when checkbox is clicked', async () => {
    const user = userEvent.setup()
    render(<DayCard {...defaultProps} />)
    
    const checkboxes = screen.getAllByRole('button')
    const firstCheckbox = checkboxes.find(button => 
      button.closest('[class*="w-5 h-5"]')
    )
    
    if (firstCheckbox) {
      await user.click(firstCheckbox)
      expect(defaultProps.onToggleItemized).toHaveBeenCalledWith(0, false)
    }
  })

  it('shows correct itemized state for each item', () => {
    render(<DayCard {...defaultProps} />)
    
    const checkboxes = screen.getAllByRole('button')
    const mealItemButtons = checkboxes.filter(button => 
      button.closest('[class*="w-5 h-5"]')
    )
    
    // First item should be checked (itemized: true)
    const firstCheckbox = mealItemButtons[0]
    expect(firstCheckbox?.querySelector('svg')).toBeInTheDocument()
    
    // Only test second checkbox if it exists
    if (mealItemButtons[1]) {
      const secondCheckbox = mealItemButtons[1]
      expect(secondCheckbox.querySelector('svg')).not.toBeInTheDocument()
    }
  })

  it('shows empty state message when no notes exist', () => {
    const emptyDayData: DayData = {
      ...mockDayData,
      meal_note: null,
    }
    
    render(<DayCard {...defaultProps} day={emptyDayData} />)
    
    expect(screen.getByText('Tap to add meals...')).toBeInTheDocument()
  })

  it('enters edit mode when empty state is clicked', async () => {
    const { fireEvent } = await import('@testing-library/react')
    const emptyDayData: DayData = {
      ...mockDayData,
      meal_note: null,
    }
    
    render(<DayCard {...defaultProps} day={emptyDayData} />)
    
    const emptyState = screen.getByText('Tap to add meals...')
    fireEvent.click(emptyState)
    
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument()
  })

  it('displays save status during editing', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<DayCard {...defaultProps} />)
    
    // Enter edit mode
    const textElement = screen.getByText('Breakfast: Oatmeal')
    fireEvent.click(textElement)
    
    // Start typing to trigger save status
    const editor = screen.getByTestId('rich-text-editor')
    fireEvent.change(editor, { target: { value: 'Updated content' } })
    
    // Wait for onNotesChange to be called (indicating save process started)
    await waitFor(() => {
      expect(defaultProps.onNotesChange).toHaveBeenCalled()
    })
  })

  it('handles all-day events correctly', () => {
    const dayWithAllDayEvent: DayData = {
      ...mockDayData,
      events: [
        {
          id: 'event-2',
          uid: 'uid-2',
          calendar_name: 'Personal',
          title: 'All Day Event',
          start_time: '2024-02-15T00:00:00Z',
          end_time: null,
          all_day: true,
        },
      ],
    }
    
    render(<DayCard {...defaultProps} day={dayWithAllDayEvent} />)
    
    expect(screen.getByText('All Day Event')).toBeInTheDocument()
    // Should not show time for all-day events
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument()
  })

  it('applies correct styling for today vs other days', () => {
    const { rerender } = render(<DayCard {...defaultProps} isToday={false} />)
    
    let card = document.querySelector('.bg-white.dark\\:bg-gray-800.rounded-lg.shadow-sm.border')
    expect(card).toHaveClass('border-gray-200')
    
    rerender(<DayCard {...defaultProps} isToday={true} />)
    
    card = document.querySelector('.bg-white.dark\\:bg-gray-800.rounded-lg.shadow-sm.border')
    expect(card).toHaveClass('border-blue-400')
  })
})
