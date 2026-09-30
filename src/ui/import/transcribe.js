// Import-section submodule: WhisperX transcription, the local model manager,
// the WhisperX advanced settings modal, diarization controls, force-align of an
// imported transcript, and transcript SRT/VTT export. (S-16 Phase 3a —
// structural split, no behavior change.)

import { state, emit } from '../../state.js';
import { toast } from '../toast.js';
import { segmentFromWords } from '../../parser/word-segments.js';
import {
  generateTranscriptVTT,
  normalizeWordsPerCue,
} from '../../exporters/transcript.js';
import { getApiKey, setApiKey } from '../../ai/api-key.js';
import { saveTextToPath } from '../../util/save-file.js';
import {
  invoke,
  dialogOpen,
  dialogAsk,
  listen,
  isElectron,
  resolveCapability,
  resolveCollectTimelineAudio,
} from '../../platform/adapter.js';
import { exportTranscriptSrt } from '../export-srt.js';
import { openFirstRunDeps } from '../first-run-deps.js';
import { populateVideoMeta } from '../../util/video-meta.js';
import {
  renderSegments,
  mergeWordsIntoSentences,
  loadSRTContent,
  escHtml,
} from './segments.js';
import { MIN_CHARS } from './constants.js';

// S-07: re-export so the auto-mode orchestrator + batch segment with the same
// minimum-sentence-length constant the manual transcribe path uses.
export { MIN_CHARS };

export function initTranscribe() {
  // S-05 — transcript align + export
  document
    .getElementById('alignTranscriptBtn')
    .addEventListener('click', alignImportedTranscript);
  document
    .getElementById('exportSrtBtn')
    .addEventListener('click', exportTranscriptSrt);
  document
    .getElementById('exportVttBtn')
    .addEventListener('click', exportTranscriptVTT);

  // S-05 — Built-in WhisperX transcription + model manager
  document
    .getElementById('browseWhisperVideoBtn')
    .addEventListener('click', browseWhisperVideo);
  document.getElementById('whisperLanguage').addEventListener('change', (e) => {
    state.whisperLanguage = e.target.value;
  });
  document
    .getElementById('transcribeBtn')
    .addEventListener('click', transcribeWithWhisper);
  document
    .getElementById('cancelTranscribeBtn')
    .addEventListener('click', cancelTranscribe);
  // Phase 6 — diarization toggle + HF token
  const diarizeToggle = document.getElementById('diarizeToggle');
  diarizeToggle.checked = state.diarize;
  const hfTokenInput = document.getElementById('hfTokenInput');
  hfTokenInput.value = getApiKey('huggingface');
  document.getElementById('diarizeTokenRow').style.display = state.diarize
    ? ''
    : 'none';
  diarizeToggle.addEventListener('change', (e) => {
    state.diarize = e.target.checked;
    document.getElementById('diarizeTokenRow').style.display = e.target.checked
      ? ''
      : 'none';
    emit();
  });
  hfTokenInput.addEventListener('input', (e) => {
    setApiKey('huggingface', e.target.value.trim());
  });
  // S-18 — manual full self-test (heavy align), the only path that earns the
  // authoritative green "Silnik gotowy" badge. The launch probe is the cheap
  // cached capability check (see refreshEngineReadiness).
  const fullVerifyBtn = document.getElementById('fullEngineVerifyBtn');
  if (fullVerifyBtn) fullVerifyBtn.addEventListener('click', fullEngineVerify);
  initModelManager();
  initWhisperAdvanced();

  // S-29 Phase 4 — transcription readiness gate. Transcription needs the heavy
  // engine/ffmpeg deps (thin installer downloads them on first run); import,
  // SRT-paste and export do NOT. Wire the "Pobierz zależności" CTA to the setup
  // screen and re-check readiness whenever deps change (a download or a variant
  // switch dispatches `deps-changed`).
  const depsCtaBtn = document.getElementById('openDepsSetupBtn');
  if (depsCtaBtn)
    depsCtaBtn.addEventListener('click', () => openFirstRunDeps());
  document.addEventListener('deps-changed', refreshTranscribeReadiness);
  // The badge must follow too: staging an engine mid-session changes which binary
  // resolves, and `verify_staged_engine` files a fresh verdict under the new
  // readiness key. Without this the badge keeps painting the pre-download verdict
  // (or "niezweryfikowany") until the next launch.
  document.addEventListener('deps-changed', refreshEngineReadiness);
  refreshTranscribeReadiness();

  // S-09 Mode A — wire the "Z osi czasu Resolve" button. It renders the active
  // timeline's audio mix as the transcription input ON CLICK (not on panel open),
  // and is shown only inside the Resolve WI panel when the scripting API is
  // available (resolveCapability/state.fps were already resolved + seeded in
  // main.js before this init ran; the verdict is memoized).
  const collectBtn = document.getElementById('collectTimelineAudioBtn');
  if (collectBtn) {
    collectBtn.addEventListener('click', collectTimelineAudioFromResolve);
    showResolveAudioButtonIfAvailable();
  }
}

/**
 * Reveal the "Z osi czasu Resolve" button only inside the Resolve WI panel when
 * the scripting API is available; it stays hidden under Tauri/browser and on
 * Resolve Free / non-Studio (no API). Never throws.
 * @returns {Promise<void>}
 */
async function showResolveAudioButtonIfAvailable() {
  const btn = document.getElementById('collectTimelineAudioBtn');
  if (!btn) return;
  if (!isElectron()) return; // stays hidden under Tauri/browser
  try {
    const cap = await resolveCapability();
    btn.style.display = cap && cap.available ? '' : 'none';
  } catch {
    btn.style.display = 'none';
  }
}

/**
 * S-09 Mode A (button-triggered): render the active Resolve timeline's audio mix
 * and present it as the transcription input. Render-to-file is the only
 * auto-collect path (it captures the real timeline MIX); on unavailability or
 * failure it leaves the manual picker untouched and shows a Polish notice (never a
 * blind source-clip decode). Never throws — a failure restores the previous path.
 * @returns {Promise<void>}
 */
async function collectTimelineAudioFromResolve() {
  const btn = document.getElementById('collectTimelineAudioBtn');
  const pathEl = document.getElementById('whisperVideoPath');
  const prev = pathEl ? pathEl.value : '';
  if (btn) btn.disabled = true;
  if (pathEl) pathEl.value = 'Renderowanie audio z aktywnej osi czasu Resolve…';
  try {
    const res = await resolveCollectTimelineAudio();
    if (res && res.ok && res.path) {
      state._whisperVideoPath = res.path;
      if (pathEl) pathEl.value = res.path;
      // fps is already seeded from the live timeline (Phase 1); deliberately do
      // NOT probe the audio-only wav — it has no video stream, so populateVideoMeta
      // would clobber the authoritative Resolve fps.
      syncTranscribeBtn();
      syncAlignBtn();
      emit();
      toast('Pobrano audio z aktywnej osi czasu Resolve.', 'success');
    } else {
      if (pathEl) pathEl.value = prev;
      toast(
        'Nie udało się pobrać audio z osi czasu Resolve — wybierz plik ręcznie.',
        'info',
      );
    }
  } catch {
    if (pathEl) pathEl.value = prev;
    toast(
      'Nie udało się pobrać audio z osi czasu Resolve — wybierz plik ręcznie.',
      'info',
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── F1 Whisper transcription ──────────────────────────────────────

function syncTranscribeBtn() {
  const hasVideo = !!state._whisperVideoPath;
  const hasModel = !!state.modelId && !!_modelStatus[state.modelId]?.downloaded;
  document.getElementById('transcribeBtn').disabled = !(
    hasVideo &&
    hasModel &&
    _depsReady
  );
}

// S-29 Phase 4: are the heavy engine/ffmpeg deps resolvable (spawn-free read)?
// Defaults true so plain browser dev (no backend) and existing bundled installs
// are never falsely gated — `transcription_ready` reports true whenever the
// engine resolves anywhere (staged deps → bundle → repo binaries/), so only a
// truly deps-less thin install disables transcription.
let _depsReady = true;

/**
 * Re-read the spawn-free deps-readiness gate (S-18) and reflect it on the
 * transcribe button + the "Pobierz zależności" CTA. Never throws — a missing
 * backend leaves transcription un-gated.
 * @returns {Promise<void>}
 */
async function refreshTranscribeReadiness() {
  try {
    _depsReady = await invoke('transcription_ready');
  } catch (e) {
    _depsReady = true; // no backend / can't tell → don't gate
  }
  const cta = document.getElementById('depsMissingCta');
  if (cta) cta.style.display = _depsReady ? 'none' : '';
  syncTranscribeBtn();
}

// ── S-05 model manager ────────────────────────────────────────────────

/** @type {Record<string,{downloaded:boolean,path?:string}>} */
let _modelStatus = {};
let _downloadingId = null;

// Per-machine: the last-selected WhisperX model id. Persisted so the choice is
// remembered across sessions (and available to auto/batch runs without a loaded
// project). NOT written to .reelproj — model availability is per-machine.
const MODEL_LS_KEY = 'edl_whisper_model';

/**
 * Restore the remembered model selection from localStorage when nothing has set
 * it yet (a loaded project takes precedence). Only restores a model that is
 * still downloaded on this machine, so a stale id can't disable transcription.
 * @returns {void}
 */
function restoreSelectedModel() {
  if (state.modelId) return; // a loaded project already chose one
  try {
    const saved = localStorage.getItem(MODEL_LS_KEY);
    if (saved && _modelStatus[saved]?.downloaded) {
      state.modelId = saved;
      emit();
    }
  } catch (e) {}
}

async function initModelManager() {
  // Render the model list immediately. The launch badge is a pure cache READ
  // (whisperx_engine_cached) — it never spawns the sidecar, because even the
  // "cheap" probe pays a 37–67 s cold cost (290 MB onefile extraction + torch
  // import). The badge paints only from a prior "Pełna weryfikacja" result; a
  // miss invites the user to run it on demand. Kick it off without awaiting.
  await refreshModelStatus();
  restoreSelectedModel();
  await renderModelManager();
  refreshEngineReadiness();
}

/**
 * Describe the engine's devices. Since S-30 the ASR device (CTranslate2) and the torch
 * device (VAD / alignment / diarization) can legitimately differ: the shipping Windows
 * GPU build transcribes on `cuda` and aligns on CPU torch, while macOS transcribes on
 * `cpu` and aligns on `mps`. A single value cannot say that, so name both. A verdict
 * cached by a pre-S-30 build carries only the old `device` string — degrade to it rather
 * than inventing a pair.
 * @param {{device?:string, gpu?:boolean, ct2_device?:string, torch_device?:string}} status
 * @returns {string}
 */
function deviceLabel(status) {
  if (status.ct2_device && status.torch_device)
    return `transkrypcja: ${status.ct2_device} · dopasowanie: ${status.torch_device}`;
  return `${status.device || 'cpu'}${status.gpu ? ', GPU' : ''}`;
}

/**
 * Paint the engine-readiness badge from a status verdict.
 * @param {HTMLElement|null} el
 * @param {{ok:boolean, device?:string, gpu?:boolean, alignment_model_ready?:boolean, ct2_device?:string, torch_device?:string, audio_decode_ready?:boolean}} status
 * @param {{authoritative:boolean}} opts - `authoritative` is true ONLY for the full
 *   `--selftest` path, which is the sole path allowed to paint the green "Silnik gotowy"
 *   tier. The cheap capability probe cannot `import whisperx`, so it cannot verify the
 *   frozen import chain (the false-positive documented in whisperx_engine.py) — it paints
 *   the distinct, non-authoritative amber "Silnik wykryty" tier instead.
 *
 *   `audio_decode_ready === false` outranks both tiers: an engine that cannot decode a
 *   single frame of audio cannot transcribe, whatever else it reports — and a green badge
 *   is exactly what certified the machine in the bug this check exists to abolish. Only an
 *   EXPLICIT `false` blocks; `undefined` (an engine staged before the field existed, or a
 *   `--capability` verdict, which never decodes) means "unknown" and paints as it always
 *   did.
 */
function renderEngineBadge(el, status, { authoritative }) {
  if (!el) return;
  if (status.ok) {
    const dev = deviceLabel(status);
    if (status.audio_decode_ready === false) {
      el.textContent =
        'Silnik nie potrafi zdekodować audio — brak działającego FFmpeg. ' +
        'Sprawdź ZALEŻNOŚCI i pobierz FFmpeg.';
      el.style.color = 'var(--red)';
    } else if (authoritative) {
      el.textContent = `Silnik gotowy (${dev})${status.alignment_model_ready ? ', model dopasowania wbudowany' : ''}`;
      el.style.color = 'var(--green)';
    } else {
      el.textContent = `Silnik wykryty (${dev}) — pełna weryfikacja zalecana`;
      el.style.color = 'var(--amber)';
    }
  } else {
    el.textContent =
      'Silnik WhisperX nie jest jeszcze zbudowany. Uruchom sidecar/build.sh.';
    el.style.color = 'var(--amber)';
  }
}

async function refreshEngineReadiness() {
  const el = document.getElementById('engineReadyIndicator');
  if (!el) return;
  try {
    // Pure cache read — never spawns the sidecar (see initModelManager). `null`
    // = no prior verification on this machine for the current engine version.
    const s = await invoke('whisperx_engine_cached');
    if (s) {
      // Cached verdict carries its own `authoritative` flag (true only when a
      // full self-test wrote it), so the badge paints the correct tier.
      renderEngineBadge(el, s, { authoritative: !!s.authoritative });
    } else {
      el.textContent =
        'Silnik niezweryfikowany — kliknij „Pełna weryfikacja silnika”.';
      el.style.color = 'var(--text3)';
    }
  } catch (e) {
    el.textContent = 'Nie można sprawdzić silnika: ' + e;
    el.style.color = 'var(--amber)';
  }
}

// Manual full self-test: the heavy `--selftest` (loads the align model, runs a
// real forced-align) — also refreshes the Rust readiness cache. The only path
// that earns the authoritative green badge.
async function fullEngineVerify() {
  const el = document.getElementById('engineReadyIndicator');
  const btn = document.getElementById('fullEngineVerifyBtn');
  if (btn) btn.disabled = true;
  if (el) {
    el.textContent = 'Pełna weryfikacja silnika…';
    el.style.color = 'var(--text3)';
  }
  try {
    const s = await invoke('whisperx_engine_check');
    renderEngineBadge(el, s, { authoritative: true });
  } catch (e) {
    if (el) {
      el.textContent = 'Nie można sprawdzić silnika: ' + e;
      el.style.color = 'var(--amber)';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshModelStatus() {
  try {
    const { MODEL_REGISTRY } =
      await import('../../transcription/model-registry.js');
    const list = await invoke('list_models', {
      // Pass each model's readiness sentinel so non-CT2 models (Cohere →
      // model.safetensors) report "downloaded" correctly; CT2 omits it (Rust
      // defaults to model.bin).
      models: MODEL_REGISTRY.map((m) => ({ id: m.id, sentinel: m.sentinel })),
    });
    _modelStatus = {};
    for (const s of list) _modelStatus[s.id] = s;
  } catch (e) {
    _modelStatus = {};
  }
  syncTranscribeBtn();
}

export async function renderModelManager() {
  const container = document.getElementById('modelManagerList');
  if (!container) return;
  const { MODEL_REGISTRY, formatBytes } =
    await import('../../transcription/model-registry.js');
  // Compact dropdown picker: one <option> per registry model, annotated with
  // size + download status. Selecting a downloaded model makes it active;
  // selecting a missing one surfaces the ⬇ Pobierz button beside the dropdown.
  const options = MODEL_REGISTRY.map((m) => {
    const st = _modelStatus[m.id] || {};
    const status = st.downloaded ? 'Pobrany' : 'Brak';
    const sel = state.modelId === m.id ? ' selected' : '';
    return `<option value="${m.id}"${sel}>${escHtml(m.label)} — ${status}</option>`;
  }).join('');

  const selModel = MODEL_REGISTRY.find((m) => m.id === state.modelId);
  const selDownloaded = !!(selModel && _modelStatus[selModel.id]?.downloaded);
  const showDownload = !!selModel && !selDownloaded;
  const disabledAttr = _downloadingId ? 'disabled' : '';

  container.innerHTML = `
<div style="display:flex;gap:8px;align-items:center;">
  <select id="modelSelect" style="flex:1;min-width:0;font-size:13px;" ${disabledAttr}>
    <option value=""${state.modelId ? '' : ' selected'} disabled>— wybierz model —</option>
    ${options}
  </select>
  ${
    showDownload
      ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;white-space:nowrap;" data-download-model="${selModel.id}" ${disabledAttr}>Pobierz</button>`
      : ''
  }
  ${
    selDownloaded
      ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;white-space:nowrap;" data-delete-model="${selModel.id}" ${disabledAttr}>Usuń</button>`
      : ''
  }
</div>
<div class="model-dl-progress" id="modelDlProgress" style="display:none;font-size:11px;color:var(--text2);margin-top:6px;"></div>`;

  const sel = container.querySelector('#modelSelect');
  if (sel) sel.addEventListener('change', () => selectModel(sel.value));
  const dlBtn = container.querySelector('[data-download-model]');
  if (dlBtn) {
    dlBtn.addEventListener('click', () =>
      downloadModel(dlBtn.dataset.downloadModel),
    );
  }
  const delBtn = container.querySelector('[data-delete-model]');
  if (delBtn) {
    delBtn.addEventListener('click', () =>
      deleteModel(delBtn.dataset.deleteModel),
    );
  }
}

async function deleteModel(id) {
  const { getModel } = await import('../../transcription/model-registry.js');
  const model = getModel(id);
  const label = model ? model.label : id;
  // Use Tauri's native dialog — window.confirm() does not reliably show a panel
  // in the WKWebView and can resolve without prompting.
  const confirmed = await dialogAsk(
    `Usunąć model „${label}" z dysku? Tej operacji nie można cofnąć.`,
    {
      title: 'Usuń model',
      kind: 'warning',
      okLabel: 'Usuń',
      cancelLabel: 'Anuluj',
    },
  );
  if (!confirmed) return;
  try {
    await invoke('delete_model', { modelId: id });
    if (state.modelId === id) {
      state.modelId = '';
      try {
        localStorage.removeItem(MODEL_LS_KEY);
      } catch (e) {}
      emit();
    }
    await refreshModelStatus();
    await renderModelManager();
  } catch (e) {
    toast('Nie udało się usunąć modelu: ' + e, 'error');
  }
}

function selectModel(id) {
  state.modelId = id;
  try {
    localStorage.setItem(MODEL_LS_KEY, id);
  } catch (e) {}
  emit();
  renderModelManager();
  syncTranscribeBtn();
}

async function downloadModel(id) {
  const { getModel } = await import('../../transcription/model-registry.js');
  const model = getModel(id);
  if (!model) return;
  if (!model.repo || !model.files?.length) {
    toast(
      'Ten model nie ma jeszcze skonfigurowanego repozytorium/plików do pobrania (uzupełnij rejestr).',
      'info',
    );
    return;
  }
  _downloadingId = id;
  // Must await: renderModelManager() is async (awaits a dynamic import before
  // rewriting container.innerHTML). Without await, the querySelector below grabs
  // the pre-render node, which the pending innerHTML rewrite then detaches — so
  // every progress update writes to an orphaned element and the UI shows nothing.
  await renderModelManager();
  const progEl = document.getElementById('modelDlProgress');
  if (progEl) progEl.style.display = 'block';

  let unlisten;
  try {
    unlisten = await listen('model-download-progress', (e) => {
      if (e.payload.modelId !== id) return;
      const { percent, bytesPerSec, etaSec } = e.payload;
      if (progEl) {
        const mb = (bytesPerSec / 1024 / 1024).toFixed(1);
        const eta = etaSec ? `${Math.round(etaSec)}s` : '—';
        progEl.textContent = `${Math.round(percent)}% · ${mb} MB/s · ETA ${eta}`;
      }
    });
    // Gated repos (Cohere) need a Bearer HF token; reuse the diarization HF-token
    // value. Public CT2 models pass null → no Authorization header (unchanged).
    const hfToken = model.gated ? getApiKey('huggingface') || null : null;
    await invoke('download_model', {
      modelId: id,
      repo: model.repo,
      files: model.files,
      totalBytes: model.sizeBytes || null,
      hfToken,
    });
    if (progEl) progEl.textContent = 'Pobrano i zweryfikowano';
    await refreshModelStatus();
    selectModel(id);
  } catch (e) {
    if (progEl) progEl.textContent = 'Błąd: ' + e;
    toast('Pobieranie modelu nieudane: ' + e, 'error');
  } finally {
    if (unlisten) unlisten();
    _downloadingId = null;
    renderModelManager();
  }
}

async function cancelTranscribe() {
  // Reset the UI immediately so the user can start again right away, instead of
  // waiting for the (now cancellable) backend promise to unwind. The backend
  // SIGTERMs the engine and the driver returns the cancelled state shortly.
  setWhisperProgress('Anulowano.', 0);
  document.getElementById('cancelTranscribeBtn').style.display = 'none';
  syncTranscribeBtn();
  try {
    await invoke('cancel_transcription');
  } catch (e) {
    // ignore
  }
}

// ── S-05 Phase 7 — WhisperX advanced settings modal ───────────────────
// Minimal high-value subset of engine knobs. Empty/default fields fall back to
// the engine's defaults (untouched modal = no behavior change). Only the
// per-machine perf knobs (device, computeType) are persisted to localStorage;
// they are deliberately NOT written to .reelproj (F3 decision).
const WHISPER_ADV_LS_KEY = 'edl_whisper_advanced';

/**
 * Default WhisperX advanced-settings bag (per-machine prefs + run knobs).
 * @returns {typeof import('../../state.js').state.whisperAdvanced}
 */
function defaultWhisperAdvanced() {
  return {
    device: '',
    computeType: '',
    beamSize: null,
    initialPrompt: '',
    vadOnset: null,
    vadOffset: null,
    minSpeakers: null,
    maxSpeakers: null,
    wordLevelSrtExport: false,
    srtWordsPerCue: 1,
    srtStripPunctuation: false,
    punctuation: true,
  };
}

/**
 * Hydrate the per-machine advanced prefs (device / computeType /
 * wordLevelSrtExport / srtWordsPerCue / srtStripPunctuation) from localStorage
 * into state.whisperAdvanced.
 * @returns {void}
 */
function loadWhisperAdvancedFromLS() {
  try {
    const saved = JSON.parse(localStorage.getItem(WHISPER_ADV_LS_KEY) || '{}');
    if (typeof saved.device === 'string')
      state.whisperAdvanced.device = saved.device;
    if (typeof saved.computeType === 'string')
      state.whisperAdvanced.computeType = saved.computeType;
    if (typeof saved.wordLevelSrtExport === 'boolean')
      state.whisperAdvanced.wordLevelSrtExport = saved.wordLevelSrtExport;
    if (typeof saved.srtWordsPerCue === 'number')
      state.whisperAdvanced.srtWordsPerCue = normalizeWordsPerCue(
        saved.srtWordsPerCue,
      );
    if (typeof saved.srtStripPunctuation === 'boolean')
      state.whisperAdvanced.srtStripPunctuation = saved.srtStripPunctuation;
  } catch (e) {}
}

/**
 * Persist only the per-machine advanced prefs to localStorage (never the
 * .reelproj-bound run settings).
 * @returns {void}
 */
function saveWhisperAdvancedToLS() {
  try {
    // Per-machine prefs only — never the .reelproj-bound run settings.
    localStorage.setItem(
      WHISPER_ADV_LS_KEY,
      JSON.stringify({
        device: state.whisperAdvanced.device,
        computeType: state.whisperAdvanced.computeType,
        wordLevelSrtExport: state.whisperAdvanced.wordLevelSrtExport,
        srtWordsPerCue: state.whisperAdvanced.srtWordsPerCue,
        srtStripPunctuation: state.whisperAdvanced.srtStripPunctuation,
      }),
    );
  } catch (e) {}
}

/**
 * The words-per-cue picker only matters in word-by-word mode — grey it out
 * while the word-SRT toggle is off.
 * @returns {void}
 */
function syncSrtWordsPerCueEnabled() {
  const toggle = document.getElementById('advWordLevelSrt');
  const select = document.getElementById('advSrtWordsPerCue');
  if (toggle && select) select.disabled = !toggle.checked;
}

function initWhisperAdvanced() {
  loadWhisperAdvancedFromLS();
  const openBtn = document.getElementById('whisperAdvancedBtn');
  const modal = document.getElementById('whisperAdvancedModal');
  const closeBtn = document.getElementById('whisperAdvancedClose');
  if (!openBtn || !modal || !closeBtn) return;
  const close = () => {
    modal.style.display = 'none';
  };
  openBtn.addEventListener('click', async () => {
    fillWhisperAdvancedForm();
    await applyAdvancedPanelGating();
    modal.style.display = 'flex';
  });
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  // Live-persist the word-SRT toggle on change (not just on "Zapisz"), so the
  // flag sticks regardless of how the modal is dismissed (Zapisz / X / backdrop)
  // and survives a restart. Write ONLY the checkbox here — calling the full
  // applyWhisperAdvancedForm would capture the other unsaved fields and break
  // the Zapisz/Anuluj semantics the rest of the modal relies on.
  const wordSrtEl = document.getElementById('advWordLevelSrt');
  if (wordSrtEl) {
    wordSrtEl.addEventListener('change', (e) => {
      state.whisperAdvanced.wordLevelSrtExport = e.target.checked;
      syncSrtWordsPerCueEnabled();
      saveWhisperAdvancedToLS();
      emit();
    });
  }
  // The other two SRT-export prefs are live-persisted the same way.
  const wordsPerCueEl = document.getElementById('advSrtWordsPerCue');
  if (wordsPerCueEl) {
    wordsPerCueEl.addEventListener('change', (e) => {
      state.whisperAdvanced.srtWordsPerCue = normalizeWordsPerCue(
        e.target.value,
      );
      saveWhisperAdvancedToLS();
      emit();
    });
  }
  const stripPunctEl = document.getElementById('advSrtStripPunct');
  if (stripPunctEl) {
    stripPunctEl.addEventListener('change', (e) => {
      state.whisperAdvanced.srtStripPunctuation = e.target.checked;
      saveWhisperAdvancedToLS();
      emit();
    });
  }
  document.getElementById('advSaveBtn').addEventListener('click', () => {
    applyWhisperAdvancedForm();
    saveWhisperAdvancedToLS();
    emit();
    close();
  });
  document.getElementById('advResetBtn').addEventListener('click', () => {
    state.whisperAdvanced = defaultWhisperAdvanced();
    fillWhisperAdvancedForm();
    saveWhisperAdvancedToLS();
    emit();
  });
}

/**
 * Swap the advanced-settings modal between WhisperX and Cohere knob sets based
 * on the selected model's engine `kind` (local-cohere-transcription Phase 4).
 * WhisperX kind → the full CT2 knob set (compute precision, beam/initial-prompt,
 * VAD, diarization, word-SRT). Cohere kind → only the align `device` override
 * (in the shared "Wydajność" block) plus the `punctuation` toggle; the
 * WhisperX-only sections (marked `[data-engine="whisperx"]`) are hidden and the
 * Cohere-only sections (`[data-engine="cohere"]`) are shown.
 * @returns {Promise<void>}
 */
async function applyAdvancedPanelGating() {
  const modal = document.getElementById('whisperAdvancedModal');
  if (!modal) return;
  const { getModel } = await import('../../transcription/model-registry.js');
  const isCohere = getModel(state.modelId)?.kind === 'cohere-transformers';
  modal
    .querySelectorAll('[data-engine="whisperx"]')
    .forEach((el) => (el.style.display = isCohere ? 'none' : ''));
  modal
    .querySelectorAll('[data-engine="cohere"]')
    .forEach((el) => (el.style.display = isCohere ? '' : 'none'));
  const title = document.getElementById('whisperAdvancedTitle');
  if (title)
    title.textContent = isCohere
      ? 'Ustawienia zaawansowane (Cohere)'
      : 'Ustawienia zaawansowane WhisperX';
}

/**
 * Populate the advanced-settings modal inputs from state.whisperAdvanced.
 * @returns {void}
 */
function fillWhisperAdvancedForm() {
  const a = state.whisperAdvanced;
  document.getElementById('advForceCpu').checked = a.device === 'cpu';
  document.getElementById('advComputeType').value = a.computeType || '';
  document.getElementById('advBeamSize').value = a.beamSize ?? '';
  document.getElementById('advInitialPrompt').value = a.initialPrompt || '';
  document.getElementById('advVadOnset').value = a.vadOnset ?? '';
  document.getElementById('advVadOffset').value = a.vadOffset ?? '';
  document.getElementById('advMinSpeakers').value = a.minSpeakers ?? '';
  document.getElementById('advMaxSpeakers').value = a.maxSpeakers ?? '';
  document.getElementById('advWordLevelSrt').checked = !!a.wordLevelSrtExport;
  document.getElementById('advSrtWordsPerCue').value = String(
    normalizeWordsPerCue(a.srtWordsPerCue),
  );
  syncSrtWordsPerCueEnabled();
  document.getElementById('advSrtStripPunct').checked = !!a.srtStripPunctuation;
  // Cohere-only knob (default-on). Older state shapes omit it → treat as on.
  document.getElementById('advPunctuation').checked = a.punctuation !== false;
}

/**
 * Read the advanced-settings modal inputs back into state.whisperAdvanced.
 * @returns {void}
 */
function applyWhisperAdvancedForm() {
  const numOrNull = (id) => {
    const v = document.getElementById(id).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const a = state.whisperAdvanced;
  a.device = document.getElementById('advForceCpu').checked ? 'cpu' : '';
  a.computeType = document.getElementById('advComputeType').value || '';
  a.beamSize = numOrNull('advBeamSize');
  a.initialPrompt = document.getElementById('advInitialPrompt').value.trim();
  a.vadOnset = numOrNull('advVadOnset');
  a.vadOffset = numOrNull('advVadOffset');
  a.minSpeakers = numOrNull('advMinSpeakers');
  a.maxSpeakers = numOrNull('advMaxSpeakers');
  a.wordLevelSrtExport = document.getElementById('advWordLevelSrt').checked;
  a.srtWordsPerCue = normalizeWordsPerCue(
    document.getElementById('advSrtWordsPerCue').value,
  );
  a.srtStripPunctuation = document.getElementById('advSrtStripPunct').checked;
  a.punctuation = document.getElementById('advPunctuation').checked;
}

// Map the advanced settings to the engine invoke params (Tauri snake_cases the
// keys). Empty values become null so the engine omits the corresponding flag.
// Exported (S-07) so the auto-mode orchestrator + batch call the same engine
// path the manual button uses.
export function whisperAdvancedArgs() {
  const a = state.whisperAdvanced;
  return {
    device: a.device || null,
    computeType: a.computeType || null,
    beamSize: a.beamSize ?? null,
    initialPrompt: a.initialPrompt || null,
    vadOnset: a.vadOnset ?? null,
    vadOffset: a.vadOffset ?? null,
    minSpeakers: a.minSpeakers ?? null,
    maxSpeakers: a.maxSpeakers ?? null,
    // Cohere-only honored knob; rides this bag → invoke('transcribe_video') →
    // Rust forwards `--punctuation`/`--no-punctuation` to the Cohere engine.
    // The CT2/WhisperX path ignores it (Rust only reads it when engine=cohere).
    punctuation: a.punctuation !== false,
  };
}

// ── S-05 transcript align + export ────────────────────────────────────

// Show "align to audio" only when a video and parsed sentences are both present.
export function syncAlignBtn() {
  const btn = document.getElementById('alignTranscriptBtn');
  if (!btn) return;
  const hasVideo = !!(state._whisperVideoPath || state.videoPath);
  const hasSentences = state.sentences && state.sentences.length > 0;
  const show = hasVideo && hasSentences;
  btn.style.display = show ? '' : 'none';
  const note = document.getElementById('alignTranscriptNote');
  if (note) note.style.display = show ? '' : 'none';
}

/**
 * Force-align the imported transcript to the audio to obtain word timestamps.
 * Shared by the manual "Dopasuj do audio" button and the word-SRT export
 * auto-align fallback. Shows the whisperProgressBox progress UI and merges the
 * resulting (frame-normalized) words onto state.sentences. Returns true on
 * success, false on missing prerequisites / cancel / failure (surfaced via
 * toast + progress label; never throws to the caller).
 * @param {{ confirm?: boolean }} [opts] When `confirm` is true (the word-SRT
 *   export auto-align fallback), shows an async ask() notice about the 37–67s
 *   cold-spawn cost before starting; declining returns false without spawning.
 *   The manual "Dopasuj do audio" button passes no opts (no extra prompt — the
 *   click is already explicit).
 * @returns {Promise<boolean>}
 */
export async function alignToWords(opts = {}) {
  const videoPath = state._whisperVideoPath || state.videoPath;
  if (!videoPath) {
    toast(
      'Najpierw wybierz plik wideo, aby dopasować transkrypcję do audio.',
      'info',
    );
    return false;
  }
  if (!state.srtContent) {
    toast('Brak transkrypcji do dopasowania.', 'info');
    return false;
  }
  // Export-driven fallback: warn about the cold-spawn wait before showing the
  // progress box. NEVER window.confirm — it hard-crashes the WKWebView (see
  // context/foundation/lessons.md); use the async plugin-dialog ask().
  if (opts.confirm) {
    const proceed = await dialogAsk(
      'Brak słów na poziomie ramek. Dopasowanie napisów do audio może potrwać 37–67 s przy pierwszym uruchomieniu. Kontynuować?',
      {
        title: 'Dopasuj do audio',
        kind: 'info',
        okLabel: 'Dopasuj',
        cancelLabel: 'Anuluj',
      },
    );
    if (!proceed) return false;
  }
  // Suppress the legacy inline progress box during an auto run — the unified
  // floating panel owns progress there (otherwise both surfaces show on the
  // imported-SRT + video align path).
  if (!state.autoMode.running) {
    document.getElementById('whisperProgressBox').style.display = 'block';
    setWhisperProgress('Dopasowanie do audio…', 0);
  }

  let unlisten;
  try {
    unlisten = await listen('transcribe-progress', (e) => {
      const { label, percent } = e.payload;
      setWhisperProgress(label, percent);
    });
    const result = await invoke('align_transcript', {
      videoPath,
      transcript: state.srtContent,
      language: state.whisperLanguage || 'pl',
      isVtt: !!state._srtIsVtt,
      // Only the device override is relevant to align-only (torch align stage);
      // compute_type/beam/VAD are transcription-only.
      device: state.whisperAdvanced.device || null,
    });
    // Merge resulting word timestamps onto the imported sentences.
    mergeWordsIntoSentences(state.sentences, result.words || [], state.fps);
    renderSegments();
    setWhisperProgress('Dopasowano słowa do audio!', 100);
    setTimeout(() => {
      document.getElementById('whisperProgressBox').style.display = 'none';
    }, 2000);
    emit();
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('ANULOWANO')) {
      setWhisperProgress('Anulowano.', 0);
      // Mirror the success path: don't leave the progress box stuck on screen
      // after a cancel — hide it shortly after surfacing "Anulowano.".
      setTimeout(() => {
        document.getElementById('whisperProgressBox').style.display = 'none';
      }, 2000);
    } else {
      setWhisperProgress('Błąd: ' + e, 0);
      toast('Dopasowanie nieudane: ' + e, 'error');
    }
    return false;
  } finally {
    if (unlisten) unlisten();
  }
}

// Manual "Dopasuj do audio" button handler — thin wrapper over alignToWords().
async function alignImportedTranscript() {
  await alignToWords();
}

/**
 * Write a transcript to a user-chosen location via the native save dialog.
 * @param {'srt'|'vtt'} ext
 * @param {string} content
 */
function saveTranscriptToPath(ext, content) {
  const base = (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
  return saveTextToPath({ defaultName: `${base}.${ext}`, content });
}

// SRT export (sentence vs word-by-word) is handled by the shared
// ./export-srt.js → exportTranscriptSrt, wired to #exportSrtBtn in initTranscribe.

async function exportTranscriptVTT() {
  if (!state.sentences || !state.sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return;
  }
  await saveTranscriptToPath(
    'vtt',
    generateTranscriptVTT(state.sentences, state.fps),
  );
}

async function browseWhisperVideo() {
  try {
    const path = await dialogOpen({
      filters: [
        {
          name: 'Wideo',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'mxf', 'm4v', 'webm'],
        },
      ],
    });
    if (!path) return;
    state._whisperVideoPath = path;
    document.getElementById('whisperVideoPath').value = path;
    // Auto-populate the project settings from the file itself (#4/#5): fps +
    // resolution come from the FFmpeg probe, filename + path from the picker.
    // Tolerant — on probe failure the fields keep their editable defaults.
    await populateVideoMeta(path);
    document.getElementById('videoFilename').value = state.videoFilename || '';
    const fpsEl = document.getElementById('fpsSelect');
    if (fpsEl) fpsEl.value = String(state.fps);
    syncTranscribeBtn();
    syncAlignBtn();
    emit();
  } catch (e) {
    toast('Nie udało się wybrać pliku: ' + e, 'error');
  }
}

/**
 * DOM/state-free transcription unit (S-07): runs `transcribe_video` for ONE file
 * + word-driven segmentation, surfacing progress via `onProgress` and routing an
 * abort `signal` to the global `cancel_transcription` reaper. Takes its inputs as
 * arguments (never `state`) and RETURNS the derived transcript instead of writing
 * the surface, so the orchestrator and the Phase-4 batch share the manual path.
 * Rejects on real failure / `ANULOWANO` cancel rather than swallowing.
 * @param {{ videoPath:string, modelId:string, language?:string, diarize?:boolean,
 *   hfToken?:string, fps:number, [k:string]:any }} opts - engine params; extra
 *   keys (the `whisperAdvancedArgs()` bag) pass through to the invoke verbatim.
 * @param {{ signal?:AbortSignal, onProgress?:(label:string, percent:number)=>void }} [hooks]
 * @returns {Promise<{ srtContent:string, srtName:string, sentences:import('../../state.js').Sentence[], words:any[] }>}
 */
export async function transcribeDocument(
  {
    videoPath,
    modelId,
    language = 'pl',
    diarize = false,
    hfToken = '',
    fps,
    ...advanced
  },
  { signal, onProgress } = {},
) {
  if (!videoPath || !modelId)
    throw new Error('Brak pliku wideo lub modelu do transkrypcji.');

  // Model-aware routing (Phase 4): derive the selected model's engine `kind` and
  // readiness `sentinel` from the registry so the Rust readiness gate
  // (whisper.rs:400) checks the right file (Cohere → model.safetensors) and the
  // engine dispatches to `--engine cohere` when applicable. Placed in this shared
  // unit so manual Step-1 AND both auto-mode paths inherit Cohere-awareness.
  const { getModel } = await import('../../transcription/model-registry.js');
  const selected = getModel(modelId);
  const kind = selected?.kind || 'whisperx-ct2';
  const sentinel = selected?.sentinel || 'model.bin';
  // Cohere has no language auto-detect — resolve `auto` to Polish before the call.
  const resolvedLanguage =
    kind === 'cohere-transformers' && language === 'auto' ? 'pl' : language;

  // Route an external abort to the global single-reaper cancel (there is no
  // AbortSignal threaded through the Rust invoke — cancellation is a side-channel
  // command + atomic flag).
  const onAbort = () => {
    invoke('cancel_transcription').catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let unlisten;
  try {
    if (onProgress) {
      unlisten = await listen('transcribe-progress', (e) => {
        const { label, percent } = e.payload;
        onProgress(label, percent);
      });
    }
    // Returns { srt_content, words: [{text,start,end}], segments: [...] }
    const result = await invoke('transcribe_video', {
      videoPath,
      modelId,
      language: resolvedLanguage,
      diarize,
      hfToken: diarize ? hfToken : '',
      // Engine kind + readiness sentinel drive Rust's sentinel-aware download
      // gate and `--engine cohere` dispatch (Phase 3). `...advanced` carries the
      // `punctuation` flag (Cohere-only; ignored on the CT2 path).
      kind,
      sentinel,
      ...advanced,
    });

    const rawBase = videoPath
      .split('/')
      .pop()
      .split('\\')
      .pop()
      .replace(/\.[^.]+$/, '');
    // Tag the transcript with the model id so re-transcribing the same clip
    // with a different model yields a distinct name (e.g. `_small` vs
    // `_large-v3-turbo`) instead of silently overwriting the previous one.
    const modelTag = String(modelId).replace(/[^a-zA-Z0-9_\-]/g, '_');
    const srtName =
      rawBase.replace(/[^a-zA-Z0-9_\-]/g, '_') + '_' + modelTag + '.srt';

    let sentences = [];
    if (result.segments && result.segments.length) {
      // Word-driven segmentation: gap-free sentences carrying words[].
      sentences = segmentFromWords(result.segments, fps, MIN_CHARS);
      sentences.forEach((s) => {
        s.source_idx = 0;
      });
    }
    return {
      srtContent: result.srt_content,
      srtName,
      sentences,
      words: result.words || [],
    };
  } finally {
    if (unlisten) unlisten();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function transcribeWithWhisper() {
  const videoPath = state._whisperVideoPath;
  const modelId = state.modelId;
  const language = state.whisperLanguage || 'pl';

  if (!videoPath || !modelId) return;

  document.getElementById('transcribeBtn').disabled = true;
  document.getElementById('cancelTranscribeBtn').style.display = '';
  document.getElementById('whisperProgressBox').style.display = 'block';
  setWhisperProgress('Inicjalizacja…', 0);

  try {
    const result = await transcribeDocument(
      {
        videoPath,
        modelId,
        language,
        diarize: state.diarize,
        hfToken: state.diarize ? getApiKey('huggingface') : '',
        fps: state.fps,
        ...whisperAdvancedArgs(),
      },
      { onProgress: setWhisperProgress },
    );

    // Keep the derived SRT for display/save, but the engine path builds
    // sentences directly from word timestamps (no intermediate re-parse).
    loadSRTContent(result.srtContent, result.srtName);

    if (result.sentences.length) {
      state.sentences = result.sentences;
      // Engine path owns segmentation; the legacy merge path is retired here
      // (still used by the imported-transcript align path in Phase 5).
      state._pendingWhisperWords = null;
      renderSegments();
      document.getElementById('statusSegs').textContent =
        state.sentences.length;
      document.getElementById('segmentsCard').style.display = 'block';
      emit();
    } else {
      // Fallback (legacy/no segments): store flat words for merge after parse.
      // No segments means state.sentences is NOT populated here, so a later
      // word-by-word .srt export would silently emit nothing. Guard the trap
      // with a Polish notice so the user knows to parse first (S-20 Phase 3).
      state._pendingWhisperWords = result.words || [];
      toast(
        'Transkrypcja nie zwróciła segmentów — kliknij „Parsuj”, aby dokończyć podział na zdania (wymagany do eksportu napisów słowo-po-słowie).',
        'info',
      );
    }
    setWhisperProgress('Gotowe! SRT wczytany.', 100);
    setTimeout(() => {
      document.getElementById('whisperProgressBox').style.display = 'none';
    }, 2000);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('ANULOWANO')) {
      // User cancel — distinct from a real failure, no error dialog.
      setWhisperProgress('Anulowano transkrypcję.', 0);
    } else {
      setWhisperProgress('Błąd: ' + e, 0);
      toast('Transkrypcja nieudana: ' + e, 'error');
    }
  } finally {
    document.getElementById('cancelTranscribeBtn').style.display = 'none';
    syncTranscribeBtn();
  }
}

function setWhisperProgress(label, percent) {
  document.getElementById('whisperProgressLabel').textContent = label;
  document.getElementById('whisperProgressFill').style.width =
    Math.round(percent) + '%';
}
