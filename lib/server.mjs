import http from 'node:http';
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {root,projectDir,listProjects,readProject,createProject,saveProject,writeProject,markReview,mediaPath,stages,safeId} from './project.mjs';
import {acquireProjectLock} from './lock.mjs';

const types={'.ttf':'font/ttf','.woff2':'font/woff2','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aiff':'audio/aiff','.srt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'};
const jobs=new Map(),busy=new Set();
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>45*1024*1024){const e=new Error('Upload is too large. Maximum 30 MB file.');e.status=413;throw e;}chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new Error('Invalid JSON request');}}
async function serveFile(req,res,file){const info=await stat(file);if(!info.isFile())throw new Error('File not found');const mime=types[path.extname(file).toLowerCase()]||'application/octet-stream';const headers={'Content-Type':mime,'Accept-Ranges':'bytes','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m){res.writeHead(416);res.end();return;}const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),info.size-1):info.size-1;if(start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${info.size}`});createReadStream(file,{start,end}).pipe(res);}else{res.writeHead(200,{...headers,'Content-Length':info.size});createReadStream(file).pipe(res);}}
function ensureIdle(id){if(busy.has(id)){const e=new Error('This project has a running job. Wait for it to finish before editing.');e.status=409;throw e;}}
export async function runJob(id,args,baseUrl,onUpdate=()=>{}){
  safeId(id);ensureIdle(id);if(!['render','stills','speak','transcribe','cues'].includes(args.type))throw new Error('Unknown job type');
  const lock=await acquireProjectLock(projectDir(id));let project;
  try{project=await readProject(id);}catch(error){await lock.release();throw error;}
  const job={id:randomUUID(),projectId:id,status:'queued',progress:0,message:'Preparing…'};jobs.set(job.id,job);busy.add(id);
  const onProgress=(value,message)=>{if(typeof value==='object'){job.progress=value.progress??job.progress;job.message=value.message??job.message;}else{job.progress=Number.isFinite(value)?value:job.progress;if(message)job.message=message;}onUpdate(job);};
  (async()=>{try{job.status='running';onUpdate(job);let result;
    if(['render','stills'].includes(args.type)){
      const {renderProject}=await import('./render.mjs');const portrait=project.brief.format==='portrait',square=project.brief.format==='square';
      result=await renderProject({project,projectDir:projectDir(id),baseUrl,mode:args.type==='render'?'render':'stills',width:args.width??(portrait?720:1280),height:args.height??(portrait?1280:square?1280:720),fps:args.fps??30,onProgress});
      if(args.type==='render'){project.exports.push({...result,createdAt:new Date().toISOString(),revision:project.revision});await writeProject(project,{lockToken:lock.token});}
      else{project.contactSheets=[...(project.contactSheets||[]),{...result,createdAt:new Date().toISOString(),revision:project.revision}];await writeProject(project,{lockToken:lock.token});}
    }else if(args.type==='cues'){
      const {resolveCues}=await import('./cues.mjs');const next=resolveCues(project);next.revision++;next.updatedAt=new Date().toISOString();next.reviews=Object.fromEntries(stages.map(s=>[s,null]));await writeProject(next,{lockToken:lock.token});result={projectId:id};
    }else{
      const {speakProject,transcribeProject}=await import('./audio.mjs');const fn=args.type==='speak'?speakProject:transcribeProject;
      const next=await fn({project:structuredClone(project),projectDir:projectDir(id),sceneId:args.sceneId,provider:args.provider||project.voice.provider,force:args.force===true,onProgress});
      for(const scene of next.scenes)if(!args.sceneId||scene.id===args.sceneId)delete scene.cues;
      next.revision=project.revision+1;next.updatedAt=new Date().toISOString();next.reviews=Object.fromEntries(stages.map(s=>[s,null]));await writeProject(next,{lockToken:lock.token});result={projectId:id};
    }job.result=result;
  }catch(error){job.error=error.message;}finally{
    try{await lock.release();}catch(error){job.error=job.error||`Project lock release failed: ${error.message}`;}
    busy.delete(id);job.status=job.error?'error':'done';job.progress=job.error?job.progress:1;job.message=job.error?'Job failed':'Complete';onUpdate(job);
  }})();return job;
}
export function getJob(id){return jobs.get(id);}
export async function startServer({port=Number(process.env.PORT||4317),host='127.0.0.1'}={}){
  let baseUrl;
  const server=http.createServer(async(req,res)=>{try{
    const allowedHosts=new Set([`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`]);
    if(!allowedHosts.has(req.headers.host)){json(res,403,{error:'Localhost requests only'});return;}
    if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers.origin&&!allowedHosts.has(new URL(req.headers.origin).host)){json(res,403,{error:'Cross-origin writes are not allowed'});return;}
    const url=new URL(req.url,baseUrl);const pathname=decodeURIComponent(url.pathname);const parts=pathname.split('/').filter(Boolean);
    if(pathname==='/api/status'&&req.method==='GET'){const {audioStatus}=await import('./audio.mjs');json(res,200,{...await audioStatus(),imageGeneration:'codex'});return;}
    if(pathname==='/api/projects'){if(req.method==='GET')json(res,200,{projects:await listProjects()});else if(req.method==='POST')json(res,201,await createProject(await body(req)));else json(res,405,{error:'Method not allowed'});return;}
    if(parts[0]==='api'&&parts[1]==='jobs'&&req.method==='GET'){const job=getJob(parts[2]);json(res,job?200:404,job||{error:'Job not found'});return;}
    if(parts[0]==='api'&&parts[1]==='projects'&&parts[2]){
      const id=safeId(parts[2]);if(parts.length===3){if(req.method==='GET')json(res,200,await readProject(id));else if(req.method==='PUT'){ensureIdle(id);const input=await body(req);if(input.id!==id)throw new Error('Project ID cannot change');json(res,200,await saveProject(input,{expectedRevision:input.revision}));}else json(res,405,{error:'Method not allowed'});return;}
      if(req.method==='POST'&&parts[3]==='review'){ensureIdle(id);json(res,200,await markReview(id,(await body(req)).stage));return;}
      if(req.method==='POST'&&parts[3]==='jobs'){const job=await runJob(id,await body(req),baseUrl);json(res,202,job);return;}
      if(req.method==='POST'&&parts[3]==='upload'){
        ensureIdle(id);const input=await body(req);if(!['reference','asset','audio','music'].includes(input.kind))throw new Error('Unknown upload kind');
        const ext=path.extname(String(input.name)).toLowerCase();const images=['.png','.jpg','.jpeg','.webp'];const isAudio=input.kind==='audio'||input.kind==='music';if(!(isAudio?['.wav','.mp3','.m4a','.aiff']:images).includes(ext))throw new Error(isAudio?'Use WAV, MP3, M4A, or AIFF audio':'Use PNG, JPEG, or WebP images');
        if(typeof input.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))throw new Error('Invalid upload data');const bytes=Buffer.from(input.data,'base64');if(!bytes.length||bytes.length>30*1024*1024)throw new Error('File must be between 1 byte and 30 MB');
        if(!isAudio){const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpg=bytes[0]===255&&bytes[1]===216;const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!(ext==='.png'?png:ext==='.webp'?webp:jpg))throw new Error('Image contents do not match file type');}
        const lock=await acquireProjectLock(projectDir(id));let uploaded,saved;
        try{
          const p=await readProject(id);const scene=input.kind==='reference'||input.kind==='music'?null:p.scenes.find(s=>s.id===input.sceneId);if(!['reference','music'].includes(input.kind)&&!scene)throw new Error('Scene not found');
          const folder=isAudio?'audio':input.kind==='reference'?'references':'assets';const relative=`${folder}/${randomUUID()}${ext}`;await mkdir(path.join(projectDir(id),folder),{recursive:true});uploaded=path.join(projectDir(id),relative);await writeFile(uploaded,bytes);
          if(input.kind==='music'){const {inspectAudio}=await import('./audio.mjs');await inspectAudio(uploaded);p.music={file:relative,volume:0.12};}
          else if(scene){if(input.kind==='audio'){const {inspectAudio}=await import('./audio.mjs');scene.duration=await inspectAudio(uploaded);scene.audio=relative;scene.words=[];scene.timingSource='estimated';delete scene.audioHash;delete scene.transcription;}else scene.asset=relative;}else p.references.push({name:String(input.name).slice(0,180),file:relative});
          saved=await saveProject(p,{expectedRevision:p.revision,lockToken:lock.token});uploaded=undefined;
        }catch(error){if(uploaded)await rm(uploaded,{force:true});throw error;}
        finally{await lock.release();}
        json(res,200,saved);return;
      }
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){json(res,405,{error:'Method not allowed'});return;}
    if(parts[0]==='media'&&parts.length>=3){const rel=parts.slice(2).join('/');if(!['assets','references','audio','exports','stills'].includes(parts[2]))throw new Error('Media folder not available');await serveFile(req,res,await mediaPath(parts[1],rel));return;}
    const file=pathname==='/'?'index.html':pathname.slice(1);if(!['index.html','studio.js','style.css','renderer.js','render.html'].includes(file)){json(res,404,{error:'Not found'});return;}await serveFile(req,res,path.join(root,'public',file));
  }catch(error){if(!res.headersSent)json(res,error.status||(error.code==='ENOENT'?404:400),{error:error.message});else res.end();}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});baseUrl=`http://${host}:${server.address().port}`;return {server,baseUrl,close:()=>new Promise(resolve=>server.close(resolve))};
}
