import { useRef, useEffect, useCallback } from 'react';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  onBlur: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function RichTextEditor({ value, onChange, onBlur, placeholder, autoFocus = false }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isComposing = useRef(false);
  const isUserEditing = useRef(false);
  const initialMount = useRef(true);

  // Set initial content and handle auto-focus
  useEffect(() => {
    if (editorRef.current) {
      // Only update innerHTML if:
      // 1. It's the initial mount, OR
      // 2. The editor doesn't have focus (external update), OR  
      // 3. The user isn't actively editing
      const shouldUpdateContent = initialMount.current || 
        document.activeElement !== editorRef.current || 
        !isUserEditing.current;
        
      if (shouldUpdateContent && editorRef.current.innerHTML !== value) {
        editorRef.current.innerHTML = value;
      }
      
      // Auto-focus if requested (only on initial mount)
      if (autoFocus && initialMount.current) {
        // Use requestAnimationFrame to ensure the DOM is ready
        requestAnimationFrame(() => {
          if (editorRef.current) {
            editorRef.current.focus();
            
            // Move cursor to end of content
            const range = document.createRange();
            const selection = window.getSelection();
            range.selectNodeContents(editorRef.current);
            range.collapse(false); // Collapse to end
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        });
      }
      
      initialMount.current = false;
    }
  }, [value, autoFocus]);

  const handleInput = useCallback(() => {
    if (isComposing.current) return;
    if (editorRef.current) {
      isUserEditing.current = true;
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange]);

  const handleFocus = useCallback(() => {
    isUserEditing.current = true;
  }, []);

  const handleBlur = useCallback(() => {
    isUserEditing.current = false;
    onBlur();
  }, [onBlur]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd/Ctrl + B for bold
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      document.execCommand('bold', false);
      handleInput();
    }
  }, [handleInput]);

  const handlePaste = useCallback(() => {
    // Allow paste with formatting (links, bold, etc.)
    // The browser handles this automatically with contenteditable
    // We just need to clean up any unwanted styles after paste
    setTimeout(() => {
      if (editorRef.current) {
        // Remove any inline styles but keep structural formatting and links
        const html = editorRef.current.innerHTML;
        
        // More conservative cleanup: only remove style attributes and font tags
        // Keep spans that might be part of links or other important formatting
        const cleaned = html
          .replace(/ style="[^"]*"/gi, '')
          .replace(/<font[^>]*>/gi, '')
          .replace(/<\/font>/gi, '')
          // Only remove empty spans, not all spans (some might be needed for links)
          .replace(/<span[^>]*><\/span>/gi, '')
          // Remove spans that only have style attributes (now removed) and no other attributes
          .replace(/<span>\s*<\/span>/gi, '');

        if (cleaned !== html) {
          const selection = window.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          editorRef.current.innerHTML = cleaned;
          // Try to restore cursor position
          if (range && selection) {
            try {
              selection.removeAllRanges();
              selection.addRange(range);
            } catch {
              // If range restoration fails, move cursor to end
              const newRange = document.createRange();
              newRange.selectNodeContents(editorRef.current);
              newRange.collapse(false);
              selection.removeAllRanges();
              selection.addRange(newRange);
            }
          }
        }
        onChange(editorRef.current.innerHTML);
      }
    }, 0);
  }, [onChange]);

  const applyBold = useCallback(() => {
    document.execCommand('bold', false);
    editorRef.current?.focus();
    handleInput();
  }, [handleInput]);

  return (
    <div className="relative">
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-2 pb-2 border-b border-gray-200 dark:border-gray-600">
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent losing selection
            applyBold();
          }}
          className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 font-bold text-sm"
          title="Bold (Cmd+B)"
        >
          B
        </button>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">
          Tip: Paste links directly, or select text and press Cmd+B
        </span>
      </div>

      {/* Editor */}
      <div
        ref={editorRef}
        contentEditable
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={() => { isComposing.current = true; }}
        onCompositionEnd={() => {
          isComposing.current = false;
          handleInput();
        }}
        data-placeholder={placeholder}
        className="min-h-[80px] outline-none text-gray-800 dark:text-gray-200
          [&_a]:text-blue-600 [&_a]:dark:text-blue-400 [&_a]:underline
          empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 empty:before:dark:text-gray-500 empty:before:italic"
      />
    </div>
  );
}
