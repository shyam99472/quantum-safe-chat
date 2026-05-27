/**
 * performanceLogger.js
 * 
 * Placeholder utility for logging performance metrics,
 * especially useful for measuring encryption/decryption overhead in the future.
 */

const logPerformance = (label, startTime) => {
    const duration = Date.now() - startTime;
    // In the future this might log to a file or monitoring system
    console.log(`[PERF] ${label}: ${duration}ms`);
};

module.exports = {
    logPerformance
};
