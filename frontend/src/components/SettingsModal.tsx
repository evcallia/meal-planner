import { Settings } from '../hooks/useSettings';

interface SettingsModalProps {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => void;
  onClose: () => void;
}

export function SettingsModal({ settings, onUpdate, onClose }: SettingsModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Meal Ideas Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Show Future Meals</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Keep a list of meals to schedule later
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showMealIdeas}
              onClick={() => onUpdate({ showMealIdeas: !settings.showMealIdeas })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.showMealIdeas ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.showMealIdeas ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>

          {/* Pantry Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Show Pantry</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Keep pantry inventory visible below the calendar
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showPantry}
              onClick={() => onUpdate({ showPantry: !settings.showPantry })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.showPantry ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.showPantry ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>

          {/* Itemized Column Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Show Itemized Column</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Show checkboxes to mark meals as added to shopping list
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showItemizedColumn}
              onClick={() => onUpdate({ showItemizedColumn: !settings.showItemizedColumn })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.showItemizedColumn ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.showItemizedColumn ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="w-full py-2 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
