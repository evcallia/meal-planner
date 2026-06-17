import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTracker, computeStats } from '../hooks/useTracker';
import { useUndo } from '../contexts/UndoContext';
import { TrackerList, TrackerTask, TrackerLog, DirectoryUser, UserInfo } from '../types';
import { getTrackerLogs, getUsers } from '../api/client';
import { isTempId } from '../db';
import { recency, RECENCY_CLASSES, formatAgo, formatTarget, parseServerDate, progressPercent, inSeason, seasonLabel, computeStreak, MONTH_ABBR } from '../utils/recency';
import { getEditHighlight } from '../utils/editHighlightColors';

const firstName = (name: string | null | undefined): string | null => (name ? name.split(' ')[0] : null);
const preventDefaultTouch = (e: TouchEvent) => e.preventDefault();
// Recency baseline tracks the latest event of any kind, so a skip resets color/sort too.
const taskRecency = (t: TrackerTask) => recency(t.last_event_at ?? t.last_done_at, t.target_interval_days);

const LIST_COLORS: { name: string; bar: string }[] = [
  { name: 'blue', bar: 'bg-blue-500' },
  { name: 'emerald', bar: 'bg-emerald-500' },
  { name: 'amber', bar: 'bg-amber-500' },
  { name: 'rose', bar: 'bg-rose-500' },
  { name: 'violet', bar: 'bg-violet-500' },
  { name: 'slate', bar: 'bg-slate-500' },
];

function colorBar(color: string | null): string {
  return LIST_COLORS.find(c => c.name === color)?.bar ?? 'bg-blue-500';
}

const ACTIVE_KEY = 'meal-planner-lists-active';

function dueCount(list: TrackerList): number {
  return list.tasks.filter(t => {
    if (!inSeason(t.season_start_month, t.season_start_day, t.season_end_month, t.season_end_day)) return false;
    const r = taskRecency(t);
    return r.level === 'due' || r.level === 'over';
  }).length;
}

interface ListsViewProps {
  user: UserInfo;
  editHighlightColor?: string;
}

export function ListsView({ user, editHighlightColor = 'emerald' }: ListsViewProps) {
  const tracker = useTracker();
  const { lists, loading, createList } = tracker;

  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [newListColor, setNewListColor] = useState<string>(LIST_COLORS[0].name);
  const [detail, setDetail] = useState<{ listId: string; taskId: string } | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dir, setDir] = useState<'left' | 'right'>('right');
  const restoredRef = useRef(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  // Drag-to-reorder lists (pointer-based; long-press to pick up a tab).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const draggingRef = useRef(false);
  const justDraggedRef = useRef(false);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastXRef = useRef(0);
  const lastYRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Re-render every minute so relative times / colors stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  // One-time restore of the last-viewed list once lists load.
  useEffect(() => {
    if (restoredRef.current || lists.length === 0) return;
    restoredRef.current = true;
    const saved = localStorage.getItem(ACTIVE_KEY);
    const i = saved ? lists.findIndex(l => l.id === saved) : -1;
    if (i >= 0) setActiveIndex(i);
  }, [lists]);

  // Clamp when the list count shrinks (e.g. a list was deleted).
  useEffect(() => {
    if (activeIndex > Math.max(0, lists.length - 1)) setActiveIndex(Math.max(0, lists.length - 1));
  }, [lists.length, activeIndex]);

  // Persist the active list id for restore across reloads.
  useEffect(() => {
    const l = lists[activeIndex];
    if (l) { try { localStorage.setItem(ACTIVE_KEY, l.id); } catch { /* ignore */ } }
  }, [activeIndex, lists]);

  const activeList = lists[activeIndex] ?? null;

  const goTo = (i: number) => { setDir(i >= activeIndex ? 'right' : 'left'); setActiveIndex(i); setNewListOpen(false); };
  const cycle = (delta: number) => {
    if (lists.length < 2) return;
    const n = lists.length;
    setDir(delta > 0 ? 'right' : 'left');
    setActiveIndex((activeIndex + delta + n) % n);
  };

  // ----- drag-to-reorder list tabs -----
  const hitTest = (x: number, y: number) => {
    const id = dragIdRef.current;
    const cur = dragOrderRef.current;
    if (!id || !cur) return;
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-tab-id]');
    const overId = el?.getAttribute('data-tab-id');
    if (!overId || overId === id) return;
    const from = cur.indexOf(id), to = cur.indexOf(overId);
    if (from < 0 || to < 0) return;
    const next = [...cur];
    next.splice(to, 0, next.splice(from, 1)[0]);
    dragOrderRef.current = next;
    setDragOrder(next);
  };
  const onDragMove = (e: PointerEvent) => {
    lastXRef.current = e.clientX;
    lastYRef.current = e.clientY;
    hitTest(e.clientX, e.clientY);
  };
  // Auto-scroll the strip when the dragged tab nears an edge, so you can keep
  // dragging all the way to the end even when tabs overflow.
  const autoScroll = () => {
    const strip = tabStripRef.current;
    if (strip && dragIdRef.current) {
      const rect = strip.getBoundingClientRect();
      const EDGE = 56, SPEED = 12;
      const x = lastXRef.current;
      if (x > rect.right - EDGE && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1) {
        strip.scrollLeft += SPEED; hitTest(x, lastYRef.current);
      } else if (x < rect.left + EDGE && strip.scrollLeft > 0) {
        strip.scrollLeft -= SPEED; hitTest(x, lastYRef.current);
      }
    }
    rafRef.current = requestAnimationFrame(autoScroll);
  };
  const endDrag = () => {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('touchmove', preventDefaultTouch);
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const order = dragOrderRef.current;
    dragIdRef.current = null; dragOrderRef.current = null; draggingRef.current = false;
    setDragId(null); setDragOrder(null);
    justDraggedRef.current = true;
    setTimeout(() => { justDraggedRef.current = false; }, 60);
    if (order && order.some((x, i) => x !== lists[i]?.id)) {
      // Keep showing the list we were viewing, not whatever slid into its slot.
      const activeId = lists[activeIndex]?.id;
      tracker.reorderLists(order);
      const newIdx = activeId ? order.indexOf(activeId) : -1;
      if (newIdx >= 0) setActiveIndex(newIdx);
    }
  };
  const beginDrag = (id: string) => {
    draggingRef.current = true;
    dragIdRef.current = id;
    const order = lists.map(l => l.id);
    dragOrderRef.current = order;
    setDragId(id);
    setDragOrder(order);
    const rect = tabStripRef.current?.getBoundingClientRect();
    if (rect) { lastXRef.current = (rect.left + rect.right) / 2; lastYRef.current = (rect.top + rect.bottom) / 2; }
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('touchmove', preventDefaultTouch, { passive: false });
    rafRef.current = requestAnimationFrame(autoScroll);
  };
  const onTabPointerDown = (e: React.PointerEvent, id: string) => {
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => beginDrag(id), 250);
  };
  const onTabPointerMove = (e: React.PointerEvent) => {
    if (draggingRef.current) return;
    const s = pressStartRef.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 && pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };
  const onTabPointerUp = () => {
    if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
  };

  // Swipe anywhere on the Lists page to cycle (lastGLANCE-style). Listening at
  // the window level makes the whole page swipeable, not just the list card.
  const tabStripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      // Don't cycle while a modal/form is open, or when the gesture starts on
      // the tab strip (it scrolls horizontally on its own).
      if (detail || shareFor || newListOpen || tabStripRef.current?.contains(e.target as Node)) { start = null; return; }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
    };
    const onEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      // Horizontal intent only — don't hijack vertical scrolling.
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) cycle(dx < 0 ? 1 : -1);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [activeIndex, lists.length, detail, shareFor, newListOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Desktop: arrow keys cycle lists (ignored while typing or in a modal).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (detail || shareFor || newListOpen) return;
      if (e.key === 'ArrowRight') cycle(1);
      else if (e.key === 'ArrowLeft') cycle(-1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [activeIndex, lists.length, detail, shareFor, newListOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active tab scrolled into view when cycling (swipe/arrows/dots).
  useEffect(() => {
    const l = lists[activeIndex];
    if (!l || !tabStripRef.current) return;
    const el = tabStripRef.current.querySelector(`[data-tab-id="${l.id}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [activeIndex, lists]);

  const handleCreateList = () => {
    const name = newListName.trim();
    if (!name) return;
    createList(name, null, newListColor);
    setNewListName('');
    setNewListColor(LIST_COLORS[0].name);
    setNewListOpen(false);
    setDir('right');
    setActiveIndex(lists.length); // newly created list is appended at the end
  };

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const res: { list: TrackerList; task: TrackerTask }[] = [];
    for (const l of lists) for (const t of l.tasks) if (t.name.toLowerCase().includes(q)) res.push({ list: l, task: t });
    res.sort((a, b) => taskRecency(b.task).urgency - taskRecency(a.task).urgency);
    return res;
  }, [search, lists]);

  const detailList = useMemo(() => (detail ? lists.find(l => l.id === detail.listId) ?? null : null), [detail, lists]);
  const detailTask = useMemo(() => {
    if (!detail) return null;
    const list = lists.find(l => l.id === detail.listId);
    return list?.tasks.find(t => t.id === detail.taskId) ?? null;
  }, [detail, lists]);

  const shareListObj = useMemo(() => lists.find(l => l.id === shareFor) ?? null, [shareFor, lists]);

  return (
    <div className="edit-accent-scope" style={{ '--edit-accent': getEditHighlight(editHighlightColor).accent } as React.CSSProperties}>
      {/* Tab strip */}
      {lists.length > 0 && (
        <div className="sticky z-[9] glass rounded-2xl mt-4 mb-3 p-2" style={{ top: 'calc(var(--header-h, 48px) + 24px)' }}>
          <div className="flex items-center gap-1.5">
            <div ref={tabStripRef} className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0">
              {(dragOrder ? (dragOrder.map(id => lists.find(l => l.id === id)).filter(Boolean) as TrackerList[]) : lists).map((l) => {
                const i = lists.indexOf(l);
                const due = dueCount(l);
                const act = i === activeIndex && !newListOpen && !searchResults;
                return (
                  <div key={l.id} className="flex flex-col items-stretch shrink-0">
                    <button
                      data-tab-id={l.id}
                      onPointerDown={e => onTabPointerDown(e, l.id)}
                      onPointerMove={onTabPointerMove}
                      onPointerUp={onTabPointerUp}
                      onClick={() => { if (!justDraggedRef.current) goTo(i); }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors select-none ${dragId === l.id ? 'opacity-60 scale-105 ring-2 ring-blue-400' : ''} ${act ? 'bg-blue-500 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}
                    >
                      <span className="max-w-[10rem] truncate pointer-events-none">{l.name}</span>
                      {due > 0 && (
                        <span className={`min-w-[16px] h-4 px-1 inline-flex items-center justify-center text-[10px] font-bold rounded-full pointer-events-none ${act ? 'bg-white/25 text-white' : 'bg-red-500 text-white'}`}>{due}</span>
                      )}
                    </button>
                    <div className={`h-1 mt-1 mx-2 rounded-full ${colorBar(l.color)} ${act ? '' : 'opacity-40'}`} />
                  </div>
                );
              })}
            </div>
            {/* Pinned outside the scroll area so they're always reachable */}
            <button
              onClick={() => { setSearchOpen(o => { const next = !o; if (!next) setSearch(''); return next; }); }}
              className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors ${searchOpen ? 'bg-blue-500 text-white' : 'text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}
              aria-label="Search tasks"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
            </button>
            <button
              onClick={() => setNewListOpen(true)}
              className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors ${newListOpen ? 'bg-blue-500 text-white' : 'text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}
              aria-label="New list"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
          {searchOpen && (
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tasks across all lists…"
              className="mt-2 w-full px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm"
            />
          )}
        </div>
      )}

      {loading && lists.length === 0 && (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-blue-500" /></div>
      )}

      {!loading && lists.length === 0 && !newListOpen && (
        <div className="glass rounded-2xl p-8 text-center mt-4">
          <p className="text-gray-600 dark:text-gray-300 font-medium mb-1">No lists yet</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Create a list to track when you last did things — and share it with your household.</p>
          <button onClick={() => setNewListOpen(true)} className="px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600">New list</button>
        </div>
      )}

      {/* New list form */}
      {newListOpen && (
        <div className="glass rounded-2xl p-4 mt-1 space-y-3">
          <input
            autoFocus
            value={newListName}
            onChange={e => setNewListName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateList(); if (e.key === 'Escape') setNewListOpen(false); }}
            placeholder="List name (e.g. House upkeep)"
            className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none"
          />
          <div className="flex items-center gap-2">
            {LIST_COLORS.map(c => (
              <button key={c.name} onClick={() => setNewListColor(c.name)} aria-label={c.name}
                className={`w-7 h-7 rounded-full ${c.bar} transition-transform ${newListColor === c.name ? 'ring-2 ring-offset-2 ring-gray-400 dark:ring-offset-gray-900 scale-110' : ''}`} />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewListOpen(false)} className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Cancel</button>
            <button onClick={handleCreateList} disabled={!newListName.trim()} className="px-4 py-1.5 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-40">Create</button>
          </div>
        </div>
      )}

      {/* Search results across all lists */}
      {!newListOpen && searchResults && (
        <div className="space-y-3">
          {searchResults.length === 0 ? (
            <div className="glass rounded-2xl p-6 text-center text-sm text-gray-400">No tasks match "{search.trim()}".</div>
          ) : (
            <div className="glass rounded-2xl p-3 space-y-1.5">
              {searchResults.map(({ list, task }) => (
                <div key={task.id}>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400 px-1">{list.name}</div>
                  <TaskRow listId={list.id} task={task} tracker={tracker} onOpen={() => setDetail({ listId: list.id, taskId: task.id })} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Active list (swipe anywhere to cycle) */}
      {!newListOpen && !searchResults && activeList && (
        <div>
          <div key={activeIndex} className={dir === 'right' ? 'lists-slide-right' : 'lists-slide-left'}>
            <ListPanel
              list={activeList}
              tracker={tracker}
              onOpenTask={(taskId) => setDetail({ listId: activeList.id, taskId })}
              onShare={() => setShareFor(activeList.id)}
            />
          </div>
          {lists.length > 1 && (
            <div className="flex justify-center gap-1.5 mt-3">
              {lists.map((l, i) => (
                <button key={l.id} onClick={() => goTo(i)} aria-label={`Go to ${l.name}`}
                  className={`h-1.5 rounded-full transition-all ${i === activeIndex ? 'w-5 bg-blue-500' : 'w-1.5 bg-gray-300 dark:bg-gray-600'}`} />
              ))}
            </div>
          )}
        </div>
      )}

      {detail && detailTask && detailList && (
        <TaskDetailModal
          list={detailList}
          task={detailTask}
          tracker={tracker}
          user={user}
          onClose={() => setDetail(null)}
        />
      )}

      {shareListObj && shareListObj.is_owner && (
        <ShareModal list={shareListObj} tracker={tracker} onClose={() => setShareFor(null)} />
      )}
    </div>
  );
}

// ----- Active list panel -----

function ListPanel({ list, tracker, onOpenTask, onShare }: {
  list: TrackerList;
  tracker: ReturnType<typeof useTracker>;
  onOpenTask: (taskId: string) => void;
  onShare: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(list.name);
  const [addOpen, setAddOpen] = useState(false);
  const [taskName, setTaskName] = useState('');
  const [taskTarget, setTaskTarget] = useState('');
  const [showOut, setShowOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const sortedTasks = useMemo(() => {
    return [...list.tasks].map(t => ({ t, r: taskRecency(t) }))
      .sort((a, b) => (b.r.urgency - a.r.urgency) || (a.t.position - b.t.position))
      .map(x => x.t);
  }, [list.tasks]);

  const visibleTasks = useMemo(() => sortedTasks.filter(t => inSeason(t.season_start_month, t.season_start_day, t.season_end_month, t.season_end_day)), [sortedTasks]);
  const outOfSeasonTasks = useMemo(() => sortedTasks.filter(t => !inSeason(t.season_start_month, t.season_start_day, t.season_end_month, t.season_end_day)), [sortedTasks]);

  const handleAddTask = () => {
    const name = taskName.trim();
    if (!name) return;
    const target = taskTarget.trim() ? Math.max(1, Math.round(Number(taskTarget))) : null;
    tracker.createTask(list.id, name, Number.isFinite(target as number) ? target : null);
    setTaskName('');
    setTaskTarget('');
  };

  const commitRename = () => {
    const v = renameValue.trim();
    if (v && v !== list.name) tracker.updateList(list.id, { name: v });
    setRenaming(false);
  };

  return (
    <div className="glass rounded-2xl p-3">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-3 h-3 shrink-0 rounded-full ${colorBar(list.color)}`} />
        {renaming ? (
          <input
            autoFocus value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
            className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-lg font-bold"
          />
        ) : (
          <h2 className="flex-1 min-w-0 text-lg font-bold text-gray-900 dark:text-gray-100 truncate">
            {list.name}
            {!list.is_owner && <span className="ml-2 text-[10px] align-middle uppercase tracking-wide text-blue-500 dark:text-blue-400">shared</span>}
          </h2>
        )}

        {list.is_owner && (
          <button onClick={onShare} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg" aria-label="Share list">
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
          </button>
        )}
        {list.shared_with.length > 0 && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500" title={list.shared_with.map(u => u.name || u.email || u.sub).join(', ')}>
            {list.shared_with.length}👤
          </span>
        )}

        <div className="relative" ref={menuRef}>
          <button onClick={() => setMenuOpen(v => !v)} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg" aria-label="List menu">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" /></svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-9 z-20 glass-menu rounded-xl py-1 w-44 shadow-lg">
              <button onClick={() => { setMenuOpen(false); setAddOpen(true); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700">Add task</button>
              <button onClick={() => { setMenuOpen(false); setRenameValue(list.name); setRenaming(true); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700">Rename list</button>
              {list.is_owner && (
                <button onClick={() => { setMenuOpen(false); tracker.deleteList(list.id); }} className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">Delete list</button>
              )}
            </div>
          )}
        </div>
      </div>

      {list.tasks.length === 0 && !addOpen && (
        <button onClick={() => setAddOpen(true)} className="w-full text-sm text-gray-400 dark:text-gray-500 py-3 hover:text-gray-600 dark:hover:text-gray-300">+ Add the first task</button>
      )}

      <div className="space-y-1.5">
        {visibleTasks.map(task => (
          <TaskRow key={task.id} listId={list.id} task={task} tracker={tracker} onOpen={() => onOpenTask(task.id)} />
        ))}
      </div>

      {outOfSeasonTasks.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowOut(v => !v)} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-1">
            <span className={`transition-transform ${showOut ? 'rotate-90' : ''}`}>›</span>
            Out of season ({outOfSeasonTasks.length})
          </button>
          {showOut && (
            <div className="space-y-1.5 mt-1.5">
              {outOfSeasonTasks.map(task => (
                <TaskRow key={task.id} listId={list.id} task={task} tracker={tracker} onOpen={() => onOpenTask(task.id)} dimmed />
              ))}
            </div>
          )}
        </div>
      )}

      {addOpen ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus value={taskName}
            onChange={e => setTaskName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddTask(); if (e.key === 'Escape') setAddOpen(false); }}
            onFocus={e => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); }}
            placeholder="Task name"
            className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm"
          />
          <div className="flex items-center gap-1 shrink-0">
            <input
              value={taskTarget}
              onChange={e => setTaskTarget(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter') handleAddTask(); }}
              onFocus={e => { e.currentTarget.placeholder = ''; }}
              onBlur={e => { e.currentTarget.placeholder = '—'; }}
              placeholder="—"
              inputMode="numeric"
              className="w-12 px-2 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm text-center"
              title="Target interval in days (optional)"
            />
            <span className="text-xs text-gray-400">days</span>
          </div>
          <button onClick={handleAddTask} disabled={!taskName.trim()} className="px-3 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-40 shrink-0">Add</button>
        </div>
      ) : list.tasks.length > 0 && (
        <button onClick={() => setAddOpen(true)} className="mt-2 text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600">+ Add task</button>
      )}
    </div>
  );
}

// ----- Task row -----

function TaskRow({ listId, task, tracker, onOpen, dimmed }: {
  listId: string;
  task: TrackerTask;
  tracker: ReturnType<typeof useTracker>;
  onOpen: () => void;
  dimmed?: boolean;
}) {
  const r = taskRecency(task);
  const cls = RECENCY_CLASSES[r.level];
  const target = formatTarget(task.target_interval_days);
  const season = seasonLabel(task.season_start_month, task.season_start_day, task.season_end_month, task.season_end_day);
  const pct = progressPercent(r);
  const by = firstName(task.last_done_by);
  const hasNote = !!(task.last_note || task.notes);
  const [justDone, setJustDone] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flash, setFlash] = useState<'done' | 'skip' | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const longPressRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashDone = () => { setJustDone(true); setTimeout(() => setJustDone(false), 900); };
  // Highlight the row (which re-sorts on done/skip) so you can spot where it moved.
  const triggerFlash = (kind: 'done' | 'skip') => { setFlash(kind); setFlashKey(k => k + 1); };
  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1300);
    return () => clearTimeout(t);
  }, [flash, flashKey]);

  const onPointerDown = () => {
    longPressRef.current = false;
    timerRef.current = setTimeout(() => { longPressRef.current = true; setMenuOpen(true); }, 500);
  };
  const onPointerUp = () => {
    clearTimer();
    if (!longPressRef.current) { tracker.markDone(listId, task.id); flashDone(); triggerFlash('done'); }
  };

  // The whole row is a progress bar: a tinted fill grows left→right with
  // elapsed/target, a solid colored bar marks the left edge (recency level).
  return (
    <div
      onClick={() => { if (!menuOpen) onOpen(); }}
      className={`relative overflow-hidden rounded-xl cursor-pointer bg-gray-50 dark:bg-gray-800/40 ${dimmed ? 'opacity-60' : ''}`}
    >
      <div className={`absolute inset-y-0 left-0 ${cls.fill} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      <div className={`absolute inset-y-0 left-0 w-1.5 ${cls.bar}`} />
      {flash && <div key={flashKey} className={`absolute inset-0 rounded-xl pointer-events-none ${flash === 'done' ? 'task-flash-done' : 'task-flash-skip'}`} />}
      <div className="relative flex items-center gap-3 py-2.5 pl-4 pr-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{task.name}</span>
            {hasNote && (
              <svg className="shrink-0 w-3.5 h-3.5 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Has note">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            )}
            {season && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200/70 dark:bg-gray-700/70 text-gray-500 dark:text-gray-400">{season}</span>}
          </div>
          <div className="text-xs flex items-center gap-1.5 mt-0.5">
            <span className={cls.text}>{formatAgo(task.last_done_at)}</span>
            {by && <span className="text-gray-400 dark:text-gray-500">· by {by}</span>}
            {target && <span className="text-gray-400 dark:text-gray-500">· {target}</span>}
            {task.total_count > 0 && <span className="text-gray-400 dark:text-gray-500">· {task.total_count}×</span>}
          </div>
        </div>
        <div className="shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerLeave={clearTimer}
            onPointerCancel={clearTimer}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all select-none ${justDone ? 'bg-emerald-500 text-white scale-105' : 'bg-white/70 dark:bg-gray-700/80 text-gray-700 dark:text-gray-200 hover:bg-emerald-500 hover:text-white'}`}
          >
            {justDone ? '✓ Done' : 'Done'}
          </button>
          {menuOpen && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setMenuOpen(false)}>
              <div className="glass-menu w-full max-w-xs rounded-2xl p-4 shadow-xl" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">{task.name}</div>
                  <button onClick={() => setMenuOpen(false)} className="shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label="Close">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Backdate completion</div>
                <BackdateCalendar onPick={(iso) => { tracker.markDone(listId, task.id, iso); flashDone(); setMenuOpen(false); }} />
                <button
                  onClick={() => { tracker.skipTask(listId, task.id); triggerFlash('skip'); setMenuOpen(false); }}
                  className="mt-3 w-full text-center text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-2 rounded-xl bg-gray-100/70 dark:bg-gray-700/60 hover:bg-gray-200 dark:hover:bg-gray-600"
                >Skip this cycle</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// GitHub-style contribution heatmap of completions over the past year.
function ContributionGraph({ logs }: { logs: TrackerLog[] }) {
  const WEEKS = 53;
  const { columns, monthLabels } = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const counts = new Map<string, number>();
    for (const l of logs) {
      const d = new Date(parseServerDate(l.done_at));
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    // Start on the Sunday (WEEKS-1) weeks before THIS week's Sunday, so the last
    // column is always the current week (today included, later days marked future).
    const cur = new Date(today);
    cur.setDate(cur.getDate() - today.getDay() - (WEEKS - 1) * 7);
    const cols: { key: string; count: number; future: boolean }[][] = [];
    const labels: { col: number; label: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const col: { key: string; count: number; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const key = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
        col.push({ key, count: counts.get(key) || 0, future: cur > today });
        if (d === 0 && cur.getMonth() !== lastMonth) { labels.push({ col: w, label: MONTH_ABBR[cur.getMonth()] }); lastMonth = cur.getMonth(); }
        cur.setDate(cur.getDate() + 1);
      }
      cols.push(col);
    }
    return { columns: cols, monthLabels: labels };
  }, [logs]);

  const cellClass = (count: number, future: boolean) => {
    if (future) return 'bg-transparent';
    if (count === 0) return 'bg-gray-200 dark:bg-gray-700/60';
    if (count === 1) return 'bg-emerald-300 dark:bg-emerald-800';
    if (count === 2) return 'bg-emerald-400 dark:bg-emerald-600';
    return 'bg-emerald-600 dark:bg-emerald-400';
  };

  // Default the view to the most recent weeks (right edge), not the oldest.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [columns]);

  return (
    <div ref={scrollRef} className="overflow-x-auto no-scrollbar">
      <div className="inline-block">
        <div className="flex gap-[3px] mb-1 h-3">
          {columns.map((_, w) => {
            const lbl = monthLabels.find(m => m.col === w);
            return <div key={w} className="w-[10px] relative">{lbl && <span className="absolute left-0 top-0 text-[9px] text-gray-400 whitespace-nowrap">{lbl.label}</span>}</div>;
          })}
        </div>
        <div className="flex gap-[3px]">
          {columns.map((col, w) => (
            <div key={w} className="flex flex-col gap-[3px]">
              {col.map((cell, d) => (
                <div key={d} className={`w-[10px] h-[10px] rounded-[2px] ${cellClass(cell.count, cell.future)}`} title={cell.future ? undefined : `${cell.key}: ${cell.count}`} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Recurring season picker: choose a start date then an end date on one calendar.
function SeasonCalendar({ startMonth, startDay, endMonth, endDay, onChange }: {
  startMonth: number | null; startDay: number | null; endMonth: number | null; endDay: number | null;
  onChange: (sm: number | null, sd: number | null, em: number | null, ed: number | null) => void;
}) {
  const enabled = !!(startMonth && endMonth);
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: (startMonth ?? today.getMonth() + 1) - 1 });
  const [pendingStart, setPendingStart] = useState<{ m: number; d: number } | null>(null);
  const [editing, setEditing] = useState(false);

  const start = startMonth ? { m: startMonth, d: startDay ?? 1 } : null;
  const end = endMonth ? { m: endMonth, d: endDay ?? 1 } : null;
  const ord = (m: number, d: number) => m * 100 + d;
  const inRange = (m: number, d: number) => {
    if (pendingStart || !start || !end) return false; // hide the old range while a new one is being picked
    const o = ord(m, d), s = ord(start.m, start.d), e = ord(end.m, end.d);
    return s <= e ? (o >= s && o <= e) : (o >= s || o <= e);
  };
  const isEndpoint = (m: number, d: number) => !pendingStart && ((!!start && start.m === m && start.d === d) || (!!end && end.m === m && end.d === d));

  const toggle = () => {
    if (enabled) { onChange(null, null, null, null); setPendingStart(null); setEditing(false); }
    else { const sm = today.getMonth() + 1; const em = ((sm + 1) % 12) + 1; onChange(sm, 1, em, 28); setEditing(true); }
  };
  const pick = (day: number) => {
    const m = view.m + 1;
    if (!pendingStart) setPendingStart({ m, d: day });
    else { onChange(pendingStart.m, pendingStart.d, m, day); setPendingStart(null); setEditing(false); }
  };
  const shift = (delta: number) => setView(v => {
    let m = v.m + delta, y = v.y;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    return { y, m };
  });

  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const firstWeekday = new Date(view.y, view.m, 1).getDay();
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={enabled} onChange={toggle} />
          Seasonal
          {enabled && start && end && <span className="text-gray-700 dark:text-gray-200 font-medium">· {seasonLabel(start.m, start.d, end.m, end.d)}</span>}
        </label>
        {enabled && !editing && (
          <button onClick={() => setEditing(true)} className="text-xs text-blue-500 dark:text-blue-400 hover:text-blue-600">Edit</button>
        )}
      </div>
      {enabled && editing && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-2">
          <div className="flex items-center justify-between mb-1">
            <button onClick={() => shift(-1)} className="px-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200" aria-label="Previous month">‹</button>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{MONTH_ABBR[view.m]} {view.y}</span>
            <button onClick={() => shift(1)} className="px-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200" aria-label="Next month">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] text-gray-400 mb-0.5">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const m = view.m + 1;
              const pend = !!pendingStart && pendingStart.m === m && pendingStart.d === day;
              return (
                <button
                  key={i}
                  onClick={() => pick(day)}
                  className={`text-xs h-7 rounded-md transition-colors ${
                    isEndpoint(m, day) || pend ? 'bg-blue-500 text-white font-semibold'
                      : inRange(m, day) ? 'bg-blue-500/20 text-blue-700 dark:text-blue-300'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                >{day}</button>
              );
            })}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">{pendingStart ? 'Now pick the end date' : 'Tap a start date, then an end date'}</p>
        </div>
      )}
    </div>
  );
}

// Compact single-date picker for backdating a completion. Future days are
// disabled (not selectable) and you can't navigate into future months.
function BackdateCalendar({ onPick }: { onPick: (iso: string) => void }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const firstWeekday = new Date(view.y, view.m, 1).getDay();
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const atCurrentMonth = view.y === today.getFullYear() && view.m === today.getMonth();
  const isFuture = (day: number) => new Date(view.y, view.m, day) > today;
  const isToday = (day: number) => atCurrentMonth && day === today.getDate();
  const shift = (delta: number) => setView(v => { let m = v.m + delta, y = v.y; if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; } return { y, m }; });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <button onClick={() => shift(-1)} className="px-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200" aria-label="Previous month">‹</button>
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{MONTH_ABBR[view.m]} {view.y}</span>
        <button onClick={() => shift(1)} disabled={atCurrentMonth} className="px-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-30" aria-label="Next month">›</button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] text-gray-400 mb-0.5">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const future = isFuture(day);
          return (
            <button
              key={i}
              disabled={future}
              onClick={() => onPick(new Date(view.y, view.m, day, 12, 0, 0).toISOString())}
              className={`text-xs h-7 rounded-md transition-colors ${future
                ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                : isToday(day)
                  ? 'bg-blue-500/20 text-blue-700 dark:text-blue-300 hover:bg-blue-500 hover:text-white'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-blue-500 hover:text-white'}`}
            >{day}</button>
          );
        })}
      </div>
    </div>
  );
}

// ----- Task detail / history modal -----

function TaskDetailModal({ list, task, tracker, user, onClose }: {
  list: TrackerList;
  task: TrackerTask;
  tracker: ReturnType<typeof useTracker>;
  user: UserInfo;
  onClose: () => void;
}) {
  const listId = list.id;
  const { canUndo, canRedo, undo, redo } = useUndo();
  const [logs, setLogs] = useState<TrackerLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [editName, setEditName] = useState(task.name);
  const [editTarget, setEditTarget] = useState(task.target_interval_days ? String(task.target_interval_days) : '');
  const [editNotes, setEditNotes] = useState(task.notes ?? '');
  const [showBackdate, setShowBackdate] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [whoSub, setWhoSub] = useState<string>(user.sub);
  // Which edit field is focused — so external updates don't clobber active typing.
  const focusedFieldRef = useRef<string | null>(null);

  // Collaborators who can be credited with a completion: me + owner + shares.
  const members = useMemo(() => {
    const m = new Map<string, string>();
    m.set(user.sub, user.name || user.email || 'You');
    if (list.owner_sub) m.set(list.owner_sub, list.owner_name || list.owner_sub);
    for (const u of list.shared_with) m.set(u.sub, u.name || u.email || u.sub);
    return [...m.entries()].map(([sub, name]) => ({ sub, name }));
  }, [list, user]);

  const r = taskRecency(task);
  const doneLogs = useMemo(() => logs.filter(l => l.kind !== 'skip'), [logs]);
  const streak = useMemo(() => computeStreak(doneLogs.map(l => l.done_at), task.target_interval_days), [doneLogs, task.target_interval_days]);

  const reloadLogs = useCallback(async () => {
    if (isTempId(task.id)) { setLogs([]); setLoadingLogs(false); return; }
    try {
      const fetched = await getTrackerLogs(task.id);
      setLogs(fetched);
    } catch { /* offline / unsynced */ }
    finally { setLoadingLogs(false); }
  }, [task.id]);

  useEffect(() => { void reloadLogs(); }, [reloadLogs]);

  // Refetch history when this task's completions change elsewhere — a mark-done
  // on another device, or an undo/redo applied while the modal is open.
  useEffect(() => {
    const onRealtime = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string; payload?: { action?: string; task?: { id?: string } } } | undefined;
      if (detail?.type !== 'tracker.updated') return;
      if (detail.payload?.action === 'task-logged' && detail.payload.task?.id === task.id) void reloadLogs();
    };
    const onUndoRedo = () => { void reloadLogs(); };
    window.addEventListener('meal-planner-realtime', onRealtime as EventListener);
    window.addEventListener('undo-redo-applied', onUndoRedo);
    return () => {
      window.removeEventListener('meal-planner-realtime', onRealtime as EventListener);
      window.removeEventListener('undo-redo-applied', onUndoRedo);
    };
  }, [reloadLogs, task.id]);

  // Keep the editable fields in sync when the task changes underneath us (e.g. a
  // collaborator edits the note/target on another device) — but never overwrite
  // a field the user is actively typing in.
  useEffect(() => { if (focusedFieldRef.current !== 'name') setEditName(task.name); }, [task.name]);
  useEffect(() => { if (focusedFieldRef.current !== 'target') setEditTarget(task.target_interval_days != null ? String(task.target_interval_days) : ''); }, [task.target_interval_days]);
  useEffect(() => { if (focusedFieldRef.current !== 'notes') setEditNotes(task.notes ?? ''); }, [task.notes]);

  const recompute = (next: TrackerLog[]) => {
    const stats = computeStats(next.filter(l => l.kind !== 'skip').map(l => l.done_at));
    tracker.applyTaskStats(listId, task.id, stats);
  };

  const handleMarkDone = (rawIso: string) => {
    const iso = Date.parse(rawIso) > Date.now() ? new Date().toISOString() : rawIso; // never future
    const note = noteInput.trim() || null;
    const whoName = firstName(members.find(m => m.sub === whoSub)?.name ?? null);
    const holder = tracker.addLog(listId, task.id, iso, note, { sub: whoSub, name: whoName });
    const optimistic: TrackerLog = { id: holder.id, task_id: task.id, done_at: iso, note, created_by_sub: whoSub, created_by_name: whoName };
    const next = [optimistic, ...logs].sort((a, b) => parseServerDate(b.done_at) - parseServerDate(a.done_at));
    setLogs(next);
    recompute(next);
    setNoteInput('');
  };

  const handleSkip = () => {
    const { holder, doneAt } = tracker.skipTask(listId, task.id);
    const whoName = firstName(user.name) ?? null;
    const optimistic: TrackerLog = { id: holder.id, task_id: task.id, done_at: doneAt, kind: 'skip', note: null, created_by_sub: user.sub, created_by_name: whoName };
    setLogs(prev => [optimistic, ...prev].sort((a, b) => parseServerDate(b.done_at) - parseServerDate(a.done_at)));
  };

  const commitSeason = (sm: number | null, sd: number | null, em: number | null, ed: number | null) => {
    tracker.updateTask(listId, task.id, { season_start_month: sm, season_start_day: sd, season_end_month: em, season_end_day: ed });
  };

  const handleDeleteLog = (log: TrackerLog) => {
    const next = logs.filter(l => l.id !== log.id);
    setLogs(next);
    const remainingDone = next.filter(l => l.kind !== 'skip');
    const stats = computeStats(remainingDone.map(l => l.done_at));
    const allTimes = next.map(l => parseServerDate(l.done_at)).filter(n => !Number.isNaN(n)).sort((a, b) => b - a);
    const lastEvent = allTimes.length ? new Date(allTimes[0]).toISOString() : null;
    const latestDone = remainingDone[0]; // logs are kept sorted newest-first
    tracker.removeLog(listId, task.id, log, {
      ...stats,
      last_event_at: lastEvent,
      last_note: latestDone?.note ?? null,
      last_done_by: firstName(latestDone?.created_by_name) ?? null,
    });
  };

  const commitEdits = () => {
    const updates: { name?: string; target_interval_days?: number | null; notes?: string | null } = {};
    const name = editName.trim();
    if (name && name !== task.name) updates.name = name;
    const target = editTarget.trim() ? Math.max(1, Math.round(Number(editTarget))) : null;
    if (target !== task.target_interval_days) updates.target_interval_days = target;
    const notes = editNotes.trim() ? editNotes.trim() : null;
    if (notes !== (task.notes ?? null)) updates.notes = notes;
    if (Object.keys(updates).length > 0) tracker.updateTask(listId, task.id, updates);
  };

  return (
    <div className="fixed left-0 right-0 top-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" style={{ height: 'var(--vvh, 100dvh)' }} onClick={onClose}>
      <div className="glass-menu w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-full flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Pinned header — stays visible while the body scrolls (and when the keyboard is open) */}
        <div className="shrink-0 flex items-start justify-between gap-2 p-5 pb-3 border-b border-gray-200/60 dark:border-gray-700/60">
          <div className="flex-1 min-w-0">
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onFocus={() => { focusedFieldRef.current = 'name'; }}
              onBlur={() => { focusedFieldRef.current = null; commitEdits(); }}
              className="w-full text-lg font-bold bg-transparent text-gray-900 dark:text-gray-100 outline-none border-b border-transparent focus:border-gray-300 dark:focus:border-gray-600"
            />
            <div className={`text-xs mt-0.5 ${RECENCY_CLASSES[r.level].text}`}>Last done {formatAgo(task.last_done_at)}</div>
          </div>
          <div className="shrink-0 flex items-center gap-0.5">
            <button onClick={() => void undo()} disabled={!canUndo} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg disabled:opacity-30 disabled:pointer-events-none" aria-label="Undo">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" /></svg>
            </button>
            <button onClick={() => void redo()} disabled={!canRedo} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg disabled:opacity-30 disabled:pointer-events-none" aria-label="Redo">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" /></svg>
            </button>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label="Close">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="p-5 pt-4 space-y-4 overflow-y-auto">

          {/* Stats */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="glass rounded-xl py-2">
              <div className="text-base font-bold text-gray-900 dark:text-gray-100">{task.total_count}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Total</div>
            </div>
            <div className="glass rounded-xl py-2">
              <div className="text-base font-bold text-gray-900 dark:text-gray-100">{streak > 0 ? `🔥${streak}` : '—'}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Streak</div>
            </div>
            <div className="glass rounded-xl py-2">
              <div className="text-base font-bold text-gray-900 dark:text-gray-100">{task.avg_interval_days != null ? `${task.avg_interval_days}d` : '—'}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Avg</div>
            </div>
            <div className="glass rounded-xl py-2">
              <div className="text-base font-bold text-gray-900 dark:text-gray-100">{task.target_interval_days != null ? `${task.target_interval_days}d` : '—'}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Target</div>
            </div>
          </div>

          {/* Past year heatmap */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1.5">Past year</div>
            <ContributionGraph logs={doneLogs} />
          </div>

          {/* Mark done */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                value={noteInput}
                onChange={e => setNoteInput(e.target.value)}
                placeholder="Note (optional)"
                className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm"
              />
              {members.length > 1 && (
                <select
                  value={whoSub}
                  onChange={e => setWhoSub(e.target.value)}
                  title="Who did it"
                  className="shrink-0 max-w-[7rem] px-2 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm"
                >
                  {members.map(m => <option key={m.sub} value={m.sub}>{m.sub === user.sub ? 'You' : firstName(m.name)}</option>)}
                </select>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => handleMarkDone(new Date().toISOString())} className="flex-1 py-2.5 rounded-xl bg-emerald-500 text-white font-medium hover:bg-emerald-600">Mark done now</button>
              <button
                onClick={() => setShowBackdate(v => !v)}
                className={`px-3 py-2.5 rounded-xl text-sm font-medium ${showBackdate ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
              >Backdate</button>
              <button
                onClick={handleSkip}
                title="Skip this cycle — resets recency without counting as a completion"
                className="px-3 py-2.5 rounded-xl text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600"
              >Skip</button>
            </div>
            {showBackdate && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-2">
                <BackdateCalendar onPick={(iso) => { handleMarkDone(iso); setShowBackdate(false); }} />
              </div>
            )}
          </div>

          {/* Settings: target + season */}
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <label className="text-gray-500 dark:text-gray-400 w-16">Target</label>
              <input
                value={editTarget}
                onChange={e => setEditTarget(e.target.value.replace(/[^0-9]/g, ''))}
                onFocus={e => { e.currentTarget.placeholder = ''; focusedFieldRef.current = 'target'; }}
                onBlur={e => { e.currentTarget.placeholder = '—'; focusedFieldRef.current = null; commitEdits(); }}
                placeholder="—"
                inputMode="numeric"
                className="w-16 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-center"
              />
              <span className="text-gray-500 dark:text-gray-400">days</span>
            </div>
            <SeasonCalendar
              startMonth={task.season_start_month} startDay={task.season_start_day}
              endMonth={task.season_end_month} endDay={task.season_end_day}
              onChange={commitSeason}
            />
          </div>
          <textarea
            value={editNotes}
            onChange={e => setEditNotes(e.target.value)}
            onFocus={() => { focusedFieldRef.current = 'notes'; }}
            onBlur={() => { focusedFieldRef.current = null; commitEdits(); }}
            placeholder="Task notes (optional)"
            rows={2}
            className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm resize-none"
          />

          {/* History with gap pills */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">History{logs.length > 0 ? ` · ${logs.length}` : ''}</div>
            {loadingLogs ? (
              <div className="text-sm text-gray-400 py-2">Loading…</div>
            ) : logs.length === 0 ? (
              <div className="text-sm text-gray-400 py-2">No completions logged yet.</div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                {logs.map((log, i) => {
                  const older = logs[i + 1];
                  const gapDays = older ? Math.round((parseServerDate(log.done_at) - parseServerDate(older.done_at)) / 86400000) : null;
                  const overGap = gapDays != null && task.target_interval_days != null && gapDays > task.target_interval_days;
                  return (
                    <Fragment key={log.id}>
                      <div className="flex items-start justify-between text-sm py-1.5 gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-gray-700 dark:text-gray-200">
                            {new Date(parseServerDate(log.done_at)).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            {log.kind === 'skip' && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-amber-400 text-amber-950 dark:bg-amber-500/30 dark:text-amber-300 uppercase tracking-wide font-bold">Skipped</span>}
                            {log.created_by_name && <span className="text-gray-400"> · {firstName(log.created_by_name)}</span>}
                          </div>
                          {log.note && <div className="text-xs text-gray-400 break-words whitespace-pre-wrap">{log.note}</div>}
                        </div>
                        <button onClick={() => handleDeleteLog(log)} className="shrink-0 mt-0.5 text-gray-400 hover:text-red-500" aria-label="Delete entry">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                      {gapDays != null && (
                        <div className="pl-1 py-0.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${overGap ? 'bg-red-500/20 text-red-600 dark:text-red-400' : 'bg-gray-200/70 dark:bg-gray-700/70 text-gray-400'}`}>
                            {gapDays} {gapDays === 1 ? 'day' : 'days'} later
                          </span>
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>

          {/* Delete task */}
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => { tracker.deleteTask(listId, task.id); onClose(); }}
              className="text-sm text-red-600 dark:text-red-400 hover:underline"
            >Delete task</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----- Share modal -----

function ShareModal({ list, tracker, onClose }: {
  list: TrackerList;
  tracker: ReturnType<typeof useTracker>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);

  useEffect(() => {
    getUsers().then(setDirectory).catch(() => {});
  }, []);

  const sharedSubs = new Set(list.shared_with.map(u => u.sub));
  const candidates = directory.filter(u => !sharedSubs.has(u.sub) && u.sub !== list.owner_sub);

  const doShare = async (sub: string) => {
    setBusy(true);
    setError(null);
    try {
      await tracker.shareList(list.id, { sub });
    } catch {
      setError('Could not share. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed left-0 right-0 top-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" style={{ height: 'var(--vvh, 100dvh)' }} onClick={onClose}>
      <div className="glass-menu w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-full overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Share "{list.name}"</h3>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          {/* Current shares */}
          {list.shared_with.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs uppercase tracking-wide text-gray-400">Shared with</div>
              {list.shared_with.map(u => (
                <div key={u.sub} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-gray-50 dark:bg-gray-800/40">
                  <span className="text-sm text-gray-700 dark:text-gray-200">{u.name || u.email || u.sub}</span>
                  <button onClick={() => tracker.unshareList(list.id, u.sub).catch(() => {})} className="text-xs text-red-500 hover:underline">Remove</button>
                </div>
              ))}
            </div>
          )}

          {/* Add a person (dropdown of known users) */}
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Add person</div>
            {candidates.length === 0 ? (
              <p className="text-sm text-gray-400">No other users available yet — people appear here once they've signed in.</p>
            ) : (
              <select
                value=""
                disabled={busy}
                onChange={e => { if (e.target.value) doShare(e.target.value); }}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 outline-none text-sm disabled:opacity-50"
              >
                <option value="">Select a person…</option>
                {candidates.map(u => (
                  <option key={u.sub} value={u.sub}>{u.name || u.email || u.sub}</option>
                ))}
              </select>
            )}
            {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          </div>

          <p className="text-xs text-gray-400">Lists are private to you until you share them. People you share with can view and update tasks.</p>
        </div>
      </div>
    </div>
  );
}
