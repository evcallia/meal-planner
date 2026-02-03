import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsModal } from '../SettingsModal'
import type { Settings } from '../../hooks/useSettings'

describe('SettingsModal', () => {
  const defaultSettings: Settings = {
    showItemizedColumn: true,
    showPantry: true,
    showMealIdeas: true,
  }

  const defaultProps = {
    settings: defaultSettings,
    onUpdate: vi.fn(),
    onClose: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the modal with correct title', () => {
    render(<SettingsModal {...defaultProps} />)
    
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('displays the current setting state correctly', () => {
    render(<SettingsModal {...defaultProps} />)
    
    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })
    expect(ideasToggle).toHaveAttribute('aria-checked', 'true')

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })
    expect(pantryToggle).toHaveAttribute('aria-checked', 'true')

    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('displays unchecked state when setting is false', () => {
    const settings: Settings = {
      showItemizedColumn: false,
      showPantry: false,
      showMealIdeas: false,
    }
    
    render(<SettingsModal {...defaultProps} settings={settings} />)
    
    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })
    expect(ideasToggle).toHaveAttribute('aria-checked', 'false')

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })
    expect(pantryToggle).toHaveAttribute('aria-checked', 'false')

    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('calls onUpdate when checkbox is toggled', async () => {
    const user = userEvent.setup()
    render(<SettingsModal {...defaultProps} />)
    
    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    
    await user.click(toggle)
    
    expect(defaultProps.onUpdate).toHaveBeenCalledWith({
      showItemizedColumn: false,
    })
  })

  it('updates pantry visibility when toggled', async () => {
    const user = userEvent.setup()
    render(<SettingsModal {...defaultProps} />)

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })

    await user.click(pantryToggle)

    expect(defaultProps.onUpdate).toHaveBeenCalledWith({
      showPantry: false,
    })
  })

  it('updates future meals visibility when toggled', async () => {
    const user = userEvent.setup()
    render(<SettingsModal {...defaultProps} />)

    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })

    await user.click(ideasToggle)

    expect(defaultProps.onUpdate).toHaveBeenCalledWith({
      showMealIdeas: false,
    })
  })

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsModal {...defaultProps} />)
    
    const closeButton = screen.getByRole('button', { name: '' }) // The X button has no text
    
    await user.click(closeButton)
    
    expect(defaultProps.onClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking outside the modal', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<SettingsModal {...defaultProps} />)
    
    // Click on the backdrop (the overlay)
    const backdrop = screen.getByText('Settings').closest('[class*="fixed inset-0"]')
    expect(backdrop).toBeInTheDocument()
    
    fireEvent.click(backdrop!)
    
    expect(defaultProps.onClose).toHaveBeenCalled()
  })

  it('does not close when clicking inside the modal content', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<SettingsModal {...defaultProps} />)
    
    const modalContent = screen.getByText('Settings').closest('[class*="bg-white"]')
    expect(modalContent).toBeInTheDocument()
    
    fireEvent.click(modalContent!)
    
    expect(defaultProps.onClose).not.toHaveBeenCalled()
  })

  it('has proper accessibility attributes', () => {
    render(<SettingsModal {...defaultProps} />)
    
    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })
    expect(ideasToggle).toHaveAttribute('aria-checked', 'true')

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })
    expect(pantryToggle).toHaveAttribute('aria-checked', 'true')

    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    
    const closeButton = screen.getByRole('button', { name: '' }) // Empty name for X button
    expect(closeButton).toBeInTheDocument()
  })

  it('shows correct description for itemized column setting', () => {
    render(<SettingsModal {...defaultProps} />)
    
    expect(screen.getByText('Show checkboxes to mark meals as added to shopping list')).toBeInTheDocument()
  })

  it('handles keyboard navigation', () => {
    render(<SettingsModal {...defaultProps} />)
    
    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    const closeButton = screen.getByRole('button', { name: '' }) // Empty name for X button
    
    // Both elements should be focusable
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    
    closeButton.focus()
    expect(document.activeElement).toBe(closeButton)
  })
})
