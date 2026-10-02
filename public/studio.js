import { mountScene, preloadProject } from './renderer.js';

const $ = (selector) => document.querySelector(selector);
const stages = [
  { id: 'brief', label: 'The brief', detail: 'Purpose & direction' },
  { id: 'script', label: 'The script', detail: 'Words & pacing' },
  { id: 'storyboard', label: 'Storyboard', detail: 'Visual plan & assets' },
  { id: 'animation', label: 'Animation', detail: 'Timing & delivery' },
];
let projects = [];
let project = null;
let status = null;
let stage = 'brief';
let sceneId = null;
let dirty = false;
let playing = false;
let playStartedAt = 0;
let playStartedTime = 0;
let time = 0;
let frameRequest = 0;
let busy = false;
let activeJob = null;
let stillsResult = null;
const previewAudio = new Audio();
let audioSceneId = null;
const musicAudio = new Audio();
musicAudio.loop = true;
let musicFile = null;
let noticeTimeout = 0;

function escapeHTML(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function duration() { return (project?.scenes || []).reduce((sum, scene) => sum + Math.max(0, Number(scene.duration) || 0), 0); }
function selectedScene() { return project?.scenes?.find((scene) => scene.id === sceneId) || project?.scenes?.[0] || null; }
function mediaURL(path) { return `/media/${encodeURIComponent(project.id)}/${String(path).split('/').map(encodeURIComponent).join('/')}`; }
function timestamp(seconds) { const n = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
function freshReview(stageId) { return project?.reviews?.[stageId]?.revision === project?.revision; }

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
  catch (error) { throw new Error(`Cannot reach the studio server. ${error.message}`); }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function message(text, kind = 'info', timeout = 6000) {
  const notice = $('#notice');
  notice.textContent = text;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
  clearTimeout(noticeTimeout);
  if (timeout) noticeTimeout = setTimeout(() => { notice.hidden = true; }, timeout);
}
function setDirty() {
  dirty = true;
  $('#save-button').disabled = false;
  $('#save-state').textContent = 'Unsaved changes';
  renderSidebar();
}
function setBusy(value) {
  busy = value || !!activeJob;
  $('#save-button').disabled = busy || !dirty;
  $('#export-button').disabled = busy || !project;
  $('#add-scene').disabled = busy || !project;
  $('#review-button').disabled = busy || freshReview(stage);
  document.querySelectorAll('#inspector-content input, #inspector-content textarea, #inspector-content select, #inspector-content button, #save-settings').forEach((control) => {
    if (!control.hasAttribute('data-base-disabled')) control.dataset.baseDisabled = String(control.disabled);
    control.disabled = busy || control.dataset.baseDisabled === 'true';
  });
}
function updateProject(saved) {
  previewAudio.pause(); audioSceneId = null;
  musicAudio.pause(); musicFile = null;
  project = saved;
  projects = [saved, ...projects.filter((item) => item.id !== saved.id)];
  sceneId = selectedScene()?.id || null;
  renderAll();
}
async function save() {
  if (!project || !dirty) return project;
  setBusy(true);
  try {
    const saved = await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify(project) });
    dirty = false;
    updateProject(saved);
    $('#save-state').textContent = 'All changes saved';
    return saved;
  } catch (error) { message(error.message, 'error', 0); throw error; }
  finally { setBusy(false); }
}
async function chooseProject(id) {
  if (project?.id === id) return;
  if (activeJob || busy) { message('Wait for the current operation to finish before switching projects.', 'error'); return; }
  if (dirty && !confirm('Discard unsaved changes and open another project?')) return;
  stop();
  try {
    project = await api(`/api/projects/${encodeURIComponent(id)}`);
    sceneId = project.scenes[0]?.id || null;
    stage = 'brief'; time = 0; dirty = false; stillsResult = null; audioSceneId = null;
    renderAll();
    await preloadProject(project);
    renderPreview();
  } catch (error) { message(error.message, 'error', 0); }
}
function renderSidebar() {
  $('#project-list').innerHTML = projects.map((item) => `<button class="project-item ${project?.id === item.id ? 'active' : ''}" data-project="${escapeHTML(item.id)}" aria-label="Open project ${escapeHTML(item.title)}" type="button"><span class="project-glyph">${escapeHTML(item.title?.[0] || 'F')}</span><span class="project-item-text"><strong>${escapeHTML(item.title)}</strong><small>${item.scenes?.length || 0} scenes · ${timestamp((item.scenes || []).reduce((n, s) => n + (Number(s.duration) || 0), 0))}</small></span>${project?.id === item.id && dirty ? '<span class="dirty-indicator" aria-label="Unsaved changes"></span>' : ''}</button>`).join('') || '<p class="empty-sidebar">No projects yet.</p>';
  $('#stage-list').innerHTML = stages.map((item, index) => `<button type="button" data-stage="${item.id}" aria-label="${escapeHTML(item.label)}${freshReview(item.id) ? ', reviewed' : ''}" class="stage-item ${stage === item.id ? 'active' : ''}" ${!project ? 'disabled' : ''}><span class="stage-number">0${index + 1}</span><span class="stage-text"><strong>${item.label}</strong><small>${item.detail}</small></span><span class="stage-check ${freshReview(item.id) ? 'complete' : ''}">${freshReview(item.id) ? '✓' : '○'}</span></button>`).join('');
}
function renderPreview() {
  if (!project) return;
  const total = duration();
  if (time > total) time = total;
  const preview = $('#preview');
  const portrait = project.brief?.format === 'portrait';
  const square = project.brief?.format === 'square';
  preview.style.aspectRatio = portrait ? '9 / 16' : square ? '1 / 1' : '16 / 9';
  preview.classList.toggle('portrait', portrait);
  preview.classList.toggle('square', square);
  try { mountScene(preview, project, time, { width: portrait ? 720 : square ? 1080 : 1280, height: portrait ? 1280 : square ? 1080 : 720, captions: true }); }
  catch (error) { preview.innerHTML = `<div class="preview-error">Preview unavailable<br><small>${escapeHTML(error.message)}</small></div>`; }
  $('#timeline').max = String(Math.max(total, 0.01));
  $('#timeline').value = String(time);
  $('#timeline').style.setProperty('--progress', `${total ? (time / total) * 100 : 0}%`);
  $('#preview-time').textContent = `${timestamp(time)} / ${timestamp(total)}`;
  let elapsed = 0;
  const index = Math.max(0, project.scenes.findIndex((scene) => { elapsed += Number(scene.duration) || 0; return time < elapsed; }));
  $('#timeline-scene').textContent = `SCENE ${String(index + 1).padStart(2, '0')}`;
  if (playing) { syncAudio(false); syncMusic(false); }
}
function renderScenes() {
  $('#scene-count').textContent = `(${project.scenes.length})`;
  $('#scene-strip').innerHTML = project.scenes.map((scene, index) => `<button type="button" class="scene-card ${scene.id === sceneId ? 'active' : ''}" data-scene="${escapeHTML(scene.id)}"><span class="scene-card-image">${scene.asset ? `<img src="${escapeHTML(mediaURL(scene.asset))}" alt="">` : `<span class="scene-placeholder">${String(index + 1).padStart(2, '0')}</span>`}<span class="scene-card-number">${String(index + 1).padStart(2, '0')}</span></span><span class="scene-card-meta"><strong>${escapeHTML(scene.title || `Scene ${index + 1}`)}</strong><small>${Math.round(Number(scene.duration) || 0)}s · ${escapeHTML(scene.layout || 'title')}</small></span></button>`).join('') || '<p class="empty-state">No scenes yet. Add one to begin the sequence.</p>';
}
function field(label, name, value, options = {}) {
  const attrs = `data-field="${name}" ${options.required ? 'required' : ''}`;
  if (options.type === 'textarea') return `<label>${label}<textarea ${attrs} rows="${options.rows || 4}" placeholder="${escapeHTML(options.placeholder || '')}">${escapeHTML(value)}</textarea></label>`;
  if (options.type === 'select') return `<label>${label}<select ${attrs}>${options.choices.map(([v, title]) => `<option value="${escapeHTML(v)}" ${String(v) === String(value) ? 'selected' : ''}>${escapeHTML(title)}</option>`).join('')}</select></label>`;
  return `<label>${label}<input ${attrs} type="${options.type || 'text'}" value="${escapeHTML(value)}" ${options.min != null ? `min="${options.min}"` : ''} ${options.max != null ? `max="${options.max}"` : ''} ${options.step != null ? `step="${options.step}"` : ''} placeholder="${escapeHTML(options.placeholder || '')}"></label>`;
}
function uploadControl(label, kind, scene, current) {
  return `<div class="upload-block"><div class="upload-heading"><strong>${label}</strong>${current ? `<a href="${escapeHTML(mediaURL(current))}" target="_blank" rel="noopener">Open file ↗</a>` : '<span>No file attached</span>'}</div><label class="upload-button">+ Upload ${label.toLowerCase()}<input type="file" data-upload="${kind}" ${scene ? `data-scene-id="${escapeHTML(scene.id)}"` : ''} accept="${kind === 'audio' || kind === 'music' ? '.wav,.mp3,.m4a,.aiff' : '.png,.jpg,.jpeg,.webp'}"></label></div>`;
}
function sceneControls(scene) {
  const index = project.scenes.findIndex((item) => item.id === scene.id);
  return `<div class="scene-navigation"><span>SCENE ${String(index + 1).padStart(2, '0')} OF ${String(project.scenes.length).padStart(2, '0')}</span><div><button type="button" data-move="up" aria-label="Move scene up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="down" aria-label="Move scene down" title="Move down" ${index === project.scenes.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-delete-scene class="delete-control" aria-label="Delete scene" title="Delete scene" ${project.scenes.length === 1 ? 'disabled' : ''}>×</button></div></div>`;
}
function renderInspector() {
  const index = stages.findIndex((item) => item.id === stage);
  $('#inspector-kicker').textContent = stages[index].label.toUpperCase();
  $('#inspector-index').textContent = `0${index + 1} / 04`;
  const content = $('#inspector-content');
  if (!project) { content.innerHTML = '<p class="empty-state">Create a project to start.</p>'; return; }
  const scene = selectedScene();
  let html = '';
  if (stage === 'brief') {
    html = `<h2>Start with the idea.</h2><p class="inspector-intro">A focused brief keeps the story, visuals and final cut aligned.</p>${field('Project title', 'title', project.title)}${field('Audience', 'brief.audience', project.brief?.audience, { placeholder: 'Who is watching?' })}${field('Key takeaway', 'brief.takeaway', project.brief?.takeaway, { type: 'textarea', rows: 3 })}<div class="form-grid">${field('Target duration', 'brief.duration', project.brief?.duration || 60, { type: 'number', min: 1, step: 1 })}${field('Format', 'brief.format', project.brief?.format || 'landscape', { type: 'select', choices: [['landscape', '16:9'], ['portrait', '9:16'], ['square', '1:1']] })}</div>${field('Visual style', 'brief.style', project.brief?.style, { placeholder: 'Editorial illustration, type-led…' })}${field('Tone of voice', 'brief.tone', project.brief?.tone, { placeholder: 'Warm, precise, playful…' })}<div class="inspector-divider"></div><h3>Reference images</h3><p class="helper">Images that set the visual direction for this project.</p>${uploadControl('Reference image', 'reference', null, null)}<div class="reference-list">${(project.references || []).map((item) => `<a href="${escapeHTML(mediaURL(typeof item === 'string' ? item : item.file || item.path))}" target="_blank" rel="noopener">${escapeHTML((typeof item === 'string' ? item : item.file || item.path).split('/').pop())} ↗</a>`).join('')}</div>`;
  } else if (!scene) {
    html = '<h2>No scene selected</h2><p class="inspector-intro">Add a scene to shape the story.</p>';
  } else if (stage === 'script') {
    html = `${sceneControls(scene)}<h2>Write the story.</h2><p class="inspector-intro">Narration drives the pace. Keep each beat focused on one idea.</p>${field('Scene title', 'scene.title', scene.title)}${field('Narration', 'scene.narration', scene.narration, { type: 'textarea', rows: 9, placeholder: 'What should the viewer hear?' })}<div class="word-count" id="word-count">${(scene.narration || '').trim().split(/\s+/).filter(Boolean).length} words</div>${field('Scene duration · seconds', 'scene.duration', scene.duration, { type: 'number', min: 0.5, step: 0.5 })}<div class="inspector-divider"></div><h3>Voice & transcription</h3><p class="helper">Generate narration or align word timings with uploaded audio.</p><div class="stacked-actions"><button type="button" class="button button-outline" data-job="speak" data-provider="demo" ${status?.demoVoice ? '' : 'disabled title="Local demo voice requires macOS; upload audio or use ElevenLabs"'}>Generate demo voice</button><button type="button" class="button button-outline" data-job="speak" data-provider="elevenlabs" ${status?.elevenlabs ? '' : 'disabled title="Set ELEVENLABS_API_KEY on the server"'}>Generate ElevenLabs voice</button><button type="button" class="button button-outline" data-job="speak" data-provider="elevenlabs" data-force="true" ${status?.elevenlabs ? '' : 'disabled title="Set ELEVENLABS_API_KEY on the server"'}>New ElevenLabs take</button><button type="button" class="button button-outline" data-job="transcribe" ${status?.whisper ? '' : 'disabled title="Whisper is unavailable"'}>Transcribe scene audio</button></div>${uploadControl('Scene audio', 'audio', scene, scene.audio)}<p class="helper">Timing source: ${escapeHTML(scene.timingSource || 'estimated')}</p>${transcriptionReview(scene)}`;
  } else if (stage === 'storyboard') {
    html = `${sceneControls(scene)}<h2>Plan the frame.</h2><p class="inspector-intro">Describe the visual beat and attach artwork when it is ready.</p>${field('Scene title', 'scene.title', scene.title)}${field('Visual prompt', 'scene.visualPrompt', scene.visualPrompt, { type: 'textarea', rows: 7, placeholder: 'Describe the image, motion and visual hierarchy…' })}${field('Short image subtitle', 'scene.subtitle', scene.subtitle || '', { placeholder: 'A few words below the image' })}${field('Layout', 'scene.layout', scene.layout || 'title', { type: 'select', choices: [['title', 'Title'], ['image', 'Image'], ['steps', 'Steps'], ['quote', 'Quote']] })}${field('On-screen items · one per line', 'scene.items', (scene.items || []).join('\n'), { type: 'textarea', rows: 5, placeholder: 'First point\nSecond point' })}${field('Cue phrases · one per line', 'scene.cuePhrases', (scene.cuePhrases || []).join('\n'), { type: 'textarea', rows: 4, placeholder: 'Exact words in the narration that reveal each step' })}<p class="helper">For step layouts, cue phrases reveal items as those words are spoken.</p>${uploadControl('Scene image', 'asset', scene, scene.asset)}<div class="inspector-divider"></div><div class="stacked-actions"><button type="button" class="button button-outline" data-job="cues">Align step cues to narration</button><button type="button" class="button button-dark" data-job="stills">Generate storyboard stills ↗</button></div><p class="helper">The contact sheet includes beat snapshots from all scenes.</p>`;
  } else {
    html = `${sceneControls(scene)}<h2>Fine-tune the cut.</h2><p class="inspector-intro">The sequence plays scenes in order. Scrub the timeline to check each beat.</p>${field('Scene title', 'scene.title', scene.title)}${field('Duration · seconds', 'scene.duration', scene.duration, { type: 'number', min: 0.5, step: 0.5 })}${field('Layout', 'scene.layout', scene.layout || 'title', { type: 'select', choices: [['title', 'Title'], ['image', 'Image'], ['steps', 'Steps'], ['quote', 'Quote']] })}${field('On-screen items · one per line', 'scene.items', (scene.items || []).join('\n'), { type: 'textarea', rows: 5 })}<div class="inspector-divider"></div><h3>Backing music</h3><p class="helper">A single track plays under the narration throughout the film.</p>${uploadControl('Music track', 'music', null, project.music?.file)}${project.music?.file ? `${field('Music volume · 0 to 1', 'music.volume', project.music.volume ?? 0.18, { type: 'number', min: 0, max: 1, step: 0.05 })}<button type="button" class="button button-outline" data-remove-music>Remove music track</button>` : ''}<div class="inspector-divider"></div><h3>Delivery</h3><p class="helper">Render uses the current scene timing, narration and music. Save edits before export.</p><button type="button" class="button button-dark full-width" data-job="render">Render video ↗</button>`;
  }
  content.innerHTML = html;
  setBusy(busy);
}
function transcriptionReview(scene) {
  const report = scene.transcription;
  if (!report) return '';
  const differences = report.differences || [];
  return `<div class="transcription-review"><h3>Heard in the recording</h3><p class="transcript-text">${escapeHTML(report.text || '')}</p>${differences.length ? `<p class="helper">Check these words against the script:</p><div class="difference-list">${differences.map((part) => `<span class="difference ${part.type === 'heardOnly' ? 'heard' : 'script'}">${part.type === 'heardOnly' ? 'Heard' : 'Script'} · ${escapeHTML(part.word)}</span>`).join('')}</div>` : '<p class="helper">Transcription matches the script.</p>'}</div>`;
}
function renderReview() {
  const review = project.reviews?.[stage];
  const fresh = freshReview(stage);
  $('#review-description').textContent = fresh ? `Reviewed for revision ${review.revision}.` : review ? `Changes since revision ${review.revision} need a fresh review.` : `Mark the ${stages.find((item) => item.id === stage).label.toLowerCase()} ready when you have checked it.`;
  $('#review-button').textContent = fresh ? 'Reviewed ✓' : 'Mark reviewed';
  $('#review-button').disabled = fresh || busy;
}
function renderExports() {
  const exports = project.exports || [];
  const videos = exports.slice().reverse().map((item) => `<div class="export-entry"><a class="export-link" href="${escapeHTML(mediaURL(item.file))}" download><span><strong>Video · ${item.width} × ${item.height}</strong><small>Revision ${item.revision}${item.revision !== project.revision ? ' · Older revision' : ''} · ${new Date(item.createdAt).toLocaleDateString()}</small></span><span>Download ↗</span></a>${(item.files || []).filter((file) => file.endsWith('.srt')).map((file) => `<a class="supporting-file" href="${escapeHTML(mediaURL(file))}" download>Download captions · SRT ↗</a>`).join('')}</div>`).join('');
  const latestSheet = project.contactSheets?.at(-1);
  const sheetFile = latestSheet?.file || stillsResult;
  const stills = sheetFile ? `<a class="export-link" href="${escapeHTML(mediaURL(sheetFile))}" target="_blank" rel="noopener"><span><strong>Storyboard contact sheet</strong><small>${latestSheet ? `Revision ${latestSheet.revision}${latestSheet.revision !== project.revision ? ' · Older revision' : ''}` : 'Generated for this session'}</small></span><span>Open ↗</span></a>` : '';
  $('#exports-list').innerHTML = stills + videos || '<p class="helper">Finished renders will appear here.</p>';
}
function renderAll() {
  $('#project-title').textContent = project?.title || 'No project';
  $('#save-state').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
  $('#save-button').disabled = !dirty || busy;
  $('#export-button').disabled = !project || busy;
  renderSidebar();
  if (!project) return;
  renderScenes(); renderInspector(); renderReview(); renderExports(); renderPreview();
}
function setStage(next) { stage = next; renderSidebar(); renderInspector(); renderReview(); }
function setScene(id) { sceneId = id; renderScenes(); renderInspector(); const before = project.scenes.slice(0, project.scenes.findIndex((scene) => scene.id === id)).reduce((sum, scene) => sum + Number(scene.duration || 0), 0); time = before; if (playing) { playStartedAt = performance.now(); playStartedTime = time; syncAudio(true); syncMusic(true); } renderPreview(); }
function handleEdit(target) {
  if (busy || activeJob) return;
  const path = target.dataset.field;
  if (!path || !project) return;
  const parts = path.split('.');
  const holder = parts[0] === 'scene' ? selectedScene() : project;
  const keys = parts[0] === 'scene' ? parts.slice(1) : parts;
  if (!holder) return;
  let object = holder;
  for (const key of keys.slice(0, -1)) object = object[key] ||= {};
  let value = target.value;
  if (path === 'scene.items' || path === 'scene.cuePhrases') value = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (path === 'scene.duration' || path === 'brief.duration') value = Math.max(path === 'scene.duration' ? 0.5 : 1, Number(value) || 0);
  if (path === 'music.volume') value = Math.min(1, Math.max(0, Number(value) || 0));
  object[keys.at(-1)] = value;
  if (path === 'scene.narration') {
    const words = value.trim().split(/\s+/).filter(Boolean);
    const seconds = Number(holder.duration) || 1;
    holder.words = words.map((word, index) => ({ word, start: index * seconds / words.length, end: (index + 1) * seconds / words.length }));
    holder.timingSource = 'estimated';
    $('#word-count').textContent = `${words.length} words`;
  }
  if (path === 'title') $('#project-title').textContent = value || 'Untitled project';
  if (path === 'music.volume') musicAudio.volume = value;
  setDirty();
  stillsResult = null;
  if (['scene.title', 'scene.duration', 'scene.layout', 'brief.format'].includes(path)) { renderScenes(); renderPreview(); }
  if (['scene.narration', 'scene.items', 'scene.cuePhrases', 'scene.subtitle'].includes(path)) renderPreview();
}
async function upload(file, kind, id) {
  if (!file || !project || busy || activeJob) return;
  if (dirty) await save();
  const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the selected file.')); reader.readAsDataURL(file); });
  setBusy(true); message(`Uploading ${file.name}…`, 'info', 0);
  try {
    const saved = await api(`/api/projects/${encodeURIComponent(project.id)}/upload`, { method: 'POST', body: JSON.stringify({ name: file.name, data: base64, kind, ...(id ? { sceneId: id } : {}) }) });
    stillsResult = null; updateProject(saved); await preloadProject(project); renderPreview(); message(`${file.name} uploaded.`, 'success');
  } catch (error) { message(error.message, 'error', 0); }
  finally { setBusy(false); }
}
async function runJob(type, extra = {}) {
  if (!project || activeJob || busy) return;
  try { if (dirty) await save(); } catch { return; }
  const scene = selectedScene();
  if ((type === 'speak' || type === 'transcribe') && !scene) return;
  const body = { type, ...(type === 'speak' || type === 'transcribe' ? { sceneId: scene.id } : {}), ...extra };
  try {
    const job = await api(`/api/projects/${encodeURIComponent(project.id)}/jobs`, { method: 'POST', body: JSON.stringify(body) });
    activeJob = job.id;
    setBusy(true);
    message(`${type === 'render' ? 'Video render' : type === 'stills' ? 'Storyboard stills' : type === 'speak' ? 'Narration' : type === 'cues' ? 'Step cue alignment' : 'Transcription'} queued…`, 'info', 0);
    const currentId = project.id;
    while (activeJob === job.id) {
      const state = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
      if (state.status === 'done') { activeJob = null; if (project?.id === currentId) { if (type === 'stills' && state.result?.file) stillsResult = state.result.file; const saved = await api(`/api/projects/${encodeURIComponent(currentId)}`); updateProject(saved); await preloadProject(project); renderPreview(); } message(state.message || 'Job complete.', 'success'); break; }
      if (state.status === 'error') { activeJob = null; message(state.error || state.message || 'Job failed.', 'error', 0); break; }
      message(`${state.message || 'Working…'} ${Math.round((state.progress || 0) * 100)}%`, 'info', 0);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) { activeJob = null; message(error.message, 'error', 0); }
  finally { setBusy(false); }
}
async function review() {
  if (!project || busy || activeJob || freshReview(stage)) return;
  try {
    if (dirty) await save();
    const saved = await api(`/api/projects/${encodeURIComponent(project.id)}/review`, { method: 'POST', body: JSON.stringify({ stage }) });
    updateProject(saved); message(`${stages.find((item) => item.id === stage).label} marked reviewed.`, 'success');
  } catch (error) { message(error.message, 'error', 0); }
}
function addScene() {
  if (!project || busy || activeJob) return;
  const n = project.scenes.length + 1;
  const scene = { id: `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title: `Scene ${n}`, narration: '', duration: 8, layout: 'title', visualPrompt: '', asset: null, items: [], audio: null, words: [], timingSource: 'estimated' };
  project.scenes.push(scene); sceneId = scene.id; stage = 'script'; stillsResult = null; setDirty(); renderAll();
}
function moveScene(direction) {
  if (busy || activeJob) return;
  const index = project.scenes.findIndex((scene) => scene.id === sceneId);
  const next = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || next < 0 || next >= project.scenes.length) return;
  [project.scenes[index], project.scenes[next]] = [project.scenes[next], project.scenes[index]];
  stillsResult = null; setDirty(); renderAll();
}
function deleteScene() {
  if (busy || activeJob) return;
  const scene = selectedScene();
  if (project.scenes.length <= 1) { message('A project needs at least one scene.', 'error'); return; }
  if (!scene || !confirm(`Delete “${scene.title}” from this project?`)) return;
  const index = project.scenes.findIndex((item) => item.id === scene.id);
  project.scenes.splice(index, 1);
  sceneId = project.scenes[Math.min(index, project.scenes.length - 1)]?.id || null;
  stillsResult = null; setDirty(); renderAll();
}
function sceneAtPlayhead() {
  let start = 0;
  for (const scene of project?.scenes || []) { const end = start + (Number(scene.duration) || 0); if (time < end) return { scene, local: Math.max(0, time - start) }; start = end; }
  return { scene: project?.scenes?.at(-1), local: 0 };
}
function syncAudio(seek = false) {
  const { scene, local } = sceneAtPlayhead();
  if (!scene?.audio || !playing) { previewAudio.pause(); if (!scene?.audio) audioSceneId = null; return; }
  if (audioSceneId !== scene.id) {
    previewAudio.pause();
    previewAudio.src = mediaURL(scene.audio);
    audioSceneId = scene.id;
    seek = true;
  }
  if (seek || Math.abs((previewAudio.currentTime || 0) - local) > 0.35) {
    try { previewAudio.currentTime = local; } catch { previewAudio.addEventListener('loadedmetadata', () => { previewAudio.currentTime = local; }, { once: true }); }
  }
  if (Number.isFinite(previewAudio.duration) && previewAudio.duration > 0 && local >= previewAudio.duration) { previewAudio.pause(); return; }
  if (previewAudio.paused) previewAudio.play().catch((error) => { message(`Preview audio could not play: ${error.message}`, 'error'); });
}
function syncMusic(seek = false) {
  const track = project?.music;
  if (!playing || !track?.file) { musicAudio.pause(); if (!track?.file) musicFile = null; return; }
  if (musicFile !== track.file) { musicAudio.pause(); musicAudio.src = mediaURL(track.file); musicFile = track.file; seek = true; }
  musicAudio.volume = Math.min(1, Math.max(0, Number(track.volume ?? 0.18)));
  const position = Number.isFinite(musicAudio.duration) && musicAudio.duration > 0 ? time % musicAudio.duration : time;
  if (seek || Math.abs((musicAudio.currentTime || 0) - position) > 0.35) {
    try { musicAudio.currentTime = position; } catch { musicAudio.addEventListener('loadedmetadata', () => { musicAudio.currentTime = time % musicAudio.duration; }, { once: true }); }
  }
  if (musicAudio.paused) musicAudio.play().catch((error) => { message(`Preview music could not play: ${error.message}`, 'error'); });
}
function stop() { playing = false; cancelAnimationFrame(frameRequest); previewAudio.pause(); musicAudio.pause(); $('#play-button').textContent = '▶'; $('#play-button').setAttribute('aria-label', 'Play preview'); }
function tick() {
  if (!playing) return;
  time = playStartedTime + (performance.now() - playStartedAt) / 1000;
  if (time >= duration()) { time = duration(); stop(); }
  renderPreview();
  if (playing) frameRequest = requestAnimationFrame(tick);
}
function togglePlay() {
  if (!project || !duration()) return;
  if (playing) { stop(); return; }
  if (time >= duration()) time = 0;
  playing = true; playStartedAt = performance.now(); playStartedTime = time;
  $('#play-button').textContent = 'Ⅱ'; $('#play-button').setAttribute('aria-label', 'Pause preview');
  syncAudio(true);
  syncMusic(true);
  tick();
}
function openDialog(dialog) { dialog.showModal(); }
function closeDialog(dialog) { dialog.close(); }
function renderStatus() {
  const ready = status?.ffmpeg;
  $('#service-dot').classList.toggle('ready', !!ready);
  $('#service-status').textContent = ready ? 'Render engine ready' : 'Render engine unavailable';
  $('#status-details').innerHTML = [['FFmpeg', status?.ffmpeg], ['Whisper', status?.whisper], ['ElevenLabs', status?.elevenlabs], ['Image generation', status?.imageGeneration === 'codex']].map(([name, yes]) => `<div><span>${name}</span><strong class="${yes ? 'ok' : 'off'}">${yes ? 'Available' : 'Unavailable'}</strong></div>`).join('');
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.project) return chooseProject(button.dataset.project);
  if (button.dataset.stage) return setStage(button.dataset.stage);
  if (button.dataset.scene) return setScene(button.dataset.scene);
  if (button.dataset.move) return moveScene(button.dataset.move);
  if (button.hasAttribute('data-delete-scene')) return deleteScene();
  if (button.hasAttribute('data-remove-music')) { if (!busy && !activeJob && project?.music) { musicAudio.pause(); musicFile = null; project.music = null; stillsResult = null; setDirty(); renderInspector(); } return; }
  if (button.dataset.job) return runJob(button.dataset.job, { ...(button.dataset.provider ? { provider: button.dataset.provider } : {}), ...(button.dataset.force ? { force: true } : {}) });
  if (button.hasAttribute('data-close-dialog')) return closeDialog(button.closest('dialog'));
});
$('#inspector-content').addEventListener('input', (event) => { if (event.target.dataset.field) handleEdit(event.target); });
$('#inspector-content').addEventListener('change', async (event) => { if (event.target.dataset.upload) { try { await upload(event.target.files?.[0], event.target.dataset.upload, event.target.dataset.sceneId); } catch (error) { message(error.message, 'error', 0); } } });
$('#new-project').addEventListener('click', () => openDialog($('#project-dialog')));
$('#settings-button').addEventListener('click', () => { $('#voice-id').value = project?.voice?.voiceId || ''; renderStatus(); openDialog($('#settings-dialog')); });
$('#refresh-status').addEventListener('click', async () => { const button = $('#refresh-status'); button.disabled = true; try { status = await api('/api/status'); renderStatus(); renderInspector(); message('Service status refreshed.', 'success'); } catch (error) { message(error.message, 'error', 0); } finally { button.disabled = false; } });
$('#save-settings').addEventListener('click', () => { if (project && !busy && !activeJob) { project.voice ||= { provider: 'demo', model: 'eleven_multilingual_v2' }; project.voice.voiceId = $('#voice-id').value.trim(); stillsResult = null; setDirty(); } closeDialog($('#settings-dialog')); });
$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || activeJob) { message('Wait for the current operation to finish before creating a project.', 'error'); return; }
  if (dirty && !confirm('Discard unsaved changes and create a project?')) return;
  const form = event.target; const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  const brief = { audience: String(data.get('audience') || '').trim(), takeaway: String(data.get('takeaway') || '').trim(), duration: Number(data.get('duration')) || 60, format: String(data.get('format') || 'landscape'), style: String(data.get('style') || '').trim(), tone: String(data.get('tone') || '').trim() };
  try {
    const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ title, brief }) });
    closeDialog($('#project-dialog')); form.reset(); stop(); dirty = false; stage = 'brief'; time = 0; sceneId = created.scenes?.[0]?.id || null; updateProject(created); await preloadProject(project); renderPreview(); message('Project created. Shape the brief, then build your scenes.', 'success');
  } catch (error) { message(error.message, 'error', 0); }
});
$('#save-button').addEventListener('click', async () => { try { await save(); message('Changes saved.', 'success'); } catch {} });
$('#review-button').addEventListener('click', review);
$('#add-scene').addEventListener('click', addScene);
$('#export-button').addEventListener('click', () => runJob('render'));
$('#play-button').addEventListener('click', togglePlay);
$('#restart-button').addEventListener('click', () => { stop(); time = 0; renderPreview(); });
$('#timeline').addEventListener('input', (event) => { time = Number(event.target.value); if (playing) { playStartedAt = performance.now(); playStartedTime = time; syncAudio(true); syncMusic(true); } renderPreview(); });
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('keydown', (event) => { if (event.key === ' ' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); togglePlay(); } });

async function start() {
  try {
    const [listing, services] = await Promise.all([api('/api/projects'), api('/api/status').catch(() => null)]);
    projects = listing.projects || [];
    status = services; renderStatus();
    if (projects.length) await chooseProject(projects[0].id);
    else { $('#project-title').textContent = 'Your next story starts here'; $('#save-state').textContent = ''; $('#preview').innerHTML = '<div class="preview-empty"><span>FRAME STUDIO</span><h2>Make an idea move.</h2><p>Create a project to begin shaping your story.</p><button id="empty-create" class="button button-dark" type="button">Create project →</button></div>'; $('#empty-create').addEventListener('click', () => openDialog($('#project-dialog'))); renderSidebar(); renderInspector(); $('#export-button').disabled = true; }
  } catch (error) { message(error.message, 'error', 0); $('#project-title').textContent = 'Studio unavailable'; }
}
start();
