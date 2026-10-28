
import {
  activateProject,
  createProject,
  deleteProject,
  fetchGenerationJob,
  fetchHistory,
  fetchProject,
  fetchProjects,
  fetchServerConfig,
  fetchStyleLibrary,
  generateImage,
  logout,
  saveStyleLibrary,
  updateProject,
} from '../lib/api.js'
import {
  escapeAttr,
  escapeHtml,
  formatDateTime,
  getImageExtension,
  randomId,
  shorten,
  sleep,
  timestamp,
} from '../lib/dom.js'
import { setupHistoryPanel } from '../lib/history-panel.js'
import { requireLogin } from '../lib/guard.js'

    setupHistoryPanel()

    document.querySelector('#logout-button')?.addEventListener('click', async () => {
      await logout().catch(() => {})
      // 退出只清掉这个账号「未完成的生图任务」；工作区快照按账号各自保留
      try {
        if (currentUserId) localStorage.removeItem(pendingJobKey())
      } catch {}
      window.location.replace('/login.html')
    })

    // 点击头像也能开合菜单，触屏设备友好；点在记录面板内不收起菜单
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

    const TYPE_META = {
      role: {
        label: '角色资产',
        singular: '角色',
        defaultRatio: '3:4',
        nameLabels: ['姓名', '群像', '角色名称'],
        summaryLabels: ['颜值定位', '人设描述'],
      },
      scene: {
        label: '场景资产',
        singular: '场景',
        defaultRatio: '16:9',
        nameLabels: ['场景名称'],
        summaryLabels: ['空间定位', '空间结构', '光源'],
      },
      prop: {
        label: '道具资产',
        singular: '道具',
        defaultRatio: '1:1',
        nameLabels: ['道具名称'],
        summaryLabels: ['道具类别', '美学定位', '外形'],
      },
    }

    /* 本地快照按账号隔离：同一个浏览器换账号后，不能再看到上一个人的
       草稿、上次生成的图片与导入的资产。key 里带 userId，退出登录不清理
       （各账号各留一份，回来还在）；v1 是旧的全局 key，只在能证明归属时迁移。 */
    const LEGACY_STORAGE_KEY = 'moying.assetStudio.v1'
    const LEGACY_PENDING_JOB_KEY = 'moying.pendingJob.v1'
    let currentUserId = ''
    const storageKey = () => `moying.assetStudio.v2.${currentUserId}`
    const pendingJobKey = () => `moying.pendingJob.v2.${currentUserId}`
    /* 断线恢复相关的定时器必须在初始化调用之前声明，
       否则函数被提前调用时会撞上暂时性死区（TDZ）而静默失败 */
    let resumeTimer = 0
    const STATUS_TEXT = {
      idle: '未生成',
      queued: '排队中',
      generating: '生成中',
      done: '已完成',
      error: '失败',
    }
    const NON_VISUAL_FIELDS = new Set(['声线类型'])
    const STYLE_DEFAULTS = {
      role: {
        id: 'style-role-painting',
        name: '工笔重彩·角色',
        description: '东方工笔重彩人物设定图，线条细腻，设色饱满，服装与发饰材质清晰，光影柔和，整体呈古典叙事质感。',
        updatedAt: '',
      },
      scene: {
        id: 'style-scene-cinema',
        name: '电影写实·场景',
        description: '电影级写实场景，考究空间结构、陈设和陈旧材质，光线有明确来源，色彩克制，氛围真实。',
        updatedAt: '',
      },
      prop: {
        id: 'style-prop-craft',
        name: '器物考据·道具',
        description: '器物考据式道具图，工艺细节清晰，材质纹理真实，色彩与使用痕迹自然，呈现可信的年代感。',
        updatedAt: '',
      },
    }

    const state = {
      fileName: '',
      importedAt: '',
      assets: [],
      styles: { role: [], scene: [], prop: [] },
      defaultStyle: { role: '', scene: '', prop: '' },
      activeTab: 'import',
      selected: new Set(),
      search: { role: '', scene: '', prop: '' },
      page: { role: 1, scene: 1, prop: 1 },
      pageSize: 20,
      queue: [],
      processing: false,
      stopRequested: false,
      queueTotal: 0,
      queueDone: 0,
      batchLabel: '',
      modalId: '',
      freeBusy: false,
      freeImageUrl: '',
      freeImageExtension: 'png',
      // 自由创作的画面比例与提示词草稿，刷新后保持
      freeRatio: '1:1',
      freePrompt: '',
      styleType: 'role',
      styleEditingId: '',
      styleDirty: false,
      // 工具栏上的批量比例/风格选择，刷新后保持
      bulkParams: { role: {}, scene: {}, prop: {} },
      // 项目列表：每个项目是一份独立的资产数据
      projects: [],
      activeProjectId: '',
      projectPanelVisible: false,
      // 导入进行中：阻止项目列表刷新覆盖正在编辑的数据
      importing: false,
    }

    // 每条资产独立的生成进度
    const PROGRESS_STAGES = [
      [0, '排队中'],
      [8, '正在理解画面'],
      [26, '正在搭建构图'],
      [52, '正在细化光影'],
      [76, '正在完成渲染'],
      [92, '正在接收图像'],
      [97, '即将完成'],
    ]
    const progressTimers = new Map()

    // 画面比例由后端 /api/config 统一定义，此处仅作离线兜底
    let serverConfig = null

    const dom = {
      fileInput: document.querySelector('#file-input'),
      headerImport: document.querySelector('#header-import'),
      headerProjects: document.querySelector('#header-projects'),
      projectsBackdrop: document.querySelector('#projects-backdrop'),
      projectsDrawer: document.querySelector('#projects-drawer'),
      projectsClose: document.querySelector('#projects-close'),
      projectsList: document.querySelector('#projects-list'),
      projectsNew: document.querySelector('#projects-new'),
      projectsImport: document.querySelector('#projects-import'),
      dropzone: document.querySelector('#dropzone'),
      datasetBar: document.querySelector('#dataset-bar'),
      datasetName: document.querySelector('#dataset-name'),
      datasetMeta: document.querySelector('#dataset-meta'),
      panels: {
        import: document.querySelector('[data-panel="import"]'),
        role: document.querySelector('[data-panel="role"]'),
        scene: document.querySelector('[data-panel="scene"]'),
        prop: document.querySelector('[data-panel="prop"]'),
        style: document.querySelector('[data-panel="style"]'),
        free: document.querySelector('[data-panel="free"]'),
      },
      queuePanel: document.querySelector('#queue-panel'),
      queueTitle: document.querySelector('#queue-title'),
      queueDetail: document.querySelector('#queue-detail'),
      queueCount: document.querySelector('#queue-count'),
      queueProgress: document.querySelector('#queue-progress'),
      stopQueue: document.querySelector('#stop-queue'),
      modal: document.querySelector('#asset-modal'),
      modalKicker: document.querySelector('#modal-kicker'),
      modalTitle: document.querySelector('#modal-title'),
      modalFields: document.querySelector('#modal-fields'),
      modalPrompt: document.querySelector('#modal-prompt'),
      modalPromptCount: document.querySelector('#modal-prompt-count'),
      modalRatio: document.querySelector('#modal-ratio'),
      modalStyle: document.querySelector('#modal-style'),
      modalGenerate: document.querySelector('#modal-generate'),
      modalResetPrompt: document.querySelector('#modal-reset-prompt'),
      modalResultThumb: document.querySelector('#modal-result-thumb'),
      modalResultText: document.querySelector('#modal-result-text'),
      modalClose: document.querySelector('#modal-close'),
      lightbox: document.querySelector('#lightbox'),
      lightboxImage: document.querySelector('#lightbox-image'),
      lightboxClose: document.querySelector('#lightbox-close'),
      toast: document.querySelector('#toast'),
      freeForm: document.querySelector('#free-form'),
      freePrompt: document.querySelector('#free-prompt'),
      freeCount: document.querySelector('#free-count'),
      freeRatio: document.querySelector('#free-ratio'),
      freeSubmit: document.querySelector('#free-submit'),
      freeStatus: document.querySelector('#free-status'),
      freeProgress: document.querySelector('#free-progress'),
      freeProgressLabel: document.querySelector('#free-progress-label'),
      freeProgressBar: document.querySelector('#free-progress-bar'),
      freeElapsed: document.querySelector('#free-elapsed'),
      freePreview: document.querySelector('#free-preview'),
      freeImage: document.querySelector('#free-image'),
      freeDownload: document.querySelector('#free-download'),
      freeMaximize: document.querySelector('#free-maximize'),
      freePromptMaximize: document.querySelector('#free-prompt-maximize'),
      freePromptCopy: document.querySelector('#free-prompt-copy'),
    }

    let toastTimer = 0
    let saveTimer = 0
    let freeProgressTimer = 0
    let freeElapsedTimer = 0
    let freeStartedAt = 0
    let freeProgressValue = 0

    /* 启动顺序很重要：必须**先确认当前是谁**，再读本地快照并渲染。
       以前是同步 restoreState() + renderAll()，而身份是异步拿的，
       结果换账号后上一账号的草稿/图片会先画到页面上且之后不再覆盖。 */
    wireEvents()
    boot()

    async function boot() {
      let user
      try {
        user = await requireLogin()
      } catch {
        // guard 已把 401/403 跳转到登录页；其余错误要说出来，别把空页面当正常
        showToast('无法确认登录状态，请刷新页面重试', true)
        return
      }

      // /api/auth/me 返回的是 { userId, username, displayName, role }，
      // 登录接口返回的才是 { id, ... }，两处都兼容一下
      currentUserId = user.id || user.userId || ''
      if (!currentUserId) {
        showToast('登录状态异常，请刷新页面重试', true)
        return
      }
      applyUserChrome(user)

      await adoptLegacySnapshotIfOwned()
      await adoptLegacyPendingJobIfOwned()
      restoreState()
      renderAll()
      // 刷新前若有正在生成的图片，自动接回进度与结果（只接本账号自己的）
      resumePendingJobIfAny()

      // 先加载项目，再决定风格库用项目的还是全局模板的
      loadProjects().then(() => loadSharedStyles())

      // 后端配置决定可选画面比例，拉取失败时保留本地兜底值
      fetchServerConfig()
        .then(config => {
          serverConfig = config
          renderActivePanel()
          // 自由创作的画面比例也按后端配置渲染，并恢复用户上次的选择
          if (serverConfig?.ratios?.length) {
            dom.freeRatio.innerHTML = serverConfig.ratios
              .map(ratio => `<option value="${escapeAttr(ratio.id)}">${escapeHtml(ratio.label)}</option>`)
              .join('')
          }
          if (serverConfig.ratios.some(ratio => ratio.id === state.freeRatio)) {
            dom.freeRatio.value = state.freeRatio
          }
        })
        .catch(() => {})
    }

    /** 头像与菜单里的账号标识（名字取自 /api/auth/me 的实时结果） */
    function applyUserChrome(user) {
      const label = document.querySelector('#header-user')
      if (label) label.textContent = user.displayName || user.username

      const letter = document.querySelector('#avatar-letter')
      if (letter) {
        const source = user.displayName || user.username || '境'
        letter.textContent = Array.from(source)[0] || '境'
      }
    }

    async function loadSharedStyles() {
      try {
        const library = await fetchStyleLibrary()
        if (!library?.styles) return

        const hasServerStyles = Object.values(library.styles || {}).some(list => Array.isArray(list) && list.length)
        if (!hasServerStyles) {
          // 服务端还没有这个账号的风格：把本地风格作为初始值写上去。
          // 本地快照已按账号隔离（storageKey 带 userId），所以这里只会播种
          // 当前账号自己的风格，不会再出现「B 继承 A 的风格」。
          await persistStylesToServer()
          return
        }

        // 当前项目已有自己的风格就以项目为准，全局库只作为新项目的初始模板
        const activeProject = state.projects.find(item => item.id === state.activeProjectId)
        const projectHasStyles = ['role', 'scene', 'prop'].some(type =>
          (activeProject?.styles?.[type] || []).length > 0)
        if (projectHasStyles) return

        state.styles = normalizeStyles(library.styles)
        state.defaultStyle = normalizeDefaultStyles(library.defaultStyle, state.styles)
        persist()
        renderStylePage()
        refreshCurrentTable()
      } catch (error) {
        console.warn('无法读取后端风格库，继续使用本地保存的风格', error)
      }
    }

    async function persistStylesToServer() {
      try {
        await saveStyleLibrary({ styles: state.styles, defaultStyle: state.defaultStyle })
      } catch (error) {
        console.warn('无法把风格库写入后端', error)
      }
    }

    function wireEvents() {
      document.addEventListener('click', handleClick)
      document.addEventListener('change', handleChange)
      document.addEventListener('input', handleInput)
      document.addEventListener('keydown', handleKeydown)

      dom.headerImport.addEventListener('click', openFilePicker)
      dom.headerProjects?.addEventListener('click', openProjectsDrawer)
      dom.projectsClose?.addEventListener('click', closeProjectsDrawer)
      dom.projectsBackdrop?.addEventListener('click', closeProjectsDrawer)
      dom.projectsNew?.addEventListener('click', handleNewProject)
      dom.projectsImport?.addEventListener('click', () => {
        closeProjectsDrawer()
        openFilePicker()
      })
      dom.projectsList?.addEventListener('click', handleProjectListClick)
      dom.dropzone.addEventListener('click', openFilePicker)
      dom.dropzone.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openFilePicker()
        }
      })

      dom.fileInput.addEventListener('change', async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) await importFile(file)
      })

      for (const eventName of ['dragenter', 'dragover']) {
        dom.dropzone.addEventListener(eventName, event => {
          event.preventDefault()
          dom.dropzone.classList.add('dragging')
        })
      }

      for (const eventName of ['dragleave', 'drop']) {
        dom.dropzone.addEventListener(eventName, event => {
          event.preventDefault()
          dom.dropzone.classList.remove('dragging')
        })
      }

      dom.dropzone.addEventListener('drop', async event => {
        const file = event.dataTransfer?.files?.[0]
        if (file) await importFile(file)
      })

      dom.stopQueue.addEventListener('click', stopQueue)
      dom.modalClose.addEventListener('click', closeAssetModal)
      dom.modal.addEventListener('click', event => {
        if (event.target === dom.modal) closeAssetModal()
      })
      dom.lightboxClose.addEventListener('click', closeLightbox)
      dom.lightbox.addEventListener('click', event => {
        if (event.target === dom.lightbox) closeLightbox()
      })

      dom.modalPrompt.addEventListener('input', () => {
        const asset = findAsset(state.modalId)
        if (!asset) return
        asset.prompt = dom.modalPrompt.value
        dom.modalPromptCount.textContent = String(asset.prompt.length)
        persistSoon()
      })

      dom.modalResetPrompt.addEventListener('click', () => {
        const asset = findAsset(state.modalId)
        if (!asset) return
        asset.prompt = buildPrompt(asset)
        dom.modalPrompt.value = asset.prompt
        dom.modalPromptCount.textContent = String(asset.prompt.length)
        persistSoon()
        showToast('已恢复根据字段自动生成的提示词')
      })

      dom.modalGenerate.addEventListener('click', () => {
        const asset = findAsset(state.modalId)
        if (!asset) return
        startBatch([asset.id], `生成 ${asset.name}`)
      })

      dom.modalResultThumb.addEventListener('click', () => {
        const asset = findAsset(state.modalId)
        if (asset?.resultUrl) openLightbox(asset.resultUrl, asset.name)
      })

      dom.freeForm.addEventListener('submit', generateFreeImage)
      dom.freePrompt.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          dom.freeForm.requestSubmit()
        }
      })
      dom.freeDownload.addEventListener('click', () => {
        if (!state.freeImageUrl) return
        downloadImage(state.freeImageUrl, `画境-自由创作-${timestamp()}.${state.freeImageExtension}`)
      })
      dom.freeMaximize.addEventListener('click', () => {
        if (state.freeImageUrl) openLightbox(state.freeImageUrl, '自由创作生成图')
      })

      // 提示词悬浮工具：复制 + 最大化编辑器（与单张工作台同款）
      dom.freePromptCopy.addEventListener('click', async () => {
        const value = dom.freePrompt.value
        if (!value) {
          showToast('提示词还是空的')
          return
        }
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          dom.freePrompt.focus()
          dom.freePrompt.select()
          document.execCommand('copy')
          dom.freePrompt.setSelectionRange(dom.freePrompt.value.length, dom.freePrompt.value.length)
        }
        showToast('提示词已复制到剪贴板')
      })

      dom.freePromptMaximize.addEventListener('click', () => openFreePromptEditor())

      /* 悬浮工具只在输入框右上角热区出现：热区 = 右侧 150px、顶部 56px */
      const promptShell = dom.freePrompt.closest('.prompt-shell')
      if (promptShell) {
        const HOT_W = 150
        const HOT_H = 56
        promptShell.addEventListener('mousemove', event => {
          const rect = promptShell.getBoundingClientRect()
          const nearRight = event.clientX >= rect.right - HOT_W
          const nearTop = event.clientY <= rect.top + HOT_H
          promptShell.classList.toggle('tools-near', nearRight && nearTop)
        })
        promptShell.addEventListener('mouseleave', () => {
          promptShell.classList.remove('tools-near')
        })
      }
    }

    function handleClick(event) {
      const tab = event.target.closest('[data-tab]')
      if (tab) {
        switchTab(tab.dataset.tab)
        return
      }

      const rowAction = event.target.closest('[data-row-action]')
      if (rowAction) {
        const asset = findAsset(rowAction.dataset.id)
        if (!asset) return

        switch (rowAction.dataset.rowAction) {
          case 'open':
            openAssetModal(asset.id)
            break
          case 'generate':
            startBatch([asset.id], `生成 ${asset.name}`)
            break
          case 'preview':
            if (asset.resultUrl) openLightbox(asset.resultUrl, asset.name)
            break
          case 'download':
            if (asset.resultUrl) downloadImage(asset.resultUrl, assetFilename(asset))
            break
        }
        return
      }

      const action = event.target.closest('[data-action]')
      if (!action) {
        const fallbackStyleAction = event.target.closest('[data-style-action]')
        if (fallbackStyleAction) {
          handleStyleClick(fallbackStyleAction)
        }
        return
      }

      if (action.dataset.action === 'reset-asset-prompt') {
        const asset = findAsset(action.dataset.id)
        if (asset) {
          asset.prompt = buildPrompt(asset)
          persistSoon()
          openAssetModal(asset.id)
          showToast('已恢复自动提示词')
        }
        return
      }

      const type = currentAssetType()
      switch (action.dataset.action) {
        case 'select-page':
          selectVisible(type)
          break
        case 'select-type':
          selectType(type)
          break
        case 'clear-selection':
          state.selected.clear()
          renderTable(type)
          refreshSelectionLabels()
          break
        case 'apply-params':
          applyBulkParams(type)
          break
        case 'generate-selected':
          startBatch([...state.selected], '批量生成所选资产')
          break
        case 'generate-type':
          generateWholeType(type)
          break
        case 'previous-page':
          state.page[type] = Math.max(1, state.page[type] - 1)
          renderTable(type)
          break
        case 'next-page':
          state.page[type] += 1
          renderTable(type)
          break
      }

      const styleAction = event.target.closest('[data-style-action]')
      if (styleAction) {
        handleStyleClick(styleAction)
      }
    }

    function handleStyleClick(styleAction) {
      const typeTab = styleAction.closest('[data-style-type]')
      if (typeTab) {
        savePendingStyleIfValid(true)
        state.styleType = typeTab.dataset.styleType
        state.styleEditingId = state.defaultStyle[state.styleType] || styleList(state.styleType)[0]?.id || ''
        state.styleDirty = false
        renderStylePage()
        return
      }

      const styleId = styleAction.dataset.styleId
      if (styleId && styleAction.dataset.styleAction === 'open') {
        savePendingStyleIfValid(true)
        state.styleEditingId = styleId
        state.styleDirty = false
        renderStylePage()
        return
      }

      handleStyleAction(styleAction.dataset.styleAction)
    }

    function handleStyleAction(action) {
      const type = state.styleType
      const list = styleList(type)

      // 「保存风格」按钮：立即保存当前编辑中的风格（校验失败会提示原因）
      if (action === 'save') {
        savePendingStyleIfValid(false)
        return
      }

      if (action === 'create') {
        const style = {
          id: `style-${type}-${randomId()}`,
          name: `新建${TYPE_META[type].singular}风格`,
          description: '',
          updatedAt: '',
        }
        list.push(style)
        state.styleEditingId = style.id
        state.styleDirty = false
        persist()
        renderStylePage()
        document.querySelector('[data-style-field="name"]')?.focus()
        return
      }

      const style = findStyle(type, state.styleEditingId)
      if (!style) return

      if (action === 'delete') {
        if (list.length <= 1) {
          showToast('每种类型至少保留一个风格', true)
          return
        }
        if (!window.confirm(`删除风格「${style.name}」？使用它的资产会自动改用默认风格。`)) return
        state.styles[type] = list.filter(item => item.id !== style.id)
        if (state.defaultStyle[type] === style.id) {
          state.defaultStyle[type] = state.styles[type][0].id
        }
        state.assets.forEach(asset => {
          if (asset.type === type && resolveAssetStyleId(asset, asset.styleId) !== asset.styleId) {
            asset.styleId = resolveAssetStyleId(asset, '')
          }
        })
        state.styleEditingId = state.styles[type][0].id
        state.styleDirty = false
        persist()
        renderStylePage()
        refreshCurrentTable()
        showToast(`已删除风格「${style.name}」`)
        return
      }

      if (action === 'make-default') {
        state.defaultStyle[type] = style.id
        state.assets.forEach(asset => {
          if (asset.type === type) {
            asset.styleId = resolveAssetStyleId(asset, asset.styleId)
          }
        })
        persist()
        renderStylePage()
        refreshCurrentTable()
        showToast(`已将「${style.name}」设为${TYPE_META[type].singular}默认风格`)
      }
    }

    function savePendingStyleIfValid(silentWhenEmpty) {
      const type = state.styleType
      const style = findStyle(type, state.styleEditingId)
      if (!style) return false

      const nameField = document.querySelector('[data-style-field="name"]')
      const descriptionField = document.querySelector('[data-style-field="description"]')
      if (!nameField || !descriptionField) return false

      const name = nameField.value.trim()
      const description = descriptionField.value.trim()
      if (!name || !description) {
        if (!silentWhenEmpty) {
          showToast(!name ? '请填写风格名称' : '请填写风格描述，生成时会以描述为准', true)
        }
        return false
      }

      if (style.name === name && style.description === description) {
        state.styleDirty = false
        return true
      }

      style.name = name
      style.description = description
      style.updatedAt = new Date().toISOString()
      state.styleDirty = false
      persist()
      renderStylePage()
      refreshCurrentTable()
      showToast(`风格「${style.name}」已保存，生成时将以此描述为准`)
      return true
    }

    function handleChange(event) {
      // 自由创作画面比例：记住选择，刷新后保持
      if (event.target === dom.freeRatio) {
        state.freeRatio = dom.freeRatio.value
        persistSoon()
        return
      }

      // 工具栏批量比例/风格：记住选择，刷新后保持
      const bulkRatio = event.target.closest('[id^="bulk-ratio-"]')
      if (bulkRatio) {
        const type = bulkRatio.id.replace('bulk-ratio-', '')
        state.bulkParams[type] = { ...state.bulkParams[type], ratio: bulkRatio.value }
        refreshBulkSummary(type)
        persistSoon()
        return
      }

      const bulkStyle = event.target.closest('[id^="bulk-style-"]')
      if (bulkStyle) {
        const type = bulkStyle.id.replace('bulk-style-', '')
        state.bulkParams[type] = { ...state.bulkParams[type], styleId: bulkStyle.value }
        refreshBulkSummary(type)
        persistSoon()
        return
      }

      const rowRatio = event.target.closest('[data-row-ratio]')
      if (rowRatio) {
        const asset = findAsset(rowRatio.dataset.rowRatio)
        if (asset) {
          asset.ratio = rowRatio.value
          persistSoon()
        }
        return
      }

      const rowStyle = event.target.closest('[data-row-style]')
      if (rowStyle) {
        const asset = findAsset(rowStyle.dataset.rowStyle)
        if (asset) {
          asset.styleId = resolveAssetStyleId(asset, rowStyle.value)
          persistSoon()
          renderTable(asset.type)
        }
        return
      }

      const checkbox = event.target.closest('[data-select-id]')
      if (checkbox) {
        const id = checkbox.dataset.selectId
        if (checkbox.checked) state.selected.add(id)
        else state.selected.delete(id)
        const row = checkbox.closest('tr')
        row?.classList.toggle('selected-row', checkbox.checked)
        refreshSelectionLabels()
        return
      }

      if (event.target === dom.modalRatio) {
        const asset = findAsset(state.modalId)
        if (asset) {
          asset.ratio = dom.modalRatio.value
          persistSoon()
          refreshCurrentTable()
        }
        return
      }

      if (event.target === dom.modalStyle) {
        const asset = findAsset(state.modalId)
        if (asset) {
          asset.styleId = resolveAssetStyleId(asset, dom.modalStyle.value)
          persistSoon()
          refreshCurrentTable()
          renderAssetModalState()
        }
        return
      }

      const styleField = event.target.closest('[data-style-field]')
      if (styleField) {
        state.styleDirty = true
        updateStyleFormState()
      }
    }

    function handleInput(event) {
      const search = event.target.closest('[data-search]')
      if (search) {
        const type = search.dataset.search
        state.search[type] = search.value
        state.page[type] = 1
        renderTable(type)
        return
      }

      if (event.target === dom.freePrompt) {
        state.freePrompt = dom.freePrompt.value
        dom.freeCount.textContent = String(state.freePrompt.length)
        persistSoon()
      }
    }

    function handleKeydown(event) {
      if (event.key !== 'Escape') return
      if (dom.lightbox.classList.contains('visible')) {
        closeLightbox()
        return
      }
      if (dom.modal.classList.contains('visible')) {
        closeAssetModal()
      }
    }

    function restoreState() {
      try {
        const raw = localStorage.getItem(storageKey())
        if (!raw) {
          initializeStyles()
          return
        }
        const saved = JSON.parse(raw)
        if (!saved || !Array.isArray(saved.assets)) {
          initializeStyles()
          return
        }

        state.fileName = saved.fileName || ''
        state.importedAt = saved.importedAt || ''
        state.styles = normalizeStyles(saved.styles)
        state.defaultStyle = normalizeDefaultStyles(saved.defaultStyle, state.styles)
        state.assets = saved.assets.map(asset => normalizeAsset(asset))
        state.bulkParams = normalizeBulkParams(saved.bulkParams)
        // 恢复自由创作的画面比例选择（配合服务端配置渲染后回填）
        if (typeof saved.freeRatio === 'string' && saved.freeRatio) {
          state.freeRatio = saved.freeRatio
        }
        // 恢复自由创作的提示词草稿与上次生成结果，刷新不清空
        if (typeof saved.freePrompt === 'string') {
          state.freePrompt = saved.freePrompt
        }
        if (typeof saved.freeImageUrl === 'string') {
          state.freeImageUrl = saved.freeImageUrl
        }
        if (typeof saved.freeImageExtension === 'string') {
          state.freeImageExtension = saved.freeImageExtension
        }
        // 自由创作/风格设定不依赖资产，刷新后停留在用户离开的页签；
        // 资产类页签在无资产时回落到导入页
        if (['free', 'style'].includes(saved.activeTab)) {
          state.activeTab = saved.activeTab
        } else {
          state.activeTab = state.assets.length ? (saved.activeTab && saved.activeTab !== 'import' ? saved.activeTab : 'role') : 'import'
        }
        if (!dom.panels[state.activeTab]) state.activeTab = 'import'
      } catch (error) {
        console.warn('无法恢复上次导入的数据', error)
        if (currentUserId) localStorage.removeItem(storageKey())
        initializeStyles()
      }
    }

    /**
     * 旧版快照（v1）只存了一份、不分账号。升级后不能直接继承——那正是
     * 「换账号看到上一个账号页面」的原因。这里只在**能证明归属**时迁移，
     * 两条证据任一条成立即可：
     *   1) 快照里的 activeProjectId 属于当前账号（查他人项目会 404）
     *   2) 快照里上次生成的图片出现在当前账号的生成记录里
     * 都证明不了就原样留着，绝不猜测。
     */
    async function adoptLegacySnapshotIfOwned() {
      try {
        if (!currentUserId) return
        if (localStorage.getItem(storageKey())) return

        const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (!raw) return

        let saved
        try {
          saved = JSON.parse(raw)
        } catch {
          return
        }
        if (!saved || !Array.isArray(saved.assets)) return

        if (!(await legacySnapshotBelongsToMe(saved))) return

        localStorage.setItem(storageKey(), raw)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      } catch {
        // 读不到（404）或网络异常：旧键原样保留，不迁移
      }
    }

    /** 只比较路径部分：主机名/协议变化（换 IP 访问）不影响判断 */
    function toLocalPath(url) {
      try {
        return decodeURIComponent(new URL(url, location.origin).pathname)
      } catch {
        return ''
      }
    }

    async function legacySnapshotBelongsToMe(saved) {
      const projectId = typeof saved.activeProjectId === 'string' ? saved.activeProjectId : ''
      if (projectId) {
        try {
          await fetchProject(projectId)
          return true
        } catch {
          // 不是本账号的项目，继续看下一条证据
        }
      }

      const imageUrl = typeof saved.freeImageUrl === 'string' ? saved.freeImageUrl : ''
      if (imageUrl) {
        try {
          const result = await fetchHistory(120)
          const entries = Array.isArray(result?.entries) ? result.entries : []
          const target = toLocalPath(imageUrl)
          if (target && entries.some(entry => toLocalPath(entry.imageUrl || '') === target)) {
            return true
          }
        } catch {
          // 记录取不到就不认领
        }
      }

      return false
    }

    /** 把某个项目的数据载入当前编辑状态。 */
    function loadProjectIntoState(project) {
      state.fileName = project.fileName || ''
      state.importedAt = project.importedAt || ''
      state.assets = (project.assets || []).map(asset => normalizeAsset(asset))
      state.styles = normalizeStyles(project.styles)
      state.defaultStyle = normalizeDefaultStyles(project.defaultStyle, state.styles)
      state.bulkParams = normalizeBulkParams(project.bulkParams)
      // 自由创作/风格设定不依赖资产，载入项目时保留用户所在页签
      if (!['free', 'style'].includes(state.activeTab)) {
        state.activeTab = state.assets.length
          ? (state.activeTab && state.activeTab !== 'import' ? state.activeTab : 'role')
          : 'import'
      }
      state.selected.clear()
      state.search = { role: '', scene: '', prop: '' }
      state.page = { role: 1, scene: 1, prop: 1 }
      state.activeProjectId = project.id
    }

    /** 拉取项目列表并载入当前项目。 */
    async function loadProjects(force = false) {
      // 导入过程中不要覆盖正在编辑的数据
      if (state.importing) return
      try {
        const result = await fetchProjects()
        state.projects = Array.isArray(result?.projects) ? result.projects : []

        // 优先用后端记录的当前项目，本地 id 只作兜底
        const wantedId = state.activeProjectId || result?.activeProjectId || ''
        const active = state.projects.find(item => item.id === wantedId) || state.projects[0]
        if (active) {
          // 已经在这个项目里时保留当前编辑状态，避免覆盖未保存的改动
          if (force || active.id !== state.activeProjectId) {
            loadProjectIntoState(active)
          }
        } else {
          state.fileName = ''
          state.importedAt = ''
          state.assets = []
          // 无项目时尊重本地记住的页签：自由创作/风格设定不需要资产
          if (!['free', 'style'].includes(state.activeTab)) {
            state.activeTab = 'import'
          }
          state.activeProjectId = ''
        }
        renderAll()
      } catch (error) {
        console.warn('无法读取项目列表', error)
      }
    }

    /** 把当前编辑状态写回当前项目。 */
    async function saveCurrentProject(patch) {
      if (!state.activeProjectId) return
      try {
        const payload = {
          assets: state.assets,
          styles: state.styles,
          defaultStyle: state.defaultStyle,
          bulkParams: state.bulkParams,
          ...(patch || {}),
        }

        // 守卫：当前有资产但即将写入空数组时，多半是状态被旧快照覆盖了，不执行这次写入
        if (!payload.assets?.length && state.assets.length) {
          console.warn('跳过项目保存：检测到资产被意外清空')
          return
        }

        const result = await updateProject(state.activeProjectId, {
          ...payload,
        })
        const project = result?.project
        if (project) {
          const index = state.projects.findIndex(item => item.id === project.id)
          if (index >= 0) state.projects[index] = project
        }
      } catch (error) {
        console.warn('无法保存项目到后端', error)
      }
    }

    function initializeStyles() {
      state.styles = { role: [], scene: [], prop: [] }
      state.defaultStyle = { role: '', scene: '', prop: '' }
      for (const type of ['role', 'scene', 'prop']) {
        const preset = STYLE_DEFAULTS[type]
        state.styles[type] = [{ ...preset }]
        state.defaultStyle[type] = preset.id
      }
    }

    /** 恢复工具栏的批量比例/风格选择，兼容旧数据（没有这个字段时用空对象）。 */
    function normalizeBulkParams(saved) {
      const result = { role: {}, scene: {}, prop: {} }
      if (!saved || typeof saved !== 'object') return result
      for (const type of ['role', 'scene', 'prop']) {
        const item = saved[type]
        if (item && typeof item === 'object') {
          result[type] = {
            ratio: typeof item.ratio === 'string' ? item.ratio : '',
            styleId: typeof item.styleId === 'string' ? item.styleId : '',
          }
        }
      }
      return result
    }

    function normalizeStyles(saved) {
      const styles = { role: [], scene: [], prop: [] }
      for (const type of ['role', 'scene', 'prop']) {
        const list = Array.isArray(saved?.[type]) ? saved[type] : []
        styles[type] = list
          .filter(style => style && typeof style.id === 'string' && style.id)
          .map(style => ({
            id: style.id,
            name: String(style.name || '未命名风格'),
            description: String(style.description || ''),
            updatedAt: style.updatedAt || '',
          }))
        if (!styles[type].length) styles[type] = [{ ...STYLE_DEFAULTS[type] }]
      }
      return styles
    }

    function normalizeDefaultStyles(saved, styles) {
      const defaults = { role: '', scene: '', prop: '' }
      for (const type of ['role', 'scene', 'prop']) {
        const valid = styles[type].some(style => style.id === saved?.[type])
        defaults[type] = valid ? saved[type] : styles[type][0].id
      }
      return defaults
    }

    function normalizeAsset(asset) {
      const type = ['role', 'scene', 'prop'].includes(asset.type) ? asset.type : 'role'
      const normalized = {
        ...asset,
        type,
        fields: Array.isArray(asset.fields) ? asset.fields : [],
        ratio: asset.ratio || TYPE_META[type].defaultRatio,
        status: asset.status === 'done' || asset.status === 'error' ? asset.status : 'idle',
        styleId: '',
      }
      normalized.styleId = resolveAssetStyleId(normalized, asset.styleId)
      normalized.prompt = asset.prompt || buildPrompt(normalized)
      return normalized
    }

    function persistSoon() {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(persist, 250)
    }

    function persist() {
      // 身份还没确定时不写盘，避免把临时状态落到别人的 key 上
      if (!currentUserId) return
      try {
        const data = {
          // 记一份归属，方便排查「这份快照是谁的」
          ownerId: currentUserId,
          activeProjectId: state.activeProjectId,
          fileName: state.fileName,
          importedAt: state.importedAt,
          activeTab: state.activeTab,
          freeRatio: state.freeRatio,
          freePrompt: state.freePrompt,
          freeImageUrl: state.freeImageUrl,
          freeImageExtension: state.freeImageExtension,
          assets: state.assets,
          styles: state.styles,
          defaultStyle: state.defaultStyle,
          bulkParams: state.bulkParams,
        }
        localStorage.setItem(storageKey(), JSON.stringify(data))
      } catch (error) {
        console.warn('无法保存导入数据', error)
        showToast('浏览器存储空间不足，本次修改可能无法长期保存', true)
      }

      scheduleStyleSync()
      scheduleProjectSync()
    }

    // 风格库同步到后端：去抖后发送，避免频繁请求
    let styleSyncTimer = 0
    function scheduleStyleSync() {
      window.clearTimeout(styleSyncTimer)
      styleSyncTimer = window.setTimeout(persistStylesToServer, 600)
    }

    // 项目同步到后端：去抖后发送，避免每次勾选都打一次接口
    let projectSyncTimer = 0
    function scheduleProjectSync() {
      window.clearTimeout(projectSyncTimer)
      projectSyncTimer = window.setTimeout(() => saveCurrentProject(), 800)
    }

    function openFilePicker() {
      dom.fileInput.click()
    }

    // ---------- 项目管理 ----------

    function openProjectsDrawer() {
      state.projectPanelVisible = true
      renderProjectsList()
      dom.projectsBackdrop.hidden = false
      dom.projectsDrawer.hidden = false
    }

    function closeProjectsDrawer() {
      state.projectPanelVisible = false
      dom.projectsBackdrop.hidden = true
      dom.projectsDrawer.hidden = true
    }

    function renderProjectsList() {
      if (!dom.projectsList) return

      if (!state.projects.length) {
        dom.projectsList.innerHTML = '<div class="drawer-empty">还没有项目。<br>导入一个资产 JSON，或新建空项目。</div>'
        return
      }

      dom.projectsList.innerHTML = state.projects
        .map(project => {
          const isActive = project.id === state.activeProjectId
          const assets = project.assets || []
          const roleCount = assets.filter(item => item.type === 'role').length
          const sceneCount = assets.filter(item => item.type === 'scene').length
          const propCount = assets.filter(item => item.type === 'prop').length
          const total = roleCount + sceneCount + propCount

          return [
            '<div class="project-card' + (isActive ? ' active' : '') + '" data-project-id="' + escapeAttr(project.id) + '">',
            '  <div class="project-card-head">',
            '    <p class="project-card-name" title="' + escapeAttr(project.name) + '">' + escapeHtml(project.name) + '</p>',
            isActive ? '    <span class="project-badge">当前</span>' : '',
            '  </div>',
            '  <div class="project-card-meta">' + (project.importedAt ? '导入于 ' + formatDateTime(project.importedAt) : '空项目') + '</div>',
            '  <div class="project-card-stats">',
            '    <span>角色 ' + roleCount + '</span>',
            '    <span>场景 ' + sceneCount + '</span>',
            '    <span>道具 ' + propCount + '</span>',
            '    <span>共 ' + total + '</span>',
            '  </div>',
            '  <div class="project-card-actions">',
            isActive ? '' : '    <button class="button ghost mini" data-project-action="switch">切换到此项目</button>',
            '    <button class="button danger mini" data-project-action="delete">删除项目</button>',
            '  </div>',
            '</div>',
          ].join('\n')
        })
        .join('\n')
    }

    async function handleProjectListClick(event) {
      const button = event.target.closest('[data-project-action]')
      if (!button) return

      const card = button.closest('[data-project-id]')
      const id = card?.dataset.projectId
      if (!id) return

      if (button.dataset.projectAction === 'switch') {
        await switchProject(id)
        return
      }

      if (button.dataset.projectAction === 'delete') {
        const project = state.projects.find(item => item.id === id)
        if (!project) return
        if (!window.confirm('删除项目「' + project.name + '」？\n项目内的资产与生成记录会一并删除，此操作无法撤销。')) return

        try {
          await deleteProject(id)
          state.projects = state.projects.filter(item => item.id !== id)
          if (state.activeProjectId === id) {
            state.activeProjectId = ''
            await loadProjects()
          }
          renderProjectsList()
          renderAll()
          showToast('已删除项目「' + project.name + '」')
        } catch (error) {
          showToast('删除失败：' + (error.message || '未知错误'), true)
        }
      }
    }

    async function switchProject(id) {
      // 先把当前项目的数据存回去，再切换
      await saveCurrentProject()
      await activateProject(id)

      // 从后端取该项目的最新数据，避免用到列表里的旧快照
      let project = state.projects.find(item => item.id === id)
      try {
        const result = await fetchProject(id)
        if (result?.project) {
          project = result.project
          const index = state.projects.findIndex(item => item.id === id)
          if (index >= 0) state.projects[index] = project
        }
      } catch (error) {
        console.warn('无法读取项目详情，使用列表数据', error)
      }
      if (!project) return

      loadProjectIntoState(project)
      renderAll()
      renderProjectsList()
      showToast('已切换到项目「' + project.name + '」')
    }

    async function handleNewProject() {
      const name = window.prompt('新项目名称', '新项目')
      if (name === null) return

      try {
        await saveCurrentProject()
        const created = await createProject({ name: name.trim() || '新项目' })
        const project = created?.project
        if (!project) throw new Error('创建失败')

        state.projects.push(project)
        // 新项目沿用当前项目的风格作为起点（先记下再载入，避免被空风格覆盖）
        const inheritedStyles = state.styles
        const inheritedDefaults = state.defaultStyle
        loadProjectIntoState(project)
        state.styles = inheritedStyles
        state.defaultStyle = inheritedDefaults
        await saveCurrentProject({
          styles: inheritedStyles,
          defaultStyle: inheritedDefaults,
        })

        closeProjectsDrawer()
        renderAll()
        showToast('已创建项目「' + project.name + '」')
      } catch (error) {
        showToast('创建失败：' + (error.message || '未知错误'), true)
      }
    }

    async function importFile(file) {
      if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
        showToast('请选择 .json 资产文件', true)
        return
      }

      if (file.size > 8 * 1024 * 1024) {
        showToast('JSON 文件超过 8 MB，无法导入', true)
        return
      }

      state.importing = true
      try {
        const text = await file.text()
        const json = JSON.parse(text)
        const assets = normalizeAssets(json)
        if (!assets.length) {
          throw new Error('没有找到 role、scene 或 prop 资产')
        }

        // 每次导入都新建一个项目，互不影响
        const created = await createProject({ name: file.name.replace(/\.json$/i, ''), fileName: file.name })
        const project = created?.project
        if (!project) throw new Error('创建项目失败')

        state.fileName = file.name
        state.importedAt = new Date().toISOString()
        state.assets = assets
        state.styles = normalizeStyles(state.styles)
        state.defaultStyle = normalizeDefaultStyles(state.defaultStyle, state.styles)
        state.activeProjectId = project.id
        if (!state.projects.some(item => item.id === project.id)) {
          state.projects.push(project)
        }
        state.selected.clear()
        state.search = { role: '', scene: '', prop: '' }
        state.page = { role: 1, scene: 1, prop: 1 }
        state.styleType = state.assets.find(asset => ['role', 'scene', 'prop'].includes(asset.type))?.type || 'role'
        state.activeTab = ['role', 'scene', 'prop'].find(type => countType(type) > 0) || 'import'
        // 先把资产写进新项目，再刷新列表（顺序不能反，否则列表会用空数据覆盖）
        await saveCurrentProject({
          name: project.name,
          fileName: file.name,
        })
        persist()
        // 用后端返回的项目数据刷新本地缓存，保持列表与磁盘一致
        const saved = state.projects.find(item => item.id === project.id)
        if (saved) {
          const index = state.projects.findIndex(item => item.id === project.id)
          if (index >= 0) state.projects[index] = saved
        }
        renderAll()
        showToast(`已创建项目「${project.name}」，导入 ${assets.length} 项资产，自动切换到 ${TYPE_META[state.activeTab]?.label || '资产页'}`)
      } catch (error) {
        console.error(error)
        showToast(`导入失败：${error.message || 'JSON 格式无效'}`, true)
      } finally {
        state.importing = false
      }
    }

    function normalizeAssets(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('顶层必须是包含 role、scene、prop 的对象')
      }

      const assets = []
      for (const type of ['role', 'scene', 'prop']) {
        const source = json[type]
        if (!source || typeof source !== 'object') continue

        const entries = Array.isArray(source)
          ? source.map((value, index) => {
            const name = value?.name || value?.名称 || `${TYPE_META[type].singular}${index + 1}`
            return [name, value]
          })
          : Object.entries(source)

        entries.forEach(([name, raw], index) => {
          const fields = parseFields(raw, type, name)
          const id = `${type}-${index + 1}`
          const asset = {
            id,
            type,
            name: String(name || `${TYPE_META[type].singular}${index + 1}`),
            fields,
            raw: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
            ratio: TYPE_META[type].defaultRatio,
            styleId: state.defaultStyle[type] || '',
            status: 'idle',
            resultUrl: '',
            width: 0,
            height: 0,
            error: '',
            updatedAt: '',
          }
          asset.prompt = buildPrompt(asset)
          assets.push(asset)
        })
      }
      return assets
    }

    function parseFields(raw, type, name) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return Object.entries(raw).map(([label, value]) => ({
          label,
          value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        }))
      }

      const text = String(raw ?? '')
      const fields = type === 'role' ? parseRoleFields(text) : parseDelimitedFields(text, type)
      if (!fields.length) {
        fields.push({ label: TYPE_META[type].nameLabels[0], value: name })
        if (text.trim()) fields.push({ label: '原始描述', value: text.trim() })
      }
      return fields
    }

    function parseRoleFields(text) {
      const fields = []
      const pattern = /【([^】\n]+)】\s*[：:]\s*([\s\S]*?)(?=\n?【[^】\n]+】\s*[：:]|$)/g
      let match
      while ((match = pattern.exec(text)) !== null) {
        const value = match[2].trim()
        if (value) fields.push({ label: match[1].trim(), value })
      }
      return fields
    }

    function parseDelimitedFields(text, type) {
      const fields = []
      const parts = text.split(/\s*[;；]\s*/).filter(Boolean)
      parts.forEach((part, index) => {
        const colon = part.search(/[：:]/)
        if (colon > 0) {
          const label = part.slice(0, colon).trim()
          const value = part.slice(colon + 1).trim()
          if (label && value) fields.push({ label, value })
          return
        }

        if (index === 0) {
          fields.push({
            label: type === 'scene' ? '场景名称' : '道具名称',
            value: part.trim(),
          })
          return
        }

        if (/^(室内|室外|半室内|半室外)$/u.test(part.trim())) {
          fields.push({ label: '环境', value: part.trim() })
        } else if (part.trim()) {
          fields.push({ label: '补充信息', value: part.trim() })
        }
      })
      return fields
    }

    function buildPrompt(asset) {
      const meta = TYPE_META[asset.type]
      const visualFields = asset.fields.filter(field => !NON_VISUAL_FIELDS.has(field.label))
      const lines = [
        `${meta.label}设定图。`,
        `资产名称：${asset.name}`,
      ]

      for (const field of visualFields) {
        const line = `${field.label}：${field.value}`
        if (lines.join('\n').length + line.length > 3600) break
        lines.push(line)
      }

      if (asset.type === 'role') {
        const isGroup = asset.fields.some(field => field.label === '群像')
        lines.push(isGroup
          ? '画面要求：以角色群像为主体，完整呈现每位人物的面部、发型、发饰、身材比例与衣着材质；多人全身同框，人物之间保持清晰区分，不添加解释性文字、水印或界面元素。'
          : '画面要求：以角色为主体，完整呈现面部、发型、发饰、身材比例与衣着材质；单人全身，姿态自然，五官清晰，不添加解释性文字、水印或界面元素。')
      } else if (asset.type === 'scene') {
        lines.push('画面要求：以空间、陈设、材质与光线为主体，完整呈现该场景的空间结构和视觉特征；不添加解释性文字、水印或界面元素。')
      } else {
        lines.push('画面要求：以单一道具为主体，完整呈现外形、纹样、工艺、材质、色彩与使用痕迹；主体清晰，不添加解释性文字、水印或界面元素。')
      }
      return lines.join('\n')
    }

    function styleList(type) {
      return state.styles[type] || []
    }

    function findStyle(type, id) {
      return styleList(type).find(style => style.id === id)
    }

    function resolveAssetStyleId(asset, candidate) {
      const list = styleList(asset.type)
      if (list.some(style => style.id === candidate)) return candidate
      if (list.some(style => style.id === state.defaultStyle[asset.type])) return state.defaultStyle[asset.type]
      return list[0]?.id || ''
    }

    function selectedStyle(asset) {
      return findStyle(asset.type, resolveAssetStyleId(asset, asset.styleId)) || null
    }

    function composeGenerationPrompt(asset) {
      const style = selectedStyle(asset)
      if (!style) {
        return `${asset.prompt}\n\n【最终画面要求】\n本项必须严格遵循资产内容进行绘制，不要添加解释性文字、水印或界面元素。`
      }
      return [
        '【风格指令｜最高优先级】',
        `本图唯一采用以下${TYPE_META[asset.type].singular}风格：${style.name}`,
        '风格描述优先级高于资产描述中与之冲突的视觉表达。以下所有画面都必须执行这套风格：',
        style.description,
        '',
        '【资产内容】',
        asset.prompt,
      ].join('\n')
    }

    function assetPromptLength(asset) {
      return composeGenerationPrompt(asset).length
    }

    function styleOptions(type, selected) {
      const list = styleList(type)
      if (!list.length) return '<option value="">暂无风格</option>'
      const resolved = list.some(style => style.id === selected) ? selected : state.defaultStyle[type]
      return list.map(style => {
        const isDefault = style.id === state.defaultStyle[type]
        return `<option value="${escapeAttr(style.id)}" ${style.id === resolved ? 'selected' : ''}>${escapeHtml(style.name)}${isDefault ? ' · 默认' : ''}</option>`
      }).join('')
    }

    function renderAll() {
      state.assets.forEach(asset => {
        if (!asset.prompt) asset.prompt = buildPrompt(asset)
      })
      renderTabs()
      renderDatasetBar()
      renderActivePanel()
      renderQueuePanel()
      refreshSelectionLabels()
      renderFreeResult()
    }

    function renderTabs() {
      document.querySelectorAll('[data-tab]').forEach(button => {
        const type = button.dataset.tab
        button.classList.toggle('active', type === state.activeTab)
        if (type === 'role' || type === 'scene' || type === 'prop') {
          button.disabled = countType(type) === 0
        }
      })
      document.querySelectorAll('[data-count]').forEach(element => {
        const type = element.dataset.count
        element.textContent = String(type === 'all' ? state.assets.length : countType(type))
      })
    }

    function renderDatasetBar() {
      dom.datasetBar.hidden = !state.assets.length
      if (!state.assets.length) return
      const activeProject = state.projects.find(item => item.id === state.activeProjectId)
      dom.datasetName.textContent = activeProject?.name || state.fileName || '资产文件'
      dom.datasetMeta.textContent = state.importedAt
        ? `导入于 ${formatDateTime(state.importedAt)} · 项目数据保存在本地`
        : '项目数据保存在本地'
    }

    function renderActivePanel() {
      Object.entries(dom.panels).forEach(([name, panel]) => {
        panel.hidden = name !== state.activeTab
      })

      if (state.activeTab === 'role' || state.activeTab === 'scene' || state.activeTab === 'prop') {
        renderAssetPage(state.activeTab)
      } else if (state.activeTab === 'style') {
        renderStylePage()
      }
    }

    function switchTab(tab) {
      if (!['import', 'free', 'style'].includes(tab) && countType(tab) === 0) return
      state.activeTab = tab
      persistSoon()
      renderTabs()
      renderActivePanel()
    }

    function renderStylePage() {
      const panel = dom.panels.style
      const type = state.styleType
      const meta = TYPE_META[type]
      const list = styleList(type)

      if (!list.some(style => style.id === state.styleEditingId)) {
        state.styleEditingId = state.defaultStyle[type] || list[0]?.id || ''
      }

      const editing = findStyle(type, state.styleEditingId) || list[0]
      if (!editing) {
        panel.innerHTML = '<p class="empty-table">还没有风格</p>'
        return
      }

      panel.innerHTML = `
        <div class="workspace-head">
          <div>
            <h2>风格设定</h2>
            <p>角色、场景、道具三套风格互不干扰；生成时以所选风格的描述为准，优先级高于资产描述中的视觉表达。</p>
          </div>
          <div class="legend">
            <span class="badge">按类型独立</span>
            <span class="badge">描述即风格</span>
            <span class="badge">生成时自动套用</span>
          </div>
        </div>

        <div class="tabs" style="border:0;padding:0 0 16px">
          ${['role', 'scene', 'prop'].map(styleType => `
            <button class="tab ${styleType === state.styleType ? 'active' : ''}" data-style-type="${styleType}" data-style-action="switch-type" type="button">
              ${TYPE_META[styleType].label} <span class="tab-count">${styleList(styleType).length}</span>
            </button>
          `).join('')}
        </div>

        <div class="style-layout">
          <aside class="style-library">
            <div class="style-library-head">
              <h3>${meta.label}风格库</h3>
            </div>
            <div class="style-list">
              ${list.map(style => `
                <button class="style-list-item ${style.id === editing.id ? 'active' : ''}" data-style-action="open" data-style-id="${escapeAttr(style.id)}" type="button">
                  <span style="min-width:0">
                    <span class="style-list-name">${escapeHtml(style.name)}</span>
                    <span class="style-list-meta">${style.updatedAt ? '更新于 ' + formatDateTime(style.updatedAt) : '尚未修改'}</span>
                  </span>
                  ${style.id === state.defaultStyle[type] ? '<span class="style-default-tag">默认</span>' : ''}
                </button>
              `).join('')}
            </div>
            <button class="button primary" data-style-action="create" type="button" style="width:100%;margin-top:13px">＋ 新建${meta.singular}风格</button>
          </aside>

          <section class="style-editor">
            <div class="style-editor-head">
              <div>
                <h3>${escapeHtml(editing.name)}</h3>
                <p>这段描述会作为最高优先级风格指令，拼接在该类型资产生成提示词的最前面。</p>
              </div>
              ${editing.id === state.defaultStyle[type] ? '<span class="style-default-tag">本类型默认</span>' : ''}
            </div>

            <div class="style-form">
              <div>
                <label class="field-label" for="style-name">风格名称</label>
                <input class="input" id="style-name" data-style-field="name" value="${escapeAttr(editing.name)}" maxlength="40" placeholder="例如：电影写实·角色">
              </div>
              <div>
                <label class="field-label" for="style-description">风格描述（生成时以此为准）</label>
                <textarea class="textarea" id="style-description" data-style-field="description" maxlength="3000" placeholder="描述画风、线条、色彩、光影、材质、年代感等所有视觉规范……">${escapeHtml(editing.description)}</textarea>
              </div>

              <div class="style-form-footer">
                <button class="button primary" data-style-action="save" type="button">保存风格</button>
                ${editing.id === state.defaultStyle[type] ? '' : `<button class="button secondary" data-style-action="make-default" type="button">设为默认</button>`}
                <button class="button danger" data-style-action="delete" type="button">删除</button>
                <span class="style-usage">使用中的资产：${state.assets.filter(asset => resolveAssetStyleId(asset, asset.styleId) === editing.id).length} 项</span>
              </div>
            </div>
          </section>
        </div>
      `

      updateStyleFormState()
    }

    function updateStyleFormState() {
      const saveButton = document.querySelector('[data-style-action="save"]')
      if (!saveButton) return
      saveButton.textContent = state.styleDirty ? '保存风格（有未保存修改）' : '保存风格'
    }

    function renderAssetPage(type) {
      const meta = TYPE_META[type]
      const panel = dom.panels[type]
      panel.innerHTML = `
        <div class="workspace-head">
          <div>
            <h2>${meta.label}</h2>
            <p><span data-page-count="${type}"></span> 项资产 · 当前批量比例 ${state.bulkParams[type]?.ratio || meta.defaultRatio}，每行可单独调整</p>
          </div>
          <div class="legend">
            <span class="badge queued">排队中</span>
            <span class="badge generating">生成中</span>
            <span class="badge done">已完成</span>
            <span class="badge error">失败</span>
          </div>
        </div>

        <div class="toolbar">
          <div class="search-wrap">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7"></circle>
              <path d="m20 20-4-4"></path>
            </svg>
            <input class="input" data-search="${type}" value="${escapeAttr(state.search[type])}" placeholder="搜索资产名称或字段内容">
          </div>
          <select class="select" id="bulk-ratio-${type}" aria-label="批量画面比例">
            ${ratioOptions(state.bulkParams[type]?.ratio || meta.defaultRatio)}
          </select>
          <select class="select" id="bulk-style-${type}" aria-label="批量风格">
            ${styleOptions(type, state.bulkParams[type]?.styleId || state.defaultStyle[type])}
          </select>
          <button class="button secondary" data-action="apply-params" type="button">应用到所选 <span data-selected-inline="${type}"></span></button>
          <span class="toolbar-separator"></span>
          <button class="button secondary" data-action="select-page" type="button">全选本页</button>
          <button class="button secondary" data-action="select-type" type="button">全选本类型</button>
          <button class="button ghost" data-action="clear-selection" type="button">清除选择</button>
          <button class="button primary" data-action="generate-selected" type="button" data-generate-selected>批量生成所选</button>
          <button class="button secondary" data-action="generate-type" type="button" data-generate-type>生成全部${meta.singular}</button>
        </div>

        <div class="table-shell">
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th class="col-check"><input type="checkbox" data-page-check="${type}" aria-label="选择本页"></th>
                  <th class="col-name">资产</th>
                  <th class="col-fields">JSON 字段</th>
                  <th class="col-style">风格</th>
                  <th class="col-prompt">提示词预览</th>
                  <th class="col-ratio">比例</th>
                  <th class="col-status">状态</th>
                  <th class="col-result">结果</th>
                  <th class="col-actions">操作</th>
                </tr>
              </thead>
              <tbody id="asset-table-${type}"></tbody>
            </table>
          </div>
          <div class="table-footer" id="asset-pagination-${type}"></div>
        </div>
      `

      const pageCheck = panel.querySelector(`[data-page-check="${type}"]`)
      pageCheck?.addEventListener('change', () => {
        if (pageCheck.checked) selectVisible(type)
        else {
          visibleAssets(type).forEach(asset => state.selected.delete(asset.id))
          renderTable(type)
          refreshSelectionLabels()
        }
      })

      renderTable(type)
    }

    function renderTable(type) {
      const tbody = document.querySelector(`#asset-table-${type}`)
      const pagination = document.querySelector(`#asset-pagination-${type}`)
      if (!tbody || !pagination) return

      const all = filteredAssets(type)
      const pages = Math.max(1, Math.ceil(all.length / state.pageSize))
      state.page[type] = Math.min(Math.max(1, state.page[type]), pages)
      const start = (state.page[type] - 1) * state.pageSize
      const pageAssets = all.slice(start, start + state.pageSize)

      document.querySelectorAll(`[data-page-count="${type}"]`).forEach(element => {
        element.textContent = String(countType(type))
      })

      if (!pageAssets.length) {
        tbody.innerHTML = `<tr><td class="empty-table" colspan="10">${state.search[type] ? '没有匹配的资产' : '这一页暂无资产'}</td></tr>`
      } else {
        tbody.innerHTML = pageAssets.map(asset => assetRow(asset)).join('')
      }

      const pageCheck = document.querySelector(`[data-page-check="${type}"]`)
      if (pageCheck) {
        const allSelected = pageAssets.length > 0 && pageAssets.every(asset => state.selected.has(asset.id))
        pageCheck.checked = allSelected
        pageCheck.indeterminate = !allSelected && pageAssets.some(asset => state.selected.has(asset.id))
      }

      pagination.innerHTML = `
        <span class="table-summary">显示 ${all.length ? start + 1 : 0}–${Math.min(start + state.pageSize, all.length)}，共 ${all.length} 项${state.search[type] ? '（已筛选）' : ''}</span>
        <div class="pagination">
          <button class="icon-button" data-action="previous-page" type="button" ${state.page[type] <= 1 ? 'disabled' : ''} aria-label="上一页">←</button>
          <span class="page-label">第 ${state.page[type]} / ${pages} 页</span>
          <button class="icon-button" data-action="next-page" type="button" ${state.page[type] >= pages ? 'disabled' : ''} aria-label="下一页">→</button>
        </div>
      `

      refreshSelectionLabels()
    }

    function assetRow(asset) {
      const selected = state.selected.has(asset.id)
      const summary = fieldSummary(asset)
      const currentStyle = selectedStyle(asset)
      const chips = asset.fields
        .filter(field => !TYPE_META[asset.type].nameLabels.includes(field.label))
        .slice(0, 3)
        .map(field => `<span class="field-chip">${escapeHtml(field.label)}</span>`)
        .join('')

      return `
        <tr class="${selected ? 'selected-row' : ''}">
          <td class="col-check">
            <input type="checkbox" data-select-id="${asset.id}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeAttr(asset.name)}">
          </td>
          <td class="col-name">
            <button class="asset-name-button" data-row-action="open" data-id="${asset.id}" title="${escapeAttr(asset.name)}">${escapeHtml(asset.name)}</button>
            <span class="asset-kind">${TYPE_META[asset.type].singular} · ${asset.fields.length} 个字段</span>
          </td>
          <td class="col-fields">
            <div class="field-chips">${chips}</div>
            <span class="asset-kind">${escapeHtml(summary)}</span>
          </td>
          <td class="col-style">
            <select class="row-select style-select" data-row-style="${asset.id}" aria-label="${escapeAttr(asset.name)} 的风格">
              ${styleOptions(asset.type, asset.styleId)}
            </select>
            <span class="asset-kind" title="${escapeAttr(currentStyle?.description || '')}">${currentStyle?.id === state.defaultStyle[asset.type] ? '本类型默认' : '单独指定'}</span>
          </td>
          <td class="col-prompt">
            <span class="prompt-preview">${escapeHtml(composeGenerationPrompt(asset))}</span>
          </td>
          <td class="col-ratio">
            <select class="row-select" data-row-ratio="${asset.id}" aria-label="${escapeAttr(asset.name)} 的画面比例">
              ${ratioOptions(asset.ratio)}
            </select>
          </td>
          <td class="col-status">${statusCell(asset)}</td>
          <td class="col-result">${resultCell(asset)}</td>
          <td class="col-actions">
            <div class="row-actions">
              <button class="mini-button primary" data-row-action="generate" data-id="${asset.id}" ${asset.status === 'generating' ? 'disabled' : ''}>生成</button>
              <button class="mini-button" data-row-action="open" data-id="${asset.id}">编辑</button>
            </div>
          </td>
        </tr>
      `
    }

    function resultCell(asset) {
      if (asset.resultUrl) {
        return `<button class="result-thumb" data-row-action="preview" data-id="${asset.id}" title="查看 ${escapeAttr(asset.name)} 的生成图"><img src="${escapeAttr(asset.resultUrl)}" alt="${escapeAttr(asset.name)} 生成结果"></button>`
      }
      if (asset.status === 'error') return '<span class="asset-kind" title="' + escapeAttr(asset.error || '生成失败') + '">无结果</span>'
      return '<button class="result-thumb" type="button" disabled>暂无</button>'
    }

    function statusPill(status) {
      const safe = STATUS_TEXT[status] ? status : 'idle'
      return `<span class="status-pill ${safe}">${STATUS_TEXT[safe]}</span>`
    }

    /**
     * 状态单元格：状态标签 + 该条资产自己的进度条。
     * 排队中 / 生成中 / 失败 / 已完成 都有各自的展示方式。
     */
    function statusCell(asset) {
      const pill = statusPill(asset.status)

      if (asset.status === 'generating') {
        const percent = Math.round(asset.progress || 0)
        return `<div class="cell-progress" data-progress-cell="${escapeAttr(asset.id)}">
          ${pill}
          <div class="cell-progress-track">
            <div class="cell-progress-bar" style="width:${percent}%"></div>
          </div>
          <span class="cell-progress-text">${escapeHtml(asset.progressStage || '生成中')} ${percent}%</span>
        </div>`
      }

      if (asset.status === 'queued') {
        return `<div class="cell-progress queued" data-progress-cell="${escapeAttr(asset.id)}">
          ${pill}
          <div class="cell-progress-track">
            <div class="cell-progress-bar" style="width:0%"></div>
          </div>
          <span class="cell-progress-text">队列第 ${queuePositionOf(asset)} 位 · 等待中</span>
        </div>`
      }

      if (asset.status === 'error') {
        return `<div class="cell-progress failed">
          ${pill}
          <span class="cell-progress-text" title="${escapeAttr(asset.error || '生成失败')}">${escapeHtml(asset.error || '生成失败')}</span>
        </div>`
      }

      if (asset.status === 'done') {
        return `<div class="cell-progress">
          ${pill}
          <div class="cell-progress-track">
            <div class="cell-progress-bar done" style="width:100%"></div>
          </div>
          <span class="cell-progress-text">${asset.width && asset.height ? `${asset.width} × ${asset.height}` : '已完成'}</span>
        </div>`
      }

      return `<div class="cell-progress">${pill}</div>`
    }

    function ratioOptions(selected) {
      const list = serverConfig?.ratios?.length
        ? serverConfig.ratios
        : [{ id: '1:1', label: '1 : 1' }, { id: '4:3', label: '4 : 3' }, { id: '3:4', label: '3 : 4' }, { id: '16:9', label: '16 : 9' }, { id: '9:16', label: '9 : 16' }]
      return list
        .map(ratio => `<option value="${escapeAttr(ratio.id)}" ${ratio.id === selected ? 'selected' : ''}>${escapeHtml(ratio.shortLabel || ratio.label)}</option>`)
        .join('')
    }

    function fieldSummary(asset) {
      const labels = TYPE_META[asset.type].summaryLabels
      const field = labels.map(label => asset.fields.find(item => item.label === label)).find(Boolean)
        || asset.fields[1]
        || asset.fields[0]
      return shorten(field?.value || asset.raw, 62)
    }

    function filteredAssets(type) {
      const query = state.search[type].trim().toLowerCase()
      const assets = state.assets.filter(asset => asset.type === type)
      if (!query) return assets
      return assets.filter(asset => {
        const haystack = `${asset.name}\n${asset.raw}\n${asset.fields.map(field => `${field.label} ${field.value}`).join('\n')}`.toLowerCase()
        return haystack.includes(query)
      })
    }

    function visibleAssets(type) {
      const all = filteredAssets(type)
      const start = (state.page[type] - 1) * state.pageSize
      return all.slice(start, start + state.pageSize)
    }

    function selectVisible(type) {
      visibleAssets(type).forEach(asset => state.selected.add(asset.id))
      renderTable(type)
      refreshSelectionLabels()
    }

    function selectType(type) {
      state.assets.filter(asset => asset.type === type).forEach(asset => state.selected.add(asset.id))
      renderTable(type)
      refreshSelectionLabels()
    }

    function applyBulkParams(type) {
      if (!state.selected.size) {
        showToast('请先勾选资产', true)
        return
      }
      const ratio = document.querySelector(`#bulk-ratio-${type}`)?.value
      const styleId = document.querySelector(`#bulk-style-${type}`)?.value
      if (!ratio) return

      // 记住工具栏当前选择，刷新后仍然生效
      state.bulkParams[type] = { ...state.bulkParams[type], ratio, styleId: styleId || '' }

      let changed = 0
      state.assets.forEach(asset => {
        if (!state.selected.has(asset.id)) return
        asset.ratio = ratio
        if (styleId) asset.styleId = resolveAssetStyleId(asset, styleId)
        changed += 1
      })
      persistSoon()
      renderTable(type)
      showToast(`已为 ${changed} 项资产应用 ${ratio}${styleId ? ' 与所选风格' : ''}`)
    }

    /** 更新工具栏上方的「当前批量比例」说明。 */
    function refreshBulkSummary(type) {
      const panel = document.querySelector(`[data-panel="${type}"]`)
      if (!panel) return
      const summary = panel.querySelector('.workspace-head p')
      if (!summary) return
      const count = panel.querySelector('[data-page-count]')
      const ratio = state.bulkParams[type]?.ratio || TYPE_META[type].defaultRatio
      summary.textContent = `${count ? count.textContent : countType(type)} 项资产 · 当前批量比例 ${ratio}，每行可单独调整`
    }

    function generateWholeType(type) {
      const assets = state.assets.filter(asset => asset.type === type)
      if (!assets.length) return
      if (!window.confirm(`将按顺序生成 ${assets.length} 项${TYPE_META[type].singular}资产，确认开始吗？`)) return
      startBatch(assets.map(asset => asset.id), `生成全部${TYPE_META[type].singular}`)
    }

    function refreshSelectionLabels() {
      const selectedCount = state.selected.size
      document.querySelectorAll('[data-generate-selected]').forEach(button => {
        button.disabled = selectedCount === 0 || state.processing
        button.textContent = selectedCount ? `批量生成所选 (${selectedCount})` : '批量生成所选'
      })
      document.querySelectorAll('[data-generate-type]').forEach(button => {
        button.disabled = state.processing
      })
      document.querySelectorAll('[data-selected-inline]').forEach(label => {
        label.textContent = selectedCount ? `(${selectedCount})` : ''
      })
    }

    function startBatch(ids, label) {
      if (state.processing) {
        showToast('已有批量任务在运行，请等待完成或停止后续任务', true)
        return
      }

      const unique = [...new Set(ids)]
        .map(findAsset)
        .filter(asset => asset && !state.queue.includes(asset.id))

      if (!unique.length) {
        showToast('没有可加入队列的资产')
        return
      }

      state.queue = unique.map(asset => asset.id)
      state.queueTotal = state.queue.length
      state.queueDone = 0
      state.batchLabel = label
      state.processing = true
      state.stopRequested = false
      unique.forEach(asset => {
        asset.status = 'queued'
        asset.error = ''
      })
      renderQueuePanel()
      refreshCurrentTable()
      refreshSelectionLabels()
      processQueue()
    }

    async function processQueue() {
      while (state.queue.length && !state.stopRequested) {
        const id = state.queue.shift()
        const asset = findAsset(id)
        if (!asset) continue

        asset.status = 'generating'
        asset.error = ''
        startAssetProgress(asset)
        renderQueuePanel()
        refreshCurrentTable()
        renderAssetModalState()

        try {
          const result = await generateImage({
            prompt: composeGenerationPrompt(asset),
            ratio: asset.ratio,
            category: TYPE_META[asset.type].singular,
            name: asset.name,
            source: 'batch',
          })
          if (!result?.imageUrl) {
            throw new Error('接口没有返回图片地址')
          }

          asset.resultUrl = result.imageUrl
          asset.width = result.width || 0
          asset.height = result.height || 0
          asset.status = 'done'
          asset.progress = 100
          asset.progressStage = '已完成'
          asset.updatedAt = new Date().toISOString()
        } catch (error) {
          asset.status = 'error'
          asset.progress = 0
          asset.progressStage = '生成失败'
          asset.error = error.message || '生成失败'
          asset.updatedAt = new Date().toISOString()
        }

        stopAssetProgress(asset.id)
        state.queueDone += 1
        persistSoon()
        renderQueuePanel()
        refreshCurrentTable()
        renderAssetModalState()
        await sleep(250)
      }

      if (state.stopRequested) {
        state.queue.forEach(id => {
          const asset = findAsset(id)
          if (asset && asset.status === 'queued') {
            asset.status = 'idle'
            asset.progress = 0
            asset.progressStage = ''
          }
        })
        state.queue = []
      }

      // 清理所有残留的进度定时器
      progressTimers.forEach(timer => window.clearInterval(timer))
      progressTimers.clear()

      state.processing = false
      state.stopRequested = false
      refreshSelectionLabels()
      renderQueuePanel()
      refreshCurrentTable()
      renderAssetModalState()
      persistSoon()

      if (state.queueDone > 0) {
        showToast(`批量任务完成：${state.queueDone} / ${state.queueTotal}`)
      }
    }

    function stopQueue() {
      if (!state.processing) return
      state.stopRequested = true
      dom.stopQueue.disabled = true
      showToast('将在当前图片完成后停止后续任务')
      renderQueuePanel()
    }

    function renderQueuePanel() {
      const visible = state.processing || state.queue.length > 0 || state.queueDone > 0
      dom.queuePanel.hidden = !visible
      if (!visible) return

      const active = state.assets.find(asset => asset.status === 'generating')
      const finished = state.queueDone
      const total = state.queueTotal
      const percent = total ? Math.round((finished / total) * 100) : 0
      const failures = state.assets.filter(asset => asset.updatedAt && asset.status === 'error').length

      dom.queueTitle.textContent = state.batchLabel || '批量任务'
      dom.queueDetail.textContent = state.processing
        ? active
          ? `正在生成：${active.name} · ${active.ratio} · ${active.progressStage || '生成中'} ${Math.round(active.progress || 0)}%`
          : '准备下一项'
        : state.stopRequested
          ? `已停止 · ${finished} 项已处理`
          : `已完成 · ${finished} / ${total}${failures ? `，${failures} 项失败` : ''}`
      dom.queueCount.textContent = `${finished} / ${total}`
      dom.queueProgress.style.width = `${percent}%`
      dom.stopQueue.disabled = !state.processing || state.stopRequested
      dom.stopQueue.textContent = state.stopRequested ? '正在停止后续任务…' : '停止后续任务'
    }

    function currentAssetType() {
      return ['role', 'scene', 'prop'].includes(state.activeTab) ? state.activeTab : ''
    }

    /**
     * 启动单条资产的进度条。
     * 上游生图没有进度回调，所以用分段推进模拟：进度越高代表越接近完成。
     */
    function startAssetProgress(asset) {
      stopAssetProgress(asset.id)
      asset.progress = 1
      asset.progressStage = '正在提交任务'
      asset.progressStartedAt = Date.now()

      const timer = window.setInterval(() => {
        const current = asset.progress || 0
        // 越接近完成推进越慢，模拟真实等待；末段留一点余量给传输与落盘
        const step = current < 30 ? 3.4 : current < 70 ? 1.9 : current < 90 ? 0.75 : 0.35
        const next = Math.min(99, current + step)
        asset.progress = next
        asset.progressStage = stageTextOf(next)

        if (next >= 99) {
          stopAssetProgress(asset.id)
        }
        updateProgressCells()
        renderQueuePanel()
        renderAssetModalState()
      }, 320)

      progressTimers.set(asset.id, timer)
    }

    /**
     * 只更新进度相关的 DOM，不重建整张表。
     * 重建表格会让进度条动画反复从头开始，手感很差。
     */
    function updateProgressCells() {
      document.querySelectorAll('[data-progress-cell]').forEach(cell => {
        const asset = findAsset(cell.dataset.progressCell)
        if (!asset) return

        const bar = cell.querySelector('.cell-progress-bar')
        const text = cell.querySelector('.cell-progress-text')
        const percent = Math.round(asset.progress || 0)

        if (bar && asset.status === 'generating') {
          bar.style.width = `${percent}%`
        }
        if (text && asset.status === 'generating') {
          text.textContent = `${asset.progressStage || '生成中'} ${percent}%`
        }
      })
    }
    function stopAssetProgress(assetId) {
      const timer = progressTimers.get(assetId)
      if (timer) {
        window.clearInterval(timer)
        progressTimers.delete(assetId)
      }
    }

    function stageTextOf(percent) {
      let text = PROGRESS_STAGES[0][1]
      for (const [threshold, label] of PROGRESS_STAGES) {
        if (percent >= threshold) text = label
      }
      return text
    }

    /** 该资产在队列中的位置（1 起），用来告诉用户还要等多久。 */
    function queuePositionOf(asset) {
      const index = state.queue.indexOf(asset.id)
      if (index < 0) return state.queue.length
      return index + 1
    }

    function refreshCurrentTable() {
      const type = currentAssetType()
      if (type) renderTable(type)
    }

    function openAssetModal(id) {
      state.modalId = id
      const asset = findAsset(id)
      if (!asset) return
      dom.modalKicker.textContent = TYPE_META[asset.type].label
      dom.modalTitle.textContent = asset.name
      dom.modalFields.innerHTML = asset.fields.map(field => `
        <div class="detail-field ${NON_VISUAL_FIELDS.has(field.label) ? 'nonvisual' : ''}">
          <dt>${escapeHtml(field.label)}${NON_VISUAL_FIELDS.has(field.label) ? '（仅展示）' : ''}</dt>
          <dd>${escapeHtml(field.value)}</dd>
        </div>
      `).join('')
      dom.modalPrompt.value = asset.prompt
      dom.modalPromptCount.textContent = String(asset.prompt.length)
      dom.modalRatio.value = asset.ratio
      dom.modalStyle.innerHTML = styleOptions(asset.type, asset.styleId)
      dom.modalStyle.value = resolveAssetStyleId(asset, asset.styleId)
      dom.modal.classList.add('visible')
      document.body.style.overflow = 'hidden'
      renderAssetModalState()
      dom.modalPrompt.focus()
    }

    function closeAssetModal() {
      dom.modal.classList.remove('visible')
      document.body.style.overflow = ''
      state.modalId = ''
    }

    function renderAssetModalState() {
      if (!dom.modal.classList.contains('visible')) return
      const asset = findAsset(state.modalId)
      if (!asset) return
      dom.modalRatio.value = asset.ratio
      if (dom.modalStyle.options.length) {
        dom.modalStyle.value = resolveAssetStyleId(asset, asset.styleId)
      }
      dom.modalGenerate.disabled = state.processing
      dom.modalGenerate.textContent = state.processing ? '队列运行中…' : '生成这张资产图'

      if (asset.resultUrl) {
        dom.modalResultThumb.innerHTML = `<img src="${escapeAttr(asset.resultUrl)}" alt="${escapeAttr(asset.name)} 生成结果">`
        dom.modalResultText.innerHTML = `<strong>${statusPill(asset.status)}</strong>${asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ''}${asset.updatedAt ? formatDateTime(asset.updatedAt) : ''}`
      } else if (asset.status === 'error') {
        dom.modalResultThumb.textContent = '失败'
        dom.modalResultText.innerHTML = `<strong><span class="status-pill error">失败</span></strong>${escapeHtml(asset.error || '生成失败')}`
      } else if (asset.status === 'generating' || asset.status === 'queued') {
        const percent = Math.round(asset.progress || 0)
        dom.modalResultThumb.textContent = '生成中'
        dom.modalResultText.innerHTML = `<div class="cell-progress">
          ${statusPill(asset.status)}
          <div class="cell-progress-track">
            <div class="cell-progress-bar" style="width:${percent}%"></div>
          </div>
          <span class="cell-progress-text">${escapeHtml(asset.progressStage || '生成中')} ${percent}%</span>
        </div>`
      } else {
        dom.modalResultThumb.textContent = '暂无图片'
        dom.modalResultText.innerHTML = `<strong>${statusPill(asset.status)}</strong>选择参数后点击生成，结果会与这条资产关联。`
      }
    }

    function openLightbox(url, label) {
      dom.lightboxImage.src = url
      dom.lightboxImage.alt = `${label}大图`
      dom.lightbox.classList.add('visible')
      document.body.style.overflow = 'hidden'
      dom.lightboxClose.focus()
    }

    function closeLightbox() {
      dom.lightbox.classList.remove('visible')
      dom.lightboxImage.src = ''
      document.body.style.overflow = dom.modal.classList.contains('visible') ? 'hidden' : ''
    }

    function assetFilename(asset) {
      return `${asset.name}-${asset.width || ''}${asset.width ? 'x' : ''}${asset.height || ''}-${timestamp()}.${getImageExtension(asset.resultUrl)}`
        .replace(/-+/g, '-')
    }

    function downloadImage(url, filename) {
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      showToast(`下载已开始：${filename}`)
    }

    function countType(type) {
      return state.assets.filter(asset => asset.type === type).length
    }

    function findAsset(id) {
      return state.assets.find(asset => asset.id === id)
    }

    function showToast(message, isError = false) {
      window.clearTimeout(toastTimer)
      dom.toast.textContent = message
      dom.toast.classList.toggle('error', isError)
      dom.toast.classList.add('visible')
      toastTimer = window.setTimeout(() => dom.toast.classList.remove('visible'), 3600)
    }

    /** 提示词最大化编辑器：玻璃卡片，完成时写回输入框（与单张工作台同款） */
    function openFreePromptEditor() {
      let editor = document.querySelector('#free-prompt-editor')
      if (!editor) {
        editor = document.createElement('div')
        editor.id = 'free-prompt-editor'
        editor.className = 'prompt-editor'
        editor.innerHTML = `
          <div class="prompt-editor-card">
            <div class="prompt-editor-head">
              <span>编辑提示词</span>
              <button class="prompt-editor-close" type="button" aria-label="关闭编辑器">✕</button>
            </div>
            <textarea class="prompt-editor-text" id="free-prompt-editor-text"></textarea>
            <div class="prompt-editor-foot">
              <span class="prompt-editor-count"><span id="free-prompt-editor-count">0</span> 字</span>
              <button class="prompt-editor-done" id="free-prompt-editor-done" type="button">完成</button>
            </div>
          </div>
        `
        document.body.append(editor)

        const editorText = editor.querySelector('#free-prompt-editor-text')
        const editorCount = editor.querySelector('#free-prompt-editor-count')

        editorText.addEventListener('input', () => {
          editorCount.textContent = String(editorText.value.length)
        })

        const close = () => {
          dom.freePrompt.value = editorText.value
          state.freePrompt = editorText.value
          dom.freeCount.textContent = String(state.freePrompt.length)
          persistSoon()
          editor.classList.remove('visible')
          dom.freePrompt.focus()
        }

        editor.querySelector('.prompt-editor-close').addEventListener('click', close)
        editor.querySelector('#free-prompt-editor-done').addEventListener('click', close)
        editor.addEventListener('click', event => {
          if (event.target === editor) close()
        })
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape' && editor.classList.contains('visible')) close()
        })
      }

      const editorText = editor.querySelector('#free-prompt-editor-text')
      editorText.value = dom.freePrompt.value
      editor.querySelector('#free-prompt-editor-count').textContent = String(editorText.value.length)
      editor.classList.add('visible')
      editorText.focus()
      editorText.setSelectionRange(editorText.value.length, editorText.value.length)
    }

    /* ===== 断线恢复：刷新页面后接回仍在后台生成的图片 =====
       提交前先生成 jobId 存到本地；页面若被刷新，重新载入时凭 jobId
       轮询服务端任务状态，拿到结果后照常渲染。
       任务同样按账号隔离：换了账号不能去接上一个人的进度。 */
    function rememberPendingJob(jobId) {
      if (!currentUserId) return
      try {
        localStorage.setItem(
          pendingJobKey(),
          JSON.stringify({ jobId, userId: currentUserId, startedAt: Date.now() }),
        )
      } catch {}
    }

    function readPendingJob() {
      if (!currentUserId) return null
      try {
        const raw = localStorage.getItem(pendingJobKey())
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.jobId !== 'string') return null
        // 双保险：值里的归属与当前账号不一致就不认
        if (parsed.userId && parsed.userId !== currentUserId) return null
        return parsed
      } catch {
        return null
      }
    }

    function clearPendingJob() {
      if (!currentUserId) return
      try {
        localStorage.removeItem(pendingJobKey())
      } catch {}
    }

    /**
     * 旧版 pendingJob 也不分账号。为了不在换账号时接到别人的任务，
     * 这里同样只认「服务端确认归属」的：任务查询接口对非本人返回 404。
     */
    async function adoptLegacyPendingJobIfOwned() {
      if (!currentUserId || localStorage.getItem(pendingJobKey())) return
      try {
        const raw = localStorage.getItem(LEGACY_PENDING_JOB_KEY)
        if (!raw) return
        const saved = JSON.parse(raw)
        if (!saved || typeof saved.jobId !== 'string') return
        const startedAt = Number(saved.startedAt) || 0
        if (!startedAt || Date.now() - startedAt > 10 * 60 * 1000) return

        await fetchGenerationJob(saved.jobId) // 不是本人的任务会抛 404
        localStorage.setItem(
          pendingJobKey(),
          JSON.stringify({ jobId: saved.jobId, userId: currentUserId, startedAt }),
        )
        localStorage.removeItem(LEGACY_PENDING_JOB_KEY)
      } catch {
        // 不属于当前账号或任务已过期：旧键留着不动
      }
    }

    /** 判断本地是否还有未完成的生成任务，有就恢复进度并开始轮询 */
    function resumePendingJobIfAny() {
      const pending = readPendingJob()
      if (!pending) return
      if (Date.now() - (pending.startedAt || 0) > 10 * 60 * 1000) {
        clearPendingJob()
        return
      }

      // 回到自由创作页签，并把进度条设在「进行中」的样子
      if (state.activeTab !== 'free') {
        state.activeTab = 'free'
        renderTabs()
        renderActivePanel()
      }
      state.freeBusy = true
      dom.freePrompt.disabled = true
      dom.freeSubmit.disabled = true
      dom.freeSubmit.textContent = '正在生成…'
      dom.freeStatus.textContent = '检测到未完成的生成任务，正在接回…'
      freeProgressValue = Math.max(12, freeProgressValue)
      freeStartedAt = pending.startedAt || Date.now()
      dom.freeProgress.classList.add('visible')
      dom.freeProgressLabel.textContent = '后台仍在生成'
      setFreeProgress(Math.max(freeProgressValue, 20))
      startFreeProgress()

      pollPendingJob(pending.jobId, 0)
    }

    async function pollPendingJob(jobId, attempt) {
      window.clearTimeout(resumeTimer)
      try {
        const response = await fetch(`/api/images/jobs/${encodeURIComponent(jobId)}`, {
          credentials: 'include',
        })
        const data = await response.json().catch(() => ({}))

        if (response.status === 404) {
          // 任务过期或服务重启：清掉标记，避免一直转圈
          clearPendingJob()
          finishResume()
          dom.freeStatus.textContent = '上次的生成任务已失效（可能服务重启过），请重新生成'
          return
        }
        if (!response.ok) throw new Error(data.error || '查询生成状态失败')

        if (data.status === 'running') {
          dom.freeStatus.textContent = '后台仍在生成，完成后会自动显示'
          // 进度条随已用时长缓慢推进，最多 94%
          const elapsedSec = Math.max(0, (data.elapsedMs || 0) / 1000)
          const guess = Math.min(94, 20 + elapsedSec * 1.2)
          if (guess > freeProgressValue) setFreeProgress(guess)
          resumeTimer = window.setTimeout(() => pollPendingJob(jobId, attempt + 1), 1800)
          return
        }

        if (data.status === 'done' && data.result) {
          clearPendingJob()
          stopFreeProgress()
          dom.freeProgressLabel.textContent = '图像已生成'
          setFreeProgress(100)
          state.freeImageUrl = data.result.imageUrl
          state.freeImageExtension = getImageExtension(data.result.imageUrl)
          persistSoon()
          dom.freeImage.src = `${data.result.imageUrl}?t=${Date.now()}`
          dom.freePreview.classList.add('has-image')
          dom.freeDownload.disabled = false
          dom.freeMaximize.disabled = false
          dom.freeStatus.textContent = `已接回刷新前的生成结果 · ${data.result.width} × ${data.result.height}`
          finishResume()
          showToast('刷新前的生成已完成，结果已恢复')
          return
        }

        // 失败
        clearPendingJob()
        stopFreeProgress()
        dom.freeProgressLabel.textContent = '生成中断'
        dom.freeStatus.textContent = data.error?.message || '生成失败，请重新尝试'
        finishResume()
      } catch (error) {
        if (attempt < 20) {
          resumeTimer = window.setTimeout(() => pollPendingJob(jobId, attempt + 1), 2500)
          return
        }
        clearPendingJob()
        finishResume()
        dom.freeStatus.textContent = '无法查询生成状态，请重新生成'
      }
    }

    function finishResume() {
      window.clearTimeout(resumeTimer)
      state.freeBusy = false
      dom.freePrompt.disabled = false
      dom.freeSubmit.disabled = false
      dom.freeSubmit.textContent = '生成图像'
    }

    async function generateFreeImage(event) {
      event.preventDefault()
      const prompt = dom.freePrompt.value.trim()
      if (!prompt) {
        dom.freePrompt.focus()
        dom.freeStatus.textContent = '请先写下画面描述'
        return
      }
      if (state.processing) {
        showToast('批量任务运行中，完成后再进行自由创作', true)
        return
      }
      if (state.freeBusy) return

      state.freeBusy = true
      dom.freePrompt.disabled = true
      dom.freeSubmit.disabled = true
      dom.freeSubmit.textContent = '正在生成…'
      dom.freeStatus.textContent = 'Magpie 正在绘制'
      startFreeProgress()

      const jobId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now())
      rememberPendingJob(jobId)

      try {
        const result = await generateImage({
          prompt,
          ratio: dom.freeRatio.value,
          category: '自由创作',
          name: `自由创作-${timestamp()}`,
          source: 'free',
          jobId,
        })
        if (!result?.imageUrl) throw new Error('接口没有返回图片地址')
        clearPendingJob()

        stopFreeProgress()
        dom.freeProgressLabel.textContent = '图像已生成'
        setFreeProgress(100)
        await sleep(320)
        state.freeImageUrl = result.imageUrl
        state.freeImageExtension = getImageExtension(result.imageUrl)
        persistSoon()
        dom.freeImage.src = `${result.imageUrl}?t=${Date.now()}`
        dom.freePreview.classList.add('has-image')
        dom.freeDownload.disabled = false
        dom.freeMaximize.disabled = false
        dom.freeStatus.textContent = `生成完成 · ${result.width} × ${result.height}`
      } catch (error) {
        clearPendingJob()
        stopFreeProgress()
        dom.freeProgressLabel.textContent = '生成中断'
        dom.freeStatus.textContent = error.message || '生成失败，请稍后重试'
      } finally {
        state.freeBusy = false
        dom.freePrompt.disabled = false
        dom.freeSubmit.disabled = false
        dom.freeSubmit.textContent = '生成图像'
      }
    }

    function renderFreeResult() {
      // 提示词草稿回填（刷新后不丢失）
      if (dom.freePrompt && dom.freePrompt.value !== state.freePrompt) {
        dom.freePrompt.value = state.freePrompt
        dom.freeCount.textContent = String(state.freePrompt.length)
      }
      if (state.freeImageUrl) {
        dom.freeImage.src = state.freeImageUrl
        dom.freePreview.classList.add('has-image')
        dom.freeDownload.disabled = false
        dom.freeMaximize.disabled = false
      }
    }

    function startFreeProgress() {
      stopFreeProgress()
      freeProgressValue = 3
      freeStartedAt = Date.now()
      setFreeProgress(freeProgressValue)
      dom.freeProgress.classList.add('visible')
      dom.freeProgressLabel.textContent = '正在理解画面'
      const stages = [
        [0, '正在理解画面'],
        [18, '正在搭建构图'],
        [42, '正在细化光影'],
        [68, '正在完成渲染'],
        [88, '正在接收图像'],
      ]
      freeElapsedTimer = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - freeStartedAt) / 1000)
        dom.freeElapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      }, 1000)
      freeProgressTimer = window.setInterval(() => {
        freeProgressValue += Math.max(0.25, (94 - freeProgressValue) * 0.035)
        freeProgressValue = Math.min(94, freeProgressValue)
        setFreeProgress(freeProgressValue)
        for (const [threshold, label] of stages) {
          if (freeProgressValue >= threshold) dom.freeProgressLabel.textContent = label
        }
      }, 650)
    }

    function stopFreeProgress() {
      window.clearInterval(freeProgressTimer)
      window.clearInterval(freeElapsedTimer)
    }

    function setFreeProgress(value) {
      dom.freeProgressBar.style.width = `${Math.round(value)}%`
    }
  
