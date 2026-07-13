import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { SkillIcon } from '../components/SkillIcon'
import './toolbar.css'

type ResultCardChromeProps = {
  title: string
  subtitle: string
  status: string
  sourceExpanded: boolean
  selectedText: string
  skillIconKey?: string
  cardRef?: RefObject<HTMLDivElement>
  footer: ReactNode
  statusLine?: string
  children: ReactNode
  onToggleSource: () => void
  onClose: () => void
  onHeaderMouseDown: (event: ReactMouseEvent) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPointerDown: () => void
}

type ScrollMode = 'following' | 'reading' | 'returning'
type ResizeSnapshot = {
  screenY: number
  scrollTop: number
  bottomDistance: number
  mode: ScrollMode
  anchorElement: Element | null
  anchorScreenTop: number
}

const RESULT_STREAM_BASE_HEIGHT = 360
const RESULT_STREAM_RESIZE_STEP = 26
const RESULT_RESIZE_BATCH_MS = 120
const FOLLOW_BOTTOM_DISTANCE = 40
const READING_BOTTOM_DISTANCE = 78

export function ResultCardChrome({
  title,
  subtitle,
  status,
  selectedText,
  skillIconKey,
  cardRef,
  footer,
  statusLine,
  children,
  onClose,
  onHeaderMouseDown,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
}: ResultCardChromeProps) {
  const innerCardRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const resizeTimerRef = useRef<number | null>(null)
  const lastResizeAtRef = useRef(0)
  const lastRequestedHeightRef = useRef(0)
  const nativeHeightLimitRef = useRef(Number.POSITIVE_INFINITY)
  const headerRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const wasStreamingRef = useRef(false)
  const scrollModeRef = useRef<ScrollMode>('following')
  const programmaticScrollRef = useRef(false)
  const resizeSnapshotRef = useRef<ResizeSnapshot | null>(null)
  const effectiveRef = cardRef || innerCardRef
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [popIn, setPopIn] = useState(true)

  const distanceFromBottom = (element: HTMLDivElement) =>
    Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)

  const markProgrammaticScroll = (callback: () => void) => {
    programmaticScrollRef.current = true
    callback()
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }

  const refreshScrollAffordance = (event?: Event) => {
    const element = scrollRef.current
    if (!element) return
    const distance = distanceFromBottom(element)
    const trustedManualScroll = Boolean(event?.isTrusted) && !programmaticScrollRef.current

    if (scrollModeRef.current === 'returning' && distance <= FOLLOW_BOTTOM_DISTANCE) {
      scrollModeRef.current = 'following'
    } else if (scrollModeRef.current === 'reading' && distance <= FOLLOW_BOTTOM_DISTANCE) {
      scrollModeRef.current = 'following'
    } else if (
      scrollModeRef.current === 'following' &&
      trustedManualScroll &&
      distance > READING_BOTTOM_DISTANCE
    ) {
      scrollModeRef.current = 'reading'
    }

    setShowScrollDown(scrollModeRef.current !== 'following' && distance > FOLLOW_BOTTOM_DISTANCE)
  }

  const findVisibleAnchor = () => {
    const viewport = scrollRef.current
    if (!viewport) return null
    const viewportRect = viewport.getBoundingClientRect()
    const candidates: Element[] = []
    if (sourceRef.current) candidates.push(sourceRef.current)
    if (answerRef.current) {
      const blocks = Array.from(answerRef.current.querySelectorAll(':scope > *'))
      candidates.push(...(blocks.length ? blocks : [answerRef.current]))
    }
    return candidates.find((element) => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > viewportRect.top + 2 && rect.top < viewportRect.bottom - 2
    }) || null
  }

  const captureResizeSnapshot = () => {
    const element = scrollRef.current
    if (!element) return
    const anchorElement = scrollModeRef.current === 'reading' ? findVisibleAnchor() : null
    resizeSnapshotRef.current = {
      screenY: window.screenY,
      scrollTop: element.scrollTop,
      bottomDistance: distanceFromBottom(element),
      mode: scrollModeRef.current,
      anchorElement,
      anchorScreenTop: anchorElement
        ? window.screenY + anchorElement.getBoundingClientRect().top
        : 0,
    }
  }

  useEffect(() => {
    setPopIn(true)
    const timer = window.setTimeout(() => setPopIn(false), 500)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (status === 'running' && !wasStreamingRef.current) {
      lastRequestedHeightRef.current = RESULT_STREAM_BASE_HEIGHT
      nativeHeightLimitRef.current = Number.POSITIVE_INFINITY
      scrollModeRef.current = 'following'
      setShowScrollDown(false)
    }
    wasStreamingRef.current = status === 'running'
  }, [status])

  useEffect(() => {
    const restoreAfterNativeResize = () => {
      const snapshot = resizeSnapshotRef.current
      const element = scrollRef.current
      if (!snapshot || !element) return
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const current = resizeSnapshotRef.current
          const scrollElement = scrollRef.current
          if (!current || !scrollElement) return
          markProgrammaticScroll(() => {
            if (current.mode === 'reading') {
              const anchor = current.anchorElement
              if (anchor && anchor.isConnected) {
                const currentScreenTop = window.screenY + anchor.getBoundingClientRect().top
                scrollElement.scrollTop += currentScreenTop - current.anchorScreenTop
              } else {
                scrollElement.scrollTop = Math.max(
                  0,
                  current.scrollTop + (window.screenY - current.screenY),
                )
              }
            } else {
              scrollElement.scrollTop = Math.max(
                0,
                scrollElement.scrollHeight - scrollElement.clientHeight - current.bottomDistance,
              )
            }
          })
          resizeSnapshotRef.current = null
          refreshScrollAffordance()
        })
      })
    }
    window.addEventListener('resize', restoreAfterNativeResize)
    return () => window.removeEventListener('resize', restoreAfterNativeResize)
  }, [])

  const scheduleResize = () => {
    if (popIn || resizeTimerRef.current !== null) return
    const elapsed = performance.now() - lastResizeAtRef.current
    const delay = Math.max(0, RESULT_RESIZE_BATCH_MS - elapsed)
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        lastResizeAtRef.current = performance.now()
        const headerHeight = headerRef.current?.offsetHeight ?? 0
        const sourceHeight = sourceRef.current?.offsetHeight ?? 0
        const answerHeight = answerRef.current?.scrollHeight ?? scrollRef.current?.scrollHeight ?? 0
        const footerHeight = footerRef.current?.offsetHeight ?? 0
        const desiredHeight = Math.ceil(headerHeight + sourceHeight + answerHeight + footerHeight + 24)
        if (desiredHeight <= 0) return

        const previousHeight = lastRequestedHeightRef.current
        const heightLimit = nativeHeightLimitRef.current
        if (Number.isFinite(heightLimit) && previousHeight >= heightLimit && desiredHeight >= heightLimit) {
          return
        }

        const streaming = status === 'running'
        const growsByLine = desiredHeight >= Math.max(
          RESULT_STREAM_BASE_HEIGHT,
          previousHeight + RESULT_STREAM_RESIZE_STEP,
        )
        const finalSizeChanged = !streaming && (
          previousHeight === 0 ||
          Math.abs(desiredHeight - previousHeight) >= RESULT_STREAM_RESIZE_STEP
        )
        if (!growsByLine && !finalSizeChanged) return

        lastRequestedHeightRef.current = desiredHeight
        captureResizeSnapshot()
        try {
          const request = (window.desktopApi as any).resizeResultBox?.({ height: desiredHeight })
          void Promise.resolve(request).then((result: any) => {
            const nextLimit = Number(result?.heightLimit)
            if (Number.isFinite(nextLimit) && nextLimit > 0) {
              nativeHeightLimitRef.current = nextLimit
            }
          })
        } catch (_) {}
      })
    }, delay)
  }

  useEffect(() => {
    if (popIn) return
    scheduleResize()
    const observer = new ResizeObserver(() => scheduleResize())
    const observed = [headerRef.current, sourceRef.current, answerRef.current, footerRef.current]
      .filter((element): element is Element => Boolean(element))
    observed.forEach((element) => observer.observe(element))
    return () => {
      observer.disconnect()
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [popIn])

  useEffect(() => {
    scheduleResize()
  }, [children, status])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const onScroll = (event: Event) => refreshScrollAffordance(event)
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        scrollModeRef.current = 'reading'
        setShowScrollDown(true)
      }
    }
    element.addEventListener('scroll', onScroll)
    element.addEventListener('wheel', onWheel, { passive: true })
    refreshScrollAffordance()
    return () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', onWheel)
    }
  }, [])

  const scrollToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    scrollModeRef.current = 'returning'
    setShowScrollDown(false)
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || scrollModeRef.current !== 'following') return
    markProgrammaticScroll(() => {
      element.scrollTop = element.scrollHeight
    })
    refreshScrollAffordance()
  }, [children])

  return (
    <div
      ref={effectiveRef}
      className={'result-card' + (popIn ? ' pop-in' : '') + (status === 'running' ? ' is-streaming' : '')}
      style={{
        height: '100vh',
        minHeight: 0,
        maxHeight: 'none',
        boxSizing: 'border-box',
        transition: 'box-shadow 180ms ease',
      }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onMouseDown={onPointerDown}
      onPointerDown={onPointerDown}
    >
      <header
        ref={headerRef}
        className='result-card-header'
        onMouseDown={onHeaderMouseDown}
        style={{ WebkitAppRegion: 'drag' } as any}
      >
        <div className='top-drag-grip' />
        <span className='skill-avatar'><SkillIcon iconKey={skillIconKey || 'spark'} /></span>
        <div className='title-block'>
          <div className='title-row'>
            <span className='title'>{title}</span>
            <span className='ai-pill'>AI</span>
          </div>
          <div className='model-line'>{status === 'running' ? '正在生成中...' : subtitle}</div>
        </div>
        <button
          className='close-btn'
          onClick={onClose}
          title='关闭'
          style={{ WebkitAppRegion: 'no-drag' } as any}
        >
          <SkillIcon iconKey='close' />
        </button>
      </header>

      <div className='result-card-scroll-shell'>
        <div
          className='result-card-scroll'
          ref={scrollRef}
          style={{
            scrollBehavior: 'auto',
            overflowAnchor: 'none',
            overscrollBehavior: 'contain',
          } as any}
        >
          <section ref={sourceRef} className='source-quote'>
            <div className='source-head'>
              <span>原文</span>
              <button
                className='copy-inline'
                aria-label='复制原文'
                title='复制原文'
                onClick={() => {
                  try { void (window.desktopApi as any).copyText?.(selectedText, { silent: true }) } catch (_) {}
                }}
              >
                <SkillIcon iconKey='copy' />
              </button>
            </div>
            <p className='source-text'>{selectedText}</p>
          </section>
          <section ref={answerRef} className='answer'>{children}</section>
          {statusLine ? <div className='status-line'>{statusLine}</div> : null}
        </div>

        <button
          className={'scroll-down-hint' + (showScrollDown ? ' show' : '')}
          onClick={scrollToBottom}
          title='滚动到底部'
          aria-hidden={!showScrollDown}
          tabIndex={showScrollDown ? 0 : -1}
        >
          <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
            <path d='M12 5v14' /><path d='m19 12-7 7-7-7' />
          </svg>
        </button>
      </div>

      <footer ref={footerRef} className='result-card-footer'>{footer}</footer>
    </div>
  )
}
