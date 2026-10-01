import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output='E:/Pong Benchmarks/tiktok-webview-2026-09-29/emulator-screen.png';
writeFileSync(output,execFileSync(adb,['-s','emulator-5582','exec-out','screencap','-p'],{maxBuffer:16*1024*1024}));
console.log(output);
