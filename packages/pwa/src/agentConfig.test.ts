import type { SessionConfigOption } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import type { StorageLike } from './machines.js';
import {
  agentConfigKey,
  applyConfigValue,
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
});
