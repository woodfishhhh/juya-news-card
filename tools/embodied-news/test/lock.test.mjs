import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,utimes,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import lockfile from 'proper-lockfile';
test('live writer excludes another writer; an expired crash lease can recover even if container PID is reused',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'embodied-lock-'));const path=join(dir,'collector.mutex');const options={lockfilePath:path,realpath:false,stale:60000,update:10000,retries:0};
  try{const release=await lockfile.lock(dir,options);await assert.rejects(lockfile.lock(dir,options),{code:'ELOCKED'});await release();await mkdir(path);const old=new Date(Date.now()-120000);await utimes(path,old,old);const recovered=await lockfile.lock(dir,options);await recovered();}finally{await rm(dir,{recursive:true,force:true});}
});
