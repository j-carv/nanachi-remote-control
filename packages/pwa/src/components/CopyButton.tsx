import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Copies `text` to the clipboard. The async API needs a secure context; the old one covers the rest. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based copy.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

const COPIED_MS = 1500;

interface CopyButtonProps {
  /** What is copied. */
  text: string;
  /** Accessible name while idle ("Copiar link"). */
  label: string;
}

/** Icon button that copies `text` and shows a check mark for a moment. */
export function CopyButton({ text, label }: CopyButtonProps) {
  const { t } = useTranslation('accounts');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      data-slot="copy-button"
      aria-label={copied ? t('copy.copied') : label}
      onClick={() => {
        void copyText(text).then((done) => setCopied(done));
      }}
    >
      {/* The check mounts fresh each time, so its pop plays on every copy; it swaps back to the copy icon after COPIED_MS. */}
      {copied ? (
        <Check aria-hidden="true" className="animate-pop text-success" />
      ) : (
        <Copy aria-hidden="true" />
      )}
    </Button>
  );
}
