(() => {const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Comments');if(!e)return {clicked:false};e.click();return {clicked:true};})()
