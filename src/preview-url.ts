import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Extra seconds an expiry may lie in the future, for clock drift between signing and checking. */
const FUTURE_SLACK_SECONDS = 60;

export interface PreviewSigner {
  /** Path of the render's video that works without the Bearer header until it expires. */
  url(id: string): string;
  verify(id: string, sig: unknown, exp: unknown): boolean;
}

/**
 * <video> elements can't send an Authorization header, so finished renders get a short-lived signed URL instead.
 * The key is random per process by default: a restart invalidates every URL, and the page simply asks for a new one.
 */
export function createPreviewSigner(options: { key?: Buffer; ttlSeconds: number; now?: () => number }): PreviewSigner {
  const key = options.key ?? randomBytes(32);
  const now = options.now ?? Date.now;
  const seconds = (): number => Math.floor(now() / 1000);
  const sign = (id: string, exp: string): Buffer => createHmac('sha256', key).update(`${id}.${exp}`).digest();
  return {
    url(id) {
      const exp = String(seconds() + options.ttlSeconds);
      return `/api/renders/${id}/video?exp=${exp}&sig=${sign(id, exp).toString('hex')}`;
    },
    verify(id, sig, exp) {
      if (typeof exp !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
      if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
      const current = seconds();
      const expires = Number(exp);
      if (expires < current || expires > current + options.ttlSeconds + FUTURE_SLACK_SECONDS) return false;
      return timingSafeEqual(sign(id, exp), Buffer.from(sig, 'hex'));
    },
  };
}
