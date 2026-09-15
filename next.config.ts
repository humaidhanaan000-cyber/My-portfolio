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
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
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
