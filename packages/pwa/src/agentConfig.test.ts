import type { SessionConfigOption } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import type { StorageLike } from './machines.js';
import {
  agentConfigKey,
  applyConfigValue,
  isDangerousSwitch,
  readAgentConfig,
  splitOptions,
  toCreateConfig,
  writeAgentConfig,
} from './agentConfig.js';

const MODEL: SessionConfigOption = {
  id: 'model',
  name: 'Modelo',
  category: 'model',
  type: 'select',
  currentValue: 'opus',
  options: [
    { value: 'opus', name: 'Opus' },
    { value: 'sonnet', name: 'Sonnet' },
  ],
};

const MODE: SessionConfigOption = {
  id: 'mode',
  name: 'Modo',
  category: 'mode',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Padrão' }],
};

const EFFORT: SessionConfigOption = {
  id: 'thinking',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'auto',
  options: [{ value: 'auto', name: 'Auto' }],
};

const FAST: SessionConfigOption = {
  id: 'fast',
  name: 'Fast',
  category: 'model_config',
  type: 'boolean',
  currentValue: false,
};

const BYPASS_MODE: SessionConfigOption = {
  ...MODE,
  currentValue: 'bypassPermissions',
  options: [
    { value: 'default', name: 'Manual' },
    { value: 'bypassPermissions', name: 'Bypass permissions' },
  ],
};

const PLAN_MODE: SessionConfigOption = {
  ...MODE,
  currentValue: 'plan',
  options: [
    { value: 'default', name: 'Manual' },
    { value: 'plan', name: 'Plan' },
  ],
};

const AGENT_ID = 'omp';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: StorageLike & { data: Map<string, string> } = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return storage;
}

const brokenStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('agentConfigKey', () => {
  it('usa nanachi.agentConfig.<agentId>', () => {
    expect(agentConfigKey('omp')).toBe('nanachi.agentConfig.omp');
  });
});

describe('persistência por agente', () => {
  it('sem nada salvo devolve lista vazia', () => {
    expect(readAgentConfig(memoryStorage(), AGENT_ID)).toEqual([]);
  });

  it('escreve e lê as opções do agente (ida e volta)', () => {
    const storage = memoryStorage();
    expect(writeAgentConfig(storage, AGENT_ID, [MODEL, FAST])).toBe(true);
    expect(storage.data.get('nanachi.agentConfig.omp')).toBe(JSON.stringify([MODEL, FAST]));
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([MODEL, FAST]);
  });

  it('config de um agente não vaza para outro', () => {
    const storage = memoryStorage();
    writeAgentConfig(storage, 'omp', [MODEL]);
    expect(readAgentConfig(storage, 'claude')).toEqual([]);
  });

  it('JSON inválido vira lista vazia, sem lançar', () => {
    const storage = memoryStorage({ 'nanachi.agentConfig.omp': '{quebrado' });
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([]);
  });

  it('JSON com forma errada vira lista vazia', () => {
    const storage = memoryStorage({
      'nanachi.agentConfig.omp': JSON.stringify([{ id: 'x', type: 'select' }]),
    });
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([]);
  });

  it('storage bloqueado: leitura vira vazio e escrita devolve false', () => {
    expect(readAgentConfig(brokenStorage, AGENT_ID)).toEqual([]);
    expect(writeAgentConfig(brokenStorage, AGENT_ID, [MODEL])).toBe(false);
  });
});

describe('readAgentConfig and dangerous modes', () => {
  it('drops a stored bypass mode and keeps the other options', () => {
    const storage = memoryStorage({ [agentConfigKey(AGENT_ID)]: JSON.stringify([MODEL, BYPASS_MODE, FAST]) });
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([MODEL, FAST]);
  });

  it('keeps a stored safe mode of an agent that offers it', () => {
    const storage = memoryStorage({ [agentConfigKey('claude')]: JSON.stringify([PLAN_MODE]) });
    expect(readAgentConfig(storage, 'claude')).toEqual([PLAN_MODE]);
  });

  it('drops a bypass mode even when it was written with writeAgentConfig', () => {
    const storage = memoryStorage();
    writeAgentConfig(storage, AGENT_ID, [BYPASS_MODE]);
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([]);
  });
});

describe('isDangerousSwitch', () => {
  it('is true when a mode select moves into a dangerous mode', () => {
    expect(isDangerousSwitch(MODE, 'bypassPermissions')).toBe(true);
  });

  it('is false when the mode is already the dangerous one, or the new mode is safe', () => {
    expect(isDangerousSwitch(BYPASS_MODE, 'bypassPermissions')).toBe(false);
    expect(isDangerousSwitch(MODE, 'plan')).toBe(false);
  });

  it('is false outside the mode category and for booleans', () => {
    expect(isDangerousSwitch(MODEL, 'bypassPermissions')).toBe(false);
    expect(isDangerousSwitch(FAST, true)).toBe(false);
  });
});

describe('applyConfigValue', () => {
  it('troca o currentValue de um select pelo id', () => {
    const next = applyConfigValue([MODEL, FAST], 'model', 'sonnet');
    expect(next[0]).toMatchObject({ id: 'model', currentValue: 'sonnet' });
    expect(next[1]).toBe(FAST);
  });

  it('troca o valor de um boolean', () => {
    const next = applyConfigValue([MODEL, FAST], 'fast', true);
    expect(next[1]).toMatchObject({ id: 'fast', currentValue: true });
  });

  it('valor do tipo errado é ignorado', () => {
    expect(applyConfigValue([MODEL], 'model', true)).toEqual([MODEL]);
    expect(applyConfigValue([FAST], 'fast', 'on')).toEqual([FAST]);
  });

  it('id desconhecido não altera nada e não muta a lista original', () => {
    const original = [MODEL];
    const next = applyConfigValue(original, 'nope', 'x');
    expect(next).toEqual([MODEL]);
    expect(original[0]).toBe(MODEL);
  });
});

describe('toCreateConfig', () => {
  it('monta o mapa id -> valor atual para o POST /api/sessions', () => {
    expect(toCreateConfig([MODEL, FAST])).toEqual({ model: 'opus', fast: false });
  });

  it('lista vazia vira objeto vazio', () => {
    expect(toCreateConfig([])).toEqual({});
  });
});

describe('splitOptions', () => {
  it('separa Acesso (mode), Modelo (model) e Effort (thought_level) na ordem fixa', () => {
    const { primary } = splitOptions([EFFORT, MODEL, MODE]);
    expect(primary.map((item) => [item.label, item.option.id])).toEqual([
      ['Acesso', 'mode'],
      ['Modelo', 'model'],
      ['Effort', 'thinking'],
    ]);
  });

  it('o resto (model_config, sem categoria) vai para extra', () => {
    const uncategorized: SessionConfigOption = { ...MODE, id: 'agent', category: null };
    const { primary, extra } = splitOptions([MODE, FAST, uncategorized]);
    expect(primary.map((item) => item.option.id)).toEqual(['mode']);
    expect(extra.map((option) => option.id)).toEqual(['fast', 'agent']);
  });

  it('categoria primária que não é select cai em extra', () => {
    const booleanModel: SessionConfigOption = { ...FAST, id: 'm', category: 'model' };
    const { primary, extra } = splitOptions([booleanModel]);
    expect(primary).toEqual([]);
    expect(extra).toEqual([booleanModel]);
  });

  it('sem opções primárias devolve primary vazio', () => {
    expect(splitOptions([]).primary).toEqual([]);
  });
});

describe('splitOptions in English', () => {
  it('names the fixed selectors in English', () => {
    setLanguage('en');
    const effort: SessionConfigOption = { ...MODEL, id: 'effort', category: 'thought_level' };
    const { primary } = splitOptions([MODEL, MODE, effort]);
    expect(primary.map((control) => control.label)).toEqual(['Access', 'Model', 'Effort']);
  });

  it('names the mode choices with the work mode labels, in the work mode order', () => {
    setLanguage('en');
    const mode: SessionConfigOption = {
      ...MODE,
      options: [
        { value: 'bypassPermissions', name: 'Bypass permissions' },
        { value: 'default', name: 'Manual' },
        { value: 'plan', name: 'Plan' },
      ],
    };
    const { primary } = splitOptions([mode]);
    expect(primary[0]?.option.options.map((choice) => [choice.value, choice.name])).toEqual([
      ['default', 'Ask before edits'],
      ['plan', 'Planning'],
      ['bypassPermissions', 'Bypass permissions'],
    ]);
  });
});

describe('omp work modes in the settings drawer and the dangerous check', () => {
  const OMP_MODE: SessionConfigOption = {
    ...MODE,
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Standard ACP headless mode', description: null },
      { value: 'plan', name: 'Plan', description: 'Read-only planning mode' },
    ],
  };

  const OMP_PLAN_MODE: SessionConfigOption = { ...OMP_MODE, currentValue: 'plan' };

  it('names the omp default Automatic mode, the only mode the daemon offers it', () => {
    setLanguage('en');
    const offered: SessionConfigOption = { ...OMP_MODE, options: [{ value: 'default', name: 'Standard ACP headless mode' }] };
    const { primary } = splitOptions([offered], AGENT_ID);
    expect(primary[0]?.option.options.map((choice) => [choice.value, choice.name])).toEqual([['default', 'Automatic mode']]);
  });

  it('names Planning for omp only while the session is in plan, plan first', () => {
    setLanguage('en');
    const { primary } = splitOptions([OMP_PLAN_MODE], AGENT_ID);
    expect(primary[0]?.option.options.map((choice) => [choice.value, choice.name])).toEqual([
      ['plan', 'Planning'],
      ['default', 'Automatic mode'],
    ]);
  });

  it('keeps the shared names for the same ids under another agent', () => {
    setLanguage('en');
    const { primary } = splitOptions([OMP_MODE], 'claude');
    expect(primary[0]?.option.options.map((choice) => choice.name)).toEqual(['Ask before edits', 'Planning']);
  });

  it('switching from omp plan back to default is not a dangerous switch', () => {
    expect(isDangerousSwitch(OMP_PLAN_MODE, 'default', AGENT_ID)).toBe(false);
  });

  it('drops a stored omp plan, so a new session starts in the default mode', () => {
    const storage = memoryStorage({ [agentConfigKey(AGENT_ID)]: JSON.stringify([MODEL, OMP_PLAN_MODE]) });
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([MODEL]);
  });

  it('removes the plan choice from a stored omp mode that is on its default', () => {
    const storage = memoryStorage({ [agentConfigKey(AGENT_ID)]: JSON.stringify([OMP_MODE]) });
    expect(readAgentConfig(storage, AGENT_ID)).toEqual([
      { ...OMP_MODE, options: [{ value: 'default', name: 'Standard ACP headless mode', description: null }] },
    ]);
  });

  it('keeps a stored plan of another agent', () => {
    const storage = memoryStorage({ [agentConfigKey('claude')]: JSON.stringify([OMP_PLAN_MODE]) });
    expect(readAgentConfig(storage, 'claude')).toEqual([OMP_PLAN_MODE]);
  });

  it('a switch into bypass under omp is still dangerous', () => {
    expect(isDangerousSwitch(OMP_MODE, 'bypassPermissions', AGENT_ID)).toBe(true);
  });
});
