import {mkdir,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].slice(2)]=process.argv[i+1];
const root=resolve(args.data || process.env.EMBODIED_STATE_ROOT || 'data');
const lock=join(root,'scheduled-round.mutex');const ownerFile=join(lock,'owner.json');
if(!['acquire','release','status'].includes(args.action))throw new Error('Use --action acquire|release|status');
if(args.action!=='status' && !/^[A-Za-z0-9_.:-]{1,150}$/.test(args.owner || ''))throw new Error('A unique non-secret round owner ID is required');
await mkdir(root,{recursive:true});
if(args.action==='acquire'){
 try{await mkdir(lock);}catch(e){if(e.code!=='EEXIST')throw e;console.log(JSON.stringify({acquired:false,reason:'Existing scheduled round lease; do not overlap or automatically expire it'}));process.exit(3);}
 const record={owner:args.owner,acquiredAt:new Date().toISOString(),recovery:'Fail closed after interruption. Inspect active collectors and scheduled runs before manual recovery.'};
 await writeFile(ownerFile,JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({acquired:true,...record}));
}else{
 let record;try{record=JSON.parse(await readFile(ownerFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;console.log(JSON.stringify({present:false,warning:'An incomplete lock directory still requires inspection'}));process.exit(args.action==='status'?0:2);}
 if(args.action==='status'){console.log(JSON.stringify({present:true,...record}));}
 else{if(record.owner!==args.owner)throw new Error('Lease owner mismatch; refusing to release another scheduled round');await unlink(ownerFile);await rmdir(lock);console.log(JSON.stringify({released:true,owner:args.owner}));}
}
