(() => {const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Refresh');if(!button)return {refreshed:false};button.click();return {refreshed:true};})()
