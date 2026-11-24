import { describe, expect, it } from 'vitest';
import { findAll, findSegment, flatten } from './invariants';
import { Bytes, concat, fixture, parseChecked } from './testkit';

const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
  const body = concat(...payload);
  return concat(new Bytes().u32be(8 + body.length).ascii(type).done(), body);
};

describe('MP4 / MOV / M4A (ISOBMFF)', () => {
  it('walks ftyp → moov → trak → mdia → minf → stbl with real track details', async () => {
    const bytes = fixture('video.mp4');
    const st = await parseChecked(bytes, 'mp4');
    expect(st.segments.map((s) => s.name)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
    expect(st.segments[0]!.detail).toContain('isom');
    const traks = findAll(st, 'trak');
    expect(traks).toHaveLength(2);
    expect(traks[0]!.detail).toContain('video (vide)');
    expect(traks[0]!.detail).toContain('avc1 H.264');
    expect(traks[0]!.detail).toContain('160×120');
    expect(traks[0]!.detail).toContain('15 fps');
    expect(traks[0]!.detail).toContain('30 samples');
    expect(traks[1]!.detail).toContain('audio (soun)');
    expect(traks[1]!.detail).toContain('mp4a AAC');
    const stbl = findAll(st, 'stbl')[0]!;
    expect(stbl.role).toBe('index');
    const mdat = findSegment(st, 'mdat')!;
    expect(mdat.role).toBe('samples');
    expect(mdat.offset + mdat.length).toBe(bytes.length);
    expect(findSegment(st, 'free')!.role).toBe('padding');
    expect(st.summary).toBe('MP4 (isom) · H.264 160×120 · AAC 44.1 kHz mono · 2.00 s');
  });

  it('puts moov after mdat for non-faststart QuickTime files', async () => {
    const st = await parseChecked(fixture('video.mov'), 'mov');
    expect(st.segments.map((s) => s.name)).toEqual(['ftyp', 'wide', 'mdat', 'moov']);
    expect(st.summary).toContain('QuickTime');
  });

  it('groups fragments of fragmented MP4 as moof + mdat', async () => {
    const st = await parseChecked(fixture('video-frag.mp4'), 'mp4');
    const frag = findSegment(st, 'moof + mdat')!;
    expect(frag.children!.map((c) => c.name)).toEqual(['moof', 'mdat']);
    expect(st.summary).toContain('fragmented');
    expect(findSegment(st, 'mfra')!.role).toBe('container');
  });

  it('reads M4A audio sample entries', async () => {
    const st = await parseChecked(fixture('tone.m4a'), 'm4a');
    expect(findAll(st, 'trak')[0]!.detail).toContain('44.1 kHz stereo');
    expect(st.summary).toContain('AAC 44.1 kHz stereo');
    expect(findSegment(st, 'mdat')!.role).toBe('samples');
  });

  it('parses raw AAC (ADTS) filed as m4a', async () => {
    const st = await parseChecked(fixture('tone.aac'), 'm4a');
    expect(st.segments[0]!.name).toBe('ADTS frames');
    expect(st.segments[0]!.count).toBeGreaterThan(30);
    expect(st.summary).toContain('AAC (ADTS) 44.1 kHz stereo');
  });

  it('reads HEIC items: iinf types, iloc, ispe and image data as pixels', async () => {
    const st = await parseChecked(fixture('sample.heic'), 'heic');
    expect(st.segments.map((s) => s.name)).toEqual(['ftyp', 'meta', 'mdat']);
    expect(findSegment(st, 'iinf')!.detail).toContain('hvc1 ×2');
    expect(findSegment(st, 'iinf')!.detail).toContain('Exif');
    expect(findSegment(st, 'iloc')!.detail).toContain('4 item locations');
    expect(findSegment(st, 'ispe')!.detail).toBe('200×120');
    expect(findSegment(st, 'mdat')!.role).toBe('pixels');
    expect(findSegment(st, 'colr')!.role).toBe('palette');
    expect(st.summary).toContain('HEIC (heic) · 200×120');
  });

  it('reads AVIF', async () => {
    const st = await parseChecked(fixture('still.avif'), 'avif');
    expect(findSegment(st, 'ispe')!.detail).toBe('64×64');
    expect(findSegment(st, 'av1C')).toBeDefined();
    expect(st.summary).toContain('AVIF');
  });

  it('handles 64-bit sizes and size-0 boxes (to end of file)', async () => {
    const ftyp = box('ftyp', new Bytes().ascii('isom').u32be(0).ascii('isom').done());
    const free64 = concat(new Bytes().u32be(1).ascii('free').u64be(16 + 10).done(), new Uint8Array(10));
    const mdat0 = concat(new Bytes().u32be(0).ascii('mdat').done(), new Uint8Array(100));
    const bytes = concat(ftyp, free64, mdat0);
    const st = await parseChecked(bytes, 'mp4');
    expect(st.segments.map((s) => [s.name, s.length])).toEqual([
      ['ftyp', ftyp.length],
      ['free', 26],
      ['mdat', 108],
    ]);
  });

  it('survives zero/invalid box sizes without looping', async () => {
    const bytes = concat(box('ftyp', new Bytes().ascii('isom').u32be(0).done()), new Bytes().u32be(4).ascii('moov').done(), new Uint8Array(40));
    const st = await parseChecked(bytes, 'mp4');
    expect(st.segments[0]!.name).toBe('ftyp');
    expect(st.segments.at(-1)!.role).toBe('unknown');
  });
});

describe('Matroska / WebM (EBML)', () => {
  it('reads DocType, Info, Tracks and merges clusters', async () => {
    const bytes = fixture('video.webm');
    const st = await parseChecked(bytes, 'webm');
    expect(st.segments[0]).toMatchObject({ name: 'EBML', offset: 0 });
    expect(st.segments[0]!.detail).toBe('DocType webm v4');
    const seg = findSegment(st, 'Segment')!;
    expect(seg.offset + seg.length).toBe(bytes.length);
    expect(seg.children!.map((c) => c.name)).toEqual(['SeekHead', 'Void', 'Info', 'Tracks', 'Tags', 'Cluster', 'Cues']);
    const tracks = findAll(st, 'TrackEntry');
    expect(tracks[0]!.detail).toContain('V_VP9 (VP9)');
    expect(tracks[0]!.detail).toContain('160×120');
    expect(tracks[1]!.detail).toContain('A_OPUS (Opus)');
    expect(findSegment(st, 'Cluster')!.role).toBe('samples');
    expect(findSegment(st, 'Cues')!.role).toBe('index');
    expect(findSegment(st, 'Void')!.role).toBe('padding');
    expect(st.summary).toMatch(/^WebM · VP9 160×120 · Opus 48 kHz mono · 2\.0\d s · 1 cluster$/);
  });

  it('labels matroska files', async () => {
    const st = await parseChecked(fixture('video.mkv'), 'mkv');
    expect(st.segments[0]!.detail).toContain('matroska');
    expect(st.summary!.startsWith('Matroska')).toBe(true);
  });

  it('handles unknown-size segments and clusters (live streams)', async () => {
    const vint1 = (n: number) => new Bytes().u8(0x80 | n).done();
    const el = (id: number[], payload: Uint8Array) => concat(new Uint8Array(id), vint1(payload.length), payload);
    const unknown = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const ebml = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], new TextEncoder().encode('webm')));
    const cluster = (n: number) => concat(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), unknown, el([0xe7], new Uint8Array([n])), el([0xa3], new Uint8Array(20)));
    const bytes = concat(ebml, new Uint8Array([0x18, 0x53, 0x80, 0x67]), unknown, cluster(0), cluster(1), cluster(2));
    const st = await parseChecked(bytes, 'webm');
    const cl = findSegment(st, 'Cluster')!;
    expect(cl.count).toBe(3);
    expect(findSegment(st, 'Segment')!.offset + findSegment(st, 'Segment')!.length).toBe(bytes.length);
  });
});

describe('MP3', () => {
  it('reads ID3v2 frames, the Info header and merges MPEG frames', async () => {
    const bytes = fixture('tone.mp3');
    const st = await parseChecked(bytes, 'mp3');
    expect(st.segments.map((s) => s.name)).toEqual(['ID3v2.4.0', 'Info header', 'MPEG frames']);
    expect(st.segments[0]!.children![0]).toMatchObject({ name: 'TSSE', role: 'metadata' });
    const frames = findSegment(st, 'MPEG frames')!;
    expect(frames.count).toBe(40);
    expect(frames.detail).toContain('CBR 64 kbps');
    expect(frames.detail).toContain('44.1 kHz stereo');
    // 40 frames × 1152 samples at 44.1 kHz
    expect(st.summary).toContain('64 kbps · 44.1 kHz stereo · 1.04 s');
    expect(frames.offset + frames.length).toBe(bytes.length);
  });

  it('finds ID3v1 trailers', async () => {
    const base = fixture('tone.mp3');
    const v1 = new Uint8Array(128);
    v1.set(new TextEncoder().encode('TAG'));
    v1.set(new TextEncoder().encode('Song title'), 3);
    const st = await parseChecked(concat(base, v1), 'mp3');
    const tag = findSegment(st, 'ID3v1')!;
    expect(tag.length).toBe(128);
    expect(tag.offset).toBe(base.length);
    expect(tag.detail).toContain('Song title');
  });

  it('extrapolates long files without reading them', async () => {
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    const n = 20_000;
    const big = new Uint8Array(frame.length * n);
    for (let i = 0; i < n; i++) big.set(frame, i * frame.length);
    const st = await parseChecked(big, 'mp3');
    const f = findSegment(st, 'MPEG frames')!;
    expect(f.length).toBe(big.length);
    expect(f.count).toBe(n);
    expect(f.detail).toMatch(/^~/);
  });
});

describe('FLAC', () => {
  it('reads STREAMINFO values and the frame run', async () => {
    const st = await parseChecked(fixture('tone.flac'), 'flac');
    expect(st.segments.map((s) => s.name)).toEqual(['fLaC', 'STREAMINFO', 'VORBIS_COMMENT', 'PADDING', 'frames']);
    const si = findSegment(st, 'STREAMINFO')!;
    expect(si.detail).toContain('44.1 kHz');
    expect(si.detail).toContain('stereo');
    expect(si.detail).toContain('16-bit');
    expect(si.detail).toContain('44,100 samples');
    expect(findSegment(st, 'PADDING')!.role).toBe('padding');
    expect(findSegment(st, 'frames')!.role).toBe('samples');
    expect(st.summary).toBe('FLAC 44.1 kHz stereo 16-bit · 1.00 s');
  });
});

describe('Ogg', () => {
  const page = (serial: number, seq: number, flags: number, granule: number, data: Uint8Array): Uint8Array => {
    const lacing: number[] = [];
    let left = data.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
    return concat(new Bytes().ascii('OggS').u8(0, flags).u64le(granule).u32le(serial).u32le(seq).u32le(0).u8(lacing.length, ...lacing).done(), data);
  };
  const vorbisId = new Bytes().u8(1).ascii('vorbis').u32le(0).u8(2).u32le(44100).u32le(0).u32le(128000).u32le(0).u8(0xb8, 1).done();

  it('reads Opus identification and merges audio pages', async () => {
    const st = await parseChecked(fixture('tone.opus'), 'ogg');
    expect(st.segments[0]!.name).toBe('Opus identification header');
    expect(st.segments[0]!.role).toBe('header');
    expect(st.segments[1]!.name).toBe('Opus comment header');
    expect(st.segments[1]!.role).toBe('metadata');
    expect(st.summary).toContain('Opus 48 kHz stereo');
  });

  it('merges 500 Vorbis pages per logical stream', async () => {
    const pages = [
      page(7, 0, 2, 0, vorbisId),
      page(7, 1, 0, 0, concat(new Uint8Array([3]), new TextEncoder().encode('vorbis'), new Uint8Array(20))),
      page(7, 2, 0, 0, concat(new Uint8Array([5]), new TextEncoder().encode('vorbis'), new Uint8Array(40))),
    ];
    for (let i = 0; i < 500; i++) pages.push(page(7, 3 + i, i === 499 ? 4 : 0, (i + 1) * 1024, new Uint8Array(100)));
    const st = await parseChecked(concat(...pages), 'ogg');
    expect(st.segments.map((s) => s.name)).toEqual(['Vorbis identification header', 'Vorbis comment header', 'Vorbis setup header', 'Vorbis pages']);
    expect(st.segments[3]!.count).toBe(500);
    expect(st.segments[0]!.detail).toContain('44.1 kHz');
    expect(st.summary).toContain('Vorbis 44.1 kHz stereo');
    expect(st.summary).toContain('503 pages');
  });

  it('keeps multiplexed streams distinct', async () => {
    const bytes = concat(page(1, 0, 2, 0, vorbisId), page(2, 0, 2, 0, vorbisId), page(1, 1, 0, 500, new Uint8Array(30)), page(2, 1, 0, 500, new Uint8Array(30)));
    const st = await parseChecked(bytes, 'ogg');
    expect(st.segments.length).toBe(4);
  });
});

describe('WAV', () => {
  it('reads fmt values and the data chunk duration', async () => {
    const bytes = fixture('tone.wav');
    const st = await parseChecked(bytes, 'wav');
    const fmt = findSegment(st, 'fmt')!;
    expect(fmt.detail).toBe('PCM · 44.1 kHz · stereo · 16-bit');
    const data = findSegment(st, 'data')!;
    expect(data.role).toBe('samples');
    expect(data.offset + data.length).toBe(bytes.length);
    expect(data.detail).toContain('1.00 s');
    expect(findSegment(st, 'ISFT')).toBeDefined(); // LIST children
    expect(st.summary).toBe('WAV PCM 44.1 kHz stereo 16-bit · 1.00 s');
  });

  it('treats alignment filler as padding', async () => {
    const st = await parseChecked(fixture('tone-22k.wav'), 'wav');
    expect(findSegment(st, 'FLLR')!.role).toBe('padding');
    expect(st.summary).toContain('22.05 kHz');
  });

  it('clamps a data chunk that claims more than the file holds', async () => {
    const b = new Bytes().ascii('RIFF').u32le(0xffffffff).ascii('WAVE').ascii('fmt ').u32le(16).u16le(1).u16le(1).u32le(8000).u32le(16000).u16le(2).u16le(16).ascii('data').u32le(0xffffffff).zeros(1000).done();
    const st = await parseChecked(b, 'wav');
    expect(findSegment(st, 'data')!.length).toBe(1000 + 8);
    expect(flatten(st.segments).every((s) => s.offset + s.length <= b.length)).toBe(true);
  });
});
