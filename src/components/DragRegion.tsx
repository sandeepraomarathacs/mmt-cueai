import { ReactNode, useCallback, useEffect, useRef } from 'react'

type Props = {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}

/**
 * Manual window drag for transparent frameless Electron on Windows.
 * CSS -webkit-app-region:drag often fails there.
 */
export default function DragRegion({ children, className, style }: Props) {
  const dragging = useRef(false)

  const onMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return
    window.cueaiDesktop?.dragMove?.({ screenX: e.screenX, screenY: e.screenY })
  }, [])

  const onUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    window.cueaiDesktop?.dragEnd?.()
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }, [onMove])

  useEffect(() => () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }, [onMove, onUp])

  return (
    <div
      className={className}
      style={{ cursor: 'default', ...style }}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        const target = e.target as HTMLElement
        if (target.closest('button, a, input, textarea, select, .no-drag')) return
        dragging.current = true
        window.cueaiDesktop?.dragStart?.({ screenX: e.screenX, screenY: e.screenY })
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }}
    >
      {children}
    </div>
  )
}
