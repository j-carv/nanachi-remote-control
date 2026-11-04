import { createHash, randomBytes } from 'node:crypto';

/** Token de dispositivo: 32 bytes aleatórios em base64url (o cliente guarda; o banco só vê o hash). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
