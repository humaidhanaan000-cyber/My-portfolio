/**
 * GET /api/storage/:key — download a stored artefact.
 *
 * Access is workspace-scoped: a key is only served when the requesting session's
 * workspace owns it. Public exports are served with a cache header instead.
 */
import { NextResponse } from 'next/server'
import { StorageError, getObject } from '@/lib/storage'
import { getSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key } = await context.params
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in to download this file.' } }, { status: 401 })
  }

  try {
    const { body, object } = await getObject(session.workspaceId, key.join('/'))
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'content-type': object.contentType,
        'content-length': String(body.byteLength),
        'cache-control': object.isPublic ? 'public, max-age=3600' : 'private, no-store',
        'content-disposition': `inline; filename="${key[key.length - 1] ?? 'file'}"`,
      },
    })
  } catch (error) {
    if (error instanceof StorageError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.code === 'not_found' ? 404 : 501 })
    }
    return NextResponse.json({ error: { code: 'internal_error', message: 'Download failed.' } }, { status: 500 })
  }
}
