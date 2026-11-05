import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  describeAccountError,
  describeError,
  describeLoginPollError,
  describeLoopError,
  describeRedeemError,
  describeResetsError,
  describeSessionAccountError,
  describeUsageError,
  ERROR_TEXT,
  redeemOutcomeUnknown,
  usageNeedsResume,
} from './errorMessages.js';

describe('describeError', () => {
  it('limite de sessões ativas diz o que fazer', () => {
    expect(describeError(new ApiError('too_many_sessions', 429))).toBe(
      'Limite de 8 sessões ativas; pare alguma.',
    );
  });

  it('agente que não permite retomar pede uma sessão nova', () => {
    expect(describeError(new ApiError('not_resumable', 409))).toBe(
      'Este agente não permite retomar; abra uma sessão nova.',
    );
  });

  it('sessão já em execução tem texto próprio', () => {
    expect(describeError(new ApiError('already_running', 409))).toBe(
      'Esta sessão já está em execução.',
    );
  });

  it('arquivo acima do limite diz o tamanho máximo', () => {
    expect(describeError(new ApiError('too_large', 413))).toBe('Arquivo maior que 50 MB.');
  });

  it('pasta sem git (worktree pedido) tem texto próprio', () => {
    expect(describeError(new ApiError('not_git', 400))).toBe(
      'Esta pasta não é um repositório git.',
    );
  });

  it('repositório sem commits tem texto próprio', () => {
    expect(describeError(new ApiError('no_commits', 409))).toBe(
      'O repositório ainda não tem commits.',
    );
  });

  it('worktree sujo diz que foi mantido', () => {
    expect(describeError(new ApiError('worktree_dirty', 409))).toBe(
      'O worktree tem alterações não commitadas; ele foi mantido.',
    );
  });

  it('erro que não é ApiError vira texto genérico', () => {
    expect(describeError(new Error('x'))).toBe('Erro inesperado.');
  });

  it('todo tipo de erro tem texto (ERROR_TEXT completo)', () => {
    for (const text of Object.values(ERROR_TEXT)) expect(text.length).toBeGreaterThan(0);
  });
});

describe('describeUsageError', () => {
  it('409 session_not_active pede para retomar', () => {
    const error = new ApiError('unexpected', 409, null, 'session_not_active');
    expect(describeUsageError(error)).toBe('Retome a sessão para ver o uso.');
    expect(usageNeedsResume(error)).toBe(true);
  });

  it('409 session_busy diz para tentar quando o agente terminar', () => {
    expect(describeUsageError(new ApiError('unexpected', 409, null, 'session_busy'))).toBe(
      'O agente está ocupado; tente quando ele terminar.',
    );
  });

  it('400 usage_unsupported diz que o agente não informa uso', () => {
    expect(describeUsageError(new ApiError('invalid_input', 400, null, 'usage_unsupported'))).toBe(
      'Este agente não informa uso.',
    );
  });

  it('504 agent_timeout pede para tentar de novo', () => {
    expect(describeUsageError(new ApiError('agent_timeout', 504, null, 'agent_timeout'))).toBe(
      'O agente demorou para responder. Tente de novo.',
    );
  });

  it('qualquer 504 usa o texto de demora, mesmo sem código conhecido', () => {
    expect(describeUsageError(new ApiError('unexpected', 504))).toBe(
      'O agente demorou para responder. Tente de novo.',
    );
  });

  it('outros erros caem no texto geral (describeError)', () => {
    const error = new ApiError('network');
    expect(describeUsageError(error)).toBe(describeError(error));
    expect(describeUsageError(new ApiError('not_found', 404))).toBe(ERROR_TEXT.not_found);
    expect(describeUsageError(new Error('x'))).toBe('Erro inesperado.');
  });

  it('o texto de uso não substitui o geral: session_busy fora do uso segue genérico', () => {
    const error = new ApiError('unexpected', 409, null, 'session_busy');
    expect(describeError(error)).toBe(ERROR_TEXT.unexpected);
    expect(describeUsageError(error)).not.toBe(describeError(error));
  });

  it('só session_not_active pede retomada', () => {
    expect(usageNeedsResume(new ApiError('unexpected', 409, null, 'session_busy'))).toBe(false);
    expect(usageNeedsResume(new Error('x'))).toBe(false);
  });
});

describe('describeResetsError (lista de resets)', () => {
  it('400 resets_unsupported diz que o agente não tem resets', () => {
    expect(describeResetsError(new ApiError('invalid_input', 400, null, 'resets_unsupported'))).toBe(
      'Este agente não tem resets salvos',
    );
  });

  it('os outros erros seguem os textos do uso', () => {
    expect(describeResetsError(new ApiError('agent_timeout', 504, null, 'agent_timeout'))).toBe(
      'O agente demorou para responder. Tente de novo.',
    );
    expect(describeResetsError(new ApiError('agent_failed', 502, null, 'agent_failed'))).toBe(ERROR_TEXT.agent_failed);
    expect(describeResetsError(new ApiError('network'))).toBe(ERROR_TEXT.network);
    expect(describeResetsError(new Error('x'))).toBe('Erro inesperado.');
  });
});

describe('describeRedeemError (resgate de reset)', () => {
  const UNCONFIRMED = 'Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.';

  it('504 não confirma se o reset foi gasto e manda conferir o uso', () => {
    const error = new ApiError('agent_timeout', 504, null, 'agent_timeout');
    expect(describeRedeemError(error)).toBe(UNCONFIRMED);
    expect(redeemOutcomeUnknown(error)).toBe(true);
  });

  it('qualquer 504 e falha de rede também deixam o resultado incerto', () => {
    expect(describeRedeemError(new ApiError('unexpected', 504))).toBe(UNCONFIRMED);
    expect(redeemOutcomeUnknown(new ApiError('unexpected', 504))).toBe(true);
    expect(describeRedeemError(new ApiError('network'))).toBe(UNCONFIRMED);
    expect(redeemOutcomeUnknown(new ApiError('network'))).toBe(true);
  });

  it('resposta 200 que não bate com o schema também deixa o resultado incerto', () => {
    const error = new ApiError('unexpected', 200);
    expect(describeRedeemError(error)).toBe(UNCONFIRMED);
    expect(redeemOutcomeUnknown(error)).toBe(true);
  });

  it('502 e 500 podem ter vindo depois de o agente receber o resgate: resultado incerto', () => {
    for (const error of [
      new ApiError('agent_failed', 502, null, 'agent_failed'),
      new ApiError('unexpected', 500),
      new ApiError('unexpected', 503),
    ]) {
      expect(describeRedeemError(error)).toBe(UNCONFIRMED);
      expect(redeemOutcomeUnknown(error)).toBe(true);
    }
  });

  it('só 400, 404 e 409 são recusas certas (nada foi gasto)', () => {
    for (const status of [400, 404, 409]) {
      expect(redeemOutcomeUnknown(new ApiError('unexpected', status))).toBe(false);
    }
    for (const status of [401, 403, 413, 429, 500, 502, 503, 504, 200, 201]) {
      expect(redeemOutcomeUnknown(new ApiError('unexpected', status))).toBe(true);
    }
  });

  it('409 reset_in_progress diz que já há um reset em andamento, com ponto final', () => {
    const error = new ApiError('unexpected', 409, null, 'reset_in_progress');
    expect(describeRedeemError(error)).toBe('Já tem um reset em andamento.');
    expect(redeemOutcomeUnknown(error)).toBe(false);
  });

  it('400 invalid_request pede para atualizar a lista', () => {
    const error = new ApiError('invalid_input', 400, null, 'invalid_request');
    expect(describeRedeemError(error)).toBe('Esse reset não está mais na lista. Atualize o uso e tente de novo.');
    expect(redeemOutcomeUnknown(error)).toBe(false);
  });

  it('400 resets_unsupported usa o mesmo texto da lista', () => {
    expect(describeRedeemError(new ApiError('invalid_input', 400, null, 'resets_unsupported'))).toBe(
      'Este agente não tem resets salvos',
    );
  });

  it('404 diz o texto geral de não encontrado', () => {
    const error = new ApiError('not_found', 404, null, 'not_found');
    expect(describeRedeemError(error)).toBe(ERROR_TEXT.not_found);
    expect(redeemOutcomeUnknown(error)).toBe(false);
  });

  it('erro que não é da API não diz que nada foi gasto: resultado incerto', () => {
    expect(describeRedeemError(new Error('x'))).toBe(UNCONFIRMED);
    expect(redeemOutcomeUnknown(new Error('x'))).toBe(true);
  });
});

describe('describeLoopError', () => {
  it('diz o que fazer para cada código de loop', () => {
    expect(describeLoopError(new ApiError('not_found', 404, null, 'loop_not_found'))).toBe(
      'Esta sessão não tem loop. Crie um novo.',
    );
    expect(describeLoopError(new ApiError('unexpected', 409, null, 'loop_finished'))).toBe(
      'Este loop já terminou. Crie um novo para voltar a rodar.',
    );
    expect(describeLoopError(new ApiError('unexpected', 409, null, 'loop_busy'))).toBe(
      'Uma rodada do loop está em andamento. Espere ela terminar e tente de novo.',
    );
    expect(describeLoopError(new ApiError('unexpected', 409, null, 'not_acp'))).toBe(
      'O loop só roda em sessões de agente, não em terminal.',
    );
  });

  it('sem código de loop cai no texto geral do erro', () => {
    expect(describeLoopError(new ApiError('network'))).toBe(ERROR_TEXT.network);
    expect(describeLoopError(new Error('x'))).toBe('Erro inesperado.');
  });
});

describe('describeAccountError', () => {
  it('diz o que fazer para cada código de conta', () => {
    expect(describeAccountError(new ApiError('invalid_input', 400, null, 'accounts_unsupported'))).toBe(
      'Este agente não tem contas extras.',
    );
    expect(describeAccountError(new ApiError('unexpected', 409, null, 'account_in_use'))).toBe(
      'Uma sessão está trabalhando nesta conta. Espere terminar e tente de novo.',
    );
    expect(describeAccountError(new ApiError('unexpected', 409, null, 'too_many_accounts'))).toBe(
      'Limite de 10 contas extras por agente. Remova alguma antes de adicionar outra.',
    );
    expect(describeAccountError(new ApiError('unexpected', 409, null, 'login_in_progress'))).toBe(
      'Já há um login em andamento para este agente. Termine ou cancele esse primeiro.',
    );
    expect(describeAccountError(new ApiError('unexpected', 409, null, 'invalid_state'))).toBe(
      'O login não está esperando um código agora.',
    );
  });

  it('troca de conta numa sessão ocupada pede para esperar o agente', () => {
    expect(describeAccountError(new ApiError('unexpected', 409, null, 'session_busy'))).toBe(
      'O agente está trabalhando. Troque a conta quando ele terminar.',
    );
  });

  it('agente que não retoma explica que a troca não vale para esta sessão', () => {
    expect(describeAccountError(new ApiError('not_resumable', 409, null, 'not_resumable'))).toBe(
      'Este agente não retoma sessões: abra uma sessão nova na conta que você quer usar.',
    );
  });

  it('conta que sumiu pede para atualizar a lista', () => {
    expect(describeAccountError(new ApiError('not_found', 404, null, 'not_found'))).toBe(
      'Não encontrei esta conta no PC. Atualize a lista.',
    );
  });

  it('sem código de conta cai no texto geral do erro', () => {
    expect(describeAccountError(new ApiError('network'))).toBe(ERROR_TEXT.network);
    expect(describeAccountError(new ApiError('unauthorized', 401))).toBe(ERROR_TEXT.unauthorized);
    expect(describeAccountError(new ApiError('unexpected', 409, null, 'outro_codigo'))).toBe(ERROR_TEXT.unexpected);
    expect(describeAccountError(new Error('x'))).toBe('Erro inesperado.');
  });
});

describe('describeSessionAccountError', () => {
  it('404 é sessão que sumiu: não fala de conta', () => {
    const text = describeSessionAccountError(new ApiError('not_found', 404, null, 'not_found'));
    expect(text).toBe('Não encontrei esta sessão no PC. Pode ter sido removida.');
    expect(text).not.toMatch(/conta/i);
    expect(describeSessionAccountError(new ApiError('not_found', 404))).toBe(text);
  });

  it('os outros códigos seguem os textos de conta', () => {
    expect(describeSessionAccountError(new ApiError('unexpected', 409, null, 'session_busy'))).toBe(
      'O agente está trabalhando. Troque a conta quando ele terminar.',
    );
    expect(describeSessionAccountError(new ApiError('network'))).toBe(ERROR_TEXT.network);
    expect(describeSessionAccountError(new Error('x'))).toBe('Erro inesperado.');
  });
});

describe('describeLoginPollError', () => {
  it('o PC não lembra do login: pede para fechar e tentar de novo', () => {
    expect(describeLoginPollError(new ApiError('not_found', 404, null, 'not_found'))).toBe(
      'O PC não lembra mais deste login. Feche e tente de novo.',
    );
  });

  it('rede: avisa que continua tentando', () => {
    expect(describeLoginPollError(new ApiError('network'))).toBe('Sem resposta do PC. Tentando de novo…');
  });

  it('o resto usa os textos de conta', () => {
    expect(describeLoginPollError(new ApiError('unauthorized', 401))).toBe(ERROR_TEXT.unauthorized);
    expect(describeLoginPollError(new Error('x'))).toBe('Erro inesperado.');
  });
});
