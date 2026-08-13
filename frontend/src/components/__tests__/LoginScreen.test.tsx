import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockGetAuthMethods = vi.fn();
const mockLoginWithPassword = vi.fn();

vi.mock('../../api/client', () => ({
  getLoginUrl: () => '/api/auth/login',
  getAuthMethods: (...args: unknown[]) => mockGetAuthMethods(...args),
  loginWithPassword: (...args: unknown[]) => mockLoginWithPassword(...args),
}));

import { LoginScreen } from '../LoginScreen';

describe('LoginScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows only the SSO button when password auth is disabled', async () => {
    mockGetAuthMethods.mockResolvedValue({ oidc: true, oidc_name: 'Authelia', password: false });
    render(<LoginScreen onLoggedIn={vi.fn()} />);

    const link = await screen.findByText('Sign in with Authelia');
    expect(link).toHaveAttribute('href', '/api/auth/login');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows only the password form when OIDC is disabled', async () => {
    mockGetAuthMethods.mockResolvedValue({ oidc: false, oidc_name: 'SSO', password: true });
    render(<LoginScreen onLoggedIn={vi.fn()} />);

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText(/sign in with/i)).not.toBeInTheDocument();
  });

  it('shows both methods with a divider when both are enabled', async () => {
    mockGetAuthMethods.mockResolvedValue({ oidc: true, oidc_name: 'SSO', password: true });
    render(<LoginScreen onLoggedIn={vi.fn()} />);

    expect(await screen.findByText('Sign in with SSO')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText('or')).toBeInTheDocument();
  });

  it('falls back to showing both methods when the methods fetch fails', async () => {
    mockGetAuthMethods.mockRejectedValue(new Error('offline'));
    render(<LoginScreen onLoggedIn={vi.fn()} />);

    expect(await screen.findByText('Sign in with SSO')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('logs in with username/password and reports the user up', async () => {
    mockGetAuthMethods.mockResolvedValue({ oidc: false, oidc_name: 'SSO', password: true });
    const user = { sub: 'canonical-sub', email: 'evan@example.com', name: 'Evan' };
    mockLoginWithPassword.mockResolvedValue(user);
    const onLoggedIn = vi.fn();
    render(<LoginScreen onLoggedIn={onLoggedIn} />);

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'evan@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(mockLoginWithPassword).toHaveBeenCalledWith('evan@example.com', 'hunter2hunter2');
      expect(onLoggedIn).toHaveBeenCalledWith(user);
    });
  });

  it('surfaces the server error on a failed login', async () => {
    mockGetAuthMethods.mockResolvedValue({ oidc: false, oidc_name: 'SSO', password: true });
    mockLoginWithPassword.mockRejectedValue(new Error('Invalid username or password'));
    render(<LoginScreen onLoggedIn={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
  });
});
