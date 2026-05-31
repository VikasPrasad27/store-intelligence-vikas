import { Users, ShoppingBag, Clock, TrendingUp, TrendingDown, RotateCcw, DollarSign } from 'lucide-react'

function MetricCard({ title, value, subtitle, icon: Icon, color, loading, trend }) {
  return (
    <div className="metric-card rounded-xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        {trend !== undefined && (
          <div className={`flex items-center gap-1 text-xs font-medium ${
            trend >= 0 ? 'text-emerald-400' : 'text-red-400'
          }`}>
            {trend >= 0
              ? <TrendingUp className="w-3.5 h-3.5" />
              : <TrendingDown className="w-3.5 h-3.5" />
            }
            {Math.abs(trend)}%
          </div>
        )}
      </div>
      {loading ? (
        <div className="space-y-2">
          <div className="h-8 w-24 bg-slate-700/50 rounded animate-pulse" />
          <div className="h-3 w-32 bg-slate-700/30 rounded animate-pulse" />
        </div>
      ) : (
        <>
          <div className="text-3xl font-bold text-white mb-1">{value}</div>
          <div className="text-xs text-slate-400">{subtitle}</div>
          <div className="text-xs text-slate-500 mt-1">{title}</div>
        </>
      )}
    </div>
  )
}

export default function MetricsPanel({ metrics, loading, storeId }) {
  const convPct = metrics
    ? `${(metrics.conversion_rate * 100).toFixed(1)}%`
    : '—'

  const abandonPct = metrics
    ? `${(metrics.abandonment_rate * 100).toFixed(1)}%`
    : '—'

  const revenue = metrics?.total_revenue_inr
    ? `₹${metrics.total_revenue_inr.toLocaleString('en-IN')}`
    : '—'

  const avgDwell = metrics?.avg_dwell_by_zone
    ? (() => {
        const zones = Object.values(metrics.avg_dwell_by_zone)
        if (!zones.length) return '—'
        const avg = zones.reduce((s, z) => s + (z.avg_dwell_seconds || 0), 0) / zones.length
        return `${Math.round(avg)}s`
      })()
    : '—'

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold">
          Live Metrics
          <span className="ml-2 text-slate-500 text-sm font-normal">— {storeId}</span>
        </h2>
        {metrics?.computed_at && (
          <span className="text-slate-500 text-xs">
            {new Date(metrics.computed_at).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricCard
          title="Unique Visitors"
          value={loading ? '—' : (metrics?.unique_visitors ?? 0).toLocaleString()}
          subtitle="Today (excl. staff)"
          icon={Users}
          color="bg-purple-600"
          loading={false}
        />
        <MetricCard
          title="Conversion Rate"
          value={convPct}
          subtitle="Visitors → Purchase"
          icon={ShoppingBag}
          color="bg-emerald-600"
          loading={false}
        />
        <MetricCard
          title="Revenue"
          value={revenue}
          subtitle={`${metrics?.transactions ?? 0} transactions`}
          icon={DollarSign}
          color="bg-blue-600"
          loading={false}
        />
        <MetricCard
          title="Queue Depth"
          value={loading ? '—' : String(metrics?.queue_depth ?? 0)}
          subtitle="Billing queue now"
          icon={Users}
          color={metrics?.queue_depth > 5 ? 'bg-red-600' : 'bg-amber-600'}
          loading={false}
        />
        <MetricCard
          title="Avg Dwell"
          value={avgDwell}
          subtitle="Across all zones"
          icon={Clock}
          color="bg-indigo-600"
          loading={false}
        />
        <MetricCard
          title="Abandon Rate"
          value={abandonPct}
          subtitle="Queue abandonments"
          icon={RotateCcw}
          color={metrics?.abandonment_rate > 0.3 ? 'bg-red-600' : 'bg-slate-600'}
          loading={false}
        />
      </div>
    </div>
  )
}
