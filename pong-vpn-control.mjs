import {spawn} from 'node:child_process';
import {access, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';

const CITIES = new Set(['San Francisco', 'San Jose', 'Los Angeles']);
export function requiresCaliforniaVpn(value) {
  try { const h=new URL(value).hostname.toLowerCase(); return ['pornhub.com','phncdn.com'].some(d=>h===d||h.endsWith('.'+d)); } catch { return false; }
}
const error = code => Object.assign(new Error(code), {code});
const messages = {
  helper_update:'Update and restart the PC helper.',
  nord_not_installed:'NordVPN was not found on this PC. Install and sign in to NordVPN.',
  launch_failed:'Windows could not start NordVPN. Check the PC for a login or approval prompt.',
  catalog_unavailable:'Cannot obtain verified California backup servers. Check PC internet access and retry.',
  verification_unavailable:'Cannot verify the PC VPN location. No source request was allowed.',
  connection_timeout:'California connection was not confirmed. NordVPN may need login or approval on the PC.',
  disconnect_timeout:'Disconnection was not confirmed. Check NordVPN on the PC.',
  vpn_required:'The PC is not verified on NordVPN in California. Tap Connect California.',
};
async function fetchJson(url) {
  const r=await fetch(url,{signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(!r.ok)throw error('verification_unavailable');
  return r.json();
}
async function launchNord(args) {
  const executable='C:/Program Files/NordVPN/NordVPN.exe';
  try { await access(executable); } catch { throw error('nord_not_installed'); }
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,detached:false,stdio:'ignore',shell:false});
    child.once('error',()=>reject(error('launch_failed')));
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
export class CaliforniaVpnController {
  constructor({inspect=()=>fetchJson('https://api.nordvpn.com/v1/helpers/ips/insights'),catalog=()=>fetchJson('https://api.nordvpn.com/v1/servers?limit=10000'),launch=launchNord,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,attemptMs=22000}={}) {
    Object.assign(this,{inspect,catalog,launch,sleep,now,attemptMs});
    this.state={phase:'unknown',verified:false,city:null,country:null,attempt:0,maxAttempts:3,server:null,error:null,message:'VPN not checked',events:[]};
    this.operation=null;this.checking=null;this.checkedAt=0;this.startedAt=0;this.finishedAt=0;
  }
  snapshot() { return {...this.state,helperVersion:'30.15',checkedAt:this.checkedAt||null,elapsedMs:this.startedAt?Math.max(0,(this.finishedAt||this.now())-this.startedAt):0,busy:!!this.operation,events:this.state.events.map(e=>({...e}))}; }
  update(phase,message,extra={}) { Object.assign(this.state,extra,{phase,message});this.state.events.push({phase,elapsedMs:this.startedAt?this.now()-this.startedAt:0,attempt:this.state.attempt});this.state.events=this.state.events.slice(-16); }
  async check(force=false) {
    if(!force&&this.checkedAt&&this.now()-this.checkedAt<8000)return this.snapshot();
    if(this.checking)return this.checking;
    this.checking=(async()=>{
      try {
        const data=await this.inspect();
        const country=String(data.country||''); const city=String(data.city||'');
        const verified=data.protected===true&&['United States','US'].includes(country)&&CITIES.has(city);
        Object.assign(this.state,{verified,city:CITIES.has(city)?city:null,country:['United States','US'].includes(country)?'United States':'other',protected:data.protected===true});
        this.checkedAt=this.now();
        if(!this.operation&&(verified||!this.state.error))this.update(verified?'connected':'disconnected',verified?`PC VPN verified: ${city}, California`:'PC VPN is not verified in California',{error:null});
      } catch {
        this.checkedAt=0;this.state.verified=false;
        if(!this.operation)this.update('error',messages.verification_unavailable,{error:'verification_unavailable'});
      }
      return this.snapshot();
    })().finally(()=>{this.checking=null;});
    return this.checking;
  }
  async requireCalifornia(fresh=false) {
    const status=await this.check(fresh);
    if(this.operation||!status.verified)throw error('vpn_required');
    return status;
  }
  start(action) {
    if(!['connect','disconnect'].includes(action))throw error('invalid_action');
    if(this.operation)return this.snapshot();
    this.startedAt=this.now();this.finishedAt=0;this.state.events=[];
    this.update(action==='connect'?'checking':'disconnecting',action==='connect'?'Checking PC VPN…':'Disconnecting PC VPN…',{attempt:0,server:null,error:null});
    this.operation=Promise.resolve().then(()=>action==='connect'?this.connect():this.disconnect()).catch(e=>{
      const code=Object.hasOwn(messages,e.code)?e.code:'connection_timeout';
      this.update('error',messages[code],{verified:false,error:code});
    }).finally(()=>{this.finishedAt=this.now();this.operation=null;});
    return this.snapshot();
  }
  async connect() {
    if((await this.check(true)).verified){this.update('connected',`Already connected: ${this.state.city}, California`);return;}
    this.update('finding_servers','Finding California servers and backups…');
    let servers;
    try { servers=await this.catalog(); } catch { throw error('catalog_unavailable'); }
    if(!Array.isArray(servers))throw error('catalog_unavailable');
    const eligible=servers.filter(s=>s.status==='online'&&/^United States #\d+$/.test(s.name)&&s.locations?.some(l=>l.country?.code==='US'&&CITIES.has(l.country?.city?.name)));
    eligible.sort((a,b)=>(Number(a.load)||0)-(Number(b.load)||0));
    // Prefer geographic diversity rather than three records from one city.
    const picks=[];
    for(const city of ['San Francisco','Los Angeles','San Jose']){const item=eligible.find(s=>s.locations.some(l=>l.country?.city?.name===city));if(item&&!picks.some(s=>s.name===item.name))picks.push(item);}
    for(const item of eligible)if(picks.length<3&&!picks.some(s=>s.name===item.name))picks.push(item);
    if(!picks.length)throw error('catalog_unavailable');
    this.state.maxAttempts=picks.length;
    for(const [i,server]of picks.entries()){
      this.update('connecting',`${i?'Trying backup':'Connecting'} ${i+1}/${picks.length}: ${server.name}`,{attempt:i+1,server:server.name,verified:false});
      await this.launch(['--connect','--server-name',server.name]);
      const deadline=this.now()+this.attemptMs;
      while(this.now()<deadline){
        await this.sleep(1500);
        if((await this.check(true)).verified){this.update('connected',`PC VPN verified: ${this.state.city}, California`,{error:null});return;}
      }
    }
    throw error('connection_timeout');
  }
  async disconnect() {
    await this.launch(['--disconnect']);
    const deadline=this.now()+this.attemptMs;
    while(this.now()<deadline){
      await this.sleep(1000);const status=await this.check(true);
      if(this.checkedAt&&status.protected===false){this.update('disconnected','PC VPN disconnected. VPN-dependent videos may stop.',{verified:false,error:null,server:null});return;}
    }
    throw error('disconnect_timeout');
  }
}

const privateHost=h=>h==='localhost'||h==='::1'||(isIP(h)===4&&(/^(127|10)\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)));
export function vpnLocalRequest(req) {
  const remote=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
  let host;try{host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'');}catch{return false;}
  return privateHost(remote)&&privateHost(host)&&!req.headers['x-forwarded-for']&&!req.headers['x-forwarded-host'];
}
export async function createVpnRouter({directory,controller=new CaliforniaVpnController()}={}) {
  await mkdir(directory,{recursive:true});
  const keyFile=path.join(directory,'vpn-control-key');let key;
  try{key=(await readFile(keyFile,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32).toString('hex');await writeFile(keyFile,key,{flag:'wx',mode:0o600});}
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid VPN control key file');
  const authorized=req=>{const supplied=String(req.headers['x-pong-vpn-key']||'');return /^[a-f0-9]{64}$/.test(supplied)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(key));};
  return {controller,async handle(req,res,url){
    if(!url.pathname.startsWith('/vpn/'))return false;
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    if(!vpnLocalRequest(req)){reply(403,{ok:false,error:'local_network_required',message:'VPN controls require a direct connection to the PC on your home network.'});return true;}
    // No wildcard CORS. Userscript GM requests are privileged; website fetches
    // cannot read the key or use these controls. Pairing requires user navigation.
    if(url.pathname==='/vpn/setup'&&req.method==='GET'){
      const h=req.headers;
      const navigation=h['sec-fetch-mode']==='navigate'&&h['sec-fetch-dest']==='document'&&h['sec-fetch-user']==='?1';
      // HTTP LAN origins may omit Fetch Metadata (not potentially trustworthy).
      // Permit an HTML navigation fallback, still protected by SOP/no CORS,
      // frame denial, CORP and no scripts. Never enable credentialed fetch CORS.
      const legacyNavigation=!h['sec-fetch-mode']&&!h['sec-fetch-dest']&&!h['sec-fetch-site']&&!h.origin&&!h['x-requested-with']&&String(h.accept||'').includes('text/html');
      if(!navigation&&!legacyNavigation){reply(403,{ok:false,error:'open_pairing_page',message:'Open pairing using the Pair PC button.'});return true;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer'});
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Pair Pong VPN controls</title><style>body{background:#111827;color:#fff;font:16px system-ui;padding:24px}textarea{width:100%;font:14px monospace}</style><h1>Pair this phone with Pong</h1><p>This key authorizes connecting and disconnecting this PC's VPN. Share it only with your own Tampermonkey script.</p><p>Select and copy the key below, return to the source tab, tap Pair PC, and paste it. It stays paired after PC restarts.</p><textarea readonly rows="4" aria-label="Private VPN pairing key">${key}</textarea><p>No NordVPN password is needed. Keep NordVPN signed in on the PC.</p>`);return true;
    }
    if(!authorized(req)){reply(401,{ok:false,error:'pairing_required',message:'Tap Pair PC once to authorize this browser. Your NordVPN password is never needed.'});return true;}
    try{
      if(req.method==='GET'&&url.pathname==='/vpn/status'){reply(200,{ok:true,status:await controller.check()});return true;}
      if(req.method==='POST'&&url.pathname==='/vpn/connect'){reply(202,{ok:true,status:controller.start('connect')});return true;}
      if(req.method==='POST'&&url.pathname==='/vpn/disconnect'){reply(202,{ok:true,status:controller.start('disconnect')});return true;}
      if(req.method==='POST'&&url.pathname==='/vpn/verify'){
        const status=await controller.check(true);reply(status.verified&&!status.busy?200:409,{ok:status.verified&&!status.busy,status,error:status.verified?null:'vpn_required',message:status.message});return true;
      }
      reply(404,{ok:false,error:'unknown_action'});
    }catch{reply(503,{ok:false,error:'vpn_unavailable',message:'PC VPN operation failed. Copy log and check NordVPN on the PC.'});}
    return true;
  }};
}
