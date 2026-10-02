import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createProject,writeProject,projectDir} from '../lib/project.mjs';
import {startServer} from '../lib/server.mjs';
import {renderProject} from '../lib/render.mjs';
const exec=promisify(execFile);

test('Playwright frames become a correctly timed MP4 with delayed scene audio and captions', {timeout:120000}, async()=>{
 const p=await createProject({title:'Export verification'});const dir=projectDir(p.id);const app=await startServer({port:0});
 try{
   await mkdir(path.join(dir,'audio'),{recursive:true});await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.8','-y',path.join(dir,'audio','tone.wav')]);
   p.scenes=[{...p.scenes[0],id:'first',title:'First frame',duration:1,narration:'First sentence.',words:[{word:'First',start:0,end:.4},{word:'sentence.',start:.4,end:.9}]},{...p.scenes[0],id:'second',title:'Second frame',duration:1,audio:'audio/tone.wav',narration:'Second sentence.',words:[{word:'Second',start:0,end:.4},{word:'sentence.',start:.4,end:.9}]}];await writeProject(p);
   const result=await renderProject({project:p,projectDir:dir,baseUrl:app.baseUrl,width:640,height:360,fps:10});
   const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path.join(dir,result.file)])).stdout);const video=probe.streams.find(s=>s.codec_type==='video');assert.equal(video.width,640);assert.equal(video.height,360);assert.equal(video.nb_frames,'20');assert.ok(probe.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(probe.format.duration)-2)<.15);
   const srt=await readFile(path.join(dir,result.files.find(f=>f.endsWith('.srt'))),'utf8');assert.match(srt,/00:00:01,000 --> 00:00:01,900/);
   const early=await exec('ffmpeg',['-hide_banner','-i',path.join(dir,result.file),'-t','0.8','-af','volumedetect','-vn','-f','null','-']);const late=await exec('ffmpeg',['-hide_banner','-ss','1.1','-i',path.join(dir,result.file),'-t','0.5','-af','volumedetect','-vn','-f','null','-']);
   const volume=s=>Number(/mean_volume: ([-\d.]+) dB/.exec(s)?.[1]);assert.ok(volume(early.stderr)<-70,'First scene must be silent');assert.ok(volume(late.stderr)>-30,'Second scene audio must be audible after offset');
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
