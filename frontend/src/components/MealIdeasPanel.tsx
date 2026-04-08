import { FormEvent, useMemo, useState } from 'react';
import { useMealIdeas } from '../hooks/useMealIdeas';
import { useUndo } from '../contexts/UndoContext';

interface MealIdeasPanelProps {
  onSchedule?: (title: string, date: string) => Promise<string> | string;
  onUnschedule?: (date: string, prevNotes: string) => Promise<void> | void;
  compactView?: boolean;
}

export function MealIdeasPanel({ onSchedule, onUnschedule, compactView = false }: MealIdeasPanelProps) {
  const { ideas, addIdea, updateIdea, removeIdea, resolveId, remapId, setEditing } = useMealIdeas();
  const { pushAction } = useUndo();
  const [title, setTitle] = useState('');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('meal-planner-ideas-collapsed') === 'true'; }
    catch { return false; }
  });
  const [scheduleDates, setScheduleDates] = useState<Record<string, string>>({});
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const upcomingDays = useMemo(() => {
    const days: { value: string; label: string }[] = [];
    const start = new Date();
    for (let i = 0; i < 14; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      // Use local date formatting to avoid timezone issues (toISOString uses UTC)
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const value = `${year}-${month}-${day}`;
      const label = date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      days.push({ value, label });
    }
    return days;
  }, []);

  const handleRemoveIdea = (ideaId: string) => {
    const idea = ideas.find(i => i.id === ideaId);
    if (!idea) return;
    const ideaTitle = idea.title;
    const idRef = { id: ideaId };
    removeIdea(ideaId);
    pushAction({
      type: 'remove-idea',
      undo: async () => {
        const prevId = idRef.id;
        const newTempId = addIdea({ title: ideaTitle });
        idRef.id = newTempId;
        // Remap the old ID (that was deleted) so earlier undo entries resolve correctly
        remapId(prevId, newTempId);
      },
      redo: async () => {
        const currentId = resolveId(idRef.id);
        removeIdea(currentId);
      },
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const ideaTitle = title;
    const idRef = { id: addIdea({ title: ideaTitle }) };
    setTitle('');
    pushAction({
      type: 'add-idea',
      undo: async () => {
        const currentId = resolveId(idRef.id);
        removeIdea(currentId);
      },
      redo: async () => {
        const prevId = idRef.id;
        const newTempId = addIdea({ title: ideaTitle });
        idRef.id = newTempId;
        remapId(prevId, newTempId);
      },
    });
  };

  const handleSchedule = async (ideaId: string, ideaTitle: string) => {
    const date = scheduleDates[ideaId];
    if (!date || !onSchedule) return;
    try {
      setSchedulingId(ideaId);
      const prevNotes = await onSchedule(ideaTitle, date);
      const idRef = { id: ideaId };
      removeIdea(ideaId);
      pushAction({
        type: 'schedule-idea',
        undo: async () => {
          const prevId = idRef.id;
          const newTempId = addIdea({ title: ideaTitle });
          idRef.id = newTempId;
          remapId(prevId, newTempId);
          if (onUnschedule) await onUnschedule(date, prevNotes);
        },
        redo: async () => {
          const currentId = resolveId(idRef.id);
          if (onSchedule) await onSchedule(ideaTitle, date);
          removeIdea(currentId);
        },
      });
      setScheduleDates(prev => {
        const next = { ...prev };
        delete next[ideaId];
        return next;
      });
    } finally {
      setSchedulingId(null);
    }
  };

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('meal-planner-ideas-collapsed', String(next)); } catch {}
      return next;
    });
  };

  if (compactView) {
    return (
      <section className="glass rounded-lg">
        <button
          onClick={toggleCollapsed}
          className={`w-full px-3 py-2 flex items-center justify-between ${collapsed ? '' : 'border-b border-gray-200 dark:border-gray-700'}`}
        >
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Future Meals{ideas.length > 0 ? ` (${ideas.length})` : ''}</h2>
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform flex-shrink-0 ${collapsed ? '-rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {!collapsed && <>
        <form onSubmit={handleSubmit} className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex gap-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add meal..."
            className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-white/[0.06] px-2 py-1 text-xs text-gray-900 dark:text-gray-100"
            required
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium px-2 py-1"
          >
            Add
          </button>
        </form>

        <div className="px-3 py-2 space-y-1.5 max-h-40 overflow-y-auto">
          {ideas.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">No future meals yet.</p>
          ) : (
            ideas.map(idea => (
              <div key={idea.id} className="flex items-center gap-1.5 text-xs">
                <input
                  value={idea.title}
                  onChange={(event) => updateIdea(idea.id, { title: event.target.value })}
                  onFocus={() => setEditing(true)}
                  onBlur={() => setEditing(false)}
                  className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-white/[0.06] px-1.5 py-0.5 text-xs text-gray-900 dark:text-gray-100"
                />
                <select
                  value={scheduleDates[idea.id] ?? ''}
                  onChange={(event) => setScheduleDates(prev => ({ ...prev, [idea.id]: event.target.value }))}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-white/[0.06] px-1 py-0.5 text-xs text-gray-900 dark:text-gray-100"
                  aria-label={`Schedule ${idea.title}`}
                >
                  <option value="">Day</option>
                  {upcomingDays.map(day => (
                    <option key={day.value} value={day.value}>{day.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleSchedule(idea.id, idea.title)}
                  disabled={!scheduleDates[idea.id] || !onSchedule || schedulingId === idea.id}
                  className="rounded bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs px-1.5 py-0.5"
                >
                  Go
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveIdea(idea.id)}
                  className="text-red-500 hover:text-red-600 p-0.5"
                  aria-label={`Remove ${idea.title}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
        </>}
      </section>
    );
  }

  return (
    <section className="glass rounded-lg">
      <button
        onClick={toggleCollapsed}
        className={`w-full px-4 py-3 flex items-center justify-between ${collapsed ? '' : 'border-b border-gray-200 dark:border-gray-700'}`}
      >
        <div className="text-left">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Future Meals{ideas.length > 0 ? ` (${ideas.length})` : ''}</h2>
          {!collapsed && <p className="text-sm text-gray-500 dark:text-gray-400">Capture meals you want to schedule later.</p>}
        </div>
        <svg
          className={`h-5 w-5 text-gray-400 transition-transform flex-shrink-0 ${collapsed ? '-rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && <>
      <form onSubmit={handleSubmit} className="px-4 py-4 border-b border-gray-200 dark:border-gray-700 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Meal</label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Salmon Bites"
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-white/[0.06] px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
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
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-white/[0.06] px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <select
                    value={scheduleDates[idea.id] ?? ''}
                    onChange={(event) => setScheduleDates(prev => ({ ...prev, [idea.id]: event.target.value }))}
                    className="rounded-md border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-white/[0.06] px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
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
                  onClick={() => handleRemoveIdea(idea.id)}
                  className="text-sm text-red-500 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      </>}
    </section>
  );
}
