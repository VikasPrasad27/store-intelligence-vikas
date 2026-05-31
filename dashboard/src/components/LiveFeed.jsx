import { Zap, Radio } from 'lucide-react'

const EVENT_COLORS = {
  ENTRY:                 'text-emerald-400',
  EXIT:                  'text-slate-400',
  ZONE_ENTER:            'text-blue-400',
  ZONE_EXIT:             'text-blue-300',
  ZONE_DWELL:            'text-indigo-400',
  BILLING_QUEUE_JOIN:    'text-amber-400',
  BILLING_QUEUE_ABANDON: 'text-red-400',
  REENTRY:               'text-purple-400',
}

const EVENT_DOT = {
  ENTRY:                 'bg-emerald-400',
  EXIT:                  'bg-slate-400',
  ZONE_ENTER:            'bg-blue-400',
  ZONE_EXIT:             'bg-blue-300',
  ZONE_DWELL:            'bg-indigo-400',
  BILLING_QUEUE_JOIN:    'bg-amber-400',
  BILLING_QUEUE_ABANDON: 'bg-red-400',
  REENTRY:               'bg-purple-400',
}

function EventTypeTag({ type }) {
  const color = EVENT_COLORS[type] || 'text-slate-400'
  const dot = EVENT_DOT[type] || 'bg-slate-400'
  return (
    <span className={`flex items-center gap-1 text-xs font-mono ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} flex-shrink-0`} />
      {type}
    </span>
  )
}

export default function LiveFeed({ events, connected, lastMessage }) {
  return (
    <div className="metric-card rounded-xl p-5 flex flex-col h-full min-h-[500px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <h2 className="text-white font-semibold flex items-center gap-2">
          <Radio className="w-4 h-4 text-purple-400" />
          Live Event Feed
        </h2>
        <div className={`flex items-center gap-1.5 text-xs ${
          connected ? 'text-emerald-400' : 'text-slate-500'
        }`}>
          <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 live-dot' : 'bg-slate-500'}`} />
          {connected ? 'Connected' : 'Reconnecting…'}
        </div>
      </div>

      {/* Stats bar */}
      {lastMessage?.type === 'EVENTS_INGESTED' && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-purple-900/20 border border-purple-500/20 flex-shrink-0">
          <div className="flex items-center gap-2 text-xs">
            <Zap className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-purple-300 font-medium">
              +{lastMessage.accepted} events
            </span>
            <span className="text-slate-500">from {lastMessage.store_id}</span>
          </div>
          {lastMessage.sample_event_types && (
            <div className="mt-1 flex flex-wrap gap-1">
              {lastMessage.sample_event_types.map(t => (
                <span key={t} className={`text-xs font-mono ${EVENT_COLORS[t] || 'text-slate-400'}`}>
                  {t}
                </span>
              )).reduce((acc, el, i) => {
                if (i > 0) acc.push(<span key={`sep-${i}`} className="text-slate-600">·</span>)
                acc.push(el)
                return acc
              }, [])}
            </div>
          )}
        </div>
      )}

      {/* Event list */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <Radio className="w-8 h-8 text-slate-700 mb-3" />
            <p className="text-slate-500 text-sm">Waiting for events…</p>
            <p className="text-slate-600 text-xs mt-1">
              Run the detection pipeline to see live data
            </p>
          </div>
        ) : (
          events.map(evt => (
            <div
              key={evt.id}
              className="event-item px-3 py-2.5 rounded-lg bg-slate-800/50 border border-slate-700/40 hover:border-slate-600/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-xs text-slate-300 font-medium">{evt.store_id}</span>
                <span className="text-xs text-slate-600 flex-shrink-0">
                  {new Date(evt.received_at).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-1">
                  {(evt.sample_event_types || []).map(t => (
                    <EventTypeTag key={t} type={t} />
                  ))}
                </div>
                {evt.accepted !== undefined && (
                  <span className="text-xs text-slate-500">×{evt.accepted}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {events.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-700/50 flex-shrink-0">
          <p className="text-xs text-slate-600 text-center">
            {events.length} batch{events.length !== 1 ? 'es' : ''} received this session
          </p>
        </div>
      )}
    </div>
  )
}
