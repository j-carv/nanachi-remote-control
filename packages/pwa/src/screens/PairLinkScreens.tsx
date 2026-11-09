import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Screen } from '../components/Screen.js';

/** Shown while the code of a pair link is exchanged for a token. It has no controls: the attempt runs once. */
export function PairConnecting() {
  const { t } = useTranslation('pairing');
  return (
    <Screen className="justify-center text-center">
      <p role="status" className="flex items-center justify-center gap-3 text-base text-muted-foreground">
        <LoaderCircle className="size-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {t('link.connecting')}
      </p>
    </Screen>
  );
}

interface PairInstallGuideProps {
  /** Pairs in Safari instead, with the code filled in on the normal pairing screen. */
  onContinue(): void;
}

/**
 * iOS in Safari: how to add the app to the Home Screen. The code is not used here, because the installed app cannot
 * see what Safari stored. The guide does not show the code either (the maintainer's decision).
 */
export function PairInstallGuide({ onContinue }: PairInstallGuideProps) {
  const { t } = useTranslation('pairing');
  return (
    <Screen className="gap-6">
      <header className="flex flex-col gap-2 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('link.installTitle')}</h1>
        <p className="text-base leading-6 text-muted-foreground">{t('link.installIntro')}</p>
      </header>

      <ol className="flex list-decimal flex-col gap-3 pl-5 text-base leading-6">
        <li>{t('link.installStep1')}</li>
        <li>{t('link.installStep2')}</li>
        <li>{t('link.installStep3')}</li>
      </ol>

      <Button variant="ghost" size="wide" type="button" onClick={onContinue}>
        {t('link.installContinue')}
      </Button>
    </Screen>
  );
}
