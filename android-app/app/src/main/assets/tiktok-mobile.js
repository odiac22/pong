(() => {
  'use strict';
  if (window.__pongMobileTikTokInstalled) { window.__pongTikTokScan?.(); return; }
  window.__pongMobileTikTokInstalled = true;
  // Observe the real mobile site; do not synthesize swipes, replace profile
  // navigation, hide login dialogs, or force desktop card styles onto it.
  let last = '', scanTimer = null, lastScan = 0, pendingFull = true, clockCache = null, photoCache = null;
  // Experimental only. The shipped/default observer continues to run every
  // full scan; a timed clock tick may reuse identity for at most 1.5 seconds.
  const stableFeedTrial = window.__pongMobileStableFeedTrial === true;
  const fastClockTrial = window.__pongMobileFastClockTrial === true || stableFeedTrial;
  const canonical = raw => {
    // new URL('', location.href) resolves to the currently open post. An
    // anchorless next card is NOT that post: treating its missing href as the
    // current URL bypassed React identity and collapsed every next-card list.
    if (typeof raw !== 'string' || !raw.trim()) return '';
    try {
      const u = new URL(raw, location.href);
      return /(^|\.)tiktok\.com$/i.test(u.hostname) && /^\/@[^/]+\/video\/\d+\/?$/.test(u.pathname)
        ? 'https://www.tiktok.com' + u.pathname : '';
    } catch { return ''; }
  };
  const area = element => {
    const r = element.getBoundingClientRect();
    return Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) *
      Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
  };
  const reactVideo = (() => {
   const paths = new WeakMap();
   const virtualPaths = new WeakMap();
   return (element, includeItem=false) => {
    // React data contains DOM references and accessors too. Inspect only own
    // data properties: discovery must not execute a site's cookie/DOM getters.
    // Bound the queue itself, not just the number of entries later consumed.
    const own = (object, key) => {
      try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
    };
    const found = item => {
      const id=own(item,'id'),rawAuthor=own(item,'author');
      let author=typeof rawAuthor==='string'?rawAuthor:own(rawAuthor,'uniqueId');
      if(!(typeof id==='string'&&/^\d{15,22}$/.test(id)))return null;
      if(!(typeof author==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(author))){
        // Following can omit the author entirely while providing the actual
        // post and its video object. TikTok/our resolver address posts by ID;
        // '_' is the existing native bridge's author-less route convention.
        // Never promote arbitrary IDs (music, accounts or unrelated stores).
        // The post ID and owned video ID must agree, on this exact item.
        if(own(own(item,'video'),'id')!==id||
            !(rawAuthor===''||rawAuthor===undefined||rawAuthor===null))return null;
        author='_';
      }
      // A recognized photo is a valid terminal item, but never a video URL.
      // Cache its descriptor path too: otherwise every 250ms scan exhausts
      // the entire React tree again for each photo among the next seven posts.
      // Re-read the item/type on every visit so recycled photo -> video slots
      // become eligible immediately, without keeping an outgoing identity.
      const kind=own(item,'isAd')===true?'ad':own(item,'imagePost')||own(item,'imagePostInfo')?'photo':'video';
      return {url:kind==='video'?canonical('/@'+author+'/video/'+id):'',kind,id,item};
    };
    // Cache a descriptor path, NOT a post ID. Re-read its actual data on each
    // call; replaced props, recycled nodes, removed paths and mutable items
    // cannot preserve an outgoing identity. Generic Fiber trees are not cached.
    const cached=paths.get(element);
    if(cached&&own(element,cached.rootKey)===cached.root){
      let item=cached.root;for(const key of cached.path)item=own(item,key);
      const value=found(item);if(value)return includeItem?value:value.url;
    }
    // Remember only how to reach the selected hook, never its post identity
    // or a strong reference to a retired Fiber. Most scans then need fewer
    // than twenty own-property reads rather than a repeated tree search.
    const virtual=virtualPaths.get(element);
    if(virtual){
      let fiber=own(element,virtual.rootKey);
      for(let n=0;fiber&&n<virtual.depth;n++)fiber=own(fiber,'return');
      const props=own(fiber,'memoizedProps'),slot=element.getAttribute?.('data-scroll-index');
      if(typeof slot==='string'&&/^\d+$/.test(slot)&&own(props,'index')===Number(slot)){
        let hook=own(fiber,'memoizedState');
        for(let n=0;hook&&n<virtual.hook;n++)hook=own(hook,'next');
        const state=own(hook,'memoizedState'),item=virtual.wrapped?own(own(state,'current'),'value'):state;
        if(own(item,'id')===own(props,'id')){
          const value=found(item);if(value)return includeItem?value:value.url;
        }
      }
      virtualPaths.delete(element);
    }
    const roots=Object.keys(element).filter(k=>k.startsWith('__react'));
    // Exhaust the small current-props tree BEFORE entering Fiber. Mixing both
    // roots into one BFS let Fiber exhaust the 180-object budget before a
    // perfectly valid current item at props.children...item could be visited.
    // The same bug discarded all next-card identities, defeating prefetch.
    for(const primary of [true,false]) {
      const queue = [],seen = new WeakSet();
      const enqueue = (item, depth, rootKey, path) => {
        if (!item || typeof item !== 'object' || depth > 8 || seen.has(item) || queue.length >= 180) return;
        seen.add(item); queue.push([item, depth, rootKey, path]);
      };
      roots.filter(k=>k.startsWith('__reactProps')===primary).forEach(k=>enqueue(own(element,k),0,k,[]));
      for (let cursor=0;cursor<queue.length;cursor++) {
        const [item, depth, rootKey, path] = queue[cursor];
        // ID and author must belong to the same item, never unrelated objects.
        const value=found(item);
        if(value){
          if(primary)paths.set(element,{rootKey,root:own(element,rootKey),path});
          return includeItem?value:value.url;
        }
        for (const key of Object.keys(item).slice(0, 60)) {
          if (['return', 'stateNode', 'ownerDocument','_owner','ref'].includes(key)) continue;
          enqueue(own(item,key),depth+1,rootKey,[...path,key]);
        }
      }
    }
    // Virtualized For You cards deliberately have no video or link children.
    // Their OWN item component still holds its selected post in a small hook
    // list. Read that exact item (not the ancestor feed/account store), tied
    // to both the component's post ID and this rendered slot index. This makes
    // N+2 source preparation possible before TikTok mounts N+2's decoder.
    const slot=element.getAttribute?.('data-scroll-index');
    if(element.getAttribute?.('data-e2e')==='recommend-list-item-container' &&
        typeof slot==='string'&&/^\d+$/.test(slot)) {
      let fiber=own(element,roots.find(k=>k.startsWith('__reactFiber')));
      for(let depth=0;fiber&&depth<7;depth++,fiber=own(fiber,'return')) {
        const props=own(fiber,'memoizedProps'),id=own(props,'id'),index=own(props,'index');
        if(typeof id!=='string'||!/^\d{15,22}$/.test(id)||index!==Number(slot))continue;
        let hook=own(fiber,'memoizedState');
        for(let n=0;hook&&n<20;n++,hook=own(hook,'next')) {
          const state=own(hook,'memoizedState');
          for(const item of [state,own(own(state,'current'),'value')]) {
            if(own(item,'id')!==id)continue;
            const value=found(item);
            if(value){
              virtualPaths.set(element,{rootKey:roots.find(k=>k.startsWith('__reactFiber')),depth,hook:n,wrapped:item!==state});
              return includeItem?value:value.url;
            }
          }
        }
      }
    }
    return '';
   };
  })();
  const itemUrl = element => {
    const data=reactVideo(element,true);
    if(data?.kind==='ad'||data?.kind==='photo')return '';
    const anchor = element.closest('a[href*="/video/"]') || element.querySelector('a[href*="/video/"]');
    return canonical(anchor?.href || '') || data?.url || '';
  };
  const videoPage = (video,active) => {
    // Creator cinema has no feed-card wrapper. Its address bar advances before
    // the old video is replaced, so falling back to location can pair the next
    // post with the outgoing clock. TikTok's actual player wrapper carries its
    // own post ID; bind that ID to a real grid link (or the matching route).
    const player=video?.closest('[id^="xgwrapper-"]');
    const id=player?.id?.match(/-(\d{15,22})$/)?.[1];
    if(id){
      const matches=url=>url&&url.endsWith('/video/'+id);
      const cardUrl=active?itemUrl(active):'';
      if(matches(cardUrl))return cardUrl;
      for(const anchor of document.querySelectorAll('a[href*="/video/'+id+'"]')){
        const url=canonical(anchor.href);if(matches(url))return url;
      }
      const route=canonical(location.href);return matches(route)?route:'';
    }
    return (active&&itemUrl(active))||itemUrl(video)||canonical(location.href);
  };
  const mediaHint = card => {
    const found=reactVideo(card,true), item=found?.item;
    const own=(x,k)=>{try{return Object.getOwnPropertyDescriptor(x,k)?.value}catch{return undefined}};
    const video=own(item,'video'),formats=own(video,'bitrateInfo');
    if(!found?.url||!Array.isArray(formats))return null;
    // Match the existing desktop highest-H.264 policy. Never select the
    // currently adaptive low-bitrate rendition or watermark download URL.
    const variants=formats.slice(0,30).map(row=>{
      const addr=own(row,'PlayAddr'),codec=own(row,'CodecType');
      const urls=own(addr,'UrlList');
      return {codec:typeof codec==='string'?codec:'',width:Number(own(addr,'Width')),height:Number(own(addr,'Height')),
        bitrate:Number(own(row,'Bitrate'))||0,fps:Number(own(row,'BitrateFPS'))||0,size:Number(own(addr,'DataSize')),
        urls:Array.isArray(urls)?urls.filter(u=>typeof u==='string'&&u.length<=8192).slice(0,3):[]};
    }).filter(v=>/^(h264|avc1)/i.test(v.codec)&&v.width>0&&v.height>0&&v.size>0&&v.urls.length)
      .sort((a,b)=>b.width*b.height-a.width*a.height||b.fps-a.fps||b.bitrate-a.bitrate);
    return variants[0]?{pageUrl:found.url,videoId:own(item,'id'),...variants[0]}:null;
  };
  const cinemaViewports = new WeakMap();
  // A photo carousel has its own horizontal .swiper-slide children INSIDE
  // the vertical feed article. Those are images, not next video posts.
  const postCard = media => media?.closest('[data-e2e="recommend-list-item-container"]') || media?.closest('.swiper-slide');
  const profileForwardVideos = (current, photoVisible) => {
    const postPath = raw => {
      if (typeof raw !== 'string' || !raw.trim()) return '';
      try {
        const u=new URL(raw,location.href);
        return /(^|\.)tiktok\.com$/i.test(u.hostname)&&/^\/@[^/]+\/(?:video|photo)\/\d+\/?$/.test(u.pathname)
          ? u.pathname.replace(/\/$/,'') : '';
      } catch { return ''; }
    };
    // Cinema photo posts have no video clock, but still occupy a real place
    // in the creator playlist. Keep that place while finding the next videos;
    // do not turn the photo ID into a fake /video/ source or drain the queue.
    const route=postPath(location.href);
    const currentPath=postPath(current)||(photoVisible&&route.includes('/photo/')?route:'');
    if(!currentPath)return [];
    const posts=[...document.querySelectorAll('[data-e2e="user-post-item"] a[href*="/video/"],[data-e2e="user-post-item"] a[href*="/photo/"]')]
      .map(a=>({path:postPath(a.href),video:canonical(a.href)}))
      .filter((p,i,all)=>p.path&&all.findIndex(q=>q.path===p.path)===i);
    const at=posts.findIndex(p=>p.path===currentPath);
    return at<0?[]:posts.slice(at+1).filter(p=>p.video).slice(0,3).map(p=>p.video);
  };
  const navigationBounds = media => {
    // The displayed pixels are smaller than the gesture surface (letterboxes,
    // landscape clips and partly scrolled cinema cards). Using the video's
    // moving rectangle lets a swipe escape into a free scroll and then leaves
    // the viewer between posts. Use the actual playlist viewport, not comments
    // or the creator grid. Cache only connected ancestors; geometry stays live.
    const cinema = media.closest('[class*="DivCinemaModeContent"]');
    if (cinema) {
      let viewport = cinemaViewports.get(media);
      if (!viewport?.isConnected || !cinema.contains(viewport)) {
        viewport = null;
        for (let n=media.parentElement,depth=0;n&&n!==cinema&&depth<18;n=n.parentElement,depth++) {
          if (n.clientHeight>innerHeight*.5 && /^(auto|scroll)$/.test(getComputedStyle(n).overflowY)) {
            viewport=n;break;
          }
        }
        if (viewport) cinemaViewports.set(media,viewport);
      }
      if (viewport) return viewport.getBoundingClientRect();
    }
    const card=postCard(media);
    return (card||media).getBoundingClientRect();
  };
  const observerStats = () => {
    const stats=window.__pongTikTokObserverStats??={scans:0,totalMs:0,maxMs:0};
    stats.fullScans??=0;stats.fastClock??=0;stats.fullMs??=0;stats.fastClockMs??=0;
    return stats;
  };
  const clockFields = video => ({
    currentTime:Math.round((video?.currentTime||0)*1000)/1000,
    duration:Number.isFinite(video?.duration)?video.duration:0,
    paused:!video||video.paused,playbackRate:video?.playbackRate||1
  });
  const sourceKey = video => [video?.currentSrc||'',video?.src||'',video?.poster||''].join('\n');
  const photoSourceKey = photo => [photo?.currentSrc||'',photo?.src||'',photo?.srcset||''].join('\n');
  const rectKey = media => {
    const r=media.getBoundingClientRect();
    return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight].join(',');
  };
  const fastPhoto = () => {
    const c=photoCache,photo=c?.photo,card=c?.card;
    const currentItem=card?.isConnected?reactVideo(card,true):null;
    if(!c||performance.now()-c.fullAt>=1000||document.hidden||!photo?.isConnected||!card?.isConnected||
        location.href!==c.location||photoSourceKey(photo)!==c.sourceKey||
        rectKey(photo)!==c.rectKey||postCard(photo)!==card||
        area(photo)<=innerWidth*innerHeight*.22||
        currentItem?.kind!=='photo'||currentItem.id!==c.id||
        window.__pongMediaHintTrial===true||document.querySelector('[data-e2e="cinema-mode-exit"]'))return false;
    // A reused or newly revealed VIDEO must preempt the cached photo even if
    // TikTok changed only compositor visibility before its playing event.
    for(const video of document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')){
      if(getComputedStyle(video).display!=='none'&&area(video)>innerWidth*innerHeight*.22)return false;
    }
    if(c.forwardCards.some((forward,i)=>!forward.isConnected||itemUrl(forward)!==c.forwardUrls[i]))return false;
    const r=navigationBounds(photo),region={x:Math.max(0,r.left)/innerWidth,y:Math.max(0,r.top)/innerHeight,
      right:Math.min(innerWidth,r.right)/innerWidth,bottom:Math.min(innerHeight,r.bottom)/innerHeight};
    if(JSON.stringify(region)!==c.region)return false;
    window.__pongTikTokPostEvidence={kind:'photo',adId:'',photoId:c.id,photoCard:card,photoMedia:photo};
    window.__pongDomSwapObserveVideo?.('',c.video);
    const payload=JSON.stringify({...c.payload,...clockFields(c.video)});
    if(payload!==last){last=payload;window.PongTikTokFeed?.report(payload);}
    return true;
  };
  const fastClock = () => {
    const c=clockCache,video=c?.video;
    if(!c||performance.now()-c.fullAt>=1500||!video||video.isConnected===false||
        c.active?.isConnected===false||video.paused)return false;
    const currentItem=reactVideo(c.active,true);
    if(currentItem?.kind&&currentItem.kind!=='video')return false;
    if(
        location.href!==c.location||sourceKey(video)!==c.sourceKey||
        window.__pongMediaHintTrial===true||document.querySelector('[data-e2e="cinema-mode-exit"]')||
        getComputedStyle(video).display==='none'||postCard(video)!==c.active||
        area(video)<=innerWidth*innerHeight*.22||
        videoPage(video,c.active)!==c.payload.current||
        c.active?.querySelector('[data-e2e="ad-tag"]')||
        c.forwardCards.some((card,i)=>card.isConnected===false||itemUrl(card)!==c.forwardUrls[i])||
        document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'))return false;
    const r=navigationBounds(video),region={x:Math.max(0,r.left)/innerWidth,y:Math.max(0,r.top)/innerHeight,
      right:Math.min(innerWidth,r.right)/innerWidth,bottom:Math.min(innerHeight,r.bottom)/innerHeight};
    if(JSON.stringify(region)!==c.region)return false;
    window.__pongDomSwapObserveVideo?.(c.payload.current,video);
    const payload=JSON.stringify({...c.payload,...clockFields(video)});
    if(payload!==last){last=payload;window.PongTikTokFeed?.report(payload);}
    return true;
  };
  const scan = (forceFull=true) => {
    // A playing event can preempt a pending mutation scan. Cancel that pending
    // callback so repeated events cannot accumulate independent scan chains.
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = null;
    if (document.hidden) return;
    lastScan = performance.now();
    if(!forceFull&&((fastClockTrial&&fastClock())||(stableFeedTrial&&fastPhoto()))){
      const stats=observerStats(),elapsed=performance.now()-lastScan;
      stats.scans++;if(photoCache&&photoCache.payload.postKind==='photo')stats.fastPhoto=(stats.fastPhoto||0)+1;
      else stats.fastClock++;
      stats.fastClockMs+=elapsed;
      stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);
      return;
    }
    const video = [...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')]
      .filter(v => getComputedStyle(v).display !== 'none')
      .map(v=>({v,area:area(v)})).sort((a,b)=>
        (b.area+(b.area>innerWidth*innerHeight*.22&&!b.v.paused?1e9:0))-
        (a.area+(a.area>innerWidth*innerHeight*.22&&!a.v.paused?1e9:0)))[0]?.v;
    const activeVideo = !!video && area(video) > innerWidth * innerHeight * .22;
    const articles = [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
    const cards = articles.length ? articles : [...document.querySelectorAll('.swiper-slide')];
    const active = activeVideo ? postCard(video) : null;
    // SPA navigation changes location before it replaces the media element.
    // Never attach the outgoing video's clock to the incoming URL.
    const candidateCurrent = activeVideo ? videoPage(video,active) : '';
    const adItem = activeVideo && active ? reactVideo(active,true) : null;
    const advertisement = !!activeVideo && !!active &&
      (adItem?.kind==='ad' || !!active.querySelector('[data-e2e="ad-tag"]'));
    // Sponsored creatives are not necessarily public /video/ posts. Keep the
    // site's original playing, but do not send a fabricated public source to
    // the PC or repeatedly retry a nonexistent download.
    const current = advertisement ? '' : candidateCurrent;
    // Vertical navigation also works across photo posts, but only inside the
    // actual media region. Grids, comments, navigation and verification retain
    // normal website touch handling.
    // TikTok sometimes renders a real imagePost with a different image class.
    // Without positive photo media here swipeRegion becomes null, so native
    // passes a vertical feed swipe into the horizontal carousel. Restrict the
    // fallback to the visible outer feed card's verified React photo item;
    // profile grids, avatars and unknown posts keep ordinary site handling.
    const namedPhoto = !activeVideo
      ? [...document.querySelectorAll('img[class*="ImgPhotoSlide"]')]
        .sort((a,b)=>area(b)-area(a)).find(image=>area(image)>innerWidth*innerHeight*.22) : null;
    const photo = !activeVideo ? namedPhoto || articles
      .filter(card=>area(card)>innerWidth*innerHeight*.22 && reactVideo(card,true)?.kind==='photo')
      .flatMap(card=>[...card.querySelectorAll('img')])
      .sort((a,b)=>area(b)-area(a))
      .find(image=>area(image)>innerWidth*innerHeight*.22) : null;
    // An unresolved visible video is not an idle photo. Only positive visible
    // photo evidence may relax the next-swap preparation gate.
    const postKind = advertisement ? 'ad' : current ? 'video' : !activeVideo && photo &&
      area(photo)>innerWidth*innerHeight*.22 ? 'photo' : 'unknown';
    // Photo identity belongs to the vertical post, not its rotating image URL.
    // Keep these DOM references local (never in the bridge payload). Consumers
    // must match both the visible image and its card before using this evidence.
    const photoCard=postKind==='photo'?postCard(photo):null;
    const photoItem=photoCard?reactVideo(photoCard,true):null;
    const photoId=photoItem?.kind==='photo'?photoItem.id:'';
    window.__pongTikTokPostEvidence={kind:postKind,
      adId:advertisement?String(adItem?.id||candidateCurrent.match(/video\/(\d+)/)?.[1]||''):'',
      photoId:photoId||'',photoCard:photoId?photoCard:null,photoMedia:photoId?photo:null};
    const navigationMedia = activeVideo ? video : photo;
    let swipeRegion = null;
    if (navigationMedia && area(navigationMedia)>innerWidth*innerHeight*.22 &&
        !document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')) {
      const r=navigationBounds(navigationMedia);
      swipeRegion={x:Math.max(0,r.left)/innerWidth,y:Math.max(0,r.top)/innerHeight,
        right:Math.min(innerWidth,r.right)/innerWidth,bottom:Math.min(innerHeight,r.bottom)/innerHeight};
    }
    window.__pongDomSwapObserveVideo?.(current,video);
    const urls = current ? [current] : [];
    const hintCards = current && active ? [active] : [];
    const forwardCard=active||postCard(photo);
    const start = cards.indexOf(forwardCard);
    const forwardCards=start>=0?cards.slice(start + 1, start + 8):[];
    const forwardUrls=forwardCards.map(itemUrl);
    for (let i=0;i<forwardCards.length;i++) {
      const card=forwardCards[i],url=forwardUrls[i];
      if (url && !urls.includes(url)) {urls.push(url);if(hintCards.length<3)hintCards.push(card);}
    }
    // Cinema retains the creator's grid behind its modal, not For You cards.
    // Those real grid links provide the next source without reloading TikTok.
    if ((current || photo&&area(photo)>innerWidth*innerHeight*.22) && document.querySelector('[data-e2e="cinema-mode-exit"]')) {
      for (const url of profileForwardVideos(current,!!photo)) {
        if (!urls.includes(url)) urls.push(url);
      }
      for(const anchor of document.querySelectorAll('[data-e2e="user-post-item"] a[href*="/video/"]')) {
        if(hintCards.length>=3)break;
        if(urls.slice(0,3).includes(canonical(anchor.href))) {
          const card=anchor.closest('[data-e2e="user-post-item"]');
          if(card&&!hintCards.includes(card))hintCards.push(card);
        }
      }
    }
    // The desktop CDN trial returned 403 even with browser-compatible TLS.
    // Keep that extra React traversal and failed request off the normal path.
    const mediaHints=window.__pongMediaHintTrial===true?hintCards.map(mediaHint).filter(Boolean):[];
    const staticPayload={activeVideo:!!current,postKind,swipeRegion,current,next:urls[current?1:0]||'',urls,mediaHints};
    const payload = JSON.stringify({...staticPayload,...clockFields(video)});
    if (payload !== last) { last = payload; window.PongTikTokFeed?.report(payload); }
    clockCache=fastClockTrial&&postKind==='video'&&current&&video&&active&&
      !window.__pongMediaHintTrial&&!document.querySelector('[data-e2e="cinema-mode-exit"]')&&swipeRegion
      ? {video,active,location:location.href,sourceKey:sourceKey(video),
          forwardCards,forwardUrls,region:JSON.stringify(swipeRegion),
          payload:staticPayload,fullAt:performance.now()} : null;
    photoCache=stableFeedTrial&&postKind==='photo'&&photoId&&photoCard&&photo&&
      !window.__pongMediaHintTrial&&!document.querySelector('[data-e2e="cinema-mode-exit"]')&&swipeRegion
      ? {photo,card:photoCard,id:photoId,video,location:location.href,
          sourceKey:photoSourceKey(photo),rectKey:rectKey(photo),
          forwardCards,forwardUrls,region:JSON.stringify(swipeRegion),
          payload:staticPayload,fullAt:performance.now()} : null;
    const stats=observerStats(),elapsed=performance.now()-lastScan;
    stats.scans++;stats.fullScans++;stats.fullMs+=elapsed;
    stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);
  };
  // 29.49: profile grids, Discover and Inbox have nothing to swap, but every
  // TikTok re-render there triggered a full scan (up to 4/s, each forcing
  // layout on the WebView main thread that Pong's page shares). Off the feed,
  // scan at most once a second; feed, video and cinema routes are unchanged.
  const onFeed = () => {
    const path = location.pathname.replace(/^\/[a-z]{2}(-[A-Z]{2})?(?=\/)/, '');
    return path === '/' || path === '' || /^\/(foryou|following|friends)\/?$/.test(path) ||
      /\/(video|photo)\/\d+/.test(path) || !!document.querySelector('[data-e2e="cinema-mode-exit"]');
  };
  const schedule = (forceFull=true) => {
    pendingFull ||= forceFull;
    if (scanTimer === null) scanTimer = setTimeout(()=>{
      const full=pendingFull;pendingFull=false;scan(full);
    }, Math.max(0, (onFeed() ? 250 : 1000) - (performance.now() - lastScan)));
  };
  // A newly visible post should not wait for the next 500ms polling tick.
  document.addEventListener('playing', event => {
    if (event.target?.tagName !== 'VIDEO' || event.target.classList.contains('pong-tiktok-swap-stream')) return;
    if (onFeed()) scan(); else schedule();
  }, true);
  // Admit the incoming decoder on its load event, without waiting a quarter
  // second for the periodic metadata scan. Batch same-turn load events and
  // ignore our own warm/active decoder so this cannot create a feedback loop.
  document.addEventListener('loadstart', event => {
    if(event.target?.tagName!=='VIDEO'||event.target.classList.contains('pong-tiktok-swap-stream'))return;
    if(!onFeed()){schedule();return;}
    if(scanTimer!==null)clearTimeout(scanTimer);
    scanTimer=setTimeout(scan,0);
  },true);
  window.__pongTikTokScan = schedule;
  new MutationObserver(()=>{
    // Style/src mutations matter for a cached carousel or newly visible
    // media. Existing default observer semantics stay untouched.
    if(stableFeedTrial){photoCache=null;clockCache=null;}
    schedule(true);
  }).observe(document.documentElement, {subtree:true, childList:true, attributes:true,
    attributeFilter:stableFeedTrial?['href','class','style','src','srcset']:['href','class']});
  addEventListener('scroll', ()=>{if(stableFeedTrial){photoCache=null;clockCache=null;}schedule(true);}, {passive:true});
  addEventListener('popstate', ()=>{if(stableFeedTrial){photoCache=null;clockCache=null;}schedule(true);});
  document.addEventListener('visibilitychange', ()=>{
    if(stableFeedTrial){photoCache=null;clockCache=null;if(!document.hidden){scan(true);return;}}
    schedule(true);
  });
  // TikTok navigates with pushState (no popstate): scan at once on a route
  // change so returning to the feed never waits for the 1 s off-feed cadence.
  let lastRoute = location.pathname;
  setInterval(()=>{
    if (location.pathname !== lastRoute) {
      lastRoute = location.pathname;
      if (stableFeedTrial) { photoCache = null; clockCache = null; }
      scan(true);
      return;
    }
    schedule(false);
  }, 500);
  schedule();
})();
