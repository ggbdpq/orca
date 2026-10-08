import { useLayoutEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'

export function useEditorScrollRestore(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  scrollCacheKey: string,
  editor: Editor | null
): void {
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        // Why: a scroll burst while hidden (layout re-drop) must not overwrite the blur-time
        // snapshot. Accepted wedge risk: macOS can leave document.hidden stuck at true while the
        // window is actually visible (see stale-document-visibility.ts), which pauses saves until
        // the next blur — restore then reuses the last blur-time snapshot rather than fresh reads.
        if (!document.hidden) {
          setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        }
        throttleTimer = null
      }, 150)
    }

    // Why: macOS can drop an occluded window's scroll position; blur flushes the
    // pending save and reveal re-anchors from the cache before the user reads on (#24667).
    const flushPendingSave = (): void => {
      if (throttleTimer === null) {
        return
      }
      clearTimeout(throttleTimer)
      throttleTimer = null
      setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
    }
    const reanchorAfterReveal = (): void => {
      const cached = scrollTopCache.get(scrollCacheKey)
      if (
        cached === undefined ||
        cached <= 1 ||
        container.scrollTop > 1 ||
        container.scrollHeight <= container.clientHeight + 1
      ) {
        return
      }
      container.scrollTop = Math.min(cached, container.scrollHeight - container.clientHeight)
    }
    const onWindowBlur = flushPendingSave
    const onWindowFocus = reanchorAfterReveal
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        reanchorAfterReveal()
      }
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      // Zero-height StrictMode/early cleanup must not overwrite a valid cached scroll position before content renders.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [scrollContainerRef, scrollCacheKey])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0

    // Retry while asynchronous Tiptap hydration grows scrollHeight; the initial frame may not reach the cached offset.
    const tryRestore = (): void => {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const nextScrollTop = Math.min(targetScrollTop, maxScrollTop)
      container.scrollTop = nextScrollTop

      if (Math.abs(container.scrollTop - targetScrollTop) <= 1 || maxScrollTop >= targetScrollTop) {
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(tryRestore)
      }
    }

    tryRestore()
    return () => window.cancelAnimationFrame(frameId)
    // Restart when the editor becomes available or the retry budget could expire before hydration mounts content.
  }, [scrollContainerRef, scrollCacheKey, editor])
}
