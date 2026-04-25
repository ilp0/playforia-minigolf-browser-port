import { PacketType, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";

type Lang = "en" | "fi" | "sv";

/**
 * Drives the login handshake:
 *   c new (already sent during loading)
 *   d 0 version 35
 *   d 1 language <lang>
 *   d 2 logintype nr
 * Waits for server `d N status lobbyselect ...` to advance.
 */
export class LoginPanel implements Panel {
  private app: App;
  private form: HTMLFormElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private langSelect: HTMLSelectElement | null = null;
  private connectBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private submitting = false;
  private submitHandler: ((ev: SubmitEvent) => void) | null = null;

  constructor(app: App) {
    this.app = app;
  }

  mount(root: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "panel-login";

    const heading = document.createElement("h1");
    heading.textContent = "Playforia Minigolf";
    wrap.appendChild(heading);

    const form = document.createElement("form");
    form.autocomplete = "off";

    const nameRow = document.createElement("div");
    nameRow.className = "form-row";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Username";
    nameLabel.htmlFor = "field-username";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.id = "field-username";
    nameInput.value = "Guest" + this.randomDigits(4);
    nameInput.maxLength = 20;
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    form.appendChild(nameRow);

    const langRow = document.createElement("div");
    langRow.className = "form-row";
    const langLabel = document.createElement("label");
    langLabel.textContent = "Language";
    langLabel.htmlFor = "field-lang";
    const langSelect = document.createElement("select");
    langSelect.id = "field-lang";
    for (const [val, label] of [
      ["en", "English"],
      ["fi", "Suomi"],
      ["sv", "Svenska"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      langSelect.appendChild(opt);
    }
    langRow.appendChild(langLabel);
    langRow.appendChild(langSelect);
    form.appendChild(langRow);

    const btnRow = document.createElement("div");
    btnRow.className = "form-row";
    const spacer = document.createElement("label");
    spacer.textContent = "";
    const connectBtn = document.createElement("button");
    connectBtn.type = "submit";
    connectBtn.className = "btn-green";
    connectBtn.textContent = "Connect";
    btnRow.appendChild(spacer);
    btnRow.appendChild(connectBtn);
    form.appendChild(btnRow);

    const statusEl = document.createElement("div");
    statusEl.className = "form-row";
    statusEl.style.minHeight = "16px";
    statusEl.style.color = "#406040";
    statusEl.style.fontStyle = "italic";
    form.appendChild(statusEl);

    const handler = (ev: SubmitEvent) => {
      ev.preventDefault();
      this.submit();
    };
    form.addEventListener("submit", handler);
    this.submitHandler = handler;

    wrap.appendChild(form);
    root.appendChild(wrap);

    this.form = form;
    this.nameInput = nameInput;
    this.langSelect = langSelect;
    this.connectBtn = connectBtn;
    this.statusEl = statusEl;

    // Focus username for convenience.
    nameInput.focus();
    nameInput.select();
  }

  unmount(): void {
    if (this.form && this.submitHandler) {
      this.form.removeEventListener("submit", this.submitHandler);
    }
    this.form = null;
    this.nameInput = null;
    this.langSelect = null;
    this.connectBtn = null;
    this.statusEl = null;
    this.submitHandler = null;
  }

  onPacket(pkt: Packet): void {
    if (pkt.type !== PacketType.DATA) return;
    const fields = pkt.fields;
    if (fields.length === 0) return;
    const head = fields[0];

    if (head === "versok") {
      this.setStatus("Version OK, sending language...");
      return;
    }
    if (head === "error" && fields[1] === "vernotok") {
      this.setStatus("Server rejected client version.");
      this.submitting = false;
      this.setEnabled(true);
      return;
    }
    if (head === "basicinfo") {
      this.setStatus("Logged in. Awaiting lobby...");
      return;
    }
    if (head === "status" && fields[1] === "lobbyselect") {
      this.app.setPanel("lobbyselect");
      return;
    }
  }

  private submit(): void {
    if (this.submitting) return;
    if (!this.app.connection.isOpen) {
      this.setStatus("Not connected.");
      return;
    }
    this.submitting = true;
    this.setEnabled(false);

    const lang = (this.langSelect?.value ?? "en") as Lang;

    // Full guest-login handshake. The server processes these in order; the
    // final `login` is what triggers basicinfo + status\tlobbyselect.
    this.app.connection.sendData("version", 35);
    this.app.connection.sendData("language", lang);
    this.app.connection.sendData("logintype", "nr");
    this.app.connection.sendData("login");

    this.setStatus("Authenticating...");
  }

  private setEnabled(enabled: boolean): void {
    if (this.connectBtn) this.connectBtn.disabled = !enabled;
    if (this.nameInput) this.nameInput.disabled = !enabled;
    if (this.langSelect) this.langSelect.disabled = !enabled;
  }

  private setStatus(msg: string): void {
    if (this.statusEl) this.statusEl.textContent = msg;
  }

  private randomDigits(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10).toString();
    return s;
  }
}
