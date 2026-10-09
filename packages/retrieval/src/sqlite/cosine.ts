export const cosineSimilarity = (a: readonly number[], b: readonly number[]): number => {
    if (a.length !== b.length || a.length === 0) {
        return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        const valA = a[i];
        const valB = b[i];
        dot += valA * valB;
        normA += valA * valA;
        normB += valB * valB;
    }

    if (normA <= 0 || normB <= 0) {
        return 0;
    }

    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    if (!Number.isFinite(similarity)) {
        return 0;
    }

    return similarity;
};
