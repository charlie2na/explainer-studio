import {readFile,writeFile,mkdir,readdir,rename,realpath} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {withProjectLock} from './lock.mjs';

export const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const videosRoot=path.join(root,'videos');
export const stages=['brief','script','storyboard','animation'];
export function safeId(id){if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(id))throw new Error('Invalid project ID');return id;}
export function projectDir(id){return path.join(videosRoot,safeId(id));}
export function safeRelative(value){if(typeof value!=='string'||!value||value.includes('\\')||value.split('/').some(s=>s==='..'||s.startsWith('.'))||path.isAbsolute(value))throw new Error('Invalid media path');return value;}
export async function mediaPath(id,relative){const base=await realpath(projectDir(id));const target=await realpath(path.join(base,safeRelative(relative)));if(!target.startsWith(base+path.sep))throw new Error('Media outside project');return target;}
export async function readProject(id){return JSON.parse(await readFile(path.join(projectDir(id),'project.json'),'utf8'));}
export async function listProjects(){await mkdir(videosRoot,{recursive:true});const entries=await readdir(videosRoot,{withFileTypes:true});const out=[];for(const entry of entries)if(entry.isDirectory()){try{out.push(await readProject(entry.name));}catch{}}return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export function validateProject(p){
  safeId(p.id);if(typeof p.title!=='string'||!p.title.trim()||p.title.length>180)throw new Error('Title must be 1–180 characters');
  if(!p.brief||!['landscape','portrait','square'].includes(p.brief.format))throw new Error('Choose landscape, portrait, or square');
  if(!Array.isArray(p.scenes)||p.scenes.length<1||p.scenes.length>100)throw new Error('Use between 1 and 100 scenes');
  const ids=new Set();let total=0;
  for(const s of p.scenes){safeId(s.id);if(ids.has(s.id))throw new Error('Scene IDs must be unique');ids.add(s.id);
    if(!Number.isFinite(s.duration)||s.duration<0.5||s.duration>300)throw new Error('Scene duration must be 0.5–300 seconds');total+=s.duration;
    if(!['title','image','steps','quote'].includes(s.layout))throw new Error('Unknown scene layout');
    for(const key of ['title','narration','visualPrompt'])if(typeof s[key]!=='string'||s[key].length>20000)throw new Error(`Invalid scene ${key}`);
    for(const key of ['asset','audio'])if(s[key])safeRelative(s[key]);
    if(!Array.isArray(s.items)||s.items.some(i=>typeof i!=='string'))throw new Error('Scene items must be text');
    if(!Array.isArray(s.words)||s.words.some(w=>typeof w.word!=='string'||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start))throw new Error('Invalid word timings');
  }if(total>1800)throw new Error('Maximum video duration is 30 minutes');
  if(p.music){if(typeof p.music==='string')safeRelative(p.music);else if(p.music.file){safeRelative(p.music.file);if(p.music.volume!==undefined&&(!Number.isFinite(p.music.volume)||p.music.volume<0||p.music.volume>1))throw new Error('Music volume must be between 0 and 1');}else throw new Error('Invalid music');}
  return p;
}
export function estimatedWords(text,duration){const words=text.trim().split(/\s+/).filter(Boolean);return words.map((word,i)=>({word,start:i*duration/words.length,end:(i+1)*duration/words.length}));}
export function newScene(index=1){return {id:`scene-${randomUUID().slice(0,8)}`,title:`Scene ${index}`,narration:'',duration:8,layout:'title',visualPrompt:'',items:[],asset:null,audio:null,words:[],timingSource:'estimated'};}
export async function createProject({title='Untitled film',brief={}}={}){
  const now=new Date().toISOString();const id=`${title.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,45).replace(/^-|-$/g,'')||'film'}-${randomUUID().slice(0,8)}`;
  const p={id,title,createdAt:now,updatedAt:now,revision:1,brief:{audience:'Curious beginners',takeaway:'',duration:60,format:'landscape',style:'Warm editorial illustration',tone:'Clear and conversational',...brief},voice:{provider:'demo',voiceId:'',model:'eleven_multilingual_v2'},scenes:[newScene()],reviews:Object.fromEntries(stages.map(s=>[s,null])),references:[],exports:[],contactSheets:[]};await writeProject(p);return p;
}
export async function writeProject(project,{lockToken}={}){validateProject(project);const dir=projectDir(project.id);return withProjectLock(dir,lockToken,async()=>{const tmp=path.join(dir,`project-${randomUUID()}.tmp`);await writeFile(tmp,JSON.stringify(project,null,2)+'\n');await rename(tmp,path.join(dir,'project.json'));await writeArtifacts(project);return project;});}
export async function saveProject(incoming,{expectedRevision,lockToken}={}){return withProjectLock(projectDir(incoming.id),lockToken,async token=>{
  const old=await readProject(incoming.id);if(expectedRevision!==undefined&&old.revision!==expectedRevision){const e=new Error('Project changed since you opened it. Reload before saving.');e.status=409;throw e;}
  const p=structuredClone(incoming);p.createdAt=old.createdAt;p.revision=old.revision+1;p.updatedAt=new Date().toISOString();p.exports=old.exports||[];p.contactSheets=old.contactSheets||[];p.reviews=Object.fromEntries(stages.map(s=>[s,null]));
  for(const scene of p.scenes){const before=old.scenes.find(s=>s.id===scene.id);if(!before||['narration','words','cuePhrases','audio','duration'].some(k=>JSON.stringify(before[k])!==JSON.stringify(scene[k]))||JSON.stringify(old.voice)!==JSON.stringify(p.voice))delete scene.cues;}
  for(const scene of p.scenes){const before=old.scenes.find(s=>s.id===scene.id);if(before&&(before.narration!==scene.narration||JSON.stringify(old.voice)!==JSON.stringify(p.voice))){scene.audio=null;scene.words=estimatedWords(scene.narration,scene.duration);scene.timingSource='estimated';delete scene.audioHash;delete scene.transcription;}else if(before&&before.duration!==scene.duration&&scene.timingSource==='estimated')scene.words=estimatedWords(scene.narration,scene.duration);}
  return writeProject(p,{lockToken:token});
});}
export async function markReview(id,stage,{lockToken}={}){if(!stages.includes(stage))throw new Error('Unknown review stage');return withProjectLock(projectDir(id),lockToken,async token=>{const p=await readProject(id);p.reviews[stage]={revision:p.revision,at:new Date().toISOString()};return writeProject(p,{lockToken:token});});}
async function writeArtifacts(p){const dir=projectDir(p.id);const brief=`# ${p.title}\n\n${Object.entries(p.brief).map(([k,v])=>`- **${k}:** ${v}`).join('\n')}\n`;const script=`# ${p.title} — narration\n\n${p.scenes.map(s=>`## ${s.id}: ${s.title}\n\n${s.narration}`).join('\n\n')}\n`;let t=0;const beats=p.scenes.map(s=>{const beat={id:s.id,start:t,end:t+s.duration,title:s.title,narration:s.narration,visualPrompt:s.visualPrompt,asset:s.asset,layout:s.layout,timingSource:s.timingSource,cuePhrases:s.cuePhrases||[],cues:s.cues||[]};t+=s.duration;return beat;});await Promise.all([writeFile(path.join(dir,'brief.md'),brief),writeFile(path.join(dir,'script.md'),script),writeFile(path.join(dir,'storyboard.json'),JSON.stringify(beats,null,2)+'\n')]);}
