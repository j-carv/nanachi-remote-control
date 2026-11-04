import { createHash, timingSafeEqual } from 'node:crypto';
import { generateToken } from './tokens.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Token que cada agente recebe no env para chamar `POST /api/agent/files`. Vive só em memória: some com o
 * processo do daemon, e é revogado quando a sessão para ou falha. Guarda o hash, não o token.
 */
export class AgentTokens {
  private readonly digests = new Map<string, Buffer>();

  /** Emite um token novo para a sessão (substitui o anterior, se houver). */
  issue(sessionId: string): string {
    const token = generateToken();
    this.digests.set(sessionId, digest(token));
    return token;
  }

  revoke(sessionId: string): void {
    this.digests.delete(sessionId);
  }

  /** Comparação em tempo constante. Token ausente, de outra sessão ou sem token emitido: false. */
  verify(sessionId: string, token: string | undefined): boolean {
    const expected = this.digests.get(sessionId);
    if (expected === undefined || token === undefined) return false;
    return timingSafeEqual(expected, digest(token));
  }
}
