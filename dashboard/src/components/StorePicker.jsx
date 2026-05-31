import { Store } from 'lucide-react'

export default function StorePicker({ stores, selected, onChange }) {
  const displayStores = stores.length > 0
    ? stores
    : [{ store_id: selected }]

  return (
    <div className="flex items-center gap-3">
      <Store className="w-4 h-4 text-purple-400 flex-shrink-0" />
      <div className="flex gap-2 flex-wrap">
        {displayStores.map(s => (
          <button
            key={s.store_id}
            onClick={() => onChange(s.store_id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              s.store_id === selected
                ? 'bg-purple-600/30 border-purple-500/50 text-purple-300'
                : 'bg-slate-800/50 border-slate-700/50 text-slate-400 hover:border-purple-700/50 hover:text-slate-300'
            }`}
          >
            {s.store_id}
            {s.event_count ? (
              <span className="ml-1.5 text-slate-500">({s.event_count.toLocaleString()})</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
