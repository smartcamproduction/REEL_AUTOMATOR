// Transcript exporters — pure functions of (sentences, fps) → string.
// No DOM, no state import, no I/O (per the exporter rule), so regression tests
// stay simple. `.srt` optionally embeds word-level timing as a comment block
// when sentences carry words[].

/** Upper bound for the "words per cue" setting of the word-by-word `.srt`. */
export const MAX_WORDS_PER_CUE = 10;

// Characters removed by `stripPunctuation`: sentence marks, quotes, brackets and
// dashes. Deliberately NOT the whole `\p{P}` class — symbols that carry meaning
// in a caption (% & @ # / + $ €) are kept.
const STRIP_PUNCT_RE = /[.,;:!?…"'„“”‘’«»‹›()[\]{}¿¡–—-]/g;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const DIGIT_RE = /\p{N}/u;

/**
 * Remove punctuation from caption text. Word-internal hyphens/apostrophes
 * (`e-mail`, `biało-czerwony`, `don't`) and number separators between digits
 * (`3,5`, `1.000`, `12:30`) are kept; a dash between words becomes a space.
 * Whitespace is collapsed per line and empty lines are dropped, so a
 * punctuation-only input (`"…"`, `"–"`) returns `''`. Pure function.
 * @param {string} text
 * @returns {string}
 */
export function stripPunctuation(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(STRIP_PUNCT_RE, (ch, i, str) => {
          const prev = str[i - 1] || '';
          const next = str[i + 1] || '';
          if ("-'’".includes(ch) && ALNUM_RE.test(prev) && ALNUM_RE.test(next))
            return ch;
          if ('.,:'.includes(ch) && DIGIT_RE.test(prev) && DIGIT_RE.test(next))
            return ch;
          return '-–—'.includes(ch) ? ' ' : '';
        })
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Clamp a "words per cue" value to an integer in 1..{@link MAX_WORDS_PER_CUE};
 * anything missing or non-numeric falls back to 1 (classic word-by-word).
 * @param {unknown} n
 * @returns {number}
 */
export function normalizeWordsPerCue(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_WORDS_PER_CUE);
}

/**
 * Format a frame count as an SRT/VTT timestamp.
 * @param {number} frames
 * @param {number} fps
 * @param {string} sep - millisecond separator (',' for SRT, '.' for VTT)
 * @returns {string}
 */
function frameToStamp(frames, fps, sep) {
  const totalMs = Math.round((Math.max(0, frames) / fps) * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms).padStart(3, '0')}`;
}

/**
 * Generate a valid, round-trippable `.srt` transcript from sentences. By
 * default the output is clean caption text (re-imports cleanly via `parseSRT`).
 * Pass `{includeWords:true}` to additionally append a non-standard
 * `NOTE WORDS:` line (per-word `text@start-end` in frames) for tooling — this
 * embeds word timing at the cost of standard re-import. Word-level data is also
 * durably persisted in the `.reelproj` (v4) regardless of this flag.
 * `{stripPunctuation:true}` runs each cue's text through
 * {@link stripPunctuation}; a cue left empty by it is dropped (an empty body
 * would end the SRT block early) and the remaining cues are renumbered.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @param {{includeWords?: boolean, stripPunctuation?: boolean}} [opts]
 * @returns {string}
 */
export function generateTranscriptSRT(sentences, fps, opts = {}) {
  const includeWords = opts.includeWords === true;
  const strip = opts.stripPunctuation === true;
  const out = [];
  let n = 0;
  sentences.forEach((s) => {
    const text = strip ? stripPunctuation(s.text) : s.text;
    if (strip && !text) return;
    n += 1;
    out.push(String(n));
    out.push(
      `${frameToStamp(s.start_frame, fps, ',')} --> ${frameToStamp(s.end_frame, fps, ',')}`,
    );
    out.push(text);
    if (includeWords && Array.isArray(s.words) && s.words.length) {
      const words = s.words
        .map((w) => `${w.text}@${w.start_frame}-${w.end_frame}`)
        .join(' ');
      out.push(`NOTE WORDS: ${words}`);
    }
    out.push('');
  });
  return out.join('\n');
}

/**
 * Generate a word-by-word `.srt` — one cue per spoken word, for karaoke-style
 * Reels/TikTok captions. Timing rules (S-19, gapless fill-forward): the cue
 * start is pinned to the word's real audio onset (`start_frame`) and never
 * moved — so every cue lines up with speech. Each cue is then held forward
 * (to the right) until the NEXT word's onset, leaving no gap between cues: a
 * word stays on screen until the following word is actually spoken. The final
 * word has no successor to fill toward, so it keeps its own end with a 4-frame
 * floor. If a successor's onset is at or before the current word's start
 * (overlapping/diarized timing), the end is clamped to the start so the cue is
 * never reversed. Words are flattened in global order across sentence
 * boundaries, so fill respects real audio adjacency. Speaker labels are never
 * emitted. Pure function.
 *
 * `opts.wordsPerCue` (1..{@link MAX_WORDS_PER_CUE}, default 1) groups that many
 * consecutive words into one cue. A cue never straddles a sentence boundary, so
 * the last cue of a sentence may hold fewer words. The same timing rules apply
 * to the group: start at its first word's onset, held forward to the next
 * cue's onset; the final cue ends at its last word's end (4-frame floor).
 * `opts.stripPunctuation` runs each word through {@link stripPunctuation} and
 * drops words left empty by it (e.g. a lone `–`) before grouping.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @param {{wordsPerCue?: number, stripPunctuation?: boolean}} [opts]
 * @returns {string}
 */
export function generateWordSRT(sentences, fps, opts = {}) {
  const FLOOR_FRAMES = 4;
  const perCue = normalizeWordsPerCue(opts.wordsPerCue);
  const strip = opts.stripPunctuation === true;
  /** @type {{text:string,start_frame:number,end_frame:number}[][]} */
  const cues = [];
  sentences.forEach((s) => {
    if (!Array.isArray(s.words)) return;
    let group = [];
    s.words.forEach((w) => {
      if (
        typeof w.start_frame === 'number' &&
        typeof w.end_frame === 'number' &&
        Number.isFinite(w.start_frame) &&
        Number.isFinite(w.end_frame)
      ) {
        const text = strip ? stripPunctuation(w.text) : w.text;
        if (strip && !text) return;
        group.push({ ...w, text });
        if (group.length === perCue) {
          cues.push(group);
          group = [];
        }
      }
    });
    if (group.length) cues.push(group);
  });
  const out = [];
  cues.forEach((group, i) => {
    const start = group[0].start_frame;
    const last = group[group.length - 1];
    const next = cues[i + 1];
    // Gapless fill-forward: hold this cue until the next cue's onset (clamped
    // to `start` so an overlapping successor can't reverse the cue). The last
    // cue has no successor, so it keeps its last word's end with the 4-frame
    // floor.
    const end = next
      ? Math.max(start, next[0].start_frame)
      : Math.max(last.end_frame, start + FLOOR_FRAMES);
    out.push(String(i + 1));
    out.push(
      `${frameToStamp(start, fps, ',')} --> ${frameToStamp(end, fps, ',')}`,
    );
    out.push(group.map((w) => w.text).join(' '));
    out.push('');
  });
  return out.join('\n');
}

/**
 * Generate a word-level timing JSON from sentences — a machine-readable dump of
 * each segment plus its per-word frame timings (when present). Pure function;
 * stable shape for downstream tooling and the auto-mode "słowo-JSON" output.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @returns {string}
 */
export function generateWordJSON(sentences, fps) {
  return JSON.stringify(
    {
      fps,
      sentences: sentences.map((s) => ({
        id: s.id,
        text: s.text,
        start_frame: s.start_frame,
        end_frame: s.end_frame,
        words: Array.isArray(s.words) ? s.words : [],
      })),
    },
    null,
    2,
  );
}

/**
 * Build the human-readable segment-listing `.md` for a transcript — one entry
 * per sentence with its timecode span, duration and text. Pure function (no DOM,
 * no state), so the export popover, the single-video auto-mode export, and the
 * Phase-4 batch all share one builder and a regression case can pin the output.
 * Output is byte-identical to the previous inline `export-popover.js` builder.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @param {string} [srtName] - source file name shown in the header
 * @returns {string}
 */
export function generateSegmentsMd(sentences, fps, srtName) {
  let md = `# Segmenty SRT\n\nPlik: ${srtName || 'nieznany'}\nFPS: ${fps}\nSegmentów: ${sentences.length}\n\n---\n\n`;
  sentences.forEach((s) => {
    md += `**#${s.id}** \`${s.start_tc} → ${s.end_tc}\` (${(s.duration_frame / fps).toFixed(1)}s)\n\n${s.text}\n\n---\n\n`;
  });
  return md;
}

/**
 * Generate a `.vtt` transcript from sentences.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @returns {string}
 */
export function generateTranscriptVTT(sentences, fps) {
  const out = ['WEBVTT', ''];
  sentences.forEach((s, i) => {
    out.push(String(i + 1));
    out.push(
      `${frameToStamp(s.start_frame, fps, '.')} --> ${frameToStamp(s.end_frame, fps, '.')}`,
    );
    out.push(s.text);
    out.push('');
  });
  return out.join('\n');
}
