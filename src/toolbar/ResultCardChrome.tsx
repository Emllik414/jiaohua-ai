import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
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

  const innerCardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
 const frameRef = useRef<number | null>(null);
  const autoFollowRef = useRef(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const effectiveRef = cardRef || innerCardRef;
 const [showScrollDown, setShowScrollDown] = useState<boolean>(false);
  const [popIn, setPopIn] = useState<boolean>(true);

  useEffect(() => {
    setPopIn(true);
    const t = setTimeout(() => setPopIn(false), 500);
    return () => clearTimeout(t);
  }, []);

  const scheduleResize = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const el = effectiveRef.current;
      if (!el) return;
      const headerH = headerRef.current?.offsetHeight ?? 0;
      const sourceH = sourceRef.current?.offsetHeight ?? 0;
      const answerH = answerRef.current?.scrollHeight ?? scrollRef.current?.scrollHeight ?? 0;
      const footerH = footerRef.current?.offsetHeight ?? 0;
      const chromeExtra = 24;
      const h = Math.ceil(headerH + sourceH + answerH + footerH + chromeExtra);
      if (h > 0) { try { (window.desktopApi as any).resizeResultBox?.({ height: h }); } catch (_) {} }
    });
  };

  useEffect(() => {
    if (popIn) return;
    const el = effectiveRef.current;
    if (!el) return;
    scheduleResize();
    const obs = new ResizeObserver(() => scheduleResize());
    obs.observe(el);
    return () => obs.disconnect();
  }, [popIn, effectiveRef]);

  useEffect(() => { scheduleResize(); }, [children]);

 useEffect(() => {
   const el = scrollRef.current;
   if (!el) return;
   const check = () => {
      const d = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (d <= 48) autoFollowRef.current = true;
      else if (d > 80) autoFollowRef.current = false;
      setShowScrollDown(!autoFollowRef.current && d > 48);
   };
   check();
   el.addEventListener('scroll', check);
   return () => el.removeEventListener('scroll', check);
 }, [children]);

 const scrollToBottom = () => {
   scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' as ScrollBehavior });
    autoFollowRef.current = true;
    setShowScrollDown(false);
 };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoFollowRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [children]);

  return (
    <div
      ref={effectiveRef}
      className={'result-card' + (popIn ? ' pop-in' : '')}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onMouseDown={onPointerDown}
      onPointerDown={onPointerDown}
    >
      <header ref={headerRef} className='result-card-header' onMouseDown={onHeaderMouseDown}
        style={{ WebkitAppRegion: 'drag' } as any}>
        <div className='top-drag-grip' />
        <span className='skill-avatar'><SkillIcon iconKey={skillIconKey || 'spark'} /></span>
        <div className='title-block'>
          <div className='title-row'>
            <span className='title'>{title}</span>
            <span className='ai-pill'>AI</span>
          </div>
          <div className='model-line'>{status === 'running' ? '正在生成中...' : subtitle}</div>
        </div>
        <button className='close-btn' onClick={onClose} title='关闭'
          style={{ WebkitAppRegion: 'no-drag' } as any}>
          <SkillIcon iconKey='close' />
        </button>
      </header>

      <div className='result-card-scroll-shell'>
        <div className='result-card-scroll' ref={scrollRef}>
          <section ref={sourceRef} className='source-quote'>
            <div className='source-head'>
              <span>原文</span>
              <button className='copy-inline' aria-label='复制原文' title='复制原文' onClick={() => { try { (window.desktopApi as any).copyText?.(selectedText, {silent: true}); } catch(_) {} }}><SkillIcon iconKey='copy' /></button>
            </div>
            <p className='source-text'>{selectedText}</p>
          </section>
          <section ref={answerRef} className='answer'>{children}</section>
        </div>

        <button className={'scroll-down-hint' + (showScrollDown ? ' show' : '')} onClick={scrollToBottom} title='滚动到底部' aria-hidden={!showScrollDown} tabIndex={showScrollDown ? 0 : -1}>
            <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
              <path d='M12 5v14' /><path d='m19 12-7 7-7-7' />
            </svg>
        </button>
      </div>

      <footer ref={footerRef} className='result-card-footer'>{footer}</footer>
      {statusLine ? <div className='status-line'>{statusLine}</div> : null}
    </div>
  )
}
