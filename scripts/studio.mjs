#!/usr/bin/env node
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {root,readProject,listProjects,createProject,projectDir,saveProject,writeProject,markReview} from '../lib/project.mjs';
// Load a local .env without exporting it to the browser or logging secrets.
try{for(const line of (await readFile(path.join(root,'.env'),'utf8')).split('\n')){const match=/^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());if(match&&!process.env[match[1]])process.env[match[1]]=match[2].replace(/^['"]|['"]$/g,'');}}catch{}
if(!process.env.WHISPER_PYTHON){try{const python=path.join(root,'.venv','bin','python');await access(python);process.env.WHISPER_PYTHON=python;}catch{}}
const [command='serve',id,...rest]=process.argv.slice(2);const arg=name=>{const i=rest.indexOf(`--${name}`);return i<0?undefined:rest[i+1];};
try{
  if(command==='serve'){const {startServer}=await import('../lib/server.mjs');const app=await startServer();console.log(`Frame Studio · ${app.baseUrl}\nOpen this address to review your films. Press Ctrl+C to stop.`);}
  else if(command==='doctor'){
    const {audioStatus}=await import('../lib/audio.mjs');
    const status=await audioStatus();
    const {chromium}=await import('playwright');let browser;
    try{browser=await chromium.launch({headless:true});status.browser=true;}
    catch{status.browser=false;}
    finally{await browser?.close();}
    status.node=Number(process.versions.node.split('.')[0])>=22;
    console.log(JSON.stringify({...status,imageGeneration:'Use Codex image_gen, then import with asset command',projectRoot:root},null,2));
    if(!status.node)console.error('Install Node.js 22 or later, then run npm ci.');
    if(!status.ffmpeg)console.error('Install FFmpeg and ffprobe: brew install ffmpeg (macOS), or sudo apt-get install ffmpeg (Ubuntu/Debian).');
    if(!status.browser)console.error('Install Chromium: npx playwright install chromium. On Linux, also run npx playwright install --with-deps chromium.');
    if(!status.whisper)console.log('Optional: Whisper is unavailable. Existing sample timings and ElevenLabs timestamps still work.');
    if(!status.demoVoice)console.log('Optional: macOS demo voice is unavailable. Use sample narration, upload audio, or configure ElevenLabs.');
    if(!status.elevenlabs)console.log('Optional: ElevenLabs is not configured. No API key is needed to preview or export the sample.');
    if(!status.node||!status.ffmpeg||!status.browser)process.exitCode=1;
  }
  else if(command==='list'){console.log((await listProjects()).map(p=>`${p.id}\t${p.title}\t${p.scenes.length} scenes`).join('\n'));}
  else if(command==='create'){const p=await createProject({title:id||'Untitled film'});console.log(JSON.stringify(p,null,2));}
  else if(command==='show'){console.log(JSON.stringify(await readProject(id),null,2));}
  else if(command==='save'){const file=rest[0];if(!file)throw new Error('Usage: studio save <id> <edited-json-file>');const p=JSON.parse(await readFile(file,'utf8'));if(p.id!==id)throw new Error('Project ID mismatch');console.log(JSON.stringify(await saveProject(p,{expectedRevision:p.revision}),null,2));}
  else if(command==='review'){console.log(JSON.stringify(await markReview(id,rest[0]),null,2));}
  else if(command==='asset'){const sceneId=rest[0],source=rest[1];if(!source)throw new Error('Usage: studio asset <id> <scene-id> <image-path>');const p=await readProject(id),s=p.scenes.find(s=>s.id===sceneId);if(!s)throw new Error('Scene not found');const ext=path.extname(source).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(ext))throw new Error('Use PNG, JPEG, or WebP');await mkdir(path.join(projectDir(id),'assets'),{recursive:true});s.asset=`assets/${sceneId}-${randomUUID()}${ext}`;await writeFile(path.join(projectDir(id),s.asset),await readFile(source));console.log(JSON.stringify(await saveProject(p,{expectedRevision:p.revision}),null,2));}
  else if(command==='reference'){const source=rest[0];if(!source)throw new Error('Usage: studio reference <id> <image-path>');const p=await readProject(id);const ext=path.extname(source).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(ext))throw new Error('Use PNG, JPEG, or WebP');const relative=`references/ref-${randomUUID()}${ext}`;await mkdir(path.join(projectDir(id),'references'),{recursive:true});await writeFile(path.join(projectDir(id),relative),await readFile(source));p.references.push({name:path.basename(source),file:relative});console.log(JSON.stringify(await saveProject(p,{expectedRevision:p.revision}),null,2));}
  else if(['speak','transcribe','cues','stills','render'].includes(command)){const {startServer,runJob}=await import('../lib/server.mjs');const app=await startServer({port:0});try{const job=await runJob(id,{type:command,sceneId:arg('scene'),provider:arg('provider'),force:rest.includes('--force'),width:arg('width')?Number(arg('width')):undefined,height:arg('height')?Number(arg('height')):undefined,fps:arg('fps')?Number(arg('fps')):undefined},app.baseUrl);while(['queued','running'].includes(job.status))await new Promise(r=>setTimeout(r,250));if(job.status==='error')throw new Error(job.error);console.log(JSON.stringify(job.result,null,2));}finally{await app.close();}}
  else {console.log('Commands: serve, doctor, list, create "Title", show <id>, save <id> <json>, review <id> <stage>, asset <id> <scene> <file>, speak <id> [--provider demo|elevenlabs] [--scene id], transcribe <id>, stills <id>, render <id> [--width 1280 --height 720 --fps 30]');process.exitCode=1;}
}catch(error){console.error(error.message);process.exitCode=1;}
