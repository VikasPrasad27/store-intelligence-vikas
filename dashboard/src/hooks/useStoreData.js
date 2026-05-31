import { useState, useEffect, useCallback } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

async function apiFetch(path) {
  const resp = await fetch(`${API_BASE}${path}`)
  if (!resp.ok) throw new Error(`API ${resp.status}: ${path}`)
  return resp.json()
}

export function useStoreData(storeId, pollInterval = 15000) {
  const [metrics, setMetrics]     = useState(null)
  const [funnel, setFunnel]       = useState(null)
  const [heatmap, setHeatmap]     = useState(null)
  const [anomalies, setAnomalies] = useState(null)
  const [stores, setStores]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchAll = useCallback(async () => {
    if (!storeId) return
    try {
      const [m, f, h, a] = await Promise.allSettled([
        apiFetch(`/stores/${storeId}/metrics`),
        apiFetch(`/stores/${storeId}/funnel`),
        apiFetch(`/stores/${storeId}/heatmap`),
        apiFetch(`/stores/${storeId}/anomalies`),
      ])
      if (m.status === 'fulfilled') setMetrics(m.value.data)
      if (f.status === 'fulfilled') setFunnel(f.value.data)
      if (h.status === 'fulfilled') setHeatmap(h.value.data)
      if (a.status === 'fulfilled') setAnomalies(a.value.data)
      setLastUpdated(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [storeId])

  // Fetch store list once
  useEffect(() => {
    apiFetch('/stores')
      .then(d => setStores(d.stores || []))
      .catch(() => {})
  }, [])

  // Poll
  useEffect(() => {
    fetchAll()
    const timer = setInterval(fetchAll, pollInterval)
    return () => clearInterval(timer)
  }, [fetchAll, pollInterval])

  return { metrics, funnel, heatmap, anomalies, stores, loading, error, lastUpdated, refetch: fetchAll }
}
