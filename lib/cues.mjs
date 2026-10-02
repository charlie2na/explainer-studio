// Resolve editor-authored phrases to local word timestamps. The original
// project is left untouched so callers can review or persist the result.
const normalized = text => String(text ?? '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLocaleLowerCase('en')
  .replace(/[^\p{L}\p{N}]+/gu, '');

function cueSpec(value, sceneName, position) {
  const phrase = typeof value === 'string' ? value : value?.phrase;
  const occurrence = typeof value === 'string' ? undefined : value?.occurrence;
  if (typeof phrase !== 'string' || !phrase.trim()) {
    throw new Error(`Scene "${sceneName}" cue ${position + 1} needs a nonempty phrase.`);
  }
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) {
    throw new Error(`Scene "${sceneName}" cue "${phrase}" occurrence must be a positive integer.`);
  }
  const tokens = phrase.trim().split(/\s+/).map(normalized).filter(Boolean);
  if (!tokens.length) throw new Error(`Scene "${sceneName}" cue "${phrase}" has no searchable words.`);
  return { phrase, occurrence, tokens };
}

export function resolveCues(project) {
  if (!project || !Array.isArray(project.scenes)) throw new Error('Cue resolution requires a project with scenes.');
  const result = structuredClone(project);
  result.scenes.forEach((scene, sceneIndex) => {
    const sceneName = scene.title || scene.id || `Scene ${sceneIndex + 1}`;
    const specs = scene.cuePhrases ?? [];
    if (!Array.isArray(specs)) throw new Error(`Scene "${sceneName}" cuePhrases must be an array.`);
    scene.cues = [];
    if (!specs.length) return;
    const words = scene.words;
    if (!Array.isArray(words) || !words.length) throw new Error(`Scene "${sceneName}" needs timed words before resolving cues.`);
    const sequence = words.map(w => normalized(w?.word));
    specs.forEach((value, position) => {
      const { phrase, occurrence, tokens } = cueSpec(value, sceneName, position);
      const matches = [];
      for (let i = 0; i <= sequence.length - tokens.length; i++) {
        if (tokens.every((token, k) => sequence[i + k] === token)) matches.push(i);
      }
      if (!matches.length) throw new Error(`Scene "${sceneName}" cue "${phrase}" was not found in the timed words.`);
      if (occurrence === undefined && matches.length > 1) {
        throw new Error(`Scene "${sceneName}" cue "${phrase}" matches ${matches.length} times; specify an occurrence (starting at 1).`);
      }
      if (occurrence !== undefined && occurrence > matches.length) {
        throw new Error(`Scene "${sceneName}" cue "${phrase}" has only ${matches.length} occurrence${matches.length === 1 ? '' : 's'}.`);
      }
      const wordIndex = matches[(occurrence ?? 1) - 1];
      const first = words[wordIndex], last = words[wordIndex + tokens.length - 1];
      const start = Number(first.start), end = Number(last.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        throw new Error(`Scene "${sceneName}" cue "${phrase}" matched words with invalid timing.`);
      }
      scene.cues.push({ phrase, start, end, wordIndex });
    });
  });
  return result;
}
