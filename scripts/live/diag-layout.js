(() => {
  // What sits at the mute, eye and exit positions (screenshot fractions of the viewport).
  const W = innerWidth, H = innerHeight;
  const describe = el => {
    if (!el) return null;
    const chain = [];
    for (let n = el; n && n !== document.body && chain.length < 5; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      chain.push({tag: n.tagName, id: n.id, cls: String(n.className?.baseVal ?? n.className).slice(0, 80),
        label: n.getAttribute('aria-label') || n.title || '', rect: [r.left, r.top, r.width, r.height].map(Math.round),
        pos: getComputedStyle(n).position, z: getComputedStyle(n).zIndex});
    }
    return chain;
  };
  const at = (fx, fy) => describe(document.elementFromPoint(fx * W, fy * H));
  return {viewport: [W, H, devicePixelRatio], mute: at(65 / 1665, 72 / 2000), eye: at(62 / 1665, 897 / 2000),
    back: at(62 / 1665, 955 / 2000)};
})()
