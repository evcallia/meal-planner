import '@testing-library/jest-dom'

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
}

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
}

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
global.localStorage = localStorageMock

// Mock document.execCommand
document.execCommand = vi.fn()

// Mock window.getSelection
const mockSelection = {
  removeAllRanges: vi.fn(),
  addRange: vi.fn(),
  toString: vi.fn(() => ''),
  rangeCount: 0,
  getRangeAt: vi.fn(),
}
global.getSelection = vi.fn(() => mockSelection)

// Mock Range
global.Range = class Range {
  setStart() {}
  setEnd() {}
  selectNodeContents() {}
  collapse() {}
}

document.createRange = vi.fn(() => new Range())

// Mock scrollIntoView for happy-dom
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  value: vi.fn(),
  writable: true,
})

window.scrollTo = vi.fn()
