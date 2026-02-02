interface MealItemProps {
  text: string;
  itemized: boolean;
  onToggle: () => void;
  onTextClick: () => void;
  showHeader: boolean;
}

export function MealItem({ text, itemized, onToggle, onTextClick, showHeader }: MealItemProps) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="flex-shrink-0 flex flex-col items-center w-12">
        {showHeader && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-1">
            Itemized
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={`
            w-5 h-5 rounded border-2 flex items-center justify-center
            transition-colors duration-150
            ${itemized
              ? 'bg-green-500 border-green-500 dark:bg-green-600 dark:border-green-600'
              : 'border-gray-300 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500'
            }
          `}
        >
          {itemized && (
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
      </div>
      <span
        onClick={onTextClick}
        className={`text-gray-800 dark:text-gray-200 leading-snug cursor-text flex-1 ${showHeader ? 'mt-4' : ''}`}
      >
        {text}
      </span>
    </div>
  );
}
