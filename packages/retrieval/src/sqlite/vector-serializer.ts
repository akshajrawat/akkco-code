export const MAX_FLOAT32 = 3.4028234663852886e38;

export const serializeVector = (vector: readonly number[]): Uint8Array => {
    if (vector.length === 0) {
        throw new Error("Cannot serialize empty vector");
    }

    for (let i = 0; i < vector.length; i++) {
        const val = vector[i];
        if (typeof val !== "number" || !Number.isFinite(val)) {
            throw new Error(`Cannot serialize vector containing non-finite value at index ${i}`);
        }
        if (Math.abs(val) > MAX_FLOAT32) {
            throw new Error(
                `Cannot serialize vector containing value at index ${i} that overflows 32-bit float range (${val})`,
            );
        }
    }

    const float32 = new Float32Array(vector);
    for (let i = 0; i < float32.length; i++) {
        if (!Number.isFinite(float32[i])) {
            throw new Error(
                `Cannot serialize vector: Float32 conversion produced non-finite value at index ${i}`,
            );
        }
    }

    return new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);
};

export const deserializeVector = (blob: Uint8Array, expectedDimensions?: number): number[] => {
    if (blob.byteLength === 0) {
        throw new Error("Cannot deserialize empty vector blob");
    }

    if (blob.byteLength % 4 !== 0) {
        throw new Error(
            `Malformed vector blob: byte length ${blob.byteLength} is not a multiple of 4`,
        );
    }

    const dimensions = blob.byteLength / 4;
    if (expectedDimensions !== undefined && dimensions !== expectedDimensions) {
        throw new Error(
            `Vector dimension mismatch: expected ${expectedDimensions}, got ${dimensions}`,
        );
    }

    // Copy bytes to aligned buffer if needed
    const alignedBuffer = new ArrayBuffer(blob.byteLength);
    new Uint8Array(alignedBuffer).set(blob);
    const float32 = new Float32Array(alignedBuffer);

    const vector: number[] = new Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
        const val = float32[i];
        if (!Number.isFinite(val)) {
            throw new Error(`Deserialized vector contains non-finite value at index ${i}`);
        }
        vector[i] = val;
    }

    return vector;
};
