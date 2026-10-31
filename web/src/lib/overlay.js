/**
 * 弹层公共行为：ESC 关闭、焦点陷阱、关闭后焦点归还、背景滚动锁。
 *
 * 只接管键盘与焦点，不碰元素的显隐类名——打开/关闭仍由页面自己决定，
 * 页面在真正显示/隐藏弹层时调用 activateOverlay() 拿到的 handle.release()。
 *
 * 用法：
 *   const handle = activateOverlay(modalElement, {
 *     onRequestClose: () => closeAssetModal(),
 *     initialFocus: modalElement.querySelector('textarea'),
 *   })
 *   // 关闭时
 *   handle.release()
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')

/** 当前处于活动状态的弹层，栈顶即最新打开的那一层 */
const stack = []

let scrollLockCount = 0
let previousBodyOverflow = ''
let previousBodyPaddingRight = ''
let keydownBound = false

function focusablesIn(element) {
  return [...element.querySelectorAll(FOCUSABLE_SELECTOR)].filter(node =>
    node.offsetWidth > 0 || node.offsetHeight > 0 || node.getClientRects().length > 0,
  )
}

function handleKeydown(event) {
  const top = stack[stack.length - 1]
  if (!top) return

  if (event.key === 'Escape') {
    if (!top.onRequestClose) return
    event.preventDefault()
    event.stopPropagation()
    top.onRequestClose()
    return
  }

  if (event.key !== 'Tab') return

  const items = focusablesIn(top.element)
  if (!items.length) {
    event.preventDefault()
    return
  }

  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement

  if (!top.element.contains(active)) {
    event.preventDefault()
    first.focus()
    return
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function acquireScrollLock() {
  if (scrollLockCount === 0) {
    const gap = window.innerWidth - document.documentElement.clientWidth
    previousBodyOverflow = document.body.style.overflow
    previousBodyPaddingRight = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (gap > 0) document.body.style.paddingRight = `${gap}px`
  }
  scrollLockCount += 1
}

function releaseScrollLock() {
  scrollLockCount = Math.max(0, scrollLockCount - 1)
  if (scrollLockCount > 0) return
  document.body.style.overflow = previousBodyOverflow
  document.body.style.paddingRight = previousBodyPaddingRight
}

/**
 * 把元素登记为活动弹层。
 * @param {HTMLElement} element 弹层容器
 * @param {{ onRequestClose?: () => void, initialFocus?: HTMLElement | null, lockScroll?: boolean }} options
 * @returns {{ element: HTMLElement, release: () => void }}
 */
export function activateOverlay(element, options = {}) {
  if (!element) return { element: null, release() {} }

  const { onRequestClose = null, initialFocus = null, lockScroll = true } = options
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const handle = {
    element,
    onRequestClose,
    release() {
      const index = stack.indexOf(handle)
      if (index === -1) return
      stack.splice(index, 1)
      if (lockScroll) releaseScrollLock()
      if (!stack.length && keydownBound) {
        document.removeEventListener('keydown', handleKeydown, true)
        keydownBound = false
      }
      // 焦点归还给打开它的元素；元素已不在页面上就交给 body
      if (opener && opener.isConnected) opener.focus({ preventScroll: true })
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    },
  }

  stack.push(handle)
  if (lockScroll) acquireScrollLock()
  if (!keydownBound) {
    document.addEventListener('keydown', handleKeydown, true)
    keydownBound = true
  }

  const target = initialFocus || focusablesIn(element)[0] || element
  if (target === element && !element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1')
  window.requestAnimationFrame(() => target?.focus?.({ preventScroll: true }))

  return handle
}

/** 元素当前是否登记为活动弹层 */
export function isOverlayActive(element) {
  return stack.some(handle => handle.element === element)
}

/** 释放全部弹层（退出登录、切换项目等场景用） */
export function releaseAllOverlays() {
  while (stack.length) stack[stack.length - 1].release()
}