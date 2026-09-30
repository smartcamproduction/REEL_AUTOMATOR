// Shared SRT-export mode decision for auto-mode (S-07). The single-video export
// stage and the batch path both honour the per-machine word-by-word toggle
// (`state.whisperAdvanced.wordLevelSrtExport`, S-19) exactly like the manual
// "⬇ Eksport .srt" button (export-srt.js) — so an auto/batch SRT matches what a
// manual export of the same transcript would produce. When the toggle is ON but
// the segments carry no frame-level word timing, it falls back to sentence-level
// (auto runs are headless — no place to interactively force-align here).

import { state } from '../../state.js';
import {
  generateTranscriptSRT,
  generateWordSRT,
} from '../../exporters/transcript.js';
import { srtExportOptions } from '../export-srt.js';

/**
 * True when at least one sentence carries a word with finite frame timing — the
 * data the word-by-word exporter needs (mirrors export-srt.js).
 * @param {import('../../state.js').Sentence[]} sentences
 * @returns {boolean}
 */
export function hasFrameWords(sentences) {
  return sentences.some(
    (s) =>
      Array.isArray(s.words) &&
      s.words.some(
        (w) => Number.isFinite(w.start_frame) && Number.isFinite(w.end_frame),
      ),
  );
}

/**
 * Build SRT content honouring the word-by-word toggle: per-word when the toggle
 * is on AND frame-level word timing exists, otherwise clean sentence-level.
 * Words-per-cue / punctuation prefs apply exactly as in the manual export.
 * @param {import('../../state.js').Sentence[]} sentences
 * @param {number} fps
 * @returns {string}
 */
export function buildSrtContent(sentences, fps) {
  const opts = srtExportOptions();
  if (state.whisperAdvanced.wordLevelSrtExport && hasFrameWords(sentences)) {
    return generateWordSRT(sentences, fps, opts);
  }
  return generateTranscriptSRT(sentences, fps, {
    stripPunctuation: opts.stripPunctuation,
  });
}
