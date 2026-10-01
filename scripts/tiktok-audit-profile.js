(() => {
 const e=document.querySelector('[data-e2e="nav-profile"],button[aria-label="Profile"]');
 if(!e)return {clicked:false};
 e.click();return {clicked:true};
})()
