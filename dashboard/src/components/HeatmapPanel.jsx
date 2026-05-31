import { Thermometer } from 'lucide-react'

function intensityColor(score) {
  if (score >= 80) return 'bg-red-500/80 border-red-400/50'
  if (score >= 60) return 'bg-orange-500/70 border-orange-400/50'
  if (score >= 40) return 'bg-amber-500/60 border-amber-400/50'
  if (score >= 20) return 'bg-blue-500/50 border-blue-400/50'
  return 'bg-slate-700/40 border-slate-600/30'
}

function textColor(score) {
  if (score >= 40) return 'text-white'
  return 'text-slate-400'
}

export default function HeatmapPanel({ heatmap, loading }) {
  const zones = heatmap?.zones || []

  return (
    <div className="metric-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold flex items-center gap-2">
          <Thermometer className="w-4 h-4 text-orange-400" />
          Zone Heatmap
        </h2>
        {heatmap && (
          <span className={`text-xs px-2 py-0.5 rounded border ${
            heatmap.data_confidence === 'LOW'
              ? 'bg-amber-900/30 border-amber-500/30 text-amber-400'
              : 'bg-emerald-900/30 border-emerald-500/30 text-emerald-400'
          }`}>
            {heatmap.data_confidence}
          </span>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-slate-700/30 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : zones.length === 0 ? (
        <p className="text-slate-500 text-sm text-center py-8">No zone data yet</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {zones.slice(0, 9).map(zone => (
              <div
                key={zone.zone_id}
                className={`heatmap-cell rounded-lg border p-2 cursor-default ${intensityColor(zone.heatmap_score)}`}
                title={`${zone.zone_id}: ${zone.unique_visitors} visitors, ${zone.avg_dwell_seconds}s avg dwell`}
              >
                <div className={`text-xs font-semibold truncate ${textColor(zone.heatmap_score)}`}>
                  {zone.zone_id}
                </div>
                <div className={`text-xs mt-0.5 ${textColor(zone.heatmap_score)} opacity-80`}>
                  {zone.unique_visitors}v · {zone.avg_dwell_seconds}s
                </div>
                <div className="mt-1 h-1 bg-black/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white/40 rounded-full"
                    style={{ width: `${zone.heatmap_score}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Cold</span>
            <div className="flex gap-1">
              {['bg-slate-700/40', 'bg-blue-500/50', 'bg-amber-500/60', 'bg-orange-500/70', 'bg-red-500/80'].map((c, i) => (
                <div key={i} className={`w-4 h-2 rounded-sm ${c}`} />
              ))}
            </div>
            <span>Hot</span>
          </div>
        </>
      )}
    </div>
  )
}
