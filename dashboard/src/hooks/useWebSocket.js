import { useState, useEffect, useRef, useCallback } from 'react'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4000/ws'
const MAX_EVENTS = 100

export function useWebSocket() {
  const [connected, setConnected] = useState(false)
  const [liveEvents, setLiveEvents] = useState([])
  const [lastMessage, setLastMessage] = useState(null)
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)
  const mountedRef = useRef(true)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) return
        setConnected(true)
        // Start ping/pong keepalive
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PING' }))
          }
        }, 30000)
        ws._pingInterval = pingInterval
      }

      ws.onmessage = (e) => {
        if (!mountedRef.current) return
        try {
          const msg = JSON.parse(e.data)
          setLastMessage(msg)

          if (msg.type === 'EVENTS_INGESTED') {
            const entry = {
              id: Date.now() + Math.random(),
              ...msg,
              received_at: new Date().toISOString(),
            }
            setLiveEvents(prev => [entry, ...prev].slice(0, MAX_EVENTS))
          }
        } catch (_) {}
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        setConnected(false)
        clearInterval(ws._pingInterval)
        // Reconnect after 3s
        reconnectTimer.current = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        ws.close()
      }
    } catch (_) {
      reconnectTimer.current = setTimeout(connect, 3000)
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      mountedRef.current = false
      clearTimeout(reconnectTimer.current)
      if (wsRef.current) {
        clearInterval(wsRef.current._pingInterval)
        wsRef.current.close()
      }
    }
  }, [connect])

  return { connected, liveEvents, lastMessage }
}
