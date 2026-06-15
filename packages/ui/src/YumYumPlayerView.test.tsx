import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { YumYumPlayerView, type PlayerHandle } from './YumYumPlayerView.js';

// ====================================================================
// End-to-end scrub → player.seek() regression test for the theater
// player chrome. The scrubber (`Timeline`) is driven entirely by POINTER
// events: `onSeek` (→ player.seek) fires only on `pointerup`, and a
// `scrubbing` ref gates the time display between pointerdown/pointerup.
//
// A previous "seek freeze" was a *test* artifact: driving the track with
// mouse events (mousedown/mouseup) — which the component does not listen
// for — silently never seeks and would have left `scrubbing` stuck. These
// tests exercise the real path with correct pointer events (pointerdown →
// pointermove → pointerup carrying a pointerId) and assert seek actually
// fires, scrubbing clears, and the time display resumes from telemetry.
//
// The player is mocked at the structural `PlayerHandle` seam, so nothing
// here touches WebCodecs/AudioContext/canvas decoding — fully deterministic.
// ====================================================================

interface Telemetry {
  currentPTS: number;
  duration: number;
  bufferedEnd: number;
  playbackState: string;
  playbackRate: number;
  renderedFrames: number;
  activeCodec: string;
  queueLength: number;
}

/** A controllable mock player. Mutate `telemetry` to simulate playback. */
function makeMockPlayer(overrides: Partial<Telemetry> = {}) {
  const telemetry: Telemetry = {
    currentPTS: 50, // start mid-stream so we can scrub both forward and back
    duration: 100,
    bufferedEnd: 80,
    playbackState: 'PLAYING',
    playbackRate: 1,
    renderedFrames: 0,
    activeCodec: 'h264',
    queueLength: 5,
    ...overrides,
  };

  const player: PlayerHandle = {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    mute: vi.fn(),
    setPlaybackRate: vi.fn(),
    getPlaybackRate: vi.fn(() => telemetry.playbackRate),
    getCurrentTime: vi.fn(() => telemetry.currentPTS),
    getDuration: vi.fn(() => telemetry.duration),
    // Always report a fresh, ever-advancing renderedFrames so the view's
    // stall detector never trips the buffering spinner during the test.
    getTelemetry: vi.fn(() => ({ ...telemetry, renderedFrames: telemetry.renderedFrames++ })),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
  };

  return { player, telemetry };
}

/**
 * Render the view, wait for the player to load + the poll loop to publish
 * duration, then hand back the timeline track with a deterministic geometry.
 * jsdom does no layout, so `getBoundingClientRect` is stubbed to a 200px-wide
 * track at x=0 → clientX maps linearly to time (clientX === percent × 2).
 */
async function renderPlayer(overrides: Partial<Telemetry> = {}) {
  const { player, telemetry } = makeMockPlayer(overrides);
  const createPlayer = vi.fn().mockResolvedValue({ player, isLive: false });
  const { container } = render(<YumYumPlayerView createPlayer={createPlayer} />);

  // The poll interval (250ms) publishes telemetry.duration into state; the
  // time display reads "<current> / <duration>" once it lands.
  await waitFor(() => {
    expect(screen.getByText(`${fmt(telemetry.currentPTS)} / 1:40`)).toBeTruthy();
  });

  const track = container.querySelector('.yyv-tlwrap') as HTMLElement;
  expect(track).toBeTruthy();
  track.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

  return { player, telemetry, track };
}

/** Mirror of the component's mm:ss formatter, for building expected strings. */
function fmt(seconds: number): string {
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const m = Math.floor((seconds / 60) % 60);
  return `${m}:${s}`;
}

/** clientX on the 200px track → seconds (track maps 0..200px to 0..duration). */
const SEEK_TO = (seconds: number, duration = 100) => (seconds / duration) * 200;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('YumYumPlayerView scrubber → player.seek()', () => {
  it('seeks forward to the dragged position on pointerup and resumes time updates', async () => {
    const { player, telemetry, track } = await renderPlayer();

    // pointerdown engages scrubbing; the time display switches to the
    // scrub position immediately (no seek yet — seek waits for pointerup).
    fireEvent.pointerDown(track, { clientX: SEEK_TO(50), pointerId: 1 });
    expect(player.seek).not.toHaveBeenCalled();
    expect(screen.getByText('0:50 / 1:40')).toBeTruthy();

    // Drag forward to 90s; display follows the scrub head, still no seek.
    fireEvent.pointerMove(track, { clientX: SEEK_TO(90), pointerId: 1 });
    expect(screen.getByText('1:30 / 1:40')).toBeTruthy();
    expect(player.seek).not.toHaveBeenCalled();

    // pointerup commits the seek and ends the scrub.
    fireEvent.pointerUp(track, { clientX: SEEK_TO(90), pointerId: 1 });
    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(90);
    expect(player.pause).not.toHaveBeenCalled(); // scrubbing must not pause playback

    // scrubbing is cleared → the poll loop is no longer gated, so a new
    // telemetry position flows back into the time display. If `scrubbing`
    // were stuck, this would stay frozen at the scrub head (the old bug).
    telemetry.currentPTS = 92;
    await waitFor(() => {
      expect(screen.getByText('1:32 / 1:40')).toBeTruthy();
    });
  });

  it('seeks backward on pointerup', async () => {
    const { player, track } = await renderPlayer();

    fireEvent.pointerDown(track, { clientX: SEEK_TO(50), pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: SEEK_TO(10), pointerId: 1 });
    expect(screen.getByText('0:10 / 1:40')).toBeTruthy();
    fireEvent.pointerUp(track, { clientX: SEEK_TO(10), pointerId: 1 });

    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(10);
  });

  it('seeks on a simple click (pointerdown then pointerup at the same spot)', async () => {
    const { player, track } = await renderPlayer();

    fireEvent.pointerDown(track, { clientX: SEEK_TO(25), pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: SEEK_TO(25), pointerId: 1 });

    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(25);
  });

  it('clamps a drag past the track edges to [0, duration]', async () => {
    const { player, track } = await renderPlayer();

    fireEvent.pointerDown(track, { clientX: SEEK_TO(50), pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 9999, pointerId: 1 }); // far past the right edge

    expect(player.seek).toHaveBeenCalledWith(100); // clamped to duration, not NaN/overflow
  });

  // Regression guard for the false "seek freeze": the scrubber listens only
  // for POINTER events. Mouse events must be a silent no-op — never seek and,
  // crucially, never leave `scrubbing` engaged (the time display keeps
  // tracking telemetry).
  it('ignores mouse-only events (no pointerId) — never seeks, never freezes', async () => {
    const { player, telemetry, track } = await renderPlayer();

    fireEvent.mouseDown(track, { clientX: SEEK_TO(90) });
    fireEvent.mouseUp(track, { clientX: SEEK_TO(90) });

    expect(player.seek).not.toHaveBeenCalled();

    // Time display is not frozen — telemetry still drives it.
    telemetry.currentPTS = 60;
    await waitFor(() => {
      expect(screen.getByText('1:00 / 1:40')).toBeTruthy();
    });
  });

  describe('chrome presets', () => {
    it('renders full chrome controls by default', async () => {
      const { player } = makeMockPlayer();
      const createPlayer = vi.fn().mockResolvedValue({ player, isLive: false });
      const { container } = render(<YumYumPlayerView createPlayer={createPlayer} />);
      
      await waitFor(() => {
        expect(container.querySelector('.yyv-bar')).toBeTruthy();
        expect(container.querySelector('.yyv-bar-minimal')).toBeFalsy();
      });
    });

    it('renders minimal chrome with only volume and fullscreen buttons', async () => {
      const { player } = makeMockPlayer();
      const createPlayer = vi.fn().mockResolvedValue({ player, isLive: false });
      const { container } = render(<YumYumPlayerView createPlayer={createPlayer} chrome="minimal" />);
      
      await waitFor(() => {
        expect(container.querySelector('.yyv-bar-minimal')).toBeTruthy();
        expect(container.querySelector('.yyv-tlwrap')).toBeFalsy();
        expect(container.querySelector('button[aria-label="Play"]')).toBeFalsy();
        expect(container.querySelector('button[aria-label="Settings"]')).toBeFalsy();
        expect(container.querySelector('.yyv-vol')).toBeTruthy();
        expect(container.querySelector('.yyv-btn-fullscreen')).toBeTruthy();
      });
    });

    it('renders no chrome when chrome="none"', async () => {
      const { player } = makeMockPlayer();
      const createPlayer = vi.fn().mockResolvedValue({ player, isLive: false });
      const { container } = render(<YumYumPlayerView createPlayer={createPlayer} chrome="none" />);
      
      await waitFor(() => {
        expect(container.querySelector('.yyv-bar')).toBeFalsy();
        expect(container.querySelector('.yyv-bar-minimal')).toBeFalsy();
      });
    });
  });

  describe('onReady handle', () => {
    it('passes the player handle to onReady so the host can drive playback', async () => {
      const { player } = makeMockPlayer();
      const createPlayer = vi.fn().mockResolvedValue({ player, isLive: true });
      const onReady = vi.fn();
      const { unmount } = render(
        <YumYumPlayerView createPlayer={createPlayer} chrome="none" onReady={onReady} />,
      );

      await waitFor(() => expect(onReady).toHaveBeenCalledWith(player));

      // Host can drive the player imperatively via the handle.
      const handed = onReady.mock.calls[0][0];
      handed.mute(true);
      expect(player.mute).toHaveBeenCalledWith(true);

      // On teardown the handle is revoked (null).
      unmount();
      expect(onReady).toHaveBeenLastCalledWith(null);
    });
  });
});
