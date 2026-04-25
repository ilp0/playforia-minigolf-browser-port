import type { Packet } from "@minigolf/shared";

/** Common interface for every screen / panel in the app. */
export interface Panel {
  /** Render into the supplied root element. */
  mount(root: HTMLElement): void;
  /** Tear down listeners and DOM references; `App` will clear root afterwards. */
  unmount(): void;
  /** Receive a packet from the active connection. */
  onPacket(p: Packet): void;
}
