// Copying a text to the clipboard, with a flag that says it did for two seconds.
import { useEffect, useState } from "react";

/** `copy(text)` and whether the last copy happened in the past two seconds. */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  /** Copies the text; `copied` turns on only when the browser did copy. */
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (plain HTTP) or refused: the text stays on the page to select.
    }
  };

  return { copied, copy };
}
