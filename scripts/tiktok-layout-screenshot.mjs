import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output=process.argv[2];
const png=execFileSync(adb,['-s','adb-R3CWA0HL7DF-ym0O4w._adb-tls-connect._tcp','exec-out','screencap','-p'],{maxBuffer:20000000});
const start=png.indexOf(Buffer.from('89504e470d0a1a0a','hex'));
if(start<0)throw Error('No PNG screenshot returned');
writeFileSync(output,png.subarray(start));
console.log(output);
