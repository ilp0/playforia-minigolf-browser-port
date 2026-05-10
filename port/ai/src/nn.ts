// Tiny MLP from scratch. Phase 2a is forward-pass only; Phase 2b adds the
// backward pass next door.
//
// Architecture: input → linear → tanh → linear → output.
// Weights/biases live in flat Float32Arrays so we can update every parameter
// from one tight loop in 2b without juggling jagged arrays.
//
// Layout convention (chosen for cache-friendly forward sweeps):
//   W1 is row-major [inputSize × hiddenSize] - W1[i*H + j] is the weight from
//   input neuron i to hidden neuron j. So the inner loop in `hidden[j] = ...`
//   walks contiguous memory while accumulating one hidden activation.

export interface MLPSpec {
  inputSize: number;
  hiddenSize: number;
  outputSize: number;
}

export class MLP {
  readonly spec: MLPSpec;
  /** Layer 1 weights, [inputSize × hiddenSize] row-major. */
  W1: Float32Array;
  b1: Float32Array;
  /** Layer 2 weights, [hiddenSize × outputSize] row-major. */
  W2: Float32Array;
  b2: Float32Array;

  constructor(spec: MLPSpec) {
    this.spec = spec;
    this.W1 = new Float32Array(spec.inputSize * spec.hiddenSize);
    this.b1 = new Float32Array(spec.hiddenSize);
    this.W2 = new Float32Array(spec.hiddenSize * spec.outputSize);
    this.b2 = new Float32Array(spec.outputSize);
    this.initWeights();
  }

  /**
   * Xavier/Glorot init for tanh: weights drawn from N(0, sqrt(2/(fan_in+fan_out))).
   * This keeps activations roughly unit-scale through the network at init -
   * if weights were too large, tanh would saturate (gradients vanish);
   * too small, signal dies before reaching the output. Biases start at 0.
   */
  private initWeights(): void {
    const s1 = Math.sqrt(2 / (this.spec.inputSize + this.spec.hiddenSize));
    const s2 = Math.sqrt(2 / (this.spec.hiddenSize + this.spec.outputSize));
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = randn() * s1;
    for (let i = 0; i < this.W2.length; i++) this.W2[i] = randn() * s2;
  }

  /**
   * Forward pass.
   *   hidden = tanh(input @ W1 + b1)
   *   output = hidden @ W2 + b2          (linear - no final activation)
   *
   * Returns BOTH hidden and output because Phase 2b's backprop needs the
   * hidden activations to compute the gradient w.r.t. W2 (its inputs are
   * the hidden values). Saving them now is cheaper than recomputing.
   */
  forward(input: Float32Array | readonly number[]): {
    hidden: Float32Array;
    output: Float32Array;
  } {
    const { inputSize, hiddenSize, outputSize } = this.spec;
    const hidden = new Float32Array(hiddenSize);
    for (let j = 0; j < hiddenSize; j++) {
      let z = this.b1[j];
      for (let i = 0; i < inputSize; i++) {
        z += input[i] * this.W1[i * hiddenSize + j];
      }
      hidden[j] = Math.tanh(z);
    }
    const output = new Float32Array(outputSize);
    for (let k = 0; k < outputSize; k++) {
      let z = this.b2[k];
      for (let j = 0; j < hiddenSize; j++) {
        z += hidden[j] * this.W2[j * outputSize + k];
      }
      output[k] = z;
    }
    return { hidden, output };
  }

  /** Total parameter count - useful for progress diagnostics. */
  get paramCount(): number {
    return this.W1.length + this.b1.length + this.W2.length + this.b2.length;
  }
}

/**
 * Standard-normal sample via Box-Muller. We need this in two places:
 *   - weight init (one draw per parameter)
 *   - action sampling (one draw per action dimension per stroke)
 * Math.random alone is uniform on [0, 1) - not what a Gaussian distribution
 * expects. Box-Muller turns two uniforms into one normal sample (we discard
 * the second output since we don't need it twice as often).
 */
export function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
}
