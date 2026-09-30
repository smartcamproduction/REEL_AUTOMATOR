// Shared transcript-SRT export decision (S-20). Both SRT export buttons route
// through here so the word-by-word toggle behaves identically from either entry
// point: the import-section "⬇ Eksport .srt" (transcribe.js) and the export
// popover "⬇ Transkrypcja .srt" (export-popover.js). Keeping the word/sentence +
// auto-align + Polish-feedback logic in one place stops the two paths drifting.
//
// `alignToWords` lives in import/transcribe.js, which also wires a button to this
// module — so it is pulled in via dynamic import (only when an align is actually
// needed) to avoid a static import cycle.

import { state } from '../state.js';
import { toast } from './toast.js';
import { saveTextToPath } from '../util/save-file.js';
import {
  generateTranscriptSRT,
  generateWordSRT,
  normalizeWordsPerCue,
} from '../exporters/transcript.js';

/**
 * The per-machine `.srt` export prefs (words per cue, punctuation removal) as
 * exporter options — shared with the auto-mode SRT path (srt-mode.js).
 * @returns {{ wordsPerCue: number, stripPunctuation: boolean }}
 */
export function srtExportOptions() {
  const a = state.whisperAdvanced;
  return {
    wordsPerCue: normalizeWordsPerCue(a.srtWordsPerCue),
    stripPunctuation: a.srtStripPunctuation === true,
  };
}

/**
 * Polish label for the word-mode cue size, used in success toasts:
 * 1 → "słowo-po-słowie", 3 → "po 3 słowa", 5 → "po 5 słów".
 * @param {number} n - words per cue
 * @returns {string}
 */
export function wordCueLabel(n) {
  if (n <= 1) return 'słowo-po-słowie';
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
  return `po ${n} ${few ? 'słowa' : 'słów'}`;
}

// True when at least one sentence carries a word with finite frame timing —
// i.e. frame-normalized word data the word exporter can actually emit.
function hasFrameWords(sentences = state.sentences) {
  return sentences.some(
    (s) =>
      Array.isArray(s.words) &&
      s.words.some(
        (w) => Number.isFinite(w.start_frame) && Number.isFinite(w.end_frame),
      ),
  );
}

/**
 * Default filename stem for transcript exports — the loaded SRT/VTT name minus
 * its extension, or a Polish fallback. Shared with export-popover.js (VTT).
 * @returns {string}
 */
export function transcriptBase() {
  return (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
}

/**
 * Build the transcript SRT honoring the word-by-word toggle — the single source
 * of the word-vs-sentence decision, shared by the file `.srt` export and the
 * Mode C Resolve subtitle push so neither silently degrades to phrases when
 * word-by-word is on. Mode OFF → sentence-level. Mode ON → per-word, auto-aligning
 * first when no frame-level word timing exists yet (heavy ~37–67s cold spawn,
 * behind an ask() confirmation). Returns the SRT string, or `null` when the
 * export should abort — every abort path surfaces a Polish toast, never silent.
 * Both modes honor the words-per-cue / punctuation prefs ({@link srtExportOptions}).
 * @param {import('../state.js').Sentence[]} [sentences] - subset to emit
 *   (defaults to the full transcript); the Mode C In/Out-range push passes a
 *   range-filtered subset so word/sentence selection stays identical.
 * @returns {Promise<{ content: string, wordLevel: boolean, wordsPerCue: number } | null>}
 */
export async function buildTranscriptSrt(sentences = state.sentences) {
  if (!sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return null;
  }
  const opts = srtExportOptions();
  // Mode OFF → sentence-level .srt.
  if (!state.whisperAdvanced.wordLevelSrtExport) {
    return {
      content: generateTranscriptSRT(sentences, state.fps, {
        stripPunctuation: opts.stripPunctuation,
      }),
      wordLevel: false,
      wordsPerCue: opts.wordsPerCue,
    };
  }
  // Mode ON → word-by-word .srt. Needs frame-based words[]; auto-align when
  // missing (heavy, ~37–67s cold spawn) only when a video is loaded. We never
  // fall through to sentence-level here — word-by-word means word-by-word.
  if (!hasFrameWords(sentences)) {
    const videoPath = state.videoPath || state._whisperVideoPath;
    if (!videoPath) {
      toast(
        'Najpierw wybierz plik wideo, aby dopasować napisy do audio.',
        'info',
      );
      return null;
    }
    const { alignToWords } = await import('./import/transcribe.js');
    const ok = await alignToWords({ confirm: true });
    if (!ok) return null; // declined/cancelled/failed — alignToWords surfaced why
    if (!hasFrameWords(sentences)) {
      // Align finished but produced no frame-level word timing.
      toast(
        'Dopasowanie nie wygenerowało słów na poziomie ramek — eksport słowo-po-słowie niemożliwy.',
        'info',
      );
      return null;
    }
  }
  return {
    content: generateWordSRT(sentences, state.fps, opts),
    wordLevel: true,
    wordsPerCue: opts.wordsPerCue,
  };
}

/**
 * Save the transcript as `.srt`, honoring the word-by-word toggle (see
 * {@link buildTranscriptSrt}).
 * @returns {Promise<void>}
 */
export async function exportTranscriptSrt() {
  const built = await buildTranscriptSrt();
  if (!built) return;
  const saved = await saveTextToPath({
    defaultName: transcriptBase() + '.srt',
    content: built.content,
  });
  if (saved) {
    toast(
      built.wordLevel
        ? `Zapisano napisy ${wordCueLabel(built.wordsPerCue)}`
        : 'Zapisano transkrypcję',
      'success',
    );
  }
}
