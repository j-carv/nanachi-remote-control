import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../lib/clipboard.js';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { useToast } from './Toast.js';
import { Tooltip } from './Tooltip.js';

/** An icon button that copies `text`; the icon turns into a check for a moment, and the check pops in. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    if (!(await copyText(text))) {
      toast({ tone: 'error', message: t('common.copyFailed') });
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Tooltip label={copied ? t('common.copied') : label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={() => void copy()}>
        {/* Keyed on the state, so each copy replays the pop on the check. */}
        <span key={copied ? 'copied' : 'idle'} className={cx('grid place-items-center', copied && 'animate-pop')}>
          {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </span>
      </Button>
    </Tooltip>
  );
}
