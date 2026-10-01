import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const source=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
const policy=source.slice(source.indexOf('  private static double tikTokSwapStartSeconds('),source.indexOf('  private static String unwrapJavascriptResult('));
test('compiled Android start policy reuses short loops and bounds mid-video look-ahead',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pong-start-policy-'));
 try{
  writeFileSync(join(dir,'StartPolicy.java'),`public class StartPolicy {
   ${policy}
   static void check(double p,double d,double expected) {
    double actual=tikTokSwapStartSeconds(p,d);
    if(Math.abs(actual-expected)>0.000001||!Double.isFinite(actual))throw new AssertionError(p+": "+actual+" != "+expected);
   }
   public static void main(String[] args) {
    check(0,30,0);check(.133333,7,0);check(.8,30,0);check(-1,30,0);check(Double.NaN,30,0);
    check(.801,30,1.401);check(10,120,10.6);check(119.8,120,0);check(120,120,0);check(10,Double.NaN,10.6);
    check(10,0,10.6);check(10,Double.POSITIVE_INFINITY,10.6);
    System.out.println("12 production-policy cases passed");
   }
  }`);
  execFileSync('javac',[join(dir,'StartPolicy.java')],{timeout:15000});
  const output=execFileSync('java',['-cp',dir,'StartPolicy'],{encoding:'utf8',timeout:15000});
  assert.match(output,/12 production-policy cases passed/);
 }finally{
  // Remove only these two generated test files; no recursive deletion.
  for(const name of ['StartPolicy.java','StartPolicy.class']){
   const path=join(dir,name);if(existsSync(path))unlinkSync(path);
  }
  rmdirSync(dir);
 }
});
