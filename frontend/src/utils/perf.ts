type PerfPayload = Record<string, unknown>;

const PERF_KEY = 'meal-planner-perf';
const PERF_FLAG = '__MEAL_PLANNER_PERF__';

const getNow = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const roundMs = (value: number) => Math.round(value * 100) / 100;

const getWindow = (): (Window & typeof globalThis & Record<string, unknown>) | undefined => {
  if (typeof window === 'undefined') return undefined;
  return window as Window & typeof globalThis & Record<string, unknown>;
};

export function isPerfEnabled(): boolean {
  const win = getWindow();
  return Boolean(win && win[PERF_FLAG] === true);
}

const setPerfEnabled = (enabled: boolean) => {
  const win = getWindow();
  if (!win) return;
  win[PERF_FLAG] = enabled;
  try {
    if (enabled) {
      localStorage.setItem(PERF_KEY, '1');
    } else {
      localStorage.removeItem(PERF_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
};

export function setupPerfLogging() {
  const win = getWindow();
  if (!win || win.mealPlannerPerf) return;

  let enabled = false;
  try {
    enabled = localStorage.getItem(PERF_KEY) === '1';
  } catch {
    enabled = false;
  }

  win[PERF_FLAG] = enabled;
  win.mealPlannerPerf = {
    enable: () => setPerfEnabled(true),
    disable: () => setPerfEnabled(false),
    isEnabled: () => isPerfEnabled(),
    help: () => {
      console.info('Meal Planner perf logging:', {
        enable: 'mealPlannerPerf.enable()',
        disable: 'mealPlannerPerf.disable()',
        status: 'mealPlannerPerf.isEnabled()',
      });
    },
  };

  if (enabled) {
    console.info('Meal Planner perf logging enabled.');
  }
}

export function logPerf(label: string, payload: PerfPayload = {}) {
  if (!isPerfEnabled()) return;
  console.info(`[perf] ${label}`, {
    ...payload,
    at: new Date().toISOString(),
  });
}

export function logDuration(label: string, start: number, payload: PerfPayload = {}) {
  if (!isPerfEnabled()) return;
  logPerf(label, { ...payload, durationMs: roundMs(getNow() - start) });
}

export function logRenderDuration(label: string, start: number, payload: PerfPayload = {}) {
  if (!isPerfEnabled()) return;
  const log = () => logDuration(label, start, payload);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(log);
  } else {
    setTimeout(log, 0);
  }
}

export function perfNow() {
  return getNow();
}
