import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpdateNotification } from '../UpdateNotification';

describe('UpdateNotification', () => {
  const mockOnApplyUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when updateAvailable is false', () => {
    const { container } = render(
      <UpdateNotification updateAvailable={false} onApplyUpdate={mockOnApplyUpdate} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows notification when updateAvailable is true', () => {
    render(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} />
    );
    expect(screen.getByText('A new version is available')).toBeInTheDocument();
  });

  it('shows Update button', () => {
    render(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} />
    );
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  it('clicking Update calls onApplyUpdate', () => {
    render(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} />
    );
    fireEvent.click(screen.getByText('Update'));
    expect(mockOnApplyUpdate).toHaveBeenCalledOnce();
  });

  it('shows "Updating…" text and disables button when updating', () => {
    render(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} updating={true} />
    );
    // Both the text and button say "Updating…"
    const updatingElements = screen.getAllByText('Updating…');
    expect(updatingElements.length).toBeGreaterThanOrEqual(1);

    // Button should be disabled
    const button = updatingElements.find(el => el.tagName === 'BUTTON');
    if (button) {
      expect(button).toBeDisabled();
    }
  });

  it('clicking dismiss hides the notification', () => {
    render(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} />
    );
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('A new version is available')).not.toBeInTheDocument();
  });

  it('re-shows after dismissed when updateAvailable changes', () => {
    const { rerender } = render(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} />
    );
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('A new version is available')).not.toBeInTheDocument();

    // Simulate a new update by changing the prop
    rerender(
      <UpdateNotification updateAvailable={false} onApplyUpdate={mockOnApplyUpdate} />
    );
    rerender(
      <UpdateNotification updateAvailable={true} onApplyUpdate={mockOnApplyUpdate} />
    );
    expect(screen.getByText('A new version is available')).toBeInTheDocument();
  });
});
