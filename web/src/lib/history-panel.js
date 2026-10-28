import { fetchHistory } from './api.js'
import { escapeAttr, escapeHtml, formatDateTime, qs } from './dom.js'

/* 滚轮边界守卫：滚动本身交回浏览器原生处理（方向、速度、系统的反向滚动设置都照旧），
   只在「已经到顶/到底还继续往外滚」时拦下事件，避免把滚动传给后面的页面。
   指针落在滚动容器之外、但仍在同一块面板上时（标题、搜索框），把滚动转交给容器。 */
const LINE_HEIGHT = 16

function wheelDelta(scroller, event) {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT
  if (event.deltaMode === 2) return event.deltaY * scroller.clientHeight
  return event.deltaY
}

function isScrollable(element) {
  return element.scrollHeight - element.clientHeight > 1
}

function isAtEdge(scroller, delta) {
  return delta < 0
    ? scroller.scrollTop <= 0
    : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
}

function guardWheel(scroller, host = scroller.parentElement) {
  ;(host || scroller).addEventListener('wheel', event => {
    if (event.ctrlKey) return            // 保留 Ctrl+滚轮 缩放
    if (!isScrollable(scroller)) return  // 容器自己不可滚，交给页面
    const delta = wheelDelta(scroller, event)
    if (!Number.isFinite(delta) || delta === 0) return

    if (isAtEdge(scroller, delta)) {
      event.preventDefault()             // 到边界：拦住，不再外溢到页面
      return
    }
    if (!scroller.contains(event.target)) {
      event.preventDefault()
      scroller.scrollBy(0, delta)
    }
  }, { passive: false })
}

/**
 * 生成记录面板：挂在页面右上角头像菜单下，
 * 调用 setupHistoryPanel() 即可接入，入口按钮需自带 id="history-button"。
 * 面板结构与样式见 history-panel.css。
 */
export function setupHistoryPanel() {
  const panel = qs('#history-panel')
  const button = qs('#history-button')
  if (!panel || !button) return

  const list = qs('#history-list', panel)
  const searchInput = qs('#history-search', panel)
  const closeButton = qs('#history-close', panel)
  const meta = qs('#history-meta', panel)

  let records = []
  let keyword = ''
  let loaded = false

  function open() {
    panel.classList.add('visible')
    document.body.classList.add('history-open')
    if (!loaded) load()
  }

  function close() {
    panel.classList.remove('visible')
    document.body.classList.remove('history-open')
  }

  async function load() {
    list.innerHTML = '<div class="history-loading">正在载入生成记录…</div>'
    try {
      const result = await fetchHistory(200)
      records = Array.isArray(result?.entries) ? result.entries : []
      loaded = true
      meta.textContent = `共 ${records.length} 条`
      render()
    } catch (error) {
      list.innerHTML = `<div class="history-empty">${escapeHtml(error.message || '载入失败，请稍后重试')}</div>`
    }
  }

  function filtered() {
    if (!keyword) return records
    const lower = keyword.toLowerCase()
    return records.filter(record =>
      [record.name, record.prompt, record.category]
        .some(field => String(field || '').toLowerCase().includes(lower)))
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '耗时未知'
    if (ms < 1000) return `${ms} 毫秒`
    return `${(ms / 1000).toFixed(1)} 秒`
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return ''
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }

  function sourceLabel(source) {
    if (source === 'batch') return '批量'
    if (source === 'free') return '自由创作'
    return '单张'
  }

  function render() {
    const rows = filtered()
    if (!rows.length) {
      list.innerHTML = `<div class="history-empty">${records.length ? '没有匹配的记录' : '还没有生成记录'}</div>`
      return
    }

    list.innerHTML = rows.map((record, index) => `
      <li class="history-item" data-index="${index}">
        <button class="history-thumb" type="button" data-action="view" title="查看大图">
          <img src="${escapeAttr(record.imageUrl)}" alt="${escapeAttr(record.name || '生成图片')}" loading="lazy">
        </button>
        <div class="history-body">
          <div class="history-title-row">
            <span class="history-name" title="${escapeAttr(record.name)}">${escapeHtml(record.name || '未命名')}</span>
            <span class="history-badge">${escapeHtml(sourceLabel(record.source))} · ${escapeHtml(record.category)}</span>
          </div>
          <p class="history-prompt" title="${escapeAttr(record.prompt)}">${escapeHtml(record.prompt || '（无提示词）')}</p>
          <div class="history-facts">
            <span>${escapeHtml(formatDateTime(record.createdAt))}</span>
            <span>${escapeHtml(formatDuration(record.durationMs))}</span>
            <span>${escapeHtml(record.ratio || '')} · ${record.width || '?'} × ${record.height || '?'}</span>
            <span>${escapeHtml(formatBytes(record.bytes))}</span>
            <span>${escapeHtml(tokensLabel(record))}</span>
          </div>
        </div>
        <div class="history-actions">
          <button class="history-mini" type="button" data-action="view" title="查看大图">查看</button>
          <button class="history-mini" type="button" data-action="download" title="下载原图">下载</button>
        </div>
      </li>
    `).join('')
  }

  // 事件委托：列表内所有按钮 + 大图遮罩
  panel.addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (target) {
      const item = target.closest('.history-item')
      const record = item ? filtered()[Number(item.dataset.index)] : null
      if (!record) return

      if (target.dataset.action === 'view') {
        openLightbox(record)
      } else if (target.dataset.action === 'download') {
        download(record)
      }
      return
    }

    if (event.target === panel) close()
  })

  closeButton?.addEventListener('click', close)
  button.addEventListener('click', event => {
    event.stopPropagation()
    panel.classList.contains('visible') ? close() : open()
  })

  /* 滚轮交给浏览器原生滚动处理：方向、速度、系统里的「反向滚动」设置都照旧生效，
     我们只在滚到边界时 preventDefault，避免把剩余的滚动传给后面的页面。
     之前是手动 list.scrollTop += delta，方向完全取决于我们算出来的增量——
     一旦归一化和浏览器的增量单位对不上，看起来就会是「滚轮往下、内容往上」。
     原生滚动没有这层换算，方向永远和页面其它地方一致。 */
  guardWheel(list)

  searchInput?.addEventListener('input', () => {
    keyword = searchInput.value.trim()
    render()
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.classList.contains('visible')) close()
  })
}

/**
 * token 用量文案：上游返回真实值优先；本地估算值明确标注「估算」，
 * 避免被误解为计费依据。
 */
function tokensLabel(record) {
  const input = Number(record.tokensInput)
  if (!Number.isFinite(input) || input <= 0) return ''
  const output = Number(record.tokensOutput)
  const hasOutput = Number.isFinite(output) && output > 0
  const estimated = record.tokensSource !== 'upstream'
  const value = hasOutput ? `${input} 入 / ${output} 出` : `${input} 入`
  return `token ${value}${estimated ? '（估算）' : ''}`
}

function openLightbox(record) {
  let lightbox = qs('#history-lightbox')
  if (!lightbox) {
    lightbox = document.createElement('div')
    lightbox.id = 'history-lightbox'
    lightbox.className = 'history-lightbox'
    lightbox.innerHTML = `
      <figure class="history-lightbox-stage">
        <img id="history-lightbox-image" alt="生成图片大图">
        <figcaption id="history-lightbox-caption"></figcaption>
        <div class="history-lightbox-prompt">
          <div class="history-lightbox-prompt-head">
            <span>提示词</span>
            <span class="history-lightbox-tokens" id="history-lightbox-tokens"></span>
            <button class="history-prompt-copy" id="history-prompt-copy" type="button" title="复制提示词">复制</button>
          </div>
          <p class="history-lightbox-prompt-text" id="history-lightbox-prompt-text"></p>
        </div>
        <button class="history-lightbox-close" type="button" aria-label="关闭大图">✕</button>
      </figure>
    `
    document.body.append(lightbox)

    // 复制大图下方的提示词
    lightbox.addEventListener('click', async event => {
      const copyButton = event.target.closest('#history-prompt-copy')
      if (copyButton) {
        const text = qs('#history-lightbox-prompt-text', lightbox)?.dataset.raw || ''
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const helper = document.createElement('textarea')
          helper.value = text
          document.body.append(helper)
          helper.select()
          document.execCommand('copy')
          helper.remove()
        }
        copyButton.textContent = '已复制'
        setTimeout(() => { copyButton.textContent = '复制' }, 1500)
        return
      }

      if (event.target === lightbox || event.target.closest('.history-lightbox-close')) {
        lightbox.classList.remove('visible')
      }
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') lightbox.classList.remove('visible')
    })
  }

  // 提示词区可滚动：滚轮只在它内部生效，到边界不外溢
  const promptBlock = qs('#history-lightbox-prompt-text', lightbox)
  if (promptBlock && !promptBlock.dataset.wheelBound) {
    promptBlock.dataset.wheelBound = '1'
    guardWheel(promptBlock, promptBlock.closest('.history-lightbox-prompt') || promptBlock)
  }

  qs('#history-lightbox-image', lightbox).src = record.imageUrl
  qs('#history-lightbox-caption', lightbox).textContent =
    `${record.name || '未命名'} · ${record.ratio || ''} · ${record.width || '?'} × ${record.height || '?'}`
  const promptText = qs('#history-lightbox-prompt-text', lightbox)
  promptText.textContent = record.prompt || '（该记录没有提示词，可能是旧版生成的）'
  promptText.dataset.raw = record.prompt || ''
  const tokenNote = qs('#history-lightbox-tokens', lightbox)
  if (tokenNote) {
    const label = tokensLabel(record)
    tokenNote.textContent = label
  }
  lightbox.classList.add('visible')
}

function download(record) {
  const link = document.createElement('a')
  link.href = record.imageUrl
  link.download = `${record.name || '画境'}.${(record.imageUrl.split('.').pop() || 'png').split('?')[0]}`
  document.body.append(link)
  link.click()
  link.remove()
}
