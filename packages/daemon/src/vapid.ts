import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

/** Contato que o serviço de push pode usar para falar com o dono do daemon. Fixo: é o padrão do projeto. */
export const VAPID_SUBJECT = 'mailto:nanachi@localhost';

/** Conteúdo de `<NANACHI_HOME>/vapid.json`. A chave privada não sai do daemon. */
export interface VapidConfig {
  /** P-256 não comprimida em base64url: 65 bytes começando em 0x04. */
  publicKey: string;
  /** Escalar P-256 em base64url: 32 bytes. */
  privateKey: string;
  subject: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Motivo do problema ou undefined quando o conteúdo está no formato esperado. */
function problemOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'não é um objeto';
  const { publicKey, privateKey, subject } = raw as Record<string, unknown>;
  if (typeof publicKey !== 'string' || !BASE64URL.test(publicKey)) return 'publicKey ausente ou não é base64url';
  const publicBytes = Buffer.from(publicKey, 'base64url');
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) return 'publicKey deve ser P-256 não comprimida (65 bytes)';
  if (typeof privateKey !== 'string' || !BASE64URL.test(privateKey)) return 'privateKey ausente ou não é base64url';
  if (Buffer.from(privateKey, 'base64url').length !== 32) return 'privateKey deve ter 32 bytes';
  if (typeof subject !== 'string' || !(subject.startsWith('mailto:') || subject.startsWith('https:'))) {
    return 'subject deve começar com mailto: ou https:';
  }
  return undefined;
}

/**
 * Lê `<home>/vapid.json`; se não existir, gera o par P-256 e grava. Aceita BOM (PowerShell 5.1).
 * Arquivo existente com formato errado lança erro e NÃO é sobrescrito: trocar a chave invalida as inscrições.
 */
export function loadOrCreateVapid(home: string): VapidConfig {
  const file = join(home, 'vapid.json');

  if (!existsSync(file)) {
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const vapid: VapidConfig = { publicKey, privateKey, subject: VAPID_SUBJECT };
    mkdirSync(home, { recursive: true });
    writeFileSync(file, `${JSON.stringify(vapid, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return vapid;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`vapid.json inválido (${file}): ${(error as Error).message}`, { cause: error });
  }

  const problem = problemOf(raw);
  if (problem !== undefined) throw new Error(`vapid.json inválido (${file}): ${problem}`);
  const { publicKey, privateKey, subject } = raw as VapidConfig;
  return { publicKey, privateKey, subject };
}
