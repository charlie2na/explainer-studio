// Frame Studio's single source of truth for preview and exported frames.
// Every visual property is a function of the requested absolute time.
const NS = 'http://www.w3.org/2000/svg';
const imageSizes = new Map();
const fontLoads = new Map();
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const ease = n => 1 - Math.pow(1 - clamp(n), 3);
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const safeId = value => encodeURIComponent(String(value || ''));

export function mediaUrl(project, path) {
  if (!path) return '';
  return `/media/${safeId(project.id)}/${String(path).split('/').map(safeId).join('/')}`;
}

export function sceneAt(project, time) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  let start = 0;
  for (let i = 0; i < scenes.length; i++) {
    const duration = Math.max(0.01, number(scenes[i].duration, 1));
    if (time < start + duration || i === scenes.length - 1) {
      return { scene: scenes[i], index: i, start, duration, local: clamp(time - start, 0, duration) };
    }
    start += duration;
  }
  return { scene: null, index: -1, start: 0, duration: 0, local: 0 };
}

export function projectDuration(project) {
  return (project?.scenes || []).reduce((sum, scene) => sum + Math.max(0.01, number(scene.duration, 1)), 0);
}

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  parent?.appendChild(node);
  return node;
}

function txt(parent, content, x, y, size, color, extra = {}) {
  const node = el('text', { x, y, fill: color, 'font-size': size, 'font-family': extra.serif ? 'Georgia, Times New Roman, serif' : 'Arial, Helvetica, sans-serif', 'font-weight': extra.weight || 400, 'letter-spacing': extra.tracking ?? 0, ...extra.attrs }, parent);
  node.textContent = String(content ?? '');
  return node;
}

function lines(content, maxChars, maxLines = 5) {
  const words = String(content || '').trim().split(/\s+/).filter(Boolean);
  const result = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxChars) { result.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) result.push(line);
  if (result.length > maxLines) {
    const cut = result.slice(0, maxLines);
    cut[maxLines - 1] += '…';
    return cut;
  }
  return result;
}

function multiline(parent, content, x, y, size, color, widthChars, lineHeight, options = {}) {
  const wrapped = lines(content, widthChars, options.maxLines || 5);
  wrapped.forEach((line, i) => txt(parent, line, x, y + i * lineHeight, size, color, options));
  return wrapped.length;
}

function rect(parent, x, y, w, h, fill, extra = {}) { return el('rect', { x, y, width: w, height: h, fill, ...extra }, parent); }

function image(parent, project, path, x, y, w, h, clipId, progress, opacity = 1) {
  if (!path) return false;
  const url = mediaUrl(project, path);
  const size = imageSizes.get(url);
  let ix = x, iy = y, iw = w, ih = h;
  const zoom = 1.045 + .075 * clamp(progress);
  if (size) {
    const scale = Math.max(w / size.width, h / size.height) * zoom;
    iw = size.width * scale; ih = size.height * scale;
    ix = x + (w - iw) / 2 - w * .018 * (clamp(progress) - .5);
    iy = y + (h - ih) / 2 - h * .012 * (clamp(progress) - .5);
  }
  el('image', { href: url, x: ix, y: iy, width: iw, height: ih, opacity, 'clip-path': `url(#${clipId})`, preserveAspectRatio: 'xMidYMid slice' }, parent);
  return true;
}

function captionText(scene, local) {
  const words = Array.isArray(scene.words) ? scene.words : [];
  if (words.length) {
    const current = words.findIndex(w => local >= number(w.start, 0) && local < number(w.end, 0));
    if (current < 0) return '';
    const first = Math.floor(current / 7) * 7;
    return words.slice(first, Math.min(words.length, first + 7)).map(w => w.word).join(' ');
  }
  const text = String(scene.narration || '').trim();
  if (!text) return '';
  const chunks = text.match(/[^.!?]+[.!?]?/g) || [text];
  const n = Math.min(chunks.length - 1, Math.floor(local / Math.max(0.01, number(scene.duration, 1)) * chunks.length));
  return chunks[n]?.trim() || '';
}

export async function preloadProject(project) {
  const paths = [...new Set([...(project?.scenes || []).map(scene => scene.asset), project?.brand?.logo].filter(Boolean))];
  await Promise.all(paths.map(path => new Promise((resolve, reject) => {
    const url = mediaUrl(project, path);
    const img = new Image();
    img.onload = () => { imageSizes.set(url, { width: img.naturalWidth, height: img.naturalHeight }); resolve(); };
    img.onerror = () => reject(new Error(`Artwork could not be loaded: ${path}`));
    img.src = url;
    if (img.complete && img.naturalWidth) { imageSizes.set(url, { width: img.naturalWidth, height: img.naturalHeight }); resolve(); }
  })));
  await Promise.all((project?.brand?.fonts || []).map(spec => {
    const url = mediaUrl(project, spec.path);
    if (!fontLoads.has(url)) {
      const face = new FontFace(spec.family, `url("${url}")`, { style: spec.style, weight: spec.weight });
      fontLoads.set(url, face.load().then(loaded => document.fonts.add(loaded)).catch(error => { fontLoads.delete(url); throw error; }));
    }
    return fontLoads.get(url);
  }));
  await prepareSoqMotion(project);
  if (document.fonts?.ready) await document.fonts.ready;
}

export function mountScene(container, project, time, { width = 1280, height = 720, captions = true } = {}) {
  captions = captions && project?.brief?.captions !== false;
  if (project?.brief?.renderer === 'soqratic-credits') return mountSoqratic(container, project, time, width, height, captions);
  const W = Math.max(1, number(width, 1280));
  const H = Math.max(1, number(height, 720));
  const portrait = H > W;
  const sceneInfo = sceneAt(project, number(time, 0));
  const { scene, index, local, duration } = sceneInfo;
  const svg = el('svg', { xmlns: NS, viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': scene?.title || project?.title || 'Frame' });
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.background = '#f5f0e6';
  const defs = el('defs', {}, svg);
  const clip = el('clipPath', { id: 'art-clip' }, defs);
  const ink = '#202b29', muted = '#65716c', paper = '#f5f0e6', accent = '#d86948', pale = '#dfdfce';
  rect(svg, 0, 0, W, H, paper);
  const margin = Math.round(Math.min(W, H) * (portrait ? 0.058 : 0.066));
  const top = margin * 1.15;
  const progress = duration ? clamp(local / duration) : 0;
  // Persistent quiet editorial furniture and a deterministic moving progress line.
  rect(svg, margin, top + 24, W - 2 * margin, 1, '#c6c8b8');
  rect(svg, margin, top + 24, (W - 2 * margin) * progress, 2, accent);
  txt(svg, String(project?.brief?.series || project?.title || '').toUpperCase().slice(0, 38), margin, top + 4, portrait ? 15 : 16, ink, { weight: 700, tracking: 2.2 });
  txt(svg, String(index + 1).padStart(2, '0') + ' / ' + String((project?.scenes || []).length).padStart(2, '0'), W - margin, top + 4, 15, muted, { attrs: { 'text-anchor': 'end' }, tracking: 1.5 });
  const entry = ease(local / Math.min(1.0, duration * .22));
  const title = String(scene?.title || project?.title || 'Untitled story');
  const layout = scene?.layout || 'title';
  const bodyTop = top + (portrait ? 88 : 91);
  const bottom = H - margin * (captions ? 2.05 : 1.15);
  const available = bottom - bodyTop;
  const artPath = scene?.asset;
  const group = el('g', { transform: `translate(0 ${(1-entry)*12})` }, svg);

  if (layout === 'image') {
    const imgX = portrait ? margin : W * .515;
    const imgY = portrait ? bodyTop + available * .40 : bodyTop;
    const imgW = portrait ? W - margin * 2 : W * .485 - margin;
    const imgH = portrait ? available * .57 : available;
    rect(clip, imgX, imgY, imgW, imgH, '#fff');
    rect(group, imgX, imgY, imgW, imgH, pale);
    if (!image(group, project, artPath, imgX, imgY, imgW, imgH, 'art-clip', progress)) {
      el('circle', { cx: imgX + imgW * .54, cy: imgY + imgH * .51, r: Math.min(imgW, imgH) * .28, fill: accent, opacity: .82 }, group);
      el('circle', { cx: imgX + imgW * .66, cy: imgY + imgH * .35, r: Math.min(imgW, imgH) * .14, fill: '#f0b980' }, group);
    }
    rect(group, imgX - 7 + progress * 25, imgY + imgH * .81, 72, 7, accent);
    const titleSize = portrait ? Math.min(66, W * .075) : Math.min(70, W * .052);
    multiline(group, title, margin, bodyTop + titleSize, titleSize, ink, portrait ? 23 : 16, titleSize * 1.08, { serif: true, maxLines: 4, attrs: { 'data-role': 'scene-title' } });
    if (scene?.subtitle) txt(group, String(scene.subtitle).slice(0, portrait ? 42 : 35).toUpperCase(), margin, portrait ? bodyTop + available * .33 : bottom - 40, 13, muted, { tracking: 1.6 });
  } else if (layout === 'steps') {
    const titleSize = portrait ? Math.min(62, W * .074) : Math.min(66, W * .051);
    multiline(group, title, margin, bodyTop + titleSize, titleSize, ink, portrait ? 22 : 34, titleSize * 1.07, { serif: true, maxLines: 3, attrs: { 'data-role': 'scene-title' } });
    const narrationBeats = String(scene?.narration || '').match(/[^.!?]+[.!?]?/g)?.map(s => s.trim()).filter(Boolean) || [];
    const items = (Array.isArray(scene?.items) && scene.items.length ? scene.items : narrationBeats).slice(0, 4);
    const listTop = bodyTop + (portrait ? available * .31 : available * .34);
    const gap = Math.min(portrait ? 136 : 112, (bottom - listTop) / items.length);
    items.forEach((item, i) => {
      const cueStart = Number(scene?.cues?.[i]?.start);
      const revealAt = Number.isFinite(cueStart) ? cueStart : .35 + i * Math.min(.9, duration / (items.length + 1));
      const show = ease((local - revealAt) / .45);
      const y = listTop + i * gap;
      rect(group, margin, y - 25, W - 2 * margin, 1, '#d2d2c3');
      el('circle', { cx: margin + 19, cy: y + 14, r: 18, fill: show ? accent : '#d7d8c9' }, group);
      txt(group, String(i + 1), margin + 19, y + 19, 16, '#fff', { weight: 700, attrs: { 'text-anchor': 'middle' } });
      multiline(group, String(item), margin + 57, y + 16, portrait ? Math.min(26, W * .035) : 28, ink, portrait ? 32 : 66, 34, { weight: 500, maxLines: 2, attrs: { opacity: .35 + show * .65 } });
    });
  } else if (layout === 'quote') {
    const markSize = portrait ? 142 : 182;
    txt(group, '“', margin - 4, bodyTop + markSize * .75, markSize, accent, { serif: true });
    const quote = title || scene?.narration;
    const size = portrait ? Math.min(59, W * .073) : Math.min(78, W * .059);
    multiline(group, quote, margin + (portrait ? 7 : 62), bodyTop + markSize * .85, size, ink, portrait ? 22 : 29, size * 1.13, { serif: true, maxLines: portrait ? 7 : 5, attrs: { 'data-role': 'scene-title' } });
    rect(group, margin + progress * (W - margin * 2 - 78), bottom - 20, 78, 5, accent);
  } else {
    // Title cards are intentionally generous, with a rising index disc and fine line.
    const discR = Math.min(W, H) * (portrait ? .21 : .22);
    el('circle', { cx: W - margin - discR * .44, cy: bodyTop + discR * .55 + (1 - entry) * 35, r: discR, fill: accent }, group);
    el('circle', { cx: W - margin - discR * .44, cy: bodyTop + discR * .55, r: discR * .63, fill: '#e9a87c' }, group);
    txt(group, String(index + 1).padStart(2, '0'), W - margin - discR * .44, bodyTop + discR * .80, Math.round(discR * .43), paper, { serif: true, attrs: { 'text-anchor': 'middle' } });
    const size = portrait ? Math.min(78, W * .089) : Math.min(94, W * .073);
    multiline(group, title, margin, bodyTop + available * (portrait ? .46 : .54), size, ink, portrait ? 19 : 26, size * 1.05, { serif: true, maxLines: 4, attrs: { 'data-role': 'scene-title' } });
    rect(group, margin, bottom - 11, (W - 2 * margin) * (.18 + progress * .12), 5, accent);
  }

  if (captions && scene) {
    const caption = captionText(scene, local);
    if (caption) {
      const bandY = H - margin * 1.52;
      rect(svg, 0, bandY - 22, W, H - bandY + 22, ink);
      const captionSize = portrait ? Math.min(29, W * .04) : 25;
      multiline(svg, caption, W / 2, bandY + captionSize * .7, captionSize, '#f7f2e9', portrait ? 41 : 83, captionSize * 1.24, { maxLines: 2, attrs: { 'text-anchor': 'middle', 'data-role': 'caption' } });
    }
  }
  container.replaceChildren(svg);
  return svg;
}

// Brand film: layered mascot artwork and speech-anchored vector motion.
function mountSoqratic(container, project, time, width, height, captions) {
  const {scene,index,local}=sceneAt(project,time);
  const branded=project.brand?.typography==='soqratic-website';
  const ink=branded?'#0a0a0a':'#252823',green='#45663d',muted=branded?'#525252':'#737b6e';
  const paper=branded?'#fdfbf6':'#ffffff', panel=branded?'#f0ede7':'#eef3e9';
  const svg=el('svg',{xmlns:NS,viewBox:'0 0 1280 720',width,height,role:'img','aria-label':scene.title});
  svg.style.cssText='display:block;width:100%;height:100%;background:white';
  rect(svg,0,0,1280,720,paper);
  const reveal=(at=0)=>ease((local-at)/.65);
  const cue=(n,fallback=0)=>scene.cues?.[n]?.start??fallback;
  const group=(at=0)=>el('g',{opacity:reveal(at),transform:`translate(0 ${(1-reveal(at))*18})`},svg);
  const text=(p,t,x,y,s=34,c=ink,w=600)=>{
    const headline=s>=31, emphasis=c===green && headline && !/^\d+$/.test(t);
    return txt(p,t,x,y,s,branded&&c===green?ink:c,{weight:branded&&headline?400:w,attrs:branded?{
      'font-family':headline?'Fraunces':'DM Sans',
      'font-style':emphasis?'italic':'normal'
    }:{}});
  };
  const bubble=(p,t,x,y,w,at=0)=>{const g=el('g',{opacity:reveal(at),transform:`translate(0 ${Math.sin(local*1.2+x)*3})`},p);rect(g,x,y,w,64,panel,{rx:22});text(g,t,x+23,y+40,23,green,500);el('path',{d:`M${x+26} ${y+62} l0 12 l18 -12`,fill:panel},g);};
  const owl=(x=770,y=157,size=440)=>{if(project.brand?.continuousMotion){const persistent=el('g',{},svg);if(drawTalkingSoq(persistent,project,scene,local,time))return;}const g=group(.08);if(drawTalkingSoq(g,project,scene,local,time))return;el('ellipse',{cx:x+size*.5,cy:y+size*.94,rx:size*.24,ry:12,fill:'#ebede7'},g);el('image',{href:mediaUrl(project,scene.asset),x,y:y+Math.sin(local*1.15)*4,width:size,height:size,preserveAspectRatio:'xMidYMid meet'},g);};
  el('image',{href:mediaUrl(project,project.brand.logo),x:55,y:22,width:190,height:85,style:branded?'mix-blend-mode:multiply':undefined},svg);
  text(svg,'CONTACT CREDITS',995,73,15,muted,600);
  const g=group(.05);
  const beat=scene.beat || ['intro','email','lead','plan','legacyclose'][index];
  if(beat==='monthly'){
    text(g,'Every plan.',76,225,61);text(g,'Monthly credits.',76,297,61,green);
    const a=group(cue(1,5));text(a,'For the moments',80,429,42);text(a,'that matter.',80,486,48,green);owl();
  }else if(beat==='windowclose'){
    text(g,'Window shopping',76,236,53);text(g,'is welcome.',76,300,59,green);
    const a=group(cue(1,2));text(a,'You pay when',80,436,44);text(a,'someone comes in.',80,496,48,green);owl();
  }else if(beat==='hook'){
    text(g,'A conversation is nice.',76,210,43);
    const a=group(cue(1,2));text(a,'A new reader is better.',76,303,43,green);
    const b=group(cue(2,5));text(b,'A business opportunity?',76,408,42);text(b,'That’s the point.',76,466,46,green);owl();
  }else if(beat==='outcomes'){
    const a=group(cue(0,.5));text(a,'Not chatter.',76,281,67);
    const b=group(cue(1,2));text(b,'Outcomes.',76,379,76,green);owl();
  }else if(beat==='free'){
    text(g,'Let them talk.',76,215,61,green);text(g,'About anything in your book.',79,273,29,muted,400);
    bubble(svg,'Philosophers',80,321,230,cue(0,2));bubble(svg,'Insomniacs',346,403,225,cue(1,3));bubble(svg,'Chapter-three skimmers',80,485,345,cue(2,4));
    const a=group(cue(3,6));text(a,'Chatting uses no credits.',80,604,31,green);owl();
  }else if(beat==='turns'){
    text(g,'When a conversation',76,247,48);text(g,'becomes something.',76,308,48,green);
    bubble(svg,'A new contact',80,406,250,cue(0,1));bubble(svg,'A business lead',339,494,266,cue(0,1)+.35);owl();
  }else if(beat==='popular'){
    text(g,'Rather popular?',76,210,57,green);
    bubble(svg,'Readers queuing up',80,295,320,cue(0,1));bubble(svg,'An inbox full of interest',210,396,350,cue(1,3));bubble(svg,'Speaking enquiries',80,497,310,cue(2,5));owl();
  }else if(beat==='bigger'){
    text(g,'Room to grow.',76,247,62,green);
    const a=group(cue(0,.5));text(a,'Bigger plans.',80,350,41);
    const b=group(cue(1,1));text(b,'More credits.',80,411,41);
    const d=group(cue(2,4));bubble(d,'Explore the plans',80,486,292);owl();
  }else if(beat==='close'){
    text(g,'Your book,',76,236,61);text(g,'doing its job.',76,307,61,green);
    const a=group(cue(1,5));text(a,'No email. No business inquiry.',80,437,31);text(a,'No credits used.',80,499,43,green);owl();
  }else if(beat==='intro'){
    text(g,'Your expertise.',76,247,61);text(g,'More possibilities.',76,318,61,green);
    text(g,'Each plan includes monthly credits',79,375,27,muted,400);
    bubble(svg,'A reader has a question…',90,447,355,.6);
    bubble(svg,'Your persona can help.',245,530,310,1.8);
    owl(772,145,430);
  }else if(beat==='email'){
    text(g,'A conversation.',76,196,49);text(g,'A new contact.',76,252,49,green);
    const env=group(cue(0,.5));rect(env,82,308,286,149,branded?panel:'#f0f3eb',{rx:17});
    rect(env,115,330,220,104,'white',{rx:9});el('path',{d:'M117 336 L225 398 L333 336',fill:'none',stroke:branded?ink:green,'stroke-width':3},env);
    text(env,'Emailed summary',84,497,25,muted,400);
    const num=group(cue(1,4));text(num,'1',457,437,157,green);text(num,'credit',464,492,29,green);
    owl(793,181,386);
  }else if(beat==='lead'){
    text(g,'An inquiry.',76,190,48);text(g,'A business opportunity.',76,248,48,green);
    bubble(svg,'Work together?',78,287,244,cue(0,.4));bubble(svg,'Speaking inquiry?',355,287,283,cue(1,2));
    const num=group(cue(2,7));text(num,'10',78,524,150,green);text(num,'credits total',270,464,34,green);text(num,'per conversation',272,508,27,muted,400);
    owl(795,172,400);
  }else if(beat==='plan'){
    text(g,'The basic plan',76,170,37);const num=group(cue(0,.5));text(num,'20',75,330,164,green);text(num,'credits',301,267,47,green);text(num,'fresh each month',303,314,25,muted,400);
    const a=group(cue(1,3));text(a,'20',80,463,66,green);text(a,'email contacts',80,505,26,ink,400);
    const b=group(cue(2,5));text(b,'OR',328,455,19,muted);text(b,'2',404,463,66,green);text(b,'business leads',404,505,26,ink,400);
    const c=group(cue(3,7));text(c,'or a mix of both',80,574,27,muted,400);owl(795,182,391);
  }else{
    text(g,'Put your expertise',76,235,55);text(g,'to work.',76,300,55,green);
    const a=group(cue(0,1));text(a,'Grow your audience',81,407,34,green);
    const b=group(cue(1,3));text(b,'Create business opportunities',81,463,31,green);
    owl(763,137,470);
  }
  if(captions){const cap=captionText(scene,local);if(cap){rect(svg,54,642,1172,51,'#f2f4ee',{rx:12});txt(svg,cap,640,675,23,ink,{attrs:{'text-anchor':'middle','data-role':'caption'}});}}
  container.replaceChildren(svg);return svg;
}

const soqMotionCache = new Map();
async function prepareSoqMotion(project) {
  const file=project?.brand?.motion;if(!file)return;
  const response=await fetch(mediaUrl(project,file));if(!response.ok)throw Error('Soq motion data is unavailable');
  const data=await response.json(),folder=file.slice(0,file.lastIndexOf('/')+1),frames=[];
  // Decode small frames in batches so the browser does not allocate 168 full-size surfaces at once.
  for(let start=0;start<data.frames;start+=12)await Promise.all(Array.from({length:Math.min(12,data.frames-start)},async(_,j)=>{
    const index=start+j,url=mediaUrl(project,folder+String(index+1).padStart(4,'0')+'.webp');
    const r=await fetch(url);if(!r.ok)throw Error('Missing Soq motion frame');frames[index]=await createImageBitmap(await r.blob());
  }));
  const ref=document.createElement('canvas');ref.width=ref.height=960;ref.getContext('2d').drawImage(frames[0],0,0,960,960);
  const patch=document.createElement('canvas');patch.width=100;patch.height=85;const pc=patch.getContext('2d');pc.drawImage(ref,434,394,100,85,0,0,100,85);pc.globalCompositeOperation='destination-in';const mask=pc.createRadialGradient(50,28,19,50,28,49);mask.addColorStop(0,'white');mask.addColorStop(1,'transparent');pc.fillStyle=mask;pc.fillRect(0,0,100,85);
  const previous=soqMotionCache.get(project.id);previous?.frames.forEach(f=>f.close());soqMotionCache.set(project.id,{data,frames,patch});
}
function drawTalkingSoq(parent,project,scene,local,absoluteTime=0) {
  const motion=soqMotionCache.get(project.id);if(!motion)return false;
  const plan=motion.data.scenes[scene.id];if(!plan||plan.audio!==scene.audio)throw Error('Soq mouth timing must be rebuilt for this narration');
  // Retiming places the broad wing gesture at the important spoken phrase.
  const start=plan.gestureAt-4.5;
  const phase=((absoluteTime % 13.9)+13.9)%13.9;
  const sourceTime=project.brand?.continuousMotion ? (phase<=6.95?phase:13.9-phase) : (local<start?2.1+.3*Math.sin(local*1.3):Math.min(6.95,Math.max(0,local-start)));
  const frame=Math.min(167,Math.floor(sourceTime*24));
  const open=plan.opening[Math.min(plan.opening.length-1,Math.round(local*30))]||0;
  const foreign=el('foreignObject',{x:704,y:76,width:560,height:560},parent);
  const canvas=document.createElement('canvas');canvas.dataset.sourceFrame=String(frame);canvas.width=canvas.height=640;canvas.style.cssText='width:100%;height:100%;border-radius:24px;display:block';foreign.appendChild(canvas);
  const ctx=canvas.getContext('2d');ctx.scale(2/3,2/3);
  const choreography=motion.data.choreography;
  if(choreography){
    const cycle=choreography.idleLength*2;
    const phase=(absoluteTime*choreography.idleSpeed)%cycle;
    const idle=choreography.idleStart+(phase<=cycle/2?phase:cycle-phase);
    const baseFrame=Math.min(167,Math.floor(idle*24));
    paintSoqFrame(ctx,motion,baseFrame,open);
    const event=choreography.events.find(e=>absoluteTime>=e.start&&absoluteTime<e.end);
    canvas.dataset.gesture=event?.label||'Quiet listening';
    canvas.dataset.sourceFrame=String(baseFrame);
    if(event){
      const elapsed=absoluteTime-event.start;
      const fade=Math.min(event.fade,.16);
      const atStart=event.start===0?1:ease(elapsed/fade);
      const atEnd=event.end>=projectDuration(project)-.02?1:ease((event.end-absoluteTime)/fade);
      const blend=Math.min(atStart,atEnd);
      const gestureFrame=event.offset+Math.min(167,Math.floor((event.source+elapsed*event.speed)*24));
      motion.layer??=document.createElement('canvas');motion.layer.width=motion.layer.height=640;
      const layer=motion.layer.getContext('2d');layer.scale(2/3,2/3);
      const [bx,by]=motion.data.tracks[baseFrame], [gx,gy]=motion.data.tracks[gestureFrame];
      // Align the beak during the brief dissolve to avoid two separated faces.
      if(blend<1){
        ctx.save();ctx.translate((gx-bx)*blend,(gy-by)*blend);paintSoqFrame(ctx,motion,baseFrame,open);ctx.restore();
      }
      layer.translate((bx-gx)*(1-blend),(by-gy)*(1-blend));
      paintSoqFrame(layer,motion,gestureFrame,open);
      ctx.globalAlpha=blend;ctx.drawImage(motion.layer,0,0,960,960);ctx.globalAlpha=1;
    }
  }else paintSoqFrame(ctx,motion,frame,open);
  return true;
}
function paintSoqFrame(ctx,motion,frame,open){
  ctx.drawImage(motion.frames[frame],0,0,960,960);
  const [x,y]=motion.data.tracks[frame];ctx.save();ctx.translate(x,y);ctx.drawImage(motion.patch,-50,5);
  if(open>.025){const h=2+open*22;
    const g=ctx.createLinearGradient(-22,12,17,30+h);g.addColorStop(0,'#282726');g.addColorStop(.38,'#625a51');g.addColorStop(.7,'#48413b');g.addColorStop(1,'#272724');ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(-24,12);ctx.quadraticCurveTo(0,31,24,12);ctx.quadraticCurveTo(19,24+h,0,26+h);ctx.quadraticCurveTo(-18,23+h,-24,12);ctx.fill();
    ctx.save();ctx.beginPath();ctx.moveTo(-21,13);ctx.quadraticCurveTo(0,31,21,13);ctx.quadraticCurveTo(15,20+h,0,22+h);ctx.quadraticCurveTo(-14,20+h,-21,13);ctx.clip();const inside=ctx.createRadialGradient(0,25+h,1,0,20,30);inside.addColorStop(0,'#462623');inside.addColorStop(.55,'#211514');inside.addColorStop(1,'#0e0d0c');ctx.fillStyle=inside;ctx.fillRect(-30,10,60,60);
    const tongue=ctx.createRadialGradient(-3,18+h,1,0,20+h,13);tongue.addColorStop(0,'#c58a7f');tongue.addColorStop(.45,'#ad6a62');tongue.addColorStop(1,'#663631');ctx.fillStyle=tongue;ctx.beginPath();ctx.ellipse(0,19+h,10,Math.max(1,open*5),-.08,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(83,40,38,.35)';ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(0,17+h);ctx.lineTo(0,20+h);ctx.stroke();ctx.restore();ctx.lineWidth=1.15;ctx.strokeStyle='rgba(175,160,144,.35)';ctx.beginPath();ctx.moveTo(-15,23+h*.75);ctx.quadraticCurveTo(-3,28+h,9,24+h*.9);ctx.stroke();
  }ctx.restore();
}
