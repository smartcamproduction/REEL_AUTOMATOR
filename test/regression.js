/**
 * Phase 1 regression test suite.
 *
 * Tests:
 *  1. parseSRT — output matches legacy logic exactly
 *  2. mergeAdjacentClips — threshold 0 = no merge, threshold 12 = merges adjacent
 *  3. generateEDL (threshold=0) — byte-identical to legacy EDL function
 *  4. generateXML (threshold=0) — byte-identical to legacy XML function
 *  5. generateLua (threshold=0) — functionally equivalent (key format changed intentionally per spec)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSRT, framesToTC, parseTime } from '../src/parser/srt.js';
import { mergeAdjacentClips } from '../src/parser/segments.js';
import { segmentFromWords } from '../src/parser/word-segments.js';
import { mergeWordsIntoSentences } from '../src/ui/import/segments.js';
import {
  generateTranscriptSRT,
  generateTranscriptVTT,
  generateWordSRT,
  generateSegmentsMd,
  stripPunctuation,
  normalizeWordsPerCue,
} from '../src/exporters/transcript.js';
import { generateEDL } from '../src/exporters/edl.js';
import { generateXML } from '../src/exporters/xml.js';
import { generateLua } from '../src/exporters/lua.js';
import { generateFCPXML } from '../src/exporters/fcpxml.js';
import { buildResolveTimeline } from '../src/exporters/resolve-payload.js';
import { buildPrompt, DEFAULT_SCORING_GUIDANCE } from '../src/ai/prompt.js';
import { validateThemes } from '../src/ai/validate.js';

const SRT_PATH = fileURLToPath(new URL('./sample.srt', import.meta.url));
const srtText = readFileSync(SRT_PATH, 'utf-8');

let passed = 0;
let failed = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    if (detail) console.error(`    ${detail}`);
    failed++;
  }
}

function assertEq(a, b, label) {
  if (a === b) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    const aLines = String(a).split('\n');
    const bLines = String(b).split('\n');
    for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
      if (aLines[i] !== bLines[i]) {
        console.error(`    First diff at line ${i + 1}:`);
        console.error(`    NEW: ${JSON.stringify(aLines[i])}`);
        console.error(`    LEG: ${JSON.stringify(bLines[i])}`);
        break;
      }
    }
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────
// Legacy implementations (ported verbatim from legacy HTML, no DOM)
// ─────────────────────────────────────────────────────────────────

function legacyParseTime(str) {
  const [h, m, s] = str.replace(',', '.').split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
}

function legacyFramesToTC(frames, fps) {
  frames = Math.max(0, Math.floor(frames));
  const h = Math.floor(frames / (3600 * fps));
  const m = Math.floor((frames % (3600 * fps)) / (60 * fps));
  const s = Math.floor((frames % (60 * fps)) / fps);
  const f = Math.floor(frames % fps);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

function legacyParseSRT(content, fps, minChars) {
  const pattern =
    /(\d+)\n(\d{2}:\d{2}:\d{2}[,\.]\d{3}) --> (\d{2}:\d{2}:\d{2}[,\.]\d{3})\n([\s\S]*?)(?=\n\n|\n*$)/gm;
  const matches = [...content.matchAll(pattern)];
  const sentences = [];
  let current = [];
  let startTime = null;
  let sentenceId = 1;
  matches.forEach((m, i) => {
    const start = m[2],
      end = m[3];
    const text = m[4]
      .replace(/\n/g, ' ')
      .trim()
      .replace(/<[^>]+>/g, '');
    if (!text) return;
    if (startTime === null) startTime = legacyParseTime(start);
    current.push(text);
    const endsWithPunct = /[.?!]$/.test(text.trim());
    const isLast = i === matches.length - 1;
    if (endsWithPunct || isLast) {
      const full = current.join(' ').trim();
      if (full.length >= minChars) {
        const endTime = legacyParseTime(end);
        const sf = Math.round(startTime * fps);
        const ef = Math.round(endTime * fps);
        sentences.push({
          id: sentenceId++,
          text: full,
          start_frame: sf,
          end_frame: ef,
          duration_frame: ef - sf,
          start_tc: legacyFramesToTC(sf, fps),
          end_tc: legacyFramesToTC(ef, fps),
        });
      }
      current = [];
      startTime = null;
    }
  });
  return sentences;
}

function legacyGenerateEDL(reelsData, sentences, fps, gapFrames, videoFile) {
  const lines = ['TITLE: REELS_EDL_AUTOMATOR', 'FCM: NON-DROP FRAME', ''];
  let cursor = 3600 * fps;
  let eventNum = 1;
  reelsData.forEach((reel) => {
    lines.push(`* ============================================`);
    lines.push(`* REEL: ${reel.reel_name}`);
    lines.push(`* ============================================`);
    reel.clip_ids.forEach((id) => {
      const s = sentences.find((x) => x.id === id);
      if (!s) return;
      const srcIn = legacyFramesToTC(s.start_frame, fps);
      const srcOut = legacyFramesToTC(s.end_frame, fps);
      const recIn = legacyFramesToTC(cursor, fps);
      const recOut = legacyFramesToTC(cursor + s.duration_frame, fps);
      lines.push(
        `${String(eventNum).padStart(3, '0')}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`,
      );
      lines.push(`* FROM CLIP NAME: ${videoFile}`);
      lines.push(`* SEGMENT ID: ${s.id}`);
      lines.push(`* TEXT: ${s.text.substring(0, 100)}`);
      lines.push('');
      cursor += s.duration_frame;
      eventNum++;
    });
    cursor += gapFrames;
  });
  return lines.join('\n');
}

function legacyGenerateXML(
  reelsData,
  sentences,
  fps,
  videoFile,
  videoPath,
  videoResolution,
  projectName,
  gapFrames,
) {
  const [vw, vh] = videoResolution.split('x');
  const pathUrl = videoPath.startsWith('/')
    ? 'file://localhost' + videoPath.replace(/ /g, '%20')
    : 'file://localhost/' + videoPath.replace(/\\/g, '/').replace(/ /g, '%20');
  const totalFrames = sentences.length
    ? Math.max(...sentences.map((s) => s.end_frame)) + fps * 10
    : 90000;
  const esc = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE xmeml>');
  lines.push('<xmeml version="4">');
  const fileId = 'source_file_1';
  reelsData.forEach((reel, ri) => {
    const clips = reel.clip_ids
      .map((id) => sentences.find((s) => s.id === id))
      .filter(Boolean);
    const reelDur = clips.reduce((a, s) => a + s.duration_frame, 0);
    const reelName = esc(reel.reel_name);
    const ntsc = fps === 24 || fps === 30 || fps === 60 ? 'TRUE' : 'FALSE';
    lines.push(`  <sequence id="seq_${ri + 1}">`);
    lines.push(`    <name>${reelName}</name>`);
    lines.push(`    <duration>${reelDur}</duration>`);
    lines.push(
      `    <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`,
    );
    lines.push(
      `    <timecode><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    );
    lines.push(`    <media>`);
    lines.push(`      <video>`);
    lines.push(
      `        <format><samplecharacteristics><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><width>${vw}</width><height>${vh}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
    );
    lines.push(`        <track>`);
    let cursor = 0;
    clips.forEach((seg, ci) => {
      const clipId = `clip_r${ri + 1}_c${ci + 1}`;
      const clipName = esc(`#${seg.id} ${seg.text.substring(0, 55)}`);
      lines.push(`          <clipitem id="${clipId}">`);
      lines.push(`            <masterclipid>${clipId}_master</masterclipid>`);
      lines.push(`            <name>${clipName}</name>`);
      lines.push(`            <duration>${seg.duration_frame}</duration>`);
      lines.push(
        `            <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`,
      );
      lines.push(`            <start>${cursor}</start>`);
      lines.push(`            <end>${cursor + seg.duration_frame}</end>`);
      lines.push(`            <in>${seg.start_frame}</in>`);
      lines.push(`            <out>${seg.end_frame}</out>`);
      if (ci === 0 && ri === 0) {
        lines.push(`            <file id="${fileId}">`);
        lines.push(`              <name>${esc(videoFile)}</name>`);
        lines.push(`              <pathurl>${pathUrl}</pathurl>`);
        lines.push(
          `              <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`,
        );
        lines.push(`              <duration>${totalFrames}</duration>`);
        lines.push(`              <media>`);
        lines.push(
          `                <video><samplecharacteristics><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><width>${vw}</width><height>${vh}</height></samplecharacteristics></video>`,
        );
        lines.push(
          `                <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`,
        );
        lines.push(`              </media>`);
        lines.push(`            </file>`);
      } else {
        lines.push(`            <file id="${fileId}"/>`);
      }
      lines.push(
        `            <comments><mastercomment1>${esc(seg.text.substring(0, 120))}</mastercomment1></comments>`,
      );
      lines.push(`          </clipitem>`);
      cursor += seg.duration_frame;
    });
    lines.push(`        </track>`);
    lines.push(`      </video>`);
    lines.push(`      <audio>`);
    lines.push(
      `        <track><enabled>TRUE</enabled><locked>FALSE</locked></track>`,
    );
    lines.push(`      </audio>`);
    lines.push(`    </media>`);
    lines.push(`  </sequence>`);
  });
  lines.push('</xmeml>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────────────────────────

const FPS = 25;
const MIN_CHARS = 20;
const GAP_FRAMES = 60;
const VIDEO_FILE = 'webinar_2024.mp4';
const VIDEO_PATH = '/Users/jan/Videos/webinar_2024.mp4';
const RESOLUTION = '1920x1080';
const PROJECT_NAME = 'Reels';
const MERGE_0 = 0;
const MERGE_12 = 12;

// Parse the SRT
const newSentences = parseSRT(srtText, FPS, MIN_CHARS);
const legSentences = legacyParseSRT(srtText, FPS, MIN_CHARS);

// Test reels — uses clip IDs 2, 3, 4, 5 for reel 1; 7, 8, 9 for reel 2
// Clips 9 and 10 are source-adjacent (gap of 50ms = ~1 frame at 25fps) for merge test
const reelsData = [
  { reel_name: 'Reel 1 - Hook sprzedażowy', clip_ids: [2, 3] },
  { reel_name: 'Reel 2 - Testimonial', clip_ids: [7, 8] },
];

// ─────────────────────────────────────────────────────────────────
// Test 1: parseSRT regression
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 1: parseSRT ──────────────────────────────────────');

assert(
  newSentences.length === legSentences.length,
  `sentence count matches (${newSentences.length})`,
);

newSentences.forEach((s, i) => {
  const l = legSentences[i];
  if (!l) return;
  assert(s.id === l.id, `sentence[${i}].id`);
  assert(s.text === l.text, `sentence[${i}].text`);
  assert(
    s.start_frame === l.start_frame,
    `sentence[${i}].start_frame (${s.start_frame})`,
  );
  assert(
    s.end_frame === l.end_frame,
    `sentence[${i}].end_frame (${s.end_frame})`,
  );
  assert(
    s.duration_frame === l.duration_frame,
    `sentence[${i}].duration_frame`,
  );
  assert(s.start_tc === l.start_tc, `sentence[${i}].start_tc (${s.start_tc})`);
  assert(s.end_tc === l.end_tc, `sentence[${i}].end_tc (${s.end_tc})`);
});

// ─────────────────────────────────────────────────────────────────
// Test 2: mergeAdjacentClips
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 2: mergeAdjacentClips ───────────────────────────');

// threshold=0: each clip_id → its own span
const spans0 = mergeAdjacentClips([2, 3], newSentences, 0);
assert(
  spans0.length === 2,
  'threshold=0 produces 2 separate spans for 2 clips',
);
assert(spans0[0].ids.length === 1, 'span[0] has single id');
assert(spans0[0].ids[0] === 2, 'span[0].ids[0] === 2');
assert(spans0[1].ids[0] === 3, 'span[1].ids[0] === 3');

// clips 9 and 10 in sample SRT:
//   clip 9: 00:00:28,000 --> 00:00:31,300  sf=700 ef=782
//   clip 10: 00:00:31,350 --> 00:00:34,000  sf=783 ef=850
//   gap = 783 - 782 = 1 frame ≤ 12 → should merge
const s9 = newSentences.find((s) => s.id === 9);
const s10 = newSentences.find((s) => s.id === 10);
if (s9 && s10) {
  const gap = s10.start_frame - s9.end_frame;
  console.log(
    `  clip 9 end_frame=${s9.end_frame}, clip 10 start_frame=${s10.start_frame}, gap=${gap} frames`,
  );
  const spansAdj = mergeAdjacentClips([9, 10], newSentences, 12);
  assert(
    spansAdj.length === 1,
    `clips 9+10 merge into 1 span (gap=${gap} ≤ 12)`,
  );
  if (spansAdj.length === 1) {
    assert(spansAdj[0].ids.join(',') === '9,10', 'merged span.ids === [9,10]');
    assert(
      spansAdj[0].start_frame === s9.start_frame,
      'merged span.start_frame = clip9.start_frame',
    );
    assert(
      spansAdj[0].end_frame === s10.end_frame,
      'merged span.end_frame = clip10.end_frame',
    );
  }
} else {
  console.error('  SKIP: clips 9/10 not found in parsed sentences');
}

// Order preserved — non-consecutive clip IDs
const spansReverse = mergeAdjacentClips([5, 2], newSentences, 12);
assert(
  spansReverse.length === 2,
  'non-adjacent clips not merged even with high threshold',
);
assert(spansReverse[0].ids[0] === 5, 'order preserved: first span is clip 5');
assert(spansReverse[1].ids[0] === 2, 'order preserved: second span is clip 2');

// ─────────────────────────────────────────────────────────────────
// Test 3: generateEDL regression (threshold=0 → byte-identical to legacy)
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 3: EDL regression (threshold=0) ─────────────────');

const newEDL = generateEDL({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});

const legEDL = legacyGenerateEDL(
  reelsData,
  legSentences,
  FPS,
  GAP_FRAMES,
  VIDEO_FILE,
);

assertEq(newEDL, legEDL, 'EDL output is byte-identical to legacy');

// Spot-check: segment ID lines
const edlLines = newEDL.split('\n');
const segIdLines = edlLines.filter((l) => l.startsWith('* SEGMENT ID:'));
assert(
  segIdLines.length === reelsData.reduce((a, r) => a + r.clip_ids.length, 0),
  `EDL has correct number of SEGMENT ID lines (${segIdLines.length})`,
);
assert(
  segIdLines.every((l) => /^\* SEGMENT ID: \d+$/.test(l)),
  'all SEGMENT ID lines have single integer (no comma, threshold=0)',
);

// ─────────────────────────────────────────────────────────────────
// Test 4: generateXML regression (threshold=0 → byte-identical to legacy)
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 4: XML regression (threshold=0) ─────────────────');

const newXML = generateXML({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

const legXML = legacyGenerateXML(
  reelsData,
  legSentences,
  FPS,
  VIDEO_FILE,
  VIDEO_PATH,
  RESOLUTION,
  PROJECT_NAME,
  GAP_FRAMES,
);

assertEq(newXML, legXML, 'XML output is byte-identical to legacy');

// Spot-check structure
assert(newXML.startsWith('<?xml version="1.0"'), 'XML starts with declaration');
assert(newXML.includes('<xmeml version="4">'), 'XML has xmeml v4 wrapper');
assert(newXML.includes('<!DOCTYPE xmeml>'), 'XML has DOCTYPE');
assert(
  newXML.includes('file://localhost' + VIDEO_PATH),
  'XML has correct file URL',
);
const seqMatches = [...newXML.matchAll(/<sequence id="seq_\d+"/g)];
assert(
  seqMatches.length === reelsData.length,
  `XML has ${reelsData.length} sequences`,
);

// ─────────────────────────────────────────────────────────────────
// Test 5: generateLua functional check (threshold=0)
// Lua key format changed intentionally per spec (rNsM vs integer IDs)
// so we verify structure and values, not byte-identity
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 5: Lua functional check (threshold=0) ───────────');

const newLua = generateLua({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoPath: VIDEO_PATH,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

assert(newLua.startsWith('-- =='), 'Lua starts with header comment');
assert(
  newLua.includes(`local VIDEO_PATH = "${VIDEO_PATH}"`),
  'Lua has VIDEO_PATH',
);
assert(newLua.includes(`local FPS = ${FPS}`), 'Lua has FPS');
assert(newLua.includes('local segs = {'), 'Lua has segs table');
assert(
  newLua.includes('mediaPool:AppendToTimeline(allClips)'),
  'Lua has batch append call',
);
assert(
  newLua.includes(`local baseTlName = "${PROJECT_NAME}"`),
  'Lua sets base timeline name from project name',
);
assert(
  newLua.includes('local timeline = mediaPool:CreateEmptyTimeline(tlName)'),
  'Lua creates timeline with the runtime-resolved unique name',
);
// Duplicate-name guard: collect existing timeline names, then bump a numeric
// suffix ("Reels_2", "Reels_3", …) until a free name is found instead of erroring.
assert(
  newLua.includes('for i = 1, project:GetTimelineCount() do') &&
    newLua.includes('while existingNames[tlName] do') &&
    newLua.includes('tlName = baseTlName .. "_" .. tlSuffix'),
  'Lua picks a free timeline name on collision (base_2, base_3, …)',
);
assert(newLua.includes(`przerwa ${GAP_FRAMES} klatek`), 'Lua has gap comment');

// Each clip in reelsData must appear as a span key in segs
const expectedSpanKeys = ['r1s1', 'r1s2', 'r2s1', 'r2s2'];
expectedSpanKeys.forEach((key) => {
  assert(newLua.includes(`"${key}"`), `Lua segs has key "${key}"`);
});

// Frame values should match parsed sentences
const s2 = newSentences.find((s) => s.id === 2);
const s3 = newSentences.find((s) => s.id === 3);
if (s2 && s3) {
  assert(
    newLua.includes(`sf=${s2.start_frame}`),
    `Lua r1s1 has correct start_frame (${s2.start_frame})`,
  );
  assert(
    newLua.includes(`ef=${s3.end_frame}`),
    `Lua r1s2 has correct end_frame (${s3.end_frame})`,
  );
}

// ─────────────────────────────────────────────────────────────────
// Test 6: EDL with merge — confirm merged events
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 6: EDL merge-mode sanity check (threshold=12) ───');

const mergedReels = [{ reel_name: 'Reel Merge Test', clip_ids: [9, 10] }];
const mergedEDL = generateEDL({
  reelsData: mergedReels,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_12,
});

const mergedEDLLines = mergedEDL.split('\n');
const eventLines = mergedEDLLines.filter((l) => /^\d{3}  AX/.test(l));
const mergedSegIdLines = mergedEDLLines.filter((l) =>
  l.startsWith('* SEGMENT ID:'),
);

assert(
  eventLines.length === 1,
  'merged clips 9+10 produce exactly 1 EDL event',
);
assert(
  mergedSegIdLines.length === 1 && mergedSegIdLines[0] === '* SEGMENT ID: 9,10',
  'merged SEGMENT ID line shows "9,10"',
);

// Compare duration: merged span should span both clips
if (s9 && s10) {
  const expectedDur = s10.end_frame - s9.start_frame;
  const srcIn = legacyFramesToTC(s9.start_frame, FPS);
  const srcOut = legacyFramesToTC(s10.end_frame, FPS);
  assert(eventLines[0].includes(srcIn), `merged event SRC IN = ${srcIn}`);
  assert(eventLines[0].includes(srcOut), `merged event SRC OUT = ${srcOut}`);
}

// ─────────────────────────────────────────────────────────────────
// Test 7: framesToTC — frame math invariant
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 7: framesToTC invariant ─────────────────────────');

// 1 hour at 25fps = 90000 frames → 01:00:00:00
assert(
  framesToTC(90000, 25) === '01:00:00:00',
  'framesToTC(90000,25) = 01:00:00:00',
);
assert(framesToTC(0, 25) === '00:00:00:00', 'framesToTC(0,25) = 00:00:00:00');
assert(
  framesToTC(25, 25) === '00:00:01:00',
  'framesToTC(25,25) = 00:00:01:00 (1 second)',
);
assert(
  framesToTC(24, 25) === '00:00:00:24',
  'framesToTC(24,25) = 00:00:00:24 (last frame of second)',
);
// 30fps
assert(framesToTC(30, 30) === '00:00:01:00', 'framesToTC(30,30) = 00:00:01:00');
// Negative clamp
assert(
  framesToTC(-5, 25) === '00:00:00:00',
  'framesToTC(-5,25) clamps to 00:00:00:00',
);
// EDL cursor starts at 1 hour
assert(
  framesToTC(3600 * 25, 25) === '01:00:00:00',
  '1-hour EDL offset correct',
);
// 23.976 treated as 24 NDF
assert(
  framesToTC(24, 23.976) === '00:00:01:00',
  'framesToTC(24,23.976) = 00:00:01:00 (NDF)',
);

// Drop-frame: 29.97 fps (30 DF, D=2)
// Frame 0 = 00:00:00;00
assert(framesToTC(0, 29.97) === '00:00:00;00', 'DF: frame 0 = 00:00:00;00');
// Frame 1800 = 00:01:00;02 (frames ;00 and ;01 are dropped at 1-minute mark)
assert(
  framesToTC(1800, 29.97) === '00:01:00;02',
  'DF: frame 1800 = 00:01:00;02',
);
// Frame 17982 = 00:10:00;00 (10-minute mark — no drop)
assert(
  framesToTC(17982, 29.97) === '00:10:00;00',
  'DF: frame 17982 = 00:10:00;00',
);
// 1 hour at 29.97 = 107892 frames → 01:00:00;00
assert(
  framesToTC(107892, 29.97) === '01:00:00;00',
  'DF: 1 hour (107892 frames) = 01:00:00;00',
);

// ─────────────────────────────────────────────────────────────────
// Test 8: .reelproj v2 → v3 back-compat (F-01 render-path removal)
// An old v2 project carrying dead renderConfig / reelsMetadata blobs
// must still normalize + export cleanly once the render path is gone.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 8: v2 .reelproj back-compat ─────────────────────');

// A v2-shaped project as written by the pre-F-01 app: valid pipeline
// data plus the now-removed renderConfig + reelsMetadata blobs.
const v2Project = {
  version: 2,
  srtName: 'webinar_2024.srt',
  srtContent: srtText,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoFilename2: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  gapFrames: GAP_FRAMES,
  minChars: MIN_CHARS,
  mergeThreshold: MERGE_12,
  sentences: newSentences,
  reelsData,
  // Dead blobs that v3 drops on load:
  renderConfig: {
    aspect: 'vertical_9_16',
    videoCodec: 'h264_nvenc',
    outDir: '/tmp/out',
    logo: { path: '/logo.png', position: 'br', opacity: 1, widthPct: 15 },
    burnSubtitles: true,
    loudnessNormalize: true,
  },
  reelsMetadata: [
    {
      reelIdx: 0,
      reelName: 'Reel 1',
      title: 'Stary tytuł',
      thumbnailTimestamp: 3,
    },
  ],
  namedPresets: { Instagram: { aspect: 'vertical_9_16' } },
};

// Mirrors the tolerant load (applyProjectData) after F-01: only the
// surviving keys are carried into state; renderConfig / reelsMetadata /
// namedPresets are ignored (never assigned).
function normalizeV2Project(data) {
  const norm = {};
  if (data.fps) norm.fps = data.fps;
  if (data.gapFrames != null) norm.gapFrames = data.gapFrames;
  if (data.videoFilename2 || data.videoFilename)
    norm.videoFilename = data.videoFilename2 || data.videoFilename;
  if (data.videoPath) norm.videoPath = data.videoPath;
  if (data.videoResolution) norm.videoResolution = data.videoResolution;
  if (data.projectName) norm.projectName = data.projectName;
  if (data.mergeThreshold != null) norm.mergeThreshold = data.mergeThreshold;
  if (data.sentences) norm.sentences = data.sentences;
  if (data.reelsData) norm.reelsData = data.reelsData;
  return norm;
}

const norm = normalizeV2Project(v2Project);

assert(!('renderConfig' in norm), 'normalized project drops renderConfig');
assert(!('reelsMetadata' in norm), 'normalized project drops reelsMetadata');
assert(!('namedPresets' in norm), 'normalized project drops namedPresets');
assert(norm.sentences.length === newSentences.length, 'sentences survive load');
assert(norm.reelsData.length === reelsData.length, 'reelsData survives load');

const bcEDL = generateEDL({
  reelsData: norm.reelsData,
  sentences: norm.sentences,
  fps: norm.fps,
  gapFrames: norm.gapFrames,
  videoFilename: norm.videoFilename,
  mergeThreshold: norm.mergeThreshold,
});
assert(
  bcEDL.length > 0 && bcEDL.includes('TITLE: REELS_EDL_AUTOMATOR'),
  'v2 project still exports valid EDL',
);

const bcXML = generateXML({
  reelsData: norm.reelsData,
  sentences: norm.sentences,
  fps: norm.fps,
  videoFilename: norm.videoFilename,
  videoPath: norm.videoPath,
  videoResolution: norm.videoResolution,
  projectName: norm.projectName,
  mergeThreshold: norm.mergeThreshold,
});
assert(
  bcXML.length > 0 && bcXML.includes('<xmeml version="4">'),
  'v2 project still exports valid XML',
);

const bcLua = generateLua({
  reelsData: norm.reelsData,
  sentences: norm.sentences,
  fps: norm.fps,
  gapFrames: norm.gapFrames,
  videoPath: norm.videoPath,
  projectName: norm.projectName,
  mergeThreshold: norm.mergeThreshold,
});
assert(
  bcLua.length > 0 && bcLua.includes('mediaPool:AppendToTimeline(allClips)'),
  'v2 project still exports valid Lua',
);

// ─────────────────────────────────────────────────────────────────
// Test 9: segmentFromWords — word-driven segmentation (S-05 / v4)
// Feeds a recorded WhisperX-shaped segments/words fixture through the new
// segmenter; asserts gap-free coverage, correct frame math, numbering, and
// persisted words[]. Then proves exporters still produce valid output.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 9: segmentFromWords (word-driven) ───────────────');

const WX_PATH = fileURLToPath(new URL('./whisperx-fixture.json', import.meta.url));
const wxFixture = JSON.parse(readFileSync(WX_PATH, 'utf-8'));
const wxSentences = segmentFromWords(wxFixture.segments, FPS, MIN_CHARS);

assert(
  wxSentences.length === 2,
  `produces 2 sentences (got ${wxSentences.length})`,
);
assert(
  wxSentences.every((s, i) => s.id === i + 1),
  'sentences are numbered 1..n',
);
assert(
  wxSentences.every((s) => Array.isArray(s.words) && s.words.length > 0),
  'every sentence carries words[]',
);

// Gap-free: each sentence's end_frame equals the next sentence's start_frame.
let gapFree = true;
for (let i = 0; i < wxSentences.length - 1; i++) {
  if (wxSentences[i].end_frame !== wxSentences[i + 1].start_frame)
    gapFree = false;
}
assert(gapFree, 'consecutive sentence spans are gap-free');

// Frame math: Math.round(seconds * fps), no mid-pipeline rounding.
const firstWordStart = wxFixture.segments[0].words[0].start;
assert(
  wxSentences[0].start_frame === Math.round(firstWordStart * FPS),
  `sentence[0].start_frame = Math.round(${firstWordStart} * ${FPS})`,
);
assert(
  wxSentences.every((s) => s.duration_frame === s.end_frame - s.start_frame),
  'duration_frame = end_frame - start_frame',
);
// Word frames also follow the invariant.
const w0 = wxFixture.segments[0].words[0];
assert(
  wxSentences[0].words[0].start_frame === Math.round(w0.start * FPS) &&
    wxSentences[0].words[0].end_frame === Math.round(w0.end * FPS),
  'word frames use Math.round(seconds * fps)',
);

// Exporters consume word-driven sentences with no regression.
const wxReels = [
  { reel_name: 'Reel WX', clip_ids: [wxSentences[0].id, wxSentences[1].id] },
];
const wxEDL = generateEDL({
  reelsData: wxReels,
  sentences: wxSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});
assert(
  wxEDL.includes('TITLE: REELS_EDL_AUTOMATOR') &&
    wxEDL.includes('* SEGMENT ID: 1'),
  'word-driven sentences export a valid EDL',
);
const wxXML = generateXML({
  reelsData: wxReels,
  sentences: wxSentences,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});
assert(
  wxXML.includes('<xmeml version="4">'),
  'word-driven sentences export valid XML',
);
const wxLua = generateLua({
  reelsData: wxReels,
  sentences: wxSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoPath: VIDEO_PATH,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});
assert(
  wxLua.includes('mediaPool:AppendToTimeline(allClips)'),
  'word-driven sentences export valid Lua',
);

// ─────────────────────────────────────────────────────────────────
// Test 10: .reelproj v4 round-trip (words[]) + v3 tolerant load
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 10: v4 words[] round-trip ───────────────────────');

const v4Project = {
  version: 4,
  srtName: 'webinar.srt',
  fps: FPS,
  minChars: MIN_CHARS,
  mergeThreshold: MERGE_0,
  sentences: wxSentences,
  reelsData: wxReels,
};
// Round-trip through JSON exactly as save_project/load_project do (Value I/O).
const v4Loaded = JSON.parse(JSON.stringify(v4Project));
assert(v4Loaded.version === 4, 'v4 project keeps version 4');
assert(
  v4Loaded.sentences[0].words.length === wxSentences[0].words.length,
  'words[] survive the v4 round-trip',
);
assert(
  v4Loaded.sentences[0].words[0].start_frame ===
    wxSentences[0].words[0].start_frame,
  'word frame values survive the v4 round-trip',
);

// v3 (no words) must still load tolerantly — exporters work without words.
const v3Sentences = wxSentences.map(({ words, ...rest }) => rest);
assert(
  v3Sentences.every((s) => s.words === undefined),
  'v3 fixture has no words[]',
);
const v3EDL = generateEDL({
  reelsData: wxReels,
  sentences: v3Sentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});
assert(
  v3EDL.includes('TITLE: REELS_EDL_AUTOMATOR'),
  'v3 sentences (no words) still export a valid EDL',
);

// ─────────────────────────────────────────────────────────────────
// Test 10b: align-path word units — mergeWordsIntoSentences emits frames
// The transcribe path stores words in frames; the align path historically
// stored raw seconds, breaking any start_frame reader. This locks the align
// path to the SAME frame-based Word shape (S-19 Phase 1).
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 10b: align-path word frame units ────────────────');

// One sentence spanning ~0..2s at FPS; seconds-based WhisperX words inside it.
const alignSentence = {
  id: 1,
  source_idx: 0,
  text: 'Witaj świecie.',
  start_frame: 0,
  end_frame: Math.round(2 * FPS),
};
const alignWords = [
  { text: 'Witaj', start: 0.2, end: 0.6, speaker: 'SPEAKER_00' },
  { text: 'świecie.', start: 0.7, end: 1.4 },
];
const alignSentences = [alignSentence];
mergeWordsIntoSentences(alignSentences, alignWords, FPS);

assert(
  alignSentences[0].words.length === 2,
  `align path attaches both words by overlap (got ${alignSentences[0].words.length})`,
);
assert(
  alignSentences[0].words.every(
    (w) => Number.isInteger(w.start_frame) && Number.isInteger(w.end_frame),
  ),
  'align-path words carry integer start_frame/end_frame',
);
assert(
  alignSentences[0].words[0].start_frame === Math.round(0.2 * FPS) &&
    alignSentences[0].words[0].end_frame === Math.round(0.6 * FPS),
  'align-path word frames use Math.round(seconds * fps)',
);
assert(
  alignSentences[0].words.every(
    (w) => w.start === undefined && w.end === undefined,
  ),
  'align-path words drop the raw seconds keys (start/end)',
);
assert(
  alignSentences[0].words[0].speaker === 'SPEAKER_00' &&
    alignSentences[0].words[1].speaker === undefined,
  'align-path words carry speaker only when present',
);

// ─────────────────────────────────────────────────────────────────
// Test 11: transcript exporters (.srt / .vtt) — pure, round-trippable
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 11: transcript export (.srt/.vtt) ───────────────');

// Default export is clean caption text — must round-trip via parseSRT.
const exportedSRT = generateTranscriptSRT(wxSentences, FPS);
assert(
  /00:00:00,\d{3} --> 00:00:0\d,\d{3}/.test(exportedSRT),
  'exported .srt has SRT timestamps',
);
assert(
  !exportedSRT.includes('NOTE WORDS:'),
  'default .srt is clean caption text (no embedded word notes)',
);
const reparsed = parseSRT(exportedSRT, FPS, 1);
assert(
  reparsed.length === wxSentences.length,
  `exported .srt re-imports to ${wxSentences.length} sentences (got ${reparsed.length})`,
);
assert(
  reparsed[0].text === wxSentences[0].text,
  'round-tripped first sentence text matches',
);

// Opt-in word embedding appends the NOTE line for tooling.
const srtWithWords = generateTranscriptSRT(wxSentences, FPS, {
  includeWords: true,
});
assert(
  srtWithWords.includes('NOTE WORDS:'),
  'includeWords:true embeds word-level timing',
);

const exportedVTT = generateTranscriptVTT(wxSentences, FPS);
assert(exportedVTT.startsWith('WEBVTT'), 'exported .vtt starts with WEBVTT');
assert(
  /00:00:00\.\d{3} --> 00:00:0\d\.\d{3}/.test(exportedVTT),
  'exported .vtt has VTT timestamps (dot separator)',
);

// ─────────────────────────────────────────────────────────────────
// Test 11b: generateSegmentsMd — pure segment-listing .md (S-07 Phase 4)
// Pins the extracted builder's output so batch + the export popover share one
// byte-identical generator.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 11b: generateSegmentsMd (.md) ───────────────────');

const mdSentences = [
  {
    id: 1,
    text: 'Pierwsze zdanie.',
    start_tc: '00:00:01:00',
    end_tc: '00:00:03:00',
    duration_frame: 50,
  },
  {
    id: 2,
    text: 'Drugie zdanie.',
    start_tc: '00:00:03:00',
    end_tc: '00:00:05:12',
    duration_frame: 62,
  },
];
const md = generateSegmentsMd(mdSentences, FPS, 'klip.srt');
assert(
  md.startsWith('# Segmenty SRT\n\nPlik: klip.srt\nFPS: 25\nSegmentów: 2\n'),
  'segments .md header carries source name, fps and count',
);
assert(
  md.includes('**#1** `00:00:01:00 → 00:00:03:00` (2.0s)\n\nPierwsze zdanie.'),
  'segments .md renders an entry with tc span, duration and text',
);
assert(
  md.includes('**#2** `00:00:03:00 → 00:00:05:12` (2.5s)'),
  'segments .md computes per-segment duration from frames',
);
assert(
  generateSegmentsMd([], FPS).startsWith(
    '# Segmenty SRT\n\nPlik: nieznany\nFPS: 25\nSegmentów: 0\n',
  ),
  'segments .md falls back to "nieznany" when no source name is given',
);

// ─────────────────────────────────────────────────────────────────
// Test 12: diarization speaker labels — present and absent (Phase 6)
// segmentFromWords must carry an optional `speaker` when the engine provides
// it, and omit it cleanly when absent (additive, still v4).
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 12: diarization speaker labels ──────────────────');

// Absent: the base fixture has no speaker → words must not carry `speaker`.
assert(
  wxSentences.every((s) => s.words.every((w) => w.speaker === undefined)),
  'no speaker field when engine omits diarization',
);

// Present: clone the fixture with speaker labels on each word.
const diarizedSegments = wxFixture.segments.map((seg) => ({
  ...seg,
  words: seg.words.map((w, i) => ({
    ...w,
    speaker: i % 2 ? 'SPEAKER_01' : 'SPEAKER_00',
  })),
}));
const diarizedSentences = segmentFromWords(diarizedSegments, FPS, MIN_CHARS);
assert(
  diarizedSentences.every((s) =>
    s.words.every((w) => typeof w.speaker === 'string'),
  ),
  'speaker carried onto every word when present',
);
assert(
  diarizedSentences[0].words[0].speaker === 'SPEAKER_00',
  'first word speaker label preserved',
);
// Speaker survives the v4 project round-trip.
const diarizedLoaded = JSON.parse(JSON.stringify(diarizedSentences));
assert(
  diarizedLoaded[0].words[0].speaker === 'SPEAKER_00',
  'speaker labels survive v4 round-trip',
);
// Exporters still work with speaker-labeled sentences.
const diarizedEDL = generateEDL({
  reelsData: [{ reel_name: 'R', clip_ids: [diarizedSentences[0].id] }],
  sentences: diarizedSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});
assert(
  diarizedEDL.includes('TITLE: REELS_EDL_AUTOMATOR'),
  'speaker-labeled sentences still export valid EDL',
);

// ─────────────────────────────────────────────────────────────────
// Test 13: EDL markers — hook/body/punchline locator lines (S-01)
// Conditional on reel.markers; marker-free reels stay byte-identical.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 13: EDL markers (hook/body/punchline) ────────────');

const m2 = newSentences.find((s) => s.id === 2);
const m3 = newSentences.find((s) => s.id === 3);

// One reel carries markers; a second marker-free reel rides along in the run.
const markerReels = [
  {
    reel_name: 'Reel A - z markerami',
    clip_ids: [2, 3],
    markers: { hook: 2, body: 2, punchline: 3 },
  },
  { reel_name: 'Reel B - bez markerów', clip_ids: [7, 8] },
];
const markerEDL = generateEDL({
  reelsData: markerReels,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});

const locLines = markerEDL.split('\n').filter((l) => l.startsWith('* LOC:'));
assert(
  locLines.length === 3,
  `exactly 3 LOC lines from the one markered reel (got ${locLines.length})`,
);
assert(
  locLines.some((l) => l.includes('GREEN HOOK')),
  'LOC has GREEN HOOK',
);
assert(
  locLines.some((l) => l.includes('BLUE BODY')),
  'LOC has BLUE BODY',
);
assert(
  locLines.some((l) => l.includes('RED PUNCHLINE')),
  'LOC has RED PUNCHLINE',
);

// Reel A record span (threshold=0): [3600*fps, 3600*fps + dur2 + dur3)
const recStart = 3600 * FPS;
const recEnd = recStart + m2.duration_frame + m3.duration_frame;
const tcToFrames = (tc) => {
  const [h, mm, s, f] = tc.split(/[:;]/).map(Number);
  return h * 3600 * FPS + mm * 60 * FPS + s * FPS + f; // NDF (FPS=25)
};
locLines.forEach((l, i) => {
  const tc = l.split(' ')[2]; // "* LOC: <tc> <COLOR> <NAME>"
  const fr = tcToFrames(tc);
  assert(
    fr >= recStart && fr < recEnd,
    `LOC[${i}] record frame ${fr} inside reel A span [${recStart}, ${recEnd})`,
  );
});

// Exact record frames: hook(2)=recStart, punchline(3)=recStart+dur2
assert(
  markerEDL.includes(`* LOC: ${legacyFramesToTC(recStart, FPS)} GREEN HOOK`),
  `HOOK marker at ${legacyFramesToTC(recStart, FPS)}`,
);
assert(
  markerEDL.includes(
    `* LOC: ${legacyFramesToTC(recStart + m2.duration_frame, FPS)} RED PUNCHLINE`,
  ),
  `PUNCHLINE marker at ${legacyFramesToTC(recStart + m2.duration_frame, FPS)}`,
);

// A fully marker-free run emits zero LOC lines (byte-identical legacy path).
const noMarkerEDL = generateEDL({
  reelsData: [{ reel_name: 'Reel bez markerów', clip_ids: [2, 3] }],
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});
assert(!noMarkerEDL.includes('* LOC:'), 'marker-free run emits zero LOC lines');

// ─────────────────────────────────────────────────────────────────
// Test 13a: XML markers — sequence-level <marker> (S-08 Phase 1)
// Mirrors Test 13 but for xmeml: 3 record-frame markers (Green/Blue/Red)
// for the marked reel, zero for the unmarked reel; marker-free run stays
// byte-identical to the Test 4 baseline.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 13a: XML markers (hook/body/punchline) ──────────');

const markerXML = generateXML({
  reelsData: markerReels,
  sentences: newSentences,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

const xmlMarkerBlocks = [
  ...markerXML.matchAll(
    /<marker>\s*<name>([^<]+)<\/name>\s*<in>(\d+)<\/in>\s*<out>(\d+)<\/out>\s*<color>([^<]+)<\/color>\s*<\/marker>/g,
  ),
];
assert(
  xmlMarkerBlocks.length === 3,
  `exactly 3 <marker> elements from the one markered reel (got ${xmlMarkerBlocks.length})`,
);

// Expected name→color pairing (hook=Green, body=Blue, punchline=Red).
const xmlByName = new Map(
  xmlMarkerBlocks.map((m) => [m[1], { in: Number(m[2]), color: m[4] }]),
);
assert(xmlByName.get('HOOK')?.color === 'Green', 'XML HOOK marker is Green');
assert(xmlByName.get('BODY')?.color === 'Blue', 'XML BODY marker is Blue');
assert(
  xmlByName.get('PUNCHLINE')?.color === 'Red',
  'XML PUNCHLINE marker is Red',
);

// Per-sequence record-frame range (cursor from 0, threshold=0): [0, dur2+dur3).
const xmlRecStart = 0;
const xmlRecEnd = m2.duration_frame + m3.duration_frame;
xmlMarkerBlocks.forEach((m, i) => {
  const recFrame = Number(m[2]);
  assert(
    recFrame >= xmlRecStart && recFrame < xmlRecEnd,
    `XML marker[${i}] record frame ${recFrame} inside reel A range [${xmlRecStart}, ${xmlRecEnd})`,
  );
  // <out> is always <in>+1 (1-frame marker).
  assert(Number(m[3]) === recFrame + 1, `XML marker[${i}] <out> = <in>+1`);
});

// Exact record frames: hook(2)=0, punchline(3)=dur2 (cursor-from-0).
assert(xmlByName.get('HOOK')?.in === 0, 'XML HOOK marker at record frame 0');
assert(
  xmlByName.get('PUNCHLINE')?.in === m2.duration_frame,
  `XML PUNCHLINE marker at record frame ${m2.duration_frame}`,
);

// The unmarked reel's sequence carries zero markers.
const xmlSeqs = markerXML.split('<sequence id="seq_');
assert(
  (xmlSeqs[2].match(/<marker>/g) || []).length === 0,
  'unmarked reel sequence has zero <marker> elements',
);

// A fully marker-free run stays byte-identical to the Test 4 legacy baseline.
const noMarkerXML = generateXML({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});
assert(
  !noMarkerXML.includes('<marker>'),
  'marker-free XML emits zero <marker> elements',
);
assertEq(
  noMarkerXML,
  legXML,
  'marker-free XML byte-identical to legacy baseline',
);

// ─────────────────────────────────────────────────────────────────
// Test 13b: Lua markers — timeline:AddMarker (S-08 Phase 1)
// 3 AddMarker calls (Green/Blue/Red) for the marked reel at the record
// frame each clip was appended; zero for a marker-free run.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 13b: Lua markers (hook/body/punchline) ──────────');

const markerLua = generateLua({
  reelsData: markerReels,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoPath: VIDEO_PATH,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

const addMarkerLines = markerLua
  .split('\n')
  .filter((l) => l.startsWith('timeline:AddMarker('));
assert(
  addMarkerLines.length === 3,
  `exactly 3 AddMarker lines from the one markered reel (got ${addMarkerLines.length})`,
);

// Record frames (cursor from 0, threshold=0): hook(2)=0, body(2)=0,
// punchline(3)=dur2. Color/label per format constant.
assert(
  markerLua.includes('timeline:AddMarker(0, "Green", "HOOK", "", 1, "")'),
  'Lua HOOK marker at frame 0, Green',
);
assert(
  markerLua.includes('timeline:AddMarker(0, "Blue", "BODY", "", 1, "")'),
  'Lua BODY marker at frame 0, Blue',
);
assert(
  markerLua.includes(
    `timeline:AddMarker(${m2.duration_frame}, "Red", "PUNCHLINE", "", 1, "")`,
  ),
  `Lua PUNCHLINE marker at frame ${m2.duration_frame}, Red`,
);

// A fully marker-free run emits zero AddMarker calls (functional baseline).
const noMarkerLua = generateLua({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoPath: VIDEO_PATH,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});
assert(
  !noMarkerLua.includes('timeline:AddMarker('),
  'marker-free Lua emits zero AddMarker calls',
);

// ─────────────────────────────────────────────────────────────────
// Test 13c: FCPXML — structure + clip-local markers (S-08 Phase 2)
// Valid 1.9 skeleton, shared resources, one project per reel, rational
// time, 3 EMPTY <marker value> clip-local for the marked reel, 0 for the
// unmarked reel. The pure fn always needs videoPath in opts (the wrapper
// guards a missing path, not the pure fn — so it is not exercised here).
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 13c: FCPXML structure + markers ─────────────────');

const markerFcpxml = generateFCPXML({
  reelsData: markerReels,
  sentences: newSentences,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

// Skeleton + shared resources.
assert(
  markerFcpxml.startsWith('<?xml version="1.0"'),
  'FCPXML starts with declaration',
);
assert(markerFcpxml.includes('<!DOCTYPE fcpxml>'), 'FCPXML has DOCTYPE');
assert(
  markerFcpxml.includes('<fcpxml version="1.9">'),
  'FCPXML is version 1.9',
);
assert(
  (markerFcpxml.match(/<format /g) || []).length === 1,
  'FCPXML has exactly one <format> in resources',
);
assert(
  (markerFcpxml.match(/<asset /g) || []).length === 1,
  'FCPXML has exactly one shared <asset> in resources',
);
const fcpProjects = markerFcpxml.split('<project name=');
assert(
  fcpProjects.length - 1 === markerReels.length,
  `FCPXML has one <project> per reel (${markerReels.length})`,
);
assert(markerFcpxml.includes('tcFormat="NDF"'), 'FCPXML tcFormat NDF at 25fps');

// Rational-seconds time model (fps=25 → den 2500); never a decimal.
assert(
  /start="\d+\/2500s"/.test(markerFcpxml),
  'FCPXML uses rational-seconds start attributes (…/2500s)',
);

// Clip-local markers: EMPTY <marker start duration value> — no color channel.
const fcpMarkers = [
  ...markerFcpxml.matchAll(
    /<marker start="([^"]+)" duration="([^"]+)" value="([^"]+)"\/>/g,
  ),
];
assert(
  fcpMarkers.length === 3,
  `exactly 3 FCPXML clip-local markers (got ${fcpMarkers.length})`,
);
const fcpValues = fcpMarkers.map((m) => m[3]);
assert(
  fcpValues.includes('HOOK') &&
    fcpValues.includes('BODY') &&
    fcpValues.includes('PUNCHLINE'),
  'FCPXML markers carry HOOK/BODY/PUNCHLINE values',
);

// Each marker start is rational and within its clip's [start, start+duration].
// Reel A spans (threshold=0): clip 2 = [m2.start, m2.end], clip 3 = [m3.start, m3.end].
const ratToFrames = (r) => {
  if (r === '0s') return 0;
  const [numer, denom] = r.replace('s', '').split('/').map(Number);
  return Math.round((numer / denom) * FPS);
};
fcpMarkers.forEach((m, i) => {
  assert(
    /^(\d+\/\d+s|0s)$/.test(m[1]),
    `FCPXML marker[${i}] start is rational`,
  );
  const f = ratToFrames(m[1]);
  const inClip2 = f >= m2.start_frame && f <= m2.end_frame;
  const inClip3 = f >= m3.start_frame && f <= m3.end_frame;
  assert(
    inClip2 || inClip3,
    `FCPXML marker[${i}] start frame ${f} within a clip's [start, start+duration]`,
  );
});

// Exact source frames: hook(2) on clip 2, punchline(3) on clip 3.
const fcpHook = fcpMarkers.find((m) => m[3] === 'HOOK');
assert(
  ratToFrames(fcpHook[1]) === m2.start_frame,
  `FCPXML HOOK marker source frame = ${m2.start_frame}`,
);
const fcpPunch = fcpMarkers.find((m) => m[3] === 'PUNCHLINE');
assert(
  ratToFrames(fcpPunch[1]) === m3.start_frame,
  `FCPXML PUNCHLINE marker source frame = ${m3.start_frame}`,
);

// The unmarked reel's project carries zero markers.
assert(
  !fcpProjects[2].includes('<marker '),
  'unmarked reel project carries zero markers',
);

// ─────────────────────────────────────────────────────────────────
// Test 14: buildPrompt assembly — export-safety invariant (S-03 FR-015)
// The machine-owned response format + DOSTĘPNE SEGMENTY must ALWAYS be
// injected regardless of userPrompt / systemPrompt content (including empty
// systemPrompt), and the passed systemPrompt must appear in the output.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 14: buildPrompt assembly (S-03) ─────────────────');

const customGuidance = 'ZASADY OCENY (test): preferuj krótkie hooki.';
const fullPrompt = buildPrompt(
  'Zrób reelsy z tego webinaru.',
  customGuidance,
  newSentences,
  null,
  VIDEO_FILE,
);

assert(
  fullPrompt.includes('DOSTĘPNE SEGMENTY'),
  'buildPrompt always injects the segments header',
);
assert(
  fullPrompt.includes('"clip_ids"'),
  'buildPrompt always injects the JSON response-format example (clip_ids)',
);
assert(
  fullPrompt.includes('OCZEKIWANY FORMAT ODPOWIEDZI'),
  'buildPrompt always injects the response-format header',
);
assert(
  fullPrompt.includes(customGuidance),
  'buildPrompt includes the passed systemPrompt (scoring guidance)',
);
assert(
  fullPrompt.includes('"start_tc"') &&
    fullPrompt.includes(newSentences[0].text),
  'buildPrompt includes the segment data (timecodes + sentence text)',
);

// Empty systemPrompt must still yield the format + segments (cannot break export).
const emptySysPrompt = buildPrompt('Zrób reelsy.', '', newSentences, null, '');
assert(
  emptySysPrompt.includes('DOSTĘPNE SEGMENTY') &&
    emptySysPrompt.includes('"clip_ids"'),
  'empty systemPrompt still injects format + segments',
);
assert(
  !emptySysPrompt.includes('find every Reel worth cutting'),
  'empty systemPrompt omits scoring guidance (no stray default leaks in)',
);

// The exported default is non-empty and is what state seeds from. S-26 flipped
// this guidance from Polish to English instructions (Polish output retained), so
// the marker is now an English phrase unique to the single-shot scoring block.
assert(
  typeof DEFAULT_SCORING_GUIDANCE === 'string' &&
    DEFAULT_SCORING_GUIDANCE.includes('find every Reel worth cutting'),
  'DEFAULT_SCORING_GUIDANCE is the exported scoring-guidance default',
);

// ─────────────────────────────────────────────────────────────────
// Test 15: word-by-word SRT export (S-19, gapless fill-forward)
// One cue per word; onset-pin (starts never move), each cue held forward to
// the next word's onset (no gaps), final word floor-padded. FPS=25 → 1 frame
// = 40ms.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 15: word-by-word SRT export ─────────────────────');

// Two sentences so flattening crosses a sentence boundary. Words exercise:
//  (a) onset 0, held forward to next onset 20
//  (b) onset 20, held forward across the sentence boundary to next onset 50
//  (c) onset 50, held forward to next onset 52 (sub-floor cue is fine)
//  (d) final word → free pad to floor (no successor)
const wordSrtSentences = [
  {
    id: 1,
    text: 'Słowo drugie',
    start_frame: 0,
    end_frame: 24,
    words: [
      { text: 'Słowo', start_frame: 0, end_frame: 10 }, // (a) end filled to next onset 20
      { text: 'drugie', start_frame: 20, end_frame: 22 }, // (b) end filled to next onset 50
    ],
  },
  {
    id: 2,
    text: 'trzecie czwarte',
    start_frame: 50,
    end_frame: 53,
    words: [
      { text: 'trzecie', start_frame: 50, end_frame: 51 }, // (c) end filled to next onset 52
      { text: 'czwarte', start_frame: 52, end_frame: 53 }, // (d) final → pad to 56
    ],
  },
];

const wordSRT = generateWordSRT(wordSrtSentences, FPS);
const wsLines = wordSRT.split('\n');

// Exact block layout (number / timestamp / text / blank), 4 cues.
const expectedWordSRT = [
  '1',
  '00:00:00,000 --> 00:00:00,800', // (a) start 0 (pinned), end filled to next onset 20
  'Słowo',
  '',
  '2',
  '00:00:00,800 --> 00:00:02,000', // (b) start 20 (pinned), end filled to next onset 50
  'drugie',
  '',
  '3',
  '00:00:02,000 --> 00:00:02,080', // (c) start 50 (pinned), end filled to next onset 52
  'trzecie',
  '',
  '4',
  '00:00:02,080 --> 00:00:02,240', // (d) start 52 (pinned), end 52+4=56 (free pad)
  'czwarte',
  '',
].join('\n');

assertEq(wordSRT, expectedWordSRT, 'word .srt exact onset/fill-forward output');

// Onset-pin: every cue start stamp equals frameToStamp of the word's onset.
assert(wsLines[1].startsWith('00:00:00,000 -->'), '(a) start pinned to 0');
assert(wsLines[5].startsWith('00:00:00,800 -->'), '(b) start pinned to 20');
assert(wsLines[9].startsWith('00:00:02,000 -->'), '(c) start pinned to 50');
assert(wsLines[13].startsWith('00:00:02,080 -->'), '(d) start pinned to 52');

// Fill-forward specifics: each non-final cue ends exactly at the next onset.
assert(
  wsLines[1].endsWith('--> 00:00:00,800'),
  '(a) cue held forward to next onset (frame 20)',
);
assert(
  wsLines[5].endsWith('--> 00:00:02,000'),
  '(b) cue held forward across sentence boundary to next onset (frame 50)',
);
assert(
  wsLines[9].endsWith('--> 00:00:02,080'),
  '(c) cue held forward to next onset (frame 52), sub-floor is fine',
);
assert(
  wsLines[13].endsWith('--> 00:00:02,240'),
  '(d) final word freely padded to the 4-frame floor',
);

// Gapless: every non-final cue's end stamp == the next cue's start stamp.
assert(
  wsLines[1].split(' --> ')[1] === wsLines[5].split(' --> ')[0] &&
    wsLines[5].split(' --> ')[1] === wsLines[9].split(' --> ')[0] &&
    wsLines[9].split(' --> ')[1] === wsLines[13].split(' --> ')[0],
  'cues are gapless: each end meets the next onset exactly',
);

// Skips words lacking numeric frame keys (e.g. stale seconds-only data).
const staleWordSRT = generateWordSRT(
  [
    {
      id: 1,
      text: 'stare',
      words: [
        { text: 'ok', start_frame: 0, end_frame: 10 },
        { text: 'stale', start: 0.5, end: 0.9 }, // seconds-only → skipped
      ],
    },
  ],
  FPS,
);
assert(
  staleWordSRT.includes('ok') && !staleWordSRT.includes('stale'),
  'words lacking numeric start_frame/end_frame are skipped',
);

// ─────────────────────────────────────────────────────────────────
// Test 16: word-SRT reversed-cue / diarized-overlap clamp (S-20 / F1)
// Test 15's onsets strictly increase, so the `Math.max(start, next.start)`
// clamp is never exercised against a successor whose onset PRECEDES the
// current word's start (the diarized / overlapping-onset case). Here word B's
// onset (frame 8) is < word A's start (frame 10). The clamp must yield
// end = max(start, next.start) = start — never a reversed cue (end < start).
// Reverting the guard to `end = next.start_frame` would emit end 8 < start 10.
// FPS=25 → 1 frame = 40ms.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 16: word-SRT reversed-cue / overlap clamp ───────');

const overlapSentences = [
  {
    id: 1,
    text: 'A B',
    start_frame: 8,
    end_frame: 20,
    words: [
      { text: 'A', start_frame: 10, end_frame: 20 }, // dur 10 > floor
      { text: 'B', start_frame: 8, end_frame: 18 }, // onset 8 PRECEDES A's start 10
    ],
  },
];

const overlapSRT = generateWordSRT(overlapSentences, FPS);

const expectedOverlapSRT = [
  '1',
  '00:00:00,400 --> 00:00:00,400', // A: start 10 pinned; end clamped to max(10, 8) = 10
  'A',
  '',
  '2',
  '00:00:00,320 --> 00:00:00,720', // B: final word, start 8 pinned, end 18 (free pad)
  'B',
  '',
].join('\n');

assertEq(
  overlapSRT,
  expectedOverlapSRT,
  'word .srt clamps overlapping onset to start (no reversed cue)',
);

// Every cue is non-reversed: start stamp ≤ end stamp (fixed-width zero-padded
// stamps compare correctly as strings). Fails if the Math.max guard regresses.
const overlapLines = overlapSRT.split('\n');
[1, 5].forEach((tcLine) => {
  const [a, b] = overlapLines[tcLine].split(' --> ');
  assert(
    a <= b,
    `cue at line ${tcLine} is non-reversed (start ≤ end): ${a} --> ${b}`,
  );
});

// ─────────────────────────────────────────────────────────────────
// Test 17: validateThemes — Stage-1 cluster validator (S-25 Phase 4)
// Structural failures throw; hallucinated/non-integer ids are dropped against
// the real segment set; a theme that ends up with zero valid ids is dropped;
// an all-empty result throws. Separate from validateReels (no reel_name here).
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 17: validateThemes (S-25 Phase 4) ───────────────');

const themeSentences = [
  { id: 1, text: 'a' },
  { id: 2, text: 'b' },
  { id: 3, text: 'c' },
  { id: 4, text: 'd' },
];

// Happy path: known ids pass through; order preserved as given.
const okThemes = validateThemes(
  {
    themes: [
      { title: 'Temat A', candidate_ids: [1, 2] },
      { title: 'Temat B', candidate_ids: [3, 4] },
    ],
  },
  themeSentences,
);
assert(
  okThemes.length === 2 &&
    okThemes[0].candidate_ids.join(',') === '1,2' &&
    okThemes[1].title === 'Temat B',
  'validateThemes passes valid themes through unchanged',
);

// Hallucinated / non-integer ids are dropped; known ones kept; dupes collapsed.
const dropped = validateThemes(
  { themes: [{ title: 'T', candidate_ids: [1, 99, 2, 2, 3.5, 'x'] }] },
  themeSentences,
);
assert(
  dropped.length === 1 && dropped[0].candidate_ids.join(',') === '1,2',
  'validateThemes drops unknown/non-integer/duplicate ids, keeps known',
);

// A theme whose ids are all hallucinated is dropped entirely.
const emptyThemeDropped = validateThemes(
  {
    themes: [
      { title: 'Good', candidate_ids: [1] },
      { title: 'AllFake', candidate_ids: [100, 200] },
    ],
  },
  themeSentences,
);
assert(
  emptyThemeDropped.length === 1 && emptyThemeDropped[0].title === 'Good',
  'validateThemes drops a theme with zero valid ids',
);

// Structural failures throw.
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
assert(
  throws(() => validateThemes([], themeSentences)),
  'validateThemes throws on a non-object (array) top level',
);
assert(
  throws(() => validateThemes({ themes: [] }, themeSentences)),
  'validateThemes throws on empty themes array',
);
assert(
  throws(() =>
    validateThemes(
      { themes: [{ title: '', candidate_ids: [1] }] },
      themeSentences,
    ),
  ),
  'validateThemes throws on a theme missing a title',
);
assert(
  throws(() =>
    validateThemes(
      { themes: [{ title: 'T', candidate_ids: [999] }] },
      themeSentences,
    ),
  ),
  'validateThemes throws when no theme has any valid ids',
);

// ─────────────────────────────────────────────────────────────────
// Test 18: buildResolveTimeline — Mode D clip+marker payload (S-09 Phase 2)
// The Electron WI panel drives the live Resolve API directly (AppendToTimeline +
// AddMarker) from this pure builder instead of importing FCPXML (rejected live,
// errorCode 6). Frame-math mirrors lua.js exactly: ALL reels on ONE timeline, the
// record cursor running continuously with `gapFrames` of empty timeline between
// consecutive reels. recordFrame is 0-based (NEVER the EDL 3600*fps offset);
// markers carry the live AddMarker color vocabulary (hook=Green/body=Blue/
// punchline=Red) at their continuous record frames.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 18: buildResolveTimeline (Mode D payload) ───────');

const m7 = newSentences.find((s) => s.id === 7);
const m8 = newSentences.find((s) => s.id === 8);
const reelADur = m2.duration_frame + m3.duration_frame; // clips 2+3
const resolveTl = buildResolveTimeline({
  reelsData: markerReels, // reel A {hook:2,body:2,punchline:3} + marker-free reel B [7,8]
  sentences: newSentences,
  mergeThreshold: MERGE_0,
  gapFrames: GAP_FRAMES,
  name: PROJECT_NAME,
});

assert(resolveTl.name === PROJECT_NAME, 'timeline carries the project name');

// One flat clip list across both reels: clips 2, 3 (reel A) then 7, 8 (reel B).
assert(
  resolveTl.clips.length === 4,
  `single timeline holds all 4 clips (got ${resolveTl.clips.length})`,
);

// Reel A clips: source frames map to the span start/end; recordFrame is the
// 0-based continuous cursor (clip2=0, clip3=dur2).
assert(
  resolveTl.clips[0].startFrame === m2.start_frame &&
    resolveTl.clips[0].endFrame === m2.end_frame,
  'clip[0] source frames = clip 2 span',
);
assert(
  resolveTl.clips[0].recordFrame === 0,
  'clip[0] recordFrame is 0-based (no 3600*fps offset)',
);
assert(
  resolveTl.clips[1].recordFrame === m2.duration_frame,
  `clip[1] recordFrame = dur2 (${m2.duration_frame}) — cursor advances`,
);

// Inter-reel gap: reel B's first clip (clip 7) starts after reel A's total
// duration PLUS gapFrames — the continuous single-timeline cursor, not a reset.
assert(
  resolveTl.clips[2].startFrame === m7.start_frame,
  'clip[2] source frames = clip 7 span',
);
assert(
  resolveTl.clips[2].recordFrame === reelADur + GAP_FRAMES,
  `clip[2] recordFrame = reelADur + gap (${reelADur} + ${GAP_FRAMES})`,
);
assert(
  resolveTl.clips[3].recordFrame === reelADur + GAP_FRAMES + m7.duration_frame,
  'clip[3] recordFrame continues after clip 7 (no second gap mid-reel)',
);

// Markers: 3 from reel A (reel B is marker-free), at their continuous record
// frames. Colors per the live AddMarker vocabulary; hook(2)=0, body(2)=0,
// punchline(3)=dur2.
assert(
  resolveTl.markers.length === 3,
  `timeline carries 3 markers from reel A (got ${resolveTl.markers.length})`,
);
const resByLabel = new Map(resolveTl.markers.map((m) => [m.label, m]));
assert(
  resByLabel.get('HOOK')?.color === 'Green' &&
    resByLabel.get('HOOK')?.frame === 0,
  'HOOK marker is Green at frame 0',
);
assert(
  resByLabel.get('BODY')?.color === 'Blue' &&
    resByLabel.get('BODY')?.frame === 0,
  'BODY marker is Blue at frame 0',
);
assert(
  resByLabel.get('PUNCHLINE')?.color === 'Red' &&
    resByLabel.get('PUNCHLINE')?.frame === m2.duration_frame,
  `PUNCHLINE marker is Red at frame dur2 (${m2.duration_frame})`,
);

// gapFrames=0 collapses the inter-reel gap: reel B's first clip lands exactly at
// reel A's total duration (no empty frames between reels).
const noGapTl = buildResolveTimeline({
  reelsData: markerReels,
  sentences: newSentences,
  mergeThreshold: MERGE_0,
  gapFrames: 0,
  name: PROJECT_NAME,
});
assert(
  noGapTl.clips[2].recordFrame === reelADur,
  'gapFrames=0 → reel B starts at reelADur (no inter-reel gap)',
);

// Merge path: adjacent clips 9+10 collapse to one span (threshold=12), so the
// timeline yields a single clip covering both — same span source as the exporters.
const mergedTl = buildResolveTimeline({
  reelsData: [{ reel_name: 'R', clip_ids: [9, 10] }],
  sentences: newSentences,
  mergeThreshold: MERGE_12,
  gapFrames: GAP_FRAMES,
  name: PROJECT_NAME,
});
assert(
  mergedTl.clips.length === 1 &&
    mergedTl.clips[0].startFrame === s9.start_frame &&
    mergedTl.clips[0].endFrame === s10.end_frame,
  'merged clips 9+10 produce one span [clip9.start, clip10.end]',
);

// ─────────────────────────────────────────────────────────────────
// Test 19: SRT words-per-cue + punctuation removal
// generateWordSRT groups `wordsPerCue` words into one cue without crossing a
// sentence boundary (same onset/fill-forward timing as Test 15, per group);
// wordsPerCue=1 must stay byte-identical to the default output. The
// stripPunctuation option removes sentence marks but keeps word-internal
// hyphens/apostrophes and digit separators, and drops cues/words left empty.
// FPS=25 → 1 frame = 40ms.
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 19: SRT words-per-cue + punctuation removal ─────');

assertEq(
  stripPunctuation('Cześć, jak się macie?'),
  'Cześć jak się macie',
  'stripPunctuation: comma + question mark removed',
);
assertEq(
  stripPunctuation('„Tak” — powiedział… (cicho)!'),
  'Tak powiedział cicho',
  'stripPunctuation: quotes, dash, ellipsis, brackets removed; spaces collapsed',
);
assertEq(
  stripPunctuation("e-mail, biało-czerwony i don't"),
  "e-mail biało-czerwony i don't",
  'stripPunctuation: word-internal hyphen/apostrophe kept',
);
assertEq(
  stripPunctuation('Kosztuje 3,5 zł o 12:30, czyli 1.000 razy.'),
  'Kosztuje 3,5 zł o 12:30 czyli 1.000 razy',
  'stripPunctuation: digit separators kept, trailing marks removed',
);
assertEq(
  stripPunctuation('50% & @user #tag'),
  '50% & @user #tag',
  'stripPunctuation: meaningful symbols (% & @ #) kept',
);
assertEq(
  stripPunctuation('tak—nie'),
  'tak nie',
  'stripPunctuation: dash between words becomes a space',
);
assertEq(
  stripPunctuation('linia 1.\nlinia 2!'),
  'linia 1\nlinia 2',
  'stripPunctuation: line breaks preserved',
);
assertEq(stripPunctuation('…'), '', 'stripPunctuation: punctuation-only → ""');

assert(
  normalizeWordsPerCue(undefined) === 1 &&
    normalizeWordsPerCue(0) === 1 &&
    normalizeWordsPerCue('abc') === 1 &&
    normalizeWordsPerCue('3') === 3 &&
    normalizeWordsPerCue(3.7) === 3 &&
    normalizeWordsPerCue(99) === 10,
  'normalizeWordsPerCue clamps to an integer in 1..10 (fallback 1)',
);

// wordsPerCue=1 is the classic mode — byte-identical to the default output.
assertEq(
  generateWordSRT(wordSrtSentences, FPS, { wordsPerCue: 1 }),
  wordSRT,
  'wordsPerCue=1 is byte-identical to the default word .srt',
);

// wordsPerCue=2 on Test 15's data: each sentence is exactly one cue, and the
// cue does not borrow a word from the next sentence.
assertEq(
  generateWordSRT(wordSrtSentences, FPS, { wordsPerCue: 2 }),
  [
    '1',
    '00:00:00,000 --> 00:00:02,000', // start 0, held to next cue onset 50
    'Słowo drugie',
    '',
    '2',
    '00:00:02,000 --> 00:00:02,160', // start 50, final: max(53, 50+4) = 54
    'trzecie czwarte',
    '',
  ].join('\n'),
  'wordsPerCue=2 groups words per sentence with group fill-forward timing',
);

const punctSentences = [
  {
    id: 1,
    text: 'Cześć, jak się macie?',
    start_frame: 0,
    end_frame: 40,
    words: [
      { text: 'Cześć,', start_frame: 0, end_frame: 10 },
      { text: 'jak', start_frame: 12, end_frame: 18 },
      { text: 'się', start_frame: 20, end_frame: 26 },
      { text: 'macie?', start_frame: 28, end_frame: 40 },
    ],
  },
  {
    id: 2,
    text: '…',
    start_frame: 40,
    end_frame: 50,
    words: [],
  },
  {
    id: 3,
    text: 'To – test.',
    start_frame: 60,
    end_frame: 80,
    words: [
      { text: 'To', start_frame: 60, end_frame: 66 },
      { text: '–', start_frame: 68, end_frame: 70 },
      { text: 'test.', start_frame: 72, end_frame: 80 },
    ],
  },
];

// wordsPerCue=3: sentence 1 splits 3 + 1 (the remainder stays in its sentence).
assertEq(
  generateWordSRT(punctSentences, FPS, { wordsPerCue: 3 }),
  [
    '1',
    '00:00:00,000 --> 00:00:01,120', // start 0, held to next cue onset 28
    'Cześć, jak się',
    '',
    '2',
    '00:00:01,120 --> 00:00:02,400', // start 28, held to next cue onset 60
    'macie?',
    '',
    '3',
    '00:00:02,400 --> 00:00:03,200', // start 60, final: last word end 80
    'To – test.',
    '',
  ].join('\n'),
  'wordsPerCue=3 splits a 4-word sentence 3+1, never across sentences',
);

// Same with punctuation removal: the lone "–" word vanishes before grouping.
assertEq(
  generateWordSRT(punctSentences, FPS, {
    wordsPerCue: 3,
    stripPunctuation: true,
  }),
  [
    '1',
    '00:00:00,000 --> 00:00:01,120',
    'Cześć jak się',
    '',
    '2',
    '00:00:01,120 --> 00:00:02,400',
    'macie',
    '',
    '3',
    '00:00:02,400 --> 00:00:03,200',
    'To test',
    '',
  ].join('\n'),
  'word .srt + stripPunctuation drops marks and punctuation-only words',
);

// Sentence-level: stripping renumbers after dropping the "…"-only cue; without
// the option the output keeps every cue verbatim (unchanged default).
assertEq(
  generateTranscriptSRT(punctSentences, FPS, { stripPunctuation: true }),
  [
    '1',
    '00:00:00,000 --> 00:00:01,600',
    'Cześć jak się macie',
    '',
    '2',
    '00:00:02,400 --> 00:00:03,200',
    'To test',
    '',
  ].join('\n'),
  'sentence .srt + stripPunctuation drops the empty cue and renumbers',
);
assert(
  generateTranscriptSRT(punctSentences, FPS).includes(
    '2\n00:00:01,600 --> 00:00:02,000\n…',
  ),
  'sentence .srt without the option keeps punctuation-only cues verbatim',
);

// ─────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ${passed} passed  ${failed} failed`);
if (failed > 0) {
  console.log('  STATUS: FAIL');
  process.exit(1);
} else {
  console.log('  STATUS: PASS — Phase 1 regression complete');
}
