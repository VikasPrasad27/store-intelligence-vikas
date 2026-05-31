import { useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useStoreData } from './hooks/useStoreData'
import MetricsPanel from './components/MetricsPanel'
import FunnelPanel from './components/FunnelPanel'
import HeatmapPanel from './components/HeatmapPanel'
import AnomaliesPanel from './components/AnomaliesPanel'
import LiveFeed from './components/LiveFeed'
import Header from './components/Header'
import StorePicker from './components/StorePicker'
import { formatDistanceToNow } from 'date-fns'

const DEFAULT_STORE = 'STORE_BLR_002'

export default function App() {
  const [storeId, setStoreId] = useState(DEFAULT_STORE)
  const { connected, liveEvents, lastMessage } = useWebSocket()
  const { metrics, funnel, heatmap, anomalies, stores, loading, error, lastUpdated, refetch } =
    useStoreData(storeId, 15000)

  const anomalyCount = anomalies?.anomaly_count || 0
  const criticalCount = anomalies?.anomalies?.filter(a => a.severity === 'CRITICAL').length || 0

  return (
    <div className="min-h-screen bg-[#0f0f13]">
      {/* Header */}
      <Header
        connected={connected}
        lastUpdated={lastUpdated}
        anomalyCount={anomalyCount}
        criticalCount={criticalCount}
        onRefresh={refetch}
      />

      {/* Store picker */}
      <div className="px-6 pt-4 pb-2">
        <StorePicker
          stores={stores}
          selected={storeId}
          onChange={setStoreId}
        />
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-500/30 text-red-300 text-sm">
          ⚠ API Error: {error} — ensure the API is running and CORS is configured.
        </div>
      )}

      {/* Main grid */}
      <div className="px-6 pb-8 grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* LEFT COLUMN: Metrics + Funnel + Heatmap */}
        <div className="xl:col-span-2 flex flex-col gap-6">
          <MetricsPanel metrics={metrics} loading={loading} storeId={storeId} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <FunnelPanel funnel={funnel} loading={loading} />
            <HeatmapPanel heatmap={heatmap} loading={loading} />
          </div>
          <AnomaliesPanel anomalies={anomalies} loading={loading} />
        </div>

        {/* RIGHT COLUMN: Live feed */}
        <div className="flex flex-col gap-6">
          <LiveFeed events={liveEvents} connected={connected} lastMessage={lastMessage} />
        </div>
      </div>
    </div>
  )
}
