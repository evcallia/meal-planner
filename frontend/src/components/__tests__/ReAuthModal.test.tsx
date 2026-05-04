import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  getLoginUrl: () => '/api/auth/login',
}));

import { ReAuthModal } from '../ReAuthModal';

describe('ReAuthModal', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('renders the title and body copy', () => {
    render(<ReAuthModal pendingCount={0} />);
    expect(screen.getByText(/sign in to keep using meal planner/i)).toBeInTheDocument();
    expect(screen.getByText(/your session has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/your unsaved changes are saved on this device/i)).toBeInTheDocument();
  });

  it('does not show the pending-count line when count is 0', () => {
    render(<ReAuthModal pendingCount={0} />);
    expect(screen.queryByText(/changes waiting to sync/i)).not.toBeInTheDocument();
  });

  it('shows the pending-count line when count > 0', () => {
    render(<ReAuthModal pendingCount={3} />);
    expect(screen.getByText(/3 changes waiting to sync/i)).toBeInTheDocument();
  });

  it('navigates to the login URL when Sign in is clicked', () => {
    render(<ReAuthModal pendingCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(window.location.href).toBe('/api/auth/login');
  });
});
