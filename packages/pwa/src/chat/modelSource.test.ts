import { describe, expect, it } from 'vitest';
import {
  choiceLabel,
  isModelOption,
  modelGroupsOf,
  modelSourceOf,
  providerGroups,
  sourceLabel,
  type ModelChoice,
} from './modelSource.js';

const choice = (value: string, name: string, group?: string): ModelChoice =>
  group === undefined ? { value, name } : { value, name, group };

describe('modelSourceOf', () => {
  it('reads the provider from the first segment of an Oh My Pi value', () => {
    expect(modelSourceOf({ value: 'cursor/claude-4.5-sonnet' })).toEqual({
      providerId: 'cursor',
      providerLabel: 'Cursor',
      vendorLabel: null,
    });
    expect(modelSourceOf({ value: 'claude-cli/opus' })).toEqual({
      providerId: 'claude-cli',
      providerLabel: 'Claude CLI',
      vendorLabel: null,
    });
  });

  it('reads the upstream vendor of an OpenRouter value, dropping the leading ~', () => {
    expect(modelSourceOf({ value: 'openrouter/~anthropic/claude-opus-latest' })).toEqual({
      providerId: 'openrouter',
      providerLabel: 'OpenRouter',
      vendorLabel: 'Anthropic',
    });
    expect(modelSourceOf({ value: 'openrouter/openai/gpt-5' })).toEqual({
      providerId: 'openrouter',
      providerLabel: 'OpenRouter',
      vendorLabel: 'OpenAI',
    });
  });

  it('uses the id as the label of a provider that is not in the map', () => {
    expect(modelSourceOf({ value: 'acme/model-x' })).toEqual({
      providerId: 'acme',
      providerLabel: 'acme',
      vendorLabel: null,
    });
  });

  it('does not take Object.prototype keys as provider labels', () => {
    expect(modelSourceOf({ value: 'toString/x' })?.providerLabel).toBe('toString');
  });

  it('returns null for Claude Code values (no slash) and empty provider segments', () => {
    expect(modelSourceOf({ value: 'default' })).toBeNull();
    expect(modelSourceOf({ value: 'sonnet[1m]' })).toBeNull();
    expect(modelSourceOf({ value: '/model' })).toBeNull();
  });

  it('takes the group name as the provider when the option came from an ACP group', () => {
    expect(modelSourceOf({ value: 'openrouter/~anthropic/claude-opus-latest', group: 'Cursor' })).toEqual({
      providerId: 'Cursor',
      providerLabel: 'Cursor',
      vendorLabel: null,
    });
  });

  it('falls back to the value when the group is null', () => {
    expect(modelSourceOf({ value: 'cursor/x', group: null })?.providerId).toBe('cursor');
  });
});

describe('isModelOption', () => {
  it('applies to category model, or to id model when the category is missing', () => {
    expect(isModelOption({ id: 'model', category: 'model' })).toBe(true);
    expect(isModelOption({ id: 'modelo', category: 'model' })).toBe(true);
    expect(isModelOption({ id: 'model', category: null })).toBe(true);
    expect(isModelOption({ id: 'model' })).toBe(true);
  });

  it('does not apply to other selects', () => {
    expect(isModelOption({ id: 'mode', category: 'mode' })).toBe(false);
    expect(isModelOption({ id: 'thought', category: 'thought_level' })).toBe(false);
    expect(isModelOption({ id: 'effort', category: null })).toBe(false);
  });
});

describe('providerGroups', () => {
  it('groups by provider in first-appearance order and puts unsourced options last under "Outros"', () => {
    const groups = providerGroups([
      choice('cursor/a', 'A'),
      choice('openrouter/~openai/b', 'B'),
      choice('cursor/c', 'C'),
      choice('default', 'Padrão'),
      choice('claude-cli/opus', 'Opus'),
    ]);

    expect(groups).toEqual([
      {
        providerId: 'cursor',
        providerLabel: 'Cursor',
        options: [choice('cursor/a', 'A'), choice('cursor/c', 'C')],
      },
      {
        providerId: 'openrouter',
        providerLabel: 'OpenRouter',
        options: [choice('openrouter/~openai/b', 'B')],
      },
      {
        providerId: 'claude-cli',
        providerLabel: 'Claude CLI',
        options: [choice('claude-cli/opus', 'Opus')],
      },
      {
        providerId: '',
        providerLabel: 'Outros',
        options: [choice('default', 'Padrão')],
      },
    ]);
  });

  it('groups options that came from ACP groups by the group name', () => {
    const groups = providerGroups([choice('x/1', 'One', 'Alpha'), choice('y/2', 'Two', 'Beta')]);
    expect(groups?.map((group) => group.providerLabel)).toEqual(['Alpha', 'Beta']);
  });

  it('is undefined for a single provider, so the list renders as before', () => {
    expect(providerGroups([choice('cursor/a', 'A'), choice('cursor/b', 'B')])).toBeUndefined();
  });

  it('is undefined for Claude Code values (no provider at all)', () => {
    expect(providerGroups([choice('default', 'Padrão'), choice('opus', 'Opus'), choice('sonnet[1m]', 'Sonnet')])).toBeUndefined();
  });

  it('is undefined for an empty list', () => {
    expect(providerGroups([])).toBeUndefined();
  });
});

describe('modelGroupsOf', () => {
  it('returns the provider groups of a model select', () => {
    const groups = modelGroupsOf({
      id: 'model',
      category: 'model',
      options: [choice('cursor/a', 'A'), choice('claude-cli/opus', 'Opus')],
    });
    expect(groups?.map((group) => group.providerId)).toEqual(['cursor', 'claude-cli']);
  });

  it('is undefined for a select that is not a model select, even with several providers', () => {
    expect(
      modelGroupsOf({
        id: 'mode',
        category: 'mode',
        options: [choice('cursor/a', 'A'), choice('claude-cli/opus', 'Opus')],
      }),
    ).toBeUndefined();
  });
});

describe('choiceLabel and sourceLabel', () => {
  it('appends the vendor to the name when there is one', () => {
    expect(choiceLabel(choice('openrouter/~anthropic/claude-opus-latest', 'Claude Opus latest'))).toBe(
      'Claude Opus latest · Anthropic',
    );
  });

  it('is the bare name when there is no vendor', () => {
    expect(choiceLabel(choice('cursor/claude-4.5-sonnet', 'Claude 4.5 Sonnet'))).toBe('Claude 4.5 Sonnet');
  });

  it('agrees with modelSourceOf: an option that came from an ACP group shows no vendor in either place', () => {
    const grouped = choice('openrouter/~anthropic/claude-opus-latest', 'Claude Opus latest', 'Cursor');
    const source = modelSourceOf(grouped);

    expect(source?.vendorLabel).toBeNull();
    expect(choiceLabel(grouped)).toBe('Claude Opus latest');
  });

  it('shows the vendor in both the option text and the provider line for an ungrouped OpenRouter value', () => {
    const ungrouped = choice('openrouter/~anthropic/claude-opus-latest', 'Claude Opus latest');
    const source = modelSourceOf(ungrouped);

    expect(source).not.toBeNull();
    expect(choiceLabel(ungrouped)).toBe('Claude Opus latest · Anthropic');
    expect(source === null ? '' : sourceLabel(source)).toBe('OpenRouter · Anthropic');
  });

  it('shows the provider, and the vendor after it when present', () => {
    expect(sourceLabel({ providerId: 'openrouter', providerLabel: 'OpenRouter', vendorLabel: 'Anthropic' })).toBe(
      'OpenRouter · Anthropic',
    );
    expect(sourceLabel({ providerId: 'cursor', providerLabel: 'Cursor', vendorLabel: null })).toBe('Cursor');
  });
});
