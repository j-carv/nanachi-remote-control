import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ErrorNotice } from '../components/ErrorNotice.js';
import type { NanachiDesktopBridge } from './bridge.js';
import { parsePairingCode, type PairingCode } from './schema.js';
import { formatPairingCode, pairingCountdown } from './view.js';

interface PairingCodeBodyProps {
  code: PairingCode | null;
  loading: boolean;
  /** The code could not be generated. */
  failed: boolean;
  now: number;
}

/** Code, countdown and the way out when it fails. Presentational, so it renders without a bridge. */
export function PairingCodeBody({ code, loading, failed, now }: PairingCodeBodyProps) {
  const { t } = useTranslation('desktop');
  const countdown = code === null ? null : pairingCountdown(code.expiresAt, now);
  return (
    <div className="flex flex-col items-center gap-2 px-5 pt-4" data-slot="pairing-code">
      {code !== null && countdown !== null && (
        <>
          <p
            className="font-mono text-4xl font-semibold tracking-widest tabular-nums data-[expired=true]:text-muted-foreground"
            data-expired={countdown.expired}
            aria-label={t('pairing.codeLabel', { digits: code.code.split('').join(' ') })}
            data-slot="pairing-code-value"
          >
            {formatPairingCode(code.code)}
          </p>
          <p className="text-sm text-muted-foreground" role="timer" data-slot="pairing-code-countdown">
            {countdown.label}
          </p>
        </>
      )}
      {code === null && !failed && loading && (
        <p className="py-3 text-base text-muted-foreground" role="status">
          {t('pairing.generating')}
        </p>
      )}
      {failed && (
        <div className="w-full">
          <ErrorNotice message={t('pairing.failed')} />
        </div>
      )}
    </div>
  );
}

interface PairingCodeSheetProps {
  bridge: NanachiDesktopBridge;
  onClose(): void;
}

/** Folha com o código de 6 dígitos que o daemon aceita em "parear". Não há QR: a PWA não tem uma biblioteca de QR. */
export function PairingCodeSheet({ bridge, onClose }: PairingCodeSheetProps) {
  const { t } = useTranslation('desktop');
  const [code, setCode] = useState<PairingCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const generate = useCallback(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    bridge.pairingCode().then(
      (raw) => {
        if (!active) return;
        const parsed = parsePairingCode(raw);
        setCode(parsed);
        setNow(Date.now());
        setFailed(parsed === null);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  useEffect(() => generate(), [generate]);

  const expiresAt = code?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const expired = code !== null && pairingCountdown(code.expiresAt, now).expired;

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent size="sm" hideClose>
        <DrawerHeader>
          <DrawerTitle>{t('pairing.title')}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {t('pairing.description')}
          </DrawerDescription>
        </DrawerHeader>
        <PairingCodeBody code={code} loading={loading} failed={failed} now={now} />
        <DrawerFooter className="flex-row wide:justify-end wide:pt-2 wide:pb-5">
          <Button variant="secondary" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onClose}>
            {t('pairing.close')}
          </Button>
          <Button
            variant={expired || failed ? 'default' : 'outline'}
            size="compact"
            className="flex-1 wide:min-w-24 wide:flex-none"
            disabled={loading}
            onClick={() => void generate()}
          >
            {failed ? t('pairing.retry') : t('pairing.another')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
