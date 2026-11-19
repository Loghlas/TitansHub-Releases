import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {githubClient,loadBase} from './network.mjs';
test('read-only client refuses all writes before any network call, even with activation flags',async()=>{
 let calls=0;const client=githubClient('synthetic-test-token',async()=>{calls++;throw Error('Unexpected network');});
 for(const method of ['POST','PUT','PATCH','DELETE'])await assert.rejects(()=>client(method,'/git/refs/heads/main',{}),/read-only/);
 assert.equal(calls,0);
});
test('publication and unknown activation inputs are refused before loading the base',()=>{
 for(const args of [['--mode','publish'],['--automatic'],['--approve-sha256','anything']]){
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./simulate.mjs',import.meta.url)),...args],{encoding:'utf8',windowsHide:true,env:{...process.env,CALENDAR_AUTO_PUBLISH:'true',CALENDAR_INITIAL_PUBLICATION_APPROVED:'true'}});
 assert.notEqual(result.status,0);
 }
});
test('base calendar and ledger are read from exactly one captured commit',async()=>{
 const paths=[];const base=await loadBase(async(method,p)=>{assert.equal(method,'GET');paths.push(p);return p==='/git/ref/heads/main'?{object:{sha:'captured'}}:{encoding:'base64',content:Buffer.from('{}').toString('base64')};});
 assert.equal(base.commit,'captured');assert.ok(paths.slice(1).every(p=>p.endsWith('?ref=captured')));
});
