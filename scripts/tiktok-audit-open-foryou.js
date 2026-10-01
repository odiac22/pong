(() => {
  document.querySelector('[data-e2e="cinema-mode-exit"]')?.click();
  const button=document.querySelector('[data-e2e="nav-foryou"]');
  if(!button)return {opened:false};
  button.click();return {opened:true};
})()
