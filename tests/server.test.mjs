import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {startServer} from '../lib/server.mjs';
import {projectDir} from '../lib/project.mjs';

test('HTTP studio saves revisions, blocks cross-origin writes and serves uploaded image bytes',async()=>{
 const app=await startServer({port:0});let id;
 const request=(route,data,method='POST',headers={})=>fetch(app.baseUrl+route,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
 try{
   const created=await request('/api/projects',{title:'HTTP regression',brief:{format:'portrait'}});assert.equal(created.status,201);const p=await created.json();id=p.id;
   const blocked=await request('/api/projects',{title:'Cross origin'},'POST',{origin:'https://example.com'});assert.equal(blocked.status,403);
   const saved=await request(`/api/projects/${id}`,{...p,title:'Updated title'},'PUT');assert.equal(saved.status,200);
   const stale=await request(`/api/projects/${id}`,p,'PUT');assert.equal(stale.status,409);
   const invalid=await request(`/api/projects/${id}/upload`,{name:'evil.html',data:Buffer.from('<script>alert(1)</script>').toString('base64'),kind:'asset',sceneId:p.scenes[0].id});assert.equal(invalid.status,400);
   const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6kAAAAASUVORK5CYII=';
   const upload=await request(`/api/projects/${id}/upload`,{name:'ref.png',data,kind:'reference'});assert.equal(upload.status,200);const uploaded=await upload.json();assert.equal(uploaded.references.length,1);
   const image=await fetch(`${app.baseUrl}/media/${id}/${uploaded.references[0].file}`);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal((await image.arrayBuffer()).byteLength,Buffer.from(data,'base64').length);
   const secrets=await fetch(`${app.baseUrl}/media/${id}/project.json`);assert.notEqual(secrets.status,200);
   const root=await fetch(app.baseUrl);assert.match(await root.text(),/Frame Studio/i);
 }finally{await app.close();if(id)await rm(projectDir(id),{recursive:true,force:true});}
});
