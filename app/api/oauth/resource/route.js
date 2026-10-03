import { NextResponse } from 'next/server';
import { protectedResourceMetadata } from '@/lib/oauth';

export const runtime = 'nodejs';

/** GET /.well-known/oauth-protected-resource (rewritten here): /api/mcp's metadata (RFC 9728). */
export function GET(req) {
  return NextResponse.json(protectedResourceMetadata(req.nextUrl.origin), { headers: { 'Access-Control-Allow-Origin': '*' } });
}
