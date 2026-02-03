import { FormEvent, useMemo, useState } from 'react';
import { useMealIdeas } from '../hooks/useMealIdeas';

interface MealIdeasPanelProps {
  onSchedule?: (title: string, date: string) => Promise<void> | void;
}

export function MealIdeasPanel({ onSchedule }: MealIdeasPanelProps) {
  const { ideas, addIdea, updateIdea, removeIdea } = useMealIdeas();
  const [title, setTitle] = useState('');
  const [scheduleDates, setScheduleDates] = useState<Record<string, string>>({});
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const upcomingDays = useMemo(() => {
    const days: { value: string; label: string }[] = [];
    const start = new Date();
    for (let i = 0; i < 14; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const value = date.toISOString().split('T')[0];
      const label = date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      days.push({ value, label });
    }
    return days;
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    addIdea({ title });
    setTitle('');
  };

  const handleSchedule = async (ideaId: string, ideaTitle: string) => {
    const date = scheduleDates[ideaId];
    if (!date || !onSchedule) return;
    try {
      setSchedulingId(ideaId);
      await onSchedule(ideaTitle, date);
      removeIdea(ideaId);
      setScheduleDates(prev => {
        const next = { ...prev };
        delete next[ideaId];
        return next;
      });
    } finally {
      setSchedulingId(null);
    }
  };

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Future Meals</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">Capture meals you want to schedule later.</p>
      </div>

      <form onSubmit={handleSubmit} className="px-4 py-4 border-b border-gray-200 dark:border-gray-700 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Meal</label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Salmon Bites"
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            required
          />
        </div>
        <button
          type="submit"
          className="w-full sm:w-auto rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2"
        >
          Add
        </button>
      </form>

      <div className="px-4 py-4 space-y-3">
        {ideas.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No future meals yet.</p>
        ) : (
          ideas.map(idea => (
            <div key={idea.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-2">
              <input
                value={idea.title}
                onChange={(event) => updateIdea(idea.id, { title: event.target.value })}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <select
                    value={scheduleDates[idea.id] ?? ''}
                    onChange={(event) => setScheduleDates(prev => ({ ...prev, [idea.id]: event.target.value }))}
                    className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                    aria-label={`Schedule ${idea.title}`}
                  >
                    <option value="">Select a day</option>
                    {upcomingDays.map(day => (
                      <option key={day.value} value={day.value}>{day.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleSchedule(idea.id, idea.title)}
                    disabled={!scheduleDates[idea.id] || !onSchedule || schedulingId === idea.id}
                    className="rounded-md bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-1.5"
                  >
                    {schedulingId === idea.id ? 'Scheduling...' : 'Schedule'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => removeIdea(idea.id)}
                  className="text-sm text-red-500 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
