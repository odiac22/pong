(() => ({
  route:location.pathname,
  challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),
  profilePosts:document.querySelectorAll('[data-e2e="user-post-item"]').length,
  videoLinks:[...document.querySelectorAll('[data-e2e="user-post-item"] a[href]')].filter(e=>/\/video\/\d+/.test(e.pathname)).length,
  cinema:!!document.querySelector('[data-e2e="cinema-mode-exit"]'),
  nextButtons:[...document.querySelectorAll('button')].filter(e=>/next|down/i.test(e.getAttribute('aria-label')||'')).map(e=>({label:e.getAttribute('aria-label'),disabled:e.disabled})).slice(0,5)
}))()
