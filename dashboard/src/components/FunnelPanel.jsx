import { ChevronDown } from 'lucide-react'

const STAGE_COLORS = {
  entry:         'bg-purple-500',
  zone_visit:    'bg-blue-500',
  billing_queue: 'bg-amber-500',
  purchase:      'bg-emerald-500',
}

export default function FunnelPanel({ funnel, loading }) {
  const stages = funnel?.funnel || []
  const maxCount = stages[0]?.count || 1

  return (
    <div className="metric-card rounded-xl p-5">
      <h2 className="text-white font-semibold mb-4">Conversion Funnel</h2>

      {loading ? (
        <div className="space-y-4">
          {[100, 78, 52, 31].map((w, i) => (
            <div key={i} className="space-y-1">
              <div className="h-3 w-20 bg-slate-700/50 rounded animate-pulse" />
              <div className="h-6 bg-slate-700/30 rounded animate-pulse" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      ) : stages.length === 0 ? (
        <p className="text-slate-500 text-sm text-center py-8">No session data yet</p>
      ) : (
        <div className="space-y-3">
          {stages.map((stage, idx) => {
            const widthPct = maxCount > 0 ? (stage.count / maxCount) * 100 : 0
            const color = STAGE_COLORS[stage.stage] || 'bg-slate-500'
            const dropoff = funnel?.drop_off_pct

            return (
              <div key={stage.stage}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-slate-400">{stage.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white">
                      {stage.count.toLocaleString()}
                    </span>
                    <span className="text-xs text-slate-500">
                      {stage.pct_of_total}%
                    </span>
                  </div>
                </div>
                <div className="h-5 bg-slate-700/40 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${color} rounded-full funnel-bar transition-all duration-700`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                {idx < stages.length - 1 && dropoff && (
                  <div className="flex items-center gap-1 mt-1 ml-1">
                    <ChevronDown className="w-3 h-3 text-slate-600" />
                    <span className="text-xs text-slate-600">
                      {Object.values(dropoff)[idx]?.toFixed(1)}% drop-off
                    </span>
                  </div>
                )}
              </div>
            )
          })}

          {funnel?.session_count > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-700/50 flex justify-between text-xs">
              <span className="text-slate-500">Sessions: {funnel.session_count}</span>
              <span className="text-slate-500">
                Overall drop-off: {funnel.drop_off_pct?.overall}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
