// One selected post, metadata only. No downloads, navigation, cookies, or URL logging.
// node scripts/diagnose-tiktok-extractor-metadata.mjs --expected-hash <16hex> [--port 60195]
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWebView } from './lib/tiktok-audit-cdp.mjs';
import { buildSelectedSnapshotExpression, sameSelectedSnapshot } from './lib/tiktok-selected-hint-probe.mjs';

const PYTHON = String.raw`
import json, re, sys
from yt_dlp import YoutubeDL
from yt_dlp.networking.impersonate import ImpersonateTarget

url = json.load(sys.stdin)['url']
result = {'stage':'raw-extraction','category':'unknown','formatCount':0,'h264Mp4Count':0,
          'selectedCodec':'','selectedHeight':0,'errorType':'','markers':[],'causeType':''}
def classify(error):
    text = str(error)
    if 'Your IP address is blocked from accessing this post' in text: return 'site-access-blocked'
    if re.search(r'verif|captcha|confirm.*human|sign.?in|log.?in', text, re.I): return 'verification-required'
    if re.search(r'HTTP\s*(?:Error\s*)?403|\b403\s*Forbidden\b', text, re.I): return 'http-403'
    if re.search(r'HTTP\s*(?:Error\s*)?429|\b429\b', text, re.I): return 'http-429'
    if re.search(r'HTTP\s*(?:Error\s*)?5\d\d', text, re.I): return 'http-5xx'
    if re.search(r'tim(?:e|ed)\s*out|timeout|connection reset|DNS|SSL|TLS', text, re.I): return 'network'
    if re.search(r'no video formats|requested format is not available', text, re.I): return 'format-unavailable'
    if re.search(r'unable to extract|unsupported URL|extractor', text, re.I): return 'extractor-parser'
    if re.search(r'private video|video unavailable|not available', text, re.I): return 'source-unavailable'
    return 'other'

class SilentLogger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

options = {'quiet':True,'no_warnings':True,'skip_download':True,'noplaylist':True,
           'logger':SilentLogger(),'impersonate':ImpersonateTarget.from_str('chrome'),
           'format':'best[vcodec^=h264][ext=mp4]/best[vcodec^=avc1][ext=mp4]/download/best[ext=mp4]/best'}
try:
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
        formats = info.get('formats') or [] if isinstance(info, dict) else []
        result['formatCount'] = len(formats)
        result['h264Mp4Count'] = sum(1 for row in formats if
            row.get('ext') == 'mp4' and str(row.get('vcodec') or '').lower().startswith(('h264','avc1')))
        result['stage'] = 'format-selection'
        selected = ydl.process_ie_result(info, download=False)
        if isinstance(selected, dict):
            result['selectedCodec'] = str(selected.get('vcodec') or '')[:24]
            result['selectedHeight'] = int(selected.get('height') or 0)
        result['stage'] = 'complete'
        result['category'] = 'metadata-ok'
except Exception as error:
    result['category'] = classify(error)
    result['errorType'] = type(error).__name__[:48]
    text = str(error).lower()
    safe_markers = ('impersonat','no video','video data','webpage','empty','extract','failed',
        'format','api','json','captcha','verif','forbidden','unauthoriz','unsupported',
        'log in','login','private','unavailable','timeout','blocked','response','download')
    result['markers'] = [marker for marker in safe_markers if marker in text]
    cause = getattr(error, '__cause__', None)
    result['causeType'] = type(cause).__name__[:48] if cause else ''
print(json.dumps(result, separators=(',',':')))
`;

const args=process.argv.slice(2);
const value=name=>{const at=args.indexOf(name);return at<0?'':args[at+1]||''};
const expected=value('--expected-hash');
const port=value('--port')?Number(value('--port')):60195;
if (!/^[0-9a-f]{16}$/i.test(expected)||!Number.isInteger(port)||port<1024||port>65535) {
  throw Error('Require --expected-hash <16 hex> and optional valid --port');
}
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const source=readFileSync(resolve(root,'android-app/app/src/main/assets/tiktok-mobile.js'),'utf8');
const expression=buildSelectedSnapshotExpression(source);
const python=resolve(root,'.pong-local-ai/lora-venv/Scripts/python.exe');
const output={schema:'pong-tiktok-extractor-metadata-v1',at:new Date().toISOString(),
  videoIdHash:expected.toLowerCase(),selectedStable:false,extractor:null,outcome:'not-started'};
let client;
try {
  client=await connectWebView(port,'tiktok');
  const selected=await client.read(expression);
  const hash=selected?.id?createHash('sha256').update(selected.id).digest('hex').slice(0,16):'';
  if (hash!==expected.toLowerCase()) output.outcome='selected-post-mismatch';
  else {
    const child=spawn(python,['-c',PYTHON],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderrBytes=0,timedOut=false;
    child.stdin.end(JSON.stringify({url:selected.pageUrl}));
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-8192)});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length}); // Never output raw extractor stderr.
    const timer=setTimeout(()=>{timedOut=true;child.kill()},25000);
    const code=await new Promise(resolve=>{child.once('exit',resolve);child.once('error',()=>resolve(-1))});
    clearTimeout(timer);
    const after=await client.read(expression);
    output.selectedStable=sameSelectedSnapshot(selected,after);
    if (!output.selectedStable) output.outcome='selection-changed';
    else if (timedOut) output.outcome='metadata-timeout';
    else {
      try {
        const parsed=JSON.parse(stdout);
        const allowed=['metadata-ok','site-access-blocked','verification-required','http-403','http-429','http-5xx',
          'network','format-unavailable','extractor-parser','source-unavailable','other'];
        output.extractor={stage:['raw-extraction','format-selection','complete'].includes(parsed.stage)?parsed.stage:'unknown',
          category:allowed.includes(parsed.category)?parsed.category:'unknown',
          formatCount:Math.max(0,Number(parsed.formatCount)||0),
          h264Mp4Count:Math.max(0,Number(parsed.h264Mp4Count)||0),
          selectedCodec:/^(?:h264|avc1|h265|hev1|vp9|av01|none)$/i.test(parsed.selectedCodec)?parsed.selectedCodec:'other',
          selectedHeight:Math.max(0,Number(parsed.selectedHeight)||0),
          errorType:/^[A-Za-z]+(?:Error|Exception)$/.test(parsed.errorType)?parsed.errorType:''};
        output.extractor.markers=Array.isArray(parsed.markers)?parsed.markers.filter(x=>
          ['impersonat','no video','video data','webpage','empty','extract','failed','format','api',
            'json','captcha','verif','forbidden','unauthoriz','unsupported','log in','login',
            'private','unavailable','timeout','blocked','response','download'].includes(x)).slice(0,24):[];
        output.extractor.causeType=/^[A-Za-z]+(?:Error|Exception)$/.test(parsed.causeType)?parsed.causeType:'';
        output.outcome=code===0?'reproduced':'probe-process-failed';
      } catch {output.outcome='probe-output-invalid';}
    }
  }
} catch {output.outcome='diagnostic-failed';}
finally {client?.close();}
console.log(JSON.stringify(output,null,2));
