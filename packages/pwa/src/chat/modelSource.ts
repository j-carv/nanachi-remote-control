/**
 * Where a model comes from. Oh My Pi sends one flat `model` select whose values are `<provider>/<model id>` (and
 * `<provider>/~<vendor>/<model>` for OpenRouter), so the same display name shows up under several providers. Claude
 * Code sends `default`, `opus`, ... with no provider. Pure helpers: the components only render what these return.
 */

/** Minimal shape of a select option (its `value`, display `name`, and the ACP group it came from, if any). */
export interface ModelChoice {
  value: string;
  name: string;
  group?: string | null | undefined;
}

/** Minimal shape of a select that may hold model choices. */
export interface ModelOptionLike {
  id: string;
  category?: string | null | undefined;
}

export interface ModelSource {
  providerId: string;
  providerLabel: string;
  /** Upstream vendor (OpenRouter values only), or null. */
  vendorLabel: string | null;
}

export interface ProviderGroup<T extends ModelChoice> {
  providerId: string;
  providerLabel: string;
  options: T[];
}

/** Display names of the provider ids agents send. Unknown ids are shown as they are. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openrouter: 'OpenRouter',
  cursor: 'Cursor',
  'openai-codex': 'OpenAI Codex',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'claude-cli': 'Claude CLI',
  google: 'Google',
  'google-gemini-cli': 'Gemini CLI',
  gemini: 'Gemini',
  'github-copilot': 'GitHub Copilot',
  'x-ai': 'xAI',
  xai: 'xAI',
  mistralai: 'Mistral',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  'z-ai': 'Z.ai',
  zai: 'Z.ai',
  moonshotai: 'Moonshot AI',
  'meta-llama': 'Meta',
  nvidia: 'NVIDIA',
  minimax: 'MiniMax',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  groq: 'Groq',
  cerebras: 'Cerebras',
  'amazon-bedrock': 'Amazon Bedrock',
  'azure-openai': 'Azure OpenAI',
  vertex: 'Vertex AI',
};

const OTHERS_LABEL = 'Outros';

function labelOf(id: string): string {
  return Object.hasOwn(PROVIDER_LABELS, id) ? (PROVIDER_LABELS[id] ?? id) : id;
}

/** Upstream vendor of an OpenRouter-style value (`openrouter/~anthropic/model`), or null. */
function vendorOf(value: string): string | null {
  const segments = value.split('/');
  if (segments.length < 3) return null;
  const vendorId = segments[1]?.replace(/^~/, '') ?? '';
  return vendorId === '' ? null : labelOf(vendorId);
}

/**
 * Provider of an option. A group name wins (the option came from a grouped ACP select); otherwise the value's first
 * segment is the provider. Null when the option has neither (Claude Code's `default`, `opus`).
 */
export function modelSourceOf(choice: Pick<ModelChoice, 'value' | 'group'>): ModelSource | null {
  if (choice.group) return { providerId: choice.group, providerLabel: choice.group, vendorLabel: null };
  const providerId = choice.value.split('/')[0] ?? '';
  if (providerId === '' || !choice.value.includes('/')) return null;
  return { providerId, providerLabel: labelOf(providerId), vendorLabel: vendorOf(choice.value) };
}

/** Whether a select is the model picker: category `model`, or id `model` when the category is missing. */
export function isModelOption(option: ModelOptionLike): boolean {
  const category = option.category ?? null;
  return category === null ? option.id === 'model' : category === 'model';
}

/**
 * Options grouped by provider, in first-appearance order, with the options that have no provider last under "Outros".
 * Undefined when fewer than two providers come out: a single-provider or provider-less list renders as before.
 */
export function providerGroups<T extends ModelChoice>(options: readonly T[]): ProviderGroup<T>[] | undefined {
  const groups = new Map<string, ProviderGroup<T>>();
  const others: T[] = [];
  for (const option of options) {
    const source = modelSourceOf(option);
    if (source === null) {
      others.push(option);
      continue;
    }
    const group = groups.get(source.providerId);
    if (group === undefined) {
      groups.set(source.providerId, {
        providerId: source.providerId,
        providerLabel: source.providerLabel,
        options: [option],
      });
    } else {
      group.options.push(option);
    }
  }
  if (groups.size < 2) return undefined;
  const out = [...groups.values()];
  if (others.length > 0) out.push({ providerId: '', providerLabel: OTHERS_LABEL, options: others });
  return out;
}

/** Provider groups of a select when it is the model picker and the list spans several providers, else undefined. */
export function modelGroupsOf<T extends ModelChoice>(
  option: ModelOptionLike & { options: readonly T[] },
): ProviderGroup<T>[] | undefined {
  return isModelOption(option) ? providerGroups(option.options) : undefined;
}

/**
 * Name of a model, plus its upstream vendor when its source has one: `Claude Opus latest · Anthropic`. The vendor comes
 * from `modelSourceOf`, the same place as the provider line of the closed row, so an option that came from an ACP
 * group (no vendor there) has none here either.
 */
export function choiceLabel(choice: ModelChoice): string {
  const vendor = modelSourceOf(choice)?.vendorLabel ?? null;
  return vendor === null ? choice.name : `${choice.name} · ${vendor}`;
}

/** Provider line under a model name: `OpenRouter · Anthropic`, or `Cursor`. */
export function sourceLabel(source: ModelSource): string {
  return source.vendorLabel === null ? source.providerLabel : `${source.providerLabel} · ${source.vendorLabel}`;
}
