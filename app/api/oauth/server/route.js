import { NextResponse } from 'next/server';
import { authorizationServerMetadata } from '@/lib/oauth';

export const runtime = 'nodejs';

/** GET /.well-known/oauth-authorization-server (rewritten here): the endpoints (RFC 8414). */
export function GET(req) {
  return NextResponse.json(authorizationServerMetadata(req.nextUrl.origin), { headers: { 'Access-Control-Allow-Origin': '*' } });
}
