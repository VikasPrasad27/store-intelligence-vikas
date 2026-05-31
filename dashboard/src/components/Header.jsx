import { RefreshCw, AlertTriangle, Wifi, WifiOff } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export default function Header({ connected, lastUpdated, anomalyCount, criticalCount, onRefresh }) {
  return (
    <header className="sticky top-0 z-50 bg-[#0f0f13]/90 backdrop-blur border-b border-purple-900/30 px-6 py-4">
      <div className="flex items-center justify-between">

        {/* Left: Brand */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-purple-800 flex items-center justify-center">
              <span className="text-white text-xs font-bold">AR</span>
            </div>
            <div>
              <h1 className="text-white font-semibold text-sm leading-tight">Apex Retail</h1>
              <p className="text-purple-400 text-xs">Store Intelligence</p>
            </div>
          </div>

          {/* Live indicator */}
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            connected
              ? 'bg-emerald-900/30 border-emerald-500/30 text-emerald-400'
              : 'bg-slate-800/50 border-slate-600/30 text-slate-400'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 live-dot' : 'bg-slate-500'}`} />
            {connected ? 'LIVE' : 'OFFLINE'}
          </div>
        </div>

        {/* Right: Status + refresh */}
        <div className="flex items-center gap-4">
          {anomalyCount > 0 && (
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border ${
              criticalCount > 0
                ? 'severity-CRITICAL border'
                : 'severity-WARN border'
            }`}>
              <AlertTriangle className="w-3.5 h-3.5" />
              {anomalyCount} anomal{anomalyCount === 1 ? 'y' : 'ies'}
              {criticalCount > 0 && ` (${criticalCount} critical)`}
            </div>
          )}

          {lastUpdated && (
            <span className="text-slate-500 text-xs hidden sm:block">
              Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
            </span>
          )}

          <button
            onClick={onRefresh}
            className="p-2 rounded-lg text-slate-400 hover:text-purple-400 hover:bg-purple-900/20 transition-colors"
            title="Refresh data"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  )
}
