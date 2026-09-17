'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CallProcessing } = require('../recorder/call-processing');

const id = '9b918241-3cb0-447c-8861-8f14358563e7';
test('fresh missing-derived recording reaches render and retains safe stage diagnostics', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kern-pipeline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,id);fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({sessionId:id,protocolVersion:1,state:'stopped',tracks:[],segments:[]}));
  let rendered=false;
  const processor=new CallProcessing({recordingsRoot:root,helperPath:'/helper',getSession:()=>null,getOrigin:()=>null,
    settingsPath:path.join(root,'settings.json'),spawnProcess:()=>{
      rendered=true;const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
      setImmediate(()=>child.emit('close',20));return child;
    }});
  t.after(()=>processor.stop());
  await processor.onStopped(id);
  await processor.running;
  const result=await processor.getCall(id);
  assert.equal(rendered,true);
  assert.equal(result.state,'failed');
  assert.equal(result.processingStage,'render-audio');
  assert.equal(result.errorCode,'render-validation');
  assert.ok(!result.error.includes(root));
});
