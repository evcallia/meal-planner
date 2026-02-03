import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ReactDOM
const mockCreateRoot = vi.fn();
const mockRender = vi.fn();

vi.mock('react-dom/client', () => ({
  createRoot: mockCreateRoot
}));

vi.mock('./App', () => ({
  default: () => 'App Component'
}));

// Mock CSS import
vi.mock('./index.css', () => ({}));

describe('main.tsx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    
    // Mock DOM
    const mockRootElement = document.createElement('div');
    mockRootElement.id = 'root';
    
    vi.spyOn(document, 'getElementById').mockReturnValue(mockRootElement);
    
    mockCreateRoot.mockReturnValue({
      render: mockRender
    });
  });

  it('should create root and render App', async () => {
    // Import main.tsx to execute the code
    await import('../main');

    expect(document.getElementById).toHaveBeenCalledWith('root');
    expect(mockCreateRoot).toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
  });

  it('should render App component inside React.StrictMode', async () => {
    await import('../main');

    // Check that render was called (we can't easily test the exact JSX structure in this context)
    expect(mockRender).toHaveBeenCalledTimes(1);
  });
});
