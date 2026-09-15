import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // `standalone` produces a self-contained server bundle for the production Docker image.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  compress: true,
  logging: { fetches: { fullUrl: false } },
  // Packages that must stay external to the bundler (they load native/wasm artefacts
  // or open sockets at runtime).
  serverExternalPackages: [
    '@electric-sql/pglite',
    'pg',
    'ioredis',
    'nodemailer',
    '@aws-sdk/client-s3',
  ],
  // Allow the hosted preview proxy + localhost origins to talk to the dev server.
  allowedDevOrigins: ['*.e2b.app', '*.arena.ai', 'localhost', '127.0.0.1'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    // Framing policy. Default: refuse to be framed anywhere (X-Frame-Options
    // SAMEORIGIN + frame-ancestors 'self'). Set ALLOW_EMBED=true for deployments
    // that are legitimately framed on another origin (hosted previews): the
    // X-Frame-Options header is dropped and frame-ancestors lists the allowed
    // ancestors, because browsers ignore frame-ancestors when X-Frame-Options is
    // present. Pair it with COOKIE_SAMESITE=none — a SameSite=Lax session cookie
    // is discarded inside a cross-site frame, which makes sign-in silently fail.
    const allowEmbed = process.env.ALLOW_EMBED === 'true'
    const frameAncestors = process.env.FRAME_ANCESTORS ?? "'self' https://*.e2b.app https://*.arena.ai"
    const framingHeaders = allowEmbed
      ? [{ key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors}` }]
      : [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ]
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          ...framingHeaders,
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ]
  },
}

export default nextConfig
