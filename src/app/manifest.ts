import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AIBA — Autonomous Internet Business Agent',
    short_name: 'AIBA',
    description: 'Operator console for autonomous business research, execution and monitoring.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#0d1219',
    theme_color: '#0d1219',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }
}
