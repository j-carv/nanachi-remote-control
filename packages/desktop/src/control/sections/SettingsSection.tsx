import { Check, CircleAlert, Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UpdateCheckResult } from '../../common/types.js';
import { useApi } from '../state/api.js';
import { useReported } from '../state/reported.js';
import { useShell } from '../state/shell.js';
import { Button } from '../ui/Button.js';
import { Group, Row, SectionHeading } from '../ui/Surface.js';
import { Switch } from '../ui/Switch.js';
import { useToast } from '../ui/Toast.js';
import { Page } from './Page.js';

/** How long the uninstall button stays off after it was pressed. */
const UNINSTALL_GUARD_MS = 8000;

export interface SettingsViewProps {
  version: string;
  dataFolder: string | null;
  autostart: { value: boolean; supported: boolean } | null;
  autostartBusy: boolean;
  onAutostart: (value: boolean) => void;
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
  if (!update) return <>Procura no GitHub se há uma versão nova do Nanachi.</>;
  switch (update.status) {
    case 'up-to-date':
      return (
        <span className="inline-flex items-center gap-1.5">
          <Check className="size-3.5 text-success" aria-hidden="true" />
          Você está na versão mais recente.
        </span>
      );
    case 'available':
      return <span className="text-foreground">{`A versão ${update.latest} está disponível. Você tem a ${update.current}.`}</span>;
    case 'error':
      return (
        <span className="inline-flex items-center gap-1.5 text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {update.message}
        </span>
      );
  }
}

export function SettingsView({ version, dataFolder, autostart, autostartBusy, onAutostart, update, checking, onCheckUpdate, onDownload, onOpenDataFolder, uninstalling, onUninstall }: SettingsViewProps) {
  return (
    <>
      <section aria-labelledby="settings-general">
        <SectionHeading id="settings-general">Geral</SectionHeading>
        <Group>
          <Row
            title="Iniciar com o Windows"
            id="settings-autostart"
            description={autostart && !autostart.supported ? 'Não está disponível nesta instalação.' : 'O Nanachi abre na bandeja quando você entra no Windows.'}
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

      <section aria-labelledby="settings-updates">
        <SectionHeading id="settings-updates">Atualizações</SectionHeading>
        <Group>
          <Row
            title={<span className="tabular-nums">Versão {version}</span>}
            description={<UpdateLine update={update} />}
            trailing={
              <>
                {update?.status === 'available' ? (
                  <Button variant="primary" icon={<Download aria-hidden="true" />} onClick={() => onDownload(update.url)}>
                    Baixar
                  </Button>
                ) : null}
                <Button icon={<RefreshCw className={checking ? 'animate-spin' : undefined} aria-hidden="true" />} disabled={checking} onClick={onCheckUpdate}>
                  Verificar atualizações
                </Button>
              </>
            }
          />
        </Group>
      </section>

      <section aria-labelledby="settings-data">
        <SectionHeading id="settings-data">Dados</SectionHeading>
        <Group>
          <Row
            icon={FolderOpen}
            title="Pasta de dados"
            description={<span className="selectable block truncate font-mono text-[12px]">{dataFolder ?? 'Indisponível'}</span>}
            trailing={
              <Button disabled={dataFolder === null} onClick={onOpenDataFolder}>
                Abrir pasta
              </Button>
            }
          />
        </Group>
      </section>

      <section aria-labelledby="settings-remove">
        <SectionHeading id="settings-remove">Remover</SectionHeading>
        <Group>
          <Row
            icon={Trash2}
            title="Desinstalar o Nanachi"
            description="Abre a janela de remoção, que pede a sua confirmação. Seus dados só são apagados se você marcar isso lá."
            trailing={
              <Button variant="danger-ghost" disabled={uninstalling} onClick={onUninstall}>
                Desinstalar…
              </Button>
            }
          />
        </Group>
      </section>
    </>
  );
}

export function SettingsSection() {
  const api = useApi();
  const shell = useShell();
  const toast = useToast();
  const reported = useReported();
  const [autostart, setAutostart] = useState<{ value: boolean; supported: boolean } | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const uninstallStarted = useRef(false);
  const uninstallTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (uninstallTimer.current !== null) window.clearTimeout(uninstallTimer.current);
    },
    [],
  );

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

  const changeAutostart = async (value: boolean): Promise<void> => {
    setAutostartBusy(true);
    try {
      setAutostart(await api.settings.setAutostart(value));
    } catch {
      toast({ tone: 'error', message: 'Não foi possível mudar o início com o Windows.' });
    } finally {
      setAutostartBusy(false);
    }
  };

  const checkUpdate = async (): Promise<void> => {
    setChecking(true);
    try {
      setUpdate(await api.settings.checkForUpdate());
    } catch {
      setUpdate({ status: 'error', current: version, message: 'Não foi possível consultar as atualizações agora.' });
    } finally {
      setChecking(false);
    }
  };

  // The uninstaller's own window opens a few seconds after the click; until then the button stays off (a ref as well as
  // state, so two clicks in the same frame cannot both get through).
  const uninstall = (): void => {
    if (uninstallStarted.current) return;
    uninstallStarted.current = true;
    setUninstalling(true);
    reported(() => api.settings.uninstall(), 'Não foi possível iniciar o desinstalador.');
    uninstallTimer.current = window.setTimeout(() => {
      uninstallStarted.current = false;
      setUninstalling(false);
    }, UNINSTALL_GUARD_MS);
  };

  const overview = shell.overview.status === 'ready' ? shell.overview.data : null;
  const version = overview?.appVersion ?? api.version;

  return (
    <Page section="settings">
      <SettingsView
        version={version}
        dataFolder={overview?.dataFolder ?? null}
        autostart={autostart}
        autostartBusy={autostartBusy}
        onAutostart={(value) => void changeAutostart(value)}
        update={update}
        checking={checking}
        onCheckUpdate={() => void checkUpdate()}
        onDownload={(url) => reported(() => api.settings.openUpdate(url), 'Não foi possível abrir a página da atualização.')}
        onOpenDataFolder={() => reported(() => api.openDataFolder(), 'Não foi possível abrir a pasta de dados.')}
        uninstalling={uninstalling}
        onUninstall={uninstall}
      />
    </Page>
  );
}
