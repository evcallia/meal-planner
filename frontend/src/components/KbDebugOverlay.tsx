import { useEffect, useState } from 'react';
import { kbClear, kbDebugOn, kbEntries, kbSubscribe, kbText } from '../utils/kbdebug';

// TEMPORARY. Renders the kbdebug log on the device, with a Copy button so the
// sequence can be pasted back rather than read off a screenshot. Delete with
// utils/kbdebug.ts once the keyboard-dismiss bug is understood.
export function KbDebugOverlay() {
  const [, bump] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => kbSubscribe(() => bump(n => n + 1)), []);

  if (!kbDebugOn) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(kbText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed left-2 right-2 bottom-2 z-[100] rounded-lg bg-black/90 text-green-300 text-[10px] leading-tight font-mono p-2 max-h-[45vh] overflow-y-auto"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      <div className="flex items-center gap-2 mb-1 sticky top-0 bg-black/90 py-1">
        <span className="text-white font-bold">kbdebug</span>
        <button onClick={copy} className="px-2 py-0.5 rounded-sm bg-green-700 text-white">
          {copied ? 'copied' : 'copy'}
        </button>
        <button onClick={kbClear} className="px-2 py-0.5 rounded-sm bg-gray-700 text-white">
          clear
        </button>
        <span className="ml-auto text-gray-400">{kbEntries().length}</span>
      </div>
      {kbEntries().map((e, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          <span className="text-gray-500">+{e.t}ms </span>
          <span className="text-yellow-300">{e.what}</span>
          {e.detail ? ` ${e.detail}` : ''}
        </div>
      ))}
    </div>
  );
}
