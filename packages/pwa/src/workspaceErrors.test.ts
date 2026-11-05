import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { describeWorkspaceError } from './errorMessages.js';

describe('describeWorkspaceError', () => {
  it('sessões rodando bloqueiam a troca com a mensagem da tela', () => {
    expect(describeWorkspaceError(new ApiError('unexpected', 409, null, 'sessions_running'))).toBe(
      'Há sessões rodando neste workspace. Espere terminarem ou encerre-as.',
    );
  });

  it('nome de branch inválido, existente, em uso e sumida têm texto próprio', () => {
    expect(describeWorkspaceError(new ApiError('invalid_input', 400, null, 'invalid_branch'))).toBe(
      'Nome de branch inválido.',
    );
    expect(describeWorkspaceError(new ApiError('unexpected', 409, null, 'branch_exists'))).toBe(
      'Já existe uma branch com esse nome.',
    );
    expect(describeWorkspaceError(new ApiError('unexpected', 409, null, 'branch_in_use'))).toBe(
      'Esta branch está aberta em outro worktree.',
    );
    expect(describeWorkspaceError(new ApiError('not_found', 404, null, 'branch_not_found'))).toBe(
      'Essa branch não existe mais no PC.',
    );
  });

  it('pasta não vazia e arquivo grande têm texto próprio', () => {
    expect(describeWorkspaceError(new ApiError('unexpected', 409, null, 'dir_not_empty'))).toBe(
      'A pasta não está vazia. Apague o conteúdo primeiro.',
    );
    expect(describeWorkspaceError(new ApiError('too_large', 413, null, 'file_too_large'))).toBe(
      'Arquivo grande demais para o editor (máx. 2 MB).',
    );
  });

  it('arquivo binário é recusado no editor', () => {
    expect(describeWorkspaceError(new ApiError('unexpected', 415, null, 'binary_file'))).toBe(
      'Arquivo binário: não dá para editar aqui.',
    );
  });

  it('código desconhecido cai no texto geral da API', () => {
    expect(describeWorkspaceError(new ApiError('network'))).toBe(
      'Não consegui falar com o PC. Confira o endereço e se o Tailscale está conectado.',
    );
  });

  it('erro que não é da API vira o texto genérico', () => {
    expect(describeWorkspaceError(new Error('boom'))).toBe('Erro inesperado.');
  });
});
