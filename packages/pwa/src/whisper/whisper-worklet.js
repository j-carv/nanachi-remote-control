class WhisperCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.remaining = options.processorOptions.maxSamples;
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.port.onmessage = () => {
      this.remaining = 0;
      this.flush();
      this.port.postMessage({ done: true });
    };
  }

  flush() {
    if (this.used === 0) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.used = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel === undefined || this.remaining === 0) return true;
    const count = Math.min(channel.length, this.remaining);
    this.remaining -= count;
    for (let index = 0; index < count; index += 1) {
      this.buffer[this.used++] = channel[index];
      if (this.used === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor('whisper-capture', WhisperCapture);
