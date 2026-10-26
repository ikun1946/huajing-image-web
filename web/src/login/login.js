import { login, request } from '../lib/api.js'

const form = document.querySelector('#login-form')
const usernameInput = document.querySelector('#username')
const passwordInput = document.querySelector('#password')
const submitButton = document.querySelector('#login-submit')
const errorBox = document.querySelector('#login-error')

const setupPanel = document.querySelector('#setup-panel')
const setupForm = document.querySelector('#setup-form')
const setupError = document.querySelector('#setup-error')
const setupSubmit = document.querySelector('#setup-submit')

function showError(message) {
  errorBox.textContent = message
  errorBox.hidden = false
}

function clearError() {
  errorBox.textContent = ''
  errorBox.hidden = true
}

function showSetupError(message) {
  setupError.textContent = message
  setupError.hidden = false
}

function clearSetupError() {
  setupError.textContent = ''
  setupError.hidden = true
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  clearError()

  const username = usernameInput.value.trim()
  const password = passwordInput.value
  if (!username || !password) {
    showError('请输入用户名和密码')
    return
  }

  submitButton.disabled = true
  submitButton.textContent = '正在登入…'

  try {
    const result = await login(username, password)
    if (!result?.user) {
      throw new Error('登录失败，请重试')
    }
    // 管理员登录后进入管理页，普通用户进入工作台
    const target = result.user.role === 'admin' ? '/admin.html' : '/'
    window.location.replace(target)
  } catch (error) {
    showError(error.message || '登录失败，请重试')
    submitButton.disabled = false
    submitButton.textContent = '登入'
    passwordInput.value = ''
    passwordInput.focus()
  }
})

setupForm.addEventListener('submit', async event => {
  event.preventDefault()
  clearSetupError()

  const setupKey = document.querySelector('#setup-key').value
  const username = document.querySelector('#setup-username').value.trim()
  const displayName = document.querySelector('#setup-display-name').value.trim()
  const password = document.querySelector('#setup-password').value

  if (!setupKey || !username || !password) {
    showSetupError('请填写完整')
    return
  }

  setupSubmit.disabled = true
  setupSubmit.textContent = '创建中…'

  try {
    await request('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ setupKey, username, displayName, password }),
    })
    await login(username, password)
    window.location.replace('/admin.html')
  } catch (error) {
    showSetupError(error.message || '创建失败')
    setupSubmit.disabled = false
    setupSubmit.textContent = '创建管理员'
  }
})

// 账号库为空时提示走引导创建
fetch('/api/auth/status')
  .then(response => response.json())
  .then(status => {
    if (status?.needsSetup) {
      form.hidden = true
      setupPanel.hidden = false
      document.querySelector('#setup-key').focus()
    }
  })
  .catch(() => {})
