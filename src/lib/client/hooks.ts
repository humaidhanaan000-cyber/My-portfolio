'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError, apiFetch } from './api'

export type QueryState<T> = {
  data: T | null
  meta: Record<string, unknown> | undefined
  error: string | null
  loading: boolean
  refresh: () => Promise<void>
  setData: (updater: (current: T | null) => T | null) => void
}

/**
 * Polling data hook. No third-party data library is used: the dashboard polls
 * real endpoints on an interval and re-renders only when the payload changes.
 */
export function useApi<T>(
  path: string | null,
  options: { query?: Record<string, string | number | boolean | undefined | null>; pollMs?: number; enabled?: boolean } = {},
): QueryState<T> {
  const [data, setData] = useState<T | null>(null)
  const [meta, setMeta] = useState<Record<string, unknown> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path) && options.enabled !== false)
  const queryKey = JSON.stringify(options.query ?? {})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!path || options.enabled === false) {
        setLoading(false)
        return
      }
      try {
        const result = await apiFetch<T>(path, { query: JSON.parse(queryKey) as Record<string, string>, signal })
        if (!mounted.current) return
        setData(result.data)
        setMeta(result.meta)
        setError(null)
      } catch (caught) {
        if (!mounted.current || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setError(caught instanceof ApiClientError ? caught.message : caught instanceof Error ? caught.message : 'Request failed')
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [path, queryKey, options.enabled],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!options.pollMs || options.enabled === false) return
    const timer = setInterval(() => void load(), options.pollMs)
    return () => clearInterval(timer)
  }, [load, options.pollMs, options.enabled])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  const setDataSafe = useCallback((updater: (current: T | null) => T | null) => {
    setData((current) => updater(current))
  }, [])

  return { data, meta, error, loading, refresh, setData: setDataSafe }
}

/** Small action-state helper for buttons that perform real work. */
export function useAction() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<unknown>(null)

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setPending(true)
    setError(null)
    try {
      const value = await fn()
      setResult(value)
      return value
    } catch (caught) {
      const message = caught instanceof ApiClientError ? caught.message : caught instanceof Error ? caught.message : 'Action failed'
      setError(message)
      return null
    } finally {
      setPending(false)
    }
  }, [])

  return { pending, error, result, run, clearError: () => setError(null) }
}
