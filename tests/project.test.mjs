import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createProject,saveProject,readProject,projectDir,markReview,validateProject,safeRelative,writeProject} from '../lib/project.mjs';

test('narration revision invalidates its audio and transcript, visual edit preserves audio',async()=>{
 const p=await createProject({title:'Dependency regression test'});
 try{
   p.scenes[0].narration='The original line.';p.scenes[0].audio='audio/test.mp3';p.scenes[0].timingSource='whisper';p.scenes[0].words=[{word:'The',start:0,end:1}];p.scenes[0].transcription={text:'The original line.'};await writeProject(p);
   const reviewed=await markReview(p.id,'script');assert.equal(reviewed.reviews.script.revision,1);
   const visual=structuredClone(reviewed);visual.scenes[0].title='A better title';const saved=await saveProject(visual,{expectedRevision:1});assert.equal(saved.scenes[0].audio,'audio/test.mp3');assert.equal(saved.reviews.script,null);
   const revised=structuredClone(saved);revised.scenes[0].narration='A different line.';const final=await saveProject(revised,{expectedRevision:2});assert.equal(final.scenes[0].audio,null);assert.equal(final.scenes[0].transcription,undefined);assert.equal(final.scenes[0].timingSource,'estimated');assert.match(await readFile(path.join(projectDir(p.id),'script.md'),'utf8'),/A different line/);
   await assert.rejects(saveProject(saved,{expectedRevision:2}),/changed since/);
 }finally{await rm(projectDir(p.id),{recursive:true,force:true});}
});
test('unsafe paths, duplicate scene IDs, and invalid duration are rejected',async()=>{
 for(const name of ['../key','/etc/passwd','assets/../../key','assets/.env','assets\\key'])assert.throws(()=>safeRelative(name));
 const p=await createProject({title:'Validation regression test'});try{p.scenes[0].duration=-1;assert.throws(()=>validateProject(p),/duration/);p.scenes[0].duration=5;p.scenes.push(structuredClone(p.scenes[0]));assert.throws(()=>validateProject(p),/unique/);}finally{await rm(projectDir(p.id),{recursive:true,force:true});}
});
