import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard.js';
import { Button } from './Button.js';
import { useToast } from './Toast.js';
import { Tooltip } from './Tooltip.js';

/** An icon button that copies `text`; the icon turns into a check for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    if (!(await copyText(text))) {
      toast({ tone: 'error', message: 'Não foi possível copiar.' });
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Tooltip label={copied ? 'Copiado' : label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={() => void copy()}>
        {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </Tooltip>
  );
}
