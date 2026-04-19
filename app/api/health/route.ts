// Minimal healthcheck endpoint. Deliberately does NOT touch the DB —
// the Docker healthcheck runs every 30s and must stay fast + immune to
// transient write-locks on the SQLite file. A JSON `{ ok: true }` is
// enough to prove the Node process and Next server are alive.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const METHOD_NOT_ALLOWED = (): Response =>
  new Response(null, {
    status: 405,
    headers: { Allow: 'GET' },
  });

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function POST(): Promise<Response> {
  return METHOD_NOT_ALLOWED();
}
export async function PUT(): Promise<Response> {
  return METHOD_NOT_ALLOWED();
}
export async function PATCH(): Promise<Response> {
  return METHOD_NOT_ALLOWED();
}
export async function DELETE(): Promise<Response> {
  return METHOD_NOT_ALLOWED();
}
