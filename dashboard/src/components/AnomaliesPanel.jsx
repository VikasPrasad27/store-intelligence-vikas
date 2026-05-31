import { AlertTriangle, AlertCircle, Info, ShieldAlert } from 'lucide-react'

const SEVERITY_ICON = {
  CRITICAL: ShieldAlert,
  WARN: AlertTriangle,
  INFO: Info,
}

const SEVERITY_CLASS = {
  CRITICAL: 'severity-CRITICAL border',
  WARN: 'severity-WARN border',
  INFO: 'severity-INFO border',
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  return `${Math.floor(min / 60)}h ago`
}

export default function AnomaliesPanel({ anomalies, loading }) {
  const items = anomalies?.anomalies || []

  return (
    <div className="metric-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          Active Anomalies
        </h2>
        {anomalies && (
          <span className="text-xs text-slate-500">
            {items.length} active · {new Date(anomalies.computed_at).toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="h-16 bg-slate-700/30 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-6 rounded-lg bg-emerald-900/20 border border-emerald-500/20">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-emerald-400 text-sm">All systems normal — no anomalies detected</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {items.map((anomaly, idx) => {
            const Icon = SEVERITY_ICON[anomaly.severity] || Info
            const cls = SEVERITY_CLASS[anomaly.severity] || SEVERITY_CLASS.INFO

            return (
              <div key={idx} className={`rounded-lg p-4 ${cls}`}>
                <div className="flex items-start gap-3">
                  <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide">
                        {anomaly.type.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs opacity-60 ml-2 flex-shrink-0">
                        {timeAgo(anomaly.detected_at)}
                      </span>
                    </div>
                    <p className="text-xs opacity-90 mb-2">{anomaly.message}</p>
                    <p className="text-xs opacity-60 italic">{anomaly.suggested_action}</p>
                    {anomaly.current_value !== undefined && anomaly.current_value !== null && (
                      <div className="mt-2 flex gap-3 text-xs opacity-70">
                        <span>Now: <strong>{anomaly.current_value}</strong></span>
                        {anomaly.baseline_value !== null && (
                          <span>Baseline: <strong>{anomaly.baseline_value}</strong></span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
