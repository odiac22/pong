(() => [...document.querySelectorAll('[class*="DivSidePanelSection"] button')].slice(0,5).map(e=>({html:e.outerHTML.slice(0,2200),parentClass:e.parentElement.className})))()
