/** Ambient type declarations for optional onnxruntime-node dependency */

declare module "onnxruntime-node" {
  export class Tensor {
    constructor(type: string, data: ArrayBufferView | ArrayBuffer, dims?: number[]);
    readonly data: ArrayBufferView;
    readonly dims: number[];
  }
  export class InferenceSession {
    static create(path: string): Promise<InferenceSession>;
    readonly inputNames: string[];
    readonly outputNames: string[];
    run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
  }
}
