import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionSheetPanel } from '../components/ActionSheet.js';
import { setLanguage } from '../i18n/index.js';
import { machineMenuRows } from '../machineMenuRows.js';
import type { Machine } from '../machines.js';
import { MainScreen } from './MainScreen.js';

const noop = () => undefined;
const machine: Machine = { id: 'm1', name: 'OFFICE-PC', baseUrl: 'http://127.0.0.1:7777', token: 'token' };

const props = {
  machines: [machine],
  selected: machine,
  statuses: { m1: 'online' as const },
  onSelect: noop,
  onAdd: noop,
  onRemove: noop,
  onRepair: noop,
  onOpenWorkspaces: noop,
  onOpenSettings: noop,
  onOpenSession: noop,
};

/** The "..." menu of the home screen, opened: its panel holds the same rows the screen builds. */
const menuMarkup = (): string =>
  renderToStaticMarkup(
    createElement(ActionSheetPanel, { title: 'OFFICE-PC', items: machineMenuRows(noop), onClose: noop, onPick: noop }),
  );

describe('MainScreen', () => {
  it('names the machine on the workspaces button', () => {
    expect(renderToStaticMarkup(createElement(MainScreen, props))).toContain('Workspaces de OFFICE-PC');
  });

  it('keeps "Remover máquina" out of the bottom stack: it sits in the "..." menu, which is closed on the first render', () => {
    const html = renderToStaticMarkup(createElement(MainScreen, props));

    expect(html).toContain('aria-label="Mais ações de OFFICE-PC"');
    expect(html).not.toContain('Remover máquina');
  });

  it('offers "Remover máquina" in the menu as the destructive row', () => {
    const menu = menuMarkup();

    expect(menu).toContain('>Remover máquina</span>');
    expect(menu).toContain('data-tone="danger"');
  });

  it('keeps the label prefix of a long machine name on the workspaces button, which cuts the end', () => {
    const longMachine: Machine = { ...machine, name: 'OFFICE-PC-FROM-A-VERY-LONG-HOSTNAME-THAT-KEEPS-GOING-ON-AND-ON' };
    const html = renderToStaticMarkup(
      createElement(MainScreen, { ...props, machines: [longMachine], selected: longMachine }),
    );

    expect(html).toMatch(/<span class="[^"]*truncate[^"]*">Workspaces de OFFICE-PC-FROM-A-VERY-LONG-HOSTNAME/);
    expect(html).toContain(`>Workspaces de ${longMachine.name}</span>`);
  });

  it('names the machine on the workspaces button and in the menu label, in English', () => {
    setLanguage('en');
    const html = renderToStaticMarkup(createElement(MainScreen, props));

    expect(html).toContain('Workspaces on OFFICE-PC');
    expect(html).toContain('aria-label="More actions for OFFICE-PC"');
    expect(html).not.toContain('Remove machine');
  });

  it('offers "Remove machine" in the menu as the destructive row, in English', () => {
    setLanguage('en');
    const menu = menuMarkup();

    expect(menu).toContain('>Remove machine</span>');
    expect(menu).toContain('data-tone="danger"');
  });
});
