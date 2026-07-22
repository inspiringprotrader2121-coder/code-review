import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { AppDatabase } from '@orvex-review/store';
import { sessionUser } from './session.js';

export function authorizedAdmin(c: Context, db: AppDatabase): boolean {
  if (sessionUser(c, db)?.isSuperAdmin) return true;

  const configured = process.env.ORVEX_ADMIN_SECRET ?? process.env.REVIEW_API_SECRET;
  if (!configured) return false;
  const auth = c.req.header('authorization');
  const supplied = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('x-admin-secret');
  return Boolean(supplied && safeEqual(supplied, configured));
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
