'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../recorder-ui/capture.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function view(state) {
  const elements = new Map(), starts = [], errors = [];
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'microphone' ? 'default' : '', checked:true, options:[], listeners:{},
      classList:{toggle(){}}, addEventListener(k,v){this.listeners[k]=v;},
      replaceChildren(...options){this.options=options;if(id==='microphone')this.value=options[0]?.value;},
      add(option){this.options.push(option);},
    });
    return elements.get(id);
  }
  const window = { recorderFormat:{duration:String,bytes:String} };
  const api = {
    onStatus:()=>()=>{}, getStatus:async()=>({state:'idle',tracks:[]}),
    getMicrophone:async()=>{if(state.readError)throw Error('read failed');return state.saved;},
    setMicrophone:async choice=>{if(state.saveError)throw Error('save failed');state.saved=JSON.parse(JSON.stringify(choice));return state.saved;},
    listDevices:async()=>{if(state.listError)throw Error('list failed');return state.devicesPromise || {captureEndpoints:state.devices};},
    start:async choice=>{starts.push(JSON.parse(JSON.stringify(choice)));return {state:'idle',tracks:[]};},
  };
  vm.runInNewContext(source,{window,document:{getElementById:el},Option:function(text,value){this.text=text;this.value=value;},Date,setInterval,clearInterval});
  window.createCaptureView({api,reportError:e=>errors.push(e.message),onStopped(){}});
  return {el,starts,errors};
}
function initial() {return {saved:{mode:'default'},devices:[{id:'fifine',name:'FIFINE',supported:true,defaultRoles:[]},{id:'airpods',name:'AirPods',supported:true,defaultRoles:['communications']}]};}

test('FIFINE selection survives view recreation and never changes to communications default', async()=>{
  const state=initial();const first=view(state);await settle();
  first.el('microphone').value='device:fifine';await first.el('microphone').listeners.change();
  const reopened=view(state);await settle();
  assert.equal(reopened.el('microphone').value,'device:fifine');
  await reopened.el('start').listeners.click();
  assert.deepEqual(reopened.starts,[{mode:'device',deviceId:'fifine'}]);
});

test('missing or inactive selected microphone blocks Start and refresh retains identity',async()=>{
  const state=initial();state.saved={mode:'device',deviceId:'fifine'};const v=view(state);await settle();
  state.devices=state.devices.filter(d=>d.id!=='fifine');await v.el('refresh-devices').listeners.click();
  assert.equal(v.el('microphone').value,'device:fifine');assert.equal(v.el('start').disabled,true);
  await v.el('start').listeners.click();assert.equal(v.starts.length,0);
  state.devices.push({id:'fifine',name:'FIFINE',supported:false});await v.el('refresh-devices').listeners.click();
  assert.equal(v.el('start').disabled,true);
  state.devices[1].supported=true;await v.el('refresh-devices').listeners.click();assert.equal(v.el('start').disabled,false);
});

test('Start waits for enumeration and remains blocked after preference or enumeration failure',async()=>{
  const state=initial();let release;state.devicesPromise=new Promise(resolve=>{release=resolve;});
  const v=view(state);await settle();assert.equal(v.el('start').disabled,true);
  release({captureEndpoints:state.devices});await settle();assert.equal(v.el('start').disabled,false);
  delete state.devicesPromise;state.listError=true;await v.el('refresh-devices').listeners.click();assert.equal(v.el('start').disabled,true);
  const broken=initial();broken.readError=true;const b=view(broken);await settle();assert.equal(b.el('start').disabled,true);
  b.el('microphone').value='device:fifine';broken.saveError=true;await b.el('microphone').listeners.change();assert.equal(b.el('start').disabled,true);
  broken.saveError=false;await b.el('microphone').listeners.change();assert.equal(b.el('start').disabled,false);
});
