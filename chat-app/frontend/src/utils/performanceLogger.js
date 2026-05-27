/**
 * performanceLogger.js
 * Lightweight metrics system for cryptographic operations.
 */

const metrics = {
    deriveKey: [],
    encryptMessage: [],
    decryptMessage: [],
    encryptFile: [],
    decryptFile: []
};

const groupMetrics = {};

const activeTimers = {};

export function startTimer(label) {
    activeTimers[label] = performance.now();
}

export function endTimer(label) {
    if (activeTimers[label]) {
        const duration = performance.now() - activeTimers[label];
        recordMetric(label, duration);
        delete activeTimers[label];
    }
}

export function recordMetric(label, duration) {
    if (metrics[label]) {
        metrics[label].push(duration);

        // Prune to keep only the last 100 entries to prevent memory leak
        if (metrics[label].length > 100) {
            metrics[label] = metrics[label].slice(-100);
        }

        if (label === "encryptFile" || label === "decryptFile") {
            if (metrics[label].length % 3 === 0) {
                printSummary();
            }
        } else {
            if (metrics[label].length % 10 === 0) {
                printSummary();
            }
        }
    }
}

function getAverage(arr) {
    if (arr.length === 0) return 0;
    const sum = arr.reduce((a, b) => a + b, 0);
    return sum / arr.length;
}

function printSummary() {
    console.log("Crypto Performance Metrics");
    console.log(`Key Derivation Avg: ${getAverage(metrics.deriveKey).toFixed(2)} ms`);
    console.log(`Message Encrypt Avg: ${getAverage(metrics.encryptMessage).toFixed(2)} ms`);
    console.log(`Message Decrypt Avg: ${getAverage(metrics.decryptMessage).toFixed(2)} ms`);
    console.log(`File Encrypt Avg: ${getAverage(metrics.encryptFile).toFixed(2)} ms`);
    console.log(`File Decrypt Avg: ${getAverage(metrics.decryptFile).toFixed(2)} ms`);
}

export function exportMetrics() {
    return {
        deriveKeyAvg: getAverage(metrics.deriveKey),
        encryptMessageAvg: getAverage(metrics.encryptMessage),
        decryptMessageAvg: getAverage(metrics.decryptMessage),
        encryptFileAvg: getAverage(metrics.encryptFile),
        decryptFileAvg: getAverage(metrics.decryptFile)
    };
}

export function recordGroupMetric(groupId, metricPatch) {
    if (!groupId) return;

    const current = groupMetrics[groupId] || {
        totalHeals: 0,
        classicalHeals: 0,
        pqBatchHeals: 0,
        initEvents: 0,
        lastMode: null,
        lastEpoch: 1,
        lastBatchCount: 0,
        lastPayloadBytes: 0,
        lastWrapMode: null,
        lastUpdatedAt: null
    };

    groupMetrics[groupId] = {
        ...current,
        ...metricPatch
    };
}

export function exportGroupMetric(groupId) {
    return groupMetrics[groupId] || null;
}
