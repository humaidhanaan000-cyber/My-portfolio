import type { Metadata, Viewport } from 'next'
import './globals.css'

const siteUrl = process.env.APP_URL ?? 'http://localhost:3000'
const appName = process.env.APP_NAME ?? 'AIBA'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName} — Autonomous Internet Business Agent`,
    template: `%s · ${appName}`,
  },
  description:
    'AIBA runs the day-to-day work of finding and building online business opportunities: it researches, scores, drafts and monitors — and stops for your approval before anything risky, public or paid.',
  keywords: [
    'business automation platform',
    'opportunity research software',
    'approval-gated automation',
    'AI business operations',
    'revenue tracking software',
  ],
  applicationName: appName,
  authors: [{ name: `${appName} operator` }],
  openGraph: {
    type: 'website',
    url: siteUrl,
    siteName: appName,
    title: `${appName} — Autonomous Internet Business Agent`,
    description:
      'Research, scoring, project execution and monitoring in one operator console. Every risky or paid action stops for your approval, and every financial figure is labelled as an estimate until it is verified.',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${appName} — Autonomous Internet Business Agent`,
    description: 'A business automation platform with hard budget limits and mandatory human approval for risky actions.',
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d1219',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
