import { fetchCurrentUser } from './api.js'

/**
 * 页面登录守卫：未登录则跳转到登录页。
 * 返回当前用户信息，已登录时 resolve，未登录时跳转并 reject。
 */
export function requireLogin() {
  return fetchCurrentUser()
    .then(result => {
      const user = result?.user
      if (!user) throw new Error('未登录')
      return user
    })
    .catch(error => {
      if (error?.code === 'AUTH_REQUIRED' || error?.status === 401 || error?.status === 403) {
        window.location.replace('/login.html')
      }
      throw error
    })
}
