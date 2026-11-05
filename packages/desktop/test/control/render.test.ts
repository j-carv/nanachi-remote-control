import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentAccountsInfo, ControlSection, DeviceInfo, DriveInfo, FoldersState } from '../../src/common/control-api.js';
import type { DaemonStatus, TailscaleStatus } from '../../src/common/types.js';
import { MissingBridge } from '../../src/control/MissingBridge.js';
import { AccountsView } from '../../src/control/sections/AccountsSection.js';
import { DevicesTable, PairingView, sortDevices } from '../../src/control/sections/DevicesSection.js';
import { DriveTile, FolderRow, FoldersView, SaveBar } from '../../src/control/sections/FoldersSection.js';
import { LogsView } from '../../src/control/sections/LogsSection.js';
import { OverviewView } from '../../src/control/sections/OverviewSection.js';
import { RestartDialog } from '../../src/control/sections/RestartDialog.js';
import { SettingsView } from '../../src/control/sections/SettingsSection.js';
import { TailscaleView } from '../../src/control/sections/TailscaleSection.js';
import { Sidebar } from '../../src/control/shell/Sidebar.js';
import { TitleBarView } from '../../src/control/shell/TitleBar.js';
import { buildDraftEntries } from '../../src/control/lib/roots.js';
import { Dialog } from '../../src/control/ui/Dialog.js';
import { ErrorState } from '../../src/control/ui/States.js';
import { Switch } from '../../src/control/ui/Switch.js';
import { html } from './render-helpers.js';

const noop = (): void => undefined;

const DAEMON: DaemonStatus = {
  state: 'running',
  port: 7780,
  mode: 'spawned',
  pid: 4242,
  version: '0.1.0',
  machineName: 'OFFICE-PC',
  restricted: false,
  message: null,
  logTail: [],
};

describe('title bar', () => {
  const view = (extra: Partial<Parameters<typeof TitleBarView>[0]> = {}): string =>
    html(
      createElement(TitleBarView, {
        machineName: 'OFFICE-PC',
        daemon: DAEMON,
        windowState: { maximized: false, focused: true },
        onMinimize: noop,
        onToggleMaximize: noop,
        onClose: noop,
        onOpenStatus: noop,
        ...extra,
      }),
    );

  it('has the three window buttons with Portuguese labels, a drag region and the daemon status', () => {
    const markup = view();
    expect(markup).toContain('app-drag');
    expect(markup).toContain('aria-label="Minimizar"');
    expect(markup).toContain('aria-label="Maximizar"');
    expect(markup).toContain('aria-label="Fechar"');
    expect(markup).toContain('OFFICE-PC');
    expect(markup).toContain('Rodando');
    expect(markup).toContain('data-focused="true"');
  });

  it('the maximize button becomes "Restaurar" when maximized, and the bar knows when it is unfocused', () => {
    const markup = view({ windowState: { maximized: true, focused: false } });
    expect(markup).toContain('aria-label="Restaurar"');
    expect(markup).not.toContain('aria-label="Maximizar"');
    expect(markup).toContain('data-focused="false"');
  });

  it('draws tooltips itself (a portal) outside Sessões: no native title attributes', () => {
    expect(view()).not.toContain('title=');
  });

  it('on Sessões the window buttons have native titles: a tooltip below the bar would be painted under the PWA view', () => {
    const markup = view({ nativeTips: true });
    expect(markup).toContain('title="Minimizar"');
    expect(markup).toContain('title="Maximizar"');
    expect(markup).toContain('title="Fechar. O Nanachi continua rodando na bandeja."');
    expect(view({ nativeTips: true, windowState: { maximized: true, focused: true } })).toContain('title="Restaurar"');
  });

  it('without a daemon status there is no status button', () => {
    expect(view({ daemon: null, machineName: null })).not.toContain('Abrir visão geral');
  });
});

describe('sidebar', () => {
  const view = (extra: Partial<Parameters<typeof Sidebar>[0]> = {}): string =>
    html(
      createElement(Sidebar, {
        section: 'folders',
        collapsed: false,
        dirty: new Set<ControlSection>(),
        version: '0.1.0',
        onSelect: noop,
        onToggle: noop,
        sessionsOpen: false,
        ...extra,
      }),
    );

  it('lists the eight sections in order, marks the current one and carries the shortcuts', () => {
    const markup = view();
    const labels = ['Visão geral', 'Pastas e discos', 'Aparelhos', 'Contas dos agentes', 'Tailscale', 'Logs', 'Ajustes', 'Sessões'];
    const positions = labels.map((label) => markup.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toContain('aria-keyshortcuts="Control+7"');
    expect(markup).toContain('aria-keyshortcuts="Control+8"');
    // Sessões is a section like the others: there is no second way in at the bottom.
    expect(markup).not.toContain('Abrir sessões');
    expect(markup).toContain('Versão 0.1.0');
    expect(markup).toContain('width:232px');
  });

  it('collapsed: 64 px, icon-only, every item still has its accessible name', () => {
    const markup = view({ collapsed: true });
    expect(markup).toContain('width:64px');
    expect(markup).toContain('aria-label="Visão geral"');
    expect(markup).not.toContain('Abrir sessões');
    expect(markup).not.toContain('Versão 0.1.0');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('draws tooltips itself (a portal) outside Sessões: no native title attributes', () => {
    expect(view({ collapsed: true })).not.toContain('title=');
    expect(view()).not.toContain('title=');
  });

  it('on Sessões it is the 64 px rail whatever was saved, with nothing to toggle, and the saved choice is untouched', () => {
    for (const collapsed of [false, true]) {
      const markup = view({ section: 'sessions', collapsed, sessionsOpen: true });
      expect(markup).toContain('width:64px');
      expect(markup).not.toContain('width:232px');
      expect(markup).not.toContain('Versão 0.1.0');
      expect(markup).not.toContain('aria-controls="sidebar"');
      expect(markup).not.toContain('Recolher a barra lateral');
      expect(markup).not.toContain('Expandir a barra lateral');
      // Still named for the keyboard and for screen readers.
      expect(markup).toContain('aria-label="Visão geral"');
      expect(markup).toContain('aria-label="Sessões"');
    }
  });

  it('on Sessões its tooltips are native titles (the PWA view is painted over a portal), with the shortcut', () => {
    const markup = view({ section: 'sessions', sessionsOpen: true, dirty: new Set<ControlSection>(['folders']) });
    expect(markup).toContain('title="Visão geral (Ctrl+1)"');
    expect(markup).toContain('title="Sessões (Ctrl+8)"');
    expect(markup).toContain('title="Pastas e discos (alterações não salvas) (Ctrl+2)"');
  });

  it('shows and announces unsaved edits on the folders item', () => {
    expect(view({ dirty: new Set<ControlSection>(['folders']) })).toContain('alterações não salvas');
    expect(view()).not.toContain('alterações não salvas');
  });
});

describe('folders editor', () => {
  const drive = (extra: Partial<DriveInfo> = {}): DriveInfo => ({ root: 'D:\\', label: 'Dados', kind: 'fixed', totalBytes: 1000 * 1024 ** 3, freeBytes: 400 * 1024 ** 3, ...extra });

  it('drive tile: letter, label, usage in pt-BR and a switch that follows the draft', () => {
    const off = html(createElement(DriveTile, { drive: drive(), paths: ['C:\\a'], editable: true, onToggle: noop }));
    expect(off).toContain('D:');
    expect(off).toContain('Dados');
    expect(off).toContain('400 GB');
    expect(off).toContain('livres de');
    expect(off).toContain('Permitir o disco inteiro');
    expect(off).toContain('aria-checked="false"');
    const on = html(createElement(DriveTile, { drive: drive(), paths: ['d:\\', 'D:\\Trabalho'], editable: true, onToggle: noop }));
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('1 pasta já incluída');
    expect(html(createElement(DriveTile, { drive: drive(), paths: ['D:\\Trabalho'], editable: true, onToggle: noop }))).toContain('1 pasta liberada neste disco');
  });

  it('drive tile: read-only disables the switch; an unknown size says so', () => {
    const markup = html(createElement(DriveTile, { drive: drive({ totalBytes: null, freeBytes: null, kind: 'network' }), paths: [], editable: false, onToggle: noop }));
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Tamanho indisponível');
    expect(markup).toContain('Rede');
  });

  const saved = [
    { path: 'C:\\Projetos', exists: true, coveredBy: null },
    { path: 'E:\\Antigos', exists: false, coveredBy: null },
  ];
  const rows = buildDraftEntries(saved, ['C:\\Projetos', 'E:\\Antigos', 'C:\\Projetos\\novo']);

  it('folder rows flag missing, new and covered folders, and the path stays in mono with the name last', () => {
    const covered = html(createElement(FolderRow, { entry: rows[2]!, editable: true, onReveal: noop, onRemove: noop }));
    expect(covered).toContain('Nova');
    expect(covered).toContain('Dentro de Projetos');
    expect(covered).toContain('font-mono');
    expect(covered).toContain('aria-label="Remover C:\\Projetos\\novo"');
    const missing = html(createElement(FolderRow, { entry: rows[1]!, editable: true, onReveal: noop, onRemove: noop }));
    expect(missing).toContain('Não encontrada');
    expect(missing).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Mostrar E:\\Antigos no Explorer"/);
  });

  it('read-only rows have no remove button but can still be revealed', () => {
    const markup = html(createElement(FolderRow, { entry: rows[0]!, editable: false, onReveal: noop, onRemove: noop }));
    expect(markup).not.toContain('Remover');
    expect(markup).toContain('no Explorer');
  });

  const state = (extra: Partial<FoldersState> = {}): FoldersState => ({
    roots: saved,
    rootsUnknown: false,
    drives: [drive()],
    editable: true,
    restartPending: false,
    busySessions: 0,
    ...extra,
  });
  const base = {
    entries: rows,
    paths: rows.map((row) => row.path),
    changes: { added: [], removed: [], dirty: false },
    saving: false,
    restarting: false,
    onPick: noop,
    onRemove: noop,
    onToggleDrive: noop,
    onReveal: noop,
    onDiscard: noop,
    onSave: noop,
    onRestartNow: noop,
  };

  it('explains the scope, lists the drives and the folders, and has no save bar while clean', () => {
    const markup = html(createElement(FoldersView, { ...base, state: state() }));
    expect(markup).toContain('O Nanachi só abre sessões dentro destas pastas.');
    expect(markup).toContain('Não é um sandbox');
    expect(markup).toContain('Pastas permitidas · 3');
    expect(markup).toContain('Adicionar pastas');
    expect(markup).not.toContain('Alterações não salvas');
  });

  it('empty list warns that no workspace can be added', () => {
    const markup = html(createElement(FoldersView, { ...base, entries: [], paths: [], state: state({ roots: [] }) }));
    expect(markup).toContain('Nenhuma pasta permitida');
    expect(markup).toContain('nenhum workspace pode ser adicionado');
  });

  it('read-only: explains why and offers no editing', () => {
    const markup = html(createElement(FoldersView, { ...base, state: state({ editable: false }) }));
    expect(markup).toContain('Somente leitura');
    expect(markup).toContain('Esta é a lista que esse daemon usa');
    expect(markup).not.toContain('Adicionar pastas');
  });

  it('an attached daemon whose list could not be read says so, and does not call Desktop\'s own list that daemon\'s', () => {
    const markup = html(createElement(FoldersView, { ...base, entries: [], paths: [], state: state({ editable: false, rootsUnknown: true, roots: [] }) }));
    expect(markup).toContain('Lista indisponível');
    expect(markup).toContain('não conseguiu perguntar');
    // Neither the "this is the list" claim nor the empty-list warning (which would say no workspace can be added).
    expect(markup).not.toContain('Esta é a lista que esse daemon usa');
    expect(markup).not.toContain('Nenhuma pasta permitida');
    expect(markup).not.toContain('nenhum workspace pode ser adicionado');
    expect(markup).not.toContain('Adicionar pastas');
  });

  it('an unknown list never offers the restart that belongs to a saved one', () => {
    const markup = html(createElement(FoldersView, { ...base, entries: [], paths: [], state: state({ editable: false, rootsUnknown: true, roots: [], restartPending: true }) }));
    expect(markup).not.toContain('Salvo, mas ainda não aplicado');
  });

  it('a saved list that the daemon does not use yet offers a restart', () => {
    const markup = html(createElement(FoldersView, { ...base, state: state({ restartPending: true }) }));
    expect(markup).toContain('Salvo, mas ainda não aplicado');
    expect(markup).toContain('Reiniciar agora');
  });

  it('the sticky bar summarises the changes with Descartar and Salvar', () => {
    const markup = html(createElement(SaveBar, { changes: { added: ['x', 'y'], removed: ['z'], dirty: true }, saving: false, busySessions: 0, onDiscard: noop, onSave: noop }));
    expect(markup).toContain('Alterações não salvas');
    expect(markup).toContain('2 adicionadas e 1 removida');
    expect(markup).toContain('Descartar');
    expect(markup).toContain('Salvar');
    expect(markup).toContain('o daemon reinicia e as sessões ficam paradas até você enviar uma mensagem');
    const busy = html(createElement(SaveBar, { changes: { added: ['x'], removed: [], dirty: true }, saving: false, busySessions: 2, onDiscard: noop, onSave: noop }));
    expect(busy).toContain('você escolhe se o daemon reinicia agora');
    expect(html(createElement(FoldersView, { ...base, state: state(), changes: { added: ['x'], removed: [], dirty: true } }))).toContain('1 pasta adicionada');
  });

  it('the restart dialog names the sessions it would interrupt and offers both outcomes', () => {
    const save = html(createElement(RestartDialog, { open: true, mode: 'save', busySessions: 2, busy: false, onCancel: noop, onLater: noop, onNow: noop }));
    expect(save).toContain('Há 2 sessões em andamento, que serão interrompidas.');
    expect(save).toContain('todas as sessões, em andamento ou não, ficam paradas e voltam quando você enviar uma mensagem nelas');
    expect(save).toContain('Salvar e aplicar depois');
    expect(save).toContain('Salvar e reiniciar agora');
    const restart = html(createElement(RestartDialog, { open: true, mode: 'restart', busySessions: 1, busy: false, onCancel: noop, onLater: noop, onNow: noop }));
    expect(restart).toContain('Há 1 sessão em andamento, que será interrompida.');
    expect(restart).not.toContain('Salvar e aplicar depois');
    expect(html(createElement(RestartDialog, { open: false, mode: 'save', busySessions: 2, busy: false, onCancel: noop, onLater: noop, onNow: noop }))).not.toContain('Há 2');
    const idle = html(createElement(RestartDialog, { open: true, mode: 'restart', busySessions: 0, busy: false, onCancel: noop, onLater: noop, onNow: noop }));
    expect(idle).not.toContain('Há ');
    expect(idle).toContain('ficam paradas e voltam quando você enviar uma mensagem nelas');
  });
});

describe('devices', () => {
  const NOW = 1_700_000_000_000;
  const devices: DeviceInfo[] = [
    { id: 'old', name: 'iPad antigo', createdAt: NOW - 90 * 86_400_000, lastSeenAt: NOW - 12 * 86_400_000, revoked: true, isThisApp: false },
    { id: 'self', name: 'Nanachi Desktop (PC)', createdAt: NOW - 86_400_000, lastSeenAt: NOW - 5_000, revoked: false, isThisApp: true },
    { id: 'phone', name: 'iPhone da Ana', createdAt: NOW - 20 * 86_400_000, lastSeenAt: NOW - 3 * 60_000, revoked: false, isThisApp: false },
    { id: 'never', name: 'Navegador', createdAt: NOW - 3 * 86_400_000, lastSeenAt: null, revoked: false, isThisApp: false },
  ];

  it('active devices first (most recently used first), revoked last', () => {
    expect(sortDevices(devices).map((device) => device.id)).toEqual(['self', 'phone', 'never', 'old']);
  });

  it('table: this app is badged and cannot be revoked, revoked devices have no action, the rest can', () => {
    const markup = html(createElement(DevicesTable, { devices: sortDevices(devices), now: NOW, onRevoke: noop }));
    expect(markup).toContain('Este app');
    expect(markup).toContain('há 3 min');
    expect(markup).toContain('Nunca');
    expect(markup).toContain('Revogado');
    expect(markup).toContain('aria-label="Revogar iPhone da Ana"');
    expect(markup).toContain('aria-label="Revogar Navegador"');
    expect(markup).not.toContain('aria-label="Revogar Nanachi Desktop (PC)"');
    expect(markup).not.toContain('aria-label="Revogar iPad antigo"');
    expect(markup).toContain('scope="col"');
  });

  it('pairing: the code in two blocks with its countdown, and expiry as a state', () => {
    const live = html(createElement(PairingView, { code: '482915', remainingMs: 272_000, fraction: 0.9, regenerating: false, onRegenerate: noop, onClose: noop }));
    expect(live).toContain('482 915');
    expect(live).toContain('Expira em 4:32');
    expect(live).toContain('Gerar outro');
    expect(live).toContain('aria-label="Copiar código"');
    const dead = html(createElement(PairingView, { code: '482915', remainingMs: 0, fraction: 0, regenerating: false, onRegenerate: noop, onClose: noop }));
    expect(dead).toContain('Expirou');
    expect(dead).toContain('Gerar novo código');
    expect(dead).not.toContain('aria-label="Copiar código"');
  });
});

describe('error states', () => {
  it('a real failure alerts, with the title of its code and the way out', () => {
    const markup = html(createElement(ErrorState, { error: { ok: false, code: 'daemon_unavailable', message: 'O daemon não respondeu.' }, onRetry: noop }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('O daemon não está respondendo');
    expect(markup).toContain('O daemon não respondeu.');
    expect(markup).toContain('Tentar de novo');
    expect(markup).toContain('data-calm="false"');
  });

  it.each(['not_paired', 'unauthorized', 'not_own_daemon'] as const)('%s (an attached daemon) is explained calmly, without an alert', (code) => {
    const markup = html(createElement(ErrorState, { error: { ok: false, code, message: 'Mensagem de main.' }, onRetry: noop }));
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('data-calm="true"');
    expect(markup).toContain('Mensagem de main.');
    expect(markup).toContain('o resto do painel continua funcionando');
  });
});

describe('accounts', () => {
  const agents: AgentAccountsInfo[] = [
    {
      agentId: 'claude',
      agentName: 'Claude Code',
      multiAccount: true,
      accounts: [
        { id: 'default', name: 'Principal', principal: true, active: true, status: 'logged_in', identity: 'eu@exemplo.com' },
        { id: 'work', name: 'Trabalho', principal: false, active: false, status: 'logged_in', identity: 'trabalho@exemplo.com' },
        { id: 'old', name: 'Antiga', principal: false, active: false, status: 'logged_out', identity: null },
      ],
    },
    { agentId: 'omp', agentName: 'Oh My Pi', multiAccount: false, accounts: [{ id: 'default', name: 'Principal', principal: true, active: true, status: 'logged_in', identity: null }] },
  ];

  it('"Usar em novas sessões" only for a logged-in account that is not in use, in agents with several accounts', () => {
    const markup = html(createElement(AccountsView, { agents, settingActive: null, onSetActive: noop, onOpenSessions: noop }));
    expect(markup.match(/Usar em novas sessões/g)).toHaveLength(1);
    expect(markup).toContain('Em uso');
    expect(markup).toContain('Sem login');
    expect(markup).toContain('Só a conta principal');
    expect(markup).toContain('use o app de sessões');
  });

  it('no agents is an empty state, not a blank page', () => {
    expect(html(createElement(AccountsView, { agents: [], settingActive: null, onSetActive: noop, onOpenSessions: noop }))).toContain('Nenhum agente configurado');
  });
});

describe('overview', () => {
  const info = (daemon: Partial<DaemonStatus> = {}, tailscale: TailscaleStatus = { state: 'off' }, activity: { workspaces: number; sessions: number; busySessions: number; devices: number } | null = { workspaces: 4, sessions: 12, busySessions: 2, devices: 3 }) => ({
    daemon: { ...DAEMON, ...daemon },
    tailscale,
    activity,
    dataFolder: 'C:\\Users\\user\\.nanachi-desktop',
    appVersion: '0.1.0',
  });
  const render = (data: ReturnType<typeof info>): string =>
    html(createElement(OverviewView, { info: data, restarting: false, tailscaleBusy: false, onRestart: noop, onStartTailscale: noop, onTailscaleLogin: noop, onNavigate: noop, onOpenDataFolder: noop }));

  it('daemon card: state, port, version, pid and a restart button when Desktop owns it', () => {
    const markup = render(info());
    expect(markup).toContain('Rodando');
    expect(markup).toContain('7780');
    expect(markup).toContain('0.1.0');
    expect(markup).toContain('4242');
    expect(markup).toContain('Reiniciar');
    expect(markup).toContain('Abrir pasta');
    expect(markup).toContain('C:\\Users\\user\\.nanachi-desktop');
  });

  it('an attached daemon cannot be restarted from here', () => {
    const markup = render(info({ state: 'attached', mode: 'attached', pid: null }));
    expect(markup).toContain('Conectado');
    expect(markup).not.toContain('Reiniciar');
    expect(markup).not.toContain('Tentar de novo');
    expect(markup).not.toContain('Iniciar</span>');
  });

  it('after a failure or a stop (nothing owned any more) there is still a way to try again', () => {
    const failed = render(info({ state: 'error', mode: 'none', pid: null, message: 'A porta 7780 está ocupada.' }));
    expect(failed).toContain('Tentar de novo');
    expect(failed).not.toContain('Reiniciar');
    const stopped = render(info({ state: 'stopped', mode: 'none', pid: null }));
    expect(stopped).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Iniciar<\/button>/s);
    expect(stopped).not.toContain('Reiniciar');
  });

  it('tailscale row follows the node: off offers "Ligar", needs_login the login, running the address and a copy button', () => {
    expect(render(info())).toContain('Ligar');
    expect(render(info({}, { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' }))).toContain('Entrar no Tailscale');
    const running = render(info({}, { state: 'running', dnsName: 'pc.tail1.ts.net', tailnet: 't', ips: ['100.1.1.1'] }));
    expect(running).toContain('https://pc.tail1.ts.net');
    expect(running).toContain('aria-label="Copiar endereço"');
  });

  it('activity: counts, the busy badge and the link to devices; unknown activity is a notice, not zeros', () => {
    const markup = render(info());
    expect(markup).toContain('Workspaces');
    expect(markup).toContain('2 em andamento');
    expect(markup).toContain('Aparelhos pareados');
    expect(render(info({}, { state: 'off' }, null))).toContain('não estão disponíveis agora');
    expect(render(info({}, { state: 'off' }, null))).not.toContain('Workspaces');
  });

  it('restricted and error daemons explain themselves', () => {
    expect(render(info({ restricted: true }))).toContain('Acesso local bloqueado');
    const failed = render(info({ state: 'error', message: 'A porta 7780 está ocupada.', logTail: ['linha um', 'linha dois'] }));
    expect(failed).toContain('O daemon não conseguiu iniciar');
    expect(failed).toContain('A porta 7780 está ocupada.');
    expect(failed).toContain('linha dois');
  });
});

describe('tailscale', () => {
  const view = (status: TailscaleStatus): string => html(createElement(TailscaleView, { status, busy: false, onToggle: noop, onLogin: noop, onRetry: noop }));

  it('off: the switch is off and nothing else is offered', () => {
    const markup = view({ state: 'off' });
    expect(markup).toContain('Desligado');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).not.toContain('Entrar no Tailscale');
    expect(markup).toContain('MagicDNS');
  });

  it('needs_login: the login action', () => {
    const markup = view({ state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' });
    expect(markup).toContain('Falta entrar na sua conta do Tailscale');
    expect(markup).toContain('Entrar no Tailscale');
    expect(markup).not.toContain('login.tailscale.com');
  });

  it('running: address, tailnet, IPs and the steps for the phone', () => {
    const markup = view({ state: 'running', dnsName: 'pc.tail1.ts.net', tailnet: 'user@example.com', ips: ['100.64.0.1', 'fd7a::1'] });
    expect(markup).toContain('https://pc.tail1.ts.net');
    expect(markup).toContain('user@example.com');
    expect(markup).toContain('100.64.0.1');
    expect(markup).toContain('No dispositivo móvel');
    expect(markup).toContain('aria-checked="true"');
  });

  it('error: the message and a retry', () => {
    const markup = view({ state: 'error', message: 'sem rede' });
    expect(markup).toContain('sem rede');
    expect(markup).toContain('Tentar de novo');
  });
});

describe('logs', () => {
  const logs = { daemon: ['[daemon] pronto', 'ERROR algo falhou'], tailscale: [] };
  const view = (extra: Partial<Parameters<typeof LogsView>[0]> = {}): string =>
    html(createElement(LogsView, { logs, tab: 'daemon', onTab: noop, following: true, onFollowChange: noop, resumeToken: 0, onResume: noop, onCopy: noop, onOpenFolder: noop, ...extra }));

  it('two tabs, the selected one marked, lines classified, copy and open folder', () => {
    const markup = view();
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/id="logs-tab-daemon"[^>]*aria-selected="true"/);
    expect(markup).toMatch(/id="logs-tab-tailscale"[^>]*aria-selected="false"/);
    expect(markup).toContain('2 linhas');
    expect(markup).toContain('data-level="error"');
    expect(markup).toContain('Copiar');
    expect(markup).toContain('Abrir pasta dos logs');
    expect(markup).not.toContain('Rolagem pausada');
  });

  it('the log is a log region that does not announce every new line (a poll every 2 s would talk over the screen reader)', () => {
    const markup = view();
    expect(markup).toMatch(/<div[^>]*role="log"[^>]*aria-live="off"|<div[^>]*aria-live="off"[^>]*role="log"/);
  });

  it('scrolled up: says the scroll is paused and offers the way back', () => {
    expect(view({ following: false })).toContain('Rolagem pausada');
  });

  it('an empty log says why, and cannot be copied', () => {
    const markup = view({ tab: 'tailscale' });
    expect(markup).toContain('Ainda não há linhas do Tailscale embutido');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>.*Copiar/);
  });
});

describe('settings', () => {
  const view = (extra: Partial<Parameters<typeof SettingsView>[0]> = {}): string =>
    html(
      createElement(SettingsView, {
        language: 'pt-BR',
        onLanguage: noop,
        languageBusy: false,
        version: '0.1.0',
        dataFolder: 'C:\\Users\\user\\.nanachi-desktop',
        autostart: { value: true, supported: true },
        autostartBusy: false,
        onAutostart: noop,
        update: null,
        checking: false,
        onCheckUpdate: noop,
        onDownload: noop,
        onOpenDataFolder: noop,
        uninstalling: false,
        onUninstall: noop,
        ...extra,
      }),
    );

  it('the language is the first row of the general group, with the three languages in their own words', () => {
    const markup = view();
    expect(markup).toContain('Idioma');
    expect(markup.indexOf('Idioma')).toBeLessThan(markup.indexOf('Iniciar com o Windows'));
    expect(markup).toContain('Vale para o Nanachi Desktop e para o app de sessões dentro dele.');
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-labelledby="settings-language"');
    expect(markup).toContain('id="settings-language"');
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    for (const label of ['Português (Brasil)', 'English', 'Español']) expect(markup).toContain(label);
  });

  it.each([
    ['pt-BR', 'Idioma', 'Português (Brasil)'],
    ['en', 'Language', 'English'],
    ['es', 'Idioma', 'Español'],
  ] as const)('the language row in %s: its title and description follow the language, the radio labels never do, and the checked one is the language', (language, title, checked) => {
    const markup = html(
      createElement(SettingsView, {
        language,
        onLanguage: noop,
        languageBusy: false,
        version: '0.1.0',
        dataFolder: null,
        autostart: null,
        autostartBusy: false,
        onAutostart: noop,
        update: null,
        checking: false,
        onCheckUpdate: noop,
        onDownload: noop,
        onOpenDataFolder: noop,
        uninstalling: false,
        onUninstall: noop,
      }),
      language,
    );
    expect(markup).toContain(`id="settings-language" class="text-sm leading-5 font-medium">${title}</div>`);
    for (const label of ['Português (Brasil)', 'English', 'Español']) expect(markup).toContain(label);
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)<\/button>/g)];
    expect(radios.map((match) => match[1])).toEqual(['Português (Brasil)', 'English', 'Español']);
    const checkedRadios = radios.filter((match) => match[0].includes('aria-checked="true"')).map((match) => match[1]);
    expect(checkedRadios).toEqual([checked]);
  });

  it('a change in flight disables the language choice', () => {
    expect(view({ languageBusy: true })).toMatch(/<button[^>]*role="radio"[^>]*\sdisabled=""/);
    expect(view()).not.toMatch(/<button[^>]*role="radio"[^>]*\sdisabled=""/);
  });

  it('autostart, updates, data folder and uninstall', () => {
    const markup = view();
    expect(markup).toContain('Iniciar com o Windows');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('Versão 0.1.0');
    expect(markup).toContain('Verificar atualizações');
    expect(markup).toContain('Abrir pasta');
    expect(markup).toContain('Desinstalar…');
  });

  it('while the uninstaller is being started the button cannot be pressed again (it would open a second one)', () => {
    // `disabled=""` is the attribute; the bare word also appears in Tailwind class names (`disabled:opacity-50`).
    expect(view()).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Desinstalar…/s);
    expect(view({ uninstalling: true })).toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Desinstalar…/s);
  });

  it('an unsupported autostart is disabled and says so', () => {
    const markup = view({ autostart: { value: false, supported: false } });
    expect(markup).toContain('Não está disponível nesta instalação.');
    expect(markup).toMatch(/role="switch"[^>]*disabled/);
  });

  it('update results: current, available (with Baixar) and failed', () => {
    expect(view({ update: { status: 'up-to-date', current: '0.1.0' } })).toContain('Você está na versão mais recente.');
    const available = view({ update: { status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.2.0' } });
    expect(available).toContain('A versão 0.2.0 está disponível');
    expect(available).toContain('Baixar');
    expect(view({ update: { status: 'error', current: '0.1.0', message: 'Sem conexão.' } })).toContain('Sem conexão.');
    expect(view()).not.toContain('Baixar');
  });
});

describe('primitives', () => {
  it('Switch is a real switch with state and an accessible name', () => {
    const markup = html(createElement(Switch, { checked: true, onCheckedChange: noop, label: 'Iniciar com o Windows' }));
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Iniciar com o Windows"');
    expect(html(createElement(Switch, { checked: false, onCheckedChange: noop, disabled: true, label: 'x' }))).toContain('disabled=""');
  });

  it('Dialog renders its content only while open, labelled by its title', () => {
    const open = html(createElement(Dialog, { open: true, onClose: noop, title: 'Revogar?', description: 'Texto', footer: createElement('button', null, 'OK') }));
    expect(open).toContain('Revogar?');
    expect(open).toContain('aria-labelledby');
    expect(open).toContain('OK');
    expect(html(createElement(Dialog, { open: false, onClose: noop, title: 'Revogar?' }))).not.toContain('Revogar?');
  });

  it('the page outside Nanachi Desktop says to open it there instead of inventing data', () => {
    const markup = html(createElement(MissingBridge));
    expect(markup).toContain('Abra pelo Nanachi Desktop');
    expect(markup).not.toContain('OFFICE-PC');
  });
});

describe('the same views in English and in Spanish', () => {
  const drive = (extra: Partial<DriveInfo> = {}): DriveInfo => ({ root: 'D:\\', label: 'Data', kind: 'fixed', totalBytes: Math.round(12.34 * 1024 ** 3), freeBytes: Math.round(4.2 * 1024 ** 3), ...extra });

  it('drive tile: the decimal mark, the units and the words follow the language', () => {
    const props = { drive: drive(), paths: ['D:\\Work'], editable: true, onToggle: noop };
    const en = html(createElement(DriveTile, props), 'en');
    expect(en).toContain('4.2 GB');
    expect(en).toContain('free of 12.3 GB');
    expect(en).toContain('aria-label="8.14 GB used of 12.3 GB"');
    expect(en).toContain('Allow the whole drive');
    expect(en).toContain('1 folder allowed on this drive');
    expect(en).toContain('aria-label="Drive D:"');
    const es = html(createElement(DriveTile, props), 'es');
    expect(es).toContain('4,2 GB');
    expect(es).toContain('libres de 12,3 GB');
    expect(es).toContain('aria-label="8,14 GB usados de 12,3 GB"');
    expect(es).toContain('Permitir el disco completo');
    expect(es).toContain('1 carpeta permitida en este disco');
    expect(es).toContain('aria-label="Disco D:"');
  });

  it('the restart dialog counts the sessions in the right plural, in every language', () => {
    const view = (busySessions: number, language: 'en' | 'es'): string => html(createElement(RestartDialog, { open: true, mode: 'save', busySessions, busy: false, onCancel: noop, onLater: noop, onNow: noop }), language);
    expect(view(1, 'en')).toContain('There is 1 session in progress, which will be interrupted.');
    expect(view(2, 'en')).toContain('There are 2 sessions in progress, which will be interrupted.');
    expect(view(2, 'en')).toContain('Save and apply later');
    expect(view(1, 'es')).toContain('Hay 1 sesión en curso, que se interrumpirá.');
    expect(view(2, 'es')).toContain('Hay 2 sesiones en curso, que se interrumpirán.');
    expect(view(2, 'es')).toContain('Guardar y reiniciar ahora');
  });

  it('device table: relative times and dates are written in the language', () => {
    const now = 1_700_000_000_000;
    const list: DeviceInfo[] = [{ id: 'a', name: 'Ana iPhone', createdAt: now - 20 * 86_400_000, lastSeenAt: now - 3 * 60_000, revoked: false, isThisApp: false }];
    expect(html(createElement(DevicesTable, { devices: list, now, onRevoke: noop }), 'en')).toContain('3 min ago');
    expect(html(createElement(DevicesTable, { devices: list, now, onRevoke: noop }), 'es')).toContain('hace 3 min');
    expect(html(createElement(DevicesTable, { devices: list, now, onRevoke: noop }), 'es')).toContain('aria-label="Revocar Ana iPhone"');
  });

  it('a log with no lines still counts them ("0 lines"), and the empty text is in the language', () => {
    const empty = { daemon: [], tailscale: [] };
    const view = (language: 'en' | 'es'): string =>
      html(createElement(LogsView, { logs: empty, tab: 'daemon', onTab: noop, following: true, onFollowChange: noop, resumeToken: 0, onResume: noop, onCopy: noop, onOpenFolder: noop }), language);
    expect(view('en')).toContain('0 lines');
    expect(view('en')).toContain('The daemon has not written anything yet.');
    expect(view('es')).toContain('0 líneas');
  });

  it('a path with characters that mean something to a replacement ($&, $1) is shown as it is', () => {
    const path = 'C:\\$Recycle.Bin\\$&x\\$1';
    const [entry] = buildDraftEntries([{ path, exists: true, coveredBy: null }], [path]);
    if (entry === undefined) throw new Error('no entry');
    const markup = html(createElement(FolderRow, { entry, editable: true, onReveal: noop, onRemove: noop }), 'en');
    expect(markup).toContain('aria-label="Remove C:\\$Recycle.Bin\\$&amp;x\\$1"');
    expect(markup).toContain('aria-label="Show C:\\$Recycle.Bin\\$&amp;x\\$1 in File Explorer"');
  });
});
