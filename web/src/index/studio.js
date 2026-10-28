
import { fetchServerConfig, generateImage, logout } from '../lib/api.js'
import { getImageExtension } from '../lib/dom.js'
import { setupHistoryPanel } from '../lib/history-panel.js'
import { requireLogin } from '../lib/guard.js'

    // 未登录先跳转登录页
    requireLogin()
      .then(user => {
        const label = document.querySelector('#header-user')
        if (label) label.textContent = user.displayName || user.username

        // 头像里显示用户名首字
        const letter = document.querySelector('#avatar-letter')
        if (letter) {
          const source = user.displayName || user.username || '境'
          letter.textContent = Array.from(source)[0] || '境'
        }
      })
      .catch(() => {})

    setupHistoryPanel()

    document.querySelector('#logout-button')?.addEventListener('click', async () => {
      await logout().catch(() => {})
      window.location.replace('/login.html')
    })

    // 点击头像也能开合菜单，触屏设备友好；打开菜单时不让面板误关
    document.querySelector('#user-avatar')?.addEventListener('click', event => {
      event.stopPropagation()
      document.querySelector('#user-avatar')?.classList.toggle('is-open')
    })

    document.addEventListener('click', event => {
      const avatar = document.querySelector('#user-avatar')
      if (!avatar) return
      if (event.target.closest?.('#history-panel')) return
      avatar.classList.remove('is-open')
    })

    const form = document.querySelector('#generate-form')
    const promptInput = document.querySelector('#prompt')
    const count = document.querySelector('#count')
    const submitButton = document.querySelector('#submit-button')
    const imageOptions = document.querySelector('#image-options')
    const status = document.querySelector('#status')
    const preview = document.querySelector('#preview')
    const resultImage = document.querySelector('#result-image')
    const progressWrap = document.querySelector('#progress-wrap')
    const progressBar = document.querySelector('#progress-bar')
    const progressTrack = document.querySelector('#progress-track')
    const progressLabel = document.querySelector('#progress-label')
    const elapsedLabel = document.querySelector('#elapsed')
    const ratioNote = document.querySelector('#ratio-note')
    const dimensionsLabel = document.querySelector('#output-dimensions')
    const downloadButton = document.querySelector('#download-button')
    const maximizeButton = document.querySelector('#maximize-button')
    const lightbox = document.querySelector('#lightbox')
    const lightboxImage = document.querySelector('#lightbox-image')
    const lightboxClose = document.querySelector('#lightbox-close')
    const promptMaximize = document.querySelector('#prompt-maximize')
    const promptCopy = document.querySelector('#prompt-copy')

    let progressTimer = 0
    let elapsedTimer = 0
    let startedAt = 0
    let simulatedProgress = 0
    let currentImageUrl = ''
    let currentImageExtension = 'png'

    // 画面比例由后端 /api/config 统一定义，此处仅作离线兜底
    const fallbackRatios = {
      '1:1': { width: 1, height: 1, nativeWidth: 1254, nativeHeight: 1254 },
      '4:3': { width: 4, height: 3, nativeWidth: 1448, nativeHeight: 1086 },
      '3:4': { width: 3, height: 4, nativeWidth: 1086, nativeHeight: 1448 },
      '16:9': { width: 16, height: 9, nativeWidth: 1672, nativeHeight: 941 },
      '9:16': { width: 9, height: 16, nativeWidth: 941, nativeHeight: 1672 },
    }
    let serverConfig = null

    const progressStages = [
      [0, '正在理解画面'],
      [18, '正在搭建构图'],
      [42, '正在细化光影'],
      [68, '正在完成渲染'],
      [88, '正在接收图像'],
    ]

    promptInput.addEventListener('input', () => {
      count.textContent = String(promptInput.value.length)
    })

    // ===== 提示词框悬浮工具 =====

    promptCopy?.addEventListener('click', async () => {
      const text = promptInput.value
      if (!text) {
        status.textContent = '提示词还是空的'
        return
      }
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // 剪贴板 API 不可用时退回选区复制（HTTP 环境等）
        promptInput.focus()
        promptInput.select()
        document.execCommand('copy')
        promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length)
      }
      status.textContent = '提示词已复制到剪贴板'
    })

    promptMaximize?.addEventListener('click', () => {
      openPromptEditor()
    })

    function openPromptEditor() {
      let editor = document.querySelector('#prompt-editor')
      if (!editor) {
        editor = document.createElement('div')
        editor.id = 'prompt-editor'
        editor.className = 'prompt-editor'
        editor.innerHTML = `
          <div class="prompt-editor-card">
            <div class="prompt-editor-head">
              <span>编辑提示词</span>
              <button class="prompt-editor-close" type="button" aria-label="关闭编辑器">✕</button>
            </div>
            <textarea class="prompt-editor-text" id="prompt-editor-text"></textarea>
            <div class="prompt-editor-foot">
              <span class="prompt-editor-count"><span id="prompt-editor-count">0</span> 字</span>
              <button class="prompt-editor-done" id="prompt-editor-done" type="button">完成</button>
            </div>
          </div>
        `
        document.body.append(editor)

        const editorText = editor.querySelector('#prompt-editor-text')
        const editorCount = editor.querySelector('#prompt-editor-count')

        editorText.addEventListener('input', () => {
          editorCount.textContent = String(editorText.value.length)
        })

        const close = () => {
          promptInput.value = editorText.value
          count.textContent = String(promptInput.value.length)
          editor.classList.remove('visible')
          promptInput.focus()
        }

        editor.querySelector('.prompt-editor-close').addEventListener('click', close)
        editor.querySelector('#prompt-editor-done').addEventListener('click', close)
        editor.addEventListener('click', event => {
          if (event.target === editor) close()
        })
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape' && editor.classList.contains('visible')) close()
        })
      }

      const editorText = editor.querySelector('#prompt-editor-text')
      editorText.value = promptInput.value
      editor.querySelector('#prompt-editor-count').textContent = String(editorText.value.length)
      editor.classList.add('visible')
      editorText.focus()
      editorText.setSelectionRange(editorText.value.length, editorText.value.length)
    }

    form.addEventListener('change', event => {
      if (event.target.name === 'ratio') {
        updateOutputSpec()
      }
    })

    downloadButton.addEventListener('click', () => {
      const imageUrl = activeImageUrl()
      if (!imageUrl) return

      const link = document.createElement('a')
      link.href = imageUrl
      link.download = `画境-${downloadTimestamp()}.${currentImageExtension || getImageExtension(imageUrl)}`
      document.body.append(link)
      link.click()
      link.remove()
      status.textContent = '原图下载已开始'
    })

    maximizeButton.addEventListener('click', () => {
      const imageUrl = activeImageUrl()
      if (!imageUrl) return
      lightboxImage.src = imageUrl
      lightbox.classList.add('visible')
      document.body.classList.add('lightbox-open')
      lightboxClose.focus()
    })

    lightboxClose.addEventListener('click', closeLightbox)

    lightbox.addEventListener('click', event => {
      if (event.target === lightbox) closeLightbox()
    })

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && lightbox.classList.contains('visible')) {
        closeLightbox()
      }
    })

    promptInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        form.requestSubmit()
      }
    })

    form.addEventListener('submit', async event => {
      event.preventDefault()

      const prompt = promptInput.value.trim()
      if (!prompt) {
        promptInput.focus()
        status.textContent = '请先写下画面描述'
        return
      }

      setLoading(true)
      startProgress()

      try {
        const selectedRatio = form.elements.ratio.value

        const result = await generateImage({
          prompt,
          ratio: selectedRatio,
          category: '单张创作',
          name: `单张-${downloadTimestamp()}`,
          source: 'studio',
        })

        if (!result?.imageUrl) {
          throw new Error('接口没有返回可用的图片地址')
        }

        stopProgress()
        progressLabel.textContent = '图像已生成'
        setProgress(100)
        await wait(360)

        resultImage.onload = () => {
          currentImageUrl = result.imageUrl
          currentImageExtension = getImageExtension(result.imageUrl)
          downloadButton.disabled = false
          maximizeButton.disabled = false
          preview.classList.add('has-image')
          status.textContent = `生成完成 · ${result.width} × ${result.height}`
        }
        resultImage.onerror = () => {
          throw new Error('图片已生成，但加载失败')
        }
        resultImage.src = `${result.imageUrl}?t=${Date.now()}`
      } catch (error) {
        status.textContent = error.message || '生成失败，请稍后重试'
        progressLabel.textContent = '生成中断'
        progressBar.style.background = '#b34e2d'
      } finally {
        stopProgress()
        setLoading(false)
      }
    })

    function setLoading(isLoading) {
      promptInput.disabled = isLoading
      imageOptions.disabled = isLoading
      submitButton.disabled = isLoading
      submitButton.textContent = isLoading ? '正在生成…' : '生成图像'

      if (isLoading) {
        status.textContent = 'Magpie 正在绘制'
        progressWrap.classList.add('visible')
        progressWrap.setAttribute('aria-hidden', 'false')
      } else {
        progressBar.style.background = ''
      }
    }

    function startProgress() {
      stopProgress()
      simulatedProgress = 3
      startedAt = Date.now()
      setProgress(simulatedProgress)
      updateElapsed()
      progressLabel.textContent = progressStages[0][1]

      elapsedTimer = window.setInterval(updateElapsed, 1000)
      progressTimer = window.setInterval(() => {
        const remaining = 94 - simulatedProgress
        simulatedProgress += Math.max(0.25, remaining * 0.035)
        simulatedProgress = Math.min(simulatedProgress, 94)
        setProgress(simulatedProgress)

        for (const [threshold, label] of progressStages) {
          if (simulatedProgress >= threshold) progressLabel.textContent = label
        }
      }, 650)
    }

    function stopProgress() {
      window.clearInterval(progressTimer)
      window.clearInterval(elapsedTimer)
    }

    function setProgress(value) {
      const rounded = Math.round(value)
      progressBar.style.width = `${rounded}%`
      progressTrack.setAttribute('aria-valuenow', String(rounded))
    }

    function updateElapsed() {
      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
      const rest = String(seconds % 60).padStart(2, '0')
      elapsedLabel.textContent = `${minutes}:${rest}`
    }

    function wait(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms))
    }

    function closeLightbox() {
      lightbox.classList.remove('visible')
      document.body.classList.remove('lightbox-open')
      maximizeButton.focus()
    }

    function activeImageUrl() {
      return currentImageUrl || resultImage.currentSrc || resultImage.src
    }

    function updateOutputSpec() {
      const ratioValue = form.elements.ratio.value
      const ratio = ratioSpec(ratioValue)

      ratioNote.textContent = ratioValue.replace(':', ' : ')
      const width = ratio.nativeWidth
      const height = ratio.nativeHeight
      dimensionsLabel.textContent = `${width} × ${height}`
      dimensionsLabel.dataset.width = String(width)
      dimensionsLabel.dataset.height = String(height)
    }

    function ratioSpec(id) {
      const fromServer = serverConfig?.ratios?.find(item => item.id === id)
      if (fromServer) return fromServer
      return fallbackRatios[id] || fallbackRatios['1:1']
    }

    function downloadTimestamp() {
      const now = new Date()
      const date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('')
      const time = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')
      return `${date}-${time}`
    }

    updateOutputSpec()

    // 拉取后端配置，覆盖页面上的画面比例选项
    fetchServerConfig()
      .then(config => {
        serverConfig = config
        applyServerOptions()
        updateOutputSpec()
      })
      .catch(() => {})

    function applyServerOptions() {
      if (!serverConfig) return

      const ratioSelect = document.querySelector('#ratio-select')
      if (!ratioSelect) return

      const currentRatio = form.elements.ratio.value

      if (serverConfig.ratios?.length) {
        ratioSelect.innerHTML = serverConfig.ratios
          .map(ratio => `<option value="${ratio.id}">${ratio.label}</option>`)
          .join('')
        if (serverConfig.ratios.some(ratio => ratio.id === currentRatio)) {
          ratioSelect.value = currentRatio
        }
      }
    }
  
