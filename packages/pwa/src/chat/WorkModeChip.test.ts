import type { SessionConfigOption } from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { setLanguage, t } from '../i18n/index.js';
import { WorkModeChip, workModeItems } from './WorkModeChip.js';
import type { WorkModeKind } from './workMode.js';

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

const OMP_PLAN_DESCRIPTION = 'Read-only planning mode that drafts a plan to a markdown file before any code changes';

/**
 * omp's mode select as the daemon offers it (packages/daemon/src/agent-modes.ts): its `default` (its tools run without
 * asking), and `plan` only while the session really is in plan.
 */
const ompOption = (currentValue: string): SelectOption => ({
  id: 'mode',
  name: 'Mode',
  description: null,
  category: 'mode',
  type: 'select',
  currentValue,
  options: [
    { value: 'default', name: 'Standard ACP headless mode', description: null },
    ...(currentValue === 'plan' ? [{ value: 'plan', name: 'Plan', description: OMP_PLAN_DESCRIPTION }] : []),
  ],
});

const labelOfKind = (kind: WorkModeKind): string => t(`chat:agentConfig.workMode.${kind}`);

const modeOption = (currentValue: string): SelectOption => ({
  id: 'mode',
  name: 'Mode',
  description: null,
  category: 'mode',
  type: 'select',
  currentValue,
  options: [
    { value: 'default', name: 'Manual', description: 'Always ask before making changes' },
    { value: 'plan', name: 'Plan', description: null },
    { value: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
    { value: 'custom', name: 'Custom mode', description: null },
  ],
});

const noop = () => undefined;

const render = (option: SelectOption): string =>
  renderToStaticMarkup(createElement(WorkModeChip, { option, onPick: noop }));

describe('WorkModeChip', () => {
  it('shows the friendly name of the current mode in a button that opens the list', () => {
    setLanguage('en');
    const html = render(modeOption('plan'));

    expect(html).toContain('data-slot="work-mode-chip"');
    expect(html).toContain('>Planning</span>');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it('gives a dangerous mode the danger tone, and a safe one none', () => {
    setLanguage('en');
    expect(render(modeOption('bypassPermissions'))).toContain('data-danger="true"');
    expect(render(modeOption('plan'))).not.toContain('data-danger');
  });

  it('shows the agent name of a mode it does not know', () => {
    setLanguage('en');
    expect(render(modeOption('custom'))).toContain('>Custom mode</span>');
  });

  it('names the chip for screen readers with the mode and what a tap does', () => {
    setLanguage('en');
    expect(render(modeOption('plan'))).toContain('aria-label="Work mode: Planning. Change work mode"');
  });

  it('is disabled while the agent cannot take a change now', () => {
    setLanguage('en');
    const html = renderToStaticMarkup(createElement(WorkModeChip, { option: modeOption('plan'), onPick: noop, disabled: true }));
    expect(html).toContain('disabled=""');
    expect(render(modeOption('plan'))).not.toContain('disabled=""');
  });

  it('shows the Portuguese name by default', () => {
    setLanguage('pt-BR');
    expect(render(modeOption('plan'))).toContain('>Planejamento</span>');
  });
});

describe('WorkModeChip for omp', () => {
  const renderFor = (option: SelectOption, agentId: string | undefined): string =>
    renderToStaticMarkup(createElement(WorkModeChip, { option, onPick: noop, agentId }));

  it('shows Automatic mode for its default, not Ask before edits', () => {
    setLanguage('en');
    const html = renderFor(ompOption('default'), 'omp');
    expect(html).toContain('>Automatic mode</span>');
    expect(html).toContain('data-kind="auto"');
    expect(html).not.toContain('data-danger');
  });

  it('shows Planning for its plan', () => {
    setLanguage('en');
    expect(renderFor(ompOption('plan'), 'omp')).toContain('>Planning</span>');
  });

  it('keeps Ask before edits for the same id under another agent', () => {
    setLanguage('en');
    expect(renderFor(ompOption('default'), 'claude')).toContain('>Ask before edits</span>');
    expect(renderFor(ompOption('default'), undefined)).toContain('>Ask before edits</span>');
  });

  it('lists only Automatic mode on its default, and Planning first with the agent description when in plan', () => {
    setLanguage('en');
    const onDefault = workModeItems(ompOption('default'), labelOfKind, noop, 'omp');
    expect(onDefault.map((item) => [item.label, item.detail, item.checked, item.tone])).toEqual([
      ['Automatic mode', undefined, true, undefined],
    ]);

    const inPlan = workModeItems(ompOption('plan'), labelOfKind, noop, 'omp');
    expect(inPlan.map((item) => [item.label, item.detail, item.checked, item.tone])).toEqual([
      ['Planning', OMP_PLAN_DESCRIPTION, true, undefined],
      ['Automatic mode', undefined, false, undefined],
    ]);
  });
});

describe('WorkModeChip with a single mode', () => {
  const renderFor = (option: SelectOption, agentId: string | undefined): string =>
    renderToStaticMarkup(createElement(WorkModeChip, { option, onPick: noop, agentId }));

  /** The class attribute of the chip's outer element (the first one in its markup). */
  const classOf = (html: string): string | undefined => /class="([^"]*)"/.exec(html)?.[1];

  it('shows the mode as a plain label, not a button, so there is no list to open', () => {
    setLanguage('en');
    const html = renderFor(ompOption('default'), 'omp');
    expect(html).toContain('data-slot="work-mode-chip"');
    expect(html).toContain('>Automatic mode</span>');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-haspopup');
  });

  it('keeps the size and place of the chip button', () => {
    setLanguage('en');
    expect(classOf(renderFor(ompOption('default'), 'omp'))).toBe(classOf(renderFor(ompOption('plan'), 'omp')));
  });

  it('a session with more than one mode still opens its list', () => {
    setLanguage('en');
    expect(renderFor(ompOption('plan'), 'omp')).toContain('<button');
  });
});

describe('WorkModeChip with YOLO', () => {
  it('opens the menu even when the provider has no native modes', () => {
    const html = renderToStaticMarkup(createElement(WorkModeChip, {
      option: undefined,
      onPick: noop,
      yolo: { enabled: false, onChange: noop },
    }));

    expect(html).toContain('<button');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('data-kind="yolo"');
  });

  it('shows YOLO and warns of limited coverage when active with Oh My Pi', () => {
    setLanguage('en');
    const html = renderToStaticMarkup(createElement(WorkModeChip, {
      option: ompOption('default'),
      agentId: 'omp',
      onPick: noop,
      yolo: { enabled: true, onChange: noop },
    }));

    expect(html).toContain('data-kind="yolo"');
    expect(html).toContain('>YOLO</span>');
    expect(html).toContain('Limited coverage');
  });
});
