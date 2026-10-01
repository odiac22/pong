import {readFile} from 'node:fs/promises';
const html=await readFile('index.html','utf8');
const parts=[['function layoutPongFaceSwapDetectedFaces(', 'function matchPongDetectedOriginalFace('],['async function openPongFaceMatchFix(', 'async function openQuickPongFaceDetect('],['async function togglePongFaceSwapFaceDetect(', 'function setPongFaceSwapFrameEditorView(']];
let expression=parts.map(([a,b])=>{const start=html.indexOf(a),end=html.indexOf(b,start);if(start<0||end<0)throw Error('Function boundary missing');return html.slice(start,end);}).join('\n');
const cssStart=html.indexOf('    .pong-face-match-fix {'),cssEnd=html.indexOf('    .pong-swap-frame-editor-tools button',cssStart);
if(cssStart<0||cssEnd<0)throw Error('CSS boundary missing');
expression+='\n(()=>{document.getElementById("pong-match-fix-live")?.remove();const style=document.createElement("style");style.id="pong-match-fix-live";style.textContent='+JSON.stringify(html.slice(cssStart,cssEnd))+';document.head.appendChild(style);const editor=pongFaceSwapState.settingsEditor;if(editor?.faceDetectLayer){editor.faceDetectFaces.forEach((face,index)=>{if(editor.faceDetectLayer.querySelector(`.pong-face-match-fix[data-index="${index}"]`))return;const fix=document.createElement("button");fix.type="button";fix.className="pong-face-match-fix";fix.dataset.index=String(index);fix.textContent="Fix";fix.onclick=e=>{e.preventDefault();e.stopPropagation();void openPongFaceMatchFix(editor,face);};editor.faceDetectLayer.appendChild(fix);});layoutPongFaceSwapDetectedFaces(editor);}return {activated:true,detectOpen:!!editor?.faceDetectLayer};})()';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
try{const result=await new Promise((r,j)=>{const timeout=setTimeout(()=>j(Error('timeout')),8000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timeout);if(m.result?.exceptionDetails)j(Error(m.result.exceptionDetails.text));else r(m.result?.result?.value);}};ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});console.log(JSON.stringify(result));}finally{ws.close();}
