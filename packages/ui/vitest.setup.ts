// jsdom implements neither PointerEvent nor pointer capture, so React's
// onPointerDown/Move/Up handlers would receive events with no clientX /
// pointerId — exactly the coordinates the scrubber needs. Polyfill a
// PointerEvent that extends MouseEvent (which carries clientX/clientY) and
// add a pointerId, plus no-op capture methods. This lets Testing Library's
// fireEvent.pointer* construct real coordinate-bearing events.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    public readonly isPrimary: boolean;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  // @ts-expect-error — assigning the polyfill onto the jsdom window
  window.PointerEvent = PointerEventPolyfill;
}

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
