import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MealItem } from '../MealItem'

describe('MealItem', () => {
  const defaultProps = {
    html: 'Test meal item',
    itemized: false,
    onToggle: vi.fn(),
    onTextClick: vi.fn(),
    showHeader: false,
    showItemizedColumn: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders meal item with text content', () => {
    render(<MealItem {...defaultProps} />)
    
    expect(screen.getByText('Test meal item')).toBeInTheDocument()
  })

  it('renders itemized column when showItemizedColumn is true', () => {
    render(<MealItem {...defaultProps} showHeader={true} />)
    
    expect(screen.getByText('Itemized')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('does not render itemized column when showItemizedColumn is false', () => {
    render(<MealItem {...defaultProps} showItemizedColumn={false} />)
    
    expect(screen.queryByText('Itemized')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows header only when showHeader is true', () => {
    render(<MealItem {...defaultProps} showHeader={true} />)
    
    expect(screen.getByText('Itemized')).toBeInTheDocument()
  })

  it('does not show header when showHeader is false', () => {
    render(<MealItem {...defaultProps} showHeader={false} />)
    
    expect(screen.queryByText('Itemized')).not.toBeInTheDocument()
  })

  it('displays checked checkbox when itemized is true', () => {
    render(<MealItem {...defaultProps} itemized={true} />)
    
    const checkbox = screen.getByRole('button')
    const checkIcon = checkbox.querySelector('svg')
    expect(checkIcon).toBeInTheDocument()
  })

  it('displays unchecked checkbox when itemized is false', () => {
    render(<MealItem {...defaultProps} itemized={false} />)
    
    const checkbox = screen.getByRole('button')
    const checkIcon = checkbox.querySelector('svg')
    expect(checkIcon).not.toBeInTheDocument()
  })

  it('calls onToggle when checkbox is clicked', async () => {
    const user = userEvent.setup()
    render(<MealItem {...defaultProps} />)
    
    const checkbox = screen.getByRole('button')
    await user.click(checkbox)
    
    expect(defaultProps.onToggle).toHaveBeenCalled()
  })

  it('calls onTextClick when text is clicked', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<MealItem {...defaultProps} />)
    
    const textElement = screen.getByText('Test meal item')
    fireEvent.click(textElement)
    
    expect(defaultProps.onTextClick).toHaveBeenCalled()
  })

  it('prevents event propagation when checkbox is clicked', async () => {
    const user = userEvent.setup()
    const mockParentClick = vi.fn()
    
    render(
      <div onClick={mockParentClick}>
        <MealItem {...defaultProps} />
      </div>
    )
    
    const checkbox = screen.getByRole('button')
    await user.click(checkbox)
    
    expect(defaultProps.onToggle).toHaveBeenCalled()
    expect(mockParentClick).not.toHaveBeenCalled()
  })

  it('renders HTML content safely', () => {
    const htmlContent = 'Visit <a href="https://example.com">Example</a>'
    render(<MealItem {...defaultProps} html={htmlContent} />)
    
    const link = screen.getByRole('link', { name: 'Example' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  it('applies auto-linking to URLs in text', () => {
    const htmlContent = 'Check https://example.com'
    render(<MealItem {...defaultProps} html={htmlContent} />)
    
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('handles empty HTML content', () => {
    render(<MealItem {...defaultProps} html="" />)
    
    // Should still render the structure
    const container = screen.getByRole('button').closest('div')
    expect(container).toBeInTheDocument()
  })

  it('applies correct CSS classes for layout with itemized column', () => {
    render(<MealItem {...defaultProps} showItemizedColumn={true} />)
    
    const container = screen.getByRole('button').closest('.flex.items-start.py-1\\.5.gap-3') ||
                     document.querySelector('.flex.items-start.gap-3')
    expect(container).toBeTruthy()
  })

  it('applies correct CSS classes for layout without itemized column', () => {
    const { container } = render(<MealItem {...defaultProps} showItemizedColumn={false} />)
    
    const mainDiv = container.firstChild
    expect(mainDiv).not.toHaveClass('gap-3')
  })

  it('applies margin-top to text when header is shown and itemized column is visible', () => {
    render(<MealItem {...defaultProps} showHeader={true} showItemizedColumn={true} />)
    
    const textElement = screen.getByText('Test meal item')
    expect(textElement).toHaveClass('mt-4')
  })

  it('does not apply margin-top to text when header is not shown', () => {
    render(<MealItem {...defaultProps} showHeader={false} showItemizedColumn={true} />)
    
    const textElement = screen.getByText('Test meal item')
    expect(textElement).not.toHaveClass('mt-4')
  })

  it('does not apply margin-top to text when itemized column is hidden', () => {
    render(<MealItem {...defaultProps} showHeader={true} showItemizedColumn={false} />)
    
    const textElement = screen.getByText('Test meal item')
    expect(textElement).not.toHaveClass('mt-4')
  })
})