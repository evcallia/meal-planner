import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MealIdeasPanel } from '../MealIdeasPanel';
import { useMealIdeas } from '../../hooks/useMealIdeas';

vi.mock('../../hooks/useMealIdeas', () => ({
  useMealIdeas: vi.fn(),
}));

describe('MealIdeasPanel', () => {
  const mockUseMealIdeas = vi.mocked(useMealIdeas);
  const addIdea = vi.fn();
  const updateIdea = vi.fn();
  const removeIdea = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMealIdeas.mockReturnValue({
      ideas: [],
      addIdea,
      updateIdea,
      removeIdea,
    });
  });

  it('renders empty state and adds idea in full view', async () => {
    const user = userEvent.setup();
    render(<MealIdeasPanel />);

    expect(screen.getByText('Future Meals')).toBeInTheDocument();
    expect(screen.getByText('No future meals yet.')).toBeInTheDocument();

    await act(async () => {
      await user.type(screen.getByPlaceholderText('e.g. Salmon Bites'), 'Salmon Bites');
      await user.click(screen.getByRole('button', { name: 'Add' }));
    });

    expect(addIdea).toHaveBeenCalledWith({ title: 'Salmon Bites' });
  });

  it('updates and removes ideas in compact view', () => {
    mockUseMealIdeas.mockReturnValue({
      ideas: [
        { id: '1', title: 'Tacos', updated_at: '2026-01-01T00:00:00Z' },
      ],
      addIdea,
      updateIdea,
      removeIdea,
    });

    render(<MealIdeasPanel compactView />);

    const input = screen.getByDisplayValue('Tacos');
    fireEvent.change(input, { target: { value: 'Fish Tacos' } });
    expect(updateIdea).toHaveBeenCalledWith('1', { title: 'Fish Tacos' });

    fireEvent.click(screen.getByLabelText('Remove Tacos'));
    expect(removeIdea).toHaveBeenCalledWith('1');
  });

  it('schedules a meal idea when a date is selected', async () => {
    mockUseMealIdeas.mockReturnValue({
      ideas: [
        { id: '1', title: 'Chili', updated_at: '2026-01-01T00:00:00Z' },
      ],
      addIdea,
      updateIdea,
      removeIdea,
    });

    const onSchedule = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();

    render(<MealIdeasPanel onSchedule={onSchedule} />);

    const select = screen.getByLabelText('Schedule Chili');
    const option = select.querySelectorAll('option')[1];
    act(() => {
      fireEvent.change(select, { target: { value: option.value } });
    });

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
    });

    await waitFor(() => {
      expect(onSchedule).toHaveBeenCalledWith('Chili', option.value);
    });
    expect(removeIdea).toHaveBeenCalledWith('1');
  });

  it('disables schedule button when no handler provided', () => {
    mockUseMealIdeas.mockReturnValue({
      ideas: [
        { id: '1', title: 'Pasta', updated_at: '2026-01-01T00:00:00Z' },
      ],
      addIdea,
      updateIdea,
      removeIdea,
    });

    render(<MealIdeasPanel />);

    const button = screen.getByRole('button', { name: 'Schedule' });
    expect(button).toBeDisabled();
  });
});
