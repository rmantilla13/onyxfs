import { NextResponse } from 'next/server';
import { registerOAuthClient } from '@/lib/db';
import { validateRegistration } from '@/lib/oauth';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/oauth/register — dynamic client registration (RFC 7591), which
 * Claude does before it sends anyone to sign in. Registering grants nothing:
 * a client still needs a person to sign in and allow it (/oauth/authorize),
 * and is only ever sent back to an address it registered here.
 */
export async function POST(req) {
  const read = await readJsonBody(req, { max: 8 * 1024 });
  if (read.error) return NextResponse.json({ error: 'invalid_client_metadata', error_description: read.error }, { status: 400 });
  const v = validateRegistration(read.body);
  if (v.error) return NextResponse.json({ error: 'invalid_redirect_uri', error_description: v.error }, { status: 400 });
  const client = await registerOAuthClient(v.value);
  return NextResponse.json({
    client_id: client.id,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(client.createdAt / 1000),
  }, { status: 201 });
}
