import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminStats,
  fetchAdminUsers,
  fetchCurrentUser,
  logout,
  updateAdminUser,
} from '../lib/api.js'
import { escapeHtml, formatDateTime } from '../lib/dom.js'

const dom = {
  adminUser: document.querySelector('#admin-user'),
  avatar: document.querySelector('#user-avatar'),
  logoutButton: document.querySelector('#logout-button'),
  newUserButton: document.querySelector('#new-user-button'),
  refreshButton: document.querySelector('#refresh-button'),
  usersBody: document.querySelector('#users-body'),
  statsBody: document.querySelector('#stats-body'),
  recentBody: document.querySelector('#recent-body'),
  statTotal: document.querySelector('#stat-total'),
  statAccounts: document.querySelector('#stat-accounts'),
  statBytes: document.querySelector('#stat-bytes'),
  modal: document.querySelector('#user-modal'),
  modalTitle: document.querySelector('#modal-title'),
  form: document.querySelector('#user-form'),
  username: document.querySelector('#modal-username'),
  displayName: document.querySelector('#modal-display-name'),
  password: document.querySelector('#modal-password'),
  passwordHint: document.querySelector('#modal-password-hint'),
  role: document.querySelector('#modal-role'),
  error: document.querySelector('#modal-error'),
  save: document.querySelector('#modal-save'),
  cancel: document.querySelector('#modal-cancel'),
}

let currentUser = null
let editingId = ''
let stats = null

init()

async function init() {
  try {
    const result = await fetchCurrentUser()
    currentUser = result?.user
    if (!currentUser) throw new Error('未登录')
  } catch (error) {
    if (error?.code === 'AUTH_REQUIRED' || error?.status === 401 || error?.status === 403) {
      window.location.replace('/login.html')
    }
    return
  }

  if (currentUser.role !== 'admin') {
    window.location.replace('/')
    return
  }

  dom.adminUser.textContent = `${currentUser.displayName}（${currentUser.username}）`
  const letter = document.querySelector('#avatar-letter')
  if (letter) {
    const source = currentUser.displayName || currentUser.username || '管'
    letter.textContent = Array.from(source)[0] || '管'
  }
  // 先拿统计，再渲染账号表，这样表里能显示每个账号的生图数
  await loadStats()
  await loadUsers()
}

dom.logoutButton.addEventListener('click', async () => {
  await logout().catch(() => {})
  window.location.replace('/login.html')
})

// 点击头像也能开合菜单，触屏设备友好
dom.avatar?.addEventListener('click', event => {
  event.stopPropagation()
  dom.avatar.classList.toggle('is-open')
})

document.addEventListener('click', () => {
  dom.avatar?.classList.remove('is-open')
})

dom.refreshButton.addEventListener('click', async () => {
  await loadStats()
})

dom.newUserButton.addEventListener('click', () => {
  openModal()
})

dom.cancel.addEventListener('click', closeModal)

dom.modal.addEventListener('click', event => {
  if (event.target === dom.modal) closeModal()
})

dom.form.addEventListener('submit', async event => {
  event.preventDefault()
  clearError()

  const username = dom.username.value.trim()
  const displayName = dom.displayName.value.trim()
  const password = dom.password.value
  const role = dom.role.value

  if (!username) {
    showError('用户名不能为空')
    return
  }

  dom.save.disabled = true
  dom.save.textContent = '保存中…'

  try {
    if (editingId) {
      const patch = { displayName }
      if (password) patch.password = password
      await updateAdminUser(editingId, patch)
    } else {
      if (!password) {
        throw new Error('请设置密码')
      }
      await createAdminUser({ username, displayName, password, role })
    }
    closeModal()
    await loadStats()
    await loadUsers()
  } catch (error) {
    showError(error.message || '保存失败')
  } finally {
    dom.save.disabled = false
    dom.save.textContent = '保存'
  }
})

function openModal(user) {
  editingId = user?.id || ''
  dom.modalTitle.textContent = user ? `编辑账号 · ${user.username}` : '新建账号'
  dom.username.value = user?.username || ''
  dom.username.disabled = Boolean(user)
  dom.displayName.value = user?.displayName || ''
  dom.password.value = ''
  dom.passwordHint.textContent = user ? '留空表示不修改密码' : '至少 6 位'
  dom.role.value = user?.role || 'user'
  dom.role.disabled = Boolean(user)
  clearError()
  dom.modal.hidden = false
  dom.username.focus()
}

function closeModal() {
  dom.modal.hidden = true
  editingId = ''
}

function showError(message) {
  dom.error.textContent = message
  dom.error.hidden = false
}

function clearError() {
  dom.error.textContent = ''
  dom.error.hidden = true
}

async function loadUsers() {
  try {
    const result = await fetchAdminUsers()
    const users = result?.users || []
    const counts = new Map()
    for (const account of stats?.accounts || []) {
      counts.set(account.userId, account.count)
    }

    if (!users.length) {
      dom.usersBody.innerHTML = '<tr class="empty-row"><td colspan="6">还没有账号</td></tr>'
      return
    }

    dom.usersBody.innerHTML = users
      .map(user => {
        const count = counts.get(user.id) ?? 0
        const roleTag =
          user.role === 'admin'
            ? '<span class="role-tag admin">管理员</span>'
            : '<span class="role-tag user">普通用户</span>'
        const statusTag = user.disabled
          ? '<span class="status-tag off">已停用</span>'
          : '<span class="status-tag on">正常</span>'
        const toggleLabel = user.disabled ? '启用' : '停用'
        const isSelf = user.id === currentUser.id

        return `<tr>
          <td title="创建于 ${formatDateTime(user.createdAt)}｜最近登录 ${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}">${escapeHtml(user.username)}</td>
          <td>${escapeHtml(user.displayName)}</td>
          <td>${roleTag}</td>
          <td>${statusTag}</td>
          <td>${count}</td>
          <td>
            <div class="row-actions">
              <button class="admin-button ghost mini" data-action="edit" data-id="${escapeHtml(user.id)}">编辑</button>
              ${
                isSelf
                  ? ''
                  : `<button class="admin-button ghost mini" data-action="toggle" data-id="${escapeHtml(user.id)}" data-disabled="${user.disabled}">${toggleLabel}</button>
                     <button class="admin-button danger mini" data-action="delete" data-id="${escapeHtml(user.id)}">删除</button>`
              }
            </div>
          </td>
        </tr>`
      })
      .join('')
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/login.html')
      return
    }
      dom.usersBody.innerHTML = `<tr class="empty-row"><td colspan="6">读取失败：${escapeHtml(error.message)}</td></tr>`
  }
}

async function loadStats() {
  try {
    stats = await fetchAdminStats()
    dom.statTotal.textContent = String(stats.totalImages || 0)
    dom.statAccounts.textContent = String(stats.accountCount || 0)
    dom.statBytes.textContent = ((stats.totalBytes || 0) / 1024 / 1024).toFixed(1)

    const accounts = stats.accounts || []
    if (!accounts.length) {
      dom.statsBody.innerHTML = '<tr class="empty-row"><td colspan="5">还没有生图记录</td></tr>'
    } else {
      const max = Math.max(...accounts.map(item => item.count), 1)
      dom.statsBody.innerHTML = accounts
        .map(item => {
          const percent = ((item.count / (stats.totalImages || 1)) * 100).toFixed(1)
          return `<tr>
            <td>${escapeHtml(item.username)}</td>
            <td>${item.count}</td>
            <td>${(item.bytes / 1024 / 1024).toFixed(1)} MB</td>
            <td>${item.lastGeneratedAt ? formatDateTime(item.lastGeneratedAt) : '—'}</td>
            <td class="bar-cell">
              ${percent}%
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (item.count / max) * 100).toFixed(1)}%"></div></div>
            </td>
          </tr>`
        })
        .join('')
    }

    const recent = stats.recent || []
    if (!recent.length) {
      dom.recentBody.innerHTML = '<tr class="empty-row"><td colspan="7">还没有生图记录</td></tr>'
    } else {
      dom.recentBody.innerHTML = recent
        .map(item => `<tr>
          <td>${formatDateTime(item.createdAt)}</td>
          <td>${escapeHtml(item.username)}</td>
          <td>${escapeHtml(item.category)}</td>
          <td>${escapeHtml(item.name || '—')}</td>
          <td>${escapeHtml(item.ratio)}</td>
          <td>${item.width} × ${item.height}</td>
          <td>${(item.bytes / 1024 / 1024).toFixed(1)} MB</td>
        </tr>`)
        .join('')
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/login.html')
      return
    }
    console.error(error)
  }
}

dom.usersBody.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!button) return

  const id = button.dataset.id
  const action = button.dataset.action

  if (action === 'edit') {
    const users = (await fetchAdminUsers().catch(() => null))?.users || []
    const user = users.find(item => item.id === id)
    if (user) openModal(user)
    return
  }

  if (action === 'toggle') {
    const disabled = button.dataset.disabled === 'true'
    try {
      await updateAdminUser(id, { disabled: !disabled })
      await loadStats()
      await loadUsers()
    } catch (error) {
      alert(error.message || '操作失败')
    }
    return
  }

  if (action === 'delete') {
    if (!window.confirm('删除该账号？该账号的生图记录仍会保留在统计中。')) return
    try {
      await deleteAdminUser(id)
      await loadStats()
      await loadUsers()
    } catch (error) {
      alert(error.message || '删除失败')
    }
  }
})
