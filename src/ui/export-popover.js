// Quick-export popover (S-16 Phase 3b, was step3-export.js). The export step is
// now a compact popover: EDL / XML / Lua up front, transcript (.srt/.vtt),
// segment .md and prompt-copy behind a "more" expander. The source-file card in
// the export section is read-only — its fps/filename/resolution are
// auto-detected at import (`probe_video_metadata`), so XML keeps real
// dimensions without manual entry. All generator fns are reused unchanged.

import { state, emit } from '../state.js';
import { generateEDL } from '../exporters/edl.js';
import { generateXML } from '../exporters/xml.js';
import { generateLua } from '../exporters/lua.js';
import { generateFCPXML } from '../exporters/fcpxml.js';
import { buildResolveTimeline } from '../exporters/resolve-payload.js';
import {
  generateTranscriptVTT,
  generateSegmentsMd,
} from '../exporters/transcript.js';
import { buildPrompt } from '../ai/prompt.js';
import { saveTextToPath } from '../util/save-file.js';
import { stripExt } from '../util/filename.js';
import { toast } from './toast.js';
import {
  exportTranscriptSrt,
  buildTranscriptSrt,
  transcriptBase,
  wordCueLabel,
} from './export-srt.js';
import {
  isElectron,
  resolveCapability,
  resolveCreateReels,
  resolveImportSubtitles,
  resolveTimelineInOut,
} from '../platform/adapter.js';

export function init() {
  // Export trigger now lives in the header (next to Settings) and the sidebar
  // step cue — openable at any stage, not just a final page section. Each
  // format guards its own prerequisites, so an early open is harmless.
  document
    .getElementById('openExportBtn')
    ?.addEventListener('click', openPopover);
  document.getElementById('nav3')?.addEventListener('click', openPopover);
  document
    .getElementById('exportClose')
    ?.addEventListener('click', closePopover);
  const modal = document.getElementById('exportModal');
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closePopover();
  });

  // Primary formats — generate + save, or copy.
  document
    .getElementById('exEdlGen')
    ?.addEventListener('click', () => saveFormat('edl'));
  document
    .getElementById('exEdlCopy')
    ?.addEventListener('click', () => copyFormat('edl'));
  document
    .getElementById('exXmlGen')
    ?.addEventListener('click', () => saveFormat('xml'));
  document
    .getElementById('exXmlCopy')
    ?.addEventListener('click', () => copyFormat('xml'));
  document
    .getElementById('exLuaGen')
    ?.addEventListener('click', () => saveFormat('lua'));
  document
    .getElementById('exLuaCopy')
    ?.addEventListener('click', () => copyFormat('lua'));
  document
    .getElementById('exFcpxmlGen')
    ?.addEventListener('click', () => saveFormat('fcpxml'));
  document
    .getElementById('exFcpxmlCopy')
    ?.addEventListener('click', () => copyFormat('fcpxml'));

  // S-09 Mode D: one-click hand-off to the live DaVinci Resolve project (Electron
  // WI panel only; the row stays hidden unless the Resolve API is available).
  document
    .getElementById('exResolveGen')
    ?.addEventListener('click', exportToResolve);

  // S-09 Mode C: one-click push of the transcript onto a Resolve Subtitles track
  // (Electron WI panel only; the row stays hidden unless the Resolve API is
  // available).
  document
    .getElementById('exResolveSubs')
    ?.addEventListener('click', exportSubtitlesToResolve);

  // "More" — transcript + segments + prompt.
  document
    .getElementById('exSrtBtn')
    ?.addEventListener('click', exportTranscriptSrt);
  document.getElementById('exVttBtn')?.addEventListener('click', exportVTT);
  document.getElementById('exMdBtn')?.addEventListener('click', exportMD);
  document.getElementById('exPromptBtn')?.addEventListener('click', copyPrompt);
}

// ── Popover open/close ─────────────────────────────────────────────

export function openPopover() {
  // Open at any stage — transcript/.md/prompt export is useful before reels
  // exist; the EDL/XML/Lua buttons each guard on `reelsData` themselves.
  updateSummary();
  applyResolveExportMode();
  const modal = document.getElementById('exportModal');
  if (modal) modal.style.display = 'flex';
}

// S-09: inside the DaVinci Resolve WI panel (Electron), choose the export face by
// live Resolve availability. When the scripting API is reachable (Studio + open
// project), reveal the one-click "Wyślij do Resolve" row (Mode D). When it is
// unavailable (Resolve Free / non-Studio / no open project / missing bridge),
// surface a one-time Polish notice so the editor knows why the hand-off isn't
// offered and falls back to the S-08 file-export set. No-op under Tauri/browser
// (no Resolve host → neither the row nor the notice).
async function applyResolveExportMode() {
  if (!isElectron()) return;
  const body = document.querySelector('#exportModal .modal-body');
  if (!body) return;
  let cap;
  try {
    cap = await resolveCapability();
  } catch {
    cap = { available: false };
  }
  const row = document.getElementById('resolveExportRow');
  const subsRow = document.getElementById('resolveSubtitlesRow');
  if (cap.available) {
    if (row) row.style.display = '';
    if (subsRow) subsRow.style.display = '';
    return; // Studio: API drive available — no fallback notice
  }
  if (row) row.style.display = 'none';
  if (subsRow) subsRow.style.display = 'none';
  if (document.getElementById('resolveFallbackNotice')) return;
  const note = document.createElement('div');
  note.id = 'resolveFallbackNotice';
  note.className = 'info-box';
  note.style.marginBottom = '16px';
  note.style.fontSize = '12px';
  note.textContent =
    'Brak dostępu do API DaVinci Resolve (Resolve Free lub brak otwartego projektu) — eksport do plików.';
  body.insertBefore(note, body.firstChild);
}

function closePopover() {
  const modal = document.getElementById('exportModal');
  if (modal) modal.style.display = 'none';
}

// Refreshes the export summary badges. Folded into the popover open. Source-file
// fields (fps/filename/path/resolution) now live in the Settings modal.
export function updateSummary() {
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  setText('sumSegs', state.sentences.length + ' segmentów');
  setText('sumReels', state.reelsData.length + ' reelsów');
  setText('sumClips', totalClips + ' klipów');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── Generators (reuse exporter fns unchanged) ──────────────────────

function genEDL() {
  return generateEDL({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoFilename: state.videoFilename || 'source_video.mp4',
    mergeThreshold: state.mergeThreshold,
  });
}

function genXML() {
  const videoFile = state.videoFilename || 'source_video.mp4';
  return generateXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath: state.videoPath || videoFile,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

function genLua() {
  if (!state.videoPath) {
    toast(
      'Brak ścieżki wideo — wybierz plik wideo (sekcja Import lub „Przeglądaj").',
      'info',
    );
    return null;
  }
  return generateLua({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoPath: state.videoPath,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

function genFCPXML() {
  if (!state.videoPath) {
    toast(
      'Brak ścieżki wideo — wybierz plik wideo (sekcja Import lub „Przeglądaj").',
      'info',
    );
    return null;
  }
  const videoFile = state.videoFilename || 'source_video.mp4';
  return generateFCPXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath: state.videoPath,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

const FORMATS = {
  edl: {
    gen: genEDL,
    ext: 'edl',
    suffix: '_timeline.edl',
    store: 'edlContent',
  },
  xml: {
    gen: genXML,
    ext: 'xml',
    suffix: '_timeline.xml',
    store: 'xmlContent',
  },
  lua: { gen: genLua, ext: 'lua', suffix: '_davinci.lua', store: 'luaContent' },
  fcpxml: {
    gen: genFCPXML,
    ext: 'fcpxml',
    suffix: '_timeline.fcpxml',
    store: 'fcpxmlContent',
  },
};

async function saveFormat(key) {
  if (!state.reelsData.length) {
    toast('Brak danych reelsów!', 'info');
    return;
  }
  const f = FORMATS[key];
  const content = f.gen();
  if (content == null) return; // genLua already surfaced the missing-path toast
  state[f.store] = content;
  emit();
  const saved = await saveTextToPath({
    defaultName: videoBase() + f.suffix,
    content,
  });
  if (saved) toast('Zapisano plik', 'success');
}

async function copyFormat(key) {
  if (!state.reelsData.length) {
    toast('Brak danych reelsów!', 'info');
    return;
  }
  const f = FORMATS[key];
  const content = f.gen();
  if (content == null) return;
  state[f.store] = content;
  emit();
  await copyText(content);
}

// ── Mode D — reels → Resolve timeline (S-09 Phase 2) ───────────────
// One-click hand-off into the live DaVinci Resolve project: a dated Media-Pool
// folder with a single timeline holding every reel, separated by the inter-reel
// gap from settings (`state.gapFrames`) — the same layout as the Lua export. The
// renderer builds a pure clip + marker payload (`buildResolveTimeline`, 0-based —
// the regression-fenced Lua frame-math, NOT the EDL `3600*fps` CMX offset that
// would push every clip an hour in) and the Electron backend drives the live
// Resolve API directly (`ImportMedia` → `CreateEmptyTimeline` → `AppendToTimeline`
// → `AddMarker`). `ImportTimelineFromFile`/FCPXML was rejected live (errorCode 6
// in the WI scripting scope). Gated on `resolve_available` (row hidden otherwise).

async function exportToResolve() {
  if (!state.reelsData.length) {
    toast('Brak danych reelsów!', 'info');
    return;
  }
  if (!state.videoPath) {
    toast(
      'Brak ścieżki wideo — wybierz plik wideo (sekcja Import lub „Przeglądaj").',
      'info',
    );
    return;
  }
  // Defensive re-check: the row is only shown when available, but state can move.
  let cap;
  try {
    cap = await resolveCapability();
  } catch {
    cap = { available: false };
  }
  if (!cap.available) {
    toast('Brak dostępu do API DaVinci Resolve.', 'error');
    return;
  }

  // Pure builder → { name, clips:[{startFrame,endFrame,recordFrame}], markers }.
  // One timeline with every reel: the record cursor runs continuously, with
  // `state.gapFrames` of empty timeline between consecutive reels (same as Lua).
  const timeline = buildResolveTimeline({
    reelsData: state.reelsData,
    sentences: state.sentences,
    mergeThreshold: state.mergeThreshold,
    gapFrames: state.gapFrames,
    name: state.projectName || 'Reels',
  });

  const btn = document.getElementById('exResolveGen');
  if (btn) btn.disabled = true;
  try {
    const res = await resolveCreateReels({
      folderName: datedFolderName(),
      mediaPaths: [state.videoPath],
      fps: state.fps,
      timeline,
    });
    const name = (res && res.timeline) || timeline.name;
    toast(`Utworzono timeline „${name}" w DaVinci Resolve`, 'success');
  } catch (e) {
    toast('Nie udało się utworzyć timeline w Resolve: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Dated Media-Pool folder name, local time, e.g. "Reels 2026-06-27 14-05".
function datedFolderName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Reels ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

// ── Mode C — transcript → Resolve subtitles track (S-09 Phase 3) ───────────
// One-click push of our already-built SRT onto the current timeline's subtitle
// track. The subtitles START AT THE TIMELINE In POINT: we read the In mark
// (`timeline.GetMarkInOut`, a 0-based frame offset = the same basis our cues use)
// and shift the whole transcript so its first cue lands exactly at In (Out is
// ignored). When no In point is set, the subtitles start at the timeline origin
// (offset 0). The word-vs-sentence decision is the SHARED `buildTranscriptSrt`
// (export-srt.js) — identical to the file `.srt` export — so word-by-word sends
// word-by-word here too (never silently degrading to phrases). The Electron
// backend writes the SRT to a temp file and imports it via the Media Pool
// (`ImportIntoTimeline` fallback); `CreateSubtitlesFromAudio` is never used (it
// re-transcribes, discarding our text). Gated on `resolve_available`.

/**
 * Return copies of `sentences` with every frame value (and per-word timing)
 * shifted by `delta` frames. Pure — does not touch `state`. Used to re-base the
 * transcript so its first cue lands at the timeline In point.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} delta - frames to add to every start/end
 * @returns {import('../state.js').Sentence[]}
 */
function shiftSentences(sentences, delta) {
  if (!delta) return sentences;
  return sentences.map((s) => ({
    ...s,
    start_frame: s.start_frame + delta,
    end_frame: s.end_frame + delta,
    words: Array.isArray(s.words)
      ? s.words.map((w) => ({
          ...w,
          start_frame: Number.isFinite(w.start_frame)
            ? w.start_frame + delta
            : w.start_frame,
          end_frame: Number.isFinite(w.end_frame)
            ? w.end_frame + delta
            : w.end_frame,
        }))
      : s.words,
  }));
}

async function exportSubtitlesToResolve() {
  if (!state.sentences.length) {
    toast('Brak transkrypcji do wysłania.', 'info');
    return;
  }
  // Defensive re-check: the row is only shown when available, but state can move.
  let cap;
  try {
    cap = await resolveCapability();
  } catch {
    cap = { available: false };
  }
  if (!cap.available) {
    toast('Brak dostępu do API DaVinci Resolve.', 'error');
    return;
  }

  // Shared word/sentence decision — honors the word-by-word toggle identically to
  // the file export (aligns when needed, aborts with a toast on failure). We run
  // it on the original transcript, then shift the resulting cues to the In point.
  const built = await buildTranscriptSrt();
  if (!built) return;

  // Start at the timeline In point: shift so the earliest cue lands exactly at
  // In (no Out filtering). No In mark set → push from the timeline origin.
  const range = await resolveTimelineInOut();
  let srt = built.content;
  if (range) {
    const firstStart = Math.min(...state.sentences.map((s) => s.start_frame));
    const delta = range.inFrame - firstStart;
    if (delta) {
      const built2 = await buildTranscriptSrt(
        shiftSentences(state.sentences, delta),
      );
      if (!built2) return;
      srt = built2.content;
    }
  }

  const btn = document.getElementById('exResolveSubs');
  if (btn) btn.disabled = true;
  try {
    await resolveImportSubtitles({ srt });
    const scope = range ? ' (od punktu In)' : '';
    toast(
      (built.wordLevel
        ? `Dodano napisy ${wordCueLabel(built.wordsPerCue)} w DaVinci Resolve`
        : 'Dodano napisy do osi czasu w DaVinci Resolve') + scope,
      'success',
    );
  } catch (e) {
    toast('Nie udało się dodać napisów w Resolve: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── "More" — transcript / segments / prompt ────────────────────────
// SRT export (sentence vs word-by-word) lives in ./export-srt.js, shared with
// the import-section "⬇ Eksport .srt" button so the toggle behaves identically.

async function exportVTT() {
  if (!state.sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return;
  }
  const saved = await saveTextToPath({
    defaultName: transcriptBase() + '.vtt',
    content: generateTranscriptVTT(state.sentences, state.fps),
  });
  if (saved) toast('Zapisano transkrypcję', 'success');
}

async function exportMD() {
  if (!state.sentences.length) {
    toast('Brak segmentów do eksportu.', 'info');
    return;
  }
  const saved = await saveTextToPath({
    defaultName: 'segmenty.md',
    content: generateSegmentsMd(state.sentences, state.fps, state.srtName),
  });
  if (saved) toast('Zapisano .md', 'success');
}

async function copyPrompt() {
  if (!state.sentences.length) {
    toast('Brak segmentów — najpierw przeanalizuj napisy.', 'info');
    return;
  }
  const content = buildPrompt(
    state.userPrompt,
    state.systemPrompt,
    state.sentences,
    null,
    state.videoFilename || '',
  );
  await copyText(content, 'Prompt skopiowany');
}

// ── utilities ──────────────────────────────────────────────────────

function videoBase() {
  return stripExt(state.videoFilename || 'reels');
}

async function copyText(content, okMsg = 'Skopiowano') {
  try {
    await navigator.clipboard.writeText(content);
    toast(okMsg, 'success');
  } catch {
    toast('Nie udało się skopiować — zaznacz i skopiuj ręcznie.', 'error');
  }
}
