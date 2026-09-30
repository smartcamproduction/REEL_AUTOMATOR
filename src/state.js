/**
 * A single word with frame-converted timing, produced by the WhisperX engine's
 * forced alignment and persisted on its sentence (.reelproj schema v4).
 * @typedef {Object} Word
 * @property {string} text
 * @property {number} start_frame
 * @property {number} end_frame
 * @property {string} [speaker] - diarization speaker label (opt-in, additive)
 */

/**
 * A parsed transcript segment. Produced by `parseSRT`/`parseVTT` (imported
 * transcripts) and by `segmentFromWords` (engine output); both converge on this
 * shape, consumed by the exporters and the reel editor.
 * @typedef {Object} Sentence
 * @property {number} id
 * @property {string} text
 * @property {number} start_frame
 * @property {number} end_frame
 * @property {number} duration_frame
 * @property {string} start_tc
 * @property {string} end_tc
 * @property {number} [source_idx] - F18 multi-source index (0 = primary)
 * @property {Word[]} [words] - word-level timings (engine/align path only)
 */

import {
  DEFAULT_SCORING_GUIDANCE,
  DEFAULT_CLUSTER_GUIDANCE,
  DEFAULT_CURATE_GUIDANCE,
} from './ai/prompt.js';

/**
 * A reusable userPrompt preset stored in the local library.
 * @typedef {Object} PromptPreset
 * @property {string} id - unique identifier (crypto.randomUUID or builtin-* slug)
 * @property {string} name - display name shown in the picker
 * @property {string} userPrompt - the prompt text applied to the textarea on selection
 */

/**
 * Auto-mode (S-07) stage-selection + output config (Phase 3). Transcription
 * always carries its alignment + optional diarization + word settings from the
 * Step-1 WhisperX box — it is one toggle, not separate align/diarize toggles.
 * @typedef {Object} AutoStages
 * @property {boolean} transcription - run WhisperX transcription (+align/+diarize)
 * @property {boolean} segmentation - produce segments from the transcript
 * @property {boolean} analysis - run the S-25 AI reel selection
 * @property {boolean} export - write the selected outputs after the run
 *
 * @typedef {Object} AutoOutputs
 * @property {boolean} srt - sentence-level `.srt` transcript
 * @property {boolean} vtt - `.vtt` transcript
 * @property {boolean} md - segment listing `.md`
 * @property {boolean} wordJson - word-level timing JSON
 * @property {boolean} edl - EDL timeline (requires reels)
 * @property {boolean} xml - FCP7 XML timeline (requires reels)
 * @property {boolean} lua - DaVinci Resolve Lua (requires reels)
 *
 * Auto-mode (S-07) run + config state. Phase 1 carries the transient run flags
 * the floating panel and the surface read-only gating read; Phase 3 adds the
 * `stages`/`outputs` selection; the batch queue (Phase 4) extends this block.
 * @typedef {Object} BatchItem
 * @property {string} path - absolute source video path
 * @property {string} name - display file name (basename of `path`)
 * @property {'pending'|'running'|'done'|'error'} status - per-video progress
 *
 * @typedef {Object} AutoMode
 * @property {boolean} running - true while an auto-pipeline run is in flight
 * @property {string|null} activeStage - id of the live stage ('transcribe' |
 *   'analyze' | …), or null when idle
 * @property {AutoStages} stages - which pipeline stages the run executes
 * @property {AutoOutputs} outputs - which files the export stage produces
 * @property {BatchItem[]} batchQueue - videos queued for headless batch (Phase 4)
 * @property {string|null} batchFolder - folder the batch writes outputs into
 */

/**
 * A scored reel produced by AI selection (S-01). All scored fields are
 * optional for backward-compat — older projects / providers may omit them.
 * @typedef {Object} Reel
 * @property {string} reel_name
 * @property {number[]} clip_ids - sentence ids selected for this reel
 * @property {number} [virality_score] - overall 0–100
 * @property {{hook:number, flow:number, value:number, trend:number}} [scores] - axis sub-scores
 * @property {string} [reason] - one-sentence justification
 * @property {{hook?:number, body?:number, punchline?:number}} [markers] - each value is a member of clip_ids
 * @property {number} [ai_order] - stable original LLM order (S-02), stamped at ingest
 */

export const state = {
  // step 1
  srtName: null,
  srtContent: null,
  fps: 25,
  videoFilename: '',
  gapFrames: 60,
  sentences: [],

  // step 2
  userPrompt: `Stwórz viralowe reelsy sprzedażowe z tego webinaru.

Zasady:
- Każdy Reel: HOOK (mocny wstęp) → BODY (rozwinięcie) → CTA (wezwanie do działania)
- Długość: 30–90 sekund
- Możesz zmieniać kolejność segmentów zachowując logiczny sens
- Szukaj emocjonalnych momentów, konkretnych liczb, historii i CTA
- Stwórz tyle Reelsów ile możesz z wartościowego materiału`,
  // FR-015: editable global scoring guidance. Defaults to the machine guidance;
  // boot override comes from loadSettings(); round-trips in .reelproj v6.
  systemPrompt: DEFAULT_SCORING_GUIDANCE,
  // S-25 Phase 3: editable Stage-1 (cluster) and Stage-2 (curate) guidances for
  // the cluster→curate pipeline. Persist/round-trip via the settings bag like
  // `systemPrompt`; boot override comes from loadSettings().
  clusterPrompt: DEFAULT_CLUSTER_GUIDANCE,
  curatePrompt: DEFAULT_CURATE_GUIDANCE,
  // FR-016: in-memory preset library. Populated at boot from localStorage
  // (edl_prompt_presets) by seedPresetsIfEmpty + loadPresets in main.js.
  /** @type {PromptPreset[]} */
  promptPresets: [],
  reelsData: [],
  // S-02: active reel sort mode — 'score_desc' | 'score_asc' | 'ai'.
  // Drives the physical order of reelsData (WYSIWYG export); round-trips in .reelproj v7.
  reelSort: 'score_desc',

  // step 3
  videoPath: '',
  videoResolution: '1920x1080',
  projectName: 'Reels',
  mergeThreshold: 12,
  edlContent: '',
  xmlContent: '',
  luaContent: '',
  fcpxmlContent: '',

  // openrouter
  orAllModels: [],
  // Single-shot / legacy / Phase-2 test model (flat scalar). The cluster→curate
  // pipeline (S-25) uses the `aiModels` pair below instead.
  orSelectedModel: null,
  // S-25 Phase 3: two-model tiering for the cluster→curate pipeline. Machine-
  // global (persisted to localStorage `edl_or_model_cluster`/`_curate`), NOT in
  // .reelproj — model selection is per-machine, not per-project (research §D).
  aiModels: { cluster: null, curate: null },
  // S-25 Phase 4: cluster→curate pipeline mode. 'auto' collapses to the legacy
  // single-shot call below PIPELINE_AUTO_THRESHOLD segments and runs the pipeline
  // above it; 'single'/'pipeline' force one path. Machine-global, persisted via
  // the settings bag (edl_app_settings), NOT in .reelproj.
  aiPipelineMode: 'auto',

  // Phase 4 F1 / S-05 model manager
  modelId: '', // selected managed faster-whisper model id (S-05)
  whisperLanguage: 'pl',
  diarize: false, // opt-in speaker diarization (S-05 Phase 6)

  // S-05 Phase 7 — WhisperX advanced-settings modal. A minimal high-value
  // subset of engine tuning knobs; omitted/empty values fall back to the
  // engine's defaults (untouched modal = no behavior change). The perf/device
  // knobs (device, computeType) are persisted PER-MACHINE in localStorage
  // (`edl_whisper_advanced`), never in .reelproj; the rest are live in state.
  whisperAdvanced: {
    device: '', // '' = auto, 'cpu' = wymuś CPU
    computeType: '', // '' = domyślny (float16 GPU / int8 CPU); float16|int8|int8_float16|float32
    beamSize: null, // null = domyślny (5)
    initialPrompt: '', // '' = brak
    vadOnset: null, // null = domyślny (0.5)
    vadOffset: null, // null = domyślny (0.363)
    minSpeakers: null, // diaryzacja: null = auto
    maxSpeakers: null, // diaryzacja: null = auto
    // S-19 word-by-word .srt export mode. Per-machine preference persisted in
    // localStorage alongside device/computeType — never written to .reelproj.
    wordLevelSrtExport: false,
    // Words grouped into one cue when wordLevelSrtExport is on (1 = classic
    // word-by-word), and whether `.srt` exports drop punctuation. Per-machine
    // export prefs persisted with wordLevelSrtExport — never written to .reelproj.
    srtWordsPerCue: 1,
    srtStripPunctuation: false,
    // Cohere-only run knob (local-cohere-transcription Phase 4): honored only on
    // the native Cohere engine path; ignored by the WhisperX/CT2 path. Rust
    // defaults it on when unset, so an older state shape transcribes unchanged.
    punctuation: true,
  },

  // S-07 auto-mode: transient one-click run state (config/batch fields added in
  // later phases). Never persisted to .reelproj.
  /** @type {AutoMode} */
  autoMode: {
    running: false,
    activeStage: null,
    // Defaults reproduce the Phase 1/2 full pipeline (transcribe → segment →
    // analyze) with export opt-in: a freshly opened panel + "Uruchom" behaves
    // like the original one-click run until the user toggles Eksport + formats.
    stages: {
      transcription: true,
      segmentation: true,
      analysis: true,
      export: false,
    },
    outputs: {
      srt: false,
      vtt: false,
      md: false,
      wordJson: false,
      edl: false,
      xml: false,
      lua: false,
    },
    // S-07 Phase 4 — headless batch: a sequential queue of videos, each
    // processed end-to-end and written to one folder picked once at start.
    // Never mutates the single-document surface; never persisted to .reelproj.
    /** @type {BatchItem[]} */
    batchQueue: [],
    /** @type {string|null} */
    batchFolder: null,
  },
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  listeners.forEach((fn) => fn(state));
}
