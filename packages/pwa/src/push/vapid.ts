const BASE64URL = /^[A-Za-z0-9_-]*=*$/;

/**
 * Chave VAPID (base64url, como o daemon publica) em bytes para `applicationServerKey`.
 * Aceita com ou sem padding; caractere fora do alfabeto lança `TypeError`.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(base64url)) throw new TypeError('invalid VAPID key');
  const unpadded = base64url.replace(/=+$/, '');
  const padded = unpadded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
