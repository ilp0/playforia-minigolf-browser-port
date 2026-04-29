// Port of agolf/Seed.java - 48-bit LCG (java.util.Random-style).
// Determinism is critical: shot trajectories must reproduce on every client.

const MULT = 0x5deece66dn; // 25214903917
const ADD = 0xbn; // 11
const MASK48 = (1n << 48n) - 1n;

export class Seed {
  private rnd: bigint;

  constructor(init: bigint | number) {
    const i = typeof init === "bigint" ? init : BigInt(init);
    // (init ^ 25214903917) & ((1<<48)-1)  - Java sign-extends int to long, so do the same.
    this.rnd = (BigInt.asIntN(64, i) ^ MULT) & MASK48;
  }

  next(): number {
    this.rnd = (this.rnd * MULT + ADD) & MASK48;
    // Java: int var1 = (int)(this.rnd >>> 16);  -> low 32 bits of the high 32 bits, signed.
    const top32 = this.rnd >> 16n; // 32-bit value
    let v = Number(BigInt.asIntN(32, top32)); // signed 32-bit int

    // Java's quirk:
    //   if (v < 0) { v = -v; if (v < 0) v = 0; }
    // In Java's 32-bit int arithmetic, -Integer.MIN_VALUE overflows back to itself,
    // and the inner check pins it to 0. JS Numbers don't overflow, so -(-2^31) yields
    // 2^31 and would skip the pin - handle MIN_VALUE explicitly.
    if (v < 0) v = v === -0x80000000 ? 0 : -v;
    return v;
  }

  clone(): Seed {
    const c = new Seed(0);
    c.rnd = this.rnd;
    return c;
  }
}
