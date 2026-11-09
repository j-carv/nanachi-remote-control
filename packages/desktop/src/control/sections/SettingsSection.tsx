import { Check, CircleAlert, Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Language } from '../../common/i18n/index.js';
import type { UpdateCheckResult } from '../../common/types.js';
import { useApi } from '../state/api.js';
import { useLanguageSetting } from '../state/language.js';
import { useReported } from '../state/reported.js';
import { useShell } from '../state/shell.js';
import { Button } from '../ui/Button.js';
import { LanguageSelect } from '../ui/LanguageSelect.js';
import { Group, Row, SectionHeading } from '../ui/Surface.js';
import { Switch } from '../ui/Switch.js';
import { useToast } from '../ui/Toast.js';
import { Page } from './Page.js';
import { WhisperSettings } from './WhisperSettings.js';
import { TranscriptionSettings } from './TranscriptionSettings.js';

export interface SettingsViewProps {
  /** Desktop's language, and the way to change it. `languageBusy`: a change is on its way to main. */
  language: Language;
  onLanguage: (language: Language) => void;
  languageBusy: boolean;
  version: string;
  dataFolder: string | null;
  autostart: { value: boolean; supported: boolean } | null;
  autostartBusy: boolean;
  onAutostart: (value: boolean) => void;
  whisper?: ReactNode;
  transcription?: ReactNode;
  update: UpdateCheckResult | null;
  checking: boolean;
  onCheckUpdate: () => void;
  onDownload: (url: string) => void;
  onOpenDataFolder: () => void;
  /** The uninstaller was just started: its window takes a moment to appear, and a second press would open a second one. */
  uninstalling: boolean;
  onUninstall: () => void;
}

function UpdateLine({ update }: { update: UpdateCheckResult | null }) {
  const { t } = useTranslation();
  if (!update) return <>{t('settings.updateIdle')}</>;
  switch (update.status) {
    case 'up-to-date':
      return (
        <span className="inline-flex items-center gap-1.5">
          <Check className="size-3.5 text-success" aria-hidden="true" />
          {t('settings.upToDate')}
        </span>
      );
    case 'available':
      return <span className="text-foreground">{t('settings.updateAvailable', { latest: update.latest, current: update.current })}</span>;
    case 'error':
      return (
        <span className="inline-flex items-center gap-1.5 text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {update.message}
        </span>
      );
  }
}

export function SettingsView({ language, onLanguage, languageBusy, version, dataFolder, autostart, autostartBusy, onAutostart, whisper, transcription, update, checking, onCheckUpdate, onDownload, onOpenDataFolder, uninstalling, onUninstall }: SettingsViewProps) {
  const { t } = useTranslation();
  return (
    <>
      <section aria-labelledby="settings-general">
        <SectionHeading id="settings-general">{t('settings.general')}</SectionHeading>
        <Group>
          <Row
            title={t('settings.languageTitle')}
            id="settings-language"
            description={t('settings.languageDescription')}
            trailing={<LanguageSelect value={language} onChange={onLanguage} disabled={languageBusy} labelledBy="settings-language" />}
          />
          <Row
            title={t('settings.autostart')}
            id="settings-autostart"
            description={autostart && !autostart.supported ? t('settings.autostartUnsupported') : t('settings.autostartHint')}
            trailing={
              <Switch
                checked={autostart?.value ?? false}
                disabled={autostart === null || !autostart.supported || autostartBusy}
                labelledBy="settings-autostart"
                onCheckedChange={onAutostart}
              />
            }
          />
        </Group>
      </section>

      {transcription}

      {whisper}

      <section aria-labelledby="settings-updates">
        <SectionHeading id="settings-updates">{t('settings.updates')}</SectionHeading>
        <Group>
          <Row
            title={<span className="tabular-nums">{t('settings.version', { version })}</span>}
            description={<UpdateLine update={update} />}
            trailing={
              <>
                {update?.status === 'available' ? (
                  <Button variant="primary" icon={<Download aria-hidden="true" />} onClick={() => onDownload(update.url)}>
                    {t('settings.download')}
                  </Button>
                ) : null}
                <Button icon={<RefreshCw className={checking ? 'animate-spin' : undefined} aria-hidden="true" />} disabled={checking} onClick={onCheckUpdate}>
                  {t('settings.checkUpdates')}
                </Button>
              </>
            }
          />
        </Group>
      </section>

      <section aria-labelledby="settings-data">
        <SectionHeading id="settings-data">{t('settings.data')}</SectionHeading>
        <Group>
          <Row
            icon={FolderOpen}
            title={t('common.dataFolder')}
            description={<span className="selectable block truncate font-mono text-[12px]">{dataFolder ?? t('settings.dataUnavailable')}</span>}
            trailing={
              <Button disabled={dataFolder === null} onClick={onOpenDataFolder}>
                {t('common.openFolder')}
              </Button>
            }
          />
        </Group>
      </section>

      <section aria-labelledby="settings-remove">
        <SectionHeading id="settings-remove">{t('settings.remove')}</SectionHeading>
        <Group>
          <Row
            icon={Trash2}
            title={t('settings.uninstallTitle')}
            description={t('settings.uninstallHint')}
            trailing={
              <Button variant="danger-ghost" disabled={uninstalling} onClick={onUninstall}>
                {t('settings.uninstall')}
              </Button>
            }
          />
        </Group>
      </section>
    </>
  );
}

export function SettingsSection() {
  const { t } = useTranslation();
  const api = useApi();
  const languageSetting = useLanguageSetting();
  const shell = useShell();
  const toast = useToast();
  const reported = useReported();
  const [autostart, setAutostart] = useState<{ value: boolean; supported: boolean } | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  // The last check lives in the shell, so a result survives a switch of section.
  const { updateCheck: update, setUpdateCheck: setUpdate } = shell;
  const [checking, setChecking] = useState(false);
  const uninstallGuard = shell.uninstallGuard;

  useEffect(() => {
    let active = true;
    api.settings
      .getAutostart()
      .then((state) => {
        if (active) setAutostart(state);
      })
      .catch(() => {
        if (active) setAutostart({ value: false, supported: false });
      });
    return () => {
      active = false;
    };
  }, [api]);

  const { change } = languageSetting;
  const changeLanguage = async (next: Language): Promise<void> => {
    if (!(await change(next))) toast({ tone: 'error', message: t('settings.languageFailed') });
  };

  const changeAutostart = async (value: boolean): Promise<void> => {
    setAutostartBusy(true);
    try {
      setAutostart(await api.settings.setAutostart(value));
    } catch {
      toast({ tone: 'error', message: t('settings.autostartFailed') });
    } finally {
      setAutostartBusy(false);
    }
  };

  const checkUpdate = async (): Promise<void> => {
    setChecking(true);
    try {
      setUpdate(await api.settings.checkForUpdate());
    } catch {
      setUpdate({ status: 'error', current: version, message: t('settings.checkFailed') });
    } finally {
      setChecking(false);
    }
  };

  // The uninstaller's own window opens a few seconds after the click; until then the button stays off. The guard lives in the
  // shell and is set synchronously, so two clicks in the same frame cannot both get through.
  const uninstall = (): void => {
    if (!uninstallGuard.press()) return;
    reported(() => api.settings.uninstall(), t('settings.uninstallFailed'));
  };

  const overview = shell.overview.status === 'ready' ? shell.overview.data : null;
  const version = overview?.appVersion ?? api.version;

  return (
    <Page section="settings">
      <SettingsView
        language={languageSetting.language}
        onLanguage={(next) => void changeLanguage(next)}
        languageBusy={languageSetting.busy}
        version={version}
        dataFolder={overview?.dataFolder ?? null}
        autostart={autostart}
        autostartBusy={autostartBusy}
        onAutostart={(value) => void changeAutostart(value)}
        transcription={<TranscriptionSettings />}
        whisper={<WhisperSettings />}
        update={update}
        checking={checking}
        onCheckUpdate={() => void checkUpdate()}
        onDownload={(url) => reported(() => api.settings.openUpdate(url), t('settings.openUpdateFailed'))}
        onOpenDataFolder={() => reported(() => api.openDataFolder(), t('common.openDataFolderFailed'))}
        uninstalling={uninstallGuard.active}
        onUninstall={uninstall}
      />
    </Page>
  );
}
