import { randomBytes, randomUUID } from 'node:crypto';

/** ID pendek yang enak dibaca/diketik user di chat, mis. approval #a1b2c3. */
export function shortId(size = 6) {
  return randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
}

export function uuid() {
  return randomUUID();
}
