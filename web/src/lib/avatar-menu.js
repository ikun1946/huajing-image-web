export function setupAvatarMenu({ shouldIgnoreOutsideClick } = {}) {
  const avatar = document.querySelector('#user-avatar')
  if (!avatar) return { close() {} }

  const syncExpanded = () => {
    const open = !avatar.classList.contains('is-dismissed') && (
      avatar.classList.contains('is-open')
      || avatar.matches(':hover')
      || avatar.contains(document.activeElement)
    )
    avatar.setAttribute('aria-expanded', String(open))
  }

  const close = (dismissed = false) => {
    avatar.classList.remove('is-open')
    avatar.classList.toggle('is-dismissed', dismissed)
    syncExpanded()
  }

  const reset = () => {
    avatar.classList.remove('is-open', 'is-dismissed')
    syncExpanded()
  }

  avatar.addEventListener('pointerenter', syncExpanded)
  avatar.addEventListener('pointerleave', reset)
  avatar.addEventListener('focusin', syncExpanded)
  avatar.addEventListener('focusout', event => {
    if (!avatar.contains(event.relatedTarget)) reset()
  })

  avatar.addEventListener('click', event => {
    event.stopPropagation()
    if (event.target.closest('#avatar-menu')) return
    if (avatar.classList.contains('is-open')) {
      close(true)
    } else {
      avatar.classList.remove('is-dismissed')
      avatar.classList.add('is-open')
      syncExpanded()
    }
  })

  avatar.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close(true)
    avatar.focus()
  })

  document.addEventListener('click', event => {
    if (shouldIgnoreOutsideClick?.(event)) return
    if (avatar.getAttribute('aria-expanded') === 'true') close(true)
  })

  syncExpanded()
  return { close }
}
