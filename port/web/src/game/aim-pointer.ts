/**
 * Tracks which input currently positions the aim line.
 *
 * Touch mode is a guess about the device, and touch-screen laptops can land
 * in it (a 3200x1800 panel at 250 % scaling reports a 1280x720 screen). So
 * the aim line follows the input actually in use: a real mouse always aims,
 * while a finger aims only during its drag. Touches on the canvas are
 * `preventDefault`ed and fire no mouse events of their own.
 */
export class AimPointer {
  private readonly touchPrimary: boolean;
  private dragging = false;
  private hovering = false;

  constructor(touchPrimary: boolean) {
    this.touchPrimary = touchPrimary;
  }

  mouseMoved(): void {
    this.hovering = true;
  }

  touchStarted(): void {
    this.dragging = true;
    this.hovering = false;
  }

  touchEnded(): void {
    this.dragging = false;
  }

  /** A finger is down and aiming (drives the loupe). */
  get touching(): boolean {
    return this.dragging;
  }

  /** Whether the last pointer position is one the player is aiming at now. */
  get live(): boolean {
    return !this.touchPrimary || this.dragging || this.hovering;
  }
}
