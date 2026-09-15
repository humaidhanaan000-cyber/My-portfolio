import type { MetadataRoute } from 'next'

const siteUrl = process.env.APP_URL ?? 'http://localhost:3000'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  const routes: { path: string; priority: number; changeFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'weekly' },
    { path: '/pricing', priority: 0.9, changeFrequency: 'weekly' },
    { path: '/how-it-works', priority: 0.8, changeFrequency: 'monthly' },
    { path: '/safety', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/api-docs', priority: 0.6, changeFrequency: 'monthly' },
    { path: '/status', priority: 0.4, changeFrequency: 'daily' },
    { path: '/login', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/register', priority: 0.6, changeFrequency: 'yearly' },
  ]
  return routes.map((route) => ({
    url: `${siteUrl}${route.path}`,
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }))
}
