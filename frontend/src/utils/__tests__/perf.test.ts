import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupPerfLogging, isPerfEnabled, logDuration, logRenderDuration, perfNow } from '../perf';

describe('perf utils', () => {
  const originalPerformance = global.performance;
  const originalRaf = global.requestAnimationFrame;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).mealPlannerPerf;
    delete (window as any).__MEAL_PLANNER_PERF__;
    localStorage.getItem = vi.fn();
    localStorage.setItem = vi.fn();
    localStorage.removeItem = vi.fn();
  });

  afterEach(() => {
    global.performance = originalPerformance;
    global.requestAnimationFrame = originalRaf;
  });

  it('sets up perf helpers and persists enable flag', () => {
    localStorage.getItem = vi.fn(() => '1');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    setupPerfLogging();

    expect(isPerfEnabled()).toBe(true);
    expect((window as any).mealPlannerPerf).toBeDefined();
    expect(infoSpy).toHaveBeenCalledWith('Meal Planner perf logging enabled.');

    (window as any).mealPlannerPerf.disable();
    expect(isPerfEnabled()).toBe(false);
    expect(localStorage.removeItem).toHaveBeenCalled();

    (window as any).mealPlannerPerf.enable();
    expect(isPerfEnabled()).toBe(true);
    expect(localStorage.setItem).toHaveBeenCalled();

    infoSpy.mockRestore();
  });

  it('logs duration only when enabled', () => {
    (window as any).__MEAL_PLANNER_PERF__ = true;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    global.performance = { now: () => 200 } as Performance;
    logDuration('test.duration', 120, { foo: 'bar' });

    expect(infoSpy).toHaveBeenCalledWith('[perf] test.duration', expect.objectContaining({
      foo: 'bar',
      durationMs: 80,
    }));

    infoSpy.mockRestore();
  });

  it('logs render duration via requestAnimationFrame when enabled', () => {
    (window as any).__MEAL_PLANNER_PERF__ = true;
    global.performance = { now: () => 300 } as Performance;

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    global.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };

    logRenderDuration('render.pass', 250);

    expect(infoSpy).toHaveBeenCalledWith('[perf] render.pass', expect.objectContaining({
      durationMs: 50,
    }));

    infoSpy.mockRestore();
  });

  it('falls back to Date.now when performance is unavailable', () => {
    global.performance = undefined as unknown as Performance;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(12345);

    expect(perfNow()).toBe(12345);

    nowSpy.mockRestore();
  });
});
