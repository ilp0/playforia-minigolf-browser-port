import { PacketType, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";
import { i18n, saveLang, t, type Lang } from "../i18n.ts";

const CLIENT_ID_STORAGE_KEY = "mg.clientId";

/**
 * Persistent per-browser identifier kept in localStorage. Survives page
 * refreshes (and even browser restarts) but resets on cleared site data,
 * private windows, or a different browser/profile. Format is the platform
 * `crypto.randomUUID()` (RFC 4122 v4) when available, falling back to a
 * compact random string for execution contexts that don't expose it
 * (very old test runners, mostly).
 *
 * The server only consumes this for analytics — it's logged in
 * player_login / player_disconnect / player_reconnect, never used for
 * authentication or session takeover, so a forged or shared id only
 * confuses our own dashboards.
 */
function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing && existing.length > 0) return existing;
  } catch {
    // localStorage unavailable (private mode quota, sandbox). Fall through
    // and mint a transient id — it'll change on every refresh, which makes
    // the analytics weaker but still better than nothing.
  }
  const fresh = mintClientId();
  try {
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

function mintClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback: 16 bytes of Math.random in hex. Not cryptographically secure,
  // but the cid only labels analytics rows — collision risk is what matters,
  // and 128 bits is plenty for that.
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

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
  private langChangeHandler: ((ev: Event) => void) | null = null;

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
    nameLabel.textContent = t("Login_EnterNick", "Your nickname:");
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
    // No matching key in AGolf.xml — Java surfaces languages via Language_<code>
    // values but never had a "Language:" label key. Use the port-specific
    // Port_Login_Language so a translator can add it later if desired.
    langLabel.textContent = t("Port_Login_Language", "Language");
    langLabel.htmlFor = "field-lang";
    const langSelect = document.createElement("select");
    langSelect.id = "field-lang";
    // Render the language names through the same XML so each locale's display
    // string is the one its own AGolf.xml provides (English: "Finnish",
    // Finnish: "suomi", etc.). Falls back to the inline defaults if the key
    // isn't present.
    for (const [val, fallback] of [
      ["en", "English"],
      ["fi", "Suomi"],
      ["sv", "Svenska"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = t(`Language_${val}`, fallback);
      langSelect.appendChild(opt);
    }
    // Default to the saved-language preference (or EN). Triggers below pre-load
    // the chosen XML so the moment we transition to lobbyselect the strings
    // are already resolved.
    langSelect.value = i18n.language;
    const langChange = (): void => {
      const lang = (langSelect.value || "en") as Lang;
      saveLang(lang);
      void i18n.setLanguage(lang).catch((err) => {
        console.warn("[login] language load failed", err);
      });
    };
    langSelect.addEventListener("change", langChange);
    this.langChangeHandler = langChange;
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
    connectBtn.textContent = t("Login_Ok", "Connect");
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
    if (this.langSelect && this.langChangeHandler) {
      this.langSelect.removeEventListener("change", this.langChangeHandler);
    }
    this.form = null;
    this.nameInput = null;
    this.langSelect = null;
    this.connectBtn = null;
    this.statusEl = null;
    this.submitHandler = null;
    this.langChangeHandler = null;
  }

  onPacket(pkt: Packet): void {
    if (pkt.type !== PacketType.DATA) return;
    const fields = pkt.fields;
    if (fields.length === 0) return;
    const head = fields[0];

    if (head === "versok") {
      this.setStatus(t("Port_Login_StatusVersOk", "Version OK, sending language..."));
      return;
    }
    if (head === "error" && fields[1] === "vernotok") {
      this.setStatus(t("Message_VersionError", "Server rejected client version."));
      this.submitting = false;
      this.setEnabled(true);
      return;
    }
    if (head === "basicinfo") {
      this.setStatus(t("Port_Login_StatusBasicInfo", "Logged in. Awaiting lobby..."));
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
      this.setStatus(t("Port_Login_NotConnected", "Not connected."));
      return;
    }
    this.submitting = true;
    this.setEnabled(false);

    const lang = (this.langSelect?.value ?? "en") as Lang;
    // Make sure the chosen locale's XML is loaded before any post-login panel
    // mounts. Awaited fire-and-forget — the panel transition is server-driven
    // (waits for `status lobbyselect`), so the round-trip gives `setLanguage`
    // ample time to finish.
    saveLang(lang);
    void i18n.setLanguage(lang).catch((err) => {
      console.warn("[login] language load failed", err);
    });
    const rawNick = (this.nameInput?.value ?? "").trim();
    // Server-side sanitiser will accept/reject; we only strip our own framing
    // chars here so we never split the packet on the wire.
    const nick = rawNick.replace(/[\r\n\t]+/g, " ").slice(0, 20);

    // Full guest-login handshake. The server processes these in order; the
    // final `login` is what triggers basicinfo + status\tlobbyselect.
    // `nick` is the port's extension to the original handshake — the server
    // uses it as the player's display name instead of the random `~anonym-`
    // placeholder, so other players (and ghost labels in daily mode) see the
    // name the user chose at the login screen.
    // `cid` is the port's persistent browser id (localStorage UUID). The
    // server logs it in player_login/disconnect/reconnect events so an
    // operator scanning the analytics log can tell "same browser refreshing"
    // apart from "two unrelated guests on the same NAT".
    this.app.connection.sendData("version", 35);
    this.app.connection.sendData("language", lang);
    this.app.connection.sendData("logintype", "nr");
    this.app.connection.sendData("cid", getOrCreateClientId());
    if (nick) this.app.connection.sendData("nick", nick);
    this.app.connection.sendData("login");

    this.setStatus(t("Login_Wait", "Authenticating..."));
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
