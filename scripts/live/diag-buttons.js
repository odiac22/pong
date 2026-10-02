(() => {
  const info = el => {
    if (!el) return null;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {rect: [r.left, r.top, r.width, r.height].map(Math.round), display: cs.display, visibility: cs.visibility,
      opacity: cs.opacity, pointer: cs.pointerEvents, text: (el.textContent || '').trim().slice(0, 20),
      html: el.innerHTML.replace(/\s+/g, ' ').slice(0, 160)};
  };
  const rail = [...document.querySelectorAll('[id$="-button"], .audio-toggle-button')].filter(e => {
    const r = e.getBoundingClientRect(); return r.width && r.left < 120;
  }).map(e => ({id: e.id || e.className, ...info(e)}));
  return {
    bodyBg: getComputedStyle(document.body).backgroundColor,
    tiktokVolume: info(document.querySelector('button[aria-label="Volume"]')),
    pongAudio: [...document.querySelectorAll('.audio-toggle-button')].map(info).filter(x => x.rect[2]),
    rail
  };
})()
